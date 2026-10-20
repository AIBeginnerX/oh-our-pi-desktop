// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
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
  ProjectSkillHoldId,
  ProjectSkillId,
  ProjectSkillJudgmentId,
  ProviderInstanceId,
  ThreadId,
  evaluateSkillSource,
  projectSkillEnvironmentOf,
} from "@t3tools/contracts";
import type {
  ProjectSkillCheckObservation,
  ProjectSkillContent,
  ProjectSkillEnvironment,
  ProjectSkillManagedSendEvidence,
  SelectedCheckReceipt,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";
import { runMigrations } from "./Migrations.ts";
import {
  type ClaimProjectSkillTrialDeliveryInput,
  type ClaimProjectSkillUseDeliveryInput,
  ProjectSkillTrialRepository,
  type ProjectSkillTrialSweepResult,
  layer as trialLayer,
  make as makeProjectSkillTrialRepository,
} from "./ProjectSkillTrials.ts";

const NOW = "2026-10-12T00:00:00.000Z";
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const THREAD_CREATED_SEQUENCE = 5;
const INPUT_SEQUENCE = 20;

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const skillId = ProjectSkillId.make("psk_abcd1234");
const messageId = MessageId.make("message-1");

const ref = { projectId, skillId, version: 1, contentSha256: SHA };

function withTrialsDatabase<A, E, R>(
  effect: Effect.Effect<A, E, R | ProjectSkillTrialRepository | SqlClient.SqlClient>,
) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-skill-trials-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return Effect.andThen(runMigrations(), effect).pipe(
    Effect.provide(
      trialLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath }))),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
}

const test = (
  name: string,
  run: () => Effect.Effect<unknown, unknown, ProjectSkillTrialRepository | SqlClient.SqlClient>,
) => it.effect(name, () => withTrialsDatabase(run()));

const repository = Effect.gen(function* () {
  return yield* ProjectSkillTrialRepository;
}).pipe(Effect.provide(trialLayer));

const sqlClient = Effect.gen(function* () {
  return yield* SqlClient.SqlClient;
});

// A client whose statements pass through untouched until a fault is armed.
// The armed cause fails exactly the immutable-project SELECT of
// `claimProjectForSettlement` — a plain read that never opens a transaction —
// so the fault lands at the repository's own read, not at `withTransaction`.
const withClaimProjectSelectFault = (
  client: SqlClient.SqlClient,
  fault: { cause: Cause.Cause<unknown> | undefined },
): SqlClient.SqlClient =>
  new Proxy(client, {
    apply: (target, thisArg, args: ReadonlyArray<unknown>) => {
      const strings = args[0];
      return fault.cause !== undefined &&
        Array.isArray(strings) &&
        strings.join("?").includes('SELECT project_id AS "projectId"\n')
        ? Effect.failCause(fault.cause)
        : Reflect.apply(target as never, thisArg, args);
    },
  });

const seedProject = () =>
  Effect.gen(function* () {
    const sql = yield* sqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES (${projectId}, 'Project', '/tmp/project', '[]', ${NOW}, ${NOW}, NULL)
    `;
  });

const seedThread = () =>
  Effect.gen(function* () {
    const sql = yield* sqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at
      )
      VALUES (${threadId}, ${projectId}, 'Thread', '{}', 'full-access', 'default', ${NOW}, ${NOW}, NULL)
    `;
  });

const seedVersion = (contentSha256: string = SHA) =>
  Effect.gen(function* () {
    const sql = yield* sqlClient;
    yield* sql`
      INSERT INTO project_skill_versions (
        skill_id, project_id, version, content_json, content_sha256,
        source_json, source_thread_id, source_receipt_sequence,
        source_thread_created_sequence, created_after_event_sequence, created_at
      )
      VALUES (
        ${skillId}, ${projectId}, 1, '{"title":"t"}', ${contentSha256},
        '{"type":"work"}', ${threadId}, 2, ${THREAD_CREATED_SEQUENCE}, 10, ${NOW}
      )
    `;
  });

interface SeedEvent {
  readonly sequence: number;
  readonly eventType: string;
  readonly payload: unknown;
  readonly commandId?: string | undefined;
  readonly payloadJson?: string;
  readonly threadId?: ThreadId;
}

const seedEvent = (event: SeedEvent) =>
  Effect.gen(function* () {
    const sql = yield* sqlClient;
    const streamId = event.threadId ?? threadId;
    yield* sql`
      INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      )
      VALUES (
        ${event.sequence}, ${`event-${event.sequence}`}, 'thread',
        ${streamId}, ${event.sequence}, ${event.eventType}, ${NOW},
        ${event.commandId ?? null}, NULL, NULL, 'server',
        ${event.payloadJson ?? JSON.stringify(event.payload)}, '{}'
      )
    `;
  });

const messageSentPayload = (
  id: MessageId,
  role: "user" | "assistant",
  streamThreadId: ThreadId = threadId,
) => ({
  threadId: streamThreadId,
  messageId: id,
  role,
  text: "try the candidate",
  streaming: false,
  createdAt: NOW,
  updatedAt: NOW,
});

// The trial world: one thread incarnation, the canonical accepted user
// message, and its paired turn request. Direct SQL seeds are controlled
// inputs for the storage policy — they are never evidence a provider ran.
const seedTrialWorld = (extraEvents: ReadonlyArray<SeedEvent> = []) =>
  Effect.gen(function* () {
    yield* seedProject();
    yield* seedThread();
    yield* seedVersion();
    yield* seedEvent({
      sequence: THREAD_CREATED_SEQUENCE,
      eventType: "thread.created",
      payload: { threadId, projectId },
    });
    yield* seedEvent({
      sequence: INPUT_SEQUENCE,
      eventType: "thread.message-sent",
      payload: messageSentPayload(messageId, "user"),
    });
    yield* seedEvent({
      sequence: 21,
      eventType: "thread.turn-start-requested",
      payload: { threadId, messageId, createdAt: NOW },
    });
    for (const extra of extraEvents) yield* seedEvent(extra);
  });

const passingReceipt = (overrides?: {
  readonly threadId?: ThreadId;
  readonly attemptId?: string;
  readonly revision?: number;
  readonly threadAnchorSequence?: number;
}): SelectedCheckReceipt => ({
  schemaVersion: 1,
  threadId: overrides?.threadId ?? threadId,
  attemptId: overrides?.attemptId ?? "attempt-1",
  revision: overrides?.revision ?? 1,
  threadAnchorSequence: overrides?.threadAnchorSequence ?? 30,
  context: {
    projectId,
    workspaceRoot: "/tmp/project",
    worktreePath: null,
    cwd: "/tmp/project",
    shell: "/bin/zsh",
    envSha256: SHA,
  },
  planned: [{ scriptId: "lint", scriptName: "Lint", commandSha256: SHA, timeoutMs: 60_000 }],
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
  ],
  startedAt: "2026-08-20T12:00:00Z",
  endedAt: "2026-08-20T12:00:30Z",
  error: null,
});

const failedReceipt = (overrides?: {
  readonly threadId?: ThreadId;
  readonly attemptId?: string;
  readonly revision?: number;
  readonly threadAnchorSequence?: number;
}): SelectedCheckReceipt => ({
  ...passingReceipt(overrides),
  checks: [
    {
      ...passingReceipt().checks[0]!,
      status: "failed",
      exitCode: 2,
      group: "killed",
    },
  ],
  endedAt: null,
});

const receiptEvent = (sequence: number, receipt: SelectedCheckReceipt): SeedEvent => ({
  sequence,
  eventType: "thread.activity-appended",
  commandId: `server:selected-checks:seed-${sequence}`,
  threadId: receipt.threadId,
  payload: {
    threadId: receipt.threadId,
    activity: {
      id: `selected-check-receipt:${receipt.threadId}`,
      tone: receipt.checks.some((check) => check.status === "failed") ? "error" : "info",
      kind: "selected-check-receipt",
      summary: "Selected checks finished",
      payload: receipt,
      turnId: null,
      createdAt: NOW,
    },
  },
});

const claimInput = (overrides?: Partial<ClaimProjectSkillTrialDeliveryInput>) => ({
  threadId,
  messageId,
  projectId,
  ref,
  inputEventSequence: INPUT_SEQUENCE,
  admittedSkillStateSeq: 0,
  now: NOW,
  ...overrides,
});

const settle = (repositoryService: ProjectSkillTrialRepository["Service"], attemptToken: string) =>
  repositoryService.settleDelivery({
    threadId,
    messageId,
    projectId,
    attemptToken,
    providerDriverKind: "claude-code",
    now: NOW,
  });

const sweep = (
  repositoryService: ProjectSkillTrialRepository["Service"],
  sweepRef: typeof ref = ref,
): Effect.Effect<ProjectSkillTrialSweepResult, unknown> =>
  repositoryService.sweepTrials({ projectId, ref: sweepRef, now: NOW });

const seedPrematureApprovalClosure = (
  repo: ProjectSkillTrialRepository["Service"],
  extras: ReadonlyArray<SeedEvent>,
  bindOriginalTurn = true,
) =>
  Effect.gen(function* () {
    yield* seedTrialWorld([
      ...(bindOriginalTurn
        ? [
            {
              sequence: 22,
              eventType: "thread.session-set",
              payload: { threadId, session: { status: "running", activeTurnId: "turn-1" } },
            },
          ]
        : []),
      {
        sequence: 25,
        eventType: "thread.activity-appended",
        payload: {
          threadId,
          activity: {
            id: "approval-activity",
            kind: "approval.requested",
            payload: { requestId: "approval-1" },
            turnId: "turn-1",
            createdAt: NOW,
          },
        },
      },
      {
        sequence: 26,
        eventType: "thread.approval-response-requested",
        payload: { threadId, requestId: "approval-1" },
      },
      ...extras,
    ]);
    const sql = yield* sqlClient;
    yield* sql`
      INSERT INTO projection_turns (
        thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
      )
      VALUES (${threadId}, 'turn-1', ${messageId}, 'completed', ${NOW}, '[]')
    `;
    const claim = yield* repo.claimDelivery(claimInput());
    if (claim.status !== "entered") return assert.fail("expected the claim to enter");
    yield* settle(repo, claim.attemptToken);
    const closedAt = "2026-10-12T01:00:00.000Z";
    yield* sql`
      UPDATE project_skill_inputs SET window = 'closed', window_closed_at = ${closedAt}
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
    `;
    return closedAt;
  });

