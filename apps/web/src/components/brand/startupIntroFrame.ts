/*
 * The desktop startup motion as a pure function of elapsed time. One line curls into the OOP
 * letters, the letters shrink into a hub that agents orbit, a ring wipes the screen, and a
 * burst of particles settles back into the wordmark. Nothing here reads a clock or the DOM,
 * so any frame can be drawn on its own, and every beat lands on a half second.
 */

/** From here on every frame is the same finished lockup. */
export const STARTUP_INTRO_SETTLED_AT = 3.5;

// The same black as the wrapper behind the canvas, so the first frame does not shift.
const INK = "#000000";
const PAPER = "#f4f6fb";
// The dark theme's primary, as a hex so every canvas backend parses it.
const SIGNAL = "#346bf1";

const MORPH_AT = 0.5;
const HUB_AT = 1;
const PULL_AT = 1.82;
const WIPE_AT = 2;
const SETTLE_AT = 2.5;
const IMPACT_AT = 3;

type Point = readonly [number, number];

/** The drawing calls the motion needs, so a test can stand in for a real canvas. */
export type StartupIntroCanvas = Pick<
  CanvasRenderingContext2D,
  | "globalAlpha"
  | "fillStyle"
  | "strokeStyle"
  | "lineWidth"
  | "lineCap"
  | "lineJoin"
  | "font"
  | "textAlign"
  | "textBaseline"
  | "fillRect"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "arc"
  | "ellipse"
  | "stroke"
  | "fill"
  | "fillText"
>;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** How far `t` is through the window that starts at `start`, 0 before it and 1 after. */
const span = (t: number, start: number, duration: number) => clamp01((t - start) / duration);
const lerp = (from: number, to: number, x: number) => from + (to - from) * x;
const outCubic = (x: number) => 1 - (1 - x) ** 3;
const inCubic = (x: number) => x ** 3;
const inOutCubic = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const inOutQuint = (x: number) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2);
const outExpo = (x: number) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));
const outBack = (x: number) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;

/** `0.0.163` halfway reads `0.0.082`: each number counts up, padded so the width holds still. */
export function countUpVersion(version: string, progress: number): string {
  return version.replace(/\d+/g, (digits) =>
    String(Math.round(Number(digits) * clamp01(progress))).padStart(digits.length, "0"),
  );
}

/*
 * The wordmark is drawn, not typed: two rings and a P, in units of the ring radius with the
 * word centered on the origin. Each letter is a polyline that starts life as a flat stretch
 * of the opening line, so the same points carry the line, the morph and the finished letter.
 */
const LETTER_GAP = 0.82;
const P_ARM = 0.36;
const P_BOWL = 0.55;
const WORD_HALF = (4 + 2 * LETTER_GAP + P_ARM + P_BOWL) / 2;
const STROKE = 0.5;

interface Letter {
  readonly shape: ReadonlyArray<Point>;
  /** The x of each point while the letter is still part of the flat line. */
  readonly flat: ReadonlyArray<number>;
  readonly center: Point;
  readonly length: number;
  readonly delay: number;
}

function ring(centerX: number, from: number, to: number, delay: number): Letter {
  const steps = 48;
  // Starts and ends at the bottom, so the line's middle rises and its ends curl under.
  const shape = Array.from({ length: steps + 1 }, (_, index): Point => {
    const angle = Math.PI / 2 + (index / steps) * Math.PI * 2;
    return [centerX + Math.cos(angle), Math.sin(angle)];
  });
  return {
    shape,
    flat: shape.map((_, index) => lerp(from, to, index / steps)),
    center: [centerX, 0],
    length: Math.PI * 2,
    delay,
  };
}

function letterP(stemX: number, from: number, to: number, delay: number): Letter {
  const bowl = Math.PI * P_BOWL;
  const length = 2 + P_ARM + bowl + P_ARM;
  // Each run is sampled on its own so the corners stay sharp.
  const runs: ReadonlyArray<readonly [number, number, (d: number) => Point]> = [
    [2, 20, (d) => [stemX, 1 - d]],
    [P_ARM, 3, (d) => [stemX + d, -1]],
    [
      bowl,
      20,
      (d) => {
        const angle = -Math.PI / 2 + (d / bowl) * Math.PI;
        return [stemX + P_ARM + Math.cos(angle) * P_BOWL, -1 + P_BOWL + Math.sin(angle) * P_BOWL];
      },
    ],
    [P_ARM, 3, (d) => [stemX + P_ARM - d, -1 + 2 * P_BOWL]],
  ];
  const shape: Array<Point> = [[stemX, 1]];
  const flat = [from];
  let travelled = 0;
  for (const [runLength, steps, at] of runs) {
    for (let step = 1; step <= steps; step += 1) {
      const d = (step / steps) * runLength;
      shape.push(at(d));
      flat.push(lerp(from, to, (travelled + d) / length));
    }
    travelled += runLength;
  }
  return { shape, flat, center: [stemX + 0.42, -0.2], length, delay };
}

