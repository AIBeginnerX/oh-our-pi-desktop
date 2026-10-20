import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectId, ThreadId } from "./baseSchemas.ts";
import type { OrchestrationLatestTurnState } from "./orchestration.ts";
import {
  type ProjectSkillCheckObservation,
  type ProjectSkillContent,
  ProjectSkillContextPayload,
  type ProjectSkillInputObservation,
  type ProjectSkillMode,
  type ProjectSkillReadinessGap,
  type ProjectSkillVersionRef,
  renderProjectSkillBlock,
} from "./projectSkill.ts";
import {
  type SelectedCheckReceipt,
  type SelectedChecksGetResult,
  deriveSelectedCheckState,
} from "./selectedChecks.ts";

/**
 * Pure, fail-closed acceptance checks for project-skill history (S1 lane B).
 * A selected-check receipt is a historical claim about its own attempt window;
 * nothing here inspects the current workspace tree, and nothing here claims a
 * skill was applied or a task is correct — those are separately recorded
 * judgments. Every input event sequence accepted here is a committed
 * user-input acceptance event from the same server's event sequence space.
 */

/**
 * Whether one finished selected-check attempt in this thread may back a new
 * skill version's historical source.
 *
 * `checks` is the thread's `SelectedChecks.get` result verbatim; a record
 * whose receipt names a different thread is malformed for this claim.
 * `expected`
 * pins the exact write the caller observed: attemptId, revision, and the
 * event row sequence must all match, or the record has moved and the claim is
 * rejected as `observation-changed`. `latestInputEventSequence` is the last
 * committed user-input acceptance of this thread incarnation — follow-up
 * responses and added messages included — and a failed event read is never
 * reported as null. Rejection is not a judgment about the current worktree;
 * it only says the historical source claim cannot be made from this record.
 */
export function evaluateSkillSource(f: {
  candidateProjectId: ProjectId;
  thread: {
    threadId: ThreadId;
    projectId: ProjectId;
    worktreePath: string | null;
    latestTurnState: OrchestrationLatestTurnState | null;
  };
  latestInputEventSequence: number | null;
  checks: SelectedChecksGetResult;
  expected: { attemptId: string; revision: number; receiptSequence: number };
}):
  | { ok: true; check: ProjectSkillCheckObservation }
  | {
      ok: false;
      reason:
        | "no-record"
        | "record-malformed"
        | "not-all-selected-passed"
        | "observation-changed"
        | "turn-running"
        | "input-after-checks"
        | "project-mismatch"
        | "worktree-changed"
        | "check-commands-changed";
      detail: ReadonlyArray<string>;
    } {
  if (f.checks.record.kind === "none") {
    return {
      ok: false,
      reason: "no-record",
      detail: ["the thread stores no selected-check record"],
    };
  }
  if (f.checks.record.kind === "malformed") {
    return {
      ok: false,
      reason: "record-malformed",
      detail: ["the stored record is not decodable as written"],
    };
  }
  const { receipt, sequence } = f.checks.record;
  if (receipt.threadId !== f.thread.threadId) {
    return {
      ok: false,
      reason: "record-malformed",
      detail: ["the stored record is bound to another thread"],
    };
  }
  const derived = deriveSelectedCheckState(f.checks.record);
  if (derived.state !== "all-selected-passed") {
    return { ok: false, reason: "not-all-selected-passed", detail: derived.reasons };
  }
  const moved: Array<string> = [];
  if (receipt.attemptId !== f.expected.attemptId) {
    moved.push(
      `the recorded attempt is '${receipt.attemptId}', expected '${f.expected.attemptId}'`,
    );
  }
  if (receipt.revision !== f.expected.revision) {
    moved.push(`the recorded revision is ${receipt.revision}, expected ${f.expected.revision}`);
  }
  if (sequence !== f.expected.receiptSequence) {
    moved.push(`the record row sequence is ${sequence}, expected ${f.expected.receiptSequence}`);
  }
  if (moved.length > 0) return { ok: false, reason: "observation-changed", detail: moved };
  if (f.thread.latestTurnState === "running") {
    return {
      ok: false,
      reason: "turn-running",
      detail: ["the thread's latest turn is still running"],
    };
  }
  // The all-selected-passed claim already proves the anchor is present (the
  // derivation rejects a record missing its event anchor); narrow it back for
  // the type system.
  const anchor = receipt.threadAnchorSequence;
  if (anchor === null) {
    return {
      ok: false,
      reason: "not-all-selected-passed",
      detail: ["the record is missing its event anchor"],
    };
  }
  if (f.latestInputEventSequence !== null && f.latestInputEventSequence >= anchor) {
    return {
      ok: false,
      reason: "input-after-checks",
      detail: [
        `user input event ${f.latestInputEventSequence} is at or after the attempt's first receipt write ${anchor}`,
      ],
    };
  }
  if (
    receipt.context.projectId !== f.thread.projectId ||
    f.thread.projectId !== f.candidateProjectId
  ) {
    return {
      ok: false,
      reason: "project-mismatch",
      detail: [
        `the receipt binds project '${receipt.context.projectId}', the thread binds '${f.thread.projectId}', the candidate binds '${f.candidateProjectId}'`,
      ],
    };
  }
  if (receipt.context.worktreePath !== f.thread.worktreePath) {
    return {
      ok: false,
      reason: "worktree-changed",
      detail: [
        `the receipt ran with worktree ${JSON.stringify(receipt.context.worktreePath)}, the thread now reports ${JSON.stringify(f.thread.worktreePath)}`,
      ],
    };
  }
  if (f.checks.changedScriptIds.length > 0) {
    return {
      ok: false,
      reason: "check-commands-changed",
      detail: f.checks.changedScriptIds.map(
        (scriptId) => `the command of script '${scriptId}' changed after the run`,
      ),
    };
  }
  const treeAtEnd = receipt.tree.atEnd;
  const repoAtEnd = receipt.tree.repoAtEnd;
  if (treeAtEnd.kind !== "complete" || repoAtEnd === null) {
    return {
      ok: false,
      reason: "not-all-selected-passed",
      detail: ["the passed claim lacks its ending tree and repository provenance"],
    };
  }
  return {
    ok: true,
    check: {
      threadId: receipt.threadId,
      threadAnchorSequence: anchor,
      receiptSequence: sequence,
      attemptId: receipt.attemptId,
      revision: receipt.revision,
      projectId: receipt.context.projectId,
      workspaceRoot: receipt.context.workspaceRoot,
      worktreePath: receipt.context.worktreePath,
      cwd: receipt.context.cwd,
      envSha256: receipt.context.envSha256,
      planned: receipt.planned,
      tree: {
        treeOid: treeAtEnd.treeOid,
        repoTopLevel: repoAtEnd.topLevel,
        repoCommonDir: repoAtEnd.commonDir,
      },
      environment: receipt.environment,
      startedAt: receipt.startedAt,
      endedAt: receipt.endedAt,
      outcome: "all-selected-passed",
    },
  };
}

