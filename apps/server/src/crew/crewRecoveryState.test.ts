import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { CrewTaskRecoveryJson } from "./crewRecoveryState.ts";

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
