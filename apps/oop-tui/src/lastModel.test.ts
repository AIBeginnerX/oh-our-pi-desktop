import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ModelSelection } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { readLastModel, writeLastModel } from "./lastModel.ts";

const folders: string[] = [];
const fresh = () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-last-model-"));
  folders.push(folder);
  return NodePath.join(folder, "config", "last-model.json");
};
afterEach(() => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});

describe("last model file", () => {
  it("round-trips a selection with its options", () => {
    const file = fresh();
    const selection = {
      instanceId: "codex",
      model: "gpt-5",
      options: [{ id: "reasoningEffort", value: "high" }],
    } as unknown as ModelSelection;
    writeLastModel(file, selection);
    expect(readLastModel(file)).toEqual(selection);
  });

  it("reads null for a missing or damaged file", () => {
    const file = fresh();
    expect(readLastModel(file)).toBeNull();
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, "{ not json");
    expect(readLastModel(file)).toBeNull();
    NodeFS.writeFileSync(file, JSON.stringify({ instanceId: 3 }));
    expect(readLastModel(file)).toBeNull();
  });
});
