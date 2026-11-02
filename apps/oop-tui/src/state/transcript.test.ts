import { describe, expect, it } from "vite-plus/test";

import { makeStyle } from "../render/style.ts";
import { RAIL_COLUMNS } from "../render/rail.ts";
import { ASCII_SYMBOLS } from "../render/symbols.ts";
import { BUILTIN_THEMES, createTheme } from "../render/theme.ts";
import { makeActivity, makeMessage, makeThread } from "../testing/fixtures.ts";
import { stringWidth, stripAnsi, visibleWidth } from "../text/width.ts";
import { TranscriptPrinter, type TranscriptOptions } from "./transcript.ts";

const printer = (historyMessages = 20, over: Partial<TranscriptOptions> = {}) =>
  new TranscriptPrinter({ width: 40, style: makeStyle(false), historyMessages, ...over });

const themeAt = (level: 0 | 1 | 2 | 3) => createTheme("oop", BUILTIN_THEMES.oop, level);
const coloured = (level: 0 | 1 | 2 | 3, over: Partial<TranscriptOptions> = {}) =>
  printer(20, { style: makeStyle(themeAt(level)), ...over });

const at = (second: number) => `2026-10-30T09:00:${String(second).padStart(2, "0")}.000Z`;

const assistant = (text: string, streaming: boolean, second = 1) =>
  makeMessage({ id: "m-a", role: "assistant", text, streaming, createdAt: at(second) });

/**
 * A user message with no colour: a rounded box against the right edge of `width` columns, one space of
 * padding inside the border on each side. `lines` are the rows inside the box and the box is as wide as
 * the widest of them, so a message of several lines is one block of equal width.
 */
const sent = (lines: string | ReadonlyArray<string>, width = 40): string[] => {
  const rows = typeof lines === "string" ? [lines] : lines;
  const inner = rows.reduce((widest, row) => Math.max(widest, stringWidth(row)), 1);
  const lead = " ".repeat(width - inner - 4);
  return [
    `${lead}╭${"─".repeat(inner + 2)}╮`,
    ...rows.map((row) => `${lead}│ ${row}${" ".repeat(inner - stringWidth(row))} │`),
    `${lead}╰${"─".repeat(inner + 2)}╯`,
  ];
};

const plainRows = (rows: ReadonlyArray<string>) => rows.map(stripAnsi);

const tool = (id: string, second: number, kind: string, payload: Record<string, unknown>) =>
  makeActivity({ id, kind, createdAt: at(second), payload });

