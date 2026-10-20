import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import { verifyReleaseFeeds } from "./verify-release-feeds.mjs";

const scriptPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "verify-release-feeds.mjs",
);

/** A repo root with OOP_RELEASE.json and a release folder whose two feeds match their installers. */
function makeRelease(version = "1.2.3") {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-feed-test-"));
  NodeFS.writeFileSync(NodePath.join(root, "OOP_RELEASE.json"), JSON.stringify({ version }));
  const feeds = {};
  for (const [dir, platform, pkg] of [
    ["macos", "darwin", `OoP-${version}-arm64-update.pkg`],
    ["windows", "win32", `OoP-${version}-x64.exe`],
  ]) {
    const folder = NodePath.join(root, "release", dir);
    NodeFS.mkdirSync(folder, { recursive: true });
    const bytes = Buffer.from(`installer for ${platform}`);
    const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    NodeFS.writeFileSync(NodePath.join(folder, pkg), bytes);
    NodeFS.writeFileSync(NodePath.join(folder, `${pkg}.sha256`), `${sha256}  ${pkg}\n`);
    feeds[dir] = {
      schemaVersion: 1,
      platform,
      arch: "x",
      version,
      pkg,
      size: bytes.length,
      sha256,
    };
    NodeFS.writeFileSync(NodePath.join(folder, "oop-update.json"), JSON.stringify(feeds[dir]));
  }
  const rewriteFeed = (dir, change) =>
    NodeFS.writeFileSync(
      NodePath.join(root, "release", dir, "oop-update.json"),
      JSON.stringify({ ...feeds[dir], ...change }),
    );
  return { root, releaseDir: NodePath.join(root, "release"), feeds, rewriteFeed };
}

const problemsOf = (release) =>
  Object.fromEntries(
    verifyReleaseFeeds({ repoRoot: release.root, releaseDir: release.releaseDir }).results.map(
      (result) => [result.dir, result.problems],
    ),
  );

NodeTest.test("passes when both feeds match their installers and OOP_RELEASE.json", () => {
  const release = makeRelease();
  const report = verifyReleaseFeeds({ repoRoot: release.root, releaseDir: release.releaseDir });
  NodeAssert.equal(report.ok, true);
  NodeAssert.deepEqual(problemsOf(release), { macos: [], windows: [] });
});

NodeTest.test("flags a feed whose SHA-256 does not match its installer", () => {
  const release = makeRelease();
  release.rewriteFeed("windows", { sha256: "0".repeat(64) });
  const problems = problemsOf(release);
  NodeAssert.deepEqual(problems.macos, []);
  NodeAssert.match(problems.windows.join("\n"), /SHA-256 is [0-9a-f]{64}, the feed says 0{64}/u);
});

NodeTest.test("flags a feed that is behind OOP_RELEASE.json", () => {
  const release = makeRelease();
  release.rewriteFeed("macos", { version: "1.2.2" });
  NodeAssert.match(
    problemsOf(release).macos.join("\n"),
    /feed version 1\.2\.2 differs from OOP_RELEASE\.json 1\.2\.3/u,
  );
});

NodeTest.test("flags a missing installer, a wrong size, and a stale sidecar", () => {
  const release = makeRelease();
  NodeFS.rmSync(NodePath.join(release.releaseDir, "windows", release.feeds.windows.pkg));
  release.rewriteFeed("macos", { size: 1 });
  NodeFS.writeFileSync(
    NodePath.join(release.releaseDir, "macos", `${release.feeds.macos.pkg}.sha256`),
    "f".repeat(64),
  );
  const problems = problemsOf(release);
  NodeAssert.match(problems.windows.join("\n"), /is missing/u);
  NodeAssert.match(problems.macos.join("\n"), /bytes, the feed says 1/u);
  NodeAssert.match(problems.macos.join("\n"), /\.sha256 records f{64}/u);
});

NodeTest.test("the command exits non-zero when one feed is wrong and zero when both match", () => {
  const release = makeRelease();
  const run = () =>
    NodeChildProcess.spawnSync(
      process.execPath,
      [scriptPath, "--repo-root", release.root, "--release-dir", release.releaseDir],
      { encoding: "utf8" },
    );
  NodeAssert.equal(run().status, 0);
  release.rewriteFeed("windows", { sha256: "1".repeat(64) });
  const failed = run();
  NodeAssert.equal(failed.status, 1);
  NodeAssert.match(failed.stdout, /FAIL windows/u);
});
