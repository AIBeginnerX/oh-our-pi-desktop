import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { ProjectSkillMutationFence } from "./skills/ProjectSkillMutationFence.ts";
import { ServerSettingsService, classifySettingsMutationScope, layer } from "./serverSettings.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const script: ProjectScript = {
  id: "lint",
  name: "Lint",
  command: "pnpm lint",
  icon: "lint",
  runOnWorktreeCreate: false,
};

const encodeModelSelectionJson = Schema.encodeEffect(Schema.fromJsonString(ModelSelection));
const encodeProjectScriptsJson = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(ProjectScript)),
);

describe("classifySettingsMutationScope", () => {
  it("treats per-project override edits as project-scoped", () => {
    const previous = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectA]: { defaultRuntimeMode: "approval-required" },
        [projectB]: { defaultRuntimeMode: "full-access" },
      },
    } satisfies ServerSettings;
    const next = {
      ...previous,
      projectSettingsOverrides: {
        [projectA]: { defaultRuntimeMode: "full-access" },
        [projectB]: { defaultRuntimeMode: "full-access" },
      },
    } satisfies ServerSettings;
    expect(classifySettingsMutationScope(previous, next)).toEqual({
      kind: "projects",
      projectIds: [projectA],
    });
  });

  it("treats shared defaults as global", () => {
    const previous = DEFAULT_SERVER_SETTINGS;
    const next = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultProjectScripts: [script],
    };
    expect(classifySettingsMutationScope(previous, next)).toEqual({ kind: "global" });
  });

  it("ignores known UI-only preference changes", () => {
    const previous = DEFAULT_SERVER_SETTINGS;
    const next = { ...DEFAULT_SERVER_SETTINGS, deviceOnboardingCompleted: true };
    expect(classifySettingsMutationScope(previous, next)).toEqual({ kind: "none" });
  });
});