describe("TranscriptPrinter", () => {
  it("hangs a streamed reply off the rail, commits it line by line and never prints a line twice", () => {
    const transcript = printer();
    const first = transcript.sync(
      makeThread({ messages: [assistant("첫 줄\n둘째 줄 일부", true)] }),
    );
    expect(first.commit).toEqual(["│", "│  첫 줄"]);
    expect(first.partial).toEqual(["│  둘째 줄 일부"]);

    const second = transcript.sync(
      makeThread({ messages: [assistant("첫 줄\n둘째 줄 일부 완성\n셋째", true)] }),
    );
    expect(second.commit).toEqual(["│  둘째 줄 일부 완성"]);
    expect(second.partial).toEqual(["│  셋째"]);

    const done = transcript.sync(
      makeThread({ messages: [assistant("첫 줄\n둘째 줄 일부 완성\n셋째 줄", false)] }),
    );
    expect(done.commit).toEqual(["│  셋째 줄"]);
    expect(done.partial).toEqual([]);

    const again = transcript.sync(
      makeThread({ messages: [assistant("첫 줄\n둘째 줄 일부 완성\n셋째 줄", false)] }),
    );
    expect(again).toEqual({ commit: [], partial: [] });
  });

  it("shows the rail's separator with a tail that has no finished line yet, so it does not jump when committed", () => {
    const transcript = printer();
    const first = transcript.sync(makeThread({ messages: [assistant("아직 한 줄", true)] }));
    expect(first.commit).toEqual([]);
    expect(first.partial).toEqual(["│", "│  아직 한 줄"]);
    const next = transcript.sync(
      makeThread({ messages: [assistant("아직 한 줄 끝\n다음", true)] }),
    );
    expect(next.commit).toEqual(["│", "│  아직 한 줄 끝"]);
    expect(next.partial).toEqual(["│  다음"]);
  });

  it("prints a user message once against the right edge and strips control sequences", () => {
    const transcript = printer();
    const user = makeMessage({
      id: "m-u",
      role: "user",
      text: "안녕\u001b[2J하세요",
      createdAt: at(1),
    });
    const first = transcript.sync(makeThread({ messages: [user] }));
    expect(first.commit).toEqual(["│", ...sent("안녕하세요")]);
    expect(transcript.sync(makeThread({ messages: [user] })).commit).toEqual([]);
  });

  it("keeps the lines of a multi-line user message in one block of equal width, an empty line included", () => {
    const user = makeMessage({ id: "m-u", role: "user", text: "하나\n\n셋", createdAt: at(1) });
    expect(printer().sync(makeThread({ messages: [user] })).commit).toEqual([
      "│",
      ...sent(["하나", "", "셋"]),
    ]);
  });

  it("separates a user message, a reply and the next turn with one bar each", () => {
    const synced = printer().sync(
      makeThread({
        messages: [
          makeMessage({ id: "u1", role: "user", text: "하나", createdAt: at(1) }),
          makeMessage({ id: "a1", role: "assistant", text: "답 하나", createdAt: at(2) }),
          makeMessage({ id: "u2", role: "user", text: "둘", createdAt: at(3) }),
          makeMessage({ id: "a2", role: "assistant", text: "답 둘", createdAt: at(4) }),
        ],
      }),
    );
    expect(synced.commit).toEqual([
      "│",
      ...sent("하나"),
      "│",
      "│  답 하나",
      "│",
      ...sent("둘"),
      "│",
      "│  답 둘",
    ]);
  });

  it("limits what it prints when a thread is opened and says how much it left out", () => {
    const transcript = printer(2, { width: 80 });
    const messages = [1, 2, 3, 4].map((n) =>
      makeMessage({ id: `m${n}`, role: "user", text: `메시지 ${n}`, createdAt: at(n) }),
    );
    const synced = transcript.sync(makeThread({ messages }));
    expect(synced.commit).toEqual([
      "│",
      "│  ... 이전 메시지 2개 · /history 로 보기",
      "│",
      ...sent("메시지 3", 80),
      "│",
      ...sent("메시지 4", 80),
    ]);
    const next = transcript.sync(
      makeThread({
        messages: [
          ...messages,
          makeMessage({ id: "m5", role: "user", text: "메시지 5", createdAt: at(5) }),
        ],
      }),
    );
    expect(next.commit).toEqual(["│", ...sent("메시지 5", 80)]);
  });

  it("counts what the opening skipped, and says the server has more when it does", () => {
    const messages = [1, 2, 3].map((n) =>
      makeMessage({ id: `m${n}`, role: "user", text: `메시지 ${n}`, createdAt: at(n) }),
    );
    const cut = printer(2, { width: 80 });
    expect(plainRows(cut.sync(makeThread({ messages }), true).commit)[1]).toBe(
      "│  ... 이전 메시지 1개 이상 · /history 로 보기",
    );
    expect(cut.skippedMessages).toBe(1);

    const whole = printer(5, { width: 80 });
    expect(plainRows(whole.sync(makeThread({ messages }), true).commit)[1]).toBe(
      "│  ... 이전 메시지 있음 · /history 로 보기",
    );
    expect(whole.skippedMessages).toBe(0);
    expect(plainRows(printer(5, { width: 80 }).sync(makeThread({ messages })).commit)).toEqual([
      "│",
      ...sent("메시지 1", 80),
      "│",
      ...sent("메시지 2", 80),
      "│",
      ...sent("메시지 3", 80),
    ]);
  });

  it("keeps tools together, marks a failed one with a cross in the rail's place, and prints each once", () => {
    const transcript = printer();
    const activities = [
      tool("t1", 1, "tool.completed", { title: "bun test", detail: "12 passed" }),
      tool("t2", 2, "tool.completed", { title: "rm -rf build", status: "failed" }),
      tool("t3", 3, "tool.started", { title: "다음" }),
    ];
    const synced = transcript.sync(makeThread({ activities }));
    expect(synced.commit).toEqual(["│", "◇  bun test  12 passed", "✗  rm -rf build"]);
    expect(transcript.sync(makeThread({ activities })).commit).toEqual([]);
  });

  it("surfaces runtime errors and orders activity with messages by time", () => {
    const transcript = printer();
    const synced = transcript.sync(
      makeThread({
        messages: [
          makeMessage({ id: "m-u", role: "user", text: "실행", createdAt: at(1) }),
          makeMessage({ id: "m-a", role: "assistant", text: "끝", createdAt: at(3) }),
        ],
        activities: [
          makeActivity({
            id: "e1",
            kind: "runtime.error",
            summary: "프로바이더 오류",
            createdAt: at(2),
            payload: { detail: "연결 끊김" },
          }),
        ],
      }),
    );
    expect(synced.commit).toEqual([
      "│",
      ...sent("실행"),
      "│",
      "✗  프로바이더 오류 - 연결 끊김",
      "│",
      "│  끝",
    ]);
  });

  it("hides reasoning messages", () => {
    const transcript = printer();
    const synced = transcript.sync(
      makeThread({
        messages: [makeMessage({ id: "r", role: "reasoning", text: "생각 중", createdAt: at(1) })],
      }),
    );
    expect(synced.commit).toEqual([]);
  });

  it("shows server-side failures that carry an error tone", () => {
    const transcript = printer();
    const synced = transcript.sync(
      makeThread({
        activities: [
          makeActivity({
            id: "f1",
            kind: "provider.turn.start.failed",
            tone: "error",
            summary: "Provider turn start failed",
            createdAt: at(1),
            payload: { detail: "모델을 찾을 수 없습니다\n두 번째 줄" },
          }),
          makeActivity({
            id: "f2",
            kind: "provider.turn.interrupt.failed",
            tone: "error",
            summary: "Interrupt failed",
            createdAt: at(2),
            payload: {},
          }),
          makeActivity({
            id: "f3",
            kind: "provider.user-input.respond.failed",
            tone: "error",
            summary: "User input response failed",
            createdAt: at(3),
            payload: { requestId: "ask-1", detail: "stale" },
          }),
        ],
      }),
    );
    expect(synced.commit).toEqual([
      "│",
      "✗  Provider turn start failed - 모델을",
      "│  찾을 수 없습니다",
      "✗  Interrupt failed",
      "✗  User input response failed - stale",
    ]);
  });

  it("does not show quiet activities or print a failed tool twice", () => {
    const transcript = printer();
    const synced = transcript.sync(
      makeThread({
        activities: [
          makeActivity({ id: "i1", kind: "task.started", tone: "info", createdAt: at(1) }),
          makeActivity({
            id: "t1",
            kind: "tool.completed",
            tone: "error",
            createdAt: at(2),
            payload: { title: "bun test", status: "failed" },
          }),
        ],
      }),
    );
    expect(synced.commit).toEqual(["│", "✗  bun test"]);
  });

  it("keeps a carriage return in a reply from breaking a committed row", () => {
    const transcript = printer();
    const synced = transcript.sync(makeThread({ messages: [assistant("앞\r뒤\r\n끝", false)] }));
    expect(synced.commit).toEqual(["│", "│  앞", "│  뒤", "│  끝"]);
    for (const row of synced.commit) expect(row).not.toContain("\n");
  });

  it("does not print a reply's blank lines twice or let one lead or trail the reply", () => {
    const synced = printer().sync(
      makeThread({ messages: [assistant("\n\n하나\n\n\n\n둘\n\n", false)] }),
    );
    expect(synced.commit).toEqual(["│", "│  하나", "│", "│  둘"]);
  });
});

