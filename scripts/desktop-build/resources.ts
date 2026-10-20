import gnomeCaptureBundle from "../../apps/desktop/gnome-extension/bundle.json" with { type: "json" };

type BuildPlatform = "mac" | "linux" | "win";
type BuildArch = "arm64" | "x64" | "universal";

export const DESKTOP_ELECTRON_LANGUAGES = ["en-US"] as const;
export const DESKTOP_FILE_EXCLUSIONS = [
  // T3 Code always passes the user's installed Claude executable to the SDK,
  // so the SDK's optional platform packages (each a ~200MB bundled executable)
  // are dead weight. The trailing dash keeps the SDK's own JS package.
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
  // Nothing in the packaged app enables source maps or serves them: the web
  // client's maps alone were 50 MB of app.asar that no request ever read.
  "!**/*.map",
  "!**/*.d.cts",
  "!apps/desktop/resources/browser-secret",
  "!apps/desktop/resources/browser-secret/**/*",
  "!apps/desktop/prod-resources/browser-secret",
  "!apps/desktop/prod-resources/browser-secret/**/*",
  // Windows stages the server sidecar below prod-resources so electron-builder
  // can copy it using project-relative extraResources matchers. Keep those
  // staging inputs out of app.asar; they are emitted once at resources/.
  "!apps/desktop/prod-resources/windows-server",
  "!apps/desktop/prod-resources/windows-server/**/*",
  "!apps/desktop/prod-resources/wsl-runtime.tar.gz",
  "!apps/desktop/prod-resources/wsl-runtime.tar.gz.sha256",
  "!apps/desktop/gnome-extension",
  "!apps/desktop/gnome-extension/**/*",
] as const;
// Windows terminal helpers cannot run on macOS and slow signing and notarization.
export const MAC_FILE_EXCLUSIONS = [
  "!**/node_modules/node-pty/prebuilds/win32-*/**/*",
  "!**/node_modules/node-pty/third_party/conpty/**/*",
] as const;
// Linux builds node-pty from source, so every prebuild in the package is for
// another platform (58 MB of it Windows debug symbols).
export const LINUX_FILE_EXCLUSIONS = [
  ...MAC_FILE_EXCLUSIONS,
  "!**/node_modules/node-pty/prebuilds/darwin-*/**/*",
] as const;

// node-pty publishes both Darwin prebuilds in one package. Single-architecture
// apps only need the native target; universal apps need both. An omitted arch
// preserves the existing common exclusions for callers that only inspect the
// generic platform config.
export function resolveMacFileExclusions(arch?: BuildArch) {
  if (arch === undefined || arch === "universal") {
    return [...MAC_FILE_EXCLUSIONS];
  }

  const unusedArch = arch === "arm64" ? "x64" : "arm64";
  return [...MAC_FILE_EXCLUSIONS, `!**/node_modules/node-pty/prebuilds/darwin-${unusedArch}/**/*`];
}
// Windows ships the server tree (bundle + node_modules) as a separate
// resources/server.asar sidecar instead of loose files: the NSIS installer
// then extracts a handful of large archives instead of thousands of small
// files, which dominates install (and update) time. The Windows primary runs
// the server from inside server.asar via the asar-aware ELECTRON_RUN_AS_NODE
// runtime. WSL does not use this sidecar: it runs the Linux CLI archive
// embedded as resources/wsl-runtime.tar.gz (see WSL_RUNTIME_ARCHIVE_NAME).
export const WINDOWS_SERVER_ASAR_RESOURCE = "server.asar";
// dlopen/spawn need real files, so native modules, shared libraries, and
// helper executables live in each archive's .unpacked sibling (the standard
// asar redirect convention). Everything else stays packed.
export const WINDOWS_NATIVE_ASAR_UNPACK_GLOB =
  "{**/*.node,**/*.dll,**/*.exe,**/*.so,**/*.so.*,**/*.dylib}";
