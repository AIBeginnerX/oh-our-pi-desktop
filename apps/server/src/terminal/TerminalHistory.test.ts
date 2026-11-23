import { describe, expect, it } from "vite-plus/test";
import { sanitizeTerminalHistoryChunk } from "./TerminalHistory.ts";

describe("bounded pending terminal strings", () => {
  it.each(["\u001b]", "\u001bP", "\u001b^", "\u001b_", "\u009d", "\u0090"])(
    "discards an oversized %j string until its split terminator",
    (prefix) => {
      let result = sanitizeTerminalHistoryChunk("", prefix + "x".repeat(65536));
      expect(Buffer.byteLength(result.pendingControlSequence)).toBeLessThanOrEqual(16384);
      for (let i = 0; i < 4; i++) {
        result = sanitizeTerminalHistoryChunk(result.pendingControlSequence, "y".repeat(65536));
        expect(result.visibleText).toBe("");
        expect(Buffer.byteLength(result.pendingControlSequence)).toBeLessThanOrEqual(16384);
      }
      result = sanitizeTerminalHistoryChunk(result.pendingControlSequence, "\u001b");
      result = sanitizeTerminalHistoryChunk(result.pendingControlSequence, "\\prompt");
      expect(result.visibleText).toBe("prompt");
      expect(result.pendingControlSequence).toBe("");
    },
  );
  it("preserves ordinary split strings", () => {
    const first = sanitizeTerminalHistoryChunk("", "\u001b]0;title");
    expect(sanitizeTerminalHistoryChunk(first.pendingControlSequence, "\u0007ok").visibleText).toBe(
      "\u001b]0;title\u0007ok",
    );
  });
});

it.each(["\u001b]", "\u001bP"])("ends discarded %j on cancellation or a new escape", (prefix) => {
  for (const terminator of ["\u0018", "\u001a", "\u001b[31m"]) {
    const first = sanitizeTerminalHistoryChunk("", prefix + "x".repeat(65536));
    const result = sanitizeTerminalHistoryChunk(
      first.pendingControlSequence,
      terminator + "prompt",
    );
    expect(result.visibleText).toBe((terminator.startsWith("\u001b") ? terminator : "") + "prompt");
    expect(result.pendingControlSequence).toBe("");
  }
});

it.each(["\u001b]", "\u001bP", "\u001b^", "\u001b_", "\u009d", "\u0090", "\u009e", "\u009f"])(
  "recovers same-chunk oversized %j cancellation",
  (prefix) => {
    for (const end of ["", "\u0007", "\u009c", "\u001b\\"]) {
      for (const cancel of ["\u0018", "\u001a", "\u001b[31m"]) {
        const result = sanitizeTerminalHistoryChunk(
          "",
          prefix + "x".repeat(17000) + cancel + "prompt" + end,
        );
        expect(result.visibleText).toBe(
          (cancel.startsWith("\u001b") ? cancel : "") + "prompt" + end,
        );
      }
    }
  },
);
it("handles repeated unterminated introducers without recursive rescans", () => {
  const result = sanitizeTerminalHistoryChunk(
    "",
    "\u001b]".repeat(65536) + "x".repeat(17000) + "\u0018prompt",
  );
  expect(result.visibleText).toContain("prompt");
});
