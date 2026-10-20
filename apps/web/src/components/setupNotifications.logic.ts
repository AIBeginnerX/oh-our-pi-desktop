import {
  PROVIDER_DISPLAY_NAMES,
  type DesktopUpdateState,
  type ServerProvider,
} from "@t3tools/contracts";

/** A missing CLI the server can install in one click (it found an installer such as npm). */
export function canInstallMissingProvider(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    !provider.installed &&
    provider.versionAdvisory?.canUpdate === true &&
    provider.versionAdvisory.updateCommand !== null
  );
}

/** The desktop app's update folder (the NAS share) could not be read on the last check. */
export function isUpdateFolderUnreachable(state: DesktopUpdateState | null): boolean {
  return (
    state?.installMode === "local-package" &&
    state.status === "error" &&
    state.errorContext === "check"
  );
}

export type ProviderSetupNeed = "install" | "install-manually" | "sign-in";

export interface ProviderSetupIssue {
  readonly provider: ServerProvider;
  readonly need: ProviderSetupNeed;
  readonly name: string;
}

/** Enabled providers that cannot run yet, in the order they appear. */
export function collectProviderSetupIssues(
  providers: ReadonlyArray<ServerProvider>,
): ProviderSetupIssue[] {
  const issues: ProviderSetupIssue[] = [];
  for (const provider of providers) {
    if (!provider.enabled || provider.status === "disabled") continue;
    const name =
      provider.displayName?.trim() || PROVIDER_DISPLAY_NAMES[provider.driver] || provider.driver;
    if (!provider.installed) {
      issues.push({
        provider,
        name,
        need: canInstallMissingProvider(provider) ? "install" : "install-manually",
      });
    } else if (provider.auth.status === "unauthenticated") {
      issues.push({ provider, name, need: "sign-in" });
    }
  }
  return issues;
}

/** Identifies one set of issues, so the same set is announced once per session. */
export function providerSetupNotificationKey(issues: ReadonlyArray<ProviderSetupIssue>) {
  if (issues.length === 0) return null;
  return issues
    .map((issue) => `${issue.provider.instanceId}:${issue.need}`)
    .toSorted()
    .join("|");
}

export function describeProviderSetupIssue(issue: ProviderSetupIssue): string {
  switch (issue.need) {
    case "install":
      return `${issue.name}: not installed — one click installs it.`;
    case "install-manually":
      return `${issue.name}: not installed — install Node.js for one-click installs, or follow provider settings.`;
    case "sign-in":
      return `${issue.name}: sign in to start using it.`;
  }
}
