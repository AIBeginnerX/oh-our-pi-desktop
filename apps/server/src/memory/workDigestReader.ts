import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationEventStoreError } from "../persistence/Errors.ts";
import type { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { type OwnedUsageStoreError, readOwnedThreadEventWindow } from "../usage/ownedUsage.ts";
import { deriveWorkDigest, type ThreadWorkDigest } from "./workDigest.ts";

/**
 * Digest of one thread read from retained event history, bounded like the
 * owned-usage read. A thread too large to read, or one with no creation event
 * left in history, yields no digest rather than a partial one.
 */
export const readThreadWorkDigest = (
  sql: SqlClient.SqlClient,
  store: OrchestrationEventStore["Service"],
  threadId: ThreadId,
): Effect.Effect<ThreadWorkDigest | null, OwnedUsageStoreError | OrchestrationEventStoreError> =>
  readOwnedThreadEventWindow(sql, store, threadId).pipe(
    Effect.map((window) =>
      window.status === "ok" ? deriveWorkDigest(threadId, window.events) : null,
    ),
  );
