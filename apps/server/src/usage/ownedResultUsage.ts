import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  deriveSelectedCheckState,
  type EventId,
  type OrchestrationEvent,
  type OwnedMainUsageBucketV1,
  type OwnedResultCoverageV1,
  type OwnedResultUnmeasurableReason,
  type OwnedResultUsageOutcome,
  type OwnedResultUsageV1,
  type OwnedUsageBucketScopeV1,
  parseSelectedCheckInstant,
  SELECTED_CHECK_RECEIPT_KIND,
  SelectedCheckReceipt,
  selectedCheckReceiptId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";

import type { OrchestrationEventStoreError } from "../persistence/Errors.ts";
import { SELECTED_CHECK_RECEIPT_COMMAND_PREFIX } from "../persistence/ProjectSkills.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { OWNED_USAGE_ACTIVITY_KIND } from "./ownedUsage.schema.ts";
import {
  foldChildDeliveries,
  type OwnedUsageStoreError,
  readOwnedThreadEventWindow,
  reconcileOwnedUsageMains,
  scanEvents,
  scopedClaim,
  stableKey,
  zeroSubtotal,
} from "./ownedUsage.ts";

/**
 * ## Public API (stable for the reader/RPC consumer)
 *
 * `deriveOwnedResultUsage` is the pure deterministic reducer this module
 * exports. Its exact signature:
 *
 * ```ts
 * deriveOwnedResultUsage(input: {
 *   readonly threadId: ThreadId;
 *   readonly readThroughSequence: number;
 *   readonly events: ReadonlyArray<OrchestrationEvent>;
 * }): OwnedResultUsageOutcome
 * ```
 *
 * Preconditions: `events` are this thread aggregate's retained events in
 * ascending sequence order (the same replay `readOwnedThreadUsage`
 * consumes); `readThroughSequence` is the caller's captured head — events
 * past it are ignored and every reported position is "as of" that bound.
 * No `thread.created` in range returns `missing-create`; `too-large` is
 * produced only by `readOwnedResultUsage` (the shared captured-head
 * bounded window read) before this reducer is ever called.
 *
 * Scope: a "result" is a selected-check attempt whose highest retained
 * revision derives `all-selected-passed` via `deriveSelectedCheckState`
 * on an authentic server-written receipt — the exact receipt activity
 * id+kind, the `server:selected-checks:` command prefix, and a same-thread
 * `SelectedCheckReceipt` decode. Rows wearing that identity without those
 * properties are malformed barriers, never receipts. This reports
 * selected-check passes only — not full verified-result acceptance.
 * Unmeasurable cases report a named reason, never a zero; numeric usage
 * exists only inside source-scoped buckets per measured segment; nothing
 * sums across results, main+child, or time.
 */

const decodeReceipt = Schema.decodeUnknownOption(SelectedCheckReceipt);

/** One decodable server-written receipt write and its retained position. */
type ReceiptWrite = {
  readonly sequence: number;
  readonly eventId: EventId;
  readonly occurredAt: string;
  readonly receipt: SelectedCheckReceipt;
};

/** A committed logical user input and its retained position. */
type LogicalInput = {
  readonly sequence: number;
  readonly occurredAt: string;
};

/**
 * One retained session-set reduced to what lifecycle verdicts need: which
 * provider source wrote it and whether it showed a live turn. A source is
 * (driver, instance) — the same tuple `scanEvents` uses for turn
 * inventory; `identified` requires both halves — a record missing either
 * can neither positively associate a pending request nor positively
 * settle a turn for these purposes.
 */
type SessionSetRecord = {
  readonly sequence: number;
  readonly sourceKey: string;
  readonly identified: boolean;
  readonly activeTurnId: TurnId | null;
};

/**
 * One position in the merged input+lifecycle replay the per-anchor cursor
 * consumes. Message/request pairing is replayed positionally so a link
 * formed after an anchor can never rewrite that anchor's pending state.
 */
type LifecycleEvent =
  | { readonly kind: "message"; readonly sequence: number; readonly messageId: string }
  | { readonly kind: "request"; readonly sequence: number; readonly messageId: string }
  | { readonly kind: "action"; readonly sequence: number }
  | { readonly kind: "session"; readonly record: SessionSetRecord };

/** First index at which `seqs` (ascending) holds a value greater than `lo`. */
const firstIndexAbove = (seqs: ReadonlyArray<number>, lo: number): number => {
  let low = 0;
  let high = seqs.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (seqs[mid]! <= lo) low = mid + 1;
    else high = mid;
  }
  return low;
};

const inOpenRange = (seqs: ReadonlyArray<number>, loExclusive: number, hiExclusive: number) => {
  const index = firstIndexAbove(seqs, loExclusive);
  return index < seqs.length && seqs[index]! < hiExclusive;
};

