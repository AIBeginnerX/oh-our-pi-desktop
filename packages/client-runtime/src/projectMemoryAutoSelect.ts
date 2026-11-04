/**
 * Relevance ranking and visible auto-selection for project memories.
 *
 * Pure and client-agnostic so web and any later client share one rule. The
 * composer calls `planAutoSelection` and applies the result through the normal
 * memory-reference path: auto-selected memories are ordinary removable chips,
 * so the send ledger, the affected hold and memory-echo masking behave exactly
 * as for a memory the user picked by hand.
 */

/** Auto-selection budget. The manual-send caps (8 items / 32,000 chars) are untouched. */
export const AUTO_SELECT_MAX_ITEMS = 3;
/** Title plus body characters, counted like the send ledger counts them. */
export const AUTO_SELECT_MAX_CHARS = 1_500;

const QUERY_MAX_CHARS = 2_000;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const TITLE_TERM_WEIGHT = 3;
/** A title hit is worth 2 and a body hit 1; below 2 the match is treated as noise. */
const MIN_MATCH_WEIGHT = 2;

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "about",
  "please",
  "are",
  "was",
  "you",
  "can",
  "not",
  "use",
  "have",
]);

const CJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Terms of a text: Latin/number words of 3+ characters, and character bigrams
 * of CJK runs. Bigrams let a Korean word still match with a particle attached
 * (로그인 inside 로그인을) without a morphological analyser, and a mixed
 * `API로` splits into the word `api` and nothing for the lone syllable.
 */
export function extractTerms(text: string): ReadonlyArray<string> {
  const terms: Array<string> = [];
  let run = "";
  let runIsCjk = false;
  const flush = () => {
    if (run.length > 0) {
      if (runIsCjk) {
        const chars = [...run];
        for (let index = 0; index + 1 < chars.length; index += 1) {
          terms.push(chars[index]! + chars[index + 1]!);
        }
      } else if ([...run].length >= 3 && !STOP_WORDS.has(run)) {
        terms.push(run);
      }
    }
    run = "";
  };
  for (const char of text.normalize("NFC").toLowerCase()) {
    if (!WORD_CHAR.test(char)) {
      flush();
      continue;
    }
    const isCjk = CJK.test(char);
    if (run.length > 0 && isCjk !== runIsCjk) flush();
    runIsCjk = isCjk;
    run += char;
  }
  flush();
  return terms;
}

export interface RankableProjectMemory {
  readonly memoryId: string;
  readonly title: string;
  /** Absent when the list was read without bodies: scored on the title alone. */
  readonly body?: string | undefined;
  readonly validUntil?: string | null | undefined;
}

export interface RankedProjectMemory<T extends RankableProjectMemory> {
  readonly item: T;
  readonly score: number;
}

const isExpired = (validUntil: string | null | undefined, nowMs: number) =>
  validUntil !== null && validUntil !== undefined && !(Date.parse(validUntil) > nowMs);

/**
 * BM25 over title+body with OR semantics: every distinct draft term
 * contributes, none is required. Title terms count three times. A memory needs
 * a title hit or two body hits to be returned at all, so a single stray common
 * word never selects anything. Best match first; ties keep list order.
 */
export function rankProjectMemories<T extends RankableProjectMemory>(
  draft: string,
  items: ReadonlyArray<T>,
  options: { readonly excludedMemoryIds?: ReadonlySet<string>; readonly nowMs: number },
): ReadonlyArray<RankedProjectMemory<T>> {
  const queryTerms = new Set(extractTerms(draft.slice(-QUERY_MAX_CHARS)));
  if (queryTerms.size === 0) return [];
  const { nowMs } = options;
  const docs = items
    .filter(
      (item) =>
        !options.excludedMemoryIds?.has(item.memoryId) && !isExpired(item.validUntil, nowMs),
    )
    .map((item) => {
      const title = new Set(extractTerms(item.title));
      const frequency = new Map<string, number>();
      let length = 0;
      const add = (term: string, weight: number) => {
        frequency.set(term, (frequency.get(term) ?? 0) + weight);
        length += weight;
      };
      for (const term of extractTerms(item.title)) add(term, TITLE_TERM_WEIGHT);
      for (const term of extractTerms(item.body ?? "")) add(term, 1);
      return { item, title, frequency, length };
    });
  if (docs.length === 0) return [];
  const averageLength = docs.reduce((total, doc) => total + doc.length, 0) / docs.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.frequency.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const ranked: Array<RankedProjectMemory<T>> = [];
  for (const doc of docs) {
    let score = 0;
    let matchWeight = 0;
    for (const term of queryTerms) {
      const tf = doc.frequency.get(term);
      if (tf === undefined) continue;
      const df = documentFrequency.get(term) ?? 1;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score +=
        (idf * tf * (BM25_K1 + 1)) /
        (tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / averageLength));
      matchWeight += doc.title.has(term) ? 2 : 1;
    }
    if (matchWeight >= MIN_MATCH_WEIGHT) ranked.push({ item: doc.item, score });
  }
  return ranked.sort((left, right) => right.score - left.score);
}

