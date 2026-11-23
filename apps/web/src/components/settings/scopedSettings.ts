import {
  ClientSettingsSchema,
  type ClientSettingsPatch,
  type EnvironmentId,
  isNullableProjectSettingsOverride,
  MAX_SCHEDULED_PROMPTS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectId,
  type ProjectScript,
  type ScheduledPrompt,
  type ScheduledPromptOperation,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverridePatch,
  ServerSettings,
  type T3ProjectFile,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  resolveProjectSettings,
  resolveWorktreeCleanup,
  type ProjectSettingSource,
} from "@t3tools/shared/projectSettings";
import {
  applyScheduledPromptOperations,
  projectOverrideOperationsPatch,
} from "@t3tools/shared/serverSettings";
import * as Equal from "effect/Equal";

import type { ResolvedSettingsScope } from "./settingsScope";

export type ScopedSettingsPatch = ServerSettingsPatch & ClientSettingsPatch;

interface ScopedSettingsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: {
    readonly settings: ServerSettings;
    readonly environment?: {
      readonly capabilities: { readonly projectSettingsOverrides?: boolean | undefined };
    };
  } | null;
}

const SERVER_KEYS = new Set<string>(Object.keys(ServerSettings.fields));
const CLIENT_KEYS = new Set<string>(Object.keys(ClientSettingsSchema.fields));
const PROJECT_SCOPED_KEYS = new Set<string>(PROJECT_SCOPED_SERVER_SETTING_KEYS);

export function isProjectScopedSettingKey(key: string): key is ProjectScopedServerSettingKey {
  return PROJECT_SCOPED_KEYS.has(key);
}

/** The representative supplies display values, never the set of write targets. */
export function selectScopedSettingsEnvironments<T extends ScopedSettingsEnvironment>(
  scope: ResolvedSettingsScope,
  available: readonly T[],
  primaryEnvironmentId: EnvironmentId | null,
) {
  const selectedIds = new Set(scope.environmentIds);
  const environments = available.filter((environment) =>
    selectedIds.has(environment.environmentId),
  );
  const connectedEnvironments = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const environment =
    connectedEnvironments.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    connectedEnvironments[0] ??
    null;
  return { environments, connectedEnvironments, environment };
}

/**
 * One (environment, project) pair the scope writes to, with that project's
 * effective settings. Environment scopes have no member and read the
 * environment settings directly.
 */
export interface ScopedSettingsTarget {
  readonly environmentId: EnvironmentId;
  /** The environment's label; a project is the same project on every environment. */
  readonly label: string;
  readonly projectId: ProjectId | null;
  readonly settings: ServerSettings;
  readonly sources: Readonly<Record<ProjectScopedServerSettingKey, ProjectSettingSource>>;
}

/** Effective settings per connected target: members at project scope, environments otherwise. */
export function resolveScopedSettingsTargets(
  scope: ResolvedSettingsScope,
  connectedEnvironments: readonly ScopedSettingsEnvironment[],
  // Each member's decoded t3.json, keyed by physical project key, once read.
  // A member absent here has no file tier yet; null is a missing or invalid file.
  projectFiles?: ReadonlyMap<string, T3ProjectFile | null>,
): readonly ScopedSettingsTarget[] {
  const byId = new Map(
    connectedEnvironments.map((environment) => [environment.environmentId, environment]),
  );
  if (scope.kind === "project" || scope.kind === "checkout") {
    return scope.members.flatMap((member) => {
      const environment = byId.get(member.environmentId);
      if (!environment?.serverConfig) return [];
      const projectFile = projectFiles?.get(member.physicalProjectKey);
      const resolved =
        projectFile === undefined
          ? resolveProjectSettings(environment.serverConfig.settings, member.id)
          : resolveProjectSettings(environment.serverConfig.settings, member.id, null, projectFile);
      return [
        {
          environmentId: member.environmentId,
          label: environment.label,
          projectId: member.id,
          settings: resolved.settings,
          sources: resolved.sources,
        },
      ];
    });
  }
  return connectedEnvironments.flatMap((environment) =>
    environment.serverConfig
      ? [
          {
            environmentId: environment.environmentId,
            label: environment.label,
            projectId: null,
            settings: environment.serverConfig.settings,
            sources: resolveProjectSettings(environment.serverConfig.settings, null).sources,
          },
        ]
      : [],
  );
}

export function scopedSettingsAreMixed(
  targets: readonly Pick<ScopedSettingsTarget, "settings">[],
  keys: readonly (keyof ServerSettings)[],
): boolean {
  const first = targets[0];
  return (
    first !== undefined &&
    targets.some((candidate) =>
      keys.some((key) => !Equal.equals(first.settings[key], candidate.settings[key])),
    )
  );
}