const countInHalfRange = (seqs: ReadonlyArray<number>, loExclusive: number, hiInclusive: number) =>
  firstIndexAbove(seqs, hiInclusive) - firstIndexAbove(seqs, loExclusive);

/**
 * One attempt's retained receipt history resolved against the incarnation.
 * `anchor` is the first write's own sequence and only trustworthy when that
 * write carries the expected null anchor and every later write points back
 * to it; `candidate` means the highest retained revision passes.
 */
type ResolvedAttempt = {
  readonly attemptId: string;
  readonly writes: ReadonlyArray<ReceiptWrite>;
  readonly anchor: number | null;
  readonly provenanceIntact: boolean;
  readonly revisionsOrdered: boolean;
  /** Retained positions of writes whose revision trails an earlier write. */
  readonly lateWriteSeqs: ReadonlyArray<number>;
  readonly conflicted: boolean;
  readonly candidate: boolean;
  readonly revision: number;
  readonly finalWrite: ReceiptWrite;
  readonly lastSequence: number;
};

/** Immutable per-attempt identity shared by every revision. */
const receiptProvenanceKey = (receipt: SelectedCheckReceipt): string =>
  stableKey([
    receipt.threadId,
    receipt.attemptId,
    receipt.context,
    receipt.planned,
    receipt.environment,
    receipt.startedAt,
  ]);

/**
 * The start tree is write-once: the worker captures it after the
 * anchoring revision 0, so pre-capture writes carry `not-captured` with
 * no repo identity at revisions strictly below every captured write, and
 * all captured writes agree on one value. `unsupported` is a captured
 * value and freezes like `complete`. Revisions order the transition;
 * retained-sequence violations stay with `lateWriteSeqs`.
 */
const startCaptureIntact = (writes: ReadonlyArray<ReceiptWrite>): boolean => {
  let capturedPairKey: string | null = null;
  let minCapturedRevision = Number.POSITIVE_INFINITY;
  let maxUncapturedRevision = -1;
  for (const write of writes) {
    const { atStart, repoAtStart } = write.receipt.tree;
    if (atStart.kind === "not-captured") {
      // A pre-capture write carries no repo identity at all.
      if (repoAtStart !== null) return false;
      if (write.receipt.revision > maxUncapturedRevision) {
        maxUncapturedRevision = write.receipt.revision;
      }
      continue;
    }
    const pairKey = stableKey([atStart, repoAtStart]);
    if (capturedPairKey === null) {
      capturedPairKey = pairKey;
    } else if (pairKey !== capturedPairKey) {
      return false;
    }
    if (write.receipt.revision < minCapturedRevision) {
      minCapturedRevision = write.receipt.revision;
    }
  }
  return maxUncapturedRevision < minCapturedRevision;
};

const instantMs = (value: unknown): number | null => {
  const instant = parseSelectedCheckInstant(value);
  return instant === null ? null : DateTime.toEpochMillis(instant);
};

/** A nonnegative integer millisecond difference between two recorded stamps. */
const nonNegativeSpanMs = (start: unknown, end: unknown): number | null => {
  const startMs = instantMs(start);
  const endMs = instantMs(end);
  if (startMs === null || endMs === null) return null;
  const diff = endMs - startMs;
  return Number.isSafeInteger(diff) && diff >= 0 ? diff : null;
};

