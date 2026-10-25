import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveAgentPanelModel, foldSubagentActivities } from "./state/subagentRuntime.ts";
import { leadFlowSummary, threadFlows, turnGraphs } from "./threadFlow.ts";
import { focusWorkflowGraphId, layoutWorkflow } from "./workflowGraph.ts";

let sequence = 0;
const activity = (
  kind: string,
  at: string,
  payload: Record<string, unknown>,
  turnId: string | null = "turn-1",
): OrchestrationThreadActivity =>
  ({
    id: `event-${(sequence += 1)}`,
    tone: kind.startsWith("tool.") ? "tool" : "info",
    kind,
    summary: kind,
    payload,
    turnId,
    sequence,
    createdAt: at,
  }) as unknown as OrchestrationThreadActivity;

const tool = (kind: string, at: string, toolCallId: string, toolName: string, status: string) =>
  activity(kind, at, {
    itemType: "dynamic_tool_call",
    toolCallId,
    status,
    title: "Tool call",
    detail: `${toolName}: {}`,
    data: { toolName },
  });

describe("turn flows", () => {
  it("chains sequential tool calls and puts overlapping ones in one column", () => {
    const [graph] = turnGraphs([
      tool("tool.started", "2026-10-14T01:00:00.000Z", "read", "Read", "inProgress"),
      tool("tool.completed", "2026-10-14T01:00:01.000Z", "read", "Read", "completed"),
      tool("tool.started", "2026-10-14T01:00:02.000Z", "search-a", "WebSearch", "inProgress"),
      tool("tool.started", "2026-10-14T01:00:02.500Z", "search-b", "WebSearch", "inProgress"),
      tool("tool.completed", "2026-10-14T01:00:04.000Z", "search-a", "WebSearch", "completed"),
      tool("tool.started", "2026-10-14T01:00:05.000Z", "edit", "Edit", "inProgress"),
    ]);
    expect(graph?.nodes.map((node) => [node.id, node.wave, node.state])).toEqual([
      ["read", 0, "completed"],
      ["search-a", 1, "completed"],
      ["search-b", 1, "running"],
      ["edit", 2, "running"],
    ]);
    expect(graph?.edges).toEqual([
      { from: "read", to: "search-a" },
      { from: "read", to: "search-b" },
      { from: "search-a", to: "edit" },
      { from: "search-b", to: "edit" },
    ]);
    expect(graph?.waveTitles).toEqual(["Step 1", "Step 2 · 2 parallel", "Step 3"]);
    expect(graph?.status).toBe("running");
  });

  it("names a tool call after the agent or workflow it launched and follows its status", () => {
    const [graph] = turnGraphs([
      tool("tool.started", "2026-10-14T01:00:00.000Z", "toolu_1", "Agent", "inProgress"),
      activity("task.started", "2026-10-14T01:00:01.000Z", {
        taskId: "task-1",
        toolUseId: "toolu_1",
        taskType: "local_workflow",
        workflowName: "Deep research",
        title: "Deep research harness",
        model: "claude-opus-5-5",
        effort: "medium",
      }),
      activity("task.completed", "2026-10-14T01:05:00.000Z", {
        taskId: "task-1",
        status: "completed",
        summary: "Report written",
      }),
    ]);
    const [node] = graph?.nodes ?? [];
    expect(node?.label).toBe("Workflow · Deep research");
    expect(node?.state).toBe("completed");
    expect(node?.info.subtitle).toBe("medium · claude-opus-5-5");
    expect(node?.info.completedAt).toBe("2026-10-14T01:05:00.000Z");
  });

  it("names a step after what it does and what it works on", () => {
    const [graph] = turnGraphs([
      // ACP (MiniMax Code): a generic title first, the command only on a later update.
      activity("tool.updated", "2026-10-14T01:00:00.000Z", {
        itemType: "command_execution",
        toolCallId: "run",
        status: "inProgress",
        title: "Ran command",
        data: { toolCallId: "run", kind: "execute" },
      }),
      activity("tool.completed", "2026-10-14T01:00:01.000Z", {
        itemType: "command_execution",
        toolCallId: "run",
        status: "completed",
        title: "Tool",
        detail: "ls -la src",
        data: { toolCallId: "run", kind: "execute", command: "ls -la src" },
      }),
      // Claude, as projected: the raw input is gone, its paths survive in `files`.
      activity("tool.started", "2026-10-14T01:00:02.000Z", {
        itemType: "dynamic_tool_call",
        toolCallId: "read",
        status: "inProgress",
        title: "Tool call",
        detail: 'Read: {"file_path":"/repo/docs/invoice.md"}',
        data: { toolName: "Read", files: [{ path: "/repo/docs/invoice.md" }] },
      }),
      // ACP with a title that repeats the verb.
      activity("tool.updated", "2026-10-14T01:00:03.000Z", {
        itemType: "dynamic_tool_call",
        toolCallId: "acp-read",
        status: "inProgress",
        title: "Read notes.md",
        detail: "Read notes.md",
        data: { toolCallId: "acp-read", kind: "read" },
      }),
      // A command that starts with the verb keeps it.
      activity("tool.updated", "2026-10-14T01:00:04.000Z", {
        itemType: "command_execution",
        toolCallId: "run-build",
        status: "inProgress",
        title: "Ran command",
        data: { toolCallId: "run-build", kind: "execute", command: "run build" },
      }),
    ]);
    expect(graph?.nodes.map((node) => node.label)).toEqual([
      "Run · ls -la src",
      "Read · invoice.md",
      "Read · notes.md",
      "Run · run build",
    ]);
  });

  it("skips tool activity that belongs to no turn", () => {
    expect(
      turnGraphs([
        activity(
          "tool.started",
          "2026-10-14T01:00:00.000Z",
          { toolCallId: "x", status: "inProgress" },
          null,
        ),
      ]),
    ).toEqual([]);
  });
});

