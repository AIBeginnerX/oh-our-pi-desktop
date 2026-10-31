import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { WorkspaceLists } from "./workspaceLists.ts";

const provider = (cwds: ReadonlyArray<string> = []) =>
  ({
    instanceId: "codex",
    enabled: true,
    workspaceSnapshots: cwds.map((cwd) => ({ cwd })),
  }) as unknown as ServerProvider;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const setup = () => {
  const calls: string[] = [];
  let clock = 0;
  let fail = false;
  const lists = new WorkspaceLists({
    refresh: ({ cwd }) => {
      calls.push(cwd);
      return fail ? Promise.reject(new Error("down")) : Promise.resolve();
    },
    now: () => clock,
    changed: () => undefined,
  });
  return {
    lists,
    calls,
    advance: (ms: number) => void (clock += ms),
    failing: (value: boolean) => void (fail = value),
  };
};

describe("WorkspaceLists", () => {
  it("asks once while the answer is out, and not at all once the folder is listed", async () => {
    const t = setup();
    t.lists.ensure(provider(), "/work");
    t.lists.ensure(provider(), "/work");
    expect(t.calls).toEqual(["/work"]);
    await flush();
    t.lists.ensure(provider(["/work"]), "/work");
    t.advance(3_600_000);
    t.lists.ensure(provider(["/work"]), "/work");
    expect(t.calls).toEqual(["/work"]);
  });

  it("asks again when a restarted server lost a list it had", async () => {
    const t = setup();
    t.lists.ensure(provider(["/work"]), "/work");
    expect(t.calls).toEqual([]);
    t.lists.ensure(provider(), "/work");
    expect(t.calls).toEqual(["/work"]);
    expect(t.lists.pending(provider(), "/work")).toBe(true);
  });

  it("asks again, less and less often, after an answer without a list", async () => {
    const t = setup();
    t.lists.ensure(provider(), "/work");
    await flush();
    expect(t.lists.pending(provider(), "/work")).toBe(false);
    t.advance(9_999);
    t.lists.ensure(provider(), "/work");
    expect(t.calls).toHaveLength(1);
    t.advance(1);
    t.lists.ensure(provider(), "/work");
    expect(t.calls).toHaveLength(2);
    await flush();
    t.advance(59_999);
    t.lists.ensure(provider(), "/work");
    expect(t.calls).toHaveLength(2);
    t.advance(1);
    t.lists.ensure(provider(), "/work");
    expect(t.calls).toHaveLength(3);
    await flush();
    t.advance(299_999);
    t.lists.ensure(provider(), "/work");
    expect(t.calls).toHaveLength(3);
    t.advance(1);
    t.lists.ensure(provider(), "/work");
    expect(t.calls).toHaveLength(4);
  });

  it("says the list may be late after a failure, and tries again after a pause", async () => {
    const t = setup();
    t.failing(true);
    t.lists.ensure(provider(), "/work");
    await flush();
    expect(t.lists.pending(provider(), "/work")).toBe(true);
    t.failing(false);
    t.lists.ensure(provider(), "/work");
    expect(t.calls).toHaveLength(1);
    t.advance(10_000);
    t.lists.ensure(provider(), "/work");
    expect(t.calls).toHaveLength(2);
  });
});
