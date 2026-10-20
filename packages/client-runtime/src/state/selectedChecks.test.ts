import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type SelectedChecksCancelResult,
  type SelectedChecksGetResult,
  type SelectedChecksResolveOwnershipResult,
  type SelectedChecksRunResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { EnvironmentRpcInput, EnvironmentRpcSuccess } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createSelectedChecksEnvironmentAtoms } from "./selectedChecks.ts";
import { runAtomCommand } from "./runtime.ts";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const thread1 = ThreadId.make("thread-1");
const thread2 = ThreadId.make("thread-2");
const attemptId = "attempt-1";

/** Latch routing key for resolve-ownership (no thread in the RPC payload). */
const resolveLatchThreadId = "";

type SelectedChecksRpcMethod =
  | typeof WS_METHODS.selectedChecksGet
  | typeof WS_METHODS.selectedChecksRun
  | typeof WS_METHODS.selectedChecksCancel
  | typeof WS_METHODS.selectedChecksResolveOwnership;

// The factory uses unary replies; this fixture does not implement the RPC
// transport's optional discard mode or its unrelated methods.
type SelectedChecksRpcClient = {
  readonly [Tag in SelectedChecksRpcMethod]: (
    input: EnvironmentRpcInput<Tag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<Tag>>;
};

type Method = "get" | "run" | "cancel" | "resolveOwnership";

type SelectedChecksRecordedPayload =
  | EnvironmentRpcInput<typeof WS_METHODS.selectedChecksGet>
  | EnvironmentRpcInput<typeof WS_METHODS.selectedChecksRun>
  | EnvironmentRpcInput<typeof WS_METHODS.selectedChecksCancel>
  | EnvironmentRpcInput<typeof WS_METHODS.selectedChecksResolveOwnership>;

type RecordedCall = {
  readonly environmentId: string;
  readonly method: Method;
  readonly threadId: string;
  readonly payload: SelectedChecksRecordedPayload;
};

const emptyGetResult = (): SelectedChecksGetResult => ({
  capability: { available: true, reason: null },
  record: { kind: "none" },
  changedScriptIds: [],
  admission: { state: "open" },
});

const resolveOwnershipResult = (): SelectedChecksResolveOwnershipResult => ({
  outcome: "acknowledged",
  admission: { state: "open" },
});

function makeSession(client: SelectedChecksRpcClient): RpcSession {
  return {
    client: client as unknown as WsRpcProtocolClient,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.empty,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

/**
 * Stand-in RPC server per environment. Each call records itself against the
 * supervisor that received it, opens an arrival latch, and waits for the test
 * to release the answer latch before returning.
 */
const makeHarness = Effect.gen(function* () {
  const calls: Array<RecordedCall> = [];
  const serialHoldCount = new Map<string, number>();
  const maxSerialActiveOverlapByEnvironment = new Map<string, number>();
  const latches = new Map<string, Latch.Latch>();
  const latch = (name: string) => {
    const existing = latches.get(name);
    if (existing !== undefined) return existing;
    const created = Latch.makeUnsafe();
    latches.set(name, created);
    return created;
  };
  const routeKey = (method: Method, environmentId: string, threadId: string) =>
    `${method}:${environmentId}:${threadId}`;
  const ordinalLatchKey = (
    method: Method,
    environmentId: string,
    threadId: string,
    ordinal: number,
  ) => `${routeKey(method, environmentId, threadId)}:ordinal:${ordinal}`;

  const isSerialMethod = (method: Method) => method === "cancel" || method === "resolveOwnership";

  const request = <A>(
    environmentId: string,
    method: Method,
    latchThreadId: string,
    payload: SelectedChecksRecordedPayload,
    result: (ordinal: number) => A,
  ) =>
    Effect.gen(function* () {
      const ordinal =
        calls.filter(
          (call) =>
            call.method === method &&
            call.environmentId === environmentId &&
            call.threadId === latchThreadId,
        ).length + 1;
      calls.push({ environmentId, method, threadId: latchThreadId, payload });
      if (isSerialMethod(method)) {
        const active = (serialHoldCount.get(environmentId) ?? 0) + 1;
        serialHoldCount.set(environmentId, active);
        maxSerialActiveOverlapByEnvironment.set(
          environmentId,
          Math.max(maxSerialActiveOverlapByEnvironment.get(environmentId) ?? 0, active),
        );
      }
      latch(`arrived:${routeKey(method, environmentId, latchThreadId)}`).openUnsafe();
      latch(
        `arrived:${ordinalLatchKey(method, environmentId, latchThreadId, ordinal)}`,
      ).openUnsafe();
      const value = yield* latch(
        `answer:${ordinalLatchKey(method, environmentId, latchThreadId, ordinal)}`,
      ).await.pipe(
        Effect.andThen(() => Effect.sync(() => result(ordinal))),
        Effect.ensuring(
          Effect.sync(() => {
            if (!isSerialMethod(method)) return;
            const next = (serialHoldCount.get(environmentId) ?? 1) - 1;
            if (next <= 0) serialHoldCount.delete(environmentId);
            else serialHoldCount.set(environmentId, next);
          }),
        ),
      );
      return value;
    });

  const supervisors = new Map<string, EnvironmentSupervisor.EnvironmentSupervisor["Service"]>();
  for (const environmentId of [environmentA, environmentB]) {
    const client = {
      [WS_METHODS.selectedChecksGet]: (
        input: EnvironmentRpcInput<typeof WS_METHODS.selectedChecksGet>,
      ) =>
        request(
          environmentId,
          "get",
          input.threadId,
          input,
          (ordinal): SelectedChecksGetResult => ({
            ...emptyGetResult(),
            changedScriptIds: [`get-ordinal-${ordinal}`],
          }),
        ),
      [WS_METHODS.selectedChecksRun]: (
        input: EnvironmentRpcInput<typeof WS_METHODS.selectedChecksRun>,
      ) =>
        request(
          environmentId,
          "run",
          input.threadId,
          input,
          (ordinal): SelectedChecksRunResult => ({
            attemptId: `attempt-${ordinal}`,
          }),
        ),
      [WS_METHODS.selectedChecksCancel]: (
        input: EnvironmentRpcInput<typeof WS_METHODS.selectedChecksCancel>,
      ) =>
        request(environmentId, "cancel", input.threadId, input, (): SelectedChecksCancelResult => ({
          cancelled: true,
        })),
      [WS_METHODS.selectedChecksResolveOwnership]: (
        input: EnvironmentRpcInput<typeof WS_METHODS.selectedChecksResolveOwnership>,
      ) =>
        request(
          environmentId,
          "resolveOwnership",
          resolveLatchThreadId,
          input,
          (): SelectedChecksResolveOwnershipResult => resolveOwnershipResult(),
        ),
    } satisfies SelectedChecksRpcClient;
    const connected: SupervisorConnectionState = {
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    };
    supervisors.set(
      environmentId,
      EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: environmentId,
          httpBaseUrl: "https://selected-checks.example.test",
          wsBaseUrl: "wss://selected-checks.example.test",
        }),
        state: yield* SubscriptionRef.make(connected),
        session: yield* SubscriptionRef.make(Option.some(makeSession(client))),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]),
    );
  }
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
    environmentId,
    effect,
  ) => {
    const supervisor = supervisors.get(environmentId);
    if (supervisor === undefined) throw new Error(`unknown environment ${environmentId}`);
    return Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  };
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);

  const atoms = createSelectedChecksEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry)),
  );
  const atomRegistry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => atomRegistry.dispose()));

  const getTarget = (environmentId: EnvironmentId, threadId: ThreadId) => ({
    environmentId,
    input: { threadId },
  });

  return {
    calls,
    atomRegistry,
    atoms,
    getTarget,
    isEnvironmentSerialHeld: (environmentId: EnvironmentId) =>
      (serialHoldCount.get(environmentId) ?? 0) > 0,
    maxSerialActiveOverlap: (environmentId: EnvironmentId) =>
      maxSerialActiveOverlapByEnvironment.get(environmentId) ?? 0,
    arrived: (method: Method, environmentId: EnvironmentId, threadId: string) =>
      latch(`arrived:${routeKey(method, environmentId, threadId)}`).await,
    arrivedOrdinal: (
      method: Method,
      environmentId: EnvironmentId,
      threadId: string,
      ordinal: number,
    ) => latch(`arrived:${ordinalLatchKey(method, environmentId, threadId, ordinal)}`).await,
    answerOrdinal: (
      method: Method,
      environmentId: EnvironmentId,
      threadId: string,
      ordinal: number,
    ) => latch(`answer:${ordinalLatchKey(method, environmentId, threadId, ordinal)}`).openUnsafe(),
  };
});

