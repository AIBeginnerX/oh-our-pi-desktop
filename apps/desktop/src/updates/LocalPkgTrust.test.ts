import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as EmbeddedPolicy from "./EmbeddedLocalPkgTrustPolicy.ts";
import * as ReleaseBinding from "./LocalPkgReleaseBinding.ts";
import * as Trust from "./LocalPkgTrust.ts";
import type { LocalPkgUpdateError } from "./LocalPkgUpdateError.ts";
import type { StagedPkg } from "./LocalPkgUpdates.ts";

const encoder = new TextEncoder();
const sha1 = (text: string) => NodeCrypto.createHash("sha1").update(text, "utf8").digest("hex");
const syntheticToc = (text: string) =>
  `<xar><extracted-checksum style="sha1">${sha1(text)}</extracted-checksum></xar>`;
const stagedPath = "/private/oop-local-update/stage-test/OoP-0.0.59-arm64-update.pkg";
const staged: StagedPkg = {
  version: "0.0.59",
  size: 100,
  sha256: "a".repeat(64),
  path: stagedPath,
  directory: "/private/oop-local-update/stage-test",
};
const pin = "ab".repeat(32);
const otherPin = "cd".repeat(32);
const policy: Trust.DeveloperIdTrustPolicy = {
  mode: "developer-id",
  teamId: "ABCDE12345",
  leafPins: [pin],
};
const result = (stdout: string, exitCode = 0, stderr = ""): Trust.ToolResult => ({
  stdout,
  stderr,
  exitCode,
});
const hexOctets = (hex: string) => hex.match(/../g)!.join(" ").toUpperCase();

// SYNTHETIC. No signed OOP package or supported-OS positive output was available in E21.
const syntheticPkgutil = (
  leaf = pin,
  extras = "",
  leafName = "Developer ID Installer: OOP (ABCDE12345)",
) =>
  `Package "OoP-0.0.59-arm64-update.pkg":\n` +
  `   Status: signed by a developer certificate issued by Apple for distribution\n` +
  `   Signed with a trusted timestamp on: 2026-10-09 12:00:00 +0000\n` +
  `   Certificate Chain:\n` +
  `    1. ${leafName}\n` +
  `       Expires: 2030-10-09 12:00:00 +0000\n` +
  `       SHA256 Fingerprint:\n` +
  `           ${hexOctets(leaf)}\n` +
  `       ------------------------------------------------------------------------\n` +
  extras;

// SYNTHETIC. Only the strict text shape is being exercised, not macOS acceptance.
const syntheticSpctl = (path = stagedPath, source = "Notarized Developer ID") =>
  `${path}: accepted\nsource=${source}\n`;

const expectFailure = <A, R>(
  effect: Effect.Effect<A, LocalPkgUpdateError, R>,
  reason: string,
  code?: string,
) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect);
    assert.equal(error.reason, reason);
    assert.equal(error.code, code);
    assert.notInclude(String(error.message), stagedPath);
    assert.notInclude(error.code ?? "", stagedPath);
  });

interface FakeOutput {
  readonly stdout?: Stream.Stream<Uint8Array>;
  readonly stderr?: Stream.Stream<Uint8Array>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
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

describe("LocalPkgTrust policy", () => {
  it.effect("decodes only explicit, strict embedded policy shapes", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* Trust.decodeTrustPolicy({ mode: "legacy-unsigned" }), {
        mode: "legacy-unsigned",
      });
      assert.deepEqual(yield* Trust.decodeTrustPolicy(policy), policy);

      for (const raw of [
        undefined,
        {},
        { mode: "legacy-unsigned", leafPins: [pin] },
        { mode: "developer-id", teamId: "ABCDE12345", leafPins: [] },
        { mode: "developer-id", teamId: "ABCDE12345", leafPins: [pin, pin] },
        {
          mode: "developer-id",
          teamId: "ABCDE12345",
          leafPins: [pin, otherPin, "ef".repeat(32), "12".repeat(32)],
        },
        { mode: "developer-id", teamId: "bad-team", leafPins: [pin] },
        { mode: "developer-id", teamId: "ABCDE12345", leafPins: ["z".repeat(64)] },
        { mode: "developer-id", teamId: "ABCDE12345", leafPins: [pin], extra: true },
      ]) {
        yield* expectFailure(Trust.decodeTrustPolicy(raw), "config-invalid");
      }
    }),
  );

  it.effect("keeps developer-id inactive at runtime until signed release binding exists", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* EmbeddedPolicy.loadEmbeddedTrustPolicy, {
        mode: "legacy-unsigned",
      });
      yield* expectFailure(EmbeddedPolicy.loadRuntimeTrustPolicy(policy), "config-invalid");
      yield* expectFailure(
        EmbeddedPolicy.loadRuntimeTrustPolicy({ mode: "developer-id" }),
        "config-invalid",
      );
    }),
  );
});

