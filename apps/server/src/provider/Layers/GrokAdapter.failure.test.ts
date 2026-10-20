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
});
