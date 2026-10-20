import {
  formatCompact,
  niceScale,
  textWidth,
  type ChartItem,
  type ChartSpec,
} from "@t3tools/client-runtime/visual-blocks";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";

export const reportColor = (index: number) => `var(--report-${(index % 6) + 1})`;

const svgId = (raw: string) => raw.replaceAll(/[^a-zA-Z0-9_-]/g, "");

function useWidth(fallback: number) {
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

const withUnit = (value: number, unit: string | undefined) =>
  `${formatCompact(value)}${unit ? ` ${unit}` : ""}`;

/** Width of SVG text at `fontSize`; textWidth measures 12px text. */
const widthAt = (value: string, fontSize: number) => (textWidth(value) * fontSize) / 12;

/** Shortens a label to fit `width` pixels at `fontSize`, ending in an ellipsis when cut. */
function clipToWidth(label: string, width: number, fontSize: number): string {
  if (widthAt(label, fontSize) <= width) return label;
  let clipped = "";
  for (const char of label) {
    if (widthAt(`${clipped}${char}…`, fontSize) > width) break;
    clipped += char;
  }
  return clipped.length === 0 ? "…" : `${clipped}…`;
}

function Legend({ names }: { names: ReadonlyArray<string> }) {
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

/** One ```chart block drawn as SVG; every shape animates in once when it mounts. */
export function ChartView({ spec }: { spec: ChartSpec }) {
  switch (spec.kind) {
    case "bar":
    case "line":
    case "area":
      return <CartesianChart spec={spec} />;
    case "hbar":
      return <HorizontalBars spec={spec} />;
    case "pie":
    case "donut":
      return <RingChart spec={spec} />;
    case "stats":
      return <StatGrid items={spec.items} unit={spec.unit} />;
    case "progress":
      return <ProgressList items={spec.items} unit={spec.unit} />;
  }
}

function CartesianChart({ spec }: { spec: ChartSpec }) {
  const [ref, measured] = useWidth(560);
  const uid = svgId(useId());
  const width = Math.max(260, measured);
  const height = 230;
  const margin = { top: 18, right: 14, bottom: 30, left: 46 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const count = spec.labels.length;
  const stacked = spec.kind === "bar" && spec.stacked && spec.series.length > 1;

  const values = stacked
    ? spec.labels.flatMap((_, index) => {
        let positive = 0;
        let negative = 0;
        for (const series of spec.series) {
          const value = series.data[index] ?? Number.NaN;
          if (!Number.isFinite(value)) continue;
          if (value >= 0) positive += value;
          else negative += value;
        }
        return [positive, negative];
      })
    : spec.series.flatMap((series) => series.data.filter(Number.isFinite));
  const scale = niceScale(Math.min(...values), Math.max(...values));
  const y = (value: number) =>
    margin.top + innerHeight - ((value - scale.min) / (scale.max - scale.min)) * innerHeight;
  const zeroY = y(0);
  const band = innerWidth / count;
  const widestLabel = Math.max(...spec.labels.map((label) => widthAt(label, 10)));
  const labelEvery = Math.max(1, Math.ceil(Math.min(widestLabel + 10, 90) / band));
  const xOf = (index: number) =>
    spec.kind === "bar"
      ? margin.left + band * index + band / 2
      : count === 1
        ? margin.left + innerWidth / 2
        : margin.left + (innerWidth * index) / (count - 1);

  return (
    <div ref={ref}>
      <Legend names={spec.series.map((series) => series.name)} />
      <svg width={width} height={height} className="block overflow-visible" role="img">
        <defs>
          {spec.series.map((_, index) => (
            <linearGradient key={index} id={`${uid}-fill-${index}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={reportColor(index)} stopOpacity="0.35" />
              <stop offset="100%" stopColor={reportColor(index)} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {scale.ticks.map((tick) => (
          <g key={tick} className="text-muted-foreground">
            <line
              x1={margin.left}
              x2={width - margin.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="currentColor"
              strokeOpacity={tick === 0 ? 0.45 : 0.15}
              strokeDasharray={tick === 0 ? undefined : "3 4"}
            />
            <text
              x={margin.left - 8}
              y={y(tick)}
              dy="0.32em"
              textAnchor="end"
              fill="currentColor"
              fontSize="10"
            >
              {formatCompact(tick)}
            </text>
          </g>
        ))}
        {spec.labels.map((label, index) =>
          index % labelEvery === 0 ? (
            <text
              key={label + index}
              x={xOf(index)}
              y={height - 10}
              textAnchor="middle"
              fontSize="10"
              className="fill-muted-foreground"
            >
              {clipToWidth(label, band * labelEvery - 6, 10)}
            </text>
          ) : null,
        )}
        {spec.kind === "bar" ? (
          <Bars spec={spec} stacked={stacked} band={band} margin={margin} y={y} />
        ) : (
          spec.series.map((series, seriesIndex) => {
            const points = series.data.flatMap((value, index) =>
              Number.isFinite(value) ? [[xOf(index), y(value), value] as const] : [],
            );
            if (points.length === 0) return null;
            const line = points
              .map(([px, py], index) => {
                if (index === 0) return `M ${px} ${py}`;
                const [ox, oy] = points[index - 1]!;
                const dx = (px - ox) / 3;
                return `C ${ox + dx} ${oy}, ${px - dx} ${py}, ${px} ${py}`;
              })
              .join(" ");
            const first = points[0]!;
            const last = points.at(-1)!;
            const spacing = points.length > 1 ? innerWidth / (count - 1) : innerWidth;
            const showValues =
              spec.series.length === 1 &&
              points.every(([, , value]) => widthAt(withUnit(value, spec.unit), 10) + 6 <= spacing);
            return (
              <g key={series.name + seriesIndex}>
                {spec.kind === "area" ? (
                  <path
                    d={`${line} L ${last[0]} ${zeroY} L ${first[0]} ${zeroY} Z`}
                    fill={`url(#${uid}-fill-${seriesIndex})`}
                    className="motion-safe:rpt-fade"
                    style={{ animationDelay: `${300 + seriesIndex * 150}ms` }}
                  />
                ) : null}
                <path
                  d={line}
                  fill="none"
                  stroke={reportColor(seriesIndex)}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pathLength={1}
                  className="motion-safe:rpt-draw"
                  style={{ animationDelay: `${seriesIndex * 150}ms` }}
                />
                {points.map(([px, py, value], index) => (
                  <g key={index} className="group/point">
                    <circle
                      cx={px}
                      cy={py}
                      r={3.5}
                      fill="var(--card)"
                      stroke={reportColor(seriesIndex)}
                      strokeWidth={2}
                      className="motion-safe:rpt-pop"
                      style={{ animationDelay: `${700 + index * 35}ms` }}
                    />
                    <circle cx={px} cy={py} r={12} fill="transparent" />
                    <text
                      x={px}
                      y={py - 10}
                      textAnchor="middle"
                      fontSize="10"
                      className={cn(
                        "fill-foreground font-medium transition-opacity",
                        showValues ? "opacity-80" : "opacity-0 group-hover/point:opacity-100",
                      )}
                    >
                      {withUnit(value, spec.unit)}
                    </text>
                  </g>
                ))}
              </g>
            );
          })
        )}
      </svg>
    </div>
  );
}

function Bars(props: {
  spec: ChartSpec;
  stacked: boolean;
  band: number;
  margin: { left: number };
  y: (value: number) => number;
}) {
  const { spec, stacked, band, margin, y } = props;
  const groupWidth = band * 0.72;
  const barWidth = stacked ? groupWidth : groupWidth / spec.series.length;
  // Value labels show only when every one fits over its bar; otherwise they appear on hover.
  const values = spec.series.flatMap((series) => series.data.filter(Number.isFinite));
  const room = (stacked ? groupWidth : barWidth) + (spec.series.length > 1 ? 2 : band - groupWidth);
  const fits = (format: (value: number) => string) =>
    values.every((value) => widthAt(format(value), 10) <= room);
  const valueText = fits((value) => withUnit(value, spec.unit))
    ? (value: number) => withUnit(value, spec.unit)
    : fits(formatCompact)
      ? formatCompact
      : null;
  const showValues = !stacked && valueText !== null;
  return spec.labels.map((label, index) => {
    let positive = 0;
    let negative = 0;
    return (
      <g key={label + index}>
        {spec.series.map((series, seriesIndex) => {
          const value = series.data[index] ?? Number.NaN;
          if (!Number.isFinite(value)) return null;
          const base = stacked ? (value >= 0 ? positive : negative) : 0;
          const top = base + value;
          if (stacked) {
            if (value >= 0) positive = top;
            else negative = top;
          }
          const x =
            margin.left +
            band * index +
            (band - groupWidth) / 2 +
            (stacked ? 0 : seriesIndex * barWidth);
          const y1 = y(Math.max(base, top));
          const barHeight = Math.max(1, Math.abs(y(base) - y(top)));
          return (
            <g key={series.name + seriesIndex} className="group/bar">
              <rect
                x={x + 1}
                y={y1}
                width={Math.max(2, barWidth - 2)}
                height={barHeight}
                rx={Math.min(4, barWidth / 3)}
                fill={reportColor(seriesIndex)}
                className={cn(
                  "transition-opacity group-hover/bar:opacity-80",
                  value >= 0 ? "motion-safe:rpt-grow-y" : "motion-safe:rpt-grow-y-down",
                )}
                style={{ animationDelay: `${(index * spec.series.length + seriesIndex) * 35}ms` }}
              />
              <text
                x={x + barWidth / 2}
                y={value >= 0 ? y1 - 5 : y1 + barHeight + 12}
                textAnchor="middle"
                fontSize="10"
                className={cn(
                  "fill-foreground font-medium transition-opacity",
                  showValues
                    ? "opacity-80 motion-safe:rpt-fade"
                    : "opacity-0 group-hover/bar:opacity-100",
                )}
                style={{ animationDelay: "600ms" }}
              >
                {(valueText ?? ((raw: number) => withUnit(raw, spec.unit)))(value)}
              </text>
            </g>
          );
        })}
      </g>
    );
  });
}

function HorizontalBars({ spec }: { spec: ChartSpec }) {
  const [ref, measured] = useWidth(560);
  const width = Math.max(260, measured);
  const rowHeight = 26;
  const labelWidth = Math.min(130, width * 0.32);
  const valueWidth = 64;
  const series = spec.series[0]!;
  const finite = series.data.filter(Number.isFinite);
  const max = Math.max(...finite, 0) || 1;
  const trackWidth = width - labelWidth - valueWidth - 12;
  const rows = spec.labels
    .map((label, index) => ({ label, value: series.data[index] ?? Number.NaN, index }))
    .filter((row) => Number.isFinite(row.value));
  return (
    <div ref={ref}>
      <svg width={width} height={rows.length * rowHeight + 4} className="block" role="img">
        {rows.map((row, position) => {
          const barWidth = Math.max(2, (Math.max(0, row.value) / max) * trackWidth);
          const top = position * rowHeight + 2;
          return (
            <g key={row.label + row.index} className="group/bar">
              <text
                x={labelWidth - 8}
                y={top + rowHeight / 2}
                dy="0.32em"
                textAnchor="end"
                fontSize="11"
                className="fill-muted-foreground"
              >
                {clipToWidth(row.label, labelWidth - 12, 11)}
              </text>
              <rect
                x={labelWidth}
                y={top + 5}
                width={trackWidth}
                height={rowHeight - 10}
                rx={4}
                className="fill-muted/60"
              />
              <rect
                x={labelWidth}
                y={top + 5}
                width={barWidth}
                height={rowHeight - 10}
                rx={4}
                fill={reportColor(position === 0 ? 0 : 1)}
                className="transition-opacity group-hover/bar:opacity-80 motion-safe:rpt-grow-x"
                style={{ animationDelay: `${position * 60}ms` }}
              />
              <text
                x={labelWidth + barWidth + 6}
                y={top + rowHeight / 2}
                dy="0.32em"
                fontSize="11"
                className="fill-foreground font-medium motion-safe:rpt-fade"
                style={{ animationDelay: `${400 + position * 60}ms` }}
              >
                {withUnit(row.value, spec.unit)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function RingChart({ spec }: { spec: ChartSpec }) {
  const series = spec.series[0]!;
  const slices = spec.labels
    .map((label, index) => ({ label, value: Math.max(0, series.data[index] ?? 0), index }))
    .filter((slice) => slice.value > 0);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
  const size = 168;
  const donut = spec.kind === "donut";
  const radius = donut ? 62 : 42;
  const thickness = donut ? 24 : 84;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          className="stroke-muted/50"
        />
        {slices.map((slice, position) => {
          const length = (slice.value / total) * circumference;
          const start = offset;
          offset += length;
          return (
            <circle
              key={slice.label + slice.index}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={reportColor(position)}
              strokeWidth={thickness}
              strokeDasharray={`${length} ${circumference}`}
              strokeDashoffset={-start}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              className="motion-safe:rpt-ring"
              style={
                {
                  "--rpt-c": `${circumference}`,
                  animationDelay: `${position * 110}ms`,
                } as React.CSSProperties
              }
            />
          );
        })}
        {donut ? (
          <text
            x={size / 2}
            y={size / 2}
            textAnchor="middle"
            dy="0.32em"
            fontSize="18"
            className="fill-foreground font-semibold motion-safe:rpt-fade"
            style={{ animationDelay: "500ms" }}
          >
            {withUnit(total, spec.unit)}
          </text>
        ) : null}
      </svg>
      <div className="flex min-w-40 flex-1 flex-col gap-1.5 text-sm">
        {slices.map((slice, position) => (
          <div
            key={slice.label + slice.index}
            className="flex items-center gap-2 motion-safe:rpt-enter"
            style={{ animationDelay: `${200 + position * 70}ms` }}
          >
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ background: reportColor(position) }}
            />
            <span className="min-w-0 flex-1 truncate">{slice.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {withUnit(slice.value, spec.unit)}
            </span>
            <span className="w-12 text-right font-medium tabular-nums">
              {((slice.value / total) * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const NUMBER_IN_TEXT = /^(\D*?)(-?\d[\d,]*(?:\.\d+)?)(.*)$/s;

/** Counts a number up once, keeping any prefix or suffix written around it ("$4.5B", "12.3조"). */
function CountUp({ value, unit }: { value: number | string; unit: string | undefined }) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const source = typeof value === "number" ? String(value) : value;
  const match = NUMBER_IN_TEXT.exec(source);
  const target = match ? Number(match[2]!.replaceAll(",", "")) : Number.NaN;
  const decimals = match?.[2]?.split(".")[1]?.length ?? 0;
  const grouped =
    match?.[2]?.includes(",") === true || (typeof value === "number" && target >= 1e4);
  const [shown, setShown] = useState(reducedMotion || !Number.isFinite(target) ? target : 0);

  useEffect(() => {
    if (reducedMotion || !Number.isFinite(target)) {
      setShown(target);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / 900);
      setShown(target * (1 - (1 - progress) ** 3));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, reducedMotion]);

  if (match === null || !Number.isFinite(target)) return <>{source}</>;
  const number = shown.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouped,
  });
  const suffix = typeof value === "number" && unit ? ` ${unit}` : "";
  return (
    <>
      {match[1]}
      {number}
      {match[3]}
      {suffix}
    </>
  );
}

function StatGrid({ items, unit }: { items: ReadonlyArray<ChartItem>; unit: string | undefined }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-2">
      {items.map((item, index) => (
        <div
          key={item.label + index}
          className="relative overflow-hidden rounded-xl border border-border/60 bg-card p-3 motion-safe:rpt-enter"
          style={{ animationDelay: `${index * 80}ms` }}
        >
          <span
            aria-hidden
            className="absolute inset-x-0 top-0 h-0.5"
            style={{ background: reportColor(index) }}
          />
          <div className="line-clamp-2 text-xs text-muted-foreground">{item.label}</div>
          <div className="mt-1 text-xl leading-tight font-semibold tabular-nums tracking-tight break-keep sm:text-2xl">
            <CountUp value={item.value} unit={unit} />
          </div>
          {item.delta !== undefined || item.hint !== undefined ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
              {item.delta !== undefined ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 font-medium tabular-nums",
                    item.delta >= 0
                      ? "bg-success/12 text-success"
                      : "bg-destructive/12 text-destructive",
                  )}
                >
                  {item.delta >= 0 ? "▲" : "▼"} {Math.abs(item.delta)}%
                </span>
              ) : null}
              {item.hint !== undefined ? (
                <span className="text-muted-foreground">{item.hint}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ProgressList({
  items,
  unit,
}: {
  items: ReadonlyArray<ChartItem>;
  unit: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-3">
      {items.map((item, index) => {
        const value = typeof item.value === "number" ? item.value : Number.parseFloat(item.value);
        const max = item.max ?? 100;
        const percent = Number.isFinite(value)
          ? Math.max(0, Math.min(100, (value / max) * 100))
          : 0;
        return (
          <div key={item.label + index} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{item.label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {item.max === undefined
                  ? `${percent.toFixed(0)}%`
                  : `${formatCompact(value)} / ${formatCompact(max)}${unit ? ` ${unit}` : ""}`}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted/60">
              <div
                className="h-full rounded-full motion-safe:rpt-grow-x"
                style={{
                  width: `${percent}%`,
                  background: reportColor(index),
                  animationDelay: `${index * 90}ms`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
