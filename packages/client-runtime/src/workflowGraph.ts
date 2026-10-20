/**
 * A directed work graph and its board layout, shared by every client that draws one. Pure: no
 * rendering, no clocks; callers pass `now`.
 *
 * The layout is adapted from MIT-licensed code:
 *
 * Copyright (c) 2026 Hakubisual
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
 * OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

export type WorkflowNodeState =
  | "pending"
  | "blocked"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export interface WorkflowNodeInfo {
  readonly subtitle?: string;
  readonly model?: string;
  readonly description?: string;
  readonly progress?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly tokens?: number;
  readonly toolUses?: number;
  readonly error?: string;
}

export interface WorkflowNode {
  readonly id: string;
  readonly label: string;
  readonly state: WorkflowNodeState;
  /** Fixed column; when absent the node sits one column after its furthest upstream node. */
  readonly wave?: number;
  readonly info: WorkflowNodeInfo;
}

export interface WorkflowEdge {
  readonly from: string;
  readonly to: string;
}

export interface WorkflowGraph {
  readonly id: string;
  readonly kind: "workflow" | "turn" | "crew";
  /** The lead turn a turn or crew graph belongs to; provider workflows outlive turns. */
  readonly turnId?: string;
  readonly name: string;
  readonly status: WorkflowNodeState;
  readonly startedAt: string;
  readonly updatedAt: string;
  /** Column titles by wave index; untitled columns read "Wave n". */
  readonly waveTitles: ReadonlyArray<string>;
  readonly nodes: ReadonlyArray<WorkflowNode>;
  readonly edges: ReadonlyArray<WorkflowEdge>;
}

const SETTLED: ReadonlySet<WorkflowNodeState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);
const LIVE: ReadonlySet<WorkflowNodeState> = new Set(["running", "blocked", "paused", "pending"]);

export const isSettledState = (state: WorkflowNodeState): boolean => SETTLED.has(state);

export interface WorkflowMetrics {
  readonly cardWidth: number;
  readonly cardHeight: number;
  /** A column holding more cards than this wraps into a grid of one-line cards. */
  readonly maxRows: number;
  readonly miniCardHeight: number;
  readonly colGap: number;
  readonly rowGap: number;
  readonly headerHeight: number;
  readonly padding: number;
}

export const WORKFLOW_METRICS: WorkflowMetrics = {
  cardWidth: 200,
  cardHeight: 84,
  maxRows: 10,
  miniCardHeight: 30,
  colGap: 56,
  rowGap: 14,
  headerHeight: 30,
  padding: 20,
};

export const COMPACT_WORKFLOW_METRICS: WorkflowMetrics = {
  cardWidth: 164,
  cardHeight: 84,
  maxRows: 10,
  miniCardHeight: 30,
  colGap: 36,
  rowGap: 10,
  headerHeight: 30,
  padding: 10,
};

export type WorkflowEdgeTone = "done" | "active" | "failed" | "idle";

