// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  ComposerContextId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProjectSkillId,
  ProviderInstanceId,
  ThreadId,
  canonicalProjectSkillContentJson,
  renderProjectSkillBlock,
} from "@t3tools/contracts";
import type {
  ComposerContextRecord,
  ProjectSkillContent,
  ProjectSkillVersionRef,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as OrchestrationCommandReceipts from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectSkillRepository, layer as skillsLayer } from "../../persistence/ProjectSkills.ts";
import { layer as trialsLayer } from "../../persistence/ProjectSkillTrials.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { layer as restartContinuationsLayer } from "../../restartContinuations.ts";
import {
  PROJECT_SKILL_SEND_REJECTION_DETAIL,
  ProjectSkillSendGate,
  layer as sendGateLayer,
} from "../../skills/ProjectSkillSendGate.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ServerConfig } from "../../config.ts";

type SendGateLayer = typeof sendGateLayer;
type ProjectionThreadMessageRepositoryLayer = typeof ProjectionThreadMessageRepositoryLive;

// The gate is merged into the base first so its declared requirements surface
// on the composite, then the shared repositories it reads are provided into
// that residual — the same memoized instances the test side resolves — while
// every SqlClient requirement, the gate's included, settles on the one
// persistence provide. Passing null leaves the Reference unprovided,
// exercising the fail-closed default this composition would ship.
function makeOrchestrationLayer(
  gateLayer: SendGateLayer | null = sendGateLayer,
  messageRepositoryLayer: ProjectionThreadMessageRepositoryLayer = ProjectionThreadMessageRepositoryLive,
) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-skill-gate-test-",
  });
  const gateDeps = Layer.mergeAll(skillsLayer, trialsLayer);
  const base = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(messageRepositoryLayer),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(restartContinuationsLayer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
    Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  );
  return base.pipe(
    Layer.provideMerge(gateLayer ?? Layer.empty),
    Layer.provideMerge(gateDeps),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

function decorateProjectionThreadMessageRepositoryLayer(
  decorate: (
    repository: ProjectionThreadMessageRepositoryShape,
  ) => ProjectionThreadMessageRepositoryShape,
) {
  return Layer.effect(
    ProjectionThreadMessageRepository,
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      return decorate(repository);
    }),
  ).pipe(Layer.provide(ProjectionThreadMessageRepositoryLive));
}

const NOW = "2026-01-01T00:00:00.000Z";
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const RECEIPT_SEQUENCE = 15;
const THREAD_CREATED_SEQUENCE = 5;
const WATERMARK_SEQUENCE = 50;

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

const seedCandidate = (input: {
  readonly projectId: ProjectId;
  readonly skillId: ProjectSkillId;
  readonly threadId: ThreadId;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_skill_versions (
        skill_id, project_id, version, content_json, content_sha256,
        source_json, source_thread_id, source_receipt_sequence,
        source_thread_created_sequence, created_after_event_sequence, created_at
      )
      VALUES (
        ${input.skillId}, ${input.projectId}, 1, ${JSON.stringify(content)},
        ${contentSha256},
        ${JSON.stringify({
          type: "work",
          check: {
            threadId: input.threadId,
            threadAnchorSequence: 10,
            receiptSequence: RECEIPT_SEQUENCE,
            attemptId: "attempt-1",
            revision: 1,
            projectId: input.projectId,
            workspaceRoot: "/tmp/project",
            worktreePath: null,
            cwd: "/tmp/project",
            envSha256: SHA,
            planned: [
              { scriptId: "lint", scriptName: "Lint", commandSha256: SHA, timeoutMs: 60_000 },
            ],
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
          },
          draft: { type: "typed" },
        })},
        ${input.threadId}, ${RECEIPT_SEQUENCE}, ${THREAD_CREATED_SEQUENCE}, ${WATERMARK_SEQUENCE}, ${NOW}
      )
    `;
  });

const seed = (
  engine: OrchestrationEngineShape,
  prefix: string,
  projectId: ProjectId,
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`${prefix}-project`),
      projectId,
      title: "Gate project",
      workspaceRoot: `/tmp/${prefix}`,
      createdAt: NOW,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${prefix}-thread`),
      threadId,
      projectId,
      title: "Gate thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    });
  });

