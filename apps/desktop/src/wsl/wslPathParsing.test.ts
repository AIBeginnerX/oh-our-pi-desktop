import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

vi.mock("electron", () => ({}));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { pickFolder } from "../ipc/methods/window.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";

import {
  extractDistroFromUncPath,
  isValidDistroName,
  parseWslDistroList,
  resolveWslPickFolderDefaultPath,
} from "./wslPathParsing.ts";

function makeUtf16LeBuffer(text: string): Buffer {
  return Buffer.from("﻿" + text, "utf16le");
}

describe("parseWslDistroList", () => {
  it("parses standard output with default distro marked", () => {
    const output = makeUtf16LeBuffer(
      [
        "  NAME            STATE           VERSION",
        "* Ubuntu           Running         2",
        "  Debian           Stopped         2",
        "  Ubuntu-22.04     Running         1",
      ].join("\r\n"),
    );
    const distros = parseWslDistroList(output);
    expect(distros).toEqual([
      { name: "Ubuntu", isDefault: true, version: 2 },
      { name: "Debian", isDefault: false, version: 2 },
      { name: "Ubuntu-22.04", isDefault: false, version: 1 },
    ]);
  });

  it("returns empty array for empty buffer", () => {
    expect(parseWslDistroList(Buffer.alloc(0))).toEqual([]);
  });

  it("returns empty array for header-only output", () => {
    const output = makeUtf16LeBuffer("  NAME            STATE           VERSION\r\n");
    expect(parseWslDistroList(output)).toEqual([]);
  });

  it("skips malformed lines", () => {
    const output = makeUtf16LeBuffer(
      [
        "  NAME            STATE           VERSION",
        "* Ubuntu           Running         2",
        "  bad line",
        "",
        "  Debian           Stopped         2",
      ].join("\r\n"),
    );
    const distros = parseWslDistroList(output);
    expect(distros).toEqual([
      { name: "Ubuntu", isDefault: true, version: 2 },
      { name: "Debian", isDefault: false, version: 2 },
    ]);
  });

  it("handles output without BOM", () => {
    const text = [
      "  NAME            STATE           VERSION",
      "* Ubuntu           Running         2",
    ].join("\r\n");
    const output = Buffer.from(text, "utf16le");
    const distros = parseWslDistroList(output);
    expect(distros).toEqual([{ name: "Ubuntu", isDefault: true, version: 2 }]);
  });

  it("handles UTF-8 output", () => {
    const text = [
      "  NAME            STATE           VERSION",
      "* Debian           Running         2",
    ].join("\r\n");
    const distros = parseWslDistroList(Buffer.from(text, "utf8"));
    expect(distros).toEqual([{ name: "Debian", isDefault: true, version: 2 }]);
  });
});

describe("extractDistroFromUncPath", () => {
  it("extracts the distro from \\\\wsl.localhost UNC paths", () => {
    expect(extractDistroFromUncPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\josh")).toBe(
      "Ubuntu-22.04",
    );
  });

  it("extracts the distro from the legacy \\\\wsl$ UNC paths", () => {
    expect(extractDistroFromUncPath("\\\\wsl$\\Debian\\home\\josh")).toBe("Debian");
  });

  it("returns null for non-UNC Windows paths", () => {
    expect(extractDistroFromUncPath("C:\\Users\\Josh\\project")).toBeNull();
  });

  it("returns null when the segment is not a valid distro name", () => {
    expect(extractDistroFromUncPath("\\\\wsl.localhost\\bad name!\\home")).toBeNull();
  });
});

