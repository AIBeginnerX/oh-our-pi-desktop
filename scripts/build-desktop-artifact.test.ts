// @effect-diagnostics nodeBuiltinImport:off - Tests use Node's glob matcher to verify electron-builder exclusions.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  BundleNotSelfContainedError,
  BuildCommandFailedError,
  parseWslRuntimeArchiveMembers,
  DesktopDmgBackgroundSourceMissingError,
  desktopBuildEnv,
  EmbeddedTrustPolicyMismatchError,
  createStageWorkspaceConfig,
  createStagePatchedDependencies,
  createBuildConfig,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_FILE_EXCLUSIONS,
  DESKTOP_EXTRA_RESOURCES,
  LINUX_CAPTURE_EXTRA_RESOURCES,
  LINUX_BROWSER_SECRET_EXTRA_RESOURCES,
  LINUX_FILE_EXCLUSIONS,
  MAC_FILE_EXCLUSIONS,
  InvalidBuildSigningError,
  InvalidOopLocalUpdateDirectoryError,
  InvalidOopLocalUpdateCandidatesError,
  InvalidMacPasskeyRpDomainError,
  InvalidMacPasskeyPublishableKeyError,
  InvalidMockUpdateServerPortError,
  UnsupportedDesktopBuildArchitectureError,
  isMacPasskeySigningConfigurationError,
  LinuxIconResizeError,
  LinuxDesktopBuildPrerequisitesMissingError,
  MacDesktopBuildPrerequisitesMissingError,
  MacBundleSignatureValidationError,
  MacPasskeySigningConfigurationResolutionError,
  MissingMacPasskeyProvisioningProfileError,
  packWindowsServerAsar,
  preflightLinuxDesktopBuild,
  preflightMacDesktopBuild,
  preflightWindowsDesktopBuild,
  renderMacDeveloperIdCandidateReceipt,
  renderMacPasskeyEntitlements,
  resolveClerkPasskeyNativeArtifacts,
  resolveKeyringNativeArtifacts,
  resolveMacPasskeySigningConfiguration,
  resolveDesktopRuntimeDependencies,
  resolveMergedStageDependencies,
  resolveFffNativeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveDesktopWebAssetBrand,
  resolveResourceMonitorRustTargets,
  resolveWindowsServerAsarIgnoreGlobs,
  resourceMonitorExecutableName,
  scrubMacDeveloperIdBuildEnv,
  verifyMacDeveloperIdRequirement,
  verifyStagedTrustMarker,
  resolveGitHubPublishConfig,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  resolveOopLocalUpdateDirectory,
  resolveOopLocalUpdateCandidates,
  resolvePackageManagerUserAgent,
  renderOopLocalUpdateConfig,
  stageLinuxIconSize,
  stageDesktopDmgBackground,
  stageResourceMonitor,
  stageLinuxCaptureHelper,
  stageWslRuntimeArchive,
  bundlesWslRuntime,
  STAGE_INSTALL_ARGS,
  ancestorNodeModulesPaths,
  copyDirectoryPreservingSymlinks,
  LinuxBrowserSecretHostError,
  stageBrowserSecret,
  validateWindowsPackagedPayload,
  WindowsPrimaryNativeProbeError,
  WindowsDesktopBuildPrerequisitesMissingError,
  WindowsPackagedPayloadValidationError,
  WINDOWS_NATIVE_ASAR_UNPACK_GLOB,
  WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT,
  WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
  WINDOWS_SERVER_EXTRA_RESOURCES,
  WINDOWS_SERVER_ASAR_RESOURCE,
  WINDOWS_SERVER_RESOURCE_SOURCE_DIR,
  WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_NAME,
  WSL_RUNTIME_ARCHIVE_NAME,
  WSL_RUNTIME_EXTRA_RESOURCES,
  WslRuntimeArchiveMissingError,
  wslRuntimeArchiveStem,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

// A minimal stand-in for the Linux CLI release archive: one top-level
// directory named after the archive stem holding the executable, the web
// client, and the runtime externals with node-pty built from source.
const makeLinuxCliArchiveFixture = Effect.fn("test.makeLinuxCliArchiveFixture")(function* (input: {
  readonly root: string;
  readonly stem: string;
  readonly extraMembers?: ReadonlyArray<string>;
  readonly omitMembers?: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const contentRoot = path.join(input.root, "content");
  const members = [
    `${input.stem}/t3`,
    `${input.stem}/client/index.html`,
    `${input.stem}/node_modules/node-pty/package.json`,
    `${input.stem}/node_modules/node-pty/build/Release/pty.node`,
    ...(input.extraMembers ?? []),
  ].filter((member) => !(input.omitMembers ?? []).includes(member));
  for (const member of members) {
    const memberPath = path.join(contentRoot, member);
    yield* fs.makeDirectory(path.dirname(memberPath), { recursive: true });
    yield* fs.writeFileString(memberPath, member);
  }
  const archivePath = path.join(input.root, `${input.stem}.tar.gz`);
  const tar = yield* spawner.spawn(
    ChildProcess.make("tar", ["-czf", archivePath, "-C", contentRoot, "."], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  assert.equal(Number(yield* tar.exitCode), 0);
  return archivePath;
});

function mockProcess(exitCode: number, stdout = "") {
  const encodedStdout = new TextEncoder().encode(stdout);
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout ? Stream.make(encodedStdout) : Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function iconResizeSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
  exitCodes: ReadonlyArray<number>,
) {
  let commandIndex = 0;
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(mockProcess(exitCodes[commandIndex++] ?? 0));
    }),
  );
}

const WINDOWS_PAYLOAD_FIXTURE_VERSION = "1.2.3";

