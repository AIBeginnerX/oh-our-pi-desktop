import { describe, expect, it } from "vite-plus/test";

import {
  formatCompact,
  layoutFlowchart,
  niceScale,
  parseChartSpec,
  parseFlowchart,
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
