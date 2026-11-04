import { CrewTodoProgress } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { pathInScope } from "./crewScope.ts";
import {
  CREW_TODO_MAX,
  OUT_OF_SCOPE_SHOWN,
  appendTodos,
  assignTodos,
  filesOutsideScope,
  judgeFilesCheck,
  nudgeText,
  openTodoIds,
  proofLabel,
  proofNote,
  resetTodos,
  summarizeOutOfScope,
  taskProof,
  todoCounts,
  todoProgressFields,
  todoPromptLines,
  todoReportNote,
  todoResumeLines,
  type TodoItem,
} from "./crewTodos.ts";

const isProgress = Schema.is(CrewTodoProgress);

const withStatus = (todo: TodoItem, status: TodoItem["status"], detail?: string): TodoItem => ({
  ...todo,
  status,
  detail,
});

describe("assignTodos", () => {
  it("numbers items t1, t2, ... itself and accepts strings or items with a check", () => {
    const todos = assignTodos([
      "write the module",
      { text: " add tests ", check: { command: " vp test run a ", files: [" a.test.ts ", ""] } },
      "   ",
      { text: "no real check", check: { command: "  ", files: [] } },
    ]);
    expect(todos.map((todo) => [todo.id, todo.text, todo.status])).toEqual([
      ["t1", "write the module", "pending"],
      ["t2", "add tests", "pending"],
      ["t3", "no real check", "pending"],
    ]);
    expect(todos[1]?.check).toEqual({ command: "vp test run a", files: ["a.test.ts"] });
    expect(todos[2]?.check).toBeUndefined();
  });

  it("keeps at most twelve items and treats no list as an empty one", () => {
    expect(assignTodos(Array.from({ length: 20 }, (_, i) => `item ${i}`))).toHaveLength(
      CREW_TODO_MAX,
    );
    expect(assignTodos(undefined)).toEqual([]);
  });

  it("starts a retried list over from pending", () => {
    const [done] = assignTodos([{ text: "a", check: { command: "true" } }]);
    const again = resetTodos([{ ...done!, status: "verified", note: "ok", detail: "x" }]);
    expect(again).toEqual([{ id: "t1", text: "a", check: { command: "true" }, status: "pending" }]);
  });
});

describe("counts and the wire payload", () => {
  const todos = assignTodos(["a", "b", "c", "d", "e"]);
  const mixed = [
    withStatus(todos[0]!, "verified"),
    withStatus(todos[1]!, "claimed"),
    withStatus(todos[2]!, "failed", "exit 1"),
    withStatus(todos[3]!, "blocked"),
    todos[4]!,
  ];

  it("counts every state and lists what still needs work", () => {
    expect(todoCounts(mixed)).toEqual({
      total: 5,
      pending: 1,
      verified: 1,
      claimed: 1,
      failed: 1,
      blocked: 1,
    });
    expect(openTodoIds(mixed)).toEqual(["t3", "t5"]);
  });

  it("carries the items and counts, never a percentage, and decodes as the contract", () => {
    const fields = todoProgressFields(mixed, summarizeOutOfScope(["z.ts", "a.ts"], true));
    expect(fields).toEqual({
      todos: [
        { id: "t1", text: "a", status: "verified" },
        { id: "t2", text: "b", status: "claimed" },
        { id: "t3", text: "c", status: "failed" },
        { id: "t4", text: "d", status: "blocked" },
        { id: "t5", text: "e", status: "pending" },
      ],
      todoTotal: 5,
      todoVerified: 1,
      todoClaimed: 1,
      todoFailed: 1,
      todoBlocked: 1,
      outOfScope: { files: ["a.ts", "z.ts"], more: 0, shared: true },
    });
    expect(isProgress(fields)).toBe(true);
    expect(todoProgressFields(mixed, undefined)).not.toHaveProperty("outOfScope");
  });

  it("samples a long out-of-scope list and says how many were left out", () => {
    const files = Array.from(
      { length: OUT_OF_SCOPE_SHOWN + 5 },
      (_, i) => `f${String(i).padStart(2, "0")}.ts`,
    );
    const sample = summarizeOutOfScope(files, false);
    expect(sample?.files).toHaveLength(OUT_OF_SCOPE_SHOWN);
    expect(sample?.more).toBe(5);
    expect(summarizeOutOfScope([], false)).toBeUndefined();
  });
});

