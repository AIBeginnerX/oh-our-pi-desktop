import { CommandId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepository } from "../Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationCommandReceiptRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationCommandReceiptRepository.pruneAccepted", (it) => {
  it.effect("deletes in bounded batches and leaves ineligible receipts", () =>
    Effect.gen(function* () {
      const receipts = yield* OrchestrationCommandReceiptRepository;
      const sql = yield* SqlClient.SqlClient;
      const put = (id: string, acceptedAt: string, resultSequence: number, status: string) =>
        sql`
          INSERT INTO orchestration_command_receipts (
            command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
          ) VALUES (${id}, 'thread', 'thread-1', ${acceptedAt}, ${resultSequence}, ${status}, NULL)
        `;
      for (let index = 0; index < 7; index += 1) {
        yield* put(`old-${index}`, "2025-01-25T00:00:00.000Z", 5, "accepted");
      }
      yield* put("rejected", "2025-01-25T00:00:00.000Z", 5, "rejected");
      yield* put("recent", "2026-02-26T00:00:00.000Z", 5, "accepted");
      yield* put("crew-pending", "2025-01-25T00:00:00.000Z", 5, "accepted");
      yield* put("crew-settled", "2025-01-25T00:00:00.000Z", 5, "accepted");
      for (const [id, commandId, delivered] of [
        ["delivery-1", "crew-pending", null],
        ["delivery-2", "crew-settled", "2026-01-02T00:00:00.000Z"],
      ] as const) {
        yield* sql`
          INSERT INTO crew_followups (
            delivery_id, lead_thread_id, command_id, message_id, record_json, created_at, delivered_at
          ) VALUES (${id}, ${`lead-${id}`}, ${commandId}, ${`message-${id}`}, '{}',
            '2025-01-25T00:00:00.000Z', ${delivered})
        `;
      }
      yield* put("ahead", "2025-01-25T00:00:00.000Z", 6, "accepted");

      yield* put("provider:old", "2026-02-26T00:00:00.000Z", 5, "accepted");
      yield* put("provider:ahead", "2026-02-26T00:00:00.000Z", 6, "accepted");

      const removed = yield* receipts.pruneAccepted({
        providerAcceptedBefore: "2026-02-27T00:00:00.000Z",
        acceptedBefore: "2025-03-01T00:00:00.000Z",
        throughSequence: 5,
        batchSize: 3,
      });
      assert.strictEqual(removed, 8);
      const remaining = yield* sql<{ readonly id: string }>`
        SELECT command_id AS "id" FROM orchestration_command_receipts ORDER BY command_id
      `;
      assert.deepEqual(
        remaining.map((row) => row.id),
        ["ahead", "crew-pending", "crew-settled", "provider:ahead", "recent", "rejected"],
      );
      assert.isTrue(
        Option.isSome(yield* receipts.getByCommandId({ commandId: CommandId.make("recent") })),
      );
    }),
  );
});