const makeSettingsLayer = (
  secretStoreLayer: typeof ServerSecretStore.layer = ServerSecretStore.layer,
) =>
  layer.pipe(
    Layer.provide(secretStoreLayer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-server-settings-skill-fence-",
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

describe("ServerSettings skill lifecycle fence", () => {
  it.effect("project override updates fence only the touched project", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const settings = yield* ServerSettingsService;
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectA]: { defaultRuntimeMode: "approval-required" },
          [projectB]: { defaultRuntimeMode: "approval-required" },
        },
      });
      const tokenA = fence.acquire(projectA);
      const tokenB = fence.acquire(projectB);
      expect(tokenA).toBeDefined();
      expect(tokenB).toBeDefined();
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectA]: { defaultRuntimeMode: "full-access" },
          [projectB]: { defaultRuntimeMode: "approval-required" },
        },
      });
      expect(fence.holds(tokenA!)).toBe(false);
      expect(fence.holds(tokenB!)).toBe(true);
    }).pipe(Effect.provide(makeSettingsLayer())),
  );

  it.effect(
    "conservative-global reload keeps cached authority until fenced publication completes",
    () =>
      Effect.gen(function* () {
        const fence = yield* ProjectSkillMutationFence;
        const settings = yield* ServerSettingsService;
        const seam = settings.skillFenceTestSeam;
        if (seam === undefined) {
          return yield* Effect.die(new Error("skillFenceTestSeam missing on ServerSettings.layer"));
        }
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [projectA]: { defaultRuntimeMode: "approval-required" },
          },
        });
        const before = yield* settings.getSettings;
        const token = fence.acquire(projectA);
        expect(token).toBeDefined();
        const park = yield* seam.armReloadPublicationPark;
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            projectSettingsOverrides: {
              [projectA]: { defaultRuntimeMode: "full-access" },
            },
          }),
        );
        const reload = yield* seam.revalidateFromDisk.pipe(Effect.forkChild);
        yield* Deferred.await(park.entered);
        const mid = yield* settings.getSettings;
        expect(mid.projectSettingsOverrides[projectA]?.defaultRuntimeMode).toBe(
          before.projectSettingsOverrides[projectA]?.defaultRuntimeMode,
        );
        expect(fence.snapshotCounters().globalPending).toBe(1);
        expect(fence.snapshotCounters().projectPending(projectB)).toBe(0);
        yield* Deferred.succeed(park.release, undefined);
        yield* Fiber.join(reload);
        yield* seam.disarmReloadPublicationPark;
        const after = yield* settings.getSettings;
        expect(after.projectSettingsOverrides[projectA]?.defaultRuntimeMode).toBe("full-access");
        expect(fence.holds(token!)).toBe(false);
      }).pipe(Effect.provide(makeSettingsLayer())),
  );

  it.effect(
    "opens a global fence before secret writes when redacted settings shape is unchanged",
    () => {
      let armedSecretSetterHits = 0;
      const beforeSecretSet = { current: undefined as (() => void) | undefined };
      const secretStoreLayer = Layer.effect(
        ServerSecretStore.ServerSecretStore,
        Effect.map(ServerSecretStore.ServerSecretStore, (store) =>
          ServerSecretStore.ServerSecretStore.of({
            ...store,
            set: (name, value) =>
              Effect.gen(function* () {
                beforeSecretSet.current?.();
                yield* store.set(name, value);
              }),
          }),
        ),
      ).pipe(Layer.provide(ServerSecretStore.layer));
      const instanceId = ProviderInstanceId.make("codex_personal");

      return Effect.gen(function* () {
        const fence = yield* ProjectSkillMutationFence;
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "OPENROUTER_API_KEY", value: "sk-a", sensitive: true }],
              config: {},
            },
          },
        });
        const token = fence.acquire(projectA);
        expect(token).toBeDefined();
        beforeSecretSet.current = () => {
          armedSecretSetterHits += 1;
          expect(fence.snapshotCounters().globalPending).toBe(1);
          expect(fence.acquire(projectA)).toBeUndefined();
          expect(fence.holds(token!)).toBe(false);
        };
        const materialized = yield* settings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "OPENROUTER_API_KEY", value: "sk-b", sensitive: true }],
              config: {},
            },
          },
        });
        expect(materialized.providerInstances[instanceId]?.environment?.[0]?.value).toBe("sk-b");
        expect(armedSecretSetterHits).toBeGreaterThanOrEqual(1);
        expect(fence.snapshotCounters().globalPending).toBe(0);
        expect(fence.holds(token!)).toBe(false);
      }).pipe(Effect.provide(makeSettingsLayer(secretStoreLayer)));
    },
  );

  it.effect("persists legacy projection fold to settings.json on trusted load", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const settings = yield* ServerSettingsService;
      const legacyProject = ProjectId.make("project-legacy-fold");
      const scriptedProject = ProjectId.make("project-scripted-fold");
      const script: ProjectScript = {
        id: "check",
        name: "Check",
        command: "npm test",
        icon: "play",
        runOnWorktreeCreate: false,
      };
      const model = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5");
      const modelJson = yield* encodeModelSelectionJson(model);
      const scriptsJson = yield* encodeProjectScriptsJson([script]);
      for (const [projectId, modelColumn, envMode, autoPull, scripts] of [
        [legacyProject, modelJson, "worktree", 1, scriptsJson],
        [scriptedProject, null, null, 0, scriptsJson],
      ] as const) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            default_thread_env_mode, auto_pull, scripts_json, created_at, updated_at
          )
          VALUES (
            ${projectId}, ${"Project"}, ${`/tmp/${projectId}`}, ${modelColumn},
            ${envMode}, ${autoPull}, ${scripts},
            ${"2026-08-25T00:00:00.000Z"}, ${"2026-08-25T00:00:00.000Z"}
          )
        `;
      }
      yield* fs.writeFileString(
        config.settingsPath,
        `{"projectAgentBrowserAccessOverrides":{"${legacyProject}":false},"projectAutoPullOverrides":{"${scriptedProject}":true},"projectScriptOverrides":{"${legacyProject}":null}}`,
      );

      const loaded = yield* settings.getSettings;
      expect(loaded.projectSettingsFolded).toBe(true);
      expect(loaded.projectSettingsOverrides[legacyProject]?.defaultThreadEnvMode).toBe("worktree");

      const raw = yield* fs.readFileString(config.settingsPath);
      const persisted = JSON.parse(raw) as ServerSettings;
      expect(persisted.projectSettingsFolded).toBe(true);
      expect(persisted.projectSettingsOverrides[legacyProject]?.enableAgentBrowserAccess).toBe(
        false,
      );
      expect(persisted.projectSettingsOverrides[scriptedProject]?.defaultProjectScripts).toEqual([
        script,
      ]);
    }).pipe(Effect.provide(makeSettingsLayer())),
  );
});
