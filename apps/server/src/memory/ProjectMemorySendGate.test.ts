// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import {
  MessageId,
  ProjectId,
  ProjectMemoryId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  type CommitProjectMemoryDispatchInput,
  ProjectMemorySendLedger,
  layer as sendLedgerLayer,
} from "../persistence/ProjectMemorySendLedger.ts";
import {
  MEMORY_SEND_HOLD_DETAIL,
  MEMORY_SEND_PROVIDER_FAILURE_DETAIL,
  ProjectMemorySendGate,
  ProjectMemorySendPolicy,
  layer as sendGateLayer,
  layerUnavailable,
  make,
} from "./ProjectMemorySendGate.ts";

const NOW_ISO = "2026-10-11T09:00:00.000Z";
const NOW = DateTime.makeUnsafe(NOW_ISO);

const policyLayer = (driverKinds: ReadonlyArray<string>) =>
  Layer.succeed(ProjectMemorySendPolicy)({
    driverKinds: new Set(driverKinds.map((kind) => ProviderDriverKind.make(kind))),
  });

// The real gate and the real ledger on one shared SqlClient — tests never
// substitute layerUnavailable for the real path.
const combinedLayer = (dbPath: string, driverKinds?: ReadonlyArray<string>) =>
  Layer.mergeAll(
    driverKinds === undefined
      ? sendGateLayer
      : sendGateLayer.pipe(Layer.provide(policyLayer(driverKinds))),
    sendLedgerLayer,
  ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })));

function withTestGate<A, E, R>(
  run: (
    dbPath: string,
  ) => Effect.Effect<
    A,
    E,
    R | ProjectMemorySendGate | ProjectMemorySendLedger | SqlClient.SqlClient
  >,
  driverKinds?: ReadonlyArray<string>,
) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-send-gate-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return run(dbPath).pipe(
    Effect.provide(combinedLayer(dbPath, driverKinds)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
}

const test = (
  name: string,
  run: (
    dbPath: string,
  ) => Effect.Effect<
    unknown,
    unknown,
    ProjectMemorySendGate | ProjectMemorySendLedger | SqlClient.SqlClient
  >,
  driverKinds?: ReadonlyArray<string>,
) => it.effect(name, () => withTestGate((dbPath) => run(dbPath), driverKinds));

const seedProject = (projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES (${projectId}, 'Project', '/tmp/project', '[]', ${NOW_ISO}, ${NOW_ISO}, NULL)
    `;
  });

const seedThread = (projectId: string, threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at
      )
      VALUES (
        ${threadId}, ${projectId}, 'Thread', '{}', 'full-access', 'default',
        ${NOW_ISO}, ${NOW_ISO}, NULL
      )
    `;
  });

const seedMessage = (threadId: string, messageId: string, role = "user") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      VALUES (${messageId}, ${threadId}, NULL, ${role}, 'text', 0, ${NOW_ISO}, ${NOW_ISO})
    `;
  });

const seedMemory = (input: {
  readonly memoryId: string;
  readonly projectId?: string;
  readonly title?: string;
  readonly body?: string;
  readonly version?: number;
  readonly validUntil?: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_memories (
        memory_id, project_id, kind, title, body, version,
        origin_type, origin_thread_id, origin_message_id,
        valid_until, estimated_tokens, created_at, updated_at
      )
      VALUES (
        ${input.memoryId}, ${input.projectId ?? "project-1"}, 'fact',
        ${input.title ?? "SECRET-T"}, ${input.body ?? "SECRET-B"},
        ${input.version ?? 1}, 'manual', NULL, NULL,
        ${input.validUntil ?? null}, 10, ${NOW_ISO}, ${NOW_ISO}
      )
    `;
  });

const seedSendContext = Effect.gen(function* () {
  yield* seedProject("project-1");
  yield* seedThread("project-1", "thread-1");
  yield* seedMessage("thread-1", "message-1");
  yield* seedMemory({ memoryId: "mem-1" });
});

