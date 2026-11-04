import { describe, expect, it } from "vite-plus/test";

import { suggestProjectMemories } from "./projectMemorySuggestions";

const memory = (memoryId: string, title: string, body?: string) => ({ memoryId, title, body });

describe("suggestProjectMemories", () => {
  const items = [
    memory("deploy", "배포 절차"),
    memory("login", "Login error handling"),
    memory("ui", "UI notes"),
    memory("db", "Database migration rules"),
  ];

  it("ranks memories whose title words appear in the draft, including Korean with particles", () => {
    expect(
      suggestProjectMemories("배포를 하기 전에 login 오류부터 고쳐줘", items, new Set()).map(
        (item) => item.memoryId,
      ),
    ).toEqual(["deploy", "login"]);
  });

  it("skips weak matches, selected memories, and short drafts", () => {
    expect(suggestProjectMemories("tweak the ui spacing", items, new Set())).toEqual([]);
    expect(suggestProjectMemories("run the database migration", items, new Set(["db"]))).toEqual(
      [],
    );
    expect(suggestProjectMemories("db", items, new Set())).toEqual([]);
  });

  it("also scores the body, so a draft can match words the title lacks", () => {
    const withBody = [
      memory(
        "release",
        "Release notes",
        "태그를 만들기 전에 pnpm build 와 smoke test 를 실행한다.",
      ),
      memory("other", "Spacing", "Use the 4px grid."),
    ];
    expect(
      suggestProjectMemories("태그 만들기 전에 smoke test 돌려줘", withBody, new Set()).map(
        (item) => item.memoryId,
      ),
    ).toEqual(["release"]);
  });
});