describe("prompt sections", () => {
  const todos = assignTodos([
    "plain step",
    { text: "checked step", check: { command: "vp test run a", files: ["a.ts"] } },
  ]);

  it("adds nothing without a list", () => {
    expect(todoPromptLines(undefined, { scoped: true })).toEqual([]);
    expect(todoPromptLines([], { scoped: false })).toEqual([]);
  });

  it("lists the ids, tells the member to check each off at once, and names the server check", () => {
    const text = todoPromptLines(todos, { scoped: false }).join("\n");
    expect(text).toContain("- t1: plain step\n- t2: checked step (OOP checks this itself:");
    expect(text).toContain("runs `vp test run a`, which must exit 0; needs changes in a.ts");
    expect(text).toContain("as soon as you finish it, before you start the next one");
    expect(text).toContain("search outside the workspace");
    expect(text).not.toContain("outside your SCOPE");
    expect(todoPromptLines(todos, { scoped: true }).join("\n")).toContain("outside your SCOPE");
  });

  it("tells a later attempt what is finished and only lists what remains", () => {
    const state = [
      withStatus(todos[0]!, "verified"),
      withStatus(todos[1]!, "failed", "The command exited with code 1."),
    ];
    const text = todoResumeLines(state).join("\n");
    expect(text).toContain("Finished, do not redo: t1 (verified).");
    expect(text).toContain("- t2: checked step");
    expect(text).toContain("[failed: The command exited with code 1.]");
    expect(text).not.toContain("- t1:");
    expect(todoResumeLines(undefined)).toEqual([]);
  });

  it("names the pending items in the one nudge", () => {
    expect(nudgeText([todos[0]!])).toContain("- t1: plain step");
  });
});

describe("report note", () => {
  const todos = assignTodos(["a", "b", "c"]);

  it("summarizes what is not verified, and out-of-scope files for shared workspaces carefully", () => {
    const note = todoReportNote(
      [withStatus(todos[0]!, "verified"), withStatus(todos[1]!, "failed", "exit 1"), todos[2]!],
      summarizeOutOfScope(["x.ts"], true),
    );
    expect(note).toContain("TODO: 3 items, 1 verified, 1 failed, 1 not done.");
    expect(note).toContain("- t2 (failed): b - exit 1");
    expect(note).toContain("- t3 (pending): c");
    expect(note).not.toContain("- t1");
    expect(note).toContain("shared, so some may be another agent's work");
    expect(note).toContain("- x.ts");
  });

  it("is absent without a list", () => {
    expect(todoReportNote([], undefined)).toBeNull();
  });
});

describe("files checks and write scope", () => {
  it("matches a file, a directory, and a globbed directory", () => {
    expect(pathInScope("src/a/b.ts", ["src/a/"])).toBe(true);
    expect(pathInScope("src/a/b.ts", ["src/a/b.ts"])).toBe(true);
    expect(pathInScope("src/a/b.ts", ["src/**"])).toBe(true);
    expect(pathInScope("src/ab.ts", ["src/a"])).toBe(false);
    expect(pathInScope("docs/x.md", ["src/"])).toBe(false);
  });

  it("fails entries nothing changed under, and flags entries only satisfied outside the scope", () => {
    expect(
      judgeFilesCheck({
        files: ["src/a.ts", "src/b.ts"],
        changed: ["src/a.ts"],
        writeScope: undefined,
      }),
    ).toEqual({ kind: "failed", missing: ["src/b.ts"] });
    expect(
      judgeFilesCheck({
        files: ["src/", "config/"],
        changed: ["src/a.ts", "config/x.json"],
        writeScope: ["src/"],
      }),
    ).toEqual({ kind: "passed", outOfScopeOnly: ["config/"] });
    expect(
      judgeFilesCheck({
        files: ["src/"],
        changed: ["src/a.ts", "other.txt"],
        writeScope: ["src/"],
      }),
    ).toEqual({ kind: "passed", outOfScopeOnly: [] });
  });

  it("lists changes outside the scope, and none when the task has no scope", () => {
    expect(filesOutsideScope(["src/a.ts", "x.md"], ["src/"])).toEqual(["x.md"]);
    expect(filesOutsideScope(["src/a.ts", "x.md"], undefined)).toEqual([]);
    expect(filesOutsideScope(["x.md"], [])).toEqual([]);
  });
});

