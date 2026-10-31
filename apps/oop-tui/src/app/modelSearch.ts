import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import type { ModelChoice } from "./commands.ts";
import { filterRanked, scoreFields } from "./listSearch.ts";

/** The fields a typed word is looked for in, best first: name, short name, sub-provider, driver, provider name, all of them. */
const searchFields = (choice: ModelChoice): string[] => {
  const search = choice.search ?? {
    name: choice.label,
    driver: "",
    providerName: "",
  };
  const parts = [
    search.name,
    search.shortName,
    search.subProvider,
    search.driver,
    search.providerName,
  ];
  return [
    ...parts.map((part) => normalizeSearchQuery(part ?? "")),
    normalizeSearchQuery(parts.filter((part) => part !== undefined && part !== "").join(" ")),
  ];
};

/**
 * How well a model matches the typed words, lower is better; null when a word matches no field.
 * See `scoreFields`: a word that matches an earlier field of the model counts for more.
 */
export const scoreModelChoice = (choice: ModelChoice, query: string): number | null =>
  scoreFields(searchFields(choice), query);

/** The models that match, exact and prefix matches first; ties keep the list's own order. */
export const filterModels = <T extends ModelChoice>(
  models: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> => filterRanked(models, query, searchFields);
