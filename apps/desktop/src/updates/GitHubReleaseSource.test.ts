// @effect-diagnostics nodeBuiltinImport:off -- Staging writes a real temporary folder.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  githubAssetUrl,
  githubReleaseDirectory,
  makeGitHubReleaseSource,
  type GitHubFetch,
} from "./GitHubReleaseSource.ts";
import * as LocalPkgUpdates from "./LocalPkgUpdates.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const REPO = "example/oop-desktop";
const PKG = "OOP-0.0.111-arm64-update.pkg";
const PKG_BYTES = Buffer.from("x".repeat(300_000));
const sha256 = NodeCrypto.createHash("sha256").update(PKG_BYTES).digest("hex");
const manifest = {
  schemaVersion: 1,
  platform: "darwin",
  arch: "arm64",
  version: "0.0.111",
  pkg: PKG,
  size: PKG_BYTES.length,
  sha256,
};

/** A release host answering only the URLs the updater should ask for. */
const releases =
  (assets: Record<string, Buffer | string>, seen: Array<string> = []): GitHubFetch =>
  async (url) => {
    seen.push(url);
    const body = assets[url];
    if (body === undefined) return new Response("Not Found", { status: 404 });
    const bytes = typeof body === "string" ? Buffer.from(body) : body;
    return new Response(new Uint8Array(bytes), {
      headers: { "content-length": String(bytes.length) },
    });
  };

const base = `https://github.com/${REPO}/releases`;
const directory = githubReleaseDirectory(REPO);

