// Particle technique after Thinking Sphere by DesignBookmark (designbookmark.com/motion)

import { OOP_MASCOT_BODY_PATH, OOP_MASCOT_EYES_PATH, OOP_MASCOT_GRID } from "./OoPMascot";
import { OOP_WORDMARK_VIEWBOX } from "./OoPWordmark";

/** Floats per dot written into the vertex buffer: x, y, size, alpha, softness. */
export const DOT_STRIDE = 5;

/**
 * Timeline beat boundaries in seconds:
 * - THINK (0..1.2): large breathing Fibonacci sphere shrinks smoothly to 1x over 0.75 s and keeps breathing.
 * - WRITE (1.2..2.2): sphere swirls into "OOP AI".
 * - VANISH & GATHER (2.2..2.8): letters drift to dust; robot dots gather into full-body Oopi (2.42..2.8).
 * - DANCE (2.8..3.8): full-body Oopi sways, bounces, swings arms, lifts legs, bobs head, wags antenna, blinks.
 * - LEAP (3.8..4.7): hops left (3.8..4.12), crouches (4.12..4.22), leaps over "OOP AI" (4.22..4.6), lands (4.6..4.7).
 * - TUCK (4.7..5.0): body folds into the head and fades to alpha 0 while the head settles to lockup and tagline fades in.
 * - HOME (5.0..5.8): letters and head fly to the sidebar brand (5.0..5.65) and fade out (5.65..5.8).
 */
export const THINK_START = 0;
export const WRITE_START = 1.2;
export const VANISH_START = 2.2;
export const ROBOT_GATHER_START = 2.42;
export const DANCE_START = 2.8;
export const LEAP_START = 3.8;
export const LEAP_HOP_END = 4.12;
export const LEAP_CROUCH_END = 4.22;
export const LEAP_ARC_END = 4.6;
export const TUCK_START = 4.7;
export const HOME_START = 5.0;
export const HOME_LAND_AT = 5.65;
/** From here on every frame is identical and the intro has finished landing. */
export const STARTUP_INTRO_SETTLED_AT = 5.8;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point2D {
  readonly x: number;
  readonly y: number;
}

/** Fallback target in the top-left when the sidebar brand is hidden or not mounted yet. */
export const FALLBACK_HOME_RECT: Rect = {
  x: 16,
  y: 14,
  width: 96,
  height: 16,
};

/** Input passed to the injected letter rasteriser so the timeline stays DOM-free. */
export interface RasterizeLockupRequest {
  readonly glyphHeight: number;
  readonly wordmarkWidth: number;
  readonly aiGap: number;
  readonly aiWidth: number;
  readonly totalWidth: number;
  readonly font: string;
  readonly maxDots: number;
}

export interface StartupIntroSceneInput {
  readonly width: number;
  readonly height: number;
  /** Vertical centre for the choreography, in CSS pixels from the top. */
  readonly centerY: number;
  /** Bounding rect of the sidebar brand; falls back to `FALLBACK_HOME_RECT` if empty. */
  readonly homeRect: Rect;
  readonly sans: string;
  readonly measureText: (text: string, font: string) => number;
  readonly rasterizeLetters: (request: RasterizeLockupRequest) => ReadonlyArray<Point2D>;
}

/** Scalars returned alongside the filled vertex buffer for DOM backdrop, colour and tagline. */
export interface StartupIntroFrameScalars {
  readonly backdropOpacity: number;
  /** 0 = paper white on black, 1 = real sidebar brand text colour. */
  readonly colorMix: number;
  readonly taglineOpacity: number;
}

const PART_HEAD = 0;
const PART_ANTENNA = 1;
const PART_EYE = 2;
const PART_TORSO = 3;
const PART_LEFT_ARM = 4;
const PART_RIGHT_ARM = 5;
const PART_LEFT_LEG = 6;
const PART_RIGHT_LEG = 7;

const ROBOT_BODY_START_ROW = 15;
const ROBOT_FULL_ROWS = 25;

// Full-body continuation below the 16x16 mascot head (rows 15-24, cols 0-15); head rows 13-14 read as neck.
const ROBOT_BODY_GRID: ReadonlyArray<string> = [
  "   ##########   ", // row 15: torso top, cols 3-12
  " ###        ### ", // row 16: arms cols 1-2 & 13-14, torso walls cols 3 & 12
  " # #   ##   # # ", // row 17: arms col 1 & 14, torso walls, chest core cols 7-8
  " # #   ##   # # ", // row 18
  " # #        # # ", // row 19
  "## ########## ##", // row 20: hands cols 0-1 & 14-15, torso bottom cols 3-12
  "    ##    ##    ", // row 21: legs cols 4-5 & 10-11
  "    ##    ##    ", // row 22
  "    ##    ##    ", // row 23
  "   ###    ###   ", // row 24: feet cols 3-5 & 10-12
];

interface RobotCell {
  readonly col: number;
  readonly row: number;
  readonly part: number;
}

interface RobotDotTemplate {
  readonly cx: number;
  readonly cy: number;
  readonly row: number;
  readonly part: number;
}

const RECT_CMD = /M(\d+)\s+(\d+)h(\d+)v(\d+)h-\d+z/g;

function parseMascotCells(path: string, kind: "body" | "eye"): ReadonlyArray<RobotCell> {
  const cells: Array<RobotCell> = [];
  for (const match of path.matchAll(RECT_CMD)) {
    const startX = Number(match[1]);
    const startY = Number(match[2]);
    const w = Number(match[3]);
    const h = Number(match[4]);
    for (let dy = 0; dy < h; dy += 1) {
      const row = startY + dy;
      const part = kind === "eye" ? PART_EYE : row <= 3 ? PART_ANTENNA : PART_HEAD;
      for (let dx = 0; dx < w; dx += 1) {
        cells.push({ col: startX + dx, row, part });
      }
    }
  }
  return cells;
}

function parseBodyCells(): ReadonlyArray<RobotCell> {
  const cells: Array<RobotCell> = [];
  for (let rowOffset = 0; rowOffset < ROBOT_BODY_GRID.length; rowOffset += 1) {
    const line = ROBOT_BODY_GRID[rowOffset]!;
    const row = ROBOT_BODY_START_ROW + rowOffset;
    for (let col = 0; col < line.length; col += 1) {
      if (line[col] !== "#") continue;
      let part = PART_TORSO;
      if (row >= 21) {
        part = col < 8 ? PART_LEFT_LEG : PART_RIGHT_LEG;
      } else if (col <= 2) {
        part = PART_LEFT_ARM;
      } else if (col >= 13) {
        part = PART_RIGHT_ARM;
      }
      cells.push({ col, row, part });
    }
  }
  return cells;
}

const SUB_OFFSETS = [0.25, 0.75] as const;

function expandCellsToDots(cells: ReadonlyArray<RobotCell>): ReadonlyArray<RobotDotTemplate> {
  return cells.flatMap((cell) =>
    SUB_OFFSETS.flatMap((oy) =>
      SUB_OFFSETS.map((ox) => ({
        cx: cell.col + ox,
        cy: cell.row + oy,
        row: cell.row,
        part: cell.part,
      })),
    ),
  );
}

