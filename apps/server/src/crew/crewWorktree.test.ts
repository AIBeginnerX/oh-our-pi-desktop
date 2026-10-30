import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  applyConflictFiles,
  makeCrewWorktrees,
  mergeConflictNote,
  type CrewWorktree,
} from "./crewWorktree.ts";

const TestLayer = Layer.mergeAll(GitVcsDriver.layer).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-crew-worktree-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

// A repository with `a.txt` and `b.txt` committed and an uncommitted edit to `a.txt`.
const makeLeadRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-crew-lead-" });
  const run = (args: ReadonlyArray<string>) =>
    git.execute({ operation: "crewWorktree.test", cwd: root, args });
  const write = (name: string, text: string) => fs.writeFileString(path.join(root, name), text);
  const read = (name: string) => fs.readFileString(path.join(root, name));
  yield* run(["init"]);
  yield* run(["config", "user.name", "Test"]);
  yield* run(["config", "user.email", "test@test.com"]);
  yield* write("a.txt", "one\ntwo\nthree\nfour\nfive\n");
  yield* write("b.txt", "bee\n");
  yield* run(["add", "."]);
  yield* run(["commit", "-m", "initial"]);
  yield* write("a.txt", "one\ntwo\nthree\nfour\nfive\nsix\n");
  return { root, run, write, read };
});

const edit = (worktree: CrewWorktree, name: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(worktree.cwd, name), text);
  });

describe("crew worktrees", () => {
  it.effect("starts from the lead's tracked state and merges edits and new files back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crew = yield* makeCrewWorktrees;
      const lead = yield* makeLeadRepo;
      yield* lead.write("untracked.txt", "only in the lead\n");
      const stagedBefore = (yield* lead.run(["diff", "--cached", "--name-only"])).stdout;

      const worktree = yield* crew.create({ taskId: "task-1", cwd: lead.root });
      assert.strictEqual(
        yield* fs.readFileString(path.join(worktree.cwd, "a.txt")),
        "one\ntwo\nthree\nfour\nfive\nsix\n",
      );
      assert.isFalse(yield* fs.exists(path.join(worktree.cwd, "untracked.txt")));
      // The snapshot leaves the lead's stash list and index alone.
      assert.strictEqual((yield* lead.run(["stash", "list"])).stdout, "");
      assert.strictEqual(
        (yield* lead.run(["diff", "--cached", "--name-only"])).stdout,
        stagedBefore,
      );

      // The lead keeps editing a different part of the same file while the member works.
      yield* lead.write("a.txt", "zero\none\ntwo\nthree\nfour\nfive\nsix\n");
      yield* edit(worktree, "a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
      yield* edit(worktree, "new.txt", "created by the member\n");

      const result = yield* crew.mergeBack(worktree);
      assert.deepStrictEqual(result, { merged: true });
      assert.strictEqual(
        yield* lead.read("a.txt"),
        "zero\none\ntwo\nthree\nfour\nfive\nsix\nseven\n",
      );
      assert.strictEqual(yield* lead.read("new.txt"), "created by the member\n");
      assert.strictEqual(yield* lead.read("untracked.txt"), "only in the lead\n");
      // Plain `git apply` never stages: the lead's index is as it was.
      assert.strictEqual(
        (yield* lead.run(["diff", "--cached", "--name-only"])).stdout,
        stagedBefore,
      );
      assert.isFalse(yield* fs.exists(worktree.path));
      assert.isFalse(yield* fs.exists(`${worktree.path}.patch`));
      assert.notInclude((yield* lead.run(["worktree", "list"])).stdout, worktree.path);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps the worktree and names the files when the edits conflict", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const crew = yield* makeCrewWorktrees;
      const lead = yield* makeLeadRepo;
      const worktree = yield* crew.create({ taskId: "task-2", cwd: lead.root });

      yield* lead.write("b.txt", "lead's bee\n");
      yield* edit(worktree, "b.txt", "member's bee\n");
      yield* edit(worktree, "c.txt", "also new\n");

      const result = yield* crew.mergeBack(worktree);
      if (result.merged) return assert.fail("expected a conflict");
      assert.deepStrictEqual(result.files, ["b.txt"]);
      // All or nothing: the file that did not conflict is not applied either.
      assert.strictEqual(yield* lead.read("b.txt"), "lead's bee\n");
      assert.isFalse(yield* fs.exists(`${lead.root}/c.txt`));
      assert.isTrue(yield* fs.exists(worktree.path));
      assert.isTrue(yield* fs.exists(result.patchPath));

      const note = mergeConflictNote(worktree, result);
      assert.include(note, "Conflicting files: b.txt");
      assert.include(note, worktree.path);
      assert.include(note, result.patchPath);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("cleans up when the member changed nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const crew = yield* makeCrewWorktrees;
      const lead = yield* makeLeadRepo;
      const worktree = yield* crew.create({ taskId: "task-3", cwd: lead.root });

      assert.deepStrictEqual(yield* crew.mergeBack(worktree), { merged: true });
      assert.isFalse(yield* fs.exists(worktree.path));
      assert.strictEqual(yield* lead.read("a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("merging twice, as after an interrupted merge, is a no-op", () =>
    Effect.gen(function* () {
      const crew = yield* makeCrewWorktrees;
      const lead = yield* makeLeadRepo;
      const worktree = yield* crew.create({ taskId: "task-4", cwd: lead.root });
      yield* edit(worktree, "b.txt", "member's bee\n");

      assert.deepStrictEqual(yield* crew.mergeBack(worktree), { merged: true });
      assert.deepStrictEqual(yield* crew.mergeBack(worktree), { merged: true });
      assert.strictEqual(yield* lead.read("b.txt"), "member's bee\n");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("recognises a patch that is already in the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const crew = yield* makeCrewWorktrees;
      const lead = yield* makeLeadRepo;
      const worktree = yield* crew.create({ taskId: "task-5", cwd: lead.root });
      yield* edit(worktree, "b.txt", "member's bee\n");
      // The lead's workspace already holds the member's edit, but the worktree is still there.
      yield* lead.write("b.txt", "member's bee\n");

      assert.deepStrictEqual(yield* crew.mergeBack(worktree), { merged: true });
      assert.isFalse(yield* fs.exists(worktree.path));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("fails to create a worktree outside a git repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const crew = yield* makeCrewWorktrees;
      const plain = yield* fs.makeTempDirectoryScoped({ prefix: "t3-crew-plain-" });
      const result = yield* Effect.exit(crew.create({ taskId: "task-6", cwd: plain }));
      assert.isTrue(result._tag === "Failure");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("applyConflictFiles", () => {
  it("reads the refused files from git apply's stderr", () => {
    const stderr = [
      "error: patch failed: src/a.ts:12",
      "error: src/a.ts: patch does not apply",
      "error: src/new.ts: already exists in working directory",
      "error: src/gone.ts: does not exist in working tree",
    ].join("\n");
    assert.deepStrictEqual(applyConflictFiles(stderr), ["src/a.ts", "src/new.ts", "src/gone.ts"]);
    assert.deepStrictEqual(applyConflictFiles("fatal: something else"), []);
  });
});
