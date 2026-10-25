// @effect-diagnostics nodeBuiltinImport:off -- A synchronous SHA-1 of an in-memory string needs no Effect service.
import * as NodeCrypto from "node:crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  LocalPkgUpdateError,
  trustExitCode,
  trustFailure,
  type TrustCode,
} from "./LocalPkgUpdateError.ts";
import {
  parseTrustPolicy,
  type DeveloperIdTrustPolicy,
  type TrustPolicy,
} from "./LocalPkgTrustPolicy.ts";
import { hasReleaseBinding, signedExtractedSha1s } from "./LocalPkgReleaseBinding.ts";
import {
  isNewerVersion,
  isReleasePackageName,
  parseStableVersion,
  type StagedPkg,
} from "./LocalPkgUpdates.ts";

/**
 * Publisher trust for a staged local update package, from the public macOS
 * tools: `pkgutil --check-signature` (the OS evaluates the signature and chain;
 * this module pins the leaf certificate) and `spctl --assess --type install`
 * (the OS decides notarization). Both run bounded and their output is read with
 * a narrow grammar where anything unexpected fails. Errors carry only the fixed
 * tokens of `TRUST_TOKENS`, never tool output, native errors or paths.
 *
 * `verifyBinding` then ties the trusted package to the release it claims to be
 * (LocalPkgReleaseBinding.ts), so a validly signed older release cannot be
 * relabeled as a newer one.
 *
 * Accepted output shapes are not yet validated against real signed, notarized
 * packages (E21 only captured the unsigned .58 package); offline, revocation
 * and expiry behavior are not promised. The runtime still only admits
 * `legacy-unsigned`, see EmbeddedLocalPkgTrustPolicy.ts.
 */

export {
  LEGACY_UNSIGNED_POLICY,
  TrustPolicy,
  type DeveloperIdTrustPolicy,
} from "./LocalPkgTrustPolicy.ts";

/** Any malformed policy is `config-invalid`; there is no fallback to another policy. */
export const decodeTrustPolicy = (raw: unknown): Effect.Effect<TrustPolicy, LocalPkgUpdateError> =>
  Effect.suspend(() => {
    const policy = parseTrustPolicy(raw);
    return policy === undefined
      ? Effect.fail(new LocalPkgUpdateError({ reason: "config-invalid" }))
      : Effect.succeed(policy);
  });

const untrusted = (code: TrustCode) => trustFailure("publisher-untrusted", code);
const unconfirmed = (code: TrustCode) => trustFailure("notarization-unconfirmed", code);
const checkFailed = (code: TrustCode) => trustFailure("trust-check-failed", code);
const bindingFailed = (code: TrustCode) => trustFailure("binding-failed", code);

export type TrustTool = "pkgutil" | "spctl" | "binding-list" | "binding-read" | "binding-toc";

export interface ToolResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const PKGUTIL_COMMAND = "/usr/sbin/pkgutil";
export const SPCTL_COMMAND = "/usr/sbin/spctl";
export const TAR_COMMAND = "/usr/bin/tar";
export const XAR_COMMAND = "/usr/bin/xar";
/** The one archive entry the release binding reads from the package. */
const BINDING_ENTRY = "Distribution";
export const TOOL_ENV = {
  LC_ALL: "C",
  LANG: "C",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
} as const;
/** Per stream: stdout and stderr each get this much. */
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
/** Per command. The scoped kill that follows may take up to `TOOL_FORCE_KILL_AFTER` plus the spawner's final wait. */
export const TOOL_DEADLINE = Duration.seconds(30);
/** SIGTERM first; the spawner sends SIGKILL if the process group is still alive after this. */
export const TOOL_FORCE_KILL_AFTER = Duration.seconds(2);

const toolOptions = {
  env: TOOL_ENV,
  extendEnv: false,
  stdin: "ignore",
  forceKillAfter: TOOL_FORCE_KILL_AFTER,
} as const satisfies ChildProcess.CommandOptions;

