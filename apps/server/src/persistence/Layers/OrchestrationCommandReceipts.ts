import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  GetByCommandIdInput,
  type PruneAcceptedInput,
  OrchestrationCommandReceipt,
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceiptRepositoryShape,
} from "../Services/OrchestrationCommandReceipts.ts";

const PRUNE_BATCH_SIZE = 5_000;

const makeOrchestrationCommandReceiptRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertReceiptRow = SqlSchema.void({
    Request: OrchestrationCommandReceipt,
    execute: (receipt) =>
      sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          accepted_at,
          result_sequence,
          status,
          error
        )
        VALUES (
          ${receipt.commandId},
          ${receipt.aggregateKind},
          ${receipt.aggregateId},
          ${receipt.acceptedAt},
          ${receipt.resultSequence},
          ${receipt.status},
          ${receipt.error}
        )
        ON CONFLICT (command_id)
        DO UPDATE SET
          aggregate_kind = excluded.aggregate_kind,
          aggregate_id = excluded.aggregate_id,
          accepted_at = excluded.accepted_at,
          result_sequence = excluded.result_sequence,
          status = excluded.status,
          error = excluded.error
      `,
  });

  const findReceiptByCommandId = SqlSchema.findOneOption({
    Request: GetByCommandIdInput,
    Result: OrchestrationCommandReceipt,
    execute: ({ commandId }) =>
      sql`
        SELECT
          command_id AS "commandId",
          aggregate_kind AS "aggregateKind",
          aggregate_id AS "aggregateId",
          accepted_at AS "acceptedAt",
          result_sequence AS "resultSequence",
          status,
          error
        FROM orchestration_command_receipts
        WHERE command_id = ${commandId}
      `,
  });

  const deleteAcceptedBatch = (input: PruneAcceptedInput, batchSize: number) =>
    sql<{ readonly commandId: string }>`
      DELETE FROM orchestration_command_receipts
      WHERE command_id IN (
        SELECT command_id FROM orchestration_command_receipts
        WHERE status = 'accepted'
          AND accepted_at < ${input.acceptedBefore}
          AND result_sequence <= ${input.throughSequence}
          AND NOT EXISTS (
            SELECT 1 FROM crew_followups
            WHERE crew_followups.command_id = orchestration_command_receipts.command_id
          )
        LIMIT ${batchSize}
      )
      RETURNING command_id AS "commandId"
    `;

  const upsert: OrchestrationCommandReceiptRepositoryShape["upsert"] = (receipt) =>
    upsertReceiptRow(receipt).pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationCommandReceiptRepository.upsert:query")),
    );

  const getByCommandId: OrchestrationCommandReceiptRepositoryShape["getByCommandId"] = (input) =>
    findReceiptByCommandId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.getByCommandId:query"),
      ),
    );

  const pruneAccepted: OrchestrationCommandReceiptRepositoryShape["pruneAccepted"] = (input) =>
    Effect.gen(function* () {
      const batchSize = input.batchSize ?? PRUNE_BATCH_SIZE;
      let total = 0;
      while (true) {
        const deleted = (yield* deleteAcceptedBatch(input, batchSize)).length;
        total += deleted;
        if (deleted < batchSize) return total;
      }
    }).pipe(
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.pruneAccepted:query"),
      ),
    );

  return {
    upsert,
    getByCommandId,
    pruneAccepted,
  } satisfies OrchestrationCommandReceiptRepositoryShape;
});

export const OrchestrationCommandReceiptRepositoryLive = Layer.effect(
  OrchestrationCommandReceiptRepository,
  makeOrchestrationCommandReceiptRepository,
);