// Mirrors DESKTOP_FILE_EXCLUSIONS for the hand-packed sidecar: the Claude SDK
// platform packages are dead weight (see above), and node_modules/.bin shims
// are never spawned at runtime (and are symlinks on POSIX build hosts, which
// the asar extraction path deliberately does not support).
export const WINDOWS_SERVER_ASAR_IGNORE_GLOBS = [
  "**/node_modules/@anthropic-ai/claude-agent-sdk-*",
  "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
  "**/node_modules/.bin",
  "**/node_modules/.bin/**",
  "**/*.map",
] as const;

export function resolveWindowsServerAsarIgnoreGlobs(arch: BuildArch) {
  const unusedArch = arch === "arm64" ? "x64" : "arm64";
  const unusedPrebuild = `**/node_modules/node-pty/prebuilds/win32-${unusedArch}`;
  const unusedConpty = `**/node_modules/node-pty/third_party/conpty/*/win10-${unusedArch}`;

  return [
    ...WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
    unusedPrebuild,
    `${unusedPrebuild}/**`,
    unusedConpty,
    `${unusedConpty}/**`,
  ];
}

export const WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT = 80;
export const WINDOWS_SERVER_RESOURCE_SOURCE_DIR = "apps/desktop/prod-resources/windows-server";
export const WINDOWS_SERVER_EXTRA_RESOURCES = [
  {
    // Copy the archive and its .unpacked sibling from one parent directory.
    // Mapping the .unpacked directory as an independent FileSet silently
    // omitted it from Windows packages even though electron-builder copied
    // the adjacent archive.
    from: WINDOWS_SERVER_RESOURCE_SOURCE_DIR,
    to: ".",
    filter: [WINDOWS_SERVER_ASAR_RESOURCE, `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked/**/*`],
  },
] as const;
export const WSL_RUNTIME_ARCHIVE_NAME = "wsl-runtime.tar.gz";
export const WSL_RUNTIME_ARCHIVE_HASH_NAME = `${WSL_RUNTIME_ARCHIVE_NAME}.sha256`;
export const WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE = {
  from: `apps/desktop/prod-resources/${WSL_RUNTIME_ARCHIVE_NAME}`,
  to: WSL_RUNTIME_ARCHIVE_NAME,
} as const;
export const WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE = {
  from: `apps/desktop/prod-resources/${WSL_RUNTIME_ARCHIVE_HASH_NAME}`,
  to: WSL_RUNTIME_ARCHIVE_HASH_NAME,
} as const;

// The WSL runtime is the Linux CLI release archive (t3-<version>-linux-<arch>
// .tar.gz, built by scripts/build-cli-archive.ts) copied in verbatim, so WSL
// runs the exact bytes a Linux user downloads. This one predicate decides both
// whether the archive is staged and whether the packaging config ships it:
// listing an extraResource whose source was never written fails electron-builder.
export const bundlesWslRuntime = (input: {
  readonly platform: BuildPlatform;
  readonly runtimeArchivePath: string | undefined;
}): boolean => input.platform === "win" && input.runtimeArchivePath !== undefined;

export const WSL_RUNTIME_EXTRA_RESOURCES = [
  WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE,
] as const;
export const DESKTOP_EXTRA_RESOURCES = [
  {
    from: "apps/desktop/prod-resources/resource-monitor",
    to: "resource-monitor",
  },
] as const;
export const LINUX_CAPTURE_EXTRA_RESOURCES = [
  {
    from: "apps/desktop/prod-resources/hyprland-capture",
    to: "hyprland-capture",
  },
  {
    from: "apps/desktop/prod-resources/kde-capture",
    to: "kde-capture",
  },
  {
    from: "apps/desktop/gnome-extension",
    to: "gnome-extension",
    filter: gnomeCaptureBundle.files,
  },
] as const;
export const LINUX_BROWSER_SECRET_EXTRA_RESOURCES = [
  { from: "apps/desktop/prod-resources/browser-secret", to: "browser-secret" },
] as const;
