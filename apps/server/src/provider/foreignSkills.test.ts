// @effect-diagnostics nodeBuiltinImport:off - Real filesystem fixtures verify bounded reads and symlink confinement.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ServerProvider } from "@t3tools/contracts";
import { FOREIGN_SKILL_MAX_BYTES, inlineForeignSkills } from "./foreignSkills.ts";

let root: string;
afterEach(async () => {
  if (root) await NodeFSP.rm(root, { recursive: true, force: true });
});
async function fixture(body = "---\nname: demo\n---\nFollow these steps") {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foreign-skills-"));
  const dir = NodePath.join(root, ".claude/skills/demo");
  await NodeFSP.mkdir(dir, { recursive: true });
  const path = NodePath.join(dir, "SKILL.md");
  await NodeFSP.writeFile(path, body);
  const providers = [
    { instanceId: "codex", driver: "codex", enabled: true, skills: [] },
    {
      instanceId: "claude",
      driver: "claude-code",
      enabled: true,
      skills: [{ name: "demo", path, enabled: true }],
    },
  ] as unknown as ServerProvider[];
  return { text: "$demo user arguments", instanceId: "codex", providers };
}
describe("inlineForeignSkills", () => {
  it("inlines foreign instructions, primary provider and tool fallback with arguments", async () => {
    const result = await inlineForeignSkills(await fixture());
    expect(result).toContain("$demo user arguments");
    expect(result).toContain("주 모델: claude-code");
    expect(result).toContain("perform the step sequentially or ask the user directly");
    expect(result).toContain("Follow these steps");
    expect(result).not.toContain("name: demo");
  });
  it("leaves native invocations unchanged", async () => {
    const input = await fixture();
    input.instanceId = "claude";
    expect(await inlineForeignSkills(input)).toBe(input.text);
  });
  it("leaves unknown mentions unchanged", async () => {
    const input = await fixture();
    input.text = "$unknown args";
    expect(await inlineForeignSkills(input)).toBe(input.text);
  });
  it("caps file reads and marks truncation", async () => {
    const result = await inlineForeignSkills(
      await fixture("x".repeat(FOREIGN_SKILL_MAX_BYTES + 100)),
    );
    expect(result).toContain("[Skill truncated at 64 KB.]");
    expect(result).not.toContain("x".repeat(FOREIGN_SKILL_MAX_BYTES + 1));
  });
  it("refuses symlinks escaping the skill root", async () => {
    const input = await fixture();
    const skill = input.providers[1]!.skills[0]!;
    await NodeFSP.rm(skill.path);
    const outside = NodePath.join(root, "secret.md");
    await NodeFSP.writeFile(outside, "secret");
    await NodeFSP.symlink(outside, skill.path);
    expect(await inlineForeignSkills(input)).toBe(input.text);
  });
});
