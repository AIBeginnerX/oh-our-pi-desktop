import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  EnvironmentId,
  type DesktopPhoneSharedEnvironment,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as NodeOS from "node:os";

import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopGatewayClients from "./DesktopGatewayClients.ts";

/**
 * Publishes the saved environments the user marked "Available on phone" to this computer's own
 * backend, which forwards them under `/_gw/<environmentId>/` to phones connected through the relay.
 *
 * Each shared environment gets its own standard-scope bearer session on the upstream. The
 * desktop's existing sessions are never handed to the host, because they are administrative: a
 * phone that could reach them could manage the upstream's pairing links and clients.
 *
 * One loop owns everything. Each pass reconciles desired state (the shared list intersected with
 * the saved catalog) against what is published, so a toggle, a catalog edit, a backend restart, or
 * a moved SSH forward all converge through the same code path. SSH tunnels are opened (and kept
 * alive, because every pass re-ensures them) only for shared environments.
 */

const RECONCILE_INTERVAL = "30 seconds";
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const STANDARD_SCOPES: ReadonlyArray<string> = AuthStandardClientScopes;
const ADMIN_SCOPES: ReadonlySet<string> = new Set(
  AuthAdministrativeScopes.filter((scope) => !STANDARD_SCOPES.includes(scope)),
);

const decodeCatalogJson = Schema.decodeEffect(Schema.fromJsonString(ConnectionCatalogDocument));

type Source =
  | {
      readonly kind: "ssh";
      readonly label: string;
      readonly target: DesktopSshEnvironmentTarget;
    }
  | {
      readonly kind: "bearer";
      readonly label: string;
      readonly httpBaseUrl: string;
      readonly bearerToken: string;
    };

interface Entry {
  phase: DesktopPhoneSharedEnvironment["state"];
  message: string | null;
  httpBaseUrl: string | null;
  bearerToken: string | null;
  /** Revokes the upstream session this entry minted. Null when the session is not ours to revoke. */
  revoke: Effect.Effect<void> | null;
  /** `hostKey|url|token` last accepted by the host; a different key means publish again. */
  publishedKey: string | null;
  /** Unshared but the host has not confirmed removal yet. */
  removing: boolean;
  failures: number;
  retryAt: number;
}

const newEntry = (): Entry => ({
  phase: "connecting",
  message: null,
  httpBaseUrl: null,
  bearerToken: null,
  revoke: null,
  publishedKey: null,
  removing: false,
  failures: 0,
  retryAt: 0,
});

const hasAdminScope = (scopes: ReadonlyArray<string>) => scopes.some((s) => ADMIN_SCOPES.has(s));

const trimSlash = (url: string) => url.replace(/\/+$/u, "");

const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);

export class DesktopGatewayPublisher extends Context.Service<
  DesktopGatewayPublisher,
  {
    /** One reconcile pass. The background loop runs it; tests call it directly. */
    readonly reconcile: Effect.Effect<void>;
    /** Wakes the loop now and clears retry backoff. */
    readonly kick: Effect.Effect<void>;
    readonly status: Effect.Effect<ReadonlyArray<DesktopPhoneSharedEnvironment>>;
    readonly setShared: (
      environmentId: string,
      shared: boolean,
    ) => Effect.Effect<ReadonlyArray<DesktopPhoneSharedEnvironment>>;
  }
>()("@t3tools/desktop/gateway/DesktopGatewayPublisher") {}

