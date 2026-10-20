// @effect-diagnostics nodeBuiltinImport:off -- Buffer decodes the app archive byte for byte and os.userInfo names the account's home directory; neither needs an Effect service.
import * as NodeBuffer from "node:buffer";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { LocalPkgUpdateError } from "./LocalPkgUpdateError.ts";
import {
  MAX_TOOL_OUTPUT_BYTES,
  TOOL_ENV,
  TOOL_FORCE_KILL_AFTER,
  parsePkgutilSignature,
  runTrustTool,
  verifyPublisher,
} from "./LocalPkgTrust.ts";
import {
  encodeTrustPolicyMarker,
  findTrustPolicyMarkers,
  parseTrustPolicy,
  type DeveloperIdTrustPolicy,
} from "./LocalPkgTrustPolicy.ts";
import type { StagedPkg } from "./LocalPkgUpdates.ts";

/**
 * Signs, notarizes and staples one internal Developer ID candidate package for
 * `scripts/build-oop-update-pkg.mjs`, which loads this file under Node's type
 * stripping (erasable TypeScript only) in signed mode. The app runtime never
 * imports it. Signer pin and notarization are judged by the runtime's own
 * `runTrustTool`, `parsePkgutilSignature` and `verifyPublisher`; this module only
 * runs productsign, notarytool and stapler, each once and never retried. Errors
 * carry fixed tokens and, once validated as a UUID, the notary submission ID;
 * never tool output, paths, the identity, the pins or the keychain profile name.
 * Credentials stay in the keychain profile: no password, key or keychain path.
 */

export const INSTALLER_IDENTITY_ENV = "T3CODE_MACOS_INSTALLER_IDENTITY";
export const TEAM_ID_ENV = "T3CODE_APPLE_TEAM_ID";
export const INSTALLER_LEAF_PINS_ENV = "T3CODE_MACOS_INSTALLER_LEAF_SHA256";
export const NOTARY_PROFILE_ENV = "T3CODE_NOTARY_KEYCHAIN_PROFILE";

export const PRODUCTSIGN_COMMAND = "/usr/bin/productsign";
export const XCRUN_COMMAND = "/usr/bin/xcrun";
export const PRODUCTSIGN_DEADLINE = Duration.seconds(120);
/** notarytool's own `--timeout`: it stops waiting, the notary service keeps working. */
export const NOTARY_WAIT_TIMEOUT = "30m";
/** Outer deadline, with margin over the wait for upload and exit. */
export const NOTARY_DEADLINE = Duration.minutes(32);
export const STAPLE_DEADLINE = Duration.seconds(120);
export const STAPLE_VALIDATE_DEADLINE = Duration.seconds(60);

export const SIGNING_STEPS = [
  "config",
  "productsign",
  "signature",
  "notarize",
  "staple",
  "assess",
  "embedded-policy",
] as const;
export type SigningStep = (typeof SIGNING_STEPS)[number];

const SAFE_CODE = /^[a-z0-9]+(?:[:-][a-z0-9]+)*$/;
const MAX_CODE_LENGTH = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONFIG_MESSAGES: Readonly<Record<string, string>> = {
  "identity-missing": `${INSTALLER_IDENTITY_ENV} is required.`,
  "identity-invalid": `${INSTALLER_IDENTITY_ENV} must be the exact "Developer ID Installer: Name (TEAMID)" identity.`,
  "team-missing": `${TEAM_ID_ENV} is required.`,
  "team-invalid": `${TEAM_ID_ENV} must be a 10-character Apple Team ID.`,
  "team-mismatch": `The Team ID in ${INSTALLER_IDENTITY_ENV} does not match ${TEAM_ID_ENV}.`,
  "pins-missing": `${INSTALLER_LEAF_PINS_ENV} is required.`,
  "pins-invalid": `${INSTALLER_LEAF_PINS_ENV} must be 1 to 3 different comma-separated lowercase SHA-256 hex fingerprints.`,
  "profile-missing": `${NOTARY_PROFILE_ENV} is required.`,
  "profile-invalid": `${NOTARY_PROFILE_ENV} must be a keychain profile name of letters, digits, '.', '_' and '-'.`,
};

