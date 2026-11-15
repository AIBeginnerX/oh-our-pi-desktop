import { OWNED_USAGE_ACTIVITY_KIND } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OwnedTurnUsageObservationV1 } from "../usage/ownedUsage.schema.ts";
import { chainStepCostsUsd } from "../usage/threadUsageSummary.ts";

/** What a crew task's thread used; `costUsd` is only here when every counted turn reported one. */
export interface CrewTaskUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly costUsd?: number;
}

const decodeObservation = Schema.decodeUnknownOption(OwnedTurnUsageObservationV1);

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);

/**
 * Totals a thread's owned-usage observations, or null when it has none. A cost is never
 * estimated: one turn without a reported cost leaves the total unpriced.
 */
export function crewThreadUsage(
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly payload: unknown;
    readonly createdAt?: string;
  }>,
): CrewTaskUsage | null {
  const observations = activities.flatMap((activity) => {
    if (activity.kind !== OWNED_USAGE_ACTIVITY_KIND) return [];
    const decoded = Option.getOrNull(decodeObservation(activity.payload));
    return decoded === null ? [] : [{ observation: decoded, createdAt: activity.createdAt ?? "" }];
  });
  if (observations.length === 0) return null;
  const cached = observations.flatMap(
    ({ observation }) => observation.usage.cachedInputTokens ?? [],
  );
  const stepCosts = chainStepCostsUsd(
    observations.map(({ observation, createdAt }) => ({
      chainKey: `${observation.source.driver}|${observation.source.instanceId ?? ""}`,
      createdAt,
      costUsd: observation.costUsd,
    })),
  );
  const allReported = stepCosts.every((cost) => cost !== null);
  return {
    inputTokens: sum(observations.map(({ observation }) => observation.usage.inputTokens ?? 0)),
    outputTokens: sum(observations.map(({ observation }) => observation.usage.outputTokens ?? 0)),
    ...(cached.length > 0 ? { cachedInputTokens: sum(cached) } : {}),
    ...(allReported ? { costUsd: sum(stepCosts.map((cost) => cost ?? 0)) } : {}),
  };
}
