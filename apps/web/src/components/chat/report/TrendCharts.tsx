import { formatCompact, stackSeries, type ChartSpec } from "@t3tools/client-runtime/visual-blocks";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { smoothPath, spreadLabels } from "./chartLayout";
import {
  Legend,
  XAxisLabels,
  clipToWidth,
  reportColor,
  useWidth,
  widthAt,
  withUnit,
} from "./chartShared";

const finiteEntries = (data: ReadonlyArray<number>) =>
  data.flatMap((value, index) => (Number.isFinite(value) ? [{ value, index }] : []));

const dim = (active: number | null, index: number) =>
  active === null || active === index ? 1 : 0.2;

/** Change from the first to the last value as a StatGrid-style pill: ▲ 12.3% / ▼ 4.0%. */
function describeChange(first: number, last: number) {
  const diff = last - first;
  if (diff === 0) return { up: null, text: "= 0%" };
  const text =
    first === 0
      ? formatCompact(Math.abs(diff))
      : `${((Math.abs(diff) / Math.abs(first)) * 100).toFixed(1)}%`;
  return { up: diff > 0, text: `${diff > 0 ? "▲" : "▼"} ${text}` };
}

/** One compact row per series: name, a mini line, the latest value and its change. */
export function SparklineList({ spec }: { spec: ChartSpec }) {
  const [ref, measured] = useWidth(560);
  const width = Math.max(260, measured);
  const height = 28;
  const pad = 4;
  const count = spec.labels.length;
  const rows = spec.series.map((series) => {
    const points = finiteEntries(series.data);
    const first = points[0];
    const last = points.at(-1);
    return {
      series,
      points,
      last,
      change:
        first !== undefined && last !== undefined && points.length > 1
          ? describeChange(first.value, last.value)
          : null,
    };
  });
  const nameWidth = Math.min(150, Math.round(width * 0.28));
  // widthAt runs narrow for medium-weight tabular digits, so both columns get some slack.
  const valueWidth = Math.ceil(
    Math.max(
      ...rows.map((row) => widthAt(row.last ? withUnit(row.last.value, spec.unit) : "", 14)),
    ) * 1.15,
  );
  const changeWidth = Math.ceil(
    Math.max(...rows.map((row) => widthAt(row.change?.text ?? "", 12))) * 1.15 + 16,
  );
  const lineWidth = Math.max(48, width - nameWidth - valueWidth - changeWidth - 24);
  const xOf = (index: number) =>
    count === 1 ? lineWidth / 2 : pad + ((lineWidth - pad * 2) * index) / (count - 1);

  return (
    <div ref={ref} className="flex flex-col gap-2">
      {rows.map(({ series, points, last, change }, rowIndex) => {
        const values = points.map((point) => point.value);
        const lo = Math.min(...values);
        const hi = Math.max(...values);
        const y = (value: number) =>
          hi === lo ? height / 2 : height - pad - ((value - lo) / (hi - lo)) * (height - pad * 2);
        const coords = points.map((point) => [xOf(point.index), y(point.value)] as const);
        const line = smoothPath(coords);
        const delay = rowIndex * 70;
        return (
          <div
            key={series.name + rowIndex}
            className="flex items-center gap-2 motion-safe:rpt-enter"
            style={{ animationDelay: `${delay}ms` }}
          >
            <span className="truncate text-sm" style={{ width: nameWidth }}>
              {series.name}
            </span>
            <svg width={lineWidth} height={height} className="block shrink-0 overflow-visible">
              {coords.length > 1 ? (
                <path
                  d={`${line} L ${coords.at(-1)![0]} ${height} L ${coords[0]![0]} ${height} Z`}
                  fill={reportColor(rowIndex)}
                  fillOpacity={0.12}
                  className="motion-safe:rpt-fade"
                  style={{ animationDelay: `${delay + 300}ms` }}
                />
              ) : null}
              <path
                d={line}
                fill="none"
                stroke={reportColor(rowIndex)}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength={1}
                className="motion-safe:rpt-draw"
                style={{ animationDelay: `${delay + 100}ms` }}
              />
              {coords.length > 0 ? (
                <circle
                  cx={coords.at(-1)![0]}
                  cy={coords.at(-1)![1]}
                  r={2.5}
                  fill={reportColor(rowIndex)}
                  className="motion-safe:rpt-pop"
                  style={{ animationDelay: `${delay + 800}ms` }}
                />
              ) : null}
            </svg>
            <span
              className="shrink-0 text-right text-sm font-medium whitespace-nowrap tabular-nums"
              style={{ width: valueWidth }}
            >
              {last ? withUnit(last.value, spec.unit) : ""}
            </span>
            <span className="flex shrink-0 justify-end" style={{ width: changeWidth }}>
              {change === null ? null : (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-xs font-medium whitespace-nowrap tabular-nums",
                    change.up === null && "bg-muted/60 text-muted-foreground",
                    change.up === true && "bg-success/12 text-success",
                    change.up === false && "bg-destructive/12 text-destructive",
                  )}
                >
                  {change.text}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** First label against last label: one straight line per series between two vertical axes. */
export function SlopeChart({ spec }: { spec: ChartSpec }) {
  const [ref, measured] = useWidth(560);
  const width = Math.max(260, measured);
  const lastIndex = spec.labels.length - 1;
  const rows = spec.series.flatMap((series, index) => {
    const from = series.data[0];
    const to = series.data[lastIndex];
    return from !== undefined && to !== undefined && Number.isFinite(from) && Number.isFinite(to)
      ? [{ name: series.name, from, to, index }]
      : [];
  });
  const top = 34;
  const bottom = 14;
  const height = Math.max(220, rows.length * 16 + top + bottom);
  const fromText = rows.map((row) => withUnit(row.from, spec.unit));
  const toText = rows.map((row) => withUnit(row.to, spec.unit));
  const left = Math.ceil(Math.max(...fromText.map((text) => widthAt(text, 11)))) + 14;
  const right = Math.min(
    width * 0.45,
    Math.ceil(Math.max(...rows.map((row, at) => widthAt(`${toText[at]}  ${row.name}`, 11))) + 14),
  );
  const xFrom = left;
  const xTo = width - right;
  const all = rows.flatMap((row) => [row.from, row.to]);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const y = (value: number) =>
    hi === lo
      ? (top + height - bottom) / 2
      : height - bottom - ((value - lo) / (hi - lo)) * (height - top - bottom);
  const fromY = spreadLabels(
    rows.map((row) => y(row.from)),
    13,
    top,
    height - bottom,
  );
  const toY = spreadLabels(
    rows.map((row) => y(row.to)),
    13,
    top,
    height - bottom,
  );

  return (
    <div ref={ref}>
      <svg width={width} height={height} className="block overflow-visible" role="img">
        <g className="text-muted-foreground">
          {[xFrom, xTo].map((x) => (
            <line
              key={x}
              x1={x}
              x2={x}
              y1={top - 8}
              y2={height - bottom + 4}
              stroke="currentColor"
              strokeOpacity={0.25}
            />
          ))}
        </g>
        <text
          x={xFrom + 4}
          y={12}
          textAnchor="end"
          fontSize="11"
          className="fill-foreground font-medium"
        >
          {clipToWidth(spec.labels[0]!, left + 4, 11)}
        </text>
        <text x={xTo - 4} y={12} fontSize="11" className="fill-foreground font-medium">
          {clipToWidth(spec.labels[lastIndex]!, right + 4, 11)}
        </text>
        {rows.map((row, position) => {
          const delay = position * 80;
          const color = reportColor(row.index);
          return (
            <g key={row.name + row.index}>
              <title>{`${row.name}: ${fromText[position]} → ${toText[position]}`}</title>
              <line
                x1={xFrom}
                x2={xTo}
                y1={y(row.from)}
                y2={y(row.to)}
                stroke={color}
                strokeWidth={2.5}
                strokeLinecap="round"
                pathLength={1}
                className="motion-safe:rpt-draw"
                style={{ animationDelay: `${delay}ms` }}
              />
              {[
                [xFrom, y(row.from)],
                [xTo, y(row.to)],
              ].map(([cx, cy], end) => (
                <circle
                  key={end}
                  cx={cx}
                  cy={cy}
                  r={3.5}
                  fill={color}
                  stroke="var(--card)"
                  strokeWidth={1.5}
                  className="motion-safe:rpt-pop"
                  style={{ animationDelay: `${delay + 500}ms` }}
                />
              ))}
              <g className="motion-safe:rpt-fade" style={{ animationDelay: `${delay + 500}ms` }}>
                <text
                  x={xFrom - 8}
                  y={fromY[position]}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize="11"
                  className="fill-foreground font-medium"
                >
                  {fromText[position]}
                </text>
                <text x={xTo + 8} y={toY[position]} dy="0.32em" fontSize="11">
                  <tspan className="fill-foreground font-medium">{toText[position]}</tspan>
                  <tspan dx="6" className="fill-muted-foreground">
                    {clipToWidth(row.name, right - 8 - widthAt(toText[position]!, 11) - 6 - 4, 11)}
                  </tspan>
                </text>
              </g>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Rank over time: rank 1 at the top, one smooth line per series, hover to isolate one. */
export function BumpChart({ spec }: { spec: ChartSpec }) {
  const [ref, measured] = useWidth(560);
  const [active, setActive] = useState<number | null>(null);
  const width = Math.max(260, measured);
  const count = spec.labels.length;
  const series = spec.series.map((entry) => ({
    name: entry.name,
    points: finiteEntries(entry.data),
  }));
  const maxRank = Math.max(2, ...series.flatMap((entry) => entry.points.map((p) => p.value)));
  const rowHeight = 26;
  const top = 16;
  const bottom = 30;
  const height = top + (maxRank - 1) * rowHeight + bottom;
  // Room for the widest name (widthAt runs a little narrow) plus the dot radius and its gap.
  const nameRoom = (names: ReadonlyArray<string>) =>
    Math.min(
      width * 0.26,
      Math.ceil(Math.max(0, ...names.map((name) => widthAt(name, 11) * 1.1))) + 24,
    );
  const left = nameRoom(series.filter((e) => e.points.length > 0).map((e) => e.name));
  const right = left;
  const innerWidth = width - left - right;
  const spacing = count > 1 ? innerWidth / (count - 1) : innerWidth;
  const radius = Math.max(4, Math.min(9, spacing / 2 - 2));
  const xOf = (index: number) => (count === 1 ? left + innerWidth / 2 : left + spacing * index);
  const y = (rank: number) => top + (rank - 1) * rowHeight;
  const labelRange = [top, height - bottom] as const;
  const leftY = spreadLabels(
    series.map((e) => (e.points[0] ? y(e.points[0].value) : 0)),
    12,
    ...labelRange,
  );
  const rightY = spreadLabels(
    series.map((e) => (e.points.at(-1) ? y(e.points.at(-1)!.value) : 0)),
    12,
    ...labelRange,
  );

  return (
    <div ref={ref}>
      <svg width={width} height={height} className="block overflow-visible" role="img">
        <XAxisLabels labels={spec.labels} xOf={xOf} band={spacing || innerWidth} y={height - 10} />
        {series.map((entry, index) => {
          if (entry.points.length === 0) return null;
          const coords = entry.points.map((p) => [xOf(p.index), y(p.value)] as const);
          const first = entry.points[0]!;
          const last = entry.points.at(-1)!;
          const color = reportColor(index);
          return (
            <g
              key={entry.name + index}
              className="transition-opacity"
              style={{ opacity: dim(active, index) }}
              onPointerEnter={() => setActive(index)}
              onPointerLeave={() => setActive(null)}
            >
              <title>{entry.name}</title>
              <path
                d={smoothPath(coords)}
                fill="none"
                stroke={color}
                strokeWidth={active === index ? 3.5 : 2.5}
                strokeLinecap="round"
                pathLength={1}
                className="motion-safe:rpt-draw"
                style={{ animationDelay: `${index * 80}ms` }}
              />
              <path
                d={smoothPath(coords)}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                pointerEvents="stroke"
              />
              {entry.points.map((point, at) => (
                <g
                  key={point.index}
                  className="motion-safe:rpt-pop"
                  style={{ animationDelay: `${500 + index * 40 + at * 20}ms` }}
                >
                  <circle cx={coords[at]![0]} cy={coords[at]![1]} r={radius} fill={color} />
                  {radius >= 7 ? (
                    <text
                      x={coords[at]![0]}
                      y={coords[at]![1]}
                      dy="0.34em"
                      textAnchor="middle"
                      fontSize="9"
                      fontWeight={600}
                      fill="var(--card)"
                    >
                      {formatCompact(point.value)}
                    </text>
                  ) : null}
                </g>
              ))}
              <text
                x={xOf(first.index) - radius - 6}
                y={leftY[index]}
                dy="0.32em"
                textAnchor="end"
                fontSize="11"
                className="fill-foreground"
              >
                {clipToWidth(entry.name, left - radius - 8, 11)}
              </text>
              <text
                x={xOf(last.index) + radius + 6}
                y={rightY[index]}
                dy="0.32em"
                fontSize="11"
                className="fill-foreground"
              >
                {clipToWidth(entry.name, right - radius - 8, 11)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Stacked bands centered on a middle line; hover a band to isolate it. */
export function StreamChart({ spec }: { spec: ChartSpec }) {
  const [ref, measured] = useWidth(560);
  const [active, setActive] = useState<number | null>(null);
  const width = Math.max(260, measured);
  const height = 230;
  const margin = { top: 18, right: 14, bottom: 30, left: 14 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const count = spec.labels.length;
  const bands = stackSeries(spec.series, count, "silhouette");
  const extent = Math.max(...bands.flatMap((band) => band.upper.map(Math.abs)), 0) || 1;
  const centerY = margin.top + innerHeight / 2;
  const y = (value: number) => centerY - (value / extent) * (innerHeight / 2);
  const band = innerWidth / count;
  const xOf = (index: number) =>
    count === 1 ? margin.left + innerWidth / 2 : margin.left + (innerWidth * index) / (count - 1);

  return (
    <div ref={ref}>
      <Legend names={spec.series.map((series) => series.name)} />
      <svg width={width} height={height} className="block overflow-visible" role="img">
        <line
          x1={margin.left}
          x2={width - margin.right}
          y1={centerY}
          y2={centerY}
          stroke="currentColor"
          strokeOpacity={0.15}
          strokeDasharray="3 4"
          className="text-muted-foreground"
        />
        <XAxisLabels labels={spec.labels} xOf={xOf} band={band} y={height - 10} />
        <g className="motion-safe:rpt-reveal-x">
          {bands.map((entry, index) => {
            const upper = entry.upper.map((value, at) => [xOf(at), y(value)] as const);
            const lower = entry.lower.map((value, at) => [xOf(at), y(value)] as const);
            return (
              <path
                key={entry.name + index}
                d={`${smoothPath(upper)} ${smoothPath(lower.toReversed(), "L")} Z`}
                fill={reportColor(index)}
                fillOpacity={0.85}
                stroke="var(--card)"
                strokeWidth={1}
                className="transition-opacity"
                style={{ opacity: dim(active, index) }}
                onPointerEnter={() => setActive(index)}
                onPointerLeave={() => setActive(null)}
              >
                <title>{entry.name}</title>
              </path>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
