import { describe, expect, it } from "vite-plus/test";

import {
  boundFlows,
  connectColumns,
  focusWorkflowGraphId,
  layoutWorkflow,
  workflowActivity,
  workflowCounts,
  workflowWaves,
  type WorkflowGraph,
  type WorkflowNode,
} from "./workflowGraph.ts";

const node = (
  id: string,
  state: WorkflowNode["state"],
  info: WorkflowNode["info"] = {},
): WorkflowNode => ({ id, label: id, state, info });

const diamond = {
  waveTitles: [],
  nodes: [
    node("merge", "pending"),
    node("build-b", "running"),
    node("plan", "completed"),
    node("build-a", "completed"),
  ],
  edges: [
    { from: "plan", to: "build-a" },
    { from: "plan", to: "build-b" },
    { from: "build-a", to: "merge" },
    { from: "build-b", to: "merge" },
  ],
};

const graph = (
  id: string,
  status: WorkflowGraph["status"],
  updatedAt: string,
): Pick<WorkflowGraph, "id" | "status" | "updatedAt" | "startedAt"> => ({
  id,
  status,
  updatedAt,
  startedAt: updatedAt,
});

describe("workflow layout", () => {
  it("puts each node one column after its longest upstream chain", () => {
    expect(Object.fromEntries(workflowWaves(diamond.nodes, diamond.edges))).toEqual({
      plan: 0,
      "build-a": 1,
      "build-b": 1,
      merge: 2,
    });
  });

  it("keeps a node in the column it was given", () => {
    const waves = workflowWaves(
      [{ ...node("late", "pending"), wave: 3 }, node("free", "pending")],
      [],
    );
    expect(Object.fromEntries(waves)).toEqual({ late: 3, free: 0 });
  });

  it("counts each column and points at the first one still open", () => {
    const layout = layoutWorkflow(diamond);
    expect(
      layout.waves.map((wave) => [wave.title, wave.total, wave.settled, wave.running]),
    ).toEqual([
      ["Wave 1", 1, 1, 0],
      ["Wave 2", 2, 1, 1],
      ["Wave 3", 1, 0, 0],
    ]);
    expect(layout.currentWave).toBe(1);
  });

  it("marks an edge active only while it feeds a running node", () => {
    const tones = Object.fromEntries(
      layoutWorkflow(diamond).edges.map((edge) => [`${edge.from}>${edge.to}`, edge.tone]),
    );
    expect(tones).toEqual({
      "plan>build-a": "done",
      "plan>build-b": "active",
      "build-a>merge": "done",
      "build-b>merge": "idle",
    });
  });

  it("samples every edge from the source card's right side to the target's left side", () => {
    const layout = layoutWorkflow(diamond);
    const plan = layout.cards.find((card) => card.node.id === "plan");
    const buildA = layout.cards.find((card) => card.node.id === "build-a");
    const edge = layout.edges.find((candidate) => candidate.to === "build-a");
    expect(edge?.flow.xs[0]).toBe((plan?.x ?? 0) + (plan?.width ?? 0));
    expect(edge?.flow.xs.at(-1)).toBeCloseTo(buildA?.x ?? 0);
    expect(edge?.flow.stops.at(-1)).toBe(1);
  });

  it("is empty for a graph without nodes", () => {
    const layout = layoutWorkflow({ nodes: [], edges: [], waveTitles: [] });
    expect([layout.width, layout.height, layout.cards.length]).toEqual([0, 0, 0]);
  });
});

describe("dense columns", () => {
  it("wraps a column past maxRows into a grid joined at its middle", () => {
    const fanOut = Array.from({ length: 25 }, (_, index) => `agent-${index}`);
    const layout = layoutWorkflow({
      waveTitles: [],
      nodes: [
        node("scope", "completed"),
        ...fanOut.map((id) => node(id, id === "agent-3" ? "running" : "completed")),
        node("report", "pending"),
      ],
      edges: [
        ...fanOut.map((id) => ({ from: "scope", to: id })),
        ...fanOut.map((id) => ({ from: id, to: "report" })),
      ],
    });
    const grid = layout.cards.filter((card) => card.wave === 1);
    expect(grid.every((card) => card.mini)).toBe(true);
    expect(new Set(grid.map((card) => card.x)).size).toBe(3);
    expect(layout.waves[1]?.width).toBeGreaterThan(layout.waves[0]?.width ?? 0);
    expect(layout.edges.map((edge) => [edge.from, edge.to, edge.tone])).toEqual([
      ["scope", "wave:1", "active"],
      ["wave:1", "report", "idle"],
    ]);
  });
});