const inputRowCount = Effect.gen(function* () {
  const sql = yield* sqlClient;
  const rows = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS "n" FROM project_skill_inputs
  `;
  return rows[0]?.n ?? 0;
});

const rawInputRows = Effect.gen(function* () {
  const sql = yield* sqlClient;
  return yield* sql<{
    readonly threadId: string;
    readonly messageId: string;
    readonly skillId: string | null;
    readonly inputEventSequence: number;
    readonly inputIncarnation: number;
    readonly delivery: string;
    readonly providerDriverKind: string | null;
    readonly inventory: string | null;
    readonly window: string;
    readonly uncountedAttempts: number;
    readonly attemptToken: string;
    readonly managedSendJson: string | null;
  }>`
    SELECT thread_id AS "threadId", message_id AS "messageId", skill_id AS "skillId",
      input_event_sequence AS "inputEventSequence", input_incarnation AS "inputIncarnation",
      delivery AS "delivery", provider_driver_kind AS "providerDriverKind",
      native_skill_inventory_sha256 AS "inventory",
      window AS "window", uncounted_attempts AS "uncountedAttempts",
      attempt_token AS "attemptToken", managed_send_json AS "managedSendJson"
    FROM project_skill_inputs
    ORDER BY message_id
  `;
});

const observationRows = Effect.gen(function* () {
  const sql = yield* sqlClient;
  return yield* sql<{
    readonly evidenceId: string;
    readonly attemptId: string;
    readonly receiptSequence: number;
    readonly outcome: string;
    readonly endedAt: string | null;
  }>`
    SELECT evidence_id AS "evidenceId", attempt_id AS "attemptId",
      receipt_sequence AS "receiptSequence", outcome AS "outcome", ended_at AS "endedAt"
    FROM project_skill_observed_uses
    ORDER BY receipt_sequence
  `;
});

describe("ProjectSkillTrialRepository.claimDelivery", () => {
  test("claims the canonical accepted user message and records its incarnation", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();

      const outcome = yield* repo.claimDelivery(claimInput());
      assert.equal(outcome.status, "entered");
      if (outcome.status !== "entered") return;
      assert.equal(outcome.attemptToken.length > 0, true);

      const rows = yield* rawInputRows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.threadId, threadId);
      assert.equal(rows[0]?.messageId, messageId);
      assert.equal(rows[0]?.skillId, skillId);
      // The binding is the canonical message event and its incarnation.
      assert.equal(rows[0]?.inputEventSequence, INPUT_SEQUENCE);
      assert.equal(rows[0]?.inputIncarnation, THREAD_CREATED_SEQUENCE);
      assert.equal(rows[0]?.delivery, "unknown");
      assert.equal(rows[0]?.providerDriverKind, null);
      // Native inventory is the truthful null, never an empty digest.
      assert.equal(rows[0]?.inventory, null);
      assert.equal(rows[0]?.window, "open");
    }));

  test("refuses a claim whose sequence is not the committed user message event", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      // Sequence 21 is the paired turn request, never an acceptance record.
      yield* seedTrialWorld([
        {
          sequence: 40,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("assistant-1"), "assistant"),
        },
      ]);

      const turnRequest = yield* repo.claimDelivery(claimInput({ inputEventSequence: 21 }));
      assert.deepEqual(turnRequest, { status: "input-event-missing" });

      const assistant = yield* repo.claimDelivery(claimInput({ inputEventSequence: 40 }));
      assert.deepEqual(assistant, { status: "input-event-missing" });

      const forged = yield* repo.claimDelivery(claimInput({ inputEventSequence: 999 }));
      assert.deepEqual(forged, { status: "input-event-missing" });
      assert.equal(yield* inputRowCount, 0);
    }));

  test("a committed claim with a lost commit receipt never re-enters delivery", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const sql = yield* sqlClient;
      yield* seedTrialWorld();

      let claimCalls = 0;
      const original = sql.withTransaction;
      const boundaryFault = new PersistenceSqlError({
        operation: "ProjectSkillTrialRepository.claimDelivery",
        detail: "transaction-failed",
      });
      Object.assign(sql, {
        withTransaction: (work: Effect.Effect<unknown, unknown, never>) => {
          claimCalls += 1;
          if (claimCalls === 1) {
            return original(work).pipe(Effect.andThen(Effect.fail(boundaryFault)));
          }
          return original(work);
        },
      });
      const lost = yield* Effect.flip(
        repo
          .claimDelivery(claimInput())
          .pipe(
            Effect.ensuring(Effect.sync(() => Object.assign(sql, { withTransaction: original }))),
          ),
      );
      assert.ok(lost instanceof PersistenceSqlError);
      assert.equal(lost.detail, "transaction-failed");
      assert.equal(yield* inputRowCount, 1);
      assert.deepEqual(
        (yield* rawInputRows).map((row) => row.delivery),
        ["unknown"],
      );
      assert.deepEqual(yield* repo.claimDelivery(claimInput()), { status: "no-resend" });
    }));

  test("answers a fixed state-free no-resend for existing unknown and accepted claims", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();

      const first = yield* repo.claimDelivery(claimInput());
      assert.equal(first.status, "entered");
      if (first.status !== "entered") return;

      // The lost-commit-receipt shape: the row exists as unknown, a replay
      // must never enter again and must not learn any state.
      assert.deepEqual(yield* repo.claimDelivery(claimInput()), { status: "no-resend" });

      const settled = yield* settle(repo, first.attemptToken);
      assert.equal(settled.status, "applied");
      assert.deepEqual(yield* repo.claimDelivery(claimInput()), { status: "no-resend" });
      assert.equal(yield* inputRowCount, 1);
    }));

  test("settlement is bound to the claimed token, and a wrong settler is not-owned", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected the claim to enter");

      const notOwned = yield* settle(repo, "not-the-claimants-token");
      assert.equal(notOwned.status, "not-owned");
      assert.deepEqual(
        (yield* rawInputRows).map((row) => row.delivery),
        ["unknown"],
      );

      const emptyDriver = yield* Effect.flip(
        repo.settleDelivery({
          threadId,
          messageId,
          projectId,
          attemptToken: claim.attemptToken,
          providerDriverKind: "  ",
          now: NOW,
        }),
      );
      assert.ok(emptyDriver instanceof PersistenceSqlError);
      assert.equal(emptyDriver.detail, "invalid-input");

      assert.equal((yield* settle(repo, claim.attemptToken)).status, "applied");
      assert.deepEqual(yield* settle(repo, claim.attemptToken), { status: "already-final" });
      assert.deepEqual(yield* settle(repo, claim.attemptToken).pipe(Effect.map(() => null)), null);

      const rows = yield* rawInputRows;
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.providerDriverKind, "claude-code");

      const missing = yield* repo.settleDelivery({
        threadId: ThreadId.make("thread-9"),
        messageId,
        projectId,
        attemptToken: claim.attemptToken,
        providerDriverKind: "claude-code",
        now: NOW,
      });
      assert.deepEqual(missing, { status: "not-found" });

      const wrongProject = yield* repo.settleDelivery({
        threadId,
        messageId,
        projectId: ProjectId.make("project-forged"),
        attemptToken: claim.attemptToken,
        providerDriverKind: "claude-code",
        now: NOW,
      });
      assert.equal(wrongProject.status, "not-owned");
      assert.deepEqual(
        (yield* rawInputRows).map((row) => row.delivery),
        ["provider-accepted"],
      );
    }));

  test("claimProjectForSettlement reads the immutable claim row project", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected entered");
      assert.deepEqual(
        yield* repo.claimProjectForSettlement({
          threadId,
          messageId,
          attemptToken: claim.attemptToken,
        }),
        Option.some(projectId),
      );
      assert.deepEqual(
        yield* repo.claimProjectForSettlement({
          threadId,
          messageId,
          attemptToken: "missing-token",
        }),
        Option.none(),
      );

      // The version's deletion tombstones the retained claim row; the
      // immutable project still answers for the exact token.
      const sql = yield* sqlClient;
      yield* sql`DELETE FROM project_skill_versions WHERE skill_id = ${skillId}`;
      assert.equal((yield* rawInputRows)[0]?.skillId, null);
      assert.deepEqual(
        yield* repo.claimProjectForSettlement({
          threadId,
          messageId,
          attemptToken: claim.attemptToken,
        }),
        Option.some(projectId),
      );
    }));

  test("claimProjectForSettlement refines faults at its own SELECT: fixed when ordinary, whole when interrupt-bearing", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const sql = yield* sqlClient;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected entered");
      const lookup = { threadId, messageId, attemptToken: claim.attemptToken };

      const fault: { cause: Cause.Cause<unknown> | undefined } = { cause: undefined };
      const faulty = yield* makeProjectSkillTrialRepository.pipe(
        Effect.provideService(SqlClient.SqlClient, withClaimProjectSelectFault(sql, fault)),
        Effect.provide(NodeCryptoLayer.layer),
      );
      // Unarmed, the wrapped client is the real one.
      assert.deepEqual(yield* faulty.claimProjectForSettlement(lookup), Option.some(projectId));

      const injected = new PersistenceSqlError({ operation: "Foreign.op", detail: "foreign" });
      fault.cause = Cause.fail(injected);
      const ordinary = yield* Effect.flip(faulty.claimProjectForSettlement(lookup));
      assert.ok(ordinary instanceof PersistenceSqlError);
      assert.equal(ordinary.operation, "ProjectSkillTrialRepository.claimProjectForSettlement");
      assert.equal(ordinary.detail, undefined);

      const mixed = Cause.combine(Cause.fail(injected), Cause.interrupt());
      fault.cause = mixed;
      const exit = yield* Effect.exit(faulty.claimProjectForSettlement(lookup));
      if (!Exit.isFailure(exit)) {
        return assert.fail("expected the mixed cause to fail the lookup");
      }
      assert.deepEqual(exit.cause, mixed);
      assert.ok(Cause.hasInterrupts(exit.cause));
      assert.deepEqual(Cause.findErrorOption(exit.cause), Option.some(injected));

      fault.cause = undefined;
      assert.deepEqual(
        (yield* rawInputRows).map((row) => row.delivery),
        ["unknown"],
      );
    }));

  test("rejects a same-message claim from a new incarnation as stale-identity", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      assert.equal(claim.status, "entered");

      // The thread id is deleted and recreated, and a new user message reuses
      // the message id: a new canonical event, never the old identity.
      yield* seedEvent({ sequence: 60, eventType: "thread.deleted", payload: {} });
      yield* seedEvent({
        sequence: 61,
        eventType: "thread.created",
        payload: { threadId, projectId },
      });
      yield* seedEvent({
        sequence: 62,
        eventType: "thread.message-sent",
        payload: messageSentPayload(messageId, "user"),
      });

      const replay = yield* repo.claimDelivery(claimInput({ inputEventSequence: 62 }));
      assert.deepEqual(replay, { status: "stale-identity" });
      assert.equal(yield* inputRowCount, 1);
    }));

  test("refuses a claim when the thread was recreated after the input", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld([
        { sequence: 25, eventType: "thread.deleted", payload: {} },
        { sequence: 26, eventType: "thread.created", payload: { threadId, projectId } },
      ]);

      const outcome = yield* repo.claimDelivery(claimInput());
      assert.deepEqual(outcome, { status: "thread-recreated" });
      assert.equal(yield* inputRowCount, 0);
    }));

  test("refuses a claim when the ref project disagrees with the thread project", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const otherProjectId = ProjectId.make("project-2");
      const otherThreadId = ThreadId.make("thread-2");
      const sql = yield* sqlClient;
      yield* seedProject();
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        )
        VALUES (${otherProjectId}, 'Other', '/tmp/other', '[]', ${NOW}, ${NOW}, NULL)
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, deleted_at
        )
        VALUES (${otherThreadId}, ${otherProjectId}, 'Other', '{}', 'full-access', 'default', ${NOW}, ${NOW}, NULL)
      `;
      yield* seedVersion();
      yield* sql`
        INSERT INTO orchestration_events (
          sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES
          (
            ${THREAD_CREATED_SEQUENCE}, 'event-other-created', 'thread', ${otherThreadId},
            ${THREAD_CREATED_SEQUENCE}, 'thread.created', ${NOW}, NULL, NULL, NULL, 'server',
            ${JSON.stringify({ threadId: otherThreadId, projectId: otherProjectId })}, '{}'
          ),
          (
            ${INPUT_SEQUENCE}, 'event-other-input', 'thread', ${otherThreadId},
            ${INPUT_SEQUENCE}, 'thread.message-sent', ${NOW}, NULL, NULL, NULL, 'server',
            ${JSON.stringify({
              threadId: otherThreadId,
              messageId,
              role: "user",
              text: "try the candidate",
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            })}, '{}'
          )
      `;

      const forgedRef = { ...ref, projectId: otherProjectId };
      const outcome = yield* repo.claimDelivery({
        ...claimInput(),
        threadId: otherThreadId,
        projectId: otherProjectId,
        ref: forgedRef,
      });
      assert.deepEqual(outcome, { status: "ref-changed" });
      assert.equal(yield* inputRowCount, 0);

      const mismatchedRef = yield* Effect.flip(
        repo.claimDelivery(claimInput({ ref: { ...ref, projectId: otherProjectId } })),
      );
      assert.ok(mismatchedRef instanceof PersistenceSqlError);
      assert.equal(mismatchedRef.detail, "invalid-input");
      assert.equal(yield* inputRowCount, 0);
    }));

  test("refuses a claim when the admitted ref or state stamp moved", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();

      // The state sequence moved since admission (the activation this slice
      // does not own wrote state), so the stamp no longer proves anything.
      const sql = yield* sqlClient;
      yield* sql`UPDATE project_skill_versions SET state = 'active' WHERE skill_id = ${skillId}`;
      const moved = yield* repo.claimDelivery(claimInput());
      assert.deepEqual(moved, { status: "ref-changed" });
      assert.equal(yield* inputRowCount, 0);

      // A deleted version is the same refusal.
      yield* sql`
        UPDATE project_skill_versions SET state = 'candidate' WHERE skill_id = ${skillId}
      `;
      yield* sql`
        INSERT INTO project_skill_state (project_id, seq) VALUES (${projectId}, 1)
          ON CONFLICT(project_id) DO UPDATE SET seq = seq + 1
      `;
      yield* sql`DELETE FROM project_skill_versions WHERE skill_id = ${skillId}`;
      const deleted = yield* repo.claimDelivery(claimInput());
      assert.deepEqual(deleted, { status: "ref-changed" });
      assert.equal(yield* inputRowCount, 0);
    }));

  test("version delete retains delivery ownership and replays stay no-resend", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const sql = yield* sqlClient;
      yield* seedTrialWorld();
      const first = yield* repo.claimDelivery(claimInput());
      assert.equal(first.status, "entered");

      yield* sql`DELETE FROM project_skill_versions WHERE skill_id = ${skillId}`;
      yield* seedVersion();
      const stamp = yield* repo.stateSequence({ projectId });
      assert.deepEqual(yield* repo.claimDelivery(claimInput({ admittedSkillStateSeq: stamp })), {
        status: "no-resend",
      });
      assert.equal(yield* inputRowCount, 1);
      assert.deepEqual(
        (yield* rawInputRows).map((row) => row.delivery),
        ["unknown"],
      );
    }));

  // Two independently scoped clients on one real file, released on the same
  // start barrier with the same claim: SQLite's writer serialization admits
  // exactly one INSERT. The loser may surface no-resend or a typed busy
  // persistence failure — never a second row or an untyped error.
  it.effect("admits exactly one of two racing claims on independent connections", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-skill-trials-race-"));
    const dbPath = NodePath.join(tempDir, "state.sqlite");
    const clientLayerA = NodeSqliteClient.layer({ filename: dbPath });
    const clientLayerB = NodeSqliteClient.layer({ filename: dbPath });
    return Effect.gen(function* () {
      // Migrate and seed on a first connection, then claim through two
      // independent repositories over the same file.
      yield* Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject();
        yield* seedThread();
        yield* seedVersion();
        yield* seedEvent({
          sequence: THREAD_CREATED_SEQUENCE,
          eventType: "thread.created",
          payload: { threadId, projectId },
        });
        yield* seedEvent({
          sequence: INPUT_SEQUENCE,
          eventType: "thread.message-sent",
          payload: messageSentPayload(messageId, "user"),
        });
      }).pipe(Effect.provide(clientLayerA));

      const start = yield* Deferred.make<void>();
      const readyA = yield* Deferred.make<void>();
      const readyB = yield* Deferred.make<void>();
      const race = (clientLayer: typeof clientLayerA, ready: Deferred.Deferred<void>) =>
        Effect.gen(function* () {
          const repo = yield* ProjectSkillTrialRepository;
          yield* Deferred.succeed(ready, undefined);
          yield* Deferred.await(start);
          return yield* repo.claimDelivery(claimInput());
        }).pipe(Effect.provide(Layer.provide(trialLayer, clientLayer)), Effect.exit);

      const fiberA = yield* Effect.forkChild(race(clientLayerA, readyA));
      const fiberB = yield* Effect.forkChild(race(clientLayerB, readyB));
      yield* Deferred.await(readyA);
      yield* Deferred.await(readyB);
      yield* Deferred.succeed(start, undefined);
      const exitA = yield* Fiber.join(fiberA);
      const exitB = yield* Fiber.join(fiberB);

      const outcomes = [exitA, exitB].flatMap((exit) =>
        Exit.isSuccess(exit) ? [exit.value.status] : [],
      );
      const failures = [exitA, exitB].filter((exit) => {
        if (Exit.isSuccess(exit)) return false;
        const failure = Cause.findErrorOption(exit.cause);
        return Option.isSome(failure) && failure.value instanceof PersistenceSqlError;
      });
      assert.equal(outcomes.filter((status) => status === "entered").length, 1);
      assert.ok(outcomes.length + failures.length === 2);
      for (const status of outcomes) {
        assert.ok(status === "entered" || status === "no-resend");
      }

      // Exactly one ownership row exists, and a calm retry only ever
      // learns the fixed no-resend.
      assert.equal(yield* inputRowCount.pipe(Effect.provide(clientLayerA)), 1);
      const calmRetry = yield* Effect.gen(function* () {
        const repo = yield* ProjectSkillTrialRepository;
        return yield* repo.claimDelivery(claimInput());
      }).pipe(Effect.provide(Layer.provide(trialLayer, clientLayerA)));
      assert.deepEqual(calmRetry, { status: "no-resend" });
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });
});

