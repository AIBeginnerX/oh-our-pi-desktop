import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@t3tools/contracts";
import { it, assert, vi } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProviderAuthFlow from "../ProviderAuthFlow.ts";

import type * as ClaudeAdapter from "../Services/ClaudeAdapter.ts";
import type * as CodexAdapter from "../Services/CodexAdapter.ts";
import type * as CursorAdapter from "../Services/CursorAdapter.ts";
import type * as OpenCodeAdapter from "../Services/OpenCodeAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import type { AnyProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as ProviderAdapterRegistryLayer from "./ProviderAdapterRegistry.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

const fakeCodexAdapter: CodexAdapter.CodexAdapterShape = {
  provider: CODEX_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  uploadFeedback: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeClaudeAdapter: ClaudeAdapter.ClaudeAdapterShape = {
  provider: CLAUDE_AGENT_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeOpenCodeAdapter: OpenCodeAdapter.OpenCodeAdapterShape = {
  provider: OPENCODE_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeCursorAdapter: CursorAdapter.CursorAdapterShape = {
  provider: CURSOR_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const makeFakeInstance = (
  driverKindString: "codex" | "claudeAgent" | "cursor" | "opencode",
  adapter: ProviderInstance["adapter"],
  overrides?: {
    readonly instanceId?: ProviderInstanceId;
    readonly auth?: ProviderInstance["auth"];
  },
): ProviderInstance => {
  const driverKind = ProviderDriverKind.make(driverKindString);
  const instanceId = overrides?.instanceId ?? defaultInstanceIdForDriver(driverKind);
  return {
    instanceId,
    driverKind,
    continuationIdentity: {
      driverKind,
      continuationKey: `${driverKind}:instance:${instanceId}`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      resolveMaintenance: () =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({
            provider: driverKind,
            packageName: null,
          }),
        ),
      getSnapshot: Effect.succeed({} as unknown as ServerProvider),
      refresh: Effect.succeed({} as unknown as ServerProvider),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
    },
    adapter,
    textGeneration: {} as unknown as TextGeneration.TextGeneration["Service"],
    ...(overrides?.auth === undefined ? {} : { auth: overrides.auth }),
  };
};

const fakeInstances: ReadonlyArray<ProviderInstance> = [
  makeFakeInstance("codex", fakeCodexAdapter),
  makeFakeInstance("claudeAgent", fakeClaudeAdapter),
  makeFakeInstance("opencode", fakeOpenCodeAdapter),
  makeFakeInstance("cursor", fakeCursorAdapter),
];

const fakeInstanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(fakeInstances.find((instance) => instance.instanceId === instanceId)),
  listInstances: Effect.succeed(fakeInstances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  // Tests never drive changes through this fake; acquire a throwaway
  // subscription on an unused PubSub so the shape is satisfied.
  subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) => PubSub.subscribe(pubsub)),
});

const layer = Layer.mergeAll(
  Layer.provide(
    ProviderAdapterRegistryLayer.ProviderAdapterRegistryLive,
    fakeInstanceRegistryLayer,
  ),
  NodeServices.layer,
);

it.layer(layer)("ProviderAdapterRegistryLive", (it) => {
  it("resolves adapters and routing metadata from provider instances", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
      const claudeInstanceId = defaultInstanceIdForDriver(CLAUDE_AGENT_DRIVER);

      const adapter = yield* registry.getByInstance(claudeInstanceId);
      assert.strictEqual(adapter, fakeClaudeAdapter);

      const info = yield* registry.getInstanceInfo(claudeInstanceId);
      assert.deepStrictEqual(info, {
        instanceId: claudeInstanceId,
        driverKind: CLAUDE_AGENT_DRIVER,
        displayName: undefined,
        accentColor: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: CLAUDE_AGENT_DRIVER,
          continuationKey: "claudeAgent:instance:claudeAgent",
        },
      });

      const instances = yield* registry.listInstances();
      assert.deepStrictEqual(instances, [
        defaultInstanceIdForDriver(CODEX_DRIVER),
        claudeInstanceId,
        defaultInstanceIdForDriver(OPENCODE_DRIVER),
        defaultInstanceIdForDriver(CURSOR_DRIVER),
      ]);
    }));
});