/**
 * The notarize codes after which no job can still be running: nothing was
 * submitted, or the service gave a final verdict. Every other code (timeout,
 * unreadable output, an I/O failure after spawn) is ambiguous.
 */
const DEFINITIVE_NOTARIZE_CODES: ReadonlySet<string> = new Set([
  "spawn",
  "path",
  "home",
  "status-invalid",
  "status-rejected",
]);

export class PkgSigningError extends Schema.TaggedError<PkgSigningError>()("PkgSigningError", {
  step: Schema.Literals(SIGNING_STEPS),
  code: Schema.String,
  submissionId: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    if (this.step === "config") {
      return CONFIG_MESSAGES[this.code] ?? `The signing configuration is invalid (${this.code}).`;
    }
    const submission =
      this.submissionId === undefined ? "" : ` Notary submission ${this.submissionId}.`;
    const ambiguous =
      this.step === "notarize" && !DEFINITIVE_NOTARIZE_CODES.has(this.code)
        ? " The outcome is ambiguous: the notary job may still be processing. Check Apple's notary history before submitting again."
        : "";
    return `Signed candidate ${this.step} failed (${this.code}).${submission}${ambiguous}`;
  }
}

/** The only constructor: a code outside the safe token shape becomes `unknown`, and only a UUID is kept as the submission ID. */
const signingError = (step: SigningStep, code: string, submissionId?: string) =>
  new PkgSigningError({
    step,
    code: code.length <= MAX_CODE_LENGTH && SAFE_CODE.test(code) ? code : "unknown",
    ...(submissionId !== undefined && UUID.test(submissionId) ? { submissionId } : {}),
  });

/** Unlike the runtime's `trustExitCode`, an odd status is not `spawn`: here that token means nothing ran. */
const exitToken = (exitCode: number) =>
  Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255
    ? `exit-${exitCode}`
    : "exit-unknown";

const fromTrustError = (step: SigningStep, error: LocalPkgUpdateError) =>
  signingError(step, error.code === undefined ? error.reason : `${error.reason}:${error.code}`);

export interface PkgSigning {
  readonly installerIdentity: string;
  readonly teamId: string;
  readonly policy: DeveloperIdTrustPolicy;
  readonly notaryProfile: string;
}

export interface SignedPackageEvidence {
  readonly leafFingerprint: string;
}

export interface NotarizationEvidence {
  readonly submissionId: string;
}

const INSTALLER_IDENTITY = /^Developer ID Installer: [^\p{Cc}]+ \(([A-Z0-9]{10})\)$/u;
const TEAM_ID = /^[A-Z0-9]{10}$/;
const NOTARY_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The signing inputs, read only once the caller chose signed mode. The first
 * problem throws a `config` error that names the variable, never its value.
 */
export const resolvePkgSigning = (
  env: Readonly<Record<string, string | undefined>>,
): PkgSigning => {
  const fail = (code: string): never => {
    throw signingError("config", code);
  };
  const installerIdentity = env[INSTALLER_IDENTITY_ENV] ?? "";
  if (installerIdentity === "") return fail("identity-missing");
  const identityTeam = INSTALLER_IDENTITY.exec(installerIdentity)?.[1];
  if (identityTeam === undefined) return fail("identity-invalid");
  const rawTeam = env[TEAM_ID_ENV]?.trim() ?? "";
  if (rawTeam === "") return fail("team-missing");
  const teamId = rawTeam.toUpperCase();
  if (!TEAM_ID.test(teamId)) return fail("team-invalid");
  if (identityTeam !== teamId) return fail("team-mismatch");
  const rawPins = env[INSTALLER_LEAF_PINS_ENV] ?? "";
  if (rawPins === "") return fail("pins-missing");
  const policy = parseTrustPolicy({ mode: "developer-id", teamId, leafPins: rawPins.split(",") });
  if (policy === undefined || policy.mode !== "developer-id") return fail("pins-invalid");
  const notaryProfile = env[NOTARY_PROFILE_ENV] ?? "";
  if (notaryProfile === "") return fail("profile-missing");
  if (!NOTARY_PROFILE.test(notaryProfile)) return fail("profile-invalid");
  return { installerIdentity, teamId, policy, notaryProfile };
};

