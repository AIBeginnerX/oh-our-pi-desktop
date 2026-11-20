import { ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import type { MemoryTidyResult } from "./memoryTidy.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PROJECT_MEMORY_ANALYSER_PENDING_MAX,
  ProjectId,
  ProjectMemoryProposalListResult,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { layer as projectMemoriesLayer } from "../persistence/ProjectMemories.ts";
import { layer as sendLedgerLayer } from "../persistence/ProjectMemorySendLedger.ts";
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
const THREAD_C = ThreadId.make("thread-c");
const THREAD_D = ThreadId.make("thread-d");

interface Fixture {
  readonly requests: Array<WorkLessonsGenerationInput>;
  tidyRespond: () => Effect.Effect<MemoryTidyResult, TextGenerationError>;
  readonly tidyRequests: Array<WorkLessonsGenerationInput>;
  /** What the fake model answers; a function so a test can fail it. */
  respond: (
    input: WorkLessonsGenerationInput,
  ) => Effect.Effect<WorkLessonsGenerationResult, TextGenerationError>;
}

const withAnalyser = <E>(
  options: { readonly analyser: boolean; readonly tidy?: boolean; readonly denied?: boolean },
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
    tidyRequests: [],
    tidyRespond: () =>
      Effect.succeed({
        suggestions: [
          {
            action: "merge",
            memories: ["M1", "M2"],
            title: "Combined",
            body: "Combined body",
            reason: "Duplicate",
          },
        ],
      }),
    respond: () => Effect.succeed({ lessons: [] }),
  };
  const textGeneration = Layer.mock(TextGeneration, {
    generateMemoryTidy: (input) => {
      fixture.tidyRequests.push(input);
      return fixture.tidyRespond();
    },
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
    textGeneration,
    ServerSettings.layerTest({
      projectMemoryAnalyser: options.analyser,
      projectMemoryTidy: options.tidy ?? false,
      providerInstances: {
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make(options.denied ? "denied" : "codex"),
          enabled: true,
          config: {},
        },
      },
    }),
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
  options: { readonly analyser: boolean; readonly tidy?: boolean; readonly denied?: boolean },
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

const decodeProposalList = Schema.decodeSync(ProjectMemoryProposalListResult);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

let sequence = 0;
/** Append one event to the event-log table. */
const append = (threadId: ThreadId, type: string, payload: unknown) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    sequence += 1;
    yield* sql`
      INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json
      )
      VALUES (
        ${sequence}, ${`event-${sequence}`}, 'thread', ${threadId}, ${sequence}, ${type},
        ${NOW}, 'system', ${encodeJson(payload)}, '{}'
      )
    `;
    return sequence;
  });

const activity = (threadId: ThreadId, kind: string, payload: unknown) =>
  append(threadId, "thread.activity-appended", {
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

const receipt = (threadId: ThreadId, attempt: string, status: string, scriptName = "test") =>
  activity(threadId, "selected-check-receipt", {
    attemptId: attempt,
    revision: 1,
    phase: "completed",
    planned: [{ scriptId: "s1", scriptName }],
    checks: [{ scriptId: "s1", status }],
  });

const seedProject = (projectId: string = PROJECT) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES (${projectId}, 'Project', '/tmp/project', '[]', ${NOW}, ${NOW}, NULL)
    `;
  });

const seedThread = (threadId: ThreadId, projectId: string = PROJECT) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at
      )
      VALUES (${threadId}, ${projectId}, 'Thread', '{"instanceId":"pi","model":"m"}', 'full-access', 'default', ${NOW}, ${NOW}, NULL)
    `;
  });

/** Two threads that each fixed a failing check; thread A's result was accepted. */
const seedTwoThreads = () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* seedProject();
    for (const threadId of [THREAD_A, THREAD_B]) {
      yield* seedThread(threadId);
      yield* append(threadId, "thread.created", { threadId });
      yield* append(threadId, "thread.message-sent", {
        threadId,
        role: "user",
        text: "SECRET TRANSCRIPT WORDS",
        streaming: false,
      });
      yield* receipt(threadId, `${threadId}-1`, "failed");
      yield* receipt(threadId, `${threadId}-2`, "passed");
    }
    yield* activity(THREAD_A, "task-result", {
      requirements: { version: 1 },
      acceptance: { acceptedAt: NOW },
    });
  });

const readHealth = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [health] =
    yield* sql`SELECT * FROM project_memory_analysis_health WHERE project_id = ${PROJECT}`;
  assert.isDefined(health);
  return health!;
});

