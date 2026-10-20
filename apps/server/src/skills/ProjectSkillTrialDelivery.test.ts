// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { SelectedChecks, type SelectedChecksTargetPlan } from "../selectedChecks/SelectedChecks.ts";
import {
  ProjectSkillMutationFence,
  layer as ProjectSkillMutationFenceLayer,
} from "./ProjectSkillMutationFence.ts";

import {
  MessageId,
  ProjectId,
  ProjectSkillId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  canonicalProjectSkillContentJson,
  renderProjectSkillBlock,
} from "@t3tools/contracts";
import type { ProjectSkillContent, ProjectSkillVersionRef } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  ProjectSkillTrialRepository,
  layer as trialsLayer,
} from "../persistence/ProjectSkillTrials.ts";
import {
  ProjectSkillTrialDelivery,
  type ProjectSkillTrialSubmission,
  layer as deliveryLayer,
} from "./ProjectSkillTrialDelivery.ts";

const NOW = "2026-10-12T00:00:00.000Z";
const SHA = "a".repeat(64);
const THREAD_CREATED_SEQUENCE = 5;
const INPUT_SEQUENCE = 20;

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const skillId = ProjectSkillId.make("psk_abcd1234");
const messageId = MessageId.make("message-1");
const driverKind = ProviderDriverKind.make("claude-code");

const ref = { projectId, skillId, version: 1, contentSha256: SHA };

const expectedIdentity = {
  threadId,
  messageId,
  projectId,
  ref,
  inputEventSequence: INPUT_SEQUENCE,
  admittedSkillStateSeq: 0,
  mode: "trial" as const,
};

// The collaborators a use handoff reads. Unscripted ones die loudly; a test
// scripts only what its schedule reaches.
interface DeliveryWorld {
  readonly resolveTargetPlan?: SelectedChecks["Service"]["resolveTargetPlan"];
  readonly previewSubmissionRoute?: ProviderService["Service"]["previewSubmissionRoute"];
  readonly getThreadShellById?: ProjectionSnapshotQuery["Service"]["getThreadShellById"];
}

// Armed per test: the next immutable-project SELECT on the trial repository's
// client fails with this cause. It is a plain read that opens no transaction,
// so a sabotaged `withTransaction` can never reach it.
const sqlFaults: { claimProjectSelect: Cause.Cause<unknown> | undefined } = {
  claimProjectSelect: undefined,
};

// The trial repository (and the assessor beside it) read through this client;
// every other consumer keeps the real one, and every statement passes through
// untouched unless the fault above is armed.
const faultableSqlLayer = Layer.effect(
  SqlClient.SqlClient,
  Effect.map(
    SqlClient.SqlClient,
    (client) =>
      new Proxy(client, {
        apply: (target, thisArg, args: ReadonlyArray<unknown>) => {
          const strings = args[0];
          return sqlFaults.claimProjectSelect !== undefined &&
            Array.isArray(strings) &&
            strings.join("?").includes('SELECT project_id AS "projectId"\n')
            ? Effect.failCause(sqlFaults.claimProjectSelect)
            : Reflect.apply(target as never, thisArg, args);
        },
      }),
  ),
);

