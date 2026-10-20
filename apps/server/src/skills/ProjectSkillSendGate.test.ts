// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProjectSkillId,
  ThreadId,
  canonicalProjectSkillContentJson,
  renderProjectSkillBlock,
} from "@t3tools/contracts";
import type {
  ComposerContextRecord,
  ProjectSkillContent,
  ProjectSkillVersionRef,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProjectSkillRepository, layer as skillsLayer } from "../persistence/ProjectSkills.ts";
import {
  ProjectSkillTrialRepository,
  layer as trialsLayer,
} from "../persistence/ProjectSkillTrials.ts";
import { ProjectSkillSendGate, layer as sendGateLayer } from "./ProjectSkillSendGate.ts";
import type { ProjectSkillSendInput, ProjectSkillSendRejection } from "./ProjectSkillSendGate.ts";

const NOW = "2026-10-12T00:00:00.000Z";
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const RECEIPT_SEQUENCE = 15;
const THREAD_CREATED_SEQUENCE = 5;
const WATERMARK_SEQUENCE = 50;

const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const threadId = ThreadId.make("thread-1");
const skillId = ProjectSkillId.make("psk_abcd1234");
const otherSkillId = ProjectSkillId.make("psk_efgh5678");
const messageId = MessageId.make("message-1");

const content: ProjectSkillContent = {
  title: "Release the web app",
  purpose: "Ship a tagged release through the checked pipeline.",
  appliesWhen: "The user asks to cut a release.",
  doesNotApplyWhen: "The user asks for a hotfix outside the pipeline.",
  procedure: "1. Install dependencies.\n2. Run the release script.\n3. Tag the commit.",
  successCheck: "The release test script exits 0.",
};
const contentSha256 = NodeCrypto.createHash("sha256")
  .update(canonicalProjectSkillContentJson(content), "utf8")
  .digest("hex");
const ref: ProjectSkillVersionRef = { projectId, skillId, version: 1, contentSha256 };
const skillBlock = renderProjectSkillBlock({ ref, content, mode: "trial" });
const text = `Follow this exactly:\n${skillBlock}\nThen report back.`;
const useSkillBlock = renderProjectSkillBlock({ ref, content, mode: "use" });
const useText = `Follow this exactly:\n${useSkillBlock}\nThen report back.`;
const useScriptIds = ["lint"];

// A minimal all-selected-passed observation so the seeded version row decodes
// through the repository's stored-source schema.
const seedCheck = {
  threadId,
  threadAnchorSequence: 10,
  receiptSequence: RECEIPT_SEQUENCE,
  attemptId: "attempt-1",
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
  startedAt: NOW,
  endedAt: NOW,
  outcome: "all-selected-passed",
};

const seedProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    )
    VALUES (${projectId}, 'Project', '/tmp/project', '[]', ${NOW}, ${NOW}, NULL)
  `;
});

const seedThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      created_at, updated_at, deleted_at
    )
    VALUES (${threadId}, ${projectId}, 'Thread', '{}', 'full-access', 'default', ${NOW}, ${NOW}, NULL)
  `;
});

const seedActive = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE project_skill_versions
    SET state = 'active', retired_reason = NULL
    WHERE skill_id = ${skillId}
  `;
});

const seedCandidate = (
  input: { readonly targetSkillId?: ProjectSkillId; readonly sha?: string } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_skill_versions (
        skill_id, project_id, version, content_json, content_sha256,
        source_json, source_thread_id, source_receipt_sequence,
        source_thread_created_sequence, created_after_event_sequence, created_at
      )
      VALUES (
        ${input.targetSkillId ?? skillId}, ${projectId}, 1, ${JSON.stringify(content)},
        ${input.sha ?? contentSha256},
        ${JSON.stringify({ type: "work", check: seedCheck, draft: { type: "typed" } })},
        ${threadId}, ${RECEIPT_SEQUENCE}, ${THREAD_CREATED_SEQUENCE}, ${WATERMARK_SEQUENCE}, ${NOW}
      )
    `;
  });

