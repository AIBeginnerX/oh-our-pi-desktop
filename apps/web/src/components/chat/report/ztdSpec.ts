/**
 * Maps an OOP ```chart spec to ztd-charts components. Pure data in, plain props out: the React
 * rendering lives in ZtdChartView, so every kind stays unit-testable without a DOM. Most kinds
 * map to one node; sparkline and stats map to one node per series/item, which the view lays out.
 */
import type { ChartSpec } from "@t3tools/client-runtime/visual-blocks";

export type ZtdComponentName =
  | "AreaChart"
  | "BarChart"
  | "BulletChart"
  | "BumpChart"
  | "CalendarHeatmap"
  | "DonutChart"
  | "LineChart"
  | "PieChart"
  | "SlopeChart"
  | "Sparkline"
  | "StatCard"
  | "StreamGraph";

export interface ZtdNode {
  readonly component: ZtdComponentName;
  /** Props for the ztd-charts component of the same name. */
  readonly props: Readonly<Record<string, unknown>>;
  /** Series name for Sparkline rows; the view renders it beside the sparkline. */
  readonly name?: string;
}

const isFinite = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value);

/** One row per finite series point (long table), so any series name works as a legend label. */
function longRows(spec: ChartSpec): Array<{ x: string; series: string; y: number }> {
  const rows: Array<{ x: string; series: string; y: number }> = [];
  for (const [index, label] of spec.labels.entries()) {
    for (const series of spec.series) {
      const value = series.data[index];
      if (!isFinite(value)) continue;
      rows.push({ x: label, series: series.name, y: value });
    }
  }
  return rows;
}

function baseProps(spec: ChartSpec): Record<string, unknown> {
  return {
    ...(spec.unit === undefined ? {} : { unit: spec.unit }),
    ...(spec.title === undefined ? {} : { ariaLabel: spec.title }),
  };
}

/** The bar mapping, shared by bar/hbar and by one-label line/step/area (a line needs two points). */
function barNode(spec: ChartSpec): ZtdNode {
  return {
    component: "BarChart",
    props: {
      ...baseProps(spec),
      data: longRows(spec),
      x: "x",
      y: "y",
      series: "series",
      orientation: spec.kind === "hbar" ? "horizontal" : "vertical",
      layout: spec.stacked && spec.series.length > 1 ? "stacked" : "grouped",
      highlight: "none",
      format: "compact",
    },
  };
}

/**
 * True when the spec carries numeric values and every one of them is 0. Such a chart plots a flat
 * zero baseline (or, for pie/donut, no slices at all), so the view adds a note explaining the blank.
 * Kinds where 0 is a real value (stats, progress, calendar) or a rank (bump) always return false.
 */
export function allValuesZero(spec: ChartSpec): boolean {
  switch (spec.kind) {
    case "bar":
    case "hbar":
    case "line":
    case "area":
    case "step":
    case "sparkline":
    case "slope":
    case "stream":
    case "pie":
    case "donut": {
      const values = spec.series.flatMap((series) => series.data).filter(isFinite);
      return values.length > 0 && values.every((value) => value === 0);
    }
    case "bump":
    case "calendar":
    case "stats":
    case "progress":
      return false;
  }
}

export function ztdSpec(spec: ChartSpec): ReadonlyArray<ZtdNode> {
  switch (spec.kind) {
    case "bar":
    case "hbar":
      return [barNode(spec)];

    case "line":
    case "step":
    case "area": {
      if (spec.labels.length === 1) return [barNode(spec)];
      const isArea = spec.kind === "area";
      return [
        {
          component: isArea ? "AreaChart" : "LineChart",
          props: {
            ...baseProps(spec),
            data: longRows(spec),
            x: "x",
            y: "y",
            series: "series",
            colorMode: "categorical",
            highlight: "none",
            format: "compact",
            ...(spec.kind === "step" ? { curve: "step" } : {}),
            ...(isArea
              ? { stack: spec.stacked && spec.series.length > 1 ? "stacked" : "none" }
              : {}),
          },
        },
      ];
    }

    case "sparkline":
      return spec.series.map((series) => ({
        component: "Sparkline",
        name: series.name,
        props: {
          data: series.data.flatMap((value, index) =>
            isFinite(value) ? [{ x: spec.labels[index] ?? String(index + 1), y: value }] : [],
          ),
          x: "x",
          y: "y",
          variant: "area",
          format: "compact",
          ...baseProps(spec),
        },
      }));

    case "slope": {
      const first = spec.labels[0] ?? "";
      const last = spec.labels.at(-1) ?? first;
      const data = spec.series.flatMap((series) => {
        const start = series.data[0];
        const end = series.data.at(-1);
        return [
          ...(isFinite(start) ? [{ label: series.name, x: first, value: start }] : []),
          ...(isFinite(end) ? [{ label: series.name, x: last, value: end }] : []),
        ];
      });
      return [
        {
          component: "SlopeChart",
          props: {
            ...baseProps(spec),
            data,
            label: "label",
            x: "x",
            value: "value",
            periodLabels: [first, last],
            format: "compact",
          },
        },
      ];
    }

    case "bump":
      return [
        {
          component: "BumpChart",
          props: {
            ...baseProps(spec),
            data: longRows(spec),
            x: "x",
            series: "series",
            rank: "y",
            highlight: "none",
          },
        },
      ];

    case "calendar":
      return [
        {
          component: "CalendarHeatmap",
          props: {
            ...baseProps(spec),
            data: spec.days.map((day) => ({ date: day.date, value: day.value })),
            date: "date",
            value: "value",
          },
        },
      ];

    case "stream":
      return [
        {
          component: "StreamGraph",
          props: {
            ...baseProps(spec),
            data: longRows(spec),
            x: "x",
            y: "y",
            series: "series",
            offset: "silhouette",
            highlight: "none",
          },
        },
      ];

    case "pie":
    case "donut": {
      const series = spec.series[0];
      const data = spec.labels.flatMap((label, index) => {
        const value = series?.data[index];
        return isFinite(value) && value > 0 ? [{ label, value }] : [];
      });
      return [
        {
          component: spec.kind === "donut" ? "DonutChart" : "PieChart",
          props: {
            ...baseProps(spec),
            data,
            label: "label",
            value: "value",
            colorMode: "categorical",
            highlight: "none",
            format: "compact",
            ...(spec.kind === "donut" && spec.unit !== undefined
              ? { centerValue: "total", centerLabel: spec.unit }
              : {}),
          },
        },
      ];
    }

    case "stats":
      return spec.items.map((item) => ({
        component: "StatCard",
        props: {
          label: item.label,
          data: [{ x: item.label, y: typeof item.value === "number" ? item.value : Number.NaN }],
          ...(typeof item.value === "string" ? { value: item.value } : {}),
          delta: item.delta === undefined ? null : `${item.delta >= 0 ? "+" : ""}${item.delta}%`,
          ...(item.hint === undefined ? {} : { note: item.hint }),
          format: "compact",
          ...baseProps(spec),
        },
      }));

    case "progress":
      return [
        {
          component: "BulletChart",
          props: {
            ...baseProps(spec),
            data: spec.items.map((item) => ({
              label: item.label,
              value: typeof item.value === "number" ? item.value : Number.parseFloat(item.value),
              target: item.max ?? 100,
            })),
            label: "label",
            value: "value",
            target: "target",
            format: "compact",
          },
        },
      ];
  }
}
