import type { AgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  actorFlows,
  MAIN_NODE_PREFIX,
  THINKING_NODE_PREFIX,
} from "@t3tools/client-runtime/thread-flow";
import {
  boundFlows,
  focusWorkflowGraphId,
  workflowActivity,
  workflowCounts,
  type WorkflowActivityEntry,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeState,
} from "@t3tools/client-runtime/workflow-graph";
import type { EnvironmentId, OrchestrationThreadActivity, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon, WorkflowIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useT } from "~/i18n";
import { cn } from "~/lib/utils";
import { formatRelativeTime } from "~/timestampFormat";

import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { CrewTaskActions } from "./CrewTaskActions";
import { hasElapsed, LiveElapsed } from "./LiveElapsed";
import { WORKFLOW_STATE_TONE, WorkflowBoard, workflowCostLabel } from "./WorkflowBoard";
import {
  countsText,
  doingText,
  flowName,
  modelText,
  nodeName,
  roleText,
  stateText,
  toolSummaryText,
  type Translate,
} from "./workflowText";

/** Activity entries shown before "Show all". */
const ACTIVITY_LIMIT = 20;

/** A flow's own members: its agents or steps, without the main agent or the thinking frontier. */
function members(flow: WorkflowGraph): WorkflowNode[] {
  return flow.nodes.filter(
    (node) => !node.id.startsWith(THINKING_NODE_PREFIX) && !node.id.startsWith(MAIN_NODE_PREFIX),
  );
}

/** The thread's work drawn as flows: one per turn, plus each provider workflow. */
export function WorkflowsPanel(props: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly agents: AgentPanelModel;
  /** The running turn, or null when the thread is idle; finished turns never look busy. */
  readonly activeTurnId: string | null;
  /** When the running turn started, so a turn that has called no tool yet still shows. */
  readonly activeTurnStartedAt?: string | null;
  /** The thread the activities belong to; crew tasks stop, open, and retry through it. */
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  /** The main agent's model, as the composer selected it; left out, its card shows none. */
  readonly lead?: { readonly model: string | null } | null;
}) {
  const t = useT();
  const leadModel = props.lead?.model ?? null;
  const flows = useMemo(
    () =>
      actorFlows({
        activities: props.activities,
        agents: props.agents,
        activeTurnId: props.activeTurnId,
        activeTurnStartedAt: props.activeTurnStartedAt ?? null,
        leadModel,
      }),
    [props.activities, props.agents, props.activeTurnId, props.activeTurnStartedAt, leadModel],
  );
  // No pick means follow the newest running flow; picking the one being followed changes nothing.
  const [chosenId, setChosenId] = useState<string | null>(null);
  const liveId = focusWorkflowGraphId(flows, null);
  const focusedId = focusWorkflowGraphId(flows, chosenId);
  const graph = flows.find((flow) => flow.id === focusedId) ?? null;
  const { visible, earlier } = boundFlows(flows, focusedId);
  const select = (id: string) => setChosenId(id === liveId ? null : id);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 p-3">
        {flows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WorkflowIcon />
              </EmptyMedia>
              <EmptyTitle>{t("No work to draw yet")}</EmptyTitle>
              <EmptyDescription>
                {t(
                  "When the agent calls tools, starts subagents, or runs a workflow in this thread, each step shows up here live.",
                )}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {visible.map((flow) => (
                <FlowChip
                  key={flow.id}
                  flow={flow}
                  selected={flow.id === focusedId}
                  onSelect={() => select(flow.id)}
                />
              ))}
              {earlier.length === 0 ? null : (
                <Menu>
                  <MenuTrigger render={<Button size="xs" variant="outline" />}>
                    {t("Earlier ({count})", { count: earlier.length })}
                    <ChevronDownIcon aria-hidden />
                  </MenuTrigger>
                  <MenuPopup align="start" className="max-h-80 overflow-y-auto">
                    {earlier.map((flow) => (
                      <MenuItem key={flow.id} onClick={() => select(flow.id)}>
                        <StateDot state={flow.status} />
                        <span className="min-w-0 flex-1 truncate">{flowName(flow, t)}</span>
                        <span className="text-xs text-muted-foreground">
                          {relativeStart(flow.startedAt, t)}
                        </span>
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              )}
              {focusedId !== liveId ? (
                <Button size="xs" variant="ghost-muted" onClick={() => setChosenId(null)}>
                  {t("Follow live")}
                </Button>
              ) : null}
            </div>
            {graph === null ? null : (
              <FlowView
                key={graph.id}
                graph={graph}
                environmentId={props.environmentId}
                threadId={props.threadId}
              />
            )}
          </>
        )}
      </div>
    </ScrollArea>
  );
}

function relativeStart(startedAt: string, t: Translate): string {
  const relative = formatRelativeTime(startedAt);
  if (relative === null) return "";
  return relative.suffix === null ? t(relative.value) : `${relative.value} ${t(relative.suffix)}`;
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
  const t = useT();
  const { flow } = props;
  const counts = workflowCounts(members(flow));
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
      <StateDot state={flow.status} />
      <span className="max-w-44 truncate font-medium">{flowName(flow, t)}</span>
      {counts.total === 0 ? null : (
        <span className="tabular-nums">
          {counts.completed}/{counts.total}
        </span>
      )}
      {counts.failed === 0 ? null : (
        <span className="text-destructive-foreground tabular-nums">
          {t("{count} failed", { count: counts.failed })}
        </span>
      )}
    </button>
  );
}

