/**
 * Visual blocks for chat replies: a ```chart block holds one JSON chart spec and a ```mermaid
 * block holds a flowchart. Both parse leniently, because models write them from memory, and
 * return null for anything they cannot draw so the reply falls back to the plain code block.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type ChartKind = "bar" | "hbar" | "line" | "area" | "pie" | "donut" | "stats" | "progress";

export interface ChartSeries {
  readonly name: string;
  readonly data: ReadonlyArray<number>;
}

export interface ChartItem {
  readonly label: string;
  readonly value: number | string;
  readonly max?: number;
  readonly delta?: number;
  readonly hint?: string;
}

export interface ChartSpec {
  readonly kind: ChartKind;
  readonly title?: string;
  readonly subtitle?: string;
  readonly unit?: string;
  readonly stacked: boolean;
  readonly labels: ReadonlyArray<string>;
  readonly series: ReadonlyArray<ChartSeries>;
  readonly items: ReadonlyArray<ChartItem>;
}

const MAX_LABELS = 40;
const MAX_SERIES = 6;
const MAX_ITEMS = 12;

const KIND_ALIASES: Record<string, ChartKind> = {
  bar: "bar",
  bars: "bar",
  column: "bar",
  columns: "bar",
  hbar: "hbar",
  barh: "hbar",
  horizontal: "hbar",
  "horizontal-bar": "hbar",
  horizontalbar: "hbar",
  line: "line",
  lines: "line",
  area: "area",
  pie: "pie",
  donut: "donut",
  doughnut: "donut",
  ring: "donut",
  stats: "stats",
  stat: "stats",
  kpi: "stats",
  kpis: "stats",
  metrics: "stats",
  progress: "progress",
  gauge: "progress",
  bullet: "progress",
};

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : undefined;

/** Numbers as models write them: 12, "12", "1,234.5", "45%". */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.replaceAll(",", "").replace(/%$/, "").trim());
  return value.trim().length > 0 && Number.isFinite(parsed) ? parsed : undefined;
}

const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.map((entry) => toNumber(entry) ?? Number.NaN) : [];

function readItems(value: unknown): ChartItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ChartItem[] => {
    if (!isRecord(entry)) return [];
    const label = text(entry.label ?? entry.name ?? entry.title);
    const raw = entry.value ?? entry.amount ?? entry.count;
    const value = toNumber(raw) ?? text(raw);
    if (label === undefined || value === undefined) return [];
    const max = toNumber(entry.max ?? entry.target ?? entry.total);
    const delta = toNumber(entry.delta ?? entry.change ?? entry.diff);
    const hint = text(entry.hint ?? entry.note ?? entry.description);
    return [
      {
        label,
        value,
        ...(max === undefined ? {} : { max }),
        ...(delta === undefined ? {} : { delta }),
        ...(hint === undefined ? {} : { hint }),
      },
    ];
  });
}

