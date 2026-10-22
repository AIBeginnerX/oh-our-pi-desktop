// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import * as DesktopSshRuntimeArchives from "./DesktopSshRuntimeArchives.ts";

const VERSION = "0.0.99";
const FILE = `t3-${VERSION}-linux-x64.tar.gz`;

function releaseWith(files: Record<string, string>) {
  const release = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-release-"));
  const cli = NodePath.join(release, "cli", `v${VERSION}`);
  NodeFS.mkdirSync(cli, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(release, "macos"));
  for (const [name, content] of Object.entries(files)) {
    NodeFS.writeFileSync(NodePath.join(cli, name), content);
  }
  return NodePath.join(release, "macos");
}

const sha = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

const find = (feedDirectories: ReadonlyArray<string>) =>
  DesktopSshRuntimeArchives.makeLocalRuntimeArchiveSource(Effect.succeed(feedDirectories))({
    version: VERSION,
    platformKey: "linux-x64",
  });

describe("DesktopSshRuntimeArchives", () => {
  it.effect("returns the archive beside the update feed when SHA256SUMS lists it", () =>
    Effect.gen(function* () {
      const feed = releaseWith({ [FILE]: "archive", SHA256SUMS: `${sha("archive")}  ${FILE}\n` });
      const found = yield* find([feed]);
      assert.strictEqual(found?.sha256, sha("archive"));
      assert.strictEqual(Buffer.from(found?.bytes ?? []).toString(), "archive");
    }),
  );

  it.effect("skips a copy that does not match its checksum and uses the next folder", () =>
    Effect.gen(function* () {
      const corrupt = releaseWith({
        [FILE]: "damaged",
        SHA256SUMS: `${sha("archive")}  ${FILE}\n`,
      });
      const good = releaseWith({ [FILE]: "archive", SHA256SUMS: `${sha("archive")} *${FILE}\n` });
      const found = yield* find([corrupt, good]);
      assert.strictEqual(Buffer.from(found?.bytes ?? []).toString(), "archive");
    }),
  );

  it.effect("returns null when no release folder holds the archive", () =>
    Effect.gen(function* () {
      const unlisted = releaseWith({ [FILE]: "archive", SHA256SUMS: "" });
      assert.isNull(yield* find([unlisted, "/nonexistent/OoP/release/windows"]));
    }),
  );
});
