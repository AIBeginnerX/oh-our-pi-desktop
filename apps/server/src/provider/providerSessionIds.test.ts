import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  nativeSessionRefOf,
  PRIOR_PROVIDER_SESSION_IDS_KEY,
  type ProviderSessionRef,
  providerSessionIdOf,
  ProviderSessionRefsMalformedError,
  preservePriorProviderSessionRefs,
  readPriorProviderSessionRefs,
} from "./providerSessionIds.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const claudeInstance = ProviderInstanceId.make("claude-current");
const claudeAliasInstance = ProviderInstanceId.make("claude-alias");
const codexInstance = ProviderInstanceId.make("codex");

const claudeSessionA = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const claudeSessionB = "482fcf9e-1c65-4d21-9a5b-6f0c2b7f4d12";
const claudeSessionC = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

const ref = (
  provider: string,
  providerInstanceId: string,
  sessionId: string,
): ProviderSessionRef => ({
  provider: ProviderDriverKind.make(provider),
  providerInstanceId: ProviderInstanceId.make(providerInstanceId),
  sessionId,
});

const payloadWithRefs = (refs: ReadonlyArray<ProviderSessionRef>) => ({
  cwd: "/tmp/project",
  [PRIOR_PROVIDER_SESSION_IDS_KEY]: refs,
});

function expectSuccess<A, E>(result: Result.Result<A, E>): A {
  if (!Result.isSuccess(result)) throw new Error("expected a successful result");
  return result.success;
}

function expectMalformed(result: Result.Result<unknown, ProviderSessionRefsMalformedError>): void {
  if (Result.isSuccess(result)) throw new Error("expected a failed result");
  expect(result.failure._tag).toBe("ProviderSessionRefsMalformedError");
}

function preserved(input: {
  existingProviderName?: string;
  existingProviderInstanceId?: string | null;
  existingResumeCursor?: unknown;
  existingRuntimePayload?: unknown;
  nextProviderName?: ProviderDriverKind;
  nextProviderInstanceId?: ProviderInstanceId;
  nextResumeCursor?: unknown;
  mergedRuntimePayload?: unknown | null;
}): ReadonlyArray<ProviderSessionRef> {
  return expectSuccess(
    preservePriorProviderSessionRefs({
      existing: {
        providerName: input.existingProviderName ?? "claudeAgent",
        providerInstanceId: input.existingProviderInstanceId ?? "claude-current",
        resumeCursor: input.existingResumeCursor ?? null,
        runtimePayload: input.existingRuntimePayload ?? null,
      },
      next: {
        providerName: input.nextProviderName ?? claude,
        providerInstanceId: input.nextProviderInstanceId ?? claudeInstance,
        resumeCursor: input.nextResumeCursor ?? null,
      },
      mergedRuntimePayload: input.mergedRuntimePayload ?? null,
    }),
  );
}

describe("providerSessionIdOf", () => {
  it("reads the Claude resume session id", () => {
    expect(providerSessionIdOf(claude, { resume: claudeSessionA, turnCount: 2 })).toBe(
      claudeSessionA,
    );
  });

  it("falls back to the legacy Claude sessionId key", () => {
    expect(providerSessionIdOf(claude, { sessionId: claudeSessionA })).toBe(claudeSessionA);
  });

  it("prefers resume over the legacy sessionId key", () => {
    expect(providerSessionIdOf(claude, { resume: claudeSessionA, sessionId: claudeSessionB })).toBe(
      claudeSessionA,
    );
  });

  it("ignores a non-UUID Claude resume value like the adapter does", () => {
    expect(providerSessionIdOf(claude, { resume: "not-a-uuid" })).toBeUndefined();
    expect(providerSessionIdOf(claude, { sessionId: "not-a-uuid" })).toBeUndefined();
  });

  it("does not read the codex threadId key for Claude", () => {
    expect(providerSessionIdOf(claude, { threadId: "codex-thread-1" })).toBeUndefined();
  });

  it("reads the codex native thread id", () => {
    expect(providerSessionIdOf(codex, { threadId: "codex-thread-1" })).toBe("codex-thread-1");
  });

  it("ignores a blank codex threadId and foreign keys", () => {
    expect(providerSessionIdOf(codex, { threadId: "   " })).toBeUndefined();
    expect(providerSessionIdOf(codex, { resume: claudeSessionA })).toBeUndefined();
  });

  it("never interprets another provider's cursor, whatever keys it carries", () => {
    for (const provider of ["cursor", "grok", "opencode", "antigravity"] as const) {
      const kind = ProviderDriverKind.make(provider);
      expect(providerSessionIdOf(kind, { resume: claudeSessionA })).toBeUndefined();
      expect(providerSessionIdOf(kind, { sessionId: claudeSessionA })).toBeUndefined();
      expect(providerSessionIdOf(kind, { threadId: "thread-1" })).toBeUndefined();
    }
  });

  it("never stringifies opaque or primitive cursors", () => {
    expect(providerSessionIdOf(claude, null)).toBeUndefined();
    expect(providerSessionIdOf(claude, "resume-opaque")).toBeUndefined();
    expect(providerSessionIdOf(claude, 42)).toBeUndefined();
    expect(providerSessionIdOf(claude, [claudeSessionA])).toBeUndefined();
    expect(providerSessionIdOf(claude, { resume: 123 })).toBeUndefined();
    expect(providerSessionIdOf(codex, { threadId: { id: "nested" } })).toBeUndefined();
  });
});

