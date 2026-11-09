import {
  ClientPresentation,
  CloudSession,
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
  PrimaryEnvironmentAuth,
  RelayDeviceIdentity,
  SshEnvironmentGateway,
} from "@t3tools/client-runtime/platform";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  mapRemoteEnvironmentError,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { managedRelayAccountChanges, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import {
  AuthStandardClientScopes,
  type DesktopBridge,
  type EnvironmentId,
  type GatewayEnvironment,
  type DesktopEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";

import { APP_VERSION } from "../branding";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { primaryEnvironmentHttpLayer } from "../environments/primary/httpLayer";
import {
  readPrimaryEnvironmentTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { gatewayEnvironmentInfoAtom } from "../state/gateway";
import { fetchGatewayEnvironments, gatewayRegistrations } from "./gateway";
import { isHostedStaticApp } from "../hostedPairing";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import {
  desktopLocalConnectionId,
  readDesktopSecondaryBootstrapsResult,
  type DesktopSecondaryBootstrapsRead,
} from "./desktopLocal";
import { connectionStorageLayer } from "./storage";
import { clientPresentationMetadata } from "./clientMetadata";
import { resolveDesktopBootstrapsRefresh } from "./useDesktopLocalBootstraps";

let nextObservedRpcRequestId = 0;

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

const connectivityLayer = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

const wakeupsLayer = Wakeups.layer({
  changes: Stream.merge(
    Stream.callback<"application-active">((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = () => {
            if (document.visibilityState === "visible") {
              Queue.offerUnsafe(queue, "application-active");
            }
          };
          document.addEventListener("visibilitychange", listener);
          return listener;
        }),
        (listener) =>
          Effect.sync(() => {
            document.removeEventListener("visibilitychange", listener);
          }),
      ).pipe(Effect.asVoid),
    ),
    managedRelayAccountChanges(appAtomRegistry).pipe(
      Stream.map(() => "credentials-changed" as const),
    ),
  ),
});

function clientMetadata() {
  return clientPresentationMetadata({
    appVersion: APP_VERSION,
    hosted: isHostedStaticApp(),
    identity: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    },
    desktopBridge: window.desktopBridge,
  });
}

