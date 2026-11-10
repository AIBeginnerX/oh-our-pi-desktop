import {
  layoutFlowchart,
  type FlowLayoutNode,
  type Flowchart,
} from "@t3tools/client-runtime/visual-blocks";
import { useId, useMemo } from "react";

import { reportColor } from "./chartShared";

const RANK_DELAY_MS = 140;
/** diagram-design: hairline strokes, 6-8px radii, and a 6px gap between an arrow and its label. */
const STROKE = 1;
const EMPHASIZED_STROKE = 1.2;
const ELBOW_RADIUS = 8;
const LABEL_GAP = 6;
/** Wide (CJK, Hangul) glyphs switch the label register: 12px sans, no tracking, no capitals. */
const WIDE_CHARACTER = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
const PATH_NUMBER = /-?\d+(?:\.\d+)?/g;

type Point = readonly [number, number];

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Liang-Barsky: does the segment touch the rectangle? */
function segmentHitsRect(from: Point, to: Point, rect: Rect): boolean {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  let enter = 0;
  let exit = 1;
  const edges: ReadonlyArray<readonly [number, number]> = [
    [-dx, from[0] - rect.x],
    [dx, rect.x + rect.width - from[0]],
    [-dy, from[1] - rect.y],
    [dy, rect.y + rect.height - from[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > exit) return false;
      if (t > enter) enter = t;
    } else {
      if (t < enter) return false;
      if (t < exit) exit = t;
    }
  }
  return true;
}

/** Role tint: a low-opacity fill over the card, its stroke pulled toward ink so it reads either theme. */
function nodePaint(node: FlowLayoutNode) {
  const color = reportColor(node.rank);
  const tint =
    node.shape === "diamond" ? 14 : node.shape === "stadium" || node.shape === "round" ? 6 : 10;
  return {
    fill: `color-mix(in oklab, ${color} ${tint}%, var(--card))`,
    stroke: `color-mix(in oklab, ${color} 72%, var(--foreground))`,
    strokeWidth: STROKE,
  };
}

/**
 * diagram-design's node box: an opaque paper mask under a tinted, hairline-stroked shape, so a
 * connector behind the fill never shows through.
 */
function NodeShape({ node, backing = false }: { node: FlowLayoutNode; backing?: boolean }) {
  const { width: w, height: h } = node;
  const paint = backing ? { fill: "var(--card)", stroke: "none", strokeWidth: 0 } : nodePaint(node);
  switch (node.shape) {
    case "diamond":
      return <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} {...paint} />;
    case "hexagon": {
      const inset = Math.min(h / 3, w / 5);
      return (
        <polygon
          points={`${inset},0 ${w - inset},0 ${w},${h / 2} ${w - inset},${h} ${inset},${h} 0,${h / 2}`}
          {...paint}
        />
      );
    }
    case "circle":
      return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...paint} />;
    case "cylinder":
      return (
        <g {...paint}>
          <path d={`M0 7 A ${w / 2} 7 0 0 1 ${w} 7 V ${h - 7} A ${w / 2} 7 0 0 1 0 ${h - 7} Z`} />
          <path d={`M0 7 A ${w / 2} 7 0 0 0 ${w} 7`} fill="none" />
        </g>
      );
    case "subroutine":
      return (
        <g {...paint}>
          <rect width={w} height={h} rx={6} />
          <path d={`M8 0 V ${h} M ${w - 8} 0 V ${h}`} fill="none" />
        </g>
      );
    case "stadium":
      return <rect width={w} height={h} rx={Math.min(h / 2, 20)} {...paint} />;
    case "round":
      return <rect width={w} height={h} rx={8} {...paint} />;
    case "rect":
      return <rect width={w} height={h} rx={6} {...paint} />;
  }
}

/**
 * The layout routes every edge as a cubic Bezier. diagram-design wants orthogonal connectors, so
 * rebuild the same route as right-angle elbows: the control points say which axis the line leaves
 * on, and the turn happens partway between the two bends. Rule 5 forbids transiting behind a box
 * that is not an endpoint, so when a multi-rank edge would pass through one, the route detours down
 * a side lane that clears every blocker instead.
 */
