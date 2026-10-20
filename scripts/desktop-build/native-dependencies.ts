import { selectCliRuntimeExternalDependencies } from "../lib/cli-external-packages.ts";
import { selectDesktopRuntimeExternalDependencies } from "../lib/desktop-external-packages.ts";
import { resolveCatalogDependencies } from "../lib/resolve-catalog.ts";

type BuildPlatform = "mac" | "linux" | "win";
type BuildArch = "arm64" | "x64" | "universal";

export function resolveFffNativeDependencies(
  platform: BuildPlatform,
  arch: BuildArch,
  version: string,
): Record<string, string> {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-darwin-${architecture}`, version]),
    );
  }

  if (platform === "win") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-win32-${architecture}`, version]),
    );
  }

  return Object.fromEntries(
    architectures.flatMap((architecture) =>
      ["gnu", "musl"].map((libc) => [`@ff-labs/fff-bin-linux-${architecture}-${libc}`, version]),
    ),
  );
}

// macOS and Linux run both processes from one app.asar, so the stage installs
// the union of what each bundle leaves external and nothing else.
export function resolveMergedStageDependencies(input: {
  readonly platform: "mac" | "linux";
  readonly serverDependencies: Record<string, string>;
  readonly desktopDependencies: Record<string, string>;
  readonly arch: BuildArch;
  readonly fffNodeVersion: string;
}) {
  return {
    ...selectCliRuntimeExternalDependencies(input.serverDependencies),
    ...input.desktopDependencies,
    ...resolveFffNativeDependencies(input.platform, input.arch, input.fffNodeVersion),
  };
}

export interface ClerkPasskeyNativeArtifact {
  readonly packageName: string;
  readonly binaryFileName: string;
}

export function resolveClerkPasskeyNativeArtifacts(
  platform: BuildPlatform,
  arch: BuildArch,
): readonly ClerkPasskeyNativeArtifact[] {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return architectures.map((architecture) => ({
      packageName: `@clerk/electron-passkeys-darwin-${architecture}`,
      binaryFileName: `electron-passkeys.darwin-${architecture}.node`,
    }));
  }

  if (platform === "win") {
    return architectures.map((architecture) => ({
      packageName: `@clerk/electron-passkeys-win32-${architecture}-msvc`,
      binaryFileName: `electron-passkeys.win32-${architecture}-msvc.node`,
    }));
  }

  return [];
}

export function resolveKeyringNativeArtifacts(
  platform: BuildPlatform,
  arch: BuildArch,
): readonly ClerkPasskeyNativeArtifact[] {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return architectures.map((architecture) => ({
      packageName: `@napi-rs/keyring-darwin-${architecture}`,
      binaryFileName: `keyring.darwin-${architecture}.node`,
    }));
  }

  if (platform === "win") {
    return architectures.map((architecture) => ({
      packageName: `@napi-rs/keyring-win32-${architecture}-msvc`,
      binaryFileName: `keyring.win32-${architecture}-msvc.node`,
    }));
  }

  return architectures.map((architecture) => ({
    packageName: `@napi-rs/keyring-linux-${architecture}-gnu`,
    binaryFileName: `keyring.linux-${architecture}-gnu.node`,
  }));
}

export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, getPatchedDependencyPackageName(patchKey)),
    ),
  );
}

function getPatchedDependencyPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}

// The main-process bundle inlines every JS dependency (see
// apps/desktop/vite.config.ts), so the packaged app only installs the packages
// that bundle leaves external: native addons and playwright-core. Everything
// else already lives inside dist-electron and would only duplicate what the
// server bundle carries too.
export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  return resolveCatalogDependencies(
    selectDesktopRuntimeExternalDependencies(dependencies),
    catalog,
    "apps/desktop",
  );
}
