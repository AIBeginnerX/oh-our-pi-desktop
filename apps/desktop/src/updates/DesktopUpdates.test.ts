// @effect-diagnostics nodeBuiltinImport:off -- Local-package tests tamper with real staged files.
import { assert, describe, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import * as EmbeddedLocalPkgTrustPolicy from "./EmbeddedLocalPkgTrustPolicy.ts";
import * as LocalPkgTrust from "./LocalPkgTrust.ts";
import * as LocalPkgUpdateError from "./LocalPkgUpdateError.ts";
import {
  flushCallbacks,
  makeHarness,
  makeLocalPackageFixture,
  type LocalPackageFixture,
  type UpdatesHarnessOptions,
} from "./updatesTestHarness.ts";

describe("DesktopUpdates", () => {
  it("preserves complete causes for update poller and event failures", () => {
    const cause = Cause.combine(
      Cause.fail(new Error("updater failed")),
      Cause.die(new Error("updater defect")),
    );
    const pollerError = new DesktopUpdates.DesktopUpdatePollerError({
      poller: "startup",
      cause,
    });
    const eventError = new DesktopUpdates.DesktopUpdateEventHandlingError({
      event: "download-progress",
      cause,
    });
    const reportedError = new DesktopUpdates.DesktopUpdaterReportedError({
      operation: "download",
      cause,
    });
    const unexpectedActionError = new DesktopUpdates.DesktopUpdateUnexpectedActionError({
      action: "install",
      cause,
    });

    assert.strictEqual(pollerError.cause, cause);
    assert.equal(pollerError.poller, "startup");
    assert.equal(pollerError.message, "Desktop update startup poller failed.");
    assert.strictEqual(eventError.cause, cause);
    assert.equal(eventError.event, "download-progress");
    assert.equal(eventError.message, "Failed to handle desktop update download-progress event.");
    assert.strictEqual(reportedError.cause, cause);
    assert.equal(reportedError.operation, "download");
    assert.equal(reportedError.message, "Desktop updater download operation reported an error.");
    assert.strictEqual(unexpectedActionError.cause, cause);
    assert.equal(unexpectedActionError.action, "install");
    assert.equal(
      unexpectedActionError.message,
      "Desktop update install action failed unexpectedly.",
    );
  });

  it.effect("configures the updater and runs startup checks on the test clock", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const state = yield* updates.getState;
          assert.equal(state.enabled, true);
          assert.equal(state.status, "idle");
          assert.deepEqual(harness.feedUrls(), [
            { provider: "generic", url: "http://localhost:4141" },
          ]);
          assert.equal(harness.listenerCount(), 6);
          assert.equal(harness.checkCount(), 0);

          yield* TestClock.adjust(Duration.millis(15_000));
          assert.equal(harness.checkCount(), 1);
        }),
      );

      assert.equal(harness.listenerCount(), 0);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("updates Linux .deb installs and leaves other non-AppImage installs off", () =>
    Effect.gen(function* () {
      const linuxState = (packageType: string | undefined) =>
        Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            return yield* updates.getState;
          }),
        ).pipe(Effect.provide(makeHarness({ platform: "linux", packageType }).layer));

      const deb = yield* linuxState("deb\n");
      assert.equal(deb.status, "idle");

      const unmarked = yield* linuxState(undefined);
      assert.equal(unmarked.status, "disabled");
    }),
  );

  it.effect("subscribe delivers the latest state plus subsequent changes", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const { latest, changes } = yield* updates.subscribe;
        assert.equal(latest.status, "idle");

        const nextState = yield* Stream.runHead(changes).pipe(Effect.forkChild);
        yield* flushCallbacks;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const observed = yield* Fiber.join(nextState);
        assert.equal(Option.getOrThrow(observed).status, "available");
        assert.equal(Option.getOrThrow(observed).availableVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("updates and broadcasts state from updater events", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.4");
        assert.isNotNull(state.checkedAt);
        assert.equal(harness.sentStates.at(-1)?.status, "available");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("enables nightly full changelog release notes and broadcasts summaries", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.setChannel("nightly");
        assert.equal(harness.fullChangelog(), true);

        harness.emit("update-available", {
          version: "1.2.4-nightly.20260709.766",
          releaseNotes: [
            {
              version: "1.2.4-nightly.20260709.766",
              note: `<h2>What's Changed</h2><ul><li>feat(client): persist offline environment data by <a>@juliusmarminge</a> in <a>#3795</a></li></ul><h2>Full Changelog</h2>`,
            },
            {
              version: "1.2.4-nightly.20260709.765",
              note: "- [codex] Upgrade Clerk stack by @juliusmarminge in #3821",
            },
            { version: "1.2.4-nightly.20260709.764", note: "- Change 764" },
            { version: "1.2.4-nightly.20260709.763", note: "- Change 763" },
            { version: "1.2.4-nightly.20260709.762", note: "- Change 762" },
            { version: "1.2.4-nightly.20260709.761", note: "- Change 761" },
            { version: "1.2.4-nightly.20260709.760", note: "- Change 760" },
          ],
        });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.deepEqual(state.releaseNotes, [
          {
            version: "1.2.4-nightly.20260709.766",
            items: ["feat(client): persist offline environment data by @juliusmarminge in #3795"],
            totalItems: 1,
          },
          {
            version: "1.2.4-nightly.20260709.765",
            items: ["[codex] Upgrade Clerk stack by @juliusmarminge in #3821"],
            totalItems: 1,
          },
          { version: "1.2.4-nightly.20260709.764", items: ["Change 764"], totalItems: 1 },
          { version: "1.2.4-nightly.20260709.763", items: ["Change 763"], totalItems: 1 },
          { version: "1.2.4-nightly.20260709.762", items: ["Change 762"], totalItems: 1 },
          { version: "1.2.4-nightly.20260709.761", items: ["Change 761"], totalItems: 1 },
        ]);
        assert.equal(state.omittedReleaseCount, 1);
        assert.deepEqual(harness.sentStates.at(-1)?.releaseNotes, state.releaseNotes);
        assert.equal(harness.sentStates.at(-1)?.omittedReleaseCount, 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("checks for newer releases after an update has been downloaded", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: queued update",
        });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.check("poll");
        assert.isTrue(result.checked);

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const unchangedState = yield* updates.getState;
        assert.equal(unchangedState.status, "downloaded");
        assert.equal(unchangedState.downloadedVersion, "1.2.4");
        assert.deepEqual(unchangedState.releaseNotes, [
          { version: "1.2.4", items: ["fix: queued update"], totalItems: 1 },
        ]);
        assert.equal(unchangedState.omittedReleaseCount, 0);

        const nextResult = yield* updates.check("poll");
        assert.isTrue(nextResult.checked);

        harness.emit("update-available", { version: "1.2.5" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.5");
        assert.isNull(state.downloadedVersion);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("preserves a queued installer when the feed has no update", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: queued update",
        });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.check("poll");
        harness.emit("update-not-available");
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.availableVersion, "1.2.4");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.deepEqual(state.releaseNotes, [
          { version: "1.2.4", items: ["fix: queued update"], totalItems: 1 },
        ]);
        assert.equal(state.omittedReleaseCount, 0);
        assert.equal(state.downloadPercent, 100);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("preserves a queued installer when the feed offers another channel", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: queued update",
        });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.check("poll");
        harness.emit("update-available", { version: "1.2.5-nightly.20260710.1" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.availableVersion, "1.2.4");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.deepEqual(state.releaseNotes, [
          { version: "1.2.4", items: ["fix: queued update"], totalItems: 1 },
        ]);
        assert.equal(state.omittedReleaseCount, 0);
        assert.equal(state.downloadPercent, 100);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect(
    "rejects install while a refresh check is in progress and releases the reservation",
    () =>
      Effect.gen(function* () {
        const checkStarted = yield* Deferred.make<void>();
        const releaseCheck = yield* Deferred.make<void>();
        const harness = makeHarness({
          checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCheck)),
          ),
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            harness.emit("update-downloaded", { version: "1.2.4" });
            yield* flushCallbacks;

            const checkFiber = yield* updates.check("manual").pipe(Effect.forkScoped);
            yield* Deferred.await(checkStarted);

            const installResult = yield* updates.install;
            assert.isFalse(installResult.accepted);

            yield* Deferred.succeed(releaseCheck, undefined);
            const checkResult = yield* Fiber.join(checkFiber);
            assert.isTrue(checkResult.checked);

            const followUpCheck = yield* updates.check("manual");
            assert.isTrue(followUpCheck.checked);
            assert.equal(harness.checkCount(), 2);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }),
  );

  it.effect("rejects refresh checks while install is in progress", () =>
    Effect.gen(function* () {
      const installStarted = yield* Deferred.make<void>();
      const releaseInstall = yield* Deferred.make<void>();
      const harness = makeHarness({
        stopBackend: Deferred.succeed(installStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseInstall)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const installFiber = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(installStarted);

          const checkResult = yield* updates.check("manual");
          assert.isFalse(checkResult.checked);
          assert.equal(harness.checkCount(), 0);

          yield* Deferred.succeed(releaseInstall, undefined);
          const installResult = yield* Fiber.join(installFiber);
          assert.isTrue(installResult.accepted);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("keeps raw updater event failures out of update state", () => {
    const harness = makeHarness();
    const cause = new Error(
      "request failed for https://user:secret@example.com/update?token=secret",
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("error", cause);
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "error");
        assert.equal(state.message, "Desktop updater background operation reported an error.");
        assert.notInclude(state.message ?? "", "secret");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("preserves a queued installer after a background updater error", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        harness.emit("error", new Error("background updater failure"));
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "error");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.isNull(state.errorContext);

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("logs bounded updater failure context without exposing the cause", () => {
    const cause = new Error(
      "request failed for https://user:secret@example.com/update?token=secret",
    );
    const updaterError = new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
      channel: null,
      cause,
    });
    const harness = makeHarness({ checkForUpdates: Effect.fail(updaterError) });
    const loggedAnnotations: Array<Record<string, unknown>> = [];
    const logger = Logger.make(({ fiber }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);
      if (annotations.errorTag === "ElectronUpdaterCheckForUpdatesError") {
        loggedAnnotations.push(annotations);
      }
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.check("manual");

        const state = yield* updates.getState;
        const loggedAnnotation = loggedAnnotations.at(-1);
        assert.isDefined(loggedAnnotation);
        assert.equal(loggedAnnotation.errorTag, "ElectronUpdaterCheckForUpdatesError");
        assert.isNull(loggedAnnotation.channel);
        assert.notProperty(loggedAnnotation, "error");
        assert.notInclude(Object.values(loggedAnnotation).map(String).join(" "), "secret");
        assert.equal(
          state.message,
          "Electron updater failed to check for updates on channel default.",
        );
        assert.notInclude(state.message ?? "", "secret");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestClock.layer(),
          harness.layer,
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("recovers download state after an unexpected setup failure", () => {
    let disableDifferentialCalls = 0;
    const harness = makeHarness({
      setDisableDifferentialDownload: Effect.suspend(() => {
        disableDifferentialCalls += 1;
        return disableDifferentialCalls === 1
          ? Effect.void
          : Effect.die(new Error("download setup failed"));
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.download;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "available");
        assert.equal(failedState.errorContext, "download");
        assert.equal(failedState.message, "Desktop update download action failed unexpectedly.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("restores download state and permits retry after interruption", () =>
    Effect.gen(function* () {
      const actionStarted = yield* Deferred.make<void>();
      let disableDifferentialCalls = 0;
      const harness = makeHarness({
        setDisableDifferentialDownload: Effect.suspend(() => {
          disableDifferentialCalls += 1;
          if (disableDifferentialCalls === 1) {
            return Effect.void;
          }
          if (disableDifferentialCalls === 2) {
            return Deferred.succeed(actionStarted, undefined).pipe(Effect.andThen(Effect.never));
          }
          return Effect.void;
        }),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;

          const downloadFiber = yield* updates.download.pipe(Effect.forkScoped);
          yield* Deferred.await(actionStarted);
          yield* Fiber.interrupt(downloadFiber);

          const interruptedState = yield* updates.getState;
          assert.equal(interruptedState.status, "available");
          assert.isNull(interruptedState.message);

          const retry = yield* updates.download;
          assert.isTrue(retry.accepted);
          assert.isTrue(retry.completed);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("clears quitting state after an unexpected install setup failure", () => {
    const harness = makeHarness({
      stopBackend: Effect.die(new Error("backend stop failed")),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);
        assert.isFalse(yield* Ref.get(desktopState.quitting));

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "downloaded");
        assert.equal(failedState.errorContext, "install");
        assert.equal(failedState.message, "Desktop update install action failed unexpectedly.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("marks the backend stop for an install as an update restart", () => {
    let markersAtStop: ReadonlyArray<string> = [];
    const harness = makeHarness({
      stopBackend: Effect.sync(() => {
        markersAtStop = [...harness.updateRestartMarkers];
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.isTrue((yield* updates.install).accepted);
        assert.deepEqual(markersAtStop, [
          environment.path.join(environment.baseDir, "runtime", DESKTOP_UPDATE_RESTART_MARKER_FILE),
        ]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("drops the update restart marker when an install is interrupted", () =>
    Effect.gen(function* () {
      const stopping = yield* Deferred.make<void>();
      const harness = makeHarness({
        stopBackend: Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Effect.never)),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const installFiber = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(stopping);
          assert.equal(harness.updateRestartMarkers.size, 1);

          yield* Fiber.interrupt(installFiber);
          assert.equal(harness.updateRestartMarkers.size, 0);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("keeps windows and restarts backends when quitAndInstall fails", () => {
    const harness = makeHarness({
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);
        // The restarted old backend must release its tunnel on a later quit.
        assert.equal(harness.updateRestartMarkers.size, 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("holds the install reservation until failed-install recovery finishes", () => {
    const recoveryStarted = Deferred.makeUnsafe<void>();
    const releaseRecovery = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
      startBackend: Deferred.succeed(recoveryStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRecovery)),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const failedInstall = yield* updates.install.pipe(Effect.forkChild);
        yield* Deferred.await(recoveryStarted);
        assert.isFalse(yield* updates.isInstallActive);

        const overlappingInstall = yield* updates.install;
        assert.isFalse(overlappingInstall.accepted);
        assert.equal(harness.quitAndInstalls(), 1);
        harness.emit("error", new Error("duplicate native installer error"));
        yield* flushCallbacks;
        assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);

        yield* Deferred.succeed(releaseRecovery, undefined);
        const failedResult = yield* Fiber.join(failedInstall);
        assert.equal(failedResult.state.errorContext, "install");

        const retry = yield* updates.install;
        assert.isTrue(retry.accepted);
        assert.equal(harness.quitAndInstalls(), 2);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("recovers when quitAndInstall reports failure through an updater event", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.install;
        assert.deepEqual(harness.installSteps, ["quitAndInstall"]);
        harness.emit("error", new Error("native installer refused"));
        yield* flushCallbacks;

        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);
        assert.equal((yield* updates.getState).errorContext, "install");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("rejects a prepared install when the downloaded version changed", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.5" });
        yield* flushCallbacks;

        const result = yield* updates.installPrepared("1.2.4");
        assert.isFalse(result.accepted);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("persists channel changes through the settings service", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("nightly");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "nightly");
        assert.equal(persistedSettings.updateChannel, "nightly");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, true);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not persist an unchanged update channel as a user preference", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("latest");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "latest");
        assert.equal(persistedSettings.updateChannel, "latest");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, false);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("fails channel changes with a typed error while a check is in progress", () =>
    Effect.gen(function* () {
      const checkStarted = yield* Deferred.make<void>();
      const releaseCheck = yield* Deferred.make<void>();
      const harness = makeHarness({
        checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCheck)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const checkFiber = yield* updates.check("manual").pipe(Effect.forkScoped);
          yield* Deferred.await(checkStarted);

          const exit = yield* Effect.exit(updates.setChannel("nightly"));
          assert.equal(exit._tag, "Failure");
          if (exit._tag === "Failure") {
            const error = Cause.squash(exit.cause);
            assert.instanceOf(error, DesktopUpdates.DesktopUpdateActionInProgressError);
            assert.equal(error.action, "check");
            assert.equal(error.requestedChannel, "nightly");
          }

          yield* Deferred.succeed(releaseCheck, undefined);
          yield* Fiber.join(checkFiber);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("rejects checks while an update channel change is being persisted", () =>
    Effect.gen(function* () {
      const channelChangeStarted = yield* Deferred.make<void>();
      const releaseChannelChange = yield* Deferred.make<void>();
      const harness = makeHarness({
        beforeSetUpdateChannel: Deferred.succeed(channelChangeStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseChannelChange)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const channelFiber = yield* updates.setChannel("nightly").pipe(Effect.forkScoped);
          yield* Deferred.await(channelChangeStarted);

          const checkResult = yield* updates.check("manual");
          assert.isFalse(checkResult.checked);
          assert.equal(harness.checkCount(), 0);

          yield* Deferred.succeed(releaseChannelChange, undefined);
          const state = yield* Fiber.join(channelFiber);

          assert.equal(state.channel, "nightly");
          assert.equal(harness.checkCount(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("preserves settings failure context when an update channel cannot be persisted", () => {
    const diskFailure = new Error("disk exploded");
    const settingsFailure = new DesktopAppSettings.DesktopSettingsWriteError({
      operation: "replace-settings-file",
      path: "/tmp/settings.json",
      cause: diskFailure,
    });
    const harness = makeHarness({ setUpdateChannelError: settingsFailure });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const error = yield* updates.setChannel("nightly").pipe(Effect.flip);

        assert.instanceOf(error, DesktopUpdates.DesktopUpdateChannelPersistenceError);
        assert.equal(error.channel, "nightly");
        assert.strictEqual(error.cause, settingsFailure);
        assert.strictEqual(error.cause.cause, diskFailure);
        assert.equal(error.message, "Failed to persist the nightly desktop update channel.");
        assert.notInclude(error.message, diskFailure.message);

        const checkResult = yield* updates.check("manual");
        assert.isTrue(checkResult.checked);
        assert.equal(harness.checkCount(), 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("leaves installMode off for the upstream flow", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.getState;
        assert.equal(state.status, "idle");
        assert.isFalse("installMode" in state);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});

/**
 * Runs `body` against an updater configured as packaged OOP on arm64 macOS:
 * a real update folder, resources directory and user data directory, with
 * `/usr/bin/open` and `xattr` faked.
 */
const runLocalPackage = <E>(
  body: (context: {
    readonly fixture: LocalPackageFixture;
    readonly harness: ReturnType<typeof makeHarness>;
    readonly updates: DesktopUpdates.DesktopUpdates["Service"];
  }) => Effect.Effect<
    void,
    E,
    DesktopState.DesktopState | DesktopEnvironment.DesktopEnvironment | Scope.Scope
  >,
  options: {
    /** The bundled config, or a function of the fixture when it names the fixture's folders. */
    readonly config?: string | ((fixture: LocalPackageFixture) => string);
    readonly writeConfig?: boolean;
    readonly harness?: UpdatesHarnessOptions;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeLocalPackageFixture;
      if (options.writeConfig !== false) {
        const config =
          typeof options.config === "function" ? options.config(fixture) : options.config;
        yield* Effect.promise(() => fixture.writeConfig(config));
      }
      const harness = makeHarness({ ...options.harness, local: fixture });
      yield* Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* body({ fixture, harness, updates });
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

const encodeFeed = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const installerCommands = (harness: ReturnType<typeof makeHarness>) =>
  harness.commands.filter((command) => command.command === "/usr/bin/open");
const trustCommands = (harness: ReturnType<typeof makeHarness>) =>
  harness.commands.filter(
    (command) => command.command === "/usr/sbin/pkgutil" || command.command === "/usr/sbin/spctl",
  );
const TEST_PIN = "a".repeat(64);
type TrustRuntime = Context.Service.Shape<typeof EmbeddedLocalPkgTrustPolicy.LocalPkgTrustRuntime>;
const testTrustRuntime = (
  verifyPublisher: TrustRuntime["verifyPublisher"],
  verifyBinding: TrustRuntime["verifyBinding"] = () => Effect.succeed(undefined),
): TrustRuntime => ({
  loadPolicy: Effect.succeed({
    mode: "developer-id" as const,
    teamId: "ABCDE12345",
    leafPins: [TEST_PIN],
  }),
  verifyPublisher,
  verifyBinding,
});
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("DesktopUpdates local package mode", () => {
  it.effect("is off for a build that is not OOP, even with a config file present", () =>
    runLocalPackage(
      ({ harness, updates }) =>
        Effect.gen(function* () {
          const state = yield* updates.getState;
          assert.isFalse("installMode" in state);
          assert.deepEqual(harness.feedUrls(), [
            { provider: "generic", url: "http://localhost:4141" },
          ]);
          assert.equal(harness.listenerCount(), 6);
        }),
      { harness: { buildProfileName: "" } },
    ),
  );

  it.effect("uses local updates under the OOP display name without polling electron-updater", () =>
    runLocalPackage(({ harness, updates }) =>
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        assert.equal(environment.branding.baseName, "OOP");
        assert.deepEqual(environment.buildProfileName, Option.some("oop-desktop"));
        const state = yield* updates.getState;
        assert.equal(state.installMode, "local-package");
        assert.equal(state.status, "idle");
        assert.isTrue(state.enabled);
        assert.deepEqual(harness.feedUrls(), []);
        assert.equal(harness.listenerCount(), 0);

        yield* TestClock.adjust(Duration.hours(1));
        assert.equal(harness.checkCount(), 0);

        // Channels select an upstream feed, so changing one is a no-op here.
        const afterChannel = yield* updates.setChannel("nightly");
        assert.equal(afterChannel.channel, state.channel);
        assert.isFalse(harness.fullChangelog());
        assert.equal(harness.checkCount(), 0);
      }),
    ),
  );

  it.effect("polls the local folder on startup and on the interval without being asked", () =>
    runLocalPackage(({ fixture, harness, updates }) =>
      Effect.gen(function* () {
        const { changes } = yield* updates.subscribe;
        const availableVersion = (version: string) =>
          changes.pipe(
            Stream.filter(
              (state) => state.status === "available" && state.availableVersion === version,
            ),
            Stream.runHead,
            Effect.forkChild,
          );

        // The harness app is 1.2.3.
        yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
        const startup = yield* availableVersion("1.2.4");
        yield* flushCallbacks;
        yield* TestClock.adjust(Duration.seconds(15));
        assert.isTrue(Option.isSome(yield* Fiber.join(startup)));

        yield* Effect.promise(() => fixture.publish({ version: "1.2.5" }));
        const polled = yield* availableVersion("1.2.5");
        yield* flushCallbacks;
        yield* TestClock.adjust(Duration.minutes(4));
        assert.isTrue(Option.isSome(yield* Fiber.join(polled)));
        assert.equal(harness.checkCount(), 0);
      }),
    ),
  );

  it.effect("offers only a strictly newer folder version", () =>
    runLocalPackage(({ fixture, harness, updates }) =>
      Effect.gen(function* () {
        // The harness app is 1.2.3.
        yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
        const newer = yield* updates.check("manual");
        assert.isTrue(newer.checked);
        assert.equal(newer.state.status, "available");
        assert.equal(newer.state.availableVersion, "1.2.4");
        assert.deepEqual(newer.state.releaseNotes, []);
        assert.equal(newer.state.installMode, "local-package");

        yield* Effect.promise(() => fixture.publish({ version: "1.2.3" }));
        const equal = yield* updates.check("manual");
        assert.equal(equal.state.status, "up-to-date");
        assert.isNull(equal.state.availableVersion);

        yield* Effect.promise(() => fixture.publish({ version: "1.2.2" }));
        const older = yield* updates.check("manual");
        assert.equal(older.state.status, "up-to-date");
        assert.isFalse((yield* updates.download).accepted);
        assert.equal(harness.checkCount(), 0);
      }),
    ),
  );

  it.effect("reports an unreadable folder as a check error that names no path", () =>
    runLocalPackage(({ fixture, harness, updates }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => NodeFSP.rm(fixture.sourceDirectory, { recursive: true }));
        const result = yield* updates.check("manual");

        assert.equal(result.state.status, "error");
        assert.equal(result.state.errorContext, "check");
        assert.isTrue(result.state.canRetry);
        assert.include(result.state.message ?? "", "mounted");
        assert.notInclude(encodeUnknownJson([result.state, harness.sentStates]), fixture.root);
      }),
    ),
  );

  it.effect("disables updates with an actionable message when the bundled config is invalid", () =>
    runLocalPackage(
      ({ fixture, harness, updates }) =>
        Effect.gen(function* () {
          const state = yield* updates.getState;
          assert.equal(state.status, "disabled");
          assert.isFalse(state.enabled);
          assert.equal(state.installMode, "local-package");
          assert.include(state.message ?? "", "Reinstall OOP");
          assert.notInclude(encodeUnknownJson(state), fixture.root);
          assert.isTrue(Option.isSome(yield* updates.disabledReason));

          // The mock upstream feed must not take over when the local config is bad.
          assert.deepEqual(harness.feedUrls(), []);
          assert.equal(harness.listenerCount(), 0);
          const result = yield* updates.check("manual");
          assert.isFalse(result.checked);
          assert.equal(harness.checkCount(), 0);
        }),
      { config: encodeUnknownJson({ directory: "relative/folder" }) },
    ),
  );

  it.effect("checks and stages from the first candidate folder that answers", () =>
    runLocalPackage(
      ({ fixture, updates }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fixture.publish({ version: "1.2.4", content: "from share" }));
          const checked = yield* updates.check("manual");
          assert.equal(checked.state.availableVersion, "1.2.4");
          const download = yield* updates.download;
          assert.isTrue(download.completed);
          const [stagedPath] = yield* Effect.promise(() => fixture.stagedPackagePaths());
          assert.equal(
            yield* Effect.promise(() => NodeFSP.readFile(stagedPath!, "utf8")),
            "from share",
          );
        }),
      {
        config: (fixture) =>
          JSON.stringify({
            directories: [NodePath.join(fixture.root, "drive-not-synced"), fixture.sourceDirectory],
            folderKind: "google-drive",
          }),
      },
    ),
  );

  it.effect("checks this device's own update folder first", () =>
    runLocalPackage(
      ({ fixture, updates }) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fixture.publish({ version: "1.2.4" });
            await NodeFSP.writeFile(
              NodePath.join(fixture.userDataDirectory, "oop-update-folder.json"),
              encodeUnknownJson({ directory: fixture.sourceDirectory }),
            );
          });
          const checked = yield* updates.check("manual");
          assert.equal(checked.state.availableVersion, "1.2.4");
        }),
      {
        config: (fixture) =>
          JSON.stringify({
            directories: [NodePath.join(fixture.root, "no-drive")],
            folderKind: "google-drive",
          }),
      },
    ),
  );

  it.effect("says how to set up Google Drive when no update folder is there", () =>
    runLocalPackage(
      ({ updates }) =>
        Effect.gen(function* () {
          const checked = yield* updates.check("manual");
          assert.equal(checked.state.status, "error");
          assert.include(checked.state.message ?? "", "Google Drive");
        }),
      {
        config: (fixture) =>
          JSON.stringify({
            directories: [NodePath.join(fixture.root, "no-drive")],
            folderKind: "google-drive",
          }),
      },
    ),
  );

  it.effect("stages a verified copy, then opens the Installer and quits without a restart", () =>
    runLocalPackage(({ fixture, harness, updates }) =>
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        yield* Effect.promise(() => fixture.publish({ version: "1.2.4", content: "new OOP" }));
        yield* updates.check("manual");

        const download = yield* updates.download;
        assert.isTrue(download.accepted);
        assert.isTrue(download.completed);
        assert.equal(download.state.status, "downloaded");
        assert.equal(download.state.downloadedVersion, "1.2.4");
        assert.equal(download.state.downloadPercent, 100);

        const [stagedPath] = yield* Effect.promise(() => fixture.stagedPackagePaths());
        assert.isDefined(stagedPath);
        assert.equal(yield* Effect.promise(() => NodeFSP.readFile(stagedPath!, "utf8")), "new OOP");
        assert.isEmpty(installerCommands(harness));

        const install = yield* updates.install;
        assert.isTrue(install.accepted);
        // Handed off to the Installer, not installed: nothing here relaunches the app.
        assert.isFalse(install.completed);
        assert.deepEqual(installerCommands(harness), [
          { command: "/usr/bin/open", args: ["-b", "com.apple.installer", stagedPath] },
        ]);
        assert.deepEqual(harness.localSteps, ["stopBackend", "openInstaller", "quit"]);
        assert.isEmpty(trustCommands(harness));
        assert.equal(harness.appQuits(), 1);
        assert.isTrue(yield* Ref.get(desktopState.quitting));
        assert.equal(harness.quitAndInstalls(), 0);
        assert.equal(harness.updateRestartMarkers.size, 0);
        assert.deepEqual(harness.installSteps, []);
      }),
    ),
  );

  it.effect(
    "does not invoke publisher or binding verification for the embedded legacy policy",
    () => {
      let publisherCalls = 0;
      let bindingCalls = 0;
      return runLocalPackage(
        ({ fixture, harness, updates }) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
            yield* updates.check("manual");
            yield* updates.download;

            const result = yield* updates.install;
            assert.isTrue(result.accepted);
            assert.equal(publisherCalls, 0);
            assert.equal(bindingCalls, 0);
            assert.isEmpty(trustCommands(harness));
            assert.deepEqual(harness.localSteps, ["stopBackend", "openInstaller", "quit"]);
          }),
        {
          harness: {
            trustRuntime: {
              loadPolicy: Effect.succeed(LocalPkgTrust.LEGACY_UNSIGNED_POLICY),
              verifyPublisher: () =>
                Effect.sync(() => {
                  publisherCalls += 1;
                  return undefined;
                }),
              verifyBinding: () =>
                Effect.sync(() => {
                  bindingCalls += 1;
                  return undefined;
                }),
            },
          },
        },
      );
    },
  );

  it.effect(
    "invalidates a staged package before binding or backend shutdown when publisher trust fails",
    () => {
      let bindingCalls = 0;
      return runLocalPackage(
        ({ fixture, harness, updates }) =>
          Effect.gen(function* () {
            const desktopState = yield* DesktopState.DesktopState;
            yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
            yield* updates.check("manual");
            yield* updates.download;
            assert.lengthOf(yield* Effect.promise(() => fixture.stagedPackagePaths()), 1);

            const result = yield* updates.install;
            assert.isTrue(result.accepted);
            assert.isFalse(result.completed);
            assert.equal(result.state.status, "available");
            assert.equal(result.state.availableVersion, "1.2.4");
            assert.isNull(result.state.downloadedVersion);
            assert.equal(result.state.errorContext, "download");
            assert.isTrue(result.state.canRetry);
            assert.isEmpty(yield* Effect.promise(() => fixture.stagedPackagePaths()));
            assert.isFalse(yield* updates.isActionActive);
            assert.isFalse(yield* Ref.get(desktopState.quitting));
            assert.deepEqual(harness.localSteps, []);
            assert.isEmpty(installerCommands(harness));
            assert.equal(harness.appQuits(), 0);
            assert.isEmpty(trustCommands(harness));
            assert.equal(bindingCalls, 0);
            assert.notInclude(encodeUnknownJson(result.state), fixture.root);
          }),
        {
          harness: {
            trustRuntime: testTrustRuntime(
              () =>
                Effect.fail(
                  LocalPkgUpdateError.trustFailure("publisher-untrusted", "pin-mismatch"),
                ),
              () =>
                Effect.sync(() => {
                  bindingCalls += 1;
                  return undefined;
                }),
            ),
          },
        },
      );
    },
  );

  it.effect(
    "checks publisher then release binding with the staged and installed versions before handoff",
    () => {
      const steps: string[] = [];
      return runLocalPackage(
        ({ fixture, harness, updates }) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
            yield* updates.check("manual");
            yield* updates.download;
            const [stagedPath] = yield* Effect.promise(() => fixture.stagedPackagePaths());

            const result = yield* updates.install;
            assert.isTrue(result.accepted);
            assert.isFalse(result.completed);
            assert.deepEqual(steps, ["publisher", "binding"]);
            assert.deepEqual(harness.localSteps, ["stopBackend", "openInstaller", "quit"]);
            assert.deepEqual(installerCommands(harness), [
              { command: "/usr/bin/open", args: ["-b", "com.apple.installer", stagedPath!] },
            ]);
          }),
        {
          harness: {
            trustRuntime: testTrustRuntime(
              () =>
                Effect.sync(() => {
                  steps.push("publisher");
                  return undefined;
                }),
              (staged, installedVersion) =>
                Effect.sync(() => {
                  assert.deepEqual(steps, ["publisher"]);
                  assert.equal(staged.version, "1.2.4");
                  assert.equal(installedVersion, "1.2.3");
                  steps.push("binding");
                  return undefined;
                }),
            ),
          },
        },
      );
    },
  );

  it.effect("invalidates binding failure without stopping backends or opening Installer", () =>
    runLocalPackage(
      ({ fixture, harness, updates }) =>
        Effect.gen(function* () {
          const desktopState = yield* DesktopState.DesktopState;
          yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
          yield* updates.check("manual");
          yield* updates.download;
          assert.lengthOf(yield* Effect.promise(() => fixture.stagedPackagePaths()), 1);

          const result = yield* updates.install;
          assert.isTrue(result.accepted);
          assert.isFalse(result.completed);
          assert.equal(result.state.status, "available");
          assert.isNull(result.state.downloadedVersion);
          assert.equal(result.state.errorContext, "download");
          assert.isTrue(result.state.canRetry);
          assert.isEmpty(yield* Effect.promise(() => fixture.stagedPackagePaths()));
          assert.isFalse(yield* updates.isActionActive);
          assert.isFalse(yield* Ref.get(desktopState.quitting));
          assert.deepEqual(harness.localSteps, []);
          assert.isEmpty(installerCommands(harness));
          assert.equal(harness.appQuits(), 0);
          assert.notInclude(encodeUnknownJson(result.state), fixture.root);
        }),
      {
        harness: {
          trustRuntime: testTrustRuntime(
            () => Effect.succeed(undefined),
            () => Effect.fail(LocalPkgUpdateError.trustFailure("binding-failed", "mismatch")),
          ),
        },
      },
    ),
  );

  it.effect("checks the staged hash before publisher verification", () => {
    let verificationCalls = 0;
    return runLocalPackage(
      ({ fixture, harness, updates }) =>
        Effect.gen(function* () {
          const { size } = yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
          yield* updates.check("manual");
          yield* updates.download;
          const [stagedPath] = yield* Effect.promise(() => fixture.stagedPackagePaths());
          assert.isDefined(stagedPath);
          yield* Effect.promise(() => NodeFSP.writeFile(stagedPath!, Buffer.alloc(size, 7)));

          const result = yield* updates.install;
          assert.isTrue(result.accepted);
          assert.equal(verificationCalls, 0);
          assert.isNull(result.state.downloadedVersion);
          assert.isEmpty(yield* Effect.promise(() => fixture.stagedPackagePaths()));
          assert.deepEqual(harness.localSteps, []);
        }),
      {
        harness: {
          trustRuntime: testTrustRuntime(() =>
            Effect.sync(() => {
              verificationCalls += 1;
              return undefined;
            }),
          ),
        },
      },
    );
  });

  it.effect("checks the staged hash again after release binding", () => {
    let publisherCalls = 0;
    let bindingCalls = 0;
    return runLocalPackage(
      ({ fixture, harness, updates }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
          yield* updates.check("manual");
          yield* updates.download;

          const result = yield* updates.install;
          assert.isTrue(result.accepted);
          assert.equal(publisherCalls, 1);
          assert.equal(bindingCalls, 1);
          assert.equal(result.state.status, "available");
          assert.isNull(result.state.downloadedVersion);
          assert.isEmpty(yield* Effect.promise(() => fixture.stagedPackagePaths()));
          assert.isFalse(yield* updates.isActionActive);
          assert.deepEqual(harness.localSteps, []);
          assert.isEmpty(installerCommands(harness));
        }),
      {
        harness: {
          trustRuntime: testTrustRuntime(
            () =>
              Effect.sync(() => {
                publisherCalls += 1;
                return undefined;
              }),
            (staged) =>
              Effect.sync(() => {
                bindingCalls += 1;
                return undefined;
              }).pipe(
                Effect.andThen(
                  Effect.promise(() =>
                    NodeFSP.writeFile(staged.path, Buffer.alloc(staged.size, 7)),
                  ),
                ),
                Effect.as(undefined),
              ),
          ),
        },
      },
    );
  });

  it.effect("releases the install reservation when publisher verification is interrupted", () =>
    Effect.gen(function* () {
      const verificationStarted = yield* Deferred.make<void>();
      const releaseVerification = yield* Deferred.make<void>();
      yield* runLocalPackage(
        ({ fixture, harness, updates }) =>
          Effect.gen(function* () {
            const desktopState = yield* DesktopState.DesktopState;
            yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
            yield* updates.check("manual");
            yield* updates.download;

            const firstInstall = yield* updates.install.pipe(Effect.forkScoped);
            yield* Deferred.await(verificationStarted);
            assert.isTrue(yield* updates.isInstallActive);
            yield* Fiber.interrupt(firstInstall);

            assert.isFalse(yield* updates.isActionActive);
            assert.isFalse(yield* Ref.get(desktopState.quitting));
            assert.lengthOf(yield* Effect.promise(() => fixture.stagedPackagePaths()), 1);
            assert.deepEqual(harness.localSteps, []);
            assert.isEmpty(installerCommands(harness));

            yield* Deferred.succeed(releaseVerification, undefined);
            const retry = yield* updates.install;
            assert.isTrue(retry.accepted);
            assert.deepEqual(harness.localSteps, ["stopBackend", "openInstaller", "quit"]);
          }),
        {
          harness: {
            trustRuntime: testTrustRuntime(() =>
              Deferred.succeed(verificationStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseVerification)),
                Effect.as(undefined),
              ),
            ),
          },
        },
      );
    }),
  );

  it.effect("releases the install reservation when release binding is interrupted", () =>
    Effect.gen(function* () {
      const bindingStarted = yield* Deferred.make<void>();
      const releaseBinding = yield* Deferred.make<void>();
      yield* runLocalPackage(
        ({ fixture, harness, updates }) =>
          Effect.gen(function* () {
            const desktopState = yield* DesktopState.DesktopState;
            yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
            yield* updates.check("manual");
            yield* updates.download;

            const firstInstall = yield* updates.install.pipe(Effect.forkScoped);
            yield* Deferred.await(bindingStarted);
            assert.isTrue(yield* updates.isInstallActive);
            yield* Fiber.interrupt(firstInstall);

            assert.isFalse(yield* updates.isActionActive);
            assert.isFalse(yield* Ref.get(desktopState.quitting));
            assert.lengthOf(yield* Effect.promise(() => fixture.stagedPackagePaths()), 1);
            assert.deepEqual(harness.localSteps, []);
            assert.isEmpty(installerCommands(harness));

            yield* Deferred.succeed(releaseBinding, undefined);
            const retry = yield* updates.install;
            assert.isTrue(retry.accepted);
            assert.deepEqual(harness.localSteps, ["stopBackend", "openInstaller", "quit"]);
          }),
        {
          harness: {
            trustRuntime: testTrustRuntime(
              () => Effect.succeed(undefined),
              () =>
                Deferred.succeed(bindingStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseBinding)),
                  Effect.as(undefined),
                ),
            ),
          },
        },
      );
    }),
  );

  it.effect("disables local updates when the runtime trust policy is malformed", () =>
    runLocalPackage(
      ({ fixture, harness, updates }) =>
        Effect.gen(function* () {
          const state = yield* updates.getState;
          assert.equal(state.status, "disabled");
          assert.isFalse(state.enabled);
          assert.equal(state.installMode, "local-package");
          assert.include(state.message ?? "", "Reinstall OOP");
          assert.isFalse((yield* updates.check("manual")).checked);
          assert.isFalse((yield* updates.download).accepted);
          assert.isFalse((yield* updates.install).accepted);
          assert.deepEqual(harness.localSteps, []);
          assert.isEmpty(trustCommands(harness));
          assert.notInclude(encodeUnknownJson(state), fixture.root);
        }),
      {
        harness: {
          trustRuntime: {
            loadPolicy: EmbeddedLocalPkgTrustPolicy.loadRuntimeTrustPolicy({ mode: "surprise" }),
            verifyPublisher: () => Effect.die("unexpected publisher verification"),
          },
        },
      },
    ),
  );

  it.effect(
    "does not fall through to the upstream updater with no local config and invalid trust",
    () =>
      runLocalPackage(
        ({ harness, updates }) =>
          Effect.gen(function* () {
            const state = yield* updates.getState;
            assert.equal(state.status, "disabled");
            assert.isFalse(state.enabled);
            assert.equal(state.installMode, "local-package");
            assert.include(state.message ?? "", "Reinstall OOP");
            assert.isFalse((yield* updates.check("manual")).checked);
            assert.deepEqual(harness.feedUrls(), []);
            assert.equal(harness.listenerCount(), 0);
            assert.equal(harness.checkCount(), 0);
            assert.isEmpty(trustCommands(harness));
          }),
        {
          writeConfig: false,
          harness: {
            trustRuntime: {
              loadPolicy: EmbeddedLocalPkgTrustPolicy.loadRuntimeTrustPolicy({ mode: "invalid" }),
              verifyPublisher: () => Effect.die("unexpected publisher verification"),
            },
          },
        },
      ),
  );

  it.effect("disables local updates when developer-id reaches runtime before release binding", () =>
    runLocalPackage(
      ({ harness, updates }) =>
        Effect.gen(function* () {
          const state = yield* updates.getState;
          assert.equal(state.status, "disabled");
          assert.isFalse(state.enabled);
          assert.equal(state.installMode, "local-package");
          assert.include(state.message ?? "", "Reinstall OOP");
          assert.isFalse((yield* updates.check("manual")).checked);
          assert.deepEqual(harness.localSteps, []);
          assert.isEmpty(trustCommands(harness));
        }),
      {
        harness: {
          trustRuntime: {
            loadPolicy: EmbeddedLocalPkgTrustPolicy.loadRuntimeTrustPolicy({
              mode: "developer-id",
              teamId: "ABCDE12345",
              leafPins: [TEST_PIN],
            }),
            verifyPublisher: () => Effect.die("unexpected publisher verification"),
          },
        },
      },
    ),
  );

  it.effect("keeps the source quarantine flag on the staged copy", () =>
    runLocalPackage(({ fixture, harness, updates }) =>
      Effect.gen(function* () {
        if (!NodeFS.existsSync("/usr/bin/xattr")) return;
        const quarantine = "0083;5f3a;Safari;UUID";
        const { pkgPath } = yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
        yield* Effect.sync(() =>
          NodeChildProcess.execFileSync("/usr/bin/xattr", [
            "-w",
            "com.apple.quarantine",
            quarantine,
            pkgPath,
          ]),
        );
        yield* updates.check("manual");
        yield* updates.download;

        const [stagedPath] = yield* Effect.promise(() => fixture.stagedPackagePaths());
        if (stagedPath === undefined) return assert.fail("Expected the staged package path");
        const writes = harness.commands.filter((command) => command.args[0] === "-w");
        assert.deepEqual(writes, [
          {
            command: "/usr/bin/xattr",
            args: ["-w", "com.apple.quarantine", quarantine, stagedPath],
          },
        ]);
      }),
    ),
  );

  it.effect("refuses an install whose staged file changed and stages again on retry", () =>
    runLocalPackage(({ fixture, harness, updates }) =>
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const { size } = yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
        yield* updates.check("manual");
        yield* updates.download;
        const [stagedPath] = yield* Effect.promise(() => fixture.stagedPackagePaths());
        yield* Effect.promise(() => NodeFSP.writeFile(stagedPath!, Buffer.alloc(size, 7)));

        const refused = yield* updates.install;
        assert.isTrue(refused.accepted);
        assert.isFalse(refused.completed);
        // Nothing was stopped, opened or quit, and the reservation is free again.
        assert.deepEqual(harness.localSteps, []);
        assert.isEmpty(installerCommands(harness));
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.isFalse(yield* updates.isActionActive);
        assert.equal(harness.updateRestartMarkers.size, 0);

        // The bad copy is gone and the update is offered for download again.
        assert.equal(refused.state.status, "available");
        assert.isNull(refused.state.downloadedVersion);
        assert.equal(refused.state.availableVersion, "1.2.4");
        assert.equal(refused.state.errorContext, "download");
        assert.isTrue(refused.state.canRetry);
        assert.include(refused.state.message ?? "", "Prepare the update again");
        assert.isEmpty(yield* Effect.promise(() => fixture.stagedPackagePaths()));

        assert.isTrue((yield* updates.download).completed);
        assert.lengthOf(yield* Effect.promise(() => fixture.stagedPackagePaths()), 1);
        assert.isTrue((yield* updates.install).accepted);
        assert.deepEqual(harness.localSteps, ["stopBackend", "openInstaller", "quit"]);
      }),
    ),
  );

  it.effect("recovers backends and keeps the staged copy when the Installer cannot open", () =>
    runLocalPackage(
      ({ fixture, harness, updates }) =>
        Effect.gen(function* () {
          const desktopState = yield* DesktopState.DesktopState;
          yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
          yield* updates.check("manual");
          yield* updates.download;

          const result = yield* updates.install;
          assert.isTrue(result.accepted);
          assert.isFalse(result.completed);
          assert.deepEqual(harness.localSteps, ["stopBackend", "openInstaller"]);
          assert.deepEqual(harness.installSteps, ["startBackend"]);
          assert.equal(harness.appQuits(), 0);
          assert.isFalse(yield* Ref.get(desktopState.quitting));
          assert.equal(harness.updateRestartMarkers.size, 0);

          assert.equal(result.state.status, "downloaded");
          assert.equal(result.state.errorContext, "install");
          assert.include(result.state.message ?? "", "Installer");
          assert.lengthOf(yield* Effect.promise(() => fixture.stagedPackagePaths()), 1);
          assert.isFalse(yield* updates.isActionActive);
        }),
      { harness: { openExitCode: 1 } },
    ),
  );

  it.effect("refuses a remotely prepared install of a local package", () =>
    runLocalPackage(({ fixture, harness, updates }) =>
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
        yield* updates.check("manual");
        yield* updates.download;

        const result = yield* updates.installPrepared("1.2.4");
        assert.isFalse(result.accepted);
        assert.isFalse(result.failed);
        assert.equal(result.state.status, "downloaded");
        assert.isEmpty(installerCommands(harness));
        assert.deepEqual(harness.localSteps, []);
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.isFalse(yield* updates.isActionActive);
      }),
    ),
  );

  it.effect("replaces the staged copy when the folder publishes something newer", () =>
    runLocalPackage(({ fixture, updates }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fixture.publish({ version: "1.2.4" }));
        yield* updates.check("manual");
        yield* updates.download;

        yield* Effect.promise(() => fixture.publish({ version: "1.2.5" }));
        const offered = yield* updates.check("manual");
        assert.equal(offered.state.status, "available");
        assert.equal(offered.state.availableVersion, "1.2.5");
        assert.isNull(offered.state.downloadedVersion);

        assert.isTrue((yield* updates.download).completed);
        const staged = yield* Effect.promise(() => fixture.stagedPackagePaths());
        assert.deepEqual(
          staged.map((path) => path.split("/").at(-1)),
          ["OoP-1.2.5-arm64-update.pkg"],
        );
      }),
    ),
  );

  it.effect("does not treat a rebuilt package with the same version as already staged", () =>
    runLocalPackage(({ fixture, updates }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fixture.publish({ version: "1.2.4", content: "first build" }));
        yield* updates.check("manual");
        yield* updates.download;

        yield* Effect.promise(() => fixture.publish({ version: "1.2.4", content: "second build" }));
        const offered = yield* updates.check("manual");
        assert.equal(offered.state.status, "available");
        assert.isNull(offered.state.downloadedVersion);

        yield* updates.download;
        const [stagedPath] = yield* Effect.promise(() => fixture.stagedPackagePaths());
        assert.equal(
          yield* Effect.promise(() => NodeFSP.readFile(stagedPath!, "utf8")),
          "second build",
        );
      }),
    ),
  );

  it.effect("fails the download, and keeps nothing, when the folder changed since the check", () =>
    runLocalPackage(({ fixture, updates }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fixture.publish({ version: "1.2.4", content: "seen build" }));
        yield* updates.check("manual");
        // Same size, different bytes, and the manifest the user saw is kept.
        const seen = yield* Effect.promise(() =>
          NodeFSP.readFile(`${fixture.sourceDirectory}/oop-update.json`),
        );
        yield* Effect.promise(async () => {
          await fixture.publish({ version: "1.2.4", content: "next build" });
          await NodeFSP.writeFile(`${fixture.sourceDirectory}/oop-update.json`, seen);
        });

        const result = yield* updates.download;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);
        assert.equal(result.state.status, "available");
        assert.equal(result.state.errorContext, "download");
        assert.include(result.state.message ?? "", "does not match its manifest");
        assert.isEmpty(yield* Effect.promise(() => fixture.stagedPackagePaths()));
        assert.isFalse(yield* updates.isActionActive);
      }),
    ),
  );
});

describe("DesktopUpdates.resolveInstallScope", () => {
  const base = {
    isPackaged: true,
    appImagePath: Option.none<string>(),
    homeDirectory: "/Users/u",
    path: NodePath.posix,
  } as const;
  const mac = (bundle: string) => ({
    ...base,
    platform: "darwin" as const,
    appPath: `${bundle}/Contents/Resources/app.asar`,
    resourcesPath: `${bundle}/Contents/Resources`,
  });

  it("classifies where the app runs from without reporting the path", () => {
    assert.equal(DesktopUpdates.resolveInstallScope(mac("/Applications/OOP.app")), "system");
    assert.equal(DesktopUpdates.resolveInstallScope(mac("/Users/u/Applications/OOP.app")), "user");
    assert.equal(DesktopUpdates.resolveInstallScope(mac("/Volumes/Disk/OOP.app")), "other");
    // A sibling folder that only shares the home prefix is not inside home.
    assert.equal(DesktopUpdates.resolveInstallScope(mac("/Users/u2/OOP.app")), "other");
    assert.equal(
      DesktopUpdates.resolveInstallScope({
        ...base,
        homeDirectory: "/home/u",
        platform: "linux",
        appImagePath: Option.some("/home/u/.local/share/oop-desktop/OOP.AppImage"),
        appPath: "/tmp/.mount_OOP/resources/app.asar",
        resourcesPath: "/tmp/.mount_OOP/resources",
      }),
      "user",
    );
    assert.equal(
      DesktopUpdates.resolveInstallScope({
        ...base,
        homeDirectory: "C:\\Users\\u",
        platform: "win32",
        path: NodePath.win32,
        appPath: "C:\\Users\\u\\AppData\\Local\\Programs\\OOP\\resources\\app.asar",
        resourcesPath: "C:\\Users\\u\\AppData\\Local\\Programs\\OOP\\resources",
      }),
      "user",
    );
    assert.equal(
      DesktopUpdates.resolveInstallScope({ ...mac("/Applications/OOP.app"), isPackaged: false }),
      "development",
    );
  });
});

describe("public builds updating from GitHub releases", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect("download a newer release on their own and wait for the user to install it", () => {
    const dmg = Buffer.from("public OOP 99.0.0 disk image");
    const feed = {
      schemaVersion: 1,
      platform: "darwin",
      arch: "arm64",
      version: "99.0.0",
      pkg: "OOP-99.0.0-arm64.dmg",
      size: dmg.length,
      sha256: NodeCrypto.createHash("sha256").update(dmg).digest("hex"),
    };
    const releases = "https://github.com/example/oop-desktop/releases";
    const assets: Record<string, Buffer> = {
      [`${releases}/latest/download/oop-update-macos.json`]: Buffer.from(encodeFeed(feed)),
      [`${releases}/download/v99.0.0/OOP-99.0.0-arm64.dmg`]: dmg,
    };
    const asked: Array<string> = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      const body = assets[url];
      return body === undefined
        ? new Response("Not Found", { status: 404 })
        : new Response(new Uint8Array(body), {
            headers: { "content-length": String(body.length) },
          });
    });
    return runLocalPackage(
      ({ fixture, harness, updates }) =>
        Effect.gen(function* () {
          const { changes } = yield* updates.subscribe;
          const downloaded = yield* changes.pipe(
            Stream.filter((state) => state.status === "downloaded"),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* TestClock.adjust(Duration.seconds(15));
          const state = Option.getOrThrow(yield* Fiber.join(downloaded));
          assert.equal(state.downloadedVersion, "99.0.0");
          assert.equal(state.build?.distribution, "public");
          assert.equal(state.build?.updateSource, "release-feed");
          assert.deepEqual(asked, Object.keys(assets));
          const staged = yield* Effect.promise(() => fixture.stagedPackagePaths());
          assert.equal(staged.length, 1);
          assert.deepEqual(yield* Effect.promise(() => NodeFSP.readFile(staged[0]!)), dmg);
          // Nothing is installed until the user chooses to.
          assert.deepEqual(installerCommands(harness), []);
        }),
      { config: '{"github":"example/oop-desktop"}' },
    );
  });
});