const seedSentEvent = (sequence = 60) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
        payload_json, metadata_json
      )
      VALUES (
        ${sequence}, ${`event-${sequence}`}, 'thread', ${threadId}, ${sequence},
        'thread.message-sent', ${NOW}, NULL, NULL, NULL, 'server',
        ${JSON.stringify({
          threadId,
          messageId,
          role: "user",
          text,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        })},
        '{}'
      )
    `;
  });

const seedWorld = Effect.gen(function* () {
  yield* seedProject;
  yield* seedThread;
  yield* seedCandidate();
});

const skillRecord = (
  contextId = "ctx-skill",
  payload: unknown = { ref, mode: "trial", admittedSkillStateSeq: 999, forged: "extra-key" },
): ComposerContextRecord => ({
  version: 1,
  contextId: ComposerContextId.make(contextId),
  kind: "project-skill",
  label: "release",
  payload,
});

const imageRecord: ComposerContextRecord = {
  version: 1,
  contextId: ComposerContextId.make("ctx-image"),
  kind: "image",
  label: "shot.png",
  attachmentId: "local-image-1",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 6,
};

const memoryRecord: ComposerContextRecord = {
  version: 1,
  contextId: ComposerContextId.make("ctx-memory"),
  kind: "memory",
  label: "memory",
  payload: { memoryId: "m-1", selectedVersion: 1 },
};

const sendInput = (overrides: Partial<ProjectSkillSendInput> = {}): ProjectSkillSendInput => ({
  threadId,
  messageId,
  text,
  records: [skillRecord()],
  bootstrap: false,
  ...overrides,
});

const projectSkillPayload = (records: ReadonlyArray<ComposerContextRecord>, index = 0) => {
  const record = records[index];
  if (record === undefined) {
    throw new Error("expected a context record");
  }
  if (record.kind !== "project-skill" || !("payload" in record)) {
    throw new Error("expected a project-skill record with payload");
  }
  return record.payload;
};

const useSendInput = (overrides: Partial<ProjectSkillSendInput> = {}): ProjectSkillSendInput =>
  sendInput({
    text: useText,
    records: [
      skillRecord("ctx-skill", {
        ref,
        mode: "use",
        selectedScriptIds: useScriptIds,
        admittedSkillStateSeq: 999,
      }),
    ],
    ...overrides,
  });

const inputsCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS "n" FROM project_skill_inputs
  `;
  return rows[0]?.n ?? 0;
});

const eventCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS "n" FROM orchestration_events
  `;
  return rows[0]?.n ?? 0;
});

function withGateDatabase<A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    R | ProjectSkillRepository | ProjectSkillTrialRepository | SqlClient.SqlClient
  >,
) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-skill-gate-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = Layer.mergeAll(skillsLayer, trialsLayer).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })),
  );
  return Effect.andThen(runMigrations(), effect).pipe(
    Effect.provide(sendGateLayer.pipe(Layer.provideMerge(persistence))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
}

describe("ProjectSkillSendGate", () => {
  it.effect("answers Ordinary for unmanaged input with no SQL, repository, or crypto work", () =>
    withGateDatabase(
      Effect.gen(function* () {
        // No project, thread, or version is seeded: the fast path never reaches them.
        const gate = yield* ProjectSkillSendGate;
        const sql = yield* SqlClient.SqlClient;
        const skills = yield* ProjectSkillRepository;
        const trials = yield* ProjectSkillTrialRepository;

        let transactions = 0;
        let getSkillCalls = 0;
        let stateSequenceCalls = 0;
        const realWithTransaction = sql.withTransaction;
        const realGetSkill = skills.getSkill;
        const realStateSequence = trials.stateSequence;
        Object.assign(sql, {
          withTransaction: (work: Effect.Effect<unknown, unknown, never>) => {
            transactions++;
            return realWithTransaction(work);
          },
        });
        Object.assign(skills, {
          getSkill: () => {
            getSkillCalls++;
            return Effect.die(new Error("getSkill must not run"));
          },
        });
        Object.assign(trials, {
          stateSequence: () => {
            stateSequenceCalls++;
            return Effect.die(new Error("stateSequence must not run"));
          },
        });

        const input = sendInput({ records: [imageRecord] });
        yield* Effect.gen(function* () {
          const first = yield* gate.preflight(input);
          assert.equal(first._tag, "Ordinary");
          const second = yield* gate.authorizeInTransaction(input);
          assert.equal(second._tag, "Ordinary");
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              Object.assign(sql, { withTransaction: realWithTransaction });
              Object.assign(skills, { getSkill: realGetSkill });
              Object.assign(trials, { stateSequence: realStateSequence });
            }),
          ),
        );
        assert.equal(transactions, 0);
        assert.equal(getSkillCalls, 0);
        assert.equal(stateSequenceCalls, 0);
      }),
    ),
  );

  it.effect("retains trial selectedScriptIds when present and still strips forged keys", () =>
    withGateDatabase(
      Effect.gen(function* () {
        yield* seedWorld;
        const gate = yield* ProjectSkillSendGate;
        const selection = ["lint", "format"];
        const input = sendInput({
          records: [
            skillRecord("ctx-skill", {
              ref,
              mode: "trial",
              selectedScriptIds: selection,
              admittedSkillStateSeq: 999,
              forged: "extra-key",
            }),
          ],
        });
        const decision = yield* gate.preflight(input);
        assert.equal(decision._tag, "Admitted");
        if (decision._tag !== "Admitted") return;
        const payload = projectSkillPayload(decision.records);
        assert.deepEqual(payload, {
          ref,
          mode: "trial",
          admittedSkillStateSeq: 0,
          selectedScriptIds: selection,
        });
      }),
    ),
  );

  it.effect("admits provisional use with validated selection in preflight and authorize", () =>
    withGateDatabase(
      Effect.gen(function* () {
        yield* seedWorld;
        yield* seedActive;
        const gate = yield* ProjectSkillSendGate;
        const trials = yield* ProjectSkillTrialRepository;
        const sql = yield* SqlClient.SqlClient;
        const stampedSeq = yield* trials.stateSequence({ projectId });
        assert.equal(stampedSeq, 1);

        const preflight = yield* gate.preflight(useSendInput());
        assert.equal(preflight._tag, "Admitted");
        if (preflight._tag !== "Admitted") return;
        assert.deepEqual(preflight.ref, ref);
        assert.notEqual(preflight.admittedSkillStateSeq, 999);
        assert.equal(preflight.admittedSkillStateSeq, stampedSeq);
        assert.deepEqual(projectSkillPayload(preflight.records), {
          ref,
          mode: "use",
          admittedSkillStateSeq: stampedSeq,
          selectedScriptIds: useScriptIds,
        });

        const eventsBefore = yield* eventCount;
        const authorized = yield* sql.withTransaction(gate.authorizeInTransaction(useSendInput()));
        assert.equal(authorized._tag, "Admitted");
        if (authorized._tag !== "Admitted") return;
        assert.equal(authorized.admittedSkillStateSeq, stampedSeq);
        assert.deepEqual(projectSkillPayload(authorized.records), {
          ref,
          mode: "use",
          admittedSkillStateSeq: stampedSeq,
          selectedScriptIds: useScriptIds,
        });
        assert.equal(yield* inputsCount, 0);
        assert.equal(yield* eventCount, eventsBefore);
      }),
    ),
  );

  it.effect("admits a managed trial send, stamps the canonical payload, and writes nothing", () =>
    withGateDatabase(
      Effect.gen(function* () {
        yield* seedWorld;
        const gate = yield* ProjectSkillSendGate;

        const input = sendInput({ records: [skillRecord(), imageRecord] });
        const eventsBefore = yield* eventCount;
        const decision = yield* gate.preflight(input);
        assert.equal(decision._tag, "Admitted");
        if (decision._tag !== "Admitted") return;

        assert.equal(decision.projectId, projectId);
        assert.deepEqual(decision.ref, ref);
        // The server-stamped sequence, not the client's 999.
        assert.equal(decision.admittedSkillStateSeq, 0);
        assert.equal(decision.records.length, 2);
        assert.deepEqual(decision.records[0], {
          version: 1,
          contextId: ComposerContextId.make("ctx-skill"),
          kind: "project-skill",
          label: "release",
          payload: { ref, mode: "trial", admittedSkillStateSeq: 0 },
        });
        // Unrelated records pass through untouched.
        assert.equal(decision.records[1], input.records[1]);

        assert.equal(yield* inputsCount, 0);
        assert.equal(yield* eventCount, eventsBefore);
      }),
    ),
  );

  const rejectionCases: ReadonlyArray<{
    readonly name: string;
    readonly reason: ProjectSkillSendRejection;
    readonly arrange?: Effect.Effect<
      unknown,
      unknown,
      SqlClient.SqlClient | ProjectSkillRepository
    >;
    readonly input?: (base: ProjectSkillSendInput) => ProjectSkillSendInput;
  }> = [
    {
      name: "an edited skill block",
      reason: "not-admissible",
      input: (base) => ({ ...base, text: base.text.replace("title:", "title: edited") }),
    },
    {
      name: "the skill block twice",
      reason: "not-admissible",
      input: (base) => ({ ...base, text: `${base.text}\n${skillBlock}` }),
    },
    {
      name: "two managed records",
      reason: "unsupported",
      input: (base) => ({
        ...base,
        records: [skillRecord("ctx-skill"), skillRecord("ctx-skill-2")],
      }),
    },
    {
      name: "a memory record mixed in",
      reason: "unsupported",
      input: (base) => ({ ...base, records: [skillRecord(), memoryRecord] }),
    },
    {
      name: "a use-mode request without script selection",
      reason: "not-admissible",
      arrange: seedActive,
      input: () => useSendInput({ records: [skillRecord("ctx-skill", { ref, mode: "use" })] }),
    },
    {
      name: "duplicate use script ids",
      reason: "not-admissible",
      input: () =>
        useSendInput({
          records: [
            skillRecord("ctx-skill", {
              ref,
              mode: "use",
              selectedScriptIds: ["lint", "lint"],
            }),
          ],
        }),
    },
    {
      name: "empty use script selection",
      reason: "not-admissible",
      input: () =>
        useSendInput({
          records: [
            skillRecord("ctx-skill", {
              ref,
              mode: "use",
              selectedScriptIds: [],
            }),
          ],
        }),
    },
    {
      name: "null use script selection",
      reason: "not-admissible",
      input: () =>
        useSendInput({
          records: [
            skillRecord("ctx-skill", {
              ref,
              mode: "use",
              selectedScriptIds: null,
            }),
          ],
        }),
    },
    {
      name: "use against a candidate version",
      reason: "not-admissible",
      input: () => useSendInput(),
    },
    {
      name: "use against a retired version",
      reason: "not-admissible",
      arrange: Effect.gen(function* () {
        yield* seedActive;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE project_skill_versions
          SET state = 'retired', retired_reason = 'user-retired'
          WHERE skill_id = ${skillId}
        `;
      }),
      input: () => useSendInput(),
    },
    {
      name: "a malformed payload",
      reason: "not-admissible",
      input: (base) => ({
        ...base,
        records: [skillRecord("ctx-skill", { no: "ref" })],
      }),
    },
    {
      name: "a bootstrap send",
      reason: "unsupported",
      input: (base) => ({ ...base, bootstrap: true }),
    },
    {
      name: "a ref to another project",
      reason: "not-admissible",
      input: (base) => ({
        ...base,
        records: [
          skillRecord("ctx-skill", {
            ref: { ...ref, projectId: otherProjectId },
            mode: "trial",
          }),
        ],
      }),
    },
    {
      name: "the same version under a different hash",
      reason: "not-admissible",
      input: (base) => ({
        ...base,
        records: [
          skillRecord("ctx-skill", { ref: { ...ref, contentSha256: OTHER_SHA }, mode: "trial" }),
        ],
      }),
    },
    {
      name: "a deleted skill",
      reason: "not-admissible",
      arrange: Effect.gen(function* () {
        const repository = yield* ProjectSkillRepository;
        yield* repository.deleteSkill({ projectId, skillId, expectedLatestVersion: 1 });
      }),
    },
    {
      name: "an already-sent message id",
      reason: "unsupported",
      arrange: seedSentEvent(),
    },
    {
      name: "a deleted thread",
      reason: "unavailable",
      arrange: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_threads SET deleted_at = ${NOW} WHERE thread_id = ${threadId}`;
      }),
    },
  ];

  it.effect.each(rejectionCases)("rejects a send with $name as $reason", (row) =>
    withGateDatabase(
      Effect.gen(function* () {
        yield* seedWorld;
        if (row.arrange !== undefined) yield* row.arrange;
        const gate = yield* ProjectSkillSendGate;
        const input = (row.input ?? ((base: ProjectSkillSendInput) => base))(sendInput());
        const decision = yield* gate.preflight(input);
        assert.equal(decision._tag, "Rejected");
        if (decision._tag === "Rejected") assert.equal(decision.reason, row.reason);
      }),
    ),
  );

  it.effect("fails closed for authorizeInTransaction outside a transaction", () =>
    withGateDatabase(
      Effect.gen(function* () {
        yield* seedWorld;
        const gate = yield* ProjectSkillSendGate;
        const decision = yield* gate.authorizeInTransaction(sendInput());
        assert.equal(decision._tag, "Rejected");
        if (decision._tag === "Rejected") assert.equal(decision.reason, "unavailable");
      }),
    ),
  );

  it.effect("re-reads the store in authorize: a deleted skill after preflight is rejected", () =>
    withGateDatabase(
      Effect.gen(function* () {
        yield* seedWorld;
        const repository = yield* ProjectSkillRepository;
        const gate = yield* ProjectSkillSendGate;
        const sql = yield* SqlClient.SqlClient;

        const admitted = yield* gate.preflight(sendInput());
        assert.equal(admitted._tag, "Admitted");

        yield* repository.deleteSkill({ projectId, skillId, expectedLatestVersion: 1 });
        const authorized = yield* sql.withTransaction(gate.authorizeInTransaction(sendInput()));
        assert.equal(authorized._tag, "Rejected");
        if (authorized._tag === "Rejected") assert.equal(authorized.reason, "not-admissible");
      }),
    ),
  );

  it.effect("stamps the sequence current at authorize, not the preflight snapshot", () =>
    withGateDatabase(
      Effect.gen(function* () {
        yield* seedWorld;
        yield* seedCandidate({ targetSkillId: otherSkillId });
        const repository = yield* ProjectSkillRepository;
        const gate = yield* ProjectSkillSendGate;
        const sql = yield* SqlClient.SqlClient;

        const admitted = yield* gate.preflight(sendInput());
        assert.equal(admitted._tag, "Admitted");
        if (admitted._tag === "Admitted") assert.equal(admitted.admittedSkillStateSeq, 0);

        // Deleting a different skill in the same project bumps the sequence.
        yield* repository.deleteSkill({
          projectId,
          skillId: otherSkillId,
          expectedLatestVersion: 1,
        });
        const authorized = yield* sql.withTransaction(gate.authorizeInTransaction(sendInput()));
        assert.equal(authorized._tag, "Admitted");
        if (authorized._tag === "Admitted") assert.equal(authorized.admittedSkillStateSeq, 1);
      }),
    ),
  );

  it.effect("sees caller-transaction writes, then rolls them back", () =>
    withGateDatabase(
      Effect.gen(function* () {
        yield* seedWorld;
        const gate = yield* ProjectSkillSendGate;
        const sql = yield* SqlClient.SqlClient;

        const rolledBack = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              // Retiring the selected version is uncommitted when authorize runs.
              yield* sql`
                UPDATE project_skill_versions
                SET state = 'retired', retired_reason = 'user-retired'
                WHERE skill_id = ${skillId}
              `;
              const decision = yield* gate.authorizeInTransaction(sendInput());
              assert.equal(decision._tag, "Rejected");
              if (decision._tag === "Rejected") {
                assert.equal(decision.reason, "not-admissible");
              }
              return yield* Effect.fail("rolled-back" as const);
            }),
          )
          .pipe(Effect.flip);
        assert.equal(rolledBack, "rolled-back");

        // The rollback restored the candidate row: the send admits again.
        const after = yield* sql.withTransaction(gate.authorizeInTransaction(sendInput()));
        assert.equal(after._tag, "Admitted");
      }),
    ),
  );

  it.effect("collapses a typed repository failure to the fixed unavailable decision", () =>
    withGateDatabase(
      Effect.gen(function* () {
        yield* seedWorld;
        const skills = yield* ProjectSkillRepository;
        const gate = yield* ProjectSkillSendGate;

        const realGetSkill = skills.getSkill;
        Object.assign(skills, {
          getSkill: () => Effect.fail(new PersistenceSqlError({ operation: "sabotage" })),
        });
        const decision = yield* gate
          .preflight(sendInput())
          .pipe(
            Effect.ensuring(Effect.sync(() => Object.assign(skills, { getSkill: realGetSkill }))),
          );
        // The public decision carries no cause, id, version, or hash.
        assert.deepEqual(decision, { _tag: "Rejected", reason: "unavailable" });
      }),
    ),
  );

  it.effect("a stored hash that no longer matches the canonical content is unavailable", () =>
    withGateDatabase(
      Effect.gen(function* () {
        yield* seedProject;
        yield* seedThread;
        yield* seedCandidate({ sha: OTHER_SHA });
        const gate = yield* ProjectSkillSendGate;

        const tamperedRef: ProjectSkillVersionRef = { ...ref, contentSha256: OTHER_SHA };
        const tamperedText = `x\n${renderProjectSkillBlock({ ref: tamperedRef, content, mode: "trial" })}\ny`;
        const decision = yield* gate.preflight(
          sendInput({
            text: tamperedText,
            records: [skillRecord("ctx-skill", { ref: tamperedRef, mode: "trial" })],
          }),
        );
        assert.deepEqual(decision, { _tag: "Rejected", reason: "unavailable" });
      }),
    ),
  );

  it.effect.each([
    { name: "missing", text: "no skill block here" },
    { name: "duplicated", text: `${useText}\n${useSkillBlock}` },
  ])("does not admit use when the managed block is $name", ({ text }) =>
    withGateDatabase(
      Effect.gen(function* () {
        yield* seedWorld;
        yield* seedActive;
        const gate = yield* ProjectSkillSendGate;
        const decision = yield* gate.preflight(useSendInput({ text }));
        assert.deepEqual(decision, { _tag: "Rejected", reason: "not-admissible" });
      }),
    ),
  );

  it.effect("propagates only the interrupt leg of a mixed defect cause", () =>
    withGateDatabase(
      Effect.gen(function* () {
        yield* seedWorld;
        const skills = yield* ProjectSkillRepository;
        const gate = yield* ProjectSkillSendGate;

        const realGetSkill = skills.getSkill;
        Object.assign(skills, {
          getSkill: () =>
            Effect.failCause(
              Cause.combine(Cause.die(new Error("hidden defect")), Cause.interrupt()),
            ),
        });
        const exit = yield* gate
          .preflight(sendInput())
          .pipe(
            Effect.exit,
            Effect.ensuring(Effect.sync(() => Object.assign(skills, { getSkill: realGetSkill }))),
          );
        assert.ok(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.ok(Cause.hasInterruptsOnly(exit.cause));
        }
      }),
    ),
  );
});
