import { describe, expect, it } from "vite-plus/test";

import {
  configDirectory,
  credentialsFilePath,
  serverRuntimeFilePath,
  type PathEnv,
} from "./paths.ts";

const posix = (env: NodeJS.ProcessEnv = {}): PathEnv => ({
  env,
  platform: "darwin",
  home: "/Users/kim",
});
const windows = (env: NodeJS.ProcessEnv = {}): PathEnv => ({
  env,
  platform: "win32",
  home: "C:\\Users\\kim",
});

describe("configDirectory", () => {
  it("uses ~/.config/oop-tui, or XDG_CONFIG_HOME when set", () => {
    expect(configDirectory(posix())).toBe("/Users/kim/.config/oop-tui");
    expect(configDirectory(posix({ XDG_CONFIG_HOME: "/cfg" }))).toBe("/cfg/oop-tui");
  });

  it("uses %APPDATA%\\oop-tui on Windows, falling back to the roaming profile", () => {
    expect(configDirectory(windows({ APPDATA: "C:\\Users\\kim\\AppData\\Roaming" }))).toBe(
      "C:\\Users\\kim\\AppData\\Roaming\\oop-tui",
    );
    expect(configDirectory(windows())).toBe("C:\\Users\\kim\\AppData\\Roaming\\oop-tui");
  });

  it("lets OOP_CONFIG_DIR win everywhere", () => {
    expect(configDirectory(posix({ OOP_CONFIG_DIR: "/tmp/x" }))).toBe("/tmp/x");
    expect(credentialsFilePath(posix({ OOP_CONFIG_DIR: "/tmp/x" }))).toBe(
      "/tmp/x/credentials.json",
    );
  });
});

describe("serverRuntimeFilePath", () => {
  it("defaults to the desktop app's userdata and honours an isolated home", () => {
    expect(serverRuntimeFilePath(posix())).toBe(
      "/Users/kim/.oop-desktop/userdata/server-runtime.json",
    );
    expect(serverRuntimeFilePath(posix({ OOP_HOME: "/iso" }))).toBe(
      "/iso/userdata/server-runtime.json",
    );
    expect(serverRuntimeFilePath(posix({ OOP_HOME: "/iso" }), "/flag")).toBe(
      "/flag/userdata/server-runtime.json",
    );
  });
});
