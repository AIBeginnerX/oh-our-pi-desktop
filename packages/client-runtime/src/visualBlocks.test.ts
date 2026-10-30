import { describe, expect, it } from "vite-plus/test";

import {
  formatCompact,
  layoutCalendar,
  layoutFlowchart,
  niceScale,
  parseChartSpec,
  parseFlowchart,
  stackSeries,
} from "./visualBlocks.ts";

describe("parseChartSpec", () => {
  it("reads a bar chart with several series", () => {
    const spec = parseChartSpec(
      JSON.stringify({
        type: "bar",
        title: "Revenue",
        unit: "B",
        labels: ["Q1", "Q2", "Q3"],
        series: [
          { name: "2025", data: [10, 12, "14"] },
          { name: "2026", data: [11, 15, 18] },
        ],
      }),
    );
    expect(spec?.kind).toBe("bar");
    expect(spec?.series.map((entry) => entry.data)).toEqual([
      [10, 12, 14],
      [11, 15, 18],
    ]);
  });

  it("accepts Chart.js datasets and object rows", () => {
    expect(
      parseChartSpec('{"type":"line","labels":["a","b"],"datasets":[{"label":"x","data":[1,2]}]}')
        ?.series[0]?.name,
    ).toBe("x");
    const pie = parseChartSpec(
      '{"type":"doughnut","data":[{"label":"A","value":"1,200"},{"label":"B","value":800}]}',
    );
    expect(pie?.kind).toBe("donut");
    expect(pie?.labels).toEqual(["A", "B"]);
    expect(pie?.series[0]?.data).toEqual([1200, 800]);
  });

  it("keeps formatted stat values as written", () => {
    const stats = parseChartSpec(
      '{"type":"kpi","items":[{"label":"Revenue","value":"12.3T","delta":4.2},{"label":"Users","value":"1,024"}]}',
    );
    expect(stats?.items).toEqual([
      { label: "Revenue", value: "12.3T", delta: 4.2 },
      { label: "Users", value: 1024 },
    ]);
  });

  it("returns null for unfinished or unknown blocks so the code block shows instead", () => {
    expect(parseChartSpec('{"type":"bar","labels":["a"')).toBeNull();
    expect(parseChartSpec('{"type":"sankey","labels":["a"],"data":[1]}')).toBeNull();
    expect(parseChartSpec('{"type":"bar","labels":["a"],"data":["n/a"]}')).toBeNull();
  });
});

describe("chart kinds", () => {
  const manySeries = (type: string, count: number, labels = ["a", "b"]) =>
    parseChartSpec(
      JSON.stringify({
        type,
        labels,
        series: Array.from({ length: count }, (_, index) => ({
          name: `s${index}`,
          data: labels.map((_, at) => index + at),
        })),
      }),
    );

  it("maps aliases to the new kinds", () => {
    const kindOf = (type: string) => manySeries(type, 1)?.kind;
    expect(
      ["steps", "stepline", "spark", "slopegraph", "bump-chart", "ranks", "streamgraph"].map(
        kindOf,
      ),
    ).toEqual(["step", "step", "sparkline", "slope", "bump", "bump", "stream"]);
    expect(
      ["heatmap", "contributions"].map(
        (type) => parseChartSpec(`{"type":"${type}","days":{"2026-10-01":1}}`)?.kind,
      ),
    ).toEqual(["calendar", "calendar"]);
  });

  it("treats stacked-area aliases as a stacked area chart", () => {
    for (const type of ["stacked-area", "stackedarea", "area-stacked"]) {
      const spec = manySeries(type, 2);
      expect([spec?.kind, spec?.stacked]).toEqual(["area", true]);
    }
    expect(manySeries("area", 2)?.stacked).toBe(false);
  });

  it("caps series at 12 for sparkline, slope and bump but 6 for line", () => {
    expect(
      ["sparkline", "slope", "bump", "line", "stream"].map(
        (type) => manySeries(type, 20)?.series.length,
      ),
    ).toEqual([12, 12, 12, 6, 6]);
  });

  it("needs at least two labels for a slope chart", () => {
    expect(manySeries("slope", 2, ["2025"])).toBeNull();
    expect(manySeries("slope", 2, ["2025", "2026"])?.labels).toHaveLength(2);
  });
});

