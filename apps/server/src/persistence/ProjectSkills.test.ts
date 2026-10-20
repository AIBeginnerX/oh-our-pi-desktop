// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  EnvironmentId,
  MessageId,
  PROJECT_SKILL_CONTEXT_KIND,
  ProjectId,
  ProjectSkillEvidenceId,
  ProjectSkillId,
  ProjectSkillJudgmentId,
  ThreadId,
  TurnId,
  canonicalProjectSkillContentJson,
  evaluateSkillSource,
  projectSkillEnvironmentOf,
} from "@t3tools/contracts";
import type {
  ProjectSkillCheckObservation,
  ProjectSkillContent,
  ProjectSkillDraft,
  ProjectSkillEnvironment,
  ProjectSkillVersionRef,
  SelectedCheckReceipt,
  SelectedChecksGetResult,
  TaskResultRecord,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";
import { runMigrations } from "./Migrations.ts";
import Migration0061 from "./Migrations/061_ProjectSkillLifecycle.ts";
import {
  ProjectSkillRepository,
  ProjectSkillUseWorkAssessor,
  type ProjectSkillCandidateOutcome,
  type ProjectSkillEvidenceJudgment,
  type ProjectSkillRevisionOutcome,
  layer,
  useWorkAssessorLayer,
} from "./ProjectSkills.ts";

const NOW = "2026-10-09T00:00:00.000Z";
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const THREAD_CREATED_SEQUENCE = 5;
const ANCHOR_SEQUENCE = 20;
const RECEIPT_SEQUENCE = 25;
const WATERMARK_SEQUENCE = 50;

const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");
const skillId = ProjectSkillId.make("psk_abcd1234");
const otherSkillId = ProjectSkillId.make("psk_efgh5678");

const contentA: ProjectSkillContent = {
  title: "Release the web app",
  purpose: "Ship a tagged release through the checked pipeline.",
  appliesWhen: "The user asks to cut a release.",
  doesNotApplyWhen: "The user asks for a hotfix outside the pipeline.",
  procedure: "1. Install dependencies.\n2. Run the release script.\n3. Tag the commit.",
  successCheck: "The release test script exits 0.",
};
const contentB: ProjectSkillContent = {
  ...contentA,
  procedure: "1. Install dependencies.\n2. Run the release script.\n3. Tag and push.",
};

function withSkillsDatabase<A, E, R>(effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-server-skills-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  // 061 is not registered in Migrations.ts yet, so the lifecycle fixtures pin
  // the run at 60 and apply the migration module directly.
  return Effect.andThen(
    Effect.andThen(runMigrations({ toMigrationInclusive: 60 }), Migration0061),
    effect,
  ).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
}

const test = (name: string, run: () => Effect.Effect<unknown, unknown, SqlClient.SqlClient>) =>
  it.effect(name, () => withSkillsDatabase(run()));

// Resolving the repository needs the sqlite client in the environment, so
// each test yields this against the harness-provided client (057 pattern).
const skillsRepository = Effect.gen(function* () {
  return yield* ProjectSkillRepository;
}).pipe(Effect.provide(layer));

const sqlClient = Effect.gen(function* () {
  return yield* SqlClient.SqlClient;
});

const seedProject = (id: typeof projectId) =>
  Effect.gen(function* () {
    const sql = yield* sqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES (${id}, 'Project', '/tmp/project', '[]', ${NOW}, ${NOW}, NULL)
    `;
  });

const seedThread = (id: ThreadId, targetProjectId: ProjectId = projectId) =>
  Effect.gen(function* () {
    const sql = yield* sqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at
      )
      VALUES (${id}, ${targetProjectId}, 'Thread', '{}', 'full-access', 'default', ${NOW}, ${NOW}, NULL)
    `;
  });

const seedMessage = (id: ThreadId, messageId: string) =>
  Effect.gen(function* () {
    const sql = yield* sqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      VALUES (${messageId}, ${id}, NULL, 'user', 'text', 0, ${NOW}, ${NOW})
    `;
  });

interface SeedEvent {
  readonly sequence: number;
  readonly threadId?: ThreadId;
  readonly eventType: string;
  readonly payload: unknown;
  readonly commandId?: string | undefined;
  /** Event aggregate; a `project` event streams on `projectId`, not the thread. */
  readonly aggregateKind?: "thread" | "project";
}

const seedEvent = (event: SeedEvent) =>
  Effect.gen(function* () {
    const sql = yield* sqlClient;
    yield* sql`
      INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      )
      VALUES (
        ${event.sequence}, ${`event-${event.sequence}`}, ${event.aggregateKind ?? "thread"},
        ${event.aggregateKind === "project" ? projectId : (event.threadId ?? threadId)},
        ${event.sequence}, ${event.eventType}, ${NOW},
        ${event.commandId ?? null}, NULL, NULL, 'server', ${JSON.stringify(event.payload)}, '{}'
      )
    `;
  });

const passingReceipt = (): SelectedCheckReceipt => ({
  schemaVersion: 1,
  threadId,
  attemptId: "attempt-1",
  revision: 2,
  threadAnchorSequence: ANCHOR_SEQUENCE,
  context: {
    projectId,
    workspaceRoot: "/tmp/project",
    worktreePath: null,
    cwd: "/tmp/project",
    shell: "/bin/zsh",
    envSha256: SHA,
  },
  planned: [
    { scriptId: "lint", scriptName: "Lint", commandSha256: SHA, timeoutMs: 60_000 },
    { scriptId: "test", scriptName: "Test", commandSha256: OTHER_SHA, timeoutMs: 60_000 },
  ],
  environment: {
    environmentId: EnvironmentId.make("env-1"),
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.6.0",
    serverVersion: "1.0.0",
    nodeVersion: "22.11.0",
  },
  tree: {
    atStart: { kind: "complete", treeOid: "c".repeat(40) },
    atEnd: { kind: "complete", treeOid: "c".repeat(40) },
    repoAtStart: { topLevel: "/tmp/project", commonDir: "/tmp/project" },
    repoAtEnd: { topLevel: "/tmp/project", commonDir: "/tmp/project" },
  },
  phase: "completed",
  checks: [
    {
      scriptId: "lint",
      status: "passed",
      startedAt: "2026-08-20T12:00:00Z",
      endedAt: "2026-08-20T12:00:30Z",
      exitCode: 0,
      exitedBy: "exit",
      exitSignal: null,
      pgid: 41234,
      group: "empty",
      stdout: { bytes: 120, sha256: SHA },
      stderr: { bytes: 0, sha256: OTHER_SHA },
      failure: null,
    },
    {
      scriptId: "test",
      status: "passed",
      startedAt: "2026-08-20T12:00:30Z",
      endedAt: "2026-08-20T12:01:00Z",
      exitCode: 0,
      exitedBy: "exit",
      exitSignal: null,
      pgid: 41235,
      group: "empty",
      stdout: { bytes: 120, sha256: SHA },
      stderr: { bytes: 0, sha256: OTHER_SHA },
      failure: null,
    },
  ],
  startedAt: "2026-08-20T12:00:00Z",
  endedAt: "2026-08-20T12:01:00Z",
  error: null,
});

const failedReceipt = (): SelectedCheckReceipt => ({
  ...passingReceipt(),
  checks: [
    {
      ...passingReceipt().checks[1]!,
      scriptId: "lint",
      status: "failed",
      exitCode: 2,
      group: "killed",
    },
  ],
  endedAt: null,
});

const receiptActivityPayload = (receipt: SelectedCheckReceipt) => ({
  threadId,
  activity: {
    id: `selected-check-receipt:${threadId}`,
    tone:
      receipt.phase === "errored" || receipt.checks.some((check) => check.status === "failed")
        ? "error"
        : "info",
    kind: "selected-check-receipt",
    summary: "Selected checks finished",
    payload: receipt,
    turnId: null,
    createdAt: NOW,
  },
});

const buildCheck = (receipt: SelectedCheckReceipt): ProjectSkillCheckObservation => {
  const evaluation = evaluateSkillSource({
    candidateProjectId: projectId,
    thread: {
      threadId,
      projectId,
      worktreePath: null,
      latestTurnState: null,
    },
    latestInputEventSequence: null,
    checks: {
      capability: { available: true, reason: null },
      record: { kind: "present", receipt, sequence: RECEIPT_SEQUENCE },
      changedScriptIds: [],
      admission: { state: "open" },
    },
    expected: {
      attemptId: receipt.attemptId,
      revision: receipt.revision,
      receiptSequence: RECEIPT_SEQUENCE,
    },
  });
  if (!evaluation.ok) throw new Error(`fixture receipt must pass: ${evaluation.reason}`);
  return evaluation.check;
};

// Seeds the controlled source world: the thread's incarnation, the receipt's
// two writes, and only non-user events afterwards (an assistant message in
// this thread, one in another thread). Direct SQL seeds are controlled inputs
// for the pure storage policy — they are never evidence a server executed
// checks or accepted a real send.
const seedSourceWorld = (
  receipt: SelectedCheckReceipt,
  extraEvents: ReadonlyArray<SeedEvent> = [],
  options: { readonly receiptCommandId?: string } = {},
) =>
  Effect.gen(function* () {
    yield* seedProject(projectId);
    yield* seedThread(threadId);
    yield* seedEvent({
      sequence: THREAD_CREATED_SEQUENCE,
      threadId,
      eventType: "thread.created",
      payload: { threadId, projectId },
    });
    yield* seedEvent({
      sequence: 20,
      threadId,
      eventType: "thread.activity-appended",
      commandId: "server:selected-checks:first",
      payload: receiptActivityPayload({ ...receipt, revision: 1, threadAnchorSequence: null }),
    });
    yield* seedEvent({
      sequence: RECEIPT_SEQUENCE,
      threadId,
      eventType: "thread.activity-appended",
      commandId: options.receiptCommandId ?? "server:selected-checks:seed",
      payload: receiptActivityPayload(receipt),
    });
    for (const extra of extraEvents) yield* seedEvent(extra);
    yield* seedEvent({
      sequence: 30,
      threadId,
      eventType: "thread.message-sent",
      payload: { role: "assistant" },
    });
    yield* seedEvent({
      sequence: WATERMARK_SEQUENCE,
      threadId: otherThreadId,
      eventType: "thread.message-sent",
      payload: { role: "assistant" },
    });
  });

const insertCandidateFor = (
  repository: ProjectSkillRepository["Service"],
  options: {
    readonly check: ProjectSkillCheckObservation;
    readonly draft?: ProjectSkillDraft;
    readonly skillId?: ProjectSkillId;
  },
): Effect.Effect<ProjectSkillCandidateOutcome, unknown> =>
  repository.insertCandidate({
    skillId: options.skillId ?? skillId,
    projectId,
    content: contentA,
    contentSha256: SHA,
    check: options.check,
    draft: options.draft ?? { type: "typed" },
    now: NOW,
  });

const versionRowCounts = Effect.gen(function* () {
  const sql = yield* sqlClient;
  const rows = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS "n" FROM project_skill_versions
  `;
  return rows[0]?.n ?? 0;
});

const rawVersionRows = Effect.gen(function* () {
  const sql = yield* sqlClient;
  return yield* sql<{
    readonly skillId: string;
    readonly version: number;
    readonly sourceThreadId: string;
    readonly sourceReceiptSequence: number;
    readonly sourceThreadCreatedSequence: number;
    readonly createdAfterEventSequence: number;
    readonly state: string;
    readonly retiredReason: string | null;
    readonly contentJson: string;
    readonly contentSha256: string;
    readonly createdAt: string;
  }>`
    SELECT skill_id AS "skillId", version AS "version",
      source_thread_id AS "sourceThreadId", source_receipt_sequence AS "sourceReceiptSequence",
      source_thread_created_sequence AS "sourceThreadCreatedSequence",
      created_after_event_sequence AS "createdAfterEventSequence",
      state AS "state", retired_reason AS "retiredReason",
      content_json AS "contentJson", content_sha256 AS "contentSha256", created_at AS "createdAt"
    FROM project_skill_versions
    ORDER BY skill_id, version
  `;
});

// A stored version row whose source_json is the watermark-stripped work
// source of the passing receipt fixture — the exact shape the repository
// itself writes, seeded directly for revision/list/get scenarios.
const seedCandidateRow = (input: {
  readonly projectId: ProjectId;
  readonly skillId: ProjectSkillId;
  readonly version: number;
  readonly contentSha256: string;
  readonly content?: ProjectSkillContent;
  readonly createdAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* sqlClient;
    const check = buildCheck(passingReceipt());
    yield* sql`
      INSERT INTO project_skill_versions (
        skill_id, project_id, version, content_json, content_sha256,
        source_json, source_thread_id, source_receipt_sequence,
        source_thread_created_sequence, created_after_event_sequence, created_at
      )
      VALUES (
        ${input.skillId}, ${input.projectId}, ${input.version},
        ${JSON.stringify(input.content ?? contentA)}, ${input.contentSha256},
        ${JSON.stringify({ type: "work", check, draft: { type: "typed" } })},
        ${threadId}, ${RECEIPT_SEQUENCE}, ${THREAD_CREATED_SEQUENCE}, ${WATERMARK_SEQUENCE},
        ${input.createdAt ?? NOW}
      )
    `;
  });

