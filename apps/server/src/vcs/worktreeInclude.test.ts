// @effect-diagnostics nodeBuiltinImport:off - Effect symlink cannot specify the Windows junction type, and exists follows symlinks.
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { layerTest } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { copyWorktreeIncludes } from "./worktreeInclude.ts";

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(layerTest(process.cwd(), { prefix: "oop-worktree-config-" })),
  Layer.provideMerge(NodeServices.layer),
);
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const makeTmpDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "oop-worktree-include-" });
});

const git = (cwd: string, args: readonly string[]) =>
  GitVcsDriver.GitVcsDriver.use((driver) =>
    driver.execute({ operation: "worktreeInclude.test", cwd, args }),
  );

const writeTextFile = (cwd: string, relative: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(cwd, relative);
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, contents);
  });

const initRepoWithCommit = () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const temp = yield* makeTmpDir;
    const source = path.join(temp, "source");
    const target = path.join(temp, "target");
    yield* fileSystem.makeDirectory(source);
    const write = (relative: string, contents = "fixture") =>
      writeTextFile(source, relative, contents);
    yield* git(source, ["init", "--quiet", "--template="]);
    yield* write("tracked.txt", "committed");
    yield* write("config/README", "tracked");
    yield* write(
      ".gitignore",
      ".env*\ntracked.txt\nconfig/*.json\nvendor/\ncache/\n.claude/\n*.local\nspawned/\n",
    );
    yield* git(source, ["add", "-f", ".gitignore", "tracked.txt", "config/README"]);
    yield* git(source, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "initial",
    ]);

    const create = (
      cwd = source,
      options?: GitVcsDriver.CreateWorktreeOptions,
      destination = target,
    ) =>
      driver.createWorktree(
        { cwd, path: destination, refName: "HEAD", newRefName: "test-worktree" },
        options,
      );
    const missing = (relative: string) =>
      Effect.promise(() =>
        expect(NodeFSP.lstat(path.join(target, relative))).rejects.toHaveProperty("code", "ENOENT"),
      );
    return { temp, source, target, write, create, missing, fileSystem, path };
  });

