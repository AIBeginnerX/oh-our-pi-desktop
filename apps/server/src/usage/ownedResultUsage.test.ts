import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ApprovalRequestId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  OwnedResultUsageOutcome,
  type OrchestrationEvent,
  type OwnedResultUsageV1,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type SelectedCheckReceipt,
  SELECTED_CHECK_RECEIPT_KIND,
  selectedCheckReceiptId,
  ThreadId,
  TurnId,
  type TurnTokenUsage,
} from "@t3tools/contracts";

import { deriveOwnedResultUsage } from "./ownedResultUsage.ts";
import {
  OWNED_USAGE_ACTIVITY_KIND,
  type OwnedTurnUsageObservationV1,
} from "./ownedUsage.schema.ts";

const isoAt = (sequence: number) => `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`;
const codex = ProviderDriverKind.make("codex");
const instanceA = ProviderInstanceId.make("codex-a");
const instanceB = ProviderInstanceId.make("codex-b");
const threadId = ThreadId.make("thread-results");
const projectId = ProjectId.make("project-results");
const sha = "0".repeat(64);
const treeOid = "a".repeat(40);
const CHECKS_MS = 30_000;

type ActivityAppendedEvent = Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;
type MessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
type TurnStartEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;
type SessionSetEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;

const base = (sequence: number, eventId: string, commandId: CommandId | null = null) => ({
  sequence,
  eventId: EventId.make(eventId),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: isoAt(sequence),
  commandId,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

const createdEvent = (sequence: number): OrchestrationEvent => ({
  ...base(sequence, `evt-created-${sequence}`),
  type: "thread.created",
  payload: {
    threadId,
    projectId,
    title: "Owned results",
    modelSelection: { instanceId: instanceA, model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: isoAt(sequence),
    updatedAt: isoAt(sequence),
  },
});

const passedCheck: SelectedCheckReceipt["checks"][number] = {
  scriptId: "typecheck",
  status: "passed",
  startedAt: "2026-01-01T00:10:01.000Z",
  endedAt: "2026-01-01T00:10:29.000Z",
  exitCode: 0,
  exitedBy: "exit",
  exitSignal: null,
  pgid: 4321,
  group: "empty",
  stdout: { bytes: 10, sha256: sha },
  stderr: { bytes: 0, sha256: sha },
  failure: null,
};

const failedCheck: SelectedCheckReceipt["checks"][number] = {
  ...passedCheck,
  status: "failed",
  exitCode: 1,
};

const pendingCheck: SelectedCheckReceipt["checks"][number] = {
  ...passedCheck,
  status: "pending",
  startedAt: null,
  endedAt: null,
  exitCode: null,
  exitedBy: null,
  exitSignal: null,
  pgid: null,
  group: null,
  stdout: null,
  stderr: null,
};

const uncapturedTree: SelectedCheckReceipt["tree"] = {
  atStart: { kind: "not-captured" },
  atEnd: { kind: "not-captured" },
  repoAtStart: null,
  repoAtEnd: null,
};

const receipt = (input: {
  attemptId: string;
  revision: number;
  anchor: number | null;
  phase?: SelectedCheckReceipt["phase"];
  checks?: SelectedCheckReceipt["checks"];
  startedAt?: string;
  endedAt?: string | null;
  cwd?: string;
  tree?: SelectedCheckReceipt["tree"];
}): SelectedCheckReceipt => ({
  schemaVersion: 1,
  threadId,
  attemptId: input.attemptId,
  revision: input.revision,
  threadAnchorSequence: input.anchor,
  context: {
    projectId,
    workspaceRoot: "/w",
    worktreePath: null,
    cwd: input.cwd ?? "/w",
    shell: "/bin/zsh",
    envSha256: sha,
  },
  planned: [
    { scriptId: "typecheck", scriptName: "Typecheck", commandSha256: sha, timeoutMs: 60_000 },
  ],
  environment: {
    environmentId: EnvironmentId.make("env-1"),
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.0.0",
    serverVersion: "1.0.0",
    nodeVersion: "24.0.0",
  },
  tree: input.tree ?? {
    atStart: { kind: "complete", treeOid },
    atEnd: { kind: "complete", treeOid },
    repoAtStart: { topLevel: "/w", commonDir: "/w/.git" },
    repoAtEnd: { topLevel: "/w", commonDir: "/w/.git" },
  },
  phase: input.phase ?? "completed",
  checks: input.checks ?? [passedCheck],
  startedAt: input.startedAt ?? "2026-01-01T00:10:00.000Z",
  endedAt: input.endedAt === undefined ? "2026-01-01T00:10:30.000Z" : input.endedAt,
  error: null,
});

// The production revision 0 as `initialReceipt` actually writes it:
// pending checks, running phase, nothing captured yet.
const initialRev0 = receipt({
  attemptId: "a",
  revision: 0,
  anchor: null,
  phase: "running",
  checks: [pendingCheck],
  endedAt: null,
  tree: uncapturedTree,
});

const receiptEvent = (
  sequence: number,
  body: unknown,
  options: { commandId?: string | null; activityId?: string } = {},
): ActivityAppendedEvent => ({
  ...base(
    sequence,
    `evt-receipt-${sequence}`,
    options.commandId === null
      ? null
      : CommandId.make(options.commandId ?? `server:selected-checks:test-${sequence}`),
  ),
  type: "thread.activity-appended",
  payload: {
    threadId,
    activity: {
      id: EventId.make(options.activityId ?? selectedCheckReceiptId(threadId)),
      tone: "info",
      kind: SELECTED_CHECK_RECEIPT_KIND,
      summary: "Selected checks recorded",
      payload: body,
      turnId: null,
      createdAt: isoAt(sequence),
    },
  },
});

const messageSent = (
  sequence: number,
  messageId: string,
  role: "user" | "assistant" = "user",
): MessageSentEvent => ({
  ...base(sequence, `evt-msg-${sequence}`),
  type: "thread.message-sent",
  payload: {
    threadId,
    messageId: MessageId.make(messageId),
    role,
    text: "go",
    turnId: null,
    streaming: false,
    createdAt: isoAt(sequence),
    updatedAt: isoAt(sequence),
  },
});

const turnStart = (sequence: number, messageId: string): TurnStartEvent => ({
  ...base(sequence, `evt-tsr-${sequence}`),
  type: "thread.turn-start-requested",
  payload: {
    threadId,
    messageId: MessageId.make(messageId),
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: isoAt(sequence),
  },
});

const approvalResponse = (sequence: number): OrchestrationEvent => ({
  ...base(sequence, `evt-approval-${sequence}`),
  type: "thread.approval-response-requested",
  payload: {
    threadId,
    requestId: ApprovalRequestId.make(`req-${sequence}`),
    decision: "accept",
    createdAt: isoAt(sequence),
  },
});

const userInputResponse = (sequence: number): OrchestrationEvent => ({
  ...base(sequence, `evt-answer-${sequence}`),
  type: "thread.user-input-response-requested",
  payload: {
    threadId,
    requestId: ApprovalRequestId.make(`req-${sequence}`),
    answers: { question: "yes" },
    createdAt: isoAt(sequence),
  },
});

const checkpointRevert = (sequence: number): OrchestrationEvent => ({
  ...base(sequence, `evt-revert-${sequence}`),
  type: "thread.checkpoint-revert-requested",
  payload: { threadId, turnCount: 1, createdAt: isoAt(sequence) },
});

// `null` omits the instance field entirely — passing `undefined` would
// only reactivate the default parameter.
const sessionSet = (
  sequence: number,
  activeTurnId: string | null,
  providerInstanceId: ProviderInstanceId | null = instanceA,
): SessionSetEvent => ({
  ...base(sequence, `evt-session-${sequence}`),
  type: "thread.session-set",
  payload: {
    threadId,
    session: {
      threadId,
      status: "ready",
      providerName: "codex",
      ...(providerInstanceId === null ? {} : { providerInstanceId }),
      runtimeMode: "full-access",
      activeTurnId: activeTurnId === null ? null : TurnId.make(activeTurnId),
      lastError: null,
      updatedAt: isoAt(sequence),
    },
  },
});

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

const observation = (
  overrides: {
    instanceId?: ProviderInstanceId | null;
    turnId?: string | null;
    runtimeEventId?: string;
    nativeConversationId?: string | null;
    usage?: TurnTokenUsage;
  } = {},
): OwnedTurnUsageObservationV1 => ({
  v: 1,
  scope: "main-turn",
  source: {
    driver: codex,
    instanceId: overrides.instanceId === undefined ? instanceA : overrides.instanceId,
    turnId:
      overrides.turnId === undefined
        ? TurnId.make("turn-1")
        : overrides.turnId === null
          ? null
          : TurnId.make(overrides.turnId),
    runtimeEventId: EventId.make(overrides.runtimeEventId ?? "rt-x"),
    nativeConversationId:
      overrides.nativeConversationId === undefined ? "conv-1" : overrides.nativeConversationId,
  },
  terminal: "completed",
  usage: overrides.usage ?? completeUsage(),
});

const ownedUsageEvent = (sequence: number, payload: unknown): ActivityAppendedEvent => ({
  ...base(sequence, `evt-usage-${sequence}`),
  type: "thread.activity-appended",
  payload: {
    threadId,
    activity: {
      id: EventId.make(`owned-usage:thread:${sequence}`),
      tone: "info",
      kind: OWNED_USAGE_ACTIVITY_KIND,
      summary: "Turn usage observed",
      payload,
      turnId: null,
      createdAt: isoAt(sequence),
    },
  },
});

const derive = (events: ReadonlyArray<OrchestrationEvent>, readThroughSequence = 200) =>
  deriveOwnedResultUsage({ threadId, readThroughSequence, events });

const decodeOutcome = Schema.decodeUnknownSync(OwnedResultUsageOutcome);

const passAttempt = (
  attemptId: string,
  anchor: number,
  final: number,
): ReadonlyArray<OrchestrationEvent> => [
  receiptEvent(anchor, receipt({ attemptId, revision: 0, anchor: null, phase: "running" })),
  receiptEvent(final, receipt({ attemptId, revision: 1, anchor })),
];

const reason = (row: OwnedResultUsageV1) =>
  row.usage.status === "unmeasurable" ? row.usage.reason : row.usage.status;

describe("deriveOwnedResultUsage", () => {
  it("measures two passed results as disjoint windows with per-segment usage", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      messageSent(3, "m1"),
      turnStart(4, "m1"),
      sessionSet(5, "turn-1"),
      ownedUsageEvent(6, observation({ runtimeEventId: "rt-1", turnId: "turn-1" })),
      sessionSet(7, null),
      ...passAttempt("a", 10, 11),
      messageSent(12, "m2"),
      turnStart(13, "m2"),
      sessionSet(14, "turn-2"),
      ownedUsageEvent(
        15,
        observation({
          runtimeEventId: "rt-2",
          turnId: "turn-2",
          usage: completeUsage({ inputTokens: 2000, outputTokens: 400 }),
        }),
      ),
      sessionSet(16, null),
      ...passAttempt("b", 20, 21),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.results).toHaveLength(2);
    const [first, second] = outcome.results;
    expect(first).toMatchObject({
      attemptId: "a",
      revision: 1,
      finalSequence: 11,
      anchorSequence: 10,
      segment: { fromSequenceExclusive: 1, toSequenceExclusive: 10 },
      inputs: 1,
      otherAttempts: 0,
      checksMs: CHECKS_MS,
      billedCost: "unknown",
      parentChildOverlap: "unknown",
    });
    expect(first!.recordedSpan).toEqual({
      recordedSpanMs: 8000,
      timeBasis: "recorded-event-timestamps",
    });
    expect(first!.usage.status).toBe("measured");
    if (first!.usage.status === "measured") {
      expect(first!.usage.coverage.complete).toBe(1);
      expect(first!.usage.buckets).toEqual([
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
      ]);
    }
    expect(second).toMatchObject({
      attemptId: "b",
      anchorSequence: 20,
      finalSequence: 21,
      segment: { fromSequenceExclusive: 11, toSequenceExclusive: 20 },
      inputs: 1,
    });
    if (second!.usage.status === "measured") {
      expect(second!.usage.buckets[0]?.reportedCompleteSubtotal.inputTokens).toBe(2000);
    }
    expect(outcome.trailing).toMatchObject({ inputs: 0, otherAttempts: 0 });
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("counts a failed attempt once as otherAttempts without making it a boundary", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      ...passAttempt("a", 10, 11),
      receiptEvent(12, receipt({ attemptId: "f", revision: 0, anchor: null, phase: "running" })),
      receiptEvent(13, receipt({ attemptId: "f", revision: 1, anchor: 12, checks: [failedCheck] })),
      receiptEvent(14, receipt({ attemptId: "f", revision: 2, anchor: 12, checks: [failedCheck] })),
      messageSent(15, "m2"),
      turnStart(16, "m2"),
      sessionSet(17, "turn-3"),
      ownedUsageEvent(18, observation({ runtimeEventId: "rt-3", turnId: "turn-3" })),
      sessionSet(19, null),
      ...passAttempt("b", 20, 21),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.results.map((row) => row.attemptId)).toEqual(["a", "b"]);
    const second = outcome.results[1]!;
    // The failed attempt's three revisions still count once, and the work
    // observed between the two results lands in the second segment.
    expect(second.otherAttempts).toBe(1);
    expect(second.usage.status).toBe("measured");
    if (second.usage.status === "measured") {
      expect(second.usage.coverage.complete).toBe(1);
      expect(second.usage.buckets).toHaveLength(1);
    }
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("does not resurrect an earlier pass when a later revision reconciles to interrupted", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      receiptEvent(10, receipt({ attemptId: "a", revision: 0, anchor: null, phase: "running" })),
      receiptEvent(11, receipt({ attemptId: "a", revision: 1, anchor: 10 })),
      receiptEvent(12, receipt({ attemptId: "a", revision: 2, anchor: 10, phase: "interrupted" })),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.results).toEqual([]);
    expect(outcome.trailing.otherAttempts).toBe(1);
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("folds identical same-revision redelivery to the latest retained sequence", () => {
    const passed = receipt({ attemptId: "a", revision: 1, anchor: 10 });
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      receiptEvent(10, receipt({ attemptId: "a", revision: 0, anchor: null, phase: "running" })),
      receiptEvent(11, passed),
      receiptEvent(12, passed),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.results).toHaveLength(1);
    const row = outcome.results[0]!;
    expect(row.finalSequence).toBe(12);
    expect(row.finalEventId).toBe("evt-receipt-12");
    expect(row.usage.status).toBe("measured");
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("marks a same-revision payload conflict as revision-conflict with null times", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      receiptEvent(10, receipt({ attemptId: "a", revision: 0, anchor: null, phase: "running" })),
      receiptEvent(
        11,
        receipt({ attemptId: "a", revision: 1, anchor: 10, endedAt: "2026-01-01T00:10:30.000Z" }),
      ),
      receiptEvent(
        12,
        receipt({ attemptId: "a", revision: 1, anchor: 10, endedAt: "2026-01-01T00:10:45.000Z" }),
      ),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.results).toHaveLength(1);
    const row = outcome.results[0]!;
    expect(reason(row)).toBe("revision-conflict");
    expect(row.anchorSequence).toBe(10);
    expect(row.segment).toEqual({ fromSequenceExclusive: 1, toSequenceExclusive: 10 });
    expect(row.checksMs).toBeNull();
    expect(row.recordedSpan.recordedSpanMs).toBeNull();
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("keeps a conflicted lower revision visible even under a clean higher pass", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      receiptEvent(10, receipt({ attemptId: "a", revision: 0, anchor: null, phase: "running" })),
      receiptEvent(11, receipt({ attemptId: "a", revision: 1, anchor: 10 })),
      receiptEvent(12, receipt({ attemptId: "a", revision: 1, anchor: 10, checks: [failedCheck] })),
      receiptEvent(13, receipt({ attemptId: "a", revision: 2, anchor: 10 })),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const row = outcome.results[0]!;
    expect(row.revision).toBe(2);
    expect(reason(row)).toBe("revision-conflict");
    expect(row.usage.status).toBe("unmeasurable");
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("accepts the production not-captured revision 0 followed by a captured pass", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      receiptEvent(10, initialRev0),
      receiptEvent(11, receipt({ attemptId: "a", revision: 1, anchor: 10 })),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.barriers).toEqual({ malformedReceipts: 0, invalidWindows: 0 });
    expect(outcome.results).toHaveLength(1);
    const row = outcome.results[0]!;
    expect(row.anchorSequence).toBe(10);
    expect(row.finalSequence).toBe(11);
    expect(row.usage.status).toBe("measured");
    expect(row.checksMs).toBe(CHECKS_MS);
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("rejects moved anchors and mutated provenance", () => {
    const staleAnchor = derive([
      createdEvent(1),
      sessionSet(2, null),
      receiptEvent(10, receipt({ attemptId: "a", revision: 0, anchor: null, phase: "running" })),
      // A later write must name the retained first write's sequence.
      receiptEvent(11, receipt({ attemptId: "a", revision: 1, anchor: 7 })),
    ]);
    const mutatedContext = derive([
      createdEvent(1),
      sessionSet(2, null),
      receiptEvent(10, receipt({ attemptId: "a", revision: 0, anchor: null, phase: "running" })),
      receiptEvent(11, receipt({ attemptId: "a", revision: 1, anchor: 10, cwd: "/other" })),
    ]);
    const recapturedStart = derive([
      createdEvent(1),
      sessionSet(2, null),
      receiptEvent(10, initialRev0),
      receiptEvent(
        11,
        receipt({ attemptId: "a", revision: 1, anchor: 10, phase: "running", endedAt: null }),
      ),
      // A second, different start capture is a genuine provenance
      // violation — the write-once value cannot move.
      receiptEvent(
        12,
        receipt({
          attemptId: "a",
          revision: 2,
          anchor: 10,
          tree: {
            atStart: { kind: "complete", treeOid },
            atEnd: { kind: "complete", treeOid },
            repoAtStart: { topLevel: "/other", commonDir: "/other/.git" },
            repoAtEnd: { topLevel: "/other", commonDir: "/other/.git" },
          },
        }),
      ),
    ]);

    for (const outcome of [staleAnchor, mutatedContext, recapturedStart]) {
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") continue;
      expect(outcome.results).toHaveLength(1);
      const row = outcome.results[0]!;
      expect(reason(row)).toBe("invalid-receipt-or-window");
      expect(row.usage.status).toBe("unmeasurable");
      expect(row.checksMs).toBeNull();
      expect(decodeOutcome(outcome)).toBeDefined();
    }
  });

  it("keeps a late lower-revision write as a barrier across the next window", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      receiptEvent(10, receipt({ attemptId: "a", revision: 0, anchor: null, phase: "running" })),
      receiptEvent(11, receipt({ attemptId: "a", revision: 2, anchor: 10 })),
      // A's contradictory earlier revision arrives after its own final.
      receiptEvent(12, receipt({ attemptId: "a", revision: 1, anchor: 10 })),
      sessionSet(14, "turn-3"),
      ownedUsageEvent(15, observation({ runtimeEventId: "rt-3", turnId: "turn-3" })),
      sessionSet(16, null),
      ...passAttempt("b", 20, 21),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.results).toHaveLength(2);
    const [first, second] = outcome.results;
    // Row identity stays on the actual selected revision and event.
    expect(first).toMatchObject({ attemptId: "a", revision: 2, finalSequence: 11 });
    expect(reason(first!)).toBe("invalid-receipt-or-window");
    // B's window spans the invalid retained write at 12, so it cannot
    // become numeric either — the usage at 15 leaks into nothing.
    expect(reason(second!)).toBe("invalid-receipt-or-window");
    expect(second!.segment).toBeNull();
    expect(outcome.barriers.invalidWindows).toBe(2);
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("closes the window on the raw request position even when its pair landed earlier", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      // The user message sits before the attempt; its linked turn-start
      // lands inside the window and must still contaminate it.
      messageSent(9, "m1"),
      receiptEvent(10, receipt({ attemptId: "a", revision: 0, anchor: null, phase: "running" })),
      turnStart(12, "m1"),
      ownedUsageEvent(13, observation({ runtimeEventId: "rt-9", turnId: "turn-9" })),
      receiptEvent(15, receipt({ attemptId: "a", revision: 1, anchor: 10 })),
      sessionSet(16, "turn-9"),
      sessionSet(17, null),
      ...passAttempt("b", 20, 21),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const [first, second] = outcome.results;
    expect(reason(first!)).toBe("activity-during-attempt");
    // The message/request pair still counts once as a logical input.
    expect(first!.inputs).toBe(1);
    expect(second!.usage.status).toBe("measured");
    if (second!.usage.status === "measured") {
      // The observation at 13 belongs to no claimable stretch: it must not
      // leak into the next result's coverage or buckets.
      expect(second!.usage.coverage).toEqual({
        complete: 0,
        partial: 0,
        unavailable: 0,
        ambiguous: 0,
        conflictTainted: 0,
        unscoped: 0,
        unrecorded: 0,
        lateUnattributed: 0,
      });
      expect(second!.usage.buckets).toEqual([]);
    }
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("closes the window on a bare request inside the attempt with no usage confounder", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      // The message sits before the attempt; its linked request is the
      // only thing inside the window and alone must poison it.
      messageSent(9, "m1"),
      receiptEvent(10, receipt({ attemptId: "a", revision: 0, anchor: null, phase: "running" })),
      turnStart(12, "m1"),
      receiptEvent(15, receipt({ attemptId: "a", revision: 1, anchor: 10 })),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const row = outcome.results[0]!;
    expect(reason(row)).toBe("activity-during-attempt");
    expect(row.inputs).toBe(1);
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("reports unresolved for an unpaired pending message and for a foreign-source null settle", () => {
    const pendingMessage = derive([
      createdEvent(1),
      sessionSet(2, null),
      // Submitted but never requested: its ownership stays unassociated.
      messageSent(3, "m1"),
      ...passAttempt("a", 10, 11),
    ]);
    expect(pendingMessage.status).toBe("ok");
    if (pendingMessage.status === "ok") {
      expect(reason(pendingMessage.results[0]!)).toBe("unresolved-ownership-or-history");
      expect(decodeOutcome(pendingMessage)).toBeDefined();
    }

    const mismatched = derive([
      createdEvent(1),
      sessionSet(2, null),
      messageSent(3, "m1"),
      turnStart(4, "m1"),
      sessionSet(5, "turn-1"),
      // A null from another instance does not settle instance A's turn.
      sessionSet(7, null, instanceB),
      ...passAttempt("a", 10, 11),
    ]);
    expect(mismatched.status).toBe("ok");
    if (mismatched.status === "ok") {
      expect(reason(mismatched.results[0]!)).toBe("unresolved-ownership-or-history");
      expect(decodeOutcome(mismatched)).toBeDefined();
    }

    // The ordinary matched-source active→terminal lifecycle stays measured.
    const settled = derive([
      createdEvent(1),
      sessionSet(2, null),
      messageSent(3, "m1"),
      turnStart(4, "m1"),
      sessionSet(5, "turn-1"),
      sessionSet(7, null),
      ...passAttempt("a", 10, 11),
    ]);
    expect(settled.status).toBe("ok");
    if (settled.status === "ok") {
      expect(settled.results[0]!.usage.status).toBe("measured");
      expect(decodeOutcome(settled)).toBeDefined();
    }

    // A record missing the instance id is an unknown source: matching
    // null keys cannot manufacture positive identity for it.
    const missingInstance = derive([
      createdEvent(1),
      sessionSet(2, null),
      turnStart(4, "m1"),
      sessionSet(5, "turn-1", null),
      sessionSet(7, null, null),
      ...passAttempt("a", 10, 11),
    ]);
    expect(missingInstance.status).toBe("ok");
    if (missingInstance.status === "ok") {
      expect(reason(missingInstance.results[0]!)).toBe("unresolved-ownership-or-history");
      expect(decodeOutcome(missingInstance)).toBeDefined();
    }

    // One observed start resolves at most the earliest pending request —
    // the second request stays unassociated.
    const sharedStart = derive([
      createdEvent(1),
      sessionSet(2, null),
      turnStart(3, "m1"),
      turnStart(4, "m2"),
      sessionSet(5, "turn-1"),
      sessionSet(7, null),
      ...passAttempt("a", 10, 11),
    ]);
    expect(sharedStart.status).toBe("ok");
    if (sharedStart.status === "ok") {
      expect(reason(sharedStart.results[0]!)).toBe("unresolved-ownership-or-history");
      expect(decodeOutcome(sharedStart)).toBeDefined();
    }

    // Re-observing the same live turn is still one start: the duplicate
    // active record cannot settle the second request already pending.
    const duplicateActive = derive([
      createdEvent(1),
      sessionSet(2, null),
      turnStart(3, "m1"),
      sessionSet(5, "turn-1"),
      turnStart(6, "m2"),
      sessionSet(7, "turn-1"),
      sessionSet(9, null),
      ...passAttempt("a", 10, 11),
    ]);
    expect(duplicateActive.status).toBe("ok");
    if (duplicateActive.status === "ok") {
      expect(reason(duplicateActive.results[0]!)).toBe("unresolved-ownership-or-history");
      expect(decodeOutcome(duplicateActive)).toBeDefined();
    }

    // At A's anchor message@3 was still pending: its matching request
    // arrives only at 12 and cannot rewrite that earlier state — though
    // logical counting still pairs it once for the report.
    const latePair = derive([
      createdEvent(1),
      sessionSet(2, null),
      messageSent(3, "m1"),
      ...passAttempt("a", 10, 11),
      turnStart(12, "m1"),
      sessionSet(13, "turn-1"),
      sessionSet(14, null),
    ]);
    expect(latePair.status).toBe("ok");
    if (latePair.status === "ok") {
      const row = latePair.results[0]!;
      expect(reason(row)).toBe("unresolved-ownership-or-history");
      expect(row.inputs).toBe(1);
      expect(decodeOutcome(latePair)).toBeDefined();
    }
  });

  it("reports activity-during-attempt for committed input or usage inside the attempt window", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      receiptEvent(10, receipt({ attemptId: "a", revision: 0, anchor: null, phase: "running" })),
      messageSent(11, "m1"),
      turnStart(12, "m1"),
      ownedUsageEvent(13, observation({ runtimeEventId: "rt-1", turnId: "turn-1" })),
      receiptEvent(15, receipt({ attemptId: "a", revision: 1, anchor: 10 })),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const row = outcome.results[0]!;
    expect(reason(row)).toBe("activity-during-attempt");
    // The window's observations become numeric nowhere: the row is
    // unmeasurable and trailing coverage does not absorb them.
    expect(row.usage.status).toBe("unmeasurable");
    expect(outcome.trailing.coverage.complete).toBe(0);
    expect(outcome.trailing.coverage.ambiguous).toBe(0);
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("reports turn-active-at-attempt when the last session-set before the anchor has a live turn", () => {
    const outcome = derive([
      createdEvent(1),
      messageSent(3, "m1"),
      turnStart(4, "m1"),
      sessionSet(5, "turn-9"),
      ownedUsageEvent(6, observation({ runtimeEventId: "rt-9", turnId: "turn-9" })),
      ...passAttempt("a", 10, 11),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(reason(outcome.results[0]!)).toBe("turn-active-at-attempt");
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("reports turn-active-at-attempt for a session-set naming a live turn inside the window", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      receiptEvent(10, receipt({ attemptId: "a", revision: 0, anchor: null, phase: "running" })),
      sessionSet(12, "turn-5"),
      sessionSet(13, null),
      receiptEvent(15, receipt({ attemptId: "a", revision: 1, anchor: 10 })),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(reason(outcome.results[0]!)).toBe("turn-active-at-attempt");
  });

  it("reports unresolved-ownership-or-history for a start never observed active, and a bare null set does not resolve it", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      messageSent(7, "m1"),
      turnStart(8, "m1"),
      // A null session-set after the request must not prove the turn ended.
      sessionSet(9, null),
      ...passAttempt("a", 10, 11),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(reason(outcome.results[0]!)).toBe("unresolved-ownership-or-history");
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("keeps a late receipt for an older turn as lateUnattributed coverage, never tokens", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      sessionSet(5, "turn-1"),
      sessionSet(7, null),
      ...passAttempt("a", 10, 11),
      messageSent(12, "m2"),
      turnStart(13, "m2"),
      sessionSet(14, "turn-2"),
      ownedUsageEvent(15, observation({ runtimeEventId: "rt-2", turnId: "turn-2" })),
      // turn-1's usage arrives one segment late: the receipt is real, its
      // window is over, so it must not join segment two's subtotal.
      ownedUsageEvent(16, observation({ runtimeEventId: "rt-1", turnId: "turn-1" })),
      sessionSet(17, null),
      ...passAttempt("b", 20, 21),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const second = outcome.results[1]!;
    expect(second.usage.status).toBe("measured");
    if (second.usage.status === "measured") {
      expect(second.usage.coverage.lateUnattributed).toBe(1);
      expect(second.usage.coverage.complete).toBe(1);
      expect(second.usage.buckets).toHaveLength(1);
      expect(second.usage.buckets[0]?.reportedCompleteSubtotal.inputTokens).toBe(1000);
    }
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("attributes conflict-only turns as conflictTainted in every touched stretch", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      // One delivery, two contradictory payloads — no clean claim exists.
      ownedUsageEvent(
        6,
        observation({
          runtimeEventId: "rt-c",
          turnId: "turn-c",
          usage: completeUsage({ inputTokens: 500 }),
        }),
      ),
      ...passAttempt("a", 10, 11),
      sessionSet(14, "turn-2"),
      ownedUsageEvent(15, observation({ runtimeEventId: "rt-2", turnId: "turn-2" })),
      ownedUsageEvent(
        16,
        observation({
          runtimeEventId: "rt-c",
          turnId: "turn-c",
          usage: completeUsage({ inputTokens: 900 }),
        }),
      ),
      sessionSet(17, null),
      ...passAttempt("b", 20, 21),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const [first, second] = outcome.results;
    for (const row of [first, second]) {
      expect(row!.usage.status).toBe("measured");
      if (row!.usage.status === "measured") {
        expect(row!.usage.coverage.conflictTainted).toBe(1);
      }
    }
    if (first!.usage.status === "measured") {
      expect(first!.usage.buckets).toEqual([]);
      expect(first!.usage.coverage.complete).toBe(0);
    }
    // An unrelated clean turn still contributes normally beside it.
    if (second!.usage.status === "measured") {
      expect(second!.usage.coverage.complete).toBe(1);
      expect(second!.usage.buckets).toHaveLength(1);
    }
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("marks a turn observed in two segments ambiguous in both with no tokens", () => {
    const outcome = derive([
      createdEvent(1),
      messageSent(3, "m1"),
      turnStart(4, "m1"),
      sessionSet(5, "turn-s"),
      ownedUsageEvent(6, observation({ runtimeEventId: "rt-1", turnId: "turn-s" })),
      sessionSet(7, null),
      ...passAttempt("a", 10, 11),
      ownedUsageEvent(16, observation({ runtimeEventId: "rt-2", turnId: "turn-s" })),
      ...passAttempt("b", 20, 21),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    for (const row of outcome.results) {
      expect(row.usage.status).toBe("measured");
      if (row.usage.status !== "measured") continue;
      expect(row.usage.coverage.ambiguous).toBe(1);
      expect(row.usage.coverage.complete).toBe(0);
      expect(row.usage.buckets).toEqual([]);
    }
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("counts malformed receipt rows as barriers, never as receipts", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      // The receipt identity claimed without the server writer prefix.
      receiptEvent(6, receipt({ attemptId: "x", revision: 1, anchor: 6 }), {
        commandId: "user:typed-it",
      }),
      // The receipt identity claimed with an undecodable payload.
      receiptEvent(7, { not: "a receipt" }),
      // A same-kind activity under a different id is not this thread's
      // receipt stream at all and is ignored.
      receiptEvent(8, receipt({ attemptId: "y", revision: 1, anchor: 8 }), {
        activityId: `other:${threadId}`,
      }),
      ...passAttempt("a", 10, 11),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.barriers.malformedReceipts).toBe(2);
    expect(outcome.barriers.invalidWindows).toBe(1);
    expect(outcome.results).toHaveLength(1);
    const row = outcome.results[0]!;
    expect(reason(row)).toBe("invalid-receipt-or-window");
    expect(row.segment).toBeNull();
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("ignores prior-incarnation receipts and rejects a stale cross-incarnation anchor", () => {
    const recreated = derive([
      createdEvent(1),
      receiptEvent(2, receipt({ attemptId: "a", revision: 0, anchor: null, phase: "running" })),
      receiptEvent(3, receipt({ attemptId: "a", revision: 1, anchor: 2 })),
      createdEvent(5),
      sessionSet(6, null),
      ...passAttempt("b", 10, 11),
    ]);
    expect(recreated.status).toBe("ok");
    if (recreated.status === "ok") {
      expect(recreated.incarnationSequence).toBe(5);
      expect(recreated.results.map((row) => row.attemptId)).toEqual(["b"]);
      expect(decodeOutcome(recreated)).toBeDefined();
    }

    const stale = derive([
      createdEvent(1),
      receiptEvent(2, receipt({ attemptId: "a", revision: 0, anchor: null, phase: "running" })),
      createdEvent(5),
      sessionSet(6, null),
      // The same attempt continues after recreation; its claimed anchor sits
      // before the incarnation, so the boundary cannot be trusted.
      receiptEvent(10, receipt({ attemptId: "a", revision: 1, anchor: 2 })),
    ]);
    expect(stale.status).toBe("ok");
    if (stale.status === "ok") {
      expect(stale.results).toHaveLength(1);
      expect(reason(stale.results[0]!)).toBe("invalid-receipt-or-window");
      expect(stale.results[0]!.anchorSequence).toBeNull();
      expect(decodeOutcome(stale)).toBeDefined();
    }
  });

  it("counts logical inputs once per submission: pair dedup, reissue, responses, not assistant text", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      messageSent(3, "m1"),
      turnStart(4, "m1"),
      sessionSet(5, "turn-1"),
      sessionSet(6, null),
      // A reissued request for the same message is a distinct input, not a
      // forever-merge by messageId.
      turnStart(7, "m1"),
      sessionSet(8, "turn-1"),
      // Reply actions associate with the live turn at their position.
      approvalResponse(10),
      userInputResponse(11),
      checkpointRevert(12),
      sessionSet(13, null),
      messageSent(14, "m9", "assistant"),
      ...passAttempt("a", 15, 16),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const row = outcome.results[0]!;
    expect(row.inputs).toBe(5);
    expect(row.usage.status).toBe("measured");
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("overlapping attempts poison both rows: the first sees activity, the second's anchor precedes the prior final", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      receiptEvent(10, receipt({ attemptId: "a", revision: 0, anchor: null, phase: "running" })),
      receiptEvent(12, receipt({ attemptId: "b", revision: 0, anchor: null, phase: "running" })),
      receiptEvent(15, receipt({ attemptId: "a", revision: 1, anchor: 10 })),
      receiptEvent(20, receipt({ attemptId: "b", revision: 1, anchor: 12 })),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.results).toHaveLength(2);
    expect(reason(outcome.results[0]!)).toBe("activity-during-attempt");
    const second = outcome.results[1]!;
    expect(reason(second)).toBe("invalid-receipt-or-window");
    // The overlapping anchor stays inspectable but no numeric segment is invented.
    expect(second.anchorSequence).toBe(12);
    expect(second.segment).toBeNull();
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("counts unscoped and undecodable observations where they are retained", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      messageSent(3, "m1"),
      turnStart(4, "m1"),
      sessionSet(5, "turn-1"),
      ownedUsageEvent(6, { garbled: true }),
      ownedUsageEvent(7, observation({ runtimeEventId: "rt-1", turnId: null })),
      sessionSet(8, null),
      ...passAttempt("a", 10, 11),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const row = outcome.results[0]!;
    expect(row.usage.status).toBe("measured");
    if (row.usage.status === "measured") {
      expect(row.usage.coverage.unscoped).toBe(2);
      expect(row.usage.coverage.complete).toBe(0);
    }
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("counts unrecorded session inventory at its first naming position", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      messageSent(3, "m1"),
      turnStart(4, "m1"),
      sessionSet(5, "turn-z"),
      sessionSet(6, "turn-1"),
      ownedUsageEvent(7, observation({ runtimeEventId: "rt-1", turnId: "turn-1" })),
      sessionSet(8, null),
      ...passAttempt("a", 10, 11),
      messageSent(12, "m2"),
      turnStart(13, "m2"),
      sessionSet(14, "turn-q"),
      sessionSet(15, null),
      ...passAttempt("b", 20, 21),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const [first, second] = outcome.results;
    if (first!.usage.status === "measured") {
      // turn-z was named once, never received a qualifying receipt.
      expect(first!.usage.coverage.unrecorded).toBe(1);
      expect(first!.usage.coverage.complete).toBe(1);
    }
    if (second!.usage.status === "measured") {
      expect(second!.usage.coverage.unrecorded).toBe(1);
      expect(second!.usage.coverage.complete).toBe(0);
    }
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("reports the trailing stretch as counts only after the last result", () => {
    const outcome = derive([
      createdEvent(1),
      sessionSet(2, null),
      ...passAttempt("a", 10, 11),
      messageSent(12, "m2"),
      turnStart(13, "m2"),
      sessionSet(14, "turn-3"),
      ownedUsageEvent(15, observation({ runtimeEventId: "rt-3", turnId: "turn-3" })),
      sessionSet(16, null),
      receiptEvent(17, receipt({ attemptId: "c", revision: 0, anchor: null, phase: "running" })),
      receiptEvent(18, receipt({ attemptId: "c", revision: 1, anchor: 17, checks: [failedCheck] })),
    ]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.results).toHaveLength(1);
    expect(outcome.trailing).toEqual({
      inputs: 1,
      otherAttempts: 1,
      coverage: {
        complete: 1,
        partial: 0,
        unavailable: 0,
        ambiguous: 0,
        conflictTainted: 0,
        unscoped: 0,
        unrecorded: 0,
        lateUnattributed: 0,
      },
    });
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("returns missing-create when no thread.created is retained, never a zero report", () => {
    const outcome = derive([
      ownedUsageEvent(2, observation({ runtimeEventId: "rt-1", turnId: "turn-1" })),
    ]);

    expect(outcome).toEqual({
      status: "missing-create",
      threadId,
      readThroughSequence: 200,
    });
    expect(decodeOutcome(outcome)).toBeDefined();
  });

  it("emits null recordedSpan when a segment holds no committed input, but keeps checksMs", () => {
    const outcome = derive([createdEvent(1), sessionSet(2, null), ...passAttempt("a", 10, 11)]);

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const row = outcome.results[0]!;
    expect(row.inputs).toBe(0);
    expect(row.recordedSpan).toEqual({
      recordedSpanMs: null,
      timeBasis: "recorded-event-timestamps",
    });
    expect(row.checksMs).toBe(CHECKS_MS);
    expect(decodeOutcome(outcome)).toBeDefined();
  });
});
