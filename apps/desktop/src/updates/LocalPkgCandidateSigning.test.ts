import { assert, describe, it } from "@effect/vitest";
import * as NodeOS from "node:os";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as CandidateSigning from "./LocalPkgCandidateSigning.ts";
import { encodeTrustPolicyMarker } from "./LocalPkgTrustPolicy.ts";
import * as Trust from "./LocalPkgTrust.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const pin = "ab".repeat(32);
const otherPin = "cd".repeat(32);
const teamId = "ABCDE12345";
const identity = `Developer ID Installer: OOP (${teamId})`;
const notaryProfile = "oop-release";
const validEnv = {
  T3CODE_MACOS_INSTALLER_IDENTITY: identity,
  T3CODE_APPLE_TEAM_ID: teamId,
  T3CODE_MACOS_INSTALLER_LEAF_SHA256: pin,
  T3CODE_NOTARY_KEYCHAIN_PROFILE: notaryProfile,
};
const expectedPolicy = { mode: "developer-id" as const, teamId, leafPins: [pin] };
const asar = (text: string) => new TextEncoder().encode(text);
const encoder = new TextEncoder();
const unsignedPath = "/private/oop-candidate/work/unsigned/OoP-0.0.59-arm64-update.pkg";
const signedPath = "/private/oop-candidate/work/signed/OoP-0.0.59-arm64-update.pkg";
const submissionId = "c873eed7-0c10-4518-9cdf-1a8d15789113";
const validSigning = {
  installerIdentity: identity,
  teamId,
  policy: expectedPolicy,
  notaryProfile,
};
const hexOctets = (hex: string) => hex.match(/../g)!.join(" ").toUpperCase();
// SYNTHETIC output shape. This does not prove a real signed package passes macOS checks.
const pkgutilOutput =
  `Package "OoP-0.0.59-arm64-update.pkg":\n` +
  `   Status: signed by a developer certificate issued by Apple for distribution\n` +
  `   Signed with a trusted timestamp on: 2026-10-09 12:00:00 +0000\n` +
  `   Certificate Chain:\n` +
  `    1. Developer ID Installer: OOP (${teamId})\n` +
  `       SHA256 Fingerprint:\n` +
  `           ${hexOctets(pin)}\n`;
const spctlOutput = `${signedPath}: accepted\nsource=Notarized Developer ID\n`;

interface FakeOutput {
  readonly stdout?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly stderr?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
  readonly onClose?: () => void;
}

const fakeSpawner = (
  calls: ChildProcess.Command[],
  respond: (command: ChildProcess.Command) => FakeOutput,
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          calls.push(command);
          const output = respond(command);
          return {
            output,
            handle: ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(31415),
              stdout: output.stdout ?? Stream.empty,
              stderr: output.stderr ?? Stream.empty,
              all: Stream.empty,
              exitCode: output.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
          };
        }),
        ({ output }) => Effect.sync(() => output.onClose?.()),
      ).pipe(Effect.map(({ handle }) => handle)),
    ),
  );

const command = (item: ChildProcess.Command) => {
  assert.equal(item._tag, "StandardCommand");
  if (item._tag !== "StandardCommand") throw new Error("expected a standard command");
  return item;
};

const assertSafeFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, step: string) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect);
    assert.equal((error as { step?: string }).step, step);
    const description = String(error);
    for (const secret of ["SECRET-STDOUT", "SECRET-STDERR", identity, signedPath, notaryProfile]) {
      assert.notInclude(description, secret);
    }
    return error as { step?: string; code?: string; submissionId?: string };
  });

const expectSafeThrow = (run: () => unknown, secrets: ReadonlyArray<string> = []) => {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.isDefined(caught);
  const description = String(caught);
  for (const secret of secrets) assert.notInclude(description, secret);
};

