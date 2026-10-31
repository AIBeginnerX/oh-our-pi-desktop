import type { OrchestrationCheckpointFile } from "@t3tools/contracts";
import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";

import { graphemesOf, sanitizeForTerminal, visibleWidth } from "../text/width.ts";
import { padEndVisible, truncateStyled } from "../text/wrap.ts";
import { DiffStream } from "./diff.ts";
import { RAIL_COLUMNS, railDone, railGap, railRow, type Rail } from "./rail.ts";

/** Diff lines the whole turn shows; the terminal's scrollback is the only place they go. */
export const OVERVIEW_LINES = 300;
/** Diff lines one file shows when it is asked for by name. */
export const FILE_LINES = 2000;
/** A diff line longer than this is cut: a minified file would otherwise wrap into thousands of rows. */
const LINE_COLUMNS = 400;
/** Files named under the heading before the rest are counted. */
const FILES_LISTED = 20;

interface Section {
  /** The `diff --git` line, or "" for text that came before the first one. */
  readonly header: string;
  readonly lines: ReadonlyArray<string>;
}

/** Splits a unified diff at its `diff --git` lines, one section per file. */
const sections = (diff: string): Section[] => {
  const out: Array<{ header: string; lines: string[] }> = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) out.push({ header: line, lines: [line] });
    else if (out.length === 0) {
      if (line !== "") out.push({ header: "", lines: [line] });
    } else out[out.length - 1]?.lines.push(line);
  }
  // The diff ends with a line feed, which is not a line of the last file.
  const last = out.at(-1);
  if (last !== undefined && last.lines.at(-1) === "") last.lines.pop();
  return out;
};

/**
 * The new-side path of a `diff --git` line when git quoted it, as it does for any name outside ASCII
 * (`core.quotePath`): `"b/\355\225\234.ts"`. The file list the server sends is read with `-z` and holds
 * the name as it is, so the two only compare once the header is unquoted. Null when the new side is
 * not quoted, which the plain ` b/<path>` ending covers.
 */
const quotedHeaderPath = (header: string): string | null => {
  if (!header.endsWith('"')) return null;
  for (let at = header.length - 2; at >= 0; at -= 1) {
    if (header[at] !== '"') continue;
    // A quote the name escapes belongs to the name: it has an odd run of backslashes before it.
    let slashes = 0;
    while (header[at - 1 - slashes] === "\\") slashes += 1;
    if (slashes % 2 === 1) continue;
    const name = unquoteGitPatchPath(header.slice(at));
    return name.startsWith("b/") ? name.slice(2) : null;
  }
  return null;
};

const sectionIsFile = (section: Section, path: string): boolean =>
  section.header.endsWith(` b/${path}`) || quotedHeaderPath(section.header) === path;

const shortened = (line: string): string => {
  if (line.length <= LINE_COLUMNS) return line;
  return `${graphemesOf(line).slice(0, LINE_COLUMNS).join("")}…`;
};