const HEAD_DOTS = expandCellsToDots([
  ...parseMascotCells(OOP_MASCOT_BODY_PATH, "body"),
  ...parseMascotCells(OOP_MASCOT_EYES_PATH, "eye"),
]);
const BODY_DOTS = expandCellsToDots(parseBodyCells());
const ROBOT_DOTS: ReadonlyArray<RobotDotTemplate> = [...HEAD_DOTS, ...BODY_DOTS];

export const LETTERS_DOT_COUNT = 1276;
export const ROBOT_HEAD_DOT_COUNT = HEAD_DOTS.length;
export const ROBOT_BODY_DOT_COUNT = BODY_DOTS.length;
export const ROBOT_DOT_COUNT = ROBOT_DOTS.length;
export const DOT_COUNT = LETTERS_DOT_COUNT + ROBOT_DOT_COUNT;

// Sidebar brand proportions: wordmark h-3.5 (14px), gap-1 (4px), gap-1.5 (6px), mascot size-4 (16px).
const WORDMARK_ASPECT = OOP_WORDMARK_VIEWBOX.width / OOP_WORDMARK_VIEWBOX.height;
const AI_GAP_RATIO = 4 / 14;
const ROBOT_GAP_RATIO = 6 / 14;
const ROBOT_SIZE_RATIO = 16 / 14;
const LOCKUP_WIDTH_FRACTION = 0.46;
const MIN_GLYPH_HEIGHT = 36;
const MAX_GLYPH_HEIGHT = 150;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PERSPECTIVE_F = 520;
const SPHERE_PITCH = 0.32;
const SPHERE_YAW_START = 0.25;
const SPHERE_YAW_RATE = 0.55;
const SPHERE_START_MULTIPLIER = 2.4;
const SPHERE_SHRINK_DURATION = 0.75;
const SPHERE_BREATH_AMP = 0.06;
const SPHERE_BREATH_PERIOD = 0.9;
const SPHERE_BREATH_OMEGA = (Math.PI * 2) / SPHERE_BREATH_PERIOD;
const SPRING_DECAY = 5.5;
const SPRING_WD = 6.46;
const SPRING_TAU_SCALE = 1.15;

// Full-body robot pivots and reference lines in grid cell coordinates (cols 0..16, rows 0..25).
const ROBOT_CENTER_CX = OOP_MASCOT_GRID * 0.5;
const HEAD_CENTER_CY = OOP_MASCOT_GRID * 0.5;
const FULL_CENTER_CY = ROBOT_FULL_ROWS * 0.5;
const FEET_BOTTOM_CY = ROBOT_FULL_ROWS;
const EYE_CENTER_CY = 7.5;
const HEAD_PIVOT_CX = 8;
const HEAD_PIVOT_CY = 14.5;
const LEFT_SHOULDER_CX = 2.5;
const LEFT_SHOULDER_CY = 16.5;
const RIGHT_SHOULDER_CX = 13.5;
const RIGHT_SHOULDER_CY = 16.5;
const LEFT_HIP_CX = 5;
const LEFT_HIP_CY = 21;
const RIGHT_HIP_CX = 11;
const RIGHT_HIP_CY = 21;
const TUCK_TARGET_CY = 10.5;

const clamp = (x: number, min: number, max: number) => (x < min ? min : x > max ? max : x);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (from: number, to: number, x: number) => from + (to - from) * x;
const span = (t: number, start: number, duration: number) => clamp01((t - start) / duration);
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const u = clamp01((x - edge0) / (edge1 - edge0));
  return u * u * (3 - 2 * u);
};
const outCubic = (x: number) => 1 - (1 - x) ** 3;
const inOutCubic = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);

/** Closed-form underdamped spring response on `u` in 0..1: overshoots ~7% then lands at 1. */
function springEase(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const tau = u * SPRING_TAU_SCALE;
  const raw =
    1 -
    Math.exp(-SPRING_DECAY * tau) *
      (Math.cos(SPRING_WD * tau) + (SPRING_DECAY / SPRING_WD) * Math.sin(SPRING_WD * tau));
  const residualFade = 1 - smoothstep(0.82, 1, u);
  return 1 + (raw - 1) * residualFade;
}

