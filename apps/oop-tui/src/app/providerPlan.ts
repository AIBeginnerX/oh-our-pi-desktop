import {
  ProviderInstanceId,
  type OrchestrationShellSnapshot,
  type ProviderInstanceConfig,
  type ServerConfig,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

import { t } from "../i18n/index.ts";
import { sanitizeForTerminal } from "../text/width.ts";
import { isThreadRunning } from "./projects.ts";
import {
  buildInstance,
  driverLabel,
  isDefaultInstanceId,
  isInstanceIdShape,
  redactSecrets,
  draftSecrets,
  targetFields,
  type AddDraft,
} from "./providerSpec.ts";

// ---- the list ---------------------------------------------------------------------------------

export type RowTone = "ok" | "warn" | "bad" | "dim";

/** One provider instance as `list` shows it. */
export interface ProviderRow {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
  readonly enabled: boolean;
  /** One word: ready, warning, error, off, not installed or unavailable. */
  readonly status: string;
  readonly tone: RowTone;
  /** How many models the server reports; null when the server has not reported the instance. */
  readonly models: number | null;
  /** The server's one-line note about the instance, sanitized; null when there is none. */
  readonly message: string | null;
  /** The instance is the built-in one of its driver. */
  readonly isDefault: boolean;
}

type ProviderState = ServerConfig["providers"][number];

const stateOf = (provider: ProviderState): Pick<ProviderRow, "status" | "tone"> => {
  if (provider.availability === "unavailable")
    return { status: t("providers.plan.unavailable"), tone: "bad" };
  if (!provider.enabled || provider.status === "disabled")
    return { status: t("providers.cmd.off"), tone: "dim" };
  if (!provider.installed) return { status: t("providers.plan.notInstalled"), tone: "bad" };
  if (provider.status === "error") return { status: t("providers.plan.error"), tone: "bad" };
  if (provider.status === "warning") return { status: t("providers.plan.warning"), tone: "warn" };
  return { status: t("providers.plan.ready"), tone: "ok" };
};

const oneLine = (text: string): string => sanitizeForTerminal(text).replace(/\s+/gu, " ").trim();

/** One provider as the server reports it. */
export const rowOfProvider = (provider: ProviderState): ProviderRow => ({
  id: provider.instanceId,
  name: oneLine(provider.displayName ?? driverLabel(provider.driver)),
  driver: provider.driver,
  enabled: provider.enabled,
  ...stateOf(provider),
  models: provider.models.length,
  message: provider.message === undefined ? null : oneLine(provider.message) || null,
  isDefault: isDefaultInstanceId(provider.instanceId),
});

/**
 * Every instance the server runs or the settings define. The server's report comes first; an
 * instance that is only in the settings (the server has not started it) is listed after it.
 */
export const providerRows = (
  config: ServerConfig | null,
  settings: ServerSettings | null,
): ProviderRow[] => {
  const rows: ProviderRow[] = [];
  const seen = new Set<string>();
  for (const provider of config?.providers ?? []) {
    seen.add(provider.instanceId);
    rows.push(rowOfProvider(provider));
  }
  for (const [id, instance] of Object.entries(settings?.providerInstances ?? {})) {
    if (seen.has(id)) continue;
    rows.push({
      id,
      name: oneLine(instance.displayName ?? driverLabel(instance.driver)),
      driver: instance.driver,
      enabled: instance.enabled !== false,
      status: instance.enabled === false ? t("providers.cmd.off") : t("providers.plan.checking"),
      tone: "dim",
      models: null,
      message: null,
      isDefault: isDefaultInstanceId(id),
    });
  }
  return rows;
};

/** Every id an instance already has, from the settings and from what the server reports. */
export const takenIds = (
  config: ServerConfig | null,
  settings: ServerSettings | null,
): Set<string> =>
  new Set([
    ...Object.keys(settings?.providerInstances ?? {}),
    ...(config?.providers ?? []).map((provider) => provider.instanceId),
  ]);

// ---- the patches ------------------------------------------------------------------------------

/**
 * The whole `providerInstances` record with `instance` added. The other instances are passed on
 * exactly as the server sent them, including a secret's `valueRedacted` marker, which is how the
 * server knows to keep the secret it holds. Null when the id is taken.
 */
export const addPatch = (
  current: ServerSettings,
  id: string,
  instance: ProviderInstanceConfig,
): ServerSettingsPatch | null => {
  if (Object.hasOwn(current.providerInstances, id)) return null;
  return {
    providerInstances: { ...current.providerInstances, [ProviderInstanceId.make(id)]: instance },
  };
};

/** The whole `providerInstances` record without `id`; null when it is not there. */
export const removePatch = (current: ServerSettings, id: string): ServerSettingsPatch | null => {
  if (!Object.hasOwn(current.providerInstances, id)) return null;
  return {
    providerInstances: Object.fromEntries(
      Object.entries(current.providerInstances).filter(([key]) => key !== id),
    ),
  };
};

// ---- what an add would send -------------------------------------------------------------------

export type Built =
  | { readonly ok: true; readonly instance: ProviderInstanceConfig }
  | { readonly ok: false; readonly message: string };

/** `buildInstance`, with the builder's complaint as a message that cannot hold a secret. */
export const tryBuild = (draft: AddDraft): Built => {
  try {
    return { ok: true, instance: buildInstance(draft) };
  } catch (cause) {
    const text = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, message: redactSecrets(oneLine(text), draftSecrets(draft)) };
  }
};

const MASK = "****";

