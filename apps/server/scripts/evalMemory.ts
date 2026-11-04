/**
 * Pure parts of `evals.ts --memory`: the lessons fixture, which memories a task run gets, and the
 * message that attaches them the way the composer does. The runner owns the I/O.
 *
 * The composer pre-selects related project memories with `planAutoSelection` and sends them as
 * ordinary memory references (an inline `t3-context://v1/memory/<id>` link plus an identifier-only
 * context record). Doing the same here keeps the send ledger, the affected hold, and memory-echo
 * masking on the measured path.
 */
import type {
  ComposerContextId,
  ComposerContextRecord,
  OrchestrationMessageContext,
} from "@t3tools/contracts";
import { ProjectMemoryKind } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";

import { PROJECT_MEMORY_SEND_DRIVER_KINDS } from "../src/memory/ProjectMemorySendProviders.ts";
import {
  EMPTY_AUTO_SELECT_STATE,
  planAutoSelection,
  type RankableProjectMemory,
} from "../../../packages/client-runtime/src/projectMemoryAutoSelect.ts";

/**
 * The provider instances the memory send gate admits. A run's instance id is its driver for the
 * default instances an eval uses, so the build-time allow list is the list (see `ProjectMemorySendProviders`).
 */
export const MEMORY_SEND_INSTANCE_IDS: ReadonlyArray<string> = [
  ...PROJECT_MEMORY_SEND_DRIVER_KINDS,
].sort();

const FixtureMemory = Schema.Struct({
  kind: ProjectMemoryKind,
  title: Schema.String,
  body: Schema.String,
  /** Source task ids the text was derived from. Never a task the fixture is measured on. */
  derivedFrom: Schema.Array(Schema.String),
});

const FixtureProject = Schema.Struct({
  family: Schema.String,
  /** The tasks measured with this project's memories attached (the holdout tasks). */
  tasks: Schema.Array(Schema.String),
  memories: Schema.Array(FixtureMemory),
});

export const MemoryFixture = Schema.Struct({
  description: Schema.String,
  /** How the memory text came to be: the real pipeline, or written from source-task failures. */
  provenance: Schema.String,
  projects: Schema.Array(FixtureProject),
});
export type MemoryFixture = typeof MemoryFixture.Type;
export type FixtureMemoryText = typeof FixtureMemory.Type;

export const decodeMemoryFixture = Schema.decodeUnknownEffect(Schema.fromJsonString(MemoryFixture));

/** Fixture problems that would make a measurement dishonest; empty when the fixture is sound. */
export const fixtureProblems = (fixture: MemoryFixture): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const measured = new Set<string>();
  for (const project of fixture.projects) {
    for (const task of project.tasks) {
      if (measured.has(task)) problems.push(`task ${task} appears in more than one project`);
      measured.add(task);
    }
    for (const memory of project.memories) {
      if (memory.derivedFrom.length === 0) {
        problems.push(`"${memory.title}" names no source task in derivedFrom`);
      }
      for (const source of memory.derivedFrom) {
        if (project.tasks.includes(source)) {
          problems.push(`"${memory.title}" is derived from the measured task ${source}`);
        }
      }
    }
  }
  return problems;
};

/** Selected tasks no fixture project names: they would run with no memory at all. */
export const tasksWithoutMemory = (
  fixture: MemoryFixture,
  taskIds: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  taskIds.filter((taskId) => memoriesForTask(fixture, taskId).length === 0);

/** What the gate says when two result files differ in project memory, which makes the pair unlike for like. */
export const memoryNote = (
  baseline: MemoryRecord,
  candidate: MemoryRecord,
): ReadonlyArray<string> => {
  const describe = (side: MemoryRecord) =>
    side.memory == null ? "no memory" : `\`${side.memory}\` (${side.memorySelect ?? "auto"})`;
  return (baseline.memorySha256 ?? null) === (candidate.memorySha256 ?? null) &&
    (baseline.memorySelect ?? null) === (candidate.memorySelect ?? null)
    ? []
    : [
        `Memory differs (baseline ${describe(baseline)}, candidate ${describe(candidate)}): this compares memory configurations of the same build, not code.`,
        "",
      ];
};

export interface MemoryRecord {
  readonly memory?: string | null;
  readonly memorySelect?: string | null;
  readonly memorySha256?: string | null;
}

/** The memories seeded into the project of one task run; empty for a task the fixture does not name. */
export const memoriesForTask = (
  fixture: MemoryFixture,
  taskId: string,
): ReadonlyArray<FixtureMemoryText> =>
  fixture.projects.find((project) => project.tasks.includes(taskId))?.memories ?? [];

export interface SeededMemory extends RankableProjectMemory {
  readonly version: number;
}

/**
 * What the composer would pre-select for this prompt in a fresh draft: the auto-select budget
 * (3 memories, 1.5 KB) applied to the project's memories.
 */
export const autoSelectForPrompt = <T extends SeededMemory>(
  prompt: string,
  memories: ReadonlyArray<T>,
  nowMs: number,
): ReadonlyArray<T> =>
  planAutoSelection({
    enabled: true,
    providerAllowed: true,
    draft: prompt,
    memories,
    selectedMemoryIds: new Set(),
    state: EMPTY_AUTO_SELECT_STATE,
    nowMs,
  }).add;

/**
 * `auto` is the product behaviour: only what `planAutoSelection` surfaces for the prompt. `all` attaches
 * every seeded memory, as if the user had picked them by hand; it isolates what a lesson is worth once
 * surfaced from whether the ranker surfaces it.
 */
export type MemorySelectMode = "auto" | "all";

export const selectMemories = <T extends SeededMemory>(
  mode: MemorySelectMode,
  prompt: string,
  memories: ReadonlyArray<T>,
  nowMs: number,
): ReadonlyArray<T> => (mode === "all" ? memories : autoSelectForPrompt(prompt, memories, nowMs));

/** The context id the composer gives a memory chip (`memory_<id>`, ids already match the pattern). */
export const memoryContextId = (memoryId: string) => `memory_${memoryId}` as ComposerContextId;

/** The message the composer sends for a prompt with memory chips: inline links plus identifier-only records. */
export const withMemoryReferences = (
  prompt: string,
  selections: ReadonlyArray<{ readonly memoryId: string; readonly version: number }>,
): { readonly text: string; readonly context: OrchestrationMessageContext | undefined } => {
  if (selections.length === 0) return { text: prompt, context: undefined };
  const links = selections.map((selection) =>
    formatComposerContextReference({
      kind: "memory",
      contextId: memoryContextId(selection.memoryId),
      label: "Project memory",
    }),
  );
  const records: Array<ComposerContextRecord> = selections.map((selection) => ({
    version: 1,
    contextId: memoryContextId(selection.memoryId),
    kind: "memory",
    label: "Project memory",
    payload: { memoryId: selection.memoryId, selectedVersion: selection.version },
  }));
  return { text: `${prompt}\n\n${links.join(" ")}`, context: { version: 1, records } };
};
