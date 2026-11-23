import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  listProjectOverrides,
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  projectScriptsOverridePatch,
  resolveScopedSettingsTargets,
  scheduledPromptWrite,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  selectScopedSettingsEnvironments,
} from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";

const decodeLegacySettingsPatch = Schema.decodeUnknownSync(
  Schema.Struct({
    projectSettingsOverrides: ServerSettingsPatch.fields.projectSettingsOverrides,
    scheduledPrompts: ServerSettingsPatch.fields.scheduledPrompts,
  }),
);

function environment(
  id: string,
  options: {
    connected?: boolean;
    loaded?: boolean;
    settings?: Partial<ServerSettings>;
    projectOverrides?: boolean;
  } = {},
) {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: {
      phase: options.connected === false ? ("offline" as const) : ("connected" as const),
    },
    serverConfig:
      options.loaded === false
        ? null
        : {
            settings: { ...DEFAULT_SERVER_SETTINGS, ...options.settings },
            environment: {
              capabilities: { projectSettingsOverrides: options.projectOverrides !== false },
            },
          },
  };
}

const laptop = environment("Laptop");
const server = environment("Server");
const offline = environment("Offline", { connected: false });
const loading = environment("Loading", { loaded: false });
const environments = [laptop, server, offline, loading];
const all = resolveSettingsScope({}, [], environments);
const named = resolveSettingsScope({ machine: server.environmentId }, [], environments);

