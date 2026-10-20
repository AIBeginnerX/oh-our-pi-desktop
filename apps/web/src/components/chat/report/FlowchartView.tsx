import {
  layoutFlowchart,
  type FlowLayoutNode,
  type Flowchart,
} from "@t3tools/client-runtime/visual-blocks";
import { useId, useMemo } from "react";

import { reportColor } from "./ChartView";

const RANK_DELAY_MS = 140;

function NodeShape({ node }: { node: FlowLayoutNode }) {
  const { width: w, height: h } = node;
  const color = reportColor(node.rank);
  const paint = {
    fill: `color-mix(in oklab, ${color} 13%, var(--card))`,
    stroke: color,
    strokeWidth: 1.5,
  };
  switch (node.shape) {
    case "diamond":
      return <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} {...paint} />;
    case "hexagon": {
      const inset = Math.min(h / 3, w / 5);
      return (
        <polygon
          points={`${inset},0 ${w - inset},0 ${w},${h / 2} ${w - inset},${h} ${inset},${h} 0,${h / 2}`}
          {...paint}
        />
      );
    }
    case "circle":
      return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...paint} />;
    case "cylinder":
      return (
        <g {...paint}>
          <path d={`M0 7 A ${w / 2} 7 0 0 1 ${w} 7 V ${h - 7} A ${w / 2} 7 0 0 1 0 ${h - 7} Z`} />
          <path d={`M0 7 A ${w / 2} 7 0 0 0 ${w} 7`} fill="none" />
        </g>
      );
    case "subroutine":
      return (
        <g {...paint}>
          <rect width={w} height={h} rx={4} />
          <path d={`M8 0 V ${h} M ${w - 8} 0 V ${h}`} fill="none" />
        </g>
      );
    case "stadium":
      return <rect width={w} height={h} rx={h / 2} {...paint} />;
    case "round":
      return <rect width={w} height={h} rx={14} {...paint} />;
    case "rect":
      return <rect width={w} height={h} rx={8} {...paint} />;
  }
}

/**
 * A mermaid flowchart drawn without mermaid: nodes pop in rank by rank and each arrow draws
 * itself after its source appears. While the block streams, new nodes join and the rest glide.
 */
export function FlowchartView({ chart }: { chart: Flowchart }) {
  const layout = useMemo(() => layoutFlowchart(chart), [chart]);
  const markerId = `flow-arrow-${useId().replaceAll(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <div className="overflow-x-auto">
      <svg
        width={layout.width}
        height={layout.height}
        className="mx-auto block"
        role="img"
        aria-label="Flowchart"
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" className="fill-muted-foreground" />
          </marker>
        </defs>
        {layout.edges.map((edge, index) => {
          const dashed = edge.style === "dashed";
          const delay = `${edge.rank * RANK_DELAY_MS + 160}ms`;
          return (
            <g key={`${edge.from}>${edge.to}:${index}`} className="text-muted-foreground">
              <path
                d={edge.d}
                fill="none"
                stroke="currentColor"
                strokeOpacity={0.75}
                strokeWidth={edge.style === "thick" ? 2.5 : 1.5}
                strokeDasharray={dashed ? "5 5" : undefined}
                pathLength={dashed ? undefined : 1}
                markerEnd={edge.arrow ? `url(#${markerId})` : undefined}
                className={dashed ? "motion-safe:rpt-fade" : "motion-safe:rpt-draw"}
                style={{ animationDelay: delay }}
              />
              {edge.labelLines.length === 0 ? null : (
                <g className="motion-safe:rpt-fade" style={{ animationDelay: delay }}>
                  <rect
                    x={edge.labelX - edge.labelWidth / 2}
                    y={edge.labelY - edge.labelHeight / 2}
                    width={edge.labelWidth}
                    height={edge.labelHeight}
                    rx={8}
                    className="fill-background stroke-border"
                  />
                  <text
                    x={edge.labelX}
                    y={edge.labelY - ((edge.labelLines.length - 1) * 14) / 2}
                    textAnchor="middle"
                    fontSize="11"
                    className="fill-muted-foreground"
                  >
                    {edge.labelLines.map((line, lineIndex) => (
                      <tspan key={lineIndex} x={edge.labelX} dy={lineIndex === 0 ? "0.32em" : "14"}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              )}
            </g>
          );
        })}
        {layout.nodes.map((node) => (
          <g
            key={node.id}
            style={{
              transform: `translate(${node.x}px, ${node.y}px)`,
              transition: "transform 300ms ease",
            }}
          >
            <g
              className="motion-safe:rpt-pop"
              style={{ animationDelay: `${node.rank * RANK_DELAY_MS}ms` }}
            >
              <NodeShape node={node} />
              <text
                x={node.width / 2}
                y={node.height / 2 - ((node.lines.length - 1) * 16) / 2}
                dy="0.32em"
                textAnchor="middle"
                fontSize="12"
                className="fill-foreground font-medium"
              >
                {node.lines.map((line, index) => (
                  <tspan key={index} x={node.width / 2} dy={index === 0 ? "0.32em" : "16"}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          </g>
        ))}
      </svg>
    </div>
  );
}
