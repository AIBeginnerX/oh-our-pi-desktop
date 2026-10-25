import packageJson from "../package.json" with { type: "json" };

declare const __T3CODE_BUILD_OOP_RELEASE__: string | undefined;

/**
 * The OOP release this executable belongs to, baked in by
 * scripts/build-oop-cli-archives.mjs; null in every other build. An OOP
 * executable reports and pins its runtime by this version, keeps its data in
 * ~/.oop-desktop, and never downloads a release: its runtimes arrive from an
 * OOP desktop over SSH (see packages/ssh tunnel.ts).
 */
export const OOP_RELEASE_VERSION: string | null =
  typeof __T3CODE_BUILD_OOP_RELEASE__ === "string" && __T3CODE_BUILD_OOP_RELEASE__ !== ""
    ? __T3CODE_BUILD_OOP_RELEASE__
    : null;

export const CLI_VERSION = OOP_RELEASE_VERSION ?? packageJson.version;

export const DEFAULT_HOME_DIR_NAME = OOP_RELEASE_VERSION === null ? ".t3" : ".oop-desktop";

export const OOP_UPDATE_MESSAGE =
  "OOP gets new versions on this machine from the OOP desktop app. Connect to this host from the updated desktop over SSH, which copies the new version into ~/.oop-desktop/runtime/versions, then run `t3 service install` from that version to switch the service.";
