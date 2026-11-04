// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type OrchestrationEvent,
  ProjectId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { layer as projectMemoriesLayer } from "../persistence/ProjectMemories.ts";
import { layer as sendLedgerLayer } from "../persistence/ProjectMemorySendLedger.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  TextGeneration,
  type WorkLessonsGenerationInput,
  type WorkLessonsGenerationResult,
} from "../textGeneration/TextGeneration.ts";
import { layer as analyserLayer, ProjectMemoryAnalyser } from "./ProjectMemoryAnalyser.ts";
import { ProjectMemoryService, layer as memoryServiceLayer } from "./ProjectMemoryService.ts";

const NOW = "2026-10-09T00:00:00.000Z";
const PROJECT = ProjectId.make("project-1");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");

interface Fixture {
  readonly requests: Array<WorkLessonsGenerationInput>;
  /** What the fake model answers; a function so a test can fail it. */
  respond: (
    input: WorkLessonsGenerationInput,
  ) => Effect.Effect<WorkLessonsGenerationResult, TextGenerationError>;
  readonly events: Map<string, Array<OrchestrationEvent>>;
}

const withAnalyser = <E>(
  options: { readonly analyser: boolean },
  run: (
    fixture: Fixture,
  ) => Effect.Effect<
    unknown,
    E,
    ProjectMemoryAnalyser | ProjectMemoryService | SqlClient.SqlClient
  >,
) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-memory-analyser-"));
  const fixture: Fixture = {
    requests: [],
    respond: () => Effect.succeed({ lessons: [] }),
    events: new Map(),
  };
  // The digest comes from the fake store; the global event log table only
  // has to agree with it about which threads moved and how far.
  const store = Layer.mock(OrchestrationEventStore, {
    getAggregateReplayStats: ({ aggregateId }) =>
      Effect.succeed({
        eventCount: fixture.events.get(aggregateId)?.length ?? 0,
        payloadBytes: 0,
        hasCreateEvent: true,
      }),
    readAggregateRange: ({ aggregateId }) =>
      Stream.fromIterable(fixture.events.get(aggregateId) ?? []),
  });
  const textGeneration = Layer.mock(TextGeneration, {
    generateWorkLessons: (input) => {
      fixture.requests.push(input);
      return fixture.respond(input);
    },
  });
  const sqlite = NodeSqliteClient.layer({ filename: NodePath.join(tempDir, "state.sqlite") });
  const dependencies = Layer.mergeAll(
    projectMemoriesLayer,
    ProjectionThreadRepositoryLive,
    ProjectionProjectRepositoryLive,
    sendLedgerLayer,
    store,
    textGeneration,
    ServerSettings.layerTest({ projectMemoryAnalyser: options.analyser }),
  ).pipe(Layer.provideMerge(sqlite));
  const service = memoryServiceLayer.pipe(
    Layer.provideMerge(dependencies),
    Layer.provide(NodeServices.layer),
  );
  const analyser = analyserLayer.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(service),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(analyser);
      return yield* run(fixture).pipe(Effect.provide(context));
    }),
  ).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
};

const test = <E>(
  name: string,
  options: { readonly analyser: boolean },
  run: (
    fixture: Fixture,
  ) => Effect.Effect<
    unknown,
    E,
    ProjectMemoryAnalyser | ProjectMemoryService | SqlClient.SqlClient
  >,
) => it.effect(name, () => withAnalyser(options, run));