export const diffTotals = (
  files: ReadonlyArray<OrchestrationCheckpointFile>,
): { count: number; additions: number; deletions: number } =>
  files.reduce(
    (total, file) => ({
      count: total.count + 1,
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { count: 0, additions: 0, deletions: 0 },
  );

export interface DiffReportInput {
  readonly rail: Rail;
  /** Columns a row may use. */
  readonly width: number;
  readonly turn: number;
  readonly files: ReadonlyArray<OrchestrationCheckpointFile>;
  /** The unified diff the server answered with. */
  readonly diff: string;
  /** A file picked by name: the report shows only that one, and further. */
  readonly file?: string;
}

const countsText = (rail: Rail, additions: number, deletions: number): string => {
  const { theme } = rail.style;
  return [
    additions > 0 ? theme.success(`+${additions}`) : "",
    deletions > 0 ? theme.error(`-${deletions}`) : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
};

/** The files a name could mean: the path itself, else those ending in it. */
export const matchFiles = (
  files: ReadonlyArray<OrchestrationCheckpointFile>,
  name: string,
): OrchestrationCheckpointFile[] => {
  // macOS spells Korean file names decomposed (NFD) and a terminal types them composed (NFC).
  const wanted = name.replace(/^\.\//u, "").normalize("NFC");
  const exact = files.filter((file) => file.path.normalize("NFC") === wanted);
  if (exact.length > 0) return exact;
  return files.filter((file) => file.path.normalize("NFC").endsWith(`/${wanted}`));
};

/**
 * What `/diff` writes into the scrollback: a heading with the turn's totals, the files it touched,
 * and the diff under them. The whole turn stops after `OVERVIEW_LINES` diff lines and says how to see
 * a file in full; one file asked for by name gets `FILE_LINES`. Rows hold only SGR styling.
 */
export const diffReportRows = (input: DiffReportInput): string[] => {
  const { rail, width, turn, files } = input;
  const { theme } = rail.style;
  const all = sections(input.diff);
  const picked =
    input.file === undefined
      ? null
      : matchFiles(files, input.file).flatMap((file) =>
          all.filter((section) => sectionIsFile(section, file.path)),
        );
  const shown = picked ?? all;
  const listed = input.file === undefined ? files : matchFiles(files, input.file);
  const totals = diffTotals(listed);

  const rows: string[] = [railGap(rail)];
  const heading =
    input.file === undefined
      ? `턴 ${turn} 변경 · 파일 ${totals.count}개`
      : `턴 ${turn} · ${sanitizeForTerminal(listed[0]?.path ?? input.file)}`;
  rows.push(
    railDone(
      rail,
      `${theme.text.bold(heading)}${
        totals.additions + totals.deletions > 0
          ? `  ${countsText(rail, totals.additions, totals.deletions)}`
          : ""
      }`,
    ),
  );

  if (input.file === undefined && files.length > 0) {
    const room = Math.max(8, width - RAIL_COLUMNS);
    const stats = files
      .slice(0, FILES_LISTED)
      .map((file) => countsText(rail, file.additions, file.deletions));
    const statWidth = Math.max(0, ...stats.map((text) => visibleWidth(text)));
    files.slice(0, FILES_LISTED).forEach((file, index) => {
      const path = truncateStyled(
        sanitizeForTerminal(file.path),
        Math.max(6, room - statWidth - 2),
      );
      const stat = stats[index] ?? "";
      rows.push(
        railRow(rail, stat === "" ? path : `${padEndVisible(path, room - statWidth - 2)}  ${stat}`),
      );
    });
    if (files.length > FILES_LISTED) {
      rows.push(railRow(rail, theme.dim(`… 외 파일 ${files.length - FILES_LISTED}개`)));
    }
  }

  if (shown.every((section) => section.lines.length === 0)) {
    rows.push(
      railRow(
        rail,
        theme.dim(
          input.file !== undefined
            ? "diff 에서 이 파일을 찾지 못했습니다. 서버가 너무 큰 diff 를 잘랐을 수 있습니다."
            : files.length > 0
              ? "표시할 diff 가 없습니다 (공백 변경만 있거나 이진 파일입니다)."
              : "이 턴에서 바뀐 파일이 없습니다.",
        ),
      ),
    );
    return rows;
  }

  rows.push(railGap(rail));
  let left = input.file === undefined ? OVERVIEW_LINES : FILE_LINES;
  let hiddenLines = 0;
  let hiddenFiles = 0;
  for (const section of shown) {
    if (left <= 0) {
      hiddenFiles += 1;
      hiddenLines += section.lines.length;
      continue;
    }
    const take = Math.min(left, section.lines.length);
    // The limit is applied here, so the stream never has to say how many lines it left out.
    const stream = new DiffStream({ width, style: rail.style, maxLines: take });
    for (const line of section.lines.slice(0, take)) rows.push(...stream.push(shortened(line)));
    rows.push(...stream.finish());
    left -= take;
    if (take < section.lines.length) {
      hiddenLines += section.lines.length - take;
      hiddenFiles += 1;
    }
  }
  if (hiddenLines > 0) {
    rows.push(railGap(rail));
    rows.push(
      railRow(
        rail,
        theme.warning(
          input.file === undefined
            ? `diff ${hiddenLines}줄 (파일 ${hiddenFiles}개) 는 생략했습니다. 한 파일 전체: /diff ${turn} <파일>`
            : `diff 앞 ${FILE_LINES}줄만 보였고 ${hiddenLines}줄은 생략했습니다. 나머지는 데스크톱 앱의 diff 보기에서 확인하세요.`,
        ),
      ),
    );
  }
  return rows;
};
