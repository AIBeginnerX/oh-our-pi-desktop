import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * The error shared by LocalPkgUpdates and LocalPkgSource. Error messages are
 * shown in the renderer and mirrored to remote clients, so they never contain
 * a path; only `code` (an errno, `helper-failed` or an exit status) is kept.
 */

const REASONS = [
  "config-invalid",
  "folder-unavailable",
  "drive-folder-unavailable",
  "manifest-invalid",
  "manifest-unsupported",
  "version-unknown",
  "package-mismatch",
  "source-timeout",
  "staging-failed",
  "staged-changed",
  "check-required",
  "installer-failed",
  "publisher-untrusted",
  "notarization-unconfirmed",
  "trust-check-failed",
  "binding-failed",
] as const;

const MESSAGES: Record<(typeof REASONS)[number], string> = {
  "config-invalid":
    "The local update configuration bundled with this app is invalid. Reinstall OOP from a fresh build.",
  "folder-unavailable":
    "The local update folder could not be read. Check that it is mounted and try again.",
  "drive-folder-unavailable":
    "OOP could not find its update folder in Google Drive (OOP/release). Install Google Drive for desktop, sign in, and make the OOP folder available offline; OOP checks again every few minutes.",
  "manifest-invalid":
    "The update manifest in the local update folder is invalid. Rebuild the update package.",
  "manifest-unsupported": "The update in the local update folder is not built for this Mac.",
  "version-unknown": "This app's version cannot be compared with the local update.",
  "package-mismatch":
    "The update package does not match its manifest. Rebuild the update package and check again.",
  "source-timeout": "Reading the update package timed out. Check the network volume and try again.",
  "staging-failed":
    "OOP could not stage the update in its private folder. Check free disk space and try again.",
  "staged-changed": "The staged update changed on disk. Prepare the update again.",
  "check-required": "The local update changed. Check for updates again.",
  "installer-failed": "macOS Installer could not be opened for the staged update.",
  "publisher-untrusted":
    "The update package is not signed by the trusted OOP publisher and was rejected.",
  "notarization-unconfirmed":
    "macOS could not confirm that the update package is notarized, so it was rejected.",
  "trust-check-failed":
    "OOP could not finish checking the update package signature, so the package was rejected. Check for updates again.",
  "binding-failed":
    "The update package does not carry the expected OOP release identity and was rejected.",
};

export class LocalPkgUpdateError extends Schema.TaggedError<LocalPkgUpdateError>()(
  "LocalPkgUpdateError",
  {
    reason: Schema.Literals(REASONS),
    /** errno code, `helper-failed`, `exit-<status>` or a trust token; never a path. */
    code: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return MESSAGES[this.reason];
  }
}

export type Reason = LocalPkgUpdateError["reason"];

export const errnoCode = (cause: unknown): string | undefined =>
  Predicate.isObject(cause) && Predicate.isString(cause.code) ? cause.code : undefined;

export const failure = (reason: Reason, cause?: unknown) => {
  const code = errnoCode(cause);
  return new LocalPkgUpdateError({ reason, ...(code === undefined ? {} : { code }) });
};

/**
 * The only `code` values a publisher trust failure carries. Tool output, native
 * errors and paths never reach the error, so the code is a fixed token.
 */
export const TRUST_TOKENS = [
  "no-signature",
  "status",
  "timestamp",
  "leaf",
  "pin-mismatch",
  "duplicate",
  "override",
  "source",
  "parse",
  "timeout",
  "output-limit",
  "spawn",
  "entry",
  "mismatch",
  "version",
  "checksum",
] as const;

export type TrustCode = (typeof TRUST_TOKENS)[number] | `exit-${number}`;
export type TrustReason = Extract<
  Reason,
  "publisher-untrusted" | "notarization-unconfirmed" | "trust-check-failed" | "binding-failed"
>;

export const trustFailure = (reason: TrustReason, code: TrustCode) =>
  new LocalPkgUpdateError({ reason, code });

/** A process exit status as a token; anything that is not a plain status byte is a spawn problem. */
export const trustExitCode = (exitCode: number): TrustCode =>
  Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? `exit-${exitCode}` : "spawn";