export type ScopedSettingSource = ProjectSettingSource | "mixed";

/** Whether the keys are overridden on every target, inherited on every target, or split. */
export function scopedSettingsSource(
  targets: readonly Pick<ScopedSettingsTarget, "sources">[],
  keys: readonly (keyof ServerSettings)[],
): ScopedSettingSource {
  const scoped = keys.filter(isProjectScopedSettingKey);
  if (scoped.length === 0 || targets.length === 0) return "environment";
  const sources = new Set(targets.flatMap((target) => scoped.map((key) => target.sources[key])));
  return sources.size > 1
    ? "mixed"
    : sources.has("project")
      ? "project"
      : sources.has("t3.json")
        ? "t3.json"
        : "environment";
}

interface ScopedServerWrite {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly patch: ServerSettingsPatch;
}

export function scheduledPromptWrite(
  current: readonly ScheduledPrompt[],
  operation: ScheduledPromptOperation,
): ServerSettingsPatch | null {
  const scheduledPromptOperations = [operation];
  const scheduledPrompts = applyScheduledPromptOperations(current, scheduledPromptOperations);
  return scheduledPrompts.length > MAX_SCHEDULED_PROMPTS
    ? null
    : { scheduledPromptOperations, scheduledPrompts };
}

export function projectScriptsOverridePatch(
  settings: ServerSettings,
  projectId: ProjectId,
  scripts: readonly ProjectScript[] | null,
): ServerSettingsPatch {
  return projectOverrideOperationsPatch(settings, {
    [projectId]:
      scripts === null
        ? { unset: ["defaultProjectScripts"] }
        : { set: { defaultProjectScripts: scripts } },
  });
}

function projectOverrideWrites(
  scope: Extract<ResolvedSettingsScope, { kind: "project" | "checkout" }>,
  environments: readonly ScopedSettingsEnvironment[],
  patch: ProjectSettingsOverridePatch,
): ScopedServerWrite[] {
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  const writes = new Map<EnvironmentId, ScopedServerWrite>();
  for (const member of scope.members) {
    const environment = byId.get(member.environmentId);
    if (
      !environment?.serverConfig ||
      environment.connection.phase !== "connected" ||
      environment.serverConfig.environment?.capabilities.projectSettingsOverrides !== true
    ) {
      continue;
    }
    const existing = writes.get(member.environmentId);
    writes.set(member.environmentId, {
      environmentId: member.environmentId,
      label: environment.label,
      patch: projectOverrideOperationsPatch(environment.serverConfig.settings, {
        ...existing?.patch.projectSettingsOverridePatches,
        [member.id]: patch,
      }),
    });
  }
  return [...writes.values()];
}

function planProjectOverridePatch(patch: ServerSettingsPatch): ProjectSettingsOverridePatch {
  const set: Record<string, unknown> = {};
  const unset: ProjectScopedServerSettingKey[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!isProjectScopedSettingKey(key)) continue;
    if (value === null && !isNullableProjectSettingsOverride(key)) unset.push(key);
    else set[key] = value;
  }
  return { set: set as NonNullable<ProjectSettingsOverridePatch["set"]>, unset };
}

/**
 * Environment scopes write the patch to every connected environment; project
 * and checkout scopes write the scopable keys into each member's override
 * entry on its environment. Client keys always persist locally.
 */
export function planScopedSettingsPatch(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  patch: ScopedSettingsPatch,
) {
  const clientPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => CLIENT_KEYS.has(key)),
  ) as ClientSettingsPatch;
  const serverPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => SERVER_KEYS.has(key)),
  ) as ServerSettingsPatch;
  const serverKeys = Object.keys(serverPatch);
  const { connectedEnvironments } = selectScopedSettingsEnvironments(scope, environments, null);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unscopableKeys = isProjectScope
    ? serverKeys.filter((key) => !isProjectScopedSettingKey(key))
    : [];
  const serverWrites: ScopedServerWrite[] =
    serverKeys.length === 0
      ? []
      : isProjectScope
        ? unscopableKeys.length > 0
          ? []
          : projectOverrideWrites(scope, environments, planProjectOverridePatch(serverPatch))
        : scope.kind === "all" || scope.kind === "environment"
          ? connectedEnvironments.map((environment) => ({
              environmentId: environment.environmentId,
              label: environment.label,
              patch:
                environment.serverConfig?.settings.worktreeCleanup != null &&
                serverPatch.storageCleanup &&
                Object.keys(serverPatch.storageCleanup).some((key) => key.startsWith("worktree"))
                  ? {
                      ...serverPatch,
                      worktreeCleanup: {
                        mode: "custom",
                        rules: {
                          ...resolveWorktreeCleanup(environment.serverConfig.settings, null),
                          ...Object.fromEntries(
                            Object.entries(serverPatch.storageCleanup).filter(([key]) =>
                              key.startsWith("worktree"),
                            ),
                          ),
                        },
                      },
                    }
                  : serverPatch,
            }))
          : [];
  const hasClientWrite = Object.keys(clientPatch).length > 0;
  const hasWrite = hasClientWrite || serverWrites.length > 0;
  const unavailableReason =
    hasWrite || Object.keys(patch).length === 0
      ? null
      : scope.kind === "unavailable"
        ? scope.message
        : unscopableKeys.length > 0
          ? "This setting is environment-wide and cannot be overridden by a project."
          : isProjectScope
            ? "Connect the selected checkouts, or update their environments, to save a project override."
            : `Connect ${scope.kind === "environment" ? scope.label : "an environment"} to save this setting.`;
  return { clientPatch, hasClientWrite, serverWrites, unavailableReason };
}