const BLOCK_SHA = "c".repeat(64);
const ROUTE_SHA = "d".repeat(64);

// The well-formed evidence the delivery owner would hand a settle after a
// matched observation — digests and ids only, never a prompt body.
const managedSend: ProjectSkillManagedSendEvidence = {
  scope: "managed-procedure/v1",
  deliveredRef: ref,
  deliveredBlockSha256: BLOCK_SHA,
  providerInstanceId: ProviderInstanceId.make("claude-personal"),
  providerSessionId: "native-session-1",
  routeConfigSha256: ROUTE_SHA,
};

const settleManaged = (
  repositoryService: ProjectSkillTrialRepository["Service"],
  attemptToken: string,
  evidence: ProjectSkillManagedSendEvidence = managedSend,
) =>
  repositoryService.settleDelivery({
    threadId,
    messageId,
    projectId,
    attemptToken,
    providerDriverKind: "claude-code",
    now: NOW,
    managedSend: evidence,
  });

describe("ProjectSkillTrialRepository managed-send evidence", () => {
  test("pins the label atomically with acceptance in one real transaction", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected the claim to enter");

      assert.equal((yield* settleManaged(repo, claim.attemptToken)).status, "applied");

      const rows = yield* rawInputRows;
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.managedSendJson, JSON.stringify(managedSend));

      // The stored JSON decodes back to exactly the pinned evidence.
      const result = yield* sweep(repo);
      const item = result.items.find((row) => row.messageId === messageId);
      assert.deepEqual(item?.managedSend, managedSend);
      // No prompt body is ever persisted with the label.
      assert.equal(rows[0]?.managedSendJson?.includes("try the candidate"), false);
    }));

  test("the label follows the claimed token — a wrong settler writes nothing", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected the claim to enter");

      assert.equal((yield* settleManaged(repo, "not-the-claimants-token")).status, "not-owned");
      const rows = yield* rawInputRows;
      assert.equal(rows[0]?.delivery, "unknown");
      assert.equal(rows[0]?.managedSendJson, null);
    }));

  test("evidence naming a different ref lands an ordinary unlabelled acceptance", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected the claim to enter");

      const mismatched: ProjectSkillManagedSendEvidence = {
        ...managedSend,
        deliveredRef: { ...ref, contentSha256: OTHER_SHA },
      };
      assert.equal((yield* settleManaged(repo, claim.attemptToken, mismatched)).status, "applied");

      const rows = yield* rawInputRows;
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.providerDriverKind, "claude-code");
      assert.equal(rows[0]?.managedSendJson, null);
    }));

  test("an unswept next input already closed the logical window for the label", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected the claim to enter");

      // A real next input lands after the claim but before the settle —
      // the stored flag still reads open, yet the row is logically closed.
      yield* seedEvent({
        sequence: 50,
        eventType: "thread.message-sent",
        payload: messageSentPayload(MessageId.make("message-2"), "user"),
      });
      assert.equal((yield* settleManaged(repo, claim.attemptToken)).status, "applied");

      const rows = yield* rawInputRows;
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.window, "open");
      assert.equal(rows[0]?.managedSendJson, null);
    }));

  test("a same-turn approval leaves an unswept managed-send window open", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld([
        {
          sequence: 22,
          eventType: "thread.session-set",
          payload: { threadId, session: { status: "running", activeTurnId: "turn-1" } },
        },
        {
          sequence: 25,
          eventType: "thread.activity-appended",
          payload: {
            threadId,
            activity: {
              id: "approval-activity",
              kind: "approval.requested",
              payload: { requestId: "approval-1" },
              turnId: "turn-1",
              createdAt: NOW,
            },
          },
        },
        {
          sequence: 26,
          eventType: "thread.approval-response-requested",
          payload: { threadId, requestId: "approval-1" },
        },
      ]);
      const sql = yield* sqlClient;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        )
        VALUES (${threadId}, 'turn-1', ${messageId}, 'running', ${NOW}, '[]')
      `;
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected the claim to enter");

      assert.equal((yield* settleManaged(repo, claim.attemptToken)).status, "applied");
      assert.equal((yield* rawInputRows)[0]?.managedSendJson, JSON.stringify(managedSend));
    }));

  test("an unswept recreation keeps the label off the acceptance", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected the claim to enter");

      yield* seedEvent({
        sequence: 25,
        eventType: "thread.created",
        payload: { threadId, projectId },
      });
      assert.equal((yield* settleManaged(repo, claim.attemptToken)).status, "applied");

      const rows = yield* rawInputRows;
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.managedSendJson, null);
    }));

  test("a swept-closed row never gains the label and a retry cannot enrich it", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected the claim to enter");

      // The boundary lands and the sweep records the closure first.
      yield* seedEvent({
        sequence: 50,
        eventType: "thread.message-sent",
        payload: messageSentPayload(MessageId.make("message-2"), "user"),
      });
      yield* sweep(repo);
      assert.equal((yield* rawInputRows)[0]?.window, "closed");

      assert.equal((yield* settleManaged(repo, claim.attemptToken)).status, "applied");
      assert.equal((yield* rawInputRows)[0]?.managedSendJson, null);

      // A retry carrying evidence is a fixed already-final answer — final
      // rows can never be enriched after the fact.
      assert.equal((yield* settleManaged(repo, claim.attemptToken)).status, "already-final");
      assert.equal((yield* rawInputRows)[0]?.managedSendJson, null);
    }));

  test("a row settled unlabelled stays unlabelled on every later settle", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected the claim to enter");

      assert.equal((yield* settle(repo, claim.attemptToken)).status, "applied");
      assert.equal((yield* settleManaged(repo, claim.attemptToken)).status, "already-final");
      const rows = yield* rawInputRows;
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.managedSendJson, null);
    }));

  test("a malformed stored label decodes to no managed evidence", () =>
    Effect.gen(function* () {
      const sql = yield* sqlClient;
      const repo = yield* repository;
      yield* seedTrialWorld();
      // Inserts bypass the update trigger — this is how a hand-edited or
      // corrupt label reaches a row; the read never yields partial evidence.
      yield* sql`
        INSERT INTO project_skill_inputs (
          thread_id, message_id, project_id, skill_id, version, content_sha256,
          input_event_sequence, input_incarnation, admitted_skill_state_seq,
          provider_driver_kind, native_skill_inventory_sha256,
          delivery, delivery_at, window, window_closed_at, uncounted_attempts,
          attempt_token, claimed_at, tombstoned_at, managed_send_json
        )
        VALUES (
          ${threadId}, 'message-corrupt', ${projectId}, ${skillId}, 1, ${SHA},
          30, ${THREAD_CREATED_SEQUENCE}, 0, 'claude-code', NULL,
          'provider-accepted', ${NOW}, 'closed', ${NOW}, 0,
          'token-corrupt', ${NOW}, NULL, 'not-json-at-all'
        )
      `;
      yield* sql`
        INSERT INTO project_skill_inputs (
          thread_id, message_id, project_id, skill_id, version, content_sha256,
          input_event_sequence, input_incarnation, admitted_skill_state_seq,
          provider_driver_kind, native_skill_inventory_sha256,
          delivery, delivery_at, window, window_closed_at, uncounted_attempts,
          attempt_token, claimed_at, tombstoned_at, managed_send_json
        )
        VALUES (
          ${threadId}, 'message-partial', ${projectId}, ${skillId}, 1, ${SHA},
          31, ${THREAD_CREATED_SEQUENCE}, 0, 'claude-code', NULL,
          'provider-accepted', ${NOW}, 'closed', ${NOW}, 0,
          'token-partial', ${NOW}, NULL, '{"scope":"managed-procedure/v1"}'
        )
      `;

      const result = yield* sweep(repo);
      const corrupt = result.items.find(
        (row) => row.messageId === MessageId.make("message-corrupt"),
      );
      const partial = result.items.find(
        (row) => row.messageId === MessageId.make("message-partial"),
      );
      assert.equal(corrupt?.managedSend, null);
      assert.equal(partial?.managedSend, null);
    }));

  test("the delete tombstone purges the label while ownership survives", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const sql = yield* sqlClient;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected the claim to enter");
      assert.equal((yield* settleManaged(repo, claim.attemptToken)).status, "applied");
      assert.equal((yield* rawInputRows)[0]?.managedSendJson, JSON.stringify(managedSend));

      yield* sql`DELETE FROM project_skill_versions WHERE skill_id = ${skillId}`;

      const rows = yield* rawInputRows;
      assert.equal(rows[0]?.managedSendJson, null);
      assert.equal(rows[0]?.skillId, null);
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.attemptToken, claim.attemptToken);
    }));

  test("a raw label write outside the settle transition is refused", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const sql = yield* sqlClient;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected the claim to enter");

      const beforeSettle = yield* Effect.exit(sql`
        UPDATE project_skill_inputs SET managed_send_json = ${"x"}
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `);
      assert.ok(Exit.isFailure(beforeSettle));

      assert.equal((yield* settleManaged(repo, claim.attemptToken)).status, "applied");
      for (const attempt of [
        sql`UPDATE project_skill_inputs SET managed_send_json = ${"x"}
            WHERE thread_id = ${threadId} AND message_id = ${messageId}`,
        sql`UPDATE project_skill_inputs SET managed_send_json = NULL
            WHERE thread_id = ${threadId} AND message_id = ${messageId}`,
      ]) {
        assert.ok(Exit.isFailure(yield* Effect.exit(attempt)));
      }
      assert.equal((yield* rawInputRows)[0]?.managedSendJson, JSON.stringify(managedSend));
    }));
});

describe("ProjectSkillTrialRepository interruption and error boundaries", () => {
  test("an interrupted claim leaves durable state only and is never a typed failure", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();

      // Deterministic boundary: the child is parked on a gate in front of the
      // claim, so this interrupt provably lands before its transaction.
      const gate = yield* Deferred.make<void>();
      const gated = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.await(gate);
          return yield* repo.claimDelivery(claimInput());
        }),
      );
      yield* Fiber.interrupt(gated);
      const gatedExit = yield* Fiber.await(gated);
      if (!Exit.isFailure(gatedExit)) {
        return assert.fail("expected the gated claim to be interrupted");
      }
      assert.ok(Cause.hasInterrupts(gatedExit.cause));
      assert.ok(Option.isNone(Cause.findErrorOption(gatedExit.cause)));
      assert.equal(yield* inputRowCount, 0);

      const retry = yield* repo.claimDelivery(claimInput());
      assert.equal(retry.status, "entered");
    }));

  test("an interrupted settle leaves the claim unknown until settlement lands", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected the claim to enter");

      const racing = yield* Effect.forkChild(settle(repo, claim.attemptToken));
      yield* Fiber.interrupt(racing);
      yield* Fiber.await(racing);

      // The settlement is always reachable from durable state: either it
      // applied under the interrupt, or the row is still unknown and a retry
      // settles it. It can never strand acceptance or fake it.
      const retried = yield* settle(repo, claim.attemptToken);
      assert.ok(
        retried.status === "applied" || retried.status === "already-final",
        `unexpected settle outcome ${retried.status}`,
      );
      assert.equal((yield* rawInputRows)[0]?.delivery, "provider-accepted");
    }));

  test("a claim transaction fault rolls back whole and retries", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const sql = yield* sqlClient;
      yield* seedTrialWorld();
      yield* sql`
        CREATE TRIGGER claim_fault BEFORE INSERT ON project_skill_inputs
        BEGIN SELECT RAISE(ABORT, 'injected claim failure'); END
      `;

      const error = yield* Effect.flip(repo.claimDelivery(claimInput()));
      assert.ok(error instanceof PersistenceSqlError);
      assert.equal(yield* inputRowCount, 0);

      yield* sql`DROP TRIGGER claim_fault`;
      const retry = yield* repo.claimDelivery(claimInput());
      assert.equal(retry.status, "entered");
    }));

  test("propagates the original mixed interrupt cause from the transaction boundary and work", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const sql = yield* sqlClient;
      yield* seedTrialWorld();
      const injected = new PersistenceSqlError({
        operation: "Foreign.op",
        detail: "foreign",
      });
      const failInterrupt = Cause.combine(Cause.fail(injected), Cause.interrupt());
      const dieInterrupt = Cause.combine(
        Cause.die(new Error("boundary-defect")),
        Cause.interrupt(),
      );
      const original = sql.withTransaction;
      for (const mixedCause of [failInterrupt, dieInterrupt]) {
        Object.assign(sql, {
          withTransaction: () => Effect.failCause(mixedCause),
        });
        const exit = yield* Effect.exit(
          repo
            .claimDelivery(claimInput())
            .pipe(
              Effect.ensuring(Effect.sync(() => Object.assign(sql, { withTransaction: original }))),
            ),
        );
        if (!Exit.isFailure(exit)) {
          return assert.fail("expected the mixed cause to fail the claim");
        }
        assert.deepEqual(exit.cause, mixedCause);
        assert.ok(Cause.hasInterrupts(exit.cause));
        assert.equal(yield* inputRowCount, 0);
      }

      const workDefect = new Error("trial-uuid-refine-defect");
      const workMixed = Cause.combine(Cause.die(workDefect), Cause.interrupt());
      const baseCrypto = yield* Effect.gen(function* () {
        return yield* Crypto.Crypto;
      }).pipe(Effect.provide(NodeCryptoLayer.layer));
      let uuidCalls = 0;
      const workRepo = yield* makeProjectSkillTrialRepository.pipe(
        Effect.provideService(Crypto.Crypto, {
          ...baseCrypto,
          randomUUIDv4: Effect.suspend(() => {
            uuidCalls += 1;
            return Effect.failCause(workMixed);
          }),
        }),
      );
      const workExit = yield* Effect.exit(workRepo.claimDelivery(claimInput()));
      if (!Exit.isFailure(workExit)) {
        return assert.fail("expected the work mixed cause to fail the claim");
      }
      assert.equal(uuidCalls, 1);
      assert.deepEqual(workExit.cause, workMixed);
      assert.equal(yield* inputRowCount, 0);
    }));

  test("foreign transaction failures keep the local operation, defects stay typed", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const sql = yield* sqlClient;
      yield* seedTrialWorld();

      const foreign = new PersistenceSqlError({ operation: "Foreign.op", detail: "foreign" });
      const original = sql.withTransaction;
      Object.assign(sql, { withTransaction: () => Effect.fail(foreign) });
      const error = yield* Effect.flip(repo.claimDelivery(claimInput())).pipe(
        Effect.ensuring(Effect.sync(() => Object.assign(sql, { withTransaction: original }))),
      );
      assert.ok(error instanceof PersistenceSqlError);
      assert.equal(error.operation, "ProjectSkillTrialRepository.claimDelivery");
      assert.equal(error.detail, undefined);
      assert.equal(yield* inputRowCount, 0);

      Object.assign(sql, { withTransaction: () => Effect.die(new Error("boom")) });
      const defect = yield* Effect.flip(repo.claimDelivery(claimInput())).pipe(
        Effect.ensuring(Effect.sync(() => Object.assign(sql, { withTransaction: original }))),
      );
      assert.ok(defect instanceof PersistenceSqlError);
      assert.equal(defect.detail, "transaction-failed");
      assert.equal(yield* inputRowCount, 0);
    }));
});

describe("ProjectSkillTrialRepository.sweepTrials", () => {
  test("freezes the latest in-window receipt per attempt at the next real input", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld([
        receiptEvent(31, passingReceipt({ revision: 1, threadAnchorSequence: 30 })),
        // A revision rewrite: the later write is the window's truth.
        receiptEvent(32, passingReceipt({ revision: 2, threadAnchorSequence: 30 })),
        receiptEvent(33, passingReceipt({ attemptId: "attempt-2", threadAnchorSequence: 30 })),
        {
          sequence: 50,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("message-2"), "user"),
        },
      ]);
      const claim = yield* repo.claimDelivery(claimInput());
      assert.equal(claim.status, "entered");

      const first = yield* sweep(repo);
      assert.equal(first.items.length, 1);
      const row = first.items[0];
      assert.equal(row?.window, "closed");
      assert.equal(row?.uncountedAttempts, 0);
      assert.deepEqual(
        row?.observations.map((observation) => [
          observation.attemptId,
          observation.receiptSequence,
        ]),
        [
          ["attempt-1", 32],
          ["attempt-2", 33],
        ],
      );
      assert.equal(row?.observations[0]?.outcome, "all-selected-passed");
      assert.equal(row?.observations[0]?.endedAt, "2026-08-20T12:00:30Z");
      assert.equal((yield* observationRows).length, 2);

      // Repeated sweeps re-read frozen history; nothing inflates or moves.
      const second = yield* sweep(repo);
      assert.deepEqual(second, first);
      assert.equal((yield* observationRows).length, 2);
    }));

  test("records a failed observation with its null end time", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld([
        receiptEvent(31, failedReceipt({ threadAnchorSequence: 30 })),
        {
          sequence: 50,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("message-2"), "user"),
        },
      ]);
      yield* repo.claimDelivery(claimInput());

      const result = yield* sweep(repo);
      const row = result.items[0];
      assert.equal(row?.window, "closed");
      assert.equal(row?.uncountedAttempts, 0);
      assert.equal(row?.observations[0]?.outcome, "failed");
      assert.equal(row?.observations[0]?.endedAt, null);
    }));

  test("an attempt anchored before the input is ignored, never an observation or uncounted", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld([
        receiptEvent(31, passingReceipt({ threadAnchorSequence: 15 })),
        {
          sequence: 50,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("message-2"), "user"),
        },
      ]);
      yield* repo.claimDelivery(claimInput());

      const result = yield* sweep(repo);
      const row = result.items[0];
      assert.equal(row?.window, "closed");
      assert.equal(row?.uncountedAttempts, 0);
      assert.deepEqual(row?.observations, []);
      assert.equal((yield* observationRows).length, 0);
    }));

  test("a terminal after the boundary is uncounted and never imported backward", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld([
        // Running revision inside the window; its terminal lands after the
        // next input, so the closed window must count it and never succeed it.
        receiptEvent(31, {
          ...passingReceipt({ revision: 1, threadAnchorSequence: 30 }),
          phase: "running",
        }),
        {
          sequence: 40,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("message-2"), "user"),
        },
        receiptEvent(45, passingReceipt({ revision: 2, threadAnchorSequence: 30 })),
      ]);
      yield* repo.claimDelivery(claimInput());

      const result = yield* sweep(repo);
      const row = result.items[0];
      assert.equal(row?.window, "closed");
      assert.equal(row?.uncountedAttempts, 1);
      assert.deepEqual(row?.observations, []);
      assert.equal((yield* observationRows).length, 0);
    }));

  test("same-message turn requests do not close the window; a real input does", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      // The paired request at 21 plus a compaction replay at 22: neither is a
      // next input for this canonical message.
      yield* seedTrialWorld([
        {
          sequence: 22,
          eventType: "thread.turn-start-requested",
          payload: { threadId, messageId, createdAt: NOW },
        },
        receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })),
      ]);
      yield* repo.claimDelivery(claimInput());

      const open = yield* sweep(repo);
      const openRow = open.items[0];
      assert.equal(openRow?.window, "open");
      // Derived provisional result, nothing persisted.
      assert.deepEqual(
        openRow?.provisional.map((attempt) => [attempt.attemptId, attempt.receiptSequence]),
        [["attempt-1", 31]],
      );
      assert.equal((yield* observationRows).length, 0);

      yield* seedEvent(receiptEvent(32, failedReceipt({ revision: 2, threadAnchorSequence: 30 })));
      const revised = yield* sweep(repo);
      assert.deepEqual(
        revised.items[0]?.provisional.map((attempt) => [
          attempt.attemptId,
          attempt.receiptSequence,
          attempt.outcome,
        ]),
        [["attempt-1", 32, "failed"]],
      );
      assert.equal((yield* observationRows).length, 0);

      // A real additional user input closes the window and freezes evidence.
      yield* seedEvent({
        sequence: 50,
        eventType: "thread.message-sent",
        payload: messageSentPayload(MessageId.make("message-2"), "user"),
      });
      const closed = yield* sweep(repo);
      const closedRow = closed.items[0];
      assert.equal(closedRow?.window, "closed");
      assert.deepEqual(closedRow?.provisional, []);
      assert.equal(closedRow?.observations[0]?.receiptSequence, 32);
      assert.equal(closedRow?.observations[0]?.outcome, "failed");
      assert.equal(closedRow?.uncountedAttempts, 0);
      assert.equal((yield* observationRows).length, 1);

      yield* seedEvent(receiptEvent(55, passingReceipt({ revision: 3, threadAnchorSequence: 30 })));
      const afterBoundary = yield* sweep(repo);
      assert.deepEqual(afterBoundary.items[0]?.observations[0]?.receiptSequence, 32);
      assert.equal((yield* observationRows).length, 1);
    }));

  test("an approval for the trial turn does not close its observation window", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld([
        {
          sequence: 22,
          eventType: "thread.session-set",
          payload: { threadId, session: { status: "ready", activeTurnId: null } },
        },
        {
          sequence: 23,
          eventType: "thread.message-sent",
          payload: {
            ...messageSentPayload(MessageId.make("assistant-before-approval"), "assistant"),
            turnId: "turn-1",
          },
        },
        {
          sequence: 24,
          eventType: "thread.session-set",
          payload: { threadId, session: { status: "running", activeTurnId: "turn-1" } },
        },
        {
          sequence: 25,
          eventType: "thread.activity-appended",
          payload: {
            threadId,
            activity: {
              id: "approval-activity",
              kind: "approval.requested",
              payload: { requestId: "approval-1" },
              turnId: "turn-1",
              createdAt: NOW,
            },
          },
        },
        {
          sequence: 26,
          eventType: "thread.approval-response-requested",
          payload: { threadId, requestId: "approval-1" },
        },
        receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })),
        {
          sequence: 50,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("message-2"), "user"),
        },
      ]);
      const sql = yield* sqlClient;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        )
        VALUES (${threadId}, 'turn-1', ${messageId}, 'running', ${NOW}, '[]')
      `;
      const claim = yield* repo.claimDelivery(claimInput());
      if (claim.status !== "entered") return assert.fail("expected the claim to enter");
      yield* settle(repo, claim.attemptToken);

      const result = yield* sweep(repo);
      assert.equal(result.items[0]?.window, "closed");
      assert.deepEqual(
        result.items[0]?.observations.map((observation) => observation.receiptSequence),
        [31],
      );
    }));

  test("recovers a prematurely closed trial without changing its original closure", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const closedAt = yield* seedPrematureApprovalClosure(repo, [
        receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })),
        {
          sequence: 50,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("message-2"), "user"),
        },
      ]);
      const sql = yield* sqlClient;

      const result = yield* sweep(repo);
      assert.deepEqual(
        result.items[0]?.observations.map((observation) => observation.receiptSequence),
        [31],
      );
      const persisted = yield* sql<{ readonly closedAt: string }>`
        SELECT window_closed_at AS "closedAt" FROM project_skill_inputs
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
      assert.equal(persisted[0]?.closedAt, closedAt);
      assert.deepEqual(yield* sweep(repo), result);
    }));

  test("keeps a historical closed-empty row provisional until real input arrives", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const closedAt = yield* seedPrematureApprovalClosure(repo, [
        receiptEvent(31, failedReceipt({ threadAnchorSequence: 30 })),
      ]);
      const sql = yield* sqlClient;

      const provisional = yield* sweep(repo);
      assert.equal(provisional.items[0]?.window, "open");
      assert.deepEqual(
        provisional.items[0]?.provisional.map((attempt) => attempt.outcome),
        ["failed"],
      );
      assert.equal((yield* rawInputRows)[0]?.window, "closed");
      assert.equal((yield* observationRows).length, 0);

      yield* seedEvent({
        sequence: 50,
        eventType: "thread.message-sent",
        payload: messageSentPayload(MessageId.make("message-2"), "user"),
      });
      const frozen = yield* sweep(repo);
      assert.equal(frozen.items[0]?.window, "closed");
      assert.equal(frozen.items[0]?.observations[0]?.outcome, "failed");
      const rows = yield* sql<{ readonly closedAt: string }>`
        SELECT window_closed_at AS "closedAt" FROM project_skill_inputs
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
      assert.equal(rows[0]?.closedAt, closedAt);
    }));

  test("refuses historical reconciliation when stored evidence conflicts", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedPrematureApprovalClosure(repo, [
        receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })),
        {
          sequence: 50,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("message-2"), "user"),
        },
      ]);
      const sql = yield* sqlClient;
      yield* sql`
        INSERT INTO project_skill_observed_uses (
          evidence_id, thread_id, message_id, attempt_id, project_id,
          skill_id, version, content_sha256, check_json, receipt_sequence,
          outcome, ended_at, recorded_at
        )
        VALUES (
          ${ProjectSkillEvidenceId.make(`pse:${threadId}:${messageId}:attempt-1`)},
          ${threadId}, ${messageId}, 'attempt-1', ${projectId},
          ${skillId}, 1, ${SHA}, '{}', 31, 'failed', NULL, ${NOW}
        )
      `;

      const result = yield* sweep(repo);
      assert.equal(result.items[0]?.observations[0]?.outcome, "failed");
      assert.equal((yield* observationRows).length, 1);
      assert.equal((yield* rawInputRows)[0]?.uncountedAttempts, 0);
    }));

  test("rolls back reconstructed observations when the final row update fails", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedPrematureApprovalClosure(repo, [
        receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })),
        {
          sequence: 50,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("message-2"), "user"),
        },
      ]);
      const sql = yield* sqlClient;
      yield* sql`
        CREATE TRIGGER fail_reconciliation BEFORE UPDATE OF uncounted_attempts
        ON project_skill_inputs FOR EACH ROW
        WHEN OLD.window = 'closed'
        BEGIN SELECT RAISE(ABORT, 'injected reconciliation failure'); END
      `;

      const failure = yield* Effect.flip(sweep(repo));
      assert.instanceOf(failure, PersistenceSqlError);
      assert.equal((yield* observationRows).length, 0);
      assert.equal((yield* rawInputRows)[0]?.window, "closed");
    }));

  test("reconciles revised attempts independently of receipt ordering", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedPrematureApprovalClosure(repo, [
        receiptEvent(31, passingReceipt({ attemptId: "attempt-a", threadAnchorSequence: 30 })),
        receiptEvent(32, passingReceipt({ attemptId: "attempt-b", threadAnchorSequence: 30 })),
        receiptEvent(
          34,
          passingReceipt({ attemptId: "attempt-a", revision: 2, threadAnchorSequence: 30 }),
        ),
        {
          sequence: 50,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("message-2"), "user"),
        },
      ]);

      const result = yield* sweep(repo);
      assert.deepEqual(
        result.items[0]?.observations.map((observation) => observation.receiptSequence),
        [34, 32],
      );
      assert.equal((yield* observationRows).length, 2);
    }));

  test("does not borrow receipts after a recreated thread", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedPrematureApprovalClosure(repo, []);
      yield* seedEvent({
        sequence: 30,
        eventType: "thread.created",
        payload: { threadId, projectId },
      });
      yield* seedEvent(receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })));
      yield* seedEvent({
        sequence: 50,
        eventType: "thread.message-sent",
        payload: messageSentPayload(MessageId.make("message-2"), "user"),
      });

      const result = yield* sweep(repo);
      assert.equal(result.items[0]?.window, "closed");
      assert.deepEqual(result.items[0]?.observations, []);
      assert.equal((yield* observationRows).length, 0);
    }));

  test("does not bind an old approval through a turn projected after recreation", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedPrematureApprovalClosure(
        repo,
        [
          receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })),
          {
            sequence: 50,
            eventType: "thread.message-sent",
            payload: messageSentPayload(MessageId.make("message-2"), "user"),
          },
        ],
        false,
      );
      yield* seedEvent({
        sequence: 60,
        eventType: "thread.created",
        payload: { threadId, projectId },
      });
      yield* seedEvent({
        sequence: 61,
        eventType: "thread.session-set",
        payload: { threadId, session: { status: "running", activeTurnId: "turn-1" } },
      });
      const sql = yield* sqlClient;
      yield* sql`DELETE FROM projection_turns WHERE thread_id = ${threadId}`;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        )
        VALUES (${threadId}, 'turn-1', ${messageId}, 'running', ${NOW}, '[]')
      `;

      const result = yield* sweep(repo);
      assert.equal(result.items[0]?.window, "closed");
      assert.deepEqual(result.items[0]?.observations, []);
      assert.equal((yield* observationRows).length, 0);
    }));

  test("closed reconciliation allows only its count, not a closure or label rewrite", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const closedAt = yield* seedPrematureApprovalClosure(repo, []);
      const sql = yield* sqlClient;

      yield* sql`
        UPDATE project_skill_inputs SET uncounted_attempts = 2
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
      assert.equal((yield* rawInputRows)[0]?.uncountedAttempts, 2);
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(sql`
            UPDATE project_skill_inputs SET window_closed_at = ${NOW}
            WHERE thread_id = ${threadId} AND message_id = ${messageId}
          `),
        ),
      );
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(sql`
            UPDATE project_skill_inputs SET managed_send_json = '{}'
            WHERE thread_id = ${threadId} AND message_id = ${messageId}
          `),
        ),
      );
      const rows = yield* sql<{ readonly closedAt: string }>`
        SELECT window_closed_at AS "closedAt" FROM project_skill_inputs
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
      assert.equal(rows[0]?.closedAt, closedAt);
    }));

  test("an unlinked approval remains a boundary before the selected check", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld([
        {
          sequence: 25,
          eventType: "thread.activity-appended",
          payload: {
            threadId,
            activity: {
              id: "foreign-approval",
              kind: "approval.requested",
              payload: { requestId: "approval-1" },
              turnId: "turn-other",
              createdAt: NOW,
            },
          },
        },
        {
          sequence: 26,
          eventType: "thread.approval-response-requested",
          payload: { threadId, requestId: "approval-1" },
        },
        receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })),
      ]);
      const sql = yield* sqlClient;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        )
        VALUES (${threadId}, 'turn-1', ${messageId}, 'running', ${NOW}, '[]')
      `;
      const claim = yield* repo.claimDelivery(claimInput());
      assert.equal(claim.status, "entered");

      const result = yield* sweep(repo);
      assert.equal(result.items[0]?.window, "closed");
      assert.deepEqual(result.items[0]?.observations, []);
      assert.equal((yield* observationRows).length, 0);
    }));

  test("conflicting approval requests do not exempt a response", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld([
        ...["turn-1", "turn-other"].map((turnId, index) => ({
          sequence: 24 + index,
          eventType: "thread.activity-appended",
          payload: {
            threadId,
            activity: {
              id: `approval-${index}`,
              kind: "approval.requested",
              payload: { requestId: "approval-1" },
              turnId,
              createdAt: NOW,
            },
          },
        })),
        {
          sequence: 26,
          eventType: "thread.approval-response-requested",
          payload: { threadId, requestId: "approval-1" },
        },
        receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })),
      ]);
      const sql = yield* sqlClient;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        )
        VALUES (${threadId}, 'turn-1', ${messageId}, 'running', ${NOW}, '[]')
      `;
      yield* repo.claimDelivery(claimInput());

      const result = yield* sweep(repo);
      assert.equal(result.items[0]?.window, "closed");
      assert.deepEqual(result.items[0]?.observations, []);
    }));

  for (const eventType of [
    "thread.user-input-response-requested",
    "thread.checkpoint-revert-requested",
  ]) {
    test(`${eventType} still cuts off a same-turn approval window`, () =>
      Effect.gen(function* () {
        const repo = yield* repository;
        yield* seedTrialWorld([
          {
            sequence: 25,
            eventType: "thread.activity-appended",
            payload: {
              threadId,
              activity: {
                id: "approval-activity",
                kind: "approval.requested",
                payload: { requestId: "approval-1" },
                turnId: "turn-1",
                createdAt: NOW,
              },
            },
          },
          {
            sequence: 26,
            eventType: "thread.approval-response-requested",
            payload: { threadId, requestId: "approval-1" },
          },
          { sequence: 28, eventType, payload: { threadId } },
          receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })),
        ]);
        const sql = yield* sqlClient;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
          )
          VALUES (${threadId}, 'turn-1', ${messageId}, 'running', ${NOW}, '[]')
        `;
        yield* repo.claimDelivery(claimInput());

        const result = yield* sweep(repo);
        assert.equal(result.items[0]?.window, "closed");
        assert.deepEqual(result.items[0]?.observations, []);
      }));
  }

  test("an approval response after the terminal session transition closes the window", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld([
        {
          sequence: 24,
          eventType: "thread.session-set",
          payload: {
            threadId,
            session: { status: "running", activeTurnId: "turn-1" },
          },
        },
        {
          sequence: 25,
          eventType: "thread.activity-appended",
          payload: {
            threadId,
            activity: {
              id: "approval-activity",
              kind: "approval.requested",
              payload: { requestId: "approval-1" },
              turnId: "turn-1",
              createdAt: NOW,
            },
          },
        },
        {
          sequence: 26,
          eventType: "thread.approval-response-requested",
          payload: { threadId, requestId: "approval-1" },
        },
        receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })),
        {
          sequence: 35,
          eventType: "thread.message-sent",
          payload: {
            ...messageSentPayload(MessageId.make("assistant-1"), "assistant"),
            turnId: "turn-1",
          },
        },
        {
          sequence: 36,
          eventType: "thread.session-set",
          payload: { threadId, session: { status: "ready", activeTurnId: null } },
        },
        {
          sequence: 40,
          eventType: "thread.approval-response-requested",
          payload: { threadId, requestId: "approval-1" },
        },
        receiptEvent(45, passingReceipt({ revision: 2, threadAnchorSequence: 30 })),
      ]);
      const sql = yield* sqlClient;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        )
        VALUES (${threadId}, 'turn-1', ${messageId}, 'completed', ${NOW}, '[]')
      `;
      const claim = yield* repo.claimDelivery(claimInput());
      assert.equal(claim.status, "entered");

      const result = yield* sweep(repo);
      assert.equal(result.items[0]?.window, "closed");
      assert.deepEqual(
        result.items[0]?.observations.map((observation) => observation.receiptSequence),
        [31],
      );
    }));

  test("thread recreation closes the window as thread-recreated with no evidence", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();
      const claim = yield* repo.claimDelivery(claimInput());
      assert.equal(claim.status, "entered");
      yield* seedEvent({
        sequence: 25,
        eventType: "thread.created",
        payload: { threadId, projectId },
      });
      yield* seedEvent(receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })));

      const result = yield* sweep(repo);
      const row = result.items[0];
      assert.equal(row?.window, "thread-recreated");
      assert.deepEqual(row?.observations, []);
      assert.deepEqual(row?.provisional, []);
      assert.equal(row?.uncountedAttempts, 0);
      assert.equal((yield* observationRows).length, 0);
    }));

  test("1200 filler events between input and boundary do not disturb the window", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const fillers: Array<SeedEvent> = [];
      for (let index = 0; index < 1200; index += 1) {
        fillers.push({
          sequence: 100 + index,
          eventType: "thread.activity-appended",
          payload: {
            threadId,
            activity: {
              id: `activity-${index}`,
              tone: "info",
              kind: "note",
              summary: "filler",
              payload: { index },
              turnId: null,
              createdAt: NOW,
            },
          },
        });
      }
      yield* seedTrialWorld([
        receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })),
        ...fillers,
        {
          sequence: 1400,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("message-2"), "user"),
        },
      ]);
      yield* repo.claimDelivery(claimInput());

      const result = yield* sweep(repo);
      const row = result.items[0];
      assert.equal(row?.window, "closed");
      assert.deepEqual(
        row?.observations.map((observation) => observation.receiptSequence),
        [31],
      );
      assert.equal(row?.uncountedAttempts, 0);
      // The head is the real event-store head, not the boundary.
      assert.equal(result.head, 1400);
    }));

  test("a receipt candidate that fails authentication fails the sweep typed", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld([
        // Matches the receipt event shape in SQL but its activity payload is
        // not a decodable server receipt: an integrity failure, never an
        // empty history.
        {
          sequence: 31,
          eventType: "thread.activity-appended",
          payload: null,
          commandId: "server:selected-checks:broken",
          payloadJson: JSON.stringify({
            threadId,
            activity: {
              id: `selected-check-receipt:${threadId}`,
              kind: "selected-check-receipt",
              payload: { broken: true },
            },
          }),
        },
        {
          sequence: 50,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("message-2"), "user"),
        },
      ]);
      yield* repo.claimDelivery(claimInput());

      const failure = yield* Effect.flip(sweep(repo));
      assert.instanceOf(failure, PersistenceDecodeError);
      // The window stayed open and nothing was written.
      assert.equal((yield* rawInputRows)[0]?.window, "open");
      assert.equal((yield* observationRows).length, 0);

      // Repairing the history lets the sweep close cleanly.
      const sql = yield* sqlClient;
      yield* sql`DELETE FROM orchestration_events WHERE sequence = 31`;
      const result = yield* sweep(repo);
      assert.equal(result.items[0]?.window, "closed");
      assert.deepEqual(result.items[0]?.observations, []);
    }));

  test("a receipt without the server command prefix is not evidence", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld([
        {
          ...receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })),
          commandId: "client:forged",
        },
        {
          sequence: 50,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("message-2"), "user"),
        },
      ]);
      yield* repo.claimDelivery(claimInput());

      const result = yield* sweep(repo);
      const row = result.items[0];
      assert.equal(row?.window, "closed");
      assert.deepEqual(row?.observations, []);
      assert.equal(row?.uncountedAttempts, 0);
      assert.equal((yield* observationRows).length, 0);
    }));

  test("the sweep is scoped to the requested ref and hides behind dead projects", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const otherSha = OTHER_SHA;
      yield* seedTrialWorld([
        receiptEvent(31, passingReceipt({ threadAnchorSequence: 30 })),
        {
          sequence: 50,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("message-2"), "user"),
        },
      ]);
      const claim = yield* repo.claimDelivery(claimInput());
      assert.equal(claim.status, "entered");

      const sql = yield* sqlClient;
      yield* sql`
        INSERT INTO project_skill_versions (
          skill_id, project_id, version, content_json, content_sha256,
          source_json, source_thread_id, source_receipt_sequence,
          source_thread_created_sequence, created_after_event_sequence, created_at
        )
        VALUES (
          ${skillId}, ${projectId}, 2, '{"title":"other"}', ${otherSha},
          '{"type":"work"}', ${threadId}, 2, ${THREAD_CREATED_SEQUENCE}, 10, ${NOW}
        )
      `;
      yield* sql`
        INSERT INTO project_skill_inputs (
          thread_id, message_id, project_id, skill_id, version, content_sha256,
          input_event_sequence, input_incarnation, admitted_skill_state_seq,
          provider_driver_kind, native_skill_inventory_sha256,
          delivery, delivery_at, window, window_closed_at, uncounted_attempts,
          attempt_token, claimed_at, tombstoned_at
        )
        VALUES (
          ${threadId}, ${MessageId.make("message-other")}, ${projectId},
          ${skillId}, 2, ${otherSha}, 22, ${THREAD_CREATED_SEQUENCE}, 0,
          NULL, NULL, 'unknown', NULL, 'open', NULL, 0, 'token-other', ${NOW}, NULL
        )
      `;

      const scoped = yield* sweep(repo);
      assert.equal(scoped.items.length, 1);
      assert.equal(scoped.items[0]?.messageId, messageId);

      const foreignRef = { ...ref, contentSha256: otherSha, version: 2 };
      const foreignSweep = yield* sweep(repo, foreignRef);
      assert.equal(foreignSweep.items.length, 1);
      assert.equal(foreignSweep.items[0]?.messageId, MessageId.make("message-other"));

      yield* sql`UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = ${projectId}`;
      const hidden = yield* sweep(repo);
      assert.deepEqual(hidden.items, []);
    }));
});

const USE_INPUT_SEQUENCE = 90;
/** After seq=1 and four judgment inserts (→5), activating bumps project state to 6. */
const USE_ADMITTED_STATE_SEQ = 6;
const USE_FIXTURE_WATERMARK = 10;
const USE_SOURCE_THREAD_CREATED_SEQUENCE = 6;
const USE_SOURCE_ANCHOR_SEQUENCE = 7;
const USE_SOURCE_RECEIPT_SEQUENCE = 8;
const useSourceThreadId = ThreadId.make("thread-use-source");

const useFixtureContent: ProjectSkillContent = {
  title: "Release the web app",
  purpose: "Ship a tagged release through the checked pipeline.",
  appliesWhen: "The user asks to cut a release.",
  doesNotApplyWhen: "The user asks for a hotfix outside the pipeline.",
  procedure: "1. Install dependencies.\n2. Run the release script.\n3. Tag the commit.",
  successCheck: "The release test script exits 0.",
};

const useFixtureSourceCheck = (
  receipt: SelectedCheckReceipt,
  sourceThreadId: ThreadId,
): ProjectSkillCheckObservation => {
  const evaluation = evaluateSkillSource({
    candidateProjectId: projectId,
    thread: {
      threadId: sourceThreadId,
      projectId,
      worktreePath: null,
      latestTurnState: null,
    },
    latestInputEventSequence: null,
    checks: {
      capability: { available: true, reason: null },
      record: { kind: "present", receipt, sequence: USE_SOURCE_RECEIPT_SEQUENCE },
      changedScriptIds: [],
      admission: { state: "open" },
    },
    expected: {
      attemptId: receipt.attemptId,
      revision: receipt.revision,
      receiptSequence: USE_SOURCE_RECEIPT_SEQUENCE,
    },
  });
  if (!evaluation.ok) {
    throw new Error(`use fixture source receipt must pass: ${evaluation.reason}`);
  }
  return evaluation.check;
};
const useMessageId = MessageId.make("message-use-1");
const evidenceMessageUse = MessageId.make("message-use-evidence");
const openFailThreadId = ThreadId.make("thread-use-open-fail");
const closedUnsweptThreadId = ThreadId.make("thread-use-closed-unswept");
const USE_FIXTURE_ROUTE_SHA = "e".repeat(64);
const USE_FIXTURE_BLOCK_SHA = "1".repeat(64);
const useFixtureManagedSendJson = JSON.stringify({
  scope: "managed-procedure/v1",
  deliveredRef: ref,
  deliveredBlockSha256: USE_FIXTURE_BLOCK_SHA,
  providerInstanceId: "claude-personal",
  providerSessionId: "native-session-1",
  routeConfigSha256: USE_FIXTURE_ROUTE_SHA,
});

const canonicalJsonForHoldId = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(
      Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });

const derivedFailureObservedHoldId = (
  useThreadId: ThreadId,
  useMessageId: MessageId,
  attemptId: string,
): ProjectSkillHoldId =>
  ProjectSkillHoldId.make(
    `psh_${NodeCrypto.createHash("sha256")
      .update(
        canonicalJsonForHoldId([ref, useThreadId, useMessageId, attemptId, "failure-observed"]),
      )
      .digest("hex")}`,
  );
const EVIDENCE_USE_READY = ProjectSkillEvidenceId.make("pse-use-ready");
const SELECTED_SCRIPT_IDS = ["lint"] as const;

const useMessagePayload = (input: {
  readonly threadId?: ThreadId;
  readonly messageId: MessageId;
  readonly admittedSkillStateSeq: number;
  readonly selectedScriptIds?: ReadonlyArray<string>;
  readonly mode?: "use" | "trial";
}) => ({
  threadId: input.threadId ?? threadId,
  messageId: input.messageId,
  role: "user" as const,
  text: "use the active skill",
  streaming: false,
  createdAt: NOW,
  updatedAt: NOW,
  context: {
    version: 1,
    records: [
      {
        version: 1,
        contextId: "ctx-skill",
        label: "Skill",
        kind: PROJECT_SKILL_CONTEXT_KIND,
        payload: {
          ref,
          mode: input.mode ?? "use",
          admittedSkillStateSeq: input.admittedSkillStateSeq,
          ...(input.selectedScriptIds === undefined
            ? {}
            : { selectedScriptIds: input.selectedScriptIds }),
        },
      },
    ],
  },
});

const seedActiveUseReadyWorld = Effect.gen(function* () {
  yield* seedProject();
  yield* seedThread();
  const sql = yield* sqlClient;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      created_at, updated_at, deleted_at
    )
    VALUES (${useSourceThreadId}, ${projectId}, 'Source thread', '{}', 'full-access', 'default', ${NOW}, ${NOW}, NULL)
  `;
  yield* seedEvent({
    sequence: THREAD_CREATED_SEQUENCE,
    eventType: "thread.created",
    payload: { threadId, projectId },
  });
  yield* seedEvent({
    threadId: useSourceThreadId,
    sequence: USE_SOURCE_THREAD_CREATED_SEQUENCE,
    eventType: "thread.created",
    payload: { threadId: useSourceThreadId, projectId },
  });
  const sourceReceipt = passingReceipt({
    threadId: useSourceThreadId,
    attemptId: "attempt-use-source",
    revision: 2,
    threadAnchorSequence: USE_SOURCE_ANCHOR_SEQUENCE,
  });
  const sourceCheck = useFixtureSourceCheck(sourceReceipt, useSourceThreadId);
  yield* seedEvent(receiptEvent(USE_SOURCE_RECEIPT_SEQUENCE, sourceReceipt));
  yield* sql`
    INSERT INTO project_skill_versions (
      skill_id, project_id, version, content_json, content_sha256,
      source_json, source_thread_id, source_receipt_sequence,
      source_thread_created_sequence, created_after_event_sequence, created_at
    )
    VALUES (
      ${skillId}, ${projectId}, 1, ${JSON.stringify(useFixtureContent)}, ${SHA},
      ${JSON.stringify({ type: "work", check: sourceCheck, draft: { type: "typed" } })},
      ${useSourceThreadId}, ${USE_SOURCE_RECEIPT_SEQUENCE}, ${USE_SOURCE_THREAD_CREATED_SEQUENCE},
      ${USE_FIXTURE_WATERMARK}, ${NOW}
    )
  `;
  yield* seedEvent({
    sequence: 60,
    eventType: "thread.message-sent",
    payload: useMessagePayload({
      messageId: evidenceMessageUse,
      admittedSkillStateSeq: 0,
      mode: "use",
    }),
  });
  yield* sql`
    INSERT INTO project_skill_state (project_id, seq) VALUES (${projectId}, 1)
    ON CONFLICT(project_id) DO UPDATE SET seq = 1
  `;
  const judgments = [
    {
      judgmentId: ProjectSkillJudgmentId.make("psj-rights"),
      kind: "rights",
      judgmentJson: JSON.stringify({
        judgmentId: ProjectSkillJudgmentId.make("psj-rights"),
        ref,
        kind: "rights",
        basis: "own-work",
        originalSource: null,
        license: null,
        recordedAt: NOW,
        recordedBy: "authenticated-client",
        note: "ok",
      }),
    },
    {
      judgmentId: ProjectSkillJudgmentId.make("psj-review"),
      kind: "review",
      judgmentJson: JSON.stringify({
        judgmentId: ProjectSkillJudgmentId.make("psj-review"),
        ref,
        kind: "review",
        provenanceChecked: true,
        privacyChecked: true,
        scopeChecked: true,
        recordedAt: NOW,
        recordedBy: "authenticated-client",
        note: "ok",
      }),
    },
    {
      judgmentId: ProjectSkillJudgmentId.make("psj-repro"),
      kind: "reproduction",
      judgmentJson: JSON.stringify({
        judgmentId: ProjectSkillJudgmentId.make("psj-repro"),
        ref,
        kind: "reproduction",
        observedEvidenceId: EVIDENCE_USE_READY,
        procedureApplied: true,
        successConditionConfirmed: true,
        taskNotUsedForAuthoring: true,
        recordedAt: NOW,
        recordedBy: "authenticated-client",
        note: "ok",
      }),
    },
    {
      judgmentId: ProjectSkillJudgmentId.make("psj-nonapp"),
      kind: "non-application",
      judgmentJson: JSON.stringify({
        judgmentId: ProjectSkillJudgmentId.make("psj-nonapp"),
        ref,
        kind: "non-application",
        observedEvidenceId: EVIDENCE_USE_READY,
        taskDescription: "unrelated",
        verdict: "correctly-not-applied",
        recordedAt: NOW,
        recordedBy: "authenticated-client",
        note: "ok",
      }),
    },
  ];
  for (const judgment of judgments) {
    yield* sql`
      INSERT INTO project_skill_judgments (
        judgment_id, project_id, skill_id, version, content_sha256, kind,
        judgment_json, recorded_after_event_sequence, withdrawn_at
      )
      VALUES (
        ${judgment.judgmentId}, ${projectId}, ${skillId}, 1, ${SHA},
        ${judgment.kind}, ${judgment.judgmentJson}, 62, NULL
      )
    `;
  }
  yield* sql`
    UPDATE project_skill_versions
    SET state = 'active', retired_reason = NULL
    WHERE project_id = ${projectId} AND skill_id = ${skillId} AND version = 1
  `;
  yield* seedEvent({
    sequence: USE_INPUT_SEQUENCE,
    eventType: "thread.message-sent",
    payload: useMessagePayload({
      messageId: useMessageId,
      admittedSkillStateSeq: USE_ADMITTED_STATE_SEQ,
      selectedScriptIds: [...SELECTED_SCRIPT_IDS],
    }),
  });
  yield* seedEvent({
    sequence: 91,
    eventType: "thread.turn-start-requested",
    payload: { threadId, messageId: useMessageId, createdAt: NOW },
  });
  const checkJson = JSON.stringify({
    threadId,
    threadAnchorSequence: 58,
    receiptSequence: 62,
    attemptId: "attempt-use-evidence",
    revision: 1,
    projectId,
    workspaceRoot: "/tmp/project",
    worktreePath: null,
    cwd: "/tmp/project",
    envSha256: SHA,
    planned: [{ scriptId: "lint", scriptName: "Lint", commandSha256: SHA, timeoutMs: 60_000 }],
    tree: {
      treeOid: "c".repeat(40),
      repoTopLevel: "/tmp/project",
      repoCommonDir: "/tmp/project",
    },
    environment: {
      environmentId: EnvironmentId.make("env-1"),
      platform: "darwin",
      arch: "arm64",
      osRelease: "25.6.0",
      serverVersion: "1.0.0",
      nodeVersion: "22.11.0",
    },
    startedAt: "2026-08-20T12:00:00Z",
    endedAt: "2026-08-20T12:00:30Z",
    outcome: "all-selected-passed",
  });
  yield* sql`
    INSERT INTO project_skill_inputs (
      thread_id, message_id, project_id, skill_id, version, content_sha256,
      input_event_sequence, input_incarnation, admitted_skill_state_seq,
      provider_driver_kind, native_skill_inventory_sha256,
      delivery, delivery_at, window, window_closed_at, uncounted_attempts,
      attempt_token, claimed_at, tombstoned_at, managed_send_json
    )
    VALUES (
      ${threadId}, ${evidenceMessageUse}, ${projectId}, ${skillId}, 1, ${SHA},
      60, ${THREAD_CREATED_SEQUENCE}, 0,
      'claude-code', NULL, 'provider-accepted', ${NOW}, 'closed', ${NOW}, 0,
      'token-evidence', ${NOW}, NULL,
      ${JSON.stringify({
        scope: "managed-procedure/v1",
        deliveredRef: ref,
        deliveredBlockSha256: USE_FIXTURE_BLOCK_SHA,
        providerInstanceId: "claude-personal",
        providerSessionId: "native-session-1",
        routeConfigSha256: USE_FIXTURE_ROUTE_SHA,
      })}
    )
  `;
  yield* sql`
    INSERT INTO project_skill_observed_uses (
      evidence_id, thread_id, message_id, attempt_id, project_id, skill_id,
      version, content_sha256, check_json, receipt_sequence, outcome, ended_at, recorded_at
    )
    VALUES (
      ${EVIDENCE_USE_READY}, ${threadId}, ${evidenceMessageUse}, 'attempt-use-evidence',
      ${projectId}, ${skillId}, 1, ${SHA}, ${checkJson}, 62, 'all-selected-passed',
      '2026-08-20T12:00:30Z', ${NOW}
    )
  `;
});