export function parseChartSpec(source: string): ChartSpec | null {
  const decoded = decodeJson(source.trim());
  if (Option.isNone(decoded) || !isRecord(decoded.value)) return null;
  const raw = decoded.value;
  const kind = KIND_ALIASES[String(raw.type ?? raw.kind ?? raw.chart ?? "bar").toLowerCase()];
  if (kind === undefined) return null;
  const title = text(raw.title);
  const subtitle = text(raw.subtitle ?? raw.description ?? raw.caption);
  const unit = text(raw.unit ?? raw.units ?? raw.suffix);
  const base = {
    kind,
    stacked: raw.stacked === true,
    ...(title === undefined ? {} : { title }),
    ...(subtitle === undefined ? {} : { subtitle }),
    ...(unit === undefined ? {} : { unit }),
  };

  if (kind === "stats" || kind === "progress") {
    const items = readItems(raw.items ?? raw.metrics ?? raw.data ?? raw.values).slice(0, MAX_ITEMS);
    return items.length === 0 ? null : { ...base, labels: [], series: [], items };
  }

  // Object rows ({label, value}) are the most common shape a model writes for one series.
  const rows = Array.isArray(raw.data) && raw.data.every(isRecord) ? raw.data : undefined;
  let labels = (
    Array.isArray(raw.labels ?? raw.categories ?? raw.x)
      ? ((raw.labels ?? raw.categories ?? raw.x) as unknown[])
      : (rows ?? []).map((row) => row.label ?? row.name ?? row.x)
  ).map((label) => text(label) ?? "");
  const declared = Array.isArray(raw.series)
    ? raw.series
    : Array.isArray(raw.datasets)
      ? raw.datasets
      : undefined;
  let series: ChartSeries[] = declared
    ? declared.flatMap((entry, index): ChartSeries[] =>
        isRecord(entry)
          ? [
              {
                name: text(entry.name ?? entry.label) ?? `Series ${index + 1}`,
                data: numbers(entry.data ?? entry.values),
              },
            ]
          : [],
      )
    : rows
      ? [{ name: title ?? "Value", data: rows.map((row) => toNumber(row.value ?? row.y) ?? NaN) }]
      : Array.isArray(raw.data ?? raw.values)
        ? [{ name: title ?? "Value", data: numbers(raw.data ?? raw.values) }]
        : [];
  if (labels.length === 0) {
    const longest = Math.max(0, ...series.map((entry) => entry.data.length));
    labels = Array.from({ length: longest }, (_, index) => String(index + 1));
  }
  labels = labels.slice(0, MAX_LABELS);
  series = series
    .slice(0, kind === "pie" || kind === "donut" ? 1 : MAX_SERIES)
    .map((entry) => ({ ...entry, data: entry.data.slice(0, labels.length) }))
    .filter((entry) => entry.data.some(Number.isFinite));
  if (series.length === 0 || labels.length === 0) return null;
  return { ...base, labels, series, items: [] };
}

export interface NiceScale {
  readonly min: number;
  readonly max: number;
  readonly ticks: ReadonlyArray<number>;
}

/** Round axis bounds that always include zero, with about `count` steps. */
export function niceScale(min: number, max: number, count = 4): NiceScale {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi === lo) return { min: lo, max: lo + 1, ticks: [lo, lo + 1] };
  const raw = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step =
    (normalized <= 1
      ? 1
      : normalized <= 2
        ? 2
        : normalized <= 2.5
          ? 2.5
          : normalized <= 5
            ? 5
            : 10) * magnitude;
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let tick = niceMin; tick <= niceMax + step / 2; tick += step) {
    ticks.push(Number(tick.toPrecision(12)));
  }
  return { min: niceMin, max: niceMax, ticks };
}

/** 1234 -> "1.2K", 0.456 -> "0.46". */
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  const scaled = (divisor: number, suffix: string) =>
    `${Number((value / divisor).toFixed(1))}${suffix}`;
  if (abs >= 1e12) return scaled(1e12, "T");
  if (abs >= 1e9) return scaled(1e9, "B");
  if (abs >= 1e6) return scaled(1e6, "M");
  if (abs >= 1e4) return scaled(1e3, "K");
  return String(Number(value.toFixed(abs >= 100 ? 0 : 2)));
}

export type FlowShape =
  | "rect"
  | "round"
  | "stadium"
  | "diamond"
  | "circle"
  | "hexagon"
  | "cylinder"
  | "subroutine";

export interface FlowNode {
  readonly id: string;
  readonly label: string;
  readonly shape: FlowShape;
}

export interface FlowEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly style: "solid" | "dashed" | "thick";
  readonly arrow: boolean;
}

export interface Flowchart {
  readonly direction: "LR" | "TD";
  readonly nodes: ReadonlyArray<FlowNode>;
  readonly edges: ReadonlyArray<FlowEdge>;
}

const MAX_NODES = 60;
const MAX_EDGES = 120;

const SHAPES: ReadonlyArray<readonly [open: string, close: string, shape: FlowShape]> = [
  ["([", "])", "stadium"],
  ["[[", "]]", "subroutine"],
  ["[(", ")]", "cylinder"],
  ["((", "))", "circle"],
  ["{{", "}}", "hexagon"],
  ["[", "]", "rect"],
  ["(", ")", "round"],
  ["{", "}", "diamond"],
  [">", "]", "rect"],
];

