import desktopPackageJson from "../../apps/desktop/package.json" with { type: "json" };
import {
  BRAND_ASSET_PATHS,
  resolveWebAssetBrandForChannel,
  type WebAssetBrand,
} from "../lib/brand-assets.ts";

export interface DesktopBuildIconAssets {
  readonly macIconPng: string;
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
}

export function resolveDesktopUpdateChannel(version: string): "latest" | "nightly" {
  return /-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest";
}

// Pull request builds (`-pr.<n>.`) and the maintainers' preview train
// (`-preview.<date>.<run>`) are downloaded by hand and never through an
// updater. Building them without a publish config means electron-builder
// emits no `latest*.yml`/`nightly*.yml` manifests or blockmaps for them and
// the app ships without `app-update.yml`, so neither a stable nor a nightly
// install can be pointed at one of these releases, and the build itself
// reports that no update feed is configured instead of polling.
export function isDesktopPreviewVersion(version: string): boolean {
  return /-pr\./.test(version) || /-preview\.\d{8}\.\d+$/.test(version);
}

export function resolveDesktopWebAssetBrand(version: string, oopBrand = false): WebAssetBrand {
  if (oopBrand) return "oop";
  return resolveWebAssetBrandForChannel(resolveDesktopUpdateChannel(version));
}

export function resolveDesktopBuildIconAssets(
  version: string,
  oopBrand = false,
): DesktopBuildIconAssets {
  if (oopBrand) {
    return {
      macIconPng: BRAND_ASSET_PATHS.oopMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.oopLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.oopWindowsIconIco,
    };
  }
  if (resolveDesktopUpdateChannel(version) === "nightly") {
    return {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    };
  }

  return {
    macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
    linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
  };
}

export function resolveMockUpdateServerUrl(mockUpdateServerPort: number | undefined): string {
  return `http://localhost:${mockUpdateServerPort ?? 3000}`;
}

// Electron Builder detects pnpm from npm_config_user_agent, whose value uses
// user-agent syntax (pnpm/11.10.0) rather than packageManager syntax
// (pnpm@11.10.0).
export function resolvePackageManagerUserAgent(packageManager: string): string {
  const trimmed = packageManager.trim();
  const versionSeparator = trimmed.lastIndexOf("@");
  if (versionSeparator <= 0 || versionSeparator === trimmed.length - 1) {
    return trimmed;
  }

  return `${trimmed.slice(0, versionSeparator)}/${trimmed.slice(versionSeparator + 1)}`;
}

export function resolveDesktopProductName(version: string, oopBrand = false): string {
  if (oopBrand) return "OoP";
  return resolveDesktopUpdateChannel(version) === "nightly"
    ? "T3 Code (Nightly)"
    : (desktopPackageJson.productName ?? "T3 Code");
}