function routePoints(
  d: string,
  obstacles: ReadonlyArray<Rect> = [],
  frame: { width: number; height: number } = { width: 0, height: 0 },
): ReadonlyArray<Point> | null {
  const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = [...d.matchAll(PATH_NUMBER)].map((match) =>
    Number(match[0]),
  );
  if ([x1, y1, c1x, c1y, c2x, c2y, x2, y2].some((value) => value === undefined)) return null;
  const vertical = Math.abs(c1x! - x1!) <= Math.abs(c1y! - y1!);
  const straight = vertical ? Math.abs(x1! - x2!) < 1 : Math.abs(y1! - y2!) < 1;
  const build = (turn: number): ReadonlyArray<Point> =>
    straight
      ? [
          [x1!, y1!],
          [x2!, y2!],
        ]
      : vertical
        ? [
            [x1!, y1!],
            [x1!, turn],
            [x2!, turn],
            [x2!, y2!],
          ]
        : [
            [x1!, y1!],
            [turn, y1!],
            [turn, y2!],
            [x2!, y2!],
          ];
  const crossings = (points: ReadonlyArray<Point>) =>
    obstacles.filter((box) =>
      points.slice(1).some((to, index) => segmentHitsRect(points[index]!, to, box)),
    ).length;
  const defaultTurn = vertical ? (c1y! + c2y!) / 2 : (c1x! + c2x!) / 2;
  const low = vertical ? Math.min(y1!, y2!) : Math.min(x1!, x2!);
  const high = vertical ? Math.max(y1!, y2!) : Math.max(x1!, x2!);
  let best: ReadonlyArray<Point> = build(defaultTurn);
  let bestCrossings = crossings(best);
  for (let turn = low; turn <= high && bestCrossings > 0; turn += 2) {
    const candidate = build(turn);
    const count = crossings(candidate);
    if (count < bestCrossings) {
      bestCrossings = count;
      best = candidate;
    }
  }
  if (bestCrossings === 0) return best;

  // Still blocked: leave the corridor and run down a lane beside every box in the way.
  const LANE_GAP = 12;
  const STUB = 10;
  const span = vertical ? Math.abs(y2! - y1!) : Math.abs(x2! - x1!);
  if (span < STUB * 4) return best;
  const lanes = obstacles.flatMap((box) =>
    vertical ? [box.x - LANE_GAP, box.x + box.width + LANE_GAP] : [],
  );
  // Fall back to the margin lane at either end of the figure, kept just inside the frame.
  const EDGE_INSET = 8;
  const laneOptions = [
    ...lanes,
    ...(vertical
      ? [EDGE_INSET, frame.width - EDGE_INSET]
      : [EDGE_INSET, frame.height - EDGE_INSET]),
  ];
  for (const lane of laneOptions) {
    const detour: ReadonlyArray<Point> = vertical
      ? [
          [x1!, y1!],
          [x1!, y1! + STUB],
          [lane, y1! + STUB],
          [lane, y2! - STUB],
          [x2!, y2! - STUB],
          [x2!, y2!],
        ]
      : [
          [x1!, y1!],
          [x1! + STUB, y1!],
          [x1! + STUB, lane],
          [x2! - STUB, lane],
          [x2! - STUB, y2!],
          [x2!, y2!],
        ];
    const inside = vertical
      ? lane < 0 || (frame.width > 0 && lane > frame.width)
      : lane < 0 || (frame.height > 0 && lane > frame.height);
    if (inside) continue;
    const count = crossings(detour);
    if (count < bestCrossings) {
      bestCrossings = count;
      best = detour;
    }
  }
  return best;
}

const fixed = (value: number) => Number(value.toFixed(2));

/** Polyline -> path with `r=8` quarter-arc elbows (diagram-design connector rule 1). */
function elbowPath(points: ReadonlyArray<Point>): string {
  const first = points[0];
  if (first === undefined) return "";
  let d = `M ${fixed(first[0])} ${fixed(first[1])}`;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    const next = points[index + 1];
    if (next === undefined) {
      d += ` L ${fixed(point[0])} ${fixed(point[1])}`;
      break;
    }
    const previous = points[index - 1] ?? first;
    const approach = Math.abs(point[0] - previous[0]) + Math.abs(point[1] - previous[1]);
    const departure = Math.abs(next[0] - point[0]) + Math.abs(next[1] - point[1]);
    const radius = Math.min(ELBOW_RADIUS, approach / 2, departure / 2);
    if (radius < 1) {
      d += ` L ${fixed(point[0])} ${fixed(point[1])}`;
      continue;
    }
    const enterX = point[0] - Math.sign(point[0] - previous[0]) * radius;
    const enterY = point[1] - Math.sign(point[1] - previous[1]) * radius;
    const exitX = point[0] + Math.sign(next[0] - point[0]) * radius;
    const exitY = point[1] + Math.sign(next[1] - point[1]) * radius;
    d += ` L ${fixed(enterX)} ${fixed(enterY)} Q ${fixed(point[0])} ${fixed(point[1])} ${fixed(exitX)} ${fixed(exitY)}`;
  }
  return d;
}