describe("ProjectSkillRepository.insertCandidate", () => {
  test("stores the candidate with the event-store watermark and incarnation", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt());

      // The default world carries an assistant message after the anchor: the
      // role filter lets it through where any user input would not.
      const result = yield* insertCandidateFor(repository, { check: buildCheck(passingReceipt()) });
      assert.equal(result.status, "applied");
      if (result.status !== "applied") return;
      expect(result.row.ref).toEqual({
        projectId,
        skillId,
        version: 1,
        contentSha256: SHA,
      });
      assert.equal(result.row.source.type, "work");
      assert.equal(result.row.source.createdAfterEventSequence, WATERMARK_SEQUENCE);
      assert.equal(result.row.state, "candidate");
      assert.equal(result.row.retiredReason, null);
      assert.equal(result.row.createdAt, NOW);

      const rows = yield* rawVersionRows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.sourceThreadId, threadId);
      assert.equal(rows[0]?.sourceReceiptSequence, RECEIPT_SEQUENCE);
      assert.equal(rows[0]?.sourceThreadCreatedSequence, THREAD_CREATED_SEQUENCE);
      assert.equal(rows[0]?.createdAfterEventSequence, WATERMARK_SEQUENCE);
      assert.equal(rows[0]?.state, "candidate");
    }));

  test("accepts a message draft only from the source thread", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt());
      yield* seedMessage(threadId, MessageId.make("message-1"));

      const applied = yield* insertCandidateFor(repository, {
        check: buildCheck(passingReceipt()),
        draft: { type: "message", messageId: MessageId.make("message-1") },
        skillId: ProjectSkillId.make("psk_draft001"),
      });
      assert.equal(applied.status, "applied");

      // A second world where the cited message lives in another thread.
      yield* seedProject(otherProjectId);
      yield* seedThread(otherThreadId, otherProjectId);
      yield* seedMessage(otherThreadId, MessageId.make("message-2"));
      const other = yield* insertCandidateFor(repository, {
        check: buildCheck(passingReceipt()),
        draft: { type: "message", messageId: MessageId.make("message-2") },
        skillId: ProjectSkillId.make("psk_draft002"),
      });
      assert.equal(other.status, "draft-message-invalid");
    }));

  test("rejects a claim whose identifiers move off the stored receipt", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt());

      // The stored receipt's identifiers belong to attempt-1 while this
      // observation claims another attempt.
      const check = buildCheck(passingReceipt());
      const moved = yield* insertCandidateFor(repository, {
        check: { ...check, attemptId: "attempt-moved" },
        skillId: ProjectSkillId.make("psk_moved001"),
      });
      assert.equal(moved.status, "source-changed");
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("rejects each receipt identifier moved independently off the stored wrapper", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt());
      const check = buildCheck(passingReceipt());

      // One field at a time against the same valid stored wrapper: moving
      // two at once could hide an identifier the guard does not enforce.
      const movedSequence = yield* insertCandidateFor(repository, {
        check: { ...check, receiptSequence: RECEIPT_SEQUENCE + 1 },
        skillId: ProjectSkillId.make("psk_movseq01"),
      });
      assert.equal(movedSequence.status, "source-changed");

      const movedRevision = yield* insertCandidateFor(repository, {
        check: { ...check, revision: 3 },
        skillId: ProjectSkillId.make("psk_movrev01"),
      });
      assert.equal(movedRevision.status, "source-changed");

      const movedAnchor = yield* insertCandidateFor(repository, {
        check: { ...check, threadAnchorSequence: ANCHOR_SEQUENCE + 5 },
        skillId: ProjectSkillId.make("psk_movanc01"),
      });
      assert.equal(movedAnchor.status, "source-changed");
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("rejects a receipt activity without the server writer's command prefix", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt(), [], { receiptCommandId: "client:forged" });
      const result = yield* insertCandidateFor(repository, {
        check: buildCheck(passingReceipt()),
      });
      assert.equal(result.status, "source-changed");
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("rejects when the same receipt activity was rewritten later", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt(), [
        {
          sequence: 35,
          eventType: "thread.activity-appended",
          commandId: "server:selected-checks:rewrite",
          payload: receiptActivityPayload({ ...passingReceipt(), revision: 3 }),
        },
      ]);

      const result = yield* insertCandidateFor(repository, { check: buildCheck(passingReceipt()) });
      assert.equal(result.status, "source-changed");
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("refuses a passed observation over a stored receipt that failed", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      // The stored receipt failed; the submitted observation claims a pass
      // with the same three identifiers. The stored payload is the authority.
      yield* seedSourceWorld(failedReceipt());

      const result = yield* insertCandidateFor(repository, { check: buildCheck(passingReceipt()) });
      assert.equal(result.status, "source-changed");
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("rejects an observation tampered against the real passing receipt", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt());
      const check = buildCheck(passingReceipt());

      const tamperedTree = yield* insertCandidateFor(repository, {
        check: {
          ...check,
          tree: {
            treeOid: "d".repeat(40),
            repoTopLevel: "/tmp/project",
            repoCommonDir: "/tmp/project",
          },
        },
        skillId: ProjectSkillId.make("psk_tamper01"),
      });
      assert.equal(tamperedTree.status, "source-changed");

      const tamperedCommand = yield* insertCandidateFor(repository, {
        check: {
          ...check,
          planned: [{ ...check.planned[0]!, commandSha256: OTHER_SHA }, ...check.planned.slice(1)],
        },
        skillId: ProjectSkillId.make("psk_tamper02"),
      });
      assert.equal(tamperedCommand.status, "source-changed");
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("closes the window on user input after the attempt's first write", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt(), [
        { sequence: 35, eventType: "thread.message-sent", payload: { role: "user" } },
      ]);
      const userMessage = yield* insertCandidateFor(repository, {
        check: buildCheck(passingReceipt()),
        skillId: ProjectSkillId.make("psk_userin01"),
      });
      assert.equal(userMessage.status, "source-changed");
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("closes the window on a user-input response after the anchor", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt(), [
        { sequence: 35, eventType: "thread.user-input-response-requested", payload: {} },
      ]);
      const result = yield* insertCandidateFor(repository, {
        check: buildCheck(passingReceipt()),
        skillId: ProjectSkillId.make("psk_reply001"),
      });
      assert.equal(result.status, "source-changed");
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("rejects thread recreation after the anchor", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt(), [
        { sequence: 35, eventType: "thread.created", payload: {} },
      ]);
      const result = yield* insertCandidateFor(repository, { check: buildCheck(passingReceipt()) });
      assert.equal(result.status, "source-changed");
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("rejects a deletion inside the source incarnation", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      // Deleted after the incarnation began but before the anchor: this
      // receipt's thread incarnation is not intact.
      yield* seedSourceWorld(passingReceipt(), [
        { sequence: 10, eventType: "thread.deleted", payload: {} },
      ]);
      const result = yield* insertCandidateFor(repository, { check: buildCheck(passingReceipt()) });
      assert.equal(result.status, "source-changed");
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("rejects when the latest pre-anchor incarnation belongs to another project", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      // Incarnations of this thread: created at 5 for project A, then at 15
      // for project B, anchor 20. The latest creation before the anchor is
      // the foreign one — the guard must refuse, not fall back to the
      // earlier same-project incarnation.
      yield* seedSourceWorld(passingReceipt(), [
        {
          sequence: 15,
          eventType: "thread.created",
          payload: { threadId, projectId: otherProjectId },
        },
      ]);
      const result = yield* insertCandidateFor(repository, {
        check: buildCheck(passingReceipt()),
        skillId: ProjectSkillId.make("psk_incmism01"),
      });
      assert.equal(result.status, "source-changed");
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("stores the latest same-project incarnation and ignores other-thread lifecycle", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      // Same thread recreated at 15 for this project before the anchor; a
      // different thread's create/delete inside the window is out of scope.
      yield* seedSourceWorld(passingReceipt(), [
        {
          sequence: 15,
          eventType: "thread.created",
          payload: { threadId, projectId },
        },
        {
          sequence: 17,
          threadId: otherThreadId,
          eventType: "thread.created",
          payload: { threadId: otherThreadId, projectId: otherProjectId },
        },
        {
          sequence: 19,
          threadId: otherThreadId,
          eventType: "thread.deleted",
          payload: { threadId: otherThreadId },
        },
      ]);
      const result = yield* insertCandidateFor(repository, {
        check: buildCheck(passingReceipt()),
        skillId: ProjectSkillId.make("psk_incokay1"),
      });
      assert.equal(result.status, "applied");
      const rows = yield* rawVersionRows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.sourceThreadCreatedSequence, 15);
    }));

  test("reports thread-missing for a deleted thread and project-missing for a tombstone", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt());
      yield* Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`UPDATE projection_threads SET deleted_at = ${NOW} WHERE thread_id = ${threadId}`;
      });
      const threadMissing = yield* insertCandidateFor(repository, {
        check: buildCheck(passingReceipt()),
        skillId: ProjectSkillId.make("psk_gonethr01"),
      });
      assert.equal(threadMissing.status, "thread-missing");

      // Restoring the thread row and tombstoning the project: the tombstone
      // trigger removes stored rows and the insert refuses to write.
      yield* Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`UPDATE projection_threads SET deleted_at = NULL WHERE thread_id = ${threadId}`;
        yield* sql`UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = ${projectId}`;
      });
      const projectMissing = yield* insertCandidateFor(repository, {
        check: buildCheck(passingReceipt()),
        skillId: ProjectSkillId.make("psk_goneprj1"),
      });
      assert.equal(projectMissing.status, "project-missing");
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("latestUserInputSequence takes the max of the five input shapes only", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt(), [
        { sequence: 10, eventType: "thread.message-sent", payload: { role: "user" } },
        { sequence: 22, eventType: "thread.turn-start-requested", payload: {} },
        { sequence: 35, eventType: "thread.user-input-response-requested", payload: {} },
        { sequence: 40, eventType: "thread.approval-response-requested", payload: {} },
        { sequence: 28, eventType: "thread.checkpoint-revert-requested", payload: {} },
        { sequence: 45, eventType: "thread.message-sent", payload: { role: "assistant" } },
        {
          sequence: 60,
          threadId: otherThreadId,
          eventType: "thread.message-sent",
          payload: { role: "user" },
        },
      ]);
      const latest = yield* repository.latestUserInputSequence({ threadId });
      assert.equal(latest, 40);

      // A thread with none of the five shapes has no user input.
      const empty = yield* repository.latestUserInputSequence({
        threadId: ThreadId.make("thread-9"),
      });
      assert.equal(empty, null);
    }));
});

describe("ProjectSkillRepository.insertRevision", () => {
  test("appends version+1 with a fresh watermark and the immutable root", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      // Events give the watermark its value: v1 was stored at W=50 and the
      // revision must measure a fresh W in the same sequence space.
      yield* seedSourceWorld(passingReceipt());
      yield* seedCandidateRow({
        projectId,
        skillId,
        version: 1,
        contentSha256: SHA,
      });
      const before = yield* rawVersionRows;

      const result = yield* repository.insertRevision({
        projectId,
        skillId,
        fromVersion: 1,
        expectedLatestVersion: 1,
        content: contentB,
        contentSha256: OTHER_SHA,
        now: NOW,
      });
      assert.equal(result.status, "applied");
      if (result.status !== "applied") return;
      assert.equal(result.row.ref.version, 2);
      assert.equal(result.row.source.type, "revision");
      if (result.row.source.type !== "revision") return;
      assert.equal(result.row.source.fromVersion, 1);
      assert.equal(result.row.source.root.type, "work");
      assert.equal(result.row.source.root.createdAfterEventSequence, WATERMARK_SEQUENCE);
      assert.ok(result.row.source.createdAfterEventSequence >= WATERMARK_SEQUENCE);
      assert.equal(result.row.state, "candidate");

      // v1 keeps every raw column byte-for-byte.
      const after = yield* rawVersionRows;
      assert.equal(after.length, 2);
      const v1Before = before.find((row) => row.version === 1);
      const v1After = after.find((row) => row.version === 1);
      assert.deepEqual(v1After, v1Before);
      const root = result.row.source.type === "revision" ? result.row.source.root : null;
      assert.equal(root?.check.threadId, threadId);
    }));

  test("conflicts on a stale expectedLatestVersion and writes nothing", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedProject(projectId);
      yield* seedCandidateRow({ projectId, skillId, version: 1, contentSha256: SHA });
      yield* repository.insertRevision({
        projectId,
        skillId,
        fromVersion: 1,
        expectedLatestVersion: 1,
        content: contentB,
        contentSha256: OTHER_SHA,
        now: NOW,
      });

      // Two writers with the same expectedLatestVersion cannot both succeed:
      // the second one's guard sees the first one's row and conflicts.
      const stale = yield* repository.insertRevision({
        projectId,
        skillId,
        fromVersion: 1,
        expectedLatestVersion: 1,
        content: contentB,
        contentSha256: "c".repeat(64),
        now: NOW,
      });
      assert.deepEqual(stale, { status: "conflict", currentLatestVersion: 2 });
      assert.equal(yield* versionRowCounts, 2);
    }));

  // Two independently scoped clients on one real file, released on the same
  // start barrier with the same expectedLatestVersion: SQLite's writer
  // serialization admits exactly one guarded insert. The loser may surface a
  // conflict or a typed busy/locked persistence failure — never a second row
  // or an untyped error — and v1 stays byte-for-byte.
  it.effect(
    "admits exactly one of two concurrent writers on independent clients of one file",
    () => {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-server-skills-race-"));
      const dbPath = NodePath.join(tempDir, "state.sqlite");
      const hashA = "d".repeat(64);
      const hashB = "e".repeat(64);
      const clientLayerA = NodeSqliteClient.layer({ filename: dbPath });
      const clientLayerB = NodeSqliteClient.layer({ filename: dbPath });
      return Effect.gen(function* () {
        // Migrate and seed on a first connection, then close it: each writer
        // below opens its own client against the same file.
        yield* Effect.gen(function* () {
          yield* runMigrations();
          yield* seedProject(projectId);
          yield* seedCandidateRow({
            projectId,
            skillId,
            version: 1,
            contentSha256: SHA,
          });
        }).pipe(Effect.provide(clientLayerA));
        const before = yield* rawVersionRows.pipe(Effect.provide(clientLayerA));

        const start = yield* Deferred.make<void>();
        const readyA = yield* Deferred.make<void>();
        const readyB = yield* Deferred.make<void>();
        const writeRevision = (
          clientLayer: typeof clientLayerA,
          ready: Deferred.Deferred<void>,
          contentSha256: string,
        ) =>
          Effect.gen(function* () {
            const repository = yield* ProjectSkillRepository;
            yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(start);
            return yield* repository.insertRevision({
              projectId,
              skillId,
              fromVersion: 1,
              expectedLatestVersion: 1,
              content: contentB,
              contentSha256,
              now: NOW,
            });
          }).pipe(Effect.provide(Layer.provide(layer, clientLayer)), Effect.exit);

        const fiberA = yield* writeRevision(clientLayerA, readyA, hashA).pipe(Effect.forkChild);
        const fiberB = yield* writeRevision(clientLayerB, readyB, hashB).pipe(Effect.forkChild);
        yield* Deferred.await(readyA);
        yield* Deferred.await(readyB);
        yield* Deferred.succeed(start, undefined);
        const exitA = yield* Fiber.join(fiberA);
        const exitB = yield* Fiber.join(fiberB);
        const exits: ReadonlyArray<Exit.Exit<ProjectSkillRevisionOutcome, unknown>> = [
          exitA,
          exitB,
        ];

        const applied = exits.filter(
          (exit) => Exit.isSuccess(exit) && exit.value.status === "applied",
        );
        const losers = exits.filter((exit) => {
          if (Exit.isSuccess(exit)) return exit.value.status === "conflict";
          const failure = Cause.findErrorOption(exit.cause);
          return Option.isSome(failure) && failure.value instanceof PersistenceSqlError;
        });
        assert.equal(applied.length, 1);
        assert.equal(losers.length, 1);

        const after = yield* rawVersionRows.pipe(Effect.provide(clientLayerA));
        assert.equal(after.length, 2);
        assert.deepEqual(
          after.find((row) => row.version === 1),
          before.find((row) => row.version === 1),
        );
        const winnerHash =
          Exit.isSuccess(exitA) && exitA.value.status === "applied" ? hashA : hashB;
        assert.equal(after.find((row) => row.version === 2)?.contentSha256, winnerHash);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
        ),
      );
    },
  );

  test("rejects a revision whose content hash already exists", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedProject(projectId);
      yield* seedCandidateRow({ projectId, skillId, version: 1, contentSha256: SHA });

      const duplicate = yield* repository.insertRevision({
        projectId,
        skillId,
        fromVersion: 1,
        expectedLatestVersion: 1,
        content: contentA,
        contentSha256: SHA,
        now: NOW,
      });
      assert.deepEqual(duplicate, { status: "duplicate-content", existingVersion: 1 });
      assert.equal(yield* versionRowCounts, 1);
    }));
});

