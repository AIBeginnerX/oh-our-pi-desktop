import {
  COMPACT_WORKFLOW_METRICS,
  layoutWorkflow,
  type WorkflowCard,
  type WorkflowEdgeLayout,
  type WorkflowGraph,
  type WorkflowNodeInfo,
  type WorkflowNodeState,
} from "@t3tools/client-runtime/workflow-graph";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useT } from "~/i18n";
import { cn } from "~/lib/utils";

import { Badge } from "../ui/badge";
import { hasElapsed, LiveElapsed } from "./LiveElapsed";
import { nodeText, waveTitleText, type Translate } from "./workflowText";

export const WORKFLOW_STATE_TONE: Record<WorkflowNodeState, string> = {
  running: "text-primary",
  completed: "text-success",
  failed: "text-destructive",
  paused: "text-warning",
  blocked: "text-warning",
  pending: "text-muted-foreground",
  cancelled: "text-muted-foreground/60",
  skipped: "text-muted-foreground/60",
};

const EVIDENCE_VARIANT = { reported: "outline", tested: "info", audited: "success" } as const;

/** A reported cost, with "+ unpriced" when part of the usage beside it came with none. */
export function workflowCostLabel(
  info: Pick<WorkflowNodeInfo, "costUsd" | "unpriced">,
  t: Translate,
) {
  if (info.costUsd === undefined) return undefined;
  const cost = info.costUsd > 0 && info.costUsd < 0.01 ? "<$0.01" : formatUsd(info.costUsd);
  return info.unpriced === true ? t("{cost} + unpriced", { cost }) : cost;
}

const EDGE_STROKE = {
  done: "var(--success)",
  failed: "var(--destructive)",
  idle: "var(--border)",
  active: "var(--primary)",
} as const;

function useElementWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export const WorkflowBoard = memo(function WorkflowBoard(props: {
  readonly graph: WorkflowGraph;
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (nodeId: string) => void;
  readonly compact?: boolean;
}) {
  const t = useT();
  const [containerRef, viewportWidth] = useElementWidth();
  const layout = useMemo(
    () =>
      layoutWorkflow(
        props.graph,
        props.compact ? COMPACT_WORKFLOW_METRICS : undefined,
        viewportWidth,
      ),
    [props.graph, props.compact, viewportWidth],
  );

  return (
    <div
      ref={containerRef}
      className="overflow-x-auto overflow-y-hidden rounded-2xl border border-border/60 bg-muted/20"
    >
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg
          className="pointer-events-none absolute inset-0"
          width={layout.width}
          height={layout.height}
          aria-hidden
        >
          {layout.edges.map((edge) => (
            <WorkflowEdge key={`${edge.from}>${edge.to}:${edge.tone}`} edge={edge} />
          ))}
        </svg>
        {layout.waves.length > 1
          ? layout.waves.map((wave) => (
              <div
                key={wave.index}
                className="absolute flex flex-col gap-1 text-2xs text-muted-foreground"
                style={{ left: wave.x, top: 12, width: wave.width }}
              >
                <span
                  className={cn("truncate", wave.index === layout.currentWave && "text-foreground")}
                >
                  {waveTitleText(wave.title, t)}
                  {wave.total > 1 ? ` · ${wave.completed}/${wave.total}` : ""}
                  {wave.failed > 0 ? (
                    <span className="text-destructive-foreground">
                      {" · "}
                      {t("{count} failed", { count: wave.failed })}
                    </span>
                  ) : null}
                  {wave.running > 0 ? ` · ${t("{count} running", { count: wave.running })}` : ""}
                </span>
                <span className="flex h-0.5 overflow-hidden rounded-full bg-border/60">
                  <span
                    className="h-full bg-success transition-[width] duration-500"
                    style={{ width: `${(wave.completed / Math.max(1, wave.total)) * 100}%` }}
                  />
                  <span
                    className="h-full bg-destructive transition-[width] duration-500"
                    style={{ width: `${(wave.failed / Math.max(1, wave.total)) * 100}%` }}
                  />
                </span>
              </div>
            ))
          : null}
        {layout.cards.map((card) => (
          <WorkflowNodeCard
            key={card.node.id}
            card={card}
            selected={card.node.id === props.selectedNodeId}
            onSelect={props.onSelectNode}
          />
        ))}
      </div>
    </div>
  );
});

