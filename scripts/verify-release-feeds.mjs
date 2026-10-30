#!/usr/bin/env node
// Checks that the Mac and Windows update feeds both point at the version in OOP_RELEASE.json and
// that each installer a feed names has the size and SHA-256 the feed claims.
//
// Every file is copied to a scratch folder before it is read: the NAS share is mounted over SMB,
// and this Mac's SMB client can keep serving a stale cached copy of a file that the Windows build
// PC rewrote in place at the same size.
//
//   node scripts/verify-release-feeds.mjs --release-dir /Volumes/Shared/MyPJ/OOP_DeskTop/release
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const FEED_NAME = "oop-update.json";
export const PLATFORMS = [
  { dir: "macos", platform: "darwin" },
  { dir: "windows", platform: "win32" },
];

const sha256Of = (path) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");

const copyToScratch = (source, scratchDir) => {
  const target = NodePath.join(
    scratchDir,
    `${NodeCrypto.randomUUID()}-${NodePath.basename(source)}`,
  );
  NodeFS.copyFileSync(source, target);
  return target;
};

/** Checks one platform folder. Returns the problems found; an empty list means the feed is good. */
export function verifyFeed({ releaseDir, dir, platform, expectedVersion, scratchDir }) {
  const problems = [];
  const feedPath = NodePath.join(releaseDir, dir, FEED_NAME);
  if (!NodeFS.existsSync(feedPath)) return { dir, problems: [`${feedPath} is missing`] };
  let feed;
  try {
    feed = JSON.parse(NodeFS.readFileSync(copyToScratch(feedPath, scratchDir), "utf8"));
  } catch (error) {
    return { dir, problems: [`${FEED_NAME} is not valid JSON: ${error.message}`] };
  }
  if (feed.version !== expectedVersion) {
    problems.push(`feed version ${feed.version} differs from OOP_RELEASE.json ${expectedVersion}`);
  }
  if (feed.platform !== platform)
    problems.push(`feed platform ${feed.platform} is not ${platform}`);
  const validName =
    typeof feed.pkg === "string" && feed.pkg !== "" && NodePath.basename(feed.pkg) === feed.pkg;
  if (!validName)
    return {
      dir,
      version: feed.version,
      problems: [...problems, "feed has no plain installer file name"],
    };
  const installerPath = NodePath.join(releaseDir, dir, feed.pkg);
  if (!NodeFS.existsSync(installerPath)) {
    return {
      dir,
      version: feed.version,
      pkg: feed.pkg,
      problems: [...problems, `${feed.pkg} is missing`],
    };
  }
  const installer = copyToScratch(installerPath, scratchDir);
  const size = NodeFS.statSync(installer).size;
  if (size !== feed.size) problems.push(`${feed.pkg} is ${size} bytes, the feed says ${feed.size}`);
  const sha256 = sha256Of(installer);
  NodeFS.rmSync(installer, { force: true });
  if (sha256 !== feed.sha256)
    problems.push(`${feed.pkg} SHA-256 is ${sha256}, the feed says ${feed.sha256}`);
  const sidecarPath = `${installerPath}.sha256`;
  if (NodeFS.existsSync(sidecarPath)) {
    const recorded = NodeFS.readFileSync(copyToScratch(sidecarPath, scratchDir), "utf8")
      .trim()
      .split(/\s+/u)[0];
    if (recorded !== sha256)
      problems.push(`${NodePath.basename(sidecarPath)} records ${recorded}, the file is ${sha256}`);
  }
  return { dir, version: feed.version, pkg: feed.pkg, sha256, problems };
}

/**
 * Checks each platform folder (`dirs`, default all) against the version in
 * `repoRoot`/OOP_RELEASE.json.
 */
export function verifyReleaseFeeds({ repoRoot, releaseDir, dirs = PLATFORMS.map((p) => p.dir) }) {
  const expectedVersion = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repoRoot, "OOP_RELEASE.json"), "utf8"),
  ).version;
  const scratchDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-feed-verify-"));
  try {
    const results = PLATFORMS.filter((entry) => dirs.includes(entry.dir)).map((entry) =>
      verifyFeed({ releaseDir, ...entry, expectedVersion, scratchDir }),
    );
    return {
      expectedVersion,
      results,
      ok: results.every((result) => result.problems.length === 0),
    };
  } finally {
    NodeFS.rmSync(scratchDir, { recursive: true, force: true });
  }
}

export function parseArgs(argv) {
  const scriptRoot = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "..",
  );
  const options = { repoRoot: scriptRoot, releaseDir: NodePath.join(scriptRoot, "release") };
  for (let index = 0; index < argv.length; index += 2) {
    const [key, value] = [argv[index], argv[index + 1]];
    if (value === undefined || !["--release-dir", "--repo-root"].includes(key)) {
      throw new Error(
        "Usage: node scripts/verify-release-feeds.mjs [--release-dir PATH] [--repo-root PATH]",
      );
    }
    options[key === "--release-dir" ? "releaseDir" : "repoRoot"] = NodePath.resolve(value);
  }
  return options;
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const { expectedVersion, results, ok } = verifyReleaseFeeds(parseArgs(process.argv.slice(2)));
  for (const result of results) {
    const head = `${result.dir}: ${result.version ?? "?"} ${result.pkg ?? ""}`.trim();
    console.log(
      result.problems.length === 0 ? `OK   ${head} sha256 ${result.sha256}` : `FAIL ${head}`,
    );
    for (const problem of result.problems) console.log(`     - ${problem}`);
  }
  console.log(
    ok ? `Both feeds match ${expectedVersion}.` : `Feeds do not match ${expectedVersion}.`,
  );
  process.exitCode = ok ? 0 : 1;
}