const projectId = ProjectId.make("project");
const laptopProjectId = ProjectId.make("laptop-project");
const member = {
  id: projectId,
  environmentId: server.environmentId,
  title: "Project",
  workspaceRoot: "/repo",
  physicalProjectKey: `${server.environmentId}:/repo`,
  environmentLabel: server.label,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const laptopMember = {
  ...member,
  id: laptopProjectId,
  environmentId: laptop.environmentId,
  physicalProjectKey: `${laptop.environmentId}:/repo`,
  environmentLabel: laptop.label,
};
const group: SidebarProjectSnapshot = {
  ...member,
  projectKey: "project-group",
  displayName: "Project",
  memberProjects: [member, laptopMember],
  memberProjectRefs: [
    { environmentId: server.environmentId, projectId },
    { environmentId: laptop.environmentId, projectId: laptopProjectId },
  ],
  groupedProjectCount: 2,
  environmentPresence: "remote-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  remoteEnvironmentLabels: [server.label, laptop.label],
};
const project = resolveSettingsScope({ project: group.projectKey }, [group], environments);
const checkout = resolveSettingsScope(
  { project: group.projectKey, machine: server.environmentId, checkout: member.physicalProjectKey },
  [group],
  environments,
);

describe("scoped settings targets", () => {
  it("uses the named environment even when a different primary is available", () => {
    const selected = selectScopedSettingsEnvironments(named, environments, laptop.environmentId);
    expect(selected.environments).toEqual([server]);
    expect(selected.environment).toBe(server);
  });

  it("keeps an offline named environment selected without falling back to primary", () => {
    const scope = resolveSettingsScope({ machine: offline.environmentId }, [], environments);
    const selected = selectScopedSettingsEnvironments(scope, environments, laptop.environmentId);
    expect(selected.environments).toEqual([offline]);
    expect(selected.connectedEnvironments).toEqual([]);
    expect(selected.environment).toBeNull();
    expect(
      planScopedSettingsPatch(scope, environments, { enableProviderUpdateChecks: false }),
    ).toMatchObject({
      serverWrites: [],
      unavailableReason: "Connect Offline to save this setting.",
    });
  });

  it("prefers the selected primary as the aggregate representative without including disconnected targets", () => {
    const selected = selectScopedSettingsEnvironments(all, environments, server.environmentId);
    expect(selected.environment).toBe(server);
    expect(selected.environments).toEqual(environments);
    expect(selected.connectedEnvironments).toEqual([laptop, server]);
  });

  it("resolves each member's effective settings and source at project scope", () => {
    const overridden = environment("Server", {
      settings: {
        defaultAutoPull: false,
        projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
      },
    });
    const targets = resolveScopedSettingsTargets(project, [laptop, overridden]);
    expect(targets.map((target) => [target.projectId, target.settings.defaultAutoPull])).toEqual([
      [projectId, true],
      [laptopProjectId, false],
    ]);
    expect(scopedSettingsSource(targets, ["defaultAutoPull"])).toBe("mixed");
    expect(scopedSettingsSource([targets[0]!], ["defaultAutoPull"])).toBe("project");
    expect(scopedSettingsSource(targets, ["enableProviderUpdateChecks"])).toBe("environment");
    expect(scopedSettingsAreMixed(targets, ["defaultAutoPull"])).toBe(true);
  });
});

describe("scoped settings writes", () => {
  it("edits the effective machine policy without changing other machines' rules", () => {
    const custom = environment("Laptop", {
      settings: {
        worktreeCleanup: {
          mode: "custom",
          rules: {
            worktreeAfterDays: 12,
            worktreeOnDelete: true,
            worktreeOnMerge: true,
            worktreeUnchanged: false,
          },
        },
      },
    });
    const disabled = environment("Server", {
      settings: { worktreeCleanup: { mode: "off" } },
    });
    const targets = [custom, disabled];
    const plan = planScopedSettingsPatch(all, targets, {
      storageCleanup: { worktreeOnDelete: false },
    });
    const policies = plan.serverWrites.map((write, index) =>
      resolveWorktreeCleanup(
        applyServerSettingsPatch(targets[index]!.serverConfig!.settings, write.patch),
        null,
      ),
    );
    expect(policies).toEqual([
      {
        worktreeAfterDays: 12,
        worktreeOnDelete: false,
        worktreeOnMerge: true,
        worktreeUnchanged: false,
      },
      {
        worktreeAfterDays: null,
        worktreeOnDelete: false,
        worktreeOnMerge: false,
        worktreeUnchanged: false,
      },
    ]);
  });
  it("isolates a formerly shared server preference to the named environment", async () => {
    const persistServer = vi.fn().mockResolvedValue({ _tag: "Success" });
    const persistClient = vi.fn();
    await persistScopedSettingsPatch(
      planScopedSettingsPatch(named, environments, { sidebarAutoSettleOnMerge: false }),
      persistServer,
      persistClient,
    );
    expect(persistServer.mock.calls).toEqual([
      [
        {
          environmentId: server.environmentId,
          input: { patch: { sidebarAutoSettleOnMerge: false } },
        },
      ],
    ]);
    expect(persistClient).not.toHaveBeenCalled();
  });

  it("writes an aggregate preference only to connected environments with loaded configuration", async () => {
    const persistServer = vi.fn().mockResolvedValue({ _tag: "Success" });
    const persistClient = vi.fn();
    await persistScopedSettingsPatch(
      planScopedSettingsPatch(all, environments, { enableProviderUpdateChecks: false }),
      persistServer,
      persistClient,
    );
    expect(persistServer.mock.calls.map(([input]) => input.environmentId)).toEqual([
      laptop.environmentId,
      server.environmentId,
    ]);
    expect(persistClient).not.toHaveBeenCalled();
  });

  it("persists client keys locally at any scope alongside server keys", async () => {
    const persistServer = vi.fn().mockResolvedValue({ _tag: "Success" });
    const persistClient = vi.fn();
    await persistScopedSettingsPatch(
      planScopedSettingsPatch(named, environments, {
        diffIgnoreWhitespace: false,
        enableProviderUpdateChecks: false,
      }),
      persistServer,
      persistClient,
    );
    expect(persistClient).toHaveBeenCalledExactlyOnceWith({ diffIgnoreWhitespace: false });
    expect(persistServer).toHaveBeenCalledExactlyOnceWith({
      environmentId: server.environmentId,
      input: { patch: { enableProviderUpdateChecks: false } },
    });
  });

  it("writes project overrides into each member's entry on its environment", () => {
    const withExisting = environment("Server", {
      settings: {
        projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } },
      },
    });
    const plan = planScopedSettingsPatch(project, [laptop, withExisting], {
      defaultAutoPull: true,
    });
    expect(plan.unavailableReason).toBeNull();
    expect(plan.serverWrites.map(({ environmentId }) => environmentId)).toEqual([
      server.environmentId,
      laptop.environmentId,
    ]);
    const settings = withExisting.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
    expect(
      applyServerSettingsPatch(settings, plan.serverWrites[0]!.patch).projectSettingsOverrides,
    ).toEqual({ [projectId]: { enableAgentBrowserAccess: false, defaultAutoPull: true } });
    expect(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, plan.serverWrites[1]!.patch)
        .projectSettingsOverrides,
    ).toEqual({ [laptopProjectId]: { defaultAutoPull: true } });
    expect(
      planScopedSettingsPatch(checkout, [laptop, server], { defaultAutoPull: true }),
    ).toMatchObject({
      serverWrites: [{ environmentId: server.environmentId }],
    });
  });

  it("keeps each project's other cleanup rules when changing one rule across machines", () => {
    const machine = environment("Laptop", {
      settings: {
        storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeAfterDays: 30 },
      },
    });
    const customized = environment("Server", {
      settings: {
        projectSettingsOverrides: {
          [projectId]: {
            defaultAutoPull: true,
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: 8,
                worktreeOnDelete: false,
                worktreeOnMerge: true,
                worktreeUnchanged: false,
              },
            },
          },
        },
      },
    });
    const plan = planScopedSettingsPatch(project, [machine, customized], {
      worktreeCleanup: { mode: "custom", rules: { worktreeOnDelete: true } },
    });
    expect(
      plan.serverWrites.map(({ environmentId, patch }) => {
        const target = environmentId === machine.environmentId ? machine : customized;
        return applyServerSettingsPatch(
          target.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
          patch,
        ).projectSettingsOverrides;
      }),
    ).toEqual([
      {
        [projectId]: {
          defaultAutoPull: true,
          worktreeCleanup: {
            mode: "custom",
            rules: {
              worktreeAfterDays: 8,
              worktreeOnDelete: true,
              worktreeOnMerge: true,
              worktreeUnchanged: false,
            },
          },
        },
      },
      {
        [laptopProjectId]: {
          worktreeCleanup: {
            mode: "custom",
            rules: {
              worktreeAfterDays: 30,
              worktreeOnDelete: true,
              worktreeOnMerge: false,
              worktreeUnchanged: false,
            },
          },
        },
      },
    ]);
    expect(
      applyServerSettingsPatch(
        customized.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
        planScopedSettingsClear(checkout, [customized], ["worktreeCleanup"]).serverWrites[0]!.patch,
      ).projectSettingsOverrides,
    ).toEqual({ [projectId]: { defaultAutoPull: true } });
    expect(
      planScopedSettingsPatch(project, [machine, customized], {
        storageCleanup: { browserArtifactsAfterDays: 8 },
      }).serverWrites,
    ).toEqual([]);
  });

  it("scopes agent device access to projects while keeping hub and hosts environment-wide", () => {
    const plan = planScopedSettingsPatch(project, [laptop, server], {
      enableAgentDeviceAccess: true,
    });
    expect(
      plan.serverWrites.map(
        ({ patch }) =>
          applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch).projectSettingsOverrides,
      ),
    ).toEqual([
      { [projectId]: { enableAgentDeviceAccess: true } },
      { [laptopProjectId]: { enableAgentDeviceAccess: true } },
    ]);
    for (const patch of [{ enableDeviceSupport: true }, { deviceHosts: [] }]) {
      expect(planScopedSettingsPatch(project, environments, patch).serverWrites).toEqual([]);
    }
  });

  it("refuses environment-wide keys and older servers at project scope", () => {
    expect(
      planScopedSettingsPatch(project, environments, { enableProviderUpdateChecks: false }),
    ).toMatchObject({
      serverWrites: [],
      unavailableReason: "This setting is environment-wide and cannot be overridden by a project.",
    });
    const legacy = environment("Server", { projectOverrides: false });
    expect(
      planScopedSettingsPatch(checkout, [laptop, legacy], { defaultAutoPull: true }),
    ).toMatchObject({ serverWrites: [], unavailableReason: expect.stringContaining("update") });
  });

  it("clears overrides per member and removes an emptied entry", () => {
    const withOverrides = environment("Server", {
      settings: {
        projectSettingsOverrides: {
          [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
        },
      },
    });
    const plan = planScopedSettingsClear(checkout, [laptop, withOverrides], ["defaultAutoPull"]);
    const settings = withOverrides.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
    expect(plan.serverWrites.map(({ environmentId }) => environmentId)).toEqual([
      server.environmentId,
    ]);
    expect(
      applyServerSettingsPatch(settings, plan.serverWrites[0]!.patch).projectSettingsOverrides,
    ).toEqual({ [projectId]: { enableAgentBrowserAccess: false } });
    const clearBoth = planScopedSettingsClear(
      checkout,
      [laptop, withOverrides],
      ["defaultAutoPull", "enableAgentBrowserAccess"],
    );
    expect(
      applyServerSettingsPatch(settings, clearBoth.serverWrites[0]!.patch).projectSettingsOverrides,
    ).toEqual({});
  });

  it("never substitutes an environment-default write for an invalid scope", () => {
    const scope = resolveSettingsScope({ machine: "removed" }, [group], environments);
    const plan = planScopedSettingsPatch(scope, environments, { enableAgentBrowserAccess: false });
    expect(plan.serverWrites).toEqual([]);
    expect(plan.hasClientWrite).toBe(false);
    expect(plan.unavailableReason).not.toBeNull();
  });

  it("waits for every target and identifies both RPC failures and rejected writes", async () => {
    const third = environment("Third");
    const fourth = environment("Fourth");
    const selected = [...environments, third, fourth];
    const scope = resolveSettingsScope({}, [], selected);
    const persistServer = vi
      .fn()
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockRejectedValueOnce(new Error("Disconnected during save"))
      .mockResolvedValueOnce({ _tag: "Success" });
    const result = await persistScopedSettingsPatch(
      planScopedSettingsPatch(scope, selected, { enableAgentBrowserAccess: false }),
      persistServer,
      vi.fn(),
    );
    expect(result.savedEnvironmentCount).toBe(2);
    expect(result.failedEnvironments.map(({ label }) => label)).toEqual([
      server.label,
      third.label,
    ]);
    expect(persistServer).toHaveBeenCalledTimes(4);
  });
});