describe("WSL project folder selection", () => {
  const wslInstance: DesktopBackendPool.DesktopBackendInstance = {
    id: DesktopBackendPool.BackendInstanceId("wsl:default"),
    label: Effect.succeed("WSL (Ubuntu)"),
    start: Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeedSome({
      executablePath: "wsl.exe",
      args: ["-d", "Ubuntu", "--", "node", "/app/bin.mjs"],
      entryPath: "/app/bin.mjs",
      cwd: "/app",
      env: {},
      extendEnv: false,
      bootstrap: {
        mode: "desktop",
        noBrowser: true,
        port: 3774,
        host: "0.0.0.0",
        desktopBootstrapToken: "",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      bootstrapDelivery: "stdin",
      httpBaseUrl: new URL("http://127.0.0.1:3774"),
      captureOutput: true,
      preflightFailure: Option.none(),
      runningDistro: "Ubuntu",
    }),
    snapshot: Effect.succeed({
      desiredRunning: true,
      ready: true,
      activePid: Option.some(123),
      restartAttempt: 0,
      restartScheduled: false,
    }),
    waitForReady: () => Effect.succeed(true),
  };

  const pickProjectFolder = (
    folder: string,
    targetEnvironmentId?: string,
    showErrorBox = vi.fn(() => Effect.void),
    wslOnly = false,
  ) =>
    pickFolder
      .handler(targetEnvironmentId === undefined ? undefined : { targetEnvironmentId })
      .pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopBackendPool.layerTest([
              wslOnly
                ? { ...wslInstance, id: DesktopBackendPool.PRIMARY_INSTANCE_ID }
                : wslInstance,
            ]),
            DesktopEnvironment.layer({
              dirname: "/repo/apps/desktop/dist-electron",
              homeDirectory: "/Users/alice",
              platform: "win32",
              processArch: "x64",
              appVersion: "0.0.22",
              appPath: "/repo/apps/desktop",
              isPackaged: false,
              resourcesPath: "/repo/resources",
              runningUnderArm64Translation: false,
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  NodePath.layerWin32,
                  DesktopConfig.layerTest({}),
                ),
              ),
            ),
            Layer.mock(ElectronDialog.ElectronDialog)({
              pickFolder: () => Effect.succeedSome(folder),
              showErrorBox,
            }),
            Layer.mock(ElectronWindow.ElectronWindow)({ focusedMainOrFirst: Effect.succeedNone }),
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              localEnvironmentEnabled: true,
              wslBackendEnabled: true,
              wslOnly,
            }),
            DesktopWslEnvironment.layerTest({
              windowsToWslPath: () => Option.some("/mnt/c/repo"),
            }),
          ),
        ),
      );

  for (const folder of [String.raw`\\wsl.localhost\Debian\work\repo`, String.raw`\\wsl$\Debian`]) {
    it.effect(`preserves the selected distro for routing when picking ${folder} from Ubuntu`, () =>
      Effect.gen(function* () {
        expect(yield* pickProjectFolder(folder, "wsl:default")).toBe(folder);
      }),
    );
  }

  it.effect("returns a Linux path for the concrete distro running under wsl:default", () =>
    Effect.gen(function* () {
      const folder = String.raw`\\wsl.localhost\ubuntu\work\repo`;
      expect(yield* pickProjectFolder(folder, "wsl:default")).toBe("/work/repo");
    }),
  );

  it.effect("returns a Linux root for the running distro in WSL-only mode", () =>
    Effect.gen(function* () {
      const folder = String.raw`\\wsl$\Ubuntu`;
      expect(yield* pickProjectFolder(folder, "wsl:default", undefined, true)).toBe("/");
    }),
  );

  const unroutableFolder = String.raw`\\wsl.localhost\Ubuntu Custom\repo`;

  it.effect("returns the selected UNC path unchanged for the native backend", () =>
    Effect.gen(function* () {
      const showErrorBox = vi.fn(() => Effect.void);
      expect(yield* pickProjectFolder(unroutableFolder, undefined, showErrorBox)).toBe(
        unroutableFolder,
      );
      expect(showErrorBox).not.toHaveBeenCalled();
    }),
  );

  it.effect("shows an error when the WSL backend cannot route the selected distro", () =>
    Effect.gen(function* () {
      const showErrorBox = vi.fn(() => Effect.void);
      expect(yield* pickProjectFolder(unroutableFolder, "wsl:Ubuntu", showErrorBox)).toBeNull();
      expect(showErrorBox).toHaveBeenCalledOnce();
    }),
  );

  it.effect("still converts Windows drive paths for the selected backend", () =>
    Effect.gen(function* () {
      expect(yield* pickProjectFolder(String.raw`C:\repo`, "wsl:Ubuntu")).toBe("/mnt/c/repo");
    }),
  );
});

describe("resolveWslPickFolderDefaultPath", () => {
  const config = { distro: null };
  const distros = [{ name: "Debian", isDefault: true, version: 2 as const }];

  it("uses WSL home when no initial path is provided", () => {
    expect(resolveWslPickFolderDefaultPath(undefined, config, distros)).toBe(
      "\\\\wsl.localhost\\Debian\\home",
    );
  });

  it("maps Linux initial paths to WSL UNC paths", () => {
    expect(
      resolveWslPickFolderDefaultPath({ initialPath: "/home/josh/project" }, config, distros),
    ).toBe("\\\\wsl.localhost\\Debian\\home\\josh\\project");
  });

  it("expands ~/path against the user's home dir when known", () => {
    expect(
      resolveWslPickFolderDefaultPath({ initialPath: "~/project" }, config, distros, "/home/josh"),
    ).toBe("\\\\wsl.localhost\\Debian\\home\\josh\\project");
  });

  it("resolves bare ~ to the user's home dir when known", () => {
    expect(
      resolveWslPickFolderDefaultPath({ initialPath: "~" }, config, distros, "/home/josh"),
    ).toBe("\\\\wsl.localhost\\Debian\\home\\josh");
  });

  it("falls back to /home parent when the user's home dir isn't known", () => {
    expect(resolveWslPickFolderDefaultPath({ initialPath: "~/project" }, config, distros)).toBe(
      "\\\\wsl.localhost\\Debian\\home\\project",
    );
  });

  it("preserves existing UNC initial paths", () => {
    expect(
      resolveWslPickFolderDefaultPath(
        { initialPath: "\\\\wsl.localhost\\Ubuntu\\home\\josh" },
        config,
        distros,
      ),
    ).toBe("\\\\wsl.localhost\\Ubuntu\\home\\josh");
  });
});

describe("isValidDistroName", () => {
  it("accepts common distro names", () => {
    for (const name of ["Ubuntu", "Ubuntu-22.04", "kali-linux", "Debian", "Ubuntu 22.04"]) {
      expect(isValidDistroName(name)).toBe(true);
    }
  });

  it("rejects names with trailing whitespace, hyphen, or dot", () => {
    for (const name of ["Ubuntu ", "Ubuntu-", "Ubuntu."]) {
      expect(isValidDistroName(name)).toBe(false);
    }
  });

  it("rejects names containing control or shell-meta characters", () => {
    for (const name of ["bad\nname", "bad\tname", "bad/name", "bad!name", "bad;name"]) {
      expect(isValidDistroName(name)).toBe(false);
    }
  });
});
