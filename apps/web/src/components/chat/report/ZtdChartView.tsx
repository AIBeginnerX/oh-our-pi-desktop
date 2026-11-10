import type { ChartSpec } from "@t3tools/client-runtime/visual-blocks";
import {
  AreaChart,
  BarChart,
  BulletChart,
  BumpChart,
  CalendarHeatmap,
  DonutChart,
  LineChart,
  PieChart,
  SlopeChart,
  Sparkline,
  StatCard,
  StreamGraph,
  ThemeProvider,
  type ThemeInput,
} from "ztd-charts";
import { useMemo, type ComponentType } from "react";

import { useTheme } from "~/hooks/useTheme";

import { useT } from "~/i18n";
import { allValuesZero, ztdSpec } from "./ztdSpec";

const CHARTS = {
  AreaChart,
  BarChart,
  BulletChart,
  BumpChart,
  CalendarHeatmap,
  DonutChart,
  LineChart,
  PieChart,
  SlopeChart,
  Sparkline,
  StatCard,
  StreamGraph,
};

// Paints come from app vars; these hex fallbacks only feed ztd's contrast maths when a var() reference cannot be resolved.
const ztdTheme = (dark: boolean): ThemeInput => ({
  bg: "transparent",
  panel: "transparent",
  accent: "var(--report-1, #6366f1)",
  accentText: "var(--report-1, #6366f1)",
  onAccent: dark ? "var(--background, #14171B)" : "var(--background, #FFFFFF)",
  onInk: dark ? "var(--background, #14171B)" : "var(--background, #FFFFFF)",
  ink: dark ? "var(--foreground, #F1F3F5)" : "var(--foreground, #14171B)",
  muted: dark ? "var(--muted-foreground, #A3ABB5)" : "var(--muted-foreground, #5D6570)",
  dim: dark ? "var(--muted-foreground, #5B636D)" : "var(--muted-foreground, #B3B9C2)",
  line: dark ? "var(--border, #2A2F36)" : "var(--border, #E6E9ED)",
  line2: dark ? "var(--border, #22272D)" : "var(--border, #F0F2F5)",
});

/** One ```chart block drawn with ztd-charts; charts animate in once when scrolled into view. */
export default function ZtdChartView({ spec }: { spec: ChartSpec }) {
  const t = useT();
  const dark = useTheme().resolvedTheme === "dark";
  const theme = useMemo(() => ztdTheme(dark), [dark]);
  const nodes = useMemo(() => ztdSpec(spec), [spec]);
  const zero = useMemo(() => allValuesZero(spec), [spec]);
  const stats = spec.kind === "stats";
  const sparklines = spec.kind === "sparkline";

  return (
    <ThemeProvider theme={theme} base={dark ? "dark" : "light"} className="oop-ztd">
      <div className={stats ? "grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-2" : ""}>
        {nodes.map((node, index) => {
          // ztd's components are generic over their row type; the props come prebuilt from
          // ztdSpec, so the bridge only needs one call-site cast.
          const Chart = CHARTS[node.component] as unknown as ComponentType<Record<string, unknown>>;
          return (
            <div
              key={node.name ?? `${node.component}-${index}`}
              className={sparklines ? "flex min-w-0 items-center gap-3 py-1" : undefined}
            >
              {node.name === undefined ? null : (
                <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
                  {node.name}
                </span>
              )}
              <div className={sparklines ? "min-w-0 flex-1" : undefined}>
                <Chart {...node.props} />
              </div>
            </div>
          );
        })}
      </div>
      {zero ? <p className="mt-1 text-xs text-muted-foreground">{t("All values are 0")}</p> : null}
    </ThemeProvider>
  );
}
