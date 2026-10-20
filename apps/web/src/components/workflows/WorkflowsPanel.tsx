import type { AgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import { THINKING_NODE_PREFIX, threadFlows } from "@t3tools/client-runtime/thread-flow";
import {
  focusWorkflowGraphId,
  isSettledState,
  nodeElapsedMs,
  shortDuration,
  workflowActivity,
  type WorkflowGraph,
  type WorkflowNodeState,
} from "@t3tools/client-runtime/workflow-graph";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { WorkflowIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { WORKFLOW_STATE_TONE, WorkflowBoard } from "./WorkflowBoard";

/** Re-renders once a second only while something on the board is running. */
function useNowWhile(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** A flow's real steps: the thinking frontier of a running turn is not one. */
function workSteps(flow: WorkflowGraph) {
  return flow.nodes.filter((node) => !node.id.startsWith(THINKING_NODE_PREFIX));
}

/** The thread's work drawn as flows: its provider workflows and each turn's steps. */
export function WorkflowsPanel(props: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly agents: AgentPanelModel;
  /** The running turn, or null when the thread is idle; finished turns never look busy. */
  readonly activeTurnId: string | null;
  /** When the running turn started, so a turn that has called no tool yet still shows. */
  readonly activeTurnStartedAt?: string | null;
}) {
  const flows = useMemo(
    () =>
      threadFlows({
        activities: props.activities,
        agents: props.agents,
        activeTurnId: props.activeTurnId,
        activeTurnStartedAt: props.activeTurnStartedAt ?? null,
      }),
    [props.activities, props.agents, props.activeTurnId, props.activeTurnStartedAt],
  );
  const [chosenId, setChosenId] = useState<string | null>(null);
  const focusedId = focusWorkflowGraphId(flows, chosenId);
  const graph = flows.find((flow) => flow.id === focusedId) ?? null;
  const now = useNowWhile(flows.some((flow) => flow.status === "running"));

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 p-3">
        {flows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WorkflowIcon />
              </EmptyMedia>
              <EmptyTitle>No work to draw yet</EmptyTitle>
              <EmptyDescription>
                When the agent calls tools, starts subagents, or runs a workflow in this thread,
                each step shows up here live.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {flows.map((flow) => (
                <FlowChip
                  key={flow.id}
                  flow={flow}
                  selected={flow.id === focusedId}
                  onSelect={() => setChosenId(flow.id)}
                />
              ))}
            </div>
            {graph === null ? null : <FlowView key={graph.id} graph={graph} now={now} />}
          </>
        )}
      </div>
    </ScrollArea>
  );
}

function StateDot({ state, className }: { state: WorkflowNodeState; className?: string }) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full bg-current",
        WORKFLOW_STATE_TONE[state],
        className,
      )}
    />
  );
}

function FlowChip(props: { flow: WorkflowGraph; selected: boolean; onSelect: () => void }) {
  const { flow } = props;
  const steps = workSteps(flow);
  const settled = steps.filter((node) => isSettledState(node.state)).length;
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
        props.selected
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "border-border/70 text-muted-foreground hover:text-foreground",
      )}
    >
      <StateDot state={flow.status} className={flow.status === "running" ? "animate-pulse" : ""} />
      <span className="max-w-44 truncate font-medium">{flow.name}</span>
      <span className="tabular-nums">
        {settled}/{steps.length}
      </span>
    </button>
  );
}

function FlowView(props: { graph: WorkflowGraph; now: number }) {
  const { graph } = props;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const steps = workSteps(graph);
  const settled = steps.filter((node) => isSettledState(node.state)).length;
  const running = steps.filter((node) => node.state === "running").length;
  const percent = (settled / Math.max(1, steps.length)) * 100;
  const selected = graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const activity = workflowActivity(graph, props.now);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StateDot state={graph.status} />
          <h2 className="min-w-0 truncate text-sm font-semibold">{graph.name}</h2>
          <span className="text-xs text-muted-foreground">
            {graph.kind === "workflow" ? "Workflow" : graph.kind === "crew" ? "Crew" : "Turn"}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {settled}/{steps.length} done{running > 0 ? ` · ${running} running` : ""}
          </span>
        </div>
        <div
          className={cn(
            "h-1.5 overflow-hidden rounded-full bg-border/50",
            graph.status === "running" && "motion-safe:wf-progress-live",
          )}
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary to-success transition-[width] duration-700"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
      <WorkflowBoard
        graph={graph}
        now={props.now}
        selectedNodeId={selectedNodeId}
        onSelectNode={setSelectedNodeId}
        compact
      />
      <section className="rounded-xl border border-border/60 p-4">
        <h3 className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Step
        </h3>
        {selected === null ? (
          <p className="text-xs text-muted-foreground">Select a card on the board.</p>
        ) : (
          <dl className="flex flex-col gap-1.5">
            <Field label="Step" value={selected.label} />
            <Field label="State" value={selected.state} />
            <Field label="Model" value={selected.info.model} />
            <Field
              label="Elapsed"
              value={(() => {
                const elapsed = nodeElapsedMs(selected.info, props.now);
                return elapsed === undefined ? undefined : shortDuration(elapsed);
              })()}
            />
            <Field label="Tokens" value={selected.info.tokens} />
            <Field label="Tool calls" value={selected.info.toolUses} />
            <Field label="Detail" value={selected.info.description} />
            <Field label="Now" value={selected.info.progress} />
            <Field label="Error" value={selected.info.error} />
          </dl>
        )}
      </section>
      <section className="rounded-xl border border-border/60 p-4">
        <h3 className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Activity
        </h3>
        {activity.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing has started yet.</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {activity.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  onClick={() => setSelectedNodeId(entry.nodeId)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-muted/60"
                >
                  {entry.state === null ? (
                    <span className="size-2 shrink-0" />
                  ) : (
                    <StateDot state={entry.state} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.text}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function Field(props: { label: string; value: string | number | undefined }) {
  if (props.value === undefined || props.value === "") return null;
  return (
    <div className="flex gap-3 text-xs">
      <dt className="w-20 shrink-0 text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 break-words">{props.value}</dd>
    </div>
  );
}
