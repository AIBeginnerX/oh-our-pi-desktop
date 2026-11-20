import type { ProviderOptionSelection, ServerProviderModel } from "@t3tools/contracts";

// Evals measure Z.ai and MiniMax on their newest flagship at maximum reasoning. ZCode lists
// `<provider>\<model>` for every provider it routes to; only its built-in Z.ai/BigModel plans
// count, and reasoning is the `reasoningEffort` option. MiniMax Code lists
// `m:<provider>:<model>:v:<variant>`; its reasoning is the `thinking` variant, not an option.
const RULES = {
  zcode: {
    candidate: (slug: string) => slug.startsWith("builtin:"),
    version: /glm-(\d+(?:\.\d+)*)/i,
  },
  minimax: {
    candidate: (slug: string) => slug.startsWith("m:minimax:") && slug.endsWith(":v:thinking"),
    version: /minimax-m(\d+(?:\.\d+)*)/i,
  },
} as const;
const LIGHT = /-(?:flash\w*|air|lite|turbo)\b/i;
const LEVELS = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Resolve only advertised models/options; never silently measure a provider default. */
export function resolveEvalModel(
  driver: string,
  models: ReadonlyArray<ServerProviderModel>,
  requested: string,
): { model: string; options?: ReadonlyArray<ProviderOptionSelection> } {
  if (driver !== "zcode" && driver !== "minimax") return { model: requested };
  const rule = RULES[driver];
  const versioned = models.flatMap((model) => {
    const version =
      model.isCustom || model.isLegacy || !rule.candidate(model.slug)
        ? undefined
        : model.slug.match(rule.version)?.[1];
    return version ? [{ model, version }] : [];
  });
  const flagships = versioned.filter(({ model }) => !LIGHT.test(model.slug));
  const model = (flagships.length ? flagships : versioned).toSorted((a, b) =>
    b.version.localeCompare(a.version, "en", { numeric: true }),
  )[0]?.model;
  if (!model) throw new Error(`${driver}: no advertised model matches the newest-flagship rule`);
  const effort = model.capabilities?.optionDescriptors?.find(
    (descriptor) => descriptor.id === "reasoningEffort",
  );
  if (effort?.type !== "select") {
    if (driver === "minimax") return { model: model.slug };
    throw new Error(`${driver}:${model.slug}: maximum reasoning option is not advertised`);
  }
  const choices = effort.options.filter((option) => LEVELS.includes(option.id.toLowerCase()));
  if (choices.length === 0 || choices.length !== effort.options.length)
    throw new Error(`${driver}:${model.slug}: cannot rank reasoning values`);
  const max = choices.toSorted(
    (a, b) => LEVELS.indexOf(b.id.toLowerCase()) - LEVELS.indexOf(a.id.toLowerCase()),
  )[0]!;
  return { model: model.slug, options: [{ id: effort.id, value: max.id }] };
}
