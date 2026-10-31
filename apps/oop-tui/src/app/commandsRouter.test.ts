import { describe, expect, it } from "vite-plus/test";

import { parseSlash } from "./commandsRouter.ts";

describe("parseSlash", () => {
  it("reads a command, its arguments and the rest of the line", () => {
    expect(parseSlash("/mode full")).toMatchObject({
      command: { name: "mode" },
      args: ["full"],
      rest: "full",
    });
    expect(parseSlash("/MODEL")).toMatchObject({ command: { name: "model" }, args: [], rest: "" });
  });

  it("finds a command by its alias", () => {
    expect(parseSlash("/q")?.command.name).toBe("exit");
    expect(parseSlash("/t")?.command.name).toBe("threads");
  });

  it("keeps a sentence whole for a command that takes text", () => {
    const parsed = parseSlash("/goal  make   the tests pass");
    expect(parsed?.command.name).toBe("goal");
    expect(parsed?.args).toEqual(["make", "the", "tests", "pass"]);
    expect(parsed?.rest).toBe("make   the tests pass");
  });

  it("leaves a line for the agent when the command takes no such argument", () => {
    expect(parseSlash("/q what does this do?")).toBeNull();
    expect(parseSlash("/plan now")).toBeNull();
    expect(parseSlash("/theme a b")).toBeNull();
  });

  it("takes the label of a mode as it is written in the help, space and all", () => {
    expect(parseSlash("/mode 전체 접근")).toMatchObject({
      command: { name: "mode" },
      rest: "전체 접근",
    });
  });

  it("reads the side-panel commands with the words they share", () => {
    expect(parseSlash("/dag-agents")).toMatchObject({ command: { name: "dag-agents" }, args: [] });
    expect(parseSlash("/dag-agents live")).toMatchObject({
      command: { name: "dag-agents" },
      args: ["live"],
    });
    expect(parseSlash("/workflow 2")?.command.name).toBe("dag-workflow");
    // The provider's /agents is not ours.
    expect(parseSlash("/agents")).toBeNull();
    // One word at most, as for /dag-workflow.
    expect(parseSlash("/dag-agents on now")).toBeNull();
  });

  it("is not a command when the word is unknown or there is no slash", () => {
    expect(parseSlash("/nope")).toBeNull();
    expect(parseSlash("mode")).toBeNull();
    expect(parseSlash("")).toBeNull();
  });
});
