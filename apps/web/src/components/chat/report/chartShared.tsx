import { formatCompact, textWidth } from "@t3tools/client-runtime/visual-blocks";
import { useLayoutEffect, useRef, useState } from "react";

export const reportColor = (index: number) => `var(--report-${(index % 6) + 1})`;

export const svgId = (raw: string) => raw.replaceAll(/[^a-zA-Z0-9_-]/g, "");

/** Tracks the width of the element behind the returned ref. */
export function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(Math.floor(element.getBoundingClientRect().width) || fallback);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined && entry.contentRect.width > 0) {
        setWidth(Math.floor(entry.contentRect.width));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width] as const;
}

export const withUnit = (value: number, unit: string | undefined) =>
  `${formatCompact(value)}${unit ? ` ${unit}` : ""}`;

/** Width of SVG text at `fontSize`; textWidth measures 12px text. */
export const widthAt = (value: string, fontSize: number) => (textWidth(value) * fontSize) / 12;

/** Shortens a label to fit `width` pixels at `fontSize`, ending in an ellipsis when cut. */
export function clipToWidth(label: string, width: number, fontSize: number): string {
  if (widthAt(label, fontSize) <= width) return label;
  let clipped = "";
  for (const char of label) {
    if (widthAt(`${clipped}${char}…`, fontSize) > width) break;
    clipped += char;
  }
  return clipped.length === 0 ? "…" : `${clipped}…`;
}

export function Legend({ names }: { names: ReadonlyArray<string> }) {
  if (names.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {names.map((name, index) => (
        <span key={name + index} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: reportColor(index) }} />
          {name}
        </span>
      ))}
    </div>
  );
}

/** X-axis labels along the bottom of a chart, thinned so neighbours never collide. */
export function XAxisLabels(props: {
  labels: ReadonlyArray<string>;
  xOf: (index: number) => number;
  band: number;
  y: number;
}) {
  const { labels, xOf, band, y } = props;
  const widestLabel = Math.max(...labels.map((label) => widthAt(label, 10)));
  const labelEvery = Math.max(1, Math.ceil(Math.min(widestLabel + 10, 90) / band));
  return labels.map((label, index) =>
    index % labelEvery === 0 ? (
      <text
        key={label + index}
        x={xOf(index)}
        y={y}
        textAnchor="middle"
        fontSize="10"
        className="fill-muted-foreground"
      >
        {clipToWidth(label, band * labelEvery - 6, 10)}
      </text>
    ) : null,
  );
}