it.effect("blocks shared credential session startup and preserves guarded adapter identity", () =>
  Effect.gen(function* () {
    const target = fakeInstances[0]!;
    const peer = fakeInstances[1]!;
    const auth = yield* ProviderAuthFlow.make({
      instanceId: target.instanceId,
      credentialBinding: { owner: "t3", key: "shared-auth" },
      methods: Effect.succeed([
        { id: "browser", name: "Browser", description: null, type: "agent" },
      ]),
      authenticate: () => Effect.never,
      logout: Effect.void,
    });
    const peerAuth = yield* ProviderAuthFlow.make({
      instanceId: peer.instanceId,
      credentialBinding: { owner: "t3", key: "shared-auth" },
      methods: Effect.succeed([]),
      authenticate: () => Effect.void,
      logout: Effect.void,
    });
    const session = {
      threadId: ThreadId.make("new-session"),
      provider: peer.driverKind,
      providerInstanceId: peer.instanceId,
      status: "ready" as const,
      runtimeMode: "approval-required" as const,
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    };
    const start = vi.fn(() => Effect.succeed(session));
    const instances = [
      { ...target, auth },
      { ...peer, auth: peerAuth, adapter: { ...peer.adapter, startSession: start } },
    ];
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry.pipe(
      Effect.provide(
        ProviderAdapterRegistryLayer.ProviderAdapterRegistryLive.pipe(
          Layer.provide(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: (id) =>
                Effect.succeed(instances.find((instance) => instance.instanceId === id)),
              listInstances: Effect.succeed(instances),
            }),
          ),
        ),
      ),
    );
    const guarded = yield* registry.getByInstance(peer.instanceId);
    assert.strictEqual(yield* registry.getByInstance(peer.instanceId), guarded);
    const flow = yield* auth.start("owner");
    const error = yield* guarded
      .startSession({
        threadId: session.threadId,
        providerInstanceId: peer.instanceId,
        runtimeMode: "approval-required",
      })
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "ProviderAdapterValidationError");
    assert.strictEqual(start.mock.calls.length, 0);
    yield* auth.cancel("owner", flow.flowId!);
    assert.deepStrictEqual(
      yield* guarded.startSession({
        threadId: session.threadId,
        providerInstanceId: peer.instanceId,
        runtimeMode: "approval-required",
      }),
      session,
    );
    assert.strictEqual(start.mock.calls.length, 1);
    const entered = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    start.mockImplementation(() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        return yield* Effect.never;
      }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
    );
    const startup = yield* guarded
      .startSession({
        threadId: session.threadId,
        providerInstanceId: peer.instanceId,
        runtimeMode: "approval-required",
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    // Signing out through another instance must drain its peer's startup too.
    yield* auth.logout(Effect.void);
    yield* Deferred.await(stopped);
    assert.strictEqual(Exit.isFailure(yield* Fiber.await(startup)), true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// --- isCurrentAdapter: real registry + real facade ---------------------------
//
// The ownership predicate exists so memory admission can re-check — at the
// synchronous publish point inside an adapter — that the adapter it captured
// at routing time is still the one the registry routes to. These tests drive
// the real `ProviderInstanceRegistry` (Ref-backed, reconcile via the mutator)
// under the real `ProviderAdapterRegistryLive` facade; a probe driver makes
// create/replace/failed-close sequences deterministic without spawning
// provider CLIs.

const makeProbeAdapter = (): ProviderInstance["adapter"] => ({ ...fakeCodexAdapter });

const makeProbeDriver = <R>(
  create: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly scope: Scope.Scope;
  }) => Effect.Effect<ProviderInstance, never, R>,
): AnyProviderDriver<R> => ({
  driverKind: CODEX_DRIVER,
  metadata: { displayName: "Ownership probe" },
  configSchema: Schema.Unknown,
  defaultConfig: () => ({}),
  create: (createInput) =>
    Effect.gen(function* () {
      return yield* create({
        instanceId: createInput.instanceId,
        scope: yield* Scope.Scope,
      });
    }),
});

const probeConfig = (id: ProviderInstanceId, marker: number): ProviderInstanceConfigMap => ({
  [id]: { driver: CODEX_DRIVER, enabled: true, config: { marker } },
});

const setupOwnershipProbe = <R>(
  driver: AnyProviderDriver<R>,
  configMap: ProviderInstanceConfigMap,
) =>
  Effect.gen(function* () {
    const { registry, mutator } = yield* makeProviderInstanceRegistry({
      drivers: [driver],
      configMap,
    });
    const facade = yield* ProviderAdapterRegistry.ProviderAdapterRegistry.pipe(
      Effect.provide(
        ProviderAdapterRegistryLayer.ProviderAdapterRegistryLive.pipe(
          Layer.provide(Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, registry)),
        ),
      ),
    );
    const isCurrentAdapter = facade.isCurrentAdapter;
    assert.strictEqual(typeof isCurrentAdapter, "function");
    return { registry, mutator, facade, isCurrentAdapter: isCurrentAdapter! };
  });