export interface WorkflowCard {
  readonly node: WorkflowNode;
  readonly wave: number;
  readonly mini: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WorkflowWave {
  readonly index: number;
  readonly title: string;
  readonly total: number;
  readonly settled: number;
  readonly running: number;
  readonly x: number;
  readonly width: number;
}

/** Sampled points along an edge with 0..1 distance stops, for animating along it. */
export interface WorkflowFlowPath {
  readonly xs: ReadonlyArray<number>;
  readonly ys: ReadonlyArray<number>;
  readonly stops: ReadonlyArray<number>;
  readonly length: number;
}

export interface WorkflowEdgeLayout {
  readonly from: string;
  readonly to: string;
  readonly tone: WorkflowEdgeTone;
  readonly d: string;
  readonly flow: WorkflowFlowPath;
}

export interface WorkflowLayout {
  readonly waves: ReadonlyArray<WorkflowWave>;
  readonly cards: ReadonlyArray<WorkflowCard>;
  readonly edges: ReadonlyArray<WorkflowEdgeLayout>;
  readonly width: number;
  readonly height: number;
  readonly currentWave: number;
  readonly settled: number;
  readonly total: number;
}

function upstreamOf(edges: ReadonlyArray<WorkflowEdge>): Map<string, string[]> {
  const upstream = new Map<string, string[]>();
  for (const edge of edges) upstream.set(edge.to, [...(upstream.get(edge.to) ?? []), edge.from]);
  return upstream;
}

/** Fixed waves win; otherwise the longest upstream chain, with a cycle falling back to 0. */
export function workflowWaves(
  nodes: ReadonlyArray<WorkflowNode>,
  edges: ReadonlyArray<WorkflowEdge>,
): Map<string, number> {
  const upstream = upstreamOf(edges);
  const fixed = new Map(
    nodes.flatMap((node) => (node.wave === undefined ? [] : [[node.id, node.wave]])),
  );
  const waves = new Map<string, number>();
  const visit = (id: string, trail: Set<string>): number => {
    const known = waves.get(id) ?? fixed.get(id);
    if (known !== undefined) {
      waves.set(id, known);
      return known;
    }
    if (trail.has(id)) return 0;
    trail.add(id);
    let wave = 0;
    for (const up of upstream.get(id) ?? []) wave = Math.max(wave, visit(up, trail) + 1);
    trail.delete(id);
    waves.set(id, wave);
    return wave;
  };
  for (const node of nodes) visit(node.id, new Set());
  return waves;
}

/**
 * Edges from one column to the next. Fan-out and fan-in connect fully; two wide columns pair up
 * so each node keeps one incoming and one outgoing edge instead of a dense mesh.
 */
export function connectColumns(
  from: ReadonlyArray<string>,
  to: ReadonlyArray<string>,
): WorkflowEdge[] {
  if (from.length === 0 || to.length === 0) return [];
  const edges = new Map<string, WorkflowEdge>();
  const add = (source: string | undefined, target: string | undefined) => {
    if (source !== undefined && target !== undefined) {
      edges.set(`${source}\u0000${target}`, { from: source, to: target });
    }
  };
  if (from.length === 1 || to.length === 1 || from.length * to.length <= 12) {
    for (const source of from) for (const target of to) add(source, target);
  } else {
    from.forEach((source, index) => add(source, to[Math.floor((index * to.length) / from.length)]));
    to.forEach((target, index) => add(from[Math.floor((index * from.length) / to.length)], target));
  }
  return [...edges.values()];
}

function edgeTone(
  from: { readonly state: WorkflowNodeState },
  to: { readonly state: WorkflowNodeState },
): WorkflowEdgeTone {
  if (to.state === "running") return "active";
  if (from.state === "failed") return "failed";
  if (from.state === "completed") return "done";
  return "idle";
}

const ELBOW_RADIUS = 8;

/**
 * An orthogonal connector: out horizontally, down or up at the midpoint, then in horizontally,
 * with rounded corners. Edges fanning out of one card share the vertical run, so a fan-out reads
 * as a tree. `flow` samples the same shape for the draw-in animation length.
 */
function elbowPath(x1: number, y1: number, x2: number, y2: number) {
  const midX = x1 + (x2 - x1) / 2;
  const dy = y2 - y1;
  const radius = Math.min(ELBOW_RADIUS, Math.abs(dy) / 2, Math.max(0, (x2 - x1) / 2));
  if (Math.abs(dy) < 0.5 || radius <= 0) {
    return {
      d: `M ${x1} ${y1} L ${x2} ${y2}`,
      flow: polylineFlow([
        [x1, y1],
        [x2, y2],
      ]),
    };
  }
  const sign = dy > 0 ? 1 : -1;
  const d = [
    `M ${x1} ${y1}`,
    `H ${midX - radius}`,
    `Q ${midX} ${y1} ${midX} ${y1 + sign * radius}`,
    `V ${y2 - sign * radius}`,
    `Q ${midX} ${y2} ${midX + radius} ${y2}`,
    `H ${x2}`,
  ].join(" ");
  return {
    d,
    flow: polylineFlow([
      [x1, y1],
      [midX, y1],
      [midX, y2],
      [x2, y2],
    ]),
  };
}

function polylineFlow(points: ReadonlyArray<readonly [number, number]>): WorkflowFlowPath {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const distances = [0];
  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) {
    travelled += Math.hypot(xs[index]! - xs[index - 1]!, ys[index]! - ys[index - 1]!);
    distances.push(travelled);
  }
  return {
    xs,
    ys,
    stops: distances.map((distance) => (travelled > 0 ? distance / travelled : 0)),
    length: travelled,
  };
}

