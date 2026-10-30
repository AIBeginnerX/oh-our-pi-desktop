// Release file names and the release-notes gate. These helpers live in one module because the
// Windows build runner copies only the scripts listed in windows.mjs RUNNER_SCRIPTS.
//
// The app and every installer are named OOP. Through 0.0.110 the update feed
// still names its package with the legacy "OoP" casing: apps up to 0.0.109 accept nothing else, and a
// macOS or Windows folder cannot hold two names that differ only in case. From 0.0.111 the feed uses OOP.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const ARTIFACT_PREFIX = "OOP";
const LEGACY_PREFIX = "OoP";
const LAST_LEGACY_FEED_VERSION = [0, 0, 110];

/** A release file name of either casing, capturing the version. */
export const RELEASE_FILE_NAME = /^(?:OOP|OoP)-(\d+\.\d+\.\d+)-/u;

function feedPrefix(version) {
  const parts = version.split(".").map(Number);
  for (const index of [0, 1, 2]) {
    if (parts[index] !== LAST_LEGACY_FEED_VERSION[index]) {
      return parts[index] < LAST_LEGACY_FEED_VERSION[index] ? LEGACY_PREFIX : ARTIFACT_PREFIX;
    }
  }
  return LEGACY_PREFIX;
}

export const macDmgName = (version) => `${ARTIFACT_PREFIX}-${version}-arm64.dmg`;
/** The update package the macOS feed names; it is the feed's own file, never a public asset. */
export const macUpdatePkgName = (version) => `${feedPrefix(version)}-${version}-arm64-update.pkg`;
export const windowsInstallerName = (version, arch) => `${ARTIFACT_PREFIX}-${version}-${arch}.exe`;
/** The setup the Windows feed names. */
export const windowsFeedInstallerName = (version, arch) =>
  `${feedPrefix(version)}-${version}-${arch}.exe`;

// Release notes. The app bundles packages/shared/src/releaseNotes.json, so a version without
// user-facing highlights ships an empty "what's new" notice. `macos.mjs build`, the Drive publish,
// and the Windows build check them here; this module is already in the Windows runner's script list.
/** The app's update-notice content, relative to the repo root. */
export const RELEASE_NOTES_PATH = "packages/shared/src/releaseNotes.json";

const LANGUAGES = ["en", "ko"];

const hasText = (value) => typeof value === "string" && value.trim().length > 0;

function highlightProblems(highlights, version) {
  if (!Array.isArray(highlights) || highlights.length === 0)
    return [`version ${version} has no highlights in ${RELEASE_NOTES_PATH}.`];
  const problems = [];
  highlights.forEach((highlight, index) => {
    const position = `version ${version} highlight ${index + 1}`;
    if (highlight === null || typeof highlight !== "object") {
      problems.push(`${position} is not an object.`);
      return;
    }
    for (const language of LANGUAGES) {
      if (!hasText(highlight[language])) problems.push(`${position} is missing "${language}".`);
    }
  });
  return problems;
}

/**
 * Checks the notes file's text; the one place the format is interpreted, so callers that read the
 * file themselves (from HEAD, say) get identical answers. Empty means `version` may be released.
 */
export function releaseNotesProblemsFromText(text, version) {
  let notes;
  try {
    notes = JSON.parse(text);
  } catch (error) {
    return [`${RELEASE_NOTES_PATH} is not valid JSON: ${error.message}`];
  }
  if (!Array.isArray(notes?.versions))
    return [`${RELEASE_NOTES_PATH} must contain a "versions" array.`];
  const entry = notes.versions.find((candidate) => candidate?.version === version);
  if (entry === undefined) return [`${RELEASE_NOTES_PATH} has no entry for version ${version}.`];
  return highlightProblems(entry.highlights, version);
}

/**
 * Everything wrong with the notes for `version` in `repoRoot`'s working tree, in the order a
 * releaser should fix them. Reads only; safe to call anywhere.
 */
export async function releaseNotesProblems(repoRoot, version) {
  let text;
  try {
    text = await NodeFSP.readFile(NodePath.join(repoRoot, RELEASE_NOTES_PATH), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [`${RELEASE_NOTES_PATH} does not exist.`];
    throw error;
  }
  return releaseNotesProblemsFromText(text, version);
}

/** The one line a blocked releaser needs to read after the problems. */
export function releaseNotesHint(version) {
  return `Add the OOP ${version} user-facing highlights ("en" and "ko") to ${RELEASE_NOTES_PATH}, in the same commit as the version bump; the build and publish refuse without them.`;
}

/** Prints every problem, then throws the hint. Callers let their own catch report it. */
export function assertReleaseNotesProblems(problems, version, log = console.error) {
  if (problems.length === 0) return;
  for (const problem of problems) log(problem);
  throw new Error(releaseNotesHint(version));
}

export async function assertReleaseNotes({ repoRoot, version, log = console.error }) {
  assertReleaseNotesProblems(await releaseNotesProblems(repoRoot, version), version, log);
}
