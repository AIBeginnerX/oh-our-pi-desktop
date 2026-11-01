import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { setLanguage } from "../i18n/index.ts";
import { checkpointGapText } from "./checkpoints.ts";
import { goalBarText } from "./goal.ts";
import { noModelCause } from "./commands.ts";
import { relativeTime } from "./projects.ts";
import { parseRuntimeMode, RUNTIME_MODES } from "./runtimeMode.ts";
import { matchSlashCommands, SLASH_COMMANDS } from "./slashCommands.ts";

const HANGUL = /[가-힣]/u;

describe("session strings in English", () => {
  beforeEach(() => setLanguage("en"));
  afterEach(() => setLanguage("ko"));

  it("describes every slash command in English", () => {
    for (const command of SLASH_COMMANDS) {
      expect(command.note).not.toMatch(HANGUL);
      expect(command.usage ?? "").not.toMatch(HANGUL);
    }
    expect(SLASH_COMMANDS.find((command) => command.name === "model")?.note).toBe("Pick a model");
  });

  it("finds a slash command by a word of its English description", () => {
    expect(matchSlashCommands("undo").map((command) => command.name)[0]).toBe("undo");
    expect(matchSlashCommands("reasoning").map((command) => command.name)).toContain("effort");
  });

  it("names runtime modes in English and still accepts the typed label", () => {
    expect(RUNTIME_MODES.map((entry) => entry.label)).toEqual([
      "Approval required",
      "Auto-accept edits",
      "Auto",
      "Full access",
    ]);
    expect(parseRuntimeMode("Full access")).toBe("full-access");
    expect(parseRuntimeMode("auto-accept edits")).toBe("auto-accept-edits");
  });

  it("writes checkpoint gaps, goal bars and relative times in English", () => {
    expect(checkpointGapText({ kind: "no-turn" })).toBe("No turn has finished yet.");
    expect(checkpointGapText({ kind: "no-such-turn", turn: 5, first: 1, last: 3 })).toBe(
      "There is no checkpoint for turn 5. Turns 1-3 have one.",
    );
    expect(noModelCause(null)).toBe("The server config has not arrived yet");
    const now = new Date("2026-01-01T12:00:00Z");
    expect(relativeTime("2026-01-01T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-01-01T11:59:50Z", now)).toBe("just now");
    expect(goalBarText({ maxContinues: 5 } as never, null)).toBe("Goal ?/5");
  });
});
