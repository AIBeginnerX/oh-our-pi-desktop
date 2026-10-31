import release from "../../../OOP_RELEASE.json" with { type: "json" };

/**
 * Version of this terminal app: the release it was built from, which is also what the desktop app of
 * that release reports. The build inlines the root `OOP_RELEASE.json`, and a run from the sources
 * reads the same file, so `oop --version` and the update check never disagree.
 */
export const TERMINAL_VERSION: string = release.version;
