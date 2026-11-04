/**
 * Query planning for project memory search.
 *
 * Semantics are deliberately tiny: every whitespace-separated term matches
 * literally, and a memory matches when any term does; the ones matching more
 * terms, and in the title, rank first (BM25, see the repository). There are
 * no operators in the user's text — `-pnpm` means the literal string "-pnpm",
 * and `OR` means the literal string "OR".
 *
 * Terms of 3+ code points go to the FTS5 trigram index as escaped phrases
 * (every term is individually double-quoted, so FTS syntax and column names
 * in user input are inert literals). Terms of 1–2 code points — Korean
 * syllables, "UI", "%", "_" — fall back to a project-bounded LIKE with `!`,
 * `%`, `_` escaped under `ESCAPE '!'`, because the trigram index cannot
 * produce tokens shorter than three characters. Code-point length matters:
 * `"a😀"` is 3 UTF-16 units but 2 code points and must take the LIKE path.
 * A single-character term matches nearly every memory, so it is dropped whenever
 * a longer term exists. A `strict` plan (an agent's recall) also drops one
 * character always and common English filler words, so a query made only of
 * those matches nothing instead of the whole project. Queries that yield no
 * terms browse like `projectMemory.list`.
 */
export interface ProjectMemorySearchPlan {
  /** Combined `"a" OR "b"` FTS5 MATCH for 3+ codepoint terms. */
  readonly ftsMatch: string | null;
  /** Escaped `%…%` patterns for 1–2 codepoint terms. */
  readonly likePatterns: ReadonlyArray<string>;
}

const FTS_TERM_MIN_CODEPOINTS = 3;

/** Words that carry no topic; nearly every English memory contains some of them. */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "are",
  "was",
  "how",
  "what",
  "why",
  "when",
  "not",
  "you",
  "can",
  "has",
  "have",
  "but",
  "all",
  "any",
  "out",
  "use",
]);

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function ftsPhrase(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

export function makeSearchPlan(
  query: string,
  options: { readonly strict?: boolean } = {},
): ProjectMemorySearchPlan {
  const ftsTerms: Array<string> = [];
  const likePatterns: Array<string> = [];

  const all = query.split(/\s+/u).filter((term) => term.length > 0);
  const hasLonger = all.some((term) => [...term].length > 1);
  for (const term of all) {
    if ([...term].length === 1 && (hasLonger || options.strict === true)) continue;
    if (options.strict === true && FILLER_WORDS.has(term.toLowerCase())) continue;
    if ([...term].length >= FTS_TERM_MIN_CODEPOINTS) {
      ftsTerms.push(ftsPhrase(term));
    } else {
      likePatterns.push(`%${escapeLikePattern(term)}%`);
    }
  }

  return {
    ftsMatch: ftsTerms.length > 0 ? ftsTerms.join(" OR ") : null,
    likePatterns,
  };
}

/** True when a plan has at least one positive term to match against. */
export function planHasTerms(plan: ProjectMemorySearchPlan): boolean {
  return plan.ftsMatch !== null || plan.likePatterns.length > 0;
}