/** The patch an add would send, as indented JSON with every secret hidden. For `--dry-run`. */
export const previewPayload = (draft: AddDraft, instance: ProviderInstanceConfig): string => {
  const passwordKeys = new Set(
    targetFields(draft.target)
      .filter((field) => field.control === "password")
      .map((field) => field.key),
  );
  const hidden = {
    ...instance,
    ...(instance.config === undefined || typeof instance.config !== "object"
      ? {}
      : {
          config: Object.fromEntries(
            Object.entries(instance.config as Record<string, unknown>).map(([key, value]) => [
              key,
              passwordKeys.has(key) ? MASK : value,
            ]),
          ),
        }),
    ...(instance.environment === undefined
      ? {}
      : {
          environment: instance.environment.map((entry) =>
            entry.sensitive ? { ...entry, value: MASK } : entry,
          ),
        }),
  };
  const text = JSON.stringify({ providerInstances: { [draft.id]: hidden } }, null, 2);
  return redactSecrets(text, draftSecrets(draft));
};

// ---- removing ---------------------------------------------------------------------------------

/** What removing an instance leaves behind, so the user sees it before confirming. */
export interface RemovePlan {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
  /** Secret environment values the server holds for the instance and drops with it. */
  readonly secrets: number;
  readonly threads: {
    readonly total: number;
    readonly running: number;
    readonly titles: ReadonlyArray<string>;
  };
  /** Crew roles pinned to a model of the instance, in the defaults and in thread overrides. */
  readonly crewPins: number;
  readonly textGeneration: boolean;
  readonly projects: number;
  /** The thread list was not available, so the thread counts are unknown. */
  readonly threadsKnown: boolean;
}

export type RemoveCheck =
  | { readonly ok: true; readonly plan: RemovePlan }
  | { readonly ok: false; readonly reason: string };

const TITLES_SHOWN = 3;

/** Whether `id` can be removed and what depends on it. Nothing is cleared automatically, as in the app. */
export const planRemove = (input: {
  readonly id: string;
  readonly settings: ServerSettings;
  readonly shell: OrchestrationShellSnapshot | null;
}): RemoveCheck => {
  const { id, settings, shell } = input;
  if (isDefaultInstanceId(id)) {
    return {
      ok: false,
      reason: t("providers.plan.builtIn", { id, driver: driverLabel(id) }),
    };
  }
  const instance = Object.hasOwn(settings.providerInstances, id)
    ? Object.entries(settings.providerInstances).find(([key]) => key === id)?.[1]
    : undefined;
  if (instance === undefined) {
    // An id that cannot be one is not repeated: it may be something else typed in its place.
    return {
      ok: false,
      reason: isInstanceIdShape(id)
        ? t("providers.plan.noSuchProvider", { id })
        : t("providers.plan.badId"),
    };
  }
  const uses = (selection: { readonly instanceId: string } | null | undefined): boolean =>
    selection?.instanceId === id;
  const threads = (shell?.threads ?? []).filter((thread) => uses(thread.modelSelection));
  const crew = settings.crew;
  const pinnedBy = (pins: object | undefined): number =>
    Object.values(pins ?? {}).filter((selection) => uses(selection as { instanceId: string }))
      .length;
  return {
    ok: true,
    plan: {
      id,
      name: oneLine(instance.displayName ?? driverLabel(instance.driver)),
      driver: instance.driver,
      secrets: (instance.environment ?? []).filter((entry) => entry.sensitive).length,
      threads: {
        total: threads.length,
        running: threads.filter(isThreadRunning).length,
        titles: threads.slice(0, TITLES_SHOWN).map((thread) => oneLine(thread.title)),
      },
      crewPins:
        pinnedBy(crew?.pinned) +
        Object.values(crew?.threads ?? {}).reduce((sum, entry) => sum + pinnedBy(entry.pinned), 0),
      textGeneration: uses(settings.textGenerationModelSelection),
      projects: (shell?.projects ?? []).filter((project) => uses(project.defaultModelSelection))
        .length,
      threadsKnown: shell !== null,
    },
  };
};

/** The plan as plain sentences, one per line. */
export const planLines = (plan: RemovePlan): string[] => {
  const lines = [
    t("providers.plan.remove", { id: plan.id, name: plan.name, driver: driverLabel(plan.driver) }),
    plan.secrets > 0
      ? t("providers.plan.secrets", { count: plan.secrets })
      : t("providers.plan.noSecrets"),
  ];
  if (!plan.threadsKnown) {
    lines.push(t("providers.plan.threadsUnknown"));
  } else if (plan.threads.total > 0) {
    const running =
      plan.threads.running > 0
        ? ` ${t("providers.plan.running", { count: plan.threads.running })}`
        : "";
    lines.push(t("providers.plan.threadsKept", { count: plan.threads.total, running }));
    for (const title of plan.threads.titles) lines.push(`  - ${title}`);
    if (plan.threads.total > plan.threads.titles.length) {
      lines.push(
        t("providers.plan.more", { count: plan.threads.total - plan.threads.titles.length }),
      );
    }
  } else {
    lines.push(t("providers.plan.noThreads"));
  }
  if (plan.crewPins > 0) lines.push(t("providers.plan.crewPins", { count: plan.crewPins }));
  if (plan.textGeneration) lines.push(t("providers.plan.textGeneration"));
  if (plan.projects > 0) lines.push(t("providers.plan.projects", { count: plan.projects }));
  if (plan.threads.total + plan.crewPins + plan.projects > 0 || plan.textGeneration) {
    lines.push(t("providers.plan.notAutomatic"));
  }
  return lines;
};
