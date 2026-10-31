import type { WorkflowGraph } from "@t3tools/client-runtime/workflow-graph";
import { describe, expect, it } from "vite-plus/test";

import { makeStyle } from "../render/style.ts";
import { UNICODE_SYMBOLS } from "../render/symbols.ts";
import { makeThread } from "../testing/fixtures.ts";
import { offElsewhereNotice, planPanelMove, SidePanel } from "./sidePanel.ts";
import { EMPTY_AGENTS_VIEW } from "./agentsPanel.ts";
import { parseFlowAction, type FlowAction, type PanelView } from "./workflowPanel.ts";

const action = (word?: string): FlowAction => {
  const parsed = parseFlowAction(word === undefined ? [] : [word]);
  if (parsed === null) throw new Error(`not an action: ${word}`);
  return parsed;
};

describe("planPanelMove", () => {
  const views: PanelView[] = ["workflow", "agents"];
  const other = (view: PanelView): PanelView => (view === "workflow" ? "agents" : "workflow");

  it("opens a closed layout for every word except off", () => {
    for (const view of views) {
      for (const word of [undefined, "on", "live", "1", "next", "prev"]) {
        expect(planPanelMove(view, action(word), null)).toBe("open");
      }
      expect(planPanelMove(view, action("off"), null)).toBe("none");
    }
  });

  it("closes on the same command again or on off, and otherwise leaves the view as it is", () => {
    for (const view of views) {
      expect(planPanelMove(view, action(), view)).toBe("close");
      expect(planPanelMove(view, action("off"), view)).toBe("close");
      for (const word of ["on", "live", "1", "next", "prev"]) {
        expect(planPanelMove(view, action(word), view)).toBe("none");
      }
    }
  });

  it("switches from the other view without closing, and off there has nothing to turn off", () => {
    for (const view of views) {
      for (const word of [undefined, "on", "live", "1", "next", "prev"]) {
        expect(planPanelMove(view, action(word), other(view))).toBe("switch");
      }
      expect(planPanelMove(view, action("off"), other(view))).toBe("none");
    }
  });
});

describe("SidePanel", () => {
  const base = {
    now: 0,
    online: true,
    columns: 40,
    rows: 12,
    style: makeStyle(false),
    symbols: UNICODE_SYMBOLS,
  };

  it("reads and draws only the view that is shown", () => {
    const panel = new SidePanel();
    const reads: string[] = [];
    const read = {
      flows: () => (reads.push("flows"), null),
      agents: () => (reads.push("agents"), EMPTY_AGENTS_VIEW),
    };
    expect(panel.view()).toBe("workflow");
    panel.lines(base, read);
    expect(reads).toEqual(["flows"]);
    panel.show("agents");
    expect(panel.lines(base, read).join("\n")).toContain("Agents");
    expect(reads).toEqual(["flows", "agents"]);
  });

  it("explains in the Agents view that only the Workflow view picks a flow", () => {
    const panel = new SidePanel();
    for (const word of ["2", "next", "prev"]) {
      expect(panel.choose("agents", () => null, action(word))).toContain("/dag-workflow <번호>");
    }
    for (const word of [undefined, "on", "off", "live"]) {
      expect(panel.choose("agents", () => null, action(word))).toBeNull();
    }
    // The Workflow view keeps its own rules.
    expect(panel.choose("workflow", () => [], action("2"))).toBe("고를 흐름이 없습니다.");
  });

  it("forgets what both views remembered when the thread changes", () => {
    const panel = new SidePanel();
    // Only the ids and the times of a flow are read when picking.
    const flows = [
      { id: "new", status: "running", updatedAt: "2", startedAt: "2" },
      { id: "old", status: "completed", updatedAt: "1", startedAt: "1" },
    ] as unknown as WorkflowGraph[];
    expect(panel.choose("workflow", () => flows, action("2"))).toBeNull();
    expect(panel.workflow.pinnedId()).toBe("old");
    const source = {
      thread: makeThread({ id: "t" }),
      leadModel: null,
      board: null,
      waiting: [],
      leadWaiting: null,
    };
    const read = panel.agents.read(source);
    expect(panel.agents.read(source)).toBe(read);
    panel.show("agents");

    panel.reset();
    expect(panel.workflow.pinnedId()).toBeNull();
    // The Agents memo is gone too: the same input is read again.
    expect(panel.agents.read(source)).not.toBe(read);
    // The view stays: the layout is still up on it.
    expect(panel.view()).toBe("agents");
  });

  it("says why `off` aimed at the view that is not shown did nothing", () => {
    expect(offElsewhereNotice("agents", "workflow")).toContain("Agents 창은 열려 있지 않습니다");
    expect(offElsewhereNotice("agents", "workflow")).toContain("/dag-workflow");
    expect(offElsewhereNotice("workflow", "agents")).toContain("/dag-agents");
  });
});