export const makeWith = (options: { readonly background: boolean }) =>
  Effect.gen(function* () {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    const ssh = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    const host = yield* DesktopGatewayClients.DesktopGatewayHost;
    const upstream = yield* DesktopGatewayClients.DesktopGatewayUpstream;
    const sessionLabel = `${DesktopGatewayClients.GATEWAY_SESSION_LABEL} (${NodeOS.hostname()})`;

    const entries = new Map<string, Entry>();
    const lock = yield* Semaphore.make(1);
    const wakeups = yield* Queue.sliding<void>(1);
    let lastHostKey: string | null = null;

    const readSources = Effect.gen(function* () {
      const raw = yield* store.get;
      if (Option.isNone(raw)) return Option.none<ReadonlyMap<string, Source>>();
      const document = yield* decodeCatalogJson(raw.value);
      const sources = new Map<string, Source>();
      for (const target of document.targets) {
        if (target._tag !== "BearerConnectionTarget" && target._tag !== "SshConnectionTarget") {
          continue;
        }
        const profile = document.profiles.find(
          (value) => value.connectionId === target.connectionId,
        );
        if (profile?._tag === "SshConnectionProfile") {
          sources.set(target.environmentId, {
            kind: "ssh",
            label: target.label,
            target: profile.target,
          });
        } else if (profile?._tag === "BearerConnectionProfile") {
          const credential = document.credentials.find(
            (value) => value.connectionId === target.connectionId,
          )?.credential;
          if (credential !== undefined) {
            sources.set(target.environmentId, {
              kind: "bearer",
              label: target.label,
              httpBaseUrl: profile.httpBaseUrl,
              bearerToken: credential.token,
            });
          }
        }
      }
      return Option.some<ReadonlyMap<string, Source>>(sources);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("gateway.catalog.unreadable", { error: messageOf(error) }).pipe(
          Effect.as(Option.none<ReadonlyMap<string, Source>>()),
        ),
      ),
    );

    const ensureTunnel = (target: DesktopSshEnvironmentTarget, issuePairingToken: boolean) =>
      ssh.ensureEnvironment(target, issuePairingToken ? { issuePairingToken: true } : undefined);

    const requireStandard = (scopes: ReadonlyArray<string>) =>
      hasAdminScope(scopes)
        ? Effect.fail(
            new DesktopGatewayClients.DesktopGatewayError({
              message: "The upstream issued an administrative session; refusing to share it.",
            }),
          )
        : Effect.void;

    /** A standard-scope session for an SSH-managed environment, from a fresh pairing credential. */
    const mintSshSession = (target: DesktopSshEnvironmentTarget) =>
      Effect.gen(function* () {
        const bootstrap = yield* ensureTunnel(target, true);
        if (bootstrap.pairingToken === null) {
          return yield* new DesktopGatewayClients.DesktopGatewayError({
            message: "The SSH environment did not issue a pairing credential.",
          });
        }
        const httpBaseUrl = trimSlash(bootstrap.httpBaseUrl);
        const session = yield* upstream.exchange({
          httpBaseUrl,
          credential: bootstrap.pairingToken,
          scopes: AuthStandardClientScopes,
          label: sessionLabel,
        });
        yield* requireStandard(session.scopes);
        // Revoking needs an administrative session, and a session cannot revoke itself. Mint a
        // short-lived one, sweep every gateway session, and leave it for the next sweep (its label
        // also matches) or its own expiry.
        const revoke = Effect.gen(function* () {
          const again = yield* ensureTunnel(target, true);
          if (again.pairingToken === null) return;
          const admin = yield* upstream.exchange({
            httpBaseUrl: trimSlash(again.httpBaseUrl),
            credential: again.pairingToken,
            scopes: AuthAdministrativeScopes,
            label: `${sessionLabel} cleanup`,
          });
          yield* upstream.revokeGatewaySessions({
            httpBaseUrl: trimSlash(again.httpBaseUrl),
            bearerToken: admin.accessToken,
            label: sessionLabel,
          });
        }).pipe(Effect.ignore);
        return { bearerToken: session.accessToken, revoke };
      });

    /**
     * A standard-scope session for a bearer or Tailscale remote. With an administrative stored
     * bearer, ask the upstream for a separate standard-scope session; if that fails, refuse. A stored
     * bearer that is already standard-scope is reused as is (and not revoked, since it is not ours).
     */
    const mintBearerSession = (httpBaseUrl: string, storedBearer: string) =>
      Effect.gen(function* () {
        const storedScopes = yield* upstream.sessionScopes({
          httpBaseUrl,
          bearerToken: storedBearer,
        });
        if (!hasAdminScope(storedScopes)) {
          return { bearerToken: storedBearer, revoke: null };
        }
        const revoke = upstream
          .revokeGatewaySessions({ httpBaseUrl, bearerToken: storedBearer, label: sessionLabel })
          .pipe(Effect.ignore);
        // Drop sessions an earlier run of this desktop minted and lost track of.
        yield* revoke;
        const credential = yield* upstream.mintPairingCredential({
          httpBaseUrl,
          bearerToken: storedBearer,
          scopes: AuthStandardClientScopes,
          label: sessionLabel,
        });
        const session = yield* upstream.exchange({
          httpBaseUrl,
          credential,
          scopes: AuthStandardClientScopes,
          label: sessionLabel,
        });
        yield* requireStandard(session.scopes);
        return { bearerToken: session.accessToken, revoke };
      });

    const unpublish = (environmentId: string, entry: Entry, hostUp: boolean) =>
      Effect.gen(function* () {
        if (hostUp) {
          yield* host.remove({ environmentId: EnvironmentId.make(environmentId) });
        }
        if (entry.revoke !== null) yield* entry.revoke;
        entries.delete(environmentId);
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            entry.removing = true;
            entry.message = messageOf(error);
          }),
        ),
      );

    const provision = (environmentId: string, source: Source, entry: Entry, hostKey: string) =>
      Effect.gen(function* () {
        let httpBaseUrl: string;
        if (source.kind === "ssh") {
          httpBaseUrl = trimSlash((yield* ensureTunnel(source.target, false)).httpBaseUrl);
        } else {
          httpBaseUrl = trimSlash(source.httpBaseUrl);
        }
        if (entry.bearerToken === null) {
          const minted =
            source.kind === "ssh"
              ? yield* mintSshSession(source.target)
              : yield* mintBearerSession(httpBaseUrl, source.bearerToken);
          entry.bearerToken = minted.bearerToken;
          entry.revoke = minted.revoke;
        }
        entry.httpBaseUrl = httpBaseUrl;
        const key = `${hostKey}|${httpBaseUrl}|${entry.bearerToken}`;
        if (entry.publishedKey !== key) {
          yield* host.upsert({
            environmentId: EnvironmentId.make(environmentId),
            label: source.label,
            httpBaseUrl,
            bearerToken: entry.bearerToken,
          });
          entry.publishedKey = key;
        }
      });

    const reconcile = lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const sources = yield* readSources;
        if (Option.isNone(sources)) return;
        const hostKeyOption = yield* host.hostKey;
        const hostUp = Option.isSome(hostKeyOption);

        let shared = new Set(yield* store.getPhoneShared);
        // A removed environment drops out of the shared list too.
        for (const id of shared) {
          if (!sources.value.has(id)) {
            shared.delete(id);
            yield* store.setPhoneShared(id, false).pipe(Effect.ignore);
          }
        }
        for (const [id, entry] of entries) {
          if (!shared.has(id)) yield* unpublish(id, entry, hostUp);
        }
        if (!hostUp) {
          lastHostKey = null;
          for (const entry of entries.values()) {
            entry.publishedKey = null;
            entry.phase = "connecting";
            entry.message = "Waiting for this computer's server.";
          }
          return;
        }
        const hostKey = hostKeyOption.value;
        if (hostKey !== lastHostKey) {
          lastHostKey = hostKey;
          for (const entry of entries.values()) entry.publishedKey = null;
        }

        const statuses = yield* host.statuses.pipe(Effect.option);
        for (const id of shared) {
          const source = sources.value.get(id);
          if (source === undefined) continue;
          let entry = entries.get(id);
          if (entry === undefined) {
            entry = newEntry();
            entries.set(id, entry);
          }
          if (Option.isSome(statuses) && statuses.value.get(id) === "auth-failed") {
            // The upstream rejected our session (revoked, or its server restarted): mint a new one.
            entry.bearerToken = null;
            entry.publishedKey = null;
          }
          if (entry.retryAt > now) continue;
          const exit = yield* Effect.exit(provision(id, source, entry, hostKey));
          if (exit._tag === "Success") {
            entry.phase = "published";
            entry.message = null;
            entry.failures = 0;
            continue;
          }
          const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
          entry.failures += 1;
          entry.phase = "error";
          entry.message = failure === undefined ? "Unexpected failure." : messageOf(failure);
          // A cancelled SSH password prompt should not re-prompt every pass.
          const cancelled =
            failure !== undefined &&
            DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation(failure);
          entry.retryAt =
            now +
            (cancelled
              ? RETRY_MAX_MS
              : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (entry.failures - 1)));
          yield* Effect.logWarning("gateway.publish.failed", {
            environmentId: id,
            failures: entry.failures,
            error: entry.message,
          });
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("gateway.reconcile.failed", { cause })),
      ),
    );

    const kick = Effect.sync(() => {
      for (const entry of entries.values()) entry.retryAt = 0;
    }).pipe(Effect.andThen(Queue.offer(wakeups, undefined)), Effect.asVoid);

    const status = Effect.gen(function* () {
      const shared = yield* store.getPhoneShared;
      return shared.map((id): DesktopPhoneSharedEnvironment => {
        const entry = entries.get(id);
        return {
          environmentId: EnvironmentId.make(id),
          state: entry?.phase ?? "connecting",
          message: entry?.message ?? null,
        };
      });
    });

    const setShared = (environmentId: string, enabled: boolean) =>
      store.setPhoneShared(environmentId, enabled).pipe(
        Effect.catch((error) =>
          Effect.logWarning("gateway.setShared.failed", { error: messageOf(error) }),
        ),
        Effect.andThen(kick),
        Effect.andThen(status),
      );

    if (options.background) {
      yield* Effect.forever(
        reconcile.pipe(
          Effect.andThen(
            Queue.take(wakeups).pipe(Effect.timeoutOption(RECONCILE_INTERVAL), Effect.asVoid),
          ),
        ),
      ).pipe(Effect.forkScoped);
    }

    return DesktopGatewayPublisher.of({ reconcile, kick, status, setShared });
  });

export const layer = Layer.effect(DesktopGatewayPublisher, makeWith({ background: true }));
/** Without the background loop, so tests drive `reconcile` themselves. */
export const layerManual = Layer.effect(DesktopGatewayPublisher, makeWith({ background: false }));
