/**
 * OOP Crew role resolution shared by the server (which runs the crew) and clients (which show
 * and change it). A role is whatever the user pinned for it, else what the preset picks from the
 * models this environment can run right now, so the crew follows newly added models on its own.
 */
import {
  CREW_FALLBACK_LIMIT,
  CREW_ROLES,
  isProviderAvailable,
  type CrewPreset,
  type CrewRole,
  type CrewSettings,
  type CrewThreadOverride,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

export const CREW_ROLE_LABEL: Record<CrewRole, string> = {
  worker: "Worker",
  expert: "Expert",
  auditor: "Auditor",
};

/**
 * Whether a thread is a crew sub-task, by the `Crew <Role> · <subject>` title the server gives it.
 * Crew threads never delegate or get audited themselves, so the crew cannot recurse; clients
 * also use this to nest them under the thread that delegated them.
 */
export function isCrewThreadTitle(title: string): boolean {
  return Object.values(CREW_ROLE_LABEL).some((label) => title.startsWith(`Crew ${label} · `));
}

/** 1 = fast and cheap, 2 = balanced, 3 = strongest. */
export type CrewModelTier = 1 | 2 | 3;

export interface CrewModelOption {
  readonly selection: ModelSelection;
  readonly label: string;
  readonly providerLabel: string;
  readonly driver: string;
  readonly tier: CrewModelTier;
  readonly isDefault: boolean;
}

const FAST_MODEL = /(mini|nano|haiku|flash|lite|fast|luna|small|instant|spark|turbo)/i;
const TOP_MODEL = /(opus|\bpro\b|max|ultra|\bo3\b|-high\b|gpt-?6)/i;

export function crewModelTier(slug: string, name: string): CrewModelTier {
  const text = `${slug} ${name}`;
  if (FAST_MODEL.test(text)) return 1;
  if (TOP_MODEL.test(text)) return 3;
  return 2;
}

/**
 * Provider drivers whose threads can lead a crew: the ones OOP gives its crew tools and the
 * brief to. The server enforces this and tells clients through `ServerProvider.canLeadCrew`.
 */
const CREW_LEAD_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/** Whether a thread running on this provider driver can lead a crew (Claude and Codex only). */
export function canLeadCrew(driver: string): boolean {
  return CREW_LEAD_DRIVERS.has(driver);
}

/** Models a crew role can use: ready, signed-in providers only, legacy models left out. */
export function crewModelOptions(providers: ReadonlyArray<ServerProvider>): CrewModelOption[] {
  return providers.flatMap((provider) => {
    const usable =
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      (provider.status === "ready" || provider.status === "warning") &&
      provider.auth.status !== "unauthenticated";
    if (!usable) return [];
    return provider.models
      .filter((model) => model.isLegacy !== true)
      .map((model) => ({
        selection: { instanceId: provider.instanceId, model: model.slug },
        label: model.shortName ?? model.name,
        providerLabel: provider.displayName ?? provider.driver,
        driver: provider.driver,
        tier: crewModelTier(model.slug, model.name),
        isDefault: model.isDefault === true,
      }));
  });
}

/**
 * The family a model belongs to, for telling whether two models can disagree independently. The
 * slug decides first, since a provider such as Cursor hosts models of other families; the
 * driver names the family only when the slug says nothing.
 */
export function modelFamily(slug: string, driver: string): string {
  const name = slug.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(name)) return "claude";
  if (/gpt|codex|\bo[34]\b/.test(name)) return "openai";
  if (name.includes("gemini")) return "google";
  if (/grok|composer/.test(name)) return "xai";
  const own = /glm|kimi|qwen|deepseek|minimax/.exec(name)?.[0];
  return own ?? driver;
}

const sameModel = (a: ModelSelection | null | undefined, b: ModelSelection | null | undefined) =>
  a != null && b != null && a.instanceId === b.instanceId && a.model === b.model;

interface Want {
  readonly tiers: ReadonlyArray<CrewModelTier>;
  readonly preferOtherProviderThan?: ModelSelection | null;
  readonly preferProviderOf?: ModelSelection | null;
  readonly avoid?: ReadonlyArray<ModelSelection | null>;
}

