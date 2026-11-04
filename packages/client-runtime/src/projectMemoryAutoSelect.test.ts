import { describe, expect, it } from "vite-plus/test";

import {
  AUTO_SELECT_MAX_CHARS,
  AUTO_SELECT_MAX_ITEMS,
  EMPTY_AUTO_SELECT_STATE,
  extractTerms,
  planAutoSelection,
  rankProjectMemories,
  type AutoSelectState,
  type RankableProjectMemory,
} from "./projectMemoryAutoSelect.ts";

const NOW = Date.parse("2026-11-01T00:00:00.000Z");
const memory = (
  memoryId: string,
  title: string,
  body: string,
  validUntil: string | null = null,
): RankableProjectMemory => ({ memoryId, title, body, validUntil });

const corpus = [
  memory("deploy", "배포 절차", "배포 전에 pnpm build 를 실행하고 릴리스 브랜치를 태그한다."),
  memory("login", "Login error handling", "Show the inline error when the login request fails."),
  memory(
    "db",
    "Database rules",
    "마이그레이션은 항상 롤백 스크립트와 함께 작성한다. Use pnpm db:migrate.",
  ),
  memory("ui", "UI notes", "Spacing follows the 4px grid."),
];
const ids = (draft: string, items = corpus) =>
  rankProjectMemories(draft, items, { nowMs: NOW }).map((entry) => entry.item.memoryId);

describe("extractTerms", () => {
  it("keeps Latin words of 3+ characters and CJK bigrams, splitting at script boundaries", () => {
    expect(extractTerms("The API로 로그인을 fix")).toEqual(["api", "로그", "그인", "인을", "fix"]);
    expect(extractTerms("ui 의 a1")).toEqual([]);
  });
});

describe("rankProjectMemories", () => {
  it("matches English drafts against title and body", () => {
    expect(ids("the login request fails with an error")).toEqual(["login"]);
    expect(ids("how do I run the migrate script, use pnpm")).toEqual(["db"]);
  });

  it("matches Korean drafts with particles attached", () => {
    expect(ids("배포를 하기 전에 뭘 해야 해?")).toEqual(["deploy"]);
    expect(ids("마이그레이션을 작성해줘")).toEqual(["db"]);
  });

  it("matches mixed Korean and English drafts, best match first", () => {
    expect(ids("배포 전에 pnpm build 하고 login 오류도 고쳐줘")[0]).toBe("deploy");
    expect(ids("배포 전에 pnpm build 하고 login 오류도 고쳐줘")).toContain("login");
  });

  it("is OR-style: unmatched words in a long draft do not block a match", () => {
    expect(
      ids("please tell me something unrelated about weather and also the login error"),
    ).toEqual(["login"]);
  });

  it("ignores noise: a single body hit, stop words, short drafts, expired and excluded", () => {
    expect(ids("grid")).toEqual([]);
    expect(ids("the and for with")).toEqual([]);
    expect(ids("db")).toEqual([]);
    const expired = [memory("old", "Login error handling", "x", "2026-01-01T00:00:00.000Z")];
    expect(ids("login error", expired)).toEqual([]);
    expect(
      rankProjectMemories("login error", corpus, {
        nowMs: NOW,
        excludedMemoryIds: new Set(["login"]),
      }),
    ).toEqual([]);
  });

  it("scores the title alone when the body is not loaded", () => {
    expect(ids("login error", [{ memoryId: "t", title: "Login error handling" }])).toEqual(["t"]);
  });
});