/** Arrow-label register: 9px mono capitals for Latin, 12px sans for wide glyphs; the mask hugs the text. */
function labelMetrics(lines: ReadonlyArray<string>) {
  const wide = lines.some((line) => WIDE_CHARACTER.test(line));
  const fontSize = wide ? 12 : 9;
  const lineHeight = wide ? 16 : 12;
  const widest = Math.max(
    0,
    ...lines.map((line) =>
      [...line].reduce(
        (sum, char) => sum + (WIDE_CHARACTER.test(char) ? fontSize : fontSize * 0.6),
        0,
      ),
    ),
  );
  return {
    wide,
    fontSize,
    lineHeight,
    width: Math.ceil(widest) + 12,
    height: lines.length * lineHeight,
  };
}

function distanceToSegment(x: number, y: number, from: Point, to: Point): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - from[0]) * dx + (y - from[1]) * dy) / lengthSquared));
  return Math.hypot(x - (from[0] + t * dx), y - (from[1] + t * dy));
}

const within = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * diagram-design connector rules 2 and 6: a label never sits on its own stroke and never lands
 * under a box painted later. Walk the route from the segment nearest the layout's anchor outward,
 * slide along each segment, and try both sides with a visible 6px gap; prefer a placement that
 * clears every node and every stroke, and only then one that also avoids labels already placed.
 */
function labelPosition(
  points: ReadonlyArray<Point>,
  hintX: number,
  hintY: number,
  box: { width: number; height: number },
  frame: { width: number; height: number },
  obstacles: ReadonlyArray<Rect>,
  taken: ReadonlyArray<Rect> = [],
): { x: number; y: number } {
  const half = { x: box.width / 2, y: box.height / 2 };
  const segments = points
    .slice(1)
    .map((to, index) => {
      const from = points[index]!;
      return { from, to, distance: distanceToSegment(hintX, hintY, from, to) };
    })
    .sort((a, b) => a.distance - b.distance);
  const fractions = [0.5, 0.3, 0.7, 0.15, 0.85, 0.05, 0.95];
  const candidates: Array<{ x: number; y: number }> = [];
  for (const { from, to } of segments) {
    const vertical = Math.abs(from[0] - to[0]) < 0.5;
    const horizontal = Math.abs(from[1] - to[1]) < 0.5;
    if (!vertical && !horizontal) continue;
    for (const fraction of fractions) {
      const alongX = from[0] + (to[0] - from[0]) * fraction;
      const alongY = from[1] + (to[1] - from[1]) * fraction;
      for (const side of [1, -1]) {
        candidates.push({
          x: vertical ? alongX + side * (LABEL_GAP + half.x) : alongX,
          y: vertical ? alongY : alongY + side * (LABEL_GAP + half.y),
        });
      }
    }
  }
  let best: { x: number; y: number; cost: number } | null = null;
  for (const candidate of candidates) {
    const x = within(candidate.x, half.x, frame.width - half.x);
    const y = within(candidate.y, half.y, frame.height - half.y);
    const rect: Rect = { x: x - half.x, y: y - half.y, width: box.width, height: box.height };
    // A clear 6px gap is enough, so the mask is inflated by just under LABEL_GAP: a stroke that
    // runs exactly LABEL_GAP away must not count as a hit.
    const margin: Rect = {
      x: rect.x - (LABEL_GAP - 0.5),
      y: rect.y - (LABEL_GAP - 0.5),
      width: rect.width + (LABEL_GAP - 0.5) * 2,
      height: rect.height + (LABEL_GAP - 0.5) * 2,
    };
    const onStroke = segments.filter(({ from, to }) => segmentHitsRect(from, to, margin)).length;
    const hidden = obstacles.filter((node) => overlaps(margin, node)).length;
    // A mask already placed is only a preference: a node or a stroke beating it still wins.
    const stacked = taken.filter((other) => overlaps(margin, other)).length;
    const drift = Math.abs(x - candidate.x) + Math.abs(y - candidate.y);
    const cost =
      (onStroke + hidden) * 1000 + stacked * 300 + drift * 8 + Math.hypot(x - hintX, y - hintY);
    if (best === null || cost < best.cost) best = { x, y, cost };
  }
  return best === null ? { x: hintX, y: hintY } : { x: best.x, y: best.y };
}

/**
 * A mermaid flowchart drawn without mermaid: nodes pop in rank by rank and each arrow draws
 * itself after its source appears. While the block streams, new nodes join and the rest glide.
 */
