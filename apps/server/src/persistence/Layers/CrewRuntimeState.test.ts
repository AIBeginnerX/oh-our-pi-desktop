import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { runMigrations } from "../Migrations.ts";
import * as CrewRuntimeState from "./CrewRuntimeState.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

describe("Crew recovery checkpoints", () => {
  it.effect("retains a pending delivery after closing and reopening the database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "crew-recovery-" });
      const filename = path.join(root, "crew.sqlite");
      const delivery = {
        delivery_id: "delivery-1",
        lead_thread_id: "lead-1",
        command_id: "command-1",
        message_id: "message-1",
        record_json: '{"taskIds":["task-1"]}',
        created_at: "2026-10-24T00:00:00.000Z",
      };
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const writer = yield* CrewRuntimeState.make;
        yield* writer.prepareFollowUp(delivery);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      const restored = yield* Effect.gen(function* () {
        const reader = yield* CrewRuntimeState.make;
        return yield* reader.readFollowUps;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      assert.deepEqual(restored, [{ ...delivery, delivered_at: null, rejected_at: null }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("restores tasks and a pending delivery after repository recreation", () =>
    Effect.gen(function* () {
      const first = yield* CrewRuntimeState.make;
      const task = {
        task_id: "task-1",
        lead_thread_id: "lead-1",
        record_json: '{"collected":false}',
        updated_at: "2026-10-24T00:00:00.000Z",
      };
      const delivery = {
        delivery_id: "delivery-1",
        lead_thread_id: "lead-1",
        command_id: "command-1",
        message_id: "message-1",
        record_json: '{"taskIds":["task-1"]}',
        created_at: "2026-10-24T00:00:00.000Z",
      };
      yield* first.saveTask(task);
      yield* first.prepareFollowUp(delivery);
      const second = yield* CrewRuntimeState.make;
      assert.deepEqual(yield* second.readTasks, [task]);
      assert.deepEqual(yield* second.readFollowUps, [
        { ...delivery, delivered_at: null, rejected_at: null },
      ]);
      const duplicate = yield* second
        .prepareFollowUp({
          ...delivery,
          delivery_id: "delivery-2",
          command_id: "command-2",
          message_id: "message-2",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(duplicate));
      const at = "2026-10-24T00:00:01.000Z";
      yield* second.acknowledgeFollowUp(delivery.delivery_id, at);
      yield* second.acknowledgeFollowUp(delivery.delivery_id, "2026-10-24T00:00:02.000Z");
      assert.deepEqual(yield* second.readFollowUps, [
        { ...delivery, delivered_at: at, rejected_at: null },
      ]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
