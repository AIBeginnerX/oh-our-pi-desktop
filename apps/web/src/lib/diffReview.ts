import type { FileDiffMetadata } from "@pierre/diffs";
import type { TurnId } from "@t3tools/contracts";

/** Viewed marks are kept per thread; past this many the oldest are forgotten. */
export const MAX_VIEWED_DIFF_MARKS_PER_THREAD = 500;

/**
 * What a "Viewed" tick remembers: the file and the exact diff the reader looked at. A file whose
 * diff changes afterwards no longer matches its mark, so it reads as unviewed again.
 */
export function viewedDiffMark(filePath: string, contentVersion: number): string {
  return `${contentVersion.toString(36)}:${filePath}`;
}

/** Adds or removes a mark, keeping the newest marks when the thread is over its limit. */
export function withViewedDiffMark(
  marks: ReadonlyArray<string>,
  mark: string,
  viewed: boolean,
): ReadonlyArray<string> {
  const others = marks.filter((candidate) => candidate !== mark);
  return viewed ? [...others, mark].slice(-MAX_VIEWED_DIFF_MARKS_PER_THREAD) : others;
}

/**
 * The file `direction` steps from `currentIndex`, stopping at either end. With no current file
 * (-1) the first press lands on the first file.
 */
export function resolveAdjacentFileIndex(
  currentIndex: number,
  fileCount: number,
  direction: 1 | -1,
): number | null {
  if (fileCount === 0) return null;
  if (currentIndex < 0) return 0;
  return Math.min(Math.max(currentIndex + direction, 0), fileCount - 1);
}

/**
 * The turn a step from the selection lands on, in a list ordered newest first. "Previous" is the
 * turn before the selected one; from a working-tree or branch view it is the latest turn, and
 * there is no "next" because those views are newer than every turn.
 */
export function resolveAdjacentTurnId(
  orderedTurnIds: ReadonlyArray<TurnId>,
  selectedTurnId: TurnId | null,
  direction: "previous" | "next",
): TurnId | null {
  if (selectedTurnId === null) {
    return direction === "previous" ? (orderedTurnIds[0] ?? null) : null;
  }
  const index = orderedTurnIds.indexOf(selectedTurnId);
  if (index < 0) return null;
  return orderedTurnIds[direction === "previous" ? index + 1 : index - 1] ?? null;
}

/** "+N −M · K files", or null when the turn recorded no files. */
export function formatTurnChangeSummary(
  stat: { readonly additions: number; readonly deletions: number },
  fileCount: number,
  filesLabel: (count: number) => string,
): string | null {
  if (fileCount === 0) return null;
  return `+${stat.additions} −${stat.deletions} · ${filesLabel(fileCount)}`;
}

/** A deleted file has nothing in the workspace to open. */
export function canOpenDiffFile(fileDiff: Pick<FileDiffMetadata, "type">): boolean {
  return fileDiff.type !== "deleted";
}

/**
 * The line in the new version of the file where its first change sits, so opening the file lands
 * on the edit instead of the top. Null when the diff has no hunk to read it from (a file whose
 * patch is still loading, a deletion).
 */
export function firstChangedNewFileLine(
  fileDiff: Pick<FileDiffMetadata, "type" | "hunks">,
): number | null {
  if (!canOpenDiffFile(fileDiff)) return null;
  const hunk = fileDiff.hunks[0];
  if (!hunk) return null;
  const change = hunk.hunkContent.find((content) => content.type === "change");
  const offset = change ? change.additionLineIndex - hunk.additionLineIndex : 0;
  return Math.max(1, hunk.additionStart + offset);
}
