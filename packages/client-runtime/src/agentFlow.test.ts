import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentFlow, LEAD_AGENT_ID } from "./agentFlow.ts";
import { deriveAgentPanelModel, foldSubagentActivities } from "./state/subagentRuntime.ts";

let sequence = 0;
const activity = (
  kind: string,
  at: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity =>
  ({
    id: `event-${(sequence += 1)}`,
    tone: kind.startsWith("tool.") ? "tool" : "info",
    kind,
    summary: kind,
    payload,
    turnId: "turn-1",
    sequence,
    createdAt: at,
  }) as unknown as OrchestrationThreadActivity;

const step = (at: string, id: string, kind: string, command: string, status: string) =>
  activity(status === "completed" ? "tool.completed" : "tool.updated", at, {
    itemType: "command_execution",
    toolCallId: id,
    status,
    title: "Tool",
    data: { toolCallId: id, kind, command },
  });

const activities = [
  step("2026-10-19T01:00:00.000Z", "s1", "read", "cat docs/spec.md", "completed"),
  activity("task.started", "2026-10-19T01:00:05.000Z", {
    taskId: "crew-1",
    title: "Implement invoice totals",
    agentKind: "agent",
    crewRole: "worker",
    model: "GPT-6.1-Sol",
    providerInstanceId: "codex",
    status: "running",
  }),
  activity("task.started", "2026-10-19T01:00:06.000Z", {
    taskId: "sub-1",
    title: "Write spec tests",
    agentKind: "agent",
    taskType: "local_agent",
    model: "claude-opus-5-5",
  }),
  step("2026-10-19T01:00:10.000Z", "s2", "execute", "npm test", "completed"),
  activity("task.completed", "2026-10-19T01:00:20.000Z", { taskId: "sub-1", status: "completed" }),
];

const flowOf = (activeTurnId: string | null) =>
  agentFlow({
    activities,
    agents: deriveAgentPanelModel({ agents: foldSubagentActivities(activities) }),
    activeTurnId,
    activeTurnStartedAt: "2026-10-19T00:59:59.000Z",
    lead: { model: "claude-opus-5-5", instanceId: "claudeAgent" },
  });

describe("agentFlow", () => {
  it("lists the lead, its crew, and its subagents with who runs them", () => {
    const { agents } = flowOf("turn-1");
    expect(
      agents.map((agent) => [agent.id, agent.kind, agent.name, agent.instanceId, agent.state]),
    ).toEqual([
      [LEAD_AGENT_ID, "lead", "Lead", "claudeAgent", "thinking"],
      ["crew-1", "crew", "Worker", "codex", "working"],
      ["sub-1", "subagent", "Subagent", "claudeAgent", "done"],
    ]);
    expect(agents.find((agent) => agent.id === "crew-1")?.summary).toBe("Worker working");
    expect(agents.find((agent) => agent.id === "sub-1")?.summary).toBe("Subagent finished");
  });

  it("lays the turn out in order and keeps flowing while the lead thinks", () => {
    const { boxes } = flowOf("turn-1");
    expect(
      boxes.map((box) => [box.agentId, box.tools?.map((tool) => tool.category) ?? box.title]),
    ).toEqual([
      [LEAD_AGENT_ID, ["read"]],
      ["crew-1", "Implement invoice totals"],
      ["sub-1", "Write spec tests"],
      [LEAD_AGENT_ID, ["run"]],
      [LEAD_AGENT_ID, "Working out the next step"],
    ]);
    expect(boxes.at(-1)).toMatchObject({ state: "thinking", doing: "thinking" });
    // No command or file path reaches the boxes.
    expect(JSON.stringify(boxes)).not.toContain("npm test");
  });

  it("sums up a finished turn by category, never by command", () => {
    const { agents, boxes } = flowOf(null);
    expect(agents[0]).toMatchObject({
      summary: "Finished the turn · 2 steps",
      state: "done",
      tools: [
        { category: "read", count: 1 },
        { category: "run", count: 1 },
      ],
    });
    expect(agents[0]?.doing).toBeUndefined();
    expect(boxes.at(-1)?.state).toBe("done");
  });

  it("tells what the lead does right now while its turn runs", () => {
    expect(flowOf("turn-1").agents[0]).toMatchObject({ state: "thinking", doing: "thinking" });
  });
});
