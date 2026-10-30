import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveAgentPanelModel, foldSubagentActivities } from "./state/subagentRuntime.ts";
import {
  actorFlows,
  leadFlowSummary,
  threadFlows,
  toolCategory,
  toolCounts,
  turnGraphs,
} from "./threadFlow.ts";
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
    expect(graph?.waveTitles).toEqual(["Step 1", "Step 2", "Step 3"]);
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

describe("crew board evidence and usage", () => {
  const agents = deriveAgentPanelModel({
    agents: foldSubagentActivities([], { sessionLive: false }),
  });
  const task = (kind: string, at: string, taskId: string, extra: Record<string, unknown> = {}) =>
    activity(kind, at, {
      taskId,
      title: taskId,
      crewRole: taskId.startsWith("audit") ? "auditor" : "worker",
      model: "M",
      status: kind === "task.completed" ? "completed" : "running",
      ...extra,
    });
  const crewOf = (activities: OrchestrationThreadActivity[]) => {
    const crew = threadFlows({ activities, agents, activeTurnId: null }).find(
      (flow) => flow.kind === "crew",
    );
    return {
      node: (id: string) => crew?.nodes.find((candidate) => candidate.id === id),
      brain: crew?.nodes.find((candidate) => candidate.id.startsWith("brain:")),
    };
  };

  it("labels results by what backs them and totals the turn's usage", () => {
    const crew = crewOf([
      task("task.started", "2026-10-14T01:00:00.000Z", "a", { threadId: "thread-a" }),
      task("task.started", "2026-10-14T01:00:00.500Z", "b", { threadId: "thread-b" }),
      task("task.started", "2026-10-14T01:00:00.600Z", "c", { threadId: "thread-c" }),
      task("task.completed", "2026-10-14T01:00:01.000Z", "a", {
        threadId: "thread-a",
        tested: true,
        usage: { inputTokens: 1000, outputTokens: 234, costUsd: 0.42 },
      }),
      task("task.completed", "2026-10-14T01:00:02.000Z", "b", {
        threadId: "thread-b",
        usage: { inputTokens: 500, outputTokens: 100 },
      }),
      task("task.completed", "2026-10-14T01:00:02.500Z", "c", {
        threadId: "thread-c",
        status: "blocked",
      }),
      task("task.started", "2026-10-14T01:00:03.000Z", "audit-1"),
      task("task.completed", "2026-10-14T01:00:04.000Z", "audit-1", { verdict: "approve" }),
    ]);

    expect(crew.node("a")?.info).toMatchObject({
      evidence: "audited",
      tokens: 1234,
      costUsd: 0.42,
      crew: { taskId: "a", threadId: "thread-a", outcome: "completed" },
    });
    expect(crew.node("b")?.info.costUsd).toBeUndefined();
    expect(crew.node("c")?.state).toBe("failed");
    expect(crew.node("c")?.info.evidence).toBeUndefined();
    expect(crew.brain?.info).toMatchObject({ tokens: 1834, costUsd: 0.42, unpriced: true });
  });

  it("labels an unaudited result tested or reported, and leaves a running task unlabeled", () => {
    const crew = crewOf([
      task("task.started", "2026-10-14T01:00:00.000Z", "a", { threadId: "thread-a" }),
      task("task.started", "2026-10-14T01:00:00.500Z", "b", { threadId: "thread-b" }),
      task("task.started", "2026-10-14T01:00:00.600Z", "c", { threadId: "thread-c" }),
      task("task.completed", "2026-10-14T01:00:01.000Z", "a", { tested: true }),
      task("task.completed", "2026-10-14T01:00:02.000Z", "b"),
    ]);

    expect(crew.node("a")?.info.evidence).toBe("tested");
    expect(crew.node("b")?.info.evidence).toBe("reported");
    expect(crew.node("c")?.info).toMatchObject({ crew: { taskId: "c", threadId: "thread-c" } });
    expect(crew.node("c")?.info.evidence).toBeUndefined();
    expect(crew.brain?.info.tokens).toBeUndefined();
  });
});

