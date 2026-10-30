import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { CrewTaskRecoveryJson } from "./crewRecoveryState.ts";

const encodeTask = Schema.encodeEffect(CrewTaskRecoveryJson);
const decodeTask = Schema.decodeEffect(CrewTaskRecoveryJson);

describe("Crew recovery checkpoint codec", () => {
  it.effect("round-trips worker identity and an uncollected result", () =>
    Effect.gen(function* () {
      const checkpoint = {
        version: 1 as const,
        taskId: "task-1",
        leadThreadId: ThreadId.make("lead-1"),
        leadTurnId: null,
        role: "worker" as const,
        subject: "worker task",
        attempts: [{ model: "worker-model", threadId: ThreadId.make("worker-1") }],
        report: {
          taskId: "task-1",
          role: "worker" as const,
          status: "completed" as const,
          result: "worker result",
        },
        collected: false,
        ended: true,
        auditState: "none" as const,
      };
      const encoded = yield* Schema.encodeEffect(CrewTaskRecoveryJson)(checkpoint);
      const restored = yield* Schema.decodeUnknownEffect(CrewTaskRecoveryJson)(encoded);
      assert.deepEqual(restored, checkpoint);
    }),
  );

  it.effect("keeps the write scope and structured report, and still reads older checkpoints", () =>
    Effect.gen(function* () {
      const report = {
        status: "partial" as const,
        summary: "Half done.",
        changedFiles: ["src/a.ts"],
        verification: { command: "vp test run src/a.test.ts", passed: false },
        findings: [{ severity: "P2" as const, confidence: 0.6, title: "Missing test" }],
      };
      const checkpoint = {
        version: 1 as const,
        taskId: "task-1",
        leadThreadId: ThreadId.make("lead-1"),
        leadTurnId: null,
        role: "worker" as const,
        subject: "worker task",
        writeScope: ["src/", "docs/a.md"],
        attempts: [],
        report: {
          taskId: "task-1",
          role: "worker" as const,
          status: "partial" as const,
          result: "Half done.",
          report,
        },
        collected: false,
        ended: true,
        auditState: "none" as const,
      };
      const encoded = yield* encodeTask(checkpoint);
      assert.deepEqual(yield* decodeTask(encoded), checkpoint);

      const older = yield* decodeTask(
        '{"version":1,"taskId":"task-1","leadThreadId":"lead-1","leadTurnId":null,"role":"worker","subject":"worker task","attempts":[],"report":{"taskId":"task-1","role":"worker","status":"completed","result":"done"},"collected":false,"ended":true,"auditState":"none"}',
      );
      assert.isUndefined(older.writeScope);
      assert.isUndefined(older.report?.report);
      assert.isUndefined(older.worktree);
    }),
  );

  it.effect("keeps an isolated task's worktree so a restart can merge it back", () =>
    Effect.gen(function* () {
      const checkpoint = {
        version: 1 as const,
        taskId: "task-1",
        leadThreadId: ThreadId.make("lead-1"),
        leadTurnId: null,
        role: "worker" as const,
        subject: "worker task",
        worktree: {
          repoRoot: "/repo",
          path: "/state/crew/task-1",
          base: "abc123",
          cwd: "/state/crew/task-1",
        },
        attempts: [],
        report: null,
        collected: false,
        ended: false,
        auditState: "none" as const,
      };
      assert.deepEqual(yield* decodeTask(yield* encodeTask(checkpoint)), checkpoint);
    }),
  );

  it.effect("rejects corrupt JSON and unsupported checkpoint versions", () =>
    Effect.gen(function* () {
      const corrupt = yield* Schema.decodeUnknownEffect(CrewTaskRecoveryJson)("not-json").pipe(
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(corrupt));
      const unsupported = yield* Schema.decodeUnknownEffect(CrewTaskRecoveryJson)(
        '{"version":2,"taskId":"task-1","leadThreadId":"lead-1","leadTurnId":null,"role":"worker","subject":"worker task","attempts":[],"report":null,"collected":false,"ended":false,"auditState":"none"}',
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(unsupported));
    }),
  );
});