const resolveAttempt = (
  attemptId: string,
  writes: ReadonlyArray<ReceiptWrite>,
): ResolvedAttempt => {
  const ordered = writes.toSorted((left, right) => left.sequence - right.sequence);
  const first = ordered[0]!;
  // The anchor is the first write's own sequence: only a null anchor on
  // that write plus a consistent pointer on every later write proves it.
  const anchored =
    first.receipt.threadAnchorSequence === null &&
    ordered.every(
      (write, index) => index === 0 || write.receipt.threadAnchorSequence === first.sequence,
    );
  const provenance = receiptProvenanceKey(first.receipt);
  const provenanceIntact =
    ordered.every((write) => receiptProvenanceKey(write.receipt) === provenance) &&
    startCaptureIntact(ordered);
  // A write whose revision trails an earlier-positioned one is an invalid
  // receipt write: it keeps its retained position so it also poisons any
  // later window that would span it.
  const lateWriteSeqs: Array<number> = [];
  let maxRevision = -1;
  for (const write of ordered) {
    if (write.receipt.revision < maxRevision) {
      lateWriteSeqs.push(write.sequence);
    } else {
      maxRevision = write.receipt.revision;
    }
  }
  const revisionsOrdered = lateWriteSeqs.length === 0;
  const byRevision = new Map<number, Array<ReceiptWrite>>();
  for (const write of ordered) {
    const group = byRevision.get(write.receipt.revision);
    if (group === undefined) {
      byRevision.set(write.receipt.revision, [write]);
    } else {
      group.push(write);
    }
  }
  // Same-revision conflicts are judged over the whole incarnation before
  // the highest revision is ever selected, so a conflicted lower revision
  // cannot be hidden by a clean higher one.
  let conflicted = false;
  let highestRevision = -1;
  for (const [revision, group] of byRevision) {
    if (new Set(group.map((write) => stableKey(write.receipt))).size > 1) {
      conflicted = true;
    }
    if (revision > highestRevision) highestRevision = revision;
  }
  const top = byRevision.get(highestRevision)!;
  const topVariants = [...new Map(top.map((write) => [stableKey(write.receipt), write])).values()];
  const candidate = topVariants.some(
    (write) =>
      deriveSelectedCheckState({
        kind: "present",
        receipt: write.receipt,
        sequence: write.sequence,
      }).state === "all-selected-passed",
  );
  return {
    attemptId,
    writes: ordered,
    anchor: anchored ? first.sequence : null,
    provenanceIntact,
    revisionsOrdered,
    lateWriteSeqs,
    conflicted,
    candidate,
    revision: highestRevision,
    // Deterministic representative for identity: the latest retained
    // sequence of the highest revision, matching identical-fold behavior.
    finalWrite: top[top.length - 1]!,
    lastSequence: ordered[ordered.length - 1]!.sequence,
  };
};

/**
 * Private mutable view of the wire coverage record — the reducer
 * accumulates into this and it flows out under the readonly
 * `OwnedResultCoverageV1` shape unchanged.
 */
type MutableResultCoverage = { -readonly [K in keyof OwnedResultCoverageV1]: number };

const zeroCoverage = (): MutableResultCoverage => ({
  complete: 0,
  partial: 0,
  unavailable: 0,
  ambiguous: 0,
  conflictTainted: 0,
  unscoped: 0,
  unrecorded: 0,
  lateUnattributed: 0,
});

/**
 * A claimable stretch of the current incarnation: one measured result's
 * work segment or the trailing tail. Positions inside unmeasurable rows'
 * spans and attempt windows belong to no claimable stretch — work there is
 * contested and simply never becomes a number.
 */
type Stretch = {
  readonly fromSequenceExclusive: number;
  readonly toSequenceInclusive: number;
  readonly coverage: MutableResultCoverage;
  readonly buckets: Map<
    string,
    {
      scope: OwnedUsageBucketScopeV1;
      subtotal: ReturnType<typeof zeroSubtotal>;
    }
  >;
  childFrames: number;
  legacyChildFrames: number;
};

const newStretch = (fromSequenceExclusive: number, toSequenceInclusive: number): Stretch => ({
  fromSequenceExclusive,
  toSequenceInclusive,
  coverage: zeroCoverage(),
  buckets: new Map(),
  childFrames: 0,
  legacyChildFrames: 0,
});

const inStretch = (stretch: Stretch, sequence: number): boolean =>
  sequence > stretch.fromSequenceExclusive && sequence <= stretch.toSequenceInclusive;