describe("scoped settings mixed values", () => {
  it("compares only requested settings across connected targets", () => {
    const changed = environment("Changed", { settings: { enableAgentBrowserAccess: false } });
    const targets = resolveScopedSettingsTargets(all, [laptop, changed]);
    expect(scopedSettingsAreMixed(targets, ["enableAgentBrowserAccess"])).toBe(true);
    expect(scopedSettingsAreMixed(targets, ["enableProviderUpdateChecks"])).toBe(false);
    expect(scopedSettingsAreMixed([], ["enableAgentBrowserAccess"])).toBe(false);
  });

  it("treats independently decoded equal nested settings as the same value", () => {
    const style = {
      ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
      mode: "custom" as const,
      customInstructions: "Use plain language",
    };
    const first = environment("First", { settings: { sourceControlWritingStyle: { ...style } } });
    const second = environment("Second", { settings: { sourceControlWritingStyle: { ...style } } });
    const targets = resolveScopedSettingsTargets(all, [first, second]);
    expect(scopedSettingsAreMixed(targets, ["sourceControlWritingStyle"])).toBe(false);
  });
});

describe("project overrides at environment scope", () => {
  const laptop = EnvironmentId.make("laptop");
  const desk = EnvironmentId.make("desk");
  const fleet = ProjectId.make("fleet");
  const t3 = ProjectId.make("t3");
  const environment = (
    environmentId: EnvironmentId,
    overrides: ServerSettings["projectSettingsOverrides"],
  ) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" as const },
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, projectSettingsOverrides: overrides },
      environment: { capabilities: { projectSettingsOverrides: true } },
    },
  });

  it("lists only the projects that override the keys", () => {
    const entries = listProjectOverrides(
      [
        environment(laptop, {
          [fleet]: { defaultAutoPull: true, defaultThreadEnvMode: "local" },
          [t3]: { defaultThreadEnvMode: "local" },
        }),
        environment(desk, { [fleet]: { defaultAutoPull: false } }),
      ],
      ["defaultAutoPull"],
    );
    expect(entries).toEqual([
      { environmentId: laptop, projectId: fleet },
      { environmentId: desk, projectId: fleet },
    ]);
  });

  it("clears only those keys and drops entries that become empty", () => {
    const target = environment(laptop, {
      [fleet]: { defaultAutoPull: true, defaultThreadEnvMode: "local" },
      [t3]: { defaultAutoPull: true },
    });
    const plan = planProjectOverridesClear(
      [target],
      [
        { environmentId: laptop, projectId: fleet },
        { environmentId: laptop, projectId: t3 },
      ],
      ["defaultAutoPull"],
    );
    expect(plan.serverWrites.map(({ environmentId }) => environmentId)).toEqual([laptop]);
    expect(
      applyServerSettingsPatch(target.serverConfig.settings, plan.serverWrites[0]!.patch)
        .projectSettingsOverrides,
    ).toEqual({ [fleet]: { defaultThreadEnvMode: "local" } });
  });
});