describe("LocalPkgTrust pkgutil parser", () => {
  it.effect("rejects the real E21 unsigned .58 assessment as no-signature", () =>
    expectFailure(
      Trust.parsePkgutilSignature(
        policy,
        "/Volumes/Shared/MyPJ/OOP_DeskTop/release/macos/OoP-0.0.58-arm64-update.pkg",
        // E21 readiness.json: actual pkgutil stdout and exit, with a basename header.
        result('Package "OoP-0.0.58-arm64-update.pkg":\n   Status: no signature\n', 1),
      ),
      "publisher-untrusted",
      "no-signature",
    ),
  );

  it.effect(
    "accepts only the SYNTHETIC pinned Installer leaf, including a wrapped fingerprint",
    () =>
      Effect.gen(function* () {
        const observed = yield* Trust.parsePkgutilSignature(
          policy,
          stagedPath,
          result(syntheticPkgutil()),
        );
        assert.equal(observed.leafFingerprint, pin);
        assert.equal(observed.teamId, policy.teamId);

        const wrapped = syntheticPkgutil().replace(
          `           ${hexOctets(pin)}\n`,
          `           ${hexOctets(pin.slice(0, 32))}\n           ${hexOctets(pin.slice(32))}\n`,
        );
        assert.equal(
          (yield* Trust.parsePkgutilSignature(policy, stagedPath, result(wrapped))).leafFingerprint,
          pin,
        );
      }),
  );

  it.effect(
    "treats leaf display team, expiry, separator and notarization wording as informational",
    () =>
      Effect.gen(function* () {
        const alternate = syntheticPkgutil(
          pin,
          "",
          "Developer ID Installer: Renamed Publisher (ZZZZZ12345)",
        )
          .replace("       Expires: 2030-10-09 12:00:00 +0000\n", "")
          .replace(
            "       ------------------------------------------------------------------------\n",
            "",
          )
          .replace(
            "   Certificate Chain:\n",
            "   Notarization: an informational value from a newer macOS\n   Certificate Chain:\n",
          );
        const observed = yield* Trust.parsePkgutilSignature(policy, stagedPath, result(alternate));
        assert.equal(observed.leafFingerprint, pin);
        const abbreviatedIntermediate =
          syntheticPkgutil() +
          "    2. Apple Worldwide Developer Relations Certification Authority\n";
        assert.equal(
          (yield* Trust.parsePkgutilSignature(policy, stagedPath, result(abbreviatedIntermediate)))
            .leafFingerprint,
          pin,
        );
      }),
  );

  it.effect("pins item 1 only, even when an intermediate has the approved fingerprint", () =>
    expectFailure(
      Trust.parsePkgutilSignature(
        policy,
        stagedPath,
        result(
          syntheticPkgutil(
            otherPin,
            `    2. Developer ID Certification Authority\n` +
              `       Expires: 2030-10-09 12:00:00 +0000\n` +
              `       SHA256 Fingerprint:\n` +
              `           ${hexOctets(pin)}\n` +
              `       ------------------------------------------------------------------------\n`,
          ),
        ),
      ),
      "publisher-untrusted",
      "pin-mismatch",
    ),
  );

  it.effect("rejects a wrong leaf kind or unpinned leaf", () =>
    Effect.gen(function* () {
      for (const [output, code] of [
        [syntheticPkgutil(pin, "", "Developer ID Application: OOP (ABCDE12345)"), "leaf"],
        [syntheticPkgutil(otherPin), "pin-mismatch"],
      ] as const) {
        yield* expectFailure(
          Trust.parsePkgutilSignature(policy, stagedPath, result(output)),
          "publisher-untrusted",
          code,
        );
      }
    }),
  );

  it.effect("rejects missing or duplicate semantic fields", () =>
    Effect.gen(function* () {
      const good = syntheticPkgutil();
      for (const [output, code] of [
        [good.replace(/   Status:.*\n/, ""), "status"],
        [good.replace(/   Signed with a trusted timestamp on:.*\n/, ""), "timestamp"],
        [good.replace("   Certificate Chain:\n", ""), "leaf"],
        [
          good.replace(
            "   Certificate Chain:\n",
            "   Status: signed by a developer certificate issued by Apple for distribution\n   Certificate Chain:\n",
          ),
          "duplicate",
        ],
        [
          good.replace(
            "   Certificate Chain:\n",
            "   Signed with a trusted timestamp on: 2026-10-09 12:00:00 +0000\n   Certificate Chain:\n",
          ),
          "duplicate",
        ],
        [
          good.replace(
            "       SHA256 Fingerprint:\n",
            "       SHA256 Fingerprint:\n       SHA256 Fingerprint:\n",
          ),
          "duplicate",
        ],
      ] as const) {
        yield* expectFailure(
          Trust.parsePkgutilSignature(policy, stagedPath, result(output)),
          "publisher-untrusted",
          code,
        );
      }
    }),
  );

  it.effect("fails closed for output spoofing, controls, truncation and exit failures", () =>
    Effect.gen(function* () {
      const good = syntheticPkgutil();
      for (const output of [
        good.replace('Package "OoP-0.0.59-arm64-update.pkg":', 'Package "different.pkg":'),
        good.replace("   Status:", "\tStatus:"),
        good.replace("   Status:", "   Sta\u202etus:"),
        good.replace("   Certificate Chain:\n", "   Certificate Chain:\n\n"),
        good.slice(0, -1),
        good + "Status: no signature\n",
        good +
          `    1. Developer ID Certification Authority\n       Expires: 2030-10-09 12:00:00 +0000\n       SHA256 Fingerprint:\n           ${hexOctets(otherPin)}\n       ------------------------------------------------------------------------\n`,
      ]) {
        yield* expectFailure(
          Trust.parsePkgutilSignature(policy, stagedPath, result(output)),
          "trust-check-failed",
          "parse",
        );
      }
      yield* expectFailure(
        Trust.parsePkgutilSignature(policy, stagedPath, result(good, 3)),
        "trust-check-failed",
        "exit-3",
      );
    }),
  );
});