const commitInput = (
  overrides: {
    readonly threadId?: string;
    readonly messageId?: string;
    readonly projectId?: string;
    readonly providerInstanceId?: string;
    readonly items?: ReadonlyArray<{
      readonly memoryId: string;
      readonly selectedVersion: number;
    }>;
    readonly now?: DateTime.Utc;
  } = {},
): CommitProjectMemoryDispatchInput => ({
  threadId: ThreadId.make(overrides.threadId ?? "thread-1"),
  messageId: MessageId.make(overrides.messageId ?? "message-1"),
  projectId: ProjectId.make(overrides.projectId ?? "project-1"),
  providerInstanceId: ProviderInstanceId.make(overrides.providerInstanceId ?? "pi"),
  items: overrides.items?.map((item) => ({
    memoryId: ProjectMemoryId.make(item.memoryId),
    selectedVersion: item.selectedVersion,
  })) ?? [{ memoryId: ProjectMemoryId.make("mem-1"), selectedVersion: 1 }],
  now: overrides.now ?? NOW,
});

const attemptRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly attemptSeq: number;
    readonly threadId: string;
    readonly messageId: string;
    readonly state: string;
    readonly settledAt: string | null;
  }>`
    SELECT attempt_seq AS "attemptSeq", thread_id AS "threadId", message_id AS "messageId",
           state, settled_at AS "settledAt"
    FROM project_memory_send_attempts
    ORDER BY attempt_seq ASC
  `;
});

