import { describe, expect, it } from "vite-plus/test";

import { smoothPath, spreadLabels, stepPath } from "./chartLayout";

describe("spreadLabels", () => {
  it("keeps labels that already have room", () => {
    expect(spreadLabels([10, 40, 80], 13, 0, 100)).toEqual([10, 40, 80]);
  });

  it("pushes crowded labels apart in their original order", () => {
    const result = spreadLabels([50, 20, 52, 51], 13, 0, 200);
    const sorted = [...result].sort((a, b) => a - b);
    sorted.forEach((value, index) => {
      if (index > 0) expect(value - sorted[index - 1]!).toBeGreaterThanOrEqual(13);
    });
    expect(result[1]).toBe(20);
    expect(result[0]!).toBeLessThan(result[3]!);
    expect(result[3]!).toBeLessThan(result[2]!);
  });

  it("shifts a crowded group back inside the bottom edge", () => {
    const result = spreadLabels([98, 99, 100], 13, 0, 100);
    expect(result).toEqual([74, 87, 100]);
  });
});

describe("paths", () => {
  it("steps horizontally then vertically", () => {
    expect(
      stepPath([
        [0, 10],
        [5, 20],
        [9, 5],
      ]),
    ).toBe("M 0 10 H 5 V 20 H 9 V 5");
  });

  it("continues a path with L when asked", () => {
    expect(
      smoothPath(
        [
          [0, 0],
          [3, 3],
        ],
        "L",
      ).startsWith("L 0 0 C"),
    ).toBe(true);
  });
});
