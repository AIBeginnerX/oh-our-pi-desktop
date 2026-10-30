/**
 * Reads what an OpenCode 2 server offers in one directory, in the shapes the
 * OpenCode provider snapshot already uses for 1.x.
 *
 * @module provider/opencode2/OpenCode2Inventory
 */
import * as Effect from "effect/Effect";

import {
  runOpenCodeSdk,
  type OpenCodeRuntimeError,
  type OpenCodeSkill,
  type OpenCodeSlashCommand,
} from "../opencodeRuntime.ts";
import { retryWhileActivating, type OpenCode2Client } from "./OpenCode2Client.ts";

export interface OpenCode2Model {
  readonly providerID: string;
  readonly id: string;
  readonly name: string;
  readonly providerName?: string;
  readonly variants: ReadonlyArray<string>;
}

export interface OpenCode2Agent {
  readonly name: string;
  readonly mode: "subagent" | "primary" | "all";
  readonly hidden: boolean;
}

export interface OpenCode2Inventory {
  readonly models: ReadonlyArray<OpenCode2Model>;
  readonly agents: ReadonlyArray<OpenCode2Agent>;
  readonly skills: ReadonlyArray<OpenCodeSkill>;
  readonly commands: ReadonlyArray<OpenCodeSlashCommand>;
}

const PROVIDER_NAMES_TIMEOUT = "3 seconds";

export const loadOpenCode2Models = (client: OpenCode2Client, directory: string) => {
  const location = { directory };
  return Effect.all(
    {
      models: runOpenCodeSdk("model.list", (signal) =>
        retryWhileActivating(() => client.model.list({ location }, { signal })),
      ),
      // Provider names only decorate the list; never let them stall it.
      providers: runOpenCodeSdk("provider.list", (signal) =>
        client.provider.list({ location }, { signal }),
      ).pipe(Effect.timeout(PROVIDER_NAMES_TIMEOUT), Effect.option),
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(({ models, providers }): ReadonlyArray<OpenCode2Model> => {
      const providerNames = new Map(
        providers._tag === "Some"
          ? providers.value.data.map((provider) => [provider.id, provider.name] as const)
          : [],
      );
      return models.data
        .filter((model) => model.enabled !== false)
        .map((model) => {
          const providerName = providerNames.get(model.providerID);
          return {
            providerID: model.providerID,
            id: model.id,
            name: model.name,
            ...(providerName ? { providerName } : {}),
            variants: model.variants.map((variant) => variant.id),
          };
        });
    }),
  );
};

export const loadOpenCode2Workspace = (client: OpenCode2Client, directory: string) => {
  const location = { directory };
  return Effect.all(
    {
      skills: runOpenCodeSdk("skill.list", (signal) =>
        retryWhileActivating(() => client.skill.list({ location }, { signal })),
      ).pipe(
        Effect.map((list): ReadonlyArray<OpenCodeSkill> =>
          list.data.map((skill) => ({
            name: skill.name,
            location: skill.path,
            ...(skill.description === undefined ? {} : { description: skill.description }),
          })),
        ),
      ),
      commands: runOpenCodeSdk("command.list", (signal) =>
        retryWhileActivating(() => client.command.list({ location }, { signal })),
      ).pipe(
        Effect.map((list): ReadonlyArray<OpenCodeSlashCommand> =>
          list.data.map((command) => ({
            name: command.name,
            ...(command.description === undefined ? {} : { description: command.description }),
            hints: [],
          })),
        ),
        Effect.orElseSucceed((): ReadonlyArray<OpenCodeSlashCommand> => []),
      ),
    },
    { concurrency: "unbounded" },
  );
};

export const loadOpenCode2Inventory = (
  client: OpenCode2Client,
  directory: string,
): Effect.Effect<OpenCode2Inventory, OpenCodeRuntimeError> =>
  Effect.all(
    {
      models: loadOpenCode2Models(client, directory),
      agents: runOpenCodeSdk("agent.list", (signal) =>
        retryWhileActivating(() => client.agent.list({ location: { directory } }, { signal })),
      ).pipe(
        // The selectable agent value is its id; 2.x names are display labels.
        Effect.map((list): ReadonlyArray<OpenCode2Agent> =>
          list.data.map((agent) => ({ name: agent.id, mode: agent.mode, hidden: agent.hidden })),
        ),
      ),
      workspace: loadOpenCode2Workspace(client, directory),
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(({ models, agents, workspace }) => ({
      models,
      agents,
      skills: workspace.skills,
      commands: workspace.commands,
    })),
  );