const trustToolCommand = (tool: TrustTool, stagedPath: string) =>
  tool === "pkgutil"
    ? ChildProcess.make(PKGUTIL_COMMAND, ["--check-signature", stagedPath], toolOptions)
    : tool === "spctl"
      ? ChildProcess.make(
          SPCTL_COMMAND,
          ["--assess", "--type", "install", "--ignore-cache", "--no-cache", "-vv", stagedPath],
          toolOptions,
        )
      : tool === "binding-toc"
        ? ChildProcess.make(XAR_COMMAND, ["--dump-toc=/dev/stdout", "-f", stagedPath], toolOptions)
        : ChildProcess.make(
            TAR_COMMAND,
            tool === "binding-list"
              ? ["-t", "-f", stagedPath, "--", BINDING_ENTRY]
              : ["-x", "-O", "-f", stagedPath, "--", BINDING_ENTRY],
            toolOptions,
          );

/** Reads at most `MAX_TOOL_OUTPUT_BYTES`; the first byte past it fails and stops the read. */
const readCapped = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Effect.suspend(() => {
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    return stream.pipe(
      Stream.runForEach((chunk: Uint8Array): Effect.Effect<void, LocalPkgUpdateError> => {
        // Empty chunks add nothing and must not grow the list without bound.
        if (chunk.byteLength === 0) return Effect.void;
        total += chunk.byteLength;
        if (total > MAX_TOOL_OUTPUT_BYTES) return Effect.fail(checkFailed("output-limit"));
        chunks.push(chunk);
        return Effect.void;
      }),
      Effect.mapError((error) =>
        Schema.is(LocalPkgUpdateError)(error) ? error : checkFailed("spawn"),
      ),
      Effect.as(chunks),
    );
  });

const decodeOutput = (chunks: ReadonlyArray<Uint8Array>) =>
  Effect.try({
    try: () => {
      const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      // Keep a byte-order mark visible so the control-character check sees it.
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    },
    catch: () => checkFailed("parse"),
  });

/**
 * Runs one trust tool on the staged path. stdout, stderr and the exit status
 * are consumed concurrently, so a full pipe can never stall the exit; the whole
 * run shares one deadline, and closing the scope (deadline, cap, interruption)
 * terminates the child's process group with `forceKillAfter` escalation.
 */
export const runTrustTool = (tool: TrustTool, stagedPath: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner
        .spawn(trustToolCommand(tool, stagedPath))
        .pipe(Effect.mapError(() => checkFailed("spawn")));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readCapped(handle.stdout),
          readCapped(handle.stderr),
          handle.exitCode.pipe(Effect.mapError(() => checkFailed("spawn"))),
        ],
        { concurrency: "unbounded" },
      );
      return {
        exitCode: Number(exitCode),
        stdout: yield* decodeOutput(stdout),
        stderr: yield* decodeOutput(stderr),
      } satisfies ToolResult;
    }).pipe(
      Effect.timeoutOption(TOOL_DEADLINE),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(checkFailed("timeout")),
          onSome: Effect.succeed,
        }),
      ),
    ),
  );

const MAX_STAGED_PATH = 1024;
/** The longest line a report legitimately has is spctl's `<staged path>: accepted`. */
const MAX_LINE_LENGTH = MAX_STAGED_PATH + 64;
const MAX_REPORT_LINES = 200;
/** Controls, format characters (bidi, zero width, BOM), surrogates and line/paragraph separators. */
const DISALLOWED_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/**
 * The lines of a tool report: UTF-8 text with one trailing newline, no blank
 * lines, no trailing whitespace, no control characters other than the line
 * breaks. `undefined` means the text is not a report this module reads.
 */
const reportLines = (text: string): ReadonlyArray<string> | undefined => {
  if (!text.endsWith("\n") || DISALLOWED_TEXT.test(text.replaceAll("\n", ""))) return undefined;
  const lines = text.slice(0, -1).split("\n");
  return lines.length > MAX_REPORT_LINES ||
    lines.some((line) => line === "" || line.length > MAX_LINE_LENGTH || /\s$/u.test(line))
    ? undefined
    : lines;
};

