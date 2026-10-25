import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface CrewTaskCheckpoint {
  readonly task_id: string;
  readonly lead_thread_id: string;
  readonly record_json: string;
  readonly updated_at: string;
}

export interface CrewFollowUpCheckpoint {
  readonly delivery_id: string;
  readonly lead_thread_id: string;
  readonly command_id: string;
  readonly message_id: string;
  readonly record_json: string;
  readonly created_at: string;
  readonly delivered_at: string | null;
  readonly rejected_at: string | null;
}

export class CrewRuntimeState extends Context.Service<
  CrewRuntimeState,
  {
    readonly saveTask: (checkpoint: CrewTaskCheckpoint) => Effect.Effect<void, PersistenceSqlError>;
    readonly readTasks: Effect.Effect<ReadonlyArray<CrewTaskCheckpoint>, PersistenceSqlError>;
    readonly prepareFollowUp: (
      checkpoint: Omit<CrewFollowUpCheckpoint, "delivered_at" | "rejected_at">,
    ) => Effect.Effect<void, PersistenceSqlError>;
    readonly readFollowUps: Effect.Effect<
      ReadonlyArray<CrewFollowUpCheckpoint>,
      PersistenceSqlError
    >;
    readonly acknowledgeFollowUp: (
      deliveryId: string,
      deliveredAt: string,
    ) => Effect.Effect<void, PersistenceSqlError>;
    readonly rejectFollowUp: (
      deliveryId: string,
      rejectedAt: string,
    ) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/persistence/Services/CrewRuntimeState") {}