describe("readPriorProviderSessionRefs", () => {
  it("treats an absent key and a non-record payload as no preserved refs", () => {
    expect(expectSuccess(readPriorProviderSessionRefs(null))).toEqual([]);
    expect(expectSuccess(readPriorProviderSessionRefs("cwd"))).toEqual([]);
    expect(expectSuccess(readPriorProviderSessionRefs(5))).toEqual([]);
    expect(expectSuccess(readPriorProviderSessionRefs({ cwd: "/tmp/project" }))).toEqual([]);
  });

  it("decodes stored refs", () => {
    const refs = [ref("claudeAgent", "claude-current", claudeSessionA)];
    expect(expectSuccess(readPriorProviderSessionRefs(payloadWithRefs(refs)))).toEqual(refs);
  });

  it("fails loudly on present-but-malformed metadata", () => {
    expectMalformed(readPriorProviderSessionRefs({ [PRIOR_PROVIDER_SESSION_IDS_KEY]: null }));
    expectMalformed(readPriorProviderSessionRefs({ [PRIOR_PROVIDER_SESSION_IDS_KEY]: "claude" }));
    expectMalformed(readPriorProviderSessionRefs({ [PRIOR_PROVIDER_SESSION_IDS_KEY]: {} }));
    expectMalformed(readPriorProviderSessionRefs({ [PRIOR_PROVIDER_SESSION_IDS_KEY]: [1] }));
    expectMalformed(
      readPriorProviderSessionRefs({
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [{ provider: "claudeAgent", sessionId: claudeSessionA }],
      }),
    );
    expectMalformed(
      readPriorProviderSessionRefs({
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [
          ref("claudeAgent", "claude-current", claudeSessionA),
          ref("claudeAgent", "claude-current", "   "),
        ],
      }),
    );
  });
});

describe("nativeSessionRefOf", () => {
  it("binds the cursor's native id to the row's provider and instance", () => {
    expect(nativeSessionRefOf("claudeAgent", "claude-current", { resume: claudeSessionA })).toEqual(
      Option.some(ref("claudeAgent", "claude-current", claudeSessionA)),
    );
  });

  it("promotes a legacy null instance like the directory does on read", () => {
    expect(nativeSessionRefOf("claudeAgent", null, { sessionId: claudeSessionA })).toEqual(
      Option.some(ref("claudeAgent", "claudeAgent", claudeSessionA)),
    );
  });

  it("has no ref for an unusable provider slug, instance, or cursor shape", () => {
    const unusable = [
      ["bad slug!", "claude-current", { resume: claudeSessionA }],
      ["claudeAgent", "", { resume: claudeSessionA }],
      ["claudeAgent", "bad slug!", { resume: claudeSessionA }],
      ["claudeAgent", "claude-current", { opaque: "cursor" }],
    ] as const;
    for (const [providerName, providerInstanceId, cursor] of unusable) {
      expect(Option.isNone(nativeSessionRefOf(providerName, providerInstanceId, cursor))).toBe(
        true,
      );
    }
  });
});

