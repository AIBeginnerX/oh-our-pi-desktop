// @effect-diagnostics nodeBuiltinImport:off - Bounded descriptor reads avoid loading an unbounded skill into memory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ServerProvider } from "@t3tools/contracts";

export const FOREIGN_SKILL_MAX_BYTES = 64 * 1024;

/** A `$name` skill mention as the composer inserts it. */
export const FOREIGN_SKILL_MENTION = /(?:^|\s)\$([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/;

// Only files discovered by a local provider snapshot are eligible. Resolve both
// ends before opening so a symlink cannot escape that provider's skills root.
async function readSkill(path: string): Promise<string | undefined> {
  const normalized = path.replaceAll("\\", "/");
  // Discovery is the authority for this path; custom config directories and
  // plugin stores may put the skill root outside the standard home directory.
  const rootEnd = normalized.lastIndexOf("/skills/");
  if (rootEnd < 0 || NodePath.basename(path) !== "SKILL.md" || !NodePath.isAbsolute(path)) return;
  const root = normalized.slice(0, rootEnd + 7);
  const [canonicalRoot, canonicalFile] = await Promise.all([
    NodeFSP.realpath(root),
    NodeFSP.realpath(path),
  ]);
  const inside = NodePath.relative(canonicalRoot, canonicalFile);
  if (inside === ".." || inside.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(inside))
    return;
  const file = await NodeFSP.open(canonicalFile, "r");
  try {
    if (!(await file.stat()).isFile()) return;
    const bytes = Buffer.alloc(FOREIGN_SKILL_MAX_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    let body = bytes.subarray(0, Math.min(bytesRead, FOREIGN_SKILL_MAX_BYTES)).toString("utf8");
    body = body.replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
    // A capped frontmatter block must never become instructions accidentally.
    if (/^(?:\uFEFF)?---\r?\n/.test(body)) return;
    return body + (bytesRead > FOREIGN_SKILL_MAX_BYTES ? "\n[Skill truncated at 64 KB.]" : "");
  } finally {
    await file.close();
  }
}

export async function inlineForeignSkills(input: {
  text: string;
  instanceId: string;
  providers: ReadonlyArray<ServerProvider>;
  cwd?: string;
}): Promise<string> {
  const skills = (provider: ServerProvider) =>
    provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === input.cwd)?.skills ??
    provider.skills;
  const target = input.providers.find((provider) => provider.instanceId === input.instanceId);
  const native = new Set(target ? skills(target).map((skill) => skill.name) : []);
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const match of input.text.matchAll(new RegExp(FOREIGN_SKILL_MENTION, "g"))) {
    const name = match[1]!;
    if (native.has(name) || seen.has(name)) continue;
    seen.add(name);
    for (const provider of input.providers) {
      if (provider.instanceId === input.instanceId || !provider.enabled) continue;
      const skill = skills(provider).find(
        (entry) => entry.name === name && entry.enabled && entry.userInvocable !== false,
      );
      if (!skill) continue;
      const body = await readSkill(skill.path).catch(() => undefined);
      if (body === undefined) continue;
      sections.push(
        `Skill: ${name}\n주 모델: ${provider.driver}\nFollow this skill using your own equivalent tools. If a named tool (Agent/Task, Skill, AskUserQuestion, TodoWrite, WebFetch, etc.) is unavailable, perform the step sequentially or ask the user directly.\n\n${body}`,
      );
      break;
    }
  }
  return sections.length ? `${input.text}\n\n${sections.join("\n\n")}` : input.text;
}
