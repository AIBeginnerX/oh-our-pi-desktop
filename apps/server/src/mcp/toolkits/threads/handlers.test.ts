import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { Tool } from "effect/unstable/ai";

import { decideOrchestrationCommand } from "../../../orchestration/decider.ts";
import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import { createEmptyReadModel, projectEvent } from "../../../orchestration/projector.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import { McpInvocationContext, type McpCapability } from "../../McpInvocationContext.ts";
import { ThreadsToolkitHandlersLive } from "./handlers.ts";
import { ThreadsToolkit } from "./tools.ts";

const NOW = "2026-10-29T00:00:00.000Z";
const source = ThreadId.make("source");
const target = ThreadId.make("target");
const turnId = TurnId.make("turn");
const projectId = ProjectId.make("project");
const instanceId = ProviderInstanceId.make("codex");

const runningTurn = {
  turnId,
  state: "running",
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: null,
  assistantMessageId: null,
} satisfies OrchestrationThread["latestTurn"];

const session = (status: OrchestrationSession["status"]): OrchestrationSession => ({
  status,
  threadId: target,
  activeTurnId: status === "running" ? turnId : null,
  providerName: "codex",
  runtimeMode: "full-access",
  lastError: null,
  updatedAt: NOW,
});

const makeThread = (
  id: ThreadId,
  patch: Partial<OrchestrationThread> = {},
): OrchestrationThread => ({
  id,
  projectId,
  title: id,
  modelSelection: { instanceId, model: "test" },
  runtimeMode: "full-access",
  interactionMode: "plan",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  activities: [],
  messages: [],
  proposedPlans: [],
  checkpoints: [],
  ...patch,
});

const message = (
  index: number,
  role: OrchestrationMessage["role"],
  text: string,
): OrchestrationMessage => ({
  id: MessageId.make(`message-${index}`),
  role,
  text,
  turnId: null,
  createdAt: NOW,
  updatedAt: NOW,
  streaming: false,
});

const makeHarness = Effect.fn("makeThreadsToolkitHarness")(function* (
  beforeDispatch?: (
    command: OrchestrationCommand,
  ) => Effect.Effect<void, OrchestrationCommandInvariantError>,
) {
  yield* TestClock.setTime(Date.parse(NOW));
  const threads = new Map([
    [source, makeThread(source, { latestTurn: runningTurn, title: "Source thread" })],
    [target, makeThread(target)],
  ]);
  const commands: OrchestrationCommand[] = [];
  const windows: number[] = [];
  const pendingTurns = new Map<ThreadId, MessageId>();
  const turnInputs = new Map<ThreadId, MessageId>();
  const page = { beforeCursor: null, hasMore: false, snapshotSequence: 0 };
  const toShell = (thread: OrchestrationThread): OrchestrationThreadShell => ({
    ...thread,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });
  const toolkit = yield* ThreadsToolkit.pipe(
    Effect.provide(ThreadsToolkitHandlersLive),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: (id) => {
            const thread = threads.get(id);
            return Effect.succeed(
              thread?.deletedAt === null ? Option.some(toShell(thread)) : Option.none(),
            );
          },
          getShellSnapshot: () =>
            Effect.succeed({
              projects: [],
              threads: [...threads.values()]
                .filter((thread) => thread.deletedAt === null)
                .map(toShell),
              snapshotSequence: 0,
              updatedAt: NOW,
            }),
          getThreadDetailSnapshot: (id, window) =>
            Effect.sync(() => {
              if (window?.turnLimit === undefined)
                throw new Error("Expected a bounded turn window");
              windows.push(window.turnLimit);
              const thread = threads.get(id);
              return thread === undefined
                ? Option.none()
                : Option.some({ thread, snapshotSequence: 0, page });
            }),
        }),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            (beforeDispatch?.(command) ?? Effect.void).pipe(
              Effect.map(() => {
                commands.push(command);
                return { sequence: commands.length };
              }),
            ),
        }),
        Layer.mock(ProjectionTurnRepository)({
          getByTurnId: (input) =>
            Effect.succeed(
              Option.some({
                ...runningTurn,
                ...input,
                pendingMessageId: turnInputs.get(input.threadId) ?? null,
                checkpointTurnCount: null,
                checkpointRef: null,
                checkpointStatus: null,
                checkpointFiles: [],
                sourceProposedPlanThreadId: null,
                sourceProposedPlanId: null,
              }),
            ),
          getPendingTurnStartByThreadId: ({ threadId }) => {
            const messageId = pendingTurns.get(threadId);
            return Effect.succeed(
              messageId === undefined
                ? Option.none()
                : Option.some({
                    threadId,
                    messageId,
                    requestedAt: NOW,
                    sourceProposedPlanThreadId: null,
                    sourceProposedPlanId: null,
                  }),
            );
          },
        }),
      ),
    ),
  );
  const call = <Name extends keyof typeof ThreadsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    options: { threadId?: ThreadId; capable?: boolean } = {},
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof ThreadsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        threadId: options.threadId ?? source,
        providerSessionId: "provider-session",
        providerInstanceId: instanceId,
        capabilities: new Set<McpCapability>(options.capable === false ? [] : ["threads"]),
        issuedAt: 0,
      }),
    );
  return { call, threads, commands, turnInputs, pendingTurns, page, windows };
});

