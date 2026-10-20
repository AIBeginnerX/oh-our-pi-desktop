// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vite-plus/test";

import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import {
  makeEventNdjsonLogger,
  makeEventNdjsonLogStore,
  type PendingRecord,
  writeBatchedMessages,
} from "./EventNdjsonLogger.ts";

// Deterministic purge fault injection: armed targets fail on rmSync alone and
// every other operation delegates to the real fs.
const rmSyncFault = vi.hoisted(() => ({
  armed: false,
  targets: new Set<string>(),
  attempts: [] as Array<string>,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      const [target] = args;
      const filePath = typeof target === "string" ? target : String(target);
      if (rmSyncFault.armed && rmSyncFault.targets.has(filePath)) {
        rmSyncFault.attempts.push(filePath);
        const error = new Error("simulated purge failure");
        Object.assign(error, { code: "EACCES" });
        throw error;
      }
      return (actual.rmSync as (...innerArgs: typeof args) => void)(...args);
    },
  };
});

afterEach(() => {
  rmSyncFault.armed = false;
  rmSyncFault.targets.clear();
  rmSyncFault.attempts.length = 0;
});

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function ownedLogPath(basePath: string, segment: string): string {
  const basename = NodePath.basename(basePath);
  const extension = NodePath.extname(basename);
  const stem = extension.length > 0 ? basename.slice(0, -extension.length) : basename;
  return NodePath.join(NodePath.dirname(basePath), `${stem}.${segment}.log`);
}

function parseLogLine(line: string) {
  const match = /^\[([^\]]+)\] ([A-Z]+): (.+)$/.exec(line);
  assert.notEqual(match, null);
  if (!match) {
    throw new Error(`invalid log line: ${line}`);
  }
  const observedAt = match[1];
  const stream = match[2];
  const payload = match[3];
  if (!observedAt || !stream || payload === undefined) {
    throw new Error(`invalid log line: ${line}`);
  }
  return {
    observedAt,
    stream,
    payload,
  };
}

type TaintStep =
  | { readonly kind: "ok"; readonly ids?: ReadonlyArray<string> }
  | { readonly kind: "fail"; readonly marker: string }
  | { readonly kind: "defect"; readonly marker: string }
  | { readonly kind: "interrupt" }
  | {
      readonly kind: "hold";
      readonly entered: Deferred.Deferred<void>;
      readonly gate: Deferred.Deferred<void>;
    };

interface TaintControl {
  readonly calls: Array<ReadonlyArray<ThreadId> | undefined>;
  readonly steps: Array<TaintStep>;
  readonly taintedThreads: (
    threadIds: ReadonlyArray<ThreadId> | undefined,
  ) => Effect.Effect<ReadonlySet<ThreadId>, unknown>;
}

/** Scripted committed-memory taint source; consumed one step per lookup. */
const makeTaintControl = (): TaintControl => {
  const calls: Array<ReadonlyArray<ThreadId> | undefined> = [];
  const steps: Array<TaintStep> = [];
  const taintedThreads = (
    threadIds: ReadonlyArray<ThreadId> | undefined,
  ): Effect.Effect<ReadonlySet<ThreadId>, unknown> =>
    Effect.gen(function* () {
      calls.push(threadIds);
      const step = steps.shift() ?? { kind: "ok" as const };
      switch (step.kind) {
        case "ok":
          return new Set<ThreadId>((step.ids ?? []) as ReadonlyArray<ThreadId>);
        case "fail":
          return yield* Effect.fail(new Error(step.marker));
        case "defect":
          return yield* Effect.die(step.marker);
        case "interrupt":
          return yield* Effect.interrupt;
        case "hold": {
          yield* Deferred.succeed(step.entered, undefined);
          yield* Deferred.await(step.gate);
          return new Set<ThreadId>();
        }
      }
    });
  return { calls, steps, taintedThreads };
};

const makeWarningCapture = () => {
  const entries: Array<unknown> = [];
  const capture = Logger.make<unknown, void>(({ message }) => {
    entries.push(Array.isArray(message) ? message : [message]);
  });
  return { entries, capture };
};

const taintWarningTags = (entries: ReadonlyArray<unknown>): Array<string> => {
  const tags: Array<string> = [];
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const text = entry[0];
    if (typeof text !== "string" || !text.startsWith("provider event log taint ")) continue;
    const context = entry[1];
    tags.push(
      typeof context === "object" && context !== null && "failure" in context
        ? String((context as { failure: unknown }).failure)
        : "missing-failure-tag",
    );
  }
  return tags;
};

const warningText = (entries: ReadonlyArray<unknown>): string => JSON.stringify(entries);

const payloadLines = (filePath: string): Array<string> =>
  NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => parseLogLine(line).payload);

const storedFileContents = (directory: string): Map<string, string> => {
  const contents = new Map<string, string>();
  for (const entry of NodeFS.readdirSync(directory).toSorted()) {
    const filePath = NodePath.join(directory, entry);
    if (NodeFS.statSync(filePath).isFile()) {
      contents.set(entry, NodeFS.readFileSync(filePath, "utf8"));
    }
  }
  return contents;
};