describe("local package candidate signing configuration", () => {
  it("accepts one canonical Installer identity, Team, pin and keychain profile", () => {
    assert.deepEqual(CandidateSigning.resolvePkgSigning(validEnv), {
      installerIdentity: identity,
      teamId,
      policy: expectedPolicy,
      notaryProfile,
    });
  });

  it("rejects every missing setting and ignores electron-builder CSC_NAME", () => {
    for (const missing of Object.keys(validEnv) as Array<keyof typeof validEnv>) {
      const env = { ...validEnv, CSC_NAME: "SECRET-CSC-NAME" } as Record<string, string>;
      delete env[missing];
      expectSafeThrow(() => CandidateSigning.resolvePkgSigning(env), ["SECRET-CSC-NAME"]);
    }
  });

  it("rejects wrong identity, Team, pins and profile without echoing their values", () => {
    const changes = [
      { T3CODE_MACOS_INSTALLER_IDENTITY: "Developer ID Application: SECRET-APP (ABCDE12345)" },
      { T3CODE_MACOS_INSTALLER_IDENTITY: "Developer ID Installer: SECRET-NAME (ZZZZZ12345)" },
      { T3CODE_APPLE_TEAM_ID: "ZZZZZ12345" },
      { T3CODE_MACOS_INSTALLER_LEAF_SHA256: "g".repeat(64) },
      { T3CODE_MACOS_INSTALLER_LEAF_SHA256: pin.toUpperCase() },
      { T3CODE_MACOS_INSTALLER_LEAF_SHA256: `${pin},${pin}` },
      {
        T3CODE_MACOS_INSTALLER_LEAF_SHA256: `${pin},${otherPin},${"ef".repeat(32)},${"12".repeat(32)}`,
      },
      { T3CODE_NOTARY_KEYCHAIN_PROFILE: "-SECRET-PROFILE" },
      { T3CODE_NOTARY_KEYCHAIN_PROFILE: "SECRET PROFILE" },
      { T3CODE_NOTARY_KEYCHAIN_PROFILE: "S".repeat(65) },
    ];
    for (const change of changes) {
      const env = { ...validEnv, ...change };
      expectSafeThrow(() => CandidateSigning.resolvePkgSigning(env), Object.values(change));
    }
  });
});

describe("local package candidate embedded policy", () => {
  const marker = encodeTrustPolicyMarker(expectedPolicy);

  it("accepts repeated exact markers anywhere in the archive", () => {
    CandidateSigning.checkEmbeddedPolicy(
      asar(`prefix\0${marker}\0middle\0${marker}\0suffix`),
      expectedPolicy,
    );
  });

  it("rejects missing, legacy, mixed, other Team and other pins", () => {
    const wrongTeam = encodeTrustPolicyMarker({ ...expectedPolicy, teamId: "ZZZZZ12345" });
    const wrongPin = encodeTrustPolicyMarker({ ...expectedPolicy, leafPins: [otherPin] });
    const legacy = encodeTrustPolicyMarker({ mode: "legacy-unsigned" });
    for (const bytes of [
      asar("no marker"),
      asar(legacy),
      asar(`${marker}\0${legacy}`),
      asar(wrongTeam),
      asar(wrongPin),
    ]) {
      expectSafeThrow(() => CandidateSigning.checkEmbeddedPolicy(bytes, expectedPolicy), [pin]);
    }
  });
});

