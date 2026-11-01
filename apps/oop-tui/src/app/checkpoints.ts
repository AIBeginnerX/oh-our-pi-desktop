import type { OrchestrationCheckpointSummary, OrchestrationThread } from "@t3tools/contracts";

import { sanitizeForTerminal } from "../text/width.ts";
import { t } from "../i18n/index.ts";

/**
 * A turn that ended less than this long ago may still be having its checkpoint made: the server
 * captures it a moment after the turn, in the background.
 */
const CHECKPOINT_GRACE_MS = 30_000;

/** What the agent reads in front of a prompt when ultrathink is picked; the desktop app takes it off too. */
const ULTRATHINK_PREFIX = "Ultrathink:\n";

const PROMPT_PREVIEW_COLUMNS = 60;

/** Why a thread has no turn to show or to undo, in the words the terminal says. */
export type CheckpointGap =
  | { readonly kind: "no-turn" }
  | { readonly kind: "none" }
  | { readonly kind: "processing" }
  | { readonly kind: "capture-failed"; readonly detail: string | null }
  | { readonly kind: "unusable"; readonly turn: number; readonly status: string }
  | {
      readonly kind: "no-such-turn";
      readonly turn: number;
      readonly first: number;
      readonly last: number;
    };

export const checkpointGapText = (gap: CheckpointGap): string => {
  switch (gap.kind) {
    case "no-turn":
      return t("session.cp.noTurn");
    case "none":
      return t("session.cp.none");
    case "processing":
      return t("session.cp.processing");
    case "capture-failed":
      return `${t("session.cp.captureFailed")}${gap.detail === null ? "" : `: ${gap.detail}`}`;
    case "unusable":
      return t("session.cp.unusable", { turn: gap.turn, status: gap.status });
    case "no-such-turn":
      return gap.first === gap.last
        ? t("session.cp.noSuchOne", { turn: gap.turn, last: gap.last })
        : t("session.cp.noSuchRange", { turn: gap.turn, first: gap.first, last: gap.last });
  }
};

const firstLine = (value: unknown): string | null =>
  typeof value === "string"
    ? (sanitizeForTerminal(value).split("\n")[0]?.trim() ?? null) || null
    : null;

const byTurnCount = (left: OrchestrationCheckpointSummary, right: OrchestrationCheckpointSummary) =>
  left.checkpointTurnCount - right.checkpointTurnCount;

/**
 * Why the newest turn has no checkpoint when it should: still being made, failed (the server
 * records that as an activity), or never made, as in a folder that is not a repository.
 */
const missingLatest = (
  thread: OrchestrationThread,
  turnId: string,
  completedAt: string | null,
  now: number,
): CheckpointGap => {
  const failure = thread.activities.findLast(
    (activity) => activity.kind === "checkpoint.capture.failed" && activity.turnId === turnId,
  );
  if (failure !== undefined) {
    const payload = failure.payload as { detail?: unknown } | null;
    return { kind: "capture-failed", detail: firstLine(payload?.detail) };
  }
  const ended = completedAt === null ? Number.NaN : Date.parse(completedAt);
  // A turn that ended just now, or (clocks differ) seems to end ahead of us, is still being captured.
  if (Number.isFinite(ended) && now - ended < CHECKPOINT_GRACE_MS) return { kind: "processing" };
  return thread.checkpoints.length === 0
    ? { kind: "none" }
    : { kind: "capture-failed", detail: null };
};

/** The checkpoints of turns that are over, oldest first; a turn that is still running has no final one. */
const settled = (thread: OrchestrationThread): OrchestrationCheckpointSummary[] => {
  const running = thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null;
  return thread.checkpoints.filter((entry) => entry.turnId !== running).toSorted(byTurnCount);
};

/**
 * The turn `/diff` shows: the one asked for, else the last. The last one must be the thread's newest
 * turn, so a newest turn without a checkpoint is explained instead of quietly showing an older one.
 */
export const diffTurn = (
  thread: OrchestrationThread,
  requested: number | null,
  now: number,
):
  | { readonly ok: true; readonly checkpoint: OrchestrationCheckpointSummary }
  | { readonly ok: false; readonly gap: CheckpointGap } => {
  const checkpoints = settled(thread);
  if (requested !== null) {
    const found = checkpoints.find((entry) => entry.checkpointTurnCount === requested);
    if (found === undefined) {
      const first = checkpoints[0];
      const last = checkpoints.at(-1);
      if (first === undefined || last === undefined) {
        return {
          ok: false,
          gap: thread.latestTurn === null ? { kind: "no-turn" } : { kind: "none" },
        };
      }
      return {
        ok: false,
        gap: {
          kind: "no-such-turn",
          turn: requested,
          first: first.checkpointTurnCount,
          last: last.checkpointTurnCount,
        },
      };
    }
    return found.status === "ready"
      ? { ok: true, checkpoint: found }
      : { ok: false, gap: { kind: "unusable", turn: requested, status: found.status } };
  }
  const newest = thread.latestTurn;
  if (newest === null && checkpoints.length === 0) return { ok: false, gap: { kind: "no-turn" } };
  if (
    newest !== null &&
    newest.state !== "running" &&
    !checkpoints.some((entry) => entry.turnId === newest.turnId)
  ) {
    return { ok: false, gap: missingLatest(thread, newest.turnId, newest.completedAt, now) };
  }
  const last = checkpoints.at(-1);
  if (last === undefined) {
    // The only turn is still running.
    return { ok: false, gap: { kind: "no-turn" } };
  }
  return last.status === "ready"
    ? { ok: true, checkpoint: last }
    : { ok: false, gap: { kind: "unusable", turn: last.checkpointTurnCount, status: last.status } };
};