describe("very long messages", () => {
  const rows = 200_000;
  const body = Array.from({ length: rows }, (_, row) => `줄 ${row}`).join("\n");

  it.each([
    ["assistant", assistant(body, false)],
    ["user", makeMessage({ id: "m-u", role: "user", text: body, createdAt: at(1) })],
    ["system", makeMessage({ id: "m-s", role: "system", text: body, createdAt: at(1) })],
  ])("commits a %s message of 200000 rows without overflowing the call stack", (_role, message) => {
    const synced = printer().sync(makeThread({ messages: [message] }));
    expect(synced.commit.length).toBeGreaterThanOrEqual(rows);
  });

  it("commits one 200000-row stream chunk of an unfinished reply", () => {
    const synced = printer().sync(makeThread({ messages: [assistant(`${body}\n끝`, true)] }));
    expect(synced.commit.length).toBeGreaterThanOrEqual(rows);
  });
});

describe("tool lines", () => {
  it("adds what the tool reported under its line, and how long it ran when it ran a while", () => {
    const synced = printer().sync(
      makeThread({
        activities: [
          tool("s1", 1, "tool.started", { toolCallId: "c1", title: "bun test" }),
          tool("p1", 2, "tool.updated", { toolCallId: "c1", title: "bun test" }),
          tool("e1", 4, "tool.completed", {
            toolCallId: "c1",
            title: "bun test",
            detail: "src/a.test.ts",
            data: { item: { aggregatedOutput: "12 passed" } },
          }),
        ],
      }),
    );
    expect(synced.commit).toEqual(["│", "◇  bun test  src/a.test.ts  3.0s", "│  12 passed"]);
  });

  it("prefers the duration a tool reports and leaves a quick or unknown one unmarked", () => {
    const synced = printer().sync(
      makeThread({
        activities: [
          tool("e1", 9, "tool.completed", {
            title: "mcp",
            data: { item: { durationMs: 75_000 } },
          }),
          tool("s2", 10, "tool.started", { toolCallId: "c2", title: "ls" }),
          { ...tool("e2", 10, "tool.completed", { toolCallId: "c2", title: "ls" }) },
          tool("e3", 11, "tool.completed", { toolCallId: "never-started", title: "pwd" }),
        ],
      }),
    );
    expect(synced.commit).toEqual(["│", "◇  mcp  1m 15s", "◇  ls", "◇  pwd"]);
  });

  it("measures a tool that started before the window of history that was printed", () => {
    const transcript = printer(1);
    const synced = transcript.sync(
      makeThread({
        messages: [
          makeMessage({ id: "old", role: "user", text: "옛 메시지", createdAt: at(1) }),
          makeMessage({ id: "new", role: "user", text: "새 메시지", createdAt: at(5) }),
        ],
        activities: [
          tool("s", 3, "tool.started", { toolCallId: "c", title: "build" }),
          tool("e", 8, "tool.completed", { toolCallId: "c", title: "build" }),
        ],
      }),
    );
    expect(synced.commit.at(-1)).toBe("◇  build  5.0s");
  });

  it("explains a failed tool with its reason, or the changed files of an edit", () => {
    const synced = printer().sync(
      makeThread({
        activities: [
          tool("f1", 1, "tool.completed", {
            title: "bun test",
            status: "failed",
            data: { item: { aggregatedOutput: "2 failed" } },
          }),
          makeActivity({
            id: "d1",
            kind: "tool.denied",
            tone: "error",
            summary: "Tool denied: rm",
            createdAt: at(2),
            payload: { toolName: "rm", detail: "허용되지 않음" },
          }),
          tool("c1", 3, "tool.completed", {
            title: "Edit",
            itemType: "file_change",
            data: { files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map((path) => ({ path })) },
          }),
        ],
      }),
    );
    expect(synced.commit).toEqual([
      "│",
      "✗  bun test",
      "│  2 failed",
      "✗  Tool denied: rm  허용되지 않음",
      "◇  Edit",
      "│  a.ts, b.ts, c.ts 외 2개",
    ]);
  });

  it("does not repeat a result that the line already shows, and keeps every row inside the width", () => {
    const long = "가".repeat(60);
    const synced = printer().sync(
      makeThread({
        activities: [
          tool("a", 1, "tool.completed", {
            title: "echo",
            detail: "same",
            data: { item: { aggregatedOutput: "same" } },
          }),
          tool("b", 2, "tool.completed", {
            title: "run",
            detail: long,
            data: { item: { aggregatedOutput: `${long}!` } },
          }),
        ],
      }),
    );
    expect(synced.commit[1]).toBe("◇  echo  same");
    expect(synced.commit).toHaveLength(4);
    for (const row of synced.commit) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
    // A long result is cut to what is left of the line after the rail, and keeps the rail.
    expect(synced.commit[3]?.startsWith("│  ")).toBe(true);
  });

  it("colours a finished tool in the tool colour on a success mark, and a failed one in the error colour", () => {
    const theme = themeAt(3);
    const synced = coloured(3).sync(
      makeThread({
        activities: [
          tool("ok", 1, "tool.completed", { title: "ls" }),
          tool("bad", 2, "tool.completed", { title: "rm", status: "failed" }),
        ],
      }),
    );
    expect(synced.commit).toEqual([
      theme.dim("│"),
      `${theme.success("◇")}  ${theme.tool.bold("ls")}`,
      `${theme.error.bold("✗")}  ${theme.error.bold("rm")}`,
    ]);
  });

  it("strips control sequences that a tool reports", () => {
    const synced = coloured(3).sync(
      makeThread({
        activities: [
          tool("x", 1, "tool.completed", {
            title: "ls\u001b[2J",
            detail: "a\u001b]0;t\u0007b",
            data: { item: { aggregatedOutput: "o\u001b[31mk" } },
          }),
        ],
      }),
    );
    expect(stripAnsi(synced.commit.join("\n"))).toBe("│\n◇  ls  ab\n│  ok");
    // eslint-disable-next-line no-control-regex
    expect(synced.commit.join("")).not.toMatch(/\u001b\[(?:2J|31m)|\u001b\]/u);
  });
});

