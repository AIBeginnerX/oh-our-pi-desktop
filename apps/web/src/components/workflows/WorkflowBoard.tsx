import {
  COMPACT_WORKFLOW_METRICS,
  layoutWorkflow,
  nodeElapsedMs,
  shortDuration,
  type WorkflowCard,
  type WorkflowEdgeLayout,
  type WorkflowGraph,
  type WorkflowNodeState,
} from "@t3tools/client-runtime/workflow-graph";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";

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

const EDGE_STROKE = {
  done: "var(--success)",
  failed: "var(--destructive)",
  idle: "var(--border)",
  active: "var(--primary)",
} as const;

// The dash flow repaints its edge every frame; past this many running edges the rest keep a
// still dashed line, so a wide fan-out never turns into a GPU load.
const MAX_ANIMATED_EDGES = 12;
const FLOW_DASH = "9 7";

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
  readonly now: number;
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (nodeId: string) => void;
  readonly compact?: boolean;
}) {
  const [containerRef, viewportWidth] = useElementWidth();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const layout = useMemo(
    () =>
      layoutWorkflow(
        props.graph,
        props.compact ? COMPACT_WORKFLOW_METRICS : undefined,
        viewportWidth,
      ),
    [props.graph, props.compact, viewportWidth],
  );
  const animatedEdges = useMemo(
    () =>
      new Set(
        layout.edges
          .filter((edge) => edge.tone === "active")
          .slice(0, MAX_ANIMATED_EDGES)
          .map((edge) => `${edge.from}>${edge.to}`),
      ),
    [layout.edges],
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
            <WorkflowEdge
              key={`${edge.from}>${edge.to}:${edge.tone}`}
              edge={edge}
              animate={!reducedMotion && animatedEdges.has(`${edge.from}>${edge.to}`)}
            />
          ))}
        </svg>
        {layout.waves.map((wave) => (
          <div
            key={wave.index}
            className="absolute flex flex-col gap-1 text-2xs text-muted-foreground"
            style={{ left: wave.x, top: 12, width: wave.width }}
          >
            <span
              className={cn("truncate", wave.index === layout.currentWave && "text-foreground")}
            >
              {wave.title} · {wave.settled}/{wave.total}
              {wave.running > 0 ? ` · ${wave.running} running` : ""}
            </span>
            <span className="h-0.5 overflow-hidden rounded-full bg-border/60">
              <span
                className="block h-full rounded-full bg-success transition-[width] duration-500"
                style={{ width: `${(wave.settled / Math.max(1, wave.total)) * 100}%` }}
              />
            </span>
          </div>
        ))}
        {layout.cards.map((card) => (
          <WorkflowNodeCard
            key={card.node.id}
            card={card}
            now={props.now}
            selected={card.node.id === props.selectedNodeId}
            onSelect={props.onSelectNode}
          />
        ))}
      </div>
    </div>
  );
});

function WorkflowEdge({ edge, animate }: { edge: WorkflowEdgeLayout; animate: boolean }) {
  const stroke = EDGE_STROKE[edge.tone];
  if (edge.tone !== "active") {
    return (
      <path
        d={edge.d}
        fill="none"
        stroke={stroke}
        strokeWidth={edge.tone === "idle" ? 1.5 : 2}
        strokeDasharray={edge.tone === "idle" || edge.tone === "failed" ? "4 6" : undefined}
        className={edge.tone === "done" ? "motion-safe:wf-edge-draw" : undefined}
        style={{ ["--wf-length" as string]: edge.flow.length }}
      />
    );
  }
  return (
    <g>
      <path
        d={edge.d}
        fill="none"
        stroke={stroke}
        strokeWidth={8}
        strokeLinecap="round"
        className="opacity-30 motion-safe:wf-edge-glow"
      />
      <path
        d={edge.d}
        fill="none"
        stroke={stroke}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={FLOW_DASH}
        className={animate ? "motion-safe:wf-edge-flow" : undefined}
      />
    </g>
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
  readonly now: number;
  readonly selected: boolean;
  readonly onSelect: (nodeId: string) => void;
}) {
  const { node } = props.card;
  const running = node.state === "running";
  const started = isStarted(node);
  if (props.card.mini) {
    return (
      <button
        type="button"
        key={node.state}
        aria-label={`${node.label}, ${node.state}`}
        onClick={() => props.onSelect(node.id)}
        className={cn(
          "absolute flex items-center gap-1.5 rounded-lg border bg-card px-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          running ? "wf-card-neon" : "border-border/60 hover:border-border",
          node.state === "completed" && "motion-safe:wf-card-settled-completed",
          props.selected && "ring-2 ring-primary/70",
        )}
        style={{
          left: props.card.x,
          top: props.card.y,
          width: props.card.width,
          height: props.card.height,
        }}
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full bg-current",
            WORKFLOW_STATE_TONE[node.state],
            running && "animate-pulse",
          )}
        />
        <span
          className={cn(
            "min-w-0 truncate text-2xs",
            started ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {node.label}
        </span>
      </button>
    );
  }
  const elapsed = nodeElapsedMs(node.info, props.now);
  const meta = [
    elapsed === undefined ? undefined : shortDuration(elapsed),
    node.info.tokens === undefined ? undefined : `${Math.round(node.info.tokens / 1000)}k tok`,
  ].filter(Boolean);
  return (
    <div
      className="absolute"
      style={{
        left: props.card.x,
        top: props.card.y,
        width: props.card.width,
        height: props.card.height,
      }}
    >
      {running ? (
        <span className="pointer-events-none absolute -inset-1.5 rounded-2xl motion-safe:wf-card-halo" />
      ) : null}
      <button
        type="button"
        key={node.state}
        aria-label={`${node.label}, ${node.state}`}
        onClick={() => props.onSelect(node.id)}
        className={cn(
          "relative flex h-full w-full flex-col gap-0.5 rounded-xl border bg-card px-3 py-2 text-left shadow-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          running ? "wf-card-neon" : "border-border/70 hover:border-border",
          node.state === "completed" && "motion-safe:wf-card-settled-completed",
          node.state === "failed" && "border-destructive/50 motion-safe:wf-card-settled-failed",
          props.selected && "ring-2 ring-primary/70",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full bg-current",
              WORKFLOW_STATE_TONE[node.state],
            )}
          />
          <span
            className={cn(
              "min-w-0 truncate text-xs font-medium",
              started ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {node.label}
          </span>
        </span>
        <span className="truncate text-2xs text-muted-foreground">
          {node.info.subtitle ?? node.info.description ?? node.state}
        </span>
        <span className={cn("truncate text-2xs", WORKFLOW_STATE_TONE[node.state])}>
          {[node.state, ...meta].join(" · ")}
        </span>
        {running && node.info.progress ? (
          <span className="truncate text-2xs text-muted-foreground/80">{node.info.progress}</span>
        ) : null}
      </button>
    </div>
  );
});
