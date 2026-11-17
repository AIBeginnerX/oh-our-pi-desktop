import { describe, expect, it } from "vite-plus/test";
import type { WorkflowNode, WorkflowNodeState } from "@t3tools/client-runtime/workflow-graph";

import { countsText, stateText, todoText } from "./workflowText";

// The keys plus their filled holes are the observable text: this translate fills them the way
// the real one does, so the assertions read exactly what a reader gets.
const t = (text: string, values?: Record<string, string | number>) =>
  values === undefined
    ? text
    : text.replace(/\{(\w+)\}/g, (_hole, name: string) => String(values[name] ?? `{${name}}`));

const todos = (counts: {
  verified?: number;
  claimed?: number;
  failed?: number;
  total?: number;
}) => ({
  total: counts.total ?? 5,
  verified: counts.verified ?? 0,
  claimed: counts.claimed ?? 0,
  failed: counts.failed ?? 0,
  blocked: 0,
});

const crewNode = (
  state: WorkflowNodeState,
  outcome?: string,
): Pick<WorkflowNode, "state" | "info"> => ({
  state,
  info: {
    startedAt: "2026-11-16T00:00:00.000Z",
    ...(outcome === undefined ? {} : { crew: { taskId: "task-1", role: "worker", outcome } }),
  },
});

describe("crew checklist text", () => {
  it("a failing check on a still-running task reads as work left, not as failed", () => {
    const text = todoText(
      {
        todos: todos({ verified: 2, claimed: 1, failed: 1 }),
        crew: { taskId: "task-1", role: "worker" },
      },
      t,
    );
    expect(text).toBe("40% · 2 of 5 verified · 1 unproven · 1 not passing yet");
    expect(text?.toLowerCase()).not.toContain("failed");
  });

  it("the same failing check on a finished task reads as failed", () => {
    expect(
      todoText(
        {
          todos: todos({ verified: 2, failed: 2, total: 4 }),
          crew: { taskId: "task-1", role: "worker", outcome: "partial" },
        },
        t,
      ),
    ).toBe("50% · 2 of 4 verified · 2 failed");
  });

  it("a checklist with nothing failing reads exactly as before", () => {
    expect(
      todoText(
        { todos: todos({ verified: 2, claimed: 1 }), crew: { taskId: "task-1", role: "worker" } },
        t,
      ),
    ).toBe("40% · 2 of 5 verified · 1 unproven");
    expect(todoText({ todos: todos({ verified: 3, total: 3 }) }, t)).toBe("100% · 3 of 3 verified");
  });
});

describe("crew task state text", () => {
  it("a task handed back partway reads as workflow state, and failed stays failed", () => {
    expect(stateText(crewNode("running"), t)).toBe("Working");
    expect(stateText(crewNode("completed"), t)).toBe("Done");
    expect(stateText(crewNode("unfinished", "partial"), t)).toBe("Partial");
    expect(stateText(crewNode("unfinished", "blocked"), t)).toBe("Blocked");
    expect(stateText(crewNode("unfinished"), t)).toBe("Not finished");
    expect(stateText(crewNode("failed", "failed"), t)).toBe("Failed");
  });
});

describe("crew flow counts", () => {
  it("counts leave out what is zero", () => {
    expect(countsText({ completed: 2, failed: 1, stopped: 0, unfinished: 0, running: 1 }, t)).toBe(
      "2 done · 1 failed · 1 running",
    );
  });

  it("a handed-back task counts as not finished, apart from failed", () => {
    expect(countsText({ completed: 1, failed: 1, stopped: 0, unfinished: 2, running: 0 }, t)).toBe(
      "1 done · 1 failed · 2 not finished",
    );
  });
});