describe("connectColumns", () => {
  it("fans out and in fully", () => {
    expect(connectColumns(["a"], ["x", "y"])).toEqual([
      { from: "a", to: "x" },
      { from: "a", to: "y" },
    ]);
  });

  it("pairs two wide columns so every node keeps an edge without a mesh", () => {
    const from = ["a", "b", "c", "d", "e"];
    const to = ["v", "w", "x", "y", "z"];
    const edges = connectColumns(from, to);
    expect(edges.length).toBe(5);
    expect(new Set(edges.map((edge) => edge.from))).toEqual(new Set(from));
    expect(new Set(edges.map((edge) => edge.to))).toEqual(new Set(to));
  });
});

describe("focus and activity", () => {
  const graphs = [
    graph("old-done", "completed", "2026-10-13T01:00:00.000Z"),
    graph("live", "running", "2026-10-13T02:00:00.000Z"),
    graph("new-done", "completed", "2026-10-13T03:00:00.000Z"),
  ];

  it("keeps the chosen graph, else follows the running one, else the newest", () => {
    expect(focusWorkflowGraphId(graphs, "old-done")).toBe("old-done");
    expect(focusWorkflowGraphId(graphs, "gone")).toBe("live");
    expect(focusWorkflowGraphId([graphs[0]!, graphs[2]!], null)).toBe("new-done");
    expect(focusWorkflowGraphId([], null)).toBeNull();
  });

  it("orders starts, finishes, and live progress newest first", () => {
    const now = Date.parse("2026-10-13T05:00:00.000Z");
    const entries = workflowActivity(
      {
        nodes: [
          node("plan", "completed", {
            startedAt: "2026-10-13T01:00:00.000Z",
            completedAt: "2026-10-13T02:00:00.000Z",
          }),
          node("build", "running", {
            startedAt: "2026-10-13T03:00:00.000Z",
            progress: "Read a.ts",
          }),
        ],
      },
      now,
    );
    expect(entries.map((entry) => entry.key)).toEqual([
      "build:progress",
      "build:start",
      "plan:end",
      "plan:start",
    ]);
    expect(entries.map((entry) => entry.event)).toEqual([
      "progress",
      "started",
      "settled",
      "started",
    ]);
    expect(entries[0]?.detail).toBe("Read a.ts");
  });
});

describe("failure counts", () => {
  const mixed = [
    node("a", "completed"),
    node("b", "completed"),
    node("c", "failed"),
    node("d", "cancelled"),
    node("e", "running"),
    node("f", "pending"),
  ];

  it("counts failures apart from completions", () => {
    expect(workflowCounts(mixed)).toEqual({
      total: 6,
      completed: 2,
      failed: 1,
      stopped: 1,
      running: 1,
    });
  });

  it("carries the split into every column", () => {
    const [wave] = layoutWorkflow({
      waveTitles: [],
      nodes: mixed.map((entry) => ({ ...entry, wave: 0 })),
      edges: [],
    }).waves;
    expect([wave?.settled, wave?.completed, wave?.failed, wave?.running]).toEqual([4, 2, 1, 1]);
  });
});

describe("bounded flow chips", () => {
  const flows = Array.from({ length: 7 }, (_, index) => ({ id: `flow-${6 - index}` }));
  const ids = (list: ReadonlyArray<{ id: string }>) => list.map((flow) => flow.id);

  it("shows the newest four and tucks the rest behind Earlier", () => {
    const { visible, earlier } = boundFlows(flows, null);
    expect(ids(visible)).toEqual(["flow-6", "flow-5", "flow-4", "flow-3"]);
    expect(ids(earlier)).toEqual(["flow-2", "flow-1", "flow-0"]);
  });

  it("keeps an older selected flow visible without duplicating it", () => {
    const { visible, earlier } = boundFlows(flows, "flow-1");
    expect(ids(visible)).toEqual(["flow-6", "flow-5", "flow-4", "flow-3", "flow-1"]);
    expect(ids(earlier)).toEqual(["flow-2", "flow-0"]);
  });

  it("has nothing earlier while the flows fit", () => {
    expect(boundFlows(flows.slice(0, 3), "flow-5").earlier).toEqual([]);
  });
});

describe("elbow edges", () => {
  it("draws orthogonal connectors with a vertical run between columns", () => {
    const layout = layoutWorkflow({
      waveTitles: [],
      nodes: [node("a", "completed"), node("b", "running"), node("c", "pending")],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
    });
    const branch = layout.edges.find((edge) => edge.to === "c");
    expect(branch?.d).toMatch(/^M [\d.]+ [\d.]+ H [\d.]+ Q .* V [\d.]+ Q .* H [\d.]+$/);
    expect(branch?.d).not.toContain(" C ");
    expect(branch?.flow.length).toBeGreaterThan(0);
  });
});
