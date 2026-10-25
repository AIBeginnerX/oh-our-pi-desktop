// Release file names. The app and every installer are named OOP. Through 0.0.110 the update feed
// still names its package with the legacy "OoP" casing: apps up to 0.0.109 accept nothing else, and a
// macOS or Windows folder cannot hold two names that differ only in case. From 0.0.111 the feed uses OOP.
export const ARTIFACT_PREFIX = "OOP";
const LEGACY_PREFIX = "OoP";
const LAST_LEGACY_FEED_VERSION = [0, 0, 110];

/** A release file name of either casing, capturing the version. */
export const RELEASE_FILE_NAME = /^(?:OOP|OoP)-(\d+\.\d+\.\d+)-/u;

function feedPrefix(version) {
  const parts = version.split(".").map(Number);
  for (const index of [0, 1, 2]) {
    if (parts[index] !== LAST_LEGACY_FEED_VERSION[index]) {
      return parts[index] < LAST_LEGACY_FEED_VERSION[index] ? LEGACY_PREFIX : ARTIFACT_PREFIX;
    }
  }
  return LEGACY_PREFIX;
}

export const macDmgName = (version) => `${ARTIFACT_PREFIX}-${version}-arm64.dmg`;
/** The update package the macOS feed names; it is the feed's own file, never a public asset. */
export const macUpdatePkgName = (version) => `${feedPrefix(version)}-${version}-arm64-update.pkg`;
export const windowsInstallerName = (version, arch) => `${ARTIFACT_PREFIX}-${version}-${arch}.exe`;
/** The setup the Windows feed names. */
export const windowsFeedInstallerName = (version, arch) =>
  `${feedPrefix(version)}-${version}-${arch}.exe`;