describe("events and notices", () => {
  it("draws a context compaction as one step, with the token counts when the server gave them", () => {
    const synced = printer().sync(
      makeThread({
        activities: [
          makeActivity({
            id: "c1",
            kind: "context-compaction",
            tone: "info",
            createdAt: at(1),
            payload: { beforeTokens: 123_400, afterTokens: 8_000 },
          }),
          makeActivity({
            id: "c2",
            kind: "context-compaction",
            tone: "info",
            createdAt: at(2),
            payload: {},
          }),
        ],
      }),
    );
    expect(synced.commit).toEqual(["│", "◇  맥락 압축 123.4k -> 8k 토큰", "◇  맥락 압축"]);
  });

  it("wraps long warnings and errors on the rail instead of overflowing, and reads the error message field", () => {
    const synced = printer().sync(
      makeThread({
        activities: [
          makeActivity({
            id: "w",
            kind: "runtime.warning",
            tone: "info",
            summary: "경고 ".repeat(30),
            createdAt: at(1),
          }),
          makeActivity({
            id: "e",
            kind: "runtime.error",
            tone: "error",
            summary: "Runtime error",
            createdAt: at(2),
            payload: { message: "연결이 끊겼습니다" },
          }),
        ],
      }),
    );
    expect(synced.commit.length).toBeGreaterThan(3);
    for (const row of synced.commit) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
    expect(synced.commit.at(-1)).toBe("✗  Runtime error - 연결이 끊겼습니다");
    expect(synced.commit[1]?.startsWith("▲  경고")).toBe(true);
    expect(synced.commit[2]?.startsWith("│  ")).toBe(true);
  });

  it("colours notices by kind", () => {
    const theme = themeAt(3);
    const synced = coloured(3).sync(
      makeThread({
        activities: [
          makeActivity({ id: "w", kind: "runtime.warning", summary: "느림", createdAt: at(1) }),
          makeActivity({
            id: "c",
            kind: "context-compaction",
            tone: "info",
            createdAt: at(2),
            payload: {},
          }),
        ],
      }),
    );
    expect(synced.commit).toEqual([
      theme.dim("│"),
      `${theme.warning("▲")}  ${theme.warning("느림")}`,
      `${theme.success("◇")}  ${theme.info("맥락 압축")}`,
    ]);
  });
});