it.effect("marks the routed adapter current until reconcile replaces or removes its instance", () =>
  Effect.gen(function* () {
    const id = ProviderInstanceId.make("codex_owned");
    const created: Array<ProviderInstance> = [];
    const driver = makeProbeDriver(({ instanceId }) =>
      Effect.sync(() => {
        const instance = makeFakeInstance("codex", makeProbeAdapter(), { instanceId });
        created.push(instance);
        return instance;
      }),
    );
    const { mutator, facade, isCurrentAdapter } = yield* setupOwnershipProbe(
      driver,
      probeConfig(id, 1),
    );

    // Stable positive: the routed adapter is current, an unknown id and a
    // foreign adapter are not.
    const routed = yield* facade.getByInstance(id);
    assert.strictEqual(routed, created[0]!.adapter);
    assert.strictEqual(isCurrentAdapter(id, routed), true);
    assert.strictEqual(isCurrentAdapter(ProviderInstanceId.make("codex_else"), routed), false);
    assert.strictEqual(isCurrentAdapter(id, makeProbeAdapter()), false);

    // A no-op reconcile keeps the same live entry.
    yield* mutator.reconcile(probeConfig(id, 1));
    assert.strictEqual(isCurrentAdapter(id, routed), true);

    // A changed config replaces the entry and retires its adapter.
    yield* mutator.reconcile(probeConfig(id, 2));
    assert.strictEqual(isCurrentAdapter(id, routed), false);
    const replacement = yield* facade.getByInstance(id);
    assert.strictEqual(replacement, created[1]!.adapter);
    assert.notStrictEqual(replacement, routed);
    assert.strictEqual(isCurrentAdapter(id, replacement), true);

    // Removal retires the id entirely.
    yield* mutator.reconcile({});
    assert.strictEqual(isCurrentAdapter(id, replacement), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retires the routed adapter even when the replaced scope fails to close", () =>
  Effect.gen(function* () {
    const id = ProviderInstanceId.make("codex_stuck");
    const created: Array<ProviderInstance> = [];
    const closeAttempted = yield* Deferred.make<void>();
    const closeFailure = new Error("instance close failed");
    const driver = makeProbeDriver(({ instanceId, scope }) =>
      Effect.gen(function* () {
        if (created.length === 0) {
          // A defecting finalizer models a retired instance whose adapter
          // context survives teardown: the defect escapes `Scope.close`
          // and aborts reconcile, but the entries Ref must already have
          // retired the entry before the close was awaited.
          yield* Scope.addFinalizer(
            scope,
            Deferred.succeed(closeAttempted, undefined).pipe(
              Effect.andThen(Effect.die(closeFailure)),
            ),
          );
        }
        const instance = makeFakeInstance("codex", makeProbeAdapter(), { instanceId });
        created.push(instance);
        return instance;
      }),
    );
    const { registry, mutator, facade, isCurrentAdapter } = yield* setupOwnershipProbe(
      driver,
      probeConfig(id, 1),
    );
    // Subscribe before reconciling so the retirement announcement is
    // causally received even though the close defect aborts the update.
    const changes = yield* registry.subscribeChanges;

    const routed = yield* facade.getByInstance(id);
    assert.strictEqual(isCurrentAdapter(id, routed), true);

    const exit = yield* Effect.exit(mutator.reconcile(probeConfig(id, 2)));

    // The injected defect is preserved, not swallowed. Retirement still
    // committed first: the id no longer resolves, the old adapter is not
    // current, and the change ping already went out.
    if (!Exit.isFailure(exit)) {
      assert.fail(`expected reconcile to fail, got ${exit._tag}`);
    }
    assert.strictEqual(Cause.hasDies(exit.cause), true);
    assert.strictEqual(Cause.squash(exit.cause), closeFailure);
    assert.strictEqual(Deferred.isDoneUnsafe(closeAttempted), true);
    yield* PubSub.take(changes);
    assert.strictEqual(registry.getInstanceUnsafe?.(id), undefined);
    assert.strictEqual(isCurrentAdapter(id, routed), false);

    // An explicit re-reconcile builds the replacement on top of the
    // already-retired state; the new adapter becomes current.
    yield* mutator.reconcile(probeConfig(id, 2));
    const routedAfter = yield* facade.getByInstance(id);
    assert.strictEqual(routedAfter, created[1]!.adapter);
    assert.strictEqual(isCurrentAdapter(id, routedAfter), true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("announces the early retirement and the completed replacement as separate ticks", () =>
  Effect.gen(function* () {
    const id = ProviderInstanceId.make("codex_staged");
    const created: Array<ProviderInstance> = [];
    const closeEntered = yield* Deferred.make<void>();
    const releaseClose = yield* Deferred.make<void>();
    const driver = makeProbeDriver(({ instanceId, scope }) =>
      Effect.gen(function* () {
        if (created.length === 0) {
          // Parking the old scope's close separates the early
          // retirement commit from the replacement build, proving the
          // two ticks correspond to two distinct authoritative states.
          yield* Scope.addFinalizer(
            scope,
            Deferred.succeed(closeEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseClose)),
            ),
          );
        }
        const instance = makeFakeInstance("codex", makeProbeAdapter(), { instanceId });
        created.push(instance);
        return instance;
      }),
    );
    const { registry, mutator, facade, isCurrentAdapter } = yield* setupOwnershipProbe(
      driver,
      probeConfig(id, 1),
    );
    const changes = yield* registry.subscribeChanges;

    const routed = yield* facade.getByInstance(id);
    assert.strictEqual(isCurrentAdapter(id, routed), true);

    const reconcileFiber = yield* mutator.reconcile(probeConfig(id, 2)).pipe(Effect.forkChild);

    // The retirement tick lands before the parked close; the receipt
    // guarantees reconcile is parked in teardown while the
    // intermediate (retired, not yet rebuilt) state is observed.
    yield* PubSub.take(changes);
    yield* Deferred.await(closeEntered);
    assert.strictEqual(registry.getInstanceUnsafe?.(id), undefined);
    assert.strictEqual(isCurrentAdapter(id, routed), false);
    assert.strictEqual(
      (yield* Effect.flip(facade.getByInstance(id)))._tag,
      "ProviderUnsupportedError",
    );

    yield* Deferred.succeed(releaseClose, undefined);
    assert.strictEqual(Exit.isSuccess(yield* Fiber.await(reconcileFiber)), true);

    // The rebuilt state is a second visible change: a consumer that
    // re-pulled on the early tick and saw the id absent must still
    // hear the completed batch or it would stay absent forever.
    yield* PubSub.take(changes);
    const routedAfter = yield* facade.getByInstance(id);
    assert.strictEqual(routedAfter, created[1]!.adapter);
    assert.strictEqual(isCurrentAdapter(id, routedAfter), true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("compares the auth-guarded adapter identity, not the underlying adapter", () =>
  Effect.gen(function* () {
    const id = ProviderInstanceId.make("codex_guarded");
    const created: Array<ProviderInstance> = [];
    const driver = makeProbeDriver(({ instanceId }) =>
      Effect.gen(function* () {
        const auth = yield* ProviderAuthFlow.make({
          instanceId,
          credentialBinding: { owner: "t3", key: `probe-auth-${created.length}` },
          methods: Effect.succeed([]),
          authenticate: () => Effect.void,
          logout: Effect.void,
        });
        const instance = makeFakeInstance("codex", makeProbeAdapter(), { instanceId, auth });
        created.push(instance);
        return instance;
      }),
    );
    const { mutator, facade, isCurrentAdapter } = yield* setupOwnershipProbe(
      driver,
      probeConfig(id, 1),
    );

    const guarded = yield* facade.getByInstance(id);
    assert.notStrictEqual(guarded, created[0]!.adapter);
    // The WeakMap memoizes the wrapper per instance — repeated routing of
    // the same live entry is the same object, and the predicate agrees.
    assert.strictEqual(yield* facade.getByInstance(id), guarded);
    assert.strictEqual(isCurrentAdapter(id, guarded), true);
    // The raw unwrapped adapter is not the facade-routed identity.
    assert.strictEqual(isCurrentAdapter(id, created[0]!.adapter), false);

    // Replacement mints a new wrapper for the new instance; the retired
    // one stops answering.
    yield* mutator.reconcile(probeConfig(id, 2));
    assert.strictEqual(isCurrentAdapter(id, guarded), false);
    const guardedAfter = yield* facade.getByInstance(id);
    assert.notStrictEqual(guardedAfter, guarded);
    assert.strictEqual(isCurrentAdapter(id, guardedAfter), true);
    assert.strictEqual(isCurrentAdapter(id, created[1]!.adapter), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails closed when the instance registry omits the synchronous hook", () =>
  Effect.gen(function* () {
    // `fakeInstanceRegistryLayer` has no `getInstanceUnsafe`; the facade
    // still exposes the predicate but can never prove ownership.
    const facade = yield* ProviderAdapterRegistry.ProviderAdapterRegistry.pipe(
      Effect.provide(
        ProviderAdapterRegistryLayer.ProviderAdapterRegistryLive.pipe(
          Layer.provide(fakeInstanceRegistryLayer),
        ),
      ),
    );
    const id = defaultInstanceIdForDriver(CODEX_DRIVER);
    const routed = yield* facade.getByInstance(id);
    assert.strictEqual(routed, fakeCodexAdapter);
    assert.strictEqual(typeof facade.isCurrentAdapter, "function");
    assert.strictEqual(facade.isCurrentAdapter?.(id, routed), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