function pick(options: ReadonlyArray<CrewModelOption>, want: Want): CrewModelOption | null {
  const providerOf = (selection: ModelSelection | null | undefined) =>
    selection == null
      ? undefined
      : options.find((option) => option.selection.instanceId === selection.instanceId)?.driver;
  const otherDriver = providerOf(want.preferOtherProviderThan);
  const sameDriver = providerOf(want.preferProviderOf);
  const score = (option: CrewModelOption) => {
    const tierRank = want.tiers.indexOf(option.tier);
    return (
      (tierRank === -1 ? 100 : tierRank * 10) +
      (otherDriver !== undefined && option.driver === otherDriver ? 8 : 0) +
      (sameDriver !== undefined && option.driver !== sameDriver ? 2 : 0) +
      ((want.avoid ?? []).some((avoided) => sameModel(avoided, option.selection)) ? 6 : 0) +
      (option.isDefault ? 0 : 1)
    );
  };
  return [...options].sort((a, b) => score(a) - score(b))[0] ?? null;
}

/** What a preset puts in each role, given the brain the thread already runs. */
export function recommendCrew(
  options: ReadonlyArray<CrewModelOption>,
  brain: ModelSelection | null,
  preset: CrewPreset,
): Record<CrewRole, CrewModelOption | null> {
  switch (preset) {
    case "speed": {
      const worker = pick(options, { tiers: [1, 2, 3], preferProviderOf: brain });
      return {
        worker,
        expert: pick(options, { tiers: [2, 3, 1], avoid: [worker?.selection ?? null] }),
        auditor: pick(options, {
          tiers: [1, 2, 3],
          preferOtherProviderThan: brain,
          avoid: [brain],
        }),
      };
    }
    case "quality": {
      const worker = pick(options, { tiers: [2, 3, 1], preferProviderOf: brain });
      return {
        worker,
        expert: pick(options, { tiers: [3, 2, 1], avoid: [worker?.selection ?? null] }),
        auditor: pick(options, {
          tiers: [3, 2, 1],
          preferOtherProviderThan: brain,
          avoid: [brain],
        }),
      };
    }
    case "budget": {
      const worker = pick(options, { tiers: [1, 2, 3], preferProviderOf: brain });
      return {
        worker,
        expert: pick(options, { tiers: [1, 2, 3], avoid: [worker?.selection ?? null] }),
        auditor: pick(options, {
          tiers: [1, 2, 3],
          preferOtherProviderThan: brain,
          avoid: [brain],
        }),
      };
    }
    case "recommended": {
      const worker = pick(options, { tiers: [1, 2, 3], preferProviderOf: brain });
      return {
        worker,
        expert: pick(options, { tiers: [3, 2, 1], avoid: [worker?.selection ?? null, brain] }),
        auditor: pick(options, {
          tiers: [3, 2, 1],
          preferOtherProviderThan: brain,
          avoid: [brain],
        }),
      };
    }
  }
}

/** Where the crew a thread runs with comes from: its own crew, else the default. */
export type CrewSource = "thread" | "default";

export interface ResolvedCrew {
  readonly enabled: boolean;
  readonly preset: CrewPreset;
  readonly roles: Record<CrewRole, CrewModelOption | null>;
  readonly pinned: ReadonlySet<CrewRole>;
  /** The user's fallback models per role, in order, that this environment can run now. */
  readonly fallbacks: Record<CrewRole, ReadonlyArray<CrewModelOption>>;
  /**
   * The fallback lists as saved, including models this environment cannot run now, so an edit or
   * "Use this crew for new chats" never drops one whose provider is only away for a while.
   */
  readonly fallbackSelections: Record<CrewRole, ReadonlyArray<ModelSelection>>;
  readonly source: CrewSource;
}

/**
 * The crew a thread runs with: its own crew (`thread.crew`) over the defaults in the settings,
 * then pins over the preset. A thread without a crew of its own runs the defaults as they are
 * now, so changing the defaults moves every such thread and never one that has its own.
 */