const NODE_ID = /^[\p{L}\p{N}_][\p{L}\p{N}_]*/u;
const EDGE_WITH_TEXT =
  /^\s*(--|==|-\.)\s*([^\s\-=.>|][^>|]*?)\s*(-{2,}>|={2,}>|\.-*->|-{3,}|={3,}|\.-+)/;
const EDGE = /^\s*<?(-{2,}>|={2,}>|-\.+->|-\.+-|-{3,}|={3,}|--[ox]|~~~)\s*(?:\|([^|]*)\|)?/;
const IGNORED =
  /^(subgraph|end|classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/;

/** Labels keep the line breaks a model writes as <br/>; other runs of space collapse. */
const cleanLabel = (value: string) =>
  value
    .replace(/^"(.*)"$/s, "$1")
    .replaceAll(/<br\s*\/?>/gi, "\n")
    .split("\n")
    .map((line) => line.replaceAll(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

/** Parses `graph`/`flowchart` diagrams; other mermaid diagram types return null. */
export function parseFlowchart(source: string): Flowchart | null {
  const lines = source
    .split(/\n|;/)
    .map((line) => line.replace(/%%.*$/, "").trim())
    .filter((line) => line.length > 0);
  const header = /^(?:graph|flowchart)\b\s*(TB|TD|BT|RL|LR)?/i.exec(lines[0] ?? "");
  if (header === null) return null;
  const orientation = (header[1] ?? "TD").toUpperCase();
  const direction = orientation === "LR" || orientation === "RL" ? "LR" : "TD";
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];

  const rest = [lines[0]!.slice(header[0].length).trim(), ...lines.slice(1)].filter(Boolean);
  for (const line of rest) {
    if (IGNORED.test(line)) continue;
    let cursor = line;

    const readNode = (): string | null => {
      cursor = cursor.trimStart();
      const id = NODE_ID.exec(cursor)?.[0];
      if (id === undefined) return null;
      cursor = cursor.slice(id.length);
      let label: string | undefined;
      let shape: FlowShape = "rect";
      for (const [open, close, kind] of SHAPES) {
        if (!cursor.startsWith(open)) continue;
        const body = cursor.slice(open.length);
        const quoted = body.startsWith('"') ? body.indexOf('"', 1) : -1;
        const end = body.indexOf(close, quoted === -1 ? 0 : quoted + 1);
        if (end === -1) return null;
        label = cleanLabel(body.slice(0, end));
        shape = kind;
        cursor = body.slice(end + close.length);
        break;
      }
      cursor = cursor.replace(/^:::[\w-]+/, "");
      const existing = nodes.get(id);
      if (existing === undefined) {
        if (nodes.size >= MAX_NODES) return null;
        nodes.set(id, { id, label: label || id, shape });
      } else if (label !== undefined) {
        nodes.set(id, { id, label: label || id, shape });
      }
      return id;
    };

    const readGroup = (): string[] | null => {
      const first = readNode();
      if (first === null) return null;
      const group = [first];
      while (/^\s*&/.test(cursor)) {
        cursor = cursor.replace(/^\s*&/, "");
        const next = readNode();
        if (next === null) break;
        group.push(next);
      }
      return group;
    };

    const readEdge = (): Omit<FlowEdge, "from" | "to"> | null => {
      const labelled = EDGE_WITH_TEXT.exec(cursor);
      const plain = labelled === null ? EDGE.exec(cursor) : null;
      const match = labelled ?? plain;
      if (match === null) return null;
      cursor = cursor.slice(match[0].length);
      const operator = labelled === null ? match[1]! : `${match[1]}${match[3]}`;
      const label = cleanLabel((labelled === null ? match[2] : match[2]) ?? "");
      return {
        style: operator.includes("=") ? "thick" : operator.includes(".") ? "dashed" : "solid",
        arrow: operator.endsWith(">"),
        ...(label.length > 0 ? { label } : {}),
      };
    };

    let previous = readGroup();
    while (previous !== null) {
      const edge = readEdge();
      if (edge === null) break;
      const next = readGroup();
      if (next === null) break;
      for (const from of previous) {
        for (const to of next) {
          if (edges.length < MAX_EDGES) edges.push({ from, to, ...edge });
        }
      }
      previous = next;
    }
  }
  return nodes.size === 0 ? null : { direction, nodes: [...nodes.values()], edges };
}

export interface FlowLayoutNode extends FlowNode {
  readonly rank: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly lines: ReadonlyArray<string>;
}

export interface FlowLayoutEdge extends FlowEdge {
  readonly rank: number;
  readonly d: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly labelLines: ReadonlyArray<string>;
  readonly labelWidth: number;
  readonly labelHeight: number;
}

export interface FlowLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: ReadonlyArray<FlowLayoutNode>;
  readonly edges: ReadonlyArray<FlowLayoutEdge>;
}

const WIDE_CHAR = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/** Approximate rendered width of 12px UI text; wide (CJK, Hangul) glyphs count double. */
export function textWidth(value: string): number {
  let width = 0;
  for (const char of value) width += WIDE_CHAR.test(char) ? 12.5 : 7;
  return width;
}

function wrapLabel(label: string, maxWidth: number): string[] {
  return label.split("\n").flatMap((line) => wrapLine(line, maxWidth));
}

function wrapLine(label: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of label.split(" ")) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (textWidth(candidate) <= maxWidth || line.length === 0) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  // A single long word (or a CJK run without spaces) still breaks by characters.
  return lines.flatMap((entry) => {
    if (textWidth(entry) <= maxWidth) return [entry];
    const pieces: string[] = [];
    let piece = "";
    for (const char of entry) {
      if (textWidth(piece + char) > maxWidth && piece.length > 0) {
        pieces.push(piece);
        piece = char;
      } else piece += char;
    }
    if (piece.length > 0) pieces.push(piece);
    return pieces;
  });
}