export function FlowchartView({ chart }: { chart: Flowchart }) {
  const layout = useMemo(() => layoutFlowchart(chart), [chart]);
  const uid = useId().replaceAll(/[^a-zA-Z0-9_-]/g, "");
  const arrowId = `flow-arrow-${uid}`;
  const strongArrowId = `flow-arrow-strong-${uid}`;
  // Routes and label masks are derived from the layout alone. Each label is placed clear of every
  // box and stroke, and prefers a spot no earlier mask already occupies.
  const routed = useMemo(() => {
    const frame = { width: layout.width, height: layout.height };
    const boxes = layout.nodes.map((node) => ({
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    }));
    const placed: Array<Rect> = [];
    return layout.edges.map((edge) => {
      // Only boxes that are not this edge's own endpoints may block its route.
      const others = boxes.filter((_, index) => {
        const node = layout.nodes[index]!;
        return node.id !== edge.from && node.id !== edge.to;
      });
      const points = routePoints(edge.d, others, frame);
      const label = edge.labelLines.length === 0 ? null : labelMetrics(edge.labelLines);
      if (label === null) return { points, label: null, at: null };
      const at =
        points === null
          ? { x: edge.labelX, y: edge.labelY }
          : labelPosition(points, edge.labelX, edge.labelY, label, frame, boxes, placed);
      placed.push({
        x: at.x - label.width / 2,
        y: at.y - label.height / 2,
        width: label.width,
        height: label.height,
      });
      return { points, label, at };
    });
  }, [layout]);
  return (
    <div className="overflow-x-auto">
      <svg
        width={layout.width}
        height={layout.height}
        className="mx-auto block font-sans"
        role="img"
        aria-label="Flowchart"
      >
        <defs>
          {(
            [
              [arrowId, "fill-muted-foreground"],
              [strongArrowId, "fill-foreground"],
            ] as const
          ).map(([id, className]) => (
            <marker
              key={id}
              id={id}
              viewBox="0 0 8 6"
              refX="7"
              refY="3"
              markerWidth="8"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <polygon points="0 0, 8 3, 0 6" className={className} />
            </marker>
          ))}
        </defs>
        {layout.edges.map((edge, edgeIndex) => {
          const dashed = edge.style === "dashed";
          const emphasized = edge.style === "thick";
          const delay = `${edge.rank * RANK_DELAY_MS + 160}ms`;
          const route = routed[edgeIndex] ?? { points: null, label: null, at: null };
          const { points, label, at } = route;
          return (
            <g key={`${edge.from}>${edge.to}:${edge.label ?? ""}:${edge.style}`}>
              <path
                d={points === null ? edge.d : elbowPath(points)}
                fill="none"
                stroke="currentColor"
                strokeWidth={emphasized ? EMPHASIZED_STROKE : STROKE}
                strokeLinejoin="round"
                strokeDasharray={dashed ? "5 4" : undefined}
                pathLength={dashed ? undefined : 1}
                markerEnd={edge.arrow ? `url(#${emphasized ? strongArrowId : arrowId})` : undefined}
                className={
                  emphasized
                    ? "text-foreground motion-safe:rpt-draw"
                    : dashed
                      ? "text-muted-foreground motion-safe:rpt-fade"
                      : "text-muted-foreground motion-safe:rpt-draw"
                }
                style={{ animationDelay: delay }}
              />
              {label === null || at === null ? null : (
                <g className="motion-safe:rpt-fade" style={{ animationDelay: delay }}>
                  <rect
                    x={at.x - label.width / 2}
                    y={at.y - label.height / 2}
                    width={label.width}
                    height={label.height}
                    rx={2}
                    className="fill-card"
                  />
                  <text
                    x={at.x}
                    y={at.y - ((edge.labelLines.length - 1) * label.lineHeight) / 2}
                    textAnchor="middle"
                    fontSize={label.fontSize}
                    fontWeight={label.wide ? 500 : 400}
                    letterSpacing={label.wide ? undefined : "0.06em"}
                    className={
                      label.wide
                        ? "fill-muted-foreground"
                        : "fill-muted-foreground font-mono uppercase"
                    }
                  >
                    {edge.labelLines.map((line, lineIndex) => (
                      <tspan
                        key={edge.labelLines.slice(0, lineIndex + 1).join("\n")}
                        x={at.x}
                        dy={lineIndex === 0 ? "0.32em" : label.lineHeight}
                      >
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              )}
            </g>
          );
        })}
        {layout.nodes.map((node) => (
          <g
            key={node.id}
            style={{
              transform: `translate(${node.x}px, ${node.y}px)`,
              transition: "transform 300ms ease",
            }}
          >
            <g
              className="motion-safe:rpt-pop"
              style={{ animationDelay: `${node.rank * RANK_DELAY_MS}ms` }}
            >
              <NodeShape node={node} backing />
              <NodeShape node={node} />
              <text
                x={node.width / 2}
                y={node.height / 2 - ((node.lines.length - 1) * 16) / 2}
                dy="0.32em"
                textAnchor="middle"
                fontSize="12"
                fontWeight="600"
                className="fill-foreground"
              >
                {node.lines.map((line, index) => (
                  <tspan
                    key={node.lines.slice(0, index + 1).join("\n")}
                    x={node.width / 2}
                    dy={index === 0 ? "0.32em" : "16"}
                  >
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          </g>
        ))}
      </svg>
    </div>
  );
}
