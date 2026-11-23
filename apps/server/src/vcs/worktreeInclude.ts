// @effect-diagnostics nodeBuiltinImport:off - lstat and exclusive copy are needed to skip symlinks and protect existing files.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import type { GitVcsDriver } from "./GitVcsDriver.ts";
import { splitNullSeparatedGitStdoutPaths } from "./gitOutputParsers.ts";

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

class WorktreeIncludeGitError extends Data.TaggedError("WorktreeIncludeGitError")<{
  message: string;
}> {}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isInside(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

// True when no symlink redirected the path. A disk may store a name decomposed
// while Git reports it composed, so the two spellings count as the same path.
async function isUnredirected(file: string): Promise<boolean> {
  return (await NodeFSP.realpath(file)).normalize("NFC") === file.normalize("NFC");
}

function resolveInside(root: string, relative: string): string | undefined {
  const segments = relative.split("/");
  if (NodePath.isAbsolute(relative) || segments.includes("..")) return;
  const resolved = NodePath.resolve(root, relative);
  if (isInside(root, resolved)) return resolved;
}

// These names only bound directory traversal. Git decides which paths match.
function namedSegments(patterns: string): Set<string> {
  const names = new Set<string>();
  for (const line of patterns.split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    for (const segment of line
      .replace(/^!/, "")
      .replace(/(?<!\\) +$/, "")
      .split("/")) {
      if (segment && !/[*?[]/.test(segment)) {
        names.add(segment.replace(/\\(.)/g, "$1").toLowerCase());
      }
    }
  }
  return names;
}

async function checkDestinationParents(
  worktree: string,
  destination: string,
  create: boolean,
): Promise<boolean> {
  let parent = worktree;
  for (const segment of NodePath.relative(worktree, NodePath.dirname(destination))
    .split(NodePath.sep)
    .filter(Boolean)) {
    parent = NodePath.join(parent, segment);
    if (create) {
      await NodeFSP.mkdir(parent).catch((error: unknown) => {
        if (!hasCode(error, "EEXIST")) throw error;
      });
    }
    try {
      if (!(await NodeFSP.lstat(parent)).isDirectory()) return false;
    } catch (error) {
      if (!create && hasCode(error, "ENOENT")) return true;
      throw error;
    }
  }
  return isUnredirected(parent);
}

async function copyRegularFile(root: string, worktree: string, relative: string): Promise<boolean> {
  const source = resolveInside(root, relative);
  const destination = resolveInside(worktree, relative);
  if (!source || !destination || isInside(worktree, source)) return false;
  if (!(await NodeFSP.lstat(source)).isFile() || !(await isUnredirected(source))) return false;
  if (!(await checkDestinationParents(worktree, destination, true))) return false;

  try {
    await NodeFSP.copyFile(source, destination, NodeFS.constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false;
    throw error;
  }
}

export const copyWorktreeIncludes = Effect.fnUntraced(function* (
  execute: GitVcsDriver["Service"]["execute"],
  fileSystem: FileSystem.FileSystem,
  cwd: string,
  worktreePath: string,
) {
  const runGit = (cwd: string, args: readonly string[], stdin?: string) =>
    execute({
      operation: "GitVcsDriver.createWorktree.localFiles",
      cwd,
      args,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      ...(stdin === undefined ? {} : { stdin, allowNonZeroExit: true }),
    });
  const rootResult = yield* runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const rootPath = rootResult.stdout.replace(/\r?\n$/, "");
  const include = NodePath.join(rootPath, ".worktreeinclude");
  if (!(yield* fileSystem.exists(include))) return 0;

  const patterns = yield* fileSystem.readFileString(include);
  const names = namedSegments(patterns);
  const [root, worktree] = yield* Effect.tryPromise(() =>
    Promise.all([
      NodeFSP.realpath(rootPath),
      NodeFSP.realpath(NodePath.resolve(cwd, worktreePath)),
    ]),
  );
  const lsIgnored = ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"];
  const listings = yield* runGit(root, [...lsIgnored, "--directory"]);
  const inScope = (relative: string) => {
    const resolved = resolveInside(root, relative);
    return resolved !== undefined && resolved !== worktree && !isInside(worktree, resolved);
  };
  const checkIgnored = Effect.fnUntraced(function* (
    cwd: string,
    entries: readonly string[],
    gitOptions: readonly string[] = [],
  ) {
    if (entries.length === 0) return [];
    // Prefix each path so a leading colon cannot introduce pathspec magic.
    const matches = yield* runGit(
      cwd,
      [...gitOptions, "check-ignore", "--stdin", "-z"],
      `${entries.map((file) => `./${file}`).join("\0")}\0`,
    );
    if (matches.exitCode !== 0 && matches.exitCode !== 1) {
      return yield* new WorktreeIncludeGitError({
        message: "Git could not match worktree include paths",
      });
    }
    return splitNullSeparatedGitStdoutPaths(matches).map((file) => file.slice(2));
  });

  const candidates = new Set<string>();
  const namedDirectories = new Set<string>();
  for (const entry of splitNullSeparatedGitStdoutPaths(listings)) {
    if (!inScope(entry)) continue;
    if (!entry.endsWith("/")) {
      candidates.add(entry);
      continue;
    }
    let prefix = "";
    for (const segment of entry.slice(0, -1).split("/")) {
      prefix += `${segment}/`;
      if (names.has(segment.toLowerCase())) namedDirectories.add(prefix);
    }
  }
  // A named parent must itself be ignored before it can open the scope to
  // descendants. The collapsed listing can contain unignored parent entries.
  const ignoredDirectories = new Set(yield* checkIgnored(root, [...namedDirectories]));
  let skippedDirectories = 0;
  for (const entry of ignoredDirectories) {
    const segments = entry.slice(0, -1).split("/");
    let prefix = "";
    const coveredByParent = segments.slice(0, -1).some((segment) => {
      prefix += `${segment}/`;
      return ignoredDirectories.has(prefix);
    });
    if (coveredByParent) continue;
    const expanded = yield* runGit(root, ["--literal-pathspecs", ...lsIgnored, "--", entry]).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (expanded === null) {
      skippedDirectories++;
      continue;
    }
    for (const file of splitNullSeparatedGitStdoutPaths(expanded)) {
      if (!file.endsWith("/") && inScope(file)) candidates.add(file);
    }
  }
  if (skippedDirectories > 0) {
    yield* Effect.logWarning("Could not expand some worktree include directories", {
      count: skippedDirectories,
    });
  }
  if (candidates.size === 0) return 0;

  // ls-files has no stdin pathspec support. Check all candidates at once in a
  // scratch repo where only the include patterns participate in matching. It
  // matches case the way the source repository does, not the way its own disk would.
  const ignoreCase = yield* runGit(root, [
    "config",
    "--type=bool",
    "--default=false",
    "--get",
    "core.ignorecase",
  ]);
  const scratch = yield* fileSystem.makeTempDirectoryScoped({ prefix: "oop-worktree-include-" });
  yield* runGit(scratch, ["init", "--quiet", "--template="]);
  yield* fileSystem.writeFileString(NodePath.join(scratch, ".gitignore"), patterns);
  const matches = yield* checkIgnored(
    scratch,
    [...candidates],
    [
      "-c",
      `core.excludesFile=${NodePath.join(scratch, "empty-excludes")}`,
      "-c",
      `core.ignorecase=${ignoreCase.stdout.trim()}`,
    ],
  );

  let count = 0;
  let failures = 0;
  // Git rejects the entire batch if any path descends through a symlink.
  const safeMatches = yield* Effect.filter(matches, (relative) =>
    Effect.tryPromise(async () => {
      const destination = resolveInside(worktree, relative);
      return destination !== undefined && checkDestinationParents(worktree, destination, false);
    }).pipe(
      Effect.catch(() => {
        failures++;
        return Effect.succeed(false);
      }),
    ),
  );
  for (const relative of yield* checkIgnored(worktree, safeMatches)) {
    const copied = yield* Effect.tryPromise(() => copyRegularFile(root, worktree, relative)).pipe(
      Effect.catch(() => {
        failures++;
        return Effect.succeed(false);
      }),
    );
    if (copied) count++;
  }
  if (failures > 0)
    yield* Effect.logWarning("Could not copy some worktree local files", { count: failures });
  return count;
});