it.layer(TestLayer)(".worktreeinclude", (it) => {
  it.effect("copies the named ignored file with its mode when invoked from a subdirectory", () =>
    Effect.gen(function* () {
      const { source, target, write, create, fileSystem, path } = yield* initRepoWithCommit();
      yield* write(".env");
      yield* fileSystem.chmod(path.join(source, ".env"), 0o640);
      yield* write(".worktreeinclude", ".env\n");
      yield* create(path.join(source, "config"));
      expect(yield* fileSystem.readFileString(path.join(target, ".env"))).toBe("fixture");
      if (!windowsHost) {
        expect((yield* fileSystem.stat(path.join(target, ".env"))).mode & 0o777).toBe(0o640);
      }
    }),
  );

  it.effect("uses Git patterns for ignored files only, including negation and unusual paths", () =>
    Effect.gen(function* () {
      const { target, write, create, missing, fileSystem, path } = yield* initRepoWithCommit();
      yield* write(".worktreeinclude", "# comment.local\n*\n!omit.local\n");
      yield* write("tracked.txt", "dirty");
      const included = ["config/secrets.json", "file space.local"];
      if (!windowsHost) included.push("file\nnewline.local", ":literal.local");
      for (const file of ["unignored.txt", "omit.local", ...included]) {
        yield* write(file);
      }
      yield* create();
      expect(yield* fileSystem.readFileString(path.join(target, "tracked.txt"))).toBe("committed");
      for (const file of ["unignored.txt", "omit.local"]) yield* missing(file);
      for (const file of included) {
        expect(yield* fileSystem.readFileString(path.join(target, file))).toBe("fixture");
      }
    }),
  );

  it.effect("expands only named ignored directories and skips symlinks", () =>
    Effect.gen(function* () {
      const { source, target, write, create, missing, fileSystem, path } =
        yield* initRepoWithCommit();
      yield* write(
        ".worktreeinclude",
        "vendor/**/config.json\n**/.claude/skills/*.md\n**/config.json\nlink.local\n# cache/\n",
      );
      for (const file of [
        "vendor/sub/config.json",
        "vendor/sub/other",
        "cache/config.json",
        ".claude/skills/test.md",
        "outside",
      ]) {
        yield* write(file);
      }
      if (!windowsHost) {
        yield* fileSystem.symlink(path.join(source, "outside"), path.join(source, "link.local"));
      }
      yield* create();
      for (const file of ["vendor/sub/config.json", ".claude/skills/test.md"]) {
        expect(yield* fileSystem.readFileString(path.join(target, file))).toBe("fixture");
      }
      for (const file of ["vendor/sub/other", "cache/config.json", "link.local"])
        yield* missing(file);
    }),
  );

  // The source repository's setting decides, whatever the disk under the temp directory does.
  it.effect.each([{ ignoreCase: "true" }, { ignoreCase: "false" }])(
    "matches a differently cased pattern only when the source repository ignores case ($ignoreCase)",
    ({ ignoreCase }) =>
      Effect.gen(function* () {
        const { source, target, write, create, missing, fileSystem, path } =
          yield* initRepoWithCommit();
        const file = "vendor/sub/config.json";
        yield* write(file);
        yield* write(".worktreeinclude", "Vendor/**/config.json\n");
        yield* git(source, ["config", "core.ignorecase", ignoreCase]);
        yield* create();
        if (ignoreCase === "true") {
          expect(yield* fileSystem.readFileString(path.join(target, file))).toBe("fixture");
        } else {
          yield* missing(file);
        }
      }),
  );

  it.effect("keeps existing destinations and skips files inside the new worktree", () =>
    Effect.gen(function* () {
      const { source, write, create, fileSystem, path } = yield* initRepoWithCommit();
      const nestedTarget = path.join(source, "spawned", "target");
      yield* write(".env");
      yield* write(".env.local");
      yield* write(".worktreeinclude", ".env*\nspawned/**\n");
      yield* create(
        source,
        {
          progress: {
            onWorktreeClaimed: (claimedPath) =>
              Effect.gen(function* () {
                yield* fileSystem.writeFileString(path.join(claimedPath, ".env"), "existing");
                yield* fileSystem.writeFileString(
                  path.join(claimedPath, "own.local"),
                  "destination only",
                );
              }).pipe(Effect.orDie),
          },
        },
        nestedTarget,
      );
      expect(yield* fileSystem.readFileString(path.join(nestedTarget, ".env"))).toBe("existing");
      expect(yield* fileSystem.readFileString(path.join(nestedTarget, ".env.local"))).toBe(
        "fixture",
      );
      expect(yield* fileSystem.exists(path.join(nestedTarget, "spawned"))).toBe(false);
    }),
  );

  it.effect("does not expand an unignored parent or follow a destination directory symlink", () =>
    Effect.gen(function* () {
      const { temp, source, target, write, create, missing, fileSystem, path } =
        yield* initRepoWithCommit();
      yield* write(
        ".worktreeinclude",
        "example/visible.local\n**/config.json\nconfig/secrets.json\n",
      );
      yield* write("example/visible.local");
      yield* write("example/cache/config.json");
      yield* write("config/secrets.json");
      const outside = path.join(temp, "outside");
      yield* fileSystem.makeDirectory(outside);
      yield* create(source, {
        progress: {
          onWorktreeClaimed: (claimedPath) =>
            Effect.gen(function* () {
              yield* fileSystem.rename(
                path.join(claimedPath, "config"),
                path.join(claimedPath, "config-tracked"),
              );
              yield* Effect.tryPromise(() =>
                NodeFSP.symlink(
                  outside,
                  path.join(claimedPath, "config"),
                  windowsHost ? "junction" : "dir",
                ),
              );
            }).pipe(Effect.orDie),
        },
      });
      expect(yield* fileSystem.readFileString(path.join(target, "example", "visible.local"))).toBe(
        "fixture",
      );
      yield* missing("example/cache");
      expect(yield* fileSystem.readDirectory(outside)).toEqual([]);
    }),
  );

  it.effect("copies a file under a directory whose name the disk stores decomposed", () =>
    Effect.gen(function* () {
      const { target, write, create, fileSystem, path } = yield* initRepoWithCommit();
      // macOS keeps a decomposed name as written while Git reports it composed.
      const directory = "설정".normalize("NFD");
      yield* write(`${directory}/secret.local`);
      yield* write(".worktreeinclude", "*.local\n");
      yield* create();
      expect(yield* fileSystem.readFileString(path.join(target, directory, "secret.local"))).toBe(
        "fixture",
      );
    }),
  );

  it.effect("skips files ignored by an untracked nested .gitignore", () =>
    Effect.gen(function* () {
      const { target, write, create, missing } = yield* initRepoWithCommit();
      yield* write(".venv/.gitignore", "*\n");
      yield* write(".venv/local-settings");
      yield* write(".worktreeinclude", ".venv/local-settings\n");
      yield* create();
      const status = yield* git(target, ["status", "--porcelain"]);
      expect(status.stdout).toBe("");
      yield* missing(".venv/local-settings");
    }),
  );

  it.effect("skips files ignored only by an uncommitted edit to .gitignore", () =>
    Effect.gen(function* () {
      const { target, write, create, missing } = yield* initRepoWithCommit();
      yield* write(".gitignore", "extra-settings\n");
      yield* write("extra-settings");
      yield* write(".worktreeinclude", "extra-settings\n");
      yield* create();
      const status = yield* git(target, ["status", "--porcelain"]);
      expect(status.stdout).toBe("");
      yield* missing("extra-settings");
    }),
  );

  it.effect("leaves ignored files in the source when there is no include file", () =>
    Effect.gen(function* () {
      const { write, create, missing } = yield* initRepoWithCommit();
      yield* write(".env");
      yield* create();
      yield* missing(".env");
    }),
  );

  it.effect("creates a worktree when .worktreeinclude cannot be read as a file", () =>
    Effect.gen(function* () {
      const { source, target, write, create, missing, fileSystem, path } =
        yield* initRepoWithCommit();
      yield* write(".env");
      yield* fileSystem.makeDirectory(path.join(source, ".worktreeinclude"));
      yield* create();
      expect((yield* git(target, ["branch", "--show-current"])).stdout.trim()).toBe(
        "test-worktree",
      );
      expect((yield* git(target, ["status", "--porcelain"])).stdout).toBe("");
      yield* missing(".env");
    }),
  );

  it.effect("reports the number of files actually copied", () =>
    Effect.gen(function* () {
      const { write, create, missing } = yield* initRepoWithCommit();
      yield* write(".worktreeinclude", "*\n");
      yield* write(".env");
      yield* write("config/extra.json");
      yield* write("unignored.txt");
      const counts: number[] = [];
      yield* create(undefined, {
        progress: {
          onLocalFilesCopied: ({ count }) =>
            Effect.sync(() => {
              counts.push(count);
            }),
        },
      });
      expect(counts).toEqual([2]);
      yield* missing("unignored.txt");
    }),
  );

  it.effect("copies other matches when one directory expansion exceeds the Git output cap", () =>
    Effect.gen(function* () {
      const { source, target, write, create, missing, fileSystem, path } =
        yield* initRepoWithCommit();
      yield* create();
      yield* write(".worktreeinclude", ".env\nvendor/**\ncache/**\n");
      yield* write(".env");
      yield* write("vendor/config.json");
      yield* write("cache/config.json");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      // Exercise the real output cap without creating a large on-disk fixture.
      const count = yield* copyWorktreeIncludes(
        (input) =>
          driver.execute(
            input.args[0] === "--literal-pathspecs" && input.args.at(-1) === "vendor/"
              ? { ...input, maxOutputBytes: 1 }
              : input,
          ),
        fileSystem,
        source,
        target,
      );
      expect(count).toBe(2);
      expect(yield* fileSystem.readFileString(path.join(target, ".env"))).toBe("fixture");
      expect(yield* fileSystem.readFileString(path.join(target, "cache/config.json"))).toBe(
        "fixture",
      );
      yield* missing("vendor/config.json");
    }),
  );
});
