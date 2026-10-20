/**
 * Query planning for project memory search.
 *
 * Semantics are deliberately tiny: every whitespace-separated term matches
 * literally, and terms combine with AND. There are no operators — `-pnpm`
 * means the literal string "-pnpm", and `OR` means the literal string "OR".
 *
 * Terms of 3+ code points go to the FTS5 trigram index as escaped phrases
 * (every term is individually double-quoted, so FTS syntax and column names
 * in user input are inert literals). Terms of 1–2 code points — Korean
 * syllables, "UI", "%", "_" — fall back to a project-bounded LIKE with `!`,
 * `%`, `_` escaped under `ESCAPE '!'`, because the trigram index cannot
 * produce tokens shorter than three characters. Code-point length matters:
 * `"a😀"` is 3 UTF-16 units but 2 code points and must take the LIKE path.
 * Queries that yield no terms browse like `projectMemory.list`.
 */
export interface ProjectMemorySearchPlan {
  /** Combined `"a" "b"` FTS5 MATCH for positive 3+ codepoint terms. */
  readonly ftsMatch: string | null;
  /** Escaped `%…%` patterns for positive 1–2 codepoint terms. */
  readonly likePatterns: ReadonlyArray<string>;
}

const FTS_TERM_MIN_CODEPOINTS = 3;

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function ftsPhrase(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

export function makeSearchPlan(query: string): ProjectMemorySearchPlan {
  const ftsTerms: Array<string> = [];
  const likePatterns: Array<string> = [];

  for (const term of query.split(/\s+/u)) {
    if (term.length === 0) continue;
    if ([...term].length >= FTS_TERM_MIN_CODEPOINTS) {
      ftsTerms.push(ftsPhrase(term));
    } else {
      likePatterns.push(`%${escapeLikePattern(term)}%`);
    }
  }

  return {
    ftsMatch: ftsTerms.length > 0 ? ftsTerms.join(" ") : null,
    likePatterns,
  };
}

/** True when a plan has at least one positive term to match against. */
export function planHasTerms(plan: ProjectMemorySearchPlan): boolean {
  return plan.ftsMatch !== null || plan.likePatterns.length > 0;
}