/**
 * Whether one selected-check receipt belongs to one accepted input's use
 * window: the attempt's first receipt write must sit strictly after the input
 * and the terminal write (this event row) strictly before the next user
 * input, so a later input can never inherit this attempt's result.
 *
 * `input` is a server-accepted `ProjectSkillInputObservation`.
 * `threadRecreatedAfterInput` is a trusted event-store answer, not derived
 * from the anchor: `threadAnchorSequence` is named for the thread-recreation
 * check it anchors, but it is the attempt's first receipt write, not the
 * thread's creation sequence, and differs per attempt. The verdict uses the
 * derived record state only — running or incomplete reads as
 * `outcome-incomplete`, never by elapsed time. No clock is consulted.
 */
export function evaluateSkillUseWindow(f: {
  input: ProjectSkillInputObservation;
  receipt: { receipt: SelectedCheckReceipt; sequence: number };
  threadRecreatedAfterInput: boolean;
  nextInputEventSequence: number | null;
}):
  | { ok: true; check: ProjectSkillCheckObservation }
  | {
      ok: false;
      reason:
        | "different-thread"
        | "different-project"
        | "thread-recreated"
        | "anchor-missing"
        | "attempt-before-input"
        | "attempt-after-next-input"
        | "outcome-incomplete";
    } {
  const { receipt, sequence } = f.receipt;
  if (receipt.threadId !== f.input.threadId) return { ok: false, reason: "different-thread" };
  if (receipt.context.projectId !== f.input.projectId) {
    return { ok: false, reason: "different-project" };
  }
  if (f.threadRecreatedAfterInput) return { ok: false, reason: "thread-recreated" };
  const anchor = receipt.threadAnchorSequence;
  if (anchor === null || anchor > sequence) return { ok: false, reason: "anchor-missing" };
  if (anchor <= f.input.inputEventSequence) return { ok: false, reason: "attempt-before-input" };
  if (f.nextInputEventSequence !== null && sequence >= f.nextInputEventSequence) {
    return { ok: false, reason: "attempt-after-next-input" };
  }
  const derived = deriveSelectedCheckState({ kind: "present", ...f.receipt });
  if (derived.state !== "all-selected-passed" && derived.state !== "failed") {
    return { ok: false, reason: "outcome-incomplete" };
  }
  // A passed claim carries the ending tree the derivation proved; a failed one
  // records no tree claim at all.
  let observedTree: ProjectSkillCheckObservation["tree"] = null;
  if (derived.state === "all-selected-passed") {
    const treeAtEnd = receipt.tree.atEnd;
    const repoAtEnd = receipt.tree.repoAtEnd;
    // Unreachable while the derivation owns the pass claim; fail closed.
    if (treeAtEnd.kind !== "complete" || repoAtEnd === null) {
      return { ok: false, reason: "outcome-incomplete" };
    }
    observedTree = {
      treeOid: treeAtEnd.treeOid,
      repoTopLevel: repoAtEnd.topLevel,
      repoCommonDir: repoAtEnd.commonDir,
    };
  }
  return {
    ok: true,
    check: {
      threadId: receipt.threadId,
      threadAnchorSequence: anchor,
      receiptSequence: sequence,
      attemptId: receipt.attemptId,
      revision: receipt.revision,
      projectId: receipt.context.projectId,
      workspaceRoot: receipt.context.workspaceRoot,
      worktreePath: receipt.context.worktreePath,
      cwd: receipt.context.cwd,
      envSha256: receipt.context.envSha256,
      planned: receipt.planned,
      // A failed run never proves tree provenance (the derivation's failed
      // branch skips it), so a failed observation records no tree claim and
      // keeps the receipt's own nullable end time.
      tree: observedTree,
      environment: receipt.environment,
      startedAt: receipt.startedAt,
      endedAt: receipt.endedAt,
      outcome: derived.state,
    },
  };
}

