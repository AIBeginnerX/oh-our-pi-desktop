// @effect-diagnostics nodeBuiltinImport:off - the integration exercises real ingestion and a file database.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type RuntimeTaskUsage,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "../bin.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { layer as restartContinuationsLayer } from "../restartContinuations.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

import { OwnedUsageReader, OwnedUsageReaderLive, reduceOwnedThreadUsage } from "./ownedUsage.ts";
import {
  OWNED_USAGE_ACTIVITY_KIND,
  type OwnedThreadUsageOutcome,
  type OwnedTurnUsageObservationV1,
  type OwnedUsageSourceV1,
} from "./ownedUsage.schema.ts";

const at = "2026-01-01T00:00:00.000Z";
const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const instanceA = ProviderInstanceId.make("codex-a");
const instanceB = ProviderInstanceId.make("codex-b");
const reportThreadId = ThreadId.make("thread-owned");
const projectId = ProjectId.make("project-owned");

type CreatedEvent = Extract<OrchestrationEvent, { type: "thread.created" }>;
type ActivityAppendedEvent = Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;
type SessionSetEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;

const completeUsage = (
  overrides: Partial<Extract<TurnTokenUsage, { usageStatus: "complete" }>> = {},
): TurnTokenUsage => ({
  usageScope: "main_agent",
  usageStatus: "complete",
  inputTokens: 1000,
  outputTokens: 200,
  hasSubagents: false,
  ...overrides,
});

const partialUsage = (): TurnTokenUsage => ({
  usageScope: "main_agent",
  usageStatus: "partial",
  inputTokens: 100,
  hasSubagents: false,
});

const unavailableUsage = (): TurnTokenUsage => ({
  usageScope: "main_agent",
  usageStatus: "unavailable",
  hasSubagents: false,
});

let runtimeEventCounter = 0;
const observation = (
  overrides: {
    driver?: typeof codex | typeof claude;
    instanceId?: ProviderInstanceId | null;
    turnId?: string | null;
    runtimeEventId?: string;
    nativeConversationId?: string | null;
    usage?: TurnTokenUsage;
    terminal?: OwnedTurnUsageObservationV1["terminal"];
  } = {},
): OwnedTurnUsageObservationV1 => {
  runtimeEventCounter += 1;
  return {
    v: 1,
    scope: "main-turn",
    source: {
      driver: overrides.driver ?? codex,
      instanceId: overrides.instanceId === undefined ? instanceA : overrides.instanceId,
      turnId:
        overrides.turnId === undefined
          ? TurnId.make(`turn-${runtimeEventCounter}`)
          : overrides.turnId === null
            ? null
            : TurnId.make(overrides.turnId),
      runtimeEventId: EventId.make(overrides.runtimeEventId ?? `rt-${runtimeEventCounter}`),
      nativeConversationId:
        overrides.nativeConversationId === undefined ? "conv-1" : overrides.nativeConversationId,
    },
    terminal: overrides.terminal ?? "completed",
    usage: overrides.usage ?? completeUsage(),
  };
};

