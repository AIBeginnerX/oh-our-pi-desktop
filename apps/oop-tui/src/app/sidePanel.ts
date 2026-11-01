import type { WorkflowGraph } from "@t3tools/client-runtime/workflow-graph";

import { AgentsPanel, type AgentsView } from "./agentsPanel.ts";
import {
  PANEL_COMMAND,
  PANEL_TITLE,
  WorkflowPanel,
  WORKFLOW_USAGE,
  type FlowAction,
  type PanelInput,
  type PanelView,
} from "./workflowPanel.ts";
import { t } from "../i18n/index.ts";

/** What each command of the side panel can be told; the Agents view always follows the live turn. */
export const PANEL_USAGE: Readonly<Record<PanelView, string>> = {
  workflow: WORKFLOW_USAGE,
  agents: "/dag-agents [on|off|live]",
};

/** What happens to the layout when a view's command is run. */
export type PanelMove = "open" | "switch" | "close" | "none";

/**
 * Each command shows its own view. With the panel closed it opens; with the other view up it
 * switches without closing; typing the same command again closes it, and so does `off`. `off` for
 * the view that is not shown has nothing to turn off. `shown` is the view up now, null when the
 * layout is closed.
 */
export const planPanelMove = (
  view: PanelView,
  action: FlowAction,
  shown: PanelView | null,
): PanelMove => {
  if (action.kind === "off") return shown === view ? "close" : "none";
  if (shown === view) return action.kind === "toggle" ? "close" : "none";
  return shown === null ? "open" : "switch";
};

/** Said for `off` aimed at a view that is not the one shown, which would otherwise do nothing in silence. */
export const offElsewhereNotice = (view: PanelView, shown: PanelView): string =>
  t("session.panel.offElsewhere", {
    view: PANEL_TITLE[view],
    shown: PANEL_TITLE[shown],
    command: PANEL_COMMAND[shown],
  });

/** Said for `/dag-agents <number>`, `next` and `prev`: there is one turn to show, not a list to pick from. */
const agentsNoPick = (): string =>
  t("session.panel.agentsNoPick", { command: PANEL_COMMAND.workflow });

export type SidePanelInput = Omit<PanelInput, "flows" | "pinnedId">;

/**
 * The right-hand panel with its two views. The view that is not shown reads nothing and draws
 * nothing; each keeps its own memo, so going back to one repeats no work if nothing changed.
 */
export class SidePanel {
  readonly workflow = new WorkflowPanel();
  readonly agents = new AgentsPanel();
  private current: PanelView = "workflow";

  view(): PanelView {
    return this.current;
  }

  show(view: PanelView): void {
    this.current = view;
  }

  /** A different thread: nothing picked or read in the last one carries over. */
  reset(): void {
    this.workflow.reset();
    this.agents.reset();
  }

  /** Applies a pick, `next`, `prev` or `live` for `view`; says why when it cannot. */
  choose(
    view: PanelView,
    flows: () => ReadonlyArray<WorkflowGraph> | null,
    action: FlowAction,
  ): string | null {
    if (view === "workflow") return this.workflow.choose(flows(), action);
    return action.kind === "pick" || action.kind === "next" || action.kind === "prev"
      ? agentsNoPick()
      : null;
  }

  lines(
    input: SidePanelInput,
    read: {
      readonly flows: () => ReadonlyArray<WorkflowGraph> | null;
      /** The Agents view of the thread on screen; null when there is no chat to read. */
      readonly agents: () => AgentsView | null;
    },
  ): string[] {
    return this.current === "agents"
      ? this.agents.lines({ ...input, view: read.agents() })
      : this.workflow.lines({ ...input, flows: read.flows() });
  }
}