const PKGUTIL_STATUS_DISTRIBUTION =
  "signed by a developer certificate issued by Apple for distribution";
const LEAF_LABEL = "Developer ID Installer: ";
const MAX_CHAIN_ITEMS = 8;
const MAX_FINGERPRINT_ROWS = 4;
const FINGERPRINT_OCTETS = 32;

const STATUS_LINE = /^ +Status: (\S.*)$/;
const NOTARIZATION_LINE = /^ +Notarization: \S.*$/;
const TIMESTAMP_LINE = /^ +Signed with a trusted timestamp on: \S.*$/;
const CHAIN_LINE = /^ +Certificate Chain:$/;
const ITEM_LINE = /^ +(\d{1,2})\. (\S.*)$/;
const EXPIRES_LINE = /^ +Expires: \S.*$/;
const FINGERPRINT_HEADER_LINE = /^ +SHA256 Fingerprint:$/;
const FINGERPRINT_ROW = /^ +([0-9A-Fa-f]{2}(?: [0-9A-Fa-f]{2}){0,31})$/;
const SEPARATOR_LINE = /^ +-{8,}$/;
const NO_SIGNATURE_LINE = /^ +Status: no signature$/;

export interface PublisherEvidence {
  /** Lowercase hex SHA256 fingerprint of certificate 1 in the chain. */
  readonly leafFingerprint: string;
  /** The policy's expected Team ID, not text read from the report. */
  readonly teamId: string;
}

/**
 * Reads a `pkgutil --check-signature` report for the staged package. pkgutil
 * prints the package's basename in the header even when given a full path.
 *
 * The OS decides whether the signature and chain are trusted (exit status and
 * the single `Status:` line); the only certificate this reads is item 1, the
 * leaf, whose label must be `Developer ID Installer:` and whose own
 * `SHA256 Fingerprint` must be one of the pins. Later certificate blocks are
 * indented display text: never parsed, never used for a fingerprint. Fields the
 * report may repeat or vary (`Notarization:`, `Expires:`, the dashed
 * separator) are optional and carry no authority; `spctl` decides notarization.
 */
