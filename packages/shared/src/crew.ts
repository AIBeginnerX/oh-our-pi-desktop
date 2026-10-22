/**
 * OOP Crew role resolution shared by the server (which runs the crew) and clients (which show
 * and change it). A role is whatever the user pinned for it, else what the preset picks from the
 * models this environment can run right now, so the crew follows newly added models on its own.
 */
import {
  CREW_ROLES,
  isProviderAvailable,
  type CrewPreset,
  type CrewRole,
  type CrewSettings,
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

export interface ResolvedCrew {
  readonly enabled: boolean;
  readonly preset: CrewPreset;
  readonly roles: Record<CrewRole, CrewModelOption | null>;
  readonly pinned: ReadonlySet<CrewRole>;
}

/** The crew a thread runs with: its override over the defaults, then pins over the preset. */
export function resolveCrew(input: {
  readonly settings: CrewSettings;
  readonly threadId: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly brain: ModelSelection | null;
}): ResolvedCrew {
  const override =
    input.threadId === null
      ? undefined
      : Object.entries(input.settings.threads).find(
          ([threadId]) => threadId === input.threadId,
        )?.[1];
  const enabled = override?.enabled ?? input.settings.enabled;
  const preset = override?.preset ?? input.settings.preset;
  const pins = { ...input.settings.pinned, ...override?.pinned };
  const options = crewModelOptions(input.providers);
  const recommended = recommendCrew(options, input.brain, preset);
  const roles = {} as Record<CrewRole, CrewModelOption | null>;
  const pinned = new Set<CrewRole>();
  for (const role of CREW_ROLES) {
    const pin = pins[role];
    const pinnedOption =
      pin == null ? undefined : options.find((option) => sameModel(option.selection, pin));
    if (pinnedOption !== undefined) pinned.add(role);
    roles[role] = pinnedOption ?? recommended[role];
  }
  return { enabled, preset, roles, pinned };
}

const ROLE_TIERS: Record<CrewRole, ReadonlyArray<CrewModelTier>> = {
  worker: [1, 2, 3],
  expert: [3, 2, 1],
  auditor: [3, 2, 1],
};

/**
 * Models a role tries in order when the one before fails: the role's own model, the preset's
 * default for the role, then other models of the same level before the next level, preferring
 * providers not already in the chain. The brain is never in it: it takes the work itself once
 * the chain runs dry. Providers in `unavailableInstances` (recently failed) are skipped.
 */
export function crewFallbackChain(input: {
  readonly options: ReadonlyArray<CrewModelOption>;
  readonly role: CrewRole;
  readonly assigned: CrewModelOption | null;
  readonly preset: CrewPreset;
  readonly brain: ModelSelection | null;
  readonly unavailableInstances?: ReadonlySet<string>;
  readonly limit?: number;
}): CrewModelOption[] {
  const usable = input.options.filter(
    (option) =>
      !sameModel(option.selection, input.brain) &&
      input.unavailableInstances?.has(option.selection.instanceId) !== true,
  );
  const chain: CrewModelOption[] = [];
  const add = (option: CrewModelOption | null | undefined) => {
    if (
      option != null &&
      usable.some((candidate) => sameModel(candidate.selection, option.selection)) &&
      !chain.some((entry) => sameModel(entry.selection, option.selection))
    ) {
      chain.push(option);
    }
  };
  add(input.assigned);
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
  return chain.slice(0, input.limit ?? 3);
}
