import { describe, expect, it } from "vite-plus/test";

import { describeAcpPromptFailure } from "./GrokAdapter.ts";

describe("describeAcpPromptFailure", () => {
  it("keeps the reason of an upstream HTML error page, without the markup", () => {
    // What MiniMax Code relayed when its service failed (Windows log, 2026-10-19).
    const defect = new Error(
      "Internal error: MiniMax Code Runtime failed: 500 <HTML><HEAD>\n<TITLE>Internal Server Error</TITLE>\n</HEAD><BODY>\n<H1>Internal Server Error - Read</H1>\nThe server encountered an internal error.<P>\nReference&#32;&#35;3&#46;e6da2317\n</BODY></HTML>",
    );
    expect(describeAcpPromptFailure("MiniMax Code", defect)).toBe(
      "MiniMax Code request failed: Internal error: MiniMax Code Runtime failed: 500 Internal Server Error Internal Server Error - Read The server encountered an internal error. Reference #3.e6da2317",
    );
  });

  it("caps a long reason and falls back when there is none", () => {
    const long = describeAcpPromptFailure("ZCode", new Error("x".repeat(500)));
    expect(long.startsWith("ZCode request failed: ")).toBe(true);
    expect(long.length).toBe("ZCode request failed: ".length + 300);
    expect(describeAcpPromptFailure("ZCode", undefined)).toBe("ZCode prompt request failed.");
  });

  it("translates a MiniMax Code LLM first-event timeout into a friendly retry message", () => {
    const defect = new Error(
      "Internal error: MiniMax Code Runtime failed: LLM request timed out: no response from the provider within 300000ms. Raise it with MCODE_LLM_FIRST_EVENT_TIMEOUT_MS (milliseconds, 0 disables) or the host's per-model firstEventTimeoutMs.",
    );
    expect(describeAcpPromptFailure("MiniMax Code", defect)).toBe(
      "MiniMax Code got no response from the model provider in time. The provider may be busy; send the message again or pick another model.",
    );
  });
});
