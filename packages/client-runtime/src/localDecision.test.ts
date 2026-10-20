import { describe, expect, it } from "vite-plus/test";
import {
  selectLocalDecision,
  type LocalDecisionCandidate,
  type LocalDecisionKey,
  type LocalDecisionRequest,
} from "./localDecision.ts";

const key = (environmentId: string, instanceId: string, model: string): LocalDecisionKey => ({
  environmentId,
  instanceId,
  model,
});

const candidate = (
  modelKey: LocalDecisionKey,
  overrides: Partial<LocalDecisionCandidate> = {},
): LocalDecisionCandidate => ({
  key: modelKey,
  eligible: true,
  capabilities: ["text"],
  ...overrides,
});

const base = (overrides: Partial<LocalDecisionRequest>): LocalDecisionRequest => ({
  environmentId: "local",
  role: "general",
  candidates: [],
  requiredCapabilities: ["text"],
  ...overrides,
});

describe("selectLocalDecision", () => {
  it("uses an explicit role preference and never crosses environments", () => {
    const local = key("local", "provider", "model");
    const remote = key("remote", "provider", "model");
    const result = selectLocalDecision(
      base({
        role: "review",
        candidates: [candidate(remote), candidate(local)],
        rolePreferenceKeys: [remote, local],
      }),
    );
    expect(result).toEqual({ kind: "recommended", key: local, reasonCodes: ["role_preference"] });
  });

  it("abstains on a specialized role without a user-authored preference", () => {
    const modelKey = key("local", "provider", "model");
    expect(
      selectLocalDecision(
        base({
          role: "implementation",
          candidates: [candidate(modelKey, { preferenceRank: 0 })],
          currentKey: modelKey,
        }),
      ),
    ).toEqual({
      kind: "abstain",
      reasonCode: "no_explicit_role_preference",
      blockedReasons: [],
    });
  });

  it("abstains when a saved role pick is unavailable", () => {
    const saved = key("local", "provider", "model");
    expect(
      selectLocalDecision(
        base({
          role: "review",
          candidates: [candidate(saved, { eligible: false })],
          rolePreferenceKeys: [saved],
        }),
      ),
    ).toEqual({
      kind: "abstain",
      reasonCode: "no_eligible_candidate",
      blockedReasons: ["ineligible"],
    });
  });

  it("abstains on an empty catalog or an eligible general catalog without user evidence", () => {
    expect(selectLocalDecision(base({}))).toEqual({
      kind: "abstain",
      reasonCode: "no_eligible_candidate",
      blockedReasons: [],
    });
    expect(
      selectLocalDecision(
        base({
          candidates: [candidate(key("local", "provider", "model"))],
        }),
      ),
    ).toEqual({
      kind: "abstain",
      reasonCode: "no_explicit_general_preference",
      blockedReasons: [],
    });
  });

  it("keeps a valid current general binding ahead of general preference rank", () => {
    const current = key("local", "first", "model");
    const favorite = key("local", "second", "model");
    expect(
      selectLocalDecision(
        base({
          candidates: [candidate(favorite, { preferenceRank: 0 }), candidate(current)],
          currentKey: current,
        }),
      ),
    ).toEqual({ kind: "recommended", key: current, reasonCodes: ["current_binding"] });
  });

  it("never selects unavailable, blocked, or capability-unknown candidates", () => {
    const unavailable = key("local", "a", "model");
    const blocked = key("local", "b", "model");
    const unknown = key("local", "c", "model");
    const valid = key("local", "d", "model");
    const request = base({
      role: "review",
      candidates: [
        candidate(unavailable, { eligible: false }),
        candidate(blocked, { blockedReason: "provider_not_ready" }),
        candidate(unknown, { capabilities: [] }),
        candidate(valid),
      ],
      rolePreferenceKeys: [unavailable, blocked, unknown, valid],
    });
    expect(selectLocalDecision(request)).toEqual({
      kind: "recommended",
      key: valid,
      reasonCodes: ["role_preference"],
    });
  });

  it("is stable across candidate order and treats contradictory duplicate eligibility as blocked", () => {
    const conflicted = key("local", "a", "model");
    const usable = key("local", "b", "model");
    const candidates = [
      candidate(conflicted, { eligible: true, preferenceRank: 0 }),
      candidate(usable, { preferenceRank: 1 }),
      candidate(conflicted, { eligible: false, preferenceRank: 0 }),
    ];
    const decide = (ordered: LocalDecisionCandidate[]) =>
      selectLocalDecision(
        base({
          candidates: ordered,
          currentKey: conflicted,
        }),
      );
    expect(decide(candidates)).toEqual({
      kind: "recommended",
      key: usable,
      reasonCodes: ["general_preference"],
    });
    expect(decide(candidates.toReversed())).toEqual(decide(candidates));
  });

  it("breaks equal preference ranks by the exact key, independent of input order", () => {
    const a = candidate(key("local", "a", "model"), { preferenceRank: 1 });
    const b = candidate(key("local", "b", "model"), { preferenceRank: 1 });
    expect(selectLocalDecision(base({ candidates: [b, a] }))).toEqual(
      selectLocalDecision(base({ candidates: [a, b] })),
    );
    expect(selectLocalDecision(base({ candidates: [b, a] }))).toEqual({
      kind: "recommended",
      key: a.key,
      reasonCodes: ["general_preference"],
    });
  });
});