describe("messages in colour", () => {
  const userAt = (second: number, text: string) =>
    makeMessage({ id: `u${second}`, role: "user", text, createdAt: at(second) });

  it("fills a user message with the theme's user tint, against the right edge, one block of equal width", () => {
    const theme = themeAt(3);
    const rows = coloured(3).sync(makeThread({ messages: [userAt(1, "안녕\n둘째 줄")] })).commit;
    expect(rows[0]).toBe(theme.dim("│"));
    const block = rows.slice(1);
    // A border above and below the text, and the widest row of it sets the width of them all.
    expect(block).toHaveLength(4);
    for (const row of block) {
      expect(row).toContain(";48;2;30;36;51m");
      // The block ends at the last column of the conversation.
      expect(visibleWidth(row)).toBe(40);
    }
    expect(plainRows(block).map((row) => row.trimStart())).toEqual([
      "╭─────────╮",
      "│ 안녕    │",
      "│ 둘째 줄 │",
      "╰─────────╯",
    ]);
  });

  it("wraps a long user message inside a block of at most four fifths of the width, with wide characters counted as two", () => {
    const rows = printer().sync(makeThread({ messages: [userAt(1, "가나다 ".repeat(20))] })).commit;
    expect(rows.length).toBeGreaterThan(4);
    expect(rows[1]).toMatch(/^ +╭─+╮$/u);
    expect(rows.at(-1)).toMatch(/^ +╰─+╯$/u);
    // Every row of the box ends in the same column, at the right edge of the conversation.
    for (const row of rows.slice(1)) expect(visibleWidth(row)).toBe(40);
    for (const row of rows.slice(2, -1)) {
      expect(row.endsWith(" │")).toBe(true);
      expect(row.trimStart().length).toBeLessThan(40);
    }
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
    // The text keeps every character; only the layout around it changed.
    const text = rows
      .slice(2, -1)
      .map((row) =>
        row
          .replace(/^ +│ /u, "")
          .replace(/ +│$/u, "")
          .trim(),
      )
      .join(" ");
    expect(text.replace(/\s+/gu, " ")).toBe("가나다 ".repeat(20).trim());
  });

  it("right-aligns a user message in the ASCII preset in an ASCII box, and leaves the reply on the left", () => {
    const rows = printer(20, { symbols: ASCII_SYMBOLS }).sync(
      makeThread({
        messages: [
          userAt(1, "hello 안녕"),
          makeMessage({ id: "a1", role: "assistant", text: "reply", createdAt: at(2) }),
        ],
      }),
    ).commit;
    const lead = " ".repeat(40 - 10 - 4);
    expect(rows).toEqual([
      "|",
      `${lead}+------------+`,
      `${lead}| hello 안녕 |`,
      `${lead}+------------+`,
      "|",
      "|  reply",
    ]);
    expect(rows.join("\n")).toMatch(/^[\n -~가-힣]+$/u);
  });

  it("keeps the text of a reply on the rail but lets code start at column 0, joined by a bar either side", () => {
    const text = "# 제목\n\n- 항목\n\n```ts\nconst a = 1;\n```\n\n끝";
    const rows = printer().sync(makeThread({ messages: [assistant(text, false)] })).commit;
    expect(rows).toEqual([
      "│",
      "│  제목",
      "│",
      "│  - 항목",
      "│",
      "ts",
      "const a = 1;",
      "│",
      "│  끝",
    ]);
  });

  it("starts a diff at column 0 too, and puts the next block one bar after it", () => {
    const text = "바꿨습니다\n```diff\n-a\n+b\n```";
    const synced = printer().sync(
      makeThread({
        messages: [assistant(text, false)],
        activities: [tool("t", 9, "tool.completed", { title: "ls" })],
      }),
    );
    const rows = plainRows(synced.commit);
    expect(rows.slice(0, 2)).toEqual(["│", "│  바꿨습니다"]);
    expect(rows.slice(2, 3)).toEqual(["│"]);
    expect(rows.slice(3)).toEqual(["diff", "- a", "+ b", "│", "◇  ls"]);
  });

  it("keeps a reply inside the width when its code is coloured on a background, with the code at column 0", () => {
    const text =
      "```ts\nconst long = '가나다라마바사아자차카타파하 가나다라마바사아자차카타파하';\n```";
    const rows = coloured(3).sync(makeThread({ messages: [assistant(text, false)] })).commit;
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(
      plainRows(rows)
        .slice(1)
        .every((row) => !row.startsWith("│")),
    ).toBe(true);
    expect(rows[2]).toContain(";48;2;");
  });

  it("keeps a long line of a reply on the rail, every wrapped row, inside the width", () => {
    const rows = printer().sync(
      makeThread({ messages: [assistant("가나다라마바사 ".repeat(15), false)] }),
    ).commit;
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows.slice(1)) expect(row.startsWith("│  ")).toBe(true);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
  });

  it("keeps every row of a very narrow terminal inside the rail", () => {
    const rows = printer(20, { width: 8 }).sync(
      makeThread({
        messages: [assistant("한글 문단 입니다 계속", false), userAt(2, "사용자 메시지")],
      }),
    ).commit;
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(8);
  });

  it("does not print an unfinished code block's rows twice while the reply streams, and keeps its tail off the rail", () => {
    const transcript = coloured(3);
    const first = transcript.sync(
      makeThread({ messages: [assistant("```ts\nlet a = 1;\nlet b", true)] }),
    );
    const second = transcript.sync(
      makeThread({ messages: [assistant("```ts\nlet a = 1;\nlet b = 2;\n", true)] }),
    );
    expect(stripAnsi(first.commit.join("\n"))).toContain("let a = 1;");
    expect(first.partial.map(stripAnsi)).toEqual(["let b"]);
    expect(stripAnsi(second.commit.join("\n"))).not.toContain("let a = 1;");
    expect(stripAnsi(second.commit.join("\n"))).toContain("let b = 2;");
  });

  it("separates text that follows a closed code block from it once the text is known, not before", () => {
    const transcript = printer();
    const closed = transcript.sync(
      makeThread({ messages: [assistant("```ts\nlet a = 1;\n```\n", true)] }),
    );
    expect(closed.commit).toEqual(["│", "ts", "let a = 1;"]);
    const after = transcript.sync(
      makeThread({ messages: [assistant("```ts\nlet a = 1;\n```\n뒤 문단", true)] }),
    );
    expect(after.commit).toEqual([]);
    expect(after.partial).toEqual(["│", "│  뒤 문단"]);
    const done = transcript.sync(
      makeThread({ messages: [assistant("```ts\nlet a = 1;\n```\n뒤 문단\n", true)] }),
    );
    expect(done.commit).toEqual(["│", "│  뒤 문단"]);
  });

  it("starts a reply that resumes after a tool with a bar, and not a second one when it just continues", () => {
    const transcript = printer();
    const thread = (text: string) =>
      makeThread({
        messages: [assistant(text, true, 1)],
        activities: [tool("t", 2, "tool.completed", { title: "ls" })],
      });
    const first = transcript.sync(thread("앞 줄\n"));
    expect(first.commit).toEqual(["│", "│  앞 줄", "│", "◇  ls"]);
    const next = transcript.sync(thread("앞 줄\n뒷 줄\n"));
    expect(next.commit).toEqual(["│", "│  뒷 줄"]);
  });
});

