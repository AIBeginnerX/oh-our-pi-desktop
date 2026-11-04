import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  autoSelectForPrompt,
  decodeMemoryFixture,
  fixtureProblems,
  memoriesForTask,
  memoryNote,
  tasksWithoutMemory,
  memoryContextId,
  selectMemories,
  withMemoryReferences,
  type MemoryFixture,
} from "./evalMemory.ts";

const NOW = Date.parse("2026-11-03T00:00:00Z");

const fixture: MemoryFixture = {
  description: "d",
  provenance: "p",
  projects: [
    {
      family: "money",
      tasks: ["holdout-a"],
      memories: [
        {
          kind: "fact",
          title: "금액은 정수 센트",
          body: "금액은 정수로 다룬다.",
          derivedFrom: ["source-a"],
        },
      ],
    },
  ],
};

describe("memory fixture", () => {
  it("gives memories only to the tasks it names", () => {
    assert.equal(memoriesForTask(fixture, "holdout-a").length, 1);
    assert.equal(memoriesForTask(fixture, "source-a").length, 0);
    assert.equal(memoriesForTask(fixture, "other").length, 0);
  });

  it("flags a lesson derived from a task it is measured on, and a task listed twice", () => {
    assert.deepEqual(fixtureProblems(fixture), []);
    const leaky: MemoryFixture = {
      ...fixture,
      projects: [
        {
          ...fixture.projects[0]!,
          memories: [{ ...fixture.projects[0]!.memories[0]!, derivedFrom: ["holdout-a"] }],
        },
        { family: "dup", tasks: ["holdout-a"], memories: [] },
      ],
    };
    const problems = fixtureProblems(leaky);
    assert.equal(problems.length, 2);
    assert.include(problems.join("\n"), "derived from the measured task holdout-a");
    assert.include(problems.join("\n"), "more than one project");
  });

  it.effect("decodes the JSON file form and rejects an unknown memory kind", () =>
    Effect.gen(function* () {
      const text = (kind: string) =>
        `{"description":"d","provenance":"p","projects":[{"family":"f","tasks":["t"],"memories":[{"kind":"${kind}","title":"T","body":"B","derivedFrom":["s"]}]}]}`;
      const decoded = yield* decodeMemoryFixture(text("fact"));
      assert.equal(decoded.projects[0]!.memories[0]!.kind, "fact");
      const bad = yield* Effect.flip(decodeMemoryFixture(text("nope")));
      assert.isDefined(bad);
    }),
  );
});

describe("memory attachment", () => {
  const stored = [
    {
      memoryId: "m1",
      version: 1,
      title: "금액은 정수 센트",
      body: "가격과 금액은 정수 센트로 다룬다.",
    },
    {
      memoryId: "m2",
      version: 3,
      title: "Node 내장 모듈만 쓴다",
      body: "외부 의존성 없이 node:test 로 시험한다.",
    },
  ];

  it("auto-selects related memories with the composer's rule and skips unrelated ones", () => {
    const picked = autoSelectForPrompt("환불 금액을 일할 계산해 줘", stored, NOW);
    assert.deepEqual(
      picked.map((memory) => memory.memoryId),
      ["m1"],
    );
    assert.deepEqual(autoSelectForPrompt("로그 파일 회전", stored, NOW), []);
  });

  it("attaches every seeded memory in `all` mode and only the related ones in `auto` mode", () => {
    const prompt = "로그 파일 회전";
    assert.deepEqual(selectMemories("auto", prompt, stored, NOW), []);
    assert.deepEqual(
      selectMemories("all", prompt, stored, NOW).map((memory) => memory.memoryId),
      ["m1", "m2"],
    );
  });

  it("leaves a prompt without memories untouched", () => {
    assert.deepEqual(withMemoryReferences("do it", []), { text: "do it", context: undefined });
  });

  it("builds inline links and identifier-only records the server resolves", () => {
    const message = withMemoryReferences("do it", [{ memoryId: "m1", version: 2 }]);
    assert.include(message.text, "[Project memory](t3-context://v1/memory/memory_m1)");
    assert.deepEqual(message.context, {
      version: 1,
      records: [
        {
          version: 1,
          contextId: memoryContextId("m1"),
          kind: "memory",
          label: "Project memory",
          payload: { memoryId: "m1", selectedVersion: 2 },
        },
      ],
    });
  });
});

describe("memory fixture hygiene", () => {
  it("rejects a memory that names no source task", () => {
    const bad: MemoryFixture = {
      ...fixture,
      projects: [
        {
          ...fixture.projects[0]!,
          memories: [{ ...fixture.projects[0]!.memories[0]!, derivedFrom: [] }],
        },
      ],
    };
    assert.deepStrictEqual(fixtureProblems(fixture), []);
    assert.match(fixtureProblems(bad).join("\n"), /names no source task/);
  });

  it("lists selected tasks that no fixture project names", () => {
    assert.deepStrictEqual(tasksWithoutMemory(fixture, ["holdout-a", "other"]), ["other"]);
  });
});

describe("memoryNote", () => {
  const control = { memory: null, memorySelect: null, memorySha256: null };
  const auto = { memory: "l.json", memorySelect: "auto", memorySha256: "abc" };
  it("is silent when both sides used the same memory", () => {
    assert.deepStrictEqual(memoryNote(auto, auto), []);
    assert.deepStrictEqual(memoryNote({}, control), []);
  });
  it("notes a different fixture, hash, or select mode", () => {
    assert.match(memoryNote(control, auto).join(" "), /Memory differs.*no memory.*l\.json/);
    assert.lengthOf(memoryNote(auto, { ...auto, memorySha256: "def" }), 2);
    assert.lengthOf(memoryNote(auto, { ...auto, memorySelect: "all" }), 2);
  });
});