const FIRST_O = -WORD_HALF + 1;
const SECOND_O = -WORD_HALF + 3 + LETTER_GAP;
const P_STEM = -WORD_HALF + 4 + 2 * LETTER_GAP;
const FIRST_CUT = FIRST_O + 1 + LETTER_GAP / 2;
const SECOND_CUT = SECOND_O + 1 + LETTER_GAP / 2;
const LETTERS: ReadonlyArray<Letter> = [
  ring(FIRST_O, -WORD_HALF - 0.5, FIRST_CUT, 0),
  ring(SECOND_O, FIRST_CUT, SECOND_CUT, 0.05),
  letterP(P_STEM, SECOND_CUT, WORD_HALF + 0.5, 0.1),
];

/** Where a letter's outline is after `distance` along it, 0..1. */
function pointOnLetter(letter: Letter, distance: number): Point {
  const position = clamp01(distance) * (letter.shape.length - 1);
  const index = Math.min(Math.floor(position), letter.shape.length - 2);
  const from = letter.shape[index] ?? letter.center;
  const to = letter.shape[index + 1] ?? from;
  const x = position - index;
  return [lerp(from[0], to[0], x), lerp(from[1], to[1], x)];
}

// A fixed seed keeps every launch identical.
function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

interface Particle {
  /** Where it lands on the wordmark. */
  readonly target: Point;
  /** Which way it sparks off the wordmark on impact. */
  readonly outward: Point;
  readonly angle: number;
  readonly reach: number;
  /** 0 is far and dim, 1 is near and bright. */
  readonly depth: number;
  readonly burstDelay: number;
  readonly settleDelay: number;
  readonly size: number;
  readonly spark: number;
  readonly accent: boolean;
}

const PARTICLE_COUNT = 280;

const PARTICLES: ReadonlyArray<Particle> = (() => {
  const random = seededRandom(0x00900);
  const total = LETTERS.reduce((sum, letter) => sum + letter.length, 0);
  return LETTERS.flatMap((letter) => {
    const count = Math.round((PARTICLE_COUNT * letter.length) / total);
    return Array.from({ length: count }, (_, index): Particle => {
      const along = (index + 0.5) / count;
      const target = pointOnLetter(letter, along);
      const away = Math.hypot(target[0] - letter.center[0], target[1] - letter.center[1]) || 1;
      return {
        target,
        outward: [(target[0] - letter.center[0]) / away, (target[1] - letter.center[1]) / away],
        angle: random() * Math.PI * 2,
        reach: lerp(1.2, 7.6, random() ** 1.25),
        depth: random(),
        burstDelay: random() * 0.08,
        // The letters fill in along their outline, like being written.
        settleDelay: along * 0.05 + random() * 0.02,
        size: lerp(0.05, 0.11, random()),
        spark: lerp(0.25, 1.5, random() ** 2),
        accent: index % 5 === 0,
      };
    });
  });
})();

interface Agent {
  readonly orbit: number;
  readonly angle: number;
  readonly order: number;
}

/** Two tilted rings turning against each other, so near and far agents slide past. */
const ORBITS = [
  { radius: 6.6, count: 5, phase: 0.3, spin: 1.4 },
  { radius: 4.3, count: 3, phase: 0.25, spin: -2.1 },
] as const;
const ORBIT_SQUASH = 0.34;
const ORBIT_TILT = -0.2;

const AGENTS: ReadonlyArray<Agent> = ORBITS.flatMap((orbit, orbitIndex) =>
  Array.from({ length: orbit.count }, (_, index) => ({
    orbit: orbitIndex,
    angle: orbit.phase + (index / orbit.count) * Math.PI * 2,
    order: orbitIndex * ORBITS[0].count + index,
  })),
);

/** The lockup sits a little above the motion's center so the tagline under it balances. */
const LOCKUP_RISE = 1.4;

export interface StartupIntroScene {
  readonly width: number;
  readonly height: number;
  readonly centerX: number;
  readonly centerY: number;
  /** The ring radius of the wordmark, in pixels. Everything scales from it. */
  readonly unit: number;
  /** Far enough from the center to cover every corner. */
  readonly cover: number;
  readonly tagline: ReadonlyArray<{ readonly letter: string; readonly x: number }>;
  readonly taglineFont: string;
  readonly version: string;
  readonly versionFont: string;
}

