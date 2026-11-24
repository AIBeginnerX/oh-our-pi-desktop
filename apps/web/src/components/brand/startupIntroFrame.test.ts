import { describe, expect, it } from "vite-plus/test";

import {
  STARTUP_INTRO_SETTLED_AT,
  countUpVersion,
  createStartupIntroScene,
  drawStartupIntro,
  type StartupIntroCanvas,
} from "./startupIntroFrame";

interface Call {
  readonly name: string;
  readonly args: ReadonlyArray<unknown>;
}

/** Stands in for a 2D context and keeps every call and property write, in order. */
function recordingCanvas() {
  const calls: Array<Call> = [];
  const canvas = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args: ReadonlyArray<unknown>) => {
          calls.push({ name: String(name), args });
        },
      set: (_, name, value) => {
        calls.push({ name: `set ${String(name)}`, args: [value] });
        return true;
      },
    },
  ) as unknown as StartupIntroCanvas;
  return { canvas, calls };
}

function frame(
  input: { width: number; height: number; centerY: number; letterWidth: number },
  t: number,
) {
  const { canvas, calls } = recordingCanvas();
  const scene = createStartupIntroScene({
    width: input.width,
    height: input.height,
    centerY: input.centerY,
    tagline: "Development AI Agents",
    version: "0.0.163",
    sans: "sans-serif",
    mono: "monospace",
    measure: (text) => text.length * input.letterWidth,
  });
  drawStartupIntro(canvas, scene, t);
  return calls;
}

const WINDOWS = [
  { name: "a wide window", width: 1920, height: 1080, centerY: 540, letterWidth: 12 },
  { name: "a tall window", width: 620, height: 900, centerY: 450, letterWidth: 6 },
  {
    name: "a window with a card under the motion",
    width: 1440,
    height: 900,
    centerY: 243,
    letterWidth: 9,
  },
  // Letters too wide to track out: the tagline must still lay out.
  {
    name: "a font wider than the wordmark",
    width: 400,
    height: 300,
    centerY: 150,
    letterWidth: 400,
  },
];

describe("drawStartupIntro", () => {
  it.each(WINDOWS)("draws every frame of $name with values a canvas accepts", (window) => {
    // A real canvas throws on a negative radius and silently drops a call with NaN in it.
    const rejected: Array<string> = [];
    for (let t = -0.1; t <= STARTUP_INTRO_SETTLED_AT + 0.5; t += 1 / 120) {
      for (const call of frame(window, t)) {
        const radii =
          call.name === "arc"
            ? [call.args[2]]
            : call.name === "ellipse"
              ? [call.args[2], call.args[3]]
              : [];
        const accepted =
          call.args.every((arg) => typeof arg !== "number" || Number.isFinite(arg)) &&
          radii.every((radius) => typeof radius === "number" && radius >= 0);
        if (!accepted) rejected.push(`${call.name}(${call.args.join(", ")}) at ${t.toFixed(3)}s`);
      }
    }
    expect(rejected).toEqual([]);
  });

  it("holds one finished frame once it has settled", () => {
    const [window] = WINDOWS;
    if (!window) throw new Error("no window");
    const settled = frame(window, STARTUP_INTRO_SETTLED_AT);
    expect(frame(window, STARTUP_INTRO_SETTLED_AT + 3)).toEqual(settled);
    // The finished frame carries the real version, not a number still counting.
    expect(settled).toContainEqual(
      expect.objectContaining({ name: "fillText", args: expect.arrayContaining(["v0.0.163"]) }),
    );
  });
});

describe("countUpVersion", () => {
  it("counts every number up to the real version without changing its width", () => {
    expect(countUpVersion("0.0.163", 0)).toBe("0.0.000");
    expect(countUpVersion("0.0.163", 0.5)).toBe("0.0.082");
    expect(countUpVersion("0.0.163", 1)).toBe("0.0.163");
    expect(countUpVersion("1.12.3-beta.4", 1)).toBe("1.12.3-beta.4");
  });
});