/** Remove the keys' project overrides so each member inherits its environment value again. */
export function planScopedSettingsClear(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  keys: readonly ProjectScopedServerSettingKey[],
) {
  const serverWrites =
    scope.kind === "project" || scope.kind === "checkout"
      ? projectOverrideWrites(scope, environments, { unset: keys })
      : [];
  return {
    clientPatch: {} as ClientSettingsPatch,
    hasClientWrite: false,
    serverWrites,
    unavailableReason:
      serverWrites.length > 0
        ? null
        : "Connect the selected checkouts, or update their environments, to reset this override.",
  };
}

export interface ProjectOverrideEntry {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/**
 * The projects on the selected environments that override `keys`. An
 * environment edit leaves these untouched, so the row can name them and
 * offer to clear them.
 */
export function listProjectOverrides(
  environments: readonly ScopedSettingsEnvironment[],
  keys: readonly (keyof ServerSettings)[],
): readonly ProjectOverrideEntry[] {
  const scoped = keys.filter(isProjectScopedSettingKey);
  if (scoped.length === 0) return [];
  return environments.flatMap((environment) => {
    const overrides = environment.serverConfig?.settings.projectSettingsOverrides;
    if (!overrides) return [];
    return Object.entries(overrides).flatMap(([projectId, entry]) =>
      scoped.some((key) => Object.hasOwn(entry, key))
        ? [{ environmentId: environment.environmentId, projectId: projectId as ProjectId }]
        : [],
    );
  });
}

/** Drop `keys` from the named project entries so they follow the environment again. */
export function planProjectOverridesClear(
  environments: readonly ScopedSettingsEnvironment[],
  entries: readonly ProjectOverrideEntry[],
  keys: readonly ProjectScopedServerSettingKey[],
) {
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  const writes = new Map<EnvironmentId, ScopedServerWrite>();
  for (const { environmentId, projectId } of entries) {
    const environment = byId.get(environmentId);
    if (!environment?.serverConfig || environment.connection.phase !== "connected") continue;
    const existing = writes.get(environmentId);
    writes.set(environmentId, {
      environmentId,
      label: environment.label,
      patch: projectOverrideOperationsPatch(environment.serverConfig.settings, {
        ...existing?.patch.projectSettingsOverridePatches,
        [projectId]: { unset: keys },
      }),
    });
  }
  const serverWrites = [...writes.values()];
  return {
    clientPatch: {} as ClientSettingsPatch,
    hasClientWrite: false,
    serverWrites,
    unavailableReason:
      serverWrites.length > 0 ? null : "Connect the environments to reset these overrides.",
  };
}

/** Wait for every target so a failed environment does not hide successful or later writes. */
export async function persistScopedSettingsPatch(
  plan: ReturnType<typeof planScopedSettingsPatch>,
  persistServer: (input: {
    environmentId: EnvironmentId;
    input: { patch: ServerSettingsPatch };
  }) => Promise<{ readonly _tag: "Success" | "Failure" }>,
  persistClient: (patch: ClientSettingsPatch) => void,
) {
  if (plan.hasClientWrite) persistClient(plan.clientPatch);
  const results = await Promise.allSettled(
    plan.serverWrites.map(({ environmentId, patch }) =>
      persistServer({ environmentId, input: { patch } }),
    ),
  );
  const failedEnvironments = plan.serverWrites.filter((_, index) => {
    const result = results[index];
    return result?.status !== "fulfilled" || result.value._tag === "Failure";
  });
  return {
    failedEnvironments,
    savedEnvironmentCount: plan.serverWrites.length - failedEnvironments.length,
  };
}
