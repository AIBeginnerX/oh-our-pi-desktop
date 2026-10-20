import * as Option from "effect/Option";

declare const __T3CODE_BUILD_DESKTOP_PROFILE_NAME__: string | undefined;

const embeddedProfileName =
  typeof __T3CODE_BUILD_DESKTOP_PROFILE_NAME__ === "undefined"
    ? ""
    : __T3CODE_BUILD_DESKTOP_PROFILE_NAME__;

export function resolveDesktopBuildProfileName(value = embeddedProfileName): Option.Option<string> {
  if (value.length === 0) return Option.none();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("Desktop build profile name must be one safe path segment.");
  }
  return Option.some(value);
}

export function resolveDesktopProfileHome(input: {
  readonly configuredHome: Option.Option<string>;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly buildProfileName?: string | undefined;
}): Option.Option<string> {
  if (Option.isSome(input.configuredHome) && input.configuredHome.value.trim().length > 0) {
    return input.configuredHome;
  }
  return Option.map(resolveDesktopBuildProfileName(input.buildProfileName), (name) =>
    input.joinPath(input.homeDirectory, `.${name}`),
  );
}

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () =>
    input.joinPath(input.homeDirectory, ".t3"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