describe("GitHubReleaseSource", () => {
  it("maps the feed to the newest release and a package to its own version", () => {
    assert.equal(
      githubAssetUrl(REPO, "macos", `${directory}/oop-update.json`),
      `${base}/latest/download/oop-update-macos.json`,
    );
    assert.equal(
      githubAssetUrl(REPO, "windows", `${directory}/OOP-0.0.111-x64.exe`),
      `${base}/download/v0.0.111/OOP-0.0.111-x64.exe`,
    );
    assert.equal(githubAssetUrl(REPO, "macos", `${directory}/notes.txt`), undefined);
    assert.equal(githubAssetUrl(REPO, "macos", `/elsewhere/oop-update.json`), undefined);
  });

  it.effect("offers a newer release, then stages its package with the published hash", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const source = makeGitHubReleaseSource({
        repository: REPO,
        platformKey: "macos",
        fetch: releases(
          {
            [`${base}/latest/download/oop-update-macos.json`]: encodeJson(manifest),
            [`${base}/download/v0.0.111/${PKG}`]: PKG_BYTES,
          },
          seen,
        ),
      });
      const offered = yield* LocalPkgUpdates.checkLocalPackage({
        sourceDirectory: directory,
        currentVersion: "0.0.110",
        appArch: "arm64",
        platform: "darwin",
        source,
      });
      assert.equal(Option.getOrThrow(offered).version, "0.0.111");
      const stagingRoot = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-gh-stage-"))),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const staged = yield* LocalPkgUpdates.stage({
        sourceDirectory: directory,
        stagingRoot,
        manifest: Option.getOrThrow(offered),
        preserveQuarantine: false,
        source,
      });
      assert.equal(staged.sha256, sha256);
      assert.deepEqual(yield* Effect.promise(() => NodeFSP.readFile(staged.path)), PKG_BYTES);
      assert.deepEqual(seen, [
        `${base}/latest/download/oop-update-macos.json`,
        `${base}/download/v0.0.111/${PKG}`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("treats a newest release without this platform's feed as no update", () =>
    Effect.gen(function* () {
      const offered = yield* LocalPkgUpdates.checkLocalPackage({
        sourceDirectory: directory,
        currentVersion: "0.0.110",
        appArch: "arm64",
        platform: "darwin",
        source: makeGitHubReleaseSource({
          repository: REPO,
          platformKey: "macos",
          fetch: releases({}),
        }),
      });
      assert.isTrue(Option.isNone(offered));
    }),
  );

  it.effect("reports an unreachable GitHub as such, not as a broken folder", () =>
    Effect.gen(function* () {
      const error = yield* LocalPkgUpdates.checkLocalPackage({
        sourceDirectory: directory,
        currentVersion: "0.0.110",
        appArch: "arm64",
        platform: "darwin",
        source: makeGitHubReleaseSource({
          repository: REPO,
          platformKey: "macos",
          fetch: async () => {
            throw new TypeError("fetch failed");
          },
        }),
      }).pipe(Effect.flip);
      assert.equal(error.reason, "github-unavailable");
    }),
  );

  it.effect("rejects a package whose bytes do not match the published hash", () =>
    Effect.gen(function* () {
      const source = makeGitHubReleaseSource({
        repository: REPO,
        platformKey: "macos",
        fetch: releases({
          [`${base}/download/v0.0.111/${PKG}`]: Buffer.from("y".repeat(PKG_BYTES.length)),
        }),
      });
      const stagingRoot = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-gh-stage-"))),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const error = yield* LocalPkgUpdates.stage({
        sourceDirectory: directory,
        stagingRoot,
        manifest: manifest as LocalPkgUpdates.LocalPkgManifest,
        preserveQuarantine: false,
        source,
      }).pipe(Effect.flip);
      assert.equal(error.reason, "package-mismatch");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("public Windows builds", () => {
  // `expandUpdateDirectories` normalizes the configured folder with `node:path`, so on Windows the
  // source is handed backslash paths: `\github-releases\owner\repo\oop-update.json`.
  const windowsDirectory = NodePath.win32.normalize(directory);
  const EXE = "OOP-0.0.111-x64.exe";
  const EXE_BYTES = Buffer.from("w".repeat(300_000));
  const windowsManifest = {
    schemaVersion: 1,
    platform: "win32",
    arch: "x64",
    version: "0.0.111",
    pkg: EXE,
    size: EXE_BYTES.length,
    sha256: NodeCrypto.createHash("sha256").update(EXE_BYTES).digest("hex"),
  };

  it("maps the backslash paths Windows builds to the same release assets", () => {
    assert.equal(
      githubAssetUrl(REPO, "windows", NodePath.win32.join(windowsDirectory, "oop-update.json")),
      `${base}/latest/download/oop-update-windows.json`,
    );
    assert.equal(
      githubAssetUrl(REPO, "windows", NodePath.win32.join(windowsDirectory, EXE)),
      `${base}/download/v0.0.111/${EXE}`,
    );
    assert.equal(
      githubAssetUrl(REPO, "windows", NodePath.win32.join("\\elsewhere", "oop-update.json")),
      undefined,
    );
  });

  it.effect("offers a newer release and stages its installer from a Windows-shaped folder", () =>
    Effect.gen(function* () {
      const source = makeGitHubReleaseSource({
        repository: REPO,
        platformKey: "windows",
        fetch: releases({
          [`${base}/latest/download/oop-update-windows.json`]: encodeJson(windowsManifest),
          [`${base}/download/v0.0.111/${EXE}`]: EXE_BYTES,
        }),
      });
      const offered = yield* LocalPkgUpdates.checkLocalPackage({
        sourceDirectory: windowsDirectory,
        currentVersion: "0.0.110",
        appArch: "x64",
        platform: "win32",
        source,
      });
      assert.equal(Option.getOrThrow(offered).pkg, EXE);
      const stagingRoot = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-gh-stage-"))),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const staged = yield* LocalPkgUpdates.stage({
        sourceDirectory: windowsDirectory,
        stagingRoot,
        manifest: Option.getOrThrow(offered),
        preserveQuarantine: false,
        source,
      });
      assert.deepEqual(yield* Effect.promise(() => NodeFSP.readFile(staged.path)), EXE_BYTES);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("still treats a newest release without the Windows feed as no update", () =>
    Effect.gen(function* () {
      const offered = yield* LocalPkgUpdates.checkLocalPackage({
        sourceDirectory: windowsDirectory,
        currentVersion: "0.0.110",
        appArch: "x64",
        platform: "win32",
        source: makeGitHubReleaseSource({
          repository: REPO,
          platformKey: "windows",
          fetch: releases({}),
        }),
      });
      assert.isTrue(Option.isNone(offered));
    }),
  );
});

describe("public Mac builds", () => {
  it.effect("take the release disk image as their package, never an Installer package", () =>
    Effect.gen(function* () {
      const DMG = "OOP-0.0.111-arm64.dmg";
      const feed = (pkg: string) =>
        makeGitHubReleaseSource({
          repository: REPO,
          platformKey: "macos",
          fetch: releases({
            [`${base}/latest/download/oop-update-macos.json`]: encodeJson({ ...manifest, pkg }),
          }),
        });
      const check = (pkg: string) =>
        LocalPkgUpdates.checkLocalPackage({
          sourceDirectory: directory,
          currentVersion: "0.0.110",
          appArch: "arm64",
          platform: "darwin",
          macPackage: "dmg",
          source: feed(pkg),
        });
      assert.equal(Option.getOrThrow(yield* check(DMG)).pkg, DMG);
      assert.equal((yield* Effect.flip(check(PKG))).reason, "manifest-invalid");
    }),
  );

  it("find the bundle they run from", () => {
    assert.equal(
      LocalPkgUpdates.appBundleOf("/Users/me/Applications/OOP.app/Contents/Resources/app.asar"),
      "/Users/me/Applications/OOP.app",
    );
    assert.equal(LocalPkgUpdates.appBundleOf("/opt/oop/resources/app.asar"), undefined);
  });
});

describe("GitHub release config", () => {
  it.effect("accepts a lone repository and rejects it next to folders", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-gh-config-"))),
        (d) => Effect.promise(() => NodeFSP.rm(d, { recursive: true, force: true })),
      );
      const write = (value: unknown) =>
        Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(dir, "oop-local-update.json"), encodeJson(value)),
        );
      yield* write({ github: REPO });
      const ready = yield* LocalPkgUpdates.loadConfig(dir);
      assert.deepEqual(ready, { _tag: "Ready", directories: [directory], github: REPO });
      yield* write({ github: REPO, directories: ["/Volumes/share"] });
      assert.equal((yield* LocalPkgUpdates.loadConfig(dir))._tag, "Invalid");
      yield* write({ github: "not a repo" });
      assert.equal((yield* LocalPkgUpdates.loadConfig(dir))._tag, "Invalid");
    }).pipe(Effect.scoped),
  );
});