export const parsePkgutilSignature = Effect.fnUntraced(function* (
  policy: DeveloperIdTrustPolicy,
  stagedPath: string,
  result: ToolResult,
) {
  const header = `Package "${stagedPath.slice(stagedPath.lastIndexOf("/") + 1)}":`;
  const lines = result.stderr === "" ? reportLines(result.stdout) : undefined;
  if (result.exitCode !== 0) {
    const unsigned =
      lines?.length === 2 && lines[0] === header && NO_SIGNATURE_LINE.test(lines[1] ?? "");
    const rejected = unsigned
      ? untrusted("no-signature")
      : checkFailed(trustExitCode(result.exitCode));
    return yield* rejected;
  }
  if (lines === undefined || lines[0] !== header) return yield* checkFailed("parse");

  const seen = new Set<"status" | "notarization" | "timestamp" | "chain">();
  let status: string | undefined;
  // "report" until item 1 starts, then "leaf" until the next numbered item, then "later".
  let block: "report" | "leaf" | "later" = "report";
  let nextItem = 1;
  const leaf = {
    name: undefined as string | undefined,
    expires: false,
    hasFingerprint: false,
    inFingerprint: false,
    ended: false,
    octets: [] as Array<string>,
    rows: 0,
  };

  for (const line of lines.slice(1)) {
    const statusMatch = STATUS_LINE.exec(line);
    const field = statusMatch
      ? "status"
      : NOTARIZATION_LINE.test(line)
        ? "notarization"
        : TIMESTAMP_LINE.test(line)
          ? "timestamp"
          : CHAIN_LINE.test(line)
            ? "chain"
            : undefined;
    if (field !== undefined) {
      if (seen.has(field)) return yield* untrusted("duplicate");
      // A report-level field after the chain began is out of place.
      if (seen.has("chain")) return yield* checkFailed("parse");
      seen.add(field);
      status = statusMatch?.[1] ?? status;
      continue;
    }

    const item = ITEM_LINE.exec(line);
    if (!seen.has("chain")) {
      // A certificate with no chain header above it has no leaf to speak of.
      const rejected = item ? untrusted("leaf") : checkFailed("parse");
      return yield* rejected;
    }
    if (item) {
      if (Number(item[1]) !== nextItem || nextItem > MAX_CHAIN_ITEMS) {
        return yield* checkFailed("parse");
      }
      if (nextItem === 1) leaf.name = item[2];
      block = nextItem === 1 ? "leaf" : "later";
      nextItem += 1;
    } else if (block === "later") {
      if (!line.startsWith(" ")) return yield* checkFailed("parse");
    } else if (block === "report" || leaf.ended) {
      return yield* checkFailed("parse");
    } else if (EXPIRES_LINE.test(line)) {
      if (leaf.expires) return yield* untrusted("duplicate");
      leaf.expires = true;
      leaf.inFingerprint = false;
    } else if (FINGERPRINT_HEADER_LINE.test(line)) {
      if (leaf.hasFingerprint) return yield* untrusted("duplicate");
      leaf.hasFingerprint = true;
      leaf.inFingerprint = true;
    } else if (leaf.inFingerprint && FINGERPRINT_ROW.test(line)) {
      leaf.octets.push(...line.trim().split(" "));
      leaf.rows += 1;
      if (leaf.rows > MAX_FINGERPRINT_ROWS || leaf.octets.length > FINGERPRINT_OCTETS) {
        return yield* checkFailed("parse");
      }
    } else if (SEPARATOR_LINE.test(line)) {
      leaf.ended = true;
      leaf.inFingerprint = false;
    } else {
      return yield* checkFailed("parse");
    }
  }

  if (status === "no signature") return yield* untrusted("no-signature");
  if (status !== PKGUTIL_STATUS_DISTRIBUTION) return yield* untrusted("status");
  if (!seen.has("timestamp")) return yield* untrusted("timestamp");
  if (leaf.name === undefined || !leaf.name.startsWith(LEAF_LABEL)) return yield* untrusted("leaf");
  if (leaf.octets.length !== FINGERPRINT_OCTETS) return yield* checkFailed("parse");
  const leafFingerprint = leaf.octets.join("").toLowerCase();
  if (!policy.leafPins.includes(leafFingerprint)) return yield* untrusted("pin-mismatch");
  return { leafFingerprint, teamId: policy.teamId } satisfies PublisherEvidence;
});

const SPCTL_SOURCE_NOTARIZED = "Notarized Developer ID";

/**
 * Reads an `spctl` assessment. The report is whichever of stdout/stderr is
 * non-empty (spctl writes its verbose result to stderr). Authority is the
 * `accepted` verdict for exactly `stagedPath`, exactly one
 * `source=Notarized Developer ID` and no `override=`; at most one `origin=` line
 * is allowed as display text and is not interpreted.
 */
export const parseSpctlAssessment = Effect.fnUntraced(function* (
  stagedPath: string,
  result: ToolResult,
) {
  if (result.exitCode !== 0) return yield* unconfirmed(trustExitCode(result.exitCode));
  const streams = [result.stdout, result.stderr].filter((text) => text !== "");
  const lines = streams.length === 1 ? reportLines(streams[0] ?? "") : undefined;
  if (lines === undefined) return yield* checkFailed("parse");
  if (lines.some((line) => line.startsWith("override="))) return yield* unconfirmed("override");
  if (lines[0] !== `${stagedPath}: accepted`) return yield* checkFailed("parse");

  const sources: Array<string> = [];
  let origins = 0;
  for (const line of lines.slice(1)) {
    if (line.startsWith("source=")) sources.push(line.slice("source=".length));
    else if (line.startsWith("origin=")) origins += 1;
    else return yield* checkFailed("parse");
  }
  if (sources.length > 1 || origins > 1) return yield* unconfirmed("duplicate");
  if (sources[0] !== SPCTL_SOURCE_NOTARIZED) return yield* unconfirmed("source");
});