describe("calendar charts", () => {
  const parse = (days: unknown) => parseChartSpec(JSON.stringify({ type: "calendar", days }));

  it("reads an array of objects, an object map, and pairs", () => {
    const expected = [
      { date: "2026-10-01", value: 3 },
      { date: "2026-10-02", value: 5 },
    ];
    expect(
      parse([
        { day: "2026-10-02", count: "5" },
        { date: "2026-10-01", value: 3 },
      ])?.days,
    ).toEqual(expected);
    expect(parse({ "2026-10-02": 5, "2026-10-01": 3 })?.days).toEqual(expected);
    expect(
      parse([
        ["2026-10-01", 3],
        ["2026-10-02", "5"],
      ])?.days,
    ).toEqual(expected);
    const spec = parseChartSpec('{"type":"calendar","data":{"2026-10-01":3}}');
    expect([spec?.labels, spec?.series, spec?.items]).toEqual([[], [], []]);
    expect(spec?.days).toHaveLength(1);
  });

  it("drops invalid dates and values, and the last duplicate wins", () => {
    const spec = parse({ "2026-02-30": 1, "10/01/2026": 2, "2026-10-03": "n/a" });
    expect(spec).toBeNull();
    expect(
      parse([
        ["2026-10-01", 1],
        ["2026-10-01", 9],
        ["2026-2-1", 4],
      ])?.days,
    ).toEqual([{ date: "2026-10-01", value: 9 }]);
    expect(parse([])).toBeNull();
  });

  it("keeps only the most recent 371 days", () => {
    // 400 consecutive days from 2025-01-01 (neither year is a leap year).
    const monthLengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31, 31, 28];
    const days: Record<string, number> = {};
    let index = 0;
    monthLengths.forEach((length, month) => {
      for (let day = 1; day <= length && index < 400; day += 1, index += 1) {
        days[
          `${2025 + Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
        ] = index;
      }
    });
    const kept = parse(days)?.days;
    expect(kept).toHaveLength(371);
    expect(kept?.at(-1)?.value).toBe(399);
    expect(kept?.[0]?.value).toBe(29);
  });
});

describe("stackSeries", () => {
  const series = [
    { name: "a", data: [1, 2, Number.NaN] },
    { name: "b", data: [3, -4] },
    { name: "c", data: [2, 2, 2] },
  ];

  it("stacks up from zero in input order, treating missing, NaN and negative as 0", () => {
    const bands = stackSeries(series, 3, "zero");
    expect(bands.map((band) => band.name)).toEqual(["a", "b", "c"]);
    expect(bands[0]?.lower).toEqual([0, 0, 0]);
    expect(bands[0]?.upper).toEqual([1, 2, 0]);
    expect(bands[1]?.upper).toEqual([4, 2, 0]);
    expect(bands[2]?.lower).toEqual([4, 2, 0]);
    expect(bands[2]?.upper).toEqual([6, 4, 2]);
  });

  it("centers each column on zero for a silhouette", () => {
    const bands = stackSeries(series, 3, "silhouette");
    for (let index = 0; index < 3; index += 1) {
      expect(bands[0]!.lower[index]).toBeCloseTo(-bands.at(-1)!.upper[index]!);
    }
    expect(bands[0]?.lower).toEqual([-3, -2, -1]);
    expect(bands.at(-1)?.upper).toEqual([3, 2, 1]);
  });
});

describe("layoutCalendar", () => {
  it("returns an empty layout for no days", () => {
    expect(layoutCalendar([])).toEqual({ weeks: 0, cells: [], months: [], max: 0, total: 0 });
  });

  it("places a range that starts mid-week into Sunday-first columns", () => {
    // 2026-10-29 is a Thursday; the range crosses into November.
    const layout = layoutCalendar([
      { date: "2026-11-03", value: 4 },
      { date: "2026-10-29", value: 1 },
      { date: "2026-10-31", value: 0 },
    ]);
    expect(layout.cells.map((cell) => [cell.date, cell.week, cell.weekday])).toEqual([
      ["2026-10-29", 0, 4],
      ["2026-10-30", 0, 5],
      ["2026-10-31", 0, 6],
      ["2026-11-01", 1, 0],
      ["2026-11-02", 1, 1],
      ["2026-11-03", 1, 2],
    ]);
    expect(layout.weeks).toBe(2);
    expect(layout.months).toEqual([
      { week: 0, month: 9, year: 2026 },
      { week: 1, month: 10, year: 2026 },
    ]);
    expect([layout.max, layout.total]).toEqual([4, 5]);
  });

  it("levels by share of the largest value and leaves gaps null", () => {
    const layout = layoutCalendar([
      { date: "2026-10-04", value: 0 },
      { date: "2026-10-06", value: 1 },
      { date: "2026-10-07", value: 5 },
      { date: "2026-10-08", value: 10 },
    ]);
    expect(layout.cells.map((cell) => [cell.value, cell.level])).toEqual([
      [0, 0],
      [null, 0],
      [1, 1],
      [5, 2],
      [10, 4],
    ]);
    expect(layout.months).toEqual([{ week: 0, month: 9, year: 2026 }]);
  });

  it("does not shift days across a DST change", () => {
    const layout = layoutCalendar([
      { date: "2026-10-30", value: 1 },
      { date: "2026-11-02", value: 1 },
    ]);
    expect(layout.cells.map((cell) => cell.date)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });
});

describe("chart scales", () => {
  it("rounds axis bounds and includes zero", () => {
    expect(niceScale(3, 87)).toEqual({ min: 0, max: 100, ticks: [0, 25, 50, 75, 100] });
    expect(niceScale(-12, 30).min).toBeLessThan(0);
  });

  it("formats large and small numbers compactly", () => {
    expect([formatCompact(1_234_567), formatCompact(45_000), formatCompact(0.456)]).toEqual([
      "1.2M",
      "45K",
      "0.46",
    ]);
  });
});

describe("parseFlowchart", () => {
  it("reads shapes, labels, chains, and edge styles", () => {
    const chart = parseFlowchart(
      [
        "flowchart LR",
        '  A["사용자 요청"] --> B{판단}',
        "  B -->|yes| C([실행]) --> D[(저장소)]",
        "  B -. no .-> E((종료))",
        "  %% comment",
        "  classDef hot fill:#f00",
      ].join("\n"),
    );
    expect(chart?.direction).toBe("LR");
    expect(chart?.nodes.map((node) => [node.id, node.label, node.shape])).toEqual([
      ["A", "사용자 요청", "rect"],
      ["B", "판단", "diamond"],
      ["C", "실행", "stadium"],
      ["D", "저장소", "cylinder"],
      ["E", "종료", "circle"],
    ]);
    expect(
      chart?.edges.map((edge) => [edge.from, edge.to, edge.label ?? null, edge.style]),
    ).toEqual([
      ["A", "B", null, "solid"],
      ["B", "C", "yes", "solid"],
      ["C", "D", null, "solid"],
      ["B", "E", "no", "dashed"],
    ]);
  });

  it("fans out with & and ignores non-flowchart diagrams", () => {
    expect(parseFlowchart("graph TD\nA & B --> C")?.edges).toHaveLength(2);
    expect(parseFlowchart("sequenceDiagram\nA->>B: hi")).toBeNull();
  });
});

describe("layoutFlowchart", () => {
  it("places each node a rank after its parents and survives cycles", () => {
    const chart = parseFlowchart("graph TD\nA --> B --> C\nC --> A\nA --> C");
    const layout = layoutFlowchart(chart!);
    const rankOf = (id: string) => layout.nodes.find((node) => node.id === id)?.rank;
    expect([rankOf("A"), rankOf("B"), rankOf("C")]).toEqual([0, 1, 2]);
    const y = (id: string) => layout.nodes.find((node) => node.id === id)?.y ?? 0;
    expect(y("A")).toBeLessThan(y("B"));
    expect(layout.edges).toHaveLength(4);
  });
});

describe("diagram labels", () => {
  const chart = parseFlowchart(
    [
      "graph LR",
      "A[3분기 실적] --> B{2027년 이익이<br/>유지될까?}",
      "B -->|HBM4 수율·가격 안정<br/>빅테크 투자 확대| C[강세]",
      "B -->|가격 상승 둔화<br/>점유율은 내줘도 이익은 성장| D[기본]",
      "B -->|발주 연기·가격 하락 전환<br/>재고 증가| E[약세]",
    ].join("\n"),
  )!;
  const layout = layoutFlowchart(chart);

  it("keeps the line breaks a model writes as <br/>", () => {
    expect(layout.nodes.find((node) => node.id === "B")?.lines).toEqual([
      "2027년 이익이",
      "유지될까?",
    ]);
    expect(layout.edges[1]?.labelLines[0]).toBe("HBM4 수율·가격 안정");
  });

  it("widens the gap so each edge label sits clear of both nodes", () => {
    const b = layout.nodes.find((node) => node.id === "B")!;
    for (const edge of layout.edges.filter((entry) => entry.from === "B")) {
      const target = layout.nodes.find((node) => node.id === edge.to)!;
      expect(edge.labelX - edge.labelWidth / 2).toBeGreaterThanOrEqual(b.x + b.width);
      expect(edge.labelX + edge.labelWidth / 2).toBeLessThanOrEqual(target.x);
    }
  });

  it("keeps sibling edge labels from overlapping", () => {
    const labels = layout.edges
      .filter((edge) => edge.from === "B")
      .map(
        (edge) => [edge.labelY - edge.labelHeight / 2, edge.labelY + edge.labelHeight / 2] as const,
      )
      .sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < labels.length; index += 1) {
      expect(labels[index]![0]).toBeGreaterThanOrEqual(labels[index - 1]![1]);
    }
  });
});
