import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import type * as RpcSession from "../rpc/session.ts";
import { createReleaseVerificationEnvironmentAtoms } from "./releaseVerification.ts";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const thread1 = ThreadId.make("thread-1");
const thread2 = ThreadId.make("thread-2");

type Method = "run" | "cancel";

/**
 * The command layer over a stand-in server. Every request records itself, signals that it
 * arrived, and then waits until the test lets that request answer, so the test decides what is
 * in flight and when. Nothing here waits on time.
 */
const makeHarness = Effect.gen(function* () {
  const calls: Array<{ environmentId: string; method: Method; threadId: string }> = [];
  const latches = new Map<string, Latch.Latch>();
  const latch = (name: string) => {
    const existing = latches.get(name);
    if (existing !== undefined) return existing;
    const created = Latch.makeUnsafe();
    latches.set(name, created);
    return created;
  };
  const keyOf = (method: Method, environmentId: string, threadId: string) =>
    `${method}:${environmentId}:${threadId}`;

  const request = <A>(environmentId: string, method: Method, threadId: string, result: () => A) =>
    Effect.gen(function* () {
      const key = keyOf(method, environmentId, threadId);
      calls.push({ environmentId, method, threadId });
      latch(`arrived:${key}`).openUnsafe();
      yield* latch(`answer:${key}`).await;
      return result();
    });

  const supervisors = new Map<string, EnvironmentSupervisor.EnvironmentSupervisor["Service"]>();
  for (const environmentId of [environmentA, environmentB]) {
    const session = {
      client: {
        [WS_METHODS.releaseVerificationRun]: (input: { readonly threadId: string }) =>
          request(environmentId, "run", input.threadId, () => ({
            attemptId: `attempt-${calls.length}`,
          })),
        [WS_METHODS.releaseVerificationCancel]: (input: { readonly threadId: string }) =>
          request(environmentId, "cancel", input.threadId, () => ({ cancelled: true })),
      },
    } as unknown as RpcSession.RpcSession;
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
          httpBaseUrl: "https://release.example.test",
          wsBaseUrl: "wss://release.example.test",
        }),
        state: yield* SubscriptionRef.make(connected),
        session: yield* SubscriptionRef.make(Option.some(session)),
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
  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

  const atoms = createReleaseVerificationEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
  );
  const atomRegistry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => atomRegistry.dispose()));

  const target = (environmentId: EnvironmentId, threadId: ThreadId) => ({
    environmentId,
    input: { threadId },
  });
  return {
    calls,
    run: (environmentId: EnvironmentId, threadId: ThreadId) =>
      atoms.run.run(atomRegistry, target(environmentId, threadId)),
    cancel: (environmentId: EnvironmentId, threadId: ThreadId) =>
      atoms.cancel.run(atomRegistry, target(environmentId, threadId)),
    /** Resolves once that request has reached the server. */
    arrived: (method: Method, environmentId: EnvironmentId, threadId: ThreadId) =>
      latch(`arrived:${keyOf(method, environmentId, threadId)}`).await,
    /** Lets that request answer. */
    answer: (method: Method, environmentId: EnvironmentId, threadId: ThreadId) =>
      latch(`answer:${keyOf(method, environmentId, threadId)}`).openUnsafe(),
  };
});

describe("release verification commands", () => {
  it.effect("share one run request between callers for the same environment and thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;

      const first = harness.run(environmentA, thread1);
      const second = harness.run(environmentA, thread1);
      yield* harness.arrived("run", environmentA, thread1);
      harness.answer("run", environmentA, thread1);

      const results = yield* Effect.promise(() => Promise.all([first, second]));
      for (const result of results) {
        expect(result).toMatchObject({ _tag: "Success", value: { attemptId: "attempt-1" } });
      }
      expect(harness.calls).toEqual([
        { environmentId: environmentA, method: "run", threadId: thread1 },
      ]);
    }),
  );

  it.effect("keep run requests for other threads and environments separate", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;

      const first = harness.run(environmentA, thread1);
      const otherThread = harness.run(environmentA, thread2);
      const otherEnvironment = harness.run(environmentB, thread1);
      // Each reaches the server while the first is still waiting: none is queued behind it.
      yield* harness.arrived("run", environmentA, thread1);
      yield* harness.arrived("run", environmentA, thread2);
      yield* harness.arrived("run", environmentB, thread1);

      harness.answer("run", environmentA, thread2);
      expect(yield* Effect.promise(() => otherThread)).toMatchObject({ _tag: "Success" });
      harness.answer("run", environmentB, thread1);
      harness.answer("run", environmentA, thread1);
      const rest = yield* Effect.promise(() => Promise.all([first, otherEnvironment]));
      for (const result of rest) {
        expect(result).toMatchObject({ _tag: "Success" });
      }
      expect(harness.calls).toHaveLength(3);
    }),
  );

  it.effect("let a cancel reach the server while a run request for the thread is outstanding", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;

      const running = harness.run(environmentA, thread1);
      yield* harness.arrived("run", environmentA, thread1);
      const cancelling = harness.cancel(environmentA, thread1);
      yield* harness.arrived("cancel", environmentA, thread1);

      harness.answer("cancel", environmentA, thread1);
      expect(yield* Effect.promise(() => cancelling)).toMatchObject({
        _tag: "Success",
        value: { cancelled: true },
      });
      harness.answer("run", environmentA, thread1);
      expect(yield* Effect.promise(() => running)).toMatchObject({ _tag: "Success" });
    }),
  );
});
