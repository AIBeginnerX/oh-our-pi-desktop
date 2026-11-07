import { describe, expect, it } from "@effect/vitest";

import { makeSearchPlan, planHasTerms } from "./memorySearch.ts";

describe("makeSearchPlan", () => {
  it("treats an empty or whitespace query as a browse", () => {
    for (const query of ["", "   ", "\t\n"]) {
      expect(planHasTerms(makeSearchPlan(query))).toBe(false);
    }
  });

  it("sends 3+ codepoint terms to FTS as quoted phrases", () => {
    const plan = makeSearchPlan("rollback migration");
    expect(plan.ftsMatch).toBe('"rollback" OR "migration"');
    expect(plan.likePatterns).toEqual([]);
  });

  it("sends 1-2 codepoint terms to escaped LIKE patterns", () => {
    // 빌드/규칙 are each 2 code points — under the trigram minimum.
    const plan = makeSearchPlan("빌드 UI 규칙");
    expect(plan.ftsMatch).toBeNull();
    expect(plan.likePatterns).toEqual(["%빌드%", "%UI%", "%규칙%"]);
  });

  it("handles single Korean syllables via LIKE", () => {
    const plan = makeSearchPlan("맥 상태");
    expect(plan.likePatterns).toEqual(["%상태%"]);
    expect(makeSearchPlan("맥").likePatterns).toEqual(["%맥%"]);
    expect(plan.ftsMatch).toBeNull();
  });

  it("counts code points, not UTF-16 units, for the FTS cutoff", () => {
    // "a😀" is 3 UTF-16 units but only 2 code points — a trigram index never
    // produced a token for it, so it must take the LIKE path.
    const plan = makeSearchPlan("a😀 ok");
    expect(plan.ftsMatch).toBeNull();
    expect(plan.likePatterns).toEqual(["%a😀%", "%ok%"]);
    const emoji = makeSearchPlan("a😀😀");
    expect(emoji.ftsMatch).toBe('"a😀😀"');
    expect(emoji.likePatterns).toEqual([]);
  });

  it("sends long terms containing punctuation to FTS literally", () => {
    // 100% and task_name are >= 3 code points: the wildcard-looking
    // characters are inert inside a quoted FTS phrase.
    const plan = makeSearchPlan("100% task_name");
    expect(plan.ftsMatch).toBe('"100%" OR "task_name"');
    expect(plan.likePatterns).toEqual([]);
  });

  it("escapes LIKE wildcards so % and _ in short terms are literals", () => {
    const plan = makeSearchPlan("a% b_");
    expect(plan.likePatterns).toEqual(["%a!%%", "%b!_%"]);
    expect(plan.ftsMatch).toBeNull();
  });

  it("escapes the escape character itself", () => {
    const plan = makeSearchPlan("a!");
    expect(plan.likePatterns).toEqual(["%a!!%"]);
  });

  it("keeps both Korean paths usable: 2 codepoints via LIKE, 3+ via trigram FTS", () => {
    // 캐시 is 2 code points, under the trigram minimum, so it must take the
    // escaped LIKE path and still produce a usable plan on its own.
    const short = makeSearchPlan("캐시");
    expect(short.ftsMatch).toBeNull();
    expect(short.likePatterns).toEqual(["%캐시%"]);
    expect(planHasTerms(short)).toBe(true);

    // 디스크용량 is 5 code points, so the trigram index can answer it.
    const long = makeSearchPlan("디스크용량");
    expect(long.ftsMatch).toBe('"디스크용량"');
    expect(long.likePatterns).toEqual([]);
    expect(planHasTerms(long)).toBe(true);

    // Together, each term keeps its own path rather than one swallowing the other.
    const mixed = makeSearchPlan("캐시 디스크용량", { strict: true });
    expect(mixed.ftsMatch).toBe('"디스크용량"');
    expect(mixed.likePatterns).toEqual(["%캐시%"]);
  });

  it("quotes FTS phrases so FTS syntax and column names are inert", () => {
    const plan = makeSearchPlan('body:foo "bar" AND');
    // Every term is individually quoted; nothing can break out as an operator.
    expect(plan.ftsMatch).toBe('"body:foo" OR """bar""" OR "AND"');
    expect(plan.likePatterns).toEqual([]);
  });

  it("has no negation operator — a leading - is literal", () => {
    // -wip is 4 code points: still a literal phrase, not an exclusion.
    const plan = makeSearchPlan("--- -wip");
    expect(plan.ftsMatch).toBe('"---" OR "-wip"');
    expect(plan.likePatterns).toEqual([]);
  });

  it("has no OR operator — OR is a literal 2-codepoint term", () => {
    const plan = makeSearchPlan("deploy OR rollback");
    expect(plan.ftsMatch).toBe('"deploy" OR "rollback"');
    expect(plan.likePatterns).toEqual(["%OR%"]);
  });

  it("routes punctuation-only short terms to LIKE", () => {
    const plan = makeSearchPlan("** ??");
    expect(plan.likePatterns).toEqual(["%**%", "%??%"]);
    expect(plan.ftsMatch).toBeNull();
  });

  it("drops one-character terms when a longer term exists", () => {
    expect(makeSearchPlan("a 이 login").ftsMatch).toBe('"login"');
    expect(makeSearchPlan("a 이 login").likePatterns).toEqual([]);
    expect(makeSearchPlan("좀 배포").likePatterns).toEqual(["%배포%"]);
    // Alone, a single character is still what the user asked for ...
    expect(makeSearchPlan("a").likePatterns).toEqual(["%a%"]);
    // ... except for an agent's recall, which never matches on it.
    expect(planHasTerms(makeSearchPlan("a", { strict: true }))).toBe(false);
  });
});