describe("workflow flows", () => {
  const workflowActivities = [
    activity("task.started", "2026-10-14T02:00:00.000Z", {
      taskId: "wf",
      taskType: "local_workflow",
      workflowName: "Deep research",
      title: "Deep research harness",
      agentKind: "agent",
    }),
    activity(
      "task.progress",
      "2026-10-14T02:00:01.000Z",
      {
        taskId: "wf",
        taskType: "local_workflow",
        workflowName: "Deep research",
        title: "Deep research harness",
        agentKind: "agent",
        phases: [
          { index: 1, title: "Scope" },
          { index: 2, title: "Search" },
          { index: 3, title: "Synthesize" },
        ],
      },
      null,
    ),
    ...[
      ["wf:1", 1, 1, "scope", "completed"],
      ["wf:2", 2, 2, "search: a", "completed"],
      ["wf:3", 2, 3, "search: b", "running"],
      ["wf:4", 3, 4, "synthesize", "pending"],
    ].map(([taskId, phaseIndex, agentIndex, title, status]) =>
      activity(
        "task.progress",
        "2026-10-14T02:00:02.000Z",
        {
          taskId,
          title,
          status,
          agentKind: "agent",
          parentAgentId: "wf",
          phaseIndex,
          agentIndex,
        },
        null,
      ),
    ),
  ];

  it("lays a workflow out with its phases as titled columns", () => {
    const agents = deriveAgentPanelModel({ agents: foldSubagentActivities(workflowActivities) });
    const [graph] = threadFlows({ activities: workflowActivities, agents }).filter(
      (flow) => flow.kind === "workflow",
    );
    expect(graph?.name).toBe("Deep research");
    expect(graph?.waveTitles).toEqual(["Scope", "Search", "Synthesize"]);
    expect(graph?.nodes.map((node) => [node.label, node.wave])).toEqual([
      ["scope", 0],
      ["search: a", 1],
      ["search: b", 1],
      ["synthesize", 2],
    ]);
    const layout = layoutWorkflow(graph ?? { nodes: [], edges: [], waveTitles: [] });
    expect(layout.waves.map((wave) => wave.title)).toEqual(["Scope", "Search", "Synthesize"]);
    expect(layout.edges.find((edge) => edge.to === "wf:3")?.tone).toBe("active");
  });

  it("focuses the running flow", () => {
    const agents = deriveAgentPanelModel({ agents: foldSubagentActivities(workflowActivities) });
    const flows = threadFlows({ activities: workflowActivities, agents });
    const focused = flows.find((flow) => flow.id === focusWorkflowGraphId(flows, null));
    expect(focused?.status).toBe("running");
  });
});

