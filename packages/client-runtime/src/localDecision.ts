export interface LocalDecisionKey {
  readonly environmentId: string;
  readonly instanceId: string;
  readonly model: string;
}

export interface LocalDecisionCandidate {
  readonly key: LocalDecisionKey;
  readonly eligible: boolean;
  readonly blockedReason?: string;
  readonly capabilities: readonly string[];
  readonly preferenceRank?: number;
}

export type LocalDecisionRole = "general" | "implementation" | "review";

export interface LocalDecisionRequest {
  readonly environmentId: string;
  readonly role: LocalDecisionRole;
  readonly candidates: readonly LocalDecisionCandidate[];
  readonly requiredCapabilities: readonly string[];
  readonly currentKey?: LocalDecisionKey;
  readonly rolePreferenceKeys?: readonly LocalDecisionKey[];
}

export type LocalDecisionResult =
  | {
      readonly kind: "recommended";
      readonly key: LocalDecisionKey;
      readonly reasonCodes: readonly (
        | "role_preference"
        | "current_binding"
        | "general_preference"
      )[];
    }
  | {
      readonly kind: "abstain";
      readonly reasonCode:
        | "no_explicit_role_preference"
        | "no_eligible_candidate"
        | "no_explicit_general_preference";
      readonly blockedReasons: readonly string[];
    };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareKeys(left: LocalDecisionKey, right: LocalDecisionKey): number {
  return (
    compareText(left.environmentId, right.environmentId) ||
    compareText(left.instanceId, right.instanceId) ||
    compareText(left.model, right.model)
  );
}

function sameKey(left: LocalDecisionKey, right: LocalDecisionKey): boolean {
  return compareKeys(left, right) === 0;
}

interface EligibleCandidate {
  readonly key: LocalDecisionKey;
  readonly preferenceRank: number | undefined;
}

/** Select only from observed eligibility and user-authored preferences. */
export function selectLocalDecision(request: LocalDecisionRequest): LocalDecisionResult {
  const groups = new Map<string, LocalDecisionCandidate[]>();
  const blockedReasons = new Set<string>();

  for (const candidate of request.candidates) {
    if (candidate.key.environmentId !== request.environmentId) {
      blockedReasons.add("wrong_environment");
      continue;
    }
    const id = JSON.stringify([
      candidate.key.environmentId,
      candidate.key.instanceId,
      candidate.key.model,
    ]);
    const group = groups.get(id);
    if (group) group.push(candidate);
    else groups.set(id, [candidate]);
  }

  const eligible: EligibleCandidate[] = [];
  for (const group of groups.values()) {
    const key = group[0]!.key;
    if (group.some((candidate) => !candidate.eligible)) {
      blockedReasons.add("ineligible");
      continue;
    }
    const reasons = group.flatMap((candidate) => candidate.blockedReason ?? []);
    if (reasons.length > 0) {
      for (const reason of reasons) blockedReasons.add(reason);
      continue;
    }
    const missing = request.requiredCapabilities.find((required) =>
      group.some((candidate) => !candidate.capabilities.includes(required)),
    );
    if (missing !== undefined) {
      blockedReasons.add(`missing_capability:${missing}`);
      continue;
    }
    const ranks = group
      .map((candidate) => candidate.preferenceRank)
      .filter((rank): rank is number => rank !== undefined && Number.isFinite(rank));
    eligible.push({ key, preferenceRank: ranks.length > 0 ? Math.min(...ranks) : undefined });
  }

  eligible.sort((left, right) => compareKeys(left.key, right.key));
  const matching = (key: LocalDecisionKey) =>
    eligible.find((candidate) => sameKey(candidate.key, key));
  const recommend = (
    candidate: EligibleCandidate,
    reasonCode: "role_preference" | "current_binding" | "general_preference",
  ): LocalDecisionResult => ({
    kind: "recommended",
    key: candidate.key,
    reasonCodes: [reasonCode],
  });
  const abstain = (
    reasonCode: Extract<LocalDecisionResult, { kind: "abstain" }>["reasonCode"],
  ): LocalDecisionResult => ({
    kind: "abstain",
    reasonCode,
    blockedReasons: [...blockedReasons].sort(compareText),
  });

  for (const key of request.rolePreferenceKeys ?? []) {
    const candidate = matching(key);
    if (candidate) return recommend(candidate, "role_preference");
  }

  if (request.role !== "general") {
    return abstain(
      request.rolePreferenceKeys?.length ? "no_eligible_candidate" : "no_explicit_role_preference",
    );
  }

  if (request.currentKey) {
    const candidate = matching(request.currentKey);
    if (candidate) return recommend(candidate, "current_binding");
  }

  const ranked = eligible
    .filter((candidate) => candidate.preferenceRank !== undefined)
    .sort(
      (left, right) =>
        left.preferenceRank! - right.preferenceRank! || compareKeys(left.key, right.key),
    );
  if (ranked[0]) return recommend(ranked[0], "general_preference");

  return abstain(eligible.length ? "no_explicit_general_preference" : "no_eligible_candidate");
}