export function layoutWorkflow(
  graph: Pick<WorkflowGraph, "nodes" | "edges" | "waveTitles">,
  metrics: WorkflowMetrics = WORKFLOW_METRICS,
  viewportWidth = 0,
): WorkflowLayout {
  const { cardWidth, cardHeight, maxRows, miniCardHeight, colGap, rowGap, headerHeight, padding } =
    metrics;
  const waveById = workflowWaves(graph.nodes, graph.edges);
  const waveCount = graph.nodes.length === 0 ? 0 : Math.max(...waveById.values()) + 1;

  // Each column follows the rows of its upstream cards, so edges cross less.
  const upstream = upstreamOf(graph.edges);
  const rowById = new Map<string, number>();
  const columns: WorkflowNode[][] = Array.from({ length: waveCount }, () => []);
  for (const node of graph.nodes) columns[waveById.get(node.id) ?? 0]?.push(node);
  columns.forEach((column, wave) => {
    if (wave > 0) {
      const weight = (node: WorkflowNode) => {
        const rows = (upstream.get(node.id) ?? []).map((id) => rowById.get(id) ?? 0);
        return rows.length === 0
          ? Number.MAX_SAFE_INTEGER
          : rows.reduce((sum, row) => sum + row, 0) / rows.length;
      };
      const original = new Map(column.map((node, index) => [node.id, index]));
      column.sort(
        (a, b) => weight(a) - weight(b) || (original.get(a.id) ?? 0) - (original.get(b.id) ?? 0),
      );
    }
    column.forEach((node, row) => rowById.set(node.id, row));
  });

  const dense = columns.map((column) => column.length > maxRows);
  const waveWidths = columns.map((column, index) => {
    const subColumns = dense[index] ? Math.ceil(column.length / maxRows) : 1;
    return subColumns * cardWidth + (subColumns - 1) * rowGap;
  });
  const columnHeights = columns.map((column, index) => {
    const rows = dense[index] ? maxRows : column.length;
    const rowHeight = dense[index] ? miniCardHeight : cardHeight;
    return rows * rowHeight + Math.max(0, rows - 1) * rowGap;
  });
  const naturalWidth =
    waveCount === 0
      ? 0
      : padding * 2 + waveWidths.reduce((sum, width) => sum + width, 0) + (waveCount - 1) * colGap;
  const offsetX = viewportWidth > naturalWidth ? Math.floor((viewportWidth - naturalWidth) / 2) : 0;
  const top = padding + headerHeight;
  const height = waveCount === 0 ? 0 : padding * 2 + headerHeight + Math.max(0, ...columnHeights);

  const cards: WorkflowCard[] = [];
  let nextX = offsetX + padding;
  const waves: WorkflowWave[] = columns.map((column, index) => {
    const x = nextX;
    const mini = dense[index] === true;
    const rowHeight = mini ? miniCardHeight : cardHeight;
    column.forEach((node, position) => {
      const subColumn = mini ? Math.floor(position / maxRows) : 0;
      const row = mini ? position % maxRows : position;
      cards.push({
        node,
        wave: index,
        mini,
        x: x + subColumn * (cardWidth + rowGap),
        y: top + row * (rowHeight + rowGap),
        width: cardWidth,
        height: rowHeight,
      });
    });
    const width = waveWidths[index] ?? cardWidth;
    nextX += width + colGap;
    return {
      index,
      title: graph.waveTitles[index] ?? `Wave ${index + 1}`,
      total: column.length,
      settled: column.filter((node) => isSettledState(node.state)).length,
      running: column.filter((node) => node.state === "running").length,
      x,
      width,
    };
  });

  // A grid column is joined at its middle instead of card by card, so dozens of edges do not
  // cross its cards.
  interface Anchor {
    readonly id: string;
    readonly state: WorkflowNodeState;
    readonly left: readonly [number, number];
    readonly right: readonly [number, number];
  }
  const waveAnchor = (index: number): Anchor => {
    const wave = waves[index];
    const column = columns[index] ?? [];
    const y = top + (columnHeights[index] ?? 0) / 2;
    const state: WorkflowNodeState = column.some((node) => node.state === "running")
      ? "running"
      : column.some((node) => node.state === "failed")
        ? "failed"
        : column.every((node) => node.state === "completed")
          ? "completed"
          : "pending";
    return {
      id: `wave:${index}`,
      state,
      left: [wave?.x ?? 0, y],
      right: [(wave?.x ?? 0) + (wave?.width ?? 0), y],
    };
  };
  const cardById = new Map(cards.map((card) => [card.node.id, card]));
  const anchorOf = (id: string): Anchor | undefined => {
    const card = cardById.get(id);
    if (card === undefined) return undefined;
    if (card.mini) return waveAnchor(card.wave);
    const y = card.y + card.height / 2;
    return { id, state: card.node.state, left: [card.x, y], right: [card.x + card.width, y] };
  };
  const edges: WorkflowEdgeLayout[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const from = anchorOf(edge.from);
    const to = anchorOf(edge.to);
    if (from === undefined || to === undefined || from.id === to.id) continue;
    const key = `${from.id}>${to.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [x1, y1] = from.right;
    const [x2, y2] = to.left;
    const elbow = elbowPath(x1, y1, x2, y2);
    edges.push({
      from: from.id,
      to: to.id,
      tone: edgeTone(from, to),
      d: elbow.d,
      flow: elbow.flow,
    });
  }

  const open = waves.findIndex((wave) => wave.settled < wave.total);
  return {
    waves,
    cards,
    edges,
    width: offsetX + naturalWidth,
    height,
    currentWave: open === -1 ? Math.max(0, waveCount - 1) : open,
    settled: graph.nodes.filter((node) => isSettledState(node.state)).length,
    total: graph.nodes.length,
  };
}

/** The graph to show: the one asked for, else the newest still moving, else the newest. */
export function focusWorkflowGraphId(
  graphs: ReadonlyArray<Pick<WorkflowGraph, "id" | "status" | "updatedAt" | "startedAt">>,
  preferredId: string | null,
): string | null {
  if (preferredId !== null && graphs.some((graph) => graph.id === preferredId)) return preferredId;
  const newest = [...graphs].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.startedAt.localeCompare(a.startedAt),
  );
  return (
    newest.find((graph) => graph.status === "running")?.id ??
    newest.find((graph) => LIVE.has(graph.status))?.id ??
    newest[0]?.id ??
    null
  );
}

export function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function nodeElapsedMs(info: WorkflowNodeInfo, now: number): number | undefined {
  if (info.startedAt === undefined) return undefined;
  const start = Date.parse(info.startedAt);
  const end = info.completedAt === undefined ? now : Date.parse(info.completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
}

export interface WorkflowActivityEntry {
  readonly key: string;
  readonly at: number;
  readonly nodeId: string;
  readonly state: WorkflowNodeState | null;
  readonly text: string;
}

/** Starts, finishes, errors, and live progress, newest first. */
export function workflowActivity(
  graph: Pick<WorkflowGraph, "nodes">,
  now: number,
  limit = 40,
): WorkflowActivityEntry[] {
  const entries: WorkflowActivityEntry[] = [];
  for (const node of graph.nodes) {
    const { info } = node;
    const started = info.startedAt === undefined ? Number.NaN : Date.parse(info.startedAt);
    const ended = info.completedAt === undefined ? Number.NaN : Date.parse(info.completedAt);
    if (Number.isFinite(started)) {
      entries.push({
        key: `${node.id}:start`,
        at: started,
        nodeId: node.id,
        state: "running",
        text: `${node.label} started`,
      });
    }
    if (isSettledState(node.state) && Number.isFinite(ended)) {
      entries.push({
        key: `${node.id}:end`,
        at: ended,
        nodeId: node.id,
        state: node.state,
        text: `${node.label} ${node.state}`,
      });
      if (info.error !== undefined) {
        entries.push({
          key: `${node.id}:error`,
          at: ended,
          nodeId: node.id,
          state: null,
          text: `${node.label}: ${info.error}`,
        });
      }
    }
    if (node.state === "running" && info.progress !== undefined) {
      entries.push({
        key: `${node.id}:progress`,
        at: now,
        nodeId: node.id,
        state: null,
        text: `${node.label}: ${info.progress}`,
      });
    }
  }
  return entries.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key)).slice(0, limit);
}