export const deriveOwnedResultUsage = (input: {
  readonly threadId: ThreadId;
  readonly readThroughSequence: number;
  readonly events: ReadonlyArray<OrchestrationEvent>;
}): OwnedResultUsageOutcome => {
  const { threadId, readThroughSequence } = input;
  const events = input.events.filter(
    (event) =>
      event.aggregateKind === "thread" &&
      event.aggregateId === threadId &&
      event.sequence <= readThroughSequence,
  );
  const incarnation = events.findLast((event) => event.type === "thread.created");
  if (incarnation === undefined) {
    const outcome: OwnedResultUsageOutcome = {
      status: "missing-create",
      threadId,
      readThroughSequence,
    };
    return outcome;
  }
  const current = events.filter((event) => event.sequence > incarnation.sequence);
  const head = readThroughSequence;

  // Whole-incarnation views, resolved once: the shared usage reconciliation
  // supplies turn/scope/conflict truth for every window at once.
  const scan = scanEvents(current, "current");
  const reconciled = reconcileOwnedUsageMains(scan.mains);
  const childFolds = foldChildDeliveries(scan.childFrames);

  // Event-class pass: committed inputs (with message/request pairing),
  // session lifecycle, receipt writes, malformed barriers, usage activity.
  // `logicalInputs` pairs each user message with its linked turn-start
  // request for the `inputs` count and recorded span; `rawInputSeqs` keeps
  // every committed input's own retained position — boundaries and
  // contamination always read the raw list, so a request separated from
  // its message by the attempt boundary still closes the window it sits
  // in. `lifecycleEvents` preserves the merged input/session order for the
  // per-anchor replay below: pending-at-anchor state is positional, never
  // rewritten by a pairing or start retained after the anchor.
  const logicalInputs: Array<LogicalInput> = [];
  const rawInputSeqs: Array<number> = [];
  const openUserMessages = new Map<string, Array<LogicalInput>>();
  const lifecycleEvents: Array<LifecycleEvent> = [];
  const sessionSets: Array<SessionSetRecord> = [];
  const writesByAttempt = new Map<string, Array<ReceiptWrite>>();
  const malformedBarrierSeqs: Array<number> = [];
  const usageActivitySeqs: Array<number> = [];
  const receiptActivityId = selectedCheckReceiptId(threadId);

  for (const event of current) {
    if (event.type === "thread.message-sent") {
      if (event.payload.role !== "user") continue;
      rawInputSeqs.push(event.sequence);
      lifecycleEvents.push({
        kind: "message",
        sequence: event.sequence,
        messageId: event.payload.messageId,
      });
      const entry = { sequence: event.sequence, occurredAt: event.occurredAt };
      const pending = openUserMessages.get(event.payload.messageId);
      if (pending === undefined) {
        openUserMessages.set(event.payload.messageId, [entry]);
      } else {
        pending.push(entry);
      }
      continue;
    }
    if (event.type === "thread.turn-start-requested") {
      rawInputSeqs.push(event.sequence);
      lifecycleEvents.push({
        kind: "request",
        sequence: event.sequence,
        messageId: event.payload.messageId,
      });
      // Pair with the earliest unconsumed user message carrying the same
      // messageId — one logical submission at the message's position. A
      // reissued request finds no unpaired message and counts on its own.
      const pending = openUserMessages.get(event.payload.messageId);
      const paired = pending !== undefined && pending.length > 0 ? pending.shift()! : undefined;
      if (pending !== undefined && pending.length === 0) {
        openUserMessages.delete(event.payload.messageId);
      }
      logicalInputs.push(paired ?? { sequence: event.sequence, occurredAt: event.occurredAt });
      continue;
    }
    if (
      event.type === "thread.approval-response-requested" ||
      event.type === "thread.user-input-response-requested" ||
      event.type === "thread.checkpoint-revert-requested"
    ) {
      rawInputSeqs.push(event.sequence);
      lifecycleEvents.push({ kind: "action", sequence: event.sequence });
      logicalInputs.push({ sequence: event.sequence, occurredAt: event.occurredAt });
      continue;
    }
    if (event.type === "thread.session-set") {
      const session = event.payload.session;
      const record: SessionSetRecord = {
        sequence: event.sequence,
        sourceKey: stableKey([session.providerName, session.providerInstanceId ?? null]),
        identified: session.providerName !== null && session.providerInstanceId !== undefined,
        activeTurnId: session.activeTurnId,
      };
      sessionSets.push(record);
      lifecycleEvents.push({ kind: "session", record });
      continue;
    }
    if (event.type !== "thread.activity-appended") continue;
    const activity = event.payload.activity;
    if (
      activity.kind === OWNED_USAGE_ACTIVITY_KIND ||
      ((activity.kind === "task.progress" || activity.kind === "task.completed") &&
        Predicate.isObject(activity.payload) &&
        activity.payload.typedUsage !== undefined)
    ) {
      usageActivitySeqs.push(event.sequence);
    }
    if (activity.id !== receiptActivityId || activity.kind !== SELECTED_CHECK_RECEIPT_KIND) {
      continue;
    }
    const receipt = Option.getOrNull(decodeReceipt(activity.payload));
    // The row wears this thread's exact receipt identity, so anything short
    // of a fully verified server write is a barrier at its retained
    // position — never silently dropped, never a receipt.
    if (
      event.payload.threadId !== threadId ||
      event.commandId === null ||
      !event.commandId.startsWith(SELECTED_CHECK_RECEIPT_COMMAND_PREFIX) ||
      receipt === null ||
      receipt.threadId !== threadId
    ) {
      malformedBarrierSeqs.push(event.sequence);
      continue;
    }
    const writes = writesByAttempt.get(receipt.attemptId);
    if (writes === undefined) {
      writesByAttempt.set(receipt.attemptId, [
        {
          sequence: event.sequence,
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          receipt,
        },
      ]);
    } else {
      writes.push({
        sequence: event.sequence,
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        receipt,
      });
    }
  }
  for (const pending of openUserMessages.values()) {
    for (const entry of pending) {
      logicalInputs.push(entry);
    }
  }
  logicalInputs.sort((left, right) => left.sequence - right.sequence);
  const logicalInputSeqs = logicalInputs.map((entry) => entry.sequence);

  const attempts = [...writesByAttempt.entries()].map(([attemptId, writes]) =>
    resolveAttempt(attemptId, writes),
  );
  const candidates = attempts
    .filter((attempt) => attempt.candidate)
    .toSorted((left, right) => left.finalWrite.sequence - right.finalWrite.sequence);
  const failedAttempts = attempts.filter((attempt) => !attempt.candidate);
  const failedAttemptLastSeqs = failedAttempts
    .map((attempt) => attempt.lastSequence)
    .toSorted((left, right) => left - right);
  // Sorted retained positions for range lookups: a receipt write of any
  // other attempt inside the window is activity, and malformed rows plus
  // late out-of-order writes are barriers at their actual positions.
  const attemptWritePositions = attempts
    .flatMap((attempt) =>
      attempt.writes.map((write) => ({
        sequence: write.sequence,
        attemptId: attempt.attemptId,
      })),
    )
    .toSorted((left, right) => left.sequence - right.sequence);
  const invalidReceiptWriteSeqs = [
    ...malformedBarrierSeqs,
    ...attempts.flatMap((attempt) => attempt.lateWriteSeqs),
  ].toSorted((left, right) => left - right);
  const foreignWriteInRange = (loExclusive: number, hiExclusive: number, attemptId: string) => {
    let low = 0;
    let high = attemptWritePositions.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (attemptWritePositions[mid]!.sequence <= loExclusive) low = mid + 1;
      else high = mid;
    }
    for (
      let index = low;
      index < attemptWritePositions.length && attemptWritePositions[index]!.sequence < hiExclusive;
      index += 1
    ) {
      if (attemptWritePositions[index]!.attemptId !== attemptId) return true;
    }
    return false;
  };

  // Pending/lifecycle replay state, advanced once in retained order up to
  // each checked anchor: per-source live turns, ambiguous settlements,
  // still-open user messages, requests awaiting a positive start, and
  // whether any reply action lacked a live turn at its own position.
  let lifecycleCursor = 0;
  const live = new Map<string, TurnId>();
  const ambiguous = new Set<string>();
  const openInput = new Map<string, Array<number>>();
  const pendingRequests: Array<number> = [];
  let pendingHead = 0;
  let sawUnassociatedAction = false;
  let insidePeek = 0;

  // Classify each candidate in retained final order. Reason precedence:
  // receipt/window integrity, revision conflicts, then live contamination
  // and unresolved lifecycle — one closed reason per row.
  type RowDraft =
    | {
        readonly attempt: ResolvedAttempt;
        readonly spanFrom: number;
        readonly reason: OwnedResultUnmeasurableReason;
        readonly stretch: null;
      }
    | {
        readonly attempt: ResolvedAttempt;
        readonly spanFrom: number;
        readonly reason: null;
        readonly stretch: Stretch;
      };
  const drafts: Array<RowDraft> = [];
  const stretches: Array<Stretch> = [];
  let previousFinal = incarnation.sequence;
  let invalidWindowRows = 0;
  for (const attempt of candidates) {
    const final = attempt.finalWrite.sequence;
    let reason: OwnedResultUnmeasurableReason | null = null;
    if (attempt.anchor === null || !attempt.provenanceIntact || !attempt.revisionsOrdered) {
      reason = "invalid-receipt-or-window";
    } else if (
      attempt.anchor <= previousFinal ||
      inOpenRange(invalidReceiptWriteSeqs, previousFinal, final)
    ) {
      // An anchor at/before the prior boundary means overlapping windows; a
      // malformed row or late out-of-order write in the contested span
      // poisons the whole stretch at its actual retained position.
      reason = "invalid-receipt-or-window";
    } else if (attempt.conflicted) {
      reason = "revision-conflict";
    } else {
      const anchor = attempt.anchor;
      const contaminated =
        inOpenRange(rawInputSeqs, anchor, final) ||
        inOpenRange(usageActivitySeqs, anchor, final) ||
        foreignWriteInRange(anchor, final, attempt.attemptId);
      if (contaminated) {
        reason = "activity-during-attempt";
      } else {
        // Replay the merged input/session stream strictly before this
        // anchor. Anchors of candidates reaching this point are strictly
        // increasing, so the single cursor covers every verdict.
        while (lifecycleCursor < lifecycleEvents.length) {
          const item = lifecycleEvents[lifecycleCursor]!;
          const itemSequence = item.kind === "session" ? item.record.sequence : item.sequence;
          if (itemSequence >= anchor) break;
          lifecycleCursor += 1;
          if (item.kind === "message") {
            const open = openInput.get(item.messageId);
            if (open === undefined) {
              openInput.set(item.messageId, [item.sequence]);
            } else {
              open.push(item.sequence);
            }
            continue;
          }
          if (item.kind === "request") {
            const open = openInput.get(item.messageId);
            if (open !== undefined && open.length > 0) open.shift();
            if (open !== undefined && open.length === 0) {
              openInput.delete(item.messageId);
            }
            // Every request joins the pending queue; a distinct positive
            // start resolves at most the earliest eligible one.
            pendingRequests.push(item.sequence);
            continue;
          }
          if (item.kind === "action") {
            // A reply action associates with the turn live at its own
            // position; without one it is unassociated history.
            if (live.size === 0) sawUnassociatedAction = true;
            continue;
          }
          const set = item.record;
          if (set.activeTurnId !== null) {
            // A distinct start is a source newly showing this turn live;
            // re-observing the same live turn is one start, not two.
            const alreadyLive = live.get(set.sourceKey) === set.activeTurnId;
            live.set(set.sourceKey, set.activeTurnId);
            if (set.identified) {
              ambiguous.delete(set.sourceKey);
              // One distinct start settles at most one pending request —
              // a repeated active record cannot manufacture another.
              if (!alreadyLive && pendingHead < pendingRequests.length) pendingHead += 1;
            } else {
              // An unattributable live claim: present but its ownership
              // cannot be proven.
              ambiguous.add(set.sourceKey);
            }
            continue;
          }
          // A null set ends only its own source's turn; a null settling
          // nothing known leaves surviving live turns unproven.
          const settledOwn = live.delete(set.sourceKey);
          ambiguous.delete(set.sourceKey);
          if (!settledOwn) {
            for (const key of live.keys()) ambiguous.add(key);
          }
        }
        if (live.size > 0) {
          reason = [...live.keys()].some((key) => ambiguous.has(key))
            ? "unresolved-ownership-or-history"
            : "turn-active-at-attempt";
        } else {
          // Checked rows have disjoint ascending (anchor, final) windows,
          // so the peek index only moves forward without consuming.
          while (insidePeek < sessionSets.length && sessionSets[insidePeek]!.sequence <= anchor) {
            insidePeek += 1;
          }
          let activeInside = false;
          for (
            let index = insidePeek;
            index < sessionSets.length && sessionSets[index]!.sequence < final;
            index += 1
          ) {
            if (sessionSets[index]!.activeTurnId !== null) {
              activeInside = true;
              break;
            }
          }
          if (activeInside) {
            reason = "turn-active-at-attempt";
          } else if (
            openInput.size > 0 ||
            pendingHead < pendingRequests.length ||
            sawUnassociatedAction
          ) {
            reason = "unresolved-ownership-or-history";
          }
        }
      }
    }
    if (reason === "invalid-receipt-or-window") invalidWindowRows += 1;
    if (reason === null) {
      // The chain above guarantees `anchor` is non-null on this path.
      const stretch = newStretch(previousFinal, attempt.anchor!);
      stretches.push(stretch);
      drafts.push({ attempt, spanFrom: previousFinal, reason, stretch });
    } else {
      drafts.push({ attempt, spanFrom: previousFinal, reason, stretch: null });
    }
    previousFinal = final;
  }
  const trailingStretch = newStretch(previousFinal, head);
  stretches.push(trailingStretch);
  // Stretches are disjoint and pushed in ascending boundary order, so a
  // position resolves to its stretch by bisecting the start boundaries.
  const stretchFromSeqs = stretches.map((stretch) => stretch.fromSequenceExclusive);
  const stretchFor = (sequence: number): Stretch | undefined => {
    const index = firstIndexAbove(stretchFromSeqs, sequence) - 1;
    if (index < 0) return undefined;
    const stretch = stretches[index]!;
    return inStretch(stretch, sequence) ? stretch : undefined;
  };

  // Attribute the shared reconciled view into the claimable stretches.
  // Tainted turns are counted once per touched stretch whether or not a
  // clean claim also exists: a conflict-only turn is present only in
  // taintedTurns/conflicts, so it must be visited from that map — the
  // clean pass below skips every tainted key.
  for (const [taintedKey, tainted] of reconciled.taintedTurns) {
    const clean = reconciled.scopedTurns.get(taintedKey);
    const touched = new Set<Stretch>();
    for (const sequence of [
      ...(clean === undefined ? [] : clean.claims.map((main) => main.ref.sequence)),
      ...tainted.alternatives.map((alternative) => alternative.observation.sequence),
    ]) {
      const stretch = stretchFor(sequence);
      if (stretch !== undefined) touched.add(stretch);
    }
    for (const stretch of touched) {
      stretch.coverage.conflictTainted += 1;
    }
  }
  for (const group of reconciled.scopedTurns.values()) {
    if (reconciled.taintedTurns.has(stableKey([group.scopeKey, group.turnId]))) continue;
    if (group.claims.length > 1) {
      const touched = new Set<Stretch>();
      for (const main of group.claims) {
        const stretch = stretchFor(main.ref.sequence);
        if (stretch !== undefined) touched.add(stretch);
      }
      for (const stretch of touched) {
        stretch.coverage.ambiguous += 1;
      }
      continue;
    }
    const single = group.claims[0]!;
    const stretch = stretchFor(single.ref.sequence);
    if (stretch === undefined) continue;
    // The turn's retained start where established: the first session-set
    // naming this exact (driver, instance, turn) scope. A receipt that
    // lands without it, or outside it, is late/unattributed coverage.
    const startSeq = scan.turnInventory.get(
      stableKey([group.scope.driver, group.scope.instanceId, group.turnId]),
    );
    if (startSeq === undefined || !inStretch(stretch, startSeq)) {
      stretch.coverage.lateUnattributed += 1;
      continue;
    }
    const usage = single.observation.usage;
    if (usage.usageStatus === "complete") {
      stretch.coverage.complete += 1;
      let bucket = stretch.buckets.get(group.scopeKey);
      if (bucket === undefined) {
        bucket = { scope: group.scope, subtotal: zeroSubtotal() };
        stretch.buckets.set(group.scopeKey, bucket);
      }
      bucket.subtotal.completeTurns += 1;
      bucket.subtotal.inputTokens += usage.inputTokens;
      bucket.subtotal.outputTokens += usage.outputTokens;
      if (usage.cachedInputTokens !== undefined) {
        bucket.subtotal.cachedInputTokens.sum += usage.cachedInputTokens;
        bucket.subtotal.cachedInputTokens.reportedTurns += 1;
      }
      if (usage.cacheCreationTokens !== undefined) {
        bucket.subtotal.cacheCreationTokens.sum += usage.cacheCreationTokens;
        bucket.subtotal.cacheCreationTokens.reportedTurns += 1;
      }
      if (usage.reasoningTokens !== undefined) {
        bucket.subtotal.reasoningTokens.sum += usage.reasoningTokens;
        bucket.subtotal.reasoningTokens.reportedTurns += 1;
      }
    } else if (usage.usageStatus === "partial") {
      stretch.coverage.partial += 1;
    } else {
      stretch.coverage.unavailable += 1;
    }
  }
  // Observations that could never claim a scope: clean unscoped deliveries,
  // unscoped conflict variants, and undecodable usage records.
  const unscopedPositions: Array<number> = [
    ...reconciled.unscopedObservations.map((main) => main.ref.sequence),
    ...reconciled.conflicts.flatMap((conflict) =>
      conflict.alternatives
        .filter((alternative) => scopedClaim(alternative.observation) === null)
        .map((alternative) => alternative.observationRef.sequence),
    ),
    ...scan.invalidSequences,
  ];
  for (const sequence of unscopedPositions) {
    const stretch = stretchFor(sequence);
    if (stretch !== undefined) stretch.coverage.unscoped += 1;
  }
  // Session inventory with no qualifying receipt, placed once at its first
  // naming position — never one synthetic turn per input.
  for (const [tuple, firstSeq] of scan.turnInventory) {
    if (reconciled.receipts.has(tuple)) continue;
    const stretch = stretchFor(firstSeq);
    if (stretch !== undefined) stretch.coverage.unrecorded += 1;
  }
  // Child frames fold globally by delivery, then count by retained
  // position; legacy rows count under their own coverage bucket.
  for (const { group, folded } of childFolds.values()) {
    const positions = folded ? [group[0]!.sequence] : group.map((frame) => frame.sequence);
    for (const sequence of positions) {
      const stretch = stretchFor(sequence);
      if (stretch !== undefined) stretch.childFrames += 1;
    }
  }
  for (const sequence of scan.legacyChildFrameSequences) {
    const stretch = stretchFor(sequence);
    if (stretch !== undefined) stretch.legacyChildFrames += 1;
  }

  // Build rows in final order over the classified drafts.
  const results: Array<OwnedResultUsageV1> = [];
  const conflictOrInvalid = new Set<OwnedResultUnmeasurableReason>([
    "revision-conflict",
    "invalid-receipt-or-window",
  ]);
  for (const draft of drafts) {
    const { attempt, spanFrom, reason } = draft;
    const final = attempt.finalWrite.sequence;
    const anchorSequence =
      attempt.anchor !== null && attempt.anchor <= final ? attempt.anchor : null;
    // A numeric segment is emitted only when the boundary itself was
    // structurally sound; invalid-boundary rows never invent window bounds.
    const segment =
      anchorSequence !== null && reason !== "invalid-receipt-or-window"
        ? { fromSequenceExclusive: spanFrom, toSequenceExclusive: anchorSequence }
        : null;
    const nullTimes = reason !== null && conflictOrInvalid.has(reason);
    const checksMs = nullTimes
      ? null
      : nonNegativeSpanMs(attempt.finalWrite.receipt.startedAt, attempt.finalWrite.receipt.endedAt);
    const firstInputIndex =
      segment === null
        ? logicalInputSeqs.length
        : firstIndexAbove(logicalInputSeqs, segment.fromSequenceExclusive);
    const firstInput =
      segment === null ||
      firstInputIndex >= logicalInputs.length ||
      logicalInputSeqs[firstInputIndex]! >= segment.toSequenceExclusive
        ? undefined
        : logicalInputs[firstInputIndex];
    const recordedSpanMs =
      nullTimes || firstInput === undefined
        ? null
        : nonNegativeSpanMs(firstInput.occurredAt, attempt.finalWrite.occurredAt);
    const usage: OwnedResultUsageV1["usage"] =
      draft.reason === null
        ? {
            status: "measured",
            coverage: draft.stretch.coverage,
            buckets: [...draft.stretch.buckets.values()].map((bucket): OwnedMainUsageBucketV1 => ({
              scope: bucket.scope,
              reportedCompleteSubtotal: bucket.subtotal,
            })),
            childFrames: draft.stretch.childFrames,
            legacyChildFrames: draft.stretch.legacyChildFrames,
          }
        : { status: "unmeasurable", reason: draft.reason };
    results.push({
      attemptId: attempt.attemptId,
      revision: attempt.revision,
      finalEventId: attempt.finalWrite.eventId,
      finalSequence: final,
      anchorSequence,
      segment,
      inputs: countInHalfRange(logicalInputSeqs, spanFrom, final),
      otherAttempts: countInHalfRange(failedAttemptLastSeqs, spanFrom, final),
      recordedSpan: { recordedSpanMs, timeBasis: "recorded-event-timestamps" },
      checksMs,
      usage,
      billedCost: "unknown",
      parentChildOverlap: "unknown",
    });
  }

  const trailingBarrierIndex = firstIndexAbove(invalidReceiptWriteSeqs, previousFinal);
  const trailingBarrier =
    trailingBarrierIndex < invalidReceiptWriteSeqs.length &&
    invalidReceiptWriteSeqs[trailingBarrierIndex]! <= head;
  const outcome: OwnedResultUsageOutcome = {
    status: "ok",
    threadId,
    readThroughSequence: head,
    incarnationSequence: incarnation.sequence,
    barriers: {
      malformedReceipts: malformedBarrierSeqs.length,
      // One count per window that can never become numeric: each
      // invalid-boundary row plus a trailing stretch holding a barrier.
      invalidWindows: invalidWindowRows + (trailingBarrier ? 1 : 0),
    },
    results,
    trailing: {
      inputs: countInHalfRange(logicalInputSeqs, previousFinal, head),
      otherAttempts: countInHalfRange(failedAttemptLastSeqs, previousFinal, head),
      coverage: trailingStretch.coverage,
    },
  };
  return outcome;
};