describe("ProjectSkillRepository judgments", () => {
  test("records a rights judgment bound to the exact ref", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt());
      yield* seedCandidateRow({ projectId, skillId, version: 1, contentSha256: SHA });

      const result = yield* repository.insertJudgment({
        judgment: rightsJudgmentFor(projectId, skillId, 1, SHA),
      });
      assert.equal(result.status, "applied");
      if (result.status !== "applied") return;
      assert.equal(result.row.judgment.kind, "rights");
      assert.equal(result.row.recordedAfterEventSequence, WATERMARK_SEQUENCE);
      assert.equal(result.row.withdrawnAt, null);

      const wrongRef = yield* repository.insertJudgment({
        judgment: rightsJudgmentFor(projectId, skillId, 1, OTHER_SHA),
      });
      assert.equal(wrongRef.status, "ref-mismatch");
    }));

  test("withdraws once, then reports already-withdrawn; unknown ids are not-found", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt());
      yield* seedCandidateRow({ projectId, skillId, version: 1, contentSha256: SHA });
      yield* repository.insertJudgment({ judgment: rightsJudgmentFor(projectId, skillId, 1, SHA) });

      const applied = yield* repository.withdrawJudgment({
        ref: { projectId, skillId, version: 1, contentSha256: SHA },
        judgmentId: ProjectSkillJudgmentId.make("psj-psk_abcd1234-1"),
        now: NOW,
      });
      assert.equal(applied.status, "applied");

      const again = yield* repository.withdrawJudgment({
        ref: { projectId, skillId, version: 1, contentSha256: SHA },
        judgmentId: ProjectSkillJudgmentId.make("psj-psk_abcd1234-1"),
        now: NOW,
      });
      assert.equal(again.status, "already-withdrawn");

      const unknown = yield* repository.withdrawJudgment({
        ref: { projectId, skillId, version: 1, contentSha256: SHA },
        judgmentId: ProjectSkillJudgmentId.make("psj-unknown001"),
        now: NOW,
      });
      assert.equal(unknown.status, "not-found");

      const rows = yield* Effect.gen(function* () {
        const sql = yield* sqlClient;
        return yield* sql<{ readonly withdrawnAt: string | null }>`
          SELECT withdrawn_at AS "withdrawnAt" FROM project_skill_judgments
        `;
      });
      assert.equal(rows[0]?.withdrawnAt, NOW);
    }));
});

describe("ProjectSkillRepository.listSkills and getSkill", () => {
  test("lists the latest version per skill with its own judgments, truncated by limit+1", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedProject(projectId);
      yield* seedCandidateRow({ projectId, skillId, version: 1, contentSha256: SHA });
      yield* seedCandidateRow({
        projectId,
        skillId,
        version: 2,
        contentSha256: OTHER_SHA,
        createdAt: "2026-10-09T01:00:00.000Z",
      });
      yield* seedCandidateRow({ projectId, skillId: otherSkillId, version: 1, contentSha256: SHA });
      yield* repository.insertJudgment({ judgment: rightsJudgmentFor(projectId, skillId, 1, SHA) });
      yield* repository.insertJudgment({
        judgment: rightsJudgmentFor(projectId, skillId, 2, OTHER_SHA),
      });

      const page = yield* repository.listSkills({ projectId, limit: 1 });
      assert.equal(page.truncated, true);
      assert.equal(page.items.length, 1);
      const first = page.items[0];
      assert.equal(first?.version.ref.skillId, skillId);
      // Latest version only, with only that exact ref's judgments.
      assert.equal(first?.version.ref.version, 2);
      assert.equal(first?.judgments.length, 1);
      assert.equal(first?.judgments[0]?.judgment.ref.version, 2);

      const full = yield* repository.listSkills({ projectId, limit: 5 });
      assert.equal(full.truncated, false);
      assert.equal(full.items.length, 2);

      // Another project's rows never leak into this list.
      yield* seedProject(otherProjectId);
      yield* seedCandidateRow({
        projectId: otherProjectId,
        skillId: ProjectSkillId.make("psk_zzzz9999"),
        version: 1,
        contentSha256: SHA,
      });
      const isolated = yield* repository.listSkills({ projectId, limit: 5 });
      assert.equal(isolated.items.length, 2);
    }));

  test("returns every version latest-first with deterministically sorted judgments", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedProject(projectId);
      yield* seedCandidateRow({ projectId, skillId, version: 1, contentSha256: SHA });
      yield* seedCandidateRow({ projectId, skillId, version: 2, contentSha256: OTHER_SHA });
      yield* repository.insertJudgment({
        judgment: rightsJudgmentFor(projectId, skillId, 2, OTHER_SHA),
      });
      yield* repository.insertJudgment({
        judgment: rightsJudgmentFor(projectId, skillId, 1, SHA),
      });

      const detail = yield* repository.getSkill({ projectId, skillId });
      assert.equal(Option.isSome(detail), true);
      if (Option.isNone(detail)) return;
      assert.deepEqual(
        detail.value.versions.map((version) => version.ref.version),
        [2, 1],
      );
      assert.deepEqual(
        detail.value.judgments.map((judgment) => judgment.judgment.ref.version),
        // Deterministic order: recorded sequence ties, so judgment id decides.
        [1, 2],
      );

      const missing = yield* repository.getSkill({
        projectId,
        skillId: ProjectSkillId.make("psk_nope0001"),
      });
      assert.equal(Option.isNone(missing), true);
    }));

  test("fails typed decode on a stored non-hex content hash for get and list", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedProject(projectId);
      // Length-64 but not hex: the stored hash must decode as Sha256Hex, not
      // pass through as a valid version ref.
      yield* seedCandidateRow({
        projectId,
        skillId,
        version: 1,
        contentSha256: "z".repeat(64),
      });
      const detail = yield* repository.getSkill({ projectId, skillId }).pipe(Effect.flip);
      assert.instanceOf(detail, PersistenceDecodeError);
      const listed = yield* repository.listSkills({ projectId, limit: 5 }).pipe(Effect.flip);
      assert.instanceOf(listed, PersistenceDecodeError);
    }));

  test("hides everything behind a raw projection delete instead of failing open", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedProject(projectId);
      yield* seedCandidateRow({ projectId, skillId, version: 1, contentSha256: SHA });
      yield* repository.insertJudgment({
        judgment: rightsJudgmentFor(projectId, skillId, 1, SHA),
      });
      // Withdraw once while the project is still live, then orphan the rows
      // behind a raw delete: the liveness-qualified diagnostics must report
      // not-found, never a leak of the orphan's already-withdrawn state.
      const firstWithdraw = yield* repository.withdrawJudgment({
        ref: { projectId, skillId, version: 1, contentSha256: SHA },
        judgmentId: ProjectSkillJudgmentId.make(`psj-${skillId}-1`),
        now: NOW,
      });
      assert.equal(firstWithdraw.status, "applied");
      yield* Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
      });

      const listed = yield* repository.listSkills({ projectId, limit: 5 });
      assert.deepEqual(listed, { items: [], truncated: false });
      const detail = yield* repository.getSkill({ projectId, skillId });
      assert.equal(Option.isNone(detail), true);
      const judged = yield* repository.insertJudgment({
        judgment: rightsJudgmentFor(projectId, skillId, 1, SHA),
      });
      assert.equal(judged.status, "project-missing");
      const withdrawn = yield* repository.withdrawJudgment({
        ref: { projectId, skillId, version: 1, contentSha256: SHA },
        judgmentId: ProjectSkillJudgmentId.make(`psj-${skillId}-1`),
        now: NOW,
      });
      assert.equal(withdrawn.status, "not-found");
      const deleted = yield* repository.deleteSkill({
        projectId,
        skillId,
        expectedLatestVersion: 1,
      });
      assert.equal(deleted.status, "not-found");
      const inserted = yield* insertCandidateFor(repository, {
        check: buildCheck(passingReceipt()),
      });
      assert.equal(inserted.status, "project-missing");
      // A revision write against the orphaned source is project-missing and
      // leaves the existing rows untouched.
      const revised = yield* repository.insertRevision({
        projectId,
        skillId,
        fromVersion: 1,
        expectedLatestVersion: 1,
        content: contentB,
        contentSha256: OTHER_SHA,
        now: NOW,
      });
      assert.equal(revised.status, "project-missing");
      assert.equal(yield* versionRowCounts, 1);
    }));

  test("deletes versions and judgments together, or neither", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedProject(projectId);
      yield* seedCandidateRow({ projectId, skillId, version: 1, contentSha256: SHA });
      yield* repository.insertJudgment({
        judgment: rightsJudgmentFor(projectId, skillId, 1, SHA),
      });

      const conflict = yield* repository.deleteSkill({
        projectId,
        skillId,
        expectedLatestVersion: 2,
      });
      assert.deepEqual(conflict, { status: "conflict", currentLatestVersion: 1 });
      assert.equal(yield* versionRowCounts, 1);
      const judgmentCount = () =>
        Effect.gen(function* () {
          const sql = yield* sqlClient;
          const rows = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS "n" FROM project_skill_judgments
          `;
          return rows[0]?.n ?? 0;
        });
      assert.equal(yield* judgmentCount(), 1);

      const applied = yield* repository.deleteSkill({
        projectId,
        skillId,
        expectedLatestVersion: 1,
      });
      assert.equal(applied.status, "applied");
      assert.equal(yield* versionRowCounts, 0);
      assert.equal(yield* judgmentCount(), 0);
    }));

  test("keeps deletes project-scoped: another project's skill is not-found and untouched", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedProject(projectId);
      yield* seedProject(otherProjectId);
      yield* seedCandidateRow({
        projectId: otherProjectId,
        skillId,
        version: 1,
        contentSha256: SHA,
      });
      yield* seedCandidateRow({
        projectId: otherProjectId,
        skillId,
        version: 2,
        contentSha256: OTHER_SHA,
      });
      yield* repository.insertJudgment({
        judgment: rightsJudgmentFor(otherProjectId, skillId, 2, OTHER_SHA),
      });

      // Project A asks to delete project B's skill with a stale expectation:
      // not-found — never a conflict leaking B's latest version — and no row
      // in either of B's tables moves.
      const outcome = yield* repository.deleteSkill({
        projectId,
        skillId,
        expectedLatestVersion: 1,
      });
      assert.equal(outcome.status, "not-found");
      assert.equal(yield* versionRowCounts, 2);
      const judgmentCount = yield* Effect.gen(function* () {
        const sql = yield* sqlClient;
        const rows = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS "n" FROM project_skill_judgments
        `;
        return rows[0]?.n ?? 0;
      });
      assert.equal(judgmentCount, 1);
    }));
});

function rightsJudgmentFor(
  targetProjectId: ProjectId,
  targetSkillId: ProjectSkillId,
  version: number,
  contentSha256: string,
): Parameters<ProjectSkillRepository["Service"]["insertJudgment"]>[0]["judgment"] {
  return {
    judgmentId: ProjectSkillJudgmentId.make(`psj-${targetSkillId}-${version}`),
    ref: { projectId: targetProjectId, skillId: targetSkillId, version, contentSha256 },
    kind: "rights",
    basis: "own-work",
    originalSource: null,
    license: null,
    recordedAt: NOW,
    recordedBy: "authenticated-client",
    note: "Authored from this repository's own sources.",
  };
}

function reviewJudgmentFor(
  targetProjectId: ProjectId,
  targetSkillId: ProjectSkillId,
  version: number,
  contentSha256: string,
): Parameters<ProjectSkillRepository["Service"]["insertJudgment"]>[0]["judgment"] {
  return {
    judgmentId: ProjectSkillJudgmentId.make(`psj-review-${targetSkillId}-${version}`),
    ref: { projectId: targetProjectId, skillId: targetSkillId, version, contentSha256 },
    kind: "review",
    provenanceChecked: true,
    privacyChecked: true,
    scopeChecked: true,
    recordedAt: NOW,
    recordedBy: "authenticated-client",
    note: "Provenance, privacy, and scope reviewed.",
  };
}

function reproductionJudgmentFor(
  ref: ProjectSkillVersionRef,
  observedEvidenceId: ProjectSkillEvidenceId,
): ProjectSkillEvidenceJudgment {
  return {
    judgmentId: ProjectSkillJudgmentId.make(`psj-repro-${ref.skillId}-v${ref.version}`),
    ref,
    kind: "reproduction",
    observedEvidenceId,
    procedureApplied: true,
    successConditionConfirmed: true,
    taskNotUsedForAuthoring: true,
    recordedAt: NOW,
    recordedBy: "authenticated-client",
    note: "Reproduced on an independent task with its own passing checks.",
  };
}

function nonApplicationJudgmentFor(
  ref: ProjectSkillVersionRef,
  observedEvidenceId: ProjectSkillEvidenceId,
): ProjectSkillEvidenceJudgment {
  return {
    judgmentId: ProjectSkillJudgmentId.make(`psj-nonapp-${ref.skillId}-v${ref.version}`),
    ref,
    kind: "non-application",
    observedEvidenceId,
    taskDescription: "A styling tweak where the procedure did not apply.",
    verdict: "correctly-not-applied",
    recordedAt: NOW,
    recordedBy: "authenticated-client",
    note: "The task did not call for the procedure.",
  };
}