const base = (sequence: number, eventId: string) => ({
  sequence,
  eventId: EventId.make(eventId),
  aggregateKind: "thread" as const,
  aggregateId: reportThreadId,
  occurredAt: at,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

const createdEvent = (sequence: number): CreatedEvent => ({
  ...base(sequence, `evt-created-${sequence}`),
  type: "thread.created",
  payload: {
    threadId: reportThreadId,
    projectId,
    title: "Owned usage",
    modelSelection: { instanceId: instanceA, model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: at,
    updatedAt: at,
  },
});

const rawActivityEvent = (
  sequence: number,
  kind: string,
  payload: unknown,
): ActivityAppendedEvent => ({
  ...base(sequence, `evt-activity-${sequence}`),
  type: "thread.activity-appended",
  payload: {
    threadId: reportThreadId,
    activity: {
      id: EventId.make(`activity-${sequence}`),
      tone: "info",
      kind,
      summary: "Recorded",
      payload,
      turnId: null,
      createdAt: at,
    },
  },
});

const ownedUsageEvent = (
  sequence: number,
  payload: OwnedTurnUsageObservationV1,
  activityId = `owned-usage:thread:rt-${sequence}`,
): ActivityAppendedEvent => ({
  ...base(sequence, `evt-activity-${sequence}`),
  type: "thread.activity-appended",
  payload: {
    threadId: reportThreadId,
    activity: {
      id: EventId.make(activityId),
      tone: "info",
      kind: OWNED_USAGE_ACTIVITY_KIND,
      summary: "Turn usage observed",
      payload,
      turnId: null,
      createdAt: at,
    },
  },
});

const childSource = (input: {
  runtimeEventId: string;
  phase: OwnedUsageSourceV1["phase"];
  instanceId?: ProviderInstanceId | null;
}): OwnedUsageSourceV1 => ({
  v: 1,
  driver: codex,
  instanceId: input.instanceId === undefined ? instanceA : input.instanceId,
  runtimeEventId: EventId.make(input.runtimeEventId),
  phase: input.phase,
});

const childUsageEvent = (input: {
  sequence: number;
  kind: "task.progress" | "task.completed";
  taskId: string;
  usage: RuntimeTaskUsage;
  source?: OwnedUsageSourceV1;
}): ActivityAppendedEvent => ({
  ...base(input.sequence, `evt-child-${input.sequence}`),
  type: "thread.activity-appended",
  payload: {
    threadId: reportThreadId,
    activity: {
      id: EventId.make(`task-usage:${input.sequence}`),
      tone: "info",
      kind: input.kind,
      summary: "Task usage updated",
      payload: {
        taskId: input.taskId,
        typedUsage: input.usage,
        ...(input.source === undefined ? {} : { usageSource: input.source }),
      },
      turnId: null,
      createdAt: at,
    },
  },
});
const sessionSetEvent = (input: {
  sequence: number;
  providerName?: string | null;
  providerInstanceId?: ProviderInstanceId | null;
  activeTurnId?: string | null;
}): SessionSetEvent => ({
  ...base(input.sequence, `evt-session-${input.sequence}`),
  type: "thread.session-set",
  payload: {
    threadId: reportThreadId,
    session: {
      threadId: reportThreadId,
      status: "ready",
      providerName: input.providerName === undefined ? "codex" : input.providerName,
      ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
      runtimeMode: "full-access",
      activeTurnId:
        input.activeTurnId === undefined || input.activeTurnId === null
          ? null
          : TurnId.make(input.activeTurnId),
      lastError: null,
      updatedAt: at,
    },
  },
});

const reduce = (events: ReadonlyArray<OrchestrationEvent>, head = 100) =>
  reduceOwnedThreadUsage({ threadId: reportThreadId, head, events });

/**
 * Discriminated guard for the retained activity rows the reader consumes, so
 * filtered history keeps the narrowed event type instead of degrading back to
 * the full union before `payload.activity` access.
 */
const isOwnedUsageActivityEvent = (
  event: OrchestrationEvent,
): event is Extract<OrchestrationEvent, { readonly type: "thread.activity-appended" }> =>
  event.type === "thread.activity-appended" &&
  event.payload.activity.kind === OWNED_USAGE_ACTIVITY_KIND;

const reduceOk = (events: ReadonlyArray<OrchestrationEvent>) => {
  const outcome = reduce(events);
  if (outcome.status !== "ok") throw new Error(`expected ok, got ${outcome.status}`);
  return outcome.report;
};

describe("reduceOwnedThreadUsage", () => {
  it("folds an identical redelivery of one scoped delivery into a single counted observation", () => {
    const delivered = observation({ runtimeEventId: "rt-1", turnId: "turn-a" });
    const report = reduceOk([
      createdEvent(1),
      ownedUsageEvent(2, delivered),
      // Same activity id and payload the projection would fold away; history
      // keeps both rows and the reader must fold them instead of double-counting.
      ownedUsageEvent(3, delivered, "owned-usage:thread:rt-1"),
    ]);

    expect(report.main.complete).toBe(1);
    expect(report.main.duplicateDeliveryCount).toBe(1);
    expect(report.main.conflicts).toEqual([]);
    expect(report.main.buckets).toHaveLength(1);
    expect(report.main.buckets[0]?.scope).toEqual({
      driver: "codex",
      instanceId: "codex-a",
      nativeConversationId: "conv-1",
    });
    expect(report.main.buckets[0]?.reportedCompleteSubtotal).toEqual({
      completeTurns: 1,
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: { sum: 0, reportedTurns: 0 },
      cacheCreationTokens: { sum: 0, reportedTurns: 0 },
      reasoningTokens: { sum: 0, reportedTurns: 0 },
    });
  });

  it("keeps a same-delivery payload that moved its turn and conversation as a conflict", () => {
    const first = observation({
      runtimeEventId: "rt-1",
      turnId: "turn-a",
      nativeConversationId: "conv-1",
    });
    // Same driver/instance/runtimeEventId but a different turn and conversation:
    // grouping by turn first would let this payload evade conflict detection.
    const moved = observation({
      runtimeEventId: "rt-1",
      turnId: "turn-b",
      nativeConversationId: "conv-2",
      usage: completeUsage({ inputTokens: 999 }),
    });
    const report = reduceOk([
      createdEvent(1),
      ownedUsageEvent(2, first),
      ownedUsageEvent(3, moved, "owned-usage:thread:rt-1"),
    ]);

    expect(report.main.conflict).toBe(1);
    expect(report.main.conflicts[0]?.delivery).toEqual({
      driver: "codex",
      instanceId: "codex-a",
      runtimeEventId: "rt-1",
    });
    expect(report.main.conflicts[0]?.alternatives).toHaveLength(2);
    expect(report.main.buckets).toEqual([]);
    expect(report.main.complete).toBe(0);
    expect(report.main.ambiguousTurns).toEqual([]);
  });

  it("taints every turn a conflicted delivery claims while clean unrelated turns still contribute", () => {
    const variantA = observation({
      runtimeEventId: "rt-1",
      turnId: "turn-a",
      nativeConversationId: "conv-1",
    });
    const variantB = observation({
      runtimeEventId: "rt-1",
      turnId: "turn-b",
      nativeConversationId: "conv-2",
    });
    const cleanA = observation({
      runtimeEventId: "rt-2",
      turnId: "turn-a",
      nativeConversationId: "conv-1",
      usage: completeUsage({ inputTokens: 4000 }),
    });
    const cleanB = observation({
      runtimeEventId: "rt-3",
      turnId: "turn-b",
      nativeConversationId: "conv-2",
      usage: completeUsage({ inputTokens: 5000 }),
    });
    const unrelated = observation({
      runtimeEventId: "rt-4",
      turnId: "turn-z",
      nativeConversationId: "conv-1",
      usage: completeUsage({ inputTokens: 300, outputTokens: 40 }),
    });
    const report = reduceOk([
      createdEvent(1),
      ownedUsageEvent(2, variantA),
      ownedUsageEvent(3, variantB, "owned-usage:thread:rt-1"),
      ownedUsageEvent(4, cleanA),
      ownedUsageEvent(5, cleanB),
      ownedUsageEvent(6, unrelated),
    ]);

    expect(report.main.conflict).toBe(1);
    // Both moved destinations are tainted: neither clean sibling may contribute.
    expect(report.main.complete).toBe(1);
    expect(report.main.ambiguous).toBe(2);
    expect(report.main.ambiguousTurns.map((entry) => entry.turnId).toSorted()).toEqual([
      "turn-a",
      "turn-b",
    ]);
    const conv1 = report.main.buckets.find(
      (bucket) => bucket.scope.nativeConversationId === "conv-1",
    );
    const conv2 = report.main.buckets.find(
      (bucket) => bucket.scope.nativeConversationId === "conv-2",
    );
    // Only the unrelated turn is numerically covered; the tainted turns' clean
    // deliveries stay inspectable and nonnumeric.
    expect(conv1?.reportedCompleteSubtotal).toEqual({
      completeTurns: 1,
      inputTokens: 300,
      outputTokens: 40,
      cachedInputTokens: { sum: 0, reportedTurns: 0 },
      cacheCreationTokens: { sum: 0, reportedTurns: 0 },
      reasoningTokens: { sum: 0, reportedTurns: 0 },
    });
    expect(conv2?.reportedCompleteSubtotal.completeTurns).toBe(0);
  });

  it("counts two separate genuine turns sharing one bucket vector", () => {
    const first = observation({ runtimeEventId: "rt-1", turnId: "turn-a", usage: completeUsage() });
    const second = observation({
      runtimeEventId: "rt-2",
      turnId: "turn-b",
      usage: completeUsage({
        inputTokens: 1100,
        outputTokens: 300,
        cachedInputTokens: 40,
        cacheCreationTokens: 25,
        reasoningTokens: 15,
      }),
    });
    const report = reduceOk([
      createdEvent(1),
      ownedUsageEvent(2, first),
      ownedUsageEvent(3, second),
    ]);

    expect(report.main.complete).toBe(2);
    expect(report.main.buckets).toHaveLength(1);
    expect(report.main.buckets[0]?.reportedCompleteSubtotal).toEqual({
      completeTurns: 2,
      inputTokens: 2100,
      outputTokens: 500,
      cachedInputTokens: { sum: 40, reportedTurns: 1 },
      cacheCreationTokens: { sum: 25, reportedTurns: 1 },
      reasoningTokens: { sum: 15, reportedTurns: 1 },
    });
  });

  it("reports one bucket per source scope and never a grand total", () => {
    const throughA = observation({
      runtimeEventId: "rt-1",
      turnId: "turn-a",
      instanceId: instanceA,
    });
    const throughB = observation({
      runtimeEventId: "rt-2",
      turnId: "turn-a",
      instanceId: instanceB,
      usage: completeUsage({ inputTokens: 1100 }),
    });
    const claudeTurn = observation({
      driver: claude,
      instanceId: instanceA,
      runtimeEventId: "rt-3",
      turnId: "turn-c",
      nativeConversationId: null,
      usage: completeUsage({ inputTokens: 500, outputTokens: 90 }),
    });
    const report = reduceOk([
      createdEvent(1),
      ownedUsageEvent(2, throughA),
      ownedUsageEvent(3, throughB),
      ownedUsageEvent(4, claudeTurn),
    ]);

    expect(report.main.buckets).toEqual([
      {
        scope: { driver: "codex", instanceId: "codex-a", nativeConversationId: "conv-1" },
        reportedCompleteSubtotal: {
          completeTurns: 1,
          inputTokens: 1000,
          outputTokens: 200,
          cachedInputTokens: { sum: 0, reportedTurns: 0 },
          cacheCreationTokens: { sum: 0, reportedTurns: 0 },
          reasoningTokens: { sum: 0, reportedTurns: 0 },
        },
      },
      {
        scope: { driver: "codex", instanceId: "codex-b", nativeConversationId: "conv-1" },
        reportedCompleteSubtotal: {
          completeTurns: 1,
          inputTokens: 1100,
          outputTokens: 200,
          cachedInputTokens: { sum: 0, reportedTurns: 0 },
          cacheCreationTokens: { sum: 0, reportedTurns: 0 },
          reasoningTokens: { sum: 0, reportedTurns: 0 },
        },
      },
      {
        scope: { driver: "claudeAgent", instanceId: "codex-a", nativeConversationId: null },
        reportedCompleteSubtotal: {
          completeTurns: 1,
          inputTokens: 500,
          outputTokens: 90,
          cachedInputTokens: { sum: 0, reportedTurns: 0 },
          cacheCreationTokens: { sum: 0, reportedTurns: 0 },
          reasoningTokens: { sum: 0, reportedTurns: 0 },
        },
      },
    ]);
    // No field anywhere aggregates across buckets or across main and children.
    expect(Object.keys(report.main).toSorted()).toEqual(
      [
        "ambiguous",
        "ambiguousTurns",
        "buckets",
        "complete",
        "conflict",
        "conflicts",
        "duplicateDeliveryCount",
        "invalid",
        "partial",
        "partialTurns",
        "priorIncarnation",
        "unavailable",
        "unrecorded",
        "unscoped",
      ].toSorted(),
    );
    expect(Object.keys(report).toSorted()).toEqual(
      [
        "children",
        "incarnationSequence",
        "legacyChildFrames",
        "main",
        "parentChildOverlap",
        "readThroughSequence",
        "threadId",
        "v",
      ].toSorted(),
    );
    expect(report.parentChildOverlap).toBe("unknown");
  });

  it("keeps missing identity and a null codex conversation unscoped instead of bucketed", () => {
    const noConversation = observation({
      runtimeEventId: "rt-1",
      turnId: "turn-a",
      nativeConversationId: null,
    });
    const noTurn = observation({ runtimeEventId: "rt-2", turnId: null });
    const noInstance = observation({ runtimeEventId: "rt-3", turnId: "turn-c", instanceId: null });
    const report = reduceOk([
      createdEvent(1),
      ownedUsageEvent(2, noConversation),
      ownedUsageEvent(3, noTurn),
      ownedUsageEvent(4, noInstance),
    ]);

    expect(report.main.unscoped).toBe(3);
    expect(report.main.buckets).toEqual([]);
    expect(report.main.complete).toBe(0);
  });

  it("preserves both alternatives of one logical turn, including a late unavailable", () => {
    const first = observation({ runtimeEventId: "rt-1", turnId: "turn-a", usage: completeUsage() });
    const late = observation({
      runtimeEventId: "rt-2",
      turnId: "turn-a",
      terminal: "failed",
      usage: unavailableUsage(),
    });
    const report = reduceOk([createdEvent(1), ownedUsageEvent(2, first), ownedUsageEvent(3, late)]);

    expect(report.main.ambiguous).toBe(1);
    expect(report.main.ambiguousTurns[0]?.alternatives).toHaveLength(2);
    expect(report.main.ambiguousTurns[0]?.alternatives[1]?.usage).toEqual(unavailableUsage());
    // The ambiguous pair contributes no number in either direction.
    expect(report.main.complete).toBe(0);
    expect(report.main.unavailable).toBe(0);
    expect(report.main.buckets[0]?.reportedCompleteSubtotal.completeTurns).toBe(0);
  });

  it("keeps partial turns outside the subtotal without reading absent fields as zero", () => {
    const partial = observation({
      runtimeEventId: "rt-1",
      turnId: "turn-a",
      usage: partialUsage(),
    });
    const complete = observation({
      runtimeEventId: "rt-2",
      turnId: "turn-b",
      usage: completeUsage({ inputTokens: 700, outputTokens: 150 }),
    });
    const report = reduceOk([
      createdEvent(1),
      ownedUsageEvent(2, partial),
      ownedUsageEvent(3, complete),
    ]);

    expect(report.main.partial).toBe(1);
    expect(report.main.partialTurns).toHaveLength(1);
    // The partial usage is kept verbatim: the absent outputTokens stay absent.
    expect(report.main.partialTurns[0]?.usage).toEqual({
      usageScope: "main_agent",
      usageStatus: "partial",
      inputTokens: 100,
      hasSubagents: false,
    });
    expect(report.main.complete).toBe(1);
    // The complete turn reported no cache dimensions: zero sum AND zero
    // reported turns, never a silent zero-read.
    expect(report.main.buckets[0]?.reportedCompleteSubtotal).toEqual({
      completeTurns: 1,
      inputTokens: 700,
      outputTokens: 150,
      cachedInputTokens: { sum: 0, reportedTurns: 0 },
      cacheCreationTokens: { sum: 0, reportedTurns: 0 },
      reasoningTokens: { sum: 0, reportedTurns: 0 },
    });
  });

  it("counts only history after the last thread.created and keeps prior coverage separate", () => {
    // Same logical turn claim before and after the second creation: only the
    // post-incarnation delivery may enter the current bucket, so a boundary
    // bug would double the count or the tokens.
    const reusedUsage = completeUsage({ inputTokens: 750, outputTokens: 90 });
    const priorObservation = observation({
      runtimeEventId: "rt-pre",
      turnId: "turn-same",
      usage: reusedUsage,
    });
    const currentObservation = observation({
      runtimeEventId: "rt-post",
      turnId: "turn-same",
      usage: reusedUsage,
    });
    const report = reduceOk([
      createdEvent(1),
      ownedUsageEvent(2, priorObservation),
      rawActivityEvent(3, "task.progress", {
        taskId: "agent-old",
        typedUsage: { totalTokens: 10 },
      }),
      createdEvent(4),
      ownedUsageEvent(5, currentObservation),
      childUsageEvent({
        sequence: 6,
        kind: "task.progress",
        taskId: "agent-new",
        usage: { totalTokens: 20 },
        source: childSource({ runtimeEventId: "rt-child", phase: "progress" }),
      }),
      rawActivityEvent(7, "task.progress", {
        taskId: "agent-legacy",
        typedUsage: { totalTokens: 30 },
      }),
    ]);

    expect(report.incarnationSequence).toBe(4);
    // One pre-incarnation observation delivery plus one pre-incarnation legacy
    // usage row, each counted once.
    expect(report.main.priorIncarnation).toBe(2);
    // The reused claim counts once, at the current incarnation's tokens only.
    expect(report.main.complete).toBe(1);
    expect(report.main.buckets[0]?.reportedCompleteSubtotal).toEqual({
      completeTurns: 1,
      inputTokens: 750,
      outputTokens: 90,
      cachedInputTokens: { sum: 0, reportedTurns: 0 },
      cacheCreationTokens: { sum: 0, reportedTurns: 0 },
      reasoningTokens: { sum: 0, reportedTurns: 0 },
    });
    expect(report.legacyChildFrames).toBe(1);
    expect(report.children).toHaveLength(1);
    expect(report.children[0]?.taskId).toBe("agent-new");
  });

  it("returns missing-create with no numeric result when history holds no creation", () => {
    const outcome = reduce([ownedUsageEvent(1, observation())], 50);

    expect(outcome).toEqual({
      status: "missing-create",
      threadId: reportThreadId,
      readThroughSequence: 50,
    });
  });

  it("matches the session inventory on source scope so one provider's same turn id cannot hide another's", () => {
    const receipted = observation({
      runtimeEventId: "rt-1",
      turnId: "turn-y",
      instanceId: instanceA,
    });
    const report = reduceOk([
      createdEvent(1),
      sessionSetEvent({ sequence: 2, providerInstanceId: instanceA, activeTurnId: "turn-x" }),
      // Same turn id string as the receipt, different instance: a matcher on
      // turnId alone would count this inventory entry as recorded.
      sessionSetEvent({ sequence: 3, providerInstanceId: instanceB, activeTurnId: "turn-y" }),
      sessionSetEvent({ sequence: 4, providerInstanceId: instanceA, activeTurnId: "turn-y" }),
      ownedUsageEvent(5, receipted),
    ]);

    // [codex-a, turn-x] has no receipt at all, and [codex-b, turn-y] is not
    // satisfied by codex-a's receipt for the same turn id string.
    expect(report.main.unrecorded).toBe(2);
  });

  it("keeps child frames as identity-unknown observations with no authoritative latest", () => {
    const report = reduceOk([
      createdEvent(1),
      childUsageEvent({
        sequence: 2,
        kind: "task.progress",
        taskId: "agent-1",
        usage: { totalTokens: 500 },
        source: childSource({ runtimeEventId: "rt-c1", phase: "progress" }),
      }),
      childUsageEvent({
        sequence: 3,
        kind: "task.progress",
        taskId: "agent-1",
        usage: { totalTokens: 500 },
        source: childSource({ runtimeEventId: "rt-c1", phase: "progress" }),
      }),
      childUsageEvent({
        sequence: 4,
        kind: "task.progress",
        taskId: "agent-1",
        usage: { totalTokens: 700 },
        source: childSource({ runtimeEventId: "rt-c2", phase: "progress" }),
      }),
      childUsageEvent({
        sequence: 5,
        kind: "task.completed",
        taskId: "agent-1",
        usage: { totalTokens: 900 },
        source: childSource({ runtimeEventId: "rt-c2", phase: "completed" }),
      }),
      childUsageEvent({
        sequence: 6,
        kind: "task.progress",
        taskId: "agent-1",
        usage: { totalTokens: 800 },
        source: childSource({ runtimeEventId: "rt-c3", phase: "progress" }),
      }),
      childUsageEvent({
        sequence: 7,
        kind: "task.progress",
        taskId: "agent-1",
        usage: { totalTokens: 300 },
        source: childSource({ runtimeEventId: "rt-c3", phase: "progress" }),
      }),
    ]);

    expect(report.children).toHaveLength(1);
    const child = report.children[0]!;
    // No `latest`/`latestPhase`/`completedSeen`: the claimed task key spans
    // lifetimes the stamp cannot bind, so only the frames speak.
    expect(Object.keys(child).toSorted()).toEqual(
      [
        "changedPayloadDeliveryCount",
        "driver",
        "duplicateDeliveryCount",
        "frames",
        "instanceId",
        "lifetime",
        "nonMonotonic",
        "taskId",
      ].toSorted(),
    );
    expect(child.lifetime).toBe("unknown");
    expect(child.duplicateDeliveryCount).toBe(1);
    expect(child.changedPayloadDeliveryCount).toBe(4);
    expect(child.nonMonotonic).toBe(true);
    // Every retained frame keeps its own value and source reference: the
    // decrease at sequence 7 never overwrites or drops sequence 6.
    expect(child.frames.map((frame) => [frame.sequence, frame.usage.totalTokens])).toEqual([
      [2, 500],
      [4, 700],
      [5, 900],
      [6, 800],
      [7, 300],
    ]);
    expect(child.frames.map((frame) => frame.runtimeEventId)).toEqual([
      "rt-c1",
      "rt-c2",
      "rt-c2",
      "rt-c3",
      "rt-c3",
    ]);
    expect(Object.keys(child.frames[0]!).toSorted()).toEqual(
      ["eventId", "phase", "runtimeEventId", "sequence", "usage"].toSorted(),
    );
  });

  it("retains a child frame that only ever arrived at completion", () => {
    const report = reduceOk([
      createdEvent(1),
      childUsageEvent({
        sequence: 2,
        kind: "task.completed",
        taskId: "agent-9",
        usage: { totalTokens: 4200, outputTokens: 400 },
        source: childSource({ runtimeEventId: "rt-c9", phase: "completed" }),
      }),
    ]);

    expect(report.children).toHaveLength(1);
    expect(report.children[0]?.frames).toHaveLength(1);
    expect(report.children[0]?.frames[0]?.phase).toBe("completed");
    expect(report.children[0]?.frames[0]?.usage).toEqual({ totalTokens: 4200, outputTokens: 400 });
  });

  it("keeps phase-only and taskId-only claim changes as distinct retained frames", () => {
    const report = reduceOk([
      createdEvent(1),
      // Same delivery, equal usage, phase only differs: a comparator that
      // ignores the phase would fold these into one frame.
      childUsageEvent({
        sequence: 2,
        kind: "task.progress",
        taskId: "agent-p",
        usage: { totalTokens: 500 },
        source: childSource({ runtimeEventId: "rt-phase", phase: "progress" }),
      }),
      childUsageEvent({
        sequence: 3,
        kind: "task.completed",
        taskId: "agent-p",
        usage: { totalTokens: 500 },
        source: childSource({ runtimeEventId: "rt-phase", phase: "completed" }),
      }),
      // Equal source stamp and usage, claimed task differs: neither variant
      // may disappear before grouping.
      childUsageEvent({
        sequence: 4,
        kind: "task.progress",
        taskId: "agent-x",
        usage: { totalTokens: 700 },
        source: childSource({ runtimeEventId: "rt-task", phase: "progress" }),
      }),
      childUsageEvent({
        sequence: 5,
        kind: "task.progress",
        taskId: "agent-y",
        usage: { totalTokens: 700 },
        source: childSource({ runtimeEventId: "rt-task", phase: "progress" }),
      }),
    ]);

    const phaseChild = report.children.find((child) => child.taskId === "agent-p");
    expect(phaseChild?.frames.map((frame) => [frame.sequence, frame.phase])).toEqual([
      [2, "progress"],
      [3, "completed"],
    ]);
    expect(phaseChild?.duplicateDeliveryCount).toBe(0);
    expect(phaseChild?.changedPayloadDeliveryCount).toBe(2);
    // The taskId-only conflict survives as two claimed groups, each keeping
    // its own frame and changed-payload charge.
    const taskChildren = report.children.filter(
      (child) => child.taskId === "agent-x" || child.taskId === "agent-y",
    );
    expect(taskChildren.map((child) => [child.taskId, child.frames.length])).toEqual([
      ["agent-x", 1],
      ["agent-y", 1],
    ]);
    expect(taskChildren.map((child) => child.changedPayloadDeliveryCount)).toEqual([1, 1]);
  });

  it("counts undecodable records as invalid and unstamped usage rows as legacy", () => {
    const report = reduceOk([
      createdEvent(1),
      rawActivityEvent(2, OWNED_USAGE_ACTIVITY_KIND, { v: 2, scope: "main-turn" }),
      rawActivityEvent(3, "task.progress", {
        taskId: "agent-1",
        typedUsage: { totalTokens: 5 },
        usageSource: {
          v: 9,
          driver: "codex",
          instanceId: null,
          runtimeEventId: "rt-bad",
          phase: "progress",
        },
      }),
      rawActivityEvent(4, "task.completed", {
        taskId: "agent-2",
        typedUsage: { totalTokens: 6 },
      }),
    ]);

    expect(report.main.invalid).toBe(2);
    expect(report.legacyChildFrames).toBe(1);
    expect(report.children).toEqual([]);
  });
});

describe("owned usage through real ingestion and a reopened read-only database", () => {
  effectIt.live(
    "records owned usage through real ingestion, reopens the file database read-only, and matches the registered CLI JSON",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-owned-usage-"));
        const dbPath = NodePath.join(dir, "userdata", "state.sqlite");
        const threadId = ThreadId.make("thread-ingested");
        const turnId = TurnId.make("turn-main");
        const instanceId = ProviderInstanceId.make("codex-personal");

        const runtimeEventBus = yield* PubSub.unbounded<{
          readonly events: ReadonlyArray<ProviderRuntimeEvent>;
          readonly enqueued?: Deferred.Deferred<void> | undefined;
        }>();
        const ingestionSubscribed = yield* Deferred.make<void>();
        const runtimeSessions: ProviderSession[] = [];
        const unsupported = () =>
          Effect.die(new Error("Unsupported provider call in test")) as never;
        const providerService: ProviderServiceShape = {
          previewSubmissionRoute: () => unsupported(),
          startSession: () => unsupported(),
          sendTurn: () => unsupported(),
          compactThread: () => unsupported(),
          interruptTurn: () => unsupported(),
          respondToRequest: () => unsupported(),
          respondToUserInput: () => unsupported(),
          stopSession: () => unsupported(),
          listSessions: () => Effect.succeed([...runtimeSessions]),
          getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
          assertConversationRollbackSupported: () => unsupported(),
          getInstanceInfo: (id) =>
            Effect.succeed({
              instanceId: id,
              driverKind: codex,
              displayName: undefined,
              enabled: true,
              continuationIdentity: {
                driverKind: codex,
                continuationKey: `codex:instance:${id}`,
              },
            }),
          rollbackConversation: () => unsupported(),
          uploadFeedback: () => unsupported(),
          get streamEvents() {
            const batched = Stream.fromPubSub(runtimeEventBus).pipe(
              Stream.flatMap(({ events, enqueued }) =>
                Stream.concat(
                  Stream.fromIterable(events),
                  enqueued
                    ? Stream.fromEffect(Deferred.succeed(enqueued, undefined)).pipe(Stream.drain)
                    : Stream.empty,
                ),
              ),
            );
            return Stream.scoped(
              Stream.fromPull(
                Stream.toPull(batched).pipe(
                  Effect.map((pull) =>
                    Effect.gen(function* () {
                      // The PubSub subscription is acquired on first pull, not
                      // when the pull is built: emit only after this ack.
                      const pulling = yield* pull.pipe(
                        Effect.forkChild({ startImmediately: true }),
                      );
                      yield* Deferred.succeed(ingestionSubscribed, undefined);
                      return yield* Fiber.join(pulling);
                    }),
                  ),
                ),
              ),
            );
          },
        };
        const setSession = (session: ProviderSession): void => {
          const existing = runtimeSessions.findIndex(
            (entry) => entry.threadId === session.threadId,
          );
          if (existing >= 0) runtimeSessions[existing] = session;
          else runtimeSessions.push(session);
        };

        const persistence = makeSqlitePersistenceLive(dbPath);
        const orchestrationLayer = OrchestrationEngineLive.pipe(
          Layer.provide(OrchestrationProjectionSnapshotQueryLive),
          Layer.provide(OrchestrationProjectionPipelineLive),
          Layer.provide(OrchestrationEventStoreLive),
          Layer.provide(OrchestrationCommandReceiptRepositoryLive),
          Layer.provide(RepositoryIdentityResolver.layer),
          Layer.provide(persistence),
        );
        const layer = ProviderRuntimeIngestionLive.pipe(
          Layer.provideMerge(orchestrationLayer),
          Layer.provideMerge(
            OrchestrationProjectionSnapshotQueryLive.pipe(
              Layer.provide(RepositoryIdentityResolver.layer),
              Layer.provide(persistence),
            ),
          ),
          Layer.provideMerge(restartContinuationsLayer),
          Layer.provideMerge(ThreadBackgroundLiveness.layer),
          Layer.provideMerge(ThreadPlanProgress.layer),
          Layer.provideMerge(persistence),
          Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(ServerConfig.layerTest(dir, dir)),
          Layer.provideMerge(NodeServices.layer),
        );

        let liveScope: Scope.Closeable | null = yield* Scope.make("sequential");
        let ingestionScope: Scope.Closeable | null = yield* Scope.make("sequential");
        let reopenScope: Scope.Closeable | null = null;
        let writerScope: Scope.Closeable | null = null;
        let controlledScope: Scope.Closeable | null = null;
        // The subscription/enqueue/drain awaits are unbounded by nature; bound
        // each with the repo's Effect.timeout convention and name the phase so
        // a stalled startup fails with a diagnosable point instead of the
        // runner timeout.
        const bounded =
          (phase: string) =>
          <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | unknown, R> =>
            effect.pipe(
              Effect.timeout("3 seconds"),
              Effect.tapError(() =>
                Effect.logWarning(`owned-usage integration: ${phase} did not settle`),
              ),
            );
        try {
          const context = yield* Layer.buildWithScope(layer, liveScope);
          const live = Effect.provideContext(context);
          const engine = yield* live(Effect.service(OrchestrationEngineService));
          const query = yield* live(Effect.service(ProjectionSnapshotQuery));
          const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
            live(engine.dispatch(command));

          yield* dispatch({
            type: "project.create",
            commandId: CommandId.make("owned-usage-project-create"),
            projectId: ProjectId.make("owned-usage-project"),
            title: "Owned usage",
            workspaceRoot: dir,
            defaultModelSelection: { instanceId, model: "gpt-5-codex" },
            createdAt: at,
          });
          yield* dispatch({
            type: "thread.create",
            commandId: CommandId.make("owned-usage-thread-create"),
            threadId,
            projectId: ProjectId.make("owned-usage-project"),
            title: "Owned usage",
            modelSelection: { instanceId, model: "gpt-5-codex" },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: at,
          });
          yield* dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("owned-usage-session-seed"),
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: at,
            },
            createdAt: at,
          });
          setSession({
            provider: codex,
            providerInstanceId: instanceId,
            status: "ready",
            runtimeMode: "full-access",
            threadId,
            createdAt: at,
            updatedAt: at,
          });

          const ingestion = yield* live(Effect.service(ProviderRuntimeIngestionService));
          yield* live(ingestion.start().pipe(Scope.provide(ingestionScope)));
          yield* bounded("provider stream subscription")(Deferred.await(ingestionSubscribed));

          const emitAndDrain = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
            Effect.gen(function* () {
              const enqueued = yield* Deferred.make<void>();
              yield* PubSub.publish(runtimeEventBus, { events, enqueued });
              yield* bounded("runtime event enqueue")(Deferred.await(enqueued));
              yield* bounded("ingestion drain")(live(ingestion.drain));
            });

          const tokenUsage: TurnTokenUsage = {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 1200,
            outputTokens: 340,
            cachedInputTokens: 50,
            cacheCreationTokens: 30,
            reasoningTokens: 10,
            hasSubagents: false,
          };
          const started: ProviderRuntimeEvent = {
            type: "turn.started",
            eventId: EventId.make("evt-turn-started"),
            provider: codex,
            providerInstanceId: instanceId,
            threadId,
            createdAt: at,
            turnId,
            payload: {},
          };
          const terminal: ProviderRuntimeEvent = {
            type: "turn.completed",
            eventId: EventId.make("evt-turn-terminal"),
            provider: codex,
            providerInstanceId: instanceId,
            threadId,
            createdAt: at,
            turnId,
            raw: {
              source: "codex.app-server.notification",
              method: "turn/completed",
              payload: { threadId: "codex-native-9" },
            },
            payload: { state: "completed", tokenUsage },
          };
          const childTick: ProviderRuntimeEvent = {
            type: "task.progress",
            eventId: EventId.make("evt-child-tick"),
            provider: codex,
            providerInstanceId: instanceId,
            threadId,
            createdAt: at,
            payload: {
              taskId: RuntimeTaskId.make("agent-1"),
              description: "Agent one",
              typedUsage: { totalTokens: 64000, inputTokens: 60000, outputTokens: 4000 },
            },
          };

          yield* emitAndDrain([started]);
          const commandModel = yield* live(query.getCommandReadModel());
          expect(
            commandModel.threads.find((entry) => entry.id === threadId)?.session?.activeTurnId,
          ).toBe(turnId);

          yield* emitAndDrain([terminal]);
          // Identical redelivery: the second command gets a fresh id, so the
          // activity id repeats in retained history even though the projection
          // folds it — exactly what the reader must deduplicate.
          yield* emitAndDrain([terminal]);
          yield* emitAndDrain([childTick]);

          // Same runtime event id delivered twice with differing accounting
          // payloads: ingestion stamps both under one activity id and the
          // reader must retain both as a conflict, never merge them.
          const conflictTerminal = (usage: TurnTokenUsage): ProviderRuntimeEvent => ({
            type: "turn.completed",
            eventId: EventId.make("evt-turn-conflict"),
            provider: codex,
            providerInstanceId: instanceId,
            threadId,
            createdAt: at,
            turnId: TurnId.make("turn-conflict"),
            raw: {
              source: "codex.app-server.notification",
              method: "turn/completed",
              payload: { threadId: "codex-native-9" },
            },
            payload: { state: "completed", tokenUsage: usage },
          });
          yield* emitAndDrain([
            conflictTerminal(completeUsage({ inputTokens: 2000, outputTokens: 500 })),
          ]);
          yield* emitAndDrain([
            conflictTerminal(completeUsage({ inputTokens: 2000, outputTokens: 999 })),
          ]);

          // Commit is done and the writer scope closes its database handle;
          // everything after this point reads the same path strictly read-only.
          yield* Scope.close(ingestionScope, Exit.void);
          ingestionScope = null;
          yield* Scope.close(liveScope, Exit.void);
          liveScope = null;

          reopenScope = yield* Scope.make("sequential");
          // Same composition as the CLI: one read-only client feeds the event
          // store and the reader's captured head through provideMerge chains.
          const reopenContext = yield* Layer.buildWithScope(
            OwnedUsageReaderLive.pipe(
              Layer.provideMerge(
                OrchestrationEventStoreLive.pipe(
                  Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath, readonly: true })),
                ),
              ),
            ),
            reopenScope,
          );
          const reopened = Effect.provideContext(reopenContext);
          const reader = yield* reopened(Effect.service(OwnedUsageReader));

          const outcome = yield* reader.read(threadId);
          expect(outcome.status).toBe("ok");
          if (outcome.status !== "ok") return;
          const report = outcome.report;

          const store = yield* reopened(Effect.service(OrchestrationEventStore));
          const history = Array.from(
            yield* Stream.runCollect(
              store.readAggregateRange({
                aggregateKind: "thread",
                aggregateId: threadId,
                fromSequenceExclusive: 0,
                toSequenceInclusive: report.readThroughSequence,
                limit: 1000,
              }),
            ),
          );
          const ownedUsageRows = history.filter(isOwnedUsageActivityEvent);
          expect(ownedUsageRows).toHaveLength(4);
          const rowsForActivityId = (activityId: string) =>
            ownedUsageRows.filter((event) => event.payload.activity.id === activityId);

          // The identical redelivery: same activity id, two distinct retained
          // orchestration events carrying the same payload.
          const duplicateRows = rowsForActivityId("owned-usage:thread-ingested:evt-turn-terminal");
          expect(duplicateRows).toHaveLength(2);
          expect(duplicateRows[0]!.eventId).not.toBe(duplicateRows[1]!.eventId);
          expect(duplicateRows[0]!.sequence).not.toBe(duplicateRows[1]!.sequence);
          expect(duplicateRows[0]!.payload.activity.payload).toEqual(
            duplicateRows[1]!.payload.activity.payload,
          );

          // The conflicting redelivery: same activity id again, but the two
          // retained payloads differ and both must survive for the reader.
          const conflictRows = rowsForActivityId("owned-usage:thread-ingested:evt-turn-conflict");
          expect(conflictRows).toHaveLength(2);
          expect(conflictRows[0]!.eventId).not.toBe(conflictRows[1]!.eventId);
          expect(conflictRows[0]!.sequence).not.toBe(conflictRows[1]!.sequence);
          expect(conflictRows[0]!.payload.activity.payload).not.toEqual(
            conflictRows[1]!.payload.activity.payload,
          );

          expect(report.incarnationSequence).toBeGreaterThan(0);
          expect(report.main.complete).toBe(1);
          expect(report.main.conflict).toBe(1);
          expect(report.main.duplicateDeliveryCount).toBe(1);
          expect(report.main.unrecorded).toBe(0);
          const conflictAlternatives = report.main.conflicts[0]?.alternatives ?? [];
          expect(report.main.conflicts[0]?.delivery).toEqual({
            driver: "codex",
            instanceId: "codex-personal",
            runtimeEventId: "evt-turn-conflict",
          });
          expect(
            conflictAlternatives.map((entry) => [
              entry.observation.source.runtimeEventId,
              entry.observation.terminal,
              entry.observation.usage.usageStatus,
            ]),
          ).toEqual([
            ["evt-turn-conflict", "completed", "complete"],
            ["evt-turn-conflict", "completed", "complete"],
          ]);
          // Both conflicting payloads are preserved verbatim; neither is
          // merged into any number.
          expect(
            conflictAlternatives
              .map((entry) =>
                entry.observation.usage.usageStatus === "complete"
                  ? entry.observation.usage.outputTokens
                  : -1,
              )
              .toSorted(),
          ).toEqual([500, 999]);
          // Each alternative keeps its durable store position.
          expect(conflictAlternatives[0]!.observationRef.sequence).not.toBe(
            conflictAlternatives[1]!.observationRef.sequence,
          );
          expect(conflictAlternatives[0]!.observationRef.eventId).not.toBe(
            conflictAlternatives[1]!.observationRef.eventId,
          );
          expect(report.main.buckets).toEqual([
            {
              scope: {
                driver: "codex",
                instanceId: "codex-personal",
                nativeConversationId: "codex-native-9",
              },
              reportedCompleteSubtotal: {
                completeTurns: 1,
                inputTokens: 1200,
                outputTokens: 340,
                cachedInputTokens: { sum: 50, reportedTurns: 1 },
                cacheCreationTokens: { sum: 30, reportedTurns: 1 },
                reasoningTokens: { sum: 10, reportedTurns: 1 },
              },
            },
          ]);
          expect(report.children).toEqual([
            {
              driver: "codex",
              instanceId: "codex-personal",
              taskId: "agent-1",
              lifetime: "unknown",
              frames: [
                {
                  sequence: expect.any(Number),
                  eventId: expect.any(String),
                  runtimeEventId: "evt-child-tick",
                  phase: "progress",
                  usage: { totalTokens: 64000, inputTokens: 60000, outputTokens: 4000 },
                },
              ],
              duplicateDeliveryCount: 0,
              changedPayloadDeliveryCount: 0,
              nonMonotonic: false,
            },
          ]);
          expect(report.legacyChildFrames).toBe(0);
          expect(report.parentChildOverlap).toBe("unknown");

          // Over-limit histories report a non-numeric outcome, not a zero.
          const tooLarge = yield* reader.read(threadId, { maxEvents: 1 });
          expect(tooLarge).toEqual({
            status: "too-large",
            threadId,
            readThroughSequence: report.readThroughSequence,
            eventCount: 2,
            payloadBytes: expect.any(Number),
          });
          const missing = yield* reader.read(ThreadId.make("thread-absent"));
          expect(missing).toEqual({
            status: "missing-create",
            threadId: "thread-absent",
            readThroughSequence: report.readThroughSequence,
          });

          const cliLines = yield* Effect.gen(function* () {
            yield* Command.runWith(cli, { version: "0.0.0" })([
              "usage",
              "owned",
              threadId,
              "--json",
              "--base-dir",
              dir,
            ]);
            return yield* TestConsole.logLines;
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                NetService.layer,
                ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
                TestConsole.layer,
              ),
            ),
          );
          const stdoutEntries = cliLines.filter((line): line is string => typeof line === "string");
          // Clean JSON stdout: exactly one log entry, no extra or non-string
          // output riding along.
          expect(cliLines).toHaveLength(1);
          const cliOutcome = JSON.parse(stdoutEntries[0]!) as OwnedThreadUsageOutcome;
          expect(cliOutcome).toEqual(outcome);

          // Captured-head boundary: replay must never see beyond the head a
          // read captured, and must never leave the requested aggregate. A
          // writable store over the same database appends two real events from
          // inside a controlled reader's replay boundary — after that read
          // captured its head and computed its stats, before it replayed.
          writerScope = yield* Scope.make("sequential");
          const writerContext = yield* Layer.buildWithScope(
            Layer.provideMerge(
              OrchestrationEventStoreLive,
              NodeSqliteClient.layer({ filename: dbPath }),
            ),
            writerScope,
          );
          const writerStore = yield* Effect.provideContext(writerContext)(
            Effect.service(OrchestrationEventStore),
          );
          const postHeadEvent: Omit<OrchestrationEvent, "sequence"> = {
            eventId: EventId.make("evt-post-head"),
            aggregateKind: "thread",
            aggregateId: threadId,
            type: "thread.activity-appended",
            occurredAt: at,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              threadId,
              activity: {
                id: EventId.make("owned-usage:thread-ingested:evt-post-head"),
                tone: "info",
                kind: OWNED_USAGE_ACTIVITY_KIND,
                summary: "Turn usage observed",
                payload: {
                  v: 1,
                  scope: "main-turn",
                  source: {
                    driver: codex,
                    instanceId,
                    turnId: TurnId.make("turn-post-head"),
                    runtimeEventId: EventId.make("evt-post-head"),
                    nativeConversationId: "codex-native-9",
                  },
                  terminal: "completed",
                  usage: completeUsage({ inputTokens: 7000, outputTokens: 700 }),
                },
                turnId: TurnId.make("turn-post-head"),
                createdAt: at,
              },
            },
          };
          const otherThreadId = ThreadId.make("thread-post-head-other");
          const otherThreadEvent: Omit<OrchestrationEvent, "sequence"> = {
            eventId: EventId.make("evt-post-head-other"),
            aggregateKind: "thread",
            aggregateId: otherThreadId,
            type: "thread.activity-appended",
            occurredAt: at,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              threadId: otherThreadId,
              activity: {
                id: EventId.make("owned-usage:thread-post-head-other:evt-post-head-other"),
                tone: "info",
                kind: OWNED_USAGE_ACTIVITY_KIND,
                summary: "Turn usage observed",
                payload: {
                  v: 1,
                  scope: "main-turn",
                  source: {
                    driver: codex,
                    instanceId,
                    turnId: TurnId.make("turn-post-head-other"),
                    runtimeEventId: EventId.make("evt-post-head-other"),
                    nativeConversationId: "codex-native-other",
                  },
                  terminal: "completed",
                  usage: completeUsage({ inputTokens: 9000, outputTokens: 900 }),
                },
                turnId: TurnId.make("turn-post-head-other"),
                createdAt: at,
              },
            },
          };
          let appendedBeyondHead = false;
          const appendBeyondHeadOnce = Effect.suspend(() => {
            if (appendedBeyondHead) return Effect.void;
            appendedBeyondHead = true;
            return Effect.asVoid(
              Effect.andThen(
                writerStore.append(postHeadEvent),
                writerStore.append(otherThreadEvent),
              ),
            );
          });
          controlledScope = yield* Scope.make("sequential");
          const controlledContext = yield* Layer.buildWithScope(
            OwnedUsageReaderLive.pipe(
              Layer.provideMerge(
                Layer.provideMerge(
                  Layer.effect(
                    OrchestrationEventStore,
                    Effect.gen(function* () {
                      const readonlyStore = yield* OrchestrationEventStore;
                      return OrchestrationEventStore.of({
                        ...readonlyStore,
                        // The append barrier runs when the stream is unwrapped,
                        // i.e. after this read captured its head and computed
                        // its stats but before any replay page is queried.
                        readAggregateRange: (input) =>
                          Stream.unwrap(
                            Effect.map(appendBeyondHeadOnce, () =>
                              readonlyStore.readAggregateRange(input),
                            ),
                          ),
                      });
                    }),
                  ).pipe(Layer.provide(OrchestrationEventStoreLive)),
                  NodeSqliteClient.layer({ filename: dbPath, readonly: true }),
                ),
              ),
            ),
            controlledScope,
          );
          const frozenReader = yield* Effect.provideContext(controlledContext)(
            Effect.service(OwnedUsageReader),
          );

          const frozenRead = yield* frozenReader.read(threadId);
          expect(frozenRead.status).toBe("ok");
          if (frozenRead.status !== "ok") return;
          // The two events appended inside the replay boundary sit beyond this
          // read's captured head: coverage is unchanged exactly.
          expect(frozenRead.report.readThroughSequence).toBe(report.readThroughSequence);
          expect(frozenRead.report.main.complete).toBe(1);
          expect(frozenRead.report.main.buckets).toEqual(report.main.buckets);
          expect(frozenRead.report.main.conflict).toBe(1);

          // A fresh read after the appends: the events really did land, so the
          // frozen read's exclusion was the head bound at work, not write loss.
          const postAppendRead = yield* reader.read(threadId);
          expect(postAppendRead.status).toBe("ok");
          if (postAppendRead.status !== "ok") return;
          expect(postAppendRead.report.main.complete).toBe(2);
          expect(postAppendRead.report.main.buckets).toEqual([
            {
              scope: {
                driver: "codex",
                instanceId: "codex-personal",
                nativeConversationId: "codex-native-9",
              },
              reportedCompleteSubtotal: {
                completeTurns: 2,
                inputTokens: 8200,
                outputTokens: 1040,
                cachedInputTokens: { sum: 50, reportedTurns: 1 },
                cacheCreationTokens: { sum: 30, reportedTurns: 1 },
                reasoningTokens: { sum: 10, reportedTurns: 1 },
              },
            },
          ]);
          // The conflict and its exclusion survive the re-read untouched.
          expect(postAppendRead.report.main.conflict).toBe(1);
          expect(postAppendRead.report.main.duplicateDeliveryCount).toBe(1);
          // Requested-aggregate boundary, both directions: this thread's
          // report never includes the other thread's appended usage, and a
          // read of that thread sees only its own creation-less history.
          const otherRead = yield* reader.read(otherThreadId);
          expect(otherRead).toEqual({
            status: "missing-create",
            threadId: otherThreadId,
            readThroughSequence: postAppendRead.report.readThroughSequence,
          });
        } finally {
          if (controlledScope !== null) {
            yield* Scope.close(controlledScope, Exit.void).pipe(Effect.ignore);
          }
          if (writerScope !== null) {
            yield* Scope.close(writerScope, Exit.void).pipe(Effect.ignore);
          }
          if (reopenScope !== null) {
            yield* Scope.close(reopenScope, Exit.void).pipe(Effect.ignore);
          }
          if (ingestionScope !== null) {
            yield* Scope.close(ingestionScope, Exit.void).pipe(Effect.ignore);
          }
          if (liveScope !== null) {
            yield* Scope.close(liveScope, Exit.void).pipe(Effect.ignore);
          }
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }
      }),
  );
});
