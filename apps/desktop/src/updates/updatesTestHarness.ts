// @effect-diagnostics nodeBuiltinImport:off -- The local-package fixture writes real update folders so symlink, permission and hash behavior is exercised.
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import * as EmbeddedLocalPkgTrustPolicy from "./EmbeddedLocalPkgTrustPolicy.ts";

/** Shared DesktopUpdates test harness: a fully stubbed updater layer whose
    electron-updater events are driven by hand via `emit`. Used by
    DesktopUpdates.test.ts, DesktopRemoteUpdates.test.ts and
    LocalPkgUpdates.test.ts. */

export const flushCallbacks = Effect.yieldNow;

export interface FakeProcessResult {
  /** "hang" never exits, like a stuck child. */
  readonly exitCode: number | "hang";
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface FakeCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const encoder = new TextEncoder();

/** A ChildProcessSpawner that runs nothing: `handler` decides each command's outcome. */
export const makeFakeSpawner = (handler: (command: FakeCommand) => FakeProcessResult) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const result = handler(command as unknown as FakeCommand);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode:
            result.exitCode === "hang"
              ? Effect.never
              : Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: result.stdout ? Stream.make(encoder.encode(result.stdout)) : Stream.empty,
          stderr: result.stderr ? Stream.make(encoder.encode(result.stderr)) : Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

/** A real update folder, app resources and user data directory under the OS temp dir. */
export interface LocalPackageFixture {
  readonly root: string;
  readonly sourceDirectory: string;
  readonly resourcesDirectory: string;
  readonly userDataDirectory: string;
  /** Writes the bundled oop-local-update.json; defaults to naming `sourceDirectory`. */
  readonly writeConfig: (content?: string) => Promise<void>;
  /** Publishes `OoP-<version>-arm64-update.pkg` and a matching manifest. */
  readonly publish: (input: {
    readonly version: string;
    readonly content?: string;
  }) => Promise<{ readonly pkgPath: string; readonly sha256: string; readonly size: number }>;
  /** Every file currently staged under the private staging folder. */
  readonly stagedPackagePaths: () => Promise<ReadonlyArray<string>>;
}

export const makeLocalPackageFixture = Effect.acquireRelease(
  Effect.promise(async (): Promise<LocalPackageFixture> => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-local-updates-"));
    const sourceDirectory = NodePath.join(root, "source");
    const resourcesDirectory = NodePath.join(root, "resources");
    const userDataDirectory = NodePath.join(root, "user-data");
    for (const directory of [sourceDirectory, resourcesDirectory, userDataDirectory]) {
      await NodeFSP.mkdir(directory);
    }
    const stagingRoot = NodePath.join(userDataDirectory, "oop-local-update");
    return {
      root,
      sourceDirectory,
      resourcesDirectory,
      userDataDirectory,
      writeConfig: (content) =>
        NodeFSP.writeFile(
          NodePath.join(resourcesDirectory, "oop-local-update.json"),
          content ?? JSON.stringify({ directory: sourceDirectory }),
        ),
      publish: async ({ version, content = `OOP package ${version}` }) => {
        const pkg = `OoP-${version}-arm64-update.pkg`;
        const bytes = Buffer.from(content);
        const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        const pkgPath = NodePath.join(sourceDirectory, pkg);
        await NodeFSP.writeFile(pkgPath, bytes);
        await NodeFSP.writeFile(
          NodePath.join(sourceDirectory, "oop-update.json"),
          JSON.stringify({
            schemaVersion: 1,
            platform: "darwin",
            arch: "arm64",
            version,
            pkg,
            size: bytes.length,
            sha256,
          }),
        );
        return { pkgPath, sha256, size: bytes.length };
      },
      stagedPackagePaths: async () => {
        const directories = await NodeFSP.readdir(stagingRoot).catch(() => []);
        const nested = await Promise.all(
          directories.map(async (directory) =>
            (await NodeFSP.readdir(NodePath.join(stagingRoot, directory))).map((file) =>
              NodePath.join(stagingRoot, directory, file),
            ),
          ),
        );
        return nested.flat();
      },
    };
  }),
  (fixture) => Effect.promise(() => NodeFSP.rm(fixture.root, { recursive: true, force: true })),
);

