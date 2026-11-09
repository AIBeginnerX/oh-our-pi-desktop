/**
 * What the server runs itself to verify a crew TODO item, so a member's word alone never marks
 * one verified: a shell command in the task's workspace, and a comparison of the workspace with
 * a snapshot taken when the task started.
 *
 * The commands are written by the lead and run only for crew tasks, in the server's default
 * environment (outside any sandbox, with network). They are therefore run only when the lead and
 * member threads have full access; for a sandboxed crew the caller does not run them, since the
 * member could have edited what they execute.
 *
 * @module crewTodoChecks
 */
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeCrypto from "node:crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ProcessRunner } from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const TODO_COMMAND_TIMEOUT = Duration.seconds(120);
/** What a failed check hands back to the member. */
export const TODO_OUTPUT_TAIL_CHARS = 4_000;
const OUTPUT_BUFFER_BYTES = 16_000;
const OUTPUT_LIMIT_BYTES = 64_000;
const GIT_TIMEOUT_MS = 60_000;

export type TodoCommandResult =
  | { readonly kind: "passed" }
  | { readonly kind: "failed"; readonly exitCode: number | null; readonly tail: string }
  | { readonly kind: "timeout"; readonly tail: string }
  /** The command could not run at all (no shell, workspace gone). */
  | { readonly kind: "error"; readonly message: string };

/** The last `TODO_OUTPUT_TAIL_CHARS` characters, cut at a line start when one is near. */
export function outputTail(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= TODO_OUTPUT_TAIL_CHARS) return trimmed;
  const cut = trimmed.slice(-TODO_OUTPUT_TAIL_CHARS);
  const newline = cut.indexOf("\n");
  return `...${newline >= 0 && newline < 200 ? cut.slice(newline) : cut}`;
}

export const makeCrewTodoChecks = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner;
  const platform = yield* HostProcessPlatform;

  /**
   * Runs `command` through the platform shell in `cwd`, with no environment of its own: the
   * server's, as for any process it starts. Only the end of the output is kept.
   */
  const runCommand = Effect.fn("CrewTodoChecks.runCommand")(function* (input: {
    readonly cwd: string;
    readonly command: string;
    readonly timeout?: Duration.Input | undefined;
  }) {
    let buffered = Buffer.alloc(0);
    const result = yield* runner
      .run({
        command: platform === "win32" ? "cmd.exe" : "sh",
        args: platform === "win32" ? ["/d", "/s", "/c", input.command] : ["-c", input.command],
        cwd: input.cwd,
        timeout: input.timeout ?? TODO_COMMAND_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        outputMode: "truncate",
        maxOutputBytes: OUTPUT_LIMIT_BYTES,
        onStdoutChunk: (chunk) => {
          buffered = Buffer.concat([buffered, chunk]).subarray(-OUTPUT_BUFFER_BYTES);
        },
      })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      return { kind: "error", message: result.failure.message } as const;
    }
    const tail = outputTail(`${buffered.toString("utf8")}\n${result.success.stderr}`);
    if (result.success.timedOut) return { kind: "timeout", tail } as const;
    return result.success.code === 0
      ? ({ kind: "passed" } as const)
      : ({ kind: "failed", exitCode: result.success.code, tail } as const);
  });

  const probe = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    git.execute({
      operation: "CrewTodoChecks.git",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: GIT_TIMEOUT_MS,
      ...(env === undefined ? {} : { env }),
    });

  /**
   * A git tree of everything in the workspace right now, ignored files aside: the tracked files
   * as they are on disk plus the untracked ones. It is built in a throwaway copy of the index, so
   * the repository's own index and stash stay as they were. Null when `cwd` is not a repository
   * or git fails; there is then nothing to compare against.
   */
  const snapshot = (cwd: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const top = yield* probe(cwd, ["rev-parse", "--show-toplevel"]);
        if (top.exitCode !== 0) return null;
        const root = top.stdout.trim();
        const indexPath = yield* probe(root, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "index",
        ]);
        if (indexPath.exitCode !== 0) return null;
        const scratch = yield* fs.makeTempFileScoped({ prefix: "t3-crew-index-" });
        // Starting from the real index keeps git's stat cache, so unchanged files are not rehashed.
        // The copy keeps the real index's modification time: git decides an entry is racily clean
        // (edited in the same timestamp tick, so its stat cannot be trusted) against that time,
        // and a fresh copy would make such an edit look unchanged.
        yield* Effect.gen(function* () {
          const real = indexPath.stdout.trim();
          yield* fs.copyFile(real, scratch);
          const info = yield* fs.stat(real);
          if (Option.isSome(info.mtime))
            yield* fs.utimes(scratch, info.mtime.value, info.mtime.value);
        }).pipe(Effect.ignore);
        const env = { GIT_INDEX_FILE: scratch };
        const added = yield* probe(root, ["add", "-A", "--", "."], env);
        if (added.exitCode !== 0) return null;
        const tree = yield* probe(root, ["write-tree"], env);
        return tree.exitCode === 0 ? tree.stdout.trim() : null;
      }),
    ).pipe(Effect.orElseSucceed(() => null));

  /**
   * The repo-relative files that differ between the snapshot `tree` and the workspace now, or
   * null when either cannot be read.
   */
  const changedSince = Effect.fn("CrewTodoChecks.changedSince")(
    function* (cwd: string, tree: string) {
      const current = yield* snapshot(cwd);
      if (current === null) return null;
      const root = (yield* probe(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
      const diff = yield* probe(root, ["diff-tree", "-r", "--name-only", "-z", tree, current]);
      if (diff.exitCode !== 0) return null;
      return diff.stdout.split("\0").filter((file) => file !== "");
    },
    Effect.orElseSucceed(() => null),
  );

  // Only explicit file paths are read. Null means absent; "unknown" is never a digest.
  const hashFiles = (cwd: string, files: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const entries = yield* Effect.forEach([...new Set(files)], (file) =>
        Effect.gen(function* () {
          const target = path.resolve(cwd, file);
          const info = yield* fs.stat(target);
          if (info.type !== "File") return "unknown";
          // Streamed so a large build artifact is hashed without loading it into memory.
          const hash = NodeCrypto.createHash("sha256");
          yield* Stream.runForEach(fs.stream(target), (chunk) =>
            Effect.sync(() => hash.update(chunk)),
          );
          return hash.digest("hex");
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(error.reason._tag === "NotFound" ? null : "unknown"),
          ),
          Effect.map((hash) => [file, hash] as const),
        ),
      );
      return Object.fromEntries(entries);
    });

  const changedHashes = (
    cwd: string,
    hashes: Readonly<Record<string, string | null>>,
    files: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const current = yield* hashFiles(cwd, files);
      if (
        files.some(
          (file) =>
            hashes[file] === undefined || hashes[file] === "unknown" || current[file] === "unknown",
        )
      )
        return null;
      return files.filter((file) => hashes[file] !== current[file]);
    });

  return { runCommand, snapshot, changedSince, hashFiles, changedHashes };
});

export type CrewTodoChecks = Effect.Success<typeof makeCrewTodoChecks>;
