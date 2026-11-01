import {
  CREW_ROLES,
  DEFAULT_CREW_SETTINGS,
  type CrewPinnedRoles,
  type CrewPreset,
  type CrewRole,
  type CrewSettings,
  type ModelSelection,
  type ServerConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  CREW_ROLE_LABEL,
  crewModelOptions,
  type CrewModelOption,
  type CrewModelTier,
  type ResolvedCrew,
} from "@t3tools/shared/crew";

import { t } from "../i18n/index.ts";
import type { ModelChoice } from "./commands.ts";
import { filterModels } from "./modelSearch.ts";

export { CREW_ROLES, CREW_ROLE_LABEL };

/**
 * Brains that receive OOP's crew tools. This copies the server's list (`CREW_BRAIN_DRIVERS` in
 * `apps/server/src/crew/crewLogic.ts`), which a client cannot import.
 */
const CREW_BRAIN_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex", "antigravity"]);

export const PRESETS: ReadonlyArray<{
  readonly value: CrewPreset;
  readonly label: string;
  readonly hint: string;
  /** Other words `/crew preset <word>` accepts. */
  readonly aliases: ReadonlyArray<string>;
}> = [
  {
    value: "recommended",
    get label() {
      return t("providers.crew.preset.recommended");
    },
    get hint() {
      return t("providers.crew.preset.recommendedHint");
    },
    aliases: ["pick"],
  },
  {
    value: "speed",
    get label() {
      return t("providers.crew.preset.speed");
    },
    get hint() {
      return t("providers.crew.preset.speedHint");
    },
    aliases: ["fast"],
  },
  {
    value: "quality",
    get label() {
      return t("providers.crew.preset.quality");
    },
    get hint() {
      return t("providers.crew.preset.qualityHint");
    },
    aliases: [],
  },
  {
    value: "budget",
    get label() {
      return t("providers.crew.preset.budget");
    },
    get hint() {
      return t("providers.crew.preset.budgetHint");
    },
    aliases: ["cheap"],
  },
];

export const ROLE_HINT: Record<CrewRole, string> = {
  get worker() {
    return t("providers.crew.role.worker");
  },
  get expert() {
    return t("providers.crew.role.expert");
  },
  get auditor() {
    return t("providers.crew.role.auditor");
  },
};

const TIER_WORD: Record<CrewModelTier, string> = {
  get 1() {
    return t("providers.crew.tier.fast");
  },
  get 2() {
    return t("providers.crew.tier.balanced");
  },
  get 3() {
    return t("providers.crew.tier.strong");
  },
};

export const presetLabel = (preset: CrewPreset): string =>
  PRESETS.find((entry) => entry.value === preset)?.label ?? preset;

/** The role a `/crew model` argument names; null when it is none of the three. */
export const parseCrewRole = (word: string): CrewRole | null => {
  const wanted = word.trim().toLowerCase();
  return CREW_ROLES.find((role) => role === wanted) ?? null;
};

/** The preset a `/crew preset` argument names: the value, an alias or the label. */
export const parseCrewPreset = (word: string): CrewPreset | null => {
  const wanted = word.trim().toLowerCase();
  if (wanted === "") return null;
  return (
    PRESETS.find(
      (entry) =>
        entry.value === wanted || entry.aliases.includes(wanted) || entry.label === word.trim(),
    )?.value ?? null
  );
};

export const presetWords = (): string => PRESETS.map((entry) => entry.value).join("|");

/** The crew settings the server reported; a server that sent none has the defaults. */
export const crewSettingsOf = (settings: Partial<ServerSettings> | undefined): CrewSettings =>
  settings?.crew ?? DEFAULT_CREW_SETTINGS;

/** Whether the thread has the crew on: its own override, else the defaults. */
export const crewEnabledFor = (settings: CrewSettings, threadId: string | null): boolean =>
  (threadId === null ? undefined : settings.threads[threadId as keyof CrewSettings["threads"]])
    ?.enabled ?? settings.enabled;

/**
 * Why a thread running on `brain` cannot use the crew, as a sentence for the user; null when it
 * can. The server hands the crew tools only to some providers' sessions.
 */
export const crewBrainProblem = (
  config: ServerConfig | null,
  brain: { readonly instanceId: string } | null,
): string | null => {
  if (brain === null) return t("providers.crew.noModels");
  const provider = config?.providers.find((candidate) => candidate.instanceId === brain.instanceId);
  if (provider === undefined) {
    return t("providers.crew.unknownModel");
  }
  if (CREW_BRAIN_DRIVERS.has(provider.driver)) return null;
  const name = provider.displayName ?? provider.driver;
  return t("providers.crew.badBrain", { name });
};

export interface CrewChange {
  readonly enabled?: boolean;
  readonly preset?: CrewPreset;
  /** A model pins the role; null puts it back on Auto. */
  readonly pins?: Partial<Record<CrewRole, ModelSelection | null>>;
}