const RANK_GAP = { LR: 56, TD: 44 } as const;
const NODE_GAP = { LR: 18, TD: 24 } as const;
const LABELLED_NODE_GAP = { LR: 30, TD: 36 } as const;
const EDGE_LABEL_WIDTH = 124;
const EDGE_LINE_HEIGHT = 14;
const PADDING = 16;
const LINE_HEIGHT = 16;
const MAX_LINES = 3;

/** Layered layout: each node sits one rank after its furthest predecessor; cycles are cut. */
export function layoutFlowchart(chart: Flowchart): FlowLayout {
  const ids = chart.nodes.map((node) => node.id);
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of chart.edges) outgoing.get(edge.from)?.push(edge.to);

  // Edges into a node still on the DFS stack close a cycle; ranking ignores them.
  const back = new Set<string>();
  const state = new Map<string, "open" | "done">();
  const visit = (id: string) => {
    state.set(id, "open");
    for (const next of outgoing.get(id) ?? []) {
      const seen = state.get(next);
      if (seen === "open") back.add(`${id}>${next}`);
      else if (seen === undefined) visit(next);
    }
    state.set(id, "done");
  };
  for (const id of ids) if (!state.has(id)) visit(id);

  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass += 1) {
    let changed = false;
    for (const edge of chart.edges) {
      if (back.has(`${edge.from}>${edge.to}`)) continue;
      const next = (rank.get(edge.from) ?? 0) + 1;
      if (next > (rank.get(edge.to) ?? 0)) {
        rank.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const rankCount = Math.max(0, ...rank.values()) + 1;
  const rows: FlowNode[][] = Array.from({ length: rankCount }, () => []);
  for (const node of chart.nodes) rows[rank.get(node.id) ?? 0]!.push(node);
  const position = new Map<string, number>();
  rows.forEach((row, index) => {
    if (index > 0) {
      const weight = (node: FlowNode) => {
        const parents = chart.edges
          .filter((edge) => edge.to === node.id && position.has(edge.from))
          .map((edge) => position.get(edge.from) ?? 0);
        return parents.length === 0
          ? Number.MAX_SAFE_INTEGER
          : parents.reduce((sum, value) => sum + value, 0) / parents.length;
      };
      const original = new Map(row.map((node, order) => [node.id, order]));
      row.sort(
        (a, b) => weight(a) - weight(b) || (original.get(a.id) ?? 0) - (original.get(b.id) ?? 0),
      );
    }
    row.forEach((node, order) => position.set(node.id, order));
  });

  const sized = new Map(
    chart.nodes.map((node) => {
      const lines = wrapLabel(node.label, 150).slice(0, MAX_LINES);
      const contentWidth = Math.max(...lines.map(textWidth));
      const grow = node.shape === "diamond" ? 1.35 : node.shape === "hexagon" ? 1.15 : 1;
      const width = Math.round(Math.min(220, Math.max(76, contentWidth * grow + 28)));
      const height = Math.round(
        Math.max(40, lines.length * LINE_HEIGHT + 22) * (node.shape === "diamond" ? 1.35 : 1),
      );
      return [node.id, { width, height, lines }] as const;
    }),
  );
  const size = (id: string) => sized.get(id) ?? { width: 76, height: 40, lines: [] };

  const labelOf = new Map(
    chart.edges.flatMap((edge, index) => {
      if (edge.label === undefined) return [];
      const lines = wrapLabel(edge.label, EDGE_LABEL_WIDTH).slice(0, MAX_LINES);
      return [
        [
          index,
          {
            lines,
            width: Math.ceil(Math.max(...lines.map(textWidth)) * 0.92 + 16),
            height: lines.length * EDGE_LINE_HEIGHT + 8,
          },
        ] as const,
      ];
    }),
  );
  // A gap between two ranks grows to hold the labels of the edges crossing it.
  const gaps = rows.map((_, index) =>
    Math.max(
      RANK_GAP[chart.direction],
      ...chart.edges.flatMap((edge, edgeIndex) => {
        const label = labelOf.get(edgeIndex);
        if (label === undefined || rank.get(edge.from) !== index) return [];
        return [chart.direction === "LR" ? label.width + 32 : label.height + 28];
      }),
    ),
  );
  const nodeGap = labelOf.size > 0 ? LABELLED_NODE_GAP[chart.direction] : NODE_GAP[chart.direction];
  const across = (row: FlowNode[]) =>
    chart.direction === "LR"
      ? row.reduce((sum, node) => sum + size(node.id).height, 0) +
        Math.max(0, row.length - 1) * nodeGap
      : row.reduce((sum, node) => sum + size(node.id).width, 0) +
        Math.max(0, row.length - 1) * nodeGap;
  const depthOf = (row: FlowNode[]) =>
    Math.max(
      0,
      ...row.map((node) => (chart.direction === "LR" ? size(node.id).width : size(node.id).height)),
    );
  const span = Math.max(0, ...rows.map(across));
  const depths = rows.map(depthOf);

  const placed = new Map<string, FlowLayoutNode>();
  let depthCursor = PADDING;
  rows.forEach((row, index) => {
    const depth = depths[index] ?? 0;
    let acrossCursor = PADDING + (span - across(row)) / 2;
    for (const node of row) {
      const { width, height, lines } = size(node.id);
      const x = chart.direction === "LR" ? depthCursor + (depth - width) / 2 : acrossCursor;
      const y = chart.direction === "LR" ? acrossCursor : depthCursor + (depth - height) / 2;
      placed.set(node.id, { ...node, rank: index, x, y, width, height, lines });
      acrossCursor += (chart.direction === "LR" ? height : width) + nodeGap;
    }
    depthCursor += depth + (gaps[index] ?? RANK_GAP[chart.direction]);
  });
  const totalDepth = depthCursor - (gaps.at(-1) ?? RANK_GAP[chart.direction]) + PADDING;
  const width = chart.direction === "LR" ? totalDepth : span + PADDING * 2;
  const height = chart.direction === "LR" ? span + PADDING * 2 : totalDepth;

  const edges = chart.edges.flatMap((edge, edgeIndex): FlowLayoutEdge[] => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (from === undefined || to === undefined) return [];
    const backward = to.rank <= from.rank;
    let points: [number, number, number, number, number, number, number, number];
    if (chart.direction === "TD") {
      if (backward) {
        const x1 = from.x + from.width;
        const y1 = from.y + from.height / 2;
        const x2 = to.x + to.width;
        const y2 = to.y + to.height / 2;
        const out = Math.max(x1, x2) + 48;
        points = [x1, y1, out, y1, out, y2, x2, y2];
      } else {
        const x1 = from.x + from.width / 2;
        const y1 = from.y + from.height;
        const x2 = to.x + to.width / 2;
        const y2 = to.y;
        const bend = Math.max(18, (y2 - y1) / 2);
        points = [x1, y1, x1, y1 + bend, x2, y2 - bend, x2, y2];
      }
    } else if (backward) {
      const x1 = from.x + from.width / 2;
      const y1 = from.y + from.height;
      const x2 = to.x + to.width / 2;
      const y2 = to.y + to.height;
      const out = Math.max(y1, y2) + 40;
      points = [x1, y1, x1, out, x2, out, x2, y2];
    } else {
      const x1 = from.x + from.width;
      const y1 = from.y + from.height / 2;
      const x2 = to.x;
      const y2 = to.y + to.height / 2;
      const bend = Math.max(18, (x2 - x1) / 2);
      points = [x1, y1, x1 + bend, y1, x2 - bend, y2, x2, y2];
    }
    const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = points;
    const at = (t: number, a: number, b: number, c: number, d: number) =>
      (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;
    // Along the flow the label sits mid-gap; across it, a little toward the target, where sibling
    // edges from one node have spread apart enough for their labels not to collide.
    const alongT = 0.5;
    const acrossT = backward ? 0.5 : 0.64;
    const label = labelOf.get(edgeIndex);
    return [
      {
        ...edge,
        rank: from.rank,
        d: `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`,
        labelX: at(chart.direction === "LR" ? alongT : acrossT, x1, c1x, c2x, x2),
        labelY: at(chart.direction === "LR" ? acrossT : alongT, y1, c1y, c2y, y2),
        labelLines: label?.lines ?? [],
        labelWidth: label?.width ?? 0,
        labelHeight: label?.height ?? 0,
      },
    ];
  });

  // Labels on edges leaving one node are pushed apart across the flow so none overlap.
  const LABEL_SPACING = 4;
  const bySource = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    if (edge.labelLines.length > 0)
      bySource.set(edge.from, [...(bySource.get(edge.from) ?? []), index]);
  });
  for (const indexes of bySource.values()) {
    const across = (edge: FlowLayoutEdge) => (chart.direction === "LR" ? edge.labelY : edge.labelX);
    const half = (edge: FlowLayoutEdge) =>
      (chart.direction === "LR" ? edge.labelHeight : edge.labelWidth) / 2;
    indexes.sort((a, b) => across(edges[a]!) - across(edges[b]!));
    let floor = Number.NEGATIVE_INFINITY;
    for (const index of indexes) {
      const edge = edges[index]!;
      const position = Math.max(across(edge), floor + half(edge) + LABEL_SPACING);
      edges[index] =
        chart.direction === "LR" ? { ...edge, labelY: position } : { ...edge, labelX: position };
      floor = position + half(edge);
    }
  }

  // Edges that point back loop outside the layers: right of a TD chart, below an LR chart.
  const loops = chart.edges.some(
    (edge) => (placed.get(edge.to)?.rank ?? 0) <= (placed.get(edge.from)?.rank ?? 0),
  );
  return {
    width: Math.ceil(width + (loops && chart.direction === "TD" ? 56 : 0)),
    height: Math.ceil(height + (loops && chart.direction === "LR" ? 48 : 0)),
    nodes: [...placed.values()],
    edges,
  };
}