const useEnvironmentFromFixture = Effect.gen(function* () {
  const sql = yield* sqlClient;
  const rows = yield* sql<{ readonly managedSendJson: string }>`
      SELECT managed_send_json AS "managedSendJson"
      FROM project_skill_inputs
      WHERE message_id = ${evidenceMessageUse}
    `;
  const managed = JSON.parse(rows[0]?.managedSendJson ?? "{}") as ProjectSkillManagedSendEvidence;
  const environment = projectSkillEnvironmentOf({
    evidenceId: EVIDENCE_USE_READY,
    input: {
      threadId,
      projectId,
      messageId: evidenceMessageUse,
      inputEventSequence: 60,
      admittedSkillStateSeq: 0,
      providerDriverKind: "claude-code",
      nativeSkillInventorySha256: null,
      items: [{ ref, mode: "use" }],
      managedSend: managed,
    },
    check: JSON.parse(
      (yield* sql<{ readonly checkJson: string }>`
            SELECT check_json AS "checkJson" FROM project_skill_observed_uses
            WHERE evidence_id = ${EVIDENCE_USE_READY}
          `)[0]?.checkJson ?? "{}",
    ),
  });
  if (environment === null) throw new Error("fixture must establish a managed environment");
  return environment;
});

const claimUseInput = (
  input: { readonly current: ProjectSkillEnvironment } & Partial<
    Omit<ClaimProjectSkillUseDeliveryInput, "current">
  >,
): ClaimProjectSkillUseDeliveryInput => ({
  threadId,
  messageId: useMessageId,
  projectId,
  ref,
  inputEventSequence: USE_INPUT_SEQUENCE,
  admittedSkillStateSeq: USE_ADMITTED_STATE_SEQ,
  expectedStateSeq: USE_ADMITTED_STATE_SEQ,
  currentSelectedScriptIds: [...SELECTED_SCRIPT_IDS],
  now: NOW,
  ...input,
});