describe("plain terminals", () => {
  const thread = makeThread({
    messages: [
      makeMessage({ id: "u", role: "user", text: "run tests", createdAt: at(1) }),
      assistant(
        "# Done\n\n> note\n\n- item\n\n```diff\n@@ -1 +1 @@\n-a\n+b\n```\n\n`x` and **y**",
        false,
        4,
      ),
    ],
    activities: [
      makeActivity({
        id: "t",
        kind: "tool.completed",
        createdAt: at(2),
        payload: {
          title: "bun test",
          detail: "all",
          status: "failed",
          data: { item: { aggregatedOutput: "1 failed" } },
        },
      }),
      makeActivity({ id: "w", kind: "runtime.warning", summary: "slow", createdAt: at(3) }),
      makeActivity({
        id: "c",
        kind: "context-compaction",
        tone: "info",
        createdAt: at(3),
        payload: {},
      }),
    ],
  });

  it("prints no escape sequence when colour is off", () => {
    expect(printer().sync(thread).commit.join("\n")).not.toContain("\u001b");
  });

  it("prints only ASCII with the ASCII symbols, on an ASCII rail", () => {
    const rows = printer(20, { symbols: ASCII_SYMBOLS }).sync(thread).commit;
    // The app's own Korean wording stays; every symbol it draws must be ASCII.
    expect(rows.join("\n").replace(/[가-힣]/gu, "")).toMatch(/^[\n -~]+$/u);
    expect(rows.some((row) => row.endsWith("run tests |"))).toBe(true);
    expect(rows).toContain("x  bun test  all");
    expect(rows).toContain("|  1 failed");
    expect(rows).toContain("|  | note");
  });

  it("gives the rail a width of RAIL_COLUMNS", () => {
    expect(RAIL_COLUMNS).toBe(3);
    for (const row of printer()
      .sync(thread)
      .commit.filter((line) => line.startsWith("│"))) {
      expect(row === "│" || row.startsWith("│  ")).toBe(true);
    }
  });

  describe("code that looks like the rail's own gap", () => {
    const code = "본문\n\n```\na\n{bar}\n{bar}\n{bar}\nb\n```\n\n끝\n";

    it("keeps every line of a code block as written, with ASCII symbols and no colour", () => {
      const rows = printer(20, { symbols: ASCII_SYMBOLS }).sync(
        makeThread({ messages: [assistant(code.replaceAll("{bar}", "|"), false)] }),
      ).commit;
      const at = rows.indexOf("a");
      expect(rows.slice(at, at + 5)).toEqual(["a", "|", "|", "|", "b"]);
      // The gap after the block is still there once, and the text after it is on the rail.
      expect(rows.slice(at + 5)).toEqual(["|", "|  끝"]);
    });

    it("does the same for a line holding the Unicode bar", () => {
      const rows = printer().sync(
        makeThread({ messages: [assistant(code.replaceAll("{bar}", "│"), false)] }),
      ).commit;
      const at = rows.indexOf("a");
      expect(rows.slice(at, at + 5)).toEqual(["a", "│", "│", "│", "b"]);
    });

    it("keeps them across commits while a reply streams, and the gap before the next block", () => {
      const transcript = printer(20, { symbols: ASCII_SYMBOLS });
      const first = transcript.sync(makeThread({ messages: [assistant("```\n|\n", true)] })).commit;
      const second = transcript.sync(
        makeThread({ messages: [assistant("```\n|\n|\n|\n```\n", true)] }),
      ).commit;
      expect(first.filter((row) => row === "|").length).toBeGreaterThanOrEqual(1);
      expect(second).toEqual(["|", "|"]);
      const next = transcript.sync(
        makeThread({
          messages: [assistant("```\n|\n|\n|\n```\n", true)],
          activities: [tool("t", 5, "tool.completed", { title: "ls" })],
        }),
      ).commit;
      // The code ended on a `|` line; the tool still gets its own gap before it.
      expect(next[0]).toBe("|");
    });
  });
});

describe("a goal's verdict in the scrollback", () => {
  const goalLine = (kind: string, payload: Record<string, unknown> = {}) =>
    plainRows(
      printer(20).sync(
        makeThread({
          activities: [
            makeActivity({
              id: "g1",
              kind,
              createdAt: at(2),
              tone: "info",
              summary: kind,
              payload,
            }),
          ],
        }),
      ).commit,
    ).filter((row) => row.trim() !== "" && row.trim() !== "│");

  it("records a met goal on one line", () => {
    expect(goalLine("goal.met", { goalId: "g" })).toEqual(["◇  목표 완료"]);
  });

  it("records a blocked goal with the reason, as a warning", () => {
    const rows = goalLine("goal.blocked", { goalId: "g", reason: "권한이 없습니다\n둘째 줄" });
    expect(rows.join(" ")).toContain("목표 차단: 권한이 없습니다");
    expect(rows.join(" ")).not.toContain("둘째 줄");
  });

  it("records an exhausted goal as stopped", () => {
    expect(goalLine("goal.exhausted", { goalId: "g" }).join(" ")).toContain("목표 중지");
  });

  it("says nothing for a continuation, which is a turn of its own", () => {
    expect(goalLine("goal.continued", { goalId: "g" })).toEqual([]);
  });
});