/**
 * Read one thread's owned result usage through the real event store, over
 * the same captured-head bounded window as `readOwnedThreadUsage`.
 * `options.maxEvents` overrides `OWNED_USAGE_MAX_EVENTS` for tests.
 */
export const readOwnedResultUsage = Effect.fn("ownedResultUsage.readOwnedResultUsage")(function* (
  threadId: ThreadId,
  options?: { readonly maxEvents?: number },
): Effect.fn.Return<
  OwnedResultUsageOutcome,
  OwnedUsageStoreError | OrchestrationEventStoreError,
  OrchestrationEventStore | SqlClient.SqlClient
> {
  const store = yield* OrchestrationEventStore;
  const sql = yield* SqlClient.SqlClient;
  const window = yield* readOwnedThreadEventWindow(sql, store, threadId, options);
  if (window.status === "too-large") {
    const outcome: OwnedResultUsageOutcome = {
      status: "too-large",
      threadId,
      readThroughSequence: window.head,
      eventCount: window.eventCount,
      payloadBytes: window.payloadBytes,
    };
    return outcome;
  }
  if (window.status === "missing-create") {
    const outcome: OwnedResultUsageOutcome = {
      status: "missing-create",
      threadId,
      readThroughSequence: window.head,
    };
    return outcome;
  }
  return deriveOwnedResultUsage({
    threadId,
    readThroughSequence: window.head,
    events: window.events,
  });
});
