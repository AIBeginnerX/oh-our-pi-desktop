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
]);

const CJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

const normalize = (text: string) => text.normalize("NFC").toLowerCase();

// A two-syllable Korean word carries as much meaning as a short English one, so CJK characters
// weigh double; a match needs a weight of at least 3 ("api", "오류" match; "ui" alone does not).
const weightOf = (word: string) =>
  [...word].reduce((total, char) => total + (CJK.test(char) ? 2 : 1), 0);

/**
 * Project memories whose title words appear in the draft, best match first. Matching is by
 * substring so a Korean word still matches with a particle attached (로그인 → 로그인을).
 */
export function suggestProjectMemories<
  T extends { readonly memoryId: string; readonly title: string },
>(
  draft: string,
  items: ReadonlyArray<T>,
  excludedMemoryIds: ReadonlySet<string>,
  max = 3,
): ReadonlyArray<T> {
  const text = normalize(draft);
  if (text.trim().length < 4) return [];
  return items
    .flatMap((item) => {
      if (excludedMemoryIds.has(item.memoryId)) return [];
      const words = new Set(
        normalize(item.title)
          .split(/[^\p{L}\p{N}]+/u)
          .filter((word) => [...word].length >= 2 && !STOP_WORDS.has(word)),
      );
      let score = 0;
      for (const word of words) if (text.includes(word)) score += weightOf(word);
      return score >= 3 ? [{ item, score }] : [];
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, max)
    .map((entry) => entry.item);
}