export interface UpdatesHarnessOptions {
  /** Runs as packaged OOP on arm64 macOS, configured from this fixture. */
  readonly local?: LocalPackageFixture;
  /** Overrides the embedded local trust runtime only inside integration tests. */
  readonly trustRuntime?: Omit<
    Context.Service.Shape<typeof EmbeddedLocalPkgTrustPolicy.LocalPkgTrustRuntime>,
    "verifyBinding"
  > &
    Partial<
      Pick<
        Context.Service.Shape<typeof EmbeddedLocalPkgTrustPolicy.LocalPkgTrustRuntime>,
        "verifyBinding"
      >
    >;
  /** Overrides the build profile; "" is a build without one (not OOP). */
  readonly buildProfileName?: string;
  /** Exit status of `/usr/bin/open` for the staged package; defaults to 0. */
  readonly openExitCode?: number;
  /** Value `xattr -p com.apple.quarantine` reports for the update folder's package. */
  readonly quarantine?: string;
  readonly checkForUpdates?: Effect.Effect<
    void,
    ElectronUpdater.ElectronUpdaterCheckForUpdatesError
  >;
  readonly beforeSetUpdateChannel?: Effect.Effect<void>;
  readonly setUpdateChannelError?: DesktopAppSettings.DesktopSettingsWriteError;
  readonly setDisableDifferentialDownload?: Effect.Effect<void>;
  readonly downloadUpdate?: Effect.Effect<void>;
  readonly quitAndInstall?: Effect.Effect<void, ElectronUpdater.ElectronUpdaterQuitAndInstallError>;
  readonly stopBackend?: Effect.Effect<void>;
  readonly startBackend?: Effect.Effect<void>;
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
  /** Contents of the resources/package-type marker a Linux package ships. */
  readonly packageType?: string | undefined;
}

