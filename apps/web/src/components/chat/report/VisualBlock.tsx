import { parseChartSpec, parseFlowchart } from "@t3tools/client-runtime/visual-blocks";
import { BarChart3Icon, Code2Icon, WorkflowIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "../../ui/button";
import { ChartView } from "./ChartView";
import { FlowchartView } from "./FlowchartView";

export const VISUAL_BLOCK_LANGUAGES: ReadonlySet<string> = new Set(["chart", "mermaid"]);

/**
 * A ```chart or ```mermaid block shown as a report figure. Until the fence closes an unparsable
 * block shows a drawing placeholder; once closed it falls back to the plain code block.
 */
export function VisualBlock(props: {
  readonly language: string;
  readonly code: string;
  readonly complete: boolean;
  readonly fallback: ReactNode;
}) {
  const [showSource, setShowSource] = useState(false);
  const isChart = props.language === "chart";
  const chart = useMemo(
    () => (isChart && props.complete ? parseChartSpec(props.code) : null),
    [isChart, props.code, props.complete],
  );
  const flow = useMemo(() => (isChart ? null : parseFlowchart(props.code)), [isChart, props.code]);

  if (chart === null && flow === null) {
    if (props.complete) return <>{props.fallback}</>;
    return (
      <div className="my-3 flex h-40 items-center justify-center gap-2 rounded-2xl border border-dashed border-border/70 text-xs text-muted-foreground motion-safe:rpt-shimmer">
        {isChart ? <BarChart3Icon className="size-4" /> : <WorkflowIcon className="size-4" />}
        {isChart ? "Drawing chart…" : "Drawing diagram…"}
      </div>
    );
  }

  const title = chart?.title;
  const subtitle = chart?.subtitle;
  return (
    <figure className="my-3 rounded-2xl border border-border/60 bg-card/40 p-4 motion-safe:rpt-enter">
      <figcaption className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          {title === undefined ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {isChart ? (
                <BarChart3Icon className="size-3.5" />
              ) : (
                <WorkflowIcon className="size-3.5" />
              )}
              {isChart ? "Chart" : "Diagram"}
            </div>
          ) : (
            <div className="text-sm leading-snug font-semibold text-pretty">{title}</div>
          )}
          {subtitle === undefined ? null : (
            <div className="mt-0.5 text-xs text-muted-foreground text-pretty">{subtitle}</div>
          )}
        </div>
        <Button
          size="xs"
          variant="ghost-muted"
          aria-pressed={showSource}
          onClick={() => setShowSource((current) => !current)}
        >
          <Code2Icon />
          {showSource ? "Visual" : "Source"}
        </Button>
      </figcaption>
      {showSource ? (
        props.fallback
      ) : chart !== null ? (
        <ChartView spec={chart} />
      ) : flow !== null ? (
        <FlowchartView chart={flow} />
      ) : null}
    </figure>
  );
}
