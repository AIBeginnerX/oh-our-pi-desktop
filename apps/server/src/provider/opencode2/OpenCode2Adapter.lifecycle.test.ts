import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import { makeOpenCode2Adapter } from "./OpenCode2Adapter.ts";
import type { OpenCode2Client } from "./OpenCode2Client.ts";

const instanceId = ProviderInstanceId.make("opencode");
const threadId = ThreadId.make("thread-lifecycle");
const SESSION = "ses_main";

function eventChannel() {
  const queued: Array<unknown> = [];
  let waiting: ((result: IteratorResult<unknown>) => void) | undefined;
  let closed = false;
  const settle = (result: IteratorResult<unknown>) => {
    const resolve = waiting;
    waiting = undefined;
    resolve?.(result);
  };
  return {
    push: (event: unknown) =>
      waiting ? settle({ value: event, done: false }) : queued.push(event),
    close: () => {
      closed = true;
      settle({ value: undefined, done: true });
    },
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> =>
          queued.length > 0
            ? Promise.resolve({ value: queued.shift(), done: false })
            : closed
              ? Promise.resolve({ value: undefined, done: true })
              : new Promise((resolve) => (waiting = resolve)),
      }),
    },
  };
}

const setup = (stallFormCancel = false) =>
  Effect.gen(function* () {
    const channel = eventChannel();
    channel.push({ type: "server.connected", data: {} });
    const ok = async () => ({});
    const cancelledForms: string[] = [];
    const client = {
      model: { list: async () => ({ data: [] }) },
      command: { list: async () => ({ data: [] }) },
      event: {
        subscribe: ({ signal }: { signal: AbortSignal }) => {
          signal.addEventListener("abort", channel.close);
          return channel.iterable;
        },
      },
      permission: { reply: ok },
      session: {
        create: async () => ({ id: SESSION }),
        switchModel: ok,
        switchAgent: ok,
        instructions: { entry: { put: ok } },
        prompt: ok,
        interrupt: stallFormCancel
          ? async () => {
              channel.push({ type: "session.execution.interrupted", data: { sessionID: SESSION } });
              return {};
            }
          : ok,
        form: {
          cancel: ({ formID }: { formID: string }) => {
            cancelledForms.push(formID);
            return stallFormCancel ? new Promise<never>(() => {}) : ok();
          },
          reply: ok,
        },
      },
    } as unknown as OpenCode2Client;
    const adapter = yield* makeOpenCode2Adapter({ binaryPath: "opencode" } as never, {
      instanceId,
      makeClient: () => client,
    });
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
      Effect.forkScoped,
    );
    const next = (type: ProviderRuntimeEvent["type"]) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(events);
          if (event.type === type) return event;
        }
      });
    const modelSelection = { instanceId, model: "provider/model" };
    yield* adapter.startSession({
      threadId,
      provider: "opencode",
      cwd: process.cwd(),
      runtimeMode: "approval-required",
      modelSelection,
    } as never);
    yield* adapter.sendTurn({ threadId, input: "hello", modelSelection } as never);
    yield* next("turn.started");
    return { adapter, cancelledForms, channel, next };
  });

const layer = Layer.mergeAll(
  Layer.succeed(OpenCodeRuntime, {
    connectToOpenCodeServer: () =>
      Effect.succeed({
        url: "http://opencode.test",
        serverPassword: "secret",
        version: "2.1.4",
        exitCode: null,
        external: true,
      }),
  } as never),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-opencode2-lifecycle-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const run = <A, E, R>(test: Effect.Effect<A, E, R>) =>
  test.pipe(Effect.scoped, Effect.provide(layer));

it.effect("ends an interrupted turn when OpenCode never reports the interruption", () =>
  run(
    Effect.gen(function* () {
      const { adapter, next } = yield* setup();
      yield* adapter.interruptTurn(threadId);
      const steer = yield* adapter.sendTurn({ threadId, input: "more" } as never).pipe(Effect.flip);
      NodeAssert.match(steer.message, /still stopping/);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");

      const completed = yield* next("turn.completed");
      NodeAssert.equal((completed.payload as { state: string }).state, "interrupted");
      NodeAssert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }),
  ),
);

it.effect("fails the turn and stops the session when the event stream closes", () =>
  run(
    Effect.gen(function* () {
      const { adapter, channel, next } = yield* setup();
      channel.close();

      const completed = yield* next("turn.completed");
      NodeAssert.equal((completed.payload as { state: string }).state, "failed");
      yield* next("session.exited");
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  ),
);

it.effect("closes an open approval card when the turn is interrupted", () =>
  run(
    Effect.gen(function* () {
      const { adapter, channel, next } = yield* setup();
      channel.push({
        type: "permission.asked",
        data: {
          id: "per_1",
          sessionID: SESSION,
          action: "shell",
          resources: ["echo hi"],
          metadata: {},
        },
      });
      const opened = yield* next("request.opened");
      NodeAssert.equal(opened.requestId, "per_1");

      yield* adapter.interruptTurn(threadId);
      const resolved = yield* next("request.resolved");
      NodeAssert.equal(resolved.requestId, "per_1");
    }),
  ),
);

it.effect("sends native Stop and resolves the form when form cancellation never responds", () =>
  run(
    Effect.gen(function* () {
      const { adapter, cancelledForms, channel, next } = yield* setup(true);
      channel.push({
        type: "form.created",
        data: {
          form: {
            id: "frm_1",
            sessionID: SESSION,
            title: "Setup",
            fields: [{ key: "name", type: "string", title: "Name" }],
          },
        },
      });
      const opened = yield* next("user-input.requested");
      NodeAssert.equal(opened.requestId, "frm_1");

      const stop = yield* adapter.interruptTurn(threadId).pipe(Effect.forkScoped);
      yield* TestClock.adjust("3 seconds");
      const exit = stop.pollUnsafe();
      NodeAssert.deepEqual(cancelledForms, ["frm_1"]);
      NodeAssert.ok(
        exit && Exit.isSuccess(exit),
        "Native Stop must return after the form deadline",
      );
      const resolved = yield* next("user-input.resolved");
      NodeAssert.equal(resolved.requestId, "frm_1");
      const completed = yield* next("turn.completed");
      NodeAssert.equal((completed.payload as { state: string }).state, "interrupted");
    }),
  ),
);
