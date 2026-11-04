import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeCrewTodoChecks, outputTail, TODO_OUTPUT_TAIL_CHARS } from "./crewTodoChecks.ts";

const TestLayer = Layer.mergeAll(GitVcsDriver.layer, ProcessRunner.layer).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-crew-todo-checks-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-crew-todo-repo-" });
  const run = (args: ReadonlyArray<string>) =>
    git.execute({ operation: "crewTodoChecks.test", cwd: root, args });
  yield* run(["init"]);
  yield* run(["config", "user.name", "Test"]);
  yield* run(["config", "user.email", "test@test.com"]);
  yield* fs.writeFileString(path.join(root, ".gitignore"), "ignored.txt\n");
  yield* fs.writeFileString(path.join(root, "a.txt"), "one\n");
  yield* run(["add", "."]);
  yield* run(["commit", "-m", "initial"]);
  const write = (name: string, text: string) => fs.writeFileString(path.join(root, name), text);
  return { root, run, write };
});

describe("crew todo checks: commands", () => {
  it.effect("passes on exit 0 and fails with the output tail otherwise", () =>
    Effect.gen(function* () {
      const checks = yield* makeCrewTodoChecks;
      const repo = yield* makeRepo;
      assert.deepStrictEqual(yield* checks.runCommand({ cwd: repo.root, command: "exit 0" }), {
        kind: "passed",
      });
      const failed = yield* checks.runCommand({
        cwd: repo.root,
        command: "echo to-stdout; echo to-stderr 1>&2; exit 3",
      });
      assert.strictEqual(failed.kind, "failed");
      if (failed.kind !== "failed") return;
      assert.strictEqual(failed.exitCode, 3);
      assert.include(failed.tail, "to-stdout");
      assert.include(failed.tail, "to-stderr");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("runs in the given directory with the server's own environment", () =>
    Effect.gen(function* () {
      const checks = yield* makeCrewTodoChecks;
      const repo = yield* makeRepo;
      process.env.T3_CREW_TODO_TEST_ENV = "from-the-server";
      try {
        const result = yield* checks.runCommand({
          cwd: repo.root,
          command: 'test "$T3_CREW_TODO_TEST_ENV" = from-the-server && test -f a.txt',
        });
        assert.deepStrictEqual(result, { kind: "passed" });
      } finally {
        delete process.env.T3_CREW_TODO_TEST_ENV;
      }
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps only the end of a long output", () =>
    Effect.gen(function* () {
      const checks = yield* makeCrewTodoChecks;
      const repo = yield* makeRepo;
      const result = yield* checks.runCommand({
        cwd: repo.root,
        command: "seq 1 100000; exit 1",
      });
      assert.strictEqual(result.kind, "failed");
      if (result.kind !== "failed") return;
      assert.isAtMost(result.tail.length, TODO_OUTPUT_TAIL_CHARS + 3);
      assert.include(result.tail, "100000");
      assert.notInclude(result.tail, "\n1\n");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("stops a command that outlives its timeout", () =>
    Effect.gen(function* () {
      const checks = yield* makeCrewTodoChecks;
      const repo = yield* makeRepo;
      // The test clock drives the timeout; the process would otherwise sleep for 30 seconds.
      const running = yield* checks
        .runCommand({ cwd: repo.root, command: "exec sleep 30", timeout: "120 seconds" })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("121 seconds");
      assert.strictEqual((yield* Fiber.join(running)).kind, "timeout");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("reports a workspace that is gone as an error, not a failed check", () =>
    Effect.gen(function* () {
      const checks = yield* makeCrewTodoChecks;
      const result = yield* checks.runCommand({
        cwd: "/nonexistent/t3-crew-todo",
        command: "exit 0",
      });
      assert.strictEqual(result.kind, "error");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it("cuts a long tail at a line start", () => {
    const tail = outputTail(`${"x".repeat(5_000)}\nlast line`);
    assert.isTrue(tail.endsWith("last line"));
    assert.isAtMost(tail.length, TODO_OUTPUT_TAIL_CHARS + 3);
  });
});

describe("crew todo checks: workspace snapshots", () => {
  it.effect("lists edited, new, and deleted files since the snapshot, and nothing before", () =>
    Effect.gen(function* () {
      const checks = yield* makeCrewTodoChecks;
      const repo = yield* makeRepo;
      yield* repo.write("a.txt", "dirty before the task\n");
      yield* repo.write("untracked-before.txt", "x\n");
      const tree = yield* checks.snapshot(repo.root);
      assert.isString(tree);
      if (tree === null) return;
      assert.deepStrictEqual(yield* checks.changedSince(repo.root, tree), []);

      const stagedBefore = (yield* repo.run(["diff", "--cached", "--name-only"])).stdout;
      yield* repo.write("a.txt", "edited by the task\n");
      yield* repo.write("new.txt", "created by the task\n");
      yield* repo.write("ignored.txt", "never listed\n");
      const changed = yield* checks.changedSince(repo.root, tree);
      assert.deepStrictEqual(changed?.toSorted(), ["a.txt", "new.txt"]);
      // The snapshot never touches the repository's own index or stash.
      assert.strictEqual(
        (yield* repo.run(["diff", "--cached", "--name-only"])).stdout,
        stagedBefore,
      );
      assert.strictEqual((yield* repo.run(["stash", "list"])).stdout, "");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("sees a same-size edit made in the same timestamp tick as the repository's index", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const checks = yield* makeCrewTodoChecks;
      const repo = yield* makeRepo;
      // A coarse-timestamp filesystem: the file, its index entry and the index share one tick.
      // Git calls such an entry racily clean and compares its content, not its stat.
      yield* repo.run(["config", "core.trustctime", "false"]);
      const tick = 1_577_836_800; // 2020-01-01, in seconds
      const file = path.join(repo.root, "a.txt");
      const index = path.join(repo.root, ".git", "index");
      yield* fs.utimes(file, tick, tick);
      yield* repo.run(["update-index", "--refresh"]);
      yield* fs.utimes(index, tick, tick);
      // Same size, same inode, same mtime: nothing in the stat tells the edit.
      yield* repo.write("a.txt", "two\n");
      yield* fs.utimes(file, tick, tick);

      const tree = yield* checks.snapshot(repo.root);
      const head = (yield* repo.run(["rev-parse", "HEAD^{tree}"])).stdout.trim();
      assert.isString(tree);
      assert.notStrictEqual(tree, head);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("has no snapshot outside a repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const checks = yield* makeCrewTodoChecks;
      const plain = yield* fs.makeTempDirectoryScoped({ prefix: "t3-crew-todo-plain-" });
      assert.isNull(yield* checks.snapshot(plain));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