describe("selected checks environment RPC commands", () => {
  it.effect(
    "coalesces pending gets for the same environment and thread without interrupting the active call",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;

        const first = runAtomCommand(
          harness.atomRegistry,
          harness.atoms.get,
          harness.getTarget(environmentA, thread1),
          { reportFailure: false },
        );
        yield* harness.arrivedOrdinal("get", environmentA, thread1, 1);
        const second = runAtomCommand(
          harness.atomRegistry,
          harness.atoms.get,
          harness.getTarget(environmentA, thread1),
          { reportFailure: false },
        );
        const third = runAtomCommand(
          harness.atomRegistry,
          harness.atoms.get,
          harness.getTarget(environmentA, thread1),
          { reportFailure: false },
        );

        harness.answerOrdinal("get", environmentA, thread1, 1);
        const firstResult = yield* Effect.promise(() => first);
        expect(firstResult).toMatchObject({
          _tag: "Success",
          value: { changedScriptIds: ["get-ordinal-1"] },
        });

        yield* harness.arrivedOrdinal("get", environmentA, thread1, 2);
        expect(
          harness.calls.filter(
            (call) =>
              call.method === "get" &&
              call.environmentId === environmentA &&
              call.threadId === thread1,
          ),
        ).toHaveLength(2);

        harness.answerOrdinal("get", environmentA, thread1, 2);
        const rest = yield* Effect.promise(() => Promise.all([second, third]));
        for (const result of rest) {
          expect(result).toMatchObject({
            _tag: "Success",
            value: { changedScriptIds: ["get-ordinal-2"] },
          });
        }
      }),
  );

  it.effect("keeps get requests for other threads and environments from blocking each other", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;

      const onA1 = runAtomCommand(
        harness.atomRegistry,
        harness.atoms.get,
        harness.getTarget(environmentA, thread1),
        { reportFailure: false },
      );
      const onA2 = runAtomCommand(
        harness.atomRegistry,
        harness.atoms.get,
        harness.getTarget(environmentA, thread2),
        { reportFailure: false },
      );
      const onB1 = runAtomCommand(
        harness.atomRegistry,
        harness.atoms.get,
        harness.getTarget(environmentB, thread1),
        { reportFailure: false },
      );
      yield* harness.arrivedOrdinal("get", environmentA, thread1, 1);
      yield* harness.arrivedOrdinal("get", environmentA, thread2, 1);
      yield* harness.arrivedOrdinal("get", environmentB, thread1, 1);

      harness.answerOrdinal("get", environmentA, thread2, 1);
      expect(yield* Effect.promise(() => onA2)).toMatchObject({ _tag: "Success" });
      harness.answerOrdinal("get", environmentB, thread1, 1);
      harness.answerOrdinal("get", environmentA, thread1, 1);
      const rest = yield* Effect.promise(() => Promise.all([onA1, onB1]));
      for (const result of rest) {
        expect(result).toMatchObject({ _tag: "Success" });
      }
      expect(harness.calls.filter((call) => call.method === "get")).toHaveLength(3);
    }),
  );

  it.effect("routes each command through the environment registry that owns the target", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;

      const onA = runAtomCommand(
        harness.atomRegistry,
        harness.atoms.get,
        harness.getTarget(environmentA, thread1),
        { reportFailure: false },
      );
      const onB = runAtomCommand(
        harness.atomRegistry,
        harness.atoms.get,
        harness.getTarget(environmentB, thread1),
        { reportFailure: false },
      );
      yield* harness.arrived("get", environmentA, thread1);
      yield* harness.arrived("get", environmentB, thread1);
      harness.answerOrdinal("get", environmentA, thread1, 1);
      harness.answerOrdinal("get", environmentB, thread1, 1);
      yield* Effect.promise(() => Promise.all([onA, onB]));

      expect(harness.calls).toEqual([
        {
          environmentId: environmentA,
          method: "get",
          threadId: thread1,
          payload: { threadId: thread1 },
        },
        {
          environmentId: environmentB,
          method: "get",
          threadId: thread1,
          payload: { threadId: thread1 },
        },
      ]);
    }),
  );

  it.effect(
    "admits only one run RPC for duplicate callers on the same environment and thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const runTarget = {
          environmentId: environmentA,
          input: { threadId: thread1, scriptIds: ["lint"] },
        };

        const first = runAtomCommand(harness.atomRegistry, harness.atoms.run, runTarget, {
          reportFailure: false,
        });
        const second = runAtomCommand(harness.atomRegistry, harness.atoms.run, runTarget, {
          reportFailure: false,
        });
        yield* harness.arrived("run", environmentA, thread1);
        harness.answerOrdinal("run", environmentA, thread1, 1);

        const results = yield* Effect.promise(() => Promise.all([first, second]));
        for (const result of results) {
          expect(result).toMatchObject({ _tag: "Success", value: { attemptId: "attempt-1" } });
        }
        expect(harness.calls.filter((call) => call.method === "run")).toEqual([
          {
            environmentId: environmentA,
            method: "run",
            threadId: thread1,
            payload: { threadId: thread1, scriptIds: ["lint"] },
          },
        ]);
      }),
  );

  it.effect("lets cancel reach the server while a run for the same thread is still in flight", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;

      const running = runAtomCommand(
        harness.atomRegistry,
        harness.atoms.run,
        { environmentId: environmentA, input: { threadId: thread1, scriptIds: ["lint"] } },
        { reportFailure: false },
      );
      yield* harness.arrived("run", environmentA, thread1);
      const cancelling = runAtomCommand(
        harness.atomRegistry,
        harness.atoms.cancel,
        { environmentId: environmentA, input: { threadId: thread1, attemptId } },
        { reportFailure: false },
      );
      yield* harness.arrived("cancel", environmentA, thread1);

      harness.answerOrdinal("cancel", environmentA, thread1, 1);
      expect(yield* Effect.promise(() => cancelling)).toMatchObject({
        _tag: "Success",
        value: { cancelled: true },
      });
      harness.answerOrdinal("run", environmentA, thread1, 1);
      expect(yield* Effect.promise(() => running)).toMatchObject({ _tag: "Success" });
    }),
  );

  it.effect("serializes cancel and resolve-ownership per environment on the shared scheduler", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;

      const cancelling = runAtomCommand(
        harness.atomRegistry,
        harness.atoms.cancel,
        { environmentId: environmentA, input: { threadId: thread1, attemptId } },
        { reportFailure: false },
      );
      yield* harness.arrivedOrdinal("cancel", environmentA, thread1, 1);
      expect(harness.isEnvironmentSerialHeld(environmentA)).toBe(true);

      const resolving = runAtomCommand(
        harness.atomRegistry,
        harness.atoms.resolveOwnership,
        {
          environmentId: environmentA,
          input: { markerSha256: null, acknowledgeUncertainty: true },
        },
        { reportFailure: false },
      );
      const cancellingB = runAtomCommand(
        harness.atomRegistry,
        harness.atoms.cancel,
        { environmentId: environmentB, input: { threadId: thread2, attemptId } },
        { reportFailure: false },
      );

      yield* harness.arrivedOrdinal("cancel", environmentB, thread2, 1);
      harness.answerOrdinal("cancel", environmentB, thread2, 1);
      expect(yield* Effect.promise(() => cancellingB)).toMatchObject({
        _tag: "Success",
        value: { cancelled: true },
      });
      expect(harness.isEnvironmentSerialHeld(environmentA)).toBe(true);
      expect(harness.calls.some((call) => call.method === "resolveOwnership")).toBe(false);
      expect(harness.maxSerialActiveOverlap(environmentA)).toBe(1);
      expect(harness.maxSerialActiveOverlap(environmentB)).toBe(1);

      harness.answerOrdinal("cancel", environmentA, thread1, 1);
      expect(yield* Effect.promise(() => cancelling)).toMatchObject({ _tag: "Success" });
      yield* harness.arrivedOrdinal("resolveOwnership", environmentA, resolveLatchThreadId, 1);
      harness.answerOrdinal("resolveOwnership", environmentA, resolveLatchThreadId, 1);
      expect(yield* Effect.promise(() => resolving)).toMatchObject({
        _tag: "Success",
        value: resolveOwnershipResult(),
      });
      expect(harness.isEnvironmentSerialHeld(environmentA)).toBe(false);
      expect(harness.maxSerialActiveOverlap(environmentA)).toBe(1);
      expect(harness.maxSerialActiveOverlap(environmentB)).toBe(1);
    }),
  );
});
