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
import { BUNDLED_SKILLS, installBundledSkill, listBundledSkills } from "./BundledSkills.ts";

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

  it.effect(
    "ships the verification and arena skills, each installable and found by the provider scan",
    () =>
      Effect.gen(function* () {
        const names = ["create-verification-skill", "maintain-verification-skill", "arena"];
        const home = yield* tempHome;
        const listed = yield* listBundledSkills(hostAt(home));
        for (const name of names) {
          const entry = listed.skills.find((skill) => skill.name === name);
          assert.isDefined(entry);
          assert.isAbove(entry!.description.length, 0);
          assert.isFalse(entry!.description.startsWith('"'));
        }

        for (const name of names) {
          const markdown = BUNDLED_SKILLS.find((skill) => skill.name === name)!.markdown;
          assert.isTrue(markdown.startsWith(`---\nname: ${name}\n`));
          assert.include(markdown, "Adapted from pstack by Lauren Tan (MIT)");
          assert.notMatch(markdown, /\.cursor|bugbot|add-plugin/i);
          for (const target of ["claude", "agents"] as const) {
            yield* installBundledSkill(hostAt(home), { name, target });
            const root = target === "claude" ? ".claude" : ".agents";
            assert.equal(
              yield* Effect.promise(() =>
                NodeFSP.readFile(NodePath.join(home, root, "skills", name, "SKILL.md"), "utf8"),
              ),
              markdown,
            );
          }
        }
        const discovered = yield* discoverClaudeSkills({ homePath: "" }, undefined, {
          CLAUDE_CONFIG_DIR: NodePath.join(home, ".claude"),
        });
        for (const name of names) {
          assert.isTrue(discovered.some((skill) => skill.name === name));
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "ships handoff and retro as on-demand mattpocock skills, with the MIT license beside them",
    () =>
      Effect.gen(function* () {
        const names = ["handoff", "retro"];
        const home = yield* tempHome;
        const listed = yield* listBundledSkills(hostAt(home));
        for (const name of names) {
          const entry = listed.skills.find((skill) => skill.name === name);
          assert.isDefined(entry);
          assert.isAbove(entry!.description.length, 0);
          assert.isFalse(entry!.description.startsWith('"'));
        }

        for (const name of names) {
          const markdown = BUNDLED_SKILLS.find((skill) => skill.name === name)!.markdown;
          assert.isTrue(markdown.startsWith(`---\nname: ${name}\n`));
          // On demand only: no always-on prompt cost.
          assert.include(markdown, "\ndisable-model-invocation: true\n");
          assert.include(markdown, "Adapted from mattpocock/skills by Matt Pocock (MIT)");
          assert.notMatch(markdown, /writing-for-agents|claude-handoff/i);
          for (const target of ["claude", "agents"] as const) {
            yield* installBundledSkill(hostAt(home), { name, target });
            const root = target === "claude" ? ".claude" : ".agents";
            assert.equal(
              yield* Effect.promise(() =>
                NodeFSP.readFile(NodePath.join(home, root, "skills", name, "SKILL.md"), "utf8"),
              ),
              markdown,
            );
          }
        }

        const license = yield* Effect.promise(() =>
          NodeFSP.readFile(
            NodePath.join(import.meta.dirname, "bundled", "mattpocock-LICENSE"),
            "utf8",
          ),
        );
        assert.include(license, "MIT License");
        assert.include(license, "Copyright (c) 2026 Matt Pocock");
        assert.include(license, 'THE SOFTWARE IS PROVIDED "AS IS"');
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "ships paper-analysis and deep-research as on-demand skills with their upstream MIT licenses",
    () =>
      Effect.gen(function* () {
        const cases = [
          {
            name: "paper-analysis",
            credit: "Adapted from 917Dhj/DeepPaperNote by 917Dhj (MIT)",
            licenses: [["deeppapernote-LICENSE", "Copyright (c) 2026 dingdingcar"]],
          },
          {
            name: "deep-research",
            credit: "Adapted from Weizhena/Deep-Research-skills by Weizhena (MIT)",
            licenses: [
              ["deep-research-skills-LICENSE", "Copyright (c) 2026 Lan Zheng"],
              ["last30days-LICENSE", "Copyright (c) 2026 Matt Van Horn"],
            ],
          },
        ] as const;
        const home = yield* tempHome;
        const listed = yield* listBundledSkills(hostAt(home));
        for (const { name, credit, licenses } of cases) {
          const entry = listed.skills.find((skill) => skill.name === name);
          assert.isDefined(entry);
          assert.isAbove(entry!.description.length, 0);
          assert.isFalse(entry!.description.startsWith('"'));

          const markdown = BUNDLED_SKILLS.find((skill) => skill.name === name)!.markdown;
          assert.isTrue(markdown.startsWith(`---\nname: ${name}\n`));
          assert.include(markdown, "\ndisable-model-invocation: true\n");
          assert.include(markdown, credit);
          for (const target of ["claude", "agents"] as const) {
            yield* installBundledSkill(hostAt(home), { name, target });
            const root = target === "claude" ? ".claude" : ".agents";
            assert.equal(
              yield* Effect.promise(() =>
                NodeFSP.readFile(NodePath.join(home, root, "skills", name, "SKILL.md"), "utf8"),
              ),
              markdown,
            );
          }
          for (const [file, copyright] of licenses) {
            const license = yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(import.meta.dirname, "bundled", file), "utf8"),
            );
            assert.include(license, "MIT License");
            assert.include(license, copyright);
            assert.include(license, 'THE SOFTWARE IS PROVIDED "AS IS"');
          }
        }
        const discovered = yield* discoverClaudeSkills({ homePath: "" }, undefined, {
          CLAUDE_CONFIG_DIR: NodePath.join(home, ".claude"),
        });
        for (const { name } of cases) {
          assert.isTrue(discovered.some((skill) => skill.name === name));
        }
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
