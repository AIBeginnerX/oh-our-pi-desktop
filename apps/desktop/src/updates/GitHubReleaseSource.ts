// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimersInEffect:off -- LocalPkgSource is a pull contract (open, stat, bounded reads, close on scope end); a fetch body reader with its own abort and per-read timer meets it without adding an HTTP layer to the updater.
import * as NodePath from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { LocalPkgUpdateError, type Reason } from "./LocalPkgUpdateError.ts";
import { SOURCE_IO_TIMEOUT, type LocalPkgSource, type SourceHandle } from "./LocalPkgSource.ts";

/**
 * Update source for public OOP builds: the releases of a GitHub repository
 * instead of a folder. The update check reads `<directory>/oop-update.json`;
 * here that is the newest release's `oop-update-<platform>.json` asset, and the
 * package it names is fetched from the release of its own version. Everything
 * after the read (size bound, SHA-256, private staging, publisher policy,
 * opening the installer) is the folder flow's, unchanged.
 */

/** The virtual folder that stands for a repository's releases. */
export const githubReleaseDirectory = (repository: string) => `/github-releases/${repository}`;

/** `owner/repo` with GitHub's allowed characters only. */
export const isGitHubRepository = (value: string) =>
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u.test(value) &&
  !value.split("/").includes("..");

const MANIFEST_FILE_NAME = "oop-update.json";
const RELEASE_FILE_VERSION = /^(?:OOP|OoP)-(\d+\.\d+\.\d+)-/u;

export type GitHubFetch = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<Response>;

const timeoutMillis = Duration.toMillis(SOURCE_IO_TIMEOUT);

/** The asset URL a path in the virtual folder stands for, or undefined when it names nothing. */
export const githubAssetUrl = (
  repository: string,
  platformKey: "macos" | "windows",
  path: string,
): string | undefined => {
  if (NodePath.posix.dirname(path) !== githubReleaseDirectory(repository)) return undefined;
  const name = NodePath.posix.basename(path);
  const base = `https://github.com/${repository}/releases`;
  if (name === MANIFEST_FILE_NAME) {
    return `${base}/latest/download/oop-update-${platformKey}.json`;
  }
  const version = RELEASE_FILE_VERSION.exec(name)?.[1];
  return version === undefined ? undefined : `${base}/download/v${version}/${name}`;
};

export const makeGitHubReleaseSource = (input: {
  readonly repository: string;
  readonly platformKey: "macos" | "windows";
  readonly fetch?: GitHubFetch;
}): LocalPkgSource => {
  const doFetch: GitHubFetch = input.fetch ?? ((url, init) => fetch(url, init));
  return {
    open: (path, reasons) =>
      Effect.gen(function* () {
        const url = githubAssetUrl(input.repository, input.platformKey, path);
        if (url === undefined)
          return yield* new LocalPkgUpdateError({ reason: reasons.unreadable });
        const io: Reason = reasons.io ?? reasons.unreadable;
        const controller = new AbortController();
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
        const response = yield* Effect.tryPromise({
          try: () => doFetch(url, { signal: controller.signal }),
          catch: () => new LocalPkgUpdateError({ reason: "github-unavailable" }),
        }).pipe(
          Effect.timeoutOption(SOURCE_IO_TIMEOUT),
          Effect.flatMap((answered) =>
            answered._tag === "Some"
              ? Effect.succeed(answered.value)
              : Effect.fail(new LocalPkgUpdateError({ reason: "github-unavailable" })),
          ),
        );
        // No release, or a newest release without this platform's feed: nothing to offer yet.
        if (response.status === 404 && NodePath.posix.basename(path) === MANIFEST_FILE_NAME) {
          return yield* new LocalPkgUpdateError({ reason: "release-feed-missing" });
        }
        if (!response.ok || response.body === null) {
          return yield* new LocalPkgUpdateError({ reason: reasons.unreadable });
        }
        const length = Number(response.headers.get("content-length"));
        if (!Number.isSafeInteger(length) || length < 0) {
          return yield* new LocalPkgUpdateError({ reason: reasons.unreadable });
        }
        const reader = response.body.getReader();
        let pending: Uint8Array = new Uint8Array(0);
        let done = false;
        const handle: SourceHandle = {
          stat: Effect.succeed({ isFile: true, size: length }),
          read: (wanted) =>
            Effect.tryPromise({
              try: async () => {
                while (pending.length === 0 && !done) {
                  const timer = setTimeout(() => controller.abort(), timeoutMillis);
                  try {
                    const next = await reader.read();
                    if (next.done) done = true;
                    else pending = next.value;
                  } finally {
                    clearTimeout(timer);
                  }
                }
                const chunk = pending.subarray(0, Math.max(1, wanted));
                pending = pending.subarray(chunk.length);
                return chunk;
              },
              catch: () =>
                new LocalPkgUpdateError({
                  reason: controller.signal.aborted ? "source-timeout" : io,
                }),
            }),
        };
        return handle;
      }),
    // Downloads carry no quarantine flag of their own; the staged copy is checked by hash.
    readQuarantine: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" }),
  };
};