export function resolveCrew(input: {
  readonly settings: CrewSettings;
  readonly override: CrewThreadOverride | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly brain: ModelSelection | null;
}): ResolvedCrew {
  const override = input.override ?? undefined;
  const enabled = override?.enabled ?? input.settings.enabled;
  const preset = override?.preset ?? input.settings.preset;
  const pins = { ...input.settings.pinned, ...override?.pinned };
  const lists = { ...input.settings.fallbacks, ...override?.fallbacks };
  const options = crewModelOptions(input.providers);
  const recommended = recommendCrew(options, input.brain, preset);
  const roles = {} as Record<CrewRole, CrewModelOption | null>;
  const fallbacks = {} as Record<CrewRole, ReadonlyArray<CrewModelOption>>;
  const fallbackSelections = {} as Record<CrewRole, ReadonlyArray<ModelSelection>>;
  const pinned = new Set<CrewRole>();
  for (const role of CREW_ROLES) {
    const pin = pins[role];
    const pinnedOption =
      pin == null ? undefined : options.find((option) => sameModel(option.selection, pin));
    if (pinnedOption !== undefined) pinned.add(role);
    roles[role] = pinnedOption ?? recommended[role];
    fallbackSelections[role] = (lists[role] ?? []).slice(0, CREW_FALLBACK_LIMIT);
    // A listed model that is not ready here is skipped, not an error: it comes back with its provider.
    fallbacks[role] = fallbackSelections[role].flatMap((selection) =>
      options.filter((option) => sameModel(option.selection, selection)),
    );
  }
  return {
    enabled,
    preset,
    roles,
    pinned,
    fallbacks,
    fallbackSelections,
    source: override === undefined ? "default" : "thread",
  };
}

export interface CrewChange {
  readonly enabled?: boolean;
  readonly preset?: CrewPreset;
  /** A model pins the role; null puts it back on Auto. */
  readonly pins?: Partial<Record<CrewRole, ModelSelection | null>>;
  /** The role's complete fallback list, in order; an empty list clears it. */
  readonly fallbacks?: Partial<Record<CrewRole, ReadonlyArray<ModelSelection>>>;
}

/**
 * A thread's next crew after `change`, which is stored as the thread's complete crew. A null pin
 * is kept: it means Auto even when the defaults pin the role. Everything the change does not name
 * stays as it was, so editing one role never moves the others.
 */
export function applyCrewChange(
  current: CrewThreadOverride | null | undefined,
  change: CrewChange,
): CrewThreadOverride {
  return {
    ...current,
    ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
    ...(change.preset === undefined ? {} : { preset: change.preset }),
    pinned: { ...current?.pinned, ...change.pins },
    ...(change.fallbacks === undefined
      ? {}
      : { fallbacks: { ...current?.fallbacks, ...change.fallbacks } }),
  };
}

/**
 * The settings' next default crew after `change`, which the client sends as the
 * complete value. Unlike a thread's own crew, a null pin removes the role's pin
 * (the defaults have no Auto-over-default to remember) and an empty fallback
 * list removes the role's key. Roles the change does not name stay as they are.
 */
export function applyDefaultCrewChange(current: CrewSettings, change: CrewChange): CrewSettings {
  const pinned = { ...current.pinned };
  const fallbacks = { ...current.fallbacks };
  for (const role of CREW_ROLES) {
    const pin = change.pins?.[role];
    if (pin === undefined) continue;
    if (pin === null) delete pinned[role];
    else pinned[role] = pin;
  }
  for (const role of CREW_ROLES) {
    const listed = change.fallbacks?.[role];
    if (listed === undefined) continue;
    if (listed.length === 0) delete fallbacks[role];
    else fallbacks[role] = listed;
  }
  return {
    ...current,
    ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
    ...(change.preset === undefined ? {} : { preset: change.preset }),
    pinned,
    fallbacks,
  };
}

/**
 * "Use this crew for new chats": what the thread runs with (on or off, preset, and the roles
 * pinned by hand) becomes the default (Settings edits it directly with `applyDefaultCrewChange`),
 * and no thread's own crew changes with it.
 */