const bumpMemory = (memoryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE project_memories SET version = version + 1 WHERE memory_id = ${memoryId}
    `;
  });

describe("ProjectMemorySendGate", () => {
  test(
    "G1 injected policy reaches the real gate: allowed drivers commit, others are held",
    (_dbPath) =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedSendContext;
        const gate = yield* ProjectMemorySendGate;
        expect(gate.driverAllowed(ProviderDriverKind.make("codex"))).toBe(true);
        expect(gate.driverAllowed(ProviderDriverKind.make("claudeAgent"))).toBe(false);

        const committed = yield* gate.admit(commitInput());
        expect(committed).toEqual({
          _tag: "Committed",
          attemptSeq: 1,
          memories: [
            {
              memoryId: "mem-1",
              version: 1,
              kind: "fact",
              title: "SECRET-T",
              body: "SECRET-B",
            },
          ],
        });

        const second = yield* gate.admit(commitInput());
        expect(second).toEqual({ _tag: "Held", reason: "already-committed" });
      }),
    ["codex"],
  );

  test("G2 default policy is the empty allowlist for every driver", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const gate = yield* ProjectMemorySendGate;
      expect(gate.driverAllowed(ProviderDriverKind.make("codex"))).toBe(false);
      expect(gate.driverAllowed(ProviderDriverKind.make("claudeAgent"))).toBe(false);
    }));

  test("G3 threadHold reflects persisted affected state and acknowledgement", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      const gate = yield* ProjectMemorySendGate;
      const ledger = yield* ProjectMemorySendLedger;
      const threadId = ThreadId.make("thread-1");

      expect(yield* gate.threadHold(threadId)).toEqual(Option.none());

      yield* ledger.commitDispatch(commitInput());
      expect(yield* gate.threadHold(threadId)).toEqual(Option.none());

      yield* bumpMemory("mem-1");
      expect(yield* gate.threadHold(threadId)).toEqual(Option.some("affected"));

      const state = yield* ledger.affectedState({ threadId, limit: 1 });
      assert.strictEqual(state.held, true);
      const latest = state.latestChangeSeq;
      assert.notStrictEqual(latest, null);
      yield* ledger.acknowledge({ threadId, throughChangeSeq: latest! });
      expect(yield* gate.threadHold(threadId)).toEqual(Option.none());
    }));

  test("G4 admit maps every ledger hold reason, with empty and context-mismatch folded to unavailable", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      yield* seedMemory({ memoryId: "mem-expired", validUntil: "2026-10-10T09:00:00.000Z" });
      const gate = yield* ProjectMemorySendGate;

      const cases: ReadonlyArray<readonly [string, CommitProjectMemoryDispatchInput, string]> = [
        [
          "missing memory",
          commitInput({ items: [{ memoryId: "mem-gone", selectedVersion: 1 }] }),
          "unavailable",
        ],
        ["empty items", commitInput({ items: [] }), "unavailable"],
        [
          "version-changed",
          commitInput({ items: [{ memoryId: "mem-1", selectedVersion: 2 }] }),
          "version-changed",
        ],
        [
          "expired",
          commitInput({ items: [{ memoryId: "mem-expired", selectedVersion: 1 }] }),
          "expired",
        ],
        [
          "context-mismatch: assistant message",
          commitInput({
            messageId: "assistant-1",
            items: [{ memoryId: "mem-1", selectedVersion: 1 }],
          }),
          "unavailable",
        ],
        [
          "too-large",
          commitInput({
            items: Array.from({ length: 9 }, (_, index) => ({
              memoryId: `mem-${index}`,
              selectedVersion: 1,
            })),
          }),
          "too-large",
        ],
      ] as const;
      yield* seedMessage("thread-1", "assistant-1", "assistant");
      for (const [name, input, reason] of cases) {
        const result = yield* gate.admit(input);
        expect(result, name).toEqual({ _tag: "Held", reason });
      }
      expect(yield* attemptRows).toEqual([]);
    }));

  test("G5 store failures hold closed with no retained cause", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      const sql = yield* SqlClient.SqlClient;
      const gate = yield* ProjectMemorySendGate;

      yield* sql`ALTER TABLE project_memory_affected RENAME TO broken_affected`;
      const hold = yield* gate.threadHold(ThreadId.make("thread-1"));
      expect(hold).toEqual(Option.some("store-failed"));

      yield* sql`ALTER TABLE project_memory_send_attempts RENAME TO broken_attempts`;
      const admission = yield* gate.admit(commitInput());
      expect(admission).toEqual({ _tag: "Held", reason: "store-failed" });
      expect(JSON.stringify(admission)).not.toContain("broken_");

      // Settle swallows store failures into one fixed warning and still completes.
      const settleExit = yield* Effect.exit(gate.settle(1, "external_send_unknown"));
      assert.isTrue(Exit.isSuccess(settleExit));
    }));

  test("G6 settle applies the outcome and ignores non-applied results", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      const gate = yield* ProjectMemorySendGate;

      const committed = yield* gate.admit(commitInput());
      if (committed._tag !== "Committed") {
        assert.fail(`expected a committed admission, got ${JSON.stringify(committed)}`);
      }
      yield* gate.settle(committed.attemptSeq, "provider_accepted");
      const rows = yield* attemptRows;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]!.state, "provider_accepted");
      assert.notStrictEqual(rows[0]!.settledAt, null);

      // Unknown attempt and already-final attempts are ignored, not surfaced.
      yield* gate.settle(999, "external_send_unknown");
      yield* gate.settle(committed.attemptSeq, "external_send_unknown");
      const after = yield* attemptRows;
      assert.strictEqual(after[0]!.state, "provider_accepted");
    }));

  it.effect("G7 layerUnavailable is a none/false/held stub for unrelated harnesses", () =>
    Effect.gen(function* () {
      const gate = yield* ProjectMemorySendGate;
      const hold = yield* gate.threadHold(ThreadId.make("thread-1"));
      const allowed = gate.driverAllowed(ProviderDriverKind.make("codex"));
      const admission = yield* gate.admit(commitInput());
      yield* gate.settle(1, "provider_accepted");
      const revalidated = yield* gate.revalidate({
        threadId: ThreadId.make("thread-1"),
        attemptSeq: 1,
        providerInstanceId: ProviderInstanceId.make("pi"),
      });
      const forAdmission = yield* gate.revalidateForAdmission({
        threadId: ThreadId.make("thread-1"),
        attemptSeq: 1,
        providerInstanceId: ProviderInstanceId.make("pi"),
      });
      expect(hold).toEqual(Option.none());
      expect(allowed).toBe(false);
      expect(admission).toEqual({ _tag: "Held", reason: "not-supported" });
      expect(revalidated).toEqual(Option.some("not-supported"));
      expect(forAdmission).toEqual({ _tag: "Held", reason: "not-supported" });
    }).pipe(Effect.provide(layerUnavailable)),
  );

  it("G8 hold detail covers every hold reason with fixed text", () => {
    expect(Object.keys(MEMORY_SEND_HOLD_DETAIL).sort()).toEqual(
      [
        "affected",
        "already-committed",
        "expired",
        "not-supported",
        "store-failed",
        "too-large",
        "unavailable",
        "version-changed",
      ].sort(),
    );
    for (const detail of Object.values(MEMORY_SEND_HOLD_DETAIL)) {
      expect(detail).not.toContain("SECRET");
      expect(detail.length).toBeGreaterThan(0);
    }
    expect(MEMORY_SEND_PROVIDER_FAILURE_DETAIL).toBe(
      "Provider turn start failed. The selected project memory may have been sent.",
    );
  });

  // R2 — the gate's revalidate for the provider memory handoff: an existing
  // thread hold wins before the attempt is re-read, held reasons map through
  // the shared fold, store failures and defects hold closed, and interrupts
  // propagate.

  const revalidateInput = (attemptSeq: number) => ({
    threadId: ThreadId.make("thread-1"),
    attemptSeq,
    providerInstanceId: ProviderInstanceId.make("pi"),
  });

  // The real gate over the real ledger with overridden methods, so
  // threadHold stays honest while the ledger surface is driven from the
  // test.
  const gateOverLedger = (
    real: ProjectMemorySendLedger["Service"],
    override: Partial<ProjectMemorySendLedger["Service"]>,
  ) =>
    make.pipe(
      Effect.provide(Layer.succeed(ProjectMemorySendLedger, { ...real, ...override })),
      Effect.provide(
        Layer.succeed(ProjectMemorySendPolicy, {
          driverKinds: new Set<ProviderDriverKind>(),
        }),
      ),
    );

  test("R2 an existing thread hold wins before the attempt is re-read", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      const real = yield* ProjectMemorySendLedger;
      const committed = yield* real.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");
      yield* bumpMemory("mem-1");

      // The affected hold answers even though the attempt would revalidate
      // cleanly — the ledger re-read never runs (it would die).
      const gate = yield* gateOverLedger(real, {
        revalidateDispatch: () => Effect.die("SECRET-REVALIDATE-RAN"),
      });
      expect(yield* gate.revalidate(revalidateInput(committed.attemptSeq))).toEqual(
        Option.some("affected"),
      );
    }));

  test("R2 revalidate maps held reasons and folds context-mismatch to unavailable", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      const gate = yield* ProjectMemorySendGate;
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-1");
      // Real updates and deletes fire the affected triggers, so the
      // thread-level hold must be acknowledged — exactly the operator flow —
      // before revalidation's own comparisons can be reached.
      const acknowledgeHeld = Effect.gen(function* () {
        const state = yield* ledger.affectedState({ threadId, limit: 1 });
        if (!state.held) return;
        const latest = state.latestChangeSeq;
        assert.notStrictEqual(latest, null);
        yield* ledger.acknowledge({ threadId, throughChangeSeq: latest! });
      });

      const committed = yield* ledger.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");
      expect(yield* gate.revalidate(revalidateInput(committed.attemptSeq))).toEqual(Option.none());

      yield* bumpMemory("mem-1");
      yield* acknowledgeHeld;
      expect(yield* gate.revalidate(revalidateInput(committed.attemptSeq))).toEqual(
        Option.some("version-changed"),
      );

      yield* sql`DELETE FROM project_memories WHERE memory_id = 'mem-1'`;
      yield* acknowledgeHeld;
      expect(yield* gate.revalidate(revalidateInput(committed.attemptSeq))).toEqual(
        Option.some("unavailable"),
      );

      // A context-mismatch folds to the same unavailable reason as admit.
      expect(yield* gate.revalidate(revalidateInput(9999))).toEqual(Option.some("unavailable"));
    }));

  test("R2 store failures and defects hold closed; interrupts propagate", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      const gate = yield* ProjectMemorySendGate;
      const real = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;

      // Typed failure: the fixed hold carries no foreign detail.
      yield* sql`ALTER TABLE project_memory_send_attempts RENAME TO broken_attempts`;
      const hold = yield* gate.revalidate(revalidateInput(1));
      expect(hold).toEqual(Option.some("store-failed"));
      expect(JSON.stringify(hold)).not.toContain("broken_");
      yield* sql`ALTER TABLE broken_attempts RENAME TO project_memory_send_attempts`;

      // Defect: the same fixed hold, and the marker never surfaces.
      const defectExit = yield* Effect.exit(
        Effect.flatMap(
          gateOverLedger(real, { revalidateDispatch: () => Effect.die("SECRET-DEFECT") }),
          (gate) => gate.revalidate(revalidateInput(1)),
        ),
      );
      assert.isTrue(Exit.isSuccess(defectExit));
      if (!Exit.isSuccess(defectExit)) {
        return assert.fail("expected the defect to become a hold");
      }
      expect(defectExit.value).toEqual(Option.some("store-failed"));
      expect(JSON.stringify(defectExit)).not.toContain("SECRET-DEFECT");

      // Interruption: neither caught nor converted into a hold.
      const interruptExit = yield* Effect.exit(
        Effect.flatMap(
          gateOverLedger(real, { revalidateDispatch: () => Effect.interrupt }),
          (gate) => gate.revalidate(revalidateInput(1)),
        ),
      );
      if (!Exit.isFailure(interruptExit)) {
        return assert.fail("expected the interrupt to propagate");
      }
      assert.isTrue(Cause.hasInterruptsOnly(interruptExit.cause));
    }));

  // AF — the dormant admission fence: revalidateForAdmission captures the
  // ledger mutation fence synchronously before the hold read, and the
  // returned stillValid re-judges that exact fence plus expiry at call time.

  test("AF1 unchanged attempt revalidates valid and stillValid agrees; revalidate derives none", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      const gate = yield* ProjectMemorySendGate;
      const ledger = yield* ProjectMemorySendLedger;
      const committed = yield* ledger.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");

      const result = yield* gate.revalidateForAdmission(revalidateInput(committed.attemptSeq));
      if (result._tag !== "Valid") return assert.fail("expected Valid");
      assert.equal(result.stillValid(), "valid");
      assert.equal(result.stillValid(), "valid");

      // The derived revalidate folds Valid to no hold — old callers keep
      // their contract until they migrate.
      expect(yield* gate.revalidate(revalidateInput(committed.attemptSeq))).toEqual(Option.none());
    }));

  test("AF2 a mutation to a memory outside the attempt still breaks stillValid", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      yield* seedMemory({ memoryId: "mem-2" });
      const gate = yield* ProjectMemorySendGate;
      const ledger = yield* ProjectMemorySendLedger;
      const committed = yield* ledger.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");

      const result = yield* gate.revalidateForAdmission(revalidateInput(committed.attemptSeq));
      if (result._tag !== "Valid") return assert.fail("expected Valid");
      assert.equal(result.stillValid(), "valid");

      // mem-2 is not in the attempt's items and was never sent to this
      // thread, so no thread hold lands — only the fence sees the change
      // in the same predicate captured before the mutation.
      yield* ledger.withMemoryMutation(bumpMemory("mem-2"));
      assert.equal(result.stillValid(), "changed");
    }));

  test("AF3 stillValid re-judges expiry against the admission clock; equality expires", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      yield* seedMemory({ memoryId: "mem-exp", validUntil: "2026-10-11T12:00:00.000Z" });
      yield* seedMessage("thread-1", "message-2");
      const gate = yield* ProjectMemorySendGate;
      const ledger = yield* ProjectMemorySendLedger;
      const committed = yield* ledger.commitDispatch(
        commitInput({
          messageId: "message-2",
          items: [{ memoryId: "mem-exp", selectedVersion: 1 }],
        }),
      );
      if (committed.status !== "committed") return assert.fail("expected committed");

      const expiryMillis = Date.parse("2026-10-11T12:00:00.000Z");
      yield* TestClock.setTime(expiryMillis - 1_000);
      const result = yield* gate.revalidateForAdmission(revalidateInput(committed.attemptSeq));
      if (result._tag !== "Valid") return assert.fail("expected Valid");
      assert.equal(result.stillValid(), "valid");

      // The same instant as valid_until is expired.
      yield* TestClock.setTime(expiryMillis);
      assert.equal(result.stillValid(), "expired");
      yield* TestClock.setTime(expiryMillis + 1_000);
      assert.equal(result.stillValid(), "expired");
    }));

  test("AF4 an existing thread hold answers before the attempt is re-read", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      const real = yield* ProjectMemorySendLedger;
      const committed = yield* real.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");
      yield* bumpMemory("mem-1");

      const gate = yield* gateOverLedger(real, {
        revalidateDispatch: () => Effect.die("SECRET-REVALIDATE-RAN"),
      });
      const result = yield* gate.revalidateForAdmission(revalidateInput(committed.attemptSeq));
      expect(result).toEqual({ _tag: "Held", reason: "affected" });
    }));

  test("AF5 a throwing fence hook fails stillValid closed instead of surfacing", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      const real = yield* ProjectMemorySendLedger;
      const committed = yield* real.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");

      const gate = yield* gateOverLedger(real, {
        mutationFenceHolds: () => {
          throw new Error("SECRET-HOOK");
        },
      });
      const result = yield* gate.revalidateForAdmission(revalidateInput(committed.attemptSeq));
      if (result._tag !== "Valid") return assert.fail("expected Valid");
      assert.equal(result.stillValid(), "changed");
    }));

  test("AF6 a mutation committed while parked after the clear hold read breaks stillValid", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      yield* seedMemory({ memoryId: "mem-used" });
      yield* seedMessage("thread-1", "message-2");
      const real = yield* ProjectMemorySendLedger;

      // The thread previously sent mem-used; the current attempt carries
      // only mem-1, so the mutation below is invisible to the attempt's own
      // item re-read — the fence is the only thing that sees it.
      const first = yield* real.commitDispatch(
        commitInput({ items: [{ memoryId: "mem-used", selectedVersion: 1 }] }),
      );
      if (first.status !== "committed") return assert.fail("expected committed");
      const committed = yield* real.commitDispatch(
        commitInput({ messageId: "message-2", items: [{ memoryId: "mem-1", selectedVersion: 1 }] }),
      );
      if (committed.status !== "committed") return assert.fail("expected committed");

      const parked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gate = yield* gateOverLedger(real, {
        revalidateDispatch: (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(parked, undefined);
            yield* Deferred.await(release);
            return yield* real.revalidateDispatch(input);
          }),
      });
      const fiber = yield* Effect.forkChild(
        gate.revalidateForAdmission(revalidateInput(committed.attemptSeq)),
      );
      // Deterministic: `parked` completes after the clear hold read — the
      // mutation lands strictly between the two reads.
      yield* Deferred.await(parked);
      yield* real.withMemoryMutation(bumpMemory("mem-used"));
      yield* Deferred.succeed(release, undefined);
      const exit = yield* Fiber.await(fiber);
      if (!Exit.isSuccess(exit)) return assert.fail("expected a revalidation result");
      const result = exit.value;
      if (result._tag !== "Valid") return assert.fail("expected Valid");
      assert.equal(result.stillValid(), "changed");

      // The same mutation also left the thread held, so a fresh admission
      // path refuses at the hold read too.
      const state = yield* real.affectedState({
        threadId: ThreadId.make("thread-1"),
        limit: 1,
      });
      assert.isTrue(state.held);
    }));

  test("AF7 the admission read refuses an ambient transaction as store-failed", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      const sql = yield* SqlClient.SqlClient;
      const gate = yield* ProjectMemorySendGate;
      const ledger = yield* ProjectMemorySendLedger;
      const committed = yield* ledger.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");

      const result = yield* sql.withTransaction(
        gate.revalidateForAdmission(revalidateInput(committed.attemptSeq)),
      );
      expect(result).toEqual({ _tag: "Held", reason: "store-failed" });
      expect(JSON.stringify(result)).not.toContain("nested-transaction");
    }));

  test("AF8 foreign failures sanitize; mixed causes stay interrupt-bearing across the real ledger boundary", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      const sql = yield* SqlClient.SqlClient;
      const gate = yield* ProjectMemorySendGate;
      const ledger = yield* ProjectMemorySendLedger;
      const committed = yield* ledger.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");

      // Fault injection lands below the real ledger boundary — the client
      // instance the ledger captured is faulted in place, since a wrapper
      // object would not be a callable sql tag. The first withTransaction
      // call after arming is threadHold's affected read; the second is
      // revalidateDispatch's metadata read.
      const realWithTransaction = sql.withTransaction;
      let withTransactionCalls = 0;
      const armFault = (failOnCall: number, injected: Effect.Effect<never, unknown>) => {
        withTransactionCalls = 0;
        Object.assign(sql, {
          withTransaction: (work: Effect.Effect<unknown, unknown, never>) => {
            withTransactionCalls += 1;
            return withTransactionCalls === failOnCall ? injected : realWithTransaction(work);
          },
        });
      };

      yield* Effect.gen(function* () {
        // A foreign typed failure at the metadata read refines to the
        // fixed store-failed hold — operation, detail and cause stay out.
        const foreign = new PersistenceSqlError({
          operation: "SECRET-OP",
          detail: "SECRET-DETAIL",
          cause: { body: "SECRET-CAUSE" },
        });
        armFault(2, Effect.fail(foreign));
        const held = yield* gate.revalidateForAdmission(revalidateInput(committed.attemptSeq));
        expect(held).toEqual({ _tag: "Held", reason: "store-failed" });
        expect(JSON.stringify(held)).not.toContain("SECRET");

        // A mixed cause keeps only its interrupt reasons through the real
        // normalizers — Fail+Interrupt and Die+Interrupt, at the hold read
        // (call 1) and at the metadata read (call 2).
        for (const failOnCall of [1, 2]) {
          for (const mixed of [
            Effect.failCause(Cause.combine(Cause.fail(foreign), Cause.interrupt())),
            Effect.failCause(
              Cause.combine(Cause.die(new Error("SECRET-DEFECT")), Cause.interrupt()),
            ),
          ]) {
            armFault(failOnCall, mixed);
            const exit = yield* Effect.exit(
              gate.revalidateForAdmission(revalidateInput(committed.attemptSeq)),
            );
            if (!Exit.isFailure(exit)) {
              return assert.fail("expected the interrupt to propagate, not a hold");
            }
            assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
            assert.ok(Option.isNone(Cause.findErrorOption(exit.cause)));
            expect(JSON.stringify(exit.cause)).not.toContain("SECRET");
          }
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => Object.assign(sql, { withTransaction: realWithTransaction })),
        ),
      );
    }));

  test("AF9 a nonfinite clock reading fails stillValid closed on a no-expiry attempt", (_dbPath) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedSendContext;
      const gate = yield* ProjectMemorySendGate;
      const ledger = yield* ProjectMemorySendLedger;
      const committed = yield* ledger.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");
      const clock = yield* Clock.Clock;

      // mem-1 carries no valid_until — the fence and the clock guard are
      // the only checks stillValid performs, so the clock is sampled even
      // though there is no expiry to compare against.
      const brokenClock: Clock.Clock = {
        ...clock,
        currentTimeMillisUnsafe: () => Number.NaN,
      };
      const result = yield* gate
        .revalidateForAdmission(revalidateInput(committed.attemptSeq))
        .pipe(Effect.provideService(Clock.Clock, brokenClock));
      if (result._tag !== "Valid") return assert.fail("expected Valid");
      assert.equal(result.stillValid(), "changed");
    }));
});