describe("the crew in the scrollback", () => {
  const crewLine = (
    kind: string,
    payload: Record<string, unknown>,
    over: Partial<TranscriptOptions> = {},
  ) =>
    plainRows(
      printer(20, { width: 80, ...over }).sync(
        makeThread({
          activities: [makeActivity({ id: "c", kind, createdAt: at(2), payload })],
        }),
      ).commit,
    ).filter((row) => row !== "│");

  it("writes one line when a task starts, with the role, the task and the model", () => {
    expect(
      crewLine("task.started", {
        taskId: "t1",
        crewRole: "worker",
        title: "파서 고치기",
        model: "Haiku 4",
        agentKind: "agent",
      }),
    ).toEqual(["│  crew Worker 시작 · 파서 고치기 (Haiku 4)"]);
  });

  it("writes one line when it ends, and says how it ended without hiding a failure", () => {
    const ended = (status: string) =>
      crewLine("task.completed", {
        taskId: "t1",
        crewRole: "expert",
        title: "설계",
        status,
        agentKind: "agent",
      });
    expect(ended("completed")).toEqual(["◇  crew Expert 완료 · 설계"]);
    expect(ended("failed")).toEqual(["✗  crew Expert 실패 · 설계"]);
    expect(ended("blocked")).toEqual(["▲  crew Expert 차단됨 · 설계"]);
    expect(ended("stopped")).toEqual(["▲  crew Expert 중단됨 · 설계"]);
  });

  it("says when the crew switched model, left an audit out, or sent the lead a follow-up", () => {
    expect(
      crewLine("task.progress", { taskId: "t1", crewRole: "worker", title: "일", model: "GPT-5" }),
    ).toEqual(["│  crew Worker 모델 전환 · 일 (GPT-5)"]);
    expect(crewLine("crew.audit-skipped", { changedFiles: 1 })).toEqual([
      "│  감사 생략: 작은 변경이고 테스트가 통과했습니다 (파일 1개)",
    ]);
    expect(crewLine("crew.follow-up", { reason: "audit" })).toEqual([
      "│  감사가 수정을 요청해 lead 에게 후속 턴을 보냈습니다",
    ]);
  });

  it("leaves other agents' tasks out of the scrollback, as before", () => {
    expect(crewLine("task.started", { taskId: "t9", title: "탐색", agentKind: "agent" })).toEqual(
      [],
    );
  });

  it("cleans a task name written by the server and stays inside a narrow terminal, in ASCII too", () => {
    const rows = crewLine(
      "task.completed",
      {
        taskId: "t1",
        crewRole: "worker",
        title: "\u001b[31m아주 긴 작업 이름이 좁은 터미널 폭을 넘어서 계속 이어집니다\u001b[0m",
        status: "failed",
      },
      { width: 30, symbols: ASCII_SYMBOLS },
    );
    expect(rows.join("\n")).not.toContain("\u001b");
    // Wrapped under the rail, nothing cut off.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.join("")).toContain("계속 이어집니다");
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(30);
  });
});

