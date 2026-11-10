import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { extractPathTokens, missingPathsWarning, type CitedPaths } from "./missingPaths.ts";

describe("crew missing paths: extractPathTokens", () => {
  it("extracts path-like tokens: with a slash plus extension, trailing slash, or a path prefix", () => {
    assert.deepStrictEqual(extractPathTokens("read apps/server/src/index.ts then src/crew/"), [
      "apps/server/src/index.ts",
      "src/crew/",
    ]);
    assert.deepStrictEqual(
      extractPathTokens("start /abs/dir/file.ts then ~/home/file.md and ./rel.ts"),
      ["/abs/dir/file.ts", "~/home/file.md", "./rel.ts"],
    );
  });

  it("strips trailing punctuation and wrapping quotes, keeping a markdown link's target", () => {
    assert.deepStrictEqual(extractPathTokens('`src/a.ts`, (src/b.ts). "src/c.ts":'), [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
    assert.deepStrictEqual(extractPathTokens("see [the guide](docs/guide.md) first"), [
      "docs/guide.md",
    ]);
  });

  it("ignores URLs, globs, extensionless words, and oversized tokens", () => {
    assert.deepStrictEqual(
      extractPathTokens(
        "https://example.com/docs/a.md http://x.dev/y.ts src/**/*.ts tools.ts " +
          "a/".repeat(200) +
          "b.ts",
      ),
      [],
    );
  });

  it("deduplicates and caps at 30 tokens", () => {
    assert.strictEqual(extractPathTokens("src/a.ts src/a.ts src/a.ts").length, 1);
    const text = Array.from({ length: 35 }, (_, index) => `src/file${index}.ts`).join(" ");
    assert.strictEqual(extractPathTokens(text).length, 30);
  });
});

it.layer(NodeServices.layer)("crew missing paths: missingPathsWarning", (it) => {
  /** A temp workspace holding src/keep.ts, removed when the test's scope closes. */
  const workspace = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-crew-missing-paths-" });
    const cwd = path.join(root, "workspace");
    const existing = path.join(cwd, "src", "keep.ts");
    yield* fs.makeDirectory(path.dirname(existing), { recursive: true });
    yield* fs.writeFileString(existing, "export {};\n");
    const warn = (input: CitedPaths) => missingPathsWarning(fs, path, cwd, input);
    return { cwd, existing, warn };
  });

  it.effect("warns when a cited path is missing from the task cwd", () =>
    Effect.gen(function* () {
      const { cwd, warn } = yield* workspace;
      const warning = yield* warn({
        task: "Follow docs/reference.md and src/gone/missing.ts from the brief.",
        verify: "vp test run src/mcp/toolkits/crew/tools.test.ts",
      });
      assert.include(warning ?? "", `do not exist from ${cwd}`);
      assert.include(warning ?? "", "docs/reference.md");
      assert.include(warning ?? "", "src/gone/missing.ts");
      assert.include(warning ?? "", "src/mcp/toolkits/crew/tools.test.ts");
    }),
  );

  it.effect("does not warn when every cited path exists", () =>
    Effect.gen(function* () {
      const { existing, warn } = yield* workspace;
      const warning = yield* warn({
        task: `Edit ${existing} per docs/../src/keep.ts.`,
        todos: [{ check: { files: ["src/keep.ts"] } }],
      });
      assert.isUndefined(warning);
    }),
  );

  it.effect("skips paths a writeScope entry is expected to create", () =>
    Effect.gen(function* () {
      const { warn } = yield* workspace;
      const covered = yield* warn({
        task: "Create src/new/thing.ts and src/more.ts.",
        writeScope: ["src/new/", "src/more.ts"],
      });
      assert.isUndefined(covered);
      const uncovered = yield* warn({
        task: "Create src/new/thing.ts.",
        writeScope: ["src/other/"],
      });
      assert.include(uncovered ?? "", "src/new/thing.ts");
    }),
  );

  it.effect("lists at most 5 missing paths with a count of the rest", () =>
    Effect.gen(function* () {
      const { warn } = yield* workspace;
      const warning = yield* warn({
        task: Array.from({ length: 7 }, (_, index) => `src/gone${index}.ts`).join(" "),
      });
      assert.strictEqual((warning?.match(/src\/gone\d\.ts/g) ?? []).length, 5);
      assert.include(warning ?? "", "+2 more");
    }),
  );

  it.effect("ignores a plain word without a slash in task and verify text", () =>
    Effect.gen(function* () {
      const { warn } = yield* workspace;
      const warning = yield* warn({
        task: "Run vitest run and check handler.ts output carefully.",
        verify: "true",
      });
      assert.isUndefined(warning);
    }),
  );
});
