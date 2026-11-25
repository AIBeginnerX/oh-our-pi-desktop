import { OOP_WORDMARK_PATHS, OOP_WORDMARK_VIEWBOX } from "./OoPWordmark";
import { DOT_STRIDE, type Point2D, type RasterizeLockupRequest } from "./startupIntroFrame";

export type RgbColor = readonly [number, number, number];

export const PAPER_RGB: RgbColor = [244 / 255, 246 / 255, 251 / 255];

const VERTEX_SHADER_SOURCE = `#version 300 es
in vec4 aDot;
in float aSoft;
uniform vec2 uRes;
uniform float uDpr;
out float vAlpha;
out float vSoft;

void main() {
  vec2 clip = aDot.xy / uRes * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  float pxSize = aDot.z * uDpr;
  gl_PointSize = aDot.w > 0.001 ? pxSize : 0.0;
  vAlpha = aDot.w;
  vSoft = max(aSoft, 1.8 / max(pxSize, 0.001));
}
`;

const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;
in float vAlpha;
in float vSoft;
uniform vec3 uCol;
out vec4 outColor;

void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float e = (1.0 - smoothstep(1.0 - vSoft, 1.0, r)) * vAlpha;
  outColor = vec4(uCol * e, e);
}
`;

export interface StartupIntroRenderer {
  resize: (cssWidth: number, cssHeight: number, dpr: number) => void;
  draw: (dots: Float32Array, rgb: RgbColor) => void;
  dispose: () => void;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * Creates a minimal single-VBO WebGL2 point sprite renderer for `dotCount` particles.
 * Returns `null` when WebGL2 is unavailable or shader setup fails; caller should skip the intro.
 */
export function createStartupIntroRenderer(
  canvas: HTMLCanvasElement,
  dotCount: number,
): StartupIntroRenderer | null {
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: true,
    antialias: false,
    alpha: true,
  });
  if (!gl) return null;

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return null;
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return null;
  }

  const uRes = gl.getUniformLocation(program, "uRes");
  const uDpr = gl.getUniformLocation(program, "uDpr");
  const uCol = gl.getUniformLocation(program, "uCol");
  const aDot = gl.getAttribLocation(program, "aDot");
  const aSoft = gl.getAttribLocation(program, "aSoft");

  const vbo = gl.createBuffer();
  const vao = gl.createVertexArray();
  if (!vbo || !vao || aDot < 0 || aSoft < 0) {
    if (vbo) gl.deleteBuffer(vbo);
    if (vao) gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return null;
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    dotCount * DOT_STRIDE * Float32Array.BYTES_PER_ELEMENT,
    gl.DYNAMIC_DRAW,
  );
  const strideBytes = DOT_STRIDE * Float32Array.BYTES_PER_ELEMENT;
  gl.enableVertexAttribArray(aDot);
  gl.vertexAttribPointer(aDot, 4, gl.FLOAT, false, strideBytes, 0);
  gl.enableVertexAttribArray(aSoft);
  gl.vertexAttribPointer(
    aSoft,
    1,
    gl.FLOAT,
    false,
    strideBytes,
    4 * Float32Array.BYTES_PER_ELEMENT,
  );
  gl.bindVertexArray(null);

  let cssWidth = 1;
  let cssHeight = 1;
  let currentDpr = 1;
  let disposed = false;

  return {
    resize(width, height, dpr) {
      if (disposed) return;
      cssWidth = Math.max(1, width);
      cssHeight = Math.max(1, height);
      currentDpr = Math.min(Math.max(dpr || 1, 1), 2);
      canvas.width = Math.round(cssWidth * currentDpr);
      canvas.height = Math.round(cssHeight * currentDpr);
    },

    draw(dots, rgb) {
      if (disposed) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, dots);
      gl.uniform2f(uRes, cssWidth, cssHeight);
      gl.uniform1f(uDpr, currentDpr);
      gl.uniform3f(uCol, rgb[0], rgb[1], rgb[2]);
      gl.drawArrays(gl.POINTS, 0, dotCount);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.useProgram(null);
      gl.deleteBuffer(vbo);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

/**
 * Rasterises the OOP wordmark paths and bold "AI" onto an offscreen 2D canvas and samples the
 * densest regular grid that fits within `request.maxDots`.
 */
export function rasterizeWordmarkLockup(request: RasterizeLockupRequest): ReadonlyArray<Point2D> {
  const pad = 4;
  const width = Math.max(1, Math.ceil(request.totalWidth + pad * 2));
  const height = Math.max(1, Math.ceil(request.glyphHeight + pad * 2));
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  ctx.fillStyle = "#ffffff";
  const scale = request.glyphHeight / OOP_WORDMARK_VIEWBOX.height;
  ctx.save();
  ctx.translate(pad, pad);
  ctx.scale(scale, scale);
  for (const d of OOP_WORDMARK_PATHS) {
    const path = new Path2D(d);
    // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- A canvas fill, not Array.fill.
    ctx.fill(path, "evenodd");
  }
  ctx.restore();

  ctx.font = request.font;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const metrics = ctx.measureText("AI");
  const ascent = metrics.actualBoundingBoxAscent || request.glyphHeight * 0.72;
  const descent = metrics.actualBoundingBoxDescent || 0;
  const baselineY = pad + request.glyphHeight * 0.5 + (ascent - descent) * 0.5;
  ctx.fillText("AI", pad + request.wordmarkWidth + request.aiGap, baselineY);

  const data = ctx.getImageData(0, 0, width, height).data;
  let opaquePixels = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! > 140) opaquePixels += 1;
  }
  if (opaquePixels === 0) return [];

  const startStep = Math.max(1, Math.sqrt(opaquePixels / Math.max(1, request.maxDots)) * 0.85);
  let best: Array<Point2D> = [];
  for (let g = startStep; g < 24; g += Math.max(0.08, g * 0.03)) {
    const list: Array<Point2D> = [];
    for (let y = 0; y < height; y += g) {
      const py = y | 0;
      const rowOffset = py * width;
      for (let x = 0; x < width; x += g) {
        if (data[(rowOffset + (x | 0)) * 4 + 3]! > 140) {
          list.push({ x: x - pad, y: y - pad });
        }
      }
    }
    best = list;
    if (list.length <= request.maxDots) break;
  }
  return best;
}

/** Resolves any CSS colour string to normalised sRGB channels once via a 1x1 offscreen canvas. */
export function resolveRgbColor(cssColor: string, fallback: RgbColor): RgbColor {
  const offscreen = document.createElement("canvas");
  offscreen.width = 1;
  offscreen.height = 1;
  const ctx = offscreen.getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallback;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 1, 1);
  const pixel = ctx.getImageData(0, 0, 1, 1).data;
  if (pixel[3] === 0) return fallback;
  return [pixel[0]! / 255, pixel[1]! / 255, pixel[2]! / 255];
}
