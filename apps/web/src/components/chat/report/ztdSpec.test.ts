import { describe, expect, it } from "vite-plus/test";

import type { ChartKind, ChartSpec } from "@t3tools/client-runtime/visual-blocks";
import { allValuesZero, ztdSpec } from "./ztdSpec";

const spec = (over: { kind: ChartKind } & Partial<ChartSpec>): ChartSpec => ({
  stacked: false,
  labels: [],
  series: [],
  items: [],
  days: [],
  ...over,
});

const labels = ["Jan", "Feb", "Mar"];
const series = [
  { name: "Desktop", data: [10, 20, 15] },
  { name: "Mobile", data: [5, 8, 12] },
];

describe("ztdSpec", () => {
  it("maps bar to a grouped vertical BarChart over long rows", () => {
    const [node] = ztdSpec(spec({ kind: "bar", labels, series, unit: "GB" }));
    expect(node?.component).toBe("BarChart");
    expect(node?.props.orientation).toBe("vertical");
    expect(node?.props.layout).toBe("grouped");
    expect(node?.props.x).toBe("x");
    expect(node?.props.series).toBe("series");
    expect(node?.props.unit).toBe("GB");
    expect(node?.props.data).toEqual([
      { x: "Jan", series: "Desktop", y: 10 },
      { x: "Jan", series: "Mobile", y: 5 },
      { x: "Feb", series: "Desktop", y: 20 },
      { x: "Feb", series: "Mobile", y: 8 },
      { x: "Mar", series: "Desktop", y: 15 },
      { x: "Mar", series: "Mobile", y: 12 },
    ]);
  });

  it("stacks a bar chart only when the spec asks and there is more than one series", () => {
    const stacked = ztdSpec(spec({ kind: "bar", labels, series, stacked: true }));
    expect(stacked[0]?.props.layout).toBe("stacked");
    const single = ztdSpec(spec({ kind: "bar", labels, stacked: true, series: [series[0]!] }));
    expect(single[0]?.props.layout).toBe("grouped");
  });

  it("keeps the full bar mapping for all-zero data so the zero baseline still renders", () => {
    // ztd's BarChart takes no max prop; its fitDomain([0, 0]) falls back to [0, 1], which keeps
    // the axis, ticks, category labels and baseline visible. The mapping just carries the zeros.
    const [node] = ztdSpec(
      spec({
        kind: "bar",
        labels: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        series: [
          { name: "Web", data: [0, 0, 0, 0, 0] },
          { name: "CLI", data: [0, 0, 0, 0, 0] },
        ],
        unit: "deploys",
      }),
    );
    expect(node?.component).toBe("BarChart");
    expect(node?.props.orientation).toBe("vertical");
    expect(node?.props.unit).toBe("deploys");
    expect(node?.props.data).toEqual(
      ["Mon", "Tue", "Wed", "Thu", "Fri"].flatMap((x) => [
        { x, series: "Web", y: 0 },
        { x, series: "CLI", y: 0 },
      ]),
    );
  });

  it("maps hbar to a horizontal BarChart", () => {
    const [node] = ztdSpec(spec({ kind: "hbar", labels, series: [series[0]!] }));
    expect(node?.component).toBe("BarChart");
    expect(node?.props.orientation).toBe("horizontal");
  });

  it("maps line to a categorical LineChart", () => {
    const [node] = ztdSpec(spec({ kind: "line", labels, series }));
    expect(node?.component).toBe("LineChart");
    expect(node?.props.colorMode).toBe("categorical");
    expect(node?.props.highlight).toBe("none");
    expect(node?.props.curve).toBeUndefined();
    expect(node?.props.stack).toBeUndefined();
  });

  it("maps step to a LineChart with a step curve", () => {
    const [node] = ztdSpec(spec({ kind: "step", labels, series: [series[0]!] }));
    expect(node?.component).toBe("LineChart");
    expect(node?.props.curve).toBe("step");
  });

  it("maps area and honours the stacked flag", () => {
    const [plain] = ztdSpec(spec({ kind: "area", labels, series }));
    expect(plain?.component).toBe("AreaChart");
    expect(plain?.props.stack).toBe("none");

    const [stacked] = ztdSpec(spec({ kind: "area", labels, series, stacked: true }));
    expect(stacked?.props.stack).toBe("stacked");
  });

  it("maps a one-label line, step and area to the bar mapping so the lone value reads", () => {
    for (const kind of ["line", "step", "area"] as const) {
      const [node] = ztdSpec(
        spec({ kind, labels: ["Today"], series: [{ name: "Stars", data: [812] }], unit: "stars" }),
      );
      expect(node?.component).toBe("BarChart");
      expect(node?.props.orientation).toBe("vertical");
      expect(node?.props.layout).toBe("grouped");
      expect(node?.props.curve).toBeUndefined();
      expect(node?.props.stack).toBeUndefined();
      expect(node?.props.data).toEqual([{ x: "Today", series: "Stars", y: 812 }]);
      expect(node?.props.unit).toBe("stars");
    }
  });

  it("keeps every series when a one-label chart maps to bars", () => {
    const [node] = ztdSpec(spec({ kind: "line", labels: ["Today"], series }));
    expect(node?.component).toBe("BarChart");
    expect(node?.props.data).toEqual([
      { x: "Today", series: "Desktop", y: 10 },
      { x: "Today", series: "Mobile", y: 5 },
    ]);
  });

  it("drops non-finite points so ztd draws a gap there", () => {
    const [node] = ztdSpec(
      spec({ kind: "line", labels, series: [{ name: "A", data: [1, Number.NaN, 3] }] }),
    );
    expect(node?.props.data).toEqual([
      { x: "Jan", series: "A", y: 1 },
      { x: "Mar", series: "A", y: 3 },
    ]);
  });

  it("maps sparkline to one row per series carrying its name", () => {
    const nodes = ztdSpec(spec({ kind: "sparkline", labels, series }));
    expect(nodes.map((node) => node.component)).toEqual(["Sparkline", "Sparkline"]);
    expect(nodes.map((node) => node.name)).toEqual(["Desktop", "Mobile"]);
    expect(nodes[1]?.props.data).toEqual([
      { x: "Jan", y: 5 },
      { x: "Feb", y: 8 },
      { x: "Mar", y: 12 },
    ]);
    expect(nodes[0]?.props.variant).toBe("area");
  });

  it("maps slope to the first and last points with period labels", () => {
    const [node] = ztdSpec(spec({ kind: "slope", labels, series: [series[0]!] }));
    expect(node?.component).toBe("SlopeChart");
    expect(node?.props.data).toEqual([
      { label: "Desktop", x: "Jan", value: 10 },
      { label: "Desktop", x: "Mar", value: 15 },
    ]);
    expect(node?.props.periodLabels).toEqual(["Jan", "Mar"]);
    expect(node?.props.label).toBe("label");
  });

  it("maps bump to rank lines read from the y field", () => {
    const [node] = ztdSpec(spec({ kind: "bump", labels, series }));
    expect(node?.component).toBe("BumpChart");
    expect(node?.props.rank).toBe("y");
    expect(node?.props.series).toBe("series");
  });

  it("maps calendar to a CalendarHeatmap over the days", () => {
    const [node] = ztdSpec(
      spec({
        kind: "calendar",
        days: [
          { date: "2026-10-01", value: 3 },
          { date: "2026-10-02", value: 0 },
        ],
      }),
    );
    expect(node?.component).toBe("CalendarHeatmap");
    expect(node?.props.date).toBe("date");
    expect(node?.props.value).toBe("value");
    expect(node?.props.data).toEqual([
      { date: "2026-10-01", value: 3 },
      { date: "2026-10-02", value: 0 },
    ]);
  });

  it("maps stream to a silhouette StreamGraph", () => {
    const [node] = ztdSpec(spec({ kind: "stream", labels, series }));
    expect(node?.component).toBe("StreamGraph");
    expect(node?.props.offset).toBe("silhouette");
    expect(node?.props.highlight).toBe("none");
  });

  it("maps pie to a categorical PieChart that drops zero and negative slices", () => {
    const [node] = ztdSpec(
      spec({ kind: "pie", labels: ["A", "B", "C"], series: [{ name: "S", data: [4, 0, 2] }] }),
    );
    expect(node?.component).toBe("PieChart");
    expect(node?.props.colorMode).toBe("categorical");
    expect(node?.props.data).toEqual([
      { label: "A", value: 4 },
      { label: "C", value: 2 },
    ]);
  });

  it("maps donut to a DonutChart with a total centre", () => {
    const [node] = ztdSpec(
      spec({
        kind: "donut",
        labels: ["A", "B"],
        series: [{ name: "S", data: [1, 2] }],
        unit: "USD",
      }),
    );
    expect(node?.component).toBe("DonutChart");
    expect(node?.props.centerValue).toBe("total");
    expect(node?.props.centerLabel).toBe("USD");
  });

  it("maps stats to one StatCard per item", () => {
    const nodes = ztdSpec(
      spec({
        kind: "stats",
        items: [
          { label: "Revenue", value: 1234, delta: 4.2, hint: "Q4" },
          { label: "Share", value: "$482K" },
          { label: "Churn", value: 12, delta: -3 },
        ],
      }),
    );
    expect(nodes).toHaveLength(3);
    expect(nodes.every((node) => node.component === "StatCard")).toBe(true);
    expect(nodes[0]?.props.label).toBe("Revenue");
    expect(nodes[0]?.props.data).toEqual([{ x: "Revenue", y: 1234 }]);
    expect(nodes[0]?.props.value).toBeUndefined();
    expect(nodes[0]?.props.delta).toBe("+4.2%");
    expect(nodes[0]?.props.note).toBe("Q4");
    expect(nodes[1]?.props.value).toBe("$482K");
    expect(nodes[1]?.props.delta).toBeNull();
    expect(nodes[2]?.props.delta).toBe("-3%");
  });

  it("maps progress to a BulletChart whose target is the item max or 100", () => {
    const [node] = ztdSpec(
      spec({
        kind: "progress",
        items: [
          { label: "Uptime", value: 99.9 },
          { label: "Quota", value: 720, max: 1000 },
        ],
        unit: "TB",
      }),
    );
    expect(node?.component).toBe("BulletChart");
    expect(node?.props.data).toEqual([
      { label: "Uptime", value: 99.9, target: 100 },
      { label: "Quota", value: 720, target: 1000 },
    ]);
    expect(node?.props.unit).toBe("TB");
  });

  it("carries the title as the accessible name", () => {
    const [node] = ztdSpec(spec({ kind: "bar", labels, series: [series[0]!], title: "Usage" }));
    expect(node?.props.ariaLabel).toBe("Usage");
  });
});

