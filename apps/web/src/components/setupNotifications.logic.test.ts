import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type DesktopUpdateState,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  canInstallMissingProvider,
  collectProviderSetupIssues,
  isUpdateFolderUnreachable,
  providerSetupNotificationKey,
} from "./setupNotifications.logic";

const provider = (id: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-16T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const installable = {
  status: "unknown",
  currentVersion: null,
  latestVersion: null,
  updateCommand: "npm install -g @anthropic-ai/claude-code@latest",
  canUpdate: true,
  canInstallVersion: false,
  checkedAt: null,
  message: null,
} as const;

const updateState = (overrides: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.0.84",
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
  ...overrides,
});
const local = { installMode: "local-package" } as const;

describe("setup notifications", () => {
  it("offers one-click install for a structured missing-runtime diagnosis", () => {
    expect(
      canInstallMissingProvider(
        provider("minimax", {
          driver: ProviderDriverKind.make("minimax"),
          installed: false,
          status: "error",
          diagnosis: "runtime-missing",
          message: "Install MiniMax Code (npm i -g @minimax-ai/code)",
        }),
      ),
    ).toBe(true);
    // Other diagnoses stay manual: the server has no fixed install command for them.
    expect(
      canInstallMissingProvider(
        provider("zcode", {
          driver: ProviderDriverKind.make("zcode"),
          installed: true,
          status: "warning",
          diagnosis: "runtime-error",
        }),
      ),
    ).toBe(false);
  });

  it("flags an unreachable update folder only for failed local-folder checks", () => {
    expect(
      isUpdateFolderUnreachable(updateState({ ...local, status: "error", errorContext: "check" })),
    ).toBe(true);
    expect(isUpdateFolderUnreachable(updateState({ ...local, status: "up-to-date" }))).toBe(false);
    expect(
      isUpdateFolderUnreachable(
        updateState({ ...local, status: "error", errorContext: "download" }),
      ),
    ).toBe(false);
    expect(isUpdateFolderUnreachable(updateState({ status: "error", errorContext: "check" }))).toBe(
      false,
    );
    expect(isUpdateFolderUnreachable(null)).toBe(false);
  });

  it("separates one-click installs from manual installs and sign-ins", () => {
    const issues = collectProviderSetupIssues([
      provider("ready"),
      provider("missing-npm", { installed: false, versionAdvisory: installable }),
      provider("missing-manual", { installed: false }),
      provider("signed-out", { auth: { status: "unauthenticated" } }),
      provider("disabled", { enabled: false, installed: false }),
    ]);
    expect(issues.map((issue) => [issue.provider.instanceId, issue.need])).toEqual([
      ["missing-npm", "install"],
      ["missing-manual", "install-manually"],
      ["signed-out", "sign-in"],
    ]);
    expect(canInstallMissingProvider(issues[0]!.provider)).toBe(true);
    expect(canInstallMissingProvider(issues[1]!.provider)).toBe(false);
  });

  it("keys a set of issues independently of order", () => {
    const a = collectProviderSetupIssues([
      provider("a", { installed: false }),
      provider("b", { auth: { status: "unauthenticated" } }),
    ]);
    const b = collectProviderSetupIssues([
      provider("b", { auth: { status: "unauthenticated" } }),
      provider("a", { installed: false }),
    ]);
    expect(providerSetupNotificationKey(a)).toBe(providerSetupNotificationKey(b));
    expect(providerSetupNotificationKey([])).toBeNull();
  });
});
