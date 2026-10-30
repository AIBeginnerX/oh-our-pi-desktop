import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it } from "vite-plus/test";

import {
  RELEASE_NOTES_PATH,
  assertReleaseNotes,
  releaseNotesHint,
  releaseNotesProblems,
} from "./oop-release-names.mjs";

const tempDirectory = () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-release-notes-"));

/** A repo root whose only content is the release notes file. */
async function repoWith(notes) {
  const root = await tempDirectory();
  await NodeFSP.mkdir(NodePath.join(root, NodePath.dirname(RELEASE_NOTES_PATH)), {
    recursive: true,
  });
  await NodeFSP.writeFile(
    NodePath.join(root, RELEASE_NOTES_PATH),
    typeof notes === "string" ? notes : `${JSON.stringify(notes, null, 2)}\n`,
  );
  return root;
}

const entry = (version, highlights) => ({
  versions: [
    { version: "0.0.120", date: "2026-10-28", highlights: [{ en: "Old.", ko: "예전 것." }] },
    { version, date: "2026-10-29", highlights },
  ],
});

describe("release notes gate", () => {
  it("accepts a version with English and Korean highlights", async () => {
    const root = await repoWith(
      entry("0.0.121", [
        { en: "Crew tasks can declare files.", ko: "crew 작업이 파일 범위를 밝힙니다." },
        { en: "Audits skip older failures.", ko: "감사가 이전 실패를 건너뜁니다." },
      ]),
    );
    NodeAssert.deepEqual(await releaseNotesProblems(root, "0.0.121"), []);
  });

  it("names the version when the notes have no entry for it", async () => {
    const root = await repoWith(entry("0.0.121", [{ en: "A.", ko: "가." }]));
    NodeAssert.deepEqual(await releaseNotesProblems(root, "0.0.122"), [
      `${RELEASE_NOTES_PATH} has no entry for version 0.0.122.`,
    ]);
  });

  it("refuses an entry with zero highlights", async () => {
    const root = await repoWith(entry("0.0.121", []));
    NodeAssert.deepEqual(await releaseNotesProblems(root, "0.0.121"), [
      "version 0.0.121 has no highlights in packages/shared/src/releaseNotes.json.",
    ]);
  });

  it("refuses a highlight with no Korean text", async () => {
    const root = await repoWith(
      entry("0.0.121", [
        { en: "Crew tasks can declare files." },
        { en: "Audits skip older failures.", ko: "   " },
      ]),
    );
    NodeAssert.deepEqual(await releaseNotesProblems(root, "0.0.121"), [
      'version 0.0.121 highlight 1 is missing "ko".',
      'version 0.0.121 highlight 2 is missing "ko".',
    ]);
  });

  it("reports a missing file, invalid JSON, and a missing versions array", async () => {
    const missing = await tempDirectory();
    NodeAssert.deepEqual(await releaseNotesProblems(missing, "0.0.121"), [
      `${RELEASE_NOTES_PATH} does not exist.`,
    ]);
    const broken = await repoWith("{ not json");
    NodeAssert.match((await releaseNotesProblems(broken, "0.0.121"))[0], /not valid JSON/u);
    const shape = await repoWith({ notes: [] });
    NodeAssert.deepEqual(await releaseNotesProblems(shape, "0.0.121"), [
      `${RELEASE_NOTES_PATH} must contain a "versions" array.`,
    ]);
  });

  it("prints every problem and throws the hint, so callers exit non-zero", async () => {
    const root = await repoWith(entry("0.0.121", []));
    const logged = [];
    await NodeAssert.rejects(
      assertReleaseNotes({ repoRoot: root, version: "0.0.121", log: (line) => logged.push(line) }),
      (error) => error.message === releaseNotesHint("0.0.121"),
    );
    NodeAssert.deepEqual(logged, [
      "version 0.0.121 has no highlights in packages/shared/src/releaseNotes.json.",
    ]);
    NodeAssert.match(releaseNotesHint("0.0.121"), /packages\/shared\/src\/releaseNotes\.json/u);

    // A satisfied version is silent.
    const ok = await repoWith(entry("0.0.121", [{ en: "A.", ko: "가." }]));
    await assertReleaseNotes({
      repoRoot: ok,
      version: "0.0.121",
      log: () => NodeAssert.fail("logged"),
    });
  });
});