describe("null patches at project scope", () => {
  it("removes the override for keys that cannot store null and keeps it for keys that can", () => {
    const environmentId = EnvironmentId.make("laptop");
    const projectId = ProjectId.make("fleet");
    const scope = {
      kind: "project" as const,
      group: {} as never,
      environmentId: null,
      label: "fleet",
      members: [{ id: projectId, environmentId } as never],
      environmentIds: [environmentId],
    };
    const environments = [
      {
        environmentId,
        label: "Laptop",
        connection: { phase: "connected" as const },
        serverConfig: {
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            projectSettingsOverrides: {
              [projectId]: { defaultThreadEnvMode: "worktree" as const, defaultAutoPull: true },
            },
          },
          environment: { capabilities: { projectSettingsOverrides: true } },
        },
      },
    ];
    const inherit = planScopedSettingsPatch(scope, environments, { defaultThreadEnvMode: null });
    const unsetModel = planScopedSettingsPatch(scope, environments, {
      defaultModelSelection: null,
    });
    const settings = environments[0]!.serverConfig.settings;
    expect(
      applyServerSettingsPatch(settings, inherit.serverWrites[0]!.patch).projectSettingsOverrides,
    ).toEqual({ [projectId]: { defaultAutoPull: true } });
    expect(
      applyServerSettingsPatch(settings, unsetModel.serverWrites[0]!.patch)
        .projectSettingsOverrides,
    ).toEqual({
      [projectId]: {
        defaultThreadEnvMode: "worktree",
        defaultAutoPull: true,
        defaultModelSelection: null,
      },
    });
  });
});