describe("preservePriorProviderSessionRefs", () => {
  it("keeps nothing prior on a fresh row: the current id stays in the cursor", () => {
    expect(
      preserved({
        existingProviderName: "claudeAgent",
        existingProviderInstanceId: null,
        nextProviderName: claude,
        nextProviderInstanceId: claudeInstance,
        nextResumeCursor: { resume: claudeSessionA },
      }),
    ).toEqual([]);
  });

  it("never grows the list when a per-turn update keeps the same session id", () => {
    const prior = [ref("claudeAgent", "claude-current", claudeSessionA)];
    expect(
      preserved({
        existingResumeCursor: { resume: claudeSessionA, turnCount: 1 },
        existingRuntimePayload: payloadWithRefs(prior),
        nextResumeCursor: { resume: claudeSessionA, turnCount: 2 },
        mergedRuntimePayload: payloadWithRefs(prior),
      }),
    ).toEqual(prior);
  });

  it("keeps refs the stored payload carries even while the cursor id is unchanged", () => {
    expect(
      preserved({
        existingResumeCursor: { resume: claudeSessionA, turnCount: 1 },
        nextResumeCursor: { resume: claudeSessionA, turnCount: 2 },
        mergedRuntimePayload: payloadWithRefs([
          ref("claudeAgent", "claude-current", claudeSessionA),
        ]),
      }),
    ).toEqual([ref("claudeAgent", "claude-current", claudeSessionA)]);
  });

  it("preserves the previous id when the cursor moves to a new session", () => {
    expect(
      preserved({
        existingResumeCursor: { resume: claudeSessionA },
        nextResumeCursor: { resume: claudeSessionB },
      }),
    ).toEqual([ref("claudeAgent", "claude-current", claudeSessionA)]);
  });

  it("accumulates across A→B→C", () => {
    const afterB = preserved({
      existingResumeCursor: { resume: claudeSessionA },
      nextResumeCursor: { resume: claudeSessionB },
    });
    expect(
      preserved({
        existingResumeCursor: { resume: claudeSessionB },
        existingRuntimePayload: payloadWithRefs(afterB),
        nextResumeCursor: { resume: claudeSessionC },
      }),
    ).toEqual([
      ref("claudeAgent", "claude-current", claudeSessionA),
      ref("claudeAgent", "claude-current", claudeSessionB),
    ]);
  });

  it("preserves the effective id through an explicit cursor reset to null", () => {
    expect(
      preserved({
        existingResumeCursor: { resume: claudeSessionA },
        nextResumeCursor: null,
      }),
    ).toEqual([ref("claudeAgent", "claude-current", claudeSessionA)]);
  });

  it("adds nothing when the cursor is omitted and the provider stands", () => {
    expect(
      preserved({
        existingResumeCursor: { resume: claudeSessionA },
        nextResumeCursor: { resume: claudeSessionA },
      }),
    ).toEqual([]);
  });

  it("keeps the original provenance when the provider switches with the cursor omitted", () => {
    expect(
      preserved({
        existingResumeCursor: { resume: claudeSessionA },
        nextProviderName: codex,
        nextProviderInstanceId: codexInstance,
        nextResumeCursor: { resume: claudeSessionA },
      }),
    ).toEqual([ref("claudeAgent", "claude-current", claudeSessionA)]);
  });

  it("stores same-session alias refs side by side instead of collapsing them", () => {
    expect(
      preserved({
        existingResumeCursor: { resume: claudeSessionC },
        existingRuntimePayload: payloadWithRefs([
          ref("claudeAgent", "claude-current", claudeSessionA),
        ]),
        nextResumeCursor: { resume: claudeSessionC },
        mergedRuntimePayload: payloadWithRefs([
          ref("claudeAgent", "claude-current", claudeSessionA),
          ref("claudeAgent", "claude-alias", claudeSessionA),
          ref("claudeAgent", "claude-current", claudeSessionB),
        ]),
      }),
    ).toEqual([
      ref("claudeAgent", "claude-current", claudeSessionA),
      ref("claudeAgent", "claude-alias", claudeSessionA),
      ref("claudeAgent", "claude-current", claudeSessionB),
    ]);
  });

  it("retains the original provenance when the same session id returns under an alias", () => {
    expect(
      preserved({
        existingResumeCursor: { resume: claudeSessionA },
        nextProviderInstanceId: claudeAliasInstance,
        nextResumeCursor: { resume: claudeSessionA },
      }),
    ).toEqual([ref("claudeAgent", "claude-current", claudeSessionA)]);
  });

  it("keeps both provenances when an aliased session id later moves on", () => {
    const afterAlias = preserved({
      existingResumeCursor: { resume: claudeSessionA },
      nextProviderInstanceId: claudeAliasInstance,
      nextResumeCursor: { resume: claudeSessionA },
    });
    expect(
      preserved({
        existingResumeCursor: { resume: claudeSessionA },
        existingProviderInstanceId: "claude-alias",
        existingRuntimePayload: payloadWithRefs(afterAlias),
        nextProviderInstanceId: claudeAliasInstance,
        nextResumeCursor: null,
        mergedRuntimePayload: payloadWithRefs(afterAlias),
      }),
    ).toEqual([
      ref("claudeAgent", "claude-current", claudeSessionA),
      ref("claudeAgent", "claude-alias", claudeSessionA),
    ]);
  });

  it("a next payload's alias ref cannot erase the older current ref", () => {
    expect(
      preserved({
        existingResumeCursor: { resume: claudeSessionA },
        nextProviderInstanceId: claudeAliasInstance,
        nextResumeCursor: null,
        mergedRuntimePayload: payloadWithRefs([ref("claudeAgent", "claude-alias", claudeSessionA)]),
      }),
    ).toEqual([
      ref("claudeAgent", "claude-alias", claudeSessionA),
      ref("claudeAgent", "claude-current", claudeSessionA),
    ]);
  });

  it("treats the same native string under another provider as a different session", () => {
    expect(
      preserved({
        existingResumeCursor: { resume: claudeSessionA },
        nextProviderName: codex,
        nextProviderInstanceId: codexInstance,
        nextResumeCursor: { threadId: claudeSessionA },
      }),
    ).toEqual([ref("claudeAgent", "claude-current", claudeSessionA)]);
  });

  it("keeps every preserved ref, with no truncation bound", () => {
    const history = Array.from({ length: 250 }, (_, index) =>
      ref(
        "claudeAgent",
        "claude-current",
        `3f2504e0-4f89-11d3-9a0c-${String(index).padStart(12, "0")}`,
      ),
    );
    const kept = preserved({
      existingRuntimePayload: payloadWithRefs(history),
      existingResumeCursor: { resume: claudeSessionC },
      nextResumeCursor: null,
    });
    // The 250 stored refs plus the id the null reset demotes.
    expect(kept).toHaveLength(251);
    expect(kept[0]).toEqual(history[0]);
    expect(kept[249]).toEqual(history[249]);
    expect(kept[250]).toEqual(ref("claudeAgent", "claude-current", claudeSessionC));
  });

  it("fails instead of silently emptying when stored metadata is malformed", () => {
    expectMalformed(
      preservePriorProviderSessionRefs({
        existing: {
          providerName: "claudeAgent",
          providerInstanceId: "claude-current",
          resumeCursor: { resume: claudeSessionA },
          runtimePayload: { [PRIOR_PROVIDER_SESSION_IDS_KEY]: "claude" },
        },
        next: {
          providerName: claude,
          providerInstanceId: claudeInstance,
          resumeCursor: { resume: claudeSessionB },
        },
        mergedRuntimePayload: null,
      }),
    );
  });

  it("fails when the payload being stored carries malformed metadata", () => {
    expectMalformed(
      preservePriorProviderSessionRefs({
        existing: {
          providerName: "claudeAgent",
          providerInstanceId: "claude-current",
          resumeCursor: { resume: claudeSessionA },
          runtimePayload: null,
        },
        next: {
          providerName: claude,
          providerInstanceId: claudeInstance,
          resumeCursor: { resume: claudeSessionB },
        },
        mergedRuntimePayload: { [PRIOR_PROVIDER_SESSION_IDS_KEY]: [{ provider: 7 }] },
      }),
    );
  });
});
