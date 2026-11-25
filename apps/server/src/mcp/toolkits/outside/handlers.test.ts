import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AuthMcpClientAccess,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer, type Tool } from "effect/unstable/ai";

import { decideOrchestrationCommand } from "../../../orchestration/decider.ts";
import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import { createEmptyReadModel, projectEvent } from "../../../orchestration/projector.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import {
  McpInvocationContext,
  type McpClientInvocationScope,
  type McpInvocationScope,
  type McpThreadInvocationScope,
} from "../../McpInvocationContext.ts";
import { OutsideToolkitHandlersLive } from "./handlers.ts";
import { OutsideToolkit } from "./tools.ts";

const NOW = "2026-10-29T00:00:00.000Z";
const projectAlpha = ProjectId.make("project-alpha");
const projectBeta = ProjectId.make("project-beta");
const threadAlpha = ThreadId.make("thread-alpha");
const threadBeta = ThreadId.make("thread-beta");
const turnId = TurnId.make("turn-1");
const instanceId = ProviderInstanceId.make("codex");
const approvalReqId = ApprovalRequestId.make("approval-req-1");
const questionReqId = ApprovalRequestId.make("question-req-1");

const makeProject = (
  id: ProjectId,
  patch: Partial<OrchestrationProjectShell> = {},
): OrchestrationProjectShell => ({
  id,
  title: `Project ${id}`,
  workspaceRoot: `/workspaces/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...patch,
});

const makeThread = (
  id: ThreadId,
  projectId: ProjectId,
  patch: Partial<OrchestrationThread> = {},
): OrchestrationThread => ({
  id,
  projectId,
  title: `Title ${id}`,
  modelSelection: { instanceId, model: "gpt-5" },
  runtimeMode: "auto-accept-edits",
  interactionMode: "default",
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

const makeSession = (
  threadId: ThreadId,
  status: OrchestrationSession["status"],
): OrchestrationSession => ({
  status,
  threadId,
  activeTurnId: status === "running" ? turnId : null,
  providerName: "codex",
  runtimeMode: "full-access",
  lastError: null,
  updatedAt: NOW,
});

const makeMessage = (
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

const makeApprovalActivity = (
  requestId: ApprovalRequestId = approvalReqId,
  payloadPatch: Record<string, unknown> = {},
): OrchestrationThreadActivity => ({
  id: EventId.make(`evt-${requestId}`),
  kind: "approval.requested",
  summary: "Command approval requested",
  tone: "approval",
  payload: {
    requestId,
    requestKind: "command",
    detail: "rm -rf dist",
    ...payloadPatch,
  },
  turnId,
  createdAt: NOW,
});

const makeQuestionActivity = (
  requestId: ApprovalRequestId = questionReqId,
  questions: ReadonlyArray<Record<string, unknown>> = [
    {
      id: "env",
      header: "Environment",
      question: "Deploy to which env?",
      options: [
        { label: "Staging", description: "Deploy to staging first" },
        { label: "Production", description: "Deploy straight to prod" },
      ],
      multiSelect: false,
      allowCustomAnswer: false,
    },
    {
      id: "areas",
      header: "Areas",
      question: "Which areas should be checked?",
      options: [
        { label: "Server", description: "Backend tests" },
        { label: "Web", description: "Frontend tests" },
      ],
      multiSelect: true,
      allowCustomAnswer: true,
    },
  ],
): OrchestrationThreadActivity => ({
  id: EventId.make(`evt-${requestId}`),
  kind: "user-input.requested",
  summary: "User input requested",
  tone: "info",
  payload: {
    requestId,
    questions,
  },
  turnId,
  createdAt: NOW,
});

const clientScope = (
  access: AuthMcpClientAccess,
  label = "Claude Code",
): McpClientInvocationScope => ({
  environmentId: EnvironmentId.make("env-test"),
  client: {
    sessionId: "mcp-session-1",
    label,
    access,
  },
  capabilities: new Set(),
  issuedAt: 0,
});

const threadScope = (): McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("env-test"),
  threadId: threadAlpha,
  providerSessionId: "provider-session-1",
  providerInstanceId: instanceId,
  capabilities: new Set(["threads"]),
  issuedAt: 0,
});

const makeHarness = Effect.fn("makeOutsideToolkitHarness")(function* (options?: {
  readonly settings?: ServerSettings;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly beforeDispatch?: (
    command: OrchestrationCommand,
  ) => Effect.Effect<void, OrchestrationCommandInvariantError>;
}) {
  yield* TestClock.setTime(Date.parse(NOW));
  const projects = new Map<ProjectId, OrchestrationProjectShell>([
    [projectAlpha, makeProject(projectAlpha, { title: "Alpha", workspaceRoot: "/work/alpha" })],
    [projectBeta, makeProject(projectBeta, { title: "Beta", workspaceRoot: "/work/beta" })],
  ]);
  const threads = new Map<ThreadId, OrchestrationThread>([
    [threadAlpha, makeThread(threadAlpha, projectAlpha)],
    [threadBeta, makeThread(threadBeta, projectBeta)],
  ]);
  const shellOverrides = new Map<
    ThreadId,
    Partial<Pick<OrchestrationThreadShell, "hasPendingApprovals" | "hasPendingUserInput">>
  >();
  const pendingTurns = new Map<ThreadId, MessageId>();
  const commands: OrchestrationCommand[] = [];
  const page = { beforeCursor: null, hasMore: false, snapshotSequence: 0 };
  const windows: number[] = [];

  let settings: ServerSettings = options?.settings ?? DEFAULT_SERVER_SETTINGS;
  const providers: ReadonlyArray<ServerProvider> = options?.providers ?? [];

  const toShell = (thread: OrchestrationThread): OrchestrationThreadShell => ({
    ...thread,
    latestUserMessageAt: null,
    hasPendingApprovals: shellOverrides.get(thread.id)?.hasPendingApprovals ?? false,
    hasPendingUserInput: shellOverrides.get(thread.id)?.hasPendingUserInput ?? false,
    hasActionableProposedPlan: false,
  });

  const toolkit = yield* OutsideToolkit.pipe(
    Effect.provide(
      OutsideToolkitHandlersLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionSnapshotQuery)({
              getProjectShells: () => Effect.sync(() => [...projects.values()]),
              getProjectShellById: (id) =>
                Effect.sync(() => Option.fromNullishOr(projects.get(id))),
              getThreadShellById: (id) =>
                Effect.sync(() => {
                  const thread = threads.get(id);
                  return thread?.deletedAt === null ? Option.some(toShell(thread)) : Option.none();
                }),
              getShellSnapshot: () =>
                Effect.sync(() => ({
                  projects: [...projects.values()],
                  threads: [...threads.values()]
                    .filter((thread) => thread.deletedAt === null)
                    .map(toShell),
                  snapshotSequence: 0,
                  updatedAt: NOW,
                })),
              getThreadDetailSnapshot: (id, window) =>
                Effect.sync(() => {
                  if (window?.turnLimit === undefined) {
                    throw new Error("Expected a bounded turn window");
                  }
                  windows.push(window.turnLimit);
                  const thread = threads.get(id);
                  return thread === undefined
                    ? Option.none()
                    : Option.some({ thread, snapshotSequence: 0, page });
                }),
            }),
            Layer.mock(OrchestrationEngineService)({
              dispatch: (command) =>
                (options?.beforeDispatch?.(command) ?? Effect.void).pipe(
                  Effect.map(() => {
                    commands.push(command);
                    return { sequence: commands.length };
                  }),
                ),
            }),
            Layer.mock(ProjectionTurnRepository)({
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
            Layer.mock(ProviderRegistry)({
              getProviders: Effect.succeed(providers),
            }),
            Layer.mock(ServerSettingsService)({
              getSettings: Effect.sync(() => settings),
            }),
          ),
        ),
      ),
    ),
  );

  const call = <Name extends keyof typeof OutsideToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope: McpInvocationScope,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof OutsideToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext, scope),
    );

  return {
    call,
    projects,
    threads,
    shellOverrides,
    pendingTurns,
    commands,
    page,
    windows,
    setSettings: (next: ServerSettings) => {
      settings = next;
    },
  };
});

describe("outside toolkit handlers", () => {
  it.effect("refuses thread scopes on every tool and points them to the threads toolkit", () =>
    Effect.gen(function* () {
      const { call, commands } = yield* makeHarness();
      const scope = threadScope();
      for (const effect of [
        call("oop_project_list", {}, scope).pipe(Effect.asVoid),
        call("oop_thread_list", { allProjects: true }, scope).pipe(Effect.asVoid),
        call("oop_thread_read", { threadId: threadAlpha }, scope).pipe(Effect.asVoid),
        call("oop_thread_start", { projectId: projectAlpha, message: "Hi" }, scope).pipe(
          Effect.asVoid,
        ),
        call("oop_thread_send", { threadId: threadAlpha, message: "Hi" }, scope).pipe(
          Effect.asVoid,
        ),
        call(
          "oop_thread_approve",
          { threadId: threadAlpha, requestId: approvalReqId, decision: "accept" },
          scope,
        ).pipe(Effect.asVoid),
        call(
          "oop_thread_answer",
          { threadId: threadAlpha, requestId: questionReqId, answers: { env: "Staging" } },
          scope,
        ).pipe(Effect.asVoid),
        call("oop_thread_interrupt", { threadId: threadAlpha }, scope).pipe(Effect.asVoid),
      ]) {
        const failure = yield* effect.pipe(Effect.flip);
        expect(failure._tag).toBe("OutsideToolRejected");
        expect(failure.message).toContain("list_threads");
        expect(failure.message).toContain("read_thread");
        expect(failure.message).toContain("send_thread_message");
      }
      expect(commands).toEqual([]);
    }),
  );

  it.effect(
    "lets a read-only client list projects and list threads across projects with filtering and statuses",
    () =>
      Effect.gen(function* () {
        const { call, threads, shellOverrides } = yield* makeHarness();
        const readOnly = clientScope("read-only");

        const listedProjects = yield* call("oop_project_list", {}, readOnly);
        expect(listedProjects).toEqual({
          projects: [
            { id: projectAlpha, title: "Alpha", workspaceRoot: "/work/alpha" },
            { id: projectBeta, title: "Beta", workspaceRoot: "/work/beta" },
          ],
        });

        const tOlder = DateTime.formatIso(DateTime.makeUnsafe(Date.parse(NOW) - 2_000));
        const tMid = DateTime.formatIso(DateTime.makeUnsafe(Date.parse(NOW) - 1_000));
        const tNewest = NOW;
        threads.set(
          threadAlpha,
          makeThread(threadAlpha, projectAlpha, {
            updatedAt: tOlder,
            session: makeSession(threadAlpha, "running"),
          }),
        );
        threads.set(
          threadBeta,
          makeThread(threadBeta, projectBeta, {
            updatedAt: tNewest,
          }),
        );
        shellOverrides.set(threadBeta, { hasPendingUserInput: true });

        const idleThread = ThreadId.make("thread-idle");
        threads.set(idleThread, makeThread(idleThread, projectAlpha, { updatedAt: tMid }));
        const archived = ThreadId.make("thread-archived");
        threads.set(archived, makeThread(archived, projectAlpha, { archivedAt: NOW }));
        const deleted = ThreadId.make("thread-deleted");
        threads.set(deleted, makeThread(deleted, projectAlpha, { deletedAt: NOW }));
        const crewChild = ThreadId.make("thread-crew-child");
        threads.set(
          crewChild,
          makeThread(crewChild, projectAlpha, { parentThreadId: threadAlpha }),
        );
        const legacyCrew = ThreadId.make("thread-crew-legacy");
        threads.set(
          legacyCrew,
          makeThread(legacyCrew, projectBeta, { title: "Crew Expert · Legacy task" }),
        );

        const allListed = yield* call("oop_thread_list", { allProjects: true }, readOnly);
        expect(allListed.threads).toEqual([
          {
            id: threadBeta,
            projectId: projectBeta,
            title: `Title ${threadBeta}`,
            updatedAt: tNewest,
            status: "needs input",
          },
          {
            id: idleThread,
            projectId: projectAlpha,
            title: `Title ${idleThread}`,
            updatedAt: tMid,
            status: "idle",
          },
          {
            id: threadAlpha,
            projectId: projectAlpha,
            title: `Title ${threadAlpha}`,
            updatedAt: tOlder,
            status: "running",
          },
        ]);

        const singleProject = yield* call(
          "oop_thread_list",
          { projectId: projectAlpha, limit: 1 },
          readOnly,
        );
        expect(singleProject.threads.map((thread) => thread.id)).toEqual([idleThread]);

        const unknownProject = yield* call(
          "oop_thread_list",
          { projectId: ProjectId.make("missing-project") },
          readOnly,
        ).pipe(Effect.flip);
        expect(unknownProject.message).toContain("Project not found");
      }),
  );

  it.effect("requires exactly one of projectId or allProjects: true on oop_thread_list", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness();
      const readOnly = clientScope("read-only");
      for (const params of [
        {},
        { allProjects: false },
        { projectId: projectAlpha, allProjects: true },
      ]) {
        const failure = yield* call("oop_thread_list", params, readOnly).pipe(Effect.flip);
        expect(failure.message).toBe("Pass projectId, or allProjects: true for every project.");
      }
    }),
  );

  it.effect("reads threads from any project with the shared 20-message and 12,000-char caps", () =>
    Effect.gen(function* () {
      const { call, threads, windows, page } = yield* makeHarness();
      const readOnly = clientScope("read-only");
      const messages = Array.from({ length: 22 }, (_, i) =>
        makeMessage(i, i % 2 === 0 ? "user" : "assistant", String(i)),
      );
      threads.set(
        threadBeta,
        makeThread(threadBeta, projectBeta, {
          messages: [
            ...messages,
            makeMessage(22, "reasoning", "hidden"),
            makeMessage(23, "system", "internal"),
          ],
        }),
      );

      const result = yield* call("oop_thread_read", { threadId: threadBeta }, readOnly);
      expect(windows).toEqual([20]);
      expect(result.truncated).toBe(true);
      expect(result.messages.map(({ text }) => text)).toEqual(
        messages.slice(2).map(({ text }) => text),
      );

      threads.set(
        threadBeta,
        makeThread(threadBeta, projectBeta, {
          messages: [makeMessage(0, "assistant", "z".repeat(12_500))],
        }),
      );
      const clipped = yield* call("oop_thread_read", { threadId: threadBeta }, readOnly);
      expect(clipped.truncated).toBe(true);
      expect(clipped.messages[0]?.text).toHaveLength(12_000);
      expect(clipped.messages[0]?.text).toMatch(/\[truncated\]$/);

      threads.set(
        threadBeta,
        makeThread(threadBeta, projectBeta, {
          messages: [makeMessage(0, "user", "hello")],
        }),
      );
      expect((yield* call("oop_thread_read", { threadId: threadBeta }, readOnly)).truncated).toBe(
        false,
      );
      page.hasMore = true;
      expect((yield* call("oop_thread_read", { threadId: threadBeta }, readOnly)).truncated).toBe(
        true,
      );

      threads.set(threadBeta, makeThread(threadBeta, projectBeta, { archivedAt: NOW }));
      expect(
        (yield* call("oop_thread_read", { threadId: threadBeta }, readOnly).pipe(Effect.flip))
          .message,
      ).toContain("not found");
    }),
  );

  it.effect(
    "returns status, pendingApprovals, and pendingQuestions on oop_thread_read and clears them when resolved",
    () =>
      Effect.gen(function* () {
        const { call, threads, windows, shellOverrides } = yield* makeHarness();
        const readOnly = clientScope("read-only");
        const longDetail = "d".repeat(2_500);
        const approvalWithOptions = makeApprovalActivity(approvalReqId, {
          detail: longDetail,
          options: [
            { decision: "accept", label: "Allow once" },
            { decision: "acceptAlways", label: "Always allow" },
            { decision: "decline", label: "Deny" },
          ],
        });
        const approvalDefaultDecisions = makeApprovalActivity(
          ApprovalRequestId.make("approval-req-default"),
          { detail: "" },
        );
        const question = makeQuestionActivity(questionReqId);
        const badQuestion: OrchestrationThreadActivity = {
          id: EventId.make("evt-bad-question"),
          kind: "user-input.requested",
          summary: "Malformed question",
          tone: "info",
          payload: { requestId: "bad-question-id", questions: "not-an-array" },
          turnId,
          createdAt: NOW,
        };

        threads.set(
          threadAlpha,
          makeThread(threadAlpha, projectAlpha, {
            session: makeSession(threadAlpha, "running"),
            activities: [approvalWithOptions, approvalDefaultDecisions, question, badQuestion],
          }),
        );
        shellOverrides.set(threadAlpha, { hasPendingApprovals: true, hasPendingUserInput: true });

        const openResult = yield* call(
          "oop_thread_read",
          { threadId: threadAlpha },
          clientScope("auto"),
        );
        expect(windows).toEqual([20]);
        expect(openResult.status).toBe("needs input");
        expect(openResult.pendingApprovals).toEqual([
          {
            requestId: approvalReqId,
            summary: "Command approval requested",
            detail: `${"d".repeat(2_000 - "… [truncated]".length)}… [truncated]`,
            decisions: ["accept", "decline"],
          },
          {
            requestId: ApprovalRequestId.make("approval-req-default"),
            summary: "Command approval requested",
            decisions: ["accept", "decline", "cancel"],
          },
        ]);

        // A read-only client sees that approvals are pending, not the tool input behind them.
        const readOnlyResult = yield* call("oop_thread_read", { threadId: threadAlpha }, readOnly);
        expect(readOnlyResult.pendingApprovals.map((approval) => "detail" in approval)).toEqual([
          false,
          false,
        ]);
        expect(readOnlyResult.pendingQuestions).toEqual(openResult.pendingQuestions);
        expect(openResult.pendingQuestions).toEqual([
          {
            requestId: questionReqId,
            questions: [
              {
                id: "env",
                header: "Environment",
                question: "Deploy to which env?",
                options: [
                  { label: "Staging", description: "Deploy to staging first" },
                  { label: "Production", description: "Deploy straight to prod" },
                ],
                multiSelect: false,
                allowCustomAnswer: false,
              },
              {
                id: "areas",
                header: "Areas",
                question: "Which areas should be checked?",
                options: [
                  { label: "Server", description: "Backend tests" },
                  { label: "Web", description: "Frontend tests" },
                ],
                multiSelect: true,
                allowCustomAnswer: true,
              },
            ],
          },
        ]);

        shellOverrides.delete(threadAlpha);
        threads.set(
          threadAlpha,
          makeThread(threadAlpha, projectAlpha, {
            activities: [
              approvalWithOptions,
              approvalDefaultDecisions,
              question,
              {
                id: EventId.make("evt-approval-resolved-1"),
                kind: "approval.resolved",
                summary: "Approval resolved",
                tone: "info",
                payload: { requestId: approvalReqId },
                turnId,
                createdAt: NOW,
              },
              {
                id: EventId.make("evt-approval-resolved-2"),
                kind: "approval.resolved",
                summary: "Approval resolved",
                tone: "info",
                payload: { requestId: "approval-req-default" },
                turnId,
                createdAt: NOW,
              },
              {
                id: EventId.make("evt-question-resolved"),
                kind: "user-input.resolved",
                summary: "User input submitted",
                tone: "info",
                payload: { requestId: questionReqId },
                turnId,
                createdAt: NOW,
              },
            ],
          }),
        );

        const resolvedResult = yield* call("oop_thread_read", { threadId: threadAlpha }, readOnly);
        expect(resolvedResult.status).toBe("idle");
        expect(resolvedResult.pendingApprovals).toEqual([]);
        expect(resolvedResult.pendingQuestions).toEqual([]);
      }),
  );

  it.effect("refuses read-only clients on both write tools before dispatching anything", () =>
    Effect.gen(function* () {
      const { call, commands } = yield* makeHarness();
      const readOnly = clientScope("read-only");
      const startFailure = yield* call(
        "oop_thread_start",
        { projectId: projectAlpha, message: "Run the build" },
        readOnly,
      ).pipe(Effect.flip);
      expect(startFailure.message).toBe(
        "This tool changes the environment, and this MCP client was approved for read-only access.",
      );

      const sendFailure = yield* call(
        "oop_thread_send",
        { threadId: threadAlpha, message: "Continue" },
        readOnly,
      ).pipe(Effect.flip);
      expect(sendFailure.message).toBe(
        "This tool changes the environment, and this MCP client was approved for read-only access.",
      );
      expect(commands).toEqual([]);
    }),
  );

  it.effect(
    "caps runtimeMode on oop_thread_start to the lower of project default and client ceiling",
    () =>
      Effect.gen(function* () {
        const { call, commands, setSettings } = yield* makeHarness({
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            defaultRuntimeMode: "full-access",
            projectSettingsOverrides: {
              [projectAlpha]: { defaultRuntimeMode: "full-access" },
              [projectBeta]: { defaultRuntimeMode: "approval-required" },
            },
          },
        });

        const longFirstLine = `${"a".repeat(140)}\nsecond line details`;
        const started = yield* call(
          "oop_thread_start",
          { projectId: projectAlpha, message: `  ${longFirstLine}  ` },
          clientScope("auto-accept-edits", "External Bot"),
        );

        expect(started.threadId.startsWith("server:outside:")).toBe(true);
        expect(started.title).toBe("a".repeat(120));
        expect(commands).toHaveLength(3);

        const [createCmd, turnCmd, activityCmd] = commands;
        expect(createCmd).toMatchObject({
          type: "thread.create",
          threadId: started.threadId,
          projectId: projectAlpha,
          title: "a".repeat(120),
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        expect(turnCmd).toMatchObject({
          type: "thread.turn.start",
          threadId: started.threadId,
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          message: {
            role: "user",
            text: longFirstLine,
            attachments: [],
          },
        });
        if (turnCmd?.type !== "thread.turn.start") throw new Error("Missing turn start");
        expect(turnCmd.message.messageId.startsWith("server:outside:")).toBe(true);
        expect(createCmd?.commandId.startsWith("server:outside:")).toBe(true);
        expect(turnCmd.commandId.startsWith("server:outside:")).toBe(true);
        expect(activityCmd).toMatchObject({
          type: "thread.activity.append",
          threadId: started.threadId,
          activity: {
            kind: "outside-agent.message",
            tone: "info",
            summary: "Message from External Bot over MCP",
            turnId: null,
          },
        });

        // A full-access client still respects a lower project default runtimeMode.
        const restricted = yield* call(
          "oop_thread_start",
          { projectId: projectBeta, message: "Check status", title: "  Status check  " },
          clientScope("full-access"),
        );
        expect(restricted.title).toBe("Status check");
        const secondCreate = commands[3];
        expect(secondCreate).toMatchObject({
          type: "thread.create",
          projectId: projectBeta,
          runtimeMode: "approval-required",
        });

        // Unknown project and message length bounds (1-20,000 chars after trimming) are enforced.
        setSettings(DEFAULT_SERVER_SETTINGS);
        expect(
          (yield* call(
            "oop_thread_start",
            { projectId: ProjectId.make("unknown"), message: "Hello" },
            clientScope("auto"),
          ).pipe(Effect.flip)).message,
        ).toContain("Project not found");
        for (const invalid of ["   ", "x".repeat(20_001)]) {
          expect(
            (yield* call(
              "oop_thread_start",
              { projectId: projectAlpha, message: invalid },
              clientScope("auto"),
            ).pipe(Effect.flip)).message,
          ).toContain("20,000");
        }
      }),
  );

  it.effect("refuses oop_thread_send when the thread runtimeMode exceeds the client ceiling", () =>
    Effect.gen(function* () {
      const { call, threads, commands } = yield* makeHarness();
      threads.set(
        threadAlpha,
        makeThread(threadAlpha, projectAlpha, { runtimeMode: "full-access" }),
      );

      const failure = yield* call(
        "oop_thread_send",
        { threadId: threadAlpha, message: "Please run tests" },
        clientScope("auto-accept-edits"),
      ).pipe(Effect.flip);
      expect(failure.message).toBe(
        "This thread runs with more access than this MCP client was approved for.",
      );
      expect(commands).toEqual([]);
    }),
  );

  it.effect(
    "starts a turn on an idle thread within the ceiling and appends the outside-agent activity",
    () =>
      Effect.gen(function* () {
        const { call, threads, commands } = yield* makeHarness();
        threads.set(
          threadAlpha,
          makeThread(threadAlpha, projectAlpha, {
            title: "Build pipeline",
            runtimeMode: "auto-accept-edits",
            interactionMode: "plan",
          }),
        );

        const sent = yield* call(
          "oop_thread_send",
          { threadId: threadAlpha, message: "  Investigate the flake  " },
          clientScope("auto", "Terminal Claude"),
        );
        expect(sent).toEqual({ threadId: threadAlpha, title: "Build pipeline" });

        const [turnCmd, activityCmd] = commands;
        expect(turnCmd).toMatchObject({
          type: "thread.turn.start",
          threadId: threadAlpha,
          runtimeMode: "auto-accept-edits",
          interactionMode: "plan",
          message: {
            role: "user",
            text: "Investigate the flake",
            attachments: [],
          },
        });
        if (turnCmd?.type !== "thread.turn.start") throw new Error("Missing turn start");
        expect(turnCmd.message.messageId.startsWith("server:outside:")).toBe(true);
        expect(activityCmd).toMatchObject({
          type: "thread.activity.append",
          threadId: threadAlpha,
          activity: {
            kind: "outside-agent.message",
            tone: "info",
            summary: "Message from Terminal Claude over MCP",
            turnId: null,
          },
        });
      }),
  );

  it.effect(
    "refuses archived, deleted, crew member, busy, and raced threads on oop_thread_send",
    () =>
      Effect.gen(function* () {
        const { call, threads, pendingTurns, commands } = yield* makeHarness();
        const scope = clientScope("full-access");

        for (const [patch, expected] of [
          [{ archivedAt: NOW }, "archived"],
          [{ deletedAt: NOW }, "not found"],
          [{ parentThreadId: threadBeta }, "crew member"],
          [{ title: "Crew Expert · Legacy task" }, "crew member"],
          [{ session: makeSession(threadAlpha, "running") }, "busy"],
          [{ session: makeSession(threadAlpha, "starting") }, "busy"],
          [
            {
              activities: [
                {
                  id: EventId.make("approval-1"),
                  kind: "approval.requested",
                  summary: "Approval requested",
                  tone: "approval" as const,
                  payload: { requestId: "req-1" },
                  turnId,
                  createdAt: NOW,
                },
              ],
            },
            "busy",
          ],
        ] satisfies Array<[Partial<OrchestrationThread>, string]>) {
          threads.set(threadAlpha, makeThread(threadAlpha, projectAlpha, patch));
          expect(
            (yield* call("oop_thread_send", { threadId: threadAlpha, message: "Ping" }, scope).pipe(
              Effect.flip,
            )).message,
          ).toContain(expected);
        }

        threads.set(threadAlpha, makeThread(threadAlpha, projectAlpha));
        pendingTurns.set(threadAlpha, MessageId.make("pending-msg"));
        expect(
          (yield* call("oop_thread_send", { threadId: threadAlpha, message: "Ping" }, scope).pipe(
            Effect.flip,
          )).message,
        ).toContain("busy");
        expect(commands).toEqual([]);

        // Dispatch race: another turn starts after the snapshot read, caught by decider.ts.
        let readModel = {
          ...createEmptyReadModel(NOW),
          threads: [makeThread(threadAlpha, projectAlpha)],
        };
        const interveningCommand: OrchestrationCommand = {
          type: "thread.turn.start",
          commandId: CommandId.make("user-race-start"),
          threadId: threadAlpha,
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          createdAt: "2026-10-29T00:00:00.001Z",
          message: {
            messageId: MessageId.make("user-race-msg"),
            role: "user",
            text: "User message",
            attachments: [],
          },
        };
        const raceHarness = yield* makeHarness({
          beforeDispatch: (command) =>
            Effect.gen(function* () {
              if (command.type !== "thread.turn.start") return;
              const events = yield* decideOrchestrationCommand({
                command: interveningCommand,
                readModel,
              }).pipe(Effect.orDie);
              for (const event of Array.isArray(events) ? events : [events]) {
                const projected = yield* projectEvent(readModel, {
                  ...event,
                  sequence: readModel.snapshotSequence + 1,
                }).pipe(Effect.orDie);
                readModel = { ...projected, threads: [...projected.threads] };
              }
              yield* decideOrchestrationCommand({ command, readModel }).pipe(
                Effect.catchTag(
                  ["OrchestrationThreadSettleBlockedError", "PlatformError"],
                  Effect.die,
                ),
              );
            }).pipe(Effect.provide(NodeServices.layer)),
        });
        const raced = yield* raceHarness
          .call("oop_thread_send", { threadId: threadAlpha, message: "Raced send" }, scope)
          .pipe(Effect.flip);
        expect(raced.message).toContain("busy");
        expect(raceHarness.commands).toEqual([]);
      }),
  );

  it.effect(
    "dispatches thread.approval.respond and records activity on oop_thread_approve, enforcing guards and offered decisions",
    () =>
      Effect.gen(function* () {
        const { call, threads, commands } = yield* makeHarness();
        const approval = makeApprovalActivity(approvalReqId, {
          options: [
            { decision: "accept", label: "Approve" },
            { decision: "acceptAlways", label: "Always allow" },
            { decision: "decline", label: "Decline" },
          ],
        });
        threads.set(
          threadAlpha,
          makeThread(threadAlpha, projectAlpha, {
            runtimeMode: "auto-accept-edits",
            activities: [approval],
          }),
        );

        const result = yield* call(
          "oop_thread_approve",
          { threadId: threadAlpha, requestId: approvalReqId, decision: "accept" },
          clientScope("auto", "Remote Bot"),
        );
        expect(result).toEqual({
          threadId: threadAlpha,
          requestId: approvalReqId,
          decision: "accept",
        });

        expect(commands).toHaveLength(2);
        const [approvalCmd, activityCmd] = commands;
        expect(approvalCmd).toMatchObject({
          type: "thread.approval.respond",
          threadId: threadAlpha,
          requestId: approvalReqId,
          decision: "accept",
        });
        expect(activityCmd).toMatchObject({
          type: "thread.activity.append",
          threadId: threadAlpha,
          activity: {
            kind: "outside-agent.approval",
            tone: "info",
            summary: "Remote Bot answered an approval (accept) over MCP",
            payload: {
              sessionId: "mcp-session-1",
              clientLabel: "Remote Bot",
              requestId: approvalReqId,
              decision: "accept",
            },
            turnId: null,
          },
        });

        // Verify the dispatched command produces a valid decider event.
        if (approvalCmd?.type !== "thread.approval.respond") {
          throw new Error("Expected thread.approval.respond command");
        }
        const decided = yield* decideOrchestrationCommand({
          command: approvalCmd,
          readModel: {
            ...createEmptyReadModel(NOW),
            threads: [threads.get(threadAlpha)!],
          },
        }).pipe(Effect.provide(NodeServices.layer));
        expect(decided).toMatchObject({
          type: "thread.approval-response-requested",
          payload: {
            threadId: threadAlpha,
            requestId: approvalReqId,
            decision: "accept",
          },
        });

        // Refused for a decision the request does not offer.
        const unoffered = yield* call(
          "oop_thread_approve",
          { threadId: threadAlpha, requestId: approvalReqId, decision: "cancel" },
          clientScope("auto"),
        ).pipe(Effect.flip);
        expect(unoffered.message).toContain("accept, decline");

        // A request that widens the agent's permissions cannot be accepted from outside.
        const permissionReqId = ApprovalRequestId.make("approval-req-permission");
        threads.set(
          threadAlpha,
          makeThread(threadAlpha, projectAlpha, {
            activities: [
              approval,
              makeApprovalActivity(permissionReqId, { requestKind: "permission" }),
              makeQuestionActivity(),
            ],
          }),
        );
        const widened = yield* call(
          "oop_thread_approve",
          { threadId: threadAlpha, requestId: permissionReqId, decision: "accept" },
          clientScope("full-access"),
        ).pipe(Effect.flip);
        expect(widened.message).toContain("decline, cancel");

        // A question's request id is not an approval, and the other way round.
        const questionAsApproval = yield* call(
          "oop_thread_approve",
          { threadId: threadAlpha, requestId: questionReqId, decision: "accept" },
          clientScope("auto"),
        ).pipe(Effect.flip);
        expect(questionAsApproval.message).toBe("This approval is no longer pending.");
        const approvalAsQuestion = yield* call(
          "oop_thread_answer",
          { threadId: threadAlpha, requestId: approvalReqId, answers: { env: "Staging" } },
          clientScope("auto"),
        ).pipe(Effect.flip);
        expect(approvalAsQuestion.message).toBe("This question is no longer pending.");

        // Refused for read-only client.
        const readOnlyFailure = yield* call(
          "oop_thread_approve",
          { threadId: threadAlpha, requestId: approvalReqId, decision: "accept" },
          clientScope("read-only"),
        ).pipe(Effect.flip);
        expect(readOnlyFailure.message).toContain("read-only");

        // Refused when thread runtimeMode exceeds client ceiling.
        threads.set(
          threadAlpha,
          makeThread(threadAlpha, projectAlpha, {
            runtimeMode: "full-access",
            activities: [approval],
          }),
        );
        const ceilingFailure = yield* call(
          "oop_thread_approve",
          { threadId: threadAlpha, requestId: approvalReqId, decision: "accept" },
          clientScope("auto"),
        ).pipe(Effect.flip);
        expect(ceilingFailure.message).toBe(
          "This thread runs with more access than this MCP client was approved for.",
        );

        // Refused for crew member thread.
        threads.set(
          threadAlpha,
          makeThread(threadAlpha, projectAlpha, {
            parentThreadId: threadBeta,
            activities: [approval],
          }),
        );
        const crewFailure = yield* call(
          "oop_thread_approve",
          { threadId: threadAlpha, requestId: approvalReqId, decision: "accept" },
          clientScope("full-access"),
        ).pipe(Effect.flip);
        expect(crewFailure.message).toContain("crew member");

        // Refused when request is not pending (missing or resolved).
        threads.set(threadAlpha, makeThread(threadAlpha, projectAlpha, { activities: [] }));
        const notPending = yield* call(
          "oop_thread_approve",
          { threadId: threadAlpha, requestId: approvalReqId, decision: "accept" },
          clientScope("full-access"),
        ).pipe(Effect.flip);
        expect(notPending.message).toBe("This approval is no longer pending.");

        expect(commands).toHaveLength(2);
      }),
  );

  it.effect(
    "dispatches thread.user-input.respond in the web client's answers shape and validates answers on oop_thread_answer",
    () =>
      Effect.gen(function* () {
        const { call, threads, commands } = yield* makeHarness();
        const questionWithOptionValue = makeQuestionActivity(questionReqId, [
          {
            id: "env",
            header: "Environment",
            question: "Deploy to which env?",
            options: [
              { label: "Staging", description: "Deploy to staging first" },
              { label: "Production", description: "Deploy straight to prod" },
            ],
            multiSelect: false,
            allowCustomAnswer: false,
          },
          {
            id: "areas",
            header: "Areas",
            question: "Which areas should be checked?",
            options: [
              { label: "Server", description: "Backend tests" },
              { label: "Web", description: "Frontend tests" },
            ],
            multiSelect: true,
            allowCustomAnswer: true,
          },
          {
            id: "notes",
            header: "Notes",
            question: "Any release notes?",
            options: [],
            multiSelect: false,
            allowCustomAnswer: true,
          },
        ]);
        threads.set(
          threadAlpha,
          makeThread(threadAlpha, projectAlpha, {
            activities: [questionWithOptionValue],
          }),
        );

        const answered = yield* call(
          "oop_thread_answer",
          {
            threadId: threadAlpha,
            requestId: questionReqId,
            answers: {
              env: "Staging",
              areas: ["Server", "Web"],
              notes: "  Ready for rollout  ",
            },
          },
          clientScope("auto", "Remote Bot"),
        );
        expect(answered).toEqual({ threadId: threadAlpha, requestId: questionReqId });

        expect(commands).toHaveLength(2);
        const [respondCmd, activityCmd] = commands;
        expect(respondCmd).toMatchObject({
          type: "thread.user-input.respond",
          threadId: threadAlpha,
          requestId: questionReqId,
          answers: {
            env: "Staging",
            areas: ["Server", "Web"],
            notes: "Ready for rollout",
          },
        });
        expect("attachmentsByQuestionId" in respondCmd!).toBe(false);
        expect(activityCmd).toMatchObject({
          type: "thread.activity.append",
          threadId: threadAlpha,
          activity: {
            kind: "outside-agent.answer",
            tone: "info",
            summary: "Remote Bot answered a question over MCP",
            payload: {
              sessionId: "mcp-session-1",
              clientLabel: "Remote Bot",
              requestId: questionReqId,
            },
            turnId: null,
          },
        });

        // Missing answer.
        const missingAnswer = yield* call(
          "oop_thread_answer",
          {
            threadId: threadAlpha,
            requestId: questionReqId,
            answers: { env: "Staging", areas: ["Server"] },
          },
          clientScope("auto"),
        ).pipe(Effect.flip);
        expect(missingAnswer.message).toContain('Missing answer for question "notes"');

        // Unknown question id.
        const unknownId = yield* call(
          "oop_thread_answer",
          {
            threadId: threadAlpha,
            requestId: questionReqId,
            answers: { env: "Staging", areas: ["Server"], notes: "ok", extra: "bad" },
          },
          clientScope("auto"),
        ).pipe(Effect.flip);
        expect(unknownId.message).toContain('Unknown question id "extra"');

        // Array for a non-multiSelect question.
        const arrayOnSingle = yield* call(
          "oop_thread_answer",
          {
            threadId: threadAlpha,
            requestId: questionReqId,
            answers: { env: ["Staging"], areas: ["Server"], notes: "ok" },
          },
          clientScope("auto"),
        ).pipe(Effect.flip);
        expect(arrayOnSingle.message).toContain("does not accept multiple answers");

        // Empty answer (whitespace string and empty array).
        const emptyString = yield* call(
          "oop_thread_answer",
          {
            threadId: threadAlpha,
            requestId: questionReqId,
            answers: { env: "Staging", areas: ["Server"], notes: "   " },
          },
          clientScope("auto"),
        ).pipe(Effect.flip);
        expect(emptyString.message).toContain("cannot be empty");

        const emptyArray = yield* call(
          "oop_thread_answer",
          {
            threadId: threadAlpha,
            requestId: questionReqId,
            answers: { env: "Staging", areas: [], notes: "ok" },
          },
          clientScope("auto"),
        ).pipe(Effect.flip);
        expect(emptyArray.message).toContain("cannot be empty");

        // An array carries listed options only; an own answer is a single string.
        const offListInArray = yield* call(
          "oop_thread_answer",
          {
            threadId: threadAlpha,
            requestId: questionReqId,
            answers: { env: "Staging", areas: ["Server", "Docs"], notes: "ok" },
          },
          clientScope("auto"),
        ).pipe(Effect.flip);
        expect(offListInArray.message).toContain(
          '"Docs" for question "areas" is not a listed option',
        );

        // Off-list value when allowCustomAnswer is false.
        const offList = yield* call(
          "oop_thread_answer",
          {
            threadId: threadAlpha,
            requestId: questionReqId,
            answers: { env: "Canary", areas: ["Server"], notes: "ok" },
          },
          clientScope("auto"),
        ).pipe(Effect.flip);
        expect(offList.message).toContain("must match one of the listed options");

        // Request no longer pending.
        const notPending = yield* call(
          "oop_thread_answer",
          {
            threadId: threadAlpha,
            requestId: ApprovalRequestId.make("missing-question"),
            answers: { env: "Staging" },
          },
          clientScope("auto"),
        ).pipe(Effect.flip);
        expect(notPending.message).toBe("This question is no longer pending.");

        // Decider user-facing invariant error detail is forwarded cleanly.
        const racedHarness = yield* makeHarness({
          beforeDispatch: (command) =>
            command.type === "thread.user-input.respond"
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "This question has already been answered.",
                  }),
                )
              : Effect.void,
        });
        racedHarness.threads.set(
          threadAlpha,
          makeThread(threadAlpha, projectAlpha, {
            activities: [questionWithOptionValue],
          }),
        );
        const alreadyAnswered = yield* racedHarness
          .call(
            "oop_thread_answer",
            {
              threadId: threadAlpha,
              requestId: questionReqId,
              answers: { env: "Staging", areas: ["Server"], notes: "ok" },
            },
            clientScope("auto"),
          )
          .pipe(Effect.flip);
        expect(alreadyAnswered.message).toBe("This question has already been answered.");

        expect(commands).toHaveLength(2);
      }),
  );

  it.effect(
    "dispatches thread.turn.interrupt without turnId on running or waiting threads and refuses idle or read-only calls",
    () =>
      Effect.gen(function* () {
        const { call, threads, commands, shellOverrides } = yield* makeHarness();

        // Refused on idle thread with no open requests.
        const idleFailure = yield* call(
          "oop_thread_interrupt",
          { threadId: threadAlpha },
          clientScope("auto"),
        ).pipe(Effect.flip);
        expect(idleFailure.message).toBe("The thread is not running.");

        // Running thread happy path.
        threads.set(
          threadAlpha,
          makeThread(threadAlpha, projectAlpha, {
            session: makeSession(threadAlpha, "running"),
          }),
        );

        // Refused for read-only client.
        const readOnlyFailure = yield* call(
          "oop_thread_interrupt",
          { threadId: threadAlpha },
          clientScope("read-only"),
        ).pipe(Effect.flip);
        expect(readOnlyFailure.message).toBe(
          "This tool changes the environment, and this MCP client was approved for read-only access.",
        );

        const interrupted = yield* call(
          "oop_thread_interrupt",
          { threadId: threadAlpha },
          clientScope("auto", "Remote Bot"),
        );
        expect(interrupted).toEqual({ threadId: threadAlpha });

        expect(commands).toHaveLength(2);
        const [interruptCmd, activityCmd] = commands;
        expect(interruptCmd).toMatchObject({
          type: "thread.turn.interrupt",
          threadId: threadAlpha,
        });
        expect("turnId" in interruptCmd!).toBe(false);
        expect(activityCmd).toMatchObject({
          type: "thread.activity.append",
          threadId: threadAlpha,
          activity: {
            kind: "outside-agent.interrupt",
            tone: "info",
            summary: "Remote Bot interrupted the turn over MCP",
            payload: {
              sessionId: "mcp-session-1",
              clientLabel: "Remote Bot",
            },
            turnId: null,
          },
        });

        // Allowed when thread is not running but has an open request.
        threads.set(
          threadAlpha,
          makeThread(threadAlpha, projectAlpha, {
            activities: [makeApprovalActivity()],
          }),
        );
        const interruptedWaiting = yield* call(
          "oop_thread_interrupt",
          { threadId: threadAlpha },
          clientScope("auto"),
        );
        expect(interruptedWaiting).toEqual({ threadId: threadAlpha });
        expect(commands).toHaveLength(4);

        // Allowed when only the thread list reports it as waiting, so it is never stuck.
        threads.set(threadAlpha, makeThread(threadAlpha, projectAlpha));
        shellOverrides.set(threadAlpha, { hasPendingUserInput: true });
        const interruptedStuck = yield* call(
          "oop_thread_interrupt",
          { threadId: threadAlpha },
          clientScope("auto"),
        );
        expect(interruptedStuck).toEqual({ threadId: threadAlpha });
        expect(commands).toHaveLength(6);
      }),
  );

  it.effect(
    "registers all eight tools via OutsideToolkitRegistrationLive with annotations and schema bounds",
    () =>
      Effect.gen(function* () {
        const serverClient = McpSchema.McpServerClient.of({
          clientId: 1,
          clientCapabilities: {},
          clientInfo: { name: "mcp-outside-test", version: "1.0.0" },
          protocolVersion: "2025-06-18",
          initializePayload: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "mcp-outside-test", version: "1.0.0" },
          },
          getClient: Effect.die("unused"),
        });
        const server = yield* McpServer.McpServer;
        const names = server.tools.map(({ tool }) => tool.name);
        expect(names).toEqual([
          "oop_project_list",
          "oop_thread_list",
          "oop_thread_read",
          "oop_thread_start",
          "oop_thread_send",
          "oop_thread_approve",
          "oop_thread_answer",
          "oop_thread_interrupt",
        ]);

        for (const readName of ["oop_project_list", "oop_thread_list", "oop_thread_read"]) {
          const entry = server.tools.find(({ tool }) => tool.name === readName);
          expect(entry?.tool.annotations?.readOnlyHint).toBe(true);
          expect(entry?.tool.annotations?.destructiveHint).toBe(false);
          expect(entry?.tool.annotations?.idempotentHint).toBe(true);
          expect(entry?.tool.annotations?.openWorldHint).toBe(false);
        }
        for (const writeName of [
          "oop_thread_start",
          "oop_thread_send",
          "oop_thread_approve",
          "oop_thread_answer",
        ]) {
          const entry = server.tools.find(({ tool }) => tool.name === writeName);
          expect(entry?.tool.annotations?.readOnlyHint).toBe(false);
          expect(entry?.tool.annotations?.destructiveHint).toBe(false);
          expect(entry?.tool.annotations?.idempotentHint).toBe(false);
          expect(entry?.tool.annotations?.openWorldHint).toBe(false);
        }
        const interruptEntry = server.tools.find(
          ({ tool }) => tool.name === "oop_thread_interrupt",
        );
        expect(interruptEntry?.tool.annotations?.readOnlyHint).toBe(false);
        expect(interruptEntry?.tool.annotations?.destructiveHint).toBe(true);
        expect(interruptEntry?.tool.annotations?.idempotentHint).toBe(false);
        expect(interruptEntry?.tool.annotations?.openWorldHint).toBe(false);

        const ok = yield* server
          .callTool({ name: "oop_project_list", arguments: {} })
          .pipe(
            Effect.provideService(McpInvocationContext, clientScope("read-only")),
            Effect.provideService(McpSchema.McpServerClient, serverClient),
          );
        expect(ok.isError).toBe(false);
        expect(ok.structuredContent).toEqual({
          projects: [{ id: projectAlpha, title: "Alpha", workspaceRoot: "/work/alpha" }],
        });

        const refused = yield* server
          .callTool({ name: "oop_project_list", arguments: {} })
          .pipe(
            Effect.provideService(McpInvocationContext, threadScope()),
            Effect.provideService(McpSchema.McpServerClient, serverClient),
          );
        expect(refused.isError).toBe(true);
        const [firstBlock] = refused.content;
        expect(firstBlock?.type === "text" ? firstBlock.text : "").toContain("list_threads");

        for (const badLimit of [0, 101]) {
          const invalid = yield* server
            .callTool({
              name: "oop_thread_list",
              arguments: { allProjects: true, limit: badLimit },
            })
            .pipe(
              Effect.provideService(McpInvocationContext, clientScope("read-only")),
              Effect.provideService(McpSchema.McpServerClient, serverClient),
              Effect.flip,
            );
          expect(invalid._tag).toBe("InvalidParams");
        }

        for (const lastingDecision of ["acceptForSession", "acceptAlways"]) {
          const invalidDecision = yield* server
            .callTool({
              name: "oop_thread_approve",
              arguments: {
                threadId: threadAlpha,
                requestId: approvalReqId,
                decision: lastingDecision,
              },
            })
            .pipe(
              Effect.provideService(McpInvocationContext, clientScope("full-access")),
              Effect.provideService(McpSchema.McpServerClient, serverClient),
              Effect.flip,
            );
          expect(invalidDecision._tag).toBe("InvalidParams");
        }
      }).pipe(
        Effect.provide(
          McpHttpServer.OutsideToolkitRegistrationLive.pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ProjectionSnapshotQuery)({
                  getProjectShells: () =>
                    Effect.succeed([
                      makeProject(projectAlpha, { title: "Alpha", workspaceRoot: "/work/alpha" }),
                    ]),
                }),
                Layer.mock(OrchestrationEngineService)({}),
                Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
                Layer.mock(ServerSettingsService)({
                  getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
                }),
                SqlitePersistenceMemory,
              ),
            ),
          ),
        ),
      ),
  );
});