const managedSend = (projectId: ProjectId, skillId: ProjectSkillId) => {
  const ref: ProjectSkillVersionRef = { projectId, skillId, version: 1, contentSha256 };
  const block = renderProjectSkillBlock({ ref, content, mode: "trial" });
  const text = `Follow this exactly:\n${block}\nThen report back.`;
  const record: ComposerContextRecord = {
    version: 1,
    contextId: ComposerContextId.make("ctx-skill"),
    kind: "project-skill",
    label: "release",
    payload: { ref, mode: "trial", admittedSkillStateSeq: 999, forged: "extra-key" },
  };
  return { ref, text, record };
};

const turnStart = (input: {
  readonly prefix: string;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly records?: ReadonlyArray<ComposerContextRecord>;
  readonly bootstrap?: { readonly runSetupScript: false };
}) => ({
  type: "thread.turn.start" as const,
  commandId: CommandId.make(`${input.prefix}-turn`),
  threadId: input.threadId,
  message: {
    messageId: input.messageId,
    role: "user" as const,
    text: input.text,
    attachments: [],
    ...(input.records !== undefined
      ? { context: { version: 1 as const, records: input.records } }
      : {}),
  },
  runtimeMode: "approval-required" as const,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  ...(input.bootstrap !== undefined ? { bootstrap: input.bootstrap } : {}),
  createdAt: NOW,
});

