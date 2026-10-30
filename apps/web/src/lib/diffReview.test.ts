import type { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFileDiffContentVersion,
  getRenderablePatch,
  resolveFileDiffPath,
} from "./diffRendering";
import {
  MAX_VIEWED_DIFF_MARKS_PER_THREAD,
  canOpenDiffFile,
  firstChangedNewFileLine,
  formatTurnChangeSummary,
  resolveAdjacentFileIndex,
  resolveAdjacentTurnId,
  viewedDiffMark,
  withViewedDiffMark,
} from "./diffReview";

function parseFiles(patch: string) {
  const renderable = getRenderablePatch(patch, "diff-review-test");
  if (renderable?.kind !== "files") throw new Error("expected a parsed patch");
  return renderable.files;
}

const MODIFY_PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,7 +10,7 @@",
  " ctx1",
  " ctx2",
  " ctx3",
  "-old line",
  "+new line",
  " ctx4",
  " ctx5",
  " ctx6",
  "",
].join("\n");

const DELETE_PATCH = [
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "index 1111111..0000000",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-one",
  "-two",
  "",
].join("\n");

describe("viewed marks", () => {
  it("changes when the file's diff changes, so a re-edited file reads as unviewed", () => {
    const [before] = parseFiles(MODIFY_PATCH);
    const [after] = parseFiles(MODIFY_PATCH.replace("+new line", "+newer line"));
    const [same] = parseFiles(MODIFY_PATCH);

    const path = resolveFileDiffPath(before!);
    const marks = new Set([viewedDiffMark(path, buildFileDiffContentVersion(before!))]);

    expect(marks.has(viewedDiffMark(path, buildFileDiffContentVersion(same!)))).toBe(true);
    expect(marks.has(viewedDiffMark(path, buildFileDiffContentVersion(after!)))).toBe(false);
  });

  it("keeps the same hash for the same path in different scopes apart", () => {
    expect(viewedDiffMark("a.ts", 1)).not.toBe(viewedDiffMark("a.ts", 2));
    expect(viewedDiffMark("a.ts", 1)).not.toBe(viewedDiffMark("b.ts", 1));
  });

  it("adds and removes marks and forgets the oldest past the limit", () => {
    expect(withViewedDiffMark([], "x", true)).toEqual(["x"]);
    expect(withViewedDiffMark(["x"], "x", true)).toEqual(["x"]);
    expect(withViewedDiffMark(["x", "y"], "x", false)).toEqual(["y"]);
    expect(withViewedDiffMark(["x"], "missing", false)).toEqual(["x"]);

    const full = Array.from(
      { length: MAX_VIEWED_DIFF_MARKS_PER_THREAD },
      (_, index) => `m${index}`,
    );
    const next = withViewedDiffMark(full, "newest", true);
    expect(next).toHaveLength(MAX_VIEWED_DIFF_MARKS_PER_THREAD);
    expect(next[0]).toBe("m1");
    expect(next.at(-1)).toBe("newest");
  });
});

describe("resolveAdjacentFileIndex", () => {
  it("steps within the list and stops at both ends", () => {
    expect(resolveAdjacentFileIndex(1, 3, 1)).toBe(2);
    expect(resolveAdjacentFileIndex(1, 3, -1)).toBe(0);
    expect(resolveAdjacentFileIndex(2, 3, 1)).toBe(2);
    expect(resolveAdjacentFileIndex(0, 3, -1)).toBe(0);
  });

  it("starts at the first file when none is current and does nothing without files", () => {
    expect(resolveAdjacentFileIndex(-1, 3, 1)).toBe(0);
    expect(resolveAdjacentFileIndex(-1, 3, -1)).toBe(0);
    expect(resolveAdjacentFileIndex(-1, 0, 1)).toBeNull();
  });
});

describe("resolveAdjacentTurnId", () => {
  const turns = ["t3", "t2", "t1"] as TurnId[];

  it("moves through turns newest first", () => {
    expect(resolveAdjacentTurnId(turns, "t2" as TurnId, "previous")).toBe("t1");
    expect(resolveAdjacentTurnId(turns, "t2" as TurnId, "next")).toBe("t3");
  });

  it("ends at the oldest and the latest turn", () => {
    expect(resolveAdjacentTurnId(turns, "t1" as TurnId, "previous")).toBeNull();
    expect(resolveAdjacentTurnId(turns, "t3" as TurnId, "next")).toBeNull();
  });

  it("enters the turns from the latest one when a git scope is selected", () => {
    expect(resolveAdjacentTurnId(turns, null, "previous")).toBe("t3");
    expect(resolveAdjacentTurnId(turns, null, "next")).toBeNull();
    expect(resolveAdjacentTurnId([], null, "previous")).toBeNull();
  });
});

describe("formatTurnChangeSummary", () => {
  const files = (count: number) => (count === 1 ? "1 file" : `${count} files`);

  it("shows lines and file count", () => {
    expect(formatTurnChangeSummary({ additions: 12, deletions: 3 }, 4, files)).toBe(
      "+12 −3 · 4 files",
    );
  });

  it("is empty for a turn without files", () => {
    expect(formatTurnChangeSummary({ additions: 0, deletions: 0 }, 0, files)).toBeNull();
  });
});

describe("opening a changed file", () => {
  it("lands on the first changed line, not the top of the hunk", () => {
    const [file] = parseFiles(MODIFY_PATCH);
    expect(firstChangedNewFileLine(file!)).toBe(13);
  });

  it("has no line for a deleted file, which cannot be opened", () => {
    const [file] = parseFiles(DELETE_PATCH);
    expect(canOpenDiffFile(file!)).toBe(false);
    expect(firstChangedNewFileLine(file!)).toBeNull();
  });

  it("has no line while the patch has no hunks yet", () => {
    expect(firstChangedNewFileLine({ type: "change", hunks: [] })).toBeNull();
  });
});