const makeWindowsPayloadFixture = Effect.fn("test.makeWindowsPayloadFixture")(function* (input: {
  readonly copyUnpackedNatives: boolean;
  readonly serverEntrySource?: string;
  readonly wslRuntime?: "valid" | "loose-server-tree" | "missing-pty" | "bad-digest";
  readonly targetArch?: "x64" | "arm64";
  readonly ptyPrebuildArch?: "x64" | "arm64";
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({
    prefix: "t3-windows-payload-test-",
  });
  const sourceDir = path.join(tempDir, "server-source");
  const serverEntryPath = path.join(sourceDir, "apps/server/dist/bin.mjs");
  const nativePath = path.join(sourceDir, "node_modules/native/addon.node");
  yield* fs.makeDirectory(path.dirname(serverEntryPath), { recursive: true });
  yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
  yield* fs.writeFileString(serverEntryPath, input.serverEntrySource ?? "console.log('server');\n");
  yield* fs.writeFileString(nativePath, "native-binary");

  const generatedAsarPath = path.join(tempDir, WINDOWS_SERVER_ASAR_RESOURCE);
  yield* packWindowsServerAsar({ sourceDir, asarPath: generatedAsarPath, arch: "x64" });

  const stageDistDir = path.join(tempDir, "dist");
  const packagedAppDir = path.join(stageDistDir, "win-unpacked");
  const resourcesDir = path.join(packagedAppDir, "resources");
  yield* fs.makeDirectory(path.join(resourcesDir, "resource-monitor"), { recursive: true });
  yield* fs.copyFile(generatedAsarPath, path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE));
  if (input.copyUnpackedNatives) {
    yield* fs.copy(
      `${generatedAsarPath}.unpacked`,
      path.join(resourcesDir, `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked`),
    );
  }
  yield* fs.writeFileString(
    path.join(resourcesDir, "resource-monitor/t3-resource-monitor.exe"),
    "monitor",
  );
  const appExecutableName = "t3code.exe";
  yield* fs.writeFileString(path.join(packagedAppDir, appExecutableName), "electron");
  yield* fs.writeFileString(path.join(packagedAppDir, "chrome_crashpad_handler.exe"), "crashpad");

  if (input.wslRuntime !== undefined) {
    const stem = wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, input.targetArch ?? "x64");
    const sourceArchivePath =
      input.wslRuntime === "loose-server-tree"
        ? // The old hand-rolled runtime: apps/server/dist + node_modules at the
          // archive root, no single stem directory, no `t3` executable.
          yield* makeLinuxCliArchiveFixture({
            root: path.join(tempDir, "wsl-runtime"),
            stem: "apps",
            omitMembers: ["apps/t3", "apps/client/index.html"],
            extraMembers: ["apps/server/dist/bin.mjs", "node_modules/node-pty/package.json"],
          })
        : yield* makeLinuxCliArchiveFixture({
            root: path.join(tempDir, "wsl-runtime"),
            stem,
            ...(input.wslRuntime === "missing-pty" || input.ptyPrebuildArch !== undefined
              ? { omitMembers: [`${stem}/node_modules/node-pty/build/Release/pty.node`] }
              : {}),
            ...(input.ptyPrebuildArch !== undefined
              ? {
                  extraMembers: [
                    `${stem}/node_modules/node-pty/prebuilds/linux-${input.ptyPrebuildArch}/pty.node`,
                  ],
                }
              : {}),
          });
    const archivePath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_NAME);
    const hashPath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_HASH_NAME);
    yield* stageWslRuntimeArchive({ sourceArchivePath, archivePath, hashPath });
    if (input.wslRuntime === "bad-digest") {
      yield* fs.writeFileString(hashPath, `${"0".repeat(64)}\n`);
    }
  }

  return {
    stageDistDir,
    packagedAppDir,
    sourceDir,
    generatedAsarPath,
    appExecutableName,
  } as const;
});

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "T3 Code (Alpha)");
    assert.equal(resolveDesktopProductName("0.0.17", true), "OOP");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "T3 Code (Nightly)");
  });

  it("switches desktop packaging icons to the nightly artwork for nightly versions", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17", true), {
      macIconPng: "assets/oop/oop-macos-1024.png",
      linuxIconPng: "assets/oop/oop-macos-1024.png",
      windowsIconIco: "assets/oop/oop-windows.ico",
    });
    assert.equal(resolveDesktopWebAssetBrand("0.0.17", true), "oop");

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("switches the bundled splash and favicon branding for nightly versions", () => {
    assert.equal(resolveDesktopWebAssetBrand("0.0.17"), "production");
    assert.equal(resolveDesktopWebAssetBrand("0.0.17-nightly.20260413.42"), "nightly");
  });

  it.effect("resolves GitHub desktop publish config from Effect config", () =>
    Effect.gen(function* () {
      const latestConfig = yield* resolveGitHubPublishConfig("latest").pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
              },
            }),
          ),
        ),
      );
      const nightlyConfig = yield* resolveGitHubPublishConfig("nightly").pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_REPOSITORY: "pingdotgg/t3code",
              },
            }),
          ),
        ),
      );

      assert.deepStrictEqual(latestConfig, {
        provider: "github",
        owner: "pingdotgg",
        repo: "t3code",
        releaseType: "release",
      });
      assert.deepStrictEqual(nightlyConfig, {
        provider: "github",
        owner: "pingdotgg",
        repo: "t3code",
        releaseType: "prerelease",
        channel: "nightly",
      });
    }),
  );

  it.effect("omits update feeds for pull request preview builds", () =>
    Effect.gen(function* () {
      const preview = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.33-pr.8182.1",
        false,
        false,
        undefined,
        undefined,
      );
      const release = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.33",
        false,
        false,
        undefined,
        undefined,
      );

      const previewChannel = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.41-preview.20260912.1589",
        false,
        false,
        undefined,
        undefined,
      );

      assert.notProperty(preview, "publish");
      assert.notProperty(previewChannel, "publish");
      assert.deepStrictEqual(release.publish, [
        {
          provider: "github",
          owner: "pingdotgg",
          repo: "t3code",
          releaseType: "release",
        },
      ]);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "pingdotgg/t3code" } }),
        ),
      ),
    ),
  );

  it("stages only the desktop main-process externals", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@clerk/electron": "catalog:",
          "@clerk/electron-passkeys": "catalog:",
          "@crowecawcaw/xa11y": "0.13.0",
          "@effect/platform-node": "catalog:",
          "@napi-rs/keyring": "^1.3.0",
          "@t3tools/contracts": "workspace:*",
          "@t3tools/shared": "workspace:*",
          "dbus-next": "0.10.2",
          effect: "catalog:",
          electron: "41.5.0",
          "electron-updater": "^6.6.2",
          "ffi-rs": "1.3.2",
          "playwright-core": "1.60.0",
        },
        {
          "@clerk/electron": "0.0.37",
          "@clerk/electron-passkeys": "0.0.3",
          "@effect/platform-node": "4.0.0-beta.59",
          effect: "4.0.0-beta.59",
        },
      ),
      {
        "@clerk/electron-passkeys": "0.0.3",
        "@crowecawcaw/xa11y": "0.13.0",
        "@napi-rs/keyring": "^1.3.0",
        "ffi-rs": "1.3.2",
        "playwright-core": "1.60.0",
      },
    );
  });

  it("carries only staged dependency patch metadata into staged desktop installs", () => {
    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
          "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "alchemy@2.0.0-beta.49": "patches/alchemy@2.0.0-beta.49.patch",
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        {
          "@ff-labs/fff-node": "0.9.4",
          "@pierre/diffs": "1.1.20",
          effect: "4.0.0-beta.73",
        },
      ),
      {
        "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
        "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
        "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
      },
    );

    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
        },
        { effect: "4.0.0-beta.73" },
      ),
      {},
    );
  });

  it("installs optional native dependencies for the target desktop architecture", () => {
    assert.deepStrictEqual(STAGE_INSTALL_ARGS, ["install", "--prod"]);
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "x64" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["x64"],
      },
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "linux", arch: "x64" }), {
      supportedArchitectures: {
        os: ["linux"],
        cpu: ["x64"],
        libc: ["glibc"],
      },
    });
    // Windows stages only win32 natives; WSL runs the separately built Linux
    // CLI archive rather than anything installed here.
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "win", arch: "x64" }), {
      supportedArchitectures: {
        os: ["win32"],
        cpu: ["x64"],
      },
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "win", arch: "arm64" }), {
      supportedArchitectures: {
        os: ["win32"],
        cpu: ["arm64"],
      },
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "universal" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["arm64", "x64"],
      },
    });
  });

  it("stages pnpm 11 allowBuilds and patchedDependencies in the workspace yaml", () => {
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: "linux",
        arch: "x64",
        allowBuilds: {
          electron: true,
          "node-pty": true,
          "browser-tabs-lock": false,
        },
        patchedDependencies: {
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        overrides: {
          effect: "4.0.0-beta.73",
        },
      }),
      {
        supportedArchitectures: {
          os: ["linux"],
          cpu: ["x64"],
          libc: ["glibc"],
        },
        allowBuilds: {
          electron: true,
          "node-pty": true,
          "browser-tabs-lock": false,
        },
        patchedDependencies: {
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        overrides: {
          effect: "4.0.0-beta.73",
        },
      },
    );

    // Empty maps must not be written — pnpm would still require reviewed
    // packages if allowBuilds is present but incomplete, and omitting empty
    // patchedDependencies keeps the stage yaml minimal.
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: "mac",
        arch: "arm64",
        allowBuilds: {},
        patchedDependencies: {},
        overrides: {},
      }),
      {
        supportedArchitectures: {
          os: ["darwin"],
          cpu: ["arm64"],
        },
      },
    );
  });

  it("limits Electron locales and excludes separately packaged resources", () => {
    assert.deepStrictEqual(DESKTOP_ELECTRON_LANGUAGES, ["en-US"]);
    // Every platform staging input is emitted once at resources/, so adding one
    // without its exclusion silently packs a second copy into app.asar. The
    // snapshot below cannot catch that on its own: adding a resource and
    // forgetting the exclusion leaves the exclusion list untouched, so it still
    // matches. Assert the invariant first, where the failure names the culprit.
    for (const resource of [
      ...WSL_RUNTIME_EXTRA_RESOURCES,
      ...LINUX_BROWSER_SECRET_EXTRA_RESOURCES,
    ]) {
      assert.include(
        DESKTOP_FILE_EXCLUSIONS,
        `!${resource.from}`,
        `${resource.from} ships via extraResources and must be excluded from app.asar`,
      );
    }

    assert.deepStrictEqual(DESKTOP_FILE_EXCLUSIONS, [
      "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
      "!**/*.map",
      "!**/*.d.cts",
      "!apps/desktop/resources/browser-secret",
      "!apps/desktop/resources/browser-secret/**/*",
      "!apps/desktop/prod-resources/browser-secret",
      "!apps/desktop/prod-resources/browser-secret/**/*",
      "!apps/desktop/prod-resources/windows-server",
      "!apps/desktop/prod-resources/windows-server/**/*",
      "!apps/desktop/prod-resources/wsl-runtime.tar.gz",
      "!apps/desktop/prod-resources/wsl-runtime.tar.gz.sha256",
      "!apps/desktop/gnome-extension",
      "!apps/desktop/gnome-extension/**/*",
    ]);
    assert.equal(WINDOWS_SERVER_RESOURCE_SOURCE_DIR, "apps/desktop/prod-resources/windows-server");
    assert.deepStrictEqual(WINDOWS_SERVER_EXTRA_RESOURCES, [
      {
        from: "apps/desktop/prod-resources/windows-server",
        to: ".",
        filter: ["server.asar", "server.asar.unpacked/**/*"],
      },
    ]);
  });

  it.effect("applies platform-specific packaging to the build config", () =>
    Effect.gen(function* () {
      const mac = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );
      const linux = yield* createBuildConfig(
        "linux",
        "AppImage",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );
      const win = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        true,
      );
      const winWithoutWslRuntime = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        false,
      );

      // Windows unpacks native files explicitly so their JavaScript and metadata
      // stay archived. Other platforms retain electron-builder's defaults.
      assert.notProperty(mac, "asar");
      assert.notProperty(linux, "asar");
      assert.notProperty(mac, "asarUnpack");
      assert.notProperty(linux, "asarUnpack");
      assert.deepStrictEqual(win.asar, { smartUnpack: false });
      assert.deepStrictEqual(win.asarUnpack, [WINDOWS_NATIVE_ASAR_UNPACK_GLOB]);
      assert.deepStrictEqual(winWithoutWslRuntime.asar, win.asar);
      assert.deepStrictEqual(winWithoutWslRuntime.asarUnpack, win.asarUnpack);
      assert.deepStrictEqual(mac.extraResources, DESKTOP_EXTRA_RESOURCES);
      assert.deepStrictEqual(linux.extraResources, [
        ...DESKTOP_EXTRA_RESOURCES,
        ...LINUX_CAPTURE_EXTRA_RESOURCES,
        { from: "apps/desktop/prod-resources/browser-secret", to: "browser-secret" },
      ]);
      assert.deepStrictEqual(win.extraResources, [
        {
          from: "apps/desktop/prod-resources/resource-monitor",
          to: "resource-monitor",
        },
        ...WINDOWS_SERVER_EXTRA_RESOURCES,
        ...WSL_RUNTIME_EXTRA_RESOURCES,
      ]);
      // No Linux CLI archive means staging never writes the runtime, so
      // listing it here would fail the build on a missing source file.
      assert.deepStrictEqual(winWithoutWslRuntime.extraResources, [
        {
          from: "apps/desktop/prod-resources/resource-monitor",
          to: "resource-monitor",
        },
        ...WINDOWS_SERVER_EXTRA_RESOURCES,
      ]);
      assert.deepStrictEqual(win.nsis, { differentialPackage: true });
      // The Claude SDK platform packages and .bin shims never ship.
      assert.deepStrictEqual(WINDOWS_SERVER_ASAR_IGNORE_GLOBS, [
        "**/node_modules/@anthropic-ai/claude-agent-sdk-*",
        "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
        "**/node_modules/.bin",
        "**/node_modules/.bin/**",
        "**/*.map",
      ]);
      assert.deepStrictEqual(mac.dmg, {
        title: "T3 Code (Alpha) 1.2.3 Installer",
        background: "dmg/dmg-background-latest.png",
        window: { width: 640, height: 432 },
        contents: [
          { x: 166, y: 214, type: "file" },
          { x: 474, y: 214, type: "link", path: "/Applications" },
        ],
        iconSize: 120,
        iconTextSize: 12,
      });
      // A Linux AppImage build also emits the .deb from the same run.
      assert.deepStrictEqual((linux.linux as Record<string, unknown>).target, ["AppImage", "deb"]);
      // Linux must register the renderer schemes so the generated .desktop
      // entry advertises MimeType=x-scheme-handler/t3code; for OAuth deep links.
      assert.deepStrictEqual((linux.linux as Record<string, unknown>).protocols, [
        { name: "T3 Code", schemes: ["t3code", "t3code-dev"] },
      ]);
      assert.deepStrictEqual(mac.files, [...DESKTOP_FILE_EXCLUSIONS, ...MAC_FILE_EXCLUSIONS]);
      assert.deepStrictEqual(linux.files, [...DESKTOP_FILE_EXCLUSIONS, ...LINUX_FILE_EXCLUSIONS]);
      assert.deepStrictEqual(win.files, DESKTOP_FILE_EXCLUSIONS);
      assert.deepStrictEqual(winWithoutWslRuntime.files, win.files);
      assert.notProperty(mac.mac as Record<string, unknown>, "sign");
      assert.equal((mac.mac as Record<string, unknown>).identity, "-");
      assert.equal((mac.mac as Record<string, unknown>).hardenedRuntime, false);
      for (const config of [linux, win]) {
        assert.deepStrictEqual(config.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
      }
      assert.deepStrictEqual(mac.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("brands an OOP macOS package while preserving its protocol identity", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        false,
        "arm64",
        true,
      );
      assert.equal(config.productName, "OOP");
      assert.equal(config.artifactName, "OOP-${version}-${arch}.${ext}");
      assert.equal(config.appId, "com.t3tools.t3code");
      assert.deepStrictEqual(config.dmg, {
        title: "OOP 1.2.3 Installer",
        background: "dmg/dmg-background-oop.png",
        window: { width: 640, height: 432 },
        contents: [
          { x: 166, y: 214, type: "file" },
          { x: 474, y: 214, type: "link", path: "/Applications" },
        ],
        iconSize: 120,
        iconTextSize: 12,
      });
      assert.deepStrictEqual((config.mac as { protocols: unknown }).protocols, [
        { name: "OOP", schemes: ["t3code", "t3code-dev"] },
      ]);
    }),
  );

  it.effect("accepts only bounded absolute OOP local update directories", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveOopLocalUpdateDirectory(undefined), undefined);
      const directory = `/Volumes/Updates/${"a".repeat(1007)}`;
      assert.equal(yield* resolveOopLocalUpdateDirectory(directory), directory);
      assert.equal(yield* resolveOopLocalUpdateDirectory("/tmp/old/../updates"), "/tmp/updates");
      assert.equal(
        renderOopLocalUpdateConfig(`/Volumes/한글/"quoted"`),
        '{"directory":"/Volumes/한글/\\"quoted\\""}\n',
      );

      for (const [value, reason] of [
        ["", "empty"],
        ["relative/updates", "not-absolute"],
        [`/${"a".repeat(1024)}`, "too-long"],
        ["/Volumes/up\0dates", "nul-byte"],
      ] as const) {
        const error = yield* Effect.flip(resolveOopLocalUpdateDirectory(value));
        assert.instanceOf(error, InvalidOopLocalUpdateDirectoryError);
        assert.equal(error.reason, reason);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts Google Drive candidate patterns before the single update folder", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveOopLocalUpdateCandidates(undefined), undefined);
      assert.equal(yield* resolveOopLocalUpdateCandidates("  "), undefined);
      const drive = [
        "~/Library/CloudStorage/GoogleDrive-*/My Drive/OOP/release/macos",
        "~/Library/CloudStorage/GoogleDrive-*/내 드라이브/OOP/release/macos",
      ];
      const driveJson =
        '["~/Library/CloudStorage/GoogleDrive-*/My Drive/OOP/release/macos","~/Library/CloudStorage/GoogleDrive-*/내 드라이브/OOP/release/macos"]';
      assert.deepEqual(yield* resolveOopLocalUpdateCandidates(driveJson), drive);
      assert.equal(
        renderOopLocalUpdateConfig("/Volumes/oop/release/macos", "smb://nas/oop", {
          directories: drive,
          folderKind: "google-drive",
        }),
        `{"directories":${driveJson},"directory":"/Volumes/oop/release/macos","folderKind":"google-drive","connectUrl":"smb://nas/oop"}\n`,
      );
      assert.equal(
        renderOopLocalUpdateConfig(undefined, undefined, { directories: drive }),
        `{"directories":${driveJson}}\n`,
      );
      for (const value of [
        "not json",
        "[]",
        '["relative/OOP"]',
        '["~/../etc"]',
        '["/Volumes/a*b*c/release"]',
        "[7]",
        '["/Volumes/up\\u0000dates"]',
      ]) {
        const error = yield* Effect.flip(resolveOopLocalUpdateCandidates(value));
        assert.instanceOf(error, InvalidOopLocalUpdateCandidatesError, value);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ships the local update config only in OOP macOS Resources", () =>
    Effect.gen(function* () {
      const configuration = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        false,
        "arm64",
        true,
        true,
      );
      const upstream = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        false,
        "arm64",
        false,
        true,
      );
      const unset = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        false,
        "arm64",
        true,
      );
      const linux = yield* createBuildConfig(
        "linux",
        "AppImage",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        false,
        "arm64",
        true,
        true,
      );
      const resource = {
        from: "apps/desktop/prod-resources/oop-local-update.json",
        to: "oop-local-update.json",
      };
      assert.deepStrictEqual(configuration.extraResources, [...DESKTOP_EXTRA_RESOURCES, resource]);
      assert.include(
        configuration.files as string[],
        "!apps/desktop/prod-resources/oop-local-update.json",
      );
      for (const config of [upstream, unset, linux]) {
        assert.notDeepInclude(config.extraResources as object[], resource);
        assert.notInclude(
          config.files as string[],
          "!apps/desktop/prod-resources/oop-local-update.json",
        );
      }
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("excludes foreign node-pty prebuilds from macOS and Linux packages", () => {
    assert.deepStrictEqual(MAC_FILE_EXCLUSIONS, [
      "!**/node_modules/node-pty/prebuilds/win32-*/**/*",
      "!**/node_modules/node-pty/third_party/conpty/**/*",
    ]);
    assert.deepStrictEqual(LINUX_FILE_EXCLUSIONS, [
      ...MAC_FILE_EXCLUSIONS,
      "!**/node_modules/node-pty/prebuilds/darwin-*/**/*",
    ]);
  });

  it("unpacks native binaries while keeping their JavaScript and metadata archived", () => {
    for (const file of [
      "node_modules/@napi-rs/keyring/keyring.win32-x64-msvc.node",
      "node_modules/@clerk/electron-passkeys/electron-passkeys.win32-x64-msvc.node",
      "node_modules/@ff-labs/fff-bin-win32-x64/fff_c.dll",
      "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
      "node_modules/native/addon.so",
      "node_modules/native/addon.so.1",
      "node_modules/native/addon.dylib",
    ]) {
      assert.isTrue(
        NodePath.matchesGlob(file, WINDOWS_NATIVE_ASAR_UNPACK_GLOB),
        `${file} must be available as a real file`,
      );
    }

    for (const file of [
      "node_modules/@napi-rs/keyring/index.js",
      "node_modules/@napi-rs/keyring/keytar.js",
      "node_modules/@clerk/electron-passkeys/index.js",
    ]) {
      assert.isFalse(
        NodePath.matchesGlob(file, WINDOWS_NATIVE_ASAR_UNPACK_GLOB),
        `${file} should remain inside the archive`,
      );
    }
  });

  it("stages only the externals of both bundles in merged packages", () => {
    assert.deepStrictEqual(
      resolveMergedStageDependencies({
        platform: "mac",
        serverDependencies: {
          "@anthropic-ai/claude-agent-sdk": "^0.3.170",
          "@ff-labs/fff-node": "0.9.4",
          "@opencode-ai/sdk": "^1.3.15",
          "@pierre/diffs": "1.3.0",
          "node-pty": "1.1.0",
        },
        desktopDependencies: {
          "@napi-rs/keyring": "1.3.0",
          "playwright-core": "1.60.0",
        },
        arch: "arm64",
        fffNodeVersion: "0.9.4",
      }),
      {
        "@ff-labs/fff-node": "0.9.4",
        "node-pty": "1.1.0",
        "@napi-rs/keyring": "1.3.0",
        "playwright-core": "1.60.0",
        "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      },
    );

    assert.deepStrictEqual(
      resolveMergedStageDependencies({
        platform: "linux",
        serverDependencies: { "@ff-labs/fff-node": "0.9.4", "node-pty": "1.1.0", effect: "4.0.0" },
        desktopDependencies: { "@crowecawcaw/xa11y": "0.13.0" },
        arch: "x64",
        fffNodeVersion: "0.9.4",
      }),
      {
        "@ff-labs/fff-node": "0.9.4",
        "node-pty": "1.1.0",
        "@crowecawcaw/xa11y": "0.13.0",
        "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
        "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
      },
    );
  });

  it("excludes node-pty binaries for the other Windows architecture", () => {
    assert.deepStrictEqual(resolveWindowsServerAsarIgnoreGlobs("x64"), [
      ...WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
      "**/node_modules/node-pty/prebuilds/win32-arm64",
      "**/node_modules/node-pty/prebuilds/win32-arm64/**",
      "**/node_modules/node-pty/third_party/conpty/*/win10-arm64",
      "**/node_modules/node-pty/third_party/conpty/*/win10-arm64/**",
    ]);
    assert.deepStrictEqual(resolveWindowsServerAsarIgnoreGlobs("arm64"), [
      ...WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
      "**/node_modules/node-pty/prebuilds/win32-x64",
      "**/node_modules/node-pty/prebuilds/win32-x64/**",
      "**/node_modules/node-pty/third_party/conpty/*/win10-x64",
      "**/node_modules/node-pty/third_party/conpty/*/win10-x64/**",
    ]);
  });

  it.effect("keeps target native files while excluding the other Windows architecture", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-windows-architecture-test-",
        });
        const sourceDir = path.join(tempDir, "server");
        const nativeFiles = [
          "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
          "node_modules/node-pty/prebuilds/win32-arm64/conpty/OpenConsole.exe",
          "node_modules/node-pty/third_party/conpty/1.0.0/win10-x64/OpenConsole.exe",
          "node_modules/node-pty/third_party/conpty/1.0.0/win10-arm64/OpenConsole.exe",
        ];

        for (const nativeFile of nativeFiles) {
          const nativePath = path.join(sourceDir, nativeFile);
          yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
          yield* fs.writeFileString(nativePath, "native");
        }

        const asarPath = path.join(tempDir, "server.asar");
        yield* packWindowsServerAsar({ sourceDir, asarPath, arch: "x64" });
        const unpackedRoot = `${asarPath}.unpacked`;

        assert.isTrue(
          yield* fs.exists(
            path.join(
              unpackedRoot,
              "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
            ),
          ),
        );
        assert.isFalse(
          yield* fs.exists(path.join(unpackedRoot, "node_modules/node-pty/prebuilds/win32-arm64")),
        );
        assert.isFalse(
          yield* fs.exists(
            path.join(unpackedRoot, "node_modules/node-pty/third_party/conpty/1.0.0/win10-arm64"),
          ),
        );
      }),
    ),
  );

  it.effect("stages a cached resource monitor without invoking Cargo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-resource-monitor-cache-test-",
        });
        const binaryPath = path.join(
          repoRoot,
          "native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor",
        );
        const stageResourcesDir = path.join(repoRoot, "stage");
        yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "cached monitor");

        yield* stageResourceMonitor({
          repoRoot,
          stageResourcesDir,
          platform: "linux",
          arch: "x64",
          verbose: false,
        }).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true" },
              }),
            ),
          ),
        );

        assert.equal(
          yield* fs.readFileString(
            path.join(stageResourcesDir, "resource-monitor/t3-resource-monitor"),
          ),
          "cached monitor",
        );
      }),
    ),
  );

  it.effect("reports every missing Linux desktop build prerequisite with an install command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
          [];
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            commands.push(childProcess);
            const fails =
              childProcess.command === "cargo" ||
              childProcess.command === "rustc" ||
              childProcess.command === "pkg-config";
            return Effect.succeed(mockProcess(fails ? 1 : 0));
          }),
        );

        const error = yield* preflightLinuxDesktopBuild("arm64").pipe(
          Effect.provide(spawner),
          Effect.flip,
        );

        assert.instanceOf(error, LinuxDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["cargo", "rust-target", "libsecret"]);
        assert.include(error.message, "Rust compiler and Cargo (cargo, rustc)");
        assert.include(error.message, "Requested Rust standard library");
        assert.include(
          error.message,
          "sudo apt-get install cargo rustc libsecret-1-dev pkg-config",
        );
        assert.include(error.message, "rustup target add aarch64-unknown-linux-gnu");
        assert.isTrue(
          commands.some(
            (command) =>
              command.command === "rustc" && command.args.includes("aarch64-unknown-linux-gnu"),
          ),
        );
      }),
    ),
  );

  it.effect("reports missing macOS tools and Rust targets before building", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            const fails =
              childProcess.command === "rustc" ||
              (childProcess.command === "xcrun" && childProcess.args.includes("iconutil"));
            return Effect.succeed(mockProcess(fails ? 1 : 0));
          }),
        );
        const error = yield* preflightMacDesktopBuild("universal").pipe(
          Effect.provide(spawner),
          Effect.flip,
        );

        assert.instanceOf(error, MacDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["rust", "iconutil"]);
        assert.deepStrictEqual(error.rustTargets, ["aarch64-apple-darwin", "x86_64-apple-darwin"]);
        assert.include(error.message, "xcode-select --install");
        assert.include(error.message, "rustup target add aarch64-apple-darwin x86_64-apple-darwin");
      }),
    ),
  );

  it.effect("reports missing Windows toolchain capabilities before building", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-windows-preflight-" });
        const pythonPath = path.join(tempDir, "python.exe");
        yield* fs.writeFileString(pythonPath, "python");
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as { readonly command: string };
            const fails =
              childProcess.command === "rustc" ||
              childProcess.command === "powershell.exe" ||
              childProcess.command === pythonPath;
            return Effect.succeed(mockProcess(fails ? 1 : 0));
          }),
        );
        const error = yield* preflightWindowsDesktopBuild({
          arch: "x64",
          bundlesWslRuntime: true,
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { npm_config_python: pythonPath } }),
              ),
            ),
          ),
          Effect.flip,
        );

        assert.instanceOf(error, WindowsDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["rust", "python", "msvc"]);
        assert.equal(error.rustTarget, "x86_64-pc-windows-msvc");
        assert.include(error.message, "Visual Studio Build Tools components");
      }),
    ),
  );

  it.effect("does not require MSVC when reusing a prebuilt Windows resource monitor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-windows-preflight-" });
        const pythonPath = path.join(tempDir, "python.exe");
        yield* fs.writeFileString(pythonPath, "python");
        const commands: string[] = [];
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as { readonly command: string };
            commands.push(childProcess.command);
            return Effect.succeed(mockProcess(childProcess.command === "powershell.exe" ? 1 : 0));
          }),
        );

        yield* preflightWindowsDesktopBuild({
          arch: "x64",
          bundlesWslRuntime: true,
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    npm_config_python: pythonPath,
                    T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true",
                  },
                }),
              ),
            ),
          ),
        );

        assert.notInclude(commands, "powershell.exe");
      }),
    ),
  );

  it.effect("rejects a PATH-discovered Python executable that is not Python 3", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-python2-preflight-" });
        const pythonPath = path.join(tempDir, "python");
        yield* fs.writeFileString(pythonPath, "python2");
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            if (childProcess.command === "python") {
              return Effect.succeed(mockProcess(0, `${pythonPath}\n`));
            }
            if (childProcess.command === pythonPath) {
              return Effect.succeed(mockProcess(1));
            }
            return Effect.succeed(mockProcess(0));
          }),
        );
        const error = yield* preflightWindowsDesktopBuild({
          arch: "x64",
          bundlesWslRuntime: false,
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: { T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true" },
                }),
              ),
            ),
          ),
          Effect.flip,
        );

        assert.instanceOf(error, WindowsDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["python"]);
      }),
    ),
  );

  it.effect("builds and stages native capture helpers for each Linux architecture", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kde-stage-test-" });
        const protocols = path.join(repoRoot, "native/hyprland-snap-shot/protocols");
        yield* fs.makeDirectory(protocols, { recursive: true });
        yield* fs.writeFileString(path.join(protocols, "capture.xml"), "BSD protocol notice");
        for (const backend of ["kde", "hyprland"] as const) {
          for (const [arch, target] of [
            ["x64", "x86_64-unknown-linux-gnu"],
            ["arm64", "aarch64-unknown-linux-gnu"],
          ] as const) {
            const binary = path.join(
              repoRoot,
              `native/${backend}-snap-shot/target`,
              target,
              `release/t3-${backend}-snap-shot`,
            );
            const stageResourcesDir = path.join(repoRoot, "stage", backend, arch);
            const spawner = Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((command) =>
                Effect.gen(function* () {
                  assert.equal(command._tag, "StandardCommand");
                  if (command._tag !== "StandardCommand") return mockProcess(1);
                  assert.equal(command.command, "cargo");
                  assert.deepEqual(command.args, [
                    "build",
                    "--locked",
                    "--release",
                    "--manifest-path",
                    path.join(repoRoot, `native/${backend}-snap-shot/Cargo.toml`),
                    "--target",
                    target,
                  ]);
                  yield* fs.makeDirectory(path.dirname(binary), { recursive: true });
                  yield* fs.writeFileString(binary, `helper-${arch}`);
                  return mockProcess(0);
                }),
              ),
            );
            yield* stageLinuxCaptureHelper({
              backend,
              repoRoot,
              stageResourcesDir,
              arch,
              verbose: false,
            }).pipe(Effect.provide(spawner));
            const installed = path.join(
              stageResourcesDir,
              `${backend}-capture/t3-${backend}-snap-shot`,
            );
            assert.equal(yield* fs.readFileString(installed), `helper-${arch}`);
            assert.equal((yield* fs.stat(installed)).mode & 0o777, 0o755);
            if (backend === "hyprland")
              assert.equal(
                yield* fs.readFileString(
                  path.join(stageResourcesDir, "hyprland-capture/protocols/capture.xml"),
                ),
                "BSD protocol notice",
              );
          }
        }
      }),
    ),
  );

  // The fixture's t3code.exe is a text placeholder, not an executable. These
  // cases reach the native-load probe, so pin only that host-platform check to
  // Linux. Host-native paths and the real Windows tar/archive checks still run.
  it.effect("validates every ASAR-unpacked native in the packaged Windows payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const result = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        const secondAsarPath = path.join(path.dirname(fixture.generatedAsarPath), "second.asar");
        yield* packWindowsServerAsar({
          sourceDir: fixture.sourceDir,
          asarPath: secondAsarPath,
          arch: "x64",
        });
        const [firstAsar, secondAsar] = yield* Effect.all([
          fs.readFile(fixture.generatedAsarPath),
          fs.readFile(secondAsarPath),
        ]);

        assert.equal(result.packagedAppDir, fixture.packagedAppDir);
        assert.deepStrictEqual(result.unpackedFiles, ["node_modules/native/addon.node"]);
        assert.isBelow(result.fileCount, WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT);
        assert.deepStrictEqual(secondAsar, firstAsar);
      }),
    ).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("accepts an embedded Linux CLI release archive with a matching digest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "valid",
        });
        const result = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        });

        assert.equal(result.packagedAppDir, fixture.packagedAppDir);
      }),
    ).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );

  for (const targetArch of ["x64", "arm64"] as const) {
    it.effect(`accepts an embedded archive with the Linux ${targetArch} node-pty prebuild`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeWindowsPayloadFixture({
            copyUnpackedNatives: true,
            wslRuntime: "valid",
            targetArch,
            ptyPrebuildArch: targetArch,
          });
          const result = yield* validateWindowsPackagedPayload({
            stageDistDir: fixture.stageDistDir,
            appExecutableName: fixture.appExecutableName,
            targetArch,
            appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
            expectWslRuntime: true,
          });

          assert.equal(result.packagedAppDir, fixture.packagedAppDir);
        }),
      ).pipe(Effect.provideService(HostProcessPlatform, "linux")),
    );

    it.effect(
      `rejects a node-pty prebuild for the wrong architecture in a Linux ${targetArch} archive`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* makeWindowsPayloadFixture({
              copyUnpackedNatives: true,
              wslRuntime: "valid",
              targetArch,
              ptyPrebuildArch: targetArch === "x64" ? "arm64" : "x64",
            });
            const error = yield* validateWindowsPackagedPayload({
              stageDistDir: fixture.stageDistDir,
              appExecutableName: fixture.appExecutableName,
              targetArch,
              appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
              expectWslRuntime: true,
            }).pipe(Effect.flip);

            assert.instanceOf(error, WindowsPackagedPayloadValidationError);
            assert.equal(error.reason, "wsl-runtime-invalid");
          }),
        ),
    );
  }

  it.effect("rejects an embedded archive built for a different release version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "valid",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: "9.9.9",
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
      }),
    ),
  );

  it.effect("rejects a Windows package missing its expected WSL runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-missing");
      }),
    ),
  );

  it.effect("rejects a loose server tree that is not a Linux CLI release archive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "loose-server-tree",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
      }),
    ),
  );

  it.effect("rejects an embedded archive without the Linux node-pty binary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "missing-pty",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
        assert.deepStrictEqual(error.missingFiles, [
          `${wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, "x64")}/node_modules/node-pty/build/Release/pty.node`,
          `${wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, "x64")}/node_modules/node-pty/prebuilds/linux-x64/pty.node`,
        ]);
      }),
    ),
  );

  it.effect("rejects an emitted WSL archive whose sidecar digest does not match", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "bad-digest",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
      }),
    ),
  );

  it.effect("probes fff through the packaged Windows primary instead of helper executables", () => {
    const commands: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: {
        readonly cwd?: string;
        readonly env?: Readonly<Record<string, string | undefined>>;
      };
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        const primaryProbe = commands.find(
          (command) => command.options.env?.ELECTRON_RUN_AS_NODE === "1",
        );
        if (primaryProbe === undefined) return assert.fail("Windows primary probe was not spawned");

        assert.equal(
          primaryProbe.command,
          path.join(fixture.packagedAppDir, fixture.appExecutableName),
        );
        assert.deepStrictEqual(primaryProbe.args.slice(0, 3), [
          "--no-global-search-paths",
          "--input-type=module",
          "--eval",
        ]);
        assert.include(primaryProbe.args[3], "FileFinder.create");
        assert.equal(
          primaryProbe.args[4],
          path.join(
            fixture.packagedAppDir,
            "resources/server.asar/node_modules/@ff-labs/fff-node/dist/src/index.js",
          ),
        );
        assert.equal(primaryProbe.options.cwd, fixture.packagedAppDir);
        assert.equal(primaryProbe.options.env?.NODE_PATH, "");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcessPlatform, "win32"),
          Layer.succeed(HostProcessArchitecture, "x64"),
        ),
      ),
    );
  });

  it.effect("builds the Linux browser secret helper for a concrete architecture", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.gen(function* () {
      // `universal` is a mac-only arch the option type still admits. The helper
      // script only knows x64 and arm64, so the request maps to x64, the same
      // concrete target the Linux resource monitor resolves it to.
      yield* stageBrowserSecret({
        repoRoot: "/repo",
        stageResourcesDir: "/stage/resources",
        platform: "linux",
        arch: "universal",
        verbose: false,
      });
      const helper = commands.find((command) =>
        command.args.some((arg) => arg.endsWith("build-browser-secret.mjs")),
      );
      assert.isDefined(helper);
      const path = yield* Path.Path;
      assert.deepStrictEqual(helper.args.slice(-4), [
        "--arch",
        "x64",
        "--output",
        path.join("/stage/resources", "browser-secret", "t3-browser-secret"),
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcessPlatform, "linux"),
          Layer.succeed(HostProcessArchitecture, "x64"),
        ),
      ),
    );
  });

  it.effect("refuses a Linux build on a host that cannot build the browser secret helper", () => {
    const commands: Array<{ readonly command: string }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.gen(function* () {
      // The helper links against the host's libsecret and its build script is
      // a no-op elsewhere, so a Linux artifact built on macOS would ship
      // without it and report the keyring as unavailable on every import.
      const error = yield* stageBrowserSecret({
        repoRoot: "/repo",
        stageResourcesDir: "/stage/resources",
        platform: "linux",
        arch: "x64",
        verbose: false,
      }).pipe(Effect.flip);
      assert.instanceOf(error, LinuxBrowserSecretHostError);
      assert.equal(error.hostPlatform, "darwin");
      assert.include(error.message, "Linux host");
      assert.lengthOf(commands, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcessPlatform, "darwin"),
          Layer.succeed(HostProcessArchitecture, "arm64"),
        ),
      ),
    );
  });

  it.effect("skips the primary native probe for cross-architecture Windows payloads", () => {
    const commands: Array<{
      readonly command: string;
      readonly options: {
        readonly env?: Readonly<Record<string, string | undefined>>;
      };
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        assert.isFalse(
          commands.some((command) => command.options.env?.ELECTRON_RUN_AS_NODE === "1"),
        );
        assert.isTrue(
          commands.some(
            (command) =>
              command.command === process.execPath && command.options.env?.NODE_PATH === "",
          ),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcessPlatform, "win32"),
          Layer.succeed(HostProcessArchitecture, "x64"),
        ),
      ),
    );
  });

  it.effect("rejects a cross-architecture Windows payload without its primary executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const executablePath = path.join(fixture.packagedAppDir, fixture.appExecutableName);
        yield* fs.remove(executablePath);

        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPrimaryNativeProbeError);
        assert.equal(error.executablePath, executablePath);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcessPlatform, "win32"),
          Layer.succeed(HostProcessArchitecture, "x64"),
        ),
      ),
    ),
  );

  it.effect("rejects a packaged sidecar whose ASAR-unpacked native is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: false });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "unpacked-native-missing");
        assert.deepStrictEqual(error.missingFiles, [
          "server.asar.unpacked/node_modules/native/addon.node",
        ]);
      }),
    ),
  );

  it.effect("rejects directories in place of packaged executable files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const nativePath = path.join(
          fixture.packagedAppDir,
          "resources/server.asar.unpacked/node_modules/native/addon.node",
        );
        yield* fs.remove(nativePath);
        yield* fs.makeDirectory(nativePath);

        const nativeError = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);
        assert.instanceOf(nativeError, WindowsPackagedPayloadValidationError);
        assert.equal(nativeError.reason, "unpacked-native-missing");
        assert.deepStrictEqual(nativeError.missingFiles, [
          "server.asar.unpacked/node_modules/native/addon.node",
        ]);

        yield* fs.remove(nativePath, { recursive: true });
        yield* fs.writeFileString(nativePath, "native-binary");
        const resourceMonitorPath = path.join(
          fixture.packagedAppDir,
          "resources/resource-monitor/t3-resource-monitor.exe",
        );
        yield* fs.remove(resourceMonitorPath);
        yield* fs.makeDirectory(resourceMonitorPath);

        const resourceMonitorError = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);
        assert.instanceOf(resourceMonitorError, WindowsPackagedPayloadValidationError);
        assert.equal(resourceMonitorError.reason, "resource-monitor-missing");
        assert.deepStrictEqual(resourceMonitorError.missingFiles, [
          "resource-monitor/t3-resource-monitor.exe",
        ]);
      }),
    ),
  );

  it.effect("rejects a Windows payload that regresses above the file-count budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          fileLimit: 2,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "file-limit-exceeded");
        assert.isAbove(error.fileCount ?? 0, 2);
      }),
    ),
  );

  it.effect("rejects a sidecar whose extracted server bundle cannot resolve", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          serverEntrySource: 'import "t3code-deliberately-missing-package";\n',
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, BundleNotSelfContainedError);
        assert.include(error.output, "t3code-deliberately-missing-package");
      }),
    ).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("preserves both Linux icon resize failures with structural context", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const error = yield* stageLinuxIconSize("source.png", "target.png", 512, false).pipe(
        Effect.provide(iconResizeSpawnerLayer(commands, [1, 2])),
        Effect.flip,
      );

      assert.instanceOf(error, LinuxIconResizeError);
      assert.equal(error.operation, "resize");
      assert.equal(error.iconSize, 512);
      assert.equal(error.primaryTool, "magick");
      assert.equal(error.fallbackTool, "convert");
      assert.include(error.message, "512x512");
      assert.include(error.message, "`magick`");
      assert.include(error.message, "`convert`");
      assert.notInclude(error.message, "non-zero exit code");

      assert.instanceOf(error.cause, AggregateError);
      const aggregateCause = error.cause as AggregateError;
      assert.lengthOf(aggregateCause.errors, 2);
      assert.strictEqual(aggregateCause.cause, aggregateCause.errors[0]);
      assert.instanceOf(aggregateCause.errors[0], BuildCommandFailedError);
      assert.instanceOf(aggregateCause.errors[1], BuildCommandFailedError);
      const primaryError = aggregateCause.errors[0] as BuildCommandFailedError;
      const fallbackError = aggregateCause.errors[1] as BuildCommandFailedError;
      assert.equal(primaryError.command, "magick linux icon 512x512");
      assert.equal(primaryError.exitCode, 1);
      assert.include(primaryError.message, "magick linux icon");
      assert.equal(fallbackError.command, "convert linux icon 512x512");
      assert.equal(fallbackError.exitCode, 2);
      assert.include(fallbackError.message, "convert linux icon");
      assert.deepStrictEqual(
        commands.map(({ command }) => command),
        ["magick", "convert"],
      );
    });
  });

  it.effect("rasterizes staged DMG backgrounds at standard and Retina sizes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stageResourcesDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3code-dmg-background-",
        });
        const dmgDir = path.join(stageResourcesDir, "dmg");
        yield* fs.makeDirectory(dmgDir, { recursive: true });
        const sourcePath = path.join(dmgDir, "dmg-background-nightly.svg");
        yield* fs.writeFileString(sourcePath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
        const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
          [];

        yield* stageDesktopDmgBackground(stageResourcesDir, "nightly", false).pipe(
          Effect.provide(iconResizeSpawnerLayer(commands, [0, 0])),
        );

        assert.deepStrictEqual(
          commands.map((command) => [command.command, ...command.args]),
          [
            [
              "sips",
              "-s",
              "format",
              "png",
              "-z",
              "432",
              "640",
              sourcePath,
              "--out",
              path.join(dmgDir, "dmg-background-nightly.png"),
            ],
            [
              "sips",
              "-s",
              "format",
              "png",
              "-z",
              "864",
              "1280",
              sourcePath,
              "--out",
              path.join(dmgDir, "dmg-background-nightly@2x.png"),
            ],
          ],
        );
      }),
    ),
  );

  it.effect("fails clearly when the selected DMG background source is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stageResourcesDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3code-dmg-background-missing-",
        });

        const error = yield* stageDesktopDmgBackground(stageResourcesDir, "latest", false).pipe(
          Effect.flip,
        );

        assert.instanceOf(error, DesktopDmgBackgroundSourceMissingError);
        assert.equal(error.channel, "latest");
        assert.include(error.sourcePath, "dmg-background-latest.svg");
      }),
    ),
  );

  it("derives macOS passkey signing configuration from the Clerk publishable key", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      T3CODE_APPLE_TEAM_ID: "abc1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("example.clerk.accounts.dev$")}`,
    });

    assert.deepStrictEqual(configuration, {
      appId: "com.t3tools.t3code",
      teamId: "ABC1234567",
      rpDomains: ["example.clerk.accounts.dev"],
      provisioningProfilePath: "/tmp/t3code.provisionprofile",
    });
  });

  it("normalizes explicit macOS passkey RP domains and renders required entitlements", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS:
        " Clerk.Example.com,example.clerk.accounts.dev,clerk.example.com ",
    });
    const entitlements = renderMacPasskeyEntitlements(configuration);

    assert.deepStrictEqual(configuration.rpDomains, [
      "clerk.example.com",
      "example.clerk.accounts.dev",
    ]);
    assert.include(entitlements, "<string>ABC1234567.com.t3tools.t3code</string>");
    assert.include(entitlements, "<string>webcredentials:clerk.example.com</string>");
    assert.include(entitlements, "<string>webcredentials:example.clerk.accounts.dev</string>");
    assert.include(entitlements, "<key>com.apple.security.cs.allow-jit</key>");
  });

  it("rejects incomplete macOS passkey signing configuration", () => {
    const captureError = (env: Readonly<Record<string, string | undefined>>) => {
      try {
        resolveMacPasskeySigningConfiguration(env);
      } catch (error) {
        return error;
      }
      return assert.fail("Expected passkey signing configuration to fail.");
    };

    const missingProfileError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev",
    });
    assert.instanceOf(missingProfileError, MissingMacPasskeyProvisioningProfileError);
    assert.equal(
      missingProfileError.message,
      "T3CODE_MACOS_PROVISIONING_PROFILE must point to an Associated Domains provisioning profile.",
    );

    const unsafeDomain =
      "https://domain-user:domain-secret@example.clerk.accounts.dev/path?token=query-secret";
    const invalidDomainError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS: unsafeDomain,
    });
    assert.instanceOf(invalidDomainError, InvalidMacPasskeyRpDomainError);
    assert.equal(invalidDomainError.reason, "scheme-not-allowed");
    assert.equal(invalidDomainError.inputLength, unsafeDomain.length);
    assert.equal(invalidDomainError.message, "Invalid passkey RP domain (scheme-not-allowed).");
    assert.notProperty(invalidDomainError, "domain");
    assert.notProperty(invalidDomainError, "cause");
    const serializedInvalidDomainError = JSON.stringify(invalidDomainError);
    assert.notInclude(serializedInvalidDomainError, unsafeDomain);
    assert.notInclude(serializedInvalidDomainError, "domain-user");
    assert.notInclude(serializedInvalidDomainError, "domain-secret");
    assert.notInclude(serializedInvalidDomainError, "query-secret");
    assert.throws(
      () =>
        resolveMacPasskeySigningConfiguration({
          T3CODE_APPLE_TEAM_ID: "ABC1234567",
          T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
          T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev:8443",
        }),
      /Invalid passkey RP domain/u,
    );
    const invalidPublishableKeyError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_%",
    });
    assert.instanceOf(invalidPublishableKeyError, InvalidMacPasskeyPublishableKeyError);
    assert.ok(invalidPublishableKeyError.cause);
    assert.equal(invalidPublishableKeyError.message, "T3CODE_CLERK_PUBLISHABLE_KEY is invalid.");
    assert.notProperty(invalidPublishableKeyError, "publishableKey");
    assert.notInclude(invalidPublishableKeyError.message, "pk_test_%");
  });

  it("preserves known passkey signing configuration errors at the build boundary", () => {
    const decodingCause = new Error("publishable-key-decode-failed");
    const knownError = new InvalidMacPasskeyPublishableKeyError({ cause: decodingCause });
    const error = MacPasskeySigningConfigurationResolutionError.fromCause(knownError);

    assert.strictEqual(error, knownError);
    assert.instanceOf(error, InvalidMacPasskeyPublishableKeyError);
    assert.strictEqual(error.cause, decodingCause);
    assert.isTrue(isMacPasskeySigningConfigurationError(error));
  });

  it("wraps unknown passkey signing configuration defects without copying cause text", () => {
    const secret = "pk_test_do-not-retain";
    const cause = new Error(secret);
    const error = MacPasskeySigningConfigurationResolutionError.fromCause(cause);

    assert.instanceOf(error, MacPasskeySigningConfigurationResolutionError);
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message, "Failed to resolve macOS passkey signing configuration.");
    assert.notInclude(error.message, secret);
  });

  it.effect("adds passkey entitlements and both renderer protocols to signed macOS builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig("mac", "dmg", "1.2.3", true, false, undefined, {
        entitlementsPath: "/tmp/entitlements.mac.plist",
        provisioningProfilePath: "/tmp/t3code.provisionprofile",
      });

      const mac = config.mac as Record<string, unknown>;
      assert.equal(config.appId, "com.t3tools.t3code");
      assert.equal(mac.entitlements, "/tmp/entitlements.mac.plist");
      assert.equal(mac.provisioningProfile, "/tmp/t3code.provisionprofile");
      assert.match(String(mac.sign), /[\\/]scripts[\\/]sign-macos\.ts$/);
      assert.notProperty(mac, "identity");
      assert.notProperty(mac, "hardenedRuntime");
      assert.deepStrictEqual(mac.protocols, [
        { name: "T3 Code", schemes: ["t3code", "t3code-dev"] },
      ]);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("uses the nightly DMG background for nightly macOS builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3-nightly.20260815.1",
        false,
        false,
        undefined,
        undefined,
      );

      assert.equal(
        (config.dmg as Record<string, unknown>).background,
        "dmg/dmg-background-nightly.png",
      );
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("keeps executable resource editing enabled for unsigned Windows builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );

      const win = config.win as Record<string, unknown>;
      assert.equal(win.icon, "icon.ico");
      assert.equal(win.signAndEditExecutable, true);
      assert.notProperty(win, "azureSignOptions");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("stages the resource monitor as an external executable resource", () => {
    assert.deepStrictEqual(DESKTOP_EXTRA_RESOURCES, [
      {
        from: "apps/desktop/prod-resources/resource-monitor",
        to: "resource-monitor",
      },
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("mac", "universal"), [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("linux", "x64"), [
      "x86_64-unknown-linux-gnu",
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("win", "arm64"), [
      "aarch64-pc-windows-msvc",
    ]);
    assert.equal(resourceMonitorExecutableName("mac"), "t3-resource-monitor");
    assert.equal(resourceMonitorExecutableName("win"), "t3-resource-monitor.exe");
  });

  it("ships the Linux CLI release archive as the WSL runtime", () => {
    assert.equal(WSL_RUNTIME_ARCHIVE_NAME, "wsl-runtime.tar.gz");
    assert.equal(WSL_RUNTIME_ARCHIVE_HASH_NAME, "wsl-runtime.tar.gz.sha256");
    assert.deepStrictEqual(WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE, {
      from: "apps/desktop/prod-resources/wsl-runtime.tar.gz",
      to: "wsl-runtime.tar.gz",
    });
    assert.deepStrictEqual(WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE, {
      from: "apps/desktop/prod-resources/wsl-runtime.tar.gz.sha256",
      to: "wsl-runtime.tar.gz.sha256",
    });
    // Both the staging and the packaging config hang off this one decision:
    // Windows only, and only when CI handed the build a Linux CLI archive.
    const runtimeArchivePath = "/tmp/t3-1.2.3-linux-x64.tar.gz";
    assert.isTrue(bundlesWslRuntime({ platform: "win", runtimeArchivePath }));
    assert.isFalse(bundlesWslRuntime({ platform: "win", runtimeArchivePath: undefined }));
    assert.isFalse(bundlesWslRuntime({ platform: "linux", runtimeArchivePath }));
    assert.isFalse(bundlesWslRuntime({ platform: "mac", runtimeArchivePath }));
    assert.equal(wslRuntimeArchiveStem("1.2.3", "x64"), "t3-1.2.3-linux-x64");
  });

  it("parses Windows bsdtar member listings with CRLF line endings", () => {
    assert.deepStrictEqual(
      parseWslRuntimeArchiveMembers("./t3-1.2.3-linux-x64/t3\r\nt3-1.2.3-linux-x64/client/\r\n"),
      ["t3-1.2.3-linux-x64/t3", "t3-1.2.3-linux-x64/client"],
    );
  });

  it.effect("stages the Linux CLI archive verbatim with its SHA-256 sidecar", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wsl-runtime-stage-" });
        const sourceArchivePath = yield* makeLinuxCliArchiveFixture({
          root,
          stem: "t3-1.2.3-linux-x64",
        });
        const stageAppDir = path.join(root, "app");
        const archivePath = path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE.from);
        const hashPath = path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE.from);

        yield* stageWslRuntimeArchive({ sourceArchivePath, archivePath, hashPath });

        const [source, staged] = yield* Effect.all([
          fs.readFile(sourceArchivePath),
          fs.readFile(archivePath),
        ]);
        assert.deepStrictEqual(staged, source);
        // The digest both gates installation inside the distro and names the
        // extracted runtime's cache directory.
        const hash = yield* fs.readFileString(hashPath);
        assert.equal(hash, `${NodeCrypto.createHash("sha256").update(source).digest("hex")}\n`);
      }),
    ),
  );

  it.effect("fails when the Linux CLI archive handed to the build does not exist", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wsl-runtime-missing-" });
        const error = yield* stageWslRuntimeArchive({
          sourceArchivePath: path.join(root, "t3-1.2.3-linux-x64.tar.gz"),
          archivePath: path.join(root, WSL_RUNTIME_ARCHIVE_NAME),
          hashPath: path.join(root, WSL_RUNTIME_ARCHIVE_HASH_NAME),
        }).pipe(Effect.flip);

        assert.instanceOf(error, WslRuntimeArchiveMissingError);
      }),
    ),
  );

  it("promotes target fff binaries to direct staged dependencies", () => {
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "universal", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      "@ff-labs/fff-bin-darwin-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("win", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-win32-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-arm64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-arm64-musl": "0.9.4",
    });
  });

  it("resolves target Clerk passkey native artifacts", () => {
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("mac", "universal"), [
      {
        packageName: "@clerk/electron-passkeys-darwin-arm64",
        binaryFileName: "electron-passkeys.darwin-arm64.node",
      },
      {
        packageName: "@clerk/electron-passkeys-darwin-x64",
        binaryFileName: "electron-passkeys.darwin-x64.node",
      },
    ]);
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("win", "x64"), [
      {
        packageName: "@clerk/electron-passkeys-win32-x64-msvc",
        binaryFileName: "electron-passkeys.win32-x64-msvc.node",
      },
    ]);
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("linux", "x64"), []);
  });

  it("resolves keyring binaries for macOS, Windows, and Linux stage targets", () => {
    assert.deepStrictEqual(resolveKeyringNativeArtifacts("mac", "universal"), [
      {
        packageName: "@napi-rs/keyring-darwin-arm64",
        binaryFileName: "keyring.darwin-arm64.node",
      },
      {
        packageName: "@napi-rs/keyring-darwin-x64",
        binaryFileName: "keyring.darwin-x64.node",
      },
    ]);
    assert.deepStrictEqual(resolveKeyringNativeArtifacts("win", "x64"), [
      {
        packageName: "@napi-rs/keyring-win32-x64-msvc",
        binaryFileName: "keyring.win32-x64-msvc.node",
      },
    ]);
    assert.deepStrictEqual(resolveKeyringNativeArtifacts("linux", "arm64"), [
      {
        packageName: "@napi-rs/keyring-linux-arm64-gnu",
        binaryFileName: "keyring.linux-arm64-gnu.node",
      },
    ]);
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it("derives the electron-builder package manager user agent from packageManager", () => {
    assert.equal(resolvePackageManagerUserAgent("pnpm@11.10.0"), "pnpm/11.10.0");
    assert.equal(resolvePackageManagerUserAgent(" yarn@4.9.2 "), "yarn/4.9.2");
    assert.equal(resolvePackageManagerUserAgent("pnpm"), "pnpm");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it("classifies invalid configured ports with the decoder's number grammar", () => {
    const cause = new Error("invalid configured port");

    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).reason,
      "not-numeric",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("12.5", cause).reason,
      "not-integer",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("65536", cause).reason,
      "out-of-range",
    );
    assert.strictEqual(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).cause,
      cause,
    );
  });

  it.effect("resolves default platform and architecture from host references", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.none(),
        target: Option.none(),
        arch: Option.none(),
        buildVersion: Option.none(),
        outputDir: Option.none(),
        skipBuild: Option.none(),
        keepStage: Option.none(),
        signed: Option.none(),
        verbose: Option.none(),
        mockUpdates: Option.none(),
        mockUpdateServerPort: Option.none(),
        wslRuntime: Option.none(),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "win32"),
            Layer.succeed(HostProcessArchitecture, "x64"),
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  PROCESSOR_ARCHITECTURE: "AMD64",
                  PROCESSOR_ARCHITEW6432: "ARM64",
                },
              }),
            ),
          ),
        ),
      );

      assert.equal(resolved.platform, "win");
      assert.equal(resolved.target, "nsis");
      assert.equal(resolved.arch, "arm64");
    }),
  );

  it.effect("rejects universal builds on Linux and Windows before staging binaries", () =>
    Effect.gen(function* () {
      for (const platform of ["linux", "win"] as const) {
        const error = yield* Effect.flip(
          resolveBuildOptions({
            platform: Option.some(platform),
            target: Option.none(),
            arch: Option.some("universal"),
            buildVersion: Option.none(),
            outputDir: Option.none(),
            skipBuild: Option.none(),
            keepStage: Option.none(),
            signed: Option.none(),
            verbose: Option.none(),
            mockUpdates: Option.none(),
            mockUpdateServerPort: Option.none(),
            wslRuntime: Option.none(),
          }),
        );

        assert.instanceOf(error, UnsupportedDesktopBuildArchitectureError);
        assert.deepStrictEqual(error.supportedArchitectures, ["x64", "arm64"]);
      }
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
        wslRuntime: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
                T3CODE_DESKTOP_SIGNED: "true",
                T3CODE_DESKTOP_VERBOSE: "true",
                T3CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );

  // Signing-mode policy. These tests check how inputs are resolved and what
  // configuration is produced; none of them touches a keychain or runs codesign,
  // so they say nothing about which certificate really signs a bundle.
  const developerIdIdentity = "Developer ID Application: Example Holder (ABCDE12345)";
  const installerLeafPin = "a".repeat(64); // Synthetic fixture, not a real certificate pin.
  const otherInstallerLeafPin = "b".repeat(64);
  const legacyTrustMarker = "OOP_LOCAL_PKG_TRUST_V1:legacy-unsigned";
  const developerIdTrustMarker = `OOP_LOCAL_PKG_TRUST_V1:developer-id:ABCDE12345:${installerLeafPin}`;
  const developerIdEnv: Record<string, string> = {
    T3CODE_DESKTOP_BUILD_PROFILE_NAME: "oop-desktop",
    CSC_NAME: developerIdIdentity,
    T3CODE_APPLE_TEAM_ID: "ABCDE12345",
    T3CODE_MACOS_INSTALLER_LEAF_SHA256: installerLeafPin,
  };
  const envWith = (patch: Record<string, string | undefined>): Record<string, string> =>
    Object.fromEntries(
      Object.entries({ ...developerIdEnv, ...patch }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
  const baseBuildInput: Parameters<typeof resolveBuildOptions>[0] = {
    platform: Option.some("mac"),
    target: Option.none(),
    arch: Option.some("arm64"),
    buildVersion: Option.none(),
    outputDir: Option.none(),
    skipBuild: Option.none(),
    keepStage: Option.none(),
    signed: Option.none(),
    verbose: Option.none(),
    mockUpdates: Option.none(),
    mockUpdateServerPort: Option.none(),
    wslRuntime: Option.none(),
  };
  const resolveWithEnv = (
    input: Parameters<typeof resolveBuildOptions>[0],
    env: Record<string, string>,
  ) =>
    resolveBuildOptions(input).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    );
  const testRepoRoot = Effect.service(Path.Path).pipe(
    Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
  );
  // The candidate needs a caller-chosen output directory outside the repo.
  const privateOutputDir = NodePath.join(NodeOS.tmpdir(), "oop-candidate-private-output");
  const explicitDeveloperId = {
    ...baseBuildInput,
    signingMode: Option.some("developer-id" as const),
    outputDir: Option.some(privateOutputDir),
  } satisfies Parameters<typeof resolveBuildOptions>[0];

  it.effect("keeps ad hoc as the default and legacy --signed as developer-id-passkey", () =>
    Effect.gen(function* () {
      // Candidate credentials, Clerk auth config and passkey inputs are all
      // present, yet nothing selects a mode but the flags that existed before.
      const ambient = envWith({
        T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("example.clerk.accounts.dev$")}`,
        T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
        T3CODE_CLERK_PASSKEY_RP_DOMAINS: "clerk.example.com",
        T3CODE_MACOS_INSTALLER_LEAF_SHA256: "invalid-ambient-pin",
        OOP_DESKTOP_BUILD_LOCAL_PKG_TRUST: developerIdTrustMarker,
      });

      for (const input of [baseBuildInput, { ...baseBuildInput, signingMode: Option.none() }]) {
        const adhoc = yield* resolveWithEnv(input, ambient);
        assert.equal(adhoc.signingMode, "adhoc");
        assert.isFalse(adhoc.signed);
        assert.isUndefined(adhoc.macDeveloperId);
        assert.equal(adhoc.localPkgTrustMarker, legacyTrustMarker);
      }

      const byFlag = yield* resolveWithEnv(
        { ...baseBuildInput, signed: Option.some(true) },
        ambient,
      );
      const byEnv = yield* resolveWithEnv(baseBuildInput, {
        ...ambient,
        T3CODE_DESKTOP_SIGNED: "true",
      });
      const windows = yield* resolveWithEnv(
        { ...baseBuildInput, platform: Option.some("win"), signed: Option.some(true) },
        {},
      );
      for (const resolved of [byFlag, byEnv, windows]) {
        assert.equal(resolved.signingMode, "developer-id-passkey");
        assert.isTrue(resolved.signed);
        assert.isUndefined(resolved.macDeveloperId);
        assert.equal(resolved.localPkgTrustMarker, legacyTrustMarker);
      }
      assert.equal(windows.platform, "win");
    }),
  );

  it.effect("selects the Developer ID candidate only from its explicit flag", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveWithEnv(
        explicitDeveloperId,
        envWith({
          T3CODE_APPLE_TEAM_ID: " abcde12345 ",
          // General Clerk auth config is not a passkey input and stays allowed.
          T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("example.clerk.accounts.dev$")}`,
        }),
      );

      assert.equal(resolved.signingMode, "developer-id");
      assert.isTrue(resolved.signed);
      assert.deepStrictEqual(resolved.macDeveloperId, {
        identity: developerIdIdentity,
        teamId: "ABCDE12345",
        electronBuilderIdentity: "Example Holder (ABCDE12345)",
        localPkgTrustPolicy: {
          mode: "developer-id",
          teamId: "ABCDE12345",
          leafPins: [installerLeafPin],
        },
      });
      assert.equal(resolved.localPkgTrustMarker, developerIdTrustMarker);
    }),
  );

  it.effect(
    "rejects every incomplete, conflicting or misplaced Developer ID candidate request",
    () =>
      Effect.gen(function* () {
        const cases: ReadonlyArray<{
          readonly reason: string;
          readonly env: Record<string, string>;
          readonly input?: Partial<Parameters<typeof resolveBuildOptions>[0]>;
        }> = [
          { reason: "missing-identity", env: envWith({ CSC_NAME: undefined }) },
          { reason: "missing-identity", env: envWith({ CSC_NAME: "   " }) },
          { reason: "missing-team-id", env: envWith({ T3CODE_APPLE_TEAM_ID: undefined }) },
          { reason: "invalid-team-id", env: envWith({ T3CODE_APPLE_TEAM_ID: "SHORT" }) },
          {
            reason: "invalid-identity",
            env: envWith({ CSC_NAME: "Example Holder (ABCDE12345)" }),
          },
          {
            reason: "invalid-identity",
            env: envWith({ CSC_NAME: "Developer ID Installer: Example Holder (ABCDE12345)" }),
          },
          {
            reason: "invalid-identity",
            env: envWith({ CSC_NAME: "Apple Development: Example Holder (ABCDE12345)" }),
          },
          {
            reason: "invalid-identity",
            env: envWith({ CSC_NAME: "Developer ID Application: Example Holder" }),
          },
          {
            reason: "invalid-identity",
            env: envWith({ CSC_NAME: "Developer ID Application: Example\nHolder (ABCDE12345)" }),
          },
          {
            reason: "identity-team-mismatch",
            env: envWith({ T3CODE_APPLE_TEAM_ID: "ZZZZZ99999" }),
          },
          {
            reason: "requires-oop-desktop-profile",
            env: envWith({ T3CODE_DESKTOP_BUILD_PROFILE_NAME: "t3code" }),
          },
          {
            reason: "requires-oop-desktop-profile",
            env: envWith({ T3CODE_DESKTOP_BUILD_PROFILE_NAME: undefined }),
          },
          {
            reason: "passkey-provisioning-profile-not-allowed",
            env: envWith({ T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile" }),
          },
          {
            reason: "passkey-rp-domains-not-allowed",
            env: envWith({ T3CODE_CLERK_PASSKEY_RP_DOMAINS: "clerk.example.com" }),
          },
          {
            reason: "conflicts-with-signed",
            env: developerIdEnv,
            input: { signed: Option.some(true) },
          },
          {
            reason: "conflicts-with-signed",
            env: developerIdEnv,
            input: { signed: Option.some(false) },
          },
          {
            reason: "conflicts-with-signed",
            env: envWith({ T3CODE_DESKTOP_SIGNED: "true" }),
          },
          { reason: "requires-mac", env: developerIdEnv, input: { platform: Option.some("win") } },
          {
            reason: "requires-mac",
            env: developerIdEnv,
            input: { platform: Option.some("linux") },
          },
          {
            reason: "skip-build-not-allowed",
            env: developerIdEnv,
            input: { skipBuild: Option.some(true) },
          },
          {
            reason: "skip-build-not-allowed",
            env: envWith({ T3CODE_DESKTOP_SKIP_BUILD: "true" }),
          },
          {
            reason: "missing-installer-pins",
            env: envWith({ T3CODE_MACOS_INSTALLER_LEAF_SHA256: undefined }),
          },
          {
            reason: "missing-installer-pins",
            env: envWith({ T3CODE_MACOS_INSTALLER_LEAF_SHA256: "" }),
          },
          {
            reason: "invalid-installer-pins",
            env: envWith({ T3CODE_MACOS_INSTALLER_LEAF_SHA256: "A".repeat(64) }),
          },
          {
            reason: "invalid-installer-pins",
            env: envWith({ T3CODE_MACOS_INSTALLER_LEAF_SHA256: "a".repeat(63) }),
          },
          {
            reason: "invalid-installer-pins",
            env: envWith({
              T3CODE_MACOS_INSTALLER_LEAF_SHA256: `${installerLeafPin},${installerLeafPin}`,
            }),
          },
          {
            reason: "invalid-installer-pins",
            env: envWith({
              T3CODE_MACOS_INSTALLER_LEAF_SHA256: ["a", "b", "c", "d"]
                .map((value) => value.repeat(64))
                .join(","),
            }),
          },
        ];

        for (const { reason, env, input } of cases) {
          const error = yield* Effect.flip(
            resolveWithEnv({ ...explicitDeveloperId, ...input }, env),
          );
          assert.instanceOf(error, InvalidBuildSigningError);
          assert.equal(error.reason, reason);
          // Rejections name the problem, never the identity or Team values.
          assert.notInclude(error.message, "ABCDE12345");
          assert.notInclude(error.message, "Example Holder");
          assert.notInclude(error.message, installerLeafPin);
        }
      }),
  );

  it.effect(
    "embeds up to three exact synthetic Installer pins only for the explicit candidate",
    () =>
      Effect.gen(function* () {
        const pins = [installerLeafPin, otherInstallerLeafPin, "c".repeat(64)];
        const resolved = yield* resolveWithEnv(
          explicitDeveloperId,
          envWith({ T3CODE_MACOS_INSTALLER_LEAF_SHA256: pins.join(",") }),
        );
        assert.deepStrictEqual(resolved.macDeveloperId?.localPkgTrustPolicy, {
          mode: "developer-id",
          teamId: "ABCDE12345",
          leafPins: pins,
        });
        assert.equal(
          resolved.localPkgTrustMarker,
          `OOP_LOCAL_PKG_TRUST_V1:developer-id:ABCDE12345:${pins.join(",")}`,
        );
      }),
  );

  it("overwrites an ambient build policy in every signing mode", () => {
    const baseEnv = { PATH: "/usr/bin", OOP_DESKTOP_BUILD_LOCAL_PKG_TRUST: "untrusted-ambient" };
    const candidate = desktopBuildEnv(baseEnv, developerIdTrustMarker);
    const legacy = desktopBuildEnv(baseEnv, legacyTrustMarker);
    assert.equal(candidate.OOP_DESKTOP_BUILD_LOCAL_PKG_TRUST, developerIdTrustMarker);
    assert.equal(legacy.OOP_DESKTOP_BUILD_LOCAL_PKG_TRUST, legacyTrustMarker);
    assert.equal(baseEnv.OOP_DESKTOP_BUILD_LOCAL_PKG_TRUST, "untrusted-ambient");
  });

  it.effect("accepts only the expected policy markers in the staged main bundle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "oop-staged-trust-" });
        const stagedMain = path.join(root, "main.cjs");

        yield* fs.writeFileString(
          stagedMain,
          `const first = "${legacyTrustMarker}"; const second = "${legacyTrustMarker}";`,
        );
        yield* verifyStagedTrustMarker(stagedMain, legacyTrustMarker);

        const rejected = (source: string, expected: string, found: "none" | "mismatch") =>
          Effect.gen(function* () {
            yield* fs.writeFileString(stagedMain, source);
            const error = yield* verifyStagedTrustMarker(stagedMain, expected).pipe(Effect.flip);
            assert.instanceOf(error, EmbeddedTrustPolicyMismatchError);
            assert.equal(error.found, found);
            assert.notInclude(error.message, installerLeafPin);
            assert.notInclude(error.message, otherInstallerLeafPin);
            assert.notInclude(error.message, root);
            assert.include(error.message, "--skip-build");
          });
        yield* rejected("const preE23 = true;", legacyTrustMarker, "none");
        yield* rejected(
          `const stale = "${developerIdTrustMarker}";`,
          legacyTrustMarker,
          "mismatch",
        );
        yield* rejected(
          `const a = "${legacyTrustMarker}"; const b = "${developerIdTrustMarker}";`,
          legacyTrustMarker,
          "mismatch",
        );

        yield* fs.remove(stagedMain);
        const unreadable = yield* verifyStagedTrustMarker(stagedMain, legacyTrustMarker).pipe(
          Effect.flip,
        );
        assert.instanceOf(unreadable, EmbeddedTrustPolicyMismatchError);
        assert.equal(unreadable.found, "none");
        assert.notInclude(unreadable.message, root);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it("keeps the legacy passkey resolver fail-closed whatever candidate credentials exist", () => {
    assert.throws(
      () =>
        resolveMacPasskeySigningConfiguration({
          CSC_NAME: developerIdIdentity,
          T3CODE_APPLE_TEAM_ID: "ABCDE12345",
          T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("example.clerk.accounts.dev$")}`,
        }),
      MissingMacPasskeyProvisioningProfileError,
    );
  });

  it.effect("signs the candidate with the requested identity and without passkey inputs", () =>
    Effect.gen(function* () {
      const { macDeveloperId } = yield* resolveWithEnv(explicitDeveloperId, developerIdEnv);
      const candidate = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        true,
        false,
        undefined,
        undefined,
        false,
        "arm64",
        true,
        true,
        macDeveloperId,
      );
      const mac = candidate.mac as Record<string, unknown>;

      assert.equal(candidate.appId, "com.t3tools.t3code");
      assert.equal(candidate.productName, "OOP");
      assert.match(String(mac.sign), /[\\/]scripts[\\/]sign-macos\.ts$/);
      assert.equal(mac.identity, "Example Holder (ABCDE12345)");
      assert.equal(mac.hardenedRuntime, true);
      assert.equal(mac.notarize, false);
      // Base Electron entitlements only: no custom plist and no Associated Domains profile.
      assert.notProperty(mac, "entitlements");
      assert.notProperty(mac, "provisioningProfile");

      const adhoc = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );
      assert.equal((adhoc.mac as Record<string, unknown>).identity, "-");
      assert.notProperty(adhoc.mac as Record<string, unknown>, "notarize");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("scrubs certificate import, notarization and upload credentials from candidate builds", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      CSC_KEYCHAIN: "/tmp/build.keychain-db",
      CSC_NAME: developerIdIdentity,
      CSC_LINK: "/tmp/cert.p12",
      CSC_KEY_PASSWORD: "p12-password",
      APPLE_ID: "dev@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_TEAM_ID: "ABCDE12345",
      APPLE_API_KEY: "/tmp/AuthKey.p8",
      APPLE_API_KEY_ID: "KEYID",
      APPLE_API_ISSUER: "issuer",
      APPLE_KEYCHAIN_PROFILE: "profile",
      GH_TOKEN: "gh-token",
      GITHUB_TOKEN: "github-token",
    };
    scrubMacDeveloperIdBuildEnv(env);

    assert.deepStrictEqual(env, {
      PATH: "/usr/bin",
      CSC_KEYCHAIN: "/tmp/build.keychain-db",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    });
  });

  it.effect("keeps the legacy output defaults unchanged", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = yield* testRepoRoot;
      const outputDirOf = (
        input: Partial<Parameters<typeof resolveBuildOptions>[0]>,
        env: Record<string, string> = {},
      ) =>
        resolveWithEnv({ ...baseBuildInput, ...input }, env).pipe(
          Effect.map((resolved) => resolved.outputDir),
        );

      assert.equal(yield* outputDirOf({}), path.join(repoRoot, "release"));
      assert.equal(
        yield* outputDirOf({ signed: Option.some(true) }),
        path.join(repoRoot, "release"),
      );
      assert.equal(
        yield* outputDirOf({ mockUpdates: Option.some(true) }),
        path.join(repoRoot, "release-mock"),
      );
      assert.equal(
        yield* outputDirOf({}, { T3CODE_DESKTOP_OUTPUT_DIR: "env-out" }),
        path.join(repoRoot, "env-out"),
      );
    }),
  );

  it.effect("requires the candidate output outside the repo and the local update directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* testRepoRoot;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-candidate-output-" });
      const feed = path.join(root, "feed");
      yield* fs.makeDirectory(feed);
      const env = envWith({ OOP_DESKTOP_UPDATE_DIRECTORY: feed });
      const reasonFor = (
        input: Partial<Parameters<typeof resolveBuildOptions>[0]>,
        inputEnv: Record<string, string> = env,
      ) =>
        Effect.flip(resolveWithEnv({ ...explicitDeveloperId, ...input }, inputEnv)).pipe(
          Effect.map((error) => {
            assert.instanceOf(error, InvalidBuildSigningError);
            return error.reason;
          }),
        );

      // Neither the default `release` directory nor an ambient output directory is accepted.
      assert.equal(yield* reasonFor({ outputDir: Option.none() }), "requires-explicit-output-dir");
      assert.equal(
        yield* reasonFor(
          { outputDir: Option.none(), mockUpdates: Option.some(true) },
          { ...env, T3CODE_DESKTOP_OUTPUT_DIR: path.join(root, "private") },
        ),
        "requires-explicit-output-dir",
      );
      for (const outputDir of [
        "release",
        "release-mock",
        ".",
        path.join(repoRoot, "release", "macos"),
        path.join(repoRoot, "not-created-yet", "out"),
      ]) {
        assert.equal(
          yield* reasonFor({ outputDir: Option.some(outputDir) }),
          "output-dir-inside-repo",
          outputDir,
        );
      }
      for (const outputDir of [feed, path.join(feed, "nested", "out")]) {
        assert.equal(
          yield* reasonFor({ outputDir: Option.some(outputDir) }),
          "output-dir-inside-update-directory",
          outputDir,
        );
      }

      // A caller-chosen directory elsewhere is accepted as the candidate directory; this is not a sandbox.
      const privateOutput = path.join(root, "private");
      const resolved = yield* resolveWithEnv(
        { ...explicitDeveloperId, outputDir: Option.some(privateOutput) },
        env,
      );
      assert.equal(resolved.signingMode, "developer-id");
      assert.equal(resolved.outputDir, privateOutput);
    }),
  );

  it.effect.skipIf(!symlinksSupported)("judges the candidate output by its real location", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* testRepoRoot;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-candidate-alias-" });
      const feed = path.join(root, "feed");
      const feedAlias = path.join(root, "feed-alias");
      const repoAlias = path.join(root, "repo-alias");
      yield* fs.makeDirectory(feed);
      yield* fs.symlink(feed, feedAlias);
      yield* fs.symlink(repoRoot, repoAlias);
      const reasonFor = (outputDir: string, updateDirectory: string) =>
        Effect.flip(
          resolveWithEnv(
            { ...explicitDeveloperId, outputDir: Option.some(outputDir) },
            envWith({ OOP_DESKTOP_UPDATE_DIRECTORY: updateDirectory }),
          ),
        ).pipe(
          Effect.map((error) => {
            assert.instanceOf(error, InvalidBuildSigningError);
            return error.reason;
          }),
        );

      assert.equal(
        yield* reasonFor(path.join(repoAlias, "candidate-out"), feed),
        "output-dir-inside-repo",
      );
      assert.equal(
        yield* reasonFor(path.join(feedAlias, "candidate-out"), feed),
        "output-dir-inside-update-directory",
      );
      assert.equal(
        yield* reasonFor(path.join(feed, "candidate-out"), feedAlias),
        "output-dir-inside-update-directory",
      );
    }),
  );

  it.effect("omits every publish provider from the candidate and keeps legacy publishing", () =>
    Effect.gen(function* () {
      const { macDeveloperId } = yield* resolveWithEnv(explicitDeveloperId, developerIdEnv);
      const macConfig = (
        signed: boolean,
        mockUpdates: boolean,
        candidate?: typeof macDeveloperId,
      ) =>
        createBuildConfig(
          "mac",
          "dmg",
          "1.2.3",
          signed,
          mockUpdates,
          undefined,
          undefined,
          false,
          "arm64",
          true,
          true,
          candidate,
        );
      const withEnv = (env: Record<string, string>) =>
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));
      const inherited = { GITHUB_REPOSITORY: "pingdotgg/t3code" };

      // Inherited repository and mock-update settings feed legacy builds but never the candidate.
      assert.notProperty(
        yield* macConfig(true, true, macDeveloperId).pipe(withEnv(inherited)),
        "publish",
      );
      assert.notProperty(yield* macConfig(true, true, macDeveloperId).pipe(withEnv({})), "publish");
      assert.deepStrictEqual((yield* macConfig(true, true).pipe(withEnv(inherited))).publish, [
        { provider: "github", owner: "pingdotgg", repo: "t3code", releaseType: "release" },
      ]);
      const mock = yield* macConfig(false, true).pipe(withEnv({}));
      assert.deepStrictEqual(
        (mock.publish as ReadonlyArray<{ readonly provider: string }>).map(
          ({ provider }) => provider,
        ),
        ["generic"],
      );
    }),
  );

  // codesign is mocked here, so these prove how the check is wired and that it
  // fails closed, not that a real certificate, chain or Team passes it.
  const developerIdRequirement =
    'identifier "com.t3tools.t3code" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "ABCDE12345"';

  it.effect(
    "tests every packaged app against the Developer ID Team requirement and fails closed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const apps = ["/tmp/dist/mac-arm64/OOP.app", "/tmp/dist/mac/OOP.app"];
          const commands: Array<{
            readonly command: string;
            readonly args: ReadonlyArray<string>;
          }> = [];
          const spawner = (failingApp?: string) =>
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((command) => {
                const child = command as unknown as {
                  readonly command: string;
                  readonly args: ReadonlyArray<string>;
                };
                commands.push({ command: child.command, args: child.args });
                return Effect.succeed(mockProcess(child.args.at(-1) === failingApp ? 3 : 0));
              }),
            );

          yield* verifyMacDeveloperIdRequirement(apps, "ABCDE12345", false).pipe(
            Effect.provide(spawner()),
          );
          assert.deepStrictEqual(
            commands,
            apps.map((app) => ({
              command: "/usr/bin/codesign",
              args: ["--verify", "--strict", "--verbose=2", `-R=${developerIdRequirement}`, app],
            })),
          );

          commands.length = 0;
          const error = yield* verifyMacDeveloperIdRequirement(apps, "ABCDE12345", false).pipe(
            Effect.provide(spawner(apps[0])),
            Effect.flip,
          );
          assert.instanceOf(error, MacBundleSignatureValidationError);
          assert.equal(error.distPath, apps[0]);
          assert.lengthOf(commands, 1);
        }),
      ),
  );

  it("marks direct candidate output nonshippable without claiming notarization or runtime results", () => {
    const receipt = JSON.parse(renderMacDeveloperIdCandidateReceipt("0.0.58", "ABCDE12345"));

    assert.deepStrictEqual(
      { ...receipt, verification: undefined },
      {
        distribution: "internal-candidate",
        shippable: false,
        passkeyConfigured: false,
        notarized: false,
        appVersion: "0.0.58",
        signing: { requestedMode: "developer-id", expectedTeamId: "ABCDE12345" },
        verification: undefined,
      },
    );
    assert.match(
      receipt.verification,
      /notarization, Gatekeeper, installer trust, passkeys, UI, and runtime behavior not exercised/u,
    );
  });
});

// The self-containment check runs the packaged tree in a scratch directory. Its
// own node_modules holds the sidecar externals and must be ignored, but any
// node_modules *above* it would let Node's parent walk satisfy an import that is
// missing from the package, so the probe refuses to run in that case.
it("lists ancestor node_modules, nearest first, excluding the start directory", () => {
  assert.deepStrictEqual(ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"), [
    "C:\\tmp\\probe\\node_modules",
    "C:\\tmp\\node_modules",
    "C:\\node_modules",
  ]);
});

it("includes the filesystem root for posix paths", () => {
  assert.deepStrictEqual(ancestorNodeModulesPaths("/tmp/probe", "/"), [
    "/tmp/node_modules",
    "/node_modules",
  ]);
});

// A UNC root must keep its \\server\share prefix. Rebuilding it from segments
// produced relative paths, which fs.exists resolves against the build cwd, so
// the guard checked directories that do not exist and silently passed.
it("keeps the prefix of a UNC path instead of going relative", () => {
  const paths = ancestorNodeModulesPaths("\\\\server\\share\\tmp\\app", "\\");
  for (const candidate of paths) {
    assert.ok(candidate.startsWith("\\\\server\\share"), candidate);
  }
  assert.deepStrictEqual(paths[0], "\\\\server\\share\\tmp\\node_modules");
});

it.effect.skipIf(!symlinksSupported)("rebases packaged links into the isolated tree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copy-symlinks-" });
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const packageDir = path.join(source, "node_modules/.pnpm/example@1/node_modules/example");
    const relativePackageLink = path.join(source, "node_modules/example-relative");
    const absolutePackageLink = path.join(source, "node_modules/example-absolute");

    yield* fs.makeDirectory(packageDir, { recursive: true });
    yield* fs.writeFileString(path.join(packageDir, "index.js"), "module.exports = true;\n");
    yield* fs.symlink(
      path.join(".pnpm", "example@1", "node_modules", "example"),
      relativePackageLink,
    );
    yield* fs.symlink(packageDir, absolutePackageLink);

    yield* copyDirectoryPreservingSymlinks(source, destination);

    const copiedPackage = path.join(
      destination,
      "node_modules/.pnpm/example@1/node_modules/example",
    );
    const resolvedCopiedPackage = yield* fs.realPath(copiedPackage);
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-relative")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-absolute")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-relative")),
      resolvedCopiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-absolute")),
      resolvedCopiedPackage,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("ignores trailing separators", () => {
  assert.deepStrictEqual(
    ancestorNodeModulesPaths("C:\\tmp\\probe\\app\\", "\\"),
    ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"),
  );
});