describe("flows and the running turn", () => {
  const agents = deriveAgentPanelModel({
    agents: foldSubagentActivities([], { sessionLive: false }),
  });
  const crewTask = (kind: string, at: string, taskId: string) =>
    activity(kind, at, {
      taskId,
      title: taskId,
      crewRole: "worker",
      model: "M",
      status: "running",
    });
  const activities = [
    tool("tool.started", "2026-10-14T01:00:00.000Z", "delegate", "crew_delegate", "inProgress"),
    crewTask("task.started", "2026-10-14T01:00:01.000Z", "task-a"),
  ];

  it("settles a finished turn: unreported steps and crew tasks stopped, never done, brain idle", () => {
    const flows = threadFlows({ activities, agents, activeTurnId: null });
    const turn = flows.find((flow) => flow.kind === "turn");
    const crew = flows.find((flow) => flow.kind === "crew");
    expect(turn?.nodes.map((node) => node.state)).toEqual(["cancelled"]);
    expect(turn?.nodes[0]?.info.progress).toBeDefined();
    expect(turn?.status).toBe("cancelled");
    expect(crew?.nodes.map((node) => node.state)).toEqual(["completed", "cancelled"]);
    expect(crew?.nodes.every((node) => node.info.completedAt !== undefined)).toBe(true);
  });

  it("keeps reported completions done when the turn ends", () => {
    const flows = threadFlows({
      activities: [
        tool("tool.started", "2026-10-14T01:00:00.000Z", "read", "Read", "inProgress"),
        tool("tool.completed", "2026-10-14T01:00:01.000Z", "read", "Read", "completed"),
        tool("tool.started", "2026-10-14T01:00:02.000Z", "edit", "Edit", "inProgress"),
      ],
      agents,
      activeTurnId: null,
    });
    const turn = flows.find((flow) => flow.kind === "turn");
    expect(turn?.nodes.map((node) => [node.id, node.state])).toEqual([
      ["read", "completed"],
      ["edit", "cancelled"],
    ]);
    expect(turn?.nodes[0]?.info.progress).toBeUndefined();
  });

  it("keeps an early running step past the step cap and counts the hidden history", () => {
    const at = (second: number) =>
      `2026-10-14T01:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`;
    const history = Array.from({ length: 70 }, (_, index) => [
      tool("tool.started", at(index + 1), `step-${index}`, "Read", "inProgress"),
      tool("tool.completed", at(index + 1), `step-${index}`, "Read", "completed"),
    ]).flat();
    const live = threadFlows({
      activities: [tool("tool.started", at(0), "long-build", "Bash", "inProgress"), ...history],
      agents,
      activeTurnId: "turn-1",
    }).find((flow) => flow.kind === "turn");
    const ids = live?.nodes.map((node) => node.id) ?? [];
    expect(ids).toContain("long-build");
    expect(live?.nodes.find((node) => node.id === "long-build")?.state).toBe("running");
    expect(ids).toHaveLength(60);
    expect(ids.at(-1)).toBe("step-69");
    expect(ids).not.toContain("step-10");
    expect(live?.name).toBe("Turn 1 · 71 steps · 11 older hidden");
    expect(live?.status).toBe("running");
  });

  it("keeps a running turn flowing while its agent thinks between steps", () => {
    const steps = [
      tool("tool.started", "2026-10-14T01:00:00.000Z", "read", "Read", "inProgress"),
      tool("tool.completed", "2026-10-14T01:00:01.000Z", "read", "Read", "completed"),
    ];
    const live = threadFlows({ activities: steps, agents, activeTurnId: "turn-1" });
    const turn = live.find((flow) => flow.kind === "turn");
    expect(turn?.nodes.map((node) => [node.id, node.state, node.wave])).toEqual([
      ["read", "completed", 0],
      ["thinking:turn-1", "running", 1],
    ]);
    expect(turn?.edges).toEqual([{ from: "read", to: "thinking:turn-1" }]);
    expect(turn?.waveTitles.at(-1)).toBe("Next");
    expect(turn?.status).toBe("running");
    const layout = layoutWorkflow(turn ?? { nodes: [], edges: [], waveTitles: [] });
    expect(layout.edges.map((edge) => edge.tone)).toEqual(["active"]);
    expect(leadFlowSummary(live)).toMatchObject({
      state: "thinking",
      steps: 1,
      current: { id: "thinking:turn-1" },
    });

    const working = threadFlows({
      activities: [
        ...steps,
        tool("tool.started", "2026-10-14T01:00:02.000Z", "edit", "Edit", "inProgress"),
      ],
      agents,
      activeTurnId: "turn-1",
    });
    expect(working.find((flow) => flow.kind === "turn")?.nodes.map((node) => node.id)).toEqual([
      "read",
      "edit",
    ]);
    expect(leadFlowSummary(working)).toMatchObject({
      state: "working",
      steps: 2,
      current: { id: "edit", label: "Edit" },
    });

    const ended = threadFlows({ activities: steps, agents, activeTurnId: null });
    expect(ended.find((flow) => flow.kind === "turn")?.nodes.map((node) => node.id)).toEqual([
      "read",
    ]);
    expect(leadFlowSummary(ended)).toMatchObject({ state: "done", steps: 1, current: null });
  });

  it("shows the agent of a running turn that has called no tool yet", () => {
    const flows = threadFlows({
      activities: [],
      agents,
      activeTurnId: "turn-9",
      activeTurnStartedAt: "2026-10-14T03:00:00.000Z",
    });
    expect(flows.map((flow) => flow.nodes.map((node) => [node.id, node.state]))).toEqual([
      [["thinking:turn-9", "running"]],
    ]);
    expect(leadFlowSummary(flows)).toMatchObject({ state: "thinking", steps: 0 });
    expect(leadFlowSummary(threadFlows({ activities: [], agents, activeTurnId: null }))).toBe(null);
  });

  it("keeps the brain and its crew working while their turn runs", () => {
    const crew = threadFlows({ activities, agents, activeTurnId: "turn-1" }).find(
      (flow) => flow.kind === "crew",
    );
    expect(crew?.nodes.map((node) => node.state)).toEqual(["running", "running"]);
  });
});