/** What `LocalPkgUpdates.stage` produces from a validated manifest (arm64 is the manifest's only arch). */
const isCanonicalStagedPath = (staged: StagedPkg) =>
  staged.path.startsWith(`${staged.directory}/`) &&
  isReleasePackageName(
    staged.path.slice(staged.directory.length + 1),
    `-${staged.version}-arm64-update.pkg`,
  );

/**
 * The staged path is app-generated, but it ends up in tool argv and is matched
 * against tool output, so it must be the canonical staged file and carry
 * nothing that could break or spoof a report line.
 */
const isTrustableStagedPath = (staged: StagedPkg) =>
  isCanonicalStagedPath(staged) &&
  staged.path.startsWith("/") &&
  staged.path.length <= MAX_STAGED_PATH &&
  !staged.path.includes('"') &&
  !DISALLOWED_TEXT.test(staged.path) &&
  !staged.path.split("/").includes("..");

/**
 * Checks who published the staged package. `legacy-unsigned` does nothing and
 * spawns nothing. `developer-id` runs pkgutil, then spctl, and the first
 * failure wins. Callers re-verify the staged bytes afterwards.
 */
export const verifyPublisher = Effect.fn("desktop.updates.localPkg.verifyPublisher")(function* (
  policy: TrustPolicy,
  staged: StagedPkg,
) {
  if (policy.mode === "legacy-unsigned") return;
  if (!isTrustableStagedPath(staged)) {
    return yield* new LocalPkgUpdateError({ reason: "staged-changed" });
  }
  const signature = yield* runTrustTool("pkgutil", staged.path);
  yield* parsePkgutilSignature(policy, staged.path, signature);
  const assessment = yield* runTrustTool("spctl", staged.path);
  yield* parseSpctlAssessment(staged.path, assessment);
});

/**
 * Checks that the staged package's `Distribution` names the OOP release it is
 * staged as. Run it after `verifyPublisher`, which has the OS verify the signed
 * table of contents (TOC). tar does not reliably check an entry against the
 * checksum the TOC records for it (it skips every style but md5 and sha1), so
 * nothing here relies on that: the SHA-1 of the bytes tar prints must be one of
 * the TOC's SHA-1 `extracted-checksum` values (see `signedExtractedSha1s` for
 * what that does and does not establish), and only then is the product element
 * read. Without a matching SHA-1 extracted checksum, fail as `checksum`. Other
 * entries may use other styles. Both versions must be stable and the staged one newer,
 * otherwise nothing is spawned. Callers re-verify the staged bytes afterwards.
 */
export const verifyBinding = Effect.fn("desktop.updates.localPkg.verifyBinding")(function* (
  staged: StagedPkg,
  installedVersion: string,
) {
  const candidate = parseStableVersion(staged.version);
  const installed = parseStableVersion(installedVersion);
  if (
    Option.isNone(candidate) ||
    Option.isNone(installed) ||
    !isNewerVersion(candidate.value, installed.value)
  ) {
    return yield* bindingFailed("version");
  }
  if (!isTrustableStagedPath(staged)) {
    return yield* new LocalPkgUpdateError({ reason: "staged-changed" });
  }
  const listing = yield* runTrustTool("binding-list", staged.path);
  if (listing.exitCode !== 0 || listing.stderr !== "" || listing.stdout !== `${BINDING_ENTRY}\n`) {
    return yield* bindingFailed("entry");
  }
  const entry = yield* runTrustTool("binding-read", staged.path);
  if (entry.exitCode !== 0 || entry.stderr !== "") return yield* bindingFailed("entry");
  const toc = yield* runTrustTool("binding-toc", staged.path);
  if (toc.exitCode !== 0 || toc.stderr !== "") return yield* bindingFailed("checksum");
  // The output decoded as fatal UTF-8 with the byte-order mark kept, so this hashes the original bytes.
  const digest = NodeCrypto.createHash("sha1").update(entry.stdout, "utf8").digest("hex");
  if (!signedExtractedSha1s(toc.stdout).has(digest)) return yield* bindingFailed("checksum");
  if (!hasReleaseBinding(entry.stdout, staged.version)) return yield* bindingFailed("mismatch");
});