describe("partial object patches at project scope", () => {
  it("keeps writing instructions and template changes made from the same snapshot", () => {
    const environmentId = EnvironmentId.make("laptop");
    const projectId = ProjectId.make("fleet");
    const member = {
      id: projectId,
      environmentId,
      physicalProjectKey: "laptop:/repo",
      environmentLabel: "Laptop",
      title: "fleet",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: {
          sourceControlWritingStyle: {
            mode: "custom" as const,
            customInstructions: "Keep it short.",
            followChangeRequestTemplates: false,
          },
        },
      },
    };
    const scope = {
      kind: "project" as const,
      group: {} as never,
      environmentId: null,
      label: "fleet",
      members: [member as never],
      environmentIds: [environmentId],
    };
    const environments = [environment("laptop", { settings })];
    const instructions = planScopedSettingsPatch(scope, environments, {
      sourceControlWritingStyle: { customInstructions: "Be terse." },
    });
    const templates = planScopedSettingsPatch(scope, environments, {
      sourceControlWritingStyle: { followChangeRequestTemplates: true },
    });
    const saved = [...instructions.serverWrites, ...templates.serverWrites].reduce(
      (current, { patch }) => applyServerSettingsPatch(current, patch),
      settings as ServerSettings,
    );
    expect(saved.projectSettingsOverrides[projectId]?.sourceControlWritingStyle).toEqual({
      mode: "custom",
      customInstructions: "Be terse.",
      followChangeRequestTemplates: true,
    });
  });
});

it.each([[[]], [null]] as const)(
  "keeps another project setting when saving scripts %j",
  (scripts) => {
    const snapshot = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [] } },
    };
    const scriptPatch = projectScriptsOverridePatch(snapshot, projectId, scripts);
    const latest = applyServerSettingsPatch(snapshot, {
      projectSettingsOverridePatches: { [projectId]: { set: { defaultAutoPull: true } } },
    });
    const saved = applyServerSettingsPatch(latest, scriptPatch);
    expect(saved.projectSettingsOverrides[projectId]).toEqual(
      scripts === null
        ? { defaultAutoPull: true }
        : { defaultAutoPull: true, defaultProjectScripts: [] },
    );
  },
);

it("keeps project setting saves and resets on servers that ignore operation fields", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: {
      [projectId]: { defaultAutoPull: true, enableAgentDeviceAccess: true },
    },
  };
  const target = environment("Server", { settings });
  const save = planScopedSettingsPatch(checkout, [target], { defaultAutoPull: false });
  const reset = planScopedSettingsClear(checkout, [target], ["enableAgentDeviceAccess"]);
  for (const [plan, expected] of [
    [save, { defaultAutoPull: false, enableAgentDeviceAccess: true }],
    [reset, { defaultAutoPull: true }],
  ] as const) {
    const patch = decodeLegacySettingsPatch(plan.serverWrites[0]!.patch);
    expect(applyServerSettingsPatch(settings, patch).projectSettingsOverrides[projectId]).toEqual(
      expected,
    );
  }
});

it("keeps scheduled prompt changes on servers that ignore operation fields", () => {
  const entry = {
    id: "daily",
    projectId,
    title: "Daily check",
    prompt: "Review open issues.",
    enabled: true,
    hour: 9,
    minute: 30,
  };
  const snapshot = { ...DEFAULT_SERVER_SETTINGS, scheduledPrompts: [entry] };
  const patch = scheduledPromptWrite(snapshot.scheduledPrompts, {
    type: "update",
    id: entry.id,
    changes: { enabled: false },
  });
  expect(
    applyServerSettingsPatch(snapshot, decodeLegacySettingsPatch(patch)).scheduledPrompts,
  ).toEqual([{ ...entry, enabled: false }]);
});
