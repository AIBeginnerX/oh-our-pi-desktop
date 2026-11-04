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
        return yield* reader.readPendingFollowUps("lead-1");
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
      assert.deepEqual(yield* second.readPendingFollowUps("lead-1"), [
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
      assert.deepEqual(yield* second.readPendingFollowUps("lead-1"), []);
      assert.deepEqual(yield* second.readSettledFollowUps, [
        { ...delivery, delivered_at: at, rejected_at: null },
      ]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("reads pending deliveries of one lead only, and deletes a delivery once finished", () =>
    Effect.gen(function* () {
      const store = yield* CrewRuntimeState.make;
      const row = (id: string, lead: string) => ({
        delivery_id: id,
        lead_thread_id: lead,
        command_id: `command-${id}`,
        message_id: `message-${id}`,
        record_json: "{}",
        created_at: "2026-10-24T00:00:00.000Z",
      });
      yield* store.prepareFollowUp(row("a", "lead-1"));
      yield* store.prepareFollowUp(row("b", "lead-2"));
      yield* store.prepareFollowUp(row("c", "lead-3"));
      yield* store.acknowledgeFollowUp("a", "2026-10-24T00:00:01.000Z");
      yield* store.rejectFollowUp("c", "2026-10-24T00:00:01.000Z");
      assert.deepEqual(
        (yield* store.readPendingFollowUps("lead-1")).map((r) => r.delivery_id),
        [],
      );
      assert.deepEqual(
        (yield* store.readPendingFollowUps("lead-2")).map((r) => r.delivery_id),
        ["b"],
      );
      assert.deepEqual(
        (yield* store.readSettledFollowUps).map((r) => r.delivery_id),
        ["a", "c"],
      );
      yield* store.deleteFollowUp("a");
      yield* store.deleteFollowUp("c");
      assert.deepEqual(yield* store.readSettledFollowUps, []);
      assert.deepEqual(
        (yield* store.readPendingFollowUps("lead-2")).map((r) => r.delivery_id),
        ["b"],
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