describe("allValuesZero", () => {
  it("is true for a bar chart whose only series is all zeros", () => {
    expect(
      allValuesZero(
        spec({
          kind: "bar",
          labels: ["Mon", "Tue", "Wed", "Thu", "Fri"],
          series: [{ name: "Web", data: [0, 0, 0, 0, 0] }],
        }),
      ),
    ).toBe(true);
  });

  it("is false as soon as one plotted value is non-zero", () => {
    expect(
      allValuesZero(
        spec({
          kind: "bar",
          labels: ["Mon", "Tue", "Wed"],
          series: [
            { name: "Web", data: [0, 0, 0] },
            { name: "CLI", data: [0, 3, 0] },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("is true for a pie chart whose slices are all zero, so the note explains the blank", () => {
    expect(
      allValuesZero(
        spec({ kind: "pie", labels: ["A", "B"], series: [{ name: "S", data: [0, 0] }] }),
      ),
    ).toBe(true);
  });

  it("is false for stats and other kinds where a 0 is meaningful or not a magnitude", () => {
    expect(allValuesZero(spec({ kind: "stats", items: [{ label: "Revenue", value: 0 }] }))).toBe(
      false,
    );
    expect(allValuesZero(spec({ kind: "progress", items: [{ label: "Quota", value: 0 }] }))).toBe(
      false,
    );
    expect(
      allValuesZero(spec({ kind: "calendar", days: [{ date: "2026-10-01", value: 0 }] })),
    ).toBe(false);
    expect(
      allValuesZero(spec({ kind: "bump", labels, series: [{ name: "A", data: [0, 0, 0] }] })),
    ).toBe(false);
  });

  it("is false when the spec carries no numeric values at all", () => {
    expect(allValuesZero(spec({ kind: "bar", labels, series: [] }))).toBe(false);
  });
});