describe("ProjectSkillTrialRepository.claimUseDelivery", () => {
  test("claims use delivery when durable selection matches the server-current plan", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedActiveUseReadyWorld;
      const current = yield* useEnvironmentFromFixture;
      const outcome = yield* repo.claimUseDelivery(claimUseInput({ current }));
      assert.equal(outcome.status, "entered");
      if (outcome.status !== "entered") return;
      assert.ok(outcome.attemptToken.length > 0);
      assert.equal(yield* inputRowCount, 2);
    }));

  test("rejects missing and mismatched durable selected script ids", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedActiveUseReadyWorld;
      const current = yield* useEnvironmentFromFixture;
      yield* seedEvent({
        sequence: 95,
        eventType: "thread.message-sent",
        payload: useMessagePayload({
          messageId: MessageId.make("message-missing-selection"),
          admittedSkillStateSeq: USE_ADMITTED_STATE_SEQ,
        }),
      });
      const missing = yield* repo.claimUseDelivery(
        claimUseInput({
          current,
          messageId: MessageId.make("message-missing-selection"),
          inputEventSequence: 95,
        }),
      );
      assert.deepEqual(missing, { status: "selection-missing" });

      const mismatch = yield* repo.claimUseDelivery(
        claimUseInput({ current, currentSelectedScriptIds: ["test"] }),
      );
      assert.deepEqual(mismatch, { status: "selection-mismatch" });
    }));

  test("refuses stale identity, recreation, inactive ref, and state stamp drift", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedActiveUseReadyWorld;
      const current = yield* useEnvironmentFromFixture;
      const sql = yield* sqlClient;
      yield* sql`UPDATE project_skill_versions SET state = 'candidate' WHERE skill_id = ${skillId}`;
      assert.deepEqual(yield* repo.claimUseDelivery(claimUseInput({ current })), {
        status: "ref-changed",
      });
      yield* sql`UPDATE project_skill_versions SET state = 'active' WHERE skill_id = ${skillId}`;
      yield* sql`UPDATE project_skill_state SET seq = ${USE_ADMITTED_STATE_SEQ + 1} WHERE project_id = ${projectId}`;
      assert.deepEqual(yield* repo.claimUseDelivery(claimUseInput({ current })), {
        status: "ref-changed",
      });
      yield* sql`UPDATE project_skill_state SET seq = ${USE_ADMITTED_STATE_SEQ} WHERE project_id = ${projectId}`;
      yield* seedEvent({ sequence: 96, eventType: "thread.deleted", payload: {} });
      assert.deepEqual(yield* repo.claimUseDelivery(claimUseInput({ current })), {
        status: "thread-recreated",
      });
    }));

  test("rejects a same-message use claim from a new incarnation as stale-identity", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedActiveUseReadyWorld;
      const current = yield* useEnvironmentFromFixture;
      const first = yield* repo.claimUseDelivery(claimUseInput({ current }));
      assert.equal(first.status, "entered");
      yield* seedEvent({ sequence: 96, eventType: "thread.deleted", payload: {} });
      yield* seedEvent({
        sequence: 97,
        eventType: "thread.created",
        payload: { threadId, projectId },
      });
      yield* seedEvent({
        sequence: 98,
        eventType: "thread.message-sent",
        payload: useMessagePayload({
          messageId: useMessageId,
          admittedSkillStateSeq: USE_ADMITTED_STATE_SEQ,
          selectedScriptIds: [...SELECTED_SCRIPT_IDS],
        }),
      });
      assert.deepEqual(
        yield* repo.claimUseDelivery(
          claimUseInput({
            current,
            inputEventSequence: 98,
            admittedSkillStateSeq: USE_ADMITTED_STATE_SEQ,
          }),
        ),
        { status: "stale-identity" },
      );
    }));

  test("refuses when a provider-accepted use row cannot bind its canonical message", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedActiveUseReadyWorld;
      const current = yield* useEnvironmentFromFixture;
      const sql = yield* sqlClient;
      yield* sql`
        INSERT INTO project_skill_inputs (
          thread_id, message_id, project_id, skill_id, version, content_sha256,
          input_event_sequence, input_incarnation, admitted_skill_state_seq,
          provider_driver_kind, native_skill_inventory_sha256,
          delivery, delivery_at, window, window_closed_at, uncounted_attempts,
          attempt_token, claimed_at, tombstoned_at
        )
        VALUES (
          ${threadId}, ${MessageId.make("message-unbound-use")}, ${projectId},
          ${skillId}, 1, ${SHA}, 88, ${THREAD_CREATED_SEQUENCE}, ${USE_ADMITTED_STATE_SEQ},
          'claude-code', NULL, 'provider-accepted', ${NOW}, 'open', NULL, 0,
          'token-unbound', ${NOW}, NULL
        )
      `;
      assert.deepEqual(yield* repo.claimUseDelivery(claimUseInput({ current })), {
        status: "context-invalid",
      });
    }));

  test("refuses when a provider-accepted use row admission stamp disagrees with context", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedActiveUseReadyWorld;
      const current = yield* useEnvironmentFromFixture;
      const sql = yield* sqlClient;
      yield* sql`
        INSERT INTO project_skill_inputs (
          thread_id, message_id, project_id, skill_id, version, content_sha256,
          input_event_sequence, input_incarnation, admitted_skill_state_seq,
          provider_driver_kind, native_skill_inventory_sha256,
          delivery, delivery_at, window, window_closed_at, uncounted_attempts,
          attempt_token, claimed_at, tombstoned_at
        )
        VALUES (
          ${threadId}, ${MessageId.make("message-stamp-mismatch")}, ${projectId},
          ${skillId}, 1, ${SHA}, 35, ${THREAD_CREATED_SEQUENCE}, 4,
          'claude-code', NULL, 'provider-accepted', ${NOW}, 'open', NULL, 0,
          'token-stamp', ${NOW}, NULL
        )
      `;
      yield* seedEvent({
        sequence: 35,
        eventType: "thread.message-sent",
        payload: useMessagePayload({
          messageId: MessageId.make("message-stamp-mismatch"),
          admittedSkillStateSeq: USE_ADMITTED_STATE_SEQ,
          selectedScriptIds: [...SELECTED_SCRIPT_IDS],
        }),
      });
      assert.deepEqual(yield* repo.claimUseDelivery(claimUseInput({ current })), {
        status: "context-invalid",
      });
    }));

  test("ignores unknown-delivery rows when scanning for failed use", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedActiveUseReadyWorld;
      const current = yield* useEnvironmentFromFixture;
      const sql = yield* sqlClient;
      yield* sql`
        INSERT INTO project_skill_inputs (
          thread_id, message_id, project_id, skill_id, version, content_sha256,
          input_event_sequence, input_incarnation, admitted_skill_state_seq,
          provider_driver_kind, native_skill_inventory_sha256,
          delivery, delivery_at, window, window_closed_at, uncounted_attempts,
          attempt_token, claimed_at, tombstoned_at
        )
        VALUES (
          ${threadId}, ${MessageId.make("message-unknown-fail")}, ${projectId},
          ${skillId}, 1, ${SHA}, 30, ${THREAD_CREATED_SEQUENCE}, ${USE_ADMITTED_STATE_SEQ},
          NULL, NULL, 'unknown', NULL, 'open', NULL, 0,
          'token-unknown-fail', ${NOW}, NULL
        )
      `;
      yield* seedEvent({
        sequence: 30,
        eventType: "thread.message-sent",
        payload: useMessagePayload({
          messageId: MessageId.make("message-unknown-fail"),
          admittedSkillStateSeq: USE_ADMITTED_STATE_SEQ,
          selectedScriptIds: [...SELECTED_SCRIPT_IDS],
        }),
      });
      yield* seedEvent(
        receiptEvent(32, failedReceipt({ threadAnchorSequence: 31, attemptId: "attempt-unknown" })),
      );
      const outcome = yield* repo.claimUseDelivery(claimUseInput({ current }));
      assert.equal(outcome.status, "entered");
    }));

  test("answers no-resend for an existing use claim", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedActiveUseReadyWorld;
      const current = yield* useEnvironmentFromFixture;
      const first = yield* repo.claimUseDelivery(claimUseInput({ current }));
      assert.equal(first.status, "entered");
      assert.deepEqual(yield* repo.claimUseDelivery(claimUseInput({ current })), {
        status: "no-resend",
      });
    }));

  test("refuses an open failed provisional use", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedActiveUseReadyWorld;
      const current = yield* useEnvironmentFromFixture;
      const sql = yield* sqlClient;
      const openFailMessageId = MessageId.make("message-open-fail");
      const openFailCreatedSequence = 25;
      const openFailInputSequence = 26;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, deleted_at
        )
        VALUES (${openFailThreadId}, ${projectId}, 'Use fail thread', '{}', 'full-access', 'default', ${NOW}, ${NOW}, NULL)
      `;
      yield* seedEvent({
        threadId: openFailThreadId,
        sequence: openFailCreatedSequence,
        eventType: "thread.created",
        payload: { threadId: openFailThreadId, projectId },
      });
      yield* seedEvent({
        threadId: openFailThreadId,
        sequence: openFailInputSequence,
        eventType: "thread.message-sent",
        payload: useMessagePayload({
          threadId: openFailThreadId,
          messageId: openFailMessageId,
          admittedSkillStateSeq: USE_ADMITTED_STATE_SEQ,
          selectedScriptIds: [...SELECTED_SCRIPT_IDS],
        }),
      });
      yield* seedEvent(
        receiptEvent(
          28,
          failedReceipt({
            threadId: openFailThreadId,
            threadAnchorSequence: 27,
            attemptId: "attempt-open-fail",
          }),
        ),
      );
      yield* sql`
        INSERT INTO project_skill_inputs (
          thread_id, message_id, project_id, skill_id, version, content_sha256,
          input_event_sequence, input_incarnation, admitted_skill_state_seq,
          provider_driver_kind, native_skill_inventory_sha256,
          delivery, delivery_at, window, window_closed_at, uncounted_attempts,
          attempt_token, claimed_at, tombstoned_at
        )
        VALUES (
          ${openFailThreadId}, ${openFailMessageId}, ${projectId},
          ${skillId}, 1, ${SHA}, ${openFailInputSequence}, ${openFailCreatedSequence},
          ${USE_ADMITTED_STATE_SEQ},
          'claude-code', NULL, 'provider-accepted', ${NOW}, 'open', NULL, 0,
          'token-open-fail', ${NOW}, NULL
        )
      `;
      assert.deepEqual(yield* repo.claimUseDelivery(claimUseInput({ current })), {
        status: "open-failed-use",
      });
    }));

  test("refuses use when a historically closed approval window has a failed provisional", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedActiveUseReadyWorld;
      const current = yield* useEnvironmentFromFixture;
      const sql = yield* sqlClient;
      const historicalThread = ThreadId.make("thread-use-historical-fail");
      const historicalMessage = MessageId.make("message-use-historical-fail");
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, deleted_at
        )
        VALUES (${historicalThread}, ${projectId}, 'Historical trial', '{}', 'full-access', 'default', ${NOW}, ${NOW}, NULL)
      `;
      yield* seedEvent({
        threadId: historicalThread,
        sequence: 20,
        eventType: "thread.created",
        payload: { threadId: historicalThread, projectId },
      });
      yield* seedEvent({
        threadId: historicalThread,
        sequence: 22,
        eventType: "thread.message-sent",
        payload: useMessagePayload({
          threadId: historicalThread,
          messageId: historicalMessage,
          admittedSkillStateSeq: USE_ADMITTED_STATE_SEQ,
          selectedScriptIds: [...SELECTED_SCRIPT_IDS],
        }),
      });
      yield* seedEvent({
        threadId: historicalThread,
        sequence: 23,
        eventType: "thread.turn-start-requested",
        payload: { threadId: historicalThread, messageId: historicalMessage },
      });
      yield* seedEvent({
        threadId: historicalThread,
        sequence: 24,
        eventType: "thread.session-set",
        payload: {
          threadId: historicalThread,
          session: { status: "running", activeTurnId: "historical-turn" },
        },
      });
      yield* seedEvent({
        threadId: historicalThread,
        sequence: 25,
        eventType: "thread.activity-appended",
        payload: {
          threadId: historicalThread,
          activity: {
            id: "historical-approval",
            kind: "approval.requested",
            payload: { requestId: "historical-request" },
            turnId: "historical-turn",
            createdAt: NOW,
          },
        },
      });
      yield* seedEvent({
        threadId: historicalThread,
        sequence: 26,
        eventType: "thread.approval-response-requested",
        payload: { threadId: historicalThread, requestId: "historical-request" },
      });
      yield* seedEvent(
        receiptEvent(
          27,
          failedReceipt({
            threadId: historicalThread,
            attemptId: "attempt-historical-fail",
            threadAnchorSequence: 26,
          }),
        ),
      );
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        )
        VALUES (${historicalThread}, 'historical-turn', ${historicalMessage}, 'running', ${NOW}, '[]')
      `;
      yield* sql`
        INSERT INTO project_skill_inputs (
          thread_id, message_id, project_id, skill_id, version, content_sha256,
          input_event_sequence, input_incarnation, admitted_skill_state_seq,
          provider_driver_kind, native_skill_inventory_sha256,
          delivery, delivery_at, window, window_closed_at, uncounted_attempts,
          attempt_token, claimed_at, tombstoned_at
        )
        VALUES (
          ${historicalThread}, ${historicalMessage}, ${projectId}, ${skillId}, 1, ${SHA},
          22, 20, ${USE_ADMITTED_STATE_SEQ}, 'claude-code', NULL,
          'provider-accepted', ${NOW}, 'closed', ${NOW}, 0,
          'token-historical-fail', ${NOW}, NULL
        )
      `;

      const provisional = yield* sweep(repo);
      assert.equal(
        provisional.items.find((item) => item.messageId === historicalMessage)?.window,
        "open",
      );
      assert.deepEqual(yield* repo.claimUseDelivery(claimUseInput({ current })), {
        status: "open-failed-use",
      });
      assert.equal((yield* observationRows).length, 1);
    }));

  test("refuses a closed unswept failed use via readiness, not a repository veto", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedActiveUseReadyWorld;
      const current = yield* useEnvironmentFromFixture;
      const sql = yield* sqlClient;
      const closedUnsweptMessageId = MessageId.make("message-closed-unswept");
      const closedCreatedSequence = 33;
      const closedInputSequence = 34;
      const closedBoundarySequence = 38;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, deleted_at
        )
        VALUES (${closedUnsweptThreadId}, ${projectId}, 'Use fail thread', '{}', 'full-access', 'default', ${NOW}, ${NOW}, NULL)
      `;
      yield* seedEvent({
        threadId: closedUnsweptThreadId,
        sequence: closedCreatedSequence,
        eventType: "thread.created",
        payload: { threadId: closedUnsweptThreadId, projectId },
      });
      yield* seedEvent({
        threadId: closedUnsweptThreadId,
        sequence: closedInputSequence,
        eventType: "thread.message-sent",
        payload: useMessagePayload({
          threadId: closedUnsweptThreadId,
          messageId: closedUnsweptMessageId,
          admittedSkillStateSeq: USE_ADMITTED_STATE_SEQ,
          selectedScriptIds: [...SELECTED_SCRIPT_IDS],
        }),
      });
      yield* seedEvent(
        receiptEvent(
          36,
          failedReceipt({
            threadId: closedUnsweptThreadId,
            threadAnchorSequence: 35,
            attemptId: "attempt-closed",
          }),
        ),
      );
      yield* seedEvent({
        threadId: closedUnsweptThreadId,
        sequence: closedBoundarySequence,
        eventType: "thread.message-sent",
        payload: messageSentPayload(
          MessageId.make("message-closed-boundary"),
          "user",
          closedUnsweptThreadId,
        ),
      });
      yield* sql`
        INSERT INTO project_skill_inputs (
          thread_id, message_id, project_id, skill_id, version, content_sha256,
          input_event_sequence, input_incarnation, admitted_skill_state_seq,
          provider_driver_kind, native_skill_inventory_sha256,
          delivery, delivery_at, window, window_closed_at, uncounted_attempts,
          attempt_token, claimed_at, tombstoned_at
        )
        VALUES (
          ${closedUnsweptThreadId}, ${closedUnsweptMessageId}, ${projectId},
          ${skillId}, 1, ${SHA}, ${closedInputSequence}, ${closedCreatedSequence},
          ${USE_ADMITTED_STATE_SEQ},
          'claude-code', NULL, 'provider-accepted', ${NOW}, 'open', NULL, 0,
          'token-closed-unswept', ${NOW}, NULL
        )
      `;
      const outcome = yield* repo.claimUseDelivery(claimUseInput({ current }));
      assert.equal(outcome.status, "not-ready");
      if (outcome.status !== "not-ready") return;
      assert.deepEqual(outcome.gaps, ["open-hold"]);
      const holdRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM project_skill_holds
        WHERE project_id = ${projectId} AND skill_id = ${skillId} AND version = 1
      `;
      assert.equal(holdRows[0]?.count ?? 0, 0);
    }));

  test("claims use when a closed failed observation hold is released", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedActiveUseReadyWorld;
      const current = yield* useEnvironmentFromFixture;
      const sql = yield* sqlClient;
      const closedUnsweptMessageId = MessageId.make("message-closed-released");
      const closedCreatedSequence = 33;
      const closedInputSequence = 34;
      const closedBoundarySequence = 38;
      const closedFailAttemptId = "attempt-closed-released";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, deleted_at
        )
        VALUES (${closedUnsweptThreadId}, ${projectId}, 'Use fail thread', '{}', 'full-access', 'default', ${NOW}, ${NOW}, NULL)
      `;
      yield* seedEvent({
        threadId: closedUnsweptThreadId,
        sequence: closedCreatedSequence,
        eventType: "thread.created",
        payload: { threadId: closedUnsweptThreadId, projectId },
      });
      yield* seedEvent({
        threadId: closedUnsweptThreadId,
        sequence: closedInputSequence,
        eventType: "thread.message-sent",
        payload: useMessagePayload({
          threadId: closedUnsweptThreadId,
          messageId: closedUnsweptMessageId,
          admittedSkillStateSeq: USE_ADMITTED_STATE_SEQ,
          selectedScriptIds: [...SELECTED_SCRIPT_IDS],
        }),
      });
      yield* seedEvent(
        receiptEvent(
          36,
          failedReceipt({
            threadId: closedUnsweptThreadId,
            threadAnchorSequence: 35,
            attemptId: closedFailAttemptId,
          }),
        ),
      );
      yield* seedEvent({
        threadId: closedUnsweptThreadId,
        sequence: closedBoundarySequence,
        eventType: "thread.message-sent",
        payload: messageSentPayload(
          MessageId.make("message-closed-released-boundary"),
          "user",
          closedUnsweptThreadId,
        ),
      });
      yield* sql`
        INSERT INTO project_skill_inputs (
          thread_id, message_id, project_id, skill_id, version, content_sha256,
          input_event_sequence, input_incarnation, admitted_skill_state_seq,
          provider_driver_kind, native_skill_inventory_sha256,
          delivery, delivery_at, window, window_closed_at, uncounted_attempts,
          attempt_token, claimed_at, tombstoned_at, managed_send_json
        )
        VALUES (
          ${closedUnsweptThreadId}, ${closedUnsweptMessageId}, ${projectId},
          ${skillId}, 1, ${SHA}, ${closedInputSequence}, ${closedCreatedSequence},
          ${USE_ADMITTED_STATE_SEQ},
          'claude-code', NULL, 'provider-accepted', ${NOW}, 'open', NULL, 0,
          'token-closed-released', ${NOW}, NULL, ${useFixtureManagedSendJson}
        )
      `;
      const holdId = derivedFailureObservedHoldId(
        closedUnsweptThreadId,
        closedUnsweptMessageId,
        closedFailAttemptId,
      );
      const classificationId = ProjectSkillJudgmentId.make("psj-failure-unrelated");
      yield* sql`
        INSERT INTO project_skill_judgments (
          judgment_id, project_id, skill_id, version, content_sha256, kind,
          judgment_json, recorded_after_event_sequence, withdrawn_at
        )
        VALUES (
          ${classificationId}, ${projectId}, ${skillId}, 1, ${SHA},
          'failure-classification',
          ${JSON.stringify({
            judgmentId: classificationId,
            ref,
            kind: "failure-classification",
            holdId,
            classification: "unrelated",
            recordedAt: NOW,
            recordedBy: "authenticated-client",
            note: "unrelated failure",
          })},
          100, NULL
        )
      `;
      const stateRows = yield* sql<{ readonly seq: number }>`
        SELECT seq FROM project_skill_state WHERE project_id = ${projectId}
      `;
      const admittedSkillStateSeq = stateRows[0]?.seq ?? 0;
      const releasedClaimMessageId = MessageId.make("message-use-after-release");
      const releasedClaimInputSequence = 92;
      const releasedClaimTurnSequence = 93;
      yield* seedEvent({
        sequence: releasedClaimInputSequence,
        eventType: "thread.message-sent",
        payload: useMessagePayload({
          messageId: releasedClaimMessageId,
          admittedSkillStateSeq,
          selectedScriptIds: [...SELECTED_SCRIPT_IDS],
        }),
      });
      yield* seedEvent({
        sequence: releasedClaimTurnSequence,
        eventType: "thread.turn-start-requested",
        payload: { threadId, messageId: releasedClaimMessageId, createdAt: NOW },
      });
      const outcome = yield* repo.claimUseDelivery(
        claimUseInput({
          current,
          messageId: releasedClaimMessageId,
          inputEventSequence: releasedClaimInputSequence,
          admittedSkillStateSeq,
          expectedStateSeq: admittedSkillStateSeq,
        }),
      );
      assert.equal(outcome.status, "entered");
    }));

  test("trial claimDelivery remains unchanged", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* seedTrialWorld();
      const outcome = yield* repo.claimDelivery(claimInput());
      assert.equal(outcome.status, "entered");
    }));

  it.effect("fails closed when ProjectSkillUseWorkAssessor is not composed", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-skill-trials-bare-"));
    const dbPath = NodePath.join(tempDir, "state.sqlite");
    const bareTrialLayer = Layer.effect(
      ProjectSkillTrialRepository,
      makeProjectSkillTrialRepository,
    ).pipe(Layer.provide(NodeCryptoLayer.layer));
    return Effect.andThen(
      runMigrations(),
      Effect.gen(function* () {
        const repo = yield* ProjectSkillTrialRepository;
        yield* seedActiveUseReadyWorld;
        const current = yield* useEnvironmentFromFixture;
        const outcome = yield* repo.claimUseDelivery(claimUseInput({ current }));
        assert.deepEqual(outcome, {
          status: "assessment-unavailable",
          dependency: "ProjectSkillUseWorkAssessor",
        });
      }),
    ).pipe(
      Effect.provide(
        bareTrialLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath }))),
      ),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });
});
