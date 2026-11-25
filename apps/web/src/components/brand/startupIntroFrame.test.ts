import { describe, expect, it } from "vite-plus/test";

import {
  DANCE_START,
  DOT_COUNT,
  DOT_STRIDE,
  FALLBACK_HOME_RECT,
  HOME_LAND_AT,
  HOME_START,
  LEAP_ARC_END,
  LEAP_CROUCH_END,
  LEAP_HOP_END,
  LEAP_START,
  LETTERS_DOT_COUNT,
  ROBOT_BODY_DOT_COUNT,
  ROBOT_DOT_COUNT,
  ROBOT_GATHER_START,
  ROBOT_HEAD_DOT_COUNT,
  STARTUP_INTRO_SETTLED_AT,
  TUCK_START,
  VANISH_START,
  WRITE_START,
  createStartupIntroScene,
  evaluateStartupIntroFrame,
  type Point2D,
  type RasterizeLockupRequest,
  type Rect,
  type StartupIntroScene,
} from "./startupIntroFrame";

/** Pure fake rasteriser returning a simple rectangular grid inside the lockup box. */
function fakeRasterizeLetters(request: RasterizeLockupRequest): ReadonlyArray<Point2D> {
  const cols = 40;
  const rows = 12;
  const points: Array<Point2D> = [];
  for (let r = 0; r < rows; r += 1) {
    const y = ((r + 0.5) / rows) * request.glyphHeight;
    for (let c = 0; c < cols; c += 1) {
      const x = ((c + 0.5) / cols) * request.totalWidth;
      points.push({ x, y });
    }
  }
  return points;
}

function buildScene(overrides?: {
  readonly width?: number;
  readonly height?: number;
  readonly centerY?: number;
  readonly homeRect?: Rect;
}): StartupIntroScene {
  const width = overrides?.width ?? 1440;
  const height = overrides?.height ?? 900;
  return createStartupIntroScene({
    width,
    height,
    centerY: overrides?.centerY ?? height * 0.5,
    homeRect: overrides?.homeRect ?? { x: 78, y: 12, width: 84, height: 16 },
    sans: "sans-serif",
    measureText: (text) => text.length * 52,
    rasterizeLetters: fakeRasterizeLetters,
  });
}

function robotCenter(buffer: Float32Array): { readonly x: number; readonly y: number } {
  let sumX = 0;
  let sumY = 0;
  for (let rIdx = 0; rIdx < ROBOT_DOT_COUNT; rIdx += 1) {
    const q = (LETTERS_DOT_COUNT + rIdx) * DOT_STRIDE;
    sumX += buffer[q]!;
    sumY += buffer[q + 1]!;
  }
  return { x: sumX / ROBOT_DOT_COUNT, y: sumY / ROBOT_DOT_COUNT };
}

function visibleDotsMeanRadius(
  buffer: Float32Array,
  centerX: number,
  centerY: number,
): { readonly meanRadius: number; readonly count: number } {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < DOT_COUNT; i += 1) {
    const q = i * DOT_STRIDE;
    if (buffer[q + 3]! <= 0.01) continue;
    sum += Math.hypot(buffer[q]! - centerX, buffer[q + 1]! - centerY);
    count += 1;
  }
  return { meanRadius: count > 0 ? sum / count : 0, count };
}

