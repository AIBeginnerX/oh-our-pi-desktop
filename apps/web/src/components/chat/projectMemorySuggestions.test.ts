import { describe, expect, it } from "vite-plus/test";

import { suggestProjectMemories } from "./projectMemorySuggestions";

const memory = (memoryId: string, title: string) => ({ memoryId, title });

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
    ).toEqual(["login", "deploy"]);
  });

  it("skips weak matches, selected memories, and short drafts", () => {
    expect(suggestProjectMemories("tweak the ui spacing", items, new Set())).toEqual([]);
    expect(suggestProjectMemories("run the database migration", items, new Set(["db"]))).toEqual(
      [],
    );
    expect(suggestProjectMemories("db", items, new Set())).toEqual([]);
  });
});