const sizeOf = (item: RankableProjectMemory) => item.title.length + (item.body?.length ?? 0);

/**
 * The best-ranked memories that fit the auto-select budget. A memory whose
 * body is unknown is never auto-selected: its size cannot be checked. One too
 * large for what is left is skipped and the next-best is tried.
 */
export function selectWithinBudget<T extends RankableProjectMemory>(
  ranked: ReadonlyArray<RankedProjectMemory<T>>,
  budget: { readonly maxItems: number; readonly maxChars: number },
): ReadonlyArray<T> {
  const chosen: Array<T> = [];
  let chars = 0;
  for (const { item } of ranked) {
    if (chosen.length >= budget.maxItems) break;
    if (item.body === undefined) continue;
    const size = sizeOf(item);
    if (chars + size > budget.maxChars) continue;
    chosen.push(item);
    chars += size;
  }
  return chosen;
}

/** Per-draft memory of what auto-selection added and what must not come back. */
export interface AutoSelectState {
  /** Auto-added and still selected: they count against the budget. */
  readonly added: ReadonlySet<string>;
  /** Selected at the previous plan, whatever the source. */
  readonly previouslySelected: ReadonlySet<string>;
  /** Removed by the user after being selected: never auto-selected again. */
  readonly dismissed: ReadonlySet<string>;
}

export const EMPTY_AUTO_SELECT_STATE: AutoSelectState = {
  added: new Set(),
  previouslySelected: new Set(),
  dismissed: new Set(),
};

export interface PlanAutoSelectionInput<T extends RankableProjectMemory> {
  /** The `autoSelectProjectMemories` setting; false is the default and the kill switch. */
  readonly enabled: boolean;
  /** The thread's provider passed the memory-send allow-list gate. */
  readonly providerAllowed: boolean;
  readonly draft: string;
  readonly memories: ReadonlyArray<T>;
  readonly selectedMemoryIds: ReadonlySet<string>;
  readonly state: AutoSelectState;
  readonly nowMs: number;
}

/**
 * One planning step: which memories to pre-select now, and the next state.
 * Call it whenever the draft or the selection changes. It only ever adds; the
 * user's removals are the only thing that shrinks the selection, and a removed
 * memory is remembered for the life of the draft. An empty draft with nothing
 * selected (a fresh draft, or just after a send) resets the state.
 */
export function planAutoSelection<T extends RankableProjectMemory>(
  input: PlanAutoSelectionInput<T>,
): { readonly add: ReadonlyArray<T>; readonly state: AutoSelectState } {
  if (input.draft.trim().length === 0 && input.selectedMemoryIds.size === 0) {
    return { add: [], state: EMPTY_AUTO_SELECT_STATE };
  }
  const dismissed = new Set(input.state.dismissed);
  for (const memoryId of input.state.previouslySelected) {
    if (!input.selectedMemoryIds.has(memoryId)) dismissed.add(memoryId);
  }
  const added = new Set([...input.state.added].filter((id) => input.selectedMemoryIds.has(id)));
  const settle = (chosen: ReadonlyArray<T>) => {
    const nextAdded = new Set([...added, ...chosen.map((item) => item.memoryId)]);
    return {
      add: chosen,
      state: {
        added: nextAdded,
        previouslySelected: new Set([...input.selectedMemoryIds, ...nextAdded]),
        dismissed,
      },
    };
  };
  if (!input.enabled || !input.providerAllowed) return settle([]);

  const used = input.memories.filter((item) => added.has(item.memoryId));
  const chosen = selectWithinBudget(
    rankProjectMemories(input.draft, input.memories, {
      excludedMemoryIds: new Set([...input.selectedMemoryIds, ...dismissed]),
      nowMs: input.nowMs,
    }),
    {
      maxItems: AUTO_SELECT_MAX_ITEMS - added.size,
      maxChars: AUTO_SELECT_MAX_CHARS - used.reduce((total, item) => total + sizeOf(item), 0),
    },
  );
  return settle(chosen);
}