function groupBounds(
  buffer: Float32Array,
  startIndex: number,
  count: number,
): {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = startIndex; i < startIndex + count; i += 1) {
    const q = i * DOT_STRIDE;
    const x = buffer[q]!;
    const y = buffer[q + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

const WINDOWS = [
  { name: "wide desktop", width: 1920, height: 1080, centerY: 540 },
  { name: "standard desktop", width: 1440, height: 900, centerY: 450 },
  { name: "card mode", width: 1440, height: 900, centerY: 243 },
  // The desktop window is never smaller than 840x620.
  { name: "smallest desktop window", width: 840, height: 620, centerY: 310 },
  { name: "smallest desktop window in card mode", width: 840, height: 620, centerY: 167 },
  { name: "narrow 360px window", width: 360, height: 640, centerY: 320 },
];

describe("startupIntroFrame", () => {
  it("is deterministic for identical scenes and timestamps", () => {
    const sceneA = buildScene();
    const sceneB = buildScene();
    const bufA = new Float32Array(DOT_COUNT * DOT_STRIDE);
    const bufA2 = new Float32Array(DOT_COUNT * DOT_STRIDE);
    const bufB = new Float32Array(DOT_COUNT * DOT_STRIDE);

    for (const t of [0.05, 0.4, 1.6, 2.55, 3.2, 4.4, 4.85, 5.3]) {
      const scalarsA = evaluateStartupIntroFrame(sceneA, t, bufA);
      const scalarsA2 = evaluateStartupIntroFrame(sceneA, t, bufA2);
      const scalarsB = evaluateStartupIntroFrame(sceneB, t, bufB);

      expect(scalarsA).toEqual(scalarsA2);
      expect(scalarsA).toEqual(scalarsB);
      expect(Array.from(bufA)).toEqual(Array.from(bufA2));
      expect(Array.from(bufA)).toEqual(Array.from(bufB));
    }
  });

  it.each(WINDOWS)("produces valid finite dot attributes across all beats for $name", (win) => {
    const scene = buildScene(win);
    expect(scene.glyphHeight).toBeLessThanOrEqual(150);
    expect(scene.glyphHeight).toBeGreaterThanOrEqual(24);

    const buf = new Float32Array(DOT_COUNT * DOT_STRIDE);
    const invalid: Array<string> = [];
    for (let t = -0.1; t <= STARTUP_INTRO_SETTLED_AT + 0.5; t += 0.1) {
      const scalars = evaluateStartupIntroFrame(scene, t, buf);
      if (
        scalars.backdropOpacity < 0 ||
        scalars.backdropOpacity > 1 ||
        scalars.colorMix < 0 ||
        scalars.colorMix > 1 ||
        scalars.taglineOpacity < 0 ||
        scalars.taglineOpacity > 1
      ) {
        invalid.push(`scalars out of range at t=${t.toFixed(2)}`);
      }
      for (let i = 0; i < DOT_COUNT; i += 1) {
        const q = i * DOT_STRIDE;
        const x = buf[q]!;
        const y = buf[q + 1]!;
        const size = buf[q + 2]!;
        const alpha = buf[q + 3]!;
        const soft = buf[q + 4]!;
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          !Number.isFinite(size) ||
          size <= 0 ||
          alpha < 0 ||
          alpha > 1 ||
          soft < 0 ||
          soft > 1
        ) {
          invalid.push(`dot ${i} invalid at t=${t.toFixed(2)}`);
          break;
        }
      }
    }
    expect(invalid).toEqual([]);
  });

  it.each(WINDOWS)(
    "starts the sphere large and shrinks while keeping all visible dots inside a $name",
    (win) => {
      const scene = buildScene(win);
      const buf = new Float32Array(DOT_COUNT * DOT_STRIDE);

      evaluateStartupIntroFrame(scene, 0.05, buf);
      const early = visibleDotsMeanRadius(buf, scene.centerX, scene.centerY);
      expect(early.count).toBeGreaterThan(DOT_COUNT * 0.5);

      // The sphere is at its widest a little after the start, so sweep the whole beat.
      const outOfBounds: Array<string> = [];
      const steps = 48;
      for (let s = 0; s <= steps && outOfBounds.length === 0; s += 1) {
        const t = (WRITE_START * s) / steps;
        evaluateStartupIntroFrame(scene, t, buf);
        for (let i = 0; i < DOT_COUNT; i += 1) {
          const q = i * DOT_STRIDE;
          if (buf[q + 3]! <= 0.01) continue;
          const x = buf[q]!;
          const y = buf[q + 1]!;
          if (x < 0 || x > scene.width || y < 0 || y > scene.height) {
            outOfBounds.push(`t=${t.toFixed(3)} dot ${i} at (${x.toFixed(1)}, ${y.toFixed(1)})`);
            break;
          }
        }
      }
      expect(outOfBounds).toEqual([]);

      evaluateStartupIntroFrame(scene, WRITE_START - 0.01, buf);
      const preWrite = visibleDotsMeanRadius(buf, scene.centerX, scene.centerY);
      expect(preWrite.count).toBeGreaterThan(DOT_COUNT * 0.5);
      expect(early.meanRadius).toBeGreaterThanOrEqual(preWrite.meanRadius * 1.6);
    },
  );

  it("lands every letters-group dot on its target and visible by the end of WRITE", () => {
    const scene = buildScene();
    const buf = new Float32Array(DOT_COUNT * DOT_STRIDE);
    evaluateStartupIntroFrame(scene, VANISH_START - 0.001, buf);

    let maxDist = 0;
    let minAlpha = 1;
    for (let i = 0; i < LETTERS_DOT_COUNT; i += 1) {
      const q = i * DOT_STRIDE;
      const dist = Math.hypot(buf[q]! - scene.writeX[i]!, buf[q + 1]! - scene.writeY[i]!);
      if (dist > maxDist) maxDist = dist;
      if (buf[q + 3]! < minAlpha) minAlpha = buf[q + 3]!;
    }
    expect(maxDist).toBeLessThanOrEqual(1);
    expect(minAlpha).toBeGreaterThan(0.95);
  });

  it("sways side to side and bounces while staying on screen during DANCE", () => {
    const scene = buildScene();
    const buf = new Float32Array(DOT_COUNT * DOT_STRIDE);
    const samples: Array<{ readonly x: number; readonly y: number }> = [];
    const outOfBounds: Array<string> = [];

    const steps = 20;
    for (let s = 0; s <= steps; s += 1) {
      const t = DANCE_START + ((LEAP_START - DANCE_START) * s) / steps;
      evaluateStartupIntroFrame(scene, t, buf);
      samples.push(robotCenter(buf));

      for (let rIdx = 0; rIdx < ROBOT_DOT_COUNT; rIdx += 1) {
        const q = (LETTERS_DOT_COUNT + rIdx) * DOT_STRIDE;
        const x = buf[q]!;
        const y = buf[q + 1]!;
        const alpha = buf[q + 3]!;
        if (x < 0 || x > scene.width || y < 0 || y > scene.height || alpha <= 0.95) {
          outOfBounds.push(`robot dot ${rIdx} at t=${t.toFixed(2)}`);
          break;
        }
      }
    }
    expect(outOfBounds).toEqual([]);

    const xs = samples.map((p) => p.x);
    const ys = samples.map((p) => p.y);
    expect(Math.max(...xs)).toBeGreaterThan(scene.centerX + 5);
    expect(Math.min(...xs)).toBeLessThan(scene.centerX - 5);

    let movedUp = false;
    let movedDown = false;
    for (let i = 1; i < ys.length; i += 1) {
      if (ys[i]! < ys[i - 1]! - 1) movedUp = true;
      if (ys[i]! > ys[i - 1]! + 1) movedDown = true;
    }
    expect(movedUp).toBe(true);
    expect(movedDown).toBe(true);
  });

  it.each(WINDOWS)(
    "shows a full-body robot taller than head-only and inside the window during DANCE and leap arc for $name",
    (win) => {
      const scene = buildScene(win);
      const buf = new Float32Array(DOT_COUNT * DOT_STRIDE);

      // Measure the head-only aspect ratio (height / width) at the lockup pose.
      evaluateStartupIntroFrame(scene, HOME_START, buf);
      const headOnly = groupBounds(buf, LETTERS_DOT_COUNT, ROBOT_HEAD_DOT_COUNT);
      const headOnlyProportion = headOnly.height / headOnly.width;

      const bodyStart = LETTERS_DOT_COUNT + ROBOT_HEAD_DOT_COUNT;
      const danceMid = (DANCE_START + LEAP_START) * 0.5;
      const leapApex = (LEAP_CROUCH_END + LEAP_ARC_END) * 0.5;

      // Sample across the whole DANCE beat and leap arc for visibility and window containment.
      const sampleTimes: Array<number> = [danceMid, leapApex];
      const steps = 16;
      for (let s = 0; s <= steps; s += 1) {
        sampleTimes.push(DANCE_START + ((LEAP_START - DANCE_START) * s) / steps);
        sampleTimes.push(LEAP_CROUCH_END + ((LEAP_ARC_END - LEAP_CROUCH_END) * s) / steps);
      }

      const outOfBounds: Array<string> = [];
      let minBodyAlpha = 1;
      for (const t of sampleTimes) {
        evaluateStartupIntroFrame(scene, t, buf);
        for (let rIdx = 0; rIdx < ROBOT_DOT_COUNT; rIdx += 1) {
          const q = (LETTERS_DOT_COUNT + rIdx) * DOT_STRIDE;
          const x = buf[q]!;
          const y = buf[q + 1]!;
          if (x < 0 || x > scene.width || y < 0 || y > scene.height) {
            outOfBounds.push(
              `robot dot ${rIdx} at t=${t.toFixed(2)} (${x.toFixed(1)}, ${y.toFixed(1)})`,
            );
            break;
          }
        }
        for (let i = bodyStart; i < bodyStart + ROBOT_BODY_DOT_COUNT; i += 1) {
          const alpha = buf[i * DOT_STRIDE + 3]!;
          if (alpha < minBodyAlpha) minBodyAlpha = alpha;
        }
      }
      expect(outOfBounds).toEqual([]);
      expect(minBodyAlpha).toBeGreaterThan(0.95);

      for (const t of [DANCE_START + 0.25, danceMid, DANCE_START + 0.75, leapApex]) {
        evaluateStartupIntroFrame(scene, t, buf);
        const fullBounds = groupBounds(buf, LETTERS_DOT_COUNT, ROBOT_DOT_COUNT);
        expect(fullBounds.height).toBeGreaterThanOrEqual(
          fullBounds.width * headOnlyProportion * 1.4,
        );
      }
    },
  );

  it("leaps from left of the lockup, peaks above the letters, lands on the right, and increases x monotonically", () => {
    const scene = buildScene();
    const buf = new Float32Array(DOT_COUNT * DOT_STRIDE);

    evaluateStartupIntroFrame(scene, LEAP_CROUCH_END, buf);
    const launch = robotCenter(buf);
    expect(launch.x).toBeLessThan(scene.lockupLettersLeft);

    const arcPeakTime = (LEAP_CROUCH_END + LEAP_ARC_END) * 0.5;
    evaluateStartupIntroFrame(scene, arcPeakTime, buf);
    const peak = robotCenter(buf);
    expect(peak.y).toBeLessThan(scene.lettersTop);

    evaluateStartupIntroFrame(scene, HOME_START, buf);
    const landed = robotCenter(buf);
    expect(landed.x).toBeGreaterThan(scene.lockupLettersRight);

    let prevX = -Infinity;
    const steps = 24;
    for (let s = 0; s <= steps; s += 1) {
      const t = LEAP_CROUCH_END + ((LEAP_ARC_END - LEAP_CROUCH_END) * s) / steps;
      evaluateStartupIntroFrame(scene, t, buf);
      const { x } = robotCenter(buf);
      expect(x).toBeGreaterThan(prevX);
      prevX = x;
    }
  });

  it.each(WINDOWS)("clears the letters for the whole leap in a $name", (win) => {
    const scene = buildScene(win);
    const buf = new Float32Array(DOT_COUNT * DOT_STRIDE);
    const steps = 48;
    for (let s = 0; s <= steps; s += 1) {
      const t = LEAP_CROUCH_END + ((LEAP_ARC_END - LEAP_CROUCH_END) * s) / steps;
      evaluateStartupIntroFrame(scene, t, buf);
      for (let rIdx = 0; rIdx < ROBOT_DOT_COUNT; rIdx += 1) {
        const q = (LETTERS_DOT_COUNT + rIdx) * DOT_STRIDE;
        const x = buf[q]!;
        if (x < scene.lockupLettersLeft || x > scene.lockupLettersRight) continue;
        expect(buf[q + 1]!).toBeLessThan(scene.lettersTop);
      }
    }
  });

  it.each([
    WRITE_START,
    VANISH_START,
    ROBOT_GATHER_START,
    DANCE_START,
    LEAP_START,
    LEAP_HOP_END,
    LEAP_CROUCH_END,
    LEAP_ARC_END,
    TUCK_START,
    HOME_START,
    HOME_LAND_AT,
  ])("moves no visible dot abruptly across the beat boundary at %ss", (boundary) => {
    for (const scene of [buildScene(), buildScene({ centerY: 243 })]) {
      expectContinuousAcross(scene, boundary);
    }
  });

  function expectContinuousAcross(scene: StartupIntroScene, boundary: number) {
    const before = new Float32Array(DOT_COUNT * DOT_STRIDE);
    const after = new Float32Array(DOT_COUNT * DOT_STRIDE);
    const epsilon = 1e-4;
    const scalarsBefore = evaluateStartupIntroFrame(scene, boundary - epsilon, before);
    const scalarsAfter = evaluateStartupIntroFrame(scene, boundary + epsilon, after);

    expect(Math.abs(scalarsAfter.backdropOpacity - scalarsBefore.backdropOpacity)).toBeLessThan(
      0.02,
    );
    expect(Math.abs(scalarsAfter.colorMix - scalarsBefore.colorMix)).toBeLessThan(0.02);
    expect(Math.abs(scalarsAfter.taglineOpacity - scalarsBefore.taglineOpacity)).toBeLessThan(0.02);

    let worstMove = 0;
    let worstAlpha = 0;
    let worstSize = 0;
    for (let i = 0; i < DOT_COUNT; i += 1) {
      const q = i * DOT_STRIDE;
      worstAlpha = Math.max(worstAlpha, Math.abs(after[q + 3]! - before[q + 3]!));
      // A dot that is invisible on both sides may be parked anywhere.
      if (before[q + 3]! < 0.02 && after[q + 3]! < 0.02) continue;
      worstMove = Math.max(
        worstMove,
        Math.hypot(after[q]! - before[q]!, after[q + 1]! - before[q + 1]!),
      );
      worstSize = Math.max(worstSize, Math.abs(after[q + 2]! - before[q + 2]!));
    }
    expect(worstMove).toBeLessThan(1.5);
    expect(worstAlpha).toBeLessThan(0.05);
    expect(worstSize).toBeLessThan(0.3);
  }

  it("hides every body dot from HOME_START onward while head dots land inside the home rect", () => {
    const homeRect: Rect = { x: 78, y: 12, width: 84, height: 16 };
    const scene = buildScene({ homeRect });
    const buf = new Float32Array(DOT_COUNT * DOT_STRIDE);
    const bodyStart = LETTERS_DOT_COUNT + ROBOT_HEAD_DOT_COUNT;

    for (const t of [
      HOME_START,
      (HOME_START + HOME_LAND_AT) * 0.5,
      HOME_LAND_AT,
      STARTUP_INTRO_SETTLED_AT,
    ]) {
      evaluateStartupIntroFrame(scene, t, buf);
      let maxBodyAlpha = 0;
      for (let i = bodyStart; i < DOT_COUNT; i += 1) {
        const alpha = buf[i * DOT_STRIDE + 3]!;
        if (alpha > maxBodyAlpha) maxBodyAlpha = alpha;
      }
      expect(maxBodyAlpha).toBe(0);
    }

    evaluateStartupIntroFrame(scene, HOME_LAND_AT, buf);
    const tolerance = 1;
    const outsideHead: Array<string> = [];
    for (let rIdx = 0; rIdx < ROBOT_HEAD_DOT_COUNT; rIdx += 1) {
      const q = (LETTERS_DOT_COUNT + rIdx) * DOT_STRIDE;
      const x = buf[q]!;
      const y = buf[q + 1]!;
      expect(buf[q + 3]!).toBeGreaterThan(0.95);
      if (
        x < homeRect.x - tolerance ||
        x > homeRect.x + homeRect.width + tolerance ||
        y < homeRect.y - tolerance ||
        y > homeRect.y + homeRect.height + tolerance
      ) {
        outsideHead.push(`head dot ${rIdx} at (${x.toFixed(1)}, ${y.toFixed(1)})`);
      }
    }
    expect(outsideHead).toEqual([]);
  });

  it.each([
    {
      name: "the real sidebar home rectangle",
      inputRect: { x: 78, y: 12, width: 84, height: 16 },
      expectedRect: { x: 78, y: 12, width: 84, height: 16 },
    },
    {
      name: "the fallback rectangle when the measured home rect is empty",
      inputRect: { x: 0, y: 0, width: 0, height: 0 },
      expectedRect: FALLBACK_HOME_RECT,
    },
  ])(
    "lands every visible dot inside $name with backdrop opacity 0 at the end of HOME",
    ({ inputRect, expectedRect }) => {
      const scene = buildScene({ homeRect: inputRect });
      const buf = new Float32Array(DOT_COUNT * DOT_STRIDE);
      const tolerance = 1;

      const landScalars = evaluateStartupIntroFrame(scene, HOME_LAND_AT, buf);
      expect(landScalars.backdropOpacity).toBe(0);
      expect(landScalars.colorMix).toBe(1);

      let visibleCount = 0;
      const outside: Array<string> = [];
      for (let i = 0; i < DOT_COUNT; i += 1) {
        const q = i * DOT_STRIDE;
        const alpha = buf[q + 3]!;
        if (alpha > 0.01) {
          visibleCount += 1;
          const x = buf[q]!;
          const y = buf[q + 1]!;
          if (
            x < expectedRect.x - tolerance ||
            x > expectedRect.x + expectedRect.width + tolerance ||
            y < expectedRect.y - tolerance ||
            y > expectedRect.y + expectedRect.height + tolerance
          ) {
            outside.push(`dot ${i} at (${x.toFixed(1)}, ${y.toFixed(1)})`);
          }
        }
      }
      expect(visibleCount).toBe(LETTERS_DOT_COUNT + ROBOT_HEAD_DOT_COUNT);
      expect(outside).toEqual([]);

      const endScalars = evaluateStartupIntroFrame(scene, STARTUP_INTRO_SETTLED_AT, buf);
      expect(endScalars.backdropOpacity).toBe(0);
      for (let i = 0; i < DOT_COUNT; i += 1) {
        const q = i * DOT_STRIDE;
        const x = buf[q]!;
        const y = buf[q + 1]!;
        if (
          x < expectedRect.x - tolerance ||
          x > expectedRect.x + expectedRect.width + tolerance ||
          y < expectedRect.y - tolerance ||
          y > expectedRect.y + expectedRect.height + tolerance
        ) {
          outside.push(`settled dot ${i} at (${x.toFixed(1)}, ${y.toFixed(1)})`);
        }
      }
      expect(outside).toEqual([]);
    },
  );

  it("holds one identical finished frame after the settled time", () => {
    const scene = buildScene();
    const settled = new Float32Array(DOT_COUNT * DOT_STRIDE);
    const later = new Float32Array(DOT_COUNT * DOT_STRIDE);

    const settledScalars = evaluateStartupIntroFrame(scene, STARTUP_INTRO_SETTLED_AT, settled);
    const laterScalars = evaluateStartupIntroFrame(scene, STARTUP_INTRO_SETTLED_AT + 3, later);

    expect(laterScalars).toEqual(settledScalars);
    expect(Array.from(later)).toEqual(Array.from(settled));
  });
});
