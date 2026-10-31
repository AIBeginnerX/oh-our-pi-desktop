import {
  MessageId,
  OrchestrationEvent,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
  type OrchestrationMessage,
  type ServerConfig,
} from "@t3tools/contracts";
import type { OrchestrationThreadStreamItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const T0 = "2026-10-30T09:00:00.000Z";

const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);
const decodeThreadShell = Schema.decodeUnknownSync(OrchestrationThreadShell);
const decodeProjectShell = Schema.decodeUnknownSync(OrchestrationProjectShell);
const decodeSnapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot);
const decodeActivity = Schema.decodeUnknownSync(OrchestrationThreadActivity);

const threadBase = {
  id: "thread-1",
  projectId: "project-1",
  title: "테스트 스레드",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: T0,
  updatedAt: T0,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
  deletedAt: null,
};

export const makeThread = (over: Record<string, unknown> = {}): OrchestrationThread =>
  decodeThread({ ...threadBase, ...over });

export const makeThreadShell = (over: Record<string, unknown> = {}): OrchestrationThreadShell => {
  const {
    messages: _m,
    proposedPlans: _p,
    activities: _a,
    checkpoints: _c,
    deletedAt: _d,
    ...shell
  } = threadBase;
  return decodeThreadShell({
    ...shell,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...over,
  });
};

export const makeProject = (over: Record<string, unknown> = {}): OrchestrationProjectShell =>
  decodeProjectShell({
    id: "project-1",
    title: "내 프로젝트",
    workspaceRoot: "/work/app",
    defaultModelSelection: null,
    scripts: [],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  });

export const makeSnapshot = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<OrchestrationThreadShell>,
  snapshotSequence = 1,
) => decodeSnapshot({ snapshotSequence, projects, threads, updatedAt: T0 });

export const makeMessage = (
  over: Partial<Omit<OrchestrationMessage, "id">> & { id: string },
): OrchestrationMessage => ({
  role: "assistant",
  text: "",
  turnId: null,
  streaming: false,
  createdAt: T0,
  updatedAt: T0,
  ...over,
  id: MessageId.make(over.id),
});

export const makeActivity = (over: {
  id: string;
  kind: string;
  tone?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  turnId?: string;
  createdAt?: string;
}) =>
  decodeActivity({
    tone: "tool",
    summary: "활동",
    payload: {},
    turnId: null,
    createdAt: T0,
    ...over,
  });

/** A config with just the fields the app reads. */
export const makeConfig = (over: Record<string, unknown> = {}): ServerConfig =>
  ({
    environment: {
      serverVersion: "0.0.127",
      capabilities: { threadPinning: true, threadPinReorder: true },
    },
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        models: [
          { slug: "gpt-5", name: "GPT-5", isCustom: false, isDefault: true, capabilities: null },
          { slug: "gpt-5-mini", name: "GPT-5 mini", isCustom: false, capabilities: null },
        ],
      },
    ],
    threadSnapshotPagination: true,
    ...over,
  }) as unknown as ServerConfig;

export const makeSession = (status: string, over: Record<string, unknown> = {}) => ({
  threadId: "thread-1",
  status,
  providerName: "codex",
  activeTurnId: null,
  lastError: null,
  updatedAt: T0,
  ...over,
});

export const approvalRequested = (requestId: string, detail = "ls -la") =>
  makeActivity({
    id: `req-${requestId}`,
    kind: "approval.requested",
    tone: "approval",
    summary: "승인 요청",
    payload: { requestId, requestKind: "command", detail },
  });

const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);

const eventBase = (sequence: number, threadId: string) => ({
  sequence,
  eventId: `evt-${sequence}`,
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: T0,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

export const messageSentEvent = (
  sequence: number,
  over: { messageId: string; text: string; streaming?: boolean; role?: string; threadId?: string },
): OrchestrationThreadStreamItem => {
  const threadId = over.threadId ?? "thread-1";
  return {
    kind: "event",
    event: decodeEvent({
      ...eventBase(sequence, threadId),
      type: "thread.message-sent",
      payload: {
        threadId,
        messageId: over.messageId,
        role: over.role ?? "assistant",
        text: over.text,
        turnId: null,
        streaming: over.streaming ?? false,
        createdAt: T0,
        updatedAt: T0,
      },
    }),
  };
};

export const threadDeletedEvent = (
  sequence: number,
  threadId = "thread-1",
): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: decodeEvent({
    ...eventBase(sequence, threadId),
    type: "thread.deleted",
    payload: { threadId, deletedAt: T0 },
  }),
});

export const threadSnapshotItem = (
  thread: OrchestrationThread,
  snapshotSequence: number,
  hasMore?: boolean,
): OrchestrationThreadStreamItem => ({
  kind: "snapshot",
  snapshot: {
    snapshotSequence,
    thread,
    ...(hasMore === undefined
      ? {}
      : { page: { beforeCursor: hasMore ? "cursor" : null, hasMore, snapshotSequence } }),
  },
});