/** Record a committed memory send on a thread, which taints it for echo purposes. */
const markSent = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_memory_send_attempts (
        thread_id, message_id, project_id, provider_instance_id, owner_instance_id,
        state, committed_at, settled_at
      )
      VALUES (${threadId}, 'message-1', ${PROJECT}, 'provider', 'owner', 'provider_accepted', ${NOW}, ${NOW})
    `;
  });

let sequence = 0;
/** Append one event to the fake store and to the event-log table. */
const append = (fixture: Fixture, threadId: ThreadId, type: string, payload: unknown) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    sequence += 1;
    const event = {
      sequence,
      eventId: `event-${sequence}`,
      aggregateKind: "thread",
      aggregateId: threadId,
      type,
      occurredAt: NOW,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload,
    } as unknown as OrchestrationEvent;
    fixture.events.set(threadId, [...(fixture.events.get(threadId) ?? []), event]);
    yield* sql`
      INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json
      )
      VALUES (
        ${sequence}, ${event.eventId}, 'thread', ${threadId}, ${sequence}, ${type},
        ${NOW}, 'system', '{}', '{}'
      )
    `;
    return event.sequence;
  });

const activity = (fixture: Fixture, threadId: ThreadId, kind: string, payload: unknown) =>
  append(fixture, threadId, "thread.activity-appended", {
    threadId,
    activity: {
      id: `activity-${sequence + 1}`,
      tone: "info",
      kind,
      summary: kind,
      payload,
      turnId: null,
      createdAt: NOW,
    },
  });

const receipt = (fixture: Fixture, threadId: ThreadId, attempt: string, status: string) =>
  activity(fixture, threadId, "selected-check-receipt", {
    attemptId: attempt,
    revision: 1,
    phase: "completed",
    planned: [{ scriptId: "s1", scriptName: "test" }],
    checks: [{ scriptId: "s1", status }],
  });

const seedProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    )
    VALUES (${PROJECT}, 'Project', '/tmp/project', '[]', ${NOW}, ${NOW}, NULL)
  `;
});

const seedThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at
      )
      VALUES (${threadId}, ${PROJECT}, 'Thread', '{"instanceId":"pi","model":"m"}', 'full-access', 'default', ${NOW}, ${NOW}, NULL)
    `;
  });

/** Two threads that each fixed a failing check; thread A's result was accepted. */
const seedTwoThreads = (fixture: Fixture) =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* seedProject;
    for (const threadId of [THREAD_A, THREAD_B]) {
      yield* seedThread(threadId);
      yield* append(fixture, threadId, "thread.created", { threadId });
      yield* append(fixture, threadId, "thread.message-sent", {
        threadId,
        role: "user",
        text: "SECRET TRANSCRIPT WORDS",
        streaming: false,
      });
      yield* receipt(fixture, threadId, `${threadId}-1`, "failed");
      yield* receipt(fixture, threadId, `${threadId}-2`, "passed");
    }
    yield* activity(fixture, THREAD_A, "task-result", {
      requirements: { version: 1 },
      acceptance: { acceptedAt: NOW },
    });
  });

describe("ProjectMemoryAnalyser", () => {
  test("is refused, with no model call, while the setting is off", { analyser: false }, (fixture) =>
    Effect.gen(function* () {
      yield* seedTwoThreads(fixture);
      const analyser = yield* ProjectMemoryAnalyser;
      const error = yield* Effect.flip(analyser.analyse({ projectId: PROJECT }));
      if (error._tag !== "ProjectMemoryRejectedError") throw new Error(error._tag);
      assert.equal(error.reason, "analyser-disabled");
      assert.equal(fixture.requests.length, 0);
    }),
  );

  test(
    "files a lesson seen in two threads, never from raw transcript text or ids",
    { analyser: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* seedTwoThreads(fixture);
        fixture.respond = () =>
          Effect.succeed({
            lessons: [
              {
                category: "fact",
                text: "Re-run the test check after fixing a failure",
                threads: ["T1", "T2"],
              },
              { category: "prohibition", text: "Never skip the flaky retry", threads: ["T1"] },
            ],
          });
        const analyser = yield* ProjectMemoryAnalyser;
        const memory = yield* ProjectMemoryService;

        const result = yield* analyser.analyse({ projectId: PROJECT });
        assert.deepEqual(result, { threadsAnalysed: 2, memoriesProposed: 1, skillsSuggested: 0 });

        const [request] = fixture.requests;
        const prompt = request?.digest ?? "";
        assert.notInclude(prompt, "SECRET TRANSCRIPT WORDS");
        // The model runs in a throwaway directory, not the workspace, and it is cleaned up.
        assert.isTrue(request?.cwd.includes("t3code-analyser-"));
        assert.isFalse(NodeFS.existsSync(request?.cwd ?? ""));
        assert.notInclude(prompt, THREAD_A);
        assert.notInclude(prompt, THREAD_B);
        assert.include(prompt, "check-failed-then-passed");

        const [proposal] = (yield* memory.listProposals({ projectId: PROJECT })).items;
        assert.equal(proposal?.body, "Re-run the test check after fixing a failure");
        assert.equal(proposal?.analysis?.target, "memory");
        assert.deepEqual(
          new Set(proposal?.analysis?.evidence.map((item) => item.threadId)),
          new Set([THREAD_A, THREAD_B]),
        );
        // Nothing was saved without approval.
        assert.deepEqual((yield* memory.list({ projectId: PROJECT })).items, []);
      }),
  );

  test("a lesson backed by a single thread is dropped", { analyser: true }, (fixture) =>
    Effect.gen(function* () {
      yield* seedTwoThreads(fixture);
      fixture.respond = () =>
        Effect.succeed({
          lessons: [
            { category: "preference", text: "Prefer small commits", threads: ["T1", "T1"] },
            { category: "fact", text: "Cites a thread that does not exist", threads: ["T1", "T9"] },
          ],
        });
      const analyser = yield* ProjectMemoryAnalyser;
      const result = yield* analyser.analyse({ projectId: PROJECT });
      assert.equal(result.memoriesProposed, 0);
      assert.deepEqual(
        (yield* (yield* ProjectMemoryService).listProposals({ projectId: PROJECT })).items,
        [],
      );
    }),
  );

  test(
    "a procedure becomes a skill-draft suggestion from its source thread",
    { analyser: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* seedTwoThreads(fixture);
        fixture.respond = () =>
          Effect.succeed({
            lessons: [
              {
                category: "procedure",
                text: "Fix the failing check, then re-run it",
                threads: ["T1", "T2"],
              },
            ],
          });
        const analyser = yield* ProjectMemoryAnalyser;
        const memory = yield* ProjectMemoryService;
        const result = yield* analyser.analyse({ projectId: PROJECT });
        assert.deepEqual(result, { threadsAnalysed: 2, memoriesProposed: 0, skillsSuggested: 1 });

        const [proposal] = (yield* memory.listProposals({ projectId: PROJECT })).items;
        assert.equal(proposal?.analysis?.target, "skill");
        // Only thread A's result was accepted, so it is the one named as the source.
        assert.deepEqual(
          proposal?.analysis?.evidence.map((item) => item.threadId),
          [THREAD_A],
        );
        assert.equal(proposal?.threadId, THREAD_A);
        assert.deepEqual((yield* memory.list({ projectId: PROJECT })).items, []);
      }),
  );

  test("provider text of an echo-tainted thread is withheld", { analyser: true }, (fixture) =>
    Effect.gen(function* () {
      yield* seedTwoThreads(fixture);
      for (const threadId of [THREAD_A, THREAD_B]) {
        yield* activity(fixture, threadId, "task.completed", {
          crewRole: "auditor",
          threadId: `child-${threadId}`,
          verdict: "needs-changes",
          summary: `AUDIT TEXT ${threadId}`,
        });
      }
      yield* markSent(THREAD_A);
      const analyser = yield* ProjectMemoryAnalyser;
      yield* analyser.analyse({ projectId: PROJECT });

      const prompt = fixture.requests[0]?.digest ?? "";
      assert.notInclude(prompt, `AUDIT TEXT ${THREAD_A}`);
      assert.include(prompt, `AUDIT TEXT ${THREAD_B}`);
    }),
  );

  test(
    "an auditor excerpt is withheld when its own child thread received memory",
    { analyser: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* seedTwoThreads(fixture);
        const audits = [
          [THREAD_A, "child-a", "AUDIT TEXT tainted child"],
          [THREAD_B, "child-b", "AUDIT TEXT clean child"],
          [THREAD_B, undefined, "AUDIT TEXT unnamed child"],
        ] as const;
        for (const [lead, child, summary] of audits) {
          yield* activity(fixture, lead, "task.completed", {
            crewRole: "auditor",
            ...(child === undefined ? {} : { threadId: child }),
            verdict: "needs-changes",
            summary,
          });
        }
        // The leads are clean; only the first auditor's own thread got memory.
        yield* markSent(ThreadId.make("child-a"));
        const analyser = yield* ProjectMemoryAnalyser;
        yield* analyser.analyse({ projectId: PROJECT });

        const prompt = fixture.requests[0]?.digest ?? "";
        assert.notInclude(prompt, "AUDIT TEXT tainted child");
        assert.notInclude(prompt, "AUDIT TEXT unnamed child");
        assert.include(prompt, "AUDIT TEXT clean child");
      }),
  );

  test(
    "a rejected suggestion is not proposed again by a later run",
    { analyser: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* seedTwoThreads(fixture);
        fixture.respond = () =>
          Effect.succeed({
            lessons: [
              {
                category: "fact",
                text: "Re-run the test check after fixing a failure",
                threads: ["T1", "T2"],
              },
            ],
          });
        const analyser = yield* ProjectMemoryAnalyser;
        const memory = yield* ProjectMemoryService;
        yield* analyser.analyse({ projectId: PROJECT });
        const [proposal] = (yield* memory.listProposals({ projectId: PROJECT })).items;
        yield* memory.rejectProposal({ projectId: PROJECT, proposalId: proposal!.proposalId });

        // New work arrives, the model says the same thing again.
        yield* receipt(fixture, THREAD_B, "thread-b-3", "passed");
        const second = yield* analyser.analyse({ projectId: PROJECT });
        assert.equal(second.memoriesProposed, 0);
        assert.equal(fixture.requests.length, 2);
        assert.deepEqual((yield* memory.listProposals({ projectId: PROJECT })).items, []);
      }),
  );

  test(
    "a rejected suggestion reworded over the same events is not proposed again",
    { analyser: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* seedTwoThreads(fixture);
        const answer = (text: string) => () =>
          Effect.succeed({
            lessons: [{ category: "fact" as const, text, threads: ["T1", "T2"] }],
          });
        fixture.respond = answer("Re-run the test check after fixing a failure");
        const analyser = yield* ProjectMemoryAnalyser;
        const memory = yield* ProjectMemoryService;
        yield* analyser.analyse({ projectId: PROJECT });
        const [proposal] = (yield* memory.listProposals({ projectId: PROJECT })).items;
        yield* memory.rejectProposal({ projectId: PROJECT, proposalId: proposal!.proposalId });

        fixture.respond = answer("Always execute the tests again once a broken one is repaired");
        yield* receipt(fixture, THREAD_B, "thread-b-3", "passed");
        const second = yield* analyser.analyse({ projectId: PROJECT });
        assert.equal(second.memoriesProposed, 0);
        assert.equal(fixture.requests.length, 2);
        assert.deepEqual((yield* memory.listProposals({ projectId: PROJECT })).items, []);
      }),
  );

  test("nothing new since the last run means no model call", { analyser: true }, (fixture) =>
    Effect.gen(function* () {
      yield* seedTwoThreads(fixture);
      const analyser = yield* ProjectMemoryAnalyser;
      yield* analyser.analyse({ projectId: PROJECT });
      const second = yield* analyser.analyse({ projectId: PROJECT });
      assert.deepEqual(second, { threadsAnalysed: 0, memoriesProposed: 0, skillsSuggested: 0 });
      assert.equal(fixture.requests.length, 1);
    }),
  );

  test(
    "a failed model call reports a fixed error and leaves the work to retry",
    { analyser: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* seedTwoThreads(fixture);
        fixture.respond = () =>
          Effect.fail(
            new TextGenerationError({ operation: "generateWorkLessons", detail: "boom SECRET" }),
          );
        const analyser = yield* ProjectMemoryAnalyser;
        const error = yield* Effect.flip(analyser.analyse({ projectId: PROJECT }));
        if (error._tag !== "ProjectMemoryRejectedError") throw new Error(error._tag);
        assert.equal(error.reason, "analyser-failed");
        assert.notInclude(error.message, "SECRET");

        fixture.respond = () => Effect.succeed({ lessons: [] });
        yield* analyser.analyse({ projectId: PROJECT });
        assert.equal(fixture.requests.length, 2);
      }),
  );
});
