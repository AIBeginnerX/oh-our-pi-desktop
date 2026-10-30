import { OWNED_USAGE_ACTIVITY_KIND } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OwnedTurnUsageObservationV1 } from "../usage/ownedUsage.schema.ts";

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
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): CrewTaskUsage | null {
  const observations = activities.flatMap((activity) =>
    activity.kind === OWNED_USAGE_ACTIVITY_KIND
      ? Option.toArray(decodeObservation(activity.payload))
      : [],
  );
  if (observations.length === 0) return null;
  const cached = observations.flatMap((entry) => entry.usage.cachedInputTokens ?? []);
  const costs = observations.flatMap((entry) => entry.costUsd ?? []);
  return {
    inputTokens: sum(observations.map((entry) => entry.usage.inputTokens ?? 0)),
    outputTokens: sum(observations.map((entry) => entry.usage.outputTokens ?? 0)),
    ...(cached.length > 0 ? { cachedInputTokens: sum(cached) } : {}),
    ...(costs.length === observations.length ? { costUsd: sum(costs) } : {}),
  };
}
