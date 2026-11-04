import {
  rankProjectMemories,
  type RankableProjectMemory,
} from "@t3tools/client-runtime/project-memory-auto-select";

/**
 * Project memories related to the draft, best match first. Title and body are
 * both scored (BM25, OR-style over words and CJK bigrams), so a Korean word
 * still matches with a particle attached (로그인 → 로그인을).
 */
export function suggestProjectMemories<T extends RankableProjectMemory>(
  draft: string,
  items: ReadonlyArray<T>,
  excludedMemoryIds: ReadonlySet<string>,
  max = 3,
): ReadonlyArray<T> {
  return rankProjectMemories(draft, items, { excludedMemoryIds, nowMs: Date.now() })
    .slice(0, max)
    .map((entry) => entry.item);
}
