// @effect-diagnostics nodeBuiltinImport:off -- reads and hashes one ~75 MB release archive per remote install.
import {
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileName,
  parseChecksums,
} from "@t3tools/shared/cliRelease";
import type { LocalRuntimeArchiveSource } from "@t3tools/ssh/tunnel";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as LocalPkgUpdates from "../updates/LocalPkgUpdates.ts";

/**
 * Where a release keeps its server archives: `<release>/cli/v<version>`, beside
 * the per-platform folder (`release/macos`, `release/windows`) each update feed reads.
 */
export function cliArchiveDirectories(
  updateDirectories: ReadonlyArray<string>,
  version: string,
): ReadonlyArray<string> {
  return [
    ...new Set(
      updateDirectories.map((directory) =>
        NodePath.join(NodePath.dirname(NodePath.normalize(directory)), "cli", `v${version}`),
      ),
    ),
  ];
}

export const localUpdateDirectories = (input: {
  readonly resourcesPath: string;
  readonly homeDirectory: string;
  readonly desktopUserDataDir: Option.Option<string>;
}): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const config = yield* LocalPkgUpdates.loadConfig(input.resourcesPath);
    if (config._tag !== "Ready") return [];
    const override = Option.isSome(input.desktopUserDataDir)
      ? yield* LocalPkgUpdates.readFolderOverride(input.desktopUserDataDir.value)
      : undefined;
    const candidates = yield* LocalPkgUpdates.expandUpdateDirectories(config.directories, {
      home: input.homeDirectory,
    });
    return override === undefined ? candidates : [override, ...candidates];
  });

export const makeLocalRuntimeArchiveSource =
  (updateDirectories: Effect.Effect<ReadonlyArray<string>>): LocalRuntimeArchiveSource =>
  ({ version, platformKey }) =>
    Effect.gen(function* () {
      const fileName = cliArchiveFileName(version, platformKey);
      for (const directory of cliArchiveDirectories(yield* updateDirectories, version)) {
        const found = yield* Effect.tryPromise(async () => {
          const listing = await NodeFSP.readFile(
            NodePath.join(directory, CLI_RELEASE_CHECKSUMS_FILE),
            "utf8",
          );
          const expected = parseChecksums(listing).get(fileName);
          if (expected === undefined) return null;
          const bytes = await NodeFSP.readFile(NodePath.join(directory, fileName));
          const actual = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
          return actual === expected ? { bytes, sha256: expected } : ("mismatch" as const);
        }).pipe(Effect.orElseSucceed(() => null));
        if (found === "mismatch") {
          yield* Effect.logWarning("desktop.ssh.runtimeArchive.checksumMismatch", {
            directory,
            fileName,
          });
          continue;
        }
        if (found !== null) return found;
      }
      return null;
    });