// ---------------------------------------------------------------------------
// Lifecycle (061): evidence-backed judgments, activation, holds, and deletes.
// The fixtures below seed closed, provider-accepted, managed `use` windows
// across the real project_skill_inputs / project_skill_observed_uses rows and
// the canonical `thread.message-sent` event with its project-skill context
// record. They are controlled storage inputs, never evidence that a provider
// ran; production Trials writes remain a separate slice.
// ---------------------------------------------------------------------------

const ROUTE_SHA_A = "e".repeat(64);
const ROUTE_SHA_B = "f".repeat(64);
const BLOCK_SHA = "1".repeat(64);

const evidenceThreadA = ThreadId.make("thread-ev-a");
const evidenceThreadB = ThreadId.make("thread-ev-b");
const evidenceThreadC = ThreadId.make("thread-ev-c");
const evidenceThreadD = ThreadId.make("thread-ev-d");
const evidenceMessageA = MessageId.make("message-ev-a");
const evidenceMessageB = MessageId.make("message-ev-b");
const evidenceMessageC = MessageId.make("message-ev-c");
const evidenceMessageD = MessageId.make("message-ev-d");

const refV1: ProjectSkillVersionRef = { projectId, skillId, version: 1, contentSha256: SHA };
const refV2: ProjectSkillVersionRef = {
  projectId,
  skillId,
  version: 2,
  contentSha256: OTHER_SHA,
};

const EVIDENCE_V1 = ProjectSkillEvidenceId.make("pse-ev-v1");
const EVIDENCE_V2 = ProjectSkillEvidenceId.make("pse-ev-v2");
const EVIDENCE_FAILED_V2 = ProjectSkillEvidenceId.make("pse-ev-v2-failed");
const EVIDENCE_LEGACY = ProjectSkillEvidenceId.make("pse-ev-legacy");
const EVIDENCE_TRIAL = ProjectSkillEvidenceId.make("pse-ev-trial");
const EVIDENCE_OPEN = ProjectSkillEvidenceId.make("pse-ev-open");
const EVIDENCE_UNKNOWN = ProjectSkillEvidenceId.make("pse-ev-unknown");
const EVIDENCE_MISSING = ProjectSkillEvidenceId.make("pse-ev-missing");
const EVIDENCE_FROZEN = ProjectSkillEvidenceId.make("pse-ev-frozen");
const EVIDENCE_MALFORMED = ProjectSkillEvidenceId.make("pse-ev-malformed");

const evidenceCheck = (input: {
  readonly threadId: ThreadId;
  readonly attemptId: string;
  readonly receiptSequence: number;
  readonly outcome: "all-selected-passed" | "failed";
}): ProjectSkillCheckObservation => ({
  threadId: input.threadId,
  threadAnchorSequence: input.receiptSequence - 2,
  receiptSequence: input.receiptSequence,
  attemptId: input.attemptId,
  revision: 1,
  projectId,
  workspaceRoot: "/tmp/project",
  worktreePath: null,
  cwd: "/tmp/project",
  envSha256: SHA,
  planned: [{ scriptId: "lint", scriptName: "Lint", commandSha256: SHA, timeoutMs: 60_000 }],
  tree:
    input.outcome === "all-selected-passed"
      ? {
          treeOid: "c".repeat(40),
          repoTopLevel: "/tmp/project",
          repoCommonDir: "/tmp/project",
        }
      : null,
  environment: {
    environmentId: EnvironmentId.make("env-1"),
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.6.0",
    serverVersion: "1.0.0",
    nodeVersion: "22.11.0",
  },
  startedAt: "2026-08-20T12:00:00Z",
  endedAt: input.outcome === "all-selected-passed" ? "2026-08-20T12:00:30Z" : null,
  outcome: input.outcome,
});

// One closed managed evidence window for `ref`: the thread incarnation, the
// canonical accepted user message carrying the project-skill context record
// (stamped with the same admitted sequence the input row stores), the input
// ledger row, and the frozen check observation. `overrideObservedUse` seeds
// deliberately corrupted observation columns for the fail-closed cases.
const seedManagedUse = (input: {
  readonly ref: ProjectSkillVersionRef;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly incarnationSequence: number;
  readonly inputEventSequence: number;
  readonly admittedSkillStateSeq: number;
  readonly evidenceId: ProjectSkillEvidenceId;
  readonly check: ProjectSkillCheckObservation;
  readonly mode?: "use" | "trial";
  readonly managedRouteSha256?: string | undefined;
  readonly window?: "open" | "closed";
  readonly delivery?: "unknown" | "provider-accepted";
  readonly overrideObservedUse?: {
    readonly checkJson: string;
    readonly receiptSequence: number;
    readonly outcome: "all-selected-passed" | "failed";
    readonly endedAt: string | null;
  };
}) =>
  Effect.gen(function* () {
    const sql = yield* sqlClient;
    yield* seedEvent({
      sequence: input.incarnationSequence,
      threadId: input.threadId,
      eventType: "thread.created",
      payload: { threadId: input.threadId, projectId: input.ref.projectId },
    });
    yield* seedEvent({
      sequence: input.inputEventSequence,
      threadId: input.threadId,
      eventType: "thread.message-sent",
      payload: {
        threadId: input.threadId,
        messageId: input.messageId,
        role: "user",
        text: "use the skill",
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId: "ctx_skill",
              label: "Skill",
              kind: PROJECT_SKILL_CONTEXT_KIND,
              payload: {
                ref: input.ref,
                mode: input.mode ?? "use",
                admittedSkillStateSeq: input.admittedSkillStateSeq,
              },
            },
          ],
        },
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    const accepted = (input.delivery ?? "provider-accepted") === "provider-accepted";
    const closed = (input.window ?? "closed") === "closed";
    yield* sql`
      INSERT INTO project_skill_inputs (
        thread_id, message_id, project_id, skill_id, version, content_sha256,
        input_event_sequence, input_incarnation, admitted_skill_state_seq,
        provider_driver_kind, native_skill_inventory_sha256,
        delivery, delivery_at, window, window_closed_at, uncounted_attempts,
        attempt_token, claimed_at, tombstoned_at, managed_send_json
      )
      VALUES (
        ${input.threadId}, ${input.messageId}, ${input.ref.projectId},
        ${input.ref.skillId}, ${input.ref.version}, ${input.ref.contentSha256},
        ${input.inputEventSequence}, ${input.incarnationSequence}, ${input.admittedSkillStateSeq},
        ${accepted ? "claude-code" : null}, NULL,
        ${accepted ? "provider-accepted" : "unknown"},
        ${accepted ? NOW : null},
        ${closed ? "closed" : "open"}, ${closed ? NOW : null}, 0,
        ${`token-${input.messageId}`}, ${NOW}, NULL,
        ${
          input.managedRouteSha256 === undefined
            ? null
            : JSON.stringify({
                scope: "managed-procedure/v1",
                deliveredRef: input.ref,
                deliveredBlockSha256: BLOCK_SHA,
                providerInstanceId: "claude-personal",
                providerSessionId: "native-session-1",
                routeConfigSha256: input.managedRouteSha256,
              })
        }
      )
    `;
    const observed = input.overrideObservedUse ?? {
      checkJson: JSON.stringify(input.check),
      receiptSequence: input.check.receiptSequence,
      outcome: input.check.outcome,
      endedAt: input.check.endedAt,
    };
    yield* sql`
      INSERT INTO project_skill_observed_uses (
        evidence_id, thread_id, message_id, attempt_id, project_id, skill_id,
        version, content_sha256, check_json, receipt_sequence, outcome, ended_at, recorded_at
      )
      VALUES (
        ${input.evidenceId}, ${input.threadId}, ${input.messageId}, ${input.check.attemptId},
        ${input.ref.projectId}, ${input.ref.skillId}, ${input.ref.version},
        ${input.ref.contentSha256}, ${observed.checkJson},
        ${observed.receiptSequence}, ${observed.outcome}, ${observed.endedAt}, ${NOW}
      )
    `;
  });

const projectStateSeq = Effect.gen(function* () {
  const sql = yield* sqlClient;
  const rows = yield* sql<{ readonly seq: number }>`
    SELECT seq FROM project_skill_state WHERE project_id = ${projectId}
  `;
  return rows[0]?.seq ?? 0;
});

const activeVersionCount = Effect.gen(function* () {
  const sql = yield* sqlClient;
  const rows = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS "n" FROM project_skill_versions WHERE state = 'active'
  `;
  return rows[0]?.n ?? 0;
});

const orchestrationEventCount = Effect.gen(function* () {
  const sql = yield* sqlClient;
  const rows = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS "n" FROM orchestration_events
  `;
  return rows[0]?.n ?? 0;
});

const rawHoldsFor = (ref: ProjectSkillVersionRef) =>
  Effect.gen(function* () {
    const sql = yield* sqlClient;
    return yield* sql<{
      readonly holdId: string;
      readonly kind: string;
      readonly evidenceScope: string | null;
      readonly attemptId: string;
      readonly observedAtEventSequence: number;
      readonly holdJson: string;
    }>`
      SELECT hold_id AS "holdId", kind AS "kind", evidence_scope AS "evidenceScope",
        attempt_id AS "attemptId",
        observed_at_event_sequence AS "observedAtEventSequence", hold_json AS "holdJson"
      FROM project_skill_holds
      WHERE project_id = ${ref.projectId} AND skill_id = ${ref.skillId}
        AND version = ${ref.version} AND content_sha256 = ${ref.contentSha256}
      ORDER BY observed_at_event_sequence
    `;
  });

const lifecycleRowCounts = (targetSkillId: ProjectSkillId) =>
  Effect.gen(function* () {
    const sql = yield* sqlClient;
    const versions = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS "n" FROM project_skill_versions WHERE skill_id = ${targetSkillId}
    `;
    const judgments = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS "n" FROM project_skill_judgments WHERE skill_id = ${targetSkillId}
    `;
    const holds = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS "n" FROM project_skill_holds WHERE skill_id = ${targetSkillId}
    `;
    const observedUses = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS "n" FROM project_skill_observed_uses WHERE skill_id = ${targetSkillId}
    `;
    return {
      versions: versions[0]?.n ?? 0,
      judgments: judgments[0]?.n ?? 0,
      holds: holds[0]?.n ?? 0,
      observedUses: observedUses[0]?.n ?? 0,
    };
  });

// The environment a ref's first stored use establishes, computed with the real
// contract function so activation currents never drift from the fixtures.
const environmentOfFirstUse = (ref: ProjectSkillVersionRef) =>
  Effect.gen(function* () {
    const repository = yield* skillsRepository;
    const lifecycle = yield* repository.readLifecycle({ ref });
    const use = Option.isSome(lifecycle) ? lifecycle.value.observedUses[0] : undefined;
    const environment = use === undefined ? null : projectSkillEnvironmentOf(use);
    if (environment === null) throw new Error("fixture use must establish a managed environment");
    return environment;
  });

// The reusable ready-candidate world: v1 stored from the source world with
// rights and review recorded, plus one closed, provider-accepted, managed
// `use` window on an independent thread whose passed check is frozen in
// project_skill_observed_uses, and reproduction + non-application judgments
// naming that evidence. Ends at state sequence 4 with v1 still a candidate.
const readyV1World = Effect.gen(function* () {
  const repository = yield* skillsRepository;
  yield* seedSourceWorld(passingReceipt());
  const inserted = yield* insertCandidateFor(repository, { check: buildCheck(passingReceipt()) });
  assert.equal(inserted.status, "applied");
  yield* repository.insertJudgment({ judgment: rightsJudgmentFor(projectId, skillId, 1, SHA) });
  yield* repository.insertJudgment({ judgment: reviewJudgmentFor(projectId, skillId, 1, SHA) });
  const checkV1 = evidenceCheck({
    threadId: evidenceThreadA,
    attemptId: "attempt-ev-a",
    receiptSequence: 62,
    outcome: "all-selected-passed",
  });
  yield* seedManagedUse({
    ref: refV1,
    threadId: evidenceThreadA,
    messageId: evidenceMessageA,
    incarnationSequence: 60,
    inputEventSequence: 61,
    admittedSkillStateSeq: 0,
    evidenceId: EVIDENCE_V1,
    check: checkV1,
    managedRouteSha256: ROUTE_SHA_A,
  });
  const reproduced = yield* repository.insertEvidenceJudgment({
    judgment: reproductionJudgmentFor(refV1, EVIDENCE_V1),
  });
  assert.equal(reproduced.status, "applied");
  const nonApplied = yield* repository.insertEvidenceJudgment({
    judgment: nonApplicationJudgmentFor(refV1, EVIDENCE_V1),
  });
  assert.equal(nonApplied.status, "applied");
  return { repository, checkV1 };
});

// v2's revision, independent evidence, and full judgment set on top of
// readyV1World's v1; leaves v2 a candidate at state sequence 9 and returns
// the revision's watermark.
const readyV2Evidence = (repository: ProjectSkillRepository["Service"]) =>
  Effect.gen(function* () {
    const revised = yield* repository.insertRevision({
      projectId,
      skillId,
      fromVersion: 1,
      expectedLatestVersion: 1,
      content: contentB,
      contentSha256: OTHER_SHA,
      now: NOW,
    });
    assert.equal(revised.status, "applied");
    if (revised.status !== "applied") return;
    yield* seedManagedUse({
      ref: refV2,
      threadId: evidenceThreadB,
      messageId: evidenceMessageB,
      incarnationSequence: 70,
      inputEventSequence: 71,
      admittedSkillStateSeq: 5,
      evidenceId: EVIDENCE_V2,
      check: evidenceCheck({
        threadId: evidenceThreadB,
        attemptId: "attempt-ev-b",
        receiptSequence: 72,
        outcome: "all-selected-passed",
      }),
      managedRouteSha256: ROUTE_SHA_B,
    });
    for (const judgment of [
      rightsJudgmentFor(projectId, skillId, 2, OTHER_SHA),
      reviewJudgmentFor(projectId, skillId, 2, OTHER_SHA),
    ]) {
      const applied = yield* repository.insertJudgment({ judgment });
      assert.equal(applied.status, "applied");
    }
    for (const judgment of [
      reproductionJudgmentFor(refV2, EVIDENCE_V2),
      nonApplicationJudgmentFor(refV2, EVIDENCE_V2),
    ]) {
      const applied = yield* repository.insertEvidenceJudgment({ judgment });
      assert.equal(applied.status, "applied");
    }
    return revised.row.source.createdAfterEventSequence;
  });