const seedPending = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (let index = 0; index < count; index++) {
      yield* sql`
        INSERT INTO project_memory_proposals (
          proposal_id, project_id, thread_id, title, body, reason, created_at, source, evidence_json
        ) VALUES (
          ${`pending-${index}`}, ${PROJECT}, ${THREAD_A}, 'Pending', 'Unrelated suggestion',
          'Fixture', ${NOW}, 'analyser', '[]'
        )
      `;
    }
  });

describe("ProjectMemoryAnalyser", () => {
  test(
    "records and updates the outcome of a sent memory after its send boundary",
    { analyser: true },
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject();
        yield* seedThread(THREAD_A);
        yield* append(THREAD_A, "thread.created", { threadId: THREAD_A });
        yield* append(THREAD_A, "thread.reverted", {});
        const service = yield* ProjectMemoryService;
        const { memory } = yield* service.create({
          projectId: PROJECT,
          title: "Run checks",
          body: "Run focused checks after changes",
          kind: "procedure",
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        INSERT INTO project_memory_send_attempts (
          thread_id, message_id, project_id, provider_instance_id, owner_instance_id,
          state, committed_at, sent_after_event_sequence
        ) VALUES (${THREAD_A}, 'message-1', ${PROJECT}, 'provider', 'owner', 'provider_accepted', ${NOW}, ${sequence})
      `;
        yield* sql`
        INSERT INTO project_memory_send_items (attempt_seq, memory_id, memory_version)
        SELECT attempt_seq, ${memory.memoryId}, ${memory.version} FROM project_memory_send_attempts
      `;
        // A hand-off the provider refused settles unknown: that memory never arrived, so the
        // thread says nothing about it.
        const refused = yield* service.create({
          projectId: PROJECT,
          title: "Never arrived",
          body: "The provider refused this hand-off",
          kind: "fact",
        });
        yield* sql`
        INSERT INTO project_memory_send_attempts (
          thread_id, message_id, project_id, provider_instance_id, owner_instance_id,
          state, committed_at, settled_at, sent_after_event_sequence
        ) VALUES (${THREAD_A}, 'message-refused', ${PROJECT}, 'provider', 'owner', 'external_send_unknown', ${NOW}, ${NOW}, ${sequence})
      `;
        yield* sql`
        INSERT INTO project_memory_send_items (attempt_seq, memory_id, memory_version)
        SELECT attempt_seq, ${refused.memory.memoryId}, ${refused.memory.version}
        FROM project_memory_send_attempts WHERE message_id = 'message-refused'
      `;
        const analyser = yield* ProjectMemoryAnalyser;
        const outcomes = sql`SELECT outcome, judged_at_event_sequence FROM project_memory_outcomes`;
        yield* analyser.analyse({ projectId: PROJECT });
        assert.deepEqual(yield* outcomes, [
          { outcome: "unknown", judged_at_event_sequence: sequence },
        ]);
        yield* receipt(THREAD_A, "check-1", "passed");
        yield* analyser.analyse({ projectId: PROJECT });
        assert.deepEqual(yield* outcomes, [
          { outcome: "good", judged_at_event_sequence: sequence },
        ]);
        yield* append(THREAD_A, "thread.reverted", {});
        yield* analyser.analyse({ projectId: PROJECT });
        assert.deepEqual(yield* outcomes, [{ outcome: "bad", judged_at_event_sequence: sequence }]);
        yield* service.delete({
          projectId: PROJECT,
          memoryId: memory.memoryId,
          expectedVersion: 1,
        });
        assert.deepEqual(yield* outcomes, []);
      }),
  );

  it("decodes a proposal list from a server without analysis health", () => {
    assert.deepEqual(decodeProposalList({ items: [] }), {
      items: [],
    });
  });

  test("records a run with no signals", { analyser: true }, (fixture) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject();
      yield* seedThread(THREAD_A);
      yield* append(THREAD_A, "thread.created", { threadId: THREAD_A });
      const analyser = yield* ProjectMemoryAnalyser;
      yield* analyser.analyse({ projectId: PROJECT });
      const memory = yield* ProjectMemoryService;
      const proposals = yield* memory.listProposals({ projectId: PROJECT });
      assert.deepEqual(proposals.items, []);
      assert.isDefined(proposals.analysisHealth);
      assert.include(proposals.analysisHealth, {
        outcome: "no-signals",
        threadsRead: 1,
        threadsWithSignals: 0,
      });
      const health = yield* readHealth;
      assert.include(health, {
        outcome: "no-signals",
        threads_read: 1,
        threads_with_signals: 0,
        candidates_returned: 0,
        suggestions_filed: 0,
      });
      assert.isString(health.last_attempt_at);
      assert.isString(health.last_success_at);
      assert.equal(fixture.requests.length, 0);

      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = ${PROJECT}`;
      assert.deepEqual(yield* sql`SELECT * FROM project_memory_analysis_health`, []);
    }),
  );

  test(
    "pauses before calling the model when the analyser queue is full",
    { analyser: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* seedTwoThreads();
        const sql = yield* SqlClient.SqlClient;
        yield* seedPending(PROJECT_MEMORY_ANALYSER_PENDING_MAX);
        fixture.respond = () =>
          Effect.succeed({
            lessons: [
              { category: "fact", text: "Re-run the check after fixing it", threads: ["T1", "T2"] },
            ],
          });
        const analyser = yield* ProjectMemoryAnalyser;
        const result = yield* analyser.analyse({ projectId: PROJECT });
        assert.propertyVal(result, "queueFull", true);
        assert.lengthOf(fixture.requests, 0);
        assert.deepEqual(
          yield* sql`SELECT last_event_sequence FROM project_memory_analysis_cursors WHERE project_id = ${PROJECT}`,
          [],
        );
        assert.include(yield* readHealth, {
          outcome: "queue-full",
          threads_read: 0,
          threads_with_signals: 0,
          candidates_returned: 0,
          suggestions_filed: 0,
        });
      }),
  );

  for (const review of ["pending", "approved", "rejected"] as const) {
    test(
      `replays held evidence without filing the ${review} lesson again`,
      { analyser: true },
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTwoThreads();
          yield* seedPending(PROJECT_MEMORY_ANALYSER_PENDING_MAX - 1);
          const first = "Verify configuration defaults before rollout";
          const held = "Record migration timings in the release notes";
          fixture.respond = () =>
            Effect.succeed({
              lessons: [
                { category: "fact", text: first, threads: ["T1", "T2"] },
                { category: "fact", text: held, threads: ["T1", "T2"] },
              ],
            });
          const analyser = yield* ProjectMemoryAnalyser;
          const memory = yield* ProjectMemoryService;
          const input = { projectId: PROJECT };
          assert.include(yield* analyser.analyse(input), { memoriesProposed: 1, queueFull: true });
          assert.include(yield* readHealth, {
            outcome: "queue-full",
            candidates_returned: 2,
            suggestions_filed: 1,
          });
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(
            yield* sql`SELECT last_event_sequence FROM project_memory_analysis_cursors WHERE project_id = ${PROJECT}`,
            [],
          );
          const before = (yield* memory.listProposals(input)).items;
          const filed = before.find((proposal) => proposal.body === first)!;
          assert.notInclude(
            before.map((proposal) => proposal.body),
            held,
          );
          if (review === "approved") {
            yield* memory.approveProposal({ ...input, proposalId: filed.proposalId });
          } else {
            const reviewed =
              review === "rejected"
                ? filed
                : before.find((proposal) => proposal.body === "Unrelated suggestion")!;
            yield* memory.rejectProposal({ ...input, proposalId: reviewed.proposalId });
          }

          const result = yield* analyser.analyse(input);
          assert.equal(result.memoriesProposed, 1);
          assert.lengthOf(fixture.requests, 2);
          assert.equal(fixture.requests[1]?.digest, fixture.requests[0]?.digest);
          const after = (yield* memory.listProposals(input)).items;
          assert.equal(after.filter((proposal) => proposal.body === held).length, 1);
          assert.deepEqual(
            after.filter((proposal) => proposal.body === first).map(({ proposalId }) => proposalId),
            review === "pending" ? [filed.proposalId] : [],
          );
          assert.deepEqual(
            yield* sql`SELECT last_event_sequence FROM project_memory_analysis_cursors WHERE project_id = ${PROJECT}`,
            [{ last_event_sequence: sequence }],
          );
        }),
    );
  }

  test(
    "a crew thread's verified completion counts for that thread, not its lead",
    { analyser: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject();
        for (const threadId of [THREAD_A, THREAD_B, THREAD_C]) {
          yield* seedThread(threadId);
          yield* append(threadId, "thread.created", { threadId });
        }
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_threads SET parent_thread_id = ${THREAD_A} WHERE thread_id IN (${THREAD_B}, ${THREAD_C})`;
        const verified = (threadId: ThreadId) =>
          activity(THREAD_A, "task.completed", {
            crewRole: "worker",
            status: "completed",
            proof: "verified",
            threadId,
            summary: "Crew report text",
          });
        yield* append(THREAD_B, "thread.turn-diff-completed", { files: [{ path: "queue.ts" }] });
        yield* verified(THREAD_B);

        const analyser = yield* ProjectMemoryAnalyser;
        yield* analyser.analyse({ projectId: PROJECT });
        assert.lengthOf(fixture.requests, 0);

        // A second crew task under the same lead is independent work.
        yield* verified(THREAD_C);
        fixture.respond = () =>
          Effect.succeed({
            lessons: [
              {
                category: "fact",
                text: "Verify queue changes before handoff",
                threads: ["T1", "T2"],
              },
            ],
          });
        const result = yield* analyser.analyse({ projectId: PROJECT });
        assert.equal(result.memoriesProposed, 1);
        const prompt = fixture.requests[0]!.digest;
        assert.include(prompt, '"label":"T2"');
        assert.notInclude(prompt, '"label":"T3"');
        assert.include(prompt, "queue.ts");
        assert.include(prompt, "crew-work-verified");
        assert.notInclude(prompt, "Crew report text");
      }),
  );

  test("is refused, with no model call, while the setting is off", { analyser: false }, (fixture) =>
    Effect.gen(function* () {
      yield* seedTwoThreads();
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
        yield* seedTwoThreads();
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
      yield* seedTwoThreads();
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
    "a procedure becomes a skill-draft suggestion with an accepted source and independent evidence",
    { analyser: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* seedTwoThreads();
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
        // Thread A's accepted result makes it the primary source.
        assert.deepEqual(
          proposal?.analysis?.evidence.map((item) => item.threadId),
          [THREAD_A, THREAD_B],
        );
        assert.equal(proposal?.threadId, THREAD_A);
        assert.deepEqual((yield* memory.list({ projectId: PROJECT })).items, []);
      }),
  );

  test("provider text of an echo-tainted thread is withheld", { analyser: true }, (fixture) =>
    Effect.gen(function* () {
      yield* seedTwoThreads();
      for (const threadId of [THREAD_A, THREAD_B]) {
        yield* activity(threadId, "task.completed", {
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
        yield* seedTwoThreads();
        const audits = [
          [THREAD_A, "child-a", "AUDIT TEXT tainted child"],
          [THREAD_B, "child-b", "AUDIT TEXT clean child"],
          [THREAD_B, undefined, "AUDIT TEXT unnamed child"],
        ] as const;
        for (const [lead, child, summary] of audits) {
          yield* activity(lead, "task.completed", {
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
    "a lead keeps its auditors' verdicts, so approval after changes still counts",
    { analyser: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject();
        for (const threadId of [THREAD_A, THREAD_B]) {
          yield* seedThread(threadId);
          yield* append(threadId, "thread.created", { threadId });
        }
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_threads SET parent_thread_id = ${THREAD_A} WHERE thread_id = ${THREAD_B}`;
        yield* activity(THREAD_A, "task.completed", {
          crewRole: "worker",
          status: "completed",
          proof: "verified",
          threadId: THREAD_B,
        });
        const review = (verdict: string, auditor: string) =>
          activity(THREAD_A, "task.completed", {
            crewRole: "auditor",
            threadId: auditor,
            verdict,
            summary: "Review",
          });
        yield* review("needs-changes", "auditor-1");
        // The fix happens in a crew follow-up turn of the same request.
        yield* append(THREAD_A, "thread.message-sent", {
          threadId: THREAD_A,
          role: "user",
          text: '<oop_crew_follow_up round="1" fixes="1">\nFix it',
          streaming: false,
        });
        yield* review("approve", "auditor-2");
        const analyser = yield* ProjectMemoryAnalyser;
        yield* analyser.analyse({ projectId: PROJECT });

        const prompt = fixture.requests[0]?.digest ?? "";
        assert.include(prompt, "audit-needs-changes-then-fixed");
        assert.include(prompt, "crew-work-verified");
      }),
  );

  test(
    "a rejected suggestion is not proposed again by a later run",
    { analyser: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* seedTwoThreads();
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
        yield* receipt(THREAD_B, "thread-b-3", "passed");
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
        yield* seedTwoThreads();
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
        yield* receipt(THREAD_B, "thread-b-3", "passed");
        const second = yield* analyser.analyse({ projectId: PROJECT });
        assert.equal(second.memoriesProposed, 0);
        assert.equal(fixture.requests.length, 2);
        assert.deepEqual((yield* memory.listProposals({ projectId: PROJECT })).items, []);
      }),
  );

  test("nothing new since the last run means no model call", { analyser: true }, (fixture) =>
    Effect.gen(function* () {
      yield* seedTwoThreads();
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
        yield* seedTwoThreads();
        fixture.respond = () =>
          Effect.fail(
            new TextGenerationError({ operation: "generateWorkLessons", detail: "boom SECRET" }),
          );
        const analyser = yield* ProjectMemoryAnalyser;
        const error = yield* Effect.flip(analyser.analyse({ projectId: PROJECT }));
        if (error._tag !== "ProjectMemoryRejectedError") throw new Error(error._tag);
        assert.equal(error.reason, "analyser-failed");
        assert.notInclude(error.message, "SECRET");
        const health = yield* readHealth;
        assert.include(health, {
          outcome: "failed",
          last_success_at: null,
          threads_read: 2,
          threads_with_signals: 2,
          candidates_returned: 0,
          suggestions_filed: 0,
        });
        assert.notInclude(encodeJson(health), "SECRET");

        fixture.respond = () => Effect.succeed({ lessons: [] });
        yield* analyser.analyse({ projectId: PROJECT });
        assert.equal(fixture.requests.length, 2);
        const success = yield* readHealth;
        assert.include(success, { outcome: "no-candidates" });
        assert.isString(success.last_success_at);

        yield* receipt(THREAD_B, "thread-b-3", "passed");
        fixture.respond = () =>
          Effect.fail(
            new TextGenerationError({ operation: "generateWorkLessons", detail: "retry failed" }),
          );
        yield* Effect.flip(analyser.analyse({ projectId: PROJECT }));
        assert.include(yield* readHealth, {
          outcome: "failed",
          last_success_at: success.last_success_at,
        });
      }),
  );

  test(
    "dream files a suggestion for the project and marks it dreamed",
    { analyser: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* seedTwoThreads();
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

        const result = yield* analyser.dream;
        assert.deepEqual(result, { projects: 1, failed: 0 });

        const [proposal] = (yield* memory.listProposals({ projectId: PROJECT })).items;
        assert.equal(proposal?.body, "Re-run the test check after fixing a failure");
        assert.equal(proposal?.analysis?.dreamed, true);
        assert.deepEqual((yield* memory.list({ projectId: PROJECT })).items, []);
      }),
  );

  for (const firstProject of ["failed", "queue-full"] as const) {
    test(
      `a ${firstProject} project does not stop the next project from dreaming`,
      { analyser: true },
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTwoThreads();
          if (firstProject === "queue-full") {
            yield* seedPending(PROJECT_MEMORY_ANALYSER_PENDING_MAX);
          }
          yield* seedProject("project-2");
          for (const threadId of [THREAD_C, THREAD_D]) {
            yield* seedThread(threadId, "project-2");
            yield* append(threadId, "thread.created", { threadId });
            yield* append(threadId, "thread.message-sent", {
              threadId,
              role: "user",
              text: "SECOND PROJECT WORK",
              streaming: false,
            });
            yield* receipt(threadId, `${threadId}-1`, "failed", "dreamlint");
            yield* receipt(threadId, `${threadId}-2`, "passed", "dreamlint");
          }
          // Only the second project's digest names "dreamlint".
          fixture.respond = (input) =>
            input.digest.includes("dreamlint")
              ? Effect.succeed({
                  lessons: [
                    { category: "fact", text: "Lint before every commit", threads: ["T1", "T2"] },
                  ],
                })
              : Effect.fail(
                  new TextGenerationError({ operation: "generateWorkLessons", detail: "boom" }),
                );
          const analyser = yield* ProjectMemoryAnalyser;
          const memory = yield* ProjectMemoryService;

          const result = yield* analyser.dream;
          const paused = firstProject === "queue-full";
          assert.deepEqual(result, { projects: 2, failed: paused ? 0 : 1 });

          assert.include(yield* readHealth, { outcome: firstProject, suggestions_filed: 0 });
          assert.lengthOf(
            (yield* memory.listProposals({ projectId: PROJECT })).items,
            paused ? PROJECT_MEMORY_ANALYSER_PENDING_MAX : 0,
          );
          const [proposal] = (yield* memory.listProposals({
            projectId: ProjectId.make("project-2"),
          })).items;
          assert.equal(proposal?.body, "Lint before every commit");
          assert.equal(proposal?.analysis?.dreamed, true);
          assert.lengthOf(fixture.requests, paused ? 1 : 2);
        }),
    );
  }

  test("dream runs nothing while the analyser setting is off", { analyser: false }, (fixture) =>
    Effect.gen(function* () {
      yield* seedTwoThreads();
      const analyser = yield* ProjectMemoryAnalyser;
      const memory = yield* ProjectMemoryService;
      const result = yield* analyser.dream;
      assert.deepEqual(result, { projects: 0, failed: 0 });
      assert.equal(fixture.requests.length, 0);
      assert.deepEqual((yield* memory.listProposals({ projectId: PROJECT })).items, []);
    }),
  );
});