/** Everything that depends on the window size, worked out once per size instead of per frame. */
export function createStartupIntroScene(input: {
  readonly width: number;
  readonly height: number;
  /** Where the motion is centered, in pixels from the top. */
  readonly centerY: number;
  readonly tagline: string;
  readonly version: string;
  readonly sans: string;
  readonly mono: string;
  readonly measure: (text: string, font: string) => number;
}): StartupIntroScene {
  const unit = Math.min(input.width, input.height) * 0.07;
  const centerX = input.width / 2;
  const taglineSize = unit * 0.44;
  const taglineFont = `500 ${taglineSize}px ${input.sans}`;
  const widths = Array.from(input.tagline, (letter) => input.measure(letter, taglineFont));
  const natural = widths.reduce((sum, width) => sum + width, 0);
  // Tracked out so the tagline is exactly as wide as the wordmark above it.
  const tracking =
    widths.length > 1 ? Math.max(0, (WORD_HALF * 2 * unit - natural) / (widths.length - 1)) : 0;
  const taglineWidth = natural + tracking * (widths.length - 1);
  let cursor = -taglineWidth / 2;
  const tagline = Array.from(input.tagline, (letter, index) => {
    const x = cursor;
    cursor += (widths[index] ?? 0) + tracking;
    return { letter, x };
  });
  return {
    width: input.width,
    height: input.height,
    centerX,
    centerY: input.centerY,
    unit,
    cover: Math.hypot(centerX, Math.max(input.centerY, input.height - input.centerY)) * 1.02,
    tagline,
    taglineFont,
    version: input.version,
    versionFont: `${unit * 0.32}px ${input.mono}`,
  };
}

