import { isImportedAgentSessionMessageId, type OrchestrationThread } from "@t3tools/contracts";

export function selectPromptSuggestion(
  thread: Pick<OrchestrationThread, "activities" | "messages" | "latestTurn" | "session">,
): { id: string; text: string } | null {
  const { latestTurn, session } = thread;
  if (
    latestTurn?.state !== "completed" ||
    session?.status === "running" ||
    session?.status === "starting"
  )
    return null;

  // Like settlement's queued-turn check, use turn timestamps to detect a
  // user message the provider has not adopted. A dismissed turn's suggestion
  // should stay hidden even after the settlement grace period.
  const latestTurnAt = Math.max(
    Date.parse(latestTurn.requestedAt),
    latestTurn.startedAt === null ? -Infinity : Date.parse(latestTurn.startedAt),
    latestTurn.completedAt === null ? -Infinity : Date.parse(latestTurn.completedAt),
  );
  if (
    thread.messages.some(
      (message) =>
        message.role === "user" &&
        !isImportedAgentSessionMessageId(message.id) &&
        Date.parse(message.createdAt) > latestTurnAt,
    )
  )
    return null;

  for (let index = thread.activities.length - 1; index >= 0; index--) {
    const activity = thread.activities[index];
    if (activity?.kind !== "prompt.suggestion") continue;
    const payload = activity.payload;
    if (
      payload !== null &&
      typeof payload === "object" &&
      "turnId" in payload &&
      payload.turnId === latestTurn.turnId &&
      "text" in payload &&
      typeof payload.text === "string" &&
      payload.text.length > 0
    )
      return { id: activity.id, text: payload.text };
  }
  return null;
}
