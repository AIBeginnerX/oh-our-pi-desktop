import { assert, describe, it } from "@effect/vitest";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  EnvironmentId,
  type GatewayEnvironmentStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";
import {
  getPhoneSharedEnvironments,
  setEnvironmentPhoneShared,
} from "../ipc/methods/phoneSharing.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as Clients from "./DesktopGatewayClients.ts";
import * as DesktopGatewayPublisher from "./DesktopGatewayPublisher.ts";

const encodeCatalog = Schema.encodeEffect(Schema.fromJsonString(ConnectionCatalogDocument));

const SSH_ID = EnvironmentId.make("ssh-env");
const ADMIN_ID = EnvironmentId.make("tailnet-admin-env");
const STANDARD_ID = EnvironmentId.make("standard-env");
const sshTarget = { alias: "devbox", hostname: "devbox.local", username: null, port: null };

const catalogWith = (ids: ReadonlyArray<EnvironmentId>) =>
  encodeCatalog({
    schemaVersion: 1,
    targets: ids.map((environmentId) =>
      environmentId === SSH_ID
        ? new SshConnectionTarget({
            environmentId,
            label: "Devbox",
            connectionId: `c:${environmentId}`,
          })
        : new BearerConnectionTarget({
            environmentId,
            label: `Label ${environmentId}`,
            connectionId: `c:${environmentId}`,
          }),
    ),
    profiles: ids.map((environmentId) =>
      environmentId === SSH_ID
        ? new SshConnectionProfile({
            connectionId: `c:${environmentId}`,
            environmentId,
            label: "Devbox",
            target: sshTarget,
          })
        : new BearerConnectionProfile({
            connectionId: `c:${environmentId}`,
            environmentId,
            label: `Label ${environmentId}`,
            httpBaseUrl: `https://${environmentId}.example.ts.net/`,
            wsBaseUrl: `wss://${environmentId}.example.ts.net/`,
          }),
    ),
    credentials: ids
      .filter((environmentId) => environmentId !== SSH_ID)
      .map((environmentId) => ({
        connectionId: `c:${environmentId}`,
        credential: new BearerConnectionCredential({ token: `stored-${environmentId}` }),
      })),
    remoteDpopTokens: [],
    disabledEnvironmentIds: [],
  });