/**
 * Scans the whole `app.asar` as latin1 for trust markers: at least one, and every
 * one exactly the marker of `policy`. This is deliberately limited. It does not
 * parse the archive or show which entry the app runs, so a marker in any entry
 * passes. It relies on the input being an E23 Developer ID candidate DMG, whose
 * staged `main.cjs` the artifact builder already checked; it is not proof of the
 * active policy.
 */
export const checkEmbeddedPolicy = (asar: Uint8Array, policy: DeveloperIdTrustPolicy): void => {
  const expected = encodeTrustPolicyMarker(policy);
  let markers: ReadonlyArray<string>;
  try {
    markers = findTrustPolicyMarkers(
      NodeBuffer.Buffer.from(asar.buffer, asar.byteOffset, asar.byteLength).toString("latin1"),
    );
  } catch {
    throw signingError("embedded-policy", "scan");
  }
  if (markers.length === 0) throw signingError("embedded-policy", "none");
  if (markers.some((marker) => marker !== expected)) {
    throw signingError("embedded-policy", "mismatch");
  }
};

const MAX_TOOL_PATH = 1024;
const CONTROL_CHARACTERS = /\p{Cc}/u;

/** Absolute, bounded and free of control characters: argv never starts with `-` and cannot break a line. */
const isToolPath = (path: string) =>
  path.startsWith("/") && path.length <= MAX_TOOL_PATH && !CONTROL_CHARACTERS.test(path);

/** `spawn` means no process exists; `io` is any stream or exit-wait failure after one does. */
type ToolFailure = "spawn" | "io" | "timeout" | "output-limit" | "home";

/** The account's home directory from the user database, never from the environment. */
const trustedHome = Effect.try({
  try: () => {
    const { homedir } = NodeOS.userInfo();
    if (!isToolPath(homedir)) throw new Error("untrusted home directory");
    return homedir;
  },
  catch: (): ToolFailure => "home",
});

/** Reads at most `MAX_TOOL_OUTPUT_BYTES`; the first byte past it fails. `keep` receives the chunks that fit. */
const drainCapped = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  keep: Array<Uint8Array> | undefined,
) =>
  Effect.suspend(() => {
    let total = 0;
    return stream.pipe(
      Stream.runForEach((chunk: Uint8Array): Effect.Effect<void, "output-limit"> => {
        if (chunk.byteLength === 0) return Effect.void;
        total += chunk.byteLength;
        if (total > MAX_TOOL_OUTPUT_BYTES) return Effect.fail("output-limit" as const);
        keep?.push(chunk);
        return Effect.void;
      }),
      Effect.mapError((error): ToolFailure => (error === "output-limit" ? "output-limit" : "io")),
    );
  });

/**
 * Runs one signing tool and yields its exit status. The environment is exactly
 * `TOOL_ENV` plus `HOME`; both streams are drained concurrently under the
 * runtime's 64 KiB cap and the whole run shares one deadline. Closing the scope
 * (deadline, cap, interruption) terminates the child's process group. `keepStdout`
 * fills as output arrives, so the caller sees what was read even if the run
 * fails. A failed exit wait is settled only after the streams end, so output
 * already printed is not lost; a stream that never ends is bounded by the deadline.
 */
const runSigningTool = (
  command: string,
  args: ReadonlyArray<string>,
  deadline: Duration.Duration,
  keepStdout?: Array<Uint8Array>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = yield* trustedHome;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(command, args, {
            env: { ...TOOL_ENV, HOME: home },
            extendEnv: false,
            stdin: "ignore",
            forceKillAfter: TOOL_FORCE_KILL_AFTER,
          }),
        )
        .pipe(Effect.mapError((): ToolFailure => "spawn"));
      const [, , exitCode] = yield* Effect.all(
        [
          drainCapped(handle.stdout, keepStdout),
          drainCapped(handle.stderr, undefined),
          handle.exitCode.pipe(Effect.catch(() => Effect.succeed(undefined))),
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode === undefined) return yield* Effect.fail("io" as const);
      return Number(exitCode);
    }).pipe(
      Effect.timeoutOption(deadline),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail("timeout" as const),
          onSome: Effect.succeed,
        }),
      ),
    ),
  );

