import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  getDesktopUpdateActionLabel,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDescription,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  getDesktopUpdateVersionToAnnounce,
  getDisplayedAppVersion,
  isDesktopUpdateButtonDisabled,
  isLocalPackageUpdate,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("displayed app version", () => {
  it("shows the desktop release, not the bundled web version, on desktop", () => {
    expect(getDisplayedAppVersion({ ...baseState, currentVersion: "0.0.84" }, true, "0.0.44")).toBe(
      "0.0.84",
    );
    expect(getDisplayedAppVersion(null, true, "0.0.44")).toBeNull();
    expect(getDisplayedAppVersion(null, false, "0.0.44")).toBe("0.0.44");
  });
});

describe("desktop update announcement", () => {
  const available: DesktopUpdateState = {
    ...baseState,
    status: "available",
    availableVersion: "1.1.0",
  };

  it("announces a newly offered version once", () => {
    expect(getDesktopUpdateVersionToAnnounce(available, new Set())).toBe("1.1.0");
    expect(getDesktopUpdateVersionToAnnounce(available, new Set(["1.1.0"]))).toBeNull();
    expect(
      getDesktopUpdateVersionToAnnounce(
        { ...available, availableVersion: "1.2.0" },
        new Set(["1.1.0"]),
      ),
    ).toBe("1.2.0");
  });

  it("announces nothing while checking, downloading or without an update", () => {
    expect(getDesktopUpdateVersionToAnnounce(null, new Set())).toBeNull();
    expect(getDesktopUpdateVersionToAnnounce(baseState, new Set())).toBeNull();
    expect(
      getDesktopUpdateVersionToAnnounce({ ...available, status: "checking" }, new Set()),
    ).toBeNull();
    expect(
      getDesktopUpdateVersionToAnnounce({ ...available, status: "downloading" }, new Set()),
    ).toBeNull();
  });
});

describe("desktop update button state", () => {
  it("shows a download action when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("keeps install action available after an install error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("keeps install action available after a background updater error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "background updater error",
      errorContext: null,
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to restart and install");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });

  it("has no action for non-actionable check errors", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "network unavailable",
      errorContext: "check",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });

  it("disables the button while downloading", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.5,
    };
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(getDesktopUpdateButtonTooltip(state)).toContain("42%");
  });

  it("prepares local packages and opens their installer with distinct labels", () => {
    const state = Object.assign(
      {
        ...baseState,
        status: "available" as const,
        availableVersion: "1.1.0",
      },
      { installMode: "local-package" as const },
    );

    expect(isLocalPackageUpdate(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateActionLabel("download", state)).toBe("Prepare Update");
    expect(getDesktopUpdateActionLabel("install", state)).toBe("Open Installer");
    expect(getDesktopUpdateActionLabel("none", state)).toBeNull();
  });

  it("describes local package preparation and installer launch without claiming installation", () => {
    const state = Object.assign(
      {
        ...baseState,
        status: "downloaded" as const,
        downloadedVersion: "1.1.0",
      },
      { installMode: "local-package" as const },
    );

    expect(getDesktopUpdateButtonTooltip(state)).toContain("prepared");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("open the installer");
    expect(getDesktopUpdateInstallConfirmationMessage(state)).toBe(
      "Open the installer for OoP 1.1.0?\n\nOoP will quit and running tasks will stop. macOS Installer will ask for your administrator password. Finish the installation, then reopen OoP from Applications.",
    );
  });

  it("surfaces a failed local preparation while leaving the retry action available", () => {
    const state = Object.assign(
      {
        ...baseState,
        status: "available" as const,
        availableVersion: "1.1.0",
        message: "The update package changed after it was checked.",
        errorContext: "download" as const,
      },
      { installMode: "local-package" as const },
    );

    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toBe(state.message);
    expect(getDesktopUpdateDescription(state, "download")).toBe(state.message);
  });

  it("shows local check failures in the About description", () => {
    const state = Object.assign(
      {
        ...baseState,
        status: "error" as const,
        errorContext: "check" as const,
        message:
          "The local update folder could not be read. Check that it is mounted and try again.",
      },
      { installMode: "local-package" as const },
    );

    expect(getDesktopUpdateDescription(state, "none")).toBe(state.message);
    expect(getDesktopUpdateDescription(baseState, "none")).toBe(
      "Current version of the application.",
    );
  });
});

describe("getDesktopUpdateActionError", () => {
  it("returns user-visible message for accepted failed attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "checksum mismatch",
        errorContext: "download",
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBe("checksum mismatch");
  });

  it("ignores messages for non-accepted attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...baseState,
        status: "error",
        message: "background failure",
        errorContext: "check",
        canRetry: false,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });

  it("ignores messages for successful attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: true,
      state: {
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
        message: null,
        errorContext: null,
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });
});

