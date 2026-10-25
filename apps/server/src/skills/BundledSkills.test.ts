// @effect-diagnostics nodeBuiltinImport:off -- Installs into real temporary home folders.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { BundledSkillListResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { discoverClaudeSkills } from "../provider/Drivers/ClaudeSkills.ts";
import { PIXELGUI_SKILL_MARKDOWN } from "./bundled/pixelguiSkill.ts";
import { installBundledSkill, listBundledSkills } from "./BundledSkills.ts";

const tempHome = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-bundled-skill-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);
const hostAt = (homeDirectory: string) => ({ homeDirectory, environment: {} });
const statuses = (result: BundledSkillListResult) =>
  Object.fromEntries(result.skills[0]!.targets.map((entry) => [entry.target, entry.status]));

describe("BundledSkills", () => {
  it.effect("installs PixelGUI where Claude Code loads it, once, without stray files", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      const before = yield* listBundledSkills(hostAt(home));
      assert.equal(before.skills[0]!.name, "pixelgui");
      assert.isAbove(before.skills[0]!.description.length, 0);
      assert.deepEqual(statuses(before), { claude: "not-installed", agents: "not-installed" });

      const after = yield* installBundledSkill(hostAt(home), {
        name: "pixelgui",
        target: "claude",
      });
      assert.deepEqual(statuses(after), { claude: "installed", agents: "not-installed" });
      const skillDirectory = NodePath.join(home, ".claude", "skills", "pixelgui");
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(skillDirectory, "SKILL.md"), "utf8"),
        ),
        PIXELGUI_SKILL_MARKDOWN,
      );
      assert.deepEqual(yield* Effect.promise(() => NodeFSP.readdir(skillDirectory)), ["SKILL.md"]);

      // The provider's own skill scan, which feeds the picker, now finds it.
      const discovered = yield* discoverClaudeSkills({ homePath: "" }, undefined, {
        CLAUDE_CONFIG_DIR: NodePath.join(home, ".claude"),
      });
      assert.isTrue(discovered.some((skill) => skill.name === "pixelgui"));

      // Installing again is a no-op, not a second copy or an error.
      yield* installBundledSkill(hostAt(home), { name: "pixelgui", target: "claude" });
      assert.deepEqual(yield* Effect.promise(() => NodeFSP.readdir(skillDirectory)), ["SKILL.md"]);

      yield* installBundledSkill(hostAt(home), { name: "pixelgui", target: "agents" });
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(
            NodePath.join(home, ".agents", "skills", "pixelgui", "SKILL.md"),
            "utf8",
          ),
        ),
        PIXELGUI_SKILL_MARKDOWN,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("follows CLAUDE_CONFIG_DIR like Claude Code does", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      const configDir = NodePath.join(home, "custom-claude");
      yield* installBundledSkill(
        { homeDirectory: home, environment: { CLAUDE_CONFIG_DIR: configDir } },
        { name: "pixelgui", target: "claude" },
      );
      yield* Effect.promise(() =>
        NodeFSP.stat(NodePath.join(configDir, "skills", "pixelgui", "SKILL.md")),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never replaces a different skill or follows a link in its place", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      const claudeSkill = NodePath.join(home, ".claude", "skills", "pixelgui");
      const outside = NodePath.join(home, "outside");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(claudeSkill, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(claudeSkill, "SKILL.md"), "the user's own skill");
        await NodeFSP.mkdir(outside);
        await NodeFSP.mkdir(NodePath.join(home, ".agents", "skills"), { recursive: true });
        await NodeFSP.symlink(outside, NodePath.join(home, ".agents", "skills", "pixelgui"));
      });

      assert.deepEqual(statuses(yield* listBundledSkills(hostAt(home))), {
        claude: "different",
        agents: "different",
      });
      const conflict = yield* installBundledSkill(hostAt(home), {
        name: "pixelgui",
        target: "claude",
      }).pipe(Effect.flip);
      assert.equal(conflict.reason, "conflict");
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(claudeSkill, "SKILL.md"), "utf8"),
        ),
        "the user's own skill",
      );
      const unsafe = yield* installBundledSkill(hostAt(home), {
        name: "pixelgui",
        target: "agents",
      }).pipe(Effect.flip);
      assert.equal(unsafe.reason, "unsafe-target");
      assert.deepEqual(yield* Effect.promise(() => NodeFSP.readdir(outside)), []);

      const unknown = yield* installBundledSkill(hostAt(home), {
        name: "not-shipped",
        target: "claude",
      }).pipe(Effect.flip);
      assert.equal(unknown.reason, "unknown-skill");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