/** A tool whose only verdict is exit 0. `prefix` tells the staple and validate failures apart. */
const runToSuccess = (
  step: SigningStep,
  prefix: string,
  command: string,
  args: ReadonlyArray<string>,
  deadline: Duration.Duration,
  submissionId?: string,
) =>
  runSigningTool(command, args, deadline).pipe(
    Effect.mapError((failure) => signingError(step, `${prefix}${failure}`, submissionId)),
    Effect.flatMap((exitCode) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail(signingError(step, `${prefix}${exitToken(exitCode)}`, submissionId)),
    ),
  );

/**
 * Signs `unsignedPath` into `signedPath` with the Developer ID Installer
 * identity and a secure timestamp, then has the runtime's pkgutil check confirm
 * the leaf is a policy pin. That runs before anything is uploaded, so a wrong
 * signer fails locally instead of after a notary round trip.
 */
export const signPackageEffect = Effect.fn("desktop.updates.localPkgCandidate.signPackage")(
  function* (
    s: PkgSigning,
    unsignedPath: string,
    signedPath: string,
  ): Effect.fn.Return<
    SignedPackageEvidence,
    PkgSigningError,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    if (!isToolPath(unsignedPath) || !isToolPath(signedPath) || unsignedPath === signedPath) {
      return yield* signingError("productsign", "path");
    }
    yield* runToSuccess(
      "productsign",
      "",
      PRODUCTSIGN_COMMAND,
      ["--sign", s.installerIdentity, "--timestamp", unsignedPath, signedPath],
      PRODUCTSIGN_DEADLINE,
    );
    const report = yield* runTrustTool("pkgutil", signedPath).pipe(
      Effect.mapError((error) => fromTrustError("signature", error)),
    );
    const evidence = yield* parsePkgutilSignature(s.policy, signedPath, report).pipe(
      Effect.mapError((error) => fromTrustError("signature", error)),
    );
    return { leafFingerprint: evidence.leafFingerprint };
  },
);

type ToolOutcome =
  | { readonly _tag: "exited"; readonly exitCode: number }
  | { readonly _tag: "failed"; readonly failure: ToolFailure };

const settle = <R>(tool: Effect.Effect<number, ToolFailure, R>) =>
  tool.pipe(
    Effect.map((exitCode): ToolOutcome => ({ _tag: "exited", exitCode })),
    Effect.catch((failure): Effect.Effect<ToolOutcome> =>
      Effect.succeed({ _tag: "failed", failure }),
    ),
  );

/**
 * The one complete JSON object notarytool printed, reduced to a UUID `id` and a
 * string `status`. Not JSON, not an object (arrays included), a byte-order mark,
 * invalid UTF-8 or trailing text all give `undefined`.
 */
const readNotaryReport = (chunks: ReadonlyArray<Uint8Array>) => {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        NodeBuffer.Buffer.concat(chunks),
      ),
    );
    if (!Predicate.isObject(parsed)) return undefined;
    const { id, status } = parsed;
    return {
      id: Predicate.isString(id) && UUID.test(id) ? id : undefined,
      status: Predicate.isString(status) ? status : undefined,
    };
  } catch {
    return undefined;
  }
};

const NOTARY_VERDICT_CODES: ReadonlyMap<string, string> = new Map([
  ["Invalid", "status-invalid"],
  ["Rejected", "status-rejected"],
  ["In Progress", "status-in-progress"],
]);

/**
 * Success is exit 0, `status` exactly `Accepted` and a UUID `id`. Every failure,
 * including a deadline, cap or I/O failure, keeps the UUID if complete JSON that
 * carried one had already been read.
 */
const notaryDecision = (
  outcome: ToolOutcome,
  stdout: ReadonlyArray<Uint8Array>,
): NotarizationEvidence | PkgSigningError => {
  const report = readNotaryReport(stdout);
  if (outcome._tag === "failed") return signingError("notarize", outcome.failure, report?.id);
  if (report === undefined) {
    return signingError("notarize", outcome.exitCode === 0 ? "parse" : exitToken(outcome.exitCode));
  }
  if (report.status === undefined) return signingError("notarize", "parse", report.id);
  if (report.status !== "Accepted") {
    return signingError(
      "notarize",
      NOTARY_VERDICT_CODES.get(report.status) ?? "status-unexpected",
      report.id,
    );
  }
  if (outcome.exitCode !== 0) {
    return signingError("notarize", exitToken(outcome.exitCode), report.id);
  }
  return report.id === undefined ? signingError("notarize", "id") : { submissionId: report.id };
};

