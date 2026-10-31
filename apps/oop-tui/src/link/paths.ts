import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { hostPlatform } from "../host.ts";

export interface PathEnv {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly home: string;
}

export const currentPathEnv = (): PathEnv => ({
  env: process.env,
  platform: hostPlatform(),
  home: NodeOS.homedir(),
});

/** Where the bearer token lives. Windows keeps it under %APPDATA%, everything else under ~/.config. */
export const configDirectory = ({ env, platform, home }: PathEnv): string => {
  const override = env.OOP_CONFIG_DIR?.trim();
  if (override) return override;
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    return NodePath.win32.join(
      appData || NodePath.win32.join(home, "AppData", "Roaming"),
      "oop-tui",
    );
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return NodePath.join(xdg || NodePath.join(home, ".config"), "oop-tui");
};

export const credentialsFilePath = (paths: PathEnv): string => {
  const directory = configDirectory(paths);
  return paths.platform === "win32"
    ? NodePath.win32.join(directory, "credentials.json")
    : NodePath.join(directory, "credentials.json");
};

/** The OOP home of the server to talk to: the flag, else OOP_HOME, else the desktop app's own. */
export const serverHome = (paths: PathEnv, homeOverride?: string): string =>
  homeOverride?.trim() || paths.env.OOP_HOME?.trim() || NodePath.join(paths.home, ".oop-desktop");

/**
 * The only file read from the desktop app's data directory: the running server announces its
 * address there. `homeOverride` (flag or OOP_HOME) points at an isolated server's home.
 */
export const serverRuntimeFilePath = (paths: PathEnv, homeOverride?: string): string =>
  NodePath.join(serverHome(paths, homeOverride), "userdata", "server-runtime.json");
