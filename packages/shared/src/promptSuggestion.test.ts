import { EventId, MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { selectPromptSuggestion } from "./promptSuggestion.ts";

const requestedAt = "2026-11-01T00:00:00.000Z";
const completedAt = "2026-11-01T00:00:01.000Z";
const turnId = TurnId.make("latest");
const suggestion = (id: string, turn = turnId) => ({
  id: EventId.make(id),
  kind: "prompt.suggestion",
  createdAt: "2026-11-01T00:00:03.000Z",
  tone: "info" as const,
  summary: "Prompt suggestion",
  payload: { text: id, turnId: turn },
  turnId: turn,
});
const thread = {
  activities: [
    suggestion("first"),
    suggestion("newest"),
    suggestion("old-turn", TurnId.make("old")),
  ],
  messages: [],
  latestTurn: {
    turnId,
    state: "completed" as const,
    requestedAt,
    startedAt: requestedAt,
    completedAt,
    assistantMessageId: null,
  },
  session: null,
};

describe("selectPromptSuggestion", () => {
  it("takes the newest suggestion for the latest turn", () => {
    expect(selectPromptSuggestion(thread)).toEqual({ id: "newest", text: "newest" });
  });

  it("ignores suggestions for earlier turns", () => {
    expect(
      selectPromptSuggestion({ ...thread, activities: [suggestion("old", TurnId.make("old"))] }),
    ).toBeNull();
  });

  it("waits for turn completion", () => {
    expect(
      selectPromptSuggestion({
        ...thread,
        latestTurn: { ...thread.latestTurn, state: "running" },
      }),
    ).toBeNull();
  });

  it("hides a suggestion after a user sends, even with an earlier clock than the activity", () => {
    const sentAt = "2026-11-01T00:00:02.000Z";
    expect(
      selectPromptSuggestion({
        ...thread,
        messages: [
          {
            id: MessageId.make("next-user"),
            role: "user",
            text: "Next",
            turnId: null,
            streaming: false,
            createdAt: sentAt,
            updatedAt: sentAt,
          },
        ],
      }),
    ).toBeNull();
  });
});