describe("ProjectSkillRepository lifecycle", () => {
  test("reconstructs exact evidence, activates, switches (bumping 2), holds, restores, retires", () =>
    Effect.gen(function* () {
      const { repository, checkV1 } = yield* readyV1World;

      const before = yield* repository.readLifecycle({ ref: refV1 });
      assert.equal(Option.isSome(before), true);
      if (Option.isNone(before)) return;
      assert.equal(before.value.version.state, "candidate");
      assert.equal(before.value.version.createdAt, NOW);
      assert.equal(before.value.stateSeq, 4);
      assert.deepEqual(before.value.activeRefs, []);
      assert.deepEqual(before.value.holds, []);
      assert.deepEqual(before.value.judgments.map((judgment) => judgment.kind).sort(), [
        "non-application",
        "reproduction",
        "review",
        "rights",
      ]);
      expect(before.value.observedUses).toEqual([
        {
          evidenceId: EVIDENCE_V1,
          input: {
            threadId: evidenceThreadA,
            projectId,
            messageId: evidenceMessageA,
            inputEventSequence: 61,
            admittedSkillStateSeq: 0,
            providerDriverKind: "claude-code",
            nativeSkillInventorySha256: null,
            items: [{ ref: refV1, mode: "use" }],
            managedSend: {
              scope: "managed-procedure/v1",
              deliveredRef: refV1,
              deliveredBlockSha256: BLOCK_SHA,
              providerInstanceId: "claude-personal",
              providerSessionId: "native-session-1",
              routeConfigSha256: ROUTE_SHA_A,
            },
          },
          check: checkV1,
        },
      ]);

      assert.deepEqual(
        yield* repository.transitionState({
          ref: refV1,
          expectedStateSeq: 4,
          to: "active",
          current: yield* environmentOfFirstUse(refV1),
        }),
        { status: "applied", stateSeq: 5 },
      );
      const active1 = yield* repository.readLifecycle({ ref: refV1 });
      assert.equal(Option.isSome(active1), true);
      if (Option.isNone(active1)) return;
      assert.equal(active1.value.version.state, "active");
      assert.deepEqual(active1.value.activeRefs, [refV1]);

      // The revision measures its watermark after v1's evidence events.
      const watermark = yield* readyV2Evidence(repository);
      assert.equal(watermark, 61);

      // One switch: supersede v1, then activate v2 — two state writes, two
      // sequence bumps.
      assert.deepEqual(
        yield* repository.transitionState({
          ref: refV2,
          expectedStateSeq: 9,
          to: "active",
          current: yield* environmentOfFirstUse(refV2),
        }),
        { status: "applied", stateSeq: 11 },
      );
      const v1AfterSwitch = yield* repository.readLifecycle({ ref: refV1 });
      const v2AfterSwitch = yield* repository.readLifecycle({ ref: refV2 });
      assert.equal(Option.isSome(v1AfterSwitch) && Option.isSome(v2AfterSwitch), true);
      if (Option.isNone(v1AfterSwitch) || Option.isNone(v2AfterSwitch)) return;
      assert.deepEqual(
        [v1AfterSwitch.value.version.state, v1AfterSwitch.value.version.retiredReason],
        ["retired", "superseded"],
      );
      assert.equal(v2AfterSwitch.value.version.state, "active");
      assert.deepEqual(v2AfterSwitch.value.activeRefs, [refV2]);
      assert.equal(yield* activeVersionCount, 1);

      // A closed failed `use` window on v2 raises exactly one managed hold.
      yield* seedManagedUse({
        ref: refV2,
        threadId: evidenceThreadC,
        messageId: evidenceMessageC,
        incarnationSequence: 80,
        inputEventSequence: 81,
        admittedSkillStateSeq: 11,
        evidenceId: EVIDENCE_FAILED_V2,
        check: evidenceCheck({
          threadId: evidenceThreadC,
          attemptId: "attempt-ev-c",
          receiptSequence: 82,
          outcome: "failed",
        }),
        managedRouteSha256: ROUTE_SHA_B,
      });
      assert.deepEqual(yield* repository.sweepFailedUseHolds({ ref: refV2, now: NOW }), {
        inserted: 1,
      });
      assert.equal(yield* projectStateSeq, 12);
      const holdRows = yield* rawHoldsFor(refV2);
      assert.equal(holdRows.length, 1);
      assert.equal(holdRows[0]?.kind, "failure-observed");
      assert.equal(holdRows[0]?.evidenceScope, "managed-procedure/v1");
      assert.equal(holdRows[0]?.observedAtEventSequence, 82);
      const holdJson = JSON.parse(holdRows[0]?.holdJson ?? "null") as {
        kind: string;
        ref: unknown;
        environment: unknown;
        evidenceScope?: string;
        observedAtEventSequence: number;
      };
      assert.equal(holdJson.kind, "failure-observed");
      assert.deepEqual(holdJson.ref, refV2);
      assert.equal(holdJson.environment, null);
      assert.equal(holdJson.evidenceScope, "managed-procedure/v1");
      assert.equal(holdJson.observedAtEventSequence, 82);

      // Restoring the retired v1 is independently current-ready against its
      // own evidence, and the switch leaves v2's scoped hold untouched.
      assert.deepEqual(
        yield* repository.transitionState({
          ref: refV1,
          expectedStateSeq: 12,
          to: "active",
          current: yield* environmentOfFirstUse(refV1),
        }),
        { status: "applied", stateSeq: 14 },
      );
      assert.equal((yield* rawHoldsFor(refV2)).length, 1);
      const v1Restored = yield* repository.readLifecycle({ ref: refV1 });
      const v2Restored = yield* repository.readLifecycle({ ref: refV2 });
      assert.equal(Option.isSome(v1Restored) && Option.isSome(v2Restored), true);
      if (Option.isNone(v1Restored) || Option.isNone(v2Restored)) return;
      assert.equal(v1Restored.value.version.state, "active");
      assert.equal(v1Restored.value.holds.length, 0);
      assert.deepEqual(
        [v2Restored.value.version.state, v2Restored.value.version.retiredReason],
        ["retired", "superseded"],
      );

      assert.deepEqual(
        yield* repository.transitionState({ ref: refV1, expectedStateSeq: 14, to: "retired" }),
        { status: "applied", stateSeq: 15 },
      );
      assert.equal(yield* activeVersionCount, 0);
      assert.deepEqual(
        (yield* rawVersionRows).map((row) => [
          row.skillId,
          row.version,
          row.state,
          row.retiredReason,
        ]),
        [
          [skillId, 1, "retired", "user-retired"],
          [skillId, 2, "retired", "superseded"],
        ],
      );
    }));

  test("an unswept failed use vetoes its own restore; an independent restore succeeds", () =>
    Effect.gen(function* () {
      const { repository } = yield* readyV1World;
      assert.deepEqual(
        yield* repository.transitionState({
          ref: refV1,
          expectedStateSeq: 4,
          to: "active",
          current: yield* environmentOfFirstUse(refV1),
        }),
        { status: "applied", stateSeq: 5 },
      );
      yield* readyV2Evidence(repository);
      assert.deepEqual(
        yield* repository.transitionState({
          ref: refV2,
          expectedStateSeq: 9,
          to: "active",
          current: yield* environmentOfFirstUse(refV2),
        }),
        { status: "applied", stateSeq: 11 },
      );
      assert.deepEqual(
        yield* repository.transitionState({ ref: refV2, expectedStateSeq: 11, to: "retired" }),
        { status: "applied", stateSeq: 12 },
      );

      // A later closed failed `use` window on v2 is a standing block from the
      // moment it exists — before any sweep persists it.
      yield* seedManagedUse({
        ref: refV2,
        threadId: evidenceThreadC,
        messageId: evidenceMessageC,
        incarnationSequence: 80,
        inputEventSequence: 81,
        admittedSkillStateSeq: 11,
        evidenceId: EVIDENCE_FAILED_V2,
        check: evidenceCheck({
          threadId: evidenceThreadC,
          attemptId: "attempt-ev-c",
          receiptSequence: 82,
          outcome: "failed",
        }),
        managedRouteSha256: ROUTE_SHA_B,
      });
      const vetoed = yield* repository.transitionState({
        ref: refV2,
        expectedStateSeq: 12,
        to: "active",
        current: yield* environmentOfFirstUse(refV2),
      });
      assert.equal(vetoed.status, "not-ready");
      if (vetoed.status !== "not-ready") return;
      assert.deepEqual(vetoed.gaps, ["open-hold"]);
      // The refusal mutates nothing: no persisted hold, no sequence bump, no
      // state move.
      assert.equal((yield* rawHoldsFor(refV2)).length, 0);
      assert.equal(yield* projectStateSeq, 12);
      assert.deepEqual(
        (yield* rawVersionRows).map((row) => [row.version, row.state, row.retiredReason]),
        [
          [1, "retired", "superseded"],
          [2, "retired", "user-retired"],
        ],
      );

      // v2's failure is not a project-wide veto: independently ready v1
      // restores against its own evidence, and sweeping v2 afterwards
      // persists the same deterministic hold the refusal saw.
      assert.deepEqual(
        yield* repository.transitionState({
          ref: refV1,
          expectedStateSeq: 12,
          to: "active",
          current: yield* environmentOfFirstUse(refV1),
        }),
        { status: "applied", stateSeq: 13 },
      );
      assert.deepEqual(yield* repository.sweepFailedUseHolds({ ref: refV2, now: NOW }), {
        inserted: 1,
      });
      assert.equal((yield* rawHoldsFor(refV2)).length, 1);
      assert.equal(yield* activeVersionCount, 1);
    }));

  test("drifted current refuses despite full history; withdrawal bumps seq, stale seq conflicts", () =>
    Effect.gen(function* () {
      const { repository } = yield* readyV1World;
      const drifted: ProjectSkillEnvironment = {
        ...(yield* environmentOfFirstUse(refV1)),
        routeConfigSha256: ROUTE_SHA_B,
      };

      const refused = yield* repository.transitionState({
        ref: refV1,
        expectedStateSeq: 4,
        to: "active",
        current: drifted,
      });
      assert.equal(refused.status, "not-ready");
      if (refused.status !== "not-ready") return;
      assert.deepEqual(refused.gaps, ["environment-changed"]);
      assert.equal(yield* projectStateSeq, 4);
      assert.equal((yield* rawVersionRows)[0]?.state, "candidate");

      const withdrawn = yield* repository.withdrawJudgment({
        ref: refV1,
        judgmentId: ProjectSkillJudgmentId.make(`psj-review-${skillId}-1`),
        now: NOW,
      });
      assert.equal(withdrawn.status, "applied");
      assert.equal(yield* projectStateSeq, 5);

      assert.deepEqual(
        yield* repository.transitionState({
          ref: refV1,
          expectedStateSeq: 4,
          to: "active",
          current: yield* environmentOfFirstUse(refV1),
        }),
        { status: "state-changed", currentStateSeq: 5 },
      );

      const afterWithdrawal = yield* repository.transitionState({
        ref: refV1,
        expectedStateSeq: 5,
        to: "active",
        current: yield* environmentOfFirstUse(refV1),
      });
      assert.equal(afterWithdrawal.status, "not-ready");
      if (afterWithdrawal.status !== "not-ready") return;
      assert.deepEqual(afterWithdrawal.gaps, ["review-missing"]);

      const rightsGone = yield* repository.withdrawJudgment({
        ref: refV1,
        judgmentId: ProjectSkillJudgmentId.make(`psj-${skillId}-1`),
        now: NOW,
      });
      assert.equal(rightsGone.status, "applied");
      const last = yield* repository.transitionState({
        ref: refV1,
        expectedStateSeq: 6,
        to: "active",
        current: yield* environmentOfFirstUse(refV1),
      });
      assert.equal(last.status, "not-ready");
      if (last.status !== "not-ready") return;
      assert.deepEqual(last.gaps, ["rights-unreviewed", "review-missing"]);
      assert.equal(yield* projectStateSeq, 6);
      assert.equal(yield* activeVersionCount, 0);
    }));

  test("failed-use sweep writes managed and legacy scoped holds with null environment, idempotently", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedProject(projectId);
      yield* seedCandidateRow({ projectId, skillId, version: 1, contentSha256: SHA });
      const failedCheck = (threadId: ThreadId, attemptId: string, receiptSequence: number) =>
        evidenceCheck({ threadId, attemptId, receiptSequence, outcome: "failed" });

      // Managed and legacy failed `use` windows are holdable; a `trial` mode
      // failure and an open window are stored facts but never holds.
      yield* seedManagedUse({
        ref: refV1,
        threadId: evidenceThreadA,
        messageId: evidenceMessageA,
        incarnationSequence: 60,
        inputEventSequence: 61,
        admittedSkillStateSeq: 0,
        evidenceId: EVIDENCE_V1,
        check: failedCheck(evidenceThreadA, "attempt-ev-a", 62),
        managedRouteSha256: ROUTE_SHA_A,
      });
      yield* seedManagedUse({
        ref: refV1,
        threadId: evidenceThreadB,
        messageId: evidenceMessageB,
        incarnationSequence: 70,
        inputEventSequence: 71,
        admittedSkillStateSeq: 0,
        evidenceId: EVIDENCE_LEGACY,
        check: failedCheck(evidenceThreadB, "attempt-ev-b", 72),
      });
      yield* seedManagedUse({
        ref: refV1,
        threadId: evidenceThreadC,
        messageId: evidenceMessageC,
        incarnationSequence: 80,
        inputEventSequence: 81,
        admittedSkillStateSeq: 0,
        evidenceId: EVIDENCE_TRIAL,
        check: failedCheck(evidenceThreadC, "attempt-ev-c", 82),
        mode: "trial",
        managedRouteSha256: ROUTE_SHA_A,
      });
      yield* seedManagedUse({
        ref: refV1,
        threadId: evidenceThreadD,
        messageId: evidenceMessageD,
        incarnationSequence: 90,
        inputEventSequence: 91,
        admittedSkillStateSeq: 0,
        evidenceId: EVIDENCE_OPEN,
        check: failedCheck(evidenceThreadD, "attempt-ev-d", 92),
        window: "open",
      });

      assert.deepEqual(yield* repository.sweepFailedUseHolds({ ref: refV1, now: NOW }), {
        inserted: 2,
      });
      const rows = yield* rawHoldsFor(refV1);
      assert.equal(rows.length, 2);
      // The scope names the evidence the row actually carries; the hold's
      // environment is null either way.
      assert.equal(rows[0]?.evidenceScope, "managed-procedure/v1");
      assert.equal(rows[0]?.attemptId, "attempt-ev-a");
      assert.equal(rows[1]?.evidenceScope, null);
      assert.equal(rows[1]?.attemptId, "attempt-ev-b");
      for (const row of rows) {
        const holdJson = JSON.parse(row.holdJson) as {
          kind: string;
          environment: unknown;
          observedAtEventSequence: number;
        };
        assert.equal(holdJson.kind, "failure-observed");
        assert.equal(holdJson.environment, null);
        assert.equal(row.observedAtEventSequence, holdJson.observedAtEventSequence);
      }

      assert.deepEqual(yield* repository.sweepFailedUseHolds({ ref: refV1, now: NOW }), {
        inserted: 0,
      });
      assert.equal((yield* rawHoldsFor(refV1)).length, 2);
      assert.equal(yield* projectStateSeq, 2);
    }));

  test("concurrent transitions on the same expected sequence admit one state-changed loser", () =>
    Effect.gen(function* () {
      const { repository } = yield* readyV1World;
      const current = yield* environmentOfFirstUse(refV1);
      const transition = () =>
        repository.transitionState({ ref: refV1, expectedStateSeq: 4, to: "active", current });
      // Both fibers race for the client's transaction lock: exactly one
      // guarded activate lands, the loser re-reads the moved sequence.
      const outcomes = yield* Effect.all([transition(), transition()], { concurrency: 2 });
      assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [
        "applied",
        "state-changed",
      ]);
      const loser = outcomes.find((outcome) => outcome.status === "state-changed");
      if (loser?.status !== "state-changed") return;
      assert.equal(loser.currentStateSeq, 5);
      assert.equal(yield* projectStateSeq, 5);
      assert.equal(yield* activeVersionCount, 1);
    }));

  test("an unrelated active skill is never retired: activation refuses as not-ready", () =>
    Effect.gen(function* () {
      const { repository } = yield* readyV1World;
      yield* seedCandidateRow({
        projectId,
        skillId: otherSkillId,
        version: 1,
        contentSha256: OTHER_SHA,
      });
      yield* Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`UPDATE project_skill_versions SET state = 'active' WHERE skill_id = ${otherSkillId}`;
      });
      // The unrelated skill's candidate -> active write bumped the sequence.
      assert.equal(yield* projectStateSeq, 5);

      // The other skill is active in this project, so the intended post-switch
      // active set needs its interference clearance first: the pure predicate
      // refuses before any row moves and the unrelated skill stays active.
      const refused = yield* repository.transitionState({
        ref: refV1,
        expectedStateSeq: 5,
        to: "active",
        current: yield* environmentOfFirstUse(refV1),
      });
      assert.equal(refused.status, "not-ready");
      if (refused.status !== "not-ready") return;
      assert.deepEqual(refused.gaps, ["interference-missing"]);
      assert.equal(yield* projectStateSeq, 5);
      const rows = yield* rawVersionRows;
      assert.equal(rows.find((row) => row.skillId === otherSkillId)?.state, "active");
      assert.equal(rows.find((row) => row.skillId === skillId)?.state, "candidate");
    }));

  test("a forced activation failure after the old retirement rolls back the old state and sequence", () =>
    Effect.gen(function* () {
      const { repository } = yield* readyV1World;
      assert.deepEqual(
        yield* repository.transitionState({
          ref: refV1,
          expectedStateSeq: 4,
          to: "active",
          current: yield* environmentOfFirstUse(refV1),
        }),
        { status: "applied", stateSeq: 5 },
      );
      yield* readyV2Evidence(repository);
      yield* Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`
          CREATE TRIGGER fail_target_activation
          BEFORE UPDATE ON project_skill_versions
          FOR EACH ROW
          WHEN NEW.state = 'active' AND OLD.state <> 'active' AND NEW.version = 2
          BEGIN
            SELECT RAISE(ABORT, 'forced target activation failure');
          END
        `;
      });

      const failure = yield* repository
        .transitionState({
          ref: refV2,
          expectedStateSeq: 9,
          to: "active",
          current: yield* environmentOfFirstUse(refV2),
        })
        .pipe(Effect.flip);
      assert.instanceOf(failure, PersistenceSqlError);

      // The supersede landed only inside the failed transaction: the rollback
      // restores v1's active state and the sequence it ran under.
      const rows = yield* rawVersionRows;
      assert.equal(rows.find((row) => row.version === 1)?.state, "active");
      assert.equal(rows.find((row) => row.version === 1)?.retiredReason, null);
      assert.equal(rows.find((row) => row.version === 2)?.state, "candidate");
      assert.equal(yield* projectStateSeq, 9);
    }));

  test("evidence judgments refuse wrong ref, open window, unknown delivery; corrupted rows fail closed; no late capture", () =>
    Effect.gen(function* () {
      const repository = yield* skillsRepository;
      yield* seedSourceWorld(passingReceipt());
      const inserted = yield* insertCandidateFor(repository, {
        check: buildCheck(passingReceipt()),
      });
      assert.equal(inserted.status, "applied");
      yield* repository.insertJudgment({ judgment: rightsJudgmentFor(projectId, skillId, 1, SHA) });
      yield* repository.insertJudgment({ judgment: reviewJudgmentFor(projectId, skillId, 1, SHA) });
      yield* seedManagedUse({
        ref: refV1,
        threadId: evidenceThreadA,
        messageId: evidenceMessageA,
        incarnationSequence: 60,
        inputEventSequence: 61,
        admittedSkillStateSeq: 0,
        evidenceId: EVIDENCE_V1,
        check: evidenceCheck({
          threadId: evidenceThreadA,
          attemptId: "attempt-ev-a",
          receiptSequence: 62,
          outcome: "all-selected-passed",
        }),
        managedRouteSha256: ROUTE_SHA_A,
      });
      yield* seedManagedUse({
        ref: refV1,
        threadId: evidenceThreadB,
        messageId: evidenceMessageB,
        incarnationSequence: 70,
        inputEventSequence: 71,
        admittedSkillStateSeq: 0,
        evidenceId: EVIDENCE_OPEN,
        check: evidenceCheck({
          threadId: evidenceThreadB,
          attemptId: "attempt-ev-b",
          receiptSequence: 72,
          outcome: "failed",
        }),
        window: "open",
      });
      yield* seedManagedUse({
        ref: refV1,
        threadId: evidenceThreadC,
        messageId: evidenceMessageC,
        incarnationSequence: 80,
        inputEventSequence: 81,
        admittedSkillStateSeq: 0,
        evidenceId: EVIDENCE_UNKNOWN,
        check: evidenceCheck({
          threadId: evidenceThreadC,
          attemptId: "attempt-ev-c",
          receiptSequence: 82,
          outcome: "failed",
        }),
        delivery: "unknown",
      });

      // Only the closed, provider-accepted window is evidence.
      const clean = yield* repository.readLifecycle({ ref: refV1 });
      assert.equal(Option.isSome(clean), true);
      if (Option.isNone(clean)) return;
      assert.deepEqual(
        clean.value.observedUses.map((use) => use.evidenceId),
        [EVIDENCE_V1],
      );

      // The guard is closure + acceptance + existence on the exact ref.
      const open = yield* repository.insertEvidenceJudgment({
        judgment: reproductionJudgmentFor(refV1, EVIDENCE_OPEN),
      });
      assert.equal(open.status, "evidence-mismatch");
      const unknown = yield* repository.insertEvidenceJudgment({
        judgment: nonApplicationJudgmentFor(refV1, EVIDENCE_UNKNOWN),
      });
      assert.equal(unknown.status, "evidence-mismatch");
      const missing = yield* repository.insertEvidenceJudgment({
        judgment: reproductionJudgmentFor(refV1, EVIDENCE_MISSING),
      });
      assert.equal(missing.status, "evidence-mismatch");
      const wrongRef = yield* repository.insertEvidenceJudgment({
        judgment: reproductionJudgmentFor(refV2, EVIDENCE_V1),
      });
      assert.equal(wrongRef.status, "ref-mismatch");
      assert.equal(yield* projectStateSeq, 2);
      const judgmentRows = yield* Effect.gen(function* () {
        const sql = yield* sqlClient;
        return yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS "n" FROM project_skill_judgments
        `;
      });
      assert.equal(judgmentRows[0]?.n, 2);

      // No late capture: the 060 settle trigger refuses a label after delivery.
      const lateLabel = yield* Effect.exit(
        Effect.gen(function* () {
          const sql = yield* sqlClient;
          yield* sql`
            UPDATE project_skill_inputs SET managed_send_json = ${JSON.stringify({
              scope: "managed-procedure/v1",
              deliveredRef: refV1,
              deliveredBlockSha256: BLOCK_SHA,
              providerInstanceId: "claude-personal",
              providerSessionId: "native-session-1",
              routeConfigSha256: ROUTE_SHA_A,
            })}
            WHERE thread_id = ${evidenceThreadA} AND message_id = ${evidenceMessageA}
          `;
        }),
      );
      assert.ok(Exit.isFailure(lateLabel));

      // A frozen observation whose receipt column disagrees with the stored
      // check fails closed on the read and the sweep instead of becoming
      // evidence. observed uses are append-only, so the drift is seeded.
      yield* seedManagedUse({
        ref: refV1,
        threadId: evidenceThreadD,
        messageId: evidenceMessageD,
        incarnationSequence: 90,
        inputEventSequence: 91,
        admittedSkillStateSeq: 0,
        evidenceId: EVIDENCE_FROZEN,
        check: evidenceCheck({
          threadId: evidenceThreadD,
          attemptId: "attempt-ev-d",
          receiptSequence: 92,
          outcome: "failed",
        }),
        overrideObservedUse: {
          checkJson: JSON.stringify(
            evidenceCheck({
              threadId: evidenceThreadD,
              attemptId: "attempt-ev-d",
              receiptSequence: 92,
              outcome: "failed",
            }),
          ),
          receiptSequence: 999,
          outcome: "failed",
          endedAt: null,
        },
      });
      const corruptedRead = yield* repository.readLifecycle({ ref: refV1 }).pipe(Effect.flip);
      assert.instanceOf(corruptedRead, PersistenceDecodeError);
      const corruptedSweep = yield* repository
        .sweepFailedUseHolds({ ref: refV1, now: NOW })
        .pipe(Effect.flip);
      assert.instanceOf(corruptedSweep, PersistenceDecodeError);

      yield* Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`DELETE FROM project_skill_observed_uses WHERE evidence_id = ${EVIDENCE_FROZEN}`;
      });
      const recovered = yield* repository.readLifecycle({ ref: refV1 });
      assert.equal(Option.isSome(recovered), true);
      if (Option.isNone(recovered)) return;
      assert.deepEqual(
        recovered.value.observedUses.map((use) => use.evidenceId),
        [EVIDENCE_V1],
      );

      // A malformed stored check is the same typed integrity failure.
      yield* Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`
          INSERT INTO project_skill_observed_uses (
            evidence_id, thread_id, message_id, attempt_id, project_id, skill_id,
            version, content_sha256, check_json, receipt_sequence, outcome, ended_at, recorded_at
          )
          VALUES (
            ${EVIDENCE_MALFORMED}, ${evidenceThreadD}, ${evidenceMessageD}, 'attempt-ev-d2',
            ${projectId}, ${skillId}, 1, ${SHA}, '{"broken": true}', 0, 'failed', NULL, ${NOW}
          )
        `;
      });
      const malformedRead = yield* repository.readLifecycle({ ref: refV1 }).pipe(Effect.flip);
      assert.instanceOf(malformedRead, PersistenceDecodeError);
    }));

  test("deleting the skill purges holds and evidence, keeps payload-free input ownership", () =>
    Effect.gen(function* () {
      const { repository } = yield* readyV1World;
      assert.deepEqual(
        yield* repository.transitionState({
          ref: refV1,
          expectedStateSeq: 4,
          to: "active",
          current: yield* environmentOfFirstUse(refV1),
        }),
        { status: "applied", stateSeq: 5 },
      );
      yield* readyV2Evidence(repository);
      assert.deepEqual(
        yield* repository.transitionState({
          ref: refV2,
          expectedStateSeq: 9,
          to: "active",
          current: yield* environmentOfFirstUse(refV2),
        }),
        { status: "applied", stateSeq: 11 },
      );
      yield* seedManagedUse({
        ref: refV2,
        threadId: evidenceThreadC,
        messageId: evidenceMessageC,
        incarnationSequence: 80,
        inputEventSequence: 81,
        admittedSkillStateSeq: 11,
        evidenceId: EVIDENCE_FAILED_V2,
        check: evidenceCheck({
          threadId: evidenceThreadC,
          attemptId: "attempt-ev-c",
          receiptSequence: 82,
          outcome: "failed",
        }),
        managedRouteSha256: ROUTE_SHA_B,
      });
      assert.deepEqual(yield* repository.sweepFailedUseHolds({ ref: refV2, now: NOW }), {
        inserted: 1,
      });

      // An unrelated skill keeps its own rows through this delete.
      yield* seedCandidateRow({
        projectId,
        skillId: otherSkillId,
        version: 1,
        contentSha256: OTHER_SHA,
      });
      yield* repository.insertJudgment({
        judgment: rightsJudgmentFor(projectId, otherSkillId, 1, OTHER_SHA),
      });
      const eventsBefore = yield* orchestrationEventCount;

      assert.deepEqual(
        yield* repository.deleteSkill({ projectId, skillId, expectedLatestVersion: 3 }),
        { status: "conflict", currentLatestVersion: 2 },
      );
      assert.equal(yield* versionRowCounts, 3);
      assert.deepEqual(yield* lifecycleRowCounts(skillId), {
        versions: 2,
        judgments: 8,
        holds: 1,
        observedUses: 3,
      });

      assert.equal(
        (yield* repository.deleteSkill({ projectId, skillId, expectedLatestVersion: 2 })).status,
        "applied",
      );
      assert.equal(yield* versionRowCounts, 1);
      assert.deepEqual(yield* lifecycleRowCounts(skillId), {
        versions: 0,
        judgments: 0,
        holds: 0,
        observedUses: 0,
      });
      assert.deepEqual(yield* lifecycleRowCounts(otherSkillId), {
        versions: 1,
        judgments: 1,
        holds: 0,
        observedUses: 0,
      });
      assert.equal(yield* orchestrationEventCount, eventsBefore);
      const projections = yield* Effect.gen(function* () {
        const sql = yield* sqlClient;
        const projects = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS "n" FROM projection_projects
        `;
        const threads = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS "n" FROM projection_threads
        `;
        return { projects: projects[0]?.n ?? 0, threads: threads[0]?.n ?? 0 };
      });
      assert.deepEqual(projections, { projects: 1, threads: 1 });

      // The input rows survive as payload-free delivery tombstones: the
      // ownership token and accepted delivery stay so a replayed message can
      // never claim a second provider call.
      const inputRows = yield* Effect.gen(function* () {
        const sql = yield* sqlClient;
        return yield* sql<{
          readonly messageId: string;
          readonly skillId: string | null;
          readonly version: number | null;
          readonly contentSha256: string | null;
          readonly admittedSkillStateSeq: number | null;
          readonly managedSendJson: string | null;
          readonly tombstonedAt: string | null;
          readonly attemptToken: string;
          readonly delivery: string;
          readonly providerDriverKind: string | null;
        }>`
          SELECT message_id AS "messageId", skill_id AS "skillId", version AS "version",
            content_sha256 AS "contentSha256",
            admitted_skill_state_seq AS "admittedSkillStateSeq",
            managed_send_json AS "managedSendJson", tombstoned_at AS "tombstonedAt",
            attempt_token AS "attemptToken", delivery AS "delivery",
            provider_driver_kind AS "providerDriverKind"
          FROM project_skill_inputs
          ORDER BY message_id
        `;
      });
      assert.equal(inputRows.length, 3);
      for (const row of inputRows) {
        assert.equal(row.skillId, null);
        assert.equal(row.version, null);
        assert.equal(row.contentSha256, null);
        assert.equal(row.admittedSkillStateSeq, null);
        assert.equal(row.managedSendJson, null);
        assert.ok(row.tombstonedAt !== null);
        assert.equal(row.delivery, "provider-accepted");
        assert.equal(row.providerDriverKind, "claude-code");
        assert.ok(row.attemptToken.startsWith("token-"));
      }

      // The real project tombstone takes the same cascade the whole way:
      // the 058 trigger deletes versions and judgments, and the version-delete
      // triggers purge the ref's holds, evidence, and input payload with them.
      yield* Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`
          INSERT INTO project_skill_holds (
            hold_id, project_id, skill_id, version, content_sha256, kind,
            evidence_scope, thread_id, message_id, attempt_id,
            observed_at_event_sequence, hold_json, created_at
          )
          VALUES (
            'psh-tombstone-probe', ${projectId}, ${otherSkillId}, 1, ${OTHER_SHA},
            'failure-observed', NULL, ${threadId}, 'message-tombstone', 'attempt-tombstone',
            20, '{"kind":"failure-observed"}', ${NOW}
          )
        `;
      });
      yield* Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = ${projectId}`;
      });
      assert.deepEqual(yield* lifecycleRowCounts(otherSkillId), {
        versions: 0,
        judgments: 0,
        holds: 0,
        observedUses: 0,
      });
      assert.equal(yield* versionRowCounts, 0);
    }));
});