const turnRequestCount = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS "n" FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
        AND event_type = 'thread.turn-start-requested'
    `;
    return rows[0]?.n ?? 0;
  });

const receiptFor = (commandId: CommandId) =>
  Effect.gen(function* () {
    const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
    return Option.getOrNull(yield* receipts.getByCommandId({ commandId }));
  });

describe("OrchestrationEngine skill send gate", () => {
  // A genuinely new managed send is authorized on the planned durable
  // text/context: the event that commits carries the server's canonical
  // records — the stamped sequence, not the client's guessed value, and none
  // of the extra keys the client attached.
  effectIt.effect("stamps the canonical server sequence on an admitted managed send", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const messages = yield* ProjectionThreadMessageRepository;
      const projectId = ProjectId.make("project-skill-gate");
      const threadId = ThreadId.make("thread-skill-gate");
      const skillId = ProjectSkillId.make("psk_engine01");
      yield* seed(engine, "sg-admit", projectId, threadId);
      yield* seedCandidate({ projectId, skillId, threadId });
      const { ref, text, record } = managedSend(projectId, skillId);
      const messageId = MessageId.make("sg-msg-admit");
      const command = turnStart({
        prefix: "sg-admit",
        threadId,
        messageId,
        text,
        records: [record],
      });

      const accepted = yield* engine.dispatch(command);

      const receipt = yield* receiptFor(command.commandId);
      expect(receipt?.status).toBe("accepted");
      expect(receipt?.resultSequence).toBe(accepted.sequence);
      const row = Option.getOrNull(
        yield* messages.getByMessageId({ messageId: command.message.messageId }),
      );
      expect(row?.threadId).toBe(threadId);
      const managed = (row?.context?.records ?? []).find(
        (record) => record.kind === "project-skill",
      );
      // The server restamped the payload: its own sequence, the exact
      // admitted ref, and nothing the client attached to the envelope.
      const managedPayload =
        managed !== undefined && "payload" in managed ? managed.payload : undefined;
      expect(managedPayload).toEqual({
        ref,
        mode: "trial",
        admittedSkillStateSeq: 0,
      });
      expect(yield* turnRequestCount(threadId)).toBe(1);
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  // Admission is re-decided inside the commit transaction: a ref the
  // preflight never saw is refused, and a ref deleted between preflight and
  // dispatch is refused again — each with the fixed detail and no events.
  effectIt.effect("rejects an unadmissible ref and a skill deleted after preflight", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const gate = yield* ProjectSkillSendGate;
      const skills = yield* ProjectSkillRepository;
      const projectId = ProjectId.make("project-skill-stale");
      const threadId = ThreadId.make("thread-skill-stale");
      const skillId = ProjectSkillId.make("psk_stale001");
      yield* seed(engine, "sg-stale", projectId, threadId);
      yield* seedCandidate({ projectId, skillId, threadId });
      const { ref, text, record } = managedSend(projectId, skillId);

      const staleRecord: ComposerContextRecord = {
        ...record,
        payload: { ref: { ...ref, contentSha256: OTHER_SHA }, mode: "trial" },
      };
      const staleCommand = turnStart({
        prefix: "sg-stale-ref",
        threadId,
        messageId: MessageId.make("sg-msg-stale"),
        text,
        records: [staleRecord],
      });
      const staleError = yield* engine.dispatch(staleCommand).pipe(Effect.flip);
      expect(staleError).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      const staleReceipt = yield* receiptFor(staleCommand.commandId);
      expect(staleReceipt?.status).toBe("rejected");
      expect(staleReceipt?.error).toContain(PROJECT_SKILL_SEND_REJECTION_DETAIL["not-admissible"]);

      const messageId = MessageId.make("sg-msg-preflight");
      const admitted = yield* gate.preflight({
        threadId,
        messageId,
        text,
        records: [record],
        bootstrap: false,
      });
      expect(admitted._tag).toBe("Admitted");
      yield* skills.deleteSkill({ projectId, skillId, expectedLatestVersion: 1 });
      const deletedCommand = turnStart({
        prefix: "sg-deleted",
        threadId,
        messageId,
        text,
        records: [record],
      });
      const deletedError = yield* engine.dispatch(deletedCommand).pipe(Effect.flip);
      expect(deletedError).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      const deletedReceipt = yield* receiptFor(deletedCommand.commandId);
      expect(deletedReceipt?.status).toBe("rejected");
      expect(deletedReceipt?.error).toContain(
        PROJECT_SKILL_SEND_REJECTION_DETAIL["not-admissible"],
      );
      expect(yield* turnRequestCount(threadId)).toBe(0);

      // A bootstrap send carrying a managed record is a structural
      // `unsupported` — the gate classifies it before any admission read.
      const bootstrapCommand = turnStart({
        prefix: "sg-bootstrap",
        threadId,
        messageId: MessageId.make("sg-msg-bootstrap"),
        text,
        records: [record],
        bootstrap: { runSetupScript: false },
      });
      const bootstrapError = yield* engine.dispatch(bootstrapCommand).pipe(Effect.flip);
      expect(bootstrapError).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      const bootstrapReceipt = yield* receiptFor(bootstrapCommand.commandId);
      expect(bootstrapReceipt?.status).toBe("rejected");
      expect(bootstrapReceipt?.error).toContain(PROJECT_SKILL_SEND_REJECTION_DETAIL.unsupported);
      expect(yield* turnRequestCount(threadId)).toBe(0);
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  // Same-id reuse emits no new message event, so the gate alone would see an
  // ordinary send. Both sides are inspected: a durable managed message
  // refuses an ordinary reuse, a durable ordinary message refuses a managed
  // reuse, and an ordinary same-id send is untouched.
  effectIt.effect("refuses managed same-id reuse in both directions", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projectId = ProjectId.make("project-skill-reuse");
      const threadId = ThreadId.make("thread-skill-reuse");
      const skillId = ProjectSkillId.make("psk_reuse001");
      yield* seed(engine, "sg-reuse", projectId, threadId);
      yield* seedCandidate({ projectId, skillId, threadId });
      const { text, record } = managedSend(projectId, skillId);

      const managedMessageId = MessageId.make("sg-reuse-managed-id");
      yield* engine.dispatch(
        turnStart({
          prefix: "sg-seed-managed",
          threadId,
          messageId: managedMessageId,
          text,
          records: [record],
        }),
      );
      expect(yield* turnRequestCount(threadId)).toBe(1);

      const ordinaryReuse = turnStart({
        prefix: "sg-ordinary-over-managed",
        threadId,
        messageId: managedMessageId,
        text: "ordinary resend",
      });
      const ordinaryReuseError = yield* engine.dispatch(ordinaryReuse).pipe(Effect.flip);
      expect(ordinaryReuseError).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      const ordinaryReuseReceipt = yield* receiptFor(ordinaryReuse.commandId);
      expect(ordinaryReuseReceipt?.status).toBe("rejected");
      expect(ordinaryReuseReceipt?.error).toContain(
        PROJECT_SKILL_SEND_REJECTION_DETAIL.unsupported,
      );
      expect(yield* turnRequestCount(threadId)).toBe(1);

      const ordinaryMessageId = MessageId.make("sg-reuse-ordinary-id");
      yield* engine.dispatch(
        turnStart({
          prefix: "sg-seed-ordinary",
          threadId,
          messageId: ordinaryMessageId,
          text: "plain text",
        }),
      );
      expect(yield* turnRequestCount(threadId)).toBe(2);

      const managedReuse = turnStart({
        prefix: "sg-managed-over-ordinary",
        threadId,
        messageId: ordinaryMessageId,
        text,
        records: [record],
      });
      const managedReuseError = yield* engine.dispatch(managedReuse).pipe(Effect.flip);
      expect(managedReuseError).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      const managedReuseReceipt = yield* receiptFor(managedReuse.commandId);
      expect(managedReuseReceipt?.status).toBe("rejected");
      expect(managedReuseReceipt?.error).toContain(PROJECT_SKILL_SEND_REJECTION_DETAIL.unsupported);
      expect(yield* turnRequestCount(threadId)).toBe(2);

      yield* engine.dispatch(
        turnStart({
          prefix: "sg-ordinary-again",
          threadId,
          messageId: ordinaryMessageId,
          text: "plain text",
        }),
      );
      expect(yield* turnRequestCount(threadId)).toBe(3);
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  // A managed record on a plain user append is refused outright, and the
  // unprovided Reference answers `unavailable` — the fail-closed default a
  // composition without a real gate ships.
  effectIt.effect("refuses managed user.append and managed sends under the default gate", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projectId = ProjectId.make("project-skill-append");
      const threadId = ThreadId.make("thread-skill-append");
      const skillId = ProjectSkillId.make("psk_append01");
      yield* seed(engine, "sg-append", projectId, threadId);
      const { text, record } = managedSend(projectId, skillId);

      const appendCommand = {
        type: "thread.message.user.append" as const,
        commandId: CommandId.make("sg-append-managed"),
        threadId,
        message: {
          messageId: MessageId.make("sg-msg-append"),
          text,
          attachments: [],
          context: { version: 1 as const, records: [record] },
        },
        createdAt: NOW,
      };
      const appendError = yield* engine.dispatch(appendCommand).pipe(Effect.flip);
      expect(appendError).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      const appendReceipt = yield* receiptFor(appendCommand.commandId);
      expect(appendReceipt?.status).toBe("rejected");
      expect(appendReceipt?.error).toContain(PROJECT_SKILL_SEND_REJECTION_DETAIL.unsupported);

      const defaultCommand = turnStart({
        prefix: "sg-default",
        threadId,
        messageId: MessageId.make("sg-msg-default"),
        text,
        records: [record],
      });
      const defaultError = yield* engine.dispatch(defaultCommand).pipe(Effect.flip);
      expect(defaultError).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      const defaultReceipt = yield* receiptFor(defaultCommand.commandId);
      expect(defaultReceipt?.status).toBe("rejected");
      expect(defaultReceipt?.error).toContain(PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable);
      expect(yield* turnRequestCount(threadId)).toBe(0);
    }).pipe(Effect.provide(makeOrchestrationLayer(null))),
  );

  // A reuse-path durable read that fails with a mixed cause must reach the
  // caller with its reasons intact — never squashed into a rejection for a
  // command that was never decided — and leaves no rejected receipt behind.
  effectIt.effect("delivers a mixed reuse-read cause with its reasons intact", () => {
    const failReads = { current: false };
    const injectedReadError = new PersistenceSqlError({
      operation: "ProjectionThreadMessageRepository.getByMessageId:query",
      detail: "simulated reuse-read failure",
    });
    const mixedReadCause = Cause.combine(Cause.fail(injectedReadError), Cause.interrupt());
    const wrappedRepository = decorateProjectionThreadMessageRepositoryLayer((repository) => ({
      ...repository,
      getByMessageId: (input) =>
        failReads.current ? Effect.failCause(mixedReadCause) : repository.getByMessageId(input),
    }));

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
      const projectId = ProjectId.make("project-skill-cause");
      const threadId = ThreadId.make("thread-skill-cause");
      yield* seed(engine, "sg-cause", projectId, threadId);
      const messageId = MessageId.make("sg-msg-reuse-mixed");
      // An ordinary durable message under the same id makes turn.start take
      // the reuse path, whose authoritative read is the injected one.
      yield* engine.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make("sg-cause-append"),
        threadId,
        message: { messageId, text: "ordinary draft", attachments: [] },
        createdAt: NOW,
      });
      const head = yield* engine.latestSequence;
      const command = turnStart({
        prefix: "sg-cause",
        threadId,
        messageId,
        text: "ordinary draft",
      });

      failReads.current = true;
      const exit = yield* Effect.exit(engine.dispatch(command));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // The original reasons arrive in order, never squashed to a mapped
        // error. Propagation adds the framework's "effect/Cause/StackTrace"
        // annotation per reason, and the delivery fiber may append its own
        // Interrupt — the only tolerated differences from the injected cause.
        const originalReasons = Array.from(mixedReadCause.reasons);
        const deliveredReasons = Array.from(exit.cause.reasons);
        expect(deliveredReasons.length).toBeGreaterThanOrEqual(originalReasons.length);
        for (const [index, original] of originalReasons.entries()) {
          const delivered = deliveredReasons[index]!;
          if (Cause.isFailReason(delivered) && Cause.isFailReason(original)) {
            expect(delivered.error).toBe(original.error);
            expect(delivered.error).toBe(injectedReadError);
          } else if (Cause.isInterruptReason(delivered) && Cause.isInterruptReason(original)) {
            expect(delivered.fiberId).toBe(original.fiberId);
          } else {
            expect.unreachable("delivered reason kinds diverged");
          }
          for (const [key, value] of original.annotations) {
            expect(delivered.annotations.get(key)).toEqual(value);
          }
          for (const key of delivered.annotations.keys()) {
            expect(key === "effect/Cause/StackTrace" || original.annotations.has(key)).toBe(true);
          }
        }
        // Only runtime-added interrupts may trail the original cause.
        for (const extra of deliveredReasons.slice(originalReasons.length)) {
          expect(Cause.isInterruptReason(extra)).toBe(true);
        }
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(Cause.hasFails(exit.cause)).toBe(true);
      }

      // Nothing was decided: no event and no rejection receipt, so the same
      // command id retries once the read recovers.
      expect(Option.isNone(yield* receipts.getByCommandId({ commandId: command.commandId }))).toBe(
        true,
      );

      failReads.current = false;
      const accepted = yield* engine.dispatch(command);
      expect(accepted.sequence).toBeGreaterThan(head);
      expect(yield* turnRequestCount(threadId)).toBe(1);
    }).pipe(Effect.provide(makeOrchestrationLayer(sendGateLayer, wrappedRepository)));
  });
});