/**
 * Submits `signedPath` to the notary service and waits, then staples and
 * validates. Authentication is the keychain profile alone. `Accepted` and the
 * staple are separate facts: only a passing `stapler validate` proves the staple.
 * Nothing is resubmitted, so an ambiguous outcome needs a manual look at the
 * notary history.
 */
export const notarizeAndStapleEffect = Effect.fn(
  "desktop.updates.localPkgCandidate.notarizeAndStaple",
)(function* (
  s: PkgSigning,
  signedPath: string,
): Effect.fn.Return<
  NotarizationEvidence,
  PkgSigningError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  if (!isToolPath(signedPath)) return yield* signingError("notarize", "path");
  const printed: Array<Uint8Array> = [];
  const outcome = yield* settle(
    runSigningTool(
      XCRUN_COMMAND,
      [
        "notarytool",
        "submit",
        signedPath,
        "--keychain-profile",
        s.notaryProfile,
        "--wait",
        "--timeout",
        NOTARY_WAIT_TIMEOUT,
        "--output-format",
        "json",
      ],
      NOTARY_DEADLINE,
      printed,
    ),
  );
  const decision = notaryDecision(outcome, printed);
  if (Schema.is(PkgSigningError)(decision)) return yield* decision;
  yield* runToSuccess(
    "staple",
    "staple:",
    XCRUN_COMMAND,
    ["stapler", "staple", signedPath],
    STAPLE_DEADLINE,
    decision.submissionId,
  );
  yield* runToSuccess(
    "staple",
    "validate:",
    XCRUN_COMMAND,
    ["stapler", "validate", signedPath],
    STAPLE_VALIDATE_DEADLINE,
    decision.submissionId,
  );
  return decision;
});

const STABLE_TRIPLE = /^\d+\.\d+\.\d+$/;

/**
 * Runs the runtime's own `verifyPublisher` (pkgutil pin, then spctl
 * notarization) on the stapled file under the canonical staged name. The runtime
 * reads only a staged package's path, directory and version, so the size and
 * hash here are placeholders and nothing re-verifies them.
 */
export const assessNotarizedPackageEffect = Effect.fn(
  "desktop.updates.localPkgCandidate.assessNotarizedPackage",
)(function* (
  s: PkgSigning,
  signedPath: string,
  version: string,
): Effect.fn.Return<void, PkgSigningError, ChildProcessSpawner.ChildProcessSpawner> {
  const split = signedPath.lastIndexOf("/");
  if (
    !STABLE_TRIPLE.test(version) ||
    !isToolPath(signedPath) ||
    signedPath.slice(split + 1) !== `OoP-${version}-arm64-update.pkg`
  ) {
    return yield* signingError("assess", "path");
  }
  const staged: StagedPkg = {
    version,
    size: 0,
    sha256: "0".repeat(64),
    path: signedPath,
    directory: signedPath.slice(0, split),
  };
  yield* verifyPublisher(s.policy, staged).pipe(
    Effect.mapError((error) => fromTrustError("assess", error)),
  );
});

/** Provides the Node services and rejects with the `PkgSigningError` itself rather than a fiber failure. */
const runPromise = async <A>(
  effect: Effect.Effect<A, PkgSigningError, ChildProcessSpawner.ChildProcessSpawner>,
): Promise<A> => {
  const settled = await Effect.runPromise(
    effect.pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      Effect.provide(NodeServices.layer),
    ),
  );
  if (!settled.ok) throw settled.error;
  return settled.value;
};

export const signPackage = (s: PkgSigning, unsignedPath: string, signedPath: string) =>
  runPromise(signPackageEffect(s, unsignedPath, signedPath));

export const notarizeAndStaple = (s: PkgSigning, signedPath: string) =>
  runPromise(notarizeAndStapleEffect(s, signedPath));

export const assessNotarizedPackage = (s: PkgSigning, signedPath: string, version: string) =>
  runPromise(assessNotarizedPackageEffect(s, signedPath, version));
