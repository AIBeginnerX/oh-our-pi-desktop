import { describe, expect, it } from "vite-plus/test";

import { matchSlashCommands, SLASH_COMMANDS, slashQuery } from "./slashCommands.ts";

const names = (query: string) => matchSlashCommands(query).map((command) => command.name);

describe("slashQuery", () => {
  it("is the word after the slash while the text is still one word", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/th")).toBe("th");
    expect(slashQuery("/THREADS")).toBe("threads");
  });

  it("is null once a space ends the command, or when the text is not a command at all", () => {
    expect(slashQuery("/theme aurora")).toBeNull();
    expect(slashQuery("/ ")).toBeNull();
    expect(slashQuery("/a\nb")).toBeNull();
    expect(slashQuery("hello")).toBeNull();
    expect(slashQuery(" /model")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
});

describe("matchSlashCommands", () => {
  it("lists every command, in the menu's order, for an empty query", () => {
    expect(matchSlashCommands("")).toEqual(SLASH_COMMANDS);
    expect(names("")[0]).toBe("model");
  });

  it("keeps the commands whose name begins with the query", () => {
    expect(names("th")).toEqual(["threads", "theme"]);
    expect(names("pro")).toEqual(["provider", "projects"]);
    expect(names("zzz")).toEqual([]);
    expect(names("upd")).toEqual(["update"]);
  });

  it("also matches an alias, and lists the command under its own name", () => {
    expect(names("q")).toEqual(["exit"]);
    expect(names("quit")).toEqual(["exit"]);
    // `/t` stays on `/threads`, the first of the commands that begin with it.
    expect(names("t")).toEqual(["threads", "tasks", "theme"]);
    expect(names("?")).toEqual(["help"]);
    expect(names("models")).toEqual(["model"]);
  });

  it("lists both side-panel commands for /dag, and leaves the provider's own /agents alone", () => {
    expect(names("dag")).toEqual(["dag-workflow", "dag-agents"]);
    expect(names("dag-a")).toEqual(["dag-agents"]);
    expect(names("agents")).toEqual([]);
  });

  it("has a note and no duplicate name or alias for every command", () => {
    const words = SLASH_COMMANDS.flatMap((command) => [command.name, ...command.aliases]);
    expect(new Set(words).size).toBe(words.length);
    for (const command of SLASH_COMMANDS) expect(command.note).not.toBe("");
  });
});

describe("the commands for modes, effort and goals", () => {
  it("lists them with how each is written in /help", () => {
    const byName = (name: string) => SLASH_COMMANDS.find((command) => command.name === name);
    expect(byName("mode")).toMatchObject({ takesArgument: true });
    expect(byName("effort")).toMatchObject({ takesArgument: true });
    expect(byName("goal")).toMatchObject({ takesArgument: true, freeText: true });
    expect(byName("plan")?.takesArgument).toBeUndefined();
    expect(byName("default")?.takesArgument).toBeUndefined();
  });

  it("puts an exact name before a longer one that only starts with it", () => {
    expect(names("mode")).toEqual(["mode", "model"]);
    expect(names("model")).toEqual(["model"]);
  });

  it("finds a command by a word of its description", () => {
    expect(names("목표")).toEqual(["goal"]);
    expect(names("강도")).toEqual(["effort"]);
    expect(names("권한")).toEqual(["mode"]);
  });

  it("keeps the menu's order among commands matched by the same kind of match", () => {
    expect(names("pl")[0]).toBe("plan");
    expect(names("스레드")).toEqual(["goal", "new", "threads", "stats", "sidebar"]);
  });
});