function sshPreparationError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.toLowerCase().includes("cancel")) {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: message,
    });
  }
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not prepare the SSH environment: ${message}`,
  });
}

export const provisionDesktopSshEnvironment = Effect.fn(
  "web.connectionPlatform.ssh.provisionDesktop",
)(function* (bridge: DesktopBridge, target: DesktopSshEnvironmentTarget) {
  const bootstrap = yield* Effect.tryPromise({
    try: () =>
      bridge.ensureSshEnvironment(target, {
        issuePairingToken: true,
      }),
    catch: sshPreparationError,
  });
  const pairingToken = bootstrap.pairingToken;
  if (pairingToken === null) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The SSH environment did not issue a pairing credential.",
    });
  }
  const descriptor = yield* Effect.tryPromise({
    try: () => bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl),
    catch: sshPreparationError,
  });
  const access = yield* Effect.tryPromise({
    try: () => bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, pairingToken),
    catch: sshPreparationError,
  });
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    bootstrap,
    bearerToken: access.access_token,
  };
});

const capabilitiesLayer = Layer.effectContext(
  Effect.sync(() => {
    const presentation = ClientPresentation.of({
      metadata: clientMetadata(),
      scopes: AuthStandardClientScopes,
    });
    const cloudSession = CloudSession.of({
      identity: Effect.sync(() =>
        Option.fromNullishOr(appAtomRegistry.get(managedRelaySessionAtom)),
      ),
      clerkToken: Effect.gen(function* () {
        const session = appAtomRegistry.get(managedRelaySessionAtom);
        if (session === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "Sign in to OOP Connect to connect this environment.",
          });
        }
        const token = yield* session.readClerkToken().pipe(
          Effect.mapError(
            (error) =>
              new ConnectionTransientError({
                reason: "network",
                detail: error.message,
              }),
          ),
        );
        if (token === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "The OOP Connect session is unavailable.",
          });
        }
        return token;
      }),
    });
    const identity = RelayDeviceIdentity.of({
      deviceId: Effect.succeedNone,
    });
    const primaryAuth = PrimaryEnvironmentAuth.of({
      bearerToken: Effect.tryPromise({
        try: readDesktopPrimaryBearerToken,
        catch: (cause) =>
          new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: `Could not load the desktop primary credential: ${String(cause)}`,
          }),
      }).pipe(Effect.map(Option.fromNullishOr)),
    });
    const ssh = SshEnvironmentGateway.of({
      provision: Effect.fn("web.connectionPlatform.ssh.provision")(function* (target) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }
        return yield* provisionDesktopSshEnvironment(bridge, target);
      }),
      prepare: Effect.fn("web.connectionPlatform.ssh.prepare")(function* (input) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }
        const bootstrap = yield* Effect.tryPromise({
          try: () =>
            bridge.ensureSshEnvironment(input.target, {
              issuePairingToken: true,
            }),
          catch: sshPreparationError,
        });
        if (bootstrap.pairingToken === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "The SSH environment did not issue a pairing credential.",
          });
        }
        const access = yield* Effect.tryPromise({
          try: () =>
            bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, bootstrap.pairingToken!),
          catch: sshPreparationError,
        });
        return {
          bootstrap,
          bearerToken: access.access_token,
        };
      }),
      disconnect: Effect.fn("web.connectionPlatform.ssh.disconnect")(function* (target) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return;
        }
        yield* Effect.tryPromise({
          try: () => bridge.disconnectSshEnvironment(target),
          catch: (cause) =>
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: `Could not disconnect the SSH environment: ${String(cause)}`,
            }),
        });
      }),
    });

    return Context.make(CloudSession, cloudSession).pipe(
      Context.add(PrimaryEnvironmentAuth, primaryAuth),
      Context.add(RelayDeviceIdentity, identity),
      Context.add(ClientPresentation, presentation),
      Context.add(SshEnvironmentGateway, ssh),
    );
  }),
);

const loadPrimaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadPrimaryConnectionRegistration",
)(function* (resolved: PrimaryEnvironmentTarget) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: resolved.target.httpBaseUrl,
  }).pipe(Effect.provide(primaryEnvironmentHttpLayer), Effect.mapError(mapRemoteEnvironmentError));
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: resolved.target.httpBaseUrl,
      wsBaseUrl: resolved.target.wsBaseUrl,
    }),
  });
});

// A desktop-local backend whose endpoints the desktop has not resolved yet
// (e.g. a parallel WSL backend still booting) is skipped on purpose: the main
// process pushes a bootstraps change once its config resolves, so no retry
// wake is needed for it.
function desktopBackendEndpointsReady(
  entry: DesktopEnvironmentBootstrap,
): entry is DesktopEnvironmentBootstrap & {
  httpBaseUrl: string;
  wsBaseUrl: string;
  bootstrapToken: string;
} {
  return (
    entry.httpBaseUrl !== null && entry.wsBaseUrl !== null && entry.bootstrapToken !== undefined
  );
}

// A desktop-local secondary backend (e.g. a parallel WSL backend) lives on its
// own loopback origin, so — unlike the same-origin primary — it authenticates
// with a bearer token minted from the bootstrap credential the desktop issues.
const loadSecondaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadSecondaryConnectionRegistration",
)(function* (entry: DesktopEnvironmentBootstrap) {
  if (!desktopBackendEndpointsReady(entry)) {
    return yield* new ConnectionTransientError({
      reason: "endpoint-unavailable",
      detail: `Desktop-local backend ${entry.id} is not ready yet.`,
    });
  }
  const httpBaseUrl = entry.httpBaseUrl;
  const wsBaseUrl = entry.wsBaseUrl;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );
  const issuedAtEpochMs = yield* Clock.currentTimeMillis;
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl,
    credential: entry.bootstrapToken,
    scopes: AuthStandardClientScopes,
    clientMetadata: clientMetadata(),
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  // Keep the desktop pool's stable backend id in the connection id. The
  // descriptor environment id still scopes projects and RPC state, while the
  // backend id lets desktop-only operations (notably the WSL folder picker)
  // route back to the instance that owns the environment.
  const connectionId = desktopLocalConnectionId(entry.id);
  // Prefer the desktop's bootstrap label (it identifies the backend and distro,
  // e.g. "WSL: Ubuntu") over the generic descriptor label, so consumers can show
  // a meaningful name without recovering it from the bootstrap list later.
  const label = entry.label || descriptor.label;
  return {
    registration: new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label,
        httpBaseUrl,
        wsBaseUrl,
      }),
      credential: new BearerConnectionCredential({ token: access.access_token }),
    }),
    expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, access.expires_in),
    refreshAtEpochMs: secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, access.expires_in),
  };
});

// Poll cadence for the platform connection source when the desktop bridge
// cannot push changes (older shells lack `onLocalEnvironmentBootstrapsChange`
// and plain web has no bridge at all). Shells carrying the event rebuild only
// on that push plus an expiry-driven wake, so the tick never runs there.
const PLATFORM_POLL_INTERVAL = "3 seconds";
// An expiry-driven wake whose deadline has already passed (a re-issue failed
// and the stale credential is retained) retries no faster than the old poll
// cadence instead of re-arming a zero-delay wake in a hot loop.
const REFRESH_WAKE_RETRY_MIN_MS = 3_000;
// A rebuild that lost an entry to a retryable failure re-arms at the floor,
// doubling per consecutive failure up to this cap so a permanently broken
// backend does not wake every few seconds forever.
const FAILURE_RETRY_MAX_MS = 30_000;
const SECONDARY_BEARER_REFRESH_SKEW_MS = 5_000;

export function secondaryBearerExpiresAtEpochMs(
  issuedAtEpochMs: number,
  expiresInSeconds: number,
): number {
  return issuedAtEpochMs + Math.max(0, expiresInSeconds * 1_000);
}

export function secondaryBearerRefreshAtEpochMs(
  issuedAtEpochMs: number,
  expiresInSeconds: number,
): number {
  return Math.max(
    issuedAtEpochMs,
    secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, expiresInSeconds) -
      SECONDARY_BEARER_REFRESH_SKEW_MS,
  );
}

export interface CachedPlatformRegistration {
  readonly signature: string;
  readonly registration: PlatformConnectionRegistration;
  readonly expiresAtEpochMs?: number;
  readonly refreshAtEpochMs?: number;
}

export type PrimaryEnvironmentTargetRead =
  | {
      readonly _tag: "Success";
      readonly target: PrimaryEnvironmentTarget | null;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

export function readPrimaryEnvironmentTargetResult(
  readTarget: () => PrimaryEnvironmentTarget | null = readPrimaryEnvironmentTarget,
): PrimaryEnvironmentTargetRead {
  try {
    return { _tag: "Success", target: readTarget() };
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}

export function primaryRegistrationToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: PrimaryEnvironmentTargetRead,
): CachedPlatformRegistration | undefined {
  return topologyRead._tag === "Failure" ? previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID) : undefined;
}

export function canReuseCachedPlatformRegistration(
  cached: CachedPlatformRegistration,
  signature: string,
  nowEpochMs: number,
): boolean {
  return (
    cached.signature === signature &&
    (cached.refreshAtEpochMs === undefined || nowEpochMs < cached.refreshAtEpochMs)
  );
}

export function canRetainCachedPlatformRegistrationAfterRefreshFailure(
  cached: CachedPlatformRegistration,
  signature: string,
  nowEpochMs: number,
): boolean {
  return (
    cached.signature === signature &&
    cached.expiresAtEpochMs !== undefined &&
    nowEpochMs < cached.expiresAtEpochMs
  );
}

export function secondaryRegistrationsToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: DesktopSecondaryBootstrapsRead,
  nowEpochMs: number,
): ReadonlyMap<string, CachedPlatformRegistration> {
  if (topologyRead._tag === "Success") {
    return new Map();
  }
  return new Map(
    [...previous].filter(
      ([, cached]) => cached.expiresAtEpochMs !== undefined && nowEpochMs < cached.expiresAtEpochMs,
    ),
  );
}

/** The earliest cached bearer refresh deadline, or undefined while none is pending. */
export function earliestRefreshAtEpochMs(
  cache: ReadonlyMap<string, CachedPlatformRegistration>,
): number | undefined {
  let earliest: number | undefined;
  for (const cached of cache.values()) {
    if (
      cached.refreshAtEpochMs !== undefined &&
      (earliest === undefined || cached.refreshAtEpochMs < earliest)
    ) {
      earliest = cached.refreshAtEpochMs;
    }
  }
  return earliest;
}

export interface PlatformRegistrationRefreshOptions {
  /**
   * Push events signalling that the desktop topology changed, sourced from
   * `window.desktopBridge.onLocalEnvironmentBootstrapsChange`. When absent —
   * an older desktop shell or plain web — the source falls back to the
   * {@link PLATFORM_POLL_INTERVAL} tick.
   */
  readonly changeEvents?: Stream.Stream<void>;
  /** Rebuild the full registration set from the current topology. */
  readonly rebuild: Effect.Effect<ReadonlyArray<PlatformConnectionRegistration>>;
  /**
   * The earliest cached bearer refresh deadline (absolute epoch ms), none
   * while nothing is scheduled to re-issue.
   */
  readonly nextRefreshAtEpochMs: Effect.Effect<Option.Option<number>>;
  /**
   * Whether the most recent rebuild dropped an expected entry for a retryable
   * reason (a transient load or topology failure — readiness skips excluded).
   * When true the source arms a wake at a bounded backoff so push-only shells
   * still retry instead of waiting for a change event that may never come.
   */
  readonly rebuildFailed?: Effect.Effect<boolean>;
}

/**
 * Drive registration rebuilds from pushes instead of a poll. With change
 * events the source rebuilds once when it starts, then only on a push, when
 * the earliest cached bearer credential nears expiry, or — at a bounded
 * backoff — when the last rebuild dropped an entry for a retryable reason
 * (re-armed after every rebuild, so failed re-issues keep retrying instead of
 * going silent). Without change events it keeps the historical interval tick
 * unchanged.
 */
export function platformRegistrationRefreshes(
  options: PlatformRegistrationRefreshOptions,
): Stream.Stream<ReadonlyArray<PlatformConnectionRegistration>> {
  const { changeEvents, rebuild, nextRefreshAtEpochMs, rebuildFailed } = options;
  if (changeEvents === undefined) {
    return Stream.tick(PLATFORM_POLL_INTERVAL).pipe(Stream.mapEffect(() => rebuild));
  }
  return Stream.unwrap(
    Effect.gen(function* () {
      const wakeups = yield* Queue.unbounded<void>();
      const pendingWaker = yield* Ref.make<Option.Option<Fiber.Fiber<void, never>>>(Option.none());
      const consecutiveFailures = yield* Ref.make(0);
      const armNextRefreshWaker = Effect.gen(function* () {
        const pending = yield* Ref.get(pendingWaker);
        if (Option.isSome(pending)) {
          yield* Fiber.interrupt(pending.value);
        }
        const failed = rebuildFailed === undefined ? false : yield* rebuildFailed;
        const failures = failed
          ? yield* Ref.updateAndGet(consecutiveFailures, (count) => count + 1)
          : yield* Ref.setAndGet(consecutiveFailures, 0);
        const nowEpochMs = yield* Clock.currentTimeMillis;
        const nextAtEpochMs = yield* nextRefreshAtEpochMs;
        // Arm at the earlier of the bearer re-issue deadline (clamped to the
        // retry floor so an overdue deadline does not hot-loop) and the
        // failure backoff (the floor doubling per consecutive failure, capped
        // at FAILURE_RETRY_MAX_MS).
        const bearerDelayMs = Option.isSome(nextAtEpochMs)
          ? Math.max(REFRESH_WAKE_RETRY_MIN_MS, nextAtEpochMs.value - nowEpochMs)
          : undefined;
        const failureDelayMs =
          failures > 0
            ? Math.min(REFRESH_WAKE_RETRY_MIN_MS * 2 ** (failures - 1), FAILURE_RETRY_MAX_MS)
            : undefined;
        if (bearerDelayMs === undefined && failureDelayMs === undefined) {
          yield* Ref.set(pendingWaker, Option.none());
          return;
        }
        const delayMs = Math.min(
          bearerDelayMs ?? Number.POSITIVE_INFINITY,
          failureDelayMs ?? Number.POSITIVE_INFINITY,
        );
        const waker = yield* Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(delayMs));
          Queue.offerUnsafe(wakeups, undefined);
        }).pipe(Effect.forkDetach);
        yield* Ref.set(pendingWaker, Option.some(waker));
      });
      // The initial element builds the first registration set right away
      // (mirroring the tick's immediate first emission) and arms the first
      // expiry wake from its result.
      return Stream.merge(
        Stream.concat(Stream.succeed<void>(undefined), Stream.fromQueue(wakeups)),
        changeEvents,
      ).pipe(Stream.mapEffect(() => rebuild.pipe(Effect.tap(() => armNextRefreshWaker))));
    }),
  );
}

// A failed gateway list fetch keeps the last list and is not retried before this elapses.
const GATEWAY_RETRY_AFTER_MS = 30_000;

const platformConnectionSourceLayer = Layer.effect(
  PlatformConnectionSource,
  Effect.gen(function* () {
    if (isHostedStaticApp() || isLocalEnvironmentDisabled()) {
      return PlatformConnectionSource.of({
        registrations: Stream.empty,
      });
    }
    const cacheRef = yield* Ref.make(new Map<string, CachedPlatformRegistration>());
    // Set by a rebuild that dropped an expected entry for a retryable reason;
    // reset at the start of every rebuild so it always reflects the last one.
    const rebuildFailedRef = yield* Ref.make(false);

    // Environments the host forwards through its gateway. The list is fetched in the
    // background on boot and again when the app regains focus or the network returns; the
    // 3-second topology tick only reads what was last fetched. The desktop app registers
    // those environments directly, so it never asks.
    const gateway = {
      environments: [] as ReadonlyArray<GatewayEnvironment>,
      refreshRequested: window.desktopBridge === undefined,
      inFlight: false,
      retryAfterEpochMs: 0,
    };
    if (window.desktopBridge === undefined) {
      const requestRefresh = () => {
        gateway.refreshRequested = true;
      };
      window.addEventListener("online", requestRefresh);
      window.addEventListener("focus", requestRefresh);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") requestRefresh();
      });
    }
    const refreshGatewayEnvironments = (hostOrigin: string, hostLabel: string) =>
      Effect.gen(function* () {
        const nowEpochMs = yield* Clock.currentTimeMillis;
        if (gateway.inFlight || !gateway.refreshRequested || nowEpochMs < gateway.retryAfterEpochMs)
          return;
        gateway.inFlight = true;
        gateway.refreshRequested = false;
        const fetched = yield* fetchGatewayEnvironments(hostOrigin).pipe(
          Effect.provide(primaryEnvironmentHttpLayer),
          Effect.option,
        );
        gateway.inFlight = false;
        if (Option.isNone(fetched)) {
          gateway.retryAfterEpochMs = nowEpochMs + GATEWAY_RETRY_AFTER_MS;
          gateway.refreshRequested = true;
          return;
        }
        gateway.environments = fetched.value;
        appAtomRegistry.set(
          gatewayEnvironmentInfoAtom,
          new Map<EnvironmentId, { status: GatewayEnvironment["status"]; hostLabel: string }>(
            fetched.value.map((environment) => [
              environment.environmentId,
              { status: environment.status, hostLabel },
            ]),
          ),
        );
      }).pipe(Effect.forkDetach, Effect.asVoid);

    // Resolve the full set of platform-managed environments the host currently
    // reports: the primary (same-origin cookie auth) plus any desktop-local
    // backends running alongside it (bearer auth). Reused registrations come
    // from the cache; an entry lost to a transient failure is skipped and
    // flagged so the next wake retries it (push-only shells have no tick to
    // fall back on), while backends still awaiting their endpoints stay
    // skipped until the main process announces their config.
    const buildPlatformRegistrations = Effect.gen(function* () {
      yield* Ref.set(rebuildFailedRef, false);
      const previous = yield* Ref.get(cacheRef);
      const nowEpochMs = yield* Clock.currentTimeMillis;
      const next = new Map<string, CachedPlatformRegistration>();
      const registrations: Array<PlatformConnectionRegistration> = [];

      const primaryTopologyRead = readPrimaryEnvironmentTargetResult();
      const retainedPrimary = primaryRegistrationToRetainAfterTopologyRead(
        previous,
        primaryTopologyRead,
      );
      if (retainedPrimary !== undefined) {
        next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, retainedPrimary);
        registrations.push(retainedPrimary.registration);
      }

      if (primaryTopologyRead._tag === "Failure") {
        yield* Ref.set(rebuildFailedRef, true);
        yield* Effect.logWarning("Could not read the primary environment topology.", {
          cause: primaryTopologyRead.cause,
        });
      } else if (primaryTopologyRead.target !== null) {
        const primaryTarget = primaryTopologyRead.target;
        const signature = `primary|${primaryTarget.target.httpBaseUrl}|${primaryTarget.target.wsBaseUrl}`;
        const cached = previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID);
        if (
          cached !== undefined &&
          canReuseCachedPlatformRegistration(cached, signature, nowEpochMs)
        ) {
          next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cached);
          registrations.push(cached.registration);
        } else {
          const built = yield* loadPrimaryConnectionRegistration(primaryTarget).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not discover the primary environment.", { error }),
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = { signature, registration: built.value };
            next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cacheEntry);
            registrations.push(built.value);
          } else {
            yield* Ref.set(rebuildFailedRef, true);
          }
        }
      }

      const topologyRead = readDesktopSecondaryBootstrapsResult();
      for (const [id, cached] of secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        topologyRead,
        nowEpochMs,
      )) {
        next.set(id, cached);
        registrations.push(cached.registration);
      }

      if (topologyRead._tag === "Failure") {
        yield* Ref.set(rebuildFailedRef, true);
        yield* Effect.logWarning("Could not read the desktop-local backend topology.", {
          cause: topologyRead.cause,
        });
      } else {
        for (const bootstrap of topologyRead.bootstraps) {
          const signature = `${bootstrap.httpBaseUrl}|${bootstrap.wsBaseUrl}|${bootstrap.bootstrapToken ?? ""}`;
          const cached = previous.get(bootstrap.id);
          if (
            cached !== undefined &&
            canReuseCachedPlatformRegistration(cached, signature, nowEpochMs)
          ) {
            next.set(bootstrap.id, cached);
            registrations.push(cached.registration);
            continue;
          }
          const built = yield* loadSecondaryConnectionRegistration(bootstrap).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not connect a desktop-local backend.", {
                id: bootstrap.id,
                error,
              }),
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = { signature, ...built.value };
            next.set(bootstrap.id, cacheEntry);
            registrations.push(built.value.registration);
          } else if (
            cached !== undefined &&
            canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, signature, nowEpochMs)
          ) {
            next.set(bootstrap.id, cached);
            registrations.push(cached.registration);
          } else if (desktopBackendEndpointsReady(bootstrap)) {
            // The retained stale credential above keeps its own refresh
            // deadline, and a backend still awaiting its endpoints is
            // announced by the main process when its config resolves; a ready
            // backend failing to load is the retryable case the wake covers.
            yield* Ref.set(rebuildFailedRef, true);
          }
        }
      }

      const primaryRegistration = next.get(PRIMARY_LOCAL_ENVIRONMENT_ID)?.registration;
      if (
        window.desktopBridge === undefined &&
        primaryRegistration?._tag === "PrimaryConnectionRegistration"
      ) {
        const hostOrigin = new URL(primaryRegistration.target.httpBaseUrl).origin;
        yield* refreshGatewayEnvironments(hostOrigin, primaryRegistration.target.label);
        registrations.push(
          ...gatewayRegistrations({
            environments: gateway.environments,
            hostOrigin,
            skipEnvironmentIds: new Set(
              registrations.map((registration) => registration.target.environmentId),
            ),
          }),
        );
      }

      yield* Ref.set(cacheRef, next);
      return registrations as ReadonlyArray<PlatformConnectionRegistration>;
    }).pipe(Effect.provide(FetchHttpClient.layer));

    const nextRefreshAtEpochMs: Effect.Effect<Option.Option<number>> = Effect.map(
      Ref.get(cacheRef),
      (cache) => Option.fromNullishOr(earliestRefreshAtEpochMs(cache)),
    );

    // The main process pushes a bootstraps change on every topology change the
    // source can see — backends registering/unregistering and each backend's
    // config resolving (covering restarts and port changes, which the primary
    // target also derives from the same bootstraps list). The enabled toggle
    // relaunches the app, so it needs no in-flight trigger. Shells without the
    // event keep the 3-second tick.
    const bootstrapsRefresh = resolveDesktopBootstrapsRefresh(window.desktopBridge);
    const registrations =
      bootstrapsRefresh._tag === "Subscribe"
        ? platformRegistrationRefreshes({
            changeEvents: Stream.callback<void>((queue) =>
              Effect.acquireRelease(
                Effect.sync(() =>
                  bootstrapsRefresh.subscribe(() => Queue.offerUnsafe(queue, undefined)),
                ),
                (unsubscribe) => Effect.sync(() => unsubscribe()),
              ).pipe(Effect.asVoid),
            ),
            rebuild: buildPlatformRegistrations,
            nextRefreshAtEpochMs,
            rebuildFailed: Ref.get(rebuildFailedRef),
          })
        : platformRegistrationRefreshes({
            rebuild: buildPlatformRegistrations,
            nextRefreshAtEpochMs,
            rebuildFailed: Ref.get(rebuildFailedRef),
          });

    return PlatformConnectionSource.of({ registrations });
  }),
);

const environmentOwnedDataCleanupLayer = Layer.succeed(
  EnvironmentOwnedDataCleanup,
  EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Effect.sync(() => {
        clearComposerDraftsEnvironment(environmentId);
      }),
  }),
);

const rpcRequestObserverLayer = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    observe: ({ environmentId, method }) =>
      Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, method, `${method} · ${environmentId}`);
        return Effect.sync(() => {
          acknowledgeRpcRequest(requestId);
        });
      }),
  }),
);

type ConnectionPlatformLayerSource =
  | typeof connectionStorageLayer
  | typeof connectivityLayer
  | typeof wakeupsLayer
  | typeof capabilitiesLayer
  | typeof platformConnectionSourceLayer
  | typeof environmentOwnedDataCleanupLayer
  | typeof rpcRequestObserverLayer;

export const connectionPlatformLayer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  connectionStorageLayer,
  connectivityLayer,
  wakeupsLayer,
  capabilitiesLayer,
  platformConnectionSourceLayer,
  environmentOwnedDataCleanupLayer,
  rpcRequestObserverLayer,
);