describe("LocalPkgTrust spctl parser", () => {
  it.effect("rejects the real E21 unsigned .58 assessment", () =>
    expectFailure(
      Trust.parseSpctlAssessment(
        "/Volumes/Shared/MyPJ/OOP_DeskTop/release/macos/OoP-0.0.58-arm64-update.pkg",
        // E21 unsigned-assessment-text.json: actual spctl -vv stderr and exit.
        result(
          "",
          3,
          "/Volumes/Shared/MyPJ/OOP_DeskTop/release/macos/OoP-0.0.58-arm64-update.pkg: rejected\nsource=no usable signature\n",
        ),
      ),
      "notarization-unconfirmed",
      "exit-3",
    ),
  );

  it.effect("accepts a SYNTHETIC notarized verdict bound to the staged path", () =>
    Effect.gen(function* () {
      yield* Trust.parseSpctlAssessment(stagedPath, result("", 0, syntheticSpctl()));
      yield* Trust.parseSpctlAssessment(stagedPath, result(syntheticSpctl()));
      const longPath = `/private/${"a".repeat(520)}/OoP-0.0.59-arm64-update.pkg`;
      yield* Trust.parseSpctlAssessment(longPath, result("", 0, syntheticSpctl(longPath)));
    }),
  );

  it.effect("treats the optional origin as informational", () =>
    Trust.parseSpctlAssessment(
      stagedPath,
      result("", 0, syntheticSpctl() + "origin=Different display identity\n"),
    ),
  );

  it.effect("rejects override, wrong source and duplicate fields", () =>
    Effect.gen(function* () {
      for (const [output, reason, code] of [
        [syntheticSpctl() + "override=security disabled\n", "notarization-unconfirmed", "override"],
        [syntheticSpctl(stagedPath, "Developer ID"), "notarization-unconfirmed", "source"],
        [
          syntheticSpctl() + "source=Notarized Developer ID\n",
          "notarization-unconfirmed",
          "duplicate",
        ],
        [
          syntheticSpctl() +
            "origin=Developer ID Installer: OOP (ABCDE12345)\norigin=Developer ID Installer: OOP (ABCDE12345)\n",
          "notarization-unconfirmed",
          "duplicate",
        ],
      ] as const) {
        yield* expectFailure(
          Trust.parseSpctlAssessment(stagedPath, result("", 0, output)),
          reason,
          code,
        );
      }
    }),
  );

  it.effect("rejects accepted text for a different path and malformed stream layout", () =>
    Effect.gen(function* () {
      for (const assessment of [
        syntheticSpctl("/private/other.pkg"),
        syntheticSpctl().replace(": accepted", ": rejected"),
        syntheticSpctl().replace("source=", "\tsource="),
        syntheticSpctl() + "\n",
        syntheticSpctl().slice(0, -1),
      ]) {
        yield* expectFailure(
          Trust.parseSpctlAssessment(stagedPath, result("", 0, assessment)),
          "trust-check-failed",
          "parse",
        );
      }
      yield* expectFailure(
        Trust.parseSpctlAssessment(stagedPath, result("noise", 0, syntheticSpctl())),
        "trust-check-failed",
        "parse",
      );
    }),
  );
});