const sendInput = { threadId: target, text: "Check the trace" };
const suggestion = { title: "Check logs", prompt: "Read the logs" };

describe("threads toolkit handlers", () => {
  it.effect("requires the capability on every tool", () =>
    Effect.gen(function* () {
      const { call, commands } = yield* makeHarness();
      for (const effect of [
        call("list_threads", {}, { capable: false }).pipe(Effect.asVoid),
        call("read_thread", { threadId: target }, { capable: false }).pipe(Effect.asVoid),
        call("send_thread_message", sendInput, { capable: false }).pipe(Effect.asVoid),
        call("suggest_task", suggestion, { capable: false }).pipe(Effect.asVoid),
      ]) {
        expect(yield* effect.pipe(Effect.flip)).toMatchObject({
          _tag: "McpCapabilityUnavailableError",
          capability: "threads",
        });
      }
      expect(commands).toEqual([]);
    }),
  );

  it.effect("derives the project from the caller and refuses deleted callers and targets", () =>
    Effect.gen(function* () {
      const { call, threads, commands } = yield* makeHarness();
      for (const patch of [{ projectId: ProjectId.make("other") }, { deletedAt: NOW }]) {
        threads.set(target, makeThread(target, patch));
        expect((yield* call("list_threads", {})).threads).toEqual([]);
        expect(
          (yield* call("read_thread", { threadId: target }).pipe(Effect.flip)).message,
        ).toContain("not found");
        expect((yield* call("send_thread_message", sendInput).pipe(Effect.flip)).message).toContain(
          "not found",
        );
      }
      threads.set(source, makeThread(source, { deletedAt: NOW }));
      expect((yield* call("suggest_task", suggestion).pipe(Effect.flip)).message).toContain(
        "not found",
      );
      expect(commands).toEqual([]);
    }),
  );

  it.effect("lists only the newest 20 other active project threads with coarse statuses", () =>
    Effect.gen(function* () {
      const { call, threads } = yield* makeHarness();
      threads.set(target, makeThread(target, { archivedAt: NOW }));
      const member = ThreadId.make("member");
      threads.set(member, makeThread(member, { parentThreadId: source }));
      for (let index = 0; index < 25; index++) {
        const id = ThreadId.make(`thread-${index}`);
        threads.set(
          id,
          makeThread(id, {
            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(NOW) - index * 1000)),
            ...(index === 0 ? { session: session("starting") } : {}),
          }),
        );
      }
      const listed = (yield* call("list_threads", {})).threads;
      expect(listed.map(({ id }) => id)).toEqual(
        Array.from({ length: 20 }, (_, i) => `thread-${i}`),
      );
      expect(listed.slice(0, 2).map(({ status }) => status)).toEqual(["running", "idle"]);
    }),
  );

  it.effect("reads only recent user and assistant text, oldest first and capped", () =>
    Effect.gen(function* () {
      const { call, threads, windows, page } = yield* makeHarness();
      const messages = Array.from({ length: 22 }, (_, i) =>
        message(i, i % 2 === 0 ? "user" : "assistant", String(i)),
      );
      threads.set(
        target,
        makeThread(target, {
          messages: [
            ...messages,
            message(22, "reasoning", "private"),
            message(23, "system", "internal"),
          ],
        }),
      );
      const result = yield* call("read_thread", { threadId: target });
      expect(windows).toEqual([20]);
      expect(result.truncated).toBe(true);
      expect(result.messages.map(({ text }) => text)).toEqual(
        messages.slice(2).map(({ text }) => text),
      );
      threads.set(
        target,
        makeThread(target, { messages: [message(0, "assistant", "a".repeat(12_500))] }),
      );
      const clipped = yield* call("read_thread", { threadId: target });
      expect(clipped.truncated).toBe(true);
      expect(clipped.messages[0]?.text).toHaveLength(12_000);
      expect(clipped.messages[0]?.text).toMatch(/\[truncated\]$/);
      threads.set(target, makeThread(target, { messages: [message(0, "user", "hello")] }));
      expect((yield* call("read_thread", { threadId: target })).truncated).toBe(false);
      page.hasMore = true;
      expect((yield* call("read_thread", { threadId: target })).truncated).toBe(true);
      threads.set(target, makeThread(target, { archivedAt: NOW }));
      expect(
        (yield* call("read_thread", { threadId: target }).pipe(Effect.flip)).message,
      ).toContain("not found");
    }),
  );

  it.effect("refuses self, archive, crew members, and invalid message lengths", () =>
    Effect.gen(function* () {
      const { call, threads, commands } = yield* makeHarness();
      expect(
        (yield* call("send_thread_message", { ...sendInput, threadId: source }).pipe(Effect.flip))
          .message,
      ).toContain("own thread");
      for (const [patch, error] of [
        [{ archivedAt: NOW }, "archived"],
        [{ parentThreadId: source }, "crew member"],
        [{ title: "Crew Expert · Legacy task" }, "crew member"],
      ] satisfies [Partial<OrchestrationThread>, string][]) {
        threads.set(target, makeThread(target, patch));
        expect((yield* call("send_thread_message", sendInput).pipe(Effect.flip)).message).toContain(
          error,
        );
      }
      threads.set(target, makeThread(target));
      for (const text of ["   ", "x".repeat(4_001)]) {
        expect(
          (yield* call("send_thread_message", { ...sendInput, text }).pipe(Effect.flip)).message,
        ).toContain("4,000");
      }
      // The provider reactor would drop this turn after the tool had answered.
      expect(
        (yield* call("send_thread_message", {
          ...sendInput,
          text: "See [note](t3-context://v1/memory/ctx_1)",
        }).pipe(Effect.flip)).message,
      ).toContain("project memory");
      expect(commands).toEqual([]);
    }),
  );

  it.effect("refuses a crew member as the sender and a target with other permissions", () =>
    Effect.gen(function* () {
      const { call, threads, commands } = yield* makeHarness();
      for (const patch of [
        { runtimeMode: "approval-required" },
        { interactionMode: "default" },
      ] satisfies Partial<OrchestrationThread>[]) {
        threads.set(source, makeThread(source, { latestTurn: runningTurn, ...patch }));
        expect((yield* call("send_thread_message", sendInput).pipe(Effect.flip)).message).toContain(
          "different access or interaction mode",
        );
      }
      for (const patch of [
        { parentThreadId: target },
        { title: "Crew Expert · Legacy task" },
      ] satisfies Partial<OrchestrationThread>[]) {
        threads.set(source, makeThread(source, { latestTurn: runningTurn, ...patch }));
        expect((yield* call("send_thread_message", sendInput).pipe(Effect.flip)).message).toContain(
          "reports to its lead",
        );
      }
      expect(commands).toEqual([]);
    }),
  );

  it.effect("keeps a thread that received a message from sending one for an hour", () =>
    Effect.gen(function* () {
      const { call, threads, commands } = yield* makeHarness();
      yield* call("send_thread_message", sendInput);
      // The received turn ended and the server started another one in the target, as a crew
      // follow-up or a goal continuation would.
      threads.set(source, makeThread(source));
      threads.set(
        target,
        makeThread(target, { latestTurn: { ...runningTurn, turnId: TurnId.make("follow-up") } }),
      );
      const reply = call(
        "send_thread_message",
        { threadId: source, text: "Reply" },
        { threadId: target },
      );
      yield* TestClock.adjust("59 minutes");
      expect((yield* reply.pipe(Effect.flip)).message).toContain("within the last hour");
      expect(commands.filter(({ type }) => type === "thread.turn.start")).toHaveLength(1);
      yield* TestClock.adjust("1 minute");
      expect(yield* reply).toEqual({ threadId: source, title: "source" });
    }),
  );

  const makeDispatchRaceHarness = (interveningCommand: OrchestrationCommand) =>
    Effect.gen(function* () {
      let readModel = {
        ...createEmptyReadModel(NOW),
        threads: [makeThread(source), makeThread(target)],
      };
      const applyInterveningCommand = Effect.gen(function* () {
        const result = yield* decideOrchestrationCommand({
          command: interveningCommand,
          readModel,
        });
        for (const event of Array.isArray(result) ? result : [result]) {
          const projected = yield* projectEvent(readModel, {
            ...event,
            sequence: readModel.snapshotSequence + 1,
          });
          readModel = { ...projected, threads: [...projected.threads] };
        }
      });
      return yield* makeHarness((command) =>
        Effect.gen(function* () {
          if (command.type !== "thread.turn.start") return;
          yield* applyInterveningCommand.pipe(Effect.orDie);
          yield* decideOrchestrationCommand({ command, readModel }).pipe(
            Effect.catchTag(["OrchestrationThreadSettleBlockedError", "PlatformError"], Effect.die),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      );
    });

  it.effect("delivers after a calling-thread activity is committed", () =>
    Effect.gen(function* () {
      const { call } = yield* makeDispatchRaceHarness({
        type: "thread.activity.append",
        commandId: CommandId.make("source-activity"),
        threadId: source,
        createdAt: NOW,
        activity: {
          id: EventId.make("source-activity"),
          kind: "tool.started",
          summary: "Tool activity",
          tone: "info",
          payload: {},
          turnId,
          createdAt: NOW,
        },
      });

      expect(yield* call("send_thread_message", sendInput)).toEqual({
        threadId: target,
        title: "target",
      });
    }),
  );

  it.effect("refuses delivery when a user starts a turn after the target was read", () =>
    Effect.gen(function* () {
      const userStart = {
        type: "thread.turn.start",
        commandId: CommandId.make("user-start"),
        threadId: target,
        runtimeMode: "full-access",
        interactionMode: "plan",
        // The user may stamp their message after the server stamped the send.
        createdAt: "2026-10-29T00:00:00.001Z",
        message: {
          messageId: MessageId.make("user-message"),
          role: "user",
          text: "User send",
          attachments: [],
        },
      } satisfies OrchestrationCommand;
      const { call, commands } = yield* makeDispatchRaceHarness(userStart);

      expect(yield* call("send_thread_message", sendInput).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { message: expect.stringContaining("busy") },
      });
      expect(commands).toEqual([]);
    }),
  );

  it.effect("refuses every busy state immediately", () =>
    Effect.gen(function* () {
      const { call, threads, commands, pendingTurns } = yield* makeHarness();
      for (const patch of [
        { session: session("running") },
        { session: session("starting") },
        { latestTurn: runningTurn },
        { messages: [message(0, "user", "queued")] },
        ...["approval.requested", "user-input.requested"].map((kind) => ({
          activities: [
            {
              id: EventId.make(kind),
              kind,
              summary: kind,
              tone: "approval" as const,
              payload: { requestId: "pending" },
              turnId,
              createdAt: NOW,
            },
          ],
        })),
      ]) {
        threads.set(target, makeThread(target, patch));
        expect((yield* call("send_thread_message", sendInput).pipe(Effect.flip)).message).toContain(
          "busy",
        );
      }
      threads.set(target, makeThread(target));
      pendingTurns.set(target, MessageId.make("queued"));
      expect((yield* call("send_thread_message", sendInput).pipe(Effect.flip)).message).toContain(
        "busy",
      );
      expect(commands).toEqual([]);
    }),
  );

  it.effect("wraps the send, appends both activities, and refuses a reply from that turn", () =>
    Effect.gen(function* () {
      const { call, commands, threads, turnInputs } = yield* makeHarness();
      expect(
        yield* call("send_thread_message", { ...sendInput, text: "  Check the trace  " }),
      ).toEqual({ threadId: target, title: "target" });
      const [start, received, sent] = commands;
      expect(start).toMatchObject({
        type: "thread.turn.start",
        threadId: target,
        interactionMode: "plan",
        runtimeMode: "full-access",
        message: {
          role: "user",
          text: 'Message from another thread · "Source thread"\nOOP delivered this on behalf of an agent. It is not a request from the user.\n\nCheck the trace',
          attachments: [],
        },
      });
      if (start?.type !== "thread.turn.start") throw new Error("Missing turn start");
      expect(start.message.text).not.toContain("<oop_crew_follow_up");
      expect(received).toMatchObject({
        type: "thread.activity.append",
        threadId: target,
        activity: {
          kind: "thread.message.received",
          payload: { fromThreadId: source, messageId: start.message.messageId },
        },
      });
      expect(sent).toMatchObject({
        type: "thread.activity.append",
        threadId: source,
        activity: {
          kind: "thread.message.sent",
          turnId,
          payload: { toThreadId: target, title: "target" },
        },
      });

      threads.set(target, makeThread(target, { latestTurn: runningTurn }));
      threads.set(source, makeThread(source));
      turnInputs.set(target, start.message.messageId);
      expect(
        (yield* call(
          "send_thread_message",
          { threadId: source, text: "Reply" },
          { threadId: target },
        ).pipe(Effect.flip)).message,
      ).toContain("cannot send one");
      expect(commands).toHaveLength(3);
    }),
  );

  it.effect("allows three sends per calling turn and resets the limit on a new turn", () =>
    Effect.gen(function* () {
      const { call, threads, commands } = yield* makeHarness();
      yield* Effect.forEach([1, 2, 3], () => call("send_thread_message", sendInput), {
        concurrency: "unbounded",
      });
      expect((yield* call("send_thread_message", sendInput).pipe(Effect.flip)).message).toContain(
        "at most three",
      );
      threads.set(
        source,
        makeThread(source, { latestTurn: { ...runningTurn, turnId: TurnId.make("next") } }),
      );
      yield* call("send_thread_message", {
        ...sendInput,
        text: " ".concat("x".repeat(4_000), " "),
      });
      expect(commands.filter(({ type }) => type === "thread.turn.start")).toHaveLength(4);
    }),
  );

  it.effect("appends one stable activity per suggestion and caps at five per calling turn", () =>
    Effect.gen(function* () {
      const { call, threads, commands } = yield* makeHarness();
      for (const invalid of [
        { title: " ", prompt: "valid" },
        { title: "x".repeat(121), prompt: "valid" },
        { title: "valid", prompt: " " },
        { title: "valid", prompt: "x".repeat(4_001) },
      ]) {
        expect((yield* call("suggest_task", invalid).pipe(Effect.flip)).message).toContain("1–120");
      }
      const result = yield* call("suggest_task", suggestion);
      expect(
        yield* call("suggest_task", { ...suggestion, title: ` ${suggestion.title} ` }),
      ).toEqual(result);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "thread.activity.append",
        threadId: source,
        activity: { kind: "task.suggested", turnId, payload: { ...suggestion, ...result } },
      });
      for (let i = 0; i < 4; i++) yield* call("suggest_task", { ...suggestion, title: String(i) });
      expect(
        (yield* call("suggest_task", { ...suggestion, title: "sixth" }).pipe(Effect.flip)).message,
      ).toContain("at most five");
      expect(yield* call("suggest_task", suggestion)).toEqual(result);
      expect(commands).toHaveLength(5);
      threads.set(
        source,
        makeThread(source, { latestTurn: { ...runningTurn, turnId: TurnId.make("next") } }),
      );
      expect(yield* call("suggest_task", suggestion)).not.toEqual(result);
      expect(commands).toHaveLength(6);
      expect(commands.every(({ type }) => type === "thread.activity.append")).toBe(true);
    }),
  );
});
