/**
 * Skills OOP ships, installed on request into a provider's own user skill folder on this host.
 * The provider CLI loads them from there and the provider snapshot's skill scan then lists them in
 * the `$` picker, so an installed bundled skill is an ordinary provider skill, not an OOP-only one.
 *
 * Installing never replaces anything: a folder of the same name with other content, or a link in
 * its place, is reported and left alone. Results name skills and target kinds, never paths.
 *
 * @module skills/BundledSkills
 */
import * as NodeOS from "node:os";

import {
  BundledSkillError,
  type BundledSkillInstallInput,
  type BundledSkillInstallStatus,
  type BundledSkillListResult,
  type BundledSkillTarget,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { PIXELGUI_SKILL_MARKDOWN } from "./bundled/pixelguiSkill.ts";

interface BundledSkill {
  readonly name: string;
  readonly markdown: string;
}

export const BUNDLED_SKILLS: ReadonlyArray<BundledSkill> = [
  { name: "pixelgui", markdown: PIXELGUI_SKILL_MARKDOWN },
];

const TARGETS: ReadonlyArray<BundledSkillTarget> = ["claude", "agents"];

const descriptionOf = (markdown: string): string =>
  /^description:[ \t]*(.+)$/m.exec(markdown)?.[1]?.trim() ?? "";

/** Where the host's providers read user skills; mirrors how Claude Code finds its config dir. */
export interface BundledSkillHost {
  readonly homeDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}

/** This server process's own host: the user it runs as and its environment. */
export const processBundledSkillHost = (): BundledSkillHost => ({
  homeDirectory: NodeOS.homedir(),
  environment: process.env,
});

const skillRoot = (path: Path.Path, host: BundledSkillHost, target: BundledSkillTarget) => {
  if (target === "agents") return path.join(host.homeDirectory, ".agents", "skills");
  const configured = host.environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  return path.join(
    configured.length > 0 ? path.resolve(configured) : path.join(host.homeDirectory, ".claude"),
    "skills",
  );
};

const statusAt = Effect.fn("BundledSkills.statusAt")(function* (
  skillDirectory: string,
  markdown: string,
): Effect.fn.Return<
  BundledSkillInstallStatus | "unsafe",
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isLink = yield* fileSystem.readLink(skillDirectory).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (isLink) return "unsafe";
  const info = yield* fileSystem.stat(skillDirectory).pipe(Effect.option);
  if (info._tag === "None") return "not-installed";
  if (info.value.type !== "Directory") return "unsafe";
  const existing = yield* fileSystem
    .readFileString(path.join(skillDirectory, "SKILL.md"))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (existing !== undefined) return existing === markdown ? "installed" : "different";
  const entries = yield* fileSystem
    .readDirectory(skillDirectory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => ["unreadable"]));
  return entries.length === 0 ? "not-installed" : "different";
});

export const listBundledSkills = Effect.fn("BundledSkills.list")(function* (
  host: BundledSkillHost,
): Effect.fn.Return<BundledSkillListResult, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const skills = [];
  for (const skill of BUNDLED_SKILLS) {
    const targets = [];
    for (const target of TARGETS) {
      const status = yield* statusAt(
        path.join(skillRoot(path, host, target), skill.name),
        skill.markdown,
      );
      targets.push({ target, status: status === "unsafe" ? ("different" as const) : status });
    }
    skills.push({ name: skill.name, description: descriptionOf(skill.markdown), targets });
  }
  return { skills };
});

export const installBundledSkill = Effect.fn("BundledSkills.install")(function* (
  host: BundledSkillHost,
  input: BundledSkillInstallInput,
): Effect.fn.Return<
  BundledSkillListResult,
  BundledSkillError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skill = BUNDLED_SKILLS.find((candidate) => candidate.name === input.name);
  if (skill === undefined) return yield* new BundledSkillError({ reason: "unknown-skill" });

  const skillDirectory = path.join(skillRoot(path, host, input.target), skill.name);
  const status = yield* statusAt(skillDirectory, skill.markdown);
  if (status === "unsafe") return yield* new BundledSkillError({ reason: "unsafe-target" });
  if (status === "different") return yield* new BundledSkillError({ reason: "conflict" });
  if (status === "not-installed") {
    const writeFailed = () => new BundledSkillError({ reason: "write-failed" });
    yield* fileSystem
      .makeDirectory(skillDirectory, { recursive: true })
      .pipe(Effect.mapError(writeFailed));
    // Write beside the final name, then hard-link it into place: the link fails if a SKILL.md
    // appeared meanwhile, so nothing another writer put there is ever overwritten.
    const stagingId = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.mapError(writeFailed));
    const staging = path.join(skillDirectory, `.SKILL.md.${stagingId}`);
    yield* fileSystem
      .writeFileString(staging, skill.markdown, { flag: "wx" })
      .pipe(Effect.mapError(writeFailed));
    const published = yield* fileSystem.link(staging, path.join(skillDirectory, "SKILL.md")).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    yield* fileSystem.remove(staging).pipe(Effect.ignore);
    if (!published) return yield* new BundledSkillError({ reason: "conflict" });
  }
  return yield* listBundledSkills(host);
});