/** In-memory stand-ins for the store, SSH manager, host backend, and upstream auth APIs. */
function makeWorld(options?: {
  readonly exchangeScopes?: ReadonlyArray<string>;
  readonly failSsh?: boolean;
  readonly mintFails?: boolean;
}) {
  const world = {
    catalog: "",
    shared: [] as Array<string>,
    sshPort: 41000,
    sshEnsures: [] as Array<{ pairing: boolean }>,
    hostKey: Option.some("host-1") as Option.Option<string>,
    upserts: [] as Array<{ environmentId: string; httpBaseUrl: string; bearerToken: string }>,
    removes: [] as Array<string>,
    statuses: new Map<string, GatewayEnvironmentStatus>(),
    exchanges: [] as Array<{ scopes: ReadonlyArray<string>; credential: string }>,
    minted: [] as Array<{ bearerToken: string; scopes: ReadonlyArray<string> }>,
    revoked: [] as Array<{ httpBaseUrl: string; bearerToken: string }>,
    sessionScopes: new Map<string, ReadonlyArray<string>>([
      ["stored-tailnet-admin-env", AuthAdministrativeScopes],
      ["stored-standard-env", AuthStandardClientScopes],
    ]),
    counter: 0,
  };

  const store = Layer.succeed(
    DesktopConnectionCatalogStore.DesktopConnectionCatalogStore,
    DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.of({
      get: Effect.sync(() => Option.some(world.catalog)),
      set: () => Effect.succeed(true),
      clear: Effect.void,
      getPhoneShared: Effect.sync(() => [...world.shared]),
      setPhoneShared: (id, on) =>
        Effect.sync(() => {
          world.shared = world.shared.filter((value) => value !== id);
          if (on) world.shared.push(id);
        }),
    }),
  );
  const ssh = Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment, {
    ensureEnvironment: (target, ensureOptions) =>
      options?.failSsh
        ? Effect.sync(() => void world.sshEnsures.push({ pairing: false })).pipe(
            Effect.andThen(Effect.die(new Error("ssh down"))),
          )
        : Effect.sync(() => {
            world.sshEnsures.push({ pairing: ensureOptions?.issuePairingToken === true });
            return {
              target,
              httpBaseUrl: `http://127.0.0.1:${world.sshPort}/`,
              wsBaseUrl: `ws://127.0.0.1:${world.sshPort}/`,
              pairingToken: ensureOptions?.issuePairingToken ? `pairing-${world.counter++}` : null,
            };
          }),
  });
  const host = Layer.succeed(
    Clients.DesktopGatewayHost,
    Clients.DesktopGatewayHost.of({
      hostKey: Effect.sync(() => world.hostKey),
      upsert: (input) => Effect.sync(() => void world.upserts.push(input)),
      remove: (input) => Effect.sync(() => void world.removes.push(input.environmentId)),
      statuses: Effect.sync(() => world.statuses),
    }),
  );
  const upstream = Layer.succeed(
    Clients.DesktopGatewayUpstream,
    Clients.DesktopGatewayUpstream.of({
      exchange: ({ credential, scopes }) =>
        Effect.sync(() => {
          world.exchanges.push({ credential, scopes });
          return {
            accessToken: `upstream-session-${world.counter++}`,
            scopes: options?.exchangeScopes ?? scopes,
          };
        }),
      mintPairingCredential: ({ bearerToken, scopes }) =>
        options?.mintFails
          ? Effect.fail(new Clients.DesktopGatewayError({ message: "mint denied" }))
          : Effect.sync(() => {
              world.minted.push({ bearerToken, scopes });
              return `minted-credential-${world.counter++}`;
            }),
      sessionScopes: ({ bearerToken }) =>
        Effect.succeed(world.sessionScopes.get(bearerToken) ?? []),
      revokeGatewaySessions: ({ httpBaseUrl, bearerToken }) =>
        Effect.sync(() => void world.revoked.push({ httpBaseUrl, bearerToken })),
    }),
  );
  const layer = DesktopGatewayPublisher.layerManual.pipe(
    Layer.provideMerge(Layer.mergeAll(store, ssh, host, upstream)),
  );
  return { world, layer };
}

const publisherTest = <A, E>(
  body: (
    publisher: DesktopGatewayPublisher.DesktopGatewayPublisher["Service"],
    world: ReturnType<typeof makeWorld>["world"],
  ) => Effect.Effect<A, E, DesktopGatewayPublisher.DesktopGatewayPublisher>,
  options?: Parameters<typeof makeWorld>[0],
) => {
  const { world, layer } = makeWorld(options);
  return Effect.gen(function* () {
    world.catalog = yield* catalogWith([SSH_ID, ADMIN_ID, STANDARD_ID]);
    const publisher = yield* DesktopGatewayPublisher.DesktopGatewayPublisher;
    return yield* body(publisher, world);
  }).pipe(Effect.provide(layer), Effect.scoped);
};

const isStandard = (scopes: ReadonlyArray<string>) =>
  scopes.every((scope) => (AuthStandardClientScopes as ReadonlyArray<string>).includes(scope));

