import { describe, expect, it } from "@effect/vitest";

import { judgeMemoryOutcome } from "./memoryOutcomes.ts";

describe("judgeMemoryOutcome", () => {
  it("ignores signals at or before the send and unrelated signals after it", () => {
    expect(
      judgeMemoryOutcome(
        [
          { kind: "revert", eventSeq: 1 },
          { kind: "result-accepted", eventSeq: 2 },
          { kind: "interrupt-then-follow-up", eventSeq: 3 },
        ],
        2,
      ),
    ).toBe("unknown");
  });

  it("judges resolved failures as good when no later bad signal is present", () => {
    expect(
      judgeMemoryOutcome(
        [
          { kind: "check-failed", eventSeq: 1 },
          { kind: "check-failed-then-passed", eventSeq: 3 },
        ],
        2,
      ),
    ).toBe("good");
  });

  it("judges a bad signal alongside a good signal as bad", () => {
    expect(
      judgeMemoryOutcome(
        [
          { kind: "crew-work-verified", eventSeq: 3 },
          { kind: "result-withdrawn", eventSeq: 4 },
        ],
        2,
      ),
    ).toBe("bad");
  });
});