export function crewAsDefault(settings: CrewSettings, crew: ResolvedCrew): CrewSettings {
  let pinned: CrewSettings["pinned"] = {};
  let fallbacks: CrewSettings["fallbacks"] = {};
  for (const role of CREW_ROLES) {
    const option = crew.roles[role];
    if (crew.pinned.has(role) && option !== null) pinned = { ...pinned, [role]: option.selection };
    const listed = crew.fallbackSelections[role];
    if (listed.length > 0) fallbacks = { ...fallbacks, [role]: listed };
  }
  return { ...settings, enabled: crew.enabled, preset: crew.preset, pinned, fallbacks };
}

const ROLE_TIERS: Record<CrewRole, ReadonlyArray<CrewModelTier>> = {
  worker: [1, 2, 3],
  expert: [3, 2, 1],
  auditor: [3, 2, 1],
};

/**
 * Models a role tries in order when the one before fails: the role's own model, the user's
 * fallbacks for the role, the preset's default for the role, then other models of the same level
 * before the next level, preferring providers not already in the chain. The brain is never in
 * it: it takes the work itself once the chain runs dry. Providers in `unavailableInstances`
 * (cooling down) and models in `unavailableModels` (refused by their provider) are skipped,
 * except the role's own model: a task tries it once, since the user may have reset the limit.
 */
export function crewFallbackChain(input: {
  readonly options: ReadonlyArray<CrewModelOption>;
  readonly role: CrewRole;
  readonly assigned: CrewModelOption | null;
  /** The user's fallback models for the role, in order. */
  readonly fallbacks?: ReadonlyArray<CrewModelOption>;
  readonly preset: CrewPreset;
  readonly brain: ModelSelection | null;
  readonly unavailableInstances?: ReadonlySet<string>;
  readonly unavailableModels?: ReadonlyArray<ModelSelection>;
  /** Defaults to three, and grows so that every user fallback and one pick of OOP's fit. */
  readonly limit?: number;
  /** Families to keep away from: models outside them come first. */
  readonly avoidFamilies?: ReadonlySet<string>;
  /** Models to keep away from when no model outside `avoidFamilies` is left: another one of the same family comes before these. */
  readonly avoidSelections?: ReadonlyArray<ModelSelection>;
}): CrewModelOption[] {
  const available = (option: CrewModelOption) =>
    input.unavailableInstances?.has(option.selection.instanceId) !== true &&
    !(input.unavailableModels ?? []).some((selection) => sameModel(selection, option.selection));
  const notBrain = input.options.filter((option) => !sameModel(option.selection, input.brain));
  const usable = notBrain.filter(available);
  const chain: CrewModelOption[] = [];
  const add = (option: CrewModelOption | null | undefined, among = usable) => {
    if (
      option != null &&
      among.some((candidate) => sameModel(candidate.selection, option.selection)) &&
      !chain.some((entry) => sameModel(entry.selection, option.selection))
    ) {
      chain.push(option);
    }
  };
  add(input.assigned, notBrain);
  const fallbacks = (input.fallbacks ?? []).slice(0, CREW_FALLBACK_LIMIT);
  for (const option of fallbacks) add(option);
  add(recommendCrew(usable, input.brain, input.preset)[input.role]);
  const anchor = input.assigned?.tier ?? ROLE_TIERS[input.role][0]!;
  const tiers = [anchor, ...ROLE_TIERS[input.role].filter((tier) => tier !== anchor)];
  const inChain = new Set(chain.map((option) => option.selection.instanceId));
  const rest = [...usable].sort(
    (a, b) =>
      tiers.indexOf(a.tier) - tiers.indexOf(b.tier) ||
      Number(inChain.has(a.selection.instanceId)) - Number(inChain.has(b.selection.instanceId)) ||
      Number(!a.isDefault) - Number(!b.isDefault),
  );
  for (const option of rest) add(option);
  const limit = input.limit ?? Math.max(3, fallbacks.length + 2);
  const avoided = input.avoidFamilies;
  if (avoided === undefined || avoided.size === 0) return chain.slice(0, limit);
  // Another family first, then another model of an avoided family, then the very same model.
  const distance = (option: CrewModelOption) =>
    !avoided.has(modelFamily(option.selection.model, option.driver))
      ? 0
      : (input.avoidSelections ?? []).some((selection) => sameModel(selection, option.selection))
        ? 2
        : 1;
  return [...chain].sort((a, b) => distance(a) - distance(b)).slice(0, limit);
}