describe("appendTodos", () => {
  const existing = assignTodos(["a", "b"]);

  it("numbers after the highest id and keeps the check", () => {
    const { items } = appendTodos(existing, ["c", { text: "d", check: { command: "true" } }]);
    expect(items.map((todo) => [todo.id, todo.text])).toEqual([
      ["t3", "c"],
      ["t4", "d"],
    ]);
    expect(items[1]?.check).toEqual({ command: "true" });
    expect(appendTodos([], ["only"]).items[0]?.id).toBe("t1");
  });

  it("returns nothing when the items do not fit whole under the cap", () => {
    const full = assignTodos(Array.from({ length: CREW_TODO_MAX - 1 }, (_, i) => `i${i}`));
    expect(appendTodos(full, ["x", "y"])).toMatchObject({ items: [], count: 2, room: 1 });
    expect(appendTodos(full, ["x"]).items).toHaveLength(1);
    expect(appendTodos(existing, ["  "])).toMatchObject({ items: [], count: 0 });
  });
});

describe("taskProof", () => {
  const counts = (over: Partial<ReturnType<typeof todoCounts>> = {}) => ({
    total: 0,
    pending: 0,
    verified: 0,
    claimed: 0,
    failed: 0,
    blocked: 0,
    ...over,
  });
  const proof = (over: Partial<Parameters<typeof taskProof>[0]> = {}) =>
    taskProof({
      status: "completed",
      observedTests: false,
      selfReportedPassed: null,
      ...over,
    });

  it("verifies a task whose every item the server verified", () => {
    expect(proof({ todos: counts({ total: 3, verified: 3 }) }).verdict).toBe("verified");
  });

  it("verifies a task without a list only on an observed passing test run", () => {
    expect(proof({ observedTests: true }).verdict).toBe("verified");
    expect(proof({ observedTests: false, selfReportedPassed: true }).verdict).toBe("inconclusive");
    expect(proof().verdict).toBe("inconclusive");
    expect(proof({ todos: counts(), observedTests: true }).verdict).toBe("verified");
  });

  it("is inconclusive while an item is only claimed, even with an observed test run", () => {
    const result = proof({
      todos: counts({ total: 3, verified: 1, claimed: 2 }),
      observedTests: true,
    });
    expect(result).toEqual({ verdict: "inconclusive", reason: "2 items claimed without proof" });
  });

  it("is not verified when an item failed, is blocked, or was never done", () => {
    for (const over of [{ failed: 1 }, { blocked: 1 }, { pending: 1 }]) {
      expect(proof({ todos: counts({ total: 2, verified: 1, ...over }) }).verdict).toBe(
        "not-verified",
      );
    }
  });

  it("is not verified for any ending other than completed", () => {
    for (const status of ["failed", "partial", "blocked", "interrupted"] as const) {
      expect(proof({ status, observedTests: true }).verdict).toBe("not-verified");
    }
  });

  it("is not verified when the member reported its own verification failed", () => {
    expect(proof({ observedTests: true, selfReportedPassed: false }).verdict).toBe("not-verified");
    expect(
      proof({ todos: counts({ total: 1, verified: 1 }), selfReportedPassed: false }).verdict,
    ).toBe("not-verified");
  });

  it("words the verdict for the lead", () => {
    expect(proofLabel("verified")).toBe("VERIFIED");
    expect(proofLabel("not-verified")).toBe("NOT VERIFIED");
    expect(proofLabel("inconclusive")).toBe("INCONCLUSIVE");
    expect(proofNote({ verdict: "inconclusive", reason: "2 items claimed without proof" })).toBe(
      "\n\nPROOF: INCONCLUSIVE - 2 items claimed without proof",
    );
  });
});