describe("proposed plans in the transcript", () => {
  const proposed = (over: Record<string, unknown> = {}) => ({
    id: "plan-1",
    turnId: "turn-1",
    planMarkdown:
      "# 로그인 계획\n\n## Summary\n- 이메일로 로그인\n\n1. 해시 칸 추가\n2. 핸들러 작성\n",
    createdAt: at(5),
    updatedAt: at(5),
    implementedAt: null,
    implementationThreadId: null,
    ...over,
  });
  const reply = assistant("계획을 제안합니다.", false, 1);

  it("writes the plan once, under the reply it ends, with how to build it", () => {
    const transcript = printer();
    const thread = makeThread({ messages: [reply], proposedPlans: [proposed()] });
    const first = plainRows(transcript.sync(thread).commit);
    expect(first.slice(0, 10)).toEqual([
      "│",
      "│  계획을 제안합니다.",
      "│",
      "◇  계획 · 로그인 계획",
      "│",
      "│  - 이메일로 로그인",
      "│",
      "│  1. 해시 칸 추가",
      "│  2. 핸들러 작성",
      "│",
    ]);
    expect(first.slice(10).join(" ")).toContain("/implement 로 이 계획을 구현합니다");
    expect(first.join("\n")).not.toContain("Summary");
    expect(plainRows(transcript.sync(thread).commit)).toEqual([]);
  });

  it("writes it again for a new reader of the thread, and not when its text only changes", () => {
    const thread = makeThread({ messages: [reply], proposedPlans: [proposed()] });
    expect(plainRows(printer().sync(thread).commit).join("\n")).toContain("◇  계획 · 로그인 계획");
    const transcript = printer();
    transcript.sync(thread);
    const edited = makeThread({
      messages: [reply],
      proposedPlans: [proposed({ planMarkdown: "# 로그인 계획\n- 바뀐 내용", updatedAt: at(9) })],
    });
    expect(transcript.sync(edited).commit).toEqual([]);
  });

  it("leaves the hint off a plan that was built, and draws a plan that is still being written once", () => {
    const rows = plainRows(
      printer().sync(
        makeThread({ messages: [reply], proposedPlans: [proposed({ implementedAt: at(30) })] }),
      ).commit,
    );
    expect(rows.join("\n")).toContain("계획 · 로그인 계획");
    expect(rows.join("\n")).not.toContain("/implement");
  });

  it("keeps a built plan before the message that built it, though building stamps it updated", () => {
    const build = makeMessage({
      id: "m-u",
      role: "user",
      text: "PLEASE IMPLEMENT THIS PLAN:\n# 로그인 계획\n- 해시 칸 추가",
      createdAt: at(40),
    });
    const rows = plainRows(
      printer().sync(
        makeThread({
          messages: [reply, build],
          proposedPlans: [proposed({ updatedAt: at(41), implementedAt: at(41) })],
        }),
      ).commit,
    );
    expect(rows.findIndex((row) => row.startsWith("◇  계획 ·"))).toBeLessThan(
      rows.findIndex((row) => row.startsWith("◇  계획 구현")),
    );
  });

  it("keeps the rows of a code block as they are, even if they look like the rail", () => {
    const rows = plainRows(
      printer().sync(
        makeThread({
          messages: [reply],
          proposedPlans: [proposed({ planMarkdown: "# 계획\n```\n│\n```\n" })],
        }),
      ).commit,
    );
    expect(rows.filter((row) => row === "│").length).toBeGreaterThan(1);
  });

  it("does not write a plan older than the messages it prints, as for the history", () => {
    const old = makeMessage({ id: "m-1", role: "user", text: "처음", createdAt: at(10) });
    const next = makeMessage({ id: "m-2", role: "user", text: "나중", createdAt: at(20) });
    const rows = plainRows(
      printer(1).sync(
        makeThread({
          messages: [old, next],
          proposedPlans: [proposed({ updatedAt: at(5) })],
        }),
      ).commit,
    );
    expect(rows.join("\n")).not.toContain("로그인 계획");
  });

  it("shows the message that builds a plan as one line, not the plan again", () => {
    const build = makeMessage({
      id: "m-u",
      role: "user",
      text: "PLEASE IMPLEMENT THIS PLAN:\n# 로그인 계획\n- 해시 칸 추가",
      createdAt: at(40),
    });
    const rows = plainRows(printer().sync(makeThread({ messages: [build] })).commit);
    expect(rows).toEqual(["│", "◇  계획 구현 · 로그인 계획"]);
  });
});

describe("the colour of the user's messages on every path", () => {
  const marked = themeAt(3).userFg("x");
  const USER_FG = marked.slice(0, marked.indexOf("m") + 1);
  const user = (id: string, text: string, second: number) =>
    makeMessage({ id, role: "user", text, createdAt: at(second) });
  /** A row of the user's box, border and all, painted in the user's own colour. */
  const isUserRow = (row: string) => row.includes(USER_FG);
  const boxRows = (rows: ReadonlyArray<string>) =>
    rows.filter((row) => stripAnsi(row).trim() !== "│");

  it("paints a message sent live, one replayed when a thread is opened, and one on a later sync", () => {
    const transcript = coloured(3);
    const opened = transcript.sync(makeThread({ messages: [user("u1", "열 때 보이는 말", 1)] }));
    const box = boxRows(opened.commit);
    // The whole box, its border included, is the user's colour.
    expect(box).toHaveLength(3);
    expect(box.every(isUserRow)).toBe(true);
    const live = transcript.sync(
      makeThread({ messages: [user("u1", "열 때 보이는 말", 1), user("u2", "방금 보낸 말", 2)] }),
    );
    expect(boxRows(live.commit).every(isUserRow)).toBe(true);
    expect(live.commit.map(stripAnsi).join("\n")).toContain("방금 보낸 말");
  });

  it("paints every message of a page of older turns, written by a printer of its own", () => {
    const older = coloured(3).sync(
      makeThread({ messages: [user("o1", "옛날 말 하나", 1), user("o2", "옛날 말 둘", 3)] }),
    );
    const rows = boxRows(older.commit);
    expect(rows).toHaveLength(6);
    expect(rows.every(isUserRow)).toBe(true);
  });

  it("paints in 256 colours and in 16, where there is no fill but the box's own border", () => {
    const at256 = coloured(2).sync(makeThread({ messages: [user("u", "안녕", 1)] })).commit;
    expect(at256.join("")).toContain("38;5;221");
    const at16 = coloured(1).sync(makeThread({ messages: [user("u", "안녕", 1)] })).commit;
    const row = at16.find((entry) => stripAnsi(entry).includes("안녕")) as string;
    expect(row).not.toContain("48;");
    expect(stripAnsi(row).endsWith("│")).toBe(true);
  });

  it("keeps the box and plain text when colour is off", () => {
    const rows = printer()
      .sync(makeThread({ messages: [user("u", "안녕", 1)] }))
      .commit.slice(1);
    expect(rows).toEqual(sent("안녕"));
    expect(rows.join("")).not.toContain("\u001b");
  });

  it("leaves an agent's reply without the user's colour", () => {
    const reply = coloured(3).sync(makeThread({ messages: [assistant("답", false)] })).commit;
    expect(reply.join("")).not.toContain(USER_FG);
  });
});
