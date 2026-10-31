import type { OrchestrationThread, ThreadId } from "@t3tools/contracts";

import type { PickerItem } from "./view.ts";
import { wrapStyled } from "../text/wrap.ts";
import { sanitizeForTerminal } from "../text/width.ts";
import type { Theme } from "../render/theme.ts";
import { promptPreview, turnCountOf, type UndoPlan } from "./checkpoints.ts";

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
      ? { label: "취소", note: "아무것도 바꾸지 않습니다" }
      : choice === "files"
        ? { label: "파일과 대화 되돌리기", note: `턴 ${plan.target} 끝 상태로` }
        : {
            label: plan.restore === "possible" ? "대화만 되돌리기" : "대화 되돌리기",
            note: "파일은 그대로 둡니다",
          },
  );

/** The state a restore goes back to, in the words of the turn it follows. */
const stateAfter = (target: number): string =>
  target === 0 ? "이 스레드를 시작하기 전" : `턴 ${target} 이 끝난`;

/**
 * What the confirmation says before anything is deleted: which turn goes, what happens to the
 * conversation and to the files, and that there is no way back. Folded to `room` columns, since a
 * list's own rows are cut, not folded.
 */
export const undoSummary = (plan: UndoPlan, theme: Theme, room: number, queued = 0): string[] => {
  const { files } = plan;
  const counts = `파일 ${files.count}개 (+${files.additions} -${files.deletions})`;
  const rows: string[] = [
    theme.text.bold(
      plan.prompt === null ? `턴 ${plan.turn}` : `턴 ${plan.turn}: ${promptPreview(plan.prompt)}`,
    ),
    `대화: 이 턴의 질문과 답변이 대화에서 지워집니다.${
      plan.prompt === null ? "" : " 질문은 입력창으로 돌아옵니다."
    }`,
  ];
  if (queued > 0) {
    rows.push(
      `대기 중인 메시지 ${queued}건은 입력창으로 돌아옵니다 (지워진 턴을 전제로 했을 수 있어 자동으로 보내지 않습니다).`,
    );
  }
  if (plan.restore === "possible") {
    rows.push(
      `파일: "파일과 대화"를 고르면 ${counts} 를 포함해 폴더 전체가 ${stateAfter(plan.target)} 상태로 돌아가고, 그 사이 직접 고친 내용도 사라집니다. "대화만"을 고르면 파일은 그대로입니다.`,
    );
  } else if (plan.restore === "shared-folder") {
    rows.push(
      `파일: 그대로 둡니다. 이 스레드는 프로젝트 폴더를 다른 스레드와 함께 쓰므로 파일 복원은 지원되지 않습니다 (데스크톱 앱도 같습니다). 이 턴이 바꾼 ${counts} 는 /diff ${plan.turn} 으로 보고 직접 되돌리세요.`,
    );
  } else {
    rows.push("파일: 그대로 둡니다. 되돌아갈 체크포인트를 쓸 수 없습니다.");
  }
  rows.push(theme.warning("되돌린 것을 다시 되돌리는 기능은 데스크톱 앱에도 없습니다."));
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