describe("local package candidate signing tools", () => {
  it.effect("runs productsign then the existing pinned pkgutil parser", () =>
    Effect.gen(function* () {
      const calls: ChildProcess.Command[] = [];
      const output = yield* CandidateSigning.signPackageEffect(
        validSigning,
        unsignedPath,
        signedPath,
      ).pipe(
        Effect.provide(
          fakeSpawner(calls, (item) => ({
            stdout:
              command(item).command === Trust.PKGUTIL_COMMAND
                ? Stream.make(encoder.encode(pkgutilOutput))
                : Stream.empty,
          })),
        ),
      );
      assert.equal(output.leafFingerprint, pin);
      assert.deepEqual(
        calls.map((item) => command(item).command),
        ["/usr/bin/productsign", Trust.PKGUTIL_COMMAND],
      );
      assert.deepEqual(command(calls[0]!).args, [
        "--sign",
        identity,
        "--timestamp",
        unsignedPath,
        signedPath,
      ]);
      assert.deepEqual(command(calls[1]!).args, ["--check-signature", signedPath]);
    }),
  );

  it.effect("rejects unsafe paths before any spawn and stops after a wrong signer", () =>
    Effect.gen(function* () {
      const calls: ChildProcess.Command[] = [];
      const spawner = fakeSpawner(calls, () => ({
        stdout: Stream.make(
          encoder.encode(pkgutilOutput.replace(hexOctets(pin), hexOctets(otherPin))),
        ),
      }));
      for (const [input, output] of [
        ["relative.pkg", signedPath],
        [unsignedPath, unsignedPath],
        [unsignedPath, `${signedPath}\nSECRET-STDOUT`],
      ] as const) {
        const error = yield* assertSafeFailure(
          CandidateSigning.signPackageEffect(validSigning, input, output).pipe(
            Effect.provide(spawner),
          ),
          "productsign",
        );
        assert.equal(error.code, "path");
      }
      assert.equal(calls.length, 0);
      const error = yield* assertSafeFailure(
        CandidateSigning.signPackageEffect(validSigning, unsignedPath, signedPath).pipe(
          Effect.provide(spawner),
        ),
        "signature",
      );
      assert.equal(error.code, "publisher-untrusted:pin-mismatch");
      assert.deepEqual(
        calls.map((item) => command(item).command),
        ["/usr/bin/productsign", Trust.PKGUTIL_COMMAND],
      );
    }),
  );

  it.effect(
    "uses fixed notary and stapler arguments, sanitized environment, and one submission",
    () =>
      Effect.gen(function* () {
        const calls: ChildProcess.Command[] = [];
        const output = yield* CandidateSigning.notarizeAndStapleEffect(
          validSigning,
          signedPath,
        ).pipe(
          Effect.provide(
            fakeSpawner(calls, (item) => ({
              stdout:
                command(item).args[0] === "notarytool"
                  ? Stream.make(
                      encoder.encode(encodeJson({ status: "Accepted", id: submissionId })),
                    )
                  : Stream.empty,
            })),
          ),
        );
        assert.equal(output.submissionId, submissionId);
        assert.deepEqual(
          calls.map((item) => command(item).args),
          [
            [
              "notarytool",
              "submit",
              signedPath,
              "--keychain-profile",
              notaryProfile,
              "--wait",
              "--timeout",
              "30m",
              "--output-format",
              "json",
            ],
            ["stapler", "staple", signedPath],
            ["stapler", "validate", signedPath],
          ],
        );
        for (const item of calls) {
          const observed = command(item);
          assert.equal(observed.command, "/usr/bin/xcrun");
          assert.equal(observed.options.extendEnv, false);
          assert.equal(observed.options.stdin, "ignore");
          assert.deepEqual(observed.options.env, {
            ...Trust.TOOL_ENV,
            HOME: NodeOS.userInfo().homedir,
          });
          assert.equal(Duration.toMillis(observed.options.forceKillAfter!), 2_000);
          for (const forbidden of ["--password", "--apple-id", "--key", "--keychain-path"]) {
            assert.notInclude(observed.args, forbidden);
          }
        }
      }),
  );

  it.effect("reuses the runtime pkgutil and spctl parsers for final assessment", () =>
    Effect.gen(function* () {
      const calls: ChildProcess.Command[] = [];
      yield* CandidateSigning.assessNotarizedPackageEffect(validSigning, signedPath, "0.0.59").pipe(
        Effect.provide(
          fakeSpawner(calls, (item) => ({
            stdout:
              command(item).command === Trust.PKGUTIL_COMMAND
                ? Stream.make(encoder.encode(pkgutilOutput))
                : Stream.empty,
            stderr:
              command(item).command === Trust.SPCTL_COMMAND
                ? Stream.make(encoder.encode(spctlOutput))
                : Stream.empty,
          })),
        ),
      );
      assert.deepEqual(
        calls.map((item) => command(item).command),
        [Trust.PKGUTIL_COMMAND, Trust.SPCTL_COMMAND],
      );
      assert.deepEqual(command(calls[1]!).args, [
        "--assess",
        "--type",
        "install",
        "--ignore-cache",
        "--no-cache",
        "-vv",
        signedPath,
      ]);
    }),
  );

  it.effect("requires an Accepted JSON object with a UUID and successful exit, without retry", () =>
    Effect.gen(function* () {
      const accepted = encodeJson({ status: "Accepted", id: submissionId });
      for (const [text, exit] of [
        [encodeJson({ status: "Invalid", id: submissionId }), 0],
        [encodeJson({ status: "Rejected", id: submissionId }), 0],
        [encodeJson({ status: "In Progress", id: submissionId }), 0],
        [encodeJson({ id: submissionId }), 0],
        [encodeJson({ status: "Accepted", id: "bad-id" }), 0],
        ["SECRET-STDOUT not JSON", 0],
        [`${accepted}\nSECRET-STDOUT`, 0],
        [accepted, 1],
      ] as const) {
        const calls: ChildProcess.Command[] = [];
        yield* assertSafeFailure(
          CandidateSigning.notarizeAndStapleEffect(validSigning, signedPath).pipe(
            Effect.provide(
              fakeSpawner(calls, () => ({
                stdout: Stream.make(encoder.encode(text)),
                stderr: Stream.make(encoder.encode("SECRET-STDERR")),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exit)),
              })),
            ),
          ),
          "notarize",
        );
        assert.equal(calls.length, 1);
      }
    }),
  );

  it.effect("treats an exit wait failure after submission as ambiguous and never retries", () =>
    Effect.gen(function* () {
      const calls: ChildProcess.Command[] = [];
      const exitCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcess",
        method: "exitCode",
        description: "SECRET-STDERR",
      });
      const error = yield* assertSafeFailure(
        CandidateSigning.notarizeAndStapleEffect(validSigning, signedPath).pipe(
          Effect.provide(
            fakeSpawner(calls, () => ({
              stdout: Stream.make(
                encoder.encode(encodeJson({ status: "Accepted", id: submissionId })),
              ),
              exitCode: Effect.fail(exitCause),
            })),
          ),
        ),
        "notarize",
      );
      assert.equal(calls.length, 1);
      assert.include(String(error), "may still be processing");
      assert.include(String(error), "notary history");
      assert.equal(error.submissionId, submissionId);
    }),
  );

  it.effect(
    "treats a post-spawn stream failure as ambiguous but a failed spawn as definitive",
    () =>
      Effect.gen(function* () {
        const cause = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "ChildProcess",
          method: "stdout",
          description: "SECRET-STDOUT",
        });
        const readCalls: ChildProcess.Command[] = [];
        const readError = yield* assertSafeFailure(
          CandidateSigning.notarizeAndStapleEffect(validSigning, signedPath).pipe(
            Effect.provide(fakeSpawner(readCalls, () => ({ stdout: Stream.fail(cause) }))),
          ),
          "notarize",
        );
        assert.equal(readCalls.length, 1);
        assert.include(String(readError), "may still be processing");

        let spawnCount = 0;
        const failedSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => {
            spawnCount += 1;
            return Effect.fail(cause);
          }),
        );
        const spawnError = yield* assertSafeFailure(
          CandidateSigning.notarizeAndStapleEffect(validSigning, signedPath).pipe(
            Effect.provide(failedSpawner),
          ),
          "notarize",
        );
        assert.equal(spawnCount, 1);
        assert.equal(spawnError.code, "spawn");
        assert.notInclude(String(spawnError), "may still be processing");
      }),
  );

  it.effect("rejects oversized notary output in either stream without a second submission", () =>
    Effect.gen(function* () {
      for (const streamName of ["stdout", "stderr"] as const) {
        const calls: ChildProcess.Command[] = [];
        let closes = 0;
        const error = yield* assertSafeFailure(
          CandidateSigning.notarizeAndStapleEffect(validSigning, signedPath).pipe(
            Effect.provide(
              fakeSpawner(calls, () => ({
                [streamName]: Stream.make(encoder.encode("é".repeat(32 * 1024 + 1))),
                onClose: () => {
                  closes += 1;
                },
              })),
            ),
          ),
          "notarize",
        );
        assert.equal(error.code, "output-limit");
        assert.equal(calls.length, 1);
        assert.equal(closes, 1);
      }
    }),
  );

  it.effect("caps each signing stream by UTF-8 bytes and closes the child scope", () =>
    Effect.gen(function* () {
      for (const streamName of ["stdout", "stderr"] as const) {
        const calls: ChildProcess.Command[] = [];
        let closes = 0;
        yield* assertSafeFailure(
          CandidateSigning.signPackageEffect(validSigning, unsignedPath, signedPath).pipe(
            Effect.provide(
              fakeSpawner(calls, () => ({
                [streamName]: Stream.make(encoder.encode("é".repeat(32 * 1024 + 1))),
                onClose: () => {
                  closes += 1;
                },
              })),
            ),
          ),
          "productsign",
        );
        assert.equal(calls.length, 1);
        assert.equal(closes, 1);
      }
    }),
  );

  it.effect("stops before validation if staple fails", () =>
    Effect.gen(function* () {
      const calls: ChildProcess.Command[] = [];
      yield* assertSafeFailure(
        CandidateSigning.notarizeAndStapleEffect(validSigning, signedPath).pipe(
          Effect.provide(
            fakeSpawner(calls, (item) => ({
              stdout:
                command(item).args[0] === "notarytool"
                  ? Stream.make(
                      encoder.encode(encodeJson({ status: "Accepted", id: submissionId })),
                    )
                  : Stream.empty,
              exitCode: Effect.succeed(
                ChildProcessSpawner.ExitCode(command(item).args[1] === "staple" ? 1 : 0),
              ),
            })),
          ),
        ),
        "staple",
      );
      assert.deepEqual(
        calls.map((item) => command(item).args[1]),
        ["submit", "staple"],
      );
    }),
  );

  it.effect("applies the outer notarization deadline to a stalled read and finalizes once", () =>
    Effect.gen(function* () {
      const enteredRead = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const calls: ChildProcess.Command[] = [];
      let closes = 0;
      const spawner = fakeSpawner(calls, () => ({
        stdout: Stream.fromEffect(
          Deferred.succeed(enteredRead, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(encoder.encode("late")),
          ),
        ),
        exitCode: Deferred.await(release).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
        onClose: () => {
          closes += 1;
        },
      }));
      const checking = yield* CandidateSigning.notarizeAndStapleEffect(
        validSigning,
        signedPath,
      ).pipe(Effect.provide(spawner), Effect.flip, Effect.forkChild);
      yield* Deferred.await(enteredRead);
      yield* TestClock.adjust(Duration.minutes(32));
      const error = yield* Fiber.join(checking);
      assert.equal((error as { step?: string }).step, "notarize");
      assert.equal((error as { code?: string }).code, "timeout");
      assert.equal(calls.length, 1);
      assert.equal(closes, 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("includes spawn in the notarization deadline and interrupts the scoped child", () =>
    Effect.gen(function* () {
      const enteredSpawn = yield* Deferred.make<void>();
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Deferred.succeed(enteredSpawn, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      );
      const checking = yield* CandidateSigning.notarizeAndStapleEffect(
        validSigning,
        signedPath,
      ).pipe(Effect.provide(spawner), Effect.flip, Effect.forkChild);
      yield* Deferred.await(enteredSpawn);
      yield* TestClock.adjust(Duration.minutes(32));
      const error = yield* Fiber.join(checking);
      assert.equal(error.step, "notarize");
      assert.equal(error.code, "timeout");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