describe("LocalPkgTrust bounded runner", () => {
  it.effect("uses fixed executable, argv and sanitized process options", () =>
    Effect.gen(function* () {
      const calls: ChildProcess.Command[] = [];
      const spawner = fakeSpawner(calls, () => ({
        stdout: Stream.make(encoder.encode("ok")),
        stderr: Stream.make(encoder.encode("warning")),
      }));
      assert.deepEqual(
        yield* Trust.runTrustTool("pkgutil", stagedPath).pipe(Effect.provide(spawner)),
        {
          exitCode: 0,
          stdout: "ok",
          stderr: "warning",
        },
      );
      yield* Trust.runTrustTool("spctl", stagedPath).pipe(Effect.provide(spawner));
      yield* Trust.runTrustTool("binding-list", stagedPath).pipe(Effect.provide(spawner));
      yield* Trust.runTrustTool("binding-read", stagedPath).pipe(Effect.provide(spawner));
      yield* Trust.runTrustTool("binding-toc", stagedPath).pipe(Effect.provide(spawner));
      assert.equal(calls.length, 5);
      for (const [index, executable, args] of [
        [0, "/usr/sbin/pkgutil", ["--check-signature", stagedPath]],
        [
          1,
          "/usr/sbin/spctl",
          ["--assess", "--type", "install", "--ignore-cache", "--no-cache", "-vv", stagedPath],
        ],
        [2, Trust.TAR_COMMAND, ["-t", "-f", stagedPath, "--", "Distribution"]],
        [3, Trust.TAR_COMMAND, ["-x", "-O", "-f", stagedPath, "--", "Distribution"]],
        [4, Trust.XAR_COMMAND, ["--dump-toc=/dev/stdout", "-f", stagedPath]],
      ] as const) {
        const command = calls[index]!;
        assert.equal(command._tag, "StandardCommand");
        if (command._tag !== "StandardCommand") continue;
        assert.equal(command.command, executable);
        assert.deepEqual(command.args, args);
        assert.deepEqual(command.options.env, {
          LC_ALL: "C",
          LANG: "C",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        });
        assert.equal(command.options.extendEnv, false);
        assert.equal(command.options.stdin, "ignore");
        assert.equal(Duration.toMillis(command.options.forceKillAfter!), 2_000);
      }
    }),
  );

  it.effect("caps stdout and stderr independently in bytes, including multibyte UTF-8", () =>
    Effect.gen(function* () {
      for (const streamName of ["stdout", "stderr"] as const) {
        const calls: ChildProcess.Command[] = [];
        const atLimit = encoder.encode("x".repeat(64 * 1024));
        const accepted = fakeSpawner(calls, () => ({ [streamName]: Stream.make(atLimit) }));
        const output = yield* Trust.runTrustTool("pkgutil", stagedPath).pipe(
          Effect.provide(accepted),
        );
        assert.equal(output[streamName].length, 64 * 1024);

        const tooManyBytes = encoder.encode("é".repeat(32 * 1024 + 1));
        let closes = 0;
        const rejected = fakeSpawner([], () => ({
          [streamName]: Stream.make(tooManyBytes),
          onClose: () => {
            closes += 1;
          },
        }));
        yield* expectFailure(
          Trust.runTrustTool("pkgutil", stagedPath).pipe(Effect.provide(rejected)),
          "trust-check-failed",
          "output-limit",
        );
        assert.equal(closes, 1);
      }
    }),
  );

  it.effect("rejects malformed UTF-8 without exposing native output", () =>
    expectFailure(
      Trust.runTrustTool("pkgutil", stagedPath).pipe(
        Effect.provide(
          fakeSpawner([], () => ({
            stdout: Stream.make(Uint8Array.of(0xc3, 0x28)),
          })),
        ),
      ),
      "trust-check-failed",
      "parse",
    ),
  );

  it.effect("ignores empty stream chunks while preserving the exact output", () =>
    Effect.gen(function* () {
      const output = yield* Trust.runTrustTool("pkgutil", stagedPath).pipe(
        Effect.provide(
          fakeSpawner([], () => ({
            stdout: Stream.make(new Uint8Array(0), encoder.encode("ok"), new Uint8Array(0)),
          })),
        ),
      );
      assert.equal(output.stdout, "ok");
    }),
  );

  it.effect("applies one 30-second deadline to stalled reads and closes the child scope", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let closes = 0;
      const spawner = fakeSpawner([], () => ({
        stdout: Stream.fromEffect(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(encoder.encode("late")),
          ),
        ),
        exitCode: Deferred.await(release).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
        onClose: () => {
          closes += 1;
        },
      }));
      const checking = yield* Trust.runTrustTool("pkgutil", stagedPath).pipe(
        Effect.provide(spawner),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(Duration.seconds(30));
      const error = yield* Fiber.join(checking);
      assert.equal(error.reason, "trust-check-failed");
      assert.equal(error.code, "timeout");
      assert.equal(closes, 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("starts the same deadline before spawn returns", () =>
    Effect.gen(function* () {
      const enteredSpawn = yield* Deferred.make<void>();
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Deferred.succeed(enteredSpawn, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      );
      const checking = yield* Trust.runTrustTool("pkgutil", stagedPath).pipe(
        Effect.provide(spawner),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(enteredSpawn);
      yield* TestClock.adjust(Duration.seconds(30));
      const error = yield* Fiber.join(checking);
      assert.equal(error.reason, "trust-check-failed");
      assert.equal(error.code, "timeout");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("includes a stalled process exit in the 30-second deadline", () =>
    Effect.gen(function* () {
      const enteredExit = yield* Deferred.make<void>();
      const exitGate = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      let closes = 0;
      const spawner = fakeSpawner([], () => ({
        exitCode: Deferred.succeed(enteredExit, undefined).pipe(
          Effect.andThen(Deferred.await(exitGate)),
        ),
        onClose: () => {
          closes += 1;
        },
      }));
      const checking = yield* Trust.runTrustTool("pkgutil", stagedPath).pipe(
        Effect.provide(spawner),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(enteredExit);
      yield* TestClock.adjust(Duration.seconds(30));
      const error = yield* Fiber.join(checking);
      assert.equal(error.reason, "trust-check-failed");
      assert.equal(error.code, "timeout");
      assert.equal(closes, 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("closes the child scope on interruption", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const never = yield* Deferred.make<void>();
      let closes = 0;
      const spawner = fakeSpawner([], () => ({
        stdout: Stream.fromEffect(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(never)),
            Effect.as(encoder.encode("late")),
          ),
        ),
        exitCode: Deferred.await(never).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
        onClose: () => {
          closes += 1;
        },
      }));
      const checking = yield* Trust.runTrustTool("pkgutil", stagedPath).pipe(
        Effect.provide(spawner),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(checking);
      assert.equal(closes, 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("LocalPkgTrust verifyPublisher", () => {
  it.effect("never spawns under the legacy policy", () =>
    Trust.verifyPublisher(Trust.LEGACY_UNSIGNED_POLICY, staged).pipe(
      Effect.provide(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die(new Error("legacy trust spawned a tool"))),
        ),
      ),
    ),
  );

  it.effect("runs pkgutil before spctl and stops at the first failed trust decision", () =>
    Effect.gen(function* () {
      const calls: ChildProcess.Command[] = [];
      const successful = fakeSpawner(calls, (command) => ({
        stdout:
          command._tag === "StandardCommand" && command.command === Trust.PKGUTIL_COMMAND
            ? Stream.make(encoder.encode(syntheticPkgutil()))
            : Stream.empty,
        stderr:
          command._tag === "StandardCommand" && command.command === Trust.SPCTL_COMMAND
            ? Stream.make(encoder.encode(syntheticSpctl()))
            : Stream.empty,
      }));
      yield* Trust.verifyPublisher(policy, staged).pipe(Effect.provide(successful));
      assert.deepEqual(
        calls.map((command) => (command._tag === "StandardCommand" ? command.command : "pipeline")),
        [Trust.PKGUTIL_COMMAND, Trust.SPCTL_COMMAND],
      );

      const rejectedCalls: ChildProcess.Command[] = [];
      const unsigned = fakeSpawner(rejectedCalls, () => ({
        stdout: Stream.make(
          encoder.encode('Package "OoP-0.0.59-arm64-update.pkg":\n   Status: no signature\n'),
        ),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
      }));
      yield* expectFailure(
        Trust.verifyPublisher(policy, staged).pipe(Effect.provide(unsigned)),
        "publisher-untrusted",
        "no-signature",
      );
      assert.equal(rejectedCalls.length, 1);
    }),
  );

  it.effect("refuses hostile staged paths before invoking either tool", () =>
    Effect.gen(function* () {
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die(new Error("hostile path reached a tool"))),
      );
      for (const path of [
        `${stagedPath}\nsource=Notarized Developer ID`,
        `${stagedPath}"`,
        `/private/oop-local-update/../stage-test/OoP-0.0.59-arm64-update.pkg`,
        "/private/oop-local-update/stage-test/wrong.pkg",
      ]) {
        yield* expectFailure(
          Trust.verifyPublisher(policy, { ...staged, path }).pipe(Effect.provide(spawner)),
          "staged-changed",
        );
      }
    }),
  );
});

describe("LocalPkgTrust verifyBinding", () => {
  const distribution = (version: string) =>
    `<installer><title>OOP</title>${ReleaseBinding.releaseProductElement(version)}</installer>`;

  const bindingSpawner = (
    calls: ChildProcess.Command[],
    options: {
      readonly list?: string;
      readonly read?: string;
      readonly listExit?: number;
      readonly readExit?: number;
      readonly listStderr?: string;
      readonly readStderr?: string;
      readonly toc?: string;
      readonly tocExit?: number;
      readonly tocStderr?: string;
    } = {},
  ) =>
    fakeSpawner(calls, (command) => {
      const listing = command._tag === "StandardCommand" && command.args[0] === "-t";
      const reading = command._tag === "StandardCommand" && command.args[0] === "-x";
      const read = options.read ?? distribution("0.0.59");
      const toc = options.toc ?? syntheticToc(read);
      return {
        stdout: Stream.make(
          encoder.encode(listing ? (options.list ?? "Distribution\n") : reading ? read : toc),
        ),
        stderr: Stream.make(
          encoder.encode(
            listing
              ? (options.listStderr ?? "")
              : reading
                ? (options.readStderr ?? "")
                : (options.tocStderr ?? ""),
          ),
        ),
        exitCode: Effect.succeed(
          ChildProcessSpawner.ExitCode(
            listing
              ? (options.listExit ?? 0)
              : reading
                ? (options.readExit ?? 0)
                : (options.tocExit ?? 0),
          ),
        ),
      };
    });

  it.effect("reads the exact Distribution entry and accepts its matching product version", () =>
    Effect.gen(function* () {
      const calls: ChildProcess.Command[] = [];
      yield* Trust.verifyBinding(staged, "0.0.58").pipe(Effect.provide(bindingSpawner(calls)));
      assert.equal(calls.length, 3);
      assert.deepEqual(
        calls.map((command) => (command._tag === "StandardCommand" ? command.args : [])),
        [
          ["-t", "-f", stagedPath, "--", "Distribution"],
          ["-x", "-O", "-f", stagedPath, "--", "Distribution"],
          ["--dump-toc=/dev/stdout", "-f", stagedPath],
        ],
      );
      assert.deepEqual(
        calls.map((command) => (command._tag === "StandardCommand" ? command.command : "")),
        [Trust.TAR_COMMAND, Trust.TAR_COMMAND, Trust.XAR_COMMAND],
      );
    }),
  );

  it.effect("rejects unexpected listing and extraction results as entry failures", () =>
    Effect.gen(function* () {
      const entryCases = [
        { list: "" },
        { list: "Distribution\nDistribution\n" },
        { list: "Distribution\nResources\n" },
        { listStderr: "warning" },
        { listExit: 1 },
        { readExit: 1 },
        { readStderr: "warning" },
      ];
      for (const options of entryCases) {
        const calls: ChildProcess.Command[] = [];
        yield* expectFailure(
          Trust.verifyBinding(staged, "0.0.58").pipe(
            Effect.provide(bindingSpawner(calls, options)),
          ),
          "binding-failed",
          "entry",
        );
        if ("list" in options || "listExit" in options || "listStderr" in options) {
          assert.equal(
            calls.length,
            1,
            "a failed listing must stop before read and TOC inspection",
          );
        }
      }
    }),
  );

  it.effect("requires the extracted bytes to match a signed SHA-1 TOC entry", () =>
    Effect.gen(function* () {
      const good = distribution("0.0.59");
      const read = good;
      const digest = sha1(read);
      const invalidTocs = [
        `<extracted-checksum style="sha256">${"a".repeat(64)}</extracted-checksum>`,
        `<extracted-checksum style="sha512">${"a".repeat(128)}</extracted-checksum>`,
        `<archived-checksum style="sha1">${digest}</archived-checksum>`,
        `<extracted-checksum style="sha1">${digest.toUpperCase()}</extracted-checksum>`,
        `<extracted-checksum style="sha1"> ${digest}</extracted-checksum>`,
        `<extracted-checksum style="sha1" extra="x">${digest}</extracted-checksum>`,
        "",
      ];
      for (const toc of invalidTocs) {
        yield* expectFailure(
          Trust.verifyBinding(staged, "0.0.58").pipe(
            Effect.provide(bindingSpawner([], { read, toc })),
          ),
          "binding-failed",
          "checksum",
        );
      }

      for (const options of [
        { toc: syntheticToc(read), tocExit: 1 },
        { toc: syntheticToc(read), tocStderr: "warning" },
      ]) {
        yield* expectFailure(
          Trust.verifyBinding(staged, "0.0.58").pipe(Effect.provide(bindingSpawner([], options))),
          "binding-failed",
          "checksum",
        );
      }
    }),
  );

  it.effect(
    "rejects successful tar output for .59 when the signed TOC contains the .57 bytes",
    () =>
      Effect.gen(function* () {
        const calls: ChildProcess.Command[] = [];
        yield* expectFailure(
          Trust.verifyBinding(staged, "0.0.58").pipe(
            Effect.provide(
              bindingSpawner(calls, {
                read: distribution("0.0.59"),
                toc: syntheticToc(distribution("0.0.57")),
              }),
            ),
          ),
          "binding-failed",
          "checksum",
        );
        assert.equal(calls.length, 3);
        assert.deepEqual(
          calls.map((command) => (command._tag === "StandardCommand" ? command.command : "")),
          [Trust.TAR_COMMAND, Trust.TAR_COMMAND, Trust.XAR_COMMAND],
        );
      }),
  );

  it.effect("maps an oversized TOC to the bounded runner output-limit failure", () =>
    expectFailure(
      Trust.verifyBinding(staged, "0.0.58").pipe(
        Effect.provide(bindingSpawner([], { toc: "x".repeat(64 * 1024 + 1) })),
      ),
      "trust-check-failed",
      "output-limit",
    ),
  );

  it.effect("rejects absent, stale, duplicate, or altered release product elements", () =>
    Effect.gen(function* () {
      const valid = ReleaseBinding.releaseProductElement("0.0.59");
      const mismatches = [
        "<installer><title>OOP</title></installer>",
        distribution("0.0.58"),
        `<installer>${valid}${valid}</installer>`,
        '<installer><product id="other" version="0.0.59"/></installer>',
        '<installer><product version="0.0.59" id="oop-desktop"/></installer>',
        '<installer><product id="oop-desktop" version="0.0.59" /></installer>',
        "",
      ];
      for (const read of mismatches) {
        yield* expectFailure(
          Trust.verifyBinding(staged, "0.0.58").pipe(Effect.provide(bindingSpawner([], { read }))),
          "binding-failed",
          "mismatch",
        );
      }
    }),
  );

  it.effect("rejects unsafe or non-newer versions and hostile paths before spawning", () =>
    Effect.gen(function* () {
      const neverSpawn = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die(new Error("invalid binding input reached tar"))),
      );
      for (const [candidate, installed] of [
        [staged, "0.0.59"],
        [{ ...staged, version: "0.0.58" }, "0.0.59"],
        [{ ...staged, version: "0.0.60-preview.1" }, "0.0.59"],
        [staged, "0.0.59-preview.1"],
        [staged, "latest"],
      ] as const) {
        yield* expectFailure(
          Trust.verifyBinding(candidate, installed).pipe(Effect.provide(neverSpawn)),
          "binding-failed",
          "version",
        );
      }
      yield* expectFailure(
        Trust.verifyBinding({ ...staged, path: `${stagedPath}.other` }, "0.0.58").pipe(
          Effect.provide(neverSpawn),
        ),
        "staged-changed",
      );
    }),
  );

  it.effect("maps a stalled xar TOC dump to a bounded timeout failure", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const read = distribution("0.0.59");
      const spawner = fakeSpawner([], (command) => {
        if (command._tag === "StandardCommand" && command.command === Trust.XAR_COMMAND) {
          return {
            stdout: Stream.fromEffect(
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(encoder.encode(syntheticToc(read))),
              ),
            ),
            exitCode: Deferred.await(release).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
          };
        }
        const listing = command._tag === "StandardCommand" && command.args[0] === "-t";
        return {
          stdout: Stream.make(encoder.encode(listing ? "Distribution\n" : read)),
        };
      });
      const checking = yield* Trust.verifyBinding(staged, "0.0.58").pipe(
        Effect.provide(spawner),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(Duration.seconds(30));
      const error = yield* Fiber.join(checking);
      assert.equal(error.reason, "trust-check-failed");
      assert.equal(error.code, "timeout");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
