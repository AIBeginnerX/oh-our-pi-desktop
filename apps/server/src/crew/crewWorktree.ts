/**
 * Git work behind `isolation: "worktree"` crew tasks.
 *
 * A task that edits code in parallel gets its own detached worktree, started from the lead's
 * tracked state, and its changes are applied back to the lead's workspace when it finishes.
 *
 * @module crewWorktree
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const CREW_WORKTREES_DIR = "crew-worktrees";
const GIT_TIMEOUT_MS = 60_000;

/** Where a crew task works instead of the lead's workspace; persisted so a restart can finish it. */
export interface CrewWorktree {
  /** The lead's repository top level, where the member's patch is applied. */
  readonly repoRoot: string;
  /** The top level of the crew worktree. */
  readonly path: string;
  /** The commit the worktree started from: the lead's tracked state when the task was handed over. */
  readonly base: string;
  /** The directory the crew thread works in: the lead's own directory, inside the worktree. */
  readonly cwd: string;
}

export type CrewMergeResult =
  | { readonly merged: true }
  | {
      readonly merged: false;
      readonly files: ReadonlyArray<string>;
      readonly detail: string;
      readonly patchPath: string;
    };

/** The files `git apply` refused, read from its stderr. */
export function applyConflictFiles(stderr: string): ReadonlyArray<string> {
  const files = stderr.split("\n").flatMap((line) => {
    const failed = /^error: patch failed: (.+):\d+$/.exec(line);
    if (failed?.[1] !== undefined) return [failed[1]];
    const refused =
      /^error: (.+): (?:patch does not apply|already exists in working directory|does not exist in working tree|does not match index)$/.exec(
        line,
      );
    return refused?.[1] === undefined ? [] : [refused[1]];
  });
  return [...new Set(files)];
}

/** What the lead reads when a member's changes could not be applied and its worktree was kept. */
export function mergeConflictNote(
  worktree: CrewWorktree,
  result: Extract<CrewMergeResult, { readonly merged: false }>,
): string {
  return [
    "",
    "ISOLATED WORKTREE: this member's changes were NOT applied to the workspace.",
    result.files.length > 0
      ? `Conflicting files: ${result.files.join(", ")}`
      : `Reason: ${result.detail}`,
    `Its worktree is kept at ${worktree.path}; its full patch is ${result.patchPath}.`,
    `Inspect it with \`git -C ${worktree.path} status\`, or apply it yourself with \`git -C ${worktree.repoRoot} apply --3way ${result.patchPath}\` and resolve the markers.`,
  ].join("\n");
}

export const makeCrewWorktrees = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Two members finishing together would otherwise patch the lead's files at the same time.
  const mergeLock = yield* Semaphore.make(1);

  const run = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: `CrewWorktree.${operation}`, cwd, args, timeoutMs: GIT_TIMEOUT_MS });
  // For commands whose exit code is the answer (`diff --quiet`, `apply --check`).
  const probe = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git.execute({
      operation: `CrewWorktree.${operation}`,
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: GIT_TIMEOUT_MS,
    });

  /**
   * A detached worktree at the lead's current tracked state: `stash create` writes the uncommitted
   * tracked changes into a commit without touching the working tree, the index, or the stash
   * list, and prints nothing when there are none, in which case HEAD is the state. Untracked
   * files are not part of it. Fails when `cwd` is not a repository with a commit.
   */
  const create = Effect.fn("CrewWorktree.create")(function* (input: {
    readonly taskId: string;
    readonly cwd: string;
  }) {
    const repoRoot = (yield* run("toplevel", input.cwd, [
      "rev-parse",
      "--show-toplevel",
    ])).stdout.trim();
    const prefix = (yield* run("prefix", input.cwd, ["rev-parse", "--show-prefix"])).stdout.trim();
    const snapshot = (yield* run("snapshot", repoRoot, ["stash", "create"])).stdout.trim();
    const base =
      snapshot !== ""
        ? snapshot
        : (yield* run("head", repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const worktreePath = path.join(config.stateDir, CREW_WORKTREES_DIR, input.taskId);
    yield* git.createWorktree({ cwd: repoRoot, refName: base, path: worktreePath });
    return {
      repoRoot,
      path: worktreePath,
      base,
      cwd: path.join(worktreePath, prefix),
    } satisfies CrewWorktree;
  });

  const patchPathOf = (worktree: CrewWorktree) => `${worktree.path}.patch`;

  /** Removes the worktree and its patch. Best effort: a leftover directory only wastes disk. */
  const discard = (worktree: CrewWorktree) =>
    Effect.gen(function* () {
      yield* git.removeWorktree({ cwd: worktree.repoRoot, path: worktree.path, force: true });
      yield* git.pruneWorktrees({ cwd: worktree.repoRoot });
    }).pipe(
      Effect.catch((error) => Effect.logWarning("crew worktree cleanup failed", { error })),
      Effect.andThen(fs.remove(patchPathOf(worktree), { force: true })),
      Effect.ignore,
    );

  const attemptMerge = Effect.fn("CrewWorktree.attemptMerge")(function* (worktree: CrewWorktree) {
    const patchPath = patchPathOf(worktree);
    // A worktree that is already gone was merged and removed before a restart interrupted us.
    if (!(yield* fs.exists(worktree.path))) return { merged: true } as const;
    // Stage inside the crew worktree (never the lead's index) so new files reach the diff.
    yield* run("stage", worktree.path, ["add", "-A"]);
    const unchanged =
      (yield* probe("changed", worktree.path, ["diff", "--cached", "--quiet", worktree.base]))
        .exitCode === 0;
    if (unchanged) {
      yield* discard(worktree);
      return { merged: true } as const;
    }
    // --output keeps the patch out of the stdout decoder, which would mangle non-UTF-8 content.
    yield* run("diff", worktree.path, [
      "diff",
      "--binary",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      `--output=${patchPath}`,
      worktree.base,
    ]);
    // Plain `apply` writes the working tree only: the lead's index and staged state stay as they
    // were (`--3way` and `--index` would stage), and it applies all or nothing, so a conflict
    // leaves the lead's files untouched.
    const apply = ["apply", "--binary", "--whitespace=nowarn"] as const;
    const applied = yield* probe("apply", worktree.repoRoot, [...apply, patchPath]);
    if (applied.exitCode !== 0) {
      // A patch that reverses cleanly is already in the workspace (interrupted earlier merge).
      const present = yield* probe("applied", worktree.repoRoot, [
        ...apply,
        "--reverse",
        "--check",
        patchPath,
      ]);
      if (present.exitCode !== 0) {
        return {
          merged: false,
          files: applyConflictFiles(applied.stderr),
          detail: applied.stderr.trim().split("\n")[0] ?? "git apply failed",
          patchPath,
        } as const;
      }
    }
    yield* discard(worktree);
    return { merged: true } as const;
  });

  /**
   * Applies what the member changed, new files included, to the lead's workspace, then removes the
   * worktree. A conflict or git failure keeps the worktree and its patch for the lead.
   */
  const mergeBack = (worktree: CrewWorktree): Effect.Effect<CrewMergeResult> =>
    mergeLock
      .withPermits(1)(attemptMerge(worktree))
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({
            merged: false,
            files: [],
            detail: error.message,
            patchPath: patchPathOf(worktree),
          } as const),
        ),
      );

  return { create, mergeBack, discard };
});