function seededRandom(seed: number) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleIndices(length: number, random: () => number): Int32Array {
  const order = new Int32Array(length);
  for (let i = 0; i < length; i += 1) order[i] = i;
  for (let i = length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  return order;
}

export interface StartupIntroScene {
  readonly width: number;
  readonly height: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly homeRect: Rect;
  readonly sphereRadius: number;
  readonly sphereStartRadius: number;
  readonly glyphHeight: number;
  readonly lettersWidth: number;
  readonly robotLockupCellPx: number;
  readonly robotDanceHeight: number;
  readonly robotDanceCellPx: number;
  readonly robotLeapHeight: number;
  readonly robotLeapCellPx: number;
  readonly leapStandCenterY: number;
  readonly lockupLettersLeft: number;
  readonly lockupLettersRight: number;
  readonly lettersTop: number;
  readonly launchCenterX: number;
  readonly landCenterX: number;
  readonly leapArcHeight: number;
  readonly taglineY: number;
  readonly letterDotSize: number;
  readonly robotDanceDotSize: number;
  readonly robotLeapDotSize: number;
  readonly robotLockupDotSize: number;
  readonly homeLetterDotSize: number;
  readonly homeRobotDotSize: number;
  readonly swirlReach: number;
  readonly swirlLift: number;
  readonly homeArcX: number;
  readonly homeArcY: number;
  /** Fibonacci sphere unit directions, shuffled across groups. */
  readonly bx: Float32Array;
  readonly by: Float32Array;
  readonly bz: Float32Array;
  /** Per-dot cubic bezier control noise. */
  readonly jx: Float32Array;
  readonly jy: Float32Array;
  readonly sw: Float32Array;
  /** Targets for the centred "OOP AI" during WRITE. */
  readonly writeX: Float32Array;
  readonly writeY: Float32Array;
  readonly writeDelay: Float32Array;
  /** Drifting dust positions during VANISH and letter re-entry during LEAP. */
  readonly dustX: Float32Array;
  readonly dustY: Float32Array;
  readonly dustBlur: Float32Array;
  readonly vanishDelay: Float32Array;
  readonly reformDelay: Float32Array;
  readonly gatherDelay: Float32Array;
  /** Final centred lockup ("OOP AI" + head on the right) positions. */
  readonly lockupX: Float32Array;
  readonly lockupY: Float32Array;
  /** Final destination inside `homeRect`. */
  readonly homeX: Float32Array;
  readonly homeY: Float32Array;
  /** Robot template arrays (length `ROBOT_DOT_COUNT`, head first then body, in cell units). */
  readonly robotCellX: Float32Array;
  readonly robotCellY: Float32Array;
  readonly robotRow: Uint8Array;
  readonly robotPart: Uint8Array;
}

/** Builds all layout and per-dot data once per window size; pure and deterministic. */
export function createStartupIntroScene(input: StartupIntroSceneInput): StartupIntroScene {
  const width = Math.max(1, input.width);
  const height = Math.max(1, input.height);
  const centerX = width / 2;
  const centerY = clamp(input.centerY, 0, height);
  const homeRect =
    input.homeRect.width > 0 && input.homeRect.height > 0 ? input.homeRect : FALLBACK_HOME_RECT;

  const random = seededRandom(0x00900a1);

  // Measure "AI" at a reference height so the lockup width scales proportionally.
  const refHeight = 100;
  const refFont = `700 ${refHeight}px ${input.sans}`;
  const measuredAi = input.measureText("AI", refFont);
  const aiAspect = clamp(measuredAi > 0 ? measuredAi / refHeight : 1.05, 0.5, 2.5);

  const lettersAspect = WORDMARK_ASPECT + AI_GAP_RATIO + aiAspect;
  const fullAspect = lettersAspect + ROBOT_GAP_RATIO + ROBOT_SIZE_RATIO;

  const desiredGlyph = (width * LOCKUP_WIDTH_FRACTION) / fullAspect;
  const maxByHeight = Math.max(24, height * 0.25);
  const maxByWidth = (width * 0.78) / fullAspect;
  const minGlyph = Math.min(MIN_GLYPH_HEIGHT, maxByHeight, maxByWidth);
  const glyphHeight = clamp(desiredGlyph, minGlyph, Math.min(MAX_GLYPH_HEIGHT, maxByHeight));

  const wordmarkWidth = glyphHeight * WORDMARK_ASPECT;
  const aiGap = glyphHeight * AI_GAP_RATIO;
  const aiWidth = glyphHeight * aiAspect;
  const lettersWidth = wordmarkWidth + aiGap + aiWidth;
  const robotGap = glyphHeight * ROBOT_GAP_RATIO;
  const robotLockupSize = glyphHeight * ROBOT_SIZE_RATIO;
  const robotLockupCellPx = robotLockupSize / OOP_MASCOT_GRID;
  const fullLockupWidth = lettersWidth + robotGap + robotLockupSize;
  const fullLockupHeight = robotLockupSize;

  const robotDanceHeight = clamp(
    Math.min(width * 0.44, height * 0.34, centerY * 1.2, (height - centerY) * 1.4),
    Math.min(96, width * 0.44, height * 0.44),
    240,
  );
  const robotDanceCellPx = robotDanceHeight / ROBOT_FULL_ROWS;

  const sphereRadius = clamp(
    Math.min(104, width * 0.22, height * 0.22, centerY * 0.45),
    Math.min(36, width * 0.25, height * 0.25),
    104,
  );
  const maxStartByWindow = 0.44 * Math.min(width, height);
  // Keep projected sphere dots (incl. surface noise, breath and perspective) strictly inside all edges.
  const maxStartByEdges = Math.min(centerX, centerY, height - centerY) * 0.82;
  const sphereStartRadius = Math.max(
    sphereRadius,
    Math.min(sphereRadius * SPHERE_START_MULTIPLIER, maxStartByWindow, maxStartByEdges),
  );

  const lockupLeft = centerX - fullLockupWidth / 2;
  const lockupTop = centerY - fullLockupHeight / 2;
  const lettersOffsetY = (fullLockupHeight - glyphHeight) / 2;
  const lockupLettersLeft = lockupLeft;
  const lockupLettersRight = lockupLeft + lettersWidth;
  const lettersTop = centerY - glyphHeight / 2;

  const writeLettersLeft = centerX - lettersWidth / 2;
  const writeLettersTop = centerY - glyphHeight / 2;

  // Size the full body for the leap so at apex it stays inside the window (including card mode)
  // while every dot, feet included, clears `lettersTop`.
  const maxLeapHeightByHeadroom = Math.max(24, lettersTop * 0.65);
  const robotLeapHeight = Math.min(robotLockupSize * 1.25, maxLeapHeightByHeadroom);
  const robotLeapCellPx = robotLeapHeight / ROBOT_FULL_ROWS;
  const lockupBottomY = centerY + robotLockupSize * 0.5;
  const leapStandCenterY = lockupBottomY - FULL_CENTER_CY * robotLeapCellPx;

  const robotLeapHalfWidth = ROBOT_CENTER_CX * robotLeapCellPx;
  const launchCenterX = Math.max(
    robotLeapHalfWidth * 1.3,
    lockupLettersLeft - robotGap - robotLockupSize * 0.5,
  );
  const landCenterX = lockupLettersRight + robotGap + robotLockupSize * 0.5;
  const desiredArc = Math.max(glyphHeight * 2.1, robotLeapHeight * 1.35);
  const maxArcByTop = Math.max(
    lockupBottomY - lettersTop + robotLeapHeight * 0.12,
    lockupBottomY - robotLeapHeight * 1.07 - 6,
  );
  const leapArcHeight = Math.min(desiredArc, maxArcByTop);

  const taglineY = centerY + fullLockupHeight / 2 + Math.max(16, glyphHeight * 0.28);

  const font = `700 ${Math.round(glyphHeight)}px ${input.sans}`;
  const sampled = input.rasterizeLetters({
    glyphHeight,
    wordmarkWidth,
    aiGap,
    aiWidth,
    totalWidth: lettersWidth,
    font,
    maxDots: LETTERS_DOT_COUNT,
  });

  const letterPoints: ReadonlyArray<Point2D> =
    sampled.length > 0
      ? sampled
      : Array.from({ length: 64 }, (_, index) => ({
          x: ((index + 0.5) / 64) * lettersWidth,
          y: glyphHeight * 0.5,
        }));

  // Map the full lockup box [0..fullLockupWidth] x [0..fullLockupHeight] cleanly inside homeRect.
  const homeScale = Math.min(homeRect.width / fullLockupWidth, homeRect.height / fullLockupHeight);
  const homeOffsetX = homeRect.x + (homeRect.width - fullLockupWidth * homeScale) / 2;
  const homeOffsetY = homeRect.y + (homeRect.height - fullLockupHeight * homeScale) / 2;
  const homeCenterX = homeRect.x + homeRect.width / 2;
  const homeCenterY = homeRect.y + homeRect.height / 2;

  const bx = new Float32Array(DOT_COUNT);
  const by = new Float32Array(DOT_COUNT);
  const bz = new Float32Array(DOT_COUNT);
  const jx = new Float32Array(DOT_COUNT);
  const jy = new Float32Array(DOT_COUNT);
  const sw = new Float32Array(DOT_COUNT);
  const writeX = new Float32Array(DOT_COUNT);
  const writeY = new Float32Array(DOT_COUNT);
  const writeDelay = new Float32Array(DOT_COUNT);
  const dustX = new Float32Array(DOT_COUNT);
  const dustY = new Float32Array(DOT_COUNT);
  const dustBlur = new Float32Array(DOT_COUNT);
  const vanishDelay = new Float32Array(DOT_COUNT);
  const reformDelay = new Float32Array(DOT_COUNT);
  const gatherDelay = new Float32Array(DOT_COUNT);
  const lockupX = new Float32Array(DOT_COUNT);
  const lockupY = new Float32Array(DOT_COUNT);
  const homeX = new Float32Array(DOT_COUNT);
  const homeY = new Float32Array(DOT_COUNT);
  const robotCellX = new Float32Array(ROBOT_DOT_COUNT);
  const robotCellY = new Float32Array(ROBOT_DOT_COUNT);
  const robotRow = new Uint8Array(ROBOT_DOT_COUNT);
  const robotPart = new Uint8Array(ROBOT_DOT_COUNT);

  const sphereOrder = shuffleIndices(DOT_COUNT, random);
  const sampleOrder = shuffleIndices(letterPoints.length, random);
  const jitterScale = clamp(glyphHeight / 100, 0.45, 1.15);

  let writeMinX = Infinity;
  let writeMaxX = -Infinity;

  for (let i = 0; i < DOT_COUNT; i += 1) {
    const fibIndex = sphereOrder[i]!;
    const y = 1 - (fibIndex / (DOT_COUNT - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = GOLDEN_ANGLE * fibIndex;
    bx[i] = Math.cos(theta) * r;
    by[i] = y;
    bz[i] = Math.sin(theta) * r;

    jx[i] = (random() - 0.5) * 70 * jitterScale;
    jy[i] = (40 + random() * 60) * jitterScale;
    sw[i] = 0.7 + random() * 0.6;

    const pt = letterPoints[sampleOrder[i % letterPoints.length]!]!;
    const localX = clamp(pt.x, 0, lettersWidth);
    const localY = clamp(pt.y, 0, glyphHeight);

    const wx = writeLettersLeft + localX;
    const wy = writeLettersTop + localY;
    writeX[i] = wx;
    writeY[i] = wy;
    if (wx < writeMinX) writeMinX = wx;
    if (wx > writeMaxX) writeMaxX = wx;

    const dustAngle = random() * Math.PI * 2;
    const dustDist = sphereRadius * (0.65 + random() * 1.15);
    dustX[i] = centerX + Math.cos(dustAngle) * dustDist * 1.35;
    dustY[i] = centerY + Math.sin(dustAngle) * dustDist * 0.85;
    dustBlur[i] = 0.35 + random() * 0.65;
    vanishDelay[i] = random() * 0.12;
    gatherDelay[i] = random() * 0.04;

    if (i < LETTERS_DOT_COUNT) {
      const lx = localX;
      const ly = lettersOffsetY + localY;
      lockupX[i] = lockupLeft + lx;
      lockupY[i] = lockupTop + ly;
      homeX[i] = homeOffsetX + lx * homeScale;
      homeY[i] = homeOffsetY + ly * homeScale;
    } else {
      const rIdx = i - LETTERS_DOT_COUNT;
      const dot = ROBOT_DOTS[rIdx]!;
      robotCellX[rIdx] = dot.cx;
      robotCellY[rIdx] = dot.cy;
      robotRow[rIdx] = dot.row;
      robotPart[rIdx] = dot.part;

      // Head dots take their lockup/home positions; hidden body dots park at the head centre.
      const isHead = rIdx < ROBOT_HEAD_DOT_COUNT;
      const nx = isHead ? dot.cx / OOP_MASCOT_GRID : 0.5;
      const ny = isHead ? dot.cy / OOP_MASCOT_GRID : 0.5;
      const lx = lettersWidth + robotGap + nx * robotLockupSize;
      const ly = ny * robotLockupSize;
      lockupX[i] = lockupLeft + lx;
      lockupY[i] = lockupTop + ly;
      homeX[i] = homeOffsetX + lx * homeScale;
      homeY[i] = homeOffsetY + ly * homeScale;
    }
  }

  const writeSpan = Math.max(1, writeMaxX - writeMinX);
  for (let i = 0; i < DOT_COUNT; i += 1) {
    const normX = (writeX[i]! - writeMinX) / writeSpan;
    writeDelay[i] = 0.04 + normX * 0.36 + random() * 0.06;
    // Right to left: the robot crosses the lockup leftwards and the letters fill in behind it.
    reformDelay[i] = 0.02 + (1 - normX) * 0.18 + random() * 0.04;
  }

  return {
    width,
    height,
    centerX,
    centerY,
    homeRect,
    sphereRadius,
    sphereStartRadius,
    glyphHeight,
    lettersWidth,
    robotLockupCellPx,
    robotDanceHeight,
    robotDanceCellPx,
    robotLeapHeight,
    robotLeapCellPx,
    leapStandCenterY,
    lockupLettersLeft,
    lockupLettersRight,
    lettersTop,
    launchCenterX,
    landCenterX,
    leapArcHeight,
    taglineY,
    letterDotSize: clamp(glyphHeight * 0.032, 1.8, 4.2),
    robotDanceDotSize: clamp(robotDanceCellPx * 0.5 * 0.95, 2.1, 4.8),
    robotLeapDotSize: clamp(robotLeapCellPx * 0.5 * 0.95, 1.4, 4.4),
    robotLockupDotSize: clamp((robotLockupSize / 32) * 0.95, 1.6, 4.4),
    homeLetterDotSize: clamp(homeScale * glyphHeight * 0.11, 1.2, 2.0),
    homeRobotDotSize: clamp(((homeScale * robotLockupSize) / 32) * 1.15, 1.1, 1.8),
    swirlReach: Math.min(80, sphereRadius * 0.85),
    swirlLift: Math.min(20, sphereRadius * 0.22),
    homeArcX: (homeCenterX - centerX) * -0.1,
    homeArcY: -Math.min(44, Math.abs(centerY - homeCenterY) * 0.14),
    bx,
    by,
    bz,
    jx,
    jy,
    sw,
    writeX,
    writeY,
    writeDelay,
    dustX,
    dustY,
    dustBlur,
    vanishDelay,
    reformDelay,
    gatherDelay,
    lockupX,
    lockupY,
    homeX,
    homeY,
    robotCellX,
    robotCellY,
    robotRow,
    robotPart,
  };
}

/**
 * Evaluates a single frame at elapsed time `t` seconds into a preallocated `Float32Array`
 * of length `DOT_COUNT * DOT_STRIDE`. Pure, zero per-dot allocation, safe for any `t`.
 */
export function evaluateStartupIntroFrame(
  scene: StartupIntroScene,
  rawTime: number,
  out: Float32Array,
): StartupIntroFrameScalars {
  const t = clamp(rawTime, 0, STARTUP_INTRO_SETTLED_AT);
  const {
    centerX,
    centerY,
    sphereRadius,
    sphereStartRadius,
    glyphHeight,
    lettersWidth,
    lockupLettersRight,
    robotLockupCellPx,
    robotDanceHeight,
    robotDanceCellPx,
    robotLeapHeight,
    robotLeapCellPx,
    leapStandCenterY,
    launchCenterX,
    landCenterX,
    leapArcHeight,
    letterDotSize,
    robotDanceDotSize,
    robotLeapDotSize,
    robotLockupDotSize,
    homeLetterDotSize,
    homeRobotDotSize,
    swirlReach,
    swirlLift,
    homeArcX,
    homeArcY,
    bx,
    by,
    bz,
    jx,
    jy,
    sw,
    writeX,
    writeY,
    writeDelay,
    dustX,
    dustY,
    dustBlur,
    vanishDelay,
    reformDelay,
    gatherDelay,
    lockupX,
    lockupY,
    homeX,
    homeY,
    robotCellX,
    robotCellY,
    robotRow,
    robotPart,
  } = scene;

  // Scalars returned to the component for backdrop, colour mix and tagline visibility.
  const backdropOpacity = t < HOME_START ? 1 : 1 - inOutCubic(span(t, HOME_START + 0.05, 0.55));
  // The colour flips quickly as the backdrop passes mid-grey, so a dark brand colour never sits
  // on an equally dark backdrop.
  const colorMix = t < HOME_START ? 0 : inOutCubic(span(t, HOME_START + 0.24, 0.2));
  const taglineOpacity =
    t < HOME_START
      ? outCubic(span(t, TUCK_START, HOME_START - TUCK_START))
      : 1 - outCubic(span(t, HOME_START, 0.18));

  // Precompute phase-wide transforms outside the dot loop.
  if (t < VANISH_START) {
    // THINK (0..1.2) and WRITE (1.2..2.2): large Fibonacci sphere shrinks while breathing -> swirls into "OOP AI".
    const fadeIn = outCubic(span(t, THINK_START, 0.35));
    const yaw = SPHERE_YAW_START + SPHERE_YAW_RATE * t;
    const cyw = Math.cos(yaw);
    const syw = Math.sin(yaw);
    const cxp = Math.cos(SPHERE_PITCH);
    const sxp = Math.sin(SPHERE_PITCH);
    const shrinkU = inOutCubic(span(t, THINK_START, SPHERE_SHRINK_DURATION));
    const breath = SPHERE_BREATH_AMP * Math.sin(t * SPHERE_BREATH_OMEGA);
    const curRadius = lerp(sphereStartRadius, sphereRadius, shrinkU) * (1 + breath);
    const radiusRatio = curRadius / sphereRadius;
    const perspF = PERSPECTIVE_F * radiusRatio;
    const zf = curRadius * 0.75;
    const invBlurRange = 1 / (curRadius * 1.5);
    const sizeScale = 1 + (radiusRatio - 1) * 0.22;

    for (let i = 0; i < DOT_COUNT; i += 1) {
      const px = bx[i]!;
      const py = by[i]!;
      const pz = bz[i]!;
      const nz =
        0.1 *
          Math.sin(px * 2.3 + t * 0.9) *
          Math.sin(py * 2.9 - t * 0.7 + 1.3) *
          Math.sin(pz * 2.1 + t * 1.1 + 0.5) +
        0.018 * Math.sin(px * 5.1 - t * 1.3 + py * 3.7);
      const r = curRadius * (1 + nz);
      const rx = (px * cyw - pz * syw) * r;
      const rz0 = (px * syw + pz * cyw) * r;
      const ry0 = py * r;
      const ry = ry0 * cxp - rz0 * sxp;
      const rz = ry0 * sxp + rz0 * cxp;
      const sc = perspF / (perspF - rz);
      const sx = centerX + rx * sc;
      const sy = centerY + ry * sc;

      const front = clamp01((rz / curRadius + 1) * 0.5);
      const blur = clamp01(Math.abs(rz - zf) * invBlurRange);
      let size = ((1.35 + 0.7 * front) * sc + blur * blur * 6.5) * sizeScale;
      let alpha = (((0.16 + 0.84 * front) * (1 - blur * 0.45)) / (1 + blur * blur * 2.2)) * fadeIn;
      let soft = blur;
      let x = sx;
      let y = sy;

      if (t >= WRITE_START) {
        const uRaw = span(t, WRITE_START + writeDelay[i]!, 0.5);
        const s = springEase(uRaw);
        if (s > 0) {
          const u = clamp01(s);
          const tx = writeX[i]!;
          const ty = writeY[i]!;
          const ox = sx - centerX;
          const oy = sy - centerY;
          const ol = Math.hypot(ox, oy) + 0.001;
          const p1x = sx - (oy / ol) * swirlReach * sw[i]!;
          const p1y = sy + (ox / ol) * swirlReach * sw[i]! - swirlLift;
          const p2x = tx + jx[i]!;
          const p2y = ty - jy[i]!;
          const e = 1 - u;
          const b0 = e * e * e;
          const b1 = 3 * e * e * u;
          const b2 = 3 * e * u * u;
          const b3 = u * u * u;
          x = b0 * sx + b1 * p1x + b2 * p2x + b3 * tx;
          y = b0 * sy + b1 * p1y + b2 * p2y + b3 * ty;
          if (s > 1) {
            const overshoot = (s - 1) * 1.2;
            x += (tx - p2x) * overshoot;
            y += (ty - p2y) * overshoot;
          }
          const fly = Math.sin(u * Math.PI);
          size = lerp(size, letterDotSize, u) + fly * 0.6;
          alpha = lerp(alpha, 1, u);
          soft = lerp(soft, 0, Math.min(1, u * 1.6));
        }
      }

      const q = i * DOT_STRIDE;
      out[q] = x;
      out[q + 1] = y;
      out[q + 2] = size;
      out[q + 3] = clamp01(alpha);
      out[q + 4] = clamp01(soft * 0.85);
    }

    return { backdropOpacity, colorMix, taglineOpacity };
  }

  if (t < DANCE_START) {
    // VANISH and GATHER (2.2..2.8): letters dissolve into drifting dust; robot dots gather into full-body Oopi.
    for (let i = 0; i < LETTERS_DOT_COUNT; i += 1) {
      const u = span(t, VANISH_START + vanishDelay[i]!, 0.46);
      const drift = outCubic(u);
      const x = lerp(writeX[i]!, dustX[i]!, drift);
      const y = lerp(writeY[i]!, dustY[i]!, drift);
      const blur = dustBlur[i]! * drift;
      const size = letterDotSize + blur * blur * 4.5;
      const alpha = (1 - u) ** 1.5;

      const q = i * DOT_STRIDE;
      out[q] = x;
      out[q + 1] = y;
      out[q + 2] = size;
      out[q + 3] = clamp01(alpha);
      out[q + 4] = clamp01(blur * 0.85);
    }

    for (let rIdx = 0; rIdx < ROBOT_DOT_COUNT; rIdx += 1) {
      const i = LETTERS_DOT_COUNT + rIdx;
      const uDrift = outCubic(span(t, VANISH_START + vanishDelay[i]! * 0.4, 0.32));
      const sx = lerp(writeX[i]!, dustX[i]!, uDrift);
      const sy = lerp(writeY[i]!, dustY[i]!, uDrift);
      const driftBlur = dustBlur[i]! * uDrift;
      let size = letterDotSize + driftBlur * driftBlur * 3.8;
      let alpha = 1 - 0.35 * uDrift;
      let soft = driftBlur;
      let x = sx;
      let y = sy;

      const uGather = span(t, ROBOT_GATHER_START + gatherDelay[i]!, 0.34);
      const s = springEase(uGather);
      if (s > 0) {
        const u = clamp01(s);
        const tx = centerX + (robotCellX[rIdx]! - ROBOT_CENTER_CX) * robotDanceCellPx;
        const ty = centerY + (robotCellY[rIdx]! - FULL_CENTER_CY) * robotDanceCellPx;
        const ox = sx - centerX;
        const oy = sy - centerY;
        const ol = Math.hypot(ox, oy) + 0.001;
        const p1x = sx - (oy / ol) * swirlReach * 0.65 * sw[i]!;
        const p1y = sy + (ox / ol) * swirlReach * 0.65 * sw[i]!;
        const p2x = tx + jx[i]! * 0.65;
        const p2y = ty - jy[i]! * 0.65;
        const e = 1 - u;
        const b0 = e * e * e;
        const b1 = 3 * e * e * u;
        const b2 = 3 * e * u * u;
        const b3 = u * u * u;
        x = b0 * sx + b1 * p1x + b2 * p2x + b3 * tx;
        y = b0 * sy + b1 * p1y + b2 * p2y + b3 * ty;
        if (s > 1) {
          const overshoot = (s - 1) * 1.1;
          x += (tx - p2x) * overshoot;
          y += (ty - p2y) * overshoot;
        }
        size = lerp(size, robotDanceDotSize, u) + Math.sin(u * Math.PI) * 0.45;
        alpha = lerp(alpha, 1, u);
        soft = lerp(soft, 0, Math.min(1, u * 1.6));
      }

      const q = i * DOT_STRIDE;
      out[q] = x;
      out[q + 1] = y;
      out[q + 2] = size;
      out[q + 3] = clamp01(alpha);
      out[q + 4] = clamp01(soft * 0.85);
    }

    return { backdropOpacity, colorMix, taglineOpacity };
  }

  if (t < TUCK_START) {
    // DANCE (2.8..3.8) and LEAP (3.8..4.7).
    // 1. Letters group: hidden during DANCE, flies back right-to-left into "OOP AI" during LEAP with a landing ripple.
    if (t < LEAP_START) {
      for (let i = 0; i < LETTERS_DOT_COUNT; i += 1) {
        const q = i * DOT_STRIDE;
        out[q] = dustX[i]!;
        out[q + 1] = dustY[i]!;
        out[q + 2] = letterDotSize;
        out[q + 3] = 0;
        out[q + 4] = 0;
      }
    } else {
      const landRippleProgress =
        t >= LEAP_ARC_END ? span(t, LEAP_ARC_END, TUCK_START - LEAP_ARC_END) : 0;
      for (let i = 0; i < LETTERS_DOT_COUNT; i += 1) {
        const tx = lockupX[i]!;
        const ty = lockupY[i]!;
        const uRaw = span(t, LEAP_START + reformDelay[i]!, 0.22);
        const s = springEase(uRaw);
        let x = dustX[i]!;
        let y = dustY[i]!;
        let size = letterDotSize + dustBlur[i]! * 3;
        let alpha = 0;
        let soft = dustBlur[i]!;

        if (s > 0) {
          const u = clamp01(s);
          const sx = dustX[i]!;
          const sy = dustY[i]!;
          const ox = sx - centerX;
          const oy = sy - centerY;
          const ol = Math.hypot(ox, oy) + 0.001;
          const p1x = sx - (oy / ol) * swirlReach * 0.7 * sw[i]!;
          const p1y = sy + (ox / ol) * swirlReach * 0.7 * sw[i]!;
          const p2x = tx + jx[i]! * 0.6;
          const p2y = ty - jy[i]! * 0.6;
          const e = 1 - u;
          const b0 = e * e * e;
          const b1 = 3 * e * e * u;
          const b2 = 3 * e * u * u;
          const b3 = u * u * u;
          x = b0 * sx + b1 * p1x + b2 * p2x + b3 * tx;
          y = b0 * sy + b1 * p1y + b2 * p2y + b3 * ty;
          if (s > 1) {
            const overshoot = (s - 1) * 1.1;
            x += (tx - p2x) * overshoot;
            y += (ty - p2y) * overshoot;
          }
          size = lerp(size, letterDotSize, u) + Math.sin(u * Math.PI) * 0.5;
          alpha = clamp01(u * 1.35);
          soft = lerp(soft, 0, Math.min(1, u * 1.7));
        }

        if (landRippleProgress > 0 && landRippleProgress < 1) {
          const distFromRight = clamp01((lockupLettersRight - tx) / Math.max(1, lettersWidth));
          const wave = (landRippleProgress - distFromRight * 0.45) / 0.55;
          if (wave > 0 && wave < 1) {
            y += Math.sin(Math.PI * wave) * glyphHeight * 0.06 * (1 - distFromRight * 0.45);
          }
        }

        const q = i * DOT_STRIDE;
        out[q] = x;
        out[q + 1] = y;
        out[q + 2] = size;
        out[q + 3] = clamp01(alpha);
        out[q + 4] = clamp01(soft * 0.85);
      }
    }

    // 2. Full-body robot group: per-part rigid transforms around shoulder/hip/neck pivots + affine body pose.
    let robotCx = centerX;
    let robotCy = centerY;
    let cellPx = robotDanceCellPx;
    let robotDotSize = robotDanceDotSize;
    let scaleX = 1;
    let scaleY = 1;
    let tilt = 0;
    let pivotCy = FEET_BOTTOM_CY;
    let antennaWag = 0;
    let eyeBlink = 0;
    let headBobY = 0;
    let headNodAngle = 0;
    let leftArmRaise = 0;
    let rightArmRaise = 0;
    let leftLegLift = 0;
    let rightLegLift = 0;
    let leftLegAngle = 0;
    let rightLegAngle = 0;
    let bodyDropY = 0;

    if (t < LEAP_START) {
      // DANCE (2.8..3.8): sway, bounce, alternating arm swings (~105°), alternating leg lifts, head bob, antenna wag, blink.
      const d = span(t, DANCE_START, LEAP_START - DANCE_START);
      const env = smoothstep(0, 0.12, d) * (1 - smoothstep(0.88, 1, d));
      const sway = Math.sin(d * Math.PI * 2);
      const hop = Math.abs(Math.sin(d * Math.PI * 2)) ** 0.85;
      const stretch = (hop * 2 - 1) * 0.09 * env;
      // C1-smooth alternating envelopes so only one arm swings out and one leg lifts at a time.
      const leftWave = Math.max(0, sway) ** 1.35;
      const rightWave = Math.max(0, -sway) ** 1.35;

      robotCx = centerX + sway * robotDanceHeight * 0.16 * env;
      robotCy = centerY - hop * robotDanceHeight * 0.11 * env;
      tilt = sway * 0.12 * env;
      scaleX = 1 - stretch;
      scaleY = 1 + stretch;
      antennaWag = Math.sin(d * Math.PI * 6) * 2.1 * env;
      eyeBlink = Math.sin(Math.PI * span(d, 0.49, 0.14));
      headBobY = -Math.abs(Math.sin(d * Math.PI * 4)) * 0.55 * env;
      headNodAngle = sway * 0.08 * env;
      leftArmRaise = leftWave * 1.85 * env;
      rightArmRaise = rightWave * 1.85 * env;
      rightLegLift = leftWave * 1.6 * env;
      rightLegAngle = -leftWave * 0.22 * env;
      leftLegLift = rightWave * 1.6 * env;
      leftLegAngle = rightWave * 0.22 * env;
    } else if (t < LEAP_HOP_END) {
      // Shrink to leap size and hop to the launch spot left of the lockup.
      const u = inOutCubic(span(t, LEAP_START, LEAP_HOP_END - LEAP_START));
      const hopSin = Math.sin(Math.PI * u);
      cellPx = lerp(robotDanceCellPx, robotLeapCellPx, u);
      robotDotSize = lerp(robotDanceDotSize, robotLeapDotSize, u);
      robotCx = lerp(centerX, launchCenterX, u);
      robotCy = lerp(centerY, leapStandCenterY, u) - hopSin * robotLeapHeight * 0.28;
      tilt = -0.1 * hopSin;
      leftArmRaise = 0.55 * hopSin;
      rightArmRaise = 0.55 * hopSin;
      leftLegLift = 0.9 * hopSin;
      rightLegLift = 0.9 * hopSin;
    } else if (t < LEAP_CROUCH_END) {
      // Anticipation crouch on the left: legs compress, arms pull back.
      const u = span(t, LEAP_HOP_END, LEAP_CROUCH_END - LEAP_HOP_END);
      const crouch = Math.sin(Math.PI * u);
      cellPx = robotLeapCellPx;
      robotDotSize = robotLeapDotSize;
      robotCx = launchCenterX;
      robotCy = leapStandCenterY;
      scaleX = 1 + 0.16 * crouch;
      scaleY = 1 - 0.22 * crouch;
      tilt = 0.08 * crouch;
      leftArmRaise = 0.75 * crouch;
      rightArmRaise = -0.25 * crouch;
      bodyDropY = 1.2 * crouch;
    } else if (t < LEAP_ARC_END) {
      // High parabolic arc over "OOP AI" with arms raised up and legs tucked.
      const u = span(t, LEAP_CROUCH_END, LEAP_ARC_END - LEAP_CROUCH_END);
      const arc = 4 * u * (1 - u);
      const midAir = Math.sin(Math.PI * u);
      cellPx = robotLeapCellPx;
      robotDotSize = robotLeapDotSize;
      // Eased sideways travel (smootherstep): rises and drops steeply so every dot clears both ends.
      robotCx = lerp(launchCenterX, landCenterX, u * u * u * (u * (u * 6 - 15) + 10));
      robotCy = leapStandCenterY - arc * leapArcHeight;
      pivotCy = FULL_CENTER_CY;
      scaleX = 1 - 0.05 * midAir;
      scaleY = 1 + 0.06 * midAir;
      tilt = (0.5 - u) * 0.26 * midAir;
      antennaWag = -1.4 * midAir;
      leftArmRaise = 2.15 * midAir;
      rightArmRaise = 2.15 * midAir;
      leftLegLift = 1.6 * midAir;
      rightLegLift = 1.6 * midAir;
      leftLegAngle = 0.35 * midAir;
      rightLegAngle = -0.35 * midAir;
    } else {
      // Landing squash on the right of "AI", feet standing on lockup bottom.
      const u = span(t, LEAP_ARC_END, TUCK_START - LEAP_ARC_END);
      const sq = Math.sin(Math.PI * u);
      cellPx = robotLeapCellPx;
      robotDotSize = robotLeapDotSize;
      robotCx = landCenterX;
      robotCy = leapStandCenterY;
      scaleX = 1 + 0.18 * sq;
      scaleY = 1 - 0.2 * sq;
      leftArmRaise = 0.35 * sq;
      rightArmRaise = 0.35 * sq;
      bodyDropY = 0.9 * sq;
    }

    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);
    const cosHN = Math.cos(headNodAngle);
    const sinHN = Math.sin(headNodAngle);
    const cosLA = Math.cos(leftArmRaise);
    const sinLA = Math.sin(leftArmRaise);
    const cosRA = Math.cos(-rightArmRaise);
    const sinRA = Math.sin(-rightArmRaise);
    const cosLL = Math.cos(leftLegAngle);
    const sinLL = Math.sin(leftLegAngle);
    const cosRL = Math.cos(rightLegAngle);
    const sinRL = Math.sin(rightLegAngle);
    const legCompressScale = bodyDropY > 0 ? Math.max(0.55, 1 - bodyDropY / 4) : 1;

    for (let rIdx = 0; rIdx < ROBOT_DOT_COUNT; rIdx += 1) {
      let cx = robotCellX[rIdx]!;
      let cy = robotCellY[rIdx]!;
      const part = robotPart[rIdx]!;

      if (part <= PART_EYE) {
        if (part === PART_EYE && eyeBlink > 0) {
          cy = EYE_CENTER_CY + (cy - EYE_CENTER_CY) * (1 - 0.88 * eyeBlink);
        } else if (part === PART_ANTENNA && antennaWag !== 0) {
          const lever = Math.max(0, (4 - robotRow[rIdx]!) / 4);
          cx += antennaWag * lever;
          cy += Math.abs(antennaWag) * lever * 0.15;
        }
        if (headNodAngle !== 0) {
          const hdx = cx - HEAD_PIVOT_CX;
          const hdy = cy - HEAD_PIVOT_CY;
          cx = HEAD_PIVOT_CX + hdx * cosHN - hdy * sinHN;
          cy = HEAD_PIVOT_CY + hdx * sinHN + hdy * cosHN;
        }
        cy += headBobY + bodyDropY;
      } else if (part === PART_TORSO) {
        cy += bodyDropY;
      } else if (part === PART_LEFT_ARM) {
        if (leftArmRaise !== 0) {
          const adx = cx - LEFT_SHOULDER_CX;
          const ady = cy - LEFT_SHOULDER_CY;
          cx = LEFT_SHOULDER_CX + adx * cosLA - ady * sinLA;
          cy = LEFT_SHOULDER_CY + adx * sinLA + ady * cosLA;
        }
        cy += bodyDropY;
      } else if (part === PART_RIGHT_ARM) {
        if (rightArmRaise !== 0) {
          const adx = cx - RIGHT_SHOULDER_CX;
          const ady = cy - RIGHT_SHOULDER_CY;
          cx = RIGHT_SHOULDER_CX + adx * cosRA - ady * sinRA;
          cy = RIGHT_SHOULDER_CY + adx * sinRA + ady * cosRA;
        }
        cy += bodyDropY;
      } else if (part === PART_LEFT_LEG) {
        if (leftLegAngle !== 0) {
          const ldx = cx - LEFT_HIP_CX;
          const ldy = cy - LEFT_HIP_CY;
          cx = LEFT_HIP_CX + ldx * cosLL - ldy * sinLL;
          cy = LEFT_HIP_CY + ldx * sinLL + ldy * cosLL;
        }
        if (legCompressScale !== 1) {
          cy = FEET_BOTTOM_CY + (cy - FEET_BOTTOM_CY) * legCompressScale;
        }
        cy -= leftLegLift;
      } else {
        if (rightLegAngle !== 0) {
          const ldx = cx - RIGHT_HIP_CX;
          const ldy = cy - RIGHT_HIP_CY;
          cx = RIGHT_HIP_CX + ldx * cosRL - ldy * sinRL;
          cy = RIGHT_HIP_CY + ldx * sinRL + ldy * cosRL;
        }
        if (legCompressScale !== 1) {
          cy = FEET_BOTTOM_CY + (cy - FEET_BOTTOM_CY) * legCompressScale;
        }
        cy -= rightLegLift;
      }

      const sxLocal = (cx - ROBOT_CENTER_CX) * scaleX;
      const syLocal = (cy - pivotCy) * scaleY;
      const rx = sxLocal * cosT - syLocal * sinT;
      const ry = sxLocal * sinT + syLocal * cosT + pivotCy - FULL_CENTER_CY;

      const q = (LETTERS_DOT_COUNT + rIdx) * DOT_STRIDE;
      out[q] = robotCx + rx * cellPx;
      out[q + 1] = robotCy + ry * cellPx;
      out[q + 2] = robotDotSize;
      out[q + 3] = 1;
      out[q + 4] = 0;
    }

    return { backdropOpacity, colorMix, taglineOpacity };
  }

  if (t < HOME_START) {
    // TUCK (4.7..5.0): letters hold at lockup; torso/arms/legs fold into the head and fade out
    // while the head settles to the exact lockup pose.
    for (let i = 0; i < LETTERS_DOT_COUNT; i += 1) {
      const q = i * DOT_STRIDE;
      out[q] = lockupX[i]!;
      out[q + 1] = lockupY[i]!;
      out[q + 2] = letterDotSize;
      out[q + 3] = 1;
      out[q + 4] = 0;
    }

    const uRaw = span(t, TUCK_START, HOME_START - TUCK_START);
    const uHead = inOutCubic(uRaw);
    const uTorso = uHead;
    const uArm = inOutCubic(clamp01(uRaw * 1.15));
    const uLeg = inOutCubic(clamp01(uRaw * 1.25));
    const bodyAlpha = 1 - inOutCubic(clamp01((uRaw - 0.1) / 0.85));

    const tuckHeadStartY = leapStandCenterY + (HEAD_CENTER_CY - FULL_CENTER_CY) * robotLeapCellPx;
    const headCenterY = lerp(tuckHeadStartY, centerY, uHead);
    const curCellPx = lerp(robotLeapCellPx, robotLockupCellPx, uHead);
    const curDotSize = lerp(robotLeapDotSize, robotLockupDotSize, uHead);
    const bodyDotSize = curDotSize * lerp(1, 0.55, uTorso);
    const bodySoft = uTorso * 0.35;
    const armTuckAngle = -0.3 * uArm;
    const cosLA = Math.cos(armTuckAngle);
    const sinLA = Math.sin(armTuckAngle);
    const cosRA = Math.cos(-armTuckAngle);
    const sinRA = Math.sin(-armTuckAngle);

    for (let rIdx = 0; rIdx < ROBOT_DOT_COUNT; rIdx += 1) {
      const q = (LETTERS_DOT_COUNT + rIdx) * DOT_STRIDE;
      let cx = robotCellX[rIdx]!;
      let cy = robotCellY[rIdx]!;

      if (rIdx < ROBOT_HEAD_DOT_COUNT) {
        out[q] = landCenterX + (cx - ROBOT_CENTER_CX) * curCellPx;
        out[q + 1] = headCenterY + (cy - HEAD_CENTER_CY) * curCellPx;
        out[q + 2] = curDotSize;
        out[q + 3] = 1;
        out[q + 4] = 0;
      } else {
        const part = robotPart[rIdx]!;
        let uPart = uTorso;
        if (part === PART_LEFT_ARM) {
          uPart = uArm;
          const adx = cx - LEFT_SHOULDER_CX;
          const ady = cy - LEFT_SHOULDER_CY;
          cx = LEFT_SHOULDER_CX + adx * cosLA - ady * sinLA;
          cy = LEFT_SHOULDER_CY + adx * sinLA + ady * cosLA;
        } else if (part === PART_RIGHT_ARM) {
          uPart = uArm;
          const adx = cx - RIGHT_SHOULDER_CX;
          const ady = cy - RIGHT_SHOULDER_CY;
          cx = RIGHT_SHOULDER_CX + adx * cosRA - ady * sinRA;
          cy = RIGHT_SHOULDER_CY + adx * sinRA + ady * cosRA;
        } else if (part === PART_LEFT_LEG || part === PART_RIGHT_LEG) {
          uPart = uLeg;
        }
        const foldedCx = lerp(cx, ROBOT_CENTER_CX + (cx - ROBOT_CENTER_CX) * 0.25, uPart);
        const foldedCy = lerp(cy, TUCK_TARGET_CY, uPart);
        out[q] = landCenterX + (foldedCx - ROBOT_CENTER_CX) * curCellPx;
        out[q + 1] = headCenterY + (foldedCy - HEAD_CENTER_CY) * curCellPx;
        out[q + 2] = bodyDotSize;
        out[q + 3] = clamp01(bodyAlpha);
        out[q + 4] = clamp01(bodySoft);
      }
    }

    return { backdropOpacity, colorMix, taglineOpacity };
  }

  // HOME (5.0..5.8): letters and head shrink and arc to homeRect while backdrop and dots fade out;
  // body dots remain hidden at alpha 0.
  const uFlight = inOutCubic(span(t, HOME_START, HOME_LAND_AT - HOME_START));
  const arc = Math.sin(Math.PI * uFlight);
  const arcDx = homeArcX * arc;
  const arcDy = homeArcY * arc;
  const dotAlpha = 1 - inOutCubic(span(t, HOME_LAND_AT, STARTUP_INTRO_SETTLED_AT - HOME_LAND_AT));
  const curLetterSize = lerp(letterDotSize, homeLetterDotSize, uFlight);
  const curRobotSize = lerp(robotLockupDotSize, homeRobotDotSize, uFlight);
  const headEndIndex = LETTERS_DOT_COUNT + ROBOT_HEAD_DOT_COUNT;

  for (let i = 0; i < DOT_COUNT; i += 1) {
    const q = i * DOT_STRIDE;
    out[q] = lerp(lockupX[i]!, homeX[i]!, uFlight) + arcDx;
    out[q + 1] = lerp(lockupY[i]!, homeY[i]!, uFlight) + arcDy;
    out[q + 2] = i < LETTERS_DOT_COUNT ? curLetterSize : curRobotSize;
    out[q + 3] = i < headEndIndex ? clamp01(dotAlpha) : 0;
    out[q + 4] = 0;
  }

  return { backdropOpacity, colorMix, taglineOpacity };
}
