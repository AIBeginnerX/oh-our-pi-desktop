import { layoutCalendar, type ChartSpec } from "@t3tools/client-runtime/visual-blocks";
import { useMemo } from "react";

import { useT } from "~/i18n";
import { reportColor, useWidth, widthAt, withUnit } from "./chartShared";

const LEVEL_OPACITY = [0, 0.3, 0.5, 0.75, 1] as const;
const GAP = 3;
const TOP = 16;
/** A month label is dropped when the next month starts less than this many weeks later. */
const MONTH_LABEL_WEEKS = 3;

// 2024-01-07 was a Sunday, so day offsets from it give weekday names by row.
const SUNDAY = Date.UTC(2024, 0, 7);

/** GitHub-style contribution grid: weeks as columns, Sunday to Saturday as rows. */
export function CalendarHeatmap({ spec }: { spec: ChartSpec }) {
  const t = useT();
  const [ref, width] = useWidth(560);
  const layout = useMemo(() => layoutCalendar(spec.days), [spec.days]);
  const names = useMemo(() => {
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
    const month = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });
    return {
      weekday: (row: number) => weekday.format(SUNDAY + row * 86_400_000),
      month: (year: number, index: number) => month.format(Date.UTC(year, index, 1)),
    };
  }, []);
  if (layout.weeks === 0) return null;

  const labelRows = [1, 3, 5];
  const gutter = Math.max(
    24,
    Math.ceil(Math.max(...labelRows.map((row) => widthAt(names.weekday(row), 10)))) + 6,
  );
  const cell = Math.min(14, Math.max(8, Math.floor((width - gutter) / layout.weeks - GAP)));
  const step = cell + GAP;
  const gridWidth = gutter + layout.weeks * step - GAP;
  const gridHeight = TOP + 7 * step - GAP;
  const months = layout.months.filter(
    (entry, index) =>
      index === layout.months.length - 1 ||
      layout.months[index + 1]!.week - entry.week >= MONTH_LABEL_WEEKS,
  );

  return (
    <div ref={ref}>
      <div className="overflow-x-auto">
        <svg width={gridWidth} height={gridHeight} className="block" role="img">
          {months.map((entry) => (
            <text
              key={`${entry.year}-${entry.month}`}
              x={gutter + entry.week * step}
              y={9}
              fontSize="10"
              className="fill-muted-foreground"
            >
              {names.month(entry.year, entry.month)}
            </text>
          ))}
          {labelRows.map((row) => (
            <text
              key={row}
              x={0}
              y={TOP + row * step + cell / 2}
              dy="0.32em"
              fontSize="10"
              className="fill-muted-foreground"
            >
              {names.weekday(row)}
            </text>
          ))}
          {layout.cells.map((entry) => (
            <rect
              key={entry.date}
              x={gutter + entry.week * step}
              y={TOP + entry.weekday * step}
              width={cell}
              height={cell}
              rx={2}
              fill={entry.level === 0 ? undefined : reportColor(0)}
              fillOpacity={entry.level === 0 ? undefined : LEVEL_OPACITY[entry.level]}
              className={
                entry.level === 0 ? "fill-muted/70 motion-safe:rpt-pop" : "motion-safe:rpt-pop"
              }
              style={{ animationDelay: `${Math.min(entry.week * 14, 700)}ms` }}
            >
              <title>
                {entry.value === null
                  ? `${entry.date}: ${t("no data")}`
                  : `${entry.date}: ${withUnit(entry.value, spec.unit)}`}
              </title>
            </rect>
          ))}
        </svg>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {t("Total")}:{" "}
          <span className="font-medium text-foreground">{withUnit(layout.total, spec.unit)}</span>
        </span>
        <span className="flex items-center gap-1">
          {t("Less")}
          {LEVEL_OPACITY.map((opacity, level) => (
            <span
              key={level}
              className={level === 0 ? "size-2.5 rounded-xs bg-muted/70" : "size-2.5 rounded-xs"}
              style={level === 0 ? undefined : { background: reportColor(0), opacity }}
            />
          ))}
          {t("More")}
        </span>
      </div>
    </div>
  );
}