/** Strokes the three letters, each `morph` of the way from the flat line to its shape. */
function strokeLetters(
  ctx: StartupIntroCanvas,
  centerX: number,
  centerY: number,
  scale: number,
  flatScale: number,
  morph: (letter: Letter) => number,
) {
  for (const letter of LETTERS) {
    const amount = morph(letter);
    ctx.beginPath();
    letter.shape.forEach((point, index) => {
      const x = centerX + lerp((letter.flat[index] ?? 0) * flatScale, point[0], amount) * scale;
      const y = centerY + point[1] * amount * scale;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

function disc(ctx: StartupIntroCanvas, x: number, y: number, radius: number) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
}

/** 0 to 2 seconds: the line, the letters it becomes, and the agents that gather around them. */
function drawOpening(ctx: StartupIntroCanvas, scene: StartupIntroScene, t: number) {
  const { centerX, centerY, unit } = scene;
  const pull = inCubic(span(t, PULL_AT, WIPE_AT - PULL_AT));
  const shrink = inOutCubic(span(t, HUB_AT - 0.06, 0.4));
  // The hub swells as the signals arrive, then tightens just before the wipe.
  const hubScale =
    lerp(1, 0.5, shrink) * (1 + 0.08 * Math.sin(Math.PI * span(t, 1.7, 0.2))) * (1 - 0.3 * pull);

  const drawAgents = (near: boolean) => {
    for (const agent of AGENTS) {
      const orbit = ORBITS[agent.orbit];
      if (!orbit) continue;
      const angle = agent.angle + orbit.spin * outCubic(span(t, HUB_AT, 1));
      if (Math.sin(angle) >= 0 !== near) continue;
      const grow = outBack(span(t, HUB_AT + 0.05 + agent.order * 0.035, 0.35));
      if (grow <= 0) continue;
      const reach = orbit.radius * unit * grow * (1 - pull);
      const flatX = Math.cos(angle) * reach;
      const flatY = Math.sin(angle) * reach * ORBIT_SQUASH;
      const x = centerX + flatX * Math.cos(ORBIT_TILT) - flatY * Math.sin(ORBIT_TILT);
      const y = centerY + flatX * Math.sin(ORBIT_TILT) + flatY * Math.cos(ORBIT_TILT);
      const depth = (Math.sin(angle) + 1) / 2;
      // The link stops short of the hub so the letters stay clean.
      const link = outCubic(span(t, HUB_AT + 0.15 + agent.order * 0.035, 0.3));
      const at = (along: number): Point => [lerp(centerX, x, along), lerp(centerY, y, along)];
      if (link > 0) {
        const [fromX, fromY] = at(0.3);
        const [toX, toY] = at(lerp(0.3, 1, link));
        ctx.globalAlpha = lerp(0.45, 0.95, depth);
        ctx.strokeStyle = SIGNAL;
        ctx.lineWidth = Math.max(1.25, unit * 0.032);
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
      }
      const signal = inOutCubic(span(t, 1.45 + agent.order * 0.03, 0.32));
      if (signal > 0 && signal < 1) {
        const [headX, headY] = at(lerp(1, 0.3, signal));
        const [tailX, tailY] = at(lerp(1, 0.3, Math.max(0, signal - 0.16)));
        ctx.globalAlpha = 1;
        ctx.strokeStyle = PAPER;
        ctx.lineWidth = Math.max(1.5, unit * 0.05);
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(headX, headY);
        ctx.stroke();
      }
      const size = unit * lerp(0.1, 0.3, depth) * grow;
      ctx.globalAlpha = lerp(0.45, 1, depth);
      ctx.fillStyle = PAPER;
      disc(ctx, x, y, size);
      ctx.fill();
      ctx.strokeStyle = SIGNAL;
      ctx.lineWidth = Math.max(1, unit * 0.025);
      disc(ctx, x, y, size * 1.8);
      ctx.stroke();
    }
  };

  // The orbit tracks stay behind after the agents leave them, for the wipe to erase.
  ORBITS.forEach((orbit, index) => {
    const drawn = outCubic(span(t, HUB_AT + index * 0.08, 0.6));
    if (drawn <= 0) return;
    const radius = orbit.radius * unit;
    const start = orbit.spin * outCubic(span(t, HUB_AT, 1));
    ctx.globalAlpha = 0.24;
    ctx.strokeStyle = PAPER;
    ctx.lineWidth = Math.max(1, unit * 0.016);
    ctx.beginPath();
    ctx.ellipse(
      centerX,
      centerY,
      radius,
      radius * ORBIT_SQUASH,
      ORBIT_TILT,
      start,
      start + drawn * Math.PI * 2,
    );
    ctx.stroke();
  });

  drawAgents(false);

  // The opening dot and its ring, then the line that shoots out of it.
  const ringOut = span(t, 0.02, 0.45);
  if (ringOut > 0 && ringOut < 1) {
    ctx.globalAlpha = 0.8 * (1 - ringOut) ** 1.5;
    ctx.strokeStyle = SIGNAL;
    ctx.lineWidth = Math.max(1.5, unit * 0.03);
    disc(ctx, centerX, centerY, lerp(0.2, 2.6, outExpo(ringOut)) * unit);
    ctx.stroke();
  }
  const thicken = inOutCubic(span(t, MORPH_AT, 0.45));
  ctx.globalAlpha = 1;
  ctx.strokeStyle = PAPER;
  ctx.lineWidth = lerp(0.07, STROKE, thicken) * unit * hubScale;
  strokeLetters(
    ctx,
    centerX,
    centerY,
    unit * hubScale,
    1.9 * outExpo(span(t, 0.06, 0.5)),
    (letter) => outCubic(span(t, MORPH_AT + letter.delay, 0.4)),
  );
  const dot = outBack(span(t, 0, 0.14)) * (1 - 0.7 * outCubic(span(t, 0.14, 0.3)));
  const dotFade = 1 - span(t, MORPH_AT - 0.05, 0.15);
  if (dot > 0 && dotFade > 0) {
    ctx.globalAlpha = dotFade;
    ctx.fillStyle = SIGNAL;
    disc(ctx, centerX, centerY, 0.24 * unit * dot);
    ctx.fill();
  }

  drawAgents(true);
}

/** 2 to 3 seconds: the burst hangs for a breath, then pours into the wordmark. */
function drawParticles(ctx: StartupIntroCanvas, scene: StartupIntroScene, t: number) {
  const { centerX, centerY, unit } = scene;
  const fade = 1 - span(t, IMPACT_AT, 0.3);
  if (fade <= 0) return;
  // The cloud breathes out once before it falls in.
  const swell = 1 + 0.08 * Math.sin(Math.PI * span(t, SETTLE_AT - 0.14, 0.2));
  const drift = outCubic(span(t, WIPE_AT, 1));
  const spark = outExpo(span(t, IMPACT_AT, 0.45));
  for (const particle of PARTICLES) {
    const burst = outExpo(span(t, WIPE_AT + particle.burstDelay, 0.5));
    if (burst <= 0) continue;
    const near = lerp(0.55, 1.6, particle.depth);
    const angle = particle.angle + 0.4 * near * drift;
    const settle = inOutQuint(span(t, SETTLE_AT + particle.settleDelay, 0.43));
    const x =
      lerp(Math.cos(angle) * particle.reach * 1.5 * burst * swell, particle.target[0], settle) +
      particle.outward[0] * particle.spark * spark;
    const y =
      lerp(
        Math.sin(angle) * particle.reach * 0.92 * burst * swell,
        particle.target[1] - LOCKUP_RISE,
        settle,
      ) +
      particle.outward[1] * particle.spark * spark;
    // Near and far differ in the cloud and even out as they join the letters.
    const size = particle.size * lerp(near, 0.7, settle) * unit;
    ctx.globalAlpha = Math.min(1, burst * 4) * lerp(lerp(0.4, 1, particle.depth), 1, settle) * fade;
    ctx.fillStyle = particle.accent ? SIGNAL : PAPER;
    ctx.fillRect(centerX + x * unit - size / 2, centerY + y * unit - size / 2, size, size);
  }
}

/** From 3 seconds: the wordmark lands, and its rule, tagline and version settle under it. */
function drawLockup(ctx: StartupIntroCanvas, scene: StartupIntroScene, t: number) {
  const { centerX, unit } = scene;
  const centerY = scene.centerY - LOCKUP_RISE * unit;

  const flash = span(t, IMPACT_AT, 0.5);
  if (flash > 0 && flash < 1) {
    ctx.globalAlpha = 0.75 * (1 - flash) ** 2;
    ctx.strokeStyle = SIGNAL;
    ctx.lineWidth = Math.max(1.5, unit * 0.05);
    disc(ctx, centerX, centerY, lerp(1.2, 8, outExpo(flash)) * unit);
    ctx.stroke();
  }

  // The stroke arrives thin and oversized, and lands on the beat.
  const land = 1 + 0.06 * (1 - outCubic(span(t, IMPACT_AT, 0.3)));
  ctx.globalAlpha = outCubic(span(t, IMPACT_AT - 0.08, 0.12));
  ctx.strokeStyle = PAPER;
  ctx.lineWidth = STROKE * unit * lerp(0.3, 1, outBack(span(t, IMPACT_AT - 0.08, 0.32)));
  strokeLetters(ctx, centerX, centerY, unit * land, 0, () => 1);

  const rule = outExpo(span(t, IMPACT_AT + 0.02, 0.4));
  if (rule > 0) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = SIGNAL;
    ctx.lineWidth = Math.max(1.5, unit * 0.04);
    ctx.beginPath();
    ctx.moveTo(centerX - WORD_HALF * unit * rule, centerY + 1.85 * unit);
    ctx.lineTo(centerX + WORD_HALF * unit * rule, centerY + 1.85 * unit);
    ctx.stroke();
  }

  ctx.fillStyle = PAPER;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.font = scene.taglineFont;
  scene.tagline.forEach(({ letter, x }, index) => {
    const rise = outCubic(span(t, IMPACT_AT + 0.05 + index * 0.012, 0.21));
    if (rise <= 0 || letter === " ") return;
    ctx.globalAlpha = 0.92 * rise;
    ctx.fillText(letter, centerX + x, centerY + (2.95 + 0.4 * (1 - rise)) * unit);
  });

  const count = outCubic(span(t, IMPACT_AT + 0.1, 0.4));
  if (count > 0) {
    ctx.globalAlpha = 0.55 * outCubic(span(t, IMPACT_AT + 0.1, 0.15));
    ctx.textAlign = "center";
    ctx.font = scene.versionFont;
    ctx.fillText(`v${countUpVersion(scene.version, count)}`, centerX, centerY + 3.85 * unit);
  }
}

/** Draws the whole frame for `t` seconds into the motion. Safe to call for any `t`, in any order. */
export function drawStartupIntro(ctx: StartupIntroCanvas, scene: StartupIntroScene, t: number) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, scene.width, scene.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (t < SETTLE_AT) drawOpening(ctx, scene, t);
  if (t >= WIPE_AT && t < SETTLE_AT) {
    // A blue ring sweeps out from the hub: what is outside it is the old scene, inside the new.
    ctx.globalAlpha = 1;
    ctx.fillStyle = SIGNAL;
    disc(ctx, scene.centerX, scene.centerY, scene.cover * outCubic(span(t, WIPE_AT, 0.42)));
    ctx.fill();
    ctx.fillStyle = INK;
    disc(ctx, scene.centerX, scene.centerY, scene.cover * outCubic(span(t, WIPE_AT + 0.07, 0.43)));
    ctx.fill();
  }
  if (t >= WIPE_AT) drawParticles(ctx, scene, t);
  if (t >= IMPACT_AT - 0.08) drawLockup(ctx, scene, t);
  ctx.globalAlpha = 1;
}