/** `/diff [turn] [file]`: a number first picks the turn, and the rest of the words name one file. */
export interface DiffRequest {
  readonly turn: number | null;
  readonly file: string | null;
}

export const parseDiffArgs = (
  args: ReadonlyArray<string>,
): DiffRequest | { readonly error: string } => {
  const [first, ...others] = args;
  const numbered = first !== undefined && /^\d+$/u.test(first);
  const turn = numbered ? Number(first) : null;
  if (turn !== null && (turn < 1 || !Number.isSafeInteger(turn))) {
    return { error: t("session.cp.badTurn") };
  }
  const file = (numbered ? others : args).join(" ").trim();
  return { turn, file: file === "" ? null : file };
};

/** What `/undo` would undo and what it would touch, read from the thread as it is now. */
export interface UndoPlan {
  /** The turn that goes: its checkpoint's turn count. The thread keeps this many turns less one. */
  readonly turn: number;
  /** Turn count the thread is rewound to. */
  readonly target: number;
  readonly files: {
    readonly count: number;
    readonly additions: number;
    readonly deletions: number;
  };
  /** The message that started the turn; it goes back to the composer. Null when it cannot be found. */
  readonly prompt: string | null;
  /**
   * Whether the files can go back with the conversation: only a thread with a worktree of its own
   * can (the server refuses to restore a folder other threads share), and only when the checkpoint
   * to go back to is usable.
   */
  readonly restore: "possible" | "shared-folder" | "checkpoint-unusable";
}

/** The text of the message that started the turn behind `checkpoint`: the last user message before its reply. */
const promptOf = (
  thread: OrchestrationThread,
  checkpoint: OrchestrationCheckpointSummary,
): string | null => {
  const messages = thread.messages.filter((message) => message.role !== "reasoning");
  const replyAt = messages.findIndex((message) => message.id === checkpoint.assistantMessageId);
  const before =
    replyAt >= 0
      ? messages.slice(0, replyAt)
      : messages.filter((message) => message.createdAt <= checkpoint.completedAt);
  const user = before.findLast((message) => message.role === "user");
  if (user === undefined) return null;
  const text = user.text.startsWith(ULTRATHINK_PREFIX)
    ? user.text.slice(ULTRATHINK_PREFIX.length)
    : user.text;
  return text.trim() === "" ? null : text.trim();
};

/** One line of the prompt for the confirmation, cut at `PROMPT_PREVIEW_COLUMNS` characters. */
export const promptPreview = (prompt: string): string => {
  const line = sanitizeForTerminal(prompt).replace(/\s+/gu, " ").trim();
  const characters = Array.from(line);
  return characters.length <= PROMPT_PREVIEW_COLUMNS
    ? line
    : `${characters.slice(0, PROMPT_PREVIEW_COLUMNS - 1).join("")}…`;
};

/**
 * The last turn as `/undo` would undo it, as the desktop app's "Edit from here" does for the last
 * message: the thread is rewound to the checkpoint before that turn. Only the newest turn can be
 * undone, and only when it has a checkpoint, so a turn that has none yet is explained instead.
 */
export const undoPlan = (
  thread: OrchestrationThread,
  now: number,
):
  | { readonly ok: true; readonly plan: UndoPlan }
  | { readonly ok: false; readonly gap: CheckpointGap } => {
  const found = diffTurn(thread, null, now);
  if (!found.ok) return found;
  const { checkpoint } = found;
  const turn = checkpoint.checkpointTurnCount;
  const target = turn - 1;
  const before =
    target === 0 ? null : thread.checkpoints.find((entry) => entry.checkpointTurnCount === target);
  // Turn zero is the state before the first turn, which the server keeps as its own baseline.
  const baselineUsable = target === 0 || before?.status === "ready";
  const files = checkpoint.files.reduce(
    (total, file) => ({
      count: total.count + 1,
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { count: 0, additions: 0, deletions: 0 },
  );
  return {
    ok: true,
    plan: {
      turn,
      target,
      files,
      prompt: promptOf(thread, checkpoint),
      restore:
        thread.worktreePath === null
          ? "shared-folder"
          : baselineUsable
            ? "possible"
            : "checkpoint-unusable",
    },
  };
};

/** The turn count the thread has now: its newest checkpoint's. */
export const turnCountOf = (thread: OrchestrationThread): number =>
  thread.checkpoints.reduce((most, entry) => Math.max(most, entry.checkpointTurnCount), 0);
