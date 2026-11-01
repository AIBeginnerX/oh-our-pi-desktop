import type { OrchestrationThread, ThreadId } from "@t3tools/contracts";

import type { PickerItem } from "./view.ts";
import { wrapStyled } from "../text/wrap.ts";
import { sanitizeForTerminal } from "../text/width.ts";
import type { Theme } from "../render/theme.ts";
import { promptPreview, turnCountOf, type UndoPlan } from "./checkpoints.ts";
import { t } from "../i18n/index.ts";

/** A request that has not been answered by now is no longer waited for. */
const PENDING_LIMIT_MS = 60_000;

/** What the confirmation offers, in the order it lists them. */
export type UndoChoice = "cancel" | "files" | "conversation";

/** The choices for a plan; the first is the safe one, and it is the one the list opens on. */
export const undoChoices = (plan: UndoPlan): ReadonlyArray<UndoChoice> =>
  plan.restore === "possible" ? ["cancel", "files", "conversation"] : ["cancel", "conversation"];

export const undoItems = (plan: UndoPlan): PickerItem[] =>
  undoChoices(plan).map((choice) =>
    choice === "cancel"
      ? { label: t("session.undo.cancel"), note: t("session.undo.cancelNote") }
      : choice === "files"
        ? {
            label: t("session.undo.filesLabel"),
            note: t("session.undo.filesNote", { target: plan.target }),
          }
        : {
            label:
              plan.restore === "possible" ? t("session.undo.convPossible") : t("session.undo.conv"),
            note: t("session.undo.convNote"),
          },
  );

/** The state a restore goes back to, in the words of the turn it follows. */
const stateAfter = (target: number): string =>
  target === 0 ? t("session.undo.stateStart") : t("session.undo.stateTurn", { target });

/**
 * What the confirmation says before anything is deleted: which turn goes, what happens to the
 * conversation and to the files, and that there is no way back. Folded to `room` columns, since a
 * list's own rows are cut, not folded.
 */
export const undoSummary = (plan: UndoPlan, theme: Theme, room: number, queued = 0): string[] => {
  const { files } = plan;
  const counts = t("session.undo.counts", {
    count: files.count,
    additions: files.additions,
    deletions: files.deletions,
  });
  const rows: string[] = [
    theme.text.bold(
      plan.prompt === null
        ? t("session.undo.turn", { turn: plan.turn })
        : t("session.undo.turnPrompt", { turn: plan.turn, prompt: promptPreview(plan.prompt) }),
    ),
    `${t("session.undo.convRow")}${plan.prompt === null ? "" : t("session.undo.convRowPrompt")}`,
  ];
  if (queued > 0) {
    rows.push(t("session.undo.queued", { queued }));
  }
  if (plan.restore === "possible") {
    rows.push(t("session.undo.filesRowPossible", { counts, state: stateAfter(plan.target) }));
  } else if (plan.restore === "shared-folder") {
    rows.push(t("session.undo.filesRowShared", { counts, turn: plan.turn }));
  } else {
    rows.push(t("session.undo.filesRowNone"));
  }
  rows.push(theme.warning(t("session.undo.irreversible")));
  return rows.flatMap((row) => wrapStyled(row, Math.max(8, room)));
};

/** How a pending undo ended, as the thread shows it. */
export type UndoOutcome =
  | { readonly kind: "done"; readonly plan: UndoPlan; readonly restoreFiles: boolean }
  | { readonly kind: "failed"; readonly detail: string | null; readonly restoreFiles: boolean };

interface Pending {
  readonly threadId: ThreadId;
  readonly plan: UndoPlan;
  readonly restoreFiles: boolean;
  startedAt: number;
  /** Failures already in the thread when it was sent: they are not this request's answer. */
  readonly knownFailures: ReadonlySet<string>;
  /** The thread is not on screen: its answer cannot be read, so the minute does not run. */
  away: boolean;
}

const FAILURE_KIND = "checkpoint.revert.failed";

/**
 * The one undo this client has sent and is waiting on. The server answers a revert only through the
 * thread: its checkpoints shrink when it worked, and an error activity appears when it did not, so
 * the answer is read from the thread and from nothing else.
 */
export class UndoTracker {
  private pending: Pending | null = null;

  /**
   * Whether an undo of this thread is on its way; one that was never answered stops counting after
   * a minute. Another thread is not held by it.
   */
  active(threadId: ThreadId, now: number): boolean {
    if (
      this.pending !== null &&
      !this.pending.away &&
      now - this.pending.startedAt >= PENDING_LIMIT_MS
    ) {
      this.pending = null;
    }
    return this.pending !== null && this.pending.threadId === threadId;
  }

  start(input: {
    readonly thread: OrchestrationThread;
    readonly plan: UndoPlan;
    readonly restoreFiles: boolean;
    readonly now: number;
  }): void {
    this.pending = {
      threadId: input.thread.id,
      plan: input.plan,
      restoreFiles: input.restoreFiles,
      startedAt: input.now,
      away: false,
      knownFailures: new Set(
        input.thread.activities
          .filter((activity) => activity.kind === FAILURE_KIND)
          .map((activity) => activity.id),
      ),
    };
  }

  /**
   * The thread went off screen: the answer is read when it is back, however long that takes, and
   * the minute is counted from then.
   */
  leave(threadId: ThreadId): void {
    if (this.pending?.threadId === threadId) this.pending.away = true;
  }

  arrive(threadId: ThreadId, now: number): void {
    const pending = this.pending;
    if (pending === null || pending.threadId !== threadId || !pending.away) return;
    pending.away = false;
    pending.startedAt = now;
  }

  /** The request never reached the server, or its delivery is unknown: nothing is waited for. */
  drop(): void {
    this.pending = null;
  }

  /** Reads the thread for the answer; once it is found the request is over. */
  observe(thread: OrchestrationThread): UndoOutcome | null {
    const pending = this.pending;
    if (pending === null || pending.threadId !== thread.id) return null;
    const failure = thread.activities.find(
      (activity) => activity.kind === FAILURE_KIND && !pending.knownFailures.has(activity.id),
    );
    if (failure !== undefined) {
      this.pending = null;
      const detail = (failure.payload as { detail?: unknown } | null)?.detail;
      return {
        kind: "failed",
        detail:
          typeof detail === "string"
            ? (sanitizeForTerminal(detail).split("\n")[0]?.trim() ?? null) || null
            : null,
        restoreFiles: pending.restoreFiles,
      };
    }
    if (turnCountOf(thread) <= pending.plan.target) {
      this.pending = null;
      return { kind: "done", plan: pending.plan, restoreFiles: pending.restoreFiles };
    }
    return null;
  }
}