export function makeHarness(options: UpdatesHarnessOptions = {}) {
  let checkCount = 0;
  let quitAndInstallCount = 0;
  let downloadCount = 0;
  let allowDowngrade = false;
  let fullChangelog = false;
  const feedUrls: ElectronUpdater.ElectronUpdaterFeedUrl[] = [];
  const listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  const sentStates: DesktopUpdateState[] = [];
  const installSteps: string[] = [];
  // Local-package installs: backend stops, the Installer launch and the app
  // quit, in order. Kept apart from installSteps, which upstream tests compare whole.
  const localSteps: string[] = [];
  const commands: FakeCommand[] = [];
  let appQuitCount = 0;

  const addListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName) ?? new Set();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
  };

  const removeListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName);
    if (!eventListeners) {
      return;
    }
    eventListeners.delete(listener);
    if (eventListeners.size === 0) {
      listeners.delete(eventName);
    }
  };

  const updaterLayer = Layer.succeed(ElectronUpdater.ElectronUpdater, {
    setFeedURL: (options) =>
      Effect.sync(() => {
        feedUrls.push(options);
      }),
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: () => Effect.void,
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.sync(() => {
        allowDowngrade = value;
      }),
    setFullChangelog: (value) =>
      Effect.sync(() => {
        fullChangelog = value;
      }),
    setDisableDifferentialDownload: () => options.setDisableDifferentialDownload ?? Effect.void,
    checkForUpdates: Effect.sync(() => {
      checkCount += 1;
    }).pipe(Effect.andThen(options.checkForUpdates ?? Effect.void)),
    downloadUpdate: Effect.sync(() => {
      downloadCount += 1;
    }).pipe(Effect.andThen(options.downloadUpdate ?? Effect.void)),
    quitAndInstall: () =>
      Effect.sync(() => {
        quitAndInstallCount += 1;
        installSteps.push("quitAndInstall");
      }).pipe(Effect.andThen(options.quitAndInstall ?? Effect.void)),
    on: (eventName, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          addListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
        }),
        () =>
          Effect.sync(() => {
            removeListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
          }),
      ).pipe(Effect.asVoid),
  } satisfies ElectronUpdater.ElectronUpdater["Service"]);

  const windowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeedNone,
    currentMainOrFirst: Effect.succeedNone,
    focusedMainOrFirst: Effect.succeedNone,
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: (_channel, state) =>
      Effect.sync(() => {
        sentStates.push(state as DesktopUpdateState);
      }),
    destroyAll: Effect.sync(() => {
      installSteps.push("destroyAll");
    }),
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const stubBackendInstance: DesktopBackendPool.DesktopBackendInstance = {
    id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    start: Effect.sync(() => {
      installSteps.push("startBackend");
    }).pipe(Effect.andThen(options.startBackend ?? Effect.void)),
    stop: () =>
      Effect.sync(() => {
        localSteps.push("stopBackend");
      }).pipe(Effect.andThen(options.stopBackend ?? Effect.void)),
    currentConfig: Effect.succeedNone,
    snapshot: Effect.succeed({
      desiredRunning: false,
      ready: false,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    }),
    waitForReady: () => Effect.succeed(true),
  };
  const backendLayer = DesktopBackendPool.layerTest([stubBackendInstance]);

  const buildProfileName = options.buildProfileName ?? (options.local ? "oop-desktop" : undefined);
  const configEnv = {
    T3CODE_HOME: `/tmp/t3-desktop-updates-test-${process.pid}`,
    T3CODE_DESKTOP_MOCK_UPDATES: "true",
    T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
    ...(options.local ? { T3CODE_DESKTOP_USER_DATA_DIR: options.local.userDataDirectory } : {}),
    ...options.env,
  };
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: `/tmp/t3-desktop-updates-home-${process.pid}`,
    platform: options.platform ?? "darwin",
    processArch: options.local ? "arm64" : "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: options.local?.resourcesDirectory ?? "/missing/resources",
    runningUnderArm64Translation: false,
    ...(buildProfileName === undefined ? {} : { buildProfileName }),
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(configEnv))));

  let testSettings: DesktopAppSettings.DesktopSettings = {
    ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
  };
  const setUpdateChannelError = options.setUpdateChannelError;
  const settingsLayer =
    setUpdateChannelError || options.beforeSetUpdateChannel
      ? Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
          get: Effect.sync(() => testSettings),
          load: Effect.sync(() => testSettings),
          setMainWindowBounds: () => Effect.die("unexpected main window bounds update"),
          setServerExposureMode: () => Effect.die("unexpected server exposure update"),
          setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
          setUpdateChannel: (channel) =>
            setUpdateChannelError
              ? Effect.fail(setUpdateChannelError)
              : (options.beforeSetUpdateChannel ?? Effect.void).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      const changed = testSettings.updateChannel !== channel;
                      testSettings = {
                        ...testSettings,
                        updateChannel: channel,
                        updateChannelConfiguredByUser: true,
                      };
                      return { settings: testSettings, changed };
                    }),
                  ),
                ),
          setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
          setWslDistro: () => Effect.die("unexpected WSL distro change"),
          setLocalEnvironmentEnabled: () => Effect.die("unexpected local environment toggle"),
          setMenuLanguage: () => Effect.die("unexpected menu language change"),
          setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
          applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
          applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
        } satisfies DesktopAppSettings.DesktopAppSettings["Service"])
      : DesktopAppSettings.layer;

  // Tracks the restart markers installs leave, so installs stay free of real
  // disk I/O that would outrun the tests' settle loops.
  const updateRestartMarkers = new Set<string>();
  const fileSystemLayer = FileSystem.layerNoop({
    readFileString: (path) =>
      path === "/missing/resources/package-type" && options.packageType !== undefined
        ? Effect.succeed(options.packageType)
        : Effect.fail(
            PlatformError.systemError({
              module: "FileSystem",
              method: "readFileString",
              _tag: "NotFound",
              pathOrDescriptor: path,
            }),
          ),
    makeDirectory: () => Effect.void,
    writeFileString: (path) =>
      Effect.sync(() => {
        updateRestartMarkers.add(path);
      }),
    remove: (path) =>
      Effect.sync(() => {
        updateRestartMarkers.delete(path);
      }),
  });

  // The local-package flow's only process boundary: xattr (quarantine copy)
  // and the Installer launch. Nothing real is run.
  const spawnerLayer = makeFakeSpawner(({ command, args }) => {
    commands.push({ command, args });
    if (command === "/usr/bin/open") {
      localSteps.push("openInstaller");
      return { exitCode: options.openExitCode ?? 0 };
    }
    if (command === "/usr/bin/xattr" && args[0] === "-p") {
      return options.quarantine === undefined
        ? { exitCode: 1, stderr: "xattr: No such xattr: com.apple.quarantine" }
        : { exitCode: 0, stdout: `${options.quarantine}\n` };
    }
    return { exitCode: 0 };
  });

  const appLayer = Layer.succeed(ElectronApp.ElectronApp, {
    quit: Effect.sync(() => {
      appQuitCount += 1;
      localSteps.push("quit");
    }),
  } as ElectronApp.ElectronApp["Service"]);

  const layer = DesktopUpdates.layer.pipe(
    Layer.provideMerge(
      options.trustRuntime === undefined
        ? Layer.empty
        : Layer.succeed(EmbeddedLocalPkgTrustPolicy.LocalPkgTrustRuntime, {
            ...options.trustRuntime,
            verifyBinding: options.trustRuntime.verifyBinding ?? (() => Effect.succeed(undefined)),
          }),
    ),
    Layer.provide(Layer.mergeAll(fileSystemLayer, spawnerLayer, appLayer)),
    Layer.provideMerge(updaterLayer),
    Layer.provideMerge(windowLayer),
    Layer.provideMerge(backendLayer),
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(DesktopConfig.layerTest(configEnv)),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    checkCount: () => checkCount,
    quitAndInstalls: () => quitAndInstallCount,
    installSteps,
    localSteps,
    commands,
    appQuits: () => appQuitCount,
    updateRestartMarkers,
    downloadCount: () => downloadCount,
    feedUrls: (): ElectronUpdater.ElectronUpdaterFeedUrl[] => feedUrls,
    fullChangelog: () => fullChangelog,
    listenerCount: () =>
      Array.from(listeners.values()).reduce(
        (total, eventListeners) => total + eventListeners.size,
        0,
      ),
    sentStates,
    emit: (eventName: string, payload?: unknown) => {
      for (const listener of listeners.get(eventName) ?? []) {
        listener(payload);
      }
    },
  };
}