describe("tool categories", () => {
  it("counts a tool the way a person would", () => {
    expect(toolCategory("Bash")).toBe("run");
    expect(toolCategory("Read")).toBe("read");
    expect(toolCategory("MultiEdit")).toBe("edit");
    expect(toolCategory("Grep")).toBe("search");
    expect(toolCategory("mcp__web__WebFetch")).toBe("web");
    expect(toolCategory("Tool", "execute")).toBe("run");
    expect(toolCategory("Tool", undefined, "file_change")).toBe("edit");
    expect(toolCategory("Frobnicate")).toBe("other");
    // Launching an agent and crew plumbing are not tool work.
    expect(toolCategory("Agent")).toBeNull();
    expect(toolCategory("mcp__t3-code__crew_delegate")).toBeNull();
  });

  it("totals categories in a fixed order and skips what nothing used", () => {
    expect(toolCounts(["search", "read", null, "read", "run", undefined, "search"])).toEqual([
      { category: "read", count: 2 },
      { category: "run", count: 1 },
      { category: "search", count: 2 },
    ]);
  });
});

describe("agent flows", () => {
  const agents = deriveAgentPanelModel({
    agents: foldSubagentActivities([], { sessionLive: false }),
  });
  const at = (second: number) => `2026-10-14T01:00:${String(second).padStart(2, "0")}.000Z`;
  const done = (second: number, id: string, name: string) => [
    tool("tool.started", at(second), id, name, "inProgress"),
    tool("tool.completed", at(second), id, name, "completed"),
  ];
  const toolWork = [
    ...done(1, "r1", "Read"),
    ...done(2, "r2", "Read"),
    ...done(3, "b1", "Bash"),
    ...done(4, "e1", "Edit"),
    ...done(5, "g1", "Grep"),
  ];

  it("draws a plain turn as the main agent, with what it did counted by category", () => {
    const flows = actorFlows({
      activities: toolWork,
      agents,
      activeTurnId: null,
      leadModel: "claude-opus-5-5",
    });
    expect(flows).toHaveLength(1);
    const [flow] = flows;
    expect(flow).toMatchObject({
      id: "turn:turn-1",
      kind: "turn",
      turnIndex: 1,
      status: "completed",
    });
    expect(flow?.nodes).toHaveLength(1);
    const main = flow?.nodes[0];
    expect(main).toMatchObject({ state: "completed", info: { model: "claude-opus-5-5" } });
    expect(main?.info.actor).toEqual({
      role: "main",
      tools: [
        { category: "read", count: 2 },
        { category: "run", count: 1 },
        { category: "edit", count: 1 },
        { category: "search", count: 1 },
      ],
    });
    // The per-tool graph stays reachable, and the card text holds no command or path.
    expect(flow?.steps?.nodes).toHaveLength(5);
    expect(JSON.stringify(flow?.nodes)).not.toContain("Bash");
  });

  it("says what the main agent does now while its turn runs", () => {
    const running = (extra: OrchestrationThreadActivity[]) =>
      actorFlows({
        activities: [...done(1, "r1", "Read"), ...extra],
        agents,
        activeTurnId: "turn-1",
      })[0]?.nodes[0];
    expect(running([])?.info.actor?.doing).toBe("thinking");
    expect(running([tool("tool.started", at(2), "b1", "Bash", "inProgress")])).toMatchObject({
      state: "running",
      info: { actor: { doing: "run" } },
    });
    expect(running([])?.info.completedAt).toBeUndefined();
  });

  it("shows a running turn that has called no tool yet", () => {
    const [flow] = actorFlows({
      activities: [],
      agents,
      activeTurnId: "turn-9",
      activeTurnStartedAt: at(0),
    });
    expect(flow).toMatchObject({ turnIndex: 1, status: "running", startedAt: at(0) });
    expect(flow?.nodes[0]?.info.actor).toMatchObject({
      role: "main",
      tools: [],
      doing: "thinking",
    });
  });

  it("merges a turn's crew into its one flow: main agent, workers, auditor", () => {
    const crewTask = (kind: string, second: number, taskId: string, extra = {}) =>
      activity(kind, at(second), {
        taskId,
        title: `task ${taskId}`,
        crewRole: taskId === "audit" ? "auditor" : "worker",
        model: "GPT-6.1-Sol",
        status: kind === "task.completed" ? "completed" : "running",
        ...extra,
      });
    const flows = actorFlows({
      activities: [
        ...toolWork,
        ...done(6, "d1", "crew_delegate"),
        crewTask("task.started", 6, "a"),
        crewTask("task.started", 7, "b"),
        crewTask("task.completed", 8, "a"),
        crewTask("task.completed", 9, "b", { status: "blocked" }),
        crewTask("task.started", 10, "audit"),
        crewTask("task.completed", 11, "audit", { verdict: "approve" }),
      ],
      agents,
      activeTurnId: null,
    });
    // One turn is one flow, however many crew tasks it ran.
    expect(flows).toHaveLength(1);
    const [flow] = flows;
    expect(flow?.kind).toBe("crew");
    expect(flow?.nodes.map((node) => [node.info.actor?.role, node.wave, node.state])).toEqual([
      ["main", 0, "completed"],
      ["worker", 1, "completed"],
      ["worker", 1, "failed"],
      ["auditor", 2, "completed"],
    ]);
    expect(flow?.nodes[1]?.info.actor?.task).toBe("task a");
    expect(flow?.nodes[2]?.info.crew?.outcome).toBe("blocked");
    // The auditor reviews on its own; only the two workers were handed tasks.
    expect(flow?.nodes[0]?.info.actor?.delegated).toBe(2);
    expect(flow?.waveTitles).toEqual(["Main agent", "Delegated work", "Review"]);
    expect(flow?.edges).toHaveLength(4);
    expect(flow?.status).toBe("failed");
    // Crew plumbing does not count as the main agent's own work.
    expect(flow?.nodes[0]?.info.actor?.tools?.map((count) => count.category)).toEqual([
      "read",
      "run",
      "edit",
      "search",
    ]);
  });

  it("draws a launched subagent as an agent of its own and stops it with its turn", () => {
    const launch = [
      tool("tool.started", at(1), "toolu_1", "Agent", "inProgress"),
      activity("task.started", at(2), {
        taskId: "sub",
        toolUseId: "toolu_1",
        agentKind: "agent",
        title: "Check the invoice totals",
        model: "claude-haiku-5",
      }),
    ];
    const live = actorFlows({ activities: launch, agents, activeTurnId: "turn-1" })[0];
    expect(live?.nodes.map((node) => [node.info.actor?.role, node.state])).toEqual([
      ["main", "running"],
      ["subagent", "running"],
    ]);
    expect(live?.nodes[1]?.info).toMatchObject({
      model: "claude-haiku-5",
      actor: { role: "subagent", task: "Check the invoice totals" },
    });
    expect(live?.nodes[0]?.info.actor?.doing).toBe("waiting");

    const ended = actorFlows({ activities: launch, agents, activeTurnId: null })[0];
    expect(ended?.nodes.map((node) => node.state)).toEqual(["completed", "cancelled"]);
    expect(ended?.nodes[1]?.info.completedAt).toBeDefined();
  });

  it("numbers turns oldest first and lists the newest flow first", () => {
    const second = (activityItem: OrchestrationThreadActivity): OrchestrationThreadActivity => ({
      ...activityItem,
      turnId: "turn-2" as OrchestrationThreadActivity["turnId"],
    });
    const flows = actorFlows({
      activities: [...done(1, "a", "Read"), ...done(30, "b", "Read").map(second)],
      agents,
      activeTurnId: null,
    });
    expect(flows.map((flow) => [flow.turnId, flow.turnIndex])).toEqual([
      ["turn-2", 2],
      ["turn-1", 1],
    ]);
  });

  it("keeps counting every tool call after the step graph starts hiding old ones", () => {
    const many = Array.from({ length: 80 }, (_, index) =>
      done(1, `call-${index}`, "Read").map((entry) => ({
        ...entry,
        createdAt: `2026-10-14T01:${String(Math.floor(index / 60) + 1).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      })),
    ).flat();
    const [flow] = actorFlows({ activities: many, agents, activeTurnId: null });
    expect(flow?.nodes[0]?.info.actor?.tools).toEqual([{ category: "read", count: 80 }]);
    expect(flow?.steps?.stepCount).toBe(80);
    expect(flow?.steps?.nodes).toHaveLength(60);
  });
});