describe("DesktopGatewayPublisher", () => {
  it.effect("opens no tunnels and publishes nothing while nothing is shared", () =>
    publisherTest((publisher, world) =>
      Effect.gen(function* () {
        yield* publisher.reconcile;
        assert.deepStrictEqual(world.sshEnsures, []);
        assert.deepStrictEqual(world.upserts, []);
        assert.deepStrictEqual(yield* publisher.status, []);
      }),
    ),
  );

  it.effect("publishes an SSH environment with a standard session over the forward", () =>
    publisherTest((publisher, world) =>
      Effect.gen(function* () {
        yield* publisher.setShared(SSH_ID, true);
        yield* publisher.reconcile;
        assert.strictEqual(world.upserts.length, 1);
        const published = world.upserts[0]!;
        assert.strictEqual(published.environmentId, SSH_ID);
        assert.strictEqual(published.httpBaseUrl, "http://127.0.0.1:41000");
        assert.match(published.bearerToken, /^upstream-session-/u);
        assert.deepStrictEqual(world.exchanges.at(0)?.scopes, AuthStandardClientScopes);
        assert.deepStrictEqual(yield* publisher.status, [
          { environmentId: SSH_ID, state: "published", message: null },
        ]);
      }),
    ),
  );

  it.effect("mints a separate standard session for an admin bearer remote", () =>
    publisherTest((publisher, world) =>
      Effect.gen(function* () {
        yield* publisher.setShared(ADMIN_ID, true);
        yield* publisher.reconcile;
        assert.deepStrictEqual(world.minted, [
          { bearerToken: "stored-tailnet-admin-env", scopes: AuthStandardClientScopes },
        ]);
        const published = world.upserts[0]!;
        assert.strictEqual(published.httpBaseUrl, "https://tailnet-admin-env.example.ts.net");
        assert.notStrictEqual(published.bearerToken, "stored-tailnet-admin-env");
        assert.deepStrictEqual(world.sshEnsures, []);
      }),
    ),
  );

  it.effect("reuses a stored bearer only when it is already standard scope", () =>
    publisherTest((publisher, world) =>
      Effect.gen(function* () {
        yield* publisher.setShared(STANDARD_ID, true);
        yield* publisher.reconcile;
        assert.strictEqual(world.upserts[0]?.bearerToken, "stored-standard-env");
        assert.deepStrictEqual(world.minted, []);
        // Not ours to revoke.
        yield* publisher.setShared(STANDARD_ID, false);
        yield* publisher.reconcile;
        assert.deepStrictEqual(world.removes, [STANDARD_ID]);
        assert.deepStrictEqual(world.revoked, []);
      }),
    ),
  );

  it.effect("never publishes an administrative bearer", () =>
    publisherTest(
      (publisher, world) =>
        Effect.gen(function* () {
          yield* publisher.setShared(ADMIN_ID, true);
          yield* publisher.reconcile;
          assert.deepStrictEqual(world.upserts, []);
          assert.strictEqual((yield* publisher.status)[0]?.state, "error");
        }),
      { mintFails: true },
    ),
  );

  it.effect("refuses an upstream session that came back with administrative scopes", () =>
    publisherTest(
      (publisher, world) =>
        Effect.gen(function* () {
          yield* publisher.setShared(SSH_ID, true);
          yield* publisher.setShared(ADMIN_ID, true);
          yield* publisher.reconcile;
          assert.deepStrictEqual(world.upserts, []);
          assert.isTrue(
            (yield* publisher.status).every(
              (entry) => entry.state === "error" && entry.message?.includes("administrative"),
            ),
          );
        }),
      { exchangeScopes: AuthAdministrativeScopes },
    ),
  );

  it.effect("every bearer handed to the host is standard scope", () =>
    publisherTest((publisher, world) =>
      Effect.gen(function* () {
        for (const id of [SSH_ID, ADMIN_ID, STANDARD_ID]) yield* publisher.setShared(id, true);
        yield* publisher.reconcile;
        assert.strictEqual(world.upserts.length, 3);
        for (const upsert of world.upserts) {
          const scopes = world.sessionScopes.get(upsert.bearerToken) ?? AuthStandardClientScopes;
          assert.isTrue(isStandard(scopes), upsert.environmentId);
          assert.notStrictEqual(upsert.bearerToken, "stored-tailnet-admin-env");
        }
      }),
    ),
  );

  it.effect("republishes when the SSH forward moves, keeping the same session", () =>
    publisherTest((publisher, world) =>
      Effect.gen(function* () {
        yield* publisher.setShared(SSH_ID, true);
        yield* publisher.reconcile;
        yield* publisher.reconcile;
        assert.strictEqual(world.upserts.length, 1);

        world.sshPort = 41999;
        yield* publisher.reconcile;
        assert.strictEqual(world.upserts.length, 2);
        assert.strictEqual(world.upserts[1]?.httpBaseUrl, "http://127.0.0.1:41999");
        assert.strictEqual(world.upserts[1]?.bearerToken, world.upserts[0]?.bearerToken);
        assert.strictEqual(world.exchanges.length, 1);
      }),
    ),
  );

  it.effect("republishes everything after the local backend restarts", () =>
    publisherTest((publisher, world) =>
      Effect.gen(function* () {
        yield* publisher.setShared(STANDARD_ID, true);
        yield* publisher.reconcile;
        world.hostKey = Option.some("host-2");
        yield* publisher.reconcile;
        assert.strictEqual(world.upserts.length, 2);
      }),
    ),
  );

  it.effect("mints a fresh session when the host reports the upstream rejected it", () =>
    publisherTest((publisher, world) =>
      Effect.gen(function* () {
        yield* publisher.setShared(SSH_ID, true);
        yield* publisher.reconcile;
        world.statuses.set(SSH_ID, "auth-failed");
        yield* publisher.reconcile;
        assert.strictEqual(world.upserts.length, 2);
        assert.notStrictEqual(world.upserts[1]?.bearerToken, world.upserts[0]?.bearerToken);
      }),
    ),
  );

  it.effect("unpublishes and revokes when the toggle goes off", () =>
    publisherTest((publisher, world) =>
      Effect.gen(function* () {
        yield* publisher.setShared(ADMIN_ID, true);
        yield* publisher.reconcile;
        yield* publisher.setShared(ADMIN_ID, false);
        const revokedBefore = world.revoked.length;
        yield* publisher.reconcile;
        assert.deepStrictEqual(world.removes, [ADMIN_ID]);
        assert.isAbove(world.revoked.length, revokedBefore);
        assert.strictEqual(world.revoked.at(-1)?.bearerToken, "stored-tailnet-admin-env");
        assert.deepStrictEqual(yield* publisher.status, []);
      }),
    ),
  );

  it.effect("unpublishes and revokes an SSH session through a fresh admin cleanup session", () =>
    publisherTest((publisher, world) =>
      Effect.gen(function* () {
        yield* publisher.setShared(SSH_ID, true);
        yield* publisher.reconcile;
        yield* publisher.setShared(SSH_ID, false);
        yield* publisher.reconcile;
        assert.deepStrictEqual(world.removes, [SSH_ID]);
        assert.strictEqual(world.revoked.length, 1);
        assert.deepStrictEqual(world.exchanges.at(-1)?.scopes, AuthAdministrativeScopes);
      }),
    ),
  );

  it.effect("unshares an environment removed from the catalog", () =>
    publisherTest((publisher, world) =>
      Effect.gen(function* () {
        yield* publisher.setShared(ADMIN_ID, true);
        yield* publisher.reconcile;
        world.catalog = yield* catalogWith([SSH_ID, STANDARD_ID]);
        yield* publisher.reconcile;
        assert.deepStrictEqual(world.removes, [ADMIN_ID]);
        assert.deepStrictEqual(world.shared, []);
        assert.isAbove(world.revoked.length, 0);
      }),
    ),
  );

  it.effect("backs off after a failure until kicked", () =>
    publisherTest(
      (publisher, world) =>
        Effect.gen(function* () {
          yield* publisher.setShared(SSH_ID, true);
          yield* publisher.reconcile;
          assert.strictEqual((yield* publisher.status)[0]?.state, "error");
          assert.strictEqual(world.sshEnsures.length, 1);
          yield* publisher.reconcile;
          assert.strictEqual(world.sshEnsures.length, 1);
          yield* publisher.kick;
          yield* publisher.reconcile;
          assert.strictEqual(world.sshEnsures.length, 2);
        }),
      { failSsh: true },
    ),
  );

  it.effect("round-trips the phone sharing setting through the desktop IPC methods", () => {
    const { world, layer } = makeWorld();
    return Effect.gen(function* () {
      world.catalog = yield* catalogWith([SSH_ID, STANDARD_ID]);
      assert.deepStrictEqual(yield* getPhoneSharedEnvironments.handler(undefined), []);

      const afterOn = yield* setEnvironmentPhoneShared.handler({
        environmentId: STANDARD_ID,
        shared: true,
      });
      assert.deepStrictEqual(afterOn, [
        { environmentId: STANDARD_ID, state: "connecting", message: null },
      ]);
      assert.deepStrictEqual(yield* getPhoneSharedEnvironments.handler(undefined), afterOn);

      const publisher = yield* DesktopGatewayPublisher.DesktopGatewayPublisher;
      yield* publisher.reconcile;
      assert.deepStrictEqual(yield* getPhoneSharedEnvironments.handler(undefined), [
        { environmentId: STANDARD_ID, state: "published", message: null },
      ]);

      assert.deepStrictEqual(
        yield* setEnvironmentPhoneShared.handler({ environmentId: STANDARD_ID, shared: false }),
        [],
      );
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});