const seedTidyMemories = Effect.gen(function* () {
  const service = yield* ProjectMemoryService;
  for (const title of ["First", "Second"])
    yield* service.create({
      projectId: PROJECT,
      kind: "fact",
      title,
      body: "Reusable body",
      origin: { type: "manual" },
    });
});
describe("guarded tidy analysis", () => {
  test(
    "runs without new threads, remembers fingerprint and marks dreamed suggestions",
    { analyser: true, tidy: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject();
        yield* seedTidyMemories;
        const analyser = yield* ProjectMemoryAnalyser;
        const result = yield* analyser.dream;
        assert.equal(result.failed, 0);
        assert.equal(fixture.tidyRequests.length, 1);
        assert.equal(NodeFS.existsSync(fixture.tidyRequests[0]!.cwd), false);
        const service = yield* ProjectMemoryService;
        const items = (yield* service.listTidy({ projectId: PROJECT })).items;
        assert.equal(items.length, 1);
        assert.equal(items[0]!.dreamed, true);
        yield* service.dismissTidy({ projectId: PROJECT, tidyId: items[0]!.tidyId });
        yield* analyser.analyse({ projectId: PROJECT });
        assert.equal(fixture.tidyRequests.length, 1);
      }),
  );

  test(
    "still suggests tidy-ups while the review queue is full",
    { analyser: true, tidy: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* seedTwoThreads();
        yield* seedPending(PROJECT_MEMORY_ANALYSER_PENDING_MAX);
        yield* seedTidyMemories;
        const analyser = yield* ProjectMemoryAnalyser;
        const result = yield* analyser.analyse({ projectId: PROJECT });
        assert.include(result, { queueFull: true, tidiesSuggested: 1 });
        assert.lengthOf(fixture.requests, 0);
        assert.lengthOf(fixture.tidyRequests, 1);
      }),
  );
  for (const options of [
    { analyser: true, tidy: false },
    { analyser: false, tidy: true },
    { analyser: true, tidy: true, denied: true },
  ]) {
    test(
      `does not call model with guard ${options.analyser}/${options.tidy}/${options.denied}`,
      options,
      (fixture) =>
        Effect.gen(function* () {
          yield* runMigrations();
          yield* seedProject();
          yield* seedTidyMemories;
          const analyser = yield* ProjectMemoryAnalyser;
          yield* analyser.dream;
          assert.equal(fixture.tidyRequests.length, 0);
        }),
    );
  }
  test(
    "excludes sensitive memories and skips fewer than two eligible memories",
    { analyser: true, tidy: true },
    (fixture) =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject();
        yield* seedTidyMemories;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE project_memories SET body = '-----BEGIN PRIVATE KEY-----' WHERE title = 'First'`;
        const analyser = yield* ProjectMemoryAnalyser;
        yield* analyser.analyse({ projectId: PROJECT });
        assert.equal(fixture.tidyRequests.length, 0);
        const service = yield* ProjectMemoryService;
        yield* service.create({
          projectId: PROJECT,
          kind: "fact",
          title: "Third",
          body: "Safe",
          origin: { type: "manual" },
        });
        yield* analyser.analyse({ projectId: PROJECT });
        assert.equal(fixture.tidyRequests.length, 1);
        assert.equal(fixture.tidyRequests[0]!.digest.includes("PRIVATE KEY"), false);
      }),
  );
  test("tidy failure does not fail lessons", { analyser: true, tidy: true }, (fixture) =>
    Effect.gen(function* () {
      yield* seedTwoThreads();
      yield* seedTidyMemories;
      fixture.tidyRespond = () =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateMemoryTidy",
            detail: "Fixed test failure",
          }),
        );
      const analyser = yield* ProjectMemoryAnalyser;
      const result = yield* analyser.analyse({ projectId: PROJECT });
      assert.equal(result.threadsAnalysed, 2);
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.tidyRequests.length, 1);
    }),
  );
});