const sameProjectSkillVersionRef = (
  a: ProjectSkillVersionRef,
  b: ProjectSkillVersionRef,
): boolean =>
  a.projectId === b.projectId &&
  a.skillId === b.skillId &&
  a.version === b.version &&
  a.contentSha256 === b.contentSha256;

const countOccurrences = (text: string, needle: string): number =>
  needle === "" ? 0 : text.split(needle).length - 1;

/**
 * Whether one send may carry its managed project-skill items, and with which
 * version refs and modes. `items` holds the send's composer records whose
 * kind is `PROJECT_SKILL_CONTEXT_KIND`, already filtered by the caller; the
 * payload must decode, bind this project and one exact full version ref
 * (including content hash), satisfy its mode's state gate — `use` needs an
 * active, ready version, `trial` a candidate — and carry the server-rendered
 * block exactly once in `messageText`. The client-sent
 * `admittedSkillStateSeq` is never read or trusted; the server stamps its own
 * after admission. With no managed items the send is ordinary text and is
 * admitted without inspecting `messageText`.
 */
export function evaluateProjectSkillAdmission(f: {
  projectId: ProjectId;
  messageText: string;
  items: ReadonlyArray<{ contextId: string; payload: unknown }>;
  versions: ReadonlyArray<{
    ref: ProjectSkillVersionRef;
    state: "candidate" | "active" | "retired";
    content: ProjectSkillContent;
    useReadiness: { ready: boolean; gaps: ReadonlyArray<ProjectSkillReadinessGap> };
  }>;
}):
  | { ok: true; admitted: ReadonlyArray<{ ref: ProjectSkillVersionRef; mode: ProjectSkillMode }> }
  | {
      ok: false;
      contextId: string;
      hold:
        | "malformed-item"
        | "duplicate-item"
        | "project-mismatch"
        | "version-missing"
        | "content-mismatch"
        | "block-missing-or-altered"
        | "not-active"
        | "not-candidate"
        | "not-ready";
    } {
  if (f.items.length === 0) return { ok: true, admitted: [] };
  const decodePayload = Schema.decodeUnknownOption(ProjectSkillContextPayload);
  const seenContextIds = new Set<string>();
  const seenRefs = new Set<string>();
  const admitted: Array<{ ref: ProjectSkillVersionRef; mode: ProjectSkillMode }> = [];
  for (const item of f.items) {
    const payload = decodePayload(item.payload);
    if (Option.isNone(payload)) {
      return { ok: false, contextId: item.contextId, hold: "malformed-item" };
    }
    if (seenContextIds.has(item.contextId)) {
      return { ok: false, contextId: item.contextId, hold: "duplicate-item" };
    }
    seenContextIds.add(item.contextId);
    const { ref, mode } = payload.value;
    const refKey = [ref.projectId, ref.skillId, ref.version, ref.contentSha256].join("\u0000");
    if (seenRefs.has(refKey)) {
      return { ok: false, contextId: item.contextId, hold: "duplicate-item" };
    }
    seenRefs.add(refKey);
    if (ref.projectId !== f.projectId) {
      return { ok: false, contextId: item.contextId, hold: "project-mismatch" };
    }
    const version = f.versions.find((candidate) => sameProjectSkillVersionRef(candidate.ref, ref));
    if (version === undefined) {
      // The same version number under a different content hash means the
      // record binds stale content, not a missing version.
      const staleContent = f.versions.some(
        (candidate) =>
          candidate.ref.projectId === ref.projectId &&
          candidate.ref.skillId === ref.skillId &&
          candidate.ref.version === ref.version,
      );
      return {
        ok: false,
        contextId: item.contextId,
        hold: staleContent ? "content-mismatch" : "version-missing",
      };
    }
    if (mode === "use") {
      if (version.state !== "active") {
        return { ok: false, contextId: item.contextId, hold: "not-active" };
      }
      if (!version.useReadiness.ready) {
        return { ok: false, contextId: item.contextId, hold: "not-ready" };
      }
    } else if (version.state !== "candidate") {
      return { ok: false, contextId: item.contextId, hold: "not-candidate" };
    }
    const block = renderProjectSkillBlock({ ref: version.ref, content: version.content, mode });
    if (countOccurrences(f.messageText, block) !== 1) {
      return { ok: false, contextId: item.contextId, hold: "block-missing-or-altered" };
    }
    admitted.push({ ref: version.ref, mode });
  }
  return { ok: true, admitted };
}