describe("desktop update UI helpers", () => {
  it("builds the stable release URL for a downloaded version", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30")).toBe(
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30",
    );
  });

  it("builds the nightly release URL without dropping its version suffix", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30-nightly.20260728.931")).toBe(
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30-nightly.20260728.931",
    );
  });

  it("omits the release URL when the updater does not report a version", () => {
    expect(getDesktopUpdateReleaseUrl(null)).toBeNull();
    expect(getDesktopUpdateReleaseUrl("  ")).toBeNull();
  });

  it("builds the release history URL", () => {
    expect(getDesktopUpdateReleaseHistoryUrl()).toBe(
      "https://github.com/pingdotgg/t3code/releases",
    );
  });

  it("does not generate upstream release links for local packages", () => {
    const state = Object.assign({ ...baseState }, { installMode: "local-package" as const });
    expect(getDesktopUpdateReleaseUrl("1.1.0", state)).toBeNull();
  });

  it("toasts only for actionable updater errors", () => {
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: "checksum mismatch" },
      }),
    ).toBe(true);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: null },
      }),
    ).toBe(false);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: true,
        state: { ...baseState, message: "checksum mismatch" },
      }),
    ).toBe(false);
  });

  it("shows an Apple Silicon warning for Intel builds under Rosetta", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    };

    expect(shouldShowArm64IntelBuildWarning(state)).toBe(true);
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Apple Silicon");
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Intel build");
  });

  it("changes the warning copy when a native build update is ready to download", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
      status: "available",
      availableVersion: "1.1.0",
    };

    expect(getArm64IntelBuildWarningDescription(state)).toContain("Download the available update");
  });

  it("uses the OoP product name for the local-package warning", () => {
    const state = Object.assign(
      {
        ...baseState,
        hostArch: "arm64" as const,
        appArch: "x64" as const,
        status: "available" as const,
        availableVersion: "1.1.0",
      },
      { installMode: "local-package" as const },
    );

    const description = getArm64IntelBuildWarningDescription(state);
    expect(description).toContain("OoP");
    expect(description).not.toContain("T3 Code");
    expect(description).toContain("Prepare the available update");
  });

  it("includes the downloaded version in the install confirmation copy", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.1",
      }),
    ).toContain("Install update 1.1.1 and restart T3 Code?");
  });

  it("falls back to generic install confirmation copy when no version is available", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: null,
        downloadedVersion: null,
      }),
    ).toContain("Install update and restart T3 Code?");
  });

  it("keeps the same install confirmation copy across desktop platforms", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(
      "Install update 1.1.0 and restart T3 Code?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.",
    );
  });
});

describe("canCheckForUpdate", () => {
  it("returns false for null state", () => {
    expect(canCheckForUpdate(null)).toBe(false);
  });

  it("returns false when updates are disabled", () => {
    expect(canCheckForUpdate({ ...baseState, enabled: false, status: "disabled" })).toBe(false);
  });

  it("returns false while checking", () => {
    expect(canCheckForUpdate({ ...baseState, status: "checking" })).toBe(false);
  });

  it("returns false while downloading", () => {
    expect(canCheckForUpdate({ ...baseState, status: "downloading", downloadPercent: 50 })).toBe(
      false,
    );
  });

  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });

  it("returns true when idle", () => {
    expect(canCheckForUpdate({ ...baseState, status: "idle" })).toBe(true);
  });

  it("returns true when up-to-date", () => {
    expect(canCheckForUpdate({ ...baseState, status: "up-to-date" })).toBe(true);
  });

  it("returns true when an update is available", () => {
    expect(
      canCheckForUpdate({ ...baseState, status: "available", availableVersion: "1.1.0" }),
    ).toBe(true);
  });

  it("returns true on error so the user can retry", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "error",
        errorContext: "check",
        message: "network",
      }),
    ).toBe(true);
  });
});

describe("getDesktopUpdateButtonTooltip", () => {
  it("returns 'Up to date' for non-actionable states", () => {
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "idle" })).toBe("Up to date");
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "up-to-date" })).toBe(
      "Up to date",
    );
  });

  it("shows a local updater's disabled reason", () => {
    const state = Object.assign(
      { ...baseState, enabled: false, status: "disabled" as const, message: "No package feed." },
      { installMode: "local-package" as const },
    );
    expect(getDesktopUpdateButtonTooltip(state)).toBe("No package feed.");
  });
});