function withDeliveryDatabase<A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    R | ProjectSkillTrialRepository | SqlClient.SqlClient | ProjectSkillMutationFence
  >,
  world: DeliveryWorld = {},
) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-skill-delivery-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const sqliteLayer = NodeSqliteClient.layer({ filename: dbPath });
  const persistence = trialsLayer.pipe(
    Layer.provide(faultableSqlLayer),
    Layer.provideMerge(sqliteLayer),
  );
  const deliveryDeps = Layer.mergeAll(
    ProjectSkillMutationFenceLayer,
    Layer.mock(SelectedChecks, {
      get: () => Effect.die("unexpected SelectedChecks.get in delivery test"),
      resolveTargetPlan:
        world.resolveTargetPlan ??
        (() => Effect.die("unexpected SelectedChecks.resolveTargetPlan in delivery test")),
    }),
    Layer.mock(ProviderService, {
      previewSubmissionRoute:
        world.previewSubmissionRoute ??
        (() => Effect.die("unexpected ProviderService.previewSubmissionRoute in delivery test")),
    }),
    Layer.mock(ProjectionSnapshotQuery, {
      getThreadShellById: world.getThreadShellById ?? (() => Effect.succeed(Option.none())),
    }),
  ).pipe(Layer.provideMerge(sqliteLayer));
  const appLayer = deliveryLayer.pipe(
    Layer.provideMerge(persistence),
    Layer.provideMerge(deliveryDeps),
  );
  return Effect.andThen(runMigrations(), effect).pipe(
    Effect.provide(appLayer),
    Effect.ensuring(
      Effect.sync(() => {
        sqlFaults.claimProjectSelect = undefined;
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    ),
  );
}

const test = (
  name: string,
  run: () => Effect.Effect<
    unknown,
    unknown,
    ProjectSkillTrialRepository | SqlClient.SqlClient | ProjectSkillMutationFence
  >,
  world?: DeliveryWorld,
) => it.effect(name, () => withDeliveryDatabase(run(), world));

const delivery = Effect.gen(function* () {
  return yield* ProjectSkillTrialDelivery;
});

const sqlClient = Effect.gen(function* () {
  return yield* SqlClient.SqlClient;
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

const seedVersion = (input?: { readonly contentSha256?: string; readonly contentJson?: string }) =>
  Effect.gen(function* () {
    const sql = yield* sqlClient;
    yield* sql`
      INSERT INTO project_skill_versions (
        skill_id, project_id, version, content_json, content_sha256,
        source_json, source_thread_id, source_receipt_sequence,
        source_thread_created_sequence, created_after_event_sequence, created_at
      )
      VALUES (
        ${skillId}, ${projectId}, 1, ${input?.contentJson ?? '{"title":"t"}'},
        ${input?.contentSha256 ?? SHA},
        '{"type":"work"}', ${threadId}, 2, ${THREAD_CREATED_SEQUENCE}, 10, ${NOW}
      )
    `;
  });

interface SeedEvent {
  readonly sequence: number;
  readonly eventType: string;
  readonly payload: unknown;
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
        ${event.sequence}, ${`event-${event.sequence}`}, 'thread',
        ${threadId}, ${event.sequence}, ${event.eventType}, ${NOW},
        NULL, NULL, NULL, 'server',
        ${JSON.stringify(event.payload)}, '{}'
      )
    `;
  });

// `thread.created` payloads must decode through the persisted-event schema:
// resolve reads the canonical project binding out of the governing creation.
const threadCreatedPayload = (pid: ProjectId = projectId) => ({
  threadId,
  projectId: pid,
  title: "Thread",
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  branch: null,
  worktreePath: null,
  createdAt: NOW,
  updatedAt: NOW,
});

// The stamped trial record the gate would have persisted into the message
// context: mode trial plus the server-issued admittedSkillStateSeq.
const managedRecord = (
  contextId = "ctx-skill",
  payload: unknown = { ref, mode: "trial", admittedSkillStateSeq: 0 },
) => ({
  version: 1,
  contextId,
  kind: "project-skill",
  label: "release",
  payload,
});

const imageRecord = {
  version: 1,
  contextId: "ctx-image",
  kind: "image",
  label: "shot.png",
  attachmentId: "local-image-1",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 6,
};

const memoryRecord = {
  version: 1,
  contextId: "ctx-memory",
  kind: "memory",
  label: "memory",
  payload: { memoryId: "m-1", selectedVersion: 1 },
};

const managedContext = { version: 1, records: [managedRecord()] };

const messageSentPayload = (
  id: MessageId,
  role: "user" | "assistant" = "user",
  context: unknown = managedContext,
) => ({
  threadId,
  messageId: id,
  role,
  text: "try the candidate",
  context,
  streaming: false,
  createdAt: NOW,
  updatedAt: NOW,
});

// The trial world: one thread incarnation, the canonical accepted user
// message, and its paired plus re-emitted turn requests. Direct SQL seeds
// are controlled inputs — never evidence a provider ran.
const seedTrialWorld = (extraEvents: ReadonlyArray<SeedEvent> = []) =>
  Effect.gen(function* () {
    yield* seedProject();
    yield* seedThread();
    yield* seedVersion();
    yield* seedEvent({
      sequence: THREAD_CREATED_SEQUENCE,
      eventType: "thread.created",
      payload: threadCreatedPayload(),
    });
    yield* seedEvent({
      sequence: INPUT_SEQUENCE,
      eventType: "thread.message-sent",
      payload: messageSentPayload(messageId),
    });
    yield* seedEvent({
      sequence: 21,
      eventType: "thread.turn-start-requested",
      payload: { threadId, messageId, createdAt: NOW },
    });
    for (const extra of extraEvents) yield* seedEvent(extra);
  });

const inputsCount = Effect.gen(function* () {
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
    readonly inputEventSequence: number;
    readonly inputIncarnation: number;
    readonly delivery: string;
    readonly providerDriverKind: string | null;
    readonly window: string;
    readonly managedSendJson: string | null;
  }>`
    SELECT thread_id AS "threadId", message_id AS "messageId",
      input_event_sequence AS "inputEventSequence",
      input_incarnation AS "inputIncarnation",
      delivery AS "delivery", provider_driver_kind AS "providerDriverKind",
      window AS "window", managed_send_json AS "managedSendJson"
    FROM project_skill_inputs
    ORDER BY message_id
  `;
});

// The ownership facts one claim row retains, tombstoned or not: the immutable
// project, the one-time token, and the delivery state.
const ownershipRow = Effect.gen(function* () {
  const sql = yield* sqlClient;
  const rows = yield* sql<{
    readonly projectId: string;
    readonly attemptToken: string;
    readonly delivery: string;
    readonly providerDriverKind: string | null;
    readonly skillId: string | null;
  }>`
    SELECT project_id AS "projectId", attempt_token AS "attemptToken",
      delivery AS "delivery", provider_driver_kind AS "providerDriverKind",
      skill_id AS "skillId"
    FROM project_skill_inputs
    WHERE thread_id = ${threadId} AND message_id = ${messageId}
  `;
  return rows[0];
});

// The managed-capture fixture: real immutable content so the canonical
// expected block actually derives — the sha is the real canonical hash, and
// the message context record names the real ref.
const skillContent: ProjectSkillContent = {
  title: "Release the web app",
  purpose: "Ship a tagged release through the checked pipeline.",
  appliesWhen: "The user asks to cut a release.",
  doesNotApplyWhen: "The user asks for a hotfix outside the pipeline.",
  procedure: "1. Install dependencies.\n2. Run the release script.\n3. Tag the commit.",
  successCheck: "The release test script exits 0.",
};
const skillContentSha256 = NodeCrypto.createHash("sha256")
  .update(canonicalProjectSkillContentJson(skillContent), "utf8")
  .digest("hex");
const skillRef: ProjectSkillVersionRef = {
  projectId,
  skillId,
  version: 1,
  contentSha256: skillContentSha256,
};
const expectedBlock = renderProjectSkillBlock({
  ref: skillRef,
  content: skillContent,
  mode: "trial",
});
const expectedBlockSha256 = NodeCrypto.createHash("sha256")
  .update(expectedBlock, "utf8")
  .digest("hex");

const claudeInstanceId = ProviderInstanceId.make("claude-personal");
const claudeDriverKind = ProviderDriverKind.make("claudeAgent");
const ROUTE_SHA = "d".repeat(64);

const skillContext = {
  version: 1,
  records: [managedRecord("ctx-skill", { ref: skillRef, mode: "trial", admittedSkillStateSeq: 0 })],
};

const expectedEvidenceJson = JSON.stringify({
  scope: "managed-procedure/v1",
  deliveredRef: skillRef,
  deliveredBlockSha256: expectedBlockSha256,
  providerInstanceId: claudeInstanceId,
  providerSessionId: "native-session-1",
  routeConfigSha256: ROUTE_SHA,
});

// Same world as seedTrialWorld, but the stored version carries real content
// so claim-time derivation can produce the canonical expected block.
const seedManagedWorld = (extraEvents: ReadonlyArray<SeedEvent> = []) =>
  Effect.gen(function* () {
    yield* seedProject();
    yield* seedThread();
    yield* seedVersion({
      contentSha256: skillContentSha256,
      contentJson: JSON.stringify(skillContent),
    });
    yield* seedEvent({
      sequence: THREAD_CREATED_SEQUENCE,
      eventType: "thread.created",
      payload: threadCreatedPayload(),
    });
    yield* seedEvent({
      sequence: INPUT_SEQUENCE,
      eventType: "thread.message-sent",
      payload: messageSentPayload(messageId, "user", skillContext),
    });
    yield* seedEvent({
      sequence: 21,
      eventType: "thread.turn-start-requested",
      payload: { threadId, messageId, createdAt: NOW },
    });
    for (const extra of extraEvents) yield* seedEvent(extra);
  });

const submission = (
  textBlocks: ReadonlyArray<string>,
  routeConfigSha256: string = ROUTE_SHA,
): ProjectSkillTrialSubmission => ({
  sessionGeneration: 3,
  nativeSessionId: "native-session-1",
  providerInstanceId: claudeInstanceId,
  driverKind: claudeDriverKind,
  submissionCandidate: { textBlocks, routeConfigSha256 },
});

describe("ProjectSkillTrialDelivery.resolveInput", () => {
  test("resolves the canonical user message, never its paired or re-emitted request", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedTrialWorld([
        {
          sequence: 22,
          eventType: "thread.turn-start-requested",
          payload: { threadId, messageId, createdAt: NOW },
        },
        // Another message under a different id must not shift the binding.
        {
          sequence: 30,
          eventType: "thread.message-sent",
          payload: messageSentPayload(MessageId.make("message-2")),
        },
      ]);

      const resolved = yield* service.resolveInput({ threadId, messageId });
      assert.ok(Option.isSome(resolved));
      if (Option.isNone(resolved)) return;
      assert.deepEqual(resolved.value, expectedIdentity);
      assert.ok(Object.isFrozen(resolved.value));
    }));

  test("resolves durable use selection and stamp from the canonical message", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedTrialWorld();
      yield* seedEvent({
        sequence: 31,
        eventType: "thread.message-sent",
        payload: messageSentPayload(MessageId.make("message-use"), "user", {
          version: 1,
          records: [
            managedRecord("ctx-use", {
              ref,
              mode: "use",
              admittedSkillStateSeq: 2,
              selectedScriptIds: ["lint", "test"],
            }),
          ],
        }),
      });
      const useMessageId = MessageId.make("message-use");
      const resolved = yield* service.resolveInput({ threadId, messageId: useMessageId });
      assert.ok(Option.isSome(resolved));
      if (Option.isNone(resolved)) return;
      assert.equal(resolved.value.mode, "use");
      assert.deepEqual(resolved.value.selectedScriptIds, ["lint", "test"]);
      assert.equal(resolved.value.admittedSkillStateSeq, 2);
    }));

  test("binds the latest incarnation and ignores a same-id message from an older one", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedTrialWorld([
        { sequence: 30, eventType: "thread.deleted", payload: {} },
        {
          sequence: 40,
          eventType: "thread.created",
          payload: threadCreatedPayload(),
        },
        {
          sequence: 50,
          eventType: "thread.message-sent",
          payload: messageSentPayload(messageId),
        },
      ]);

      const resolved = yield* service.resolveInput({ threadId, messageId });
      assert.ok(Option.isSome(resolved));
      if (Option.isNone(resolved)) return;
      // Sequence 50 inside the new incarnation — never the stale 20.
      assert.equal(resolved.value.inputEventSequence, 50);
      assert.equal(resolved.value.admittedSkillStateSeq, 0);
    }));

  test("answers none when the same-id message only exists before recreation", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedTrialWorld([
        { sequence: 30, eventType: "thread.deleted", payload: {} },
        {
          sequence: 40,
          eventType: "thread.created",
          payload: threadCreatedPayload(),
        },
      ]);

      const resolved = yield* service.resolveInput({ threadId, messageId });
      assert.ok(Option.isNone(resolved));
    }));

  test("answers none for a message appended after the incarnation ended", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedProject();
      yield* seedThread();
      yield* seedEvent({
        sequence: THREAD_CREATED_SEQUENCE,
        eventType: "thread.created",
        payload: threadCreatedPayload(),
      });
      yield* seedEvent({ sequence: 15, eventType: "thread.deleted", payload: {} });
      yield* seedEvent({
        sequence: INPUT_SEQUENCE,
        eventType: "thread.message-sent",
        payload: messageSentPayload(messageId),
      });

      const resolved = yield* service.resolveInput({ threadId, messageId });
      assert.ok(Option.isNone(resolved));
    }));

  const resolveRejections: ReadonlyArray<{
    readonly name: string;
    readonly arrange?: ReadonlyArray<SeedEvent>;
    readonly payload?: (base: ReturnType<typeof messageSentPayload>) => Record<string, unknown>;
  }> = [
    {
      name: "a duplicated canonical message id",
      arrange: [
        {
          sequence: 30,
          eventType: "thread.message-sent",
          payload: messageSentPayload(messageId),
        },
      ],
    },
    {
      name: "two managed records",
      payload: (base) => ({
        ...base,
        context: { version: 1, records: [managedRecord(), managedRecord("ctx-skill-2")] },
      }),
    },
    {
      name: "a malformed managed payload",
      payload: (base) => ({
        ...base,
        context: { version: 1, records: [managedRecord("ctx-skill", { no: "ref" })] },
      }),
    },
    {
      name: "a managed record without its payload envelope",
      payload: (base) => ({
        ...base,
        context: {
          version: 1,
          records: [{ version: 1, contextId: "ctx-skill", kind: "project-skill", label: "x" }],
        },
      }),
    },
    {
      name: "an unstamped managed payload",
      payload: (base) => ({
        ...base,
        context: { version: 1, records: [managedRecord("ctx-skill", { ref, mode: "trial" })] },
      }),
    },
    {
      name: "a use-mode managed payload without durable selection",
      payload: (base) => ({
        ...base,
        context: {
          version: 1,
          records: [managedRecord("ctx-skill", { ref, mode: "use", admittedSkillStateSeq: 0 })],
        },
      }),
    },
    {
      name: "memory mixed into the context",
      payload: (base) => ({
        ...base,
        context: { version: 1, records: [managedRecord(), memoryRecord] },
      }),
    },
    {
      // The malformed memory envelope would be dropped by compatibility
      // decoding; the raw declaration is refused before that can happen.
      name: "a malformed memory record beside a valid skill record",
      payload: (base) => ({
        ...base,
        context: {
          version: 1,
          records: [
            managedRecord(),
            { version: 1, contextId: "ctx-memory", kind: "memory", label: "memory" },
          ],
        },
      }),
    },
    {
      name: "no managed record at all",
      payload: (base) => ({
        ...base,
        context: { version: 1, records: [imageRecord] },
      }),
    },
    {
      name: "an assistant message under the id",
      payload: (base) => ({ ...base, role: "assistant" }),
    },
    {
      name: "a payload naming a different thread",
      payload: (base) => ({ ...base, threadId: ThreadId.make("thread-9") }),
    },
    {
      name: "a managed ref bound to another project",
      payload: (base) => ({
        ...base,
        context: {
          version: 1,
          records: [
            managedRecord("ctx-skill", {
              ref: { ...ref, projectId: ProjectId.make("project-9") },
              mode: "trial",
              admittedSkillStateSeq: 0,
            }),
          ],
        },
      }),
    },
  ];

  it.effect.each(resolveRejections)("answers none and holds for $name", (row) =>
    withDeliveryDatabase(
      Effect.gen(function* () {
        const service = yield* delivery;
        yield* seedTrialWorld(row.arrange ?? []);
        if (row.payload !== undefined) {
          const sql = yield* sqlClient;
          const base = messageSentPayload(messageId);
          yield* sql`
            UPDATE orchestration_events SET payload_json = ${JSON.stringify(row.payload(base))}
            WHERE sequence = ${INPUT_SEQUENCE}
          `;
        }
        const resolved = yield* service.resolveInput({ threadId, messageId });
        assert.ok(Option.isNone(resolved));
        assert.deepEqual(yield* service.claim({ threadId, messageId }), {
          _tag: "Held",
          reason: "unavailable",
        });
        assert.equal(yield* inputsCount, 0);
      }),
    ),
  );

  test("refuses the ambiguous target when a later row claims the id but fails the envelope", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedTrialWorld([
        {
          sequence: 30,
          eventType: "thread.message-sent",
          // Same target id, same user role — but no `streaming`, so the
          // persisted envelope cannot decode. The valid earlier row must not
          // be silently accepted around it.
          payload: {
            threadId,
            messageId,
            role: "user",
            text: "try the candidate",
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      ]);

      assert.ok(Option.isNone(yield* service.resolveInput({ threadId, messageId })));
      assert.deepEqual(yield* service.claim({ threadId, messageId }), {
        _tag: "Held",
        reason: "unavailable",
      });
      assert.equal(yield* inputsCount, 0);
    }));

  const envelopeCorruptions: ReadonlyArray<{
    readonly name: string;
    readonly sequence: number;
    readonly metadata: string;
  }> = [
    {
      name: "corrupt metadata on the canonical message",
      sequence: INPUT_SEQUENCE,
      metadata: '{"historyImport":"invalid"}',
    },
    {
      name: "unparseable metadata on the canonical message",
      sequence: INPUT_SEQUENCE,
      metadata: "not json",
    },
    {
      name: "corrupt metadata on the latest creation",
      sequence: THREAD_CREATED_SEQUENCE,
      metadata: '{"historyImport":"invalid"}',
    },
    {
      name: "unparseable metadata on the latest creation",
      sequence: THREAD_CREATED_SEQUENCE,
      metadata: "not json",
    },
  ];

  it.effect.each(envelopeCorruptions)("answers none and holds with $name", (row) =>
    withDeliveryDatabase(
      Effect.gen(function* () {
        const service = yield* delivery;
        const sql = yield* sqlClient;
        yield* seedTrialWorld();
        yield* sql`
          UPDATE orchestration_events SET metadata_json = ${row.metadata}
          WHERE sequence = ${row.sequence}
        `;

        assert.ok(Option.isNone(yield* service.resolveInput({ threadId, messageId })));
        assert.deepEqual(yield* service.claim({ threadId, messageId }), {
          _tag: "Held",
          reason: "unavailable",
        });
        assert.equal(yield* inputsCount, 0);
      }),
    ),
  );
});

describe("ProjectSkillTrialDelivery.claim", () => {
  test("enters once with the definite token and the frozen canonical identity", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedTrialWorld();

      const outcome = yield* service.claim({ threadId, messageId });
      assert.equal(outcome._tag, "Entered");
      if (outcome._tag !== "Entered") return;
      assert.equal(outcome.attemptToken.length > 0, true);
      assert.deepEqual(outcome.identity, expectedIdentity);
      assert.ok(Object.isFrozen(outcome.identity));

      const rows = yield* rawInputRows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.inputEventSequence, INPUT_SEQUENCE);
      assert.equal(rows[0]?.inputIncarnation, THREAD_CREATED_SEQUENCE);
      assert.equal(rows[0]?.delivery, "unknown");
      assert.equal(rows[0]?.window, "open");
    }));

  test("answers the fixed held on every repeat — never a second entry", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedTrialWorld();

      const first = yield* service.claim({ threadId, messageId });
      assert.equal(first._tag, "Entered");
      if (first._tag !== "Entered") return;

      assert.deepEqual(yield* service.claim({ threadId, messageId }), {
        _tag: "Held",
        reason: "unavailable",
      });
      yield* service.settle({ entered: first, providerDriverKind: driverKind });
      // Even after acceptance the fixed answer stands: no resend.
      assert.deepEqual(yield* service.claim({ threadId, messageId }), {
        _tag: "Held",
        reason: "unavailable",
      });
      assert.equal(yield* inputsCount, 1);
    }));

  test("holds when no canonical input exists — never an ordinary send", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedProject();
      yield* seedThread();

      // No events at all: resolve misses and the claim can never degrade to
      // an ordinary path.
      assert.deepEqual(yield* service.claim({ threadId, messageId }), {
        _tag: "Held",
        reason: "unavailable",
      });
      assert.equal(yield* inputsCount, 0);
    }));

  test("derives the durable stamp and ref: a moved stamp or deleted ref is held", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      const sql = yield* sqlClient;
      yield* seedTrialWorld();

      // The admitted stamp no longer proves the live state sequence.
      yield* sql`
        INSERT INTO project_skill_state (project_id, seq) VALUES (${projectId}, 1)
        ON CONFLICT(project_id) DO UPDATE SET seq = seq + 1
      `;
      assert.deepEqual(yield* service.claim({ threadId, messageId }), {
        _tag: "Held",
        reason: "unavailable",
      });
      assert.equal(yield* inputsCount, 0);
    }));

  test("a record whose ref no longer matches the live candidate is held", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      const sql = yield* sqlClient;
      yield* seedTrialWorld();
      yield* sql`DELETE FROM project_skill_versions WHERE skill_id = ${skillId}`;

      assert.deepEqual(yield* service.claim({ threadId, messageId }), {
        _tag: "Held",
        reason: "unavailable",
      });
      assert.equal(yield* inputsCount, 0);
    }));
});

describe("ProjectSkillTrialDelivery.settle", () => {
  test("settles the captured token and routed driver; a forged token leaves unknown", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedTrialWorld();
      const claim = yield* service.claim({ threadId, messageId });
      assert.equal(claim._tag, "Entered");
      if (claim._tag !== "Entered") return;

      // A caller-shaped replacement token is not the captured settlement
      // secret: the row stays unknown.
      yield* service.settle({
        entered: { ...claim, attemptToken: "forged-token" },
        providerDriverKind: driverKind,
      });
      assert.equal((yield* rawInputRows)[0]?.delivery, "unknown");
      assert.equal((yield* rawInputRows)[0]?.providerDriverKind, null);

      yield* service.settle({ entered: claim, providerDriverKind: driverKind });
      const rows = yield* rawInputRows;
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.providerDriverKind, driverKind);

      // already-final is terminal success: a repeated settle stays quiet.
      yield* service.settle({ entered: claim, providerDriverKind: driverKind });
      assert.equal((yield* rawInputRows)[0]?.delivery, "provider-accepted");
    }));

  // One schedule over the retained, tombstoned original claim and a forged
  // captured project: the settlement transaction is held open, the claim row's
  // immutable project is fenced while another project stays live, and on
  // release the same token/project row — not the forged project — is settled.
  test("fences the immutable project of a tombstoned claim and settles only that row", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      const repo = yield* ProjectSkillTrialRepository;
      const fence = yield* ProjectSkillMutationFence;
      const sql = yield* sqlClient;
      const forgedProjectId = ProjectId.make("project-forged");
      yield* seedTrialWorld();
      const claim = yield* service.claim({ threadId, messageId });
      assert.equal(claim._tag, "Entered");
      if (claim._tag !== "Entered") return;

      // Deleting the version tombstones the claim: its ref payload is purged,
      // the ownership row — project, token, delivery — is retained.
      yield* sql`DELETE FROM project_skill_versions WHERE skill_id = ${skillId}`;
      const retained = yield* ownershipRow;
      assert.equal(retained?.skillId, null);
      assert.equal(retained?.projectId, projectId);
      assert.equal(retained?.attemptToken, claim.attemptToken);
      assert.equal(retained?.delivery, "unknown");

      // The captured identity is forged to another project. Its own token is
      // real, but the repository rechecks token and project in SQL: the forged
      // project is not-owned while delivery is still unknown.
      const forged = { ...claim, identity: { ...claim.identity, projectId: forgedProjectId } };
      const wrongProject = yield* repo.settleDelivery({
        threadId,
        messageId,
        projectId: forgedProjectId,
        attemptToken: claim.attemptToken,
        providerDriverKind: driverKind,
        now: NOW,
      });
      assert.equal(wrongProject.status, "not-owned");
      assert.equal((yield* ownershipRow)?.delivery, "unknown");

      const tokenBefore = fence.acquire(projectId);
      assert.ok(tokenBefore !== undefined);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const original = sql.withTransaction;
      Object.assign(sql, {
        withTransaction: <A, E, R>(inner: Effect.Effect<A, E, R>) =>
          original(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(inner),
            ),
          ),
      });
      const settling = yield* service
        .settle({ entered: forged, providerDriverKind: driverKind })
        .pipe(
          Effect.ensuring(Effect.sync(() => Object.assign(sql, { withTransaction: original }))),
          Effect.forkChild,
        );
      yield* Deferred.await(entered);

      // Parked inside the real settlement transaction: only the claim row's
      // immutable project is fenced; the forged one is untouched and live.
      yield* Effect.sync(() => {
        const counters = fence.snapshotCounters();
        assert.equal(counters.projectPending(projectId), 1);
        assert.equal(counters.projectPending(forgedProjectId), 0);
        assert.equal(counters.projectRevision(forgedProjectId), 0);
        assert.equal(fence.acquire(projectId), undefined);
        assert.ok(fence.acquire(forgedProjectId) !== undefined);
        assert.equal(fence.holds(tokenBefore!), false);
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(settling);

      // Released: the same token/project row settled, still tombstoned, and
      // the fence is open again.
      const settled = yield* ownershipRow;
      assert.equal(settled?.projectId, projectId);
      assert.equal(settled?.attemptToken, claim.attemptToken);
      assert.equal(settled?.delivery, "provider-accepted");
      assert.equal(settled?.providerDriverKind, driverKind);
      assert.equal(settled?.skillId, null);
      assert.equal(fence.snapshotCounters().projectPending(projectId), 0);
      assert.ok(fence.acquire(projectId) !== undefined);
    }));
});

describe("ProjectSkillTrialDelivery managed-send evidence", () => {
  test("claim carries the canonical expected block derived from stored content", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedManagedWorld();

      const claim = yield* service.claim({ threadId, messageId });
      assert.equal(claim._tag, "Entered");
      if (claim._tag !== "Entered") return;
      // Ephemeral, never persisted — the row itself stays label-free.
      assert.equal(claim.expectedBlock, expectedBlock);
      assert.equal((yield* rawInputRows)[0]?.managedSendJson, null);
    }));

  test("a claim without a derivable block stays ordinary — never caller-shaped", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedTrialWorld();

      const claim = yield* service.claim({ threadId, messageId });
      assert.equal(claim._tag, "Entered");
      if (claim._tag !== "Entered") return;
      // The fixture content is unverifiable: no expected block, so the
      // matched submission still yields no label — delivery stays ordinary.
      assert.equal(claim.expectedBlock, undefined);
      yield* service.settle({
        entered: claim,
        providerDriverKind: claudeDriverKind,
        providerInstanceId: claudeInstanceId,
        submission: submission([expectedBlock]),
      });
      const rows = yield* rawInputRows;
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.managedSendJson, null);
    }));

  test("a matched observation pins the evidence inside the acceptance transaction", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedManagedWorld();
      const claim = yield* service.claim({ threadId, messageId });
      assert.equal(claim._tag, "Entered");
      if (claim._tag !== "Entered") return;

      yield* service.settle({
        entered: claim,
        providerDriverKind: claudeDriverKind,
        providerInstanceId: claudeInstanceId,
        submission: submission([`prefix\n${expectedBlock}\nsuffix`]),
      });

      const rows = yield* rawInputRows;
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.providerDriverKind, claudeDriverKind);
      assert.equal(rows[0]?.managedSendJson, expectedEvidenceJson);
      // Digests and ids only — the block text itself is never persisted.
      assert.equal(rows[0]?.managedSendJson?.includes(expectedBlock), false);
    }));

  test("duplicates and splits across separate blocks never fabricate a match", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedManagedWorld();
      let seq = 50;
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly blocks: ReadonlyArray<string>;
        readonly expectedJson: string | null;
      }> = [
        {
          name: "one occurrence inside one real block",
          blocks: [`pre\n${expectedBlock}\npost`],
          expectedJson: expectedEvidenceJson,
        },
        {
          name: "duplicated across two blocks",
          blocks: [expectedBlock, expectedBlock],
          expectedJson: null,
        },
        {
          name: "duplicated inside one block",
          blocks: [`${expectedBlock}\n${expectedBlock}`],
          expectedJson: null,
        },
        {
          name: "split across two blocks",
          blocks: [expectedBlock.slice(0, 40), expectedBlock.slice(40)],
          expectedJson: null,
        },
        { name: "no text blocks", blocks: [], expectedJson: null },
      ];
      for (const kase of cases) {
        const mid = MessageId.make(`m-${seq}`);
        yield* seedEvent({
          sequence: seq,
          eventType: "thread.message-sent",
          payload: messageSentPayload(mid, "user", skillContext),
        });
        yield* seedEvent({
          sequence: seq + 1,
          eventType: "thread.turn-start-requested",
          payload: { threadId, messageId: mid, createdAt: NOW },
        });
        const claim = yield* service.claim({ threadId, messageId: mid });
        assert.equal(claim._tag, "Entered", kase.name);
        if (claim._tag !== "Entered") return;
        yield* service.settle({
          entered: claim,
          providerDriverKind: claudeDriverKind,
          providerInstanceId: claudeInstanceId,
          submission: submission(kase.blocks),
        });
        const rows = yield* rawInputRows;
        const row = rows.find((entry) => entry.messageId === `m-${seq}`);
        assert.equal(row?.delivery, "provider-accepted", kase.name);
        assert.equal(row?.managedSendJson, kase.expectedJson, kase.name);
        seq += 10;
      }
    }));

  test("an empty expected block never reaches the counter and stays unlabelled", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedManagedWorld();
      const claim = yield* service.claim({ threadId, messageId });
      assert.equal(claim._tag, "Entered");
      if (claim._tag !== "Entered") return;

      // An empty needle would loop the occurrence counter forever; the guard
      // must reject it before matching, and the settle still lands ordinary.
      yield* service.settle({
        entered: { ...claim, expectedBlock: "" },
        providerDriverKind: claudeDriverKind,
        providerInstanceId: claudeInstanceId,
        submission: submission([expectedBlock]),
      });
      const rows = yield* rawInputRows;
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.managedSendJson, null);
    }));

  test("route, session, generation, and instance mismatches stay unlabelled", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedManagedWorld();
      let seq = 50;
      const base = submission([expectedBlock]);
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly providerInstanceId?: ProviderInstanceId;
        readonly providerDriverKind?: ProviderDriverKind;
        readonly submission?: ProjectSkillTrialSubmission;
      }> = [
        { name: "no observation at all", providerInstanceId: claudeInstanceId },
        { name: "no captured instance", submission: base },
        {
          name: "observed instance differs from the enter route",
          providerInstanceId: ProviderInstanceId.make("other-instance"),
          submission: base,
        },
        {
          name: "observed route driver differs",
          providerInstanceId: claudeInstanceId,
          submission: { ...base, driverKind: ProviderDriverKind.make("codex") },
        },
        {
          name: "settled driver is not Claude",
          providerInstanceId: claudeInstanceId,
          providerDriverKind: ProviderDriverKind.make("codex"),
          submission: { ...base, driverKind: ProviderDriverKind.make("codex") },
        },
        {
          name: "blank native session id",
          providerInstanceId: claudeInstanceId,
          submission: { ...base, nativeSessionId: "   " },
        },
        {
          name: "missing native session id",
          providerInstanceId: claudeInstanceId,
          submission: { ...base, nativeSessionId: undefined },
        },
        {
          name: "fractional session generation",
          providerInstanceId: claudeInstanceId,
          submission: { ...base, sessionGeneration: 1.5 },
        },
        {
          name: "negative session generation",
          providerInstanceId: claudeInstanceId,
          submission: { ...base, sessionGeneration: -1 },
        },
        {
          name: "missing submission candidate",
          providerInstanceId: claudeInstanceId,
          submission: {
            sessionGeneration: 3,
            nativeSessionId: "native-session-1",
            providerInstanceId: claudeInstanceId,
            driverKind: claudeDriverKind,
          },
        },
        {
          name: "malformed route digest",
          providerInstanceId: claudeInstanceId,
          submission: submission([expectedBlock], "not-a-sha"),
        },
        {
          name: "uppercase route digest is not lowercase hex",
          providerInstanceId: claudeInstanceId,
          submission: submission([expectedBlock], "D".repeat(64)),
        },
      ];
      for (const kase of cases) {
        const mid = MessageId.make(`m-${seq}`);
        yield* seedEvent({
          sequence: seq,
          eventType: "thread.message-sent",
          payload: messageSentPayload(mid, "user", skillContext),
        });
        yield* seedEvent({
          sequence: seq + 1,
          eventType: "thread.turn-start-requested",
          payload: { threadId, messageId: mid, createdAt: NOW },
        });
        const claim = yield* service.claim({ threadId, messageId: mid });
        assert.equal(claim._tag, "Entered", kase.name);
        if (claim._tag !== "Entered") return;
        yield* service.settle({
          entered: claim,
          providerDriverKind: kase.providerDriverKind ?? claudeDriverKind,
          ...(kase.providerInstanceId !== undefined
            ? { providerInstanceId: kase.providerInstanceId }
            : {}),
          ...(kase.submission !== undefined ? { submission: kase.submission } : {}),
        });
        const rows = yield* rawInputRows;
        const row = rows.find((entry) => entry.messageId === `m-${seq}`);
        // Ordinary accepted delivery is preserved — only the label is lost.
        assert.equal(row?.delivery, "provider-accepted", kase.name);
        assert.equal(row?.managedSendJson, null, kase.name);
        seq += 10;
      }
    }));

  test("an unswept next-input boundary keeps even a matched submission unlabelled", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedManagedWorld();
      const claim = yield* service.claim({ threadId, messageId });
      assert.equal(claim._tag, "Entered");
      if (claim._tag !== "Entered") return;

      // The boundary lands after the claim but before the settle — the
      // stored flag still reads open, yet the label is already refused.
      yield* seedEvent({
        sequence: 50,
        eventType: "thread.message-sent",
        payload: messageSentPayload(MessageId.make("message-2"), "user", skillContext),
      });
      yield* service.settle({
        entered: claim,
        providerDriverKind: claudeDriverKind,
        providerInstanceId: claudeInstanceId,
        submission: submission([expectedBlock]),
      });
      const rows = yield* rawInputRows;
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.managedSendJson, null);
    }));

  test("a send without capture stays ordinary and can never be enriched later", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedManagedWorld();
      const claim = yield* service.claim({ threadId, messageId });
      assert.equal(claim._tag, "Entered");
      if (claim._tag !== "Entered") return;

      yield* service.settle({ entered: claim, providerDriverKind: claudeDriverKind });
      let rows = yield* rawInputRows;
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.managedSendJson, null);

      // A late capture on an already-final row changes nothing.
      yield* service.settle({
        entered: claim,
        providerDriverKind: claudeDriverKind,
        providerInstanceId: claudeInstanceId,
        submission: submission([expectedBlock]),
      });
      rows = yield* rawInputRows;
      assert.equal(rows[0]?.managedSendJson, null);
    }));
});

describe("ProjectSkillTrialDelivery error boundary", () => {
  test("an ordinary failure is held or fixed; a mixed interrupt cause is returned whole", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      const sql = yield* sqlClient;
      yield* seedTrialWorld();

      const original = sql.withTransaction;
      Object.assign(sql, {
        withTransaction: () =>
          Effect.fail(new PersistenceSqlError({ operation: "Foreign.op", detail: "foreign" })),
      });
      const resolveFailure = yield* service
        .resolveInput({ threadId, messageId })
        .pipe(
          Effect.flip,
          Effect.ensuring(Effect.sync(() => Object.assign(sql, { withTransaction: original }))),
        );
      assert.ok(resolveFailure instanceof PersistenceSqlError);
      assert.equal(resolveFailure.operation, "ProjectSkillTrialDelivery.resolveInput");
      assert.equal(resolveFailure.detail, undefined);

      Object.assign(sql, {
        withTransaction: () =>
          Effect.fail(new PersistenceSqlError({ operation: "Foreign.op", detail: "foreign" })),
      });
      const held = yield* service
        .claim({ threadId, messageId })
        .pipe(
          Effect.ensuring(Effect.sync(() => Object.assign(sql, { withTransaction: original }))),
        );
      assert.deepEqual(held, { _tag: "Held", reason: "unavailable" });

      // A mixed fail+interrupt cause is returned whole: the Fail leg is
      // retained, never cast away or filtered to interrupts only. One
      // sabotage window covers claim and settle alike.
      const mixedCause = Cause.combine(
        Cause.fail(new PersistenceSqlError({ operation: "Foreign.op", detail: "foreign" })),
        Cause.interrupt(),
      );
      Object.assign(sql, { withTransaction: original });
      const entered = yield* service.claim({ threadId, messageId });
      assert.equal(entered._tag, "Entered");
      if (entered._tag !== "Entered") return;

      Object.assign(sql, { withTransaction: () => Effect.failCause(mixedCause) });
      const [exit, settleExit] = yield* Effect.all([
        service.claim({ threadId, messageId }).pipe(Effect.exit),
        service.settle({ entered, providerDriverKind: driverKind }).pipe(Effect.exit),
      ]).pipe(
        Effect.ensuring(Effect.sync(() => Object.assign(sql, { withTransaction: original }))),
      );
      assert.ok(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.deepEqual(exit.cause, mixedCause);
      }
      assert.ok(Exit.isFailure(settleExit));
      if (Exit.isFailure(settleExit)) {
        assert.deepEqual(settleExit.cause, mixedCause);
      }
    }));

  test("an ordinary settle failure leaves unknown and finishes on the fixed diagnostic", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      const sql = yield* sqlClient;
      yield* seedTrialWorld();
      const claim = yield* service.claim({ threadId, messageId });
      assert.equal(claim._tag, "Entered");
      if (claim._tag !== "Entered") return;

      const original = sql.withTransaction;
      Object.assign(sql, {
        withTransaction: () =>
          Effect.fail(new PersistenceSqlError({ operation: "Foreign.op", detail: "foreign" })),
      });
      // Ordinary failure: the effect still completes (void), and the durable
      // row keeps its honest unknown state.
      yield* service
        .settle({ entered: claim, providerDriverKind: driverKind })
        .pipe(
          Effect.ensuring(Effect.sync(() => Object.assign(sql, { withTransaction: original }))),
        );
      assert.equal((yield* rawInputRows)[0]?.delivery, "unknown");

      yield* service.settle({ entered: claim, providerDriverKind: driverKind });
      assert.equal((yield* rawInputRows)[0]?.delivery, "provider-accepted");
    }));

  // The settlement's preliminary immutable-project read is a plain SELECT that
  // opens no transaction, so sabotaging `withTransaction` never reaches it:
  // the fault is armed on that SELECT itself.
  test("a fault at the settlement's own project SELECT stays fixed or returns whole, and writes nothing", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedTrialWorld();
      const claim = yield* service.claim({ threadId, messageId });
      assert.equal(claim._tag, "Entered");
      if (claim._tag !== "Entered") return;

      const injected = new PersistenceSqlError({ operation: "Foreign.op", detail: "foreign" });
      sqlFaults.claimProjectSelect = Cause.fail(injected);
      yield* service.settle({ entered: claim, providerDriverKind: driverKind });
      assert.equal((yield* rawInputRows)[0]?.delivery, "unknown");

      const mixed = Cause.combine(Cause.fail(injected), Cause.interrupt());
      sqlFaults.claimProjectSelect = mixed;
      const exit = yield* Effect.exit(
        service.settle({ entered: claim, providerDriverKind: driverKind }),
      );
      if (!Exit.isFailure(exit)) {
        return assert.fail("expected the mixed cause to fail the settle");
      }
      assert.deepEqual(exit.cause, mixed);
      assert.ok(Cause.hasInterrupts(exit.cause));
      assert.deepEqual(Cause.findErrorOption(exit.cause), Option.some(injected));
      const rows = yield* rawInputRows;
      assert.equal(rows[0]?.delivery, "unknown");
      assert.equal(rows[0]?.providerDriverKind, null);
      assert.equal(rows[0]?.managedSendJson, null);

      // Disarmed, the same token still settles: nothing durable moved.
      sqlFaults.claimProjectSelect = undefined;
      yield* service.settle({ entered: claim, providerDriverKind: driverKind });
      assert.equal((yield* rawInputRows)[0]?.delivery, "provider-accepted");
    }));
});

// A scripted world for the use handoff: the target plan is fixed, the thread is
// live, and each route preview reports the next scripted instance while every
// other returned field stays identical. A call past the script repeats its last
// instance.
const targetPlan: SelectedChecksTargetPlan = {
  threadId,
  projectId,
  threadCreatedAt: NOW,
  workspaceRoot: "/tmp/project",
  worktreePath: null,
  cwd: "/tmp/project",
  shell: "/bin/sh",
  envSha256: SHA,
  platform: "linux",
  arch: "x64",
  planned: [{ scriptId: "lint", commandSha256: SHA }],
};

const scriptedUseWorld = (instances: ReadonlyArray<ProviderInstanceId>) => {
  let previewCalls = 0;
  const world: DeliveryWorld = {
    resolveTargetPlan: () => Effect.succeed(targetPlan),
    // Delivery only checks that the live thread shell exists.
    getThreadShellById: () => Effect.succeed(Option.some({} as never)),
    previewSubmissionRoute: () =>
      Effect.sync(() => {
        const providerInstanceId = instances[Math.min(previewCalls, instances.length - 1)]!;
        previewCalls += 1;
        return {
          providerInstanceId,
          driverKind: claudeDriverKind,
          routePreview: {
            sessionGeneration: 3,
            nativeSessionId: "native-session-1",
            routeConfigSha256: ROUTE_SHA,
          },
        };
      }),
  };
  return { world, previewCalls: () => previewCalls };
};

const handoffMessageId = MessageId.make("message-use-handoff");

// The canonical durable use input: mode use, the stamp, and the selection.
const seedUseInput = () =>
  Effect.gen(function* () {
    yield* seedTrialWorld();
    yield* seedEvent({
      sequence: 31,
      eventType: "thread.message-sent",
      payload: messageSentPayload(handoffMessageId, "user", {
        version: 1,
        records: [
          managedRecord("ctx-use", {
            ref,
            mode: "use",
            admittedSkillStateSeq: 0,
            selectedScriptIds: ["lint"],
          }),
        ],
      }),
    });
  });

describe("ProjectSkillTrialDelivery.useHandoff first route identity", () => {
  const instanceA = ProviderInstanceId.make("claude-a");
  const instanceB = ProviderInstanceId.make("claude-b");

  // The first observed route is A although B is intended; the second preview
  // reads B and every other returned field is identical. Comparing the second
  // preview with the first through the intended instance would accept this.
  const movedAfterFirst = scriptedUseWorld([instanceA, instanceB]);
  test(
    "holds when the first route's actual instance is not the intended one",
    () =>
      Effect.gen(function* () {
        const service = yield* delivery;
        yield* seedUseInput();
        const outcome = yield* service.useHandoff({
          threadId,
          messageId: handoffMessageId,
          intendedProviderInstanceId: instanceB,
          sendTurn: { threadId, input: "use the skill" },
        });
        assert.equal(outcome._tag, "Held");
        // Refused on the first route itself, before its facts were used.
        assert.equal(movedAfterFirst.previewCalls(), 1);
        assert.equal(yield* inputsCount, 0);
      }),
    movedAfterFirst.world,
  );

  const unchangedB = scriptedUseWorld([instanceB, instanceB]);
  test(
    "hands off when the first route is the intended instance and stays so",
    () =>
      Effect.gen(function* () {
        const service = yield* delivery;
        yield* seedUseInput();
        const outcome = yield* service.useHandoff({
          threadId,
          messageId: handoffMessageId,
          intendedProviderInstanceId: instanceB,
          sendTurn: { threadId, input: "use the skill" },
        });
        assert.equal(outcome._tag, "Handoff");
        if (outcome._tag !== "Handoff") return;
        assert.equal(outcome.handoff.providerInstanceId, instanceB);
        assert.equal(unchangedB.previewCalls(), 2);
        // The handoff is only assembled: nothing is claimed until entry.
        assert.equal(yield* inputsCount, 0);
      }),
    unchangedB.world,
  );
});

describe("ProjectSkillTrialDelivery.useHandoff", () => {
  test("held when the canonical input is trial-only", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedTrialWorld();
      const outcome = yield* service.useHandoff({
        threadId,
        messageId,
        intendedProviderInstanceId: ProviderInstanceId.make("claude-personal"),
        sendTurn: { threadId, input: "use the skill" },
      });
      assert.equal(outcome._tag, "Held");
    }));

  test("held when SelectedChecks cannot resolve the durable script ids", () =>
    Effect.gen(function* () {
      const service = yield* delivery;
      yield* seedTrialWorld();
      yield* seedEvent({
        sequence: 31,
        eventType: "thread.message-sent",
        payload: messageSentPayload(MessageId.make("message-use-handoff"), "user", {
          version: 1,
          records: [
            managedRecord("ctx-use", {
              ref,
              mode: "use",
              admittedSkillStateSeq: 0,
              selectedScriptIds: ["lint"],
            }),
          ],
        }),
      });
      const outcome = yield* service.useHandoff({
        threadId,
        messageId: MessageId.make("message-use-handoff"),
        intendedProviderInstanceId: ProviderInstanceId.make("claude-personal"),
        sendTurn: { threadId, input: "use the skill" },
      });
      assert.equal(outcome._tag, "Held");
    }));
});

describe("ProjectSkillTrialDelivery default reference", () => {
  it.effect("resolves nothing, holds every claim, and settles nothing", () =>
    Effect.gen(function* () {
      // Unprovided: the Context.Reference default is the fail-closed service.
      const service = yield* ProjectSkillTrialDelivery;
      assert.ok(Option.isNone(yield* service.resolveInput({ threadId, messageId })));
      assert.deepEqual(yield* service.claim({ threadId, messageId }), {
        _tag: "Held",
        reason: "unavailable",
      });
      yield* service.settle({
        entered: { _tag: "Entered", identity: expectedIdentity, attemptToken: "t" },
        providerDriverKind: driverKind,
      });
    }),
  );
});