function FlowView(props: {
  graph: WorkflowGraph;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
}) {
  const t = useT();
  const { graph } = props;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const view = showSteps && graph.steps !== undefined ? graph.steps : graph;
  const parts = members(view);
  const counts = workflowCounts(parts);
  const hiddenSteps = view.stepCount === undefined ? 0 : view.stepCount - parts.length;
  const selected = view.nodes.find((node) => node.id === selectedNodeId) ?? null;
  // Live progress sorts ahead of everything dated, so it takes the latest possible time.
  const activity = useMemo(
    () => workflowActivity(view, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY),
    [view],
  );
  const shownActivity = showAllActivity ? activity : activity.slice(0, ACTIVITY_LIMIT);
  const percent = (count: number) => `${(count / Math.max(1, counts.total)) * 100}%`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StateDot state={graph.status} />
          <h2 className="min-w-0 truncate text-sm font-semibold">{flowName(graph, t)}</h2>
          {graph.kind === "workflow" ? (
            <span className="text-xs text-muted-foreground">{t("Workflow")}</span>
          ) : null}
          {counts.total === 0 ? null : (
            <span className="text-xs text-muted-foreground tabular-nums">
              {countsText(counts, t)}
            </span>
          )}
          {graph.steps === undefined ? null : (
            <Button
              size="xs"
              variant={showSteps ? "secondary" : "ghost-muted"}
              aria-pressed={showSteps}
              className="ml-auto"
              onClick={() => {
                setShowSteps((value) => !value);
                setSelectedNodeId(null);
              }}
            >
              {showSteps ? t("Hide steps") : t("Show steps")}
            </Button>
          )}
        </div>
        {counts.total === 0 ? null : (
          <div className="flex h-1.5 overflow-hidden rounded-full bg-border/50">
            <div
              className="h-full bg-success transition-[width] duration-500"
              style={{ width: percent(counts.completed) }}
            />
            <div
              className="h-full bg-destructive transition-[width] duration-500"
              style={{ width: percent(counts.failed) }}
            />
            <div
              className="h-full bg-muted-foreground/40 transition-[width] duration-500"
              style={{ width: percent(counts.stopped) }}
            />
            <div
              className="h-full bg-primary/40 transition-[width] duration-500"
              style={{ width: percent(counts.running) }}
            />
          </div>
        )}
        {hiddenSteps > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("{count} older steps hidden", { count: hiddenSteps })}
          </p>
        ) : null}
      </div>
      <WorkflowBoard
        graph={view}
        selectedNodeId={selectedNodeId}
        onSelectNode={setSelectedNodeId}
        compact
      />
      <section className="rounded-xl border border-border/60 p-4">
        <h3 className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("Details")}
        </h3>
        {selected === null ? (
          <p className="text-xs text-muted-foreground">{t("Select a card on the board.")}</p>
        ) : (
          <NodeDetails node={selected} t={t} />
        )}
        {selected?.info.crew === undefined ||
        props.environmentId === null ||
        props.threadId === null ? null : (
          <CrewTaskActions
            environmentId={props.environmentId}
            leadThreadId={props.threadId}
            crew={selected.info.crew}
          />
        )}
      </section>
      <section className="rounded-xl border border-border/60 p-4">
        <h3 className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("Activity")}
        </h3>
        {activity.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("Nothing has started yet.")}</p>
        ) : (
          <>
            <ol className="flex flex-col gap-1">
              {shownActivity.map((entry) => (
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
                    <span className="min-w-0 flex-1 truncate">
                      {activityText(entry, view.nodes, t)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            {activity.length > ACTIVITY_LIMIT ? (
              <Button
                size="xs"
                variant="ghost-muted"
                className="mt-2"
                onClick={() => setShowAllActivity((value) => !value)}
              >
                {showAllActivity
                  ? t("Show fewer")
                  : t("Show all ({count})", { count: activity.length })}
              </Button>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

function activityText(
  entry: WorkflowActivityEntry,
  nodes: ReadonlyArray<WorkflowNode>,
  t: Translate,
): string {
  const node = nodes.find((candidate) => candidate.id === entry.nodeId);
  if (node === undefined) return entry.detail ?? "";
  const name = nodeName(node, t);
  switch (entry.event) {
    case "started":
      return t("{name} started", { name });
    case "settled":
      return t("{name}: {state}", { name, state: stateText(node, t) });
    case "error":
    case "progress":
      return `${name}: ${entry.detail ?? ""}`;
  }
}

/** The facts of one card with friendly labels; the raw command stays under "Detail". */
function NodeDetails({ node, t }: { node: WorkflowNode; t: Translate }) {
  const { info } = node;
  const { actor } = info;
  const tools = actor?.tools === undefined ? "" : toolSummaryText(actor.tools, t);
  return (
    <dl className="flex flex-col gap-1.5">
      <Field
        label={actor === undefined ? t("Step") : t("Agent")}
        value={actor === undefined ? node.label : roleText(actor.role, t)}
      />
      <Field label={t("Task")} value={actor?.task} />
      <Field label={t("Work so far")} value={tools} />
      <Field label={t("State")} value={stateText(node, t)} />
      <Field label={t("Model")} value={modelText(info.model)} />
      <Field
        label={t("Elapsed")}
        value={
          hasElapsed(info) ? <LiveElapsed info={info} live={node.state === "running"} /> : undefined
        }
      />
      <Field label={t("Tokens")} value={info.tokens} />
      <Field label={t("Cost")} value={workflowCostLabel(info, t)} />
      <Field
        label={t("Evidence")}
        value={info.evidence === undefined ? undefined : t(info.evidence)}
      />
      <Field label={t("Tool calls")} value={info.toolUses} />
      <Field label={t("Detail")} value={info.description} />
      <Field
        label={t("Now")}
        value={
          node.state === "running" && actor?.doing !== undefined
            ? doingText(actor.doing, t)
            : info.progress
        }
      />
      <Field label={t("Error")} value={info.error} />
    </dl>
  );
}

function Field(props: { label: string; value: ReactNode }) {
  if (props.value === undefined || props.value === null || props.value === "") return null;
  return (
    <div className="flex gap-3 text-xs">
      <dt className="w-20 shrink-0 text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 break-words">{props.value}</dd>
    </div>
  );
}
