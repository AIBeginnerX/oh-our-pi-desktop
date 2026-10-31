import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

import { graphemesOf, sanitizeForTerminal } from "../text/width.ts";

/** Longest search, in characters. */
export const SEARCH_LIMIT = 60;

/** The search text after `typed` was added: one line, no leading space, no doubled spaces, cut to the limit. */
export const appendToSearch = (query: string, typed: string): string => {
  const next = `${query}${sanitizeForTerminal(typed).replace(/\s+/gu, " ")}`
    .replace(/^\s+/u, "")
    .replace(/\s{2,}/gu, " ");
  return graphemesOf(next).slice(0, SEARCH_LIMIT).join("");
};

/** The search text after Backspace: one character less, or none at all with Ctrl or Alt held. */
export const eraseFromSearch = (query: string, wholeWord: boolean): string =>
  wholeWord ? "" : graphemesOf(query).slice(0, -1).join("");

/**
 * The same text whichever way its Korean letters are composed: macOS file names come decomposed
 * (NFD), a terminal types them composed (NFC), and the two never match as they are.
 */
const composed = (text: string): string => normalizeSearchQuery(text.normalize("NFC"));

const scoreToken = (field: string, token: string, base: number): number | null =>
  scoreQueryMatch({
    value: field,
    query: token,
    exactBase: base,
    prefixBase: base + 2,
    boundaryBase: base + 4,
    includesBase: base + 6,
    ...(token.length >= 3 ? { fuzzyBase: base + 100 } : {}),
  });

/**
 * How well the typed words match an item's fields (already normalized, best field first), lower is
 * better; null when a word matches no field. Every space-separated word has to match some field (as
 * in the desktop app's pickers), and a word that matches an earlier field counts for more.
 */
export const scoreFields = (fields: ReadonlyArray<string>, query: string): number | null => {
  const tokens = composed(query)
    .split(/\s+/u)
    .filter((token) => token !== "");
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const token of tokens) {
    let best: number | null = null;
    fields.forEach((field, index) => {
      const score = scoreToken(field, token, index * 10);
      if (score !== null && (best === null || score < best)) best = score;
    });
    if (best === null) return null;
    total += best;
  }
  return total;
};

/** The items that match, exact and prefix matches first; ties keep the list's own order. */
export const filterRanked = <T>(
  items: ReadonlyArray<T>,
  query: string,
  fieldsOf: (item: T) => ReadonlyArray<string>,
): ReadonlyArray<T> => {
  if (composed(query) === "") return items;
  return items
    .map((item, index) => ({ item, index, score: scoreFields(fieldsOf(item), query) }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .toSorted((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.item);
};

/** A text as a search field: lower case, one line. */
export const searchField = (text: string): string =>
  composed(sanitizeForTerminal(text).replace(/\s+/gu, " "));