describe("EventNdjsonLogger", () => {
  it.effect("summarizes circular events without exposing their contents in diagnostics", () => {
    const messages: Array<unknown> = [];
    const logCapture = Logger.make<unknown, void>(({ message }) => {
      if (Array.isArray(message)) {
        messages.push(...message);
      } else {
        messages.push(message);
      }
    });
    const secret = "secret-circular-event-value";

    return Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-native.ndjson");
      const circular: Record<string, unknown> = { secret };
      circular.self = circular;

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.exists(logger);
        if (!logger) return;
        yield* logger.write(circular, ThreadId.make("thread-1"));
        yield* logger.close();

        const serialized = encodeUnknownJson(messages);
        assert.notInclude(serialized, secret);
        const line = parseLogLine(
          NodeFS.readFileSync(ownedLogPath(basePath, "thread-1"), "utf8").trim(),
        );
        assert.equal(line.payload, '{"truncated":true}');
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(Logger.layer([logCapture], { mergeWithExisting: false })));
  });

  it.effect("writes effect-style lines to thread-scoped files", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* logger.write(
          { threadId: "provider-thread-1", id: "evt-1" },
          ThreadId.make("thread-1"),
        );
        yield* logger.write(
          { type: "turn.completed", threadId: "provider-thread-2", id: "evt-2" },
          ThreadId.make("thread-2"),
        );
        yield* logger.close();

        const threadOnePath = ownedLogPath(basePath, "thread-1");
        const threadTwoPath = ownedLogPath(basePath, "thread-2");
        assert.equal(NodeFS.existsSync(threadOnePath), true);
        assert.equal(NodeFS.existsSync(threadTwoPath), true);

        const first = parseLogLine(NodeFS.readFileSync(threadOnePath, "utf8").trim());
        const second = parseLogLine(NodeFS.readFileSync(threadTwoPath, "utf8").trim());

        assert.equal(Number.isNaN(Date.parse(first.observedAt)), false);
        assert.equal(first.stream, "NTIVE");
        assert.equal(first.payload, '{"threadId":"provider-thread-1","id":"evt-1"}');

        assert.equal(Number.isNaN(Date.parse(second.observedAt)), false);
        assert.equal(second.stream, "NTIVE");
        assert.equal(
          second.payload,
          '{"type":"turn.completed","threadId":"provider-thread-2","id":"evt-2"}',
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect(
    "falls back to a global segment when orchestration thread id is missing or invalid",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
        const basePath = NodePath.join(tempDir, "provider-canonical.ndjson");

        try {
          const logger = yield* makeEventNdjsonLogger(basePath, { stream: "orchestration" });
          assert.notEqual(logger, undefined);
          if (!logger) {
            return;
          }

          yield* logger.write({ id: "evt-no-thread" }, null);
          yield* logger.write({ id: "evt-invalid-thread" }, "!!!" as unknown as ThreadId);
          yield* logger.close();

          const globalPath = ownedLogPath(basePath, "_global");
          assert.equal(NodeFS.existsSync(globalPath), true);
          const lines = NodeFS.readFileSync(globalPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => parseLogLine(line));
          assert.equal(lines.length, 2);
          assert.equal(Number.isNaN(Date.parse(lines[0]?.observedAt ?? "")), false);
          assert.equal(Number.isNaN(Date.parse(lines[1]?.observedAt ?? "")), false);
          assert.equal(lines[0]?.stream, "ORCH");
          assert.equal(lines[0]?.payload, '{"id":"evt-no-thread"}');
          assert.equal(lines[1]?.stream, "ORCH");
          assert.equal(lines[1]?.payload, '{"id":"evt-invalid-thread"}');
        } finally {
          NodeFS.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
  );

  it.effect("shares one thread writer across native and canonical streams", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 0 });
        const native = store.logger("native");
        const canonical = store.logger("canonical");
        const threadId = ThreadId.make("thread-shared");

        yield* native.write({ id: "native-event" }, threadId);
        yield* canonical.write({ type: "item.completed", id: "canonical-event" }, threadId);
        yield* store.close();

        const lines = NodeFS.readFileSync(ownedLogPath(basePath, "thread-shared"), "utf8")
          .trim()
          .split("\n")
          .map(parseLogLine);

        assert.deepEqual(
          lines.map(({ stream, payload }) => ({ stream, payload })),
          [
            { stream: "NTIVE", payload: '{"id":"native-event"}' },
            {
              stream: "CANON",
              payload: '{"type":"item.completed","id":"canonical-event"}',
            },
          ],
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("keeps shared store views non-owning when one adapter closes", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 0 });
        const native = store.logger("native");
        const canonical = store.logger("canonical");
        const threadId = ThreadId.make("thread-shared-close");

        yield* native.write({ id: "before-close" }, threadId);
        yield* native.close();
        yield* canonical.write({ type: "item.completed", id: "after-close" }, threadId);
        yield* store.close();

        const lines = NodeFS.readFileSync(ownedLogPath(basePath, "thread-shared-close"), "utf8")
          .trim()
          .split("\n")
          .map(parseLogLine);

        assert.deepEqual(
          lines.map(({ stream, payload }) => ({ stream, payload })),
          [
            { stream: "NTIVE", payload: '{"id":"before-close"}' },
            {
              stream: "CANON",
              payload: '{"type":"item.completed","id":"after-close"}',
            },
          ],
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("flushes an active batch without a permanent polling loop", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const threadPath = ownedLogPath(basePath, "thread-batched");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 1_000 });
        yield* store
          .logger("native")
          .write({ id: "batched-event" }, ThreadId.make("thread-batched"));

        assert.equal(NodeFS.existsSync(threadPath), false);
        yield* TestClock.adjust(1_000);
        assert.equal(NodeFS.existsSync(threadPath), true);
        yield* store.close();
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("does not strand a later batch after an interrupted write", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const threadPath = ownedLogPath(basePath, "thread-interrupted");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 1_000 });
        const logger = store.logger("native");
        const interruptedWrite = yield* logger
          .write({ id: "possibly-interrupted" }, ThreadId.make("thread-interrupted"))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(interruptedWrite);
        yield* logger.write({ id: "accepted" }, ThreadId.make("thread-interrupted"));

        yield* TestClock.adjust(1_000);

        assert.equal(NodeFS.existsSync(threadPath), true);
        assert.include(NodeFS.readFileSync(threadPath, "utf8"), '{"id":"accepted"}');
        yield* store.close();
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("drops transient provider events before serialization", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 0 });
        const canonical = store.logger("canonical");
        const native = store.logger("native");
        const threadId = ThreadId.make("thread-filtered");
        const circularDelta: Record<string, unknown> = { type: "content.delta" };
        circularDelta["self"] = circularDelta;

        yield* canonical.write(circularDelta, threadId);
        yield* canonical.write({ type: "item.completed", id: "final" }, threadId);
        yield* native.write({ type: "content.delta", id: "native-delta" }, threadId);
        yield* native.write(
          { method: "item/agentMessage/delta", payload: circularDelta },
          threadId,
        );
        yield* native.write(
          { method: "thread/realtime/outputAudio/delta", payload: circularDelta },
          threadId,
        );
        yield* native.write(
          { method: "thread/realtime/transcript/delta", payload: circularDelta },
          threadId,
        );
        yield* native.write({ method: "turn/diff/updated", payload: circularDelta }, threadId);
        yield* native.write(
          {
            event: {
              direction: "incoming",
              stage: "decoded",
              payload: {
                method: "turn/diff/updated",
                get params() {
                  throw new Error("unused diff snapshots must not be traversed");
                },
              },
            },
          },
          threadId,
        );
        yield* native.write(
          {
            event: {
              method: "claude/stream_event/content_block_delta/text_delta",
              payload: circularDelta,
            },
          },
          threadId,
        );
        yield* native.write(
          {
            event: {
              method: "session/update",
              payload: { update: { sessionUpdate: "agent_message_chunk" } },
            },
          },
          threadId,
        );
        yield* native.write(
          {
            event: {
              direction: "incoming",
              stage: "decoded",
              payload: { method: "item/commandExecution/outputDelta", params: circularDelta },
            },
          },
          threadId,
        );
        yield* native.write(
          {
            event: {
              direction: "incoming",
              stage: "decoded",
              payload: {
                type: "stream_event",
                event: { type: "content_block_delta", delta: circularDelta },
              },
            },
          },
          threadId,
        );
        yield* native.write(
          {
            event: {
              direction: "incoming",
              stage: "raw",
              get payload() {
                throw new Error("raw frames must not be inspected");
              },
            },
          },
          threadId,
        );
        yield* native.write(
          {
            event: {
              type: "message.part.updated",
              payload: { properties: { part: { type: "text" } } },
            },
          },
          threadId,
        );
        yield* native.write(
          {
            event: {
              type: "message.part.updated",
              payload: {
                properties: {
                  part: { type: "tool", state: { status: "running", output: "progress" } },
                },
              },
            },
          },
          threadId,
        );
        yield* native.write({ type: "turn.completed", id: "native-final" }, threadId);
        yield* store.close();

        const lines = NodeFS.readFileSync(ownedLogPath(basePath, "thread-filtered"), "utf8")
          .trim()
          .split("\n")
          .map(parseLogLine);

        assert.deepEqual(
          lines.map(({ stream, payload }) => ({ stream, payload })),
          [
            { stream: "CANON", payload: '{"type":"item.completed","id":"final"}' },
            { stream: "NTIVE", payload: '{"type":"turn.completed","id":"native-final"}' },
          ],
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("summarizes large histories without reading their items", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const turns = Array.from({ length: 10_000 });
      Object.defineProperty(turns, 0, {
        get: () => {
          throw new Error("history must not be serialized");
        },
      });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath);
        yield* store.logger("native").write(
          {
            provider: "codex",
            event: {
              direction: "incoming",
              stage: "decoded",
              payload: { id: 42, result: { thread: { id: "native-thread", turns } } },
            },
          },
          ThreadId.make("large-history"),
        );
        yield* store.close();

        const contents = NodeFS.readFileSync(ownedLogPath(basePath, "large-history"), "utf8");
        assert.isBelow(Buffer.byteLength(contents), 2_048);
        const record = decodeUnknownJson(parseLogLine(contents.trim()).payload);
        assert.nestedPropertyVal(record, "event.payload.id", 42);
        assert.nestedPropertyVal(record, "event.payload.result.thread.id", "native-thread");
        assert.nestedPropertyVal(record, "event.payload.result.thread.turns.itemCount", 10_000);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("bounds oversized records while retaining failure details", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath);
        const logger = store.logger("native");
        const threadId = ThreadId.make("large-error");
        const failure = {
          method: "error",
          params: {
            threadId: "native-thread",
            turnId: "native-turn",
            error: { message: "The provider is unavailable.", code: "overloaded" },
            output: "x".repeat(128 * 1_024),
          },
        };
        yield* logger.write(failure, threadId);
        yield* logger.write({ id: "escaped", output: "\u0000".repeat(20_000) }, threadId);
        yield* store.close();

        const contents = NodeFS.readFileSync(ownedLogPath(basePath, "large-error"), "utf8");
        const records = contents
          .trim()
          .split("\n")
          .map((line) => decodeUnknownJson(parseLogLine(line).payload));
        assert.isBelow(Buffer.byteLength(contents), 64 * 1_024);
        assert.equal(records.length, 2);
        assert.nestedPropertyVal(records[0], "params.threadId", "native-thread");
        assert.nestedPropertyVal(records[0], "params.turnId", "native-turn");
        assert.nestedPropertyVal(
          records[0],
          "params.error.message",
          "The provider is unavailable.",
        );
        assert.nestedPropertyVal(records[0], "params.error.code", "overloaded");
        assert.propertyVal(records[1], "id", "escaped");
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("bounds canonical diff snapshots before serializing their duplicate payloads", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const threadId = ThreadId.make("large-diff");
      const diff = "diff-payload".repeat(128 * 1_024);
      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 0 });
        yield* store.logger("canonical").write(
          {
            type: "turn.diff.updated",
            threadId,
            turnId: "native-turn",
            raw: { method: "turn/diff/updated", payload: { diff } },
            payload: { unifiedDiff: diff },
          },
          threadId,
        );
        yield* store.close();
        const contents = NodeFS.readFileSync(ownedLogPath(basePath, "large-diff"), "utf8");
        assert.isBelow(Buffer.byteLength(contents), 2_048);
        const record = decodeUnknownJson(parseLogLine(contents.trim()).payload);
        assert.propertyVal(record, "type", "turn.diff.updated");
        assert.propertyVal(record, "threadId", threadId);
        assert.propertyVal(record, "turnId", "native-turn");
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("keeps OpenCode tool input, final output, and errors in native logs", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const threadId = ThreadId.make("thread-tool-lifecycle");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 0 });
        const native = store.logger("native");
        const input = { command: "run-build" };
        const states = [
          { status: "pending", input },
          { status: "completed", input, output: "Build complete", time: { start: 1, end: 2 } },
          { status: "error", input, error: "Build failed", time: { start: 3, end: 4 } },
          { status: "unknown", input },
          null,
        ];
        const events = states.map((state) => ({
          event: {
            type: "message.part.updated",
            payload: { properties: { part: { type: "tool", state } } },
          },
        }));
        for (const event of events) {
          yield* native.write(event, threadId);
        }
        yield* store.close();

        const payloads = NodeFS.readFileSync(
          ownedLogPath(basePath, "thread-tool-lifecycle"),
          "utf8",
        )
          .trim()
          .split("\n")
          .map((line) => parseLogLine(line).payload);
        assert.deepEqual(
          payloads,
          events.map((event) => encodeUnknownJson(event)),
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("contains hostile event accessors inside guarded serialization", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "canonical",
          batchWindowMs: 0,
        });
        assert.exists(logger);
        if (!logger) return;
        const hostile = new Proxy(
          { id: "hostile" },
          {
            get(_target, property) {
              if (property === "type") throw new Error("blocked");
              return undefined;
            },
          },
        );

        yield* logger.write(hostile, ThreadId.make("thread-hostile"));
        yield* logger.close();

        const contents = NodeFS.readFileSync(ownedLogPath(basePath, "thread-hostile"), "utf8");
        assert.notInclude(contents, "blocked");
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("serializes concurrent first writes for the same segment", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-canonical.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "canonical",
          batchWindowMs: 0,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* Effect.all(
          [
            logger.write({ id: "evt-concurrent-1" }, null),
            logger.write({ id: "evt-concurrent-2" }, null),
          ],
          { concurrency: "unbounded" },
        );
        yield* logger.close();

        const globalPath = ownedLogPath(basePath, "_global");
        assert.equal(NodeFS.existsSync(globalPath), true);
        const lines = NodeFS.readFileSync(globalPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => parseLogLine(line));

        assert.equal(lines.length, 2);
        assert.deepEqual(lines.map((line) => line.payload).toSorted(), [
          '{"id":"evt-concurrent-1"}',
          '{"id":"evt-concurrent-2"}',
        ]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("rotates per-thread files when max size is exceeded", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-native.ndjson");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          maxBytes: 120,
          maxFiles: 2,
          batchWindowMs: 0,
        });
        const native = store.logger("native");
        const canonical = store.logger("canonical");

        for (let index = 0; index < 10; index += 1) {
          const logger = index % 2 === 0 ? native : canonical;
          yield* logger.write(
            {
              type: "session.started",
              threadId: "provider-thread-rotate",
              id: `evt-${index}`,
              payload: "x".repeat(40),
            },
            ThreadId.make("thread-rotate"),
          );
        }
        yield* store.close();

        const fileStem = NodePath.basename(ownedLogPath(basePath, "thread-rotate"));
        const matchingFiles = NodeFS.readdirSync(tempDir)
          .filter((entry) => entry === fileStem || entry.startsWith(`${fileStem}.`))
          .toSorted();

        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.1`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === fileStem || entry === `${fileStem}.2`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.3`),
          false,
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("enforces aggregate age and byte retention on startup", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const expiredPath = ownedLogPath(basePath, "expired");
      const oldPath = ownedLogPath(basePath, "old");
      const newPath = ownedLogPath(basePath, "new");
      const unrelatedLogPath = NodePath.join(tempDir, "unrelated.log");
      const legacyLogPath = NodePath.join(tempDir, "legacy-thread.log");
      const ignoredPath = NodePath.join(tempDir, "ignored.txt");

      try {
        yield* TestClock.setTime(1_800_000_000_000);
        const now = yield* Clock.currentTimeMillis;
        for (const filePath of [expiredPath, oldPath, newPath, unrelatedLogPath, ignoredPath]) {
          NodeFS.writeFileSync(filePath, "x".repeat(40));
        }
        NodeFS.writeFileSync(
          legacyLogPath,
          "[2026-01-01T00:00:00.000Z] CANON: legacy provider event\n",
        );
        NodeFS.utimesSync(expiredPath, (now - 20_000) / 1_000, (now - 20_000) / 1_000);
        NodeFS.utimesSync(legacyLogPath, (now - 20_000) / 1_000, (now - 20_000) / 1_000);
        NodeFS.utimesSync(oldPath, (now - 5_000) / 1_000, (now - 5_000) / 1_000);
        NodeFS.utimesSync(newPath, now / 1_000, now / 1_000);

        const store = yield* makeEventNdjsonLogStore(basePath, {
          maxAgeMs: 10_000,
          maxTotalBytes: 60,
        });
        yield* store.close();

        assert.equal(NodeFS.existsSync(expiredPath), false);
        assert.equal(NodeFS.existsSync(legacyLogPath), false);
        assert.equal(NodeFS.existsSync(oldPath), false);
        assert.equal(NodeFS.existsSync(newPath), true);
        assert.equal(NodeFS.existsSync(unrelatedLogPath), true);
        assert.equal(NodeFS.existsSync(ignoredPath), true);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("does not prune an active thread sink during an unrelated flush", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const activePath = ownedLogPath(basePath, "active");

      try {
        yield* TestClock.setTime(1_800_000_000_000);
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 0,
          maxAgeMs: 1,
          retentionCheckIntervalMs: 1,
        });
        const logger = store.logger("native");

        yield* logger.write({ id: "active-before-retention" }, ThreadId.make("active"));
        assert.equal(NodeFS.existsSync(activePath), true);

        yield* TestClock.adjust("2 millis");
        yield* logger.write({ id: "retention-trigger" }, ThreadId.make("other"));

        assert.equal(NodeFS.existsSync(activePath), true);
        yield* store.close();
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it("attributes batches that were written before a later chunk fails", () => {
    const records: ReadonlyArray<PendingRecord> = [
      {
        stream: "native",
        threadId: null,
        threadSegment: "thread",
        line: "first",
        bytes: 5,
      },
      {
        stream: "canonical",
        threadId: null,
        threadSegment: "thread",
        line: "second",
        bytes: 6,
      },
    ];
    const attributed: Array<PendingRecord> = [];
    let writes = 0;

    assert.throws(() =>
      writeBatchedMessages(
        {
          write: () => {
            writes += 1;
            if (writes === 2) throw new Error("simulated disk exhaustion");
          },
        },
        records,
        5,
        (written) => attributed.push(...written),
      ),
    );
    assert.deepEqual(attributed, [records[0]]);
  });

  it.effect("reports logical provider log writes to resource attribution", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-native.ndjson");

      try {
        const attribution = yield* ResourceAttribution.make();
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "native",
          batchWindowMs: 0,
          attribution,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* logger.write({ id: "attributed-event" }, ThreadId.make("thread-attribution"));
        yield* logger.close();

        const snapshot = yield* attribution.snapshot;
        assert.equal(snapshot.entries.length, 1);
        assert.equal(snapshot.entries[0]?.component, "provider-event-log");
        assert.equal(snapshot.entries[0]?.operation, "native.append");
        assert.equal(snapshot.entries[0]?.count, 1);
        assert.isAbove(snapshot.entries[0]?.logicalWriteBytes ?? 0, 0);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("S1: admits writes that arrive while a timer lookup is in flight", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const control = makeTaintControl();
      control.steps.push({ kind: "ok" });
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      control.steps.push({ kind: "hold", entered, gate });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 1_000,
          taintedThreads: control.taintedThreads,
        });
        const logger = store.logger("native");
        yield* logger.write({ id: "first" }, ThreadId.make("thread-order"));

        const timer = yield* TestClock.adjust(1_000).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* logger.write({ id: "second" }, ThreadId.make("thread-order"));
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(timer);

        // The write during the lookup scheduled the next timer itself.
        yield* TestClock.adjust(1_000);
        assert.deepEqual(payloadLines(ownedLogPath(basePath, "thread-order")), [
          '{"id":"first"}',
          '{"id":"second"}',
        ]);

        yield* store.close();
        assert.deepEqual(control.calls, [
          undefined,
          [ThreadId.make("thread-order")],
          [ThreadId.make("thread-order")],
        ]);
        assert.deepEqual(payloadLines(ownedLogPath(basePath, "thread-order")), [
          '{"id":"first"}',
          '{"id":"second"}',
        ]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("S2: close waits behind an in-flight flush and rejects later admissions", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const control = makeTaintControl();
      control.steps.push({ kind: "ok" });
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      control.steps.push({ kind: "hold", entered, gate });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 1_000,
          taintedThreads: control.taintedThreads,
        });
        const logger = store.logger("native");
        yield* logger.write({ id: "kept" }, ThreadId.make("thread-close-race"));

        const timer = yield* TestClock.adjust(1_000).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const closer = yield* store.close().pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* logger.write({ id: "rejected" }, ThreadId.make("thread-close-race"));

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(timer);
        yield* Fiber.join(closer);

        assert.deepEqual(payloadLines(ownedLogPath(basePath, "thread-close-race")), [
          '{"id":"kept"}',
        ]);
        assert.deepEqual(control.calls, [undefined, [ThreadId.make("thread-close-race")]]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("S3: an interrupted timer lookup requeues once and schedules its replacement", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const control = makeTaintControl();
      control.steps.push({ kind: "ok" }, { kind: "interrupt" }, { kind: "ok" });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 1_000,
          taintedThreads: control.taintedThreads,
        });
        const logger = store.logger("native");
        yield* logger.write({ id: "requeued" }, ThreadId.make("thread-interrupt"));

        // The timer lookup self-interrupts; no further write or close happens.
        yield* TestClock.adjust(1_000);

        // The requeued batch must have scheduled a replacement timer itself.
        yield* TestClock.adjust(1_000);
        assert.deepEqual(payloadLines(ownedLogPath(basePath, "thread-interrupt")), [
          '{"id":"requeued"}',
        ]);

        yield* store.close();
        assert.deepEqual(payloadLines(ownedLogPath(basePath, "thread-interrupt")), [
          '{"id":"requeued"}',
        ]);
        assert.deepEqual(control.calls, [
          undefined,
          [ThreadId.make("thread-interrupt")],
          [ThreadId.make("thread-interrupt")],
        ]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("S4a: a failed batch lookup drops thread records but keeps null-thread records", () => {
    const { entries, capture } = makeWarningCapture();
    return Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const control = makeTaintControl();
      control.steps.push({ kind: "ok" }, { kind: "fail", marker: "marker-lookup-failure" });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 0,
          taintedThreads: control.taintedThreads,
        });
        const logger = store.logger("native");
        yield* logger.write({ id: "dropped" }, ThreadId.make("thread-lost"));
        yield* logger.write({ id: "global-kept" }, null);
        yield* store.close();

        assert.equal(NodeFS.existsSync(ownedLogPath(basePath, "thread-lost")), false);
        assert.deepEqual(payloadLines(ownedLogPath(basePath, "_global")), ['{"id":"global-kept"}']);
        assert.deepEqual(taintWarningTags(entries), ["lookup-failed"]);
        assert.notInclude(warningText(entries), "marker-lookup-failure");
        assert.deepEqual(control.calls, [undefined, [ThreadId.make("thread-lost")]]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
  });

  it.effect("S4b: a defective batch lookup is classified without exposing the defect", () => {
    const { entries, capture } = makeWarningCapture();
    return Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const control = makeTaintControl();
      control.steps.push({ kind: "ok" }, { kind: "defect", marker: "marker-lookup-defect" });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 0,
          taintedThreads: control.taintedThreads,
        });
        const logger = store.logger("native");
        yield* logger.write({ id: "dropped" }, ThreadId.make("thread-lost"));
        yield* logger.write({ id: "global-kept" }, null);
        yield* store.close();

        assert.equal(NodeFS.existsSync(ownedLogPath(basePath, "thread-lost")), false);
        assert.deepEqual(payloadLines(ownedLogPath(basePath, "_global")), ['{"id":"global-kept"}']);
        assert.deepEqual(taintWarningTags(entries), ["lookup-defect"]);
        assert.notInclude(warningText(entries), "marker-lookup-defect");
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
  });

  it.effect("S4c: a failed full scan does not veto a successful batch lookup", () => {
    const { entries, capture } = makeWarningCapture();
    return Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const control = makeTaintControl();
      control.steps.push(
        { kind: "fail", marker: "marker-full-scan" },
        { kind: "fail", marker: "marker-full-scan" },
        { kind: "ok" },
        { kind: "ok" },
      );

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 0,
          taintedThreads: control.taintedThreads,
        });
        yield* store.logger("native").write({ id: "authorized" }, ThreadId.make("thread-veto"));
        yield* store.close();

        // The batch lookup covered every uncached thread in the batch, so the
        // record was written even though historical cleanup stayed pending
        // until the close retried the full scan.
        assert.deepEqual(payloadLines(ownedLogPath(basePath, "thread-veto")), [
          '{"id":"authorized"}',
        ]);
        assert.deepEqual(taintWarningTags(entries), ["lookup-failed", "lookup-failed"]);
        assert.notInclude(warningText(entries), "marker-full-scan");
        assert.deepEqual(control.calls, [
          undefined,
          undefined,
          [ThreadId.make("thread-veto")],
          undefined,
        ]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
  });

  it.effect("S5a: a failed open scan retries as a full scan around unrelated traffic", () => {
    const { entries, capture } = makeWarningCapture();
    return Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      NodeFS.writeFileSync(ownedLogPath(basePath, "stale-t"), "T-CURRENT\n");
      NodeFS.writeFileSync(`${ownedLogPath(basePath, "stale-t")}.1`, "T-1\n");
      NodeFS.writeFileSync(`${ownedLogPath(basePath, "stale-t")}.12`, "T-12\n");
      NodeFS.writeFileSync(ownedLogPath(basePath, "stale-t-x"), "TX\n");
      NodeFS.writeFileSync(ownedLogPath(basePath, "u"), "U\n");
      NodeFS.writeFileSync(ownedLogPath(basePath, "_global"), "GLOBAL\n");
      NodeFS.writeFileSync(NodePath.join(tempDir, "notes.stale-t.log"), "NOTES\n");
      const before = storedFileContents(tempDir);
      const control = makeTaintControl();
      control.steps.push(
        { kind: "fail", marker: "marker-open-scan" },
        { kind: "ok", ids: ["stale-t"] },
        { kind: "ok" },
      );

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 0,
          taintedThreads: control.taintedThreads,
        });
        assert.deepEqual(storedFileContents(tempDir), before);

        yield* store.logger("native").write({ id: "u-live" }, ThreadId.make("u"));
        yield* store.close();

        assert.equal(NodeFS.existsSync(ownedLogPath(basePath, "stale-t")), false);
        assert.equal(NodeFS.existsSync(`${ownedLogPath(basePath, "stale-t")}.1`), false);
        assert.equal(NodeFS.existsSync(`${ownedLogPath(basePath, "stale-t")}.12`), false);
        const after = storedFileContents(tempDir);
        assert.equal(after.get("events.stale-t-x.log"), "TX\n");
        assert.equal(after.get("events._global.log"), "GLOBAL\n");
        assert.equal(after.get("notes.stale-t.log"), "NOTES\n");
        assert.ok((after.get("events.u.log") ?? "").startsWith("U\n"));
        // The retry was a full scan; the batch lookup was a separate call.
        assert.deepEqual(control.calls, [undefined, undefined, [ThreadId.make("u")]]);
        assert.deepEqual(taintWarningTags(entries), ["lookup-failed"]);
        assert.notInclude(warningText(entries), "marker-open-scan");
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
  });

  it.effect("S5b: an empty close still retries the historical scan as a full scan", () => {
    const { entries, capture } = makeWarningCapture();
    return Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      NodeFS.writeFileSync(ownedLogPath(basePath, "stale-t"), "T-CURRENT\n");
      NodeFS.writeFileSync(`${ownedLogPath(basePath, "stale-t")}.1`, "T-1\n");
      NodeFS.writeFileSync(ownedLogPath(basePath, "stale-t-x"), "TX\n");
      NodeFS.writeFileSync(ownedLogPath(basePath, "u"), "U\n");
      NodeFS.writeFileSync(ownedLogPath(basePath, "_global"), "GLOBAL\n");
      NodeFS.writeFileSync(NodePath.join(tempDir, "notes.stale-t.log"), "NOTES\n");
      const control = makeTaintControl();
      control.steps.push(
        { kind: "fail", marker: "marker-open-scan" },
        { kind: "ok", ids: ["stale-t"] },
      );

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          taintedThreads: control.taintedThreads,
        });
        assert.deepEqual(taintWarningTags(entries), ["lookup-failed"]);

        yield* store.close();

        assert.equal(NodeFS.existsSync(ownedLogPath(basePath, "stale-t")), false);
        assert.equal(NodeFS.existsSync(`${ownedLogPath(basePath, "stale-t")}.1`), false);
        const after = storedFileContents(tempDir);
        assert.equal(after.get("events.stale-t-x.log"), "TX\n");
        assert.equal(after.get("events.u.log"), "U\n");
        assert.equal(after.get("events._global.log"), "GLOBAL\n");
        assert.equal(after.get("notes.stale-t.log"), "NOTES\n");
        // Both lookups covered all threads: no per-batch lookup ever happened.
        assert.deepEqual(control.calls, [undefined, undefined]);
        assert.deepEqual(taintWarningTags(entries), ["lookup-failed"]);
        assert.notInclude(warningText(entries), "marker-open-scan");
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
  });

  it.effect("S6: a deterministic purge fault stays pending until a successful retry", () => {
    const { entries, capture } = makeWarningCapture();
    return Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      NodeFS.writeFileSync(ownedLogPath(basePath, "stale-t"), "T-CURRENT\n");
      NodeFS.writeFileSync(`${ownedLogPath(basePath, "stale-t")}.1`, "T-1\n");
      rmSyncFault.armed = true;
      rmSyncFault.targets.add(ownedLogPath(basePath, "stale-t"));
      rmSyncFault.targets.add(`${ownedLogPath(basePath, "stale-t")}.1`);
      const control = makeTaintControl();
      control.steps.push({ kind: "ok", ids: ["stale-t"] });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 0,
          taintedThreads: control.taintedThreads,
        });
        const logger = store.logger("native");

        const attemptedTargets = [
          ownedLogPath(basePath, "stale-t"),
          `${ownedLogPath(basePath, "stale-t")}.1`,
        ].toSorted();
        assert.deepEqual(rmSyncFault.attempts.toSorted(), attemptedTargets);
        assert.equal(NodeFS.readFileSync(ownedLogPath(basePath, "stale-t"), "utf8"), "T-CURRENT\n");
        assert.equal(
          NodeFS.readFileSync(`${ownedLogPath(basePath, "stale-t")}.1`, "utf8"),
          "T-1\n",
        );
        assert.deepEqual(taintWarningTags(entries), ["purge-failed"]);

        // Cached positives block new records without another lookup or purge.
        yield* logger.write({ id: "blocked" }, ThreadId.make("stale-t"));
        assert.equal(rmSyncFault.attempts.length, 2);
        assert.equal(control.calls.length, 1);

        rmSyncFault.armed = false;
        yield* logger.write({ id: "u-live" }, ThreadId.make("u"));
        yield* store.close();

        assert.equal(NodeFS.existsSync(ownedLogPath(basePath, "stale-t")), false);
        assert.equal(NodeFS.existsSync(`${ownedLogPath(basePath, "stale-t")}.1`), false);
        assert.deepEqual(payloadLines(ownedLogPath(basePath, "u")), ['{"id":"u-live"}']);
        assert.deepEqual(control.calls, [undefined, [ThreadId.make("u")]]);
      } finally {
        rmSyncFault.armed = false;
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
  });

  it.effect("S7: a live first positive purges its historical file and its own batch", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const control = makeTaintControl();
      control.steps.push({ kind: "ok" }, { kind: "ok" }, { kind: "ok", ids: ["thread-live"] });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 1_000,
          taintedThreads: control.taintedThreads,
        });
        const logger = store.logger("native");
        yield* logger.write({ id: "pre-commit" }, ThreadId.make("thread-live"));
        yield* TestClock.adjust(1_000);
        assert.deepEqual(payloadLines(ownedLogPath(basePath, "thread-live")), [
          '{"id":"pre-commit"}',
        ]);

        yield* logger.write({ id: "post-1" }, ThreadId.make("thread-live"));
        yield* logger.write({ id: "post-2" }, ThreadId.make("thread-live"));
        yield* TestClock.adjust(1_000);

        // Accepted policy loss: the pre-commit line is gone with the file, and
        // the same batch's records for the now-tainted thread were dropped.
        const leftovers = NodeFS.readdirSync(tempDir).filter((entry) =>
          entry.startsWith("events.thread-live"),
        );
        assert.deepEqual(leftovers, []);

        yield* store.close();
        assert.deepEqual(control.calls, [
          undefined,
          [ThreadId.make("thread-live")],
          [ThreadId.make("thread-live")],
        ]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("S8a: a segment collision purges the shared files and rewrites the survivor", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      NodeFS.writeFileSync(ownedLogPath(basePath, "thread-a"), "PRE-EXISTING\n");
      const control = makeTaintControl();
      control.steps.push({ kind: "ok", ids: ["Thread-A"] }, { kind: "ok" });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 0,
          taintedThreads: control.taintedThreads,
        });

        assert.equal(NodeFS.existsSync(ownedLogPath(basePath, "thread-a")), false);

        // The lowercase thread is untainted; its next record is written anew.
        yield* store.logger("native").write({ id: "recalled" }, ThreadId.make("thread-a"));
        yield* store.close();

        assert.deepEqual(payloadLines(ownedLogPath(basePath, "thread-a")), ['{"id":"recalled"}']);
        assert.deepEqual(control.calls, [undefined, [ThreadId.make("thread-a")]]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect(
    "S8b: unrepresentable segments keep the historical global file and block raw ids",
    () => {
      const { entries, capture } = makeWarningCapture();
      return Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
        const basePath = NodePath.join(tempDir, "events.log");
        NodeFS.writeFileSync(ownedLogPath(basePath, "_global"), "GLOBAL-KEEP\n");
        const control = makeTaintControl();
        control.steps.push({ kind: "ok", ids: ["!!!"] }, { kind: "ok" });

        try {
          const store = yield* makeEventNdjsonLogStore(basePath, {
            batchWindowMs: 0,
            taintedThreads: control.taintedThreads,
          });
          assert.deepEqual(taintWarningTags(entries), ["unrepresentable-segment"]);
          assert.equal(
            NodeFS.readFileSync(ownedLogPath(basePath, "_global"), "utf8"),
            "GLOBAL-KEEP\n",
          );

          // The exact raw id is blocked by the cache before serialization.
          yield* store.logger("native").write({ id: "blocked" }, "!!!" as unknown as ThreadId);
          let contents = NodeFS.readFileSync(ownedLogPath(basePath, "_global"), "utf8");
          assert.equal(contents, "GLOBAL-KEEP\n");
          assert.equal(control.calls.length, 1);

          // A different unrepresentable id still reaches the global segment.
          yield* store.logger("native").write({ id: "other" }, "???" as unknown as ThreadId);
          contents = NodeFS.readFileSync(ownedLogPath(basePath, "_global"), "utf8");
          assert.ok(contents.startsWith("GLOBAL-KEEP\n"));
          assert.include(contents, '{"id":"other"}');
          assert.notInclude(contents, '{"id":"blocked"}');
          yield* store.close();
        } finally {
          NodeFS.rmSync(tempDir, { recursive: true, force: true });
        }
      }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
    },
  );

  it.effect(
    "B2: interrupting close while a flusher holds the permit abandons the unchecked batch",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
        const basePath = NodePath.join(tempDir, "events.log");
        const control = makeTaintControl();
        control.steps.push({ kind: "ok" });
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        control.steps.push({ kind: "hold", entered, gate });

        try {
          const store = yield* makeEventNdjsonLogStore(basePath, {
            batchWindowMs: 1_000,
            taintedThreads: control.taintedThreads,
          });
          const logger = store.logger("native");
          yield* logger.write({ id: "unchecked" }, ThreadId.make("thread-abandoned"));

          yield* TestClock.adjust(1_000).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const closer = yield* store.close().pipe(Effect.forkChild);
          yield* Effect.yieldNow;

          yield* Fiber.interrupt(closer);
          const closerExit = yield* Effect.exit(Fiber.join(closer));
          assert.equal(Exit.isSuccess(closerExit), false);

          yield* Deferred.succeed(gate, undefined);
          yield* TestClock.adjust(1_000);

          // Timer scope closed, permit released, and the unchecked batch was
          // never written despite the released lookup.
          assert.deepEqual(
            NodeFS.readdirSync(tempDir).filter((entry) => entry.endsWith(".log")),
            [],
          );
          assert.deepEqual(control.calls, [undefined, [ThreadId.make("thread-abandoned")]]);
        } finally {
          NodeFS.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
  );

  it.effect("B2: a masked close is interruptible while parked on the flusher permit", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const control = makeTaintControl();
      control.steps.push({ kind: "ok" });
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      control.steps.push({ kind: "hold", entered, gate });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 1_000,
          taintedThreads: control.taintedThreads,
        });
        const logger = store.logger("native");
        yield* logger.write({ id: "unchecked" }, ThreadId.make("thread-masked"));

        // The timer flush holds the permit, parked inside its lookup.
        yield* TestClock.adjust(1_000).pipe(Effect.forkChild);
        yield* Deferred.await(entered);

        // Close entered from an already-masked caller, like a scope finalizer:
        // the inherited mask must not make the permit wait uninterruptible.
        const closeStarted = yield* Deferred.make<void>();
        const closer = yield* Effect.uninterruptibleMask(() =>
          Deferred.succeed(closeStarted, undefined).pipe(Effect.andThen(store.close())),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(closeStarted);
        yield* Effect.yieldNow;

        // The interruption completes before the held lookup is released.
        yield* Fiber.interrupt(closer);
        const closerExit = yield* Effect.exit(Fiber.join(closer));
        assert.equal(Exit.isSuccess(closerExit), false);

        yield* Deferred.succeed(gate, undefined);
        yield* TestClock.adjust(1_000);

        // The timer scope was cleaned up on the interrupted exit: no timer
        // resumed and the unchecked batch was never written.
        assert.deepEqual(
          NodeFS.readdirSync(tempDir).filter((entry) => entry.endsWith(".log")),
          [],
        );
        assert.deepEqual(control.calls, [undefined, [ThreadId.make("thread-masked")]]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("B2: interrupting the final drain requeues its batch and closes the timer scope", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const control = makeTaintControl();
      control.steps.push({ kind: "ok" }, { kind: "ok" });
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      control.steps.push({ kind: "hold", entered, gate });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 1_000,
          taintedThreads: control.taintedThreads,
        });
        const logger = store.logger("native");
        yield* logger.write({ id: "written" }, ThreadId.make("thread-final-a"));
        yield* TestClock.adjust(1_000);
        assert.deepEqual(payloadLines(ownedLogPath(basePath, "thread-final-a")), [
          '{"id":"written"}',
        ]);

        yield* logger.write({ id: "unchecked" }, ThreadId.make("thread-final-b"));
        const closer = yield* store.close().pipe(Effect.forkChild);
        yield* Deferred.await(entered);

        yield* Fiber.interrupt(closer);
        const closerExit = yield* Effect.exit(Fiber.join(closer));
        assert.equal(Exit.isSuccess(closerExit), false);

        yield* Deferred.succeed(gate, undefined);
        // If the timer scope leaked, the pending timer would fire here and
        // write the unchecked record.
        yield* TestClock.adjust(1_000);

        assert.deepEqual(payloadLines(ownedLogPath(basePath, "thread-final-a")), [
          '{"id":"written"}',
        ]);
        assert.equal(NodeFS.existsSync(ownedLogPath(basePath, "thread-final-b")), false);
        assert.deepEqual(control.calls, [
          undefined,
          [ThreadId.make("thread-final-a")],
          [ThreadId.make("thread-final-b")],
        ]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("F1: an interrupt after positive admission keeps the historical purge durable", () => {
    const { entries, capture } = makeWarningCapture();
    return Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      NodeFS.writeFileSync(ownedLogPath(basePath, "stale-t"), "T-CURRENT\n");
      NodeFS.writeFileSync(`${ownedLogPath(basePath, "stale-t")}.1`, "T-1\n");
      const control = makeTaintControl();
      control.steps.push(
        { kind: "fail", marker: "marker-open-scan" },
        { kind: "ok", ids: ["stale-t"] },
        { kind: "interrupt" },
      );

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 1_000,
          taintedThreads: control.taintedThreads,
        });
        const logger = store.logger("native");
        yield* logger.write({ id: "u-live" }, ThreadId.make("u"));

        // The pending full scan discovers T, then the restricted batch lookup
        // is interrupted before the drain commits anything.
        yield* TestClock.adjust(1_000);

        // The cache survived the interrupt: T is blocked without a new lookup.
        yield* logger.write({ id: "blocked-t" }, ThreadId.make("stale-t"));
        assert.equal(control.calls.length, 3);

        // Recovery drains the requeued batch and the durable purge obligation.
        yield* TestClock.adjust(1_000);
        yield* store.close();

        assert.equal(NodeFS.existsSync(ownedLogPath(basePath, "stale-t")), false);
        assert.equal(NodeFS.existsSync(`${ownedLogPath(basePath, "stale-t")}.1`), false);
        assert.deepEqual(payloadLines(ownedLogPath(basePath, "u")), ['{"id":"u-live"}']);
        assert.deepEqual(control.calls, [
          undefined,
          undefined,
          [ThreadId.make("u")],
          [ThreadId.make("u")],
        ]);
        assert.deepEqual(taintWarningTags(entries), ["lookup-failed"]);
        assert.notInclude(warningText(entries), "marker-open-scan");
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
  });

  it.effect("B1: an interrupt at the write-driven flush boundary requeues and delivers once", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const control = makeTaintControl();
      control.steps.push({ kind: "ok" }, { kind: "interrupt" });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 0,
          taintedThreads: control.taintedThreads,
        });
        const logger = store.logger("native");

        // The write's own flush is interrupted at its first wait after the
        // ownership handoff; the unchecked batch must be recovered, not lost.
        const writer = yield* logger
          .write({ id: "boundary" }, ThreadId.make("thread-boundary"))
          .pipe(Effect.forkChild);
        const writerExit = yield* Effect.exit(Fiber.join(writer));
        assert.equal(Exit.isSuccess(writerExit), false);

        // The recovered batch scheduled its own replacement flush.
        yield* TestClock.adjust(1);
        assert.deepEqual(payloadLines(ownedLogPath(basePath, "thread-boundary")), [
          '{"id":"boundary"}',
        ]);

        yield* store.close();
        assert.deepEqual(payloadLines(ownedLogPath(basePath, "thread-boundary")), [
          '{"id":"boundary"}',
        ]);
        assert.deepEqual(control.calls, [
          undefined,
          [ThreadId.make("thread-boundary")],
          [ThreadId.make("thread-boundary")],
        ]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("F3: an abandoned final drain reports the remaining full-scan cleanup", () => {
    const { entries, capture } = makeWarningCapture();
    return Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const control = makeTaintControl();
      control.steps.push({ kind: "fail", marker: "marker-open-scan" });
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      control.steps.push({ kind: "hold", entered, gate });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          taintedThreads: control.taintedThreads,
        });
        assert.deepEqual(taintWarningTags(entries), ["lookup-failed"]);

        // The close's final drain stays interrupted inside its full scan; the
        // pending historical cleanup must still be reported.
        const closer = yield* store.close().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(closer);
        const closerExit = yield* Effect.exit(Fiber.join(closer));
        assert.equal(Exit.isSuccess(closerExit), false);

        yield* Deferred.succeed(gate, undefined);
        yield* TestClock.adjust(1_000);

        assert.deepEqual(taintWarningTags(entries), ["lookup-failed", "lookup-failed"]);
        assert.deepEqual(control.calls, [undefined, undefined]);
        assert.deepEqual(
          NodeFS.readdirSync(tempDir).filter((entry) => entry.endsWith(".log")),
          [],
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
  });

  it.effect("F3: an abandoned final drain reports the remaining purge cleanup", () => {
    const { entries, capture } = makeWarningCapture();
    return Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      NodeFS.writeFileSync(ownedLogPath(basePath, "stale-t"), "T-CURRENT\n");
      rmSyncFault.armed = true;
      rmSyncFault.targets.add(ownedLogPath(basePath, "stale-t"));
      const control = makeTaintControl();
      control.steps.push({ kind: "ok", ids: ["stale-t"] });
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      control.steps.push({ kind: "hold", entered, gate });

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 1_000,
          taintedThreads: control.taintedThreads,
        });
        assert.deepEqual(taintWarningTags(entries), ["purge-failed"]);
        yield* store.logger("native").write({ id: "u-live" }, ThreadId.make("u"));

        const closer = yield* store.close().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(closer);
        const closerExit = yield* Effect.exit(Fiber.join(closer));
        assert.equal(Exit.isSuccess(closerExit), false);

        yield* Deferred.succeed(gate, undefined);
        yield* TestClock.adjust(1_000);

        // No completion claim: the historical file outlives the abandoned
        // close, and the unchecked batch was never written.
        assert.equal(NodeFS.existsSync(ownedLogPath(basePath, "stale-t")), true);
        assert.equal(NodeFS.existsSync(ownedLogPath(basePath, "u")), false);
        assert.deepEqual(taintWarningTags(entries), ["purge-failed", "purge-failed"]);
        assert.deepEqual(control.calls, [undefined, [ThreadId.make("u")]]);
      } finally {
        rmSyncFault.armed = false;
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
  });
});