/**
 * The next crew settings after `change`, the way the desktop app writes them. In a thread the
 * change lands in that thread's override, where a null pin means Auto even if the defaults pin the
 * role; without a thread (`threadId` null: a conversation not started yet) it changes the defaults
 * themselves. Everything else in the settings, and in the thread's own override, is kept.
 */
export const applyCrewChange = (
  settings: CrewSettings,
  threadId: string | null,
  change: CrewChange,
): CrewSettings => {
  const scoped = {
    ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
    ...(change.preset === undefined ? {} : { preset: change.preset }),
  };
  if (threadId === null) {
    let pinned: CrewPinnedRoles = { ...settings.pinned };
    for (const role of CREW_ROLES) {
      const selection = change.pins?.[role];
      if (selection === undefined) continue;
      if (selection === null) {
        const { [role]: _cleared, ...rest } = pinned;
        pinned = rest;
      } else {
        pinned = { ...pinned, [role]: selection };
      }
    }
    return { ...settings, ...scoped, pinned };
  }
  const override = settings.threads[threadId as keyof CrewSettings["threads"]];
  return {
    ...settings,
    threads: {
      ...settings.threads,
      [threadId]: {
        ...override,
        ...scoped,
        pinned: { ...override?.pinned, ...change.pins },
      },
    },
  };
};

/**
 * "Use this crew for new chats": what the thread runs with (on or off, preset, and the roles
 * pinned by hand) becomes the default. Threads' own overrides stay as they are.
 */
export const crewAsDefault = (settings: CrewSettings, crew: ResolvedCrew): CrewSettings => {
  const pinned: Record<string, unknown> = {};
  for (const role of CREW_ROLES) {
    const option = crew.roles[role];
    if (crew.pinned.has(role) && option !== null) pinned[role] = option.selection;
  }
  return {
    ...settings,
    enabled: crew.enabled,
    preset: crew.preset,
    pinned: pinned as CrewPinnedRoles,
  };
};

/** One row of the model list for a role: Auto, or a model the environment can run now. */
export type CrewPickItem =
  | { readonly kind: "auto"; readonly label: string; readonly note: string }
  | {
      readonly kind: "model";
      readonly selection: ModelSelection;
      readonly label: string;
      readonly note: string;
    };

const sameSelection = (left: ModelSelection | null, right: ModelSelection | null): boolean =>
  left !== null &&
  right !== null &&
  left.instanceId === right.instanceId &&
  left.model === right.model;

/** The words `/crew model` search looks in for a model, as the `/model` search does. */
const choiceOf = (option: CrewModelOption): ModelChoice => ({
  instanceId: option.selection.instanceId,
  model: option.selection.model,
  label: `${option.providerLabel} / ${option.label}`,
  search: {
    name: option.label,
    driver: option.driver,
    providerName: option.providerLabel,
  },
});

/**
 * What the model list of a role offers for the typed words: Auto first (when the words do not
 * rule it out), then the models that match, best first. `autoPick` is what the preset would put
 * in the role, which Auto's note names.
 */
export const crewPickItems = (
  providers: ServerConfig["providers"],
  autoPick: CrewModelOption | null,
  query: string,
): ReadonlyArray<CrewPickItem> => {
  const options = crewModelOptions(providers);
  const byKey = new Map(
    options.map((option) => [
      `${option.selection.instanceId}\u0000${option.selection.model}`,
      option,
    ]),
  );
  const matches = filterModels(options.map(choiceOf), query).flatMap((choice) => {
    const option = byKey.get(`${choice.instanceId}\u0000${choice.model}`);
    return option === undefined
      ? []
      : [
          {
            kind: "model" as const,
            selection: option.selection,
            label: choice.label,
            note: `${TIER_WORD[option.tier]}${option.isDefault ? ` · ${t("providers.cmd.default")}` : ""}`,
          },
        ];
  });
  const needle = query.trim().toLowerCase();
  const showAuto = needle === "" || t("providers.crew.autoWords").includes(needle);
  const auto: CrewPickItem = {
    kind: "auto",
    label: "Auto",
    note:
      autoPick === null
        ? t("providers.crew.noneAvailable")
        : t("providers.crew.recommended", {
            model: autoPick.label,
            provider: autoPick.providerLabel,
          }),
  };
  return [...(showAuto ? [auto] : []), ...matches];
};

/** Whether the item is what the role has now: Auto for an unpinned role, else the pinned model. */
export const pickIsCurrent = (item: CrewPickItem, crew: ResolvedCrew, role: CrewRole): boolean =>
  item.kind === "auto"
    ? !crew.pinned.has(role)
    : crew.pinned.has(role) && sameSelection(item.selection, crew.roles[role]?.selection ?? null);

/** How a role's model reads: `Auto · Haiku` for an unpinned role, the model alone when pinned. */
export const roleModelText = (crew: ResolvedCrew, role: CrewRole): string => {
  const option = crew.roles[role];
  if (option === null) return t("providers.crew.noneAvailable");
  return `${crew.pinned.has(role) ? "" : "Auto · "}${option.label}`;
};