/** Running edges are a solid primary line; only a finished edge draws itself in, once. */
function WorkflowEdge({ edge }: { edge: WorkflowEdgeLayout }) {
  return (
    <path
      d={edge.d}
      fill="none"
      stroke={EDGE_STROKE[edge.tone]}
      strokeWidth={edge.tone === "idle" ? 1.5 : 2}
      strokeLinecap="round"
      strokeDasharray={edge.tone === "idle" || edge.tone === "failed" ? "4 6" : undefined}
      className={edge.tone === "done" ? "motion-safe:wf-edge-draw" : undefined}
      style={{ ["--wf-length" as string]: edge.flow.length }}
    />
  );
}

/** Gray until the step has actually begun; a step that never ran stays gray even once settled. */
function isStarted(node: WorkflowCard["node"]): boolean {
  return (
    node.state === "running" ||
    node.state === "completed" ||
    node.state === "failed" ||
    node.state === "paused" ||
    node.info.startedAt !== undefined
  );
}

const WorkflowNodeCard = memo(function WorkflowNodeCard(props: {
  readonly card: WorkflowCard;
  readonly selected: boolean;
  readonly onSelect: (nodeId: string) => void;
}) {
  const t = useT();
  const { node } = props.card;
  const running = node.state === "running";
  const started = isStarted(node);
  const text = nodeText(node, t);
  const frame = {
    left: props.card.x,
    top: props.card.y,
    width: props.card.width,
    height: props.card.height,
  };
  if (props.card.mini) {
    return (
      <button
        type="button"
        key={node.state}
        aria-label={`${text.title}, ${text.status}`}
        onClick={() => props.onSelect(node.id)}
        className={cn(
          "absolute flex items-center gap-1.5 rounded-lg border bg-card px-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          running
            ? "border-primary ring-1 ring-primary/60"
            : "border-border/60 hover:border-border",
          node.state === "completed" && "motion-safe:wf-card-settled-completed",
          props.selected && "ring-2 ring-primary/70",
        )}
        style={frame}
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full bg-current",
            WORKFLOW_STATE_TONE[node.state],
          )}
        />
        <span
          className={cn(
            "min-w-0 truncate text-2xs",
            started ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {node.info.actor === undefined
            ? text.title
            : [text.title, text.body].filter(Boolean).join(" · ")}
        </span>
      </button>
    );
  }
  const crewTokens =
    node.info.tokens !== undefined && node.info.actor?.role === "main"
      ? t("{amount} tok by crew", { amount: formatTokens(node.info.tokens) })
      : node.info.tokens === undefined
        ? undefined
        : t("{amount} tok", { amount: formatTokens(node.info.tokens) });
  const meta = [crewTokens, workflowCostLabel(node.info, t)].filter(Boolean);
  const agentCard = node.info.actor !== undefined;
  return (
    <button
      type="button"
      key={node.state}
      aria-label={`${text.title}, ${text.status}`}
      onClick={() => props.onSelect(node.id)}
      className={cn(
        "absolute flex flex-col gap-0.5 overflow-hidden rounded-xl border bg-card px-3 py-2 text-left shadow-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        running ? "border-primary" : "border-border/70 hover:border-border",
        node.state === "completed" && "motion-safe:wf-card-settled-completed",
        node.state === "failed" && "border-destructive/50 motion-safe:wf-card-settled-failed",
        props.selected ? "ring-2 ring-primary/70" : running && "ring-1 ring-primary/60",
      )}
      style={frame}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn("size-2 shrink-0 rounded-full bg-current", WORKFLOW_STATE_TONE[node.state])}
        />
        <span
          className={cn(
            "min-w-0 truncate text-xs font-medium",
            started ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {text.title}
        </span>
        {node.info.evidence === undefined ? null : (
          <Badge size="sm" variant={EVIDENCE_VARIANT[node.info.evidence]} className="ml-auto">
            {t(node.info.evidence)}
          </Badge>
        )}
      </span>
      {text.model === undefined ? null : (
        <span className="truncate text-2xs text-muted-foreground">{text.model}</span>
      )}
      {text.body === undefined ? null : (
        <span
          className={cn(
            "text-2xs text-foreground/90",
            agentCard ? "line-clamp-2" : "truncate text-muted-foreground",
          )}
        >
          {text.body}
        </span>
      )}
      <span
        className={cn("flex min-w-0 items-center gap-1 text-2xs", WORKFLOW_STATE_TONE[node.state])}
      >
        <span className="truncate">{text.status}</span>
        {hasElapsed(node.info) ? (
          <>
            <span aria-hidden>·</span>
            <LiveElapsed info={node.info} live={running} />
          </>
        ) : null}
        {meta.length > 0 ? <span className="truncate">· {meta.join(" · ")}</span> : null}
      </span>
      {!agentCard && running && node.info.progress ? (
        <span className="truncate text-2xs text-muted-foreground/80">{node.info.progress}</span>
      ) : null}
    </button>
  );
});