const useWorkAssessor = Effect.gen(function* () {
  return yield* ProjectSkillUseWorkAssessor;
}).pipe(Effect.provide(useWorkAssessorLayer));

const withSkillsAndAssessor = <A, E, R>(effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
  withSkillsDatabase(effect.pipe(Effect.provide(useWorkAssessorLayer)));

describe("ProjectSkillUseWorkAssessor.assessUseWork", () => {
  test("rejects calls outside the caller SQL transaction", () =>
    withSkillsAndAssessor(
      Effect.gen(function* () {
        yield* readyV1World;
        const assessor = yield* useWorkAssessor;
        const current = yield* environmentOfFirstUse(refV1);
        const failure = yield* Effect.flip(
          assessor.assessUseWork({
            ref: refV1,
            expectedStateSeq: 4,
            current,
          }),
        );
        assert.instanceOf(failure, PersistenceSqlError);
        assert.equal(failure.detail, "outside-transaction");
      }),
    ));

  test("assesses use readiness inside the same SqlClient transaction", () =>
    withSkillsAndAssessor(
      Effect.gen(function* () {
        const { repository } = yield* readyV1World;
        const assessor = yield* useWorkAssessor;
        const sql = yield* sqlClient;
        const current = yield* environmentOfFirstUse(refV1);
        assert.deepEqual(
          yield* repository.transitionState({
            ref: refV1,
            expectedStateSeq: 4,
            to: "active",
            current,
          }),
          { status: "applied", stateSeq: 5 },
        );
        const notReady = yield* sql.withTransaction(
          assessor.assessUseWork({
            ref: refV1,
            expectedStateSeq: 4,
            current,
          }),
        );
        assert.deepEqual(notReady, { status: "state-changed", currentStateSeq: 5 });
        const ready = yield* sql.withTransaction(
          assessor.assessUseWork({
            ref: refV1,
            expectedStateSeq: 5,
            current,
          }),
        );
        assert.deepEqual(ready, { status: "ready" });
      }),
    ));
});

// ---- Derived review drafts ------------------------------------------------
// The controlled source world a derived draft stands on: both incarnations,
// one user request with its turn start, the completed assistant turn, the
// check attempt's two receipt writes, and the accepted task-result record —
// strictly ordered request < assistant message < check anchor < receipt <
// acceptance. Direct SQL seeds are controlled inputs for the storage policy,
// never evidence that a server ran work or accepted a send.
const PROJECT_CREATED_SEQUENCE = 1;
const REQUEST_SEQUENCE = 6;
const TURN_START_SEQUENCE = 7;
const ASSISTANT_SEQUENCE = 14;
const TASK_RESULT_SEQUENCE = 35;
const LATER_SEQUENCE = 60;
const requestMessageId = MessageId.make("msg-request");
const assistantMessageId = MessageId.make("msg-assistant");
const sourceTurnId = TurnId.make("turn-1");
const REQUEST_BODY = "Cut a release of the web app.";
const PROCEDURE = "1. Install dependencies.\n2. Run the release script.\n3. Tag the commit.";
const ASSISTANT_BODY = `Release is done.\n\n## Procedure\n${PROCEDURE}\n\n## Summary\nAll checks passed.`;

const acceptedRecord = (overrides: Partial<TaskResultRecord> = {}): TaskResultRecord => ({
  schemaVersion: 1,
  threadId,
  revision: 1,
  threadIncarnation: THREAD_CREATED_SEQUENCE,
  requirements: {
    version: 1,
    items: [{ id: "item-1", text: "Release checks pass.", scriptIds: ["lint", "test"] }],
    checks: [
      { scriptId: "lint", commandSha256: SHA },
      { scriptId: "test", commandSha256: OTHER_SHA },
    ],
    setAt: NOW,
  },
  acceptance: {
    requirementsVersion: 1,
    checkAttemptId: "attempt-1",
    checkReceiptSequence: RECEIPT_SEQUENCE,
    acceptedAt: NOW,
  },
  ...overrides,
});

const taskResultEvent = (sequence: number, record: TaskResultRecord): SeedEvent => ({
  sequence,
  eventType: "thread.activity-appended",
  commandId: "server:task-result:seed",
  payload: {
    threadId,
    activity: {
      id: `task-result:${threadId}`,
      tone: "info",
      kind: "task-result",
      summary: "Task result accepted",
      payload: record,
      turnId: null,
      createdAt: NOW,
    },
  },
});

const seedDraftWorld = (
  options: {
    readonly record?: TaskResultRecord | null;
    readonly extraEvents?: ReadonlyArray<SeedEvent>;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* sqlClient;
    yield* seedSourceWorld(passingReceipt(), [
      {
        sequence: REQUEST_SEQUENCE,
        eventType: "thread.message-sent",
        payload: {
          threadId,
          messageId: requestMessageId,
          role: "user",
          text: REQUEST_BODY,
          turnId: null,
          streaming: false,
        },
      },
      {
        sequence: TURN_START_SEQUENCE,
        eventType: "thread.turn-start-requested",
        payload: { threadId, messageId: requestMessageId },
      },
      ...(options.extraEvents ?? []),
      {
        sequence: ASSISTANT_SEQUENCE,
        eventType: "thread.message-sent",
        payload: {
          threadId,
          messageId: assistantMessageId,
          role: "assistant",
          text: "",
          turnId: sourceTurnId,
          streaming: false,
        },
      },
      ...(options.record === null
        ? []
        : [taskResultEvent(TASK_RESULT_SEQUENCE, options.record ?? acceptedRecord())]),
    ]);
    yield* seedEvent({
      sequence: PROJECT_CREATED_SEQUENCE,
      aggregateKind: "project",
      eventType: "project.created",
      payload: { projectId },
    });
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      VALUES
        (${requestMessageId}, ${threadId}, NULL, 'user', ${REQUEST_BODY}, 0, ${NOW}, ${NOW}),
        (${assistantMessageId}, ${threadId}, ${sourceTurnId}, 'assistant', ${ASSISTANT_BODY}, 0, ${NOW}, ${NOW})
    `;
    yield* sql`
      INSERT INTO projection_turns (
        thread_id, turn_id, pending_message_id, assistant_message_id, state,
        requested_at, started_at, completed_at, checkpoint_files_json
      )
      VALUES (
        ${threadId}, ${sourceTurnId}, ${requestMessageId}, ${assistantMessageId},
        'completed', ${NOW}, ${NOW}, ${NOW}, '[]'
      )
    `;
  });

// The service's measured selected-check view: the stored record plus the
// current tree, environment, and context all matching.
const measuredChecks = (
  receipt: SelectedCheckReceipt = passingReceipt(),
): SelectedChecksGetResult => ({
  capability: { available: true, reason: null },
  record: { kind: "present", receipt, sequence: RECEIPT_SEQUENCE },
  changedScriptIds: [],
  admission: { state: "open" },
  treeUnchanged: true,
  environmentMatches: true,
  contextMatches: true,
});

const canonicalContentSha = (content: ProjectSkillContent): string =>
  NodeCrypto.createHash("sha256")
    .update(canonicalProjectSkillContentJson(content), "utf8")
    .digest("hex");

const deriveFor = (
  repository: ProjectSkillRepository["Service"],
  measured: SelectedChecksGetResult = measuredChecks(),
) =>
  repository.deriveDraft({
    projectId,
    check: buildCheck(passingReceipt()),
    measured,
  });

const deriveAvailable = (repository: ProjectSkillRepository["Service"]) =>
  Effect.gen(function* () {
    const result = yield* deriveFor(repository);
    if (result.status !== "available") {
      return yield* Effect.die(`expected an available draft, got ${result.reason}`);
    }
    return result;
  });

type AvailableDraft = Effect.Success<ReturnType<typeof deriveAvailable>>;

const reviewed = (
  draft: AvailableDraft,
  overrides: Partial<ProjectSkillContent> = {},
): ProjectSkillContent => ({
  ...draft.partial,
  doesNotApplyWhen: "The user asks for a hotfix outside the pipeline.",
  ...overrides,
});

const insertDerived = (
  repository: ProjectSkillRepository["Service"],
  draft: AvailableDraft,
  content: ProjectSkillContent,
  options: {
    readonly skillId?: ProjectSkillId;
    readonly pin?: string;
    readonly measured?: SelectedChecksGetResult | undefined;
    readonly contentSha256?: string;
  } = {},
) =>
  repository.insertCandidate({
    skillId: options.skillId ?? skillId,
    projectId,
    content,
    contentSha256: options.contentSha256 ?? canonicalContentSha(content),
    check: buildCheck(passingReceipt()),
    draft: {
      type: "derived",
      messageId: assistantMessageId,
      expectedSourceIdentitySha256: options.pin ?? draft.source.wholeSourceSha256,
    },
    ...("measured" in options
      ? options.measured === undefined
        ? {}
        : { measured: options.measured }
      : { measured: measuredChecks() }),
    now: NOW,
  });

const storedSourceJson = Effect.gen(function* () {
  const sql = yield* sqlClient;
  const rows = yield* sql<{ readonly sourceJson: string }>`
    SELECT source_json AS "sourceJson" FROM project_skill_versions ORDER BY skill_id
  `;
  return rows.map((row) => JSON.parse(row.sourceJson) as { readonly draft: unknown });
});

describe("ProjectSkillRepository derived review drafts", () => {
  test("derives the bounded seed from the accepted completed source turn", () =>
    Effect.gen(function* () {
      yield* seedDraftWorld();
      const repository = yield* skillsRepository;

      const draft = yield* deriveAvailable(repository);
      assert.deepEqual(draft.partial, {
        title: "Thread",
        purpose: REQUEST_BODY,
        appliesWhen: "Release checks pass.",
        procedure: PROCEDURE,
        successCheck: "Required checks pass: lint, test.",
      });
      assert.deepEqual(draft.truncation, {});
      const source = draft.source;
      assert.equal(source.projectIncarnationSequence, PROJECT_CREATED_SEQUENCE);
      assert.equal(source.threadIncarnationSequence, THREAD_CREATED_SEQUENCE);
      assert.equal(source.turnId, sourceTurnId);
      assert.equal(source.requestMessageId, requestMessageId);
      assert.equal(source.assistantMessageId, assistantMessageId);
      assert.equal(source.taskResultRecordSequence, TASK_RESULT_SEQUENCE);
      assert.equal(source.taskResultRecordRevision, 1);
      assert.equal(source.requirementsVersion, 1);
      // The acceptance names no revision: the accepted attempt's revision is
      // the current matching receipt's, bound through the receipt sequence.
      assert.deepEqual(source.acceptedCheck, {
        attemptId: "attempt-1",
        revision: 2,
        receiptSequence: RECEIPT_SEQUENCE,
      });
      assert.deepEqual(source.currentCheck, source.acceptedCheck);
      assert.equal(
        source.assistantBodySha256,
        NodeCrypto.createHash("sha256").update(ASSISTANT_BODY, "utf8").digest("hex"),
      );
      assert.equal(
        source.extractedProcedureSha256,
        NodeCrypto.createHash("sha256").update(PROCEDURE, "utf8").digest("hex"),
      );
      // Deriving is read-only.
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("derives and saves the accepted turn after mid-turn approval responses", () =>
    Effect.gen(function* () {
      yield* seedDraftWorld({
        extraEvents: [8, 9, 10].map((sequence) => ({
          sequence,
          eventType: "thread.approval-response-requested",
          payload: { threadId },
        })),
      });
      const repository = yield* skillsRepository;
      const draft = yield* deriveAvailable(repository);
      assert.equal(draft.source.requestMessageId, requestMessageId);
      assert.equal((yield* insertDerived(repository, draft, reviewed(draft))).status, "applied");
    }));

  test("refuses an approval after the assistant even before the check", () =>
    Effect.gen(function* () {
      yield* seedDraftWorld({
        extraEvents: [
          {
            sequence: 18,
            eventType: "thread.approval-response-requested",
            payload: { threadId },
          },
        ],
      });
      const repository = yield* skillsRepository;
      assert.deepEqual(yield* deriveFor(repository), {
        status: "unavailable",
        reason: "no-coherent-source",
      });
    }));

  test("refuses a newer request without its own completed turn", () =>
    Effect.gen(function* () {
      const laterMessageId = MessageId.make("msg-follow");
      yield* seedDraftWorld({
        extraEvents: [
          {
            sequence: 12,
            eventType: "thread.message-sent",
            payload: { threadId, messageId: laterMessageId, role: "user" },
          },
          {
            sequence: 13,
            eventType: "thread.turn-start-requested",
            payload: { threadId, messageId: laterMessageId },
          },
        ],
      });
      const repository = yield* skillsRepository;
      assert.deepEqual(yield* deriveFor(repository), {
        status: "unavailable",
        reason: "no-coherent-source",
      });
    }));

  test("refuses a post-check approval under the unchanged broad input guard", () =>
    Effect.gen(function* () {
      yield* seedDraftWorld({
        extraEvents: [
          {
            sequence: 22,
            eventType: "thread.approval-response-requested",
            payload: { threadId },
          },
        ],
      });
      const repository = yield* skillsRepository;
      assert.deepEqual(yield* deriveFor(repository), {
        status: "unavailable",
        reason: "no-coherent-source",
      });
    }));

  test("a measurement that no longer matches leaves no coherent source", () =>
    Effect.gen(function* () {
      yield* seedDraftWorld();
      const repository = yield* skillsRepository;
      assert.deepEqual(
        yield* deriveFor(repository, { ...measuredChecks(), treeUnchanged: false }),
        { status: "unavailable", reason: "no-coherent-source" },
      );
      assert.deepEqual(
        yield* deriveFor(repository, { ...measuredChecks(), contextMatches: null }),
        { status: "unavailable", reason: "no-coherent-source" },
      );
    }));

  test("stores the server-resolved identity and records the added exclusion as an edit of the seed", () =>
    Effect.gen(function* () {
      yield* seedDraftWorld();
      const repository = yield* skillsRepository;
      const draft = yield* deriveAvailable(repository);

      // Seeded fields unchanged, only the exclusion the seed omits added: the
      // seed is incomplete, so completing it is still an edit.
      const exclusionOnly = yield* insertDerived(repository, draft, reviewed(draft));
      assert.equal(exclusionOnly.status, "applied");
      const fieldEdited = yield* insertDerived(
        repository,
        draft,
        reviewed(draft, { successCheck: "The release test script exits 0." }),
        { skillId: otherSkillId },
      );
      assert.equal(fieldEdited.status, "applied");

      const stored = yield* storedSourceJson;
      assert.deepEqual(
        stored.map((source) => source.draft),
        [
          {
            type: "derived",
            messageId: assistantMessageId,
            sourceIdentity: draft.source,
            edited: true,
          },
          {
            type: "derived",
            messageId: assistantMessageId,
            sourceIdentity: draft.source,
            edited: true,
          },
        ],
      );
      // The stored derived source decodes back through the repository's reads.
      const read = yield* repository.getSkill({ projectId, skillId });
      assert.isTrue(Option.isSome(read));
    }));

  const staleSources: ReadonlyArray<
    readonly [name: string, mutate: Effect.Effect<unknown, unknown, SqlClient.SqlClient>]
  > = [
    [
      "the assistant message body changes",
      Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`
          UPDATE projection_thread_messages SET text = text || '\n4. Extra step.'
          WHERE message_id = ${assistantMessageId}
        `;
      }),
    ],
    [
      "the assistant message role changes",
      Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`
          UPDATE projection_thread_messages SET role = 'user'
          WHERE message_id = ${assistantMessageId}
        `;
      }),
    ],
    [
      "the assistant message moves to another turn",
      Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`
          UPDATE projection_thread_messages SET turn_id = 'turn-2'
          WHERE message_id = ${assistantMessageId}
        `;
      }),
    ],
    [
      "the user request body changes",
      Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`
          UPDATE projection_thread_messages SET text = 'A different request.'
          WHERE message_id = ${requestMessageId}
        `;
      }),
    ],
    [
      "the source turn names another request",
      Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`
          UPDATE projection_turns SET pending_message_id = 'msg-other'
          WHERE turn_id = ${sourceTurnId}
        `;
      }),
    ],
    [
      "the source turn is running again",
      Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`UPDATE projection_turns SET state = 'running' WHERE turn_id = ${sourceTurnId}`;
      }),
    ],
    [
      "the thread is renamed",
      Effect.gen(function* () {
        const sql = yield* sqlClient;
        yield* sql`UPDATE projection_threads SET title = 'Renamed' WHERE thread_id = ${threadId}`;
      }),
    ],
    [
      "the acceptance is withdrawn",
      seedEvent(taskResultEvent(LATER_SEQUENCE, acceptedRecord({ revision: 2, acceptance: null }))),
    ],
    [
      "the current task-result record is rewritten",
      seedEvent(taskResultEvent(LATER_SEQUENCE, acceptedRecord({ revision: 2 }))),
    ],
    [
      "the requirements change",
      seedEvent(
        taskResultEvent(
          LATER_SEQUENCE,
          acceptedRecord({
            revision: 2,
            acceptance: null,
            requirements: {
              version: 2,
              items: [{ id: "item-1", text: "Release is tagged.", scriptIds: ["lint", "test"] }],
              checks: [
                { scriptId: "lint", commandSha256: SHA },
                { scriptId: "test", commandSha256: OTHER_SHA },
              ],
              setAt: NOW,
            },
          }),
        ),
      ),
    ],
    [
      "the thread is recreated",
      seedEvent({
        sequence: LATER_SEQUENCE,
        eventType: "thread.created",
        payload: { threadId, projectId },
      }),
    ],
    [
      "a user input arrives",
      seedEvent({
        sequence: LATER_SEQUENCE,
        eventType: "thread.message-sent",
        payload: { threadId, messageId: "msg-late", role: "user" },
      }),
    ],
    [
      "the project is deleted and recreated",
      Effect.andThen(
        seedEvent({
          sequence: LATER_SEQUENCE,
          aggregateKind: "project",
          eventType: "project.deleted",
          payload: { projectId },
        }),
        seedEvent({
          sequence: LATER_SEQUENCE + 1,
          aggregateKind: "project",
          eventType: "project.created",
          payload: { projectId },
        }),
      ),
    ],
  ];
  for (const [name, mutate] of staleSources) {
    test(`a pinned preview is refused before insertion when ${name}`, () =>
      Effect.gen(function* () {
        yield* seedDraftWorld();
        const repository = yield* skillsRepository;
        const draft = yield* deriveAvailable(repository);
        yield* mutate;
        const outcome = yield* insertDerived(repository, draft, reviewed(draft));
        assert.equal(outcome.status, "source-changed");
        assert.equal(yield* versionRowCounts, 0);
      }));
  }

  test("a crafted equality hash or a missing measurement never admits a direct insert", () =>
    Effect.gen(function* () {
      yield* seedDraftWorld();
      const repository = yield* skillsRepository;
      const draft = yield* deriveAvailable(repository);

      const crafted = yield* insertDerived(repository, draft, reviewed(draft), {
        pin: "0".repeat(64),
      });
      assert.equal(crafted.status, "source-changed");
      const unmeasured = yield* insertDerived(repository, draft, reviewed(draft), {
        measured: undefined,
      });
      assert.equal(unmeasured.status, "source-changed");
      const staleMeasurement = yield* insertDerived(repository, draft, reviewed(draft), {
        measured: { ...measuredChecks(), environmentMatches: false },
      });
      assert.equal(staleMeasurement.status, "source-changed");
      // The duplicate guard keys on the canonical content hash, so a caller
      // cannot dodge it with another hash for the same content.
      const exit = yield* Effect.exit(
        insertDerived(repository, draft, reviewed(draft), { contentSha256: OTHER_SHA }),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("the accepted source is not the draft message of a derived save unless it is the assistant message", () =>
    Effect.gen(function* () {
      yield* seedDraftWorld();
      const repository = yield* skillsRepository;
      const draft = yield* deriveAvailable(repository);
      const content = reviewed(draft);
      const outcome = yield* repository.insertCandidate({
        skillId,
        projectId,
        content,
        contentSha256: canonicalContentSha(content),
        check: buildCheck(passingReceipt()),
        draft: {
          type: "derived",
          messageId: requestMessageId,
          expectedSourceIdentitySha256: draft.source.wholeSourceSha256,
        },
        measured: measuredChecks(),
        now: NOW,
      });
      assert.equal(outcome.status, "draft-message-invalid");
      assert.equal(yield* versionRowCounts, 0);
    }));

  test("the same final content from the same source is one row, whichever fields were edited", () =>
    Effect.gen(function* () {
      yield* seedDraftWorld();
      const repository = yield* skillsRepository;
      const draft = yield* deriveAvailable(repository);
      const exclusionOnly = reviewed(draft);
      const titleEdited = reviewed(draft, { title: "Release the web app twice" });

      assert.equal((yield* insertDerived(repository, draft, exclusionOnly)).status, "applied");
      assert.deepEqual(
        yield* insertDerived(repository, draft, exclusionOnly, { skillId: otherSkillId }),
        { status: "duplicate-content", existingVersion: 1 },
      );
      assert.equal(yield* versionRowCounts, 1);

      assert.equal(
        (yield* insertDerived(repository, draft, titleEdited, { skillId: otherSkillId })).status,
        "applied",
      );
      assert.equal(
        (yield* insertDerived(repository, draft, titleEdited, {
          skillId: ProjectSkillId.make("psk_ijkl9012"),
        })).status,
        "duplicate-content",
      );
      assert.equal(yield* versionRowCounts, 2);

      // A different user-written exclusion is different final content.
      const distinct = reviewed(draft, { doesNotApplyWhen: "The release is already tagged." });
      assert.equal(
        (yield* insertDerived(repository, draft, distinct, {
          skillId: ProjectSkillId.make("psk_mnop3456"),
        })).status,
        "applied",
      );
      assert.equal(yield* versionRowCounts, 3);
    }));

  test("the same reviewed content from changed accepted evidence is a distinct source, not a duplicate", () =>
    Effect.gen(function* () {
      yield* seedDraftWorld();
      const repository = yield* skillsRepository;
      const first = yield* deriveAvailable(repository);
      const content = reviewed(first);

      assert.equal((yield* insertDerived(repository, first, content)).status, "applied");
      assert.deepEqual(
        yield* insertDerived(repository, first, content, { skillId: otherSkillId }),
        { status: "duplicate-content", existingVersion: 1 },
      );
      assert.equal(yield* versionRowCounts, 1);

      // The acceptance is withdrawn and the user accepts the same attempt
      // again: authentic task-result writes, a new current record, while the
      // assistant message and the reviewed content stay identical.
      yield* seedEvent(
        taskResultEvent(LATER_SEQUENCE, acceptedRecord({ revision: 2, acceptance: null })),
      );
      yield* seedEvent(taskResultEvent(LATER_SEQUENCE + 1, acceptedRecord({ revision: 3 })));

      const reaccepted = yield* deriveAvailable(repository);
      assert.equal(reaccepted.source.assistantMessageId, first.source.assistantMessageId);
      assert.deepEqual(reaccepted.partial, first.partial);
      assert.equal(reaccepted.source.taskResultRecordSequence, LATER_SEQUENCE + 1);
      assert.equal(reaccepted.source.taskResultRecordRevision, 3);
      assert.notEqual(reaccepted.source.wholeSourceSha256, first.source.wholeSourceSha256);

      // The earlier preview's pin names the replaced evidence and is refused.
      const stale = yield* insertDerived(repository, first, content, {
        skillId: ProjectSkillId.make("psk_qrst7890"),
      });
      assert.equal(stale.status, "source-changed");
      assert.equal(yield* versionRowCounts, 1);

      // The new source saves the same final content as its own candidate, and
      // a repeat of that exact source is the duplicate again.
      assert.equal(
        (yield* insertDerived(repository, reaccepted, content, { skillId: otherSkillId })).status,
        "applied",
      );
      assert.equal(yield* versionRowCounts, 2);
      assert.deepEqual(
        yield* insertDerived(repository, reaccepted, content, {
          skillId: ProjectSkillId.make("psk_uvwx1234"),
        }),
        { status: "duplicate-content", existingVersion: 1 },
      );
      assert.equal(yield* versionRowCounts, 2);
    }));

  test("simultaneous identical derived saves insert exactly one row", () =>
    Effect.gen(function* () {
      yield* seedDraftWorld();
      const repository = yield* skillsRepository;
      const draft = yield* deriveAvailable(repository);
      const content = reviewed(draft);

      const outcomes = yield* Effect.all(
        [
          insertDerived(repository, draft, content, { skillId }),
          insertDerived(repository, draft, content, { skillId: otherSkillId }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [
        "applied",
        "duplicate-content",
      ]);
      assert.equal(yield* versionRowCounts, 1);
    }));

  test("typed saves are never deduplicated", () =>
    Effect.gen(function* () {
      yield* seedDraftWorld();
      const repository = yield* skillsRepository;
      const check = buildCheck(passingReceipt());
      assert.equal((yield* insertCandidateFor(repository, { check })).status, "applied");
      assert.equal(
        (yield* insertCandidateFor(repository, { check, skillId: otherSkillId })).status,
        "applied",
      );
      assert.equal(yield* versionRowCounts, 2);
    }));
});