describe("planAutoSelection", () => {
  const plan = (
    overrides: Partial<Parameters<typeof planAutoSelection<RankableProjectMemory>>[0]> = {},
  ) =>
    planAutoSelection({
      enabled: true,
      providerAllowed: true,
      draft: "배포 전에 pnpm build 하고 login 오류도 고쳐줘",
      memories: corpus,
      selectedMemoryIds: new Set(),
      state: EMPTY_AUTO_SELECT_STATE,
      nowMs: NOW,
      ...overrides,
    });

  it("selects nothing when disabled, which is the default", () => {
    expect(plan({ enabled: false }).add).toEqual([]);
  });

  it("selects nothing when the provider fails the allow-list gate", () => {
    expect(plan({ providerAllowed: false }).add).toEqual([]);
  });

  it("selects relevant memories when enabled", () => {
    expect(plan().add.map((item) => item.memoryId)).toEqual(["deploy", "login"]);
  });

  it("never exceeds three items", () => {
    const many = Array.from({ length: 6 }, (_, index) =>
      memory(`m${index}`, "Login error handling", "login error"),
    );
    expect(plan({ memories: many, draft: "login error" }).add).toHaveLength(AUTO_SELECT_MAX_ITEMS);
  });

  it("stays within the character budget, skipping what does not fit", () => {
    const big = memory("big", "Login error handling", "x".repeat(AUTO_SELECT_MAX_CHARS));
    const small = memory("small", "Login error notes", "short");
    const result = plan({ memories: [big, small], draft: "login error handling notes" }).add;
    expect(result.map((item) => item.memoryId)).toEqual(["small"]);

    const a = memory("a", "Login error", "y".repeat(800));
    const b = memory("b", "Login error again", "z".repeat(800));
    const both = plan({ memories: [a, b], draft: "login error again" }).add;
    expect(both.map((item) => item.memoryId)).toHaveLength(1);
    expect(
      both.reduce((total, item) => total + item.title.length + (item.body?.length ?? 0), 0),
    ).toBeLessThanOrEqual(AUTO_SELECT_MAX_CHARS);
  });

  it("never selects a memory whose body is unknown", () => {
    expect(
      plan({ memories: [{ memoryId: "t", title: "Login error handling" }], draft: "login error" })
        .add,
    ).toEqual([]);
  });

  it("does not re-add a chip the user removed from this draft", () => {
    const first = plan();
    const selected = new Set(first.add.map((item) => item.memoryId));
    // Unchanged while selected.
    const stable = plan({ selectedMemoryIds: selected, state: first.state });
    expect(stable.add).toEqual([]);
    // The user removes "login".
    const afterRemoval = plan({ selectedMemoryIds: new Set(["deploy"]), state: stable.state });
    expect(afterRemoval.add).toEqual([]);
    expect(afterRemoval.state.dismissed.has("login")).toBe(true);
    // Still removed after more typing.
    const typed = plan({
      draft: "배포 전에 pnpm build 하고 login 오류도 고쳐줘 그리고 login error",
      selectedMemoryIds: new Set(["deploy"]),
      state: afterRemoval.state,
    });
    expect(typed.add).toEqual([]);
  });

  it("does not re-add a manually picked memory the user then removed", () => {
    const manual = plan({ selectedMemoryIds: new Set(["login"]), draft: "login error" });
    const removed = plan({
      selectedMemoryIds: new Set(),
      draft: "login error",
      state: manual.state,
    });
    expect(removed.add).toEqual([]);
  });

  it("counts still-selected auto-added chips against the budget", () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      memory(`m${index}`, "Login error handling", "login error"),
    );
    const first = plan({ memories: many, draft: "login error" });
    const selected = new Set(first.add.map((item) => item.memoryId));
    expect(
      plan({
        memories: many,
        draft: "login error",
        selectedMemoryIds: selected,
        state: first.state,
      }).add,
    ).toEqual([]);
    // Removing one frees a slot, but the removed one is not the candidate again.
    const [removedItem, ...rest] = first.add;
    const afterRemoval = plan({
      memories: many,
      draft: "login error",
      selectedMemoryIds: new Set(rest.map((item) => item.memoryId)),
      state: first.state,
    });
    expect(afterRemoval.add).toHaveLength(1);
    expect(afterRemoval.add[0]?.memoryId).not.toBe(removedItem?.memoryId);
  });

  it("resets for a fresh draft once the draft and selection are both empty", () => {
    const dirty: AutoSelectState = {
      added: new Set(["a"]),
      previouslySelected: new Set(["a"]),
      dismissed: new Set(["login"]),
    };
    const reset = plan({ draft: "", selectedMemoryIds: new Set(), state: dirty });
    expect(reset.state).toBe(EMPTY_AUTO_SELECT_STATE);
    expect(plan({ state: reset.state }).add.map((item) => item.memoryId)).toContain("login");
  });
});
