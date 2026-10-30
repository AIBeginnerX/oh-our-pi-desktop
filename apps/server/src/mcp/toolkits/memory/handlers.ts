import {
  McpCapabilityUnavailableError,
  ProjectMemoryRejectedError,
  ProjectMemoryStoreError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectMemorySendGate from "../../../memory/ProjectMemorySendGate.ts";
import * as ProjectMemoryService from "../../../memory/ProjectMemoryService.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../../../provider/Services/ProviderService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MEMORY_RECALL_MAX_RESULTS, MEMORY_RECALL_TEXT_MAX_CHARS, MemoryToolkit } from "./tools.ts";

const clip = (text: string) => {
  const codepoints = [...text];
  return codepoints.length > MEMORY_RECALL_TEXT_MAX_CHARS
    ? `${codepoints.slice(0, MEMORY_RECALL_TEXT_MAX_CHARS).join("")}…`
    : text;
};

const make = Effect.gen(function* () {
  const memories = yield* ProjectMemoryService.ProjectMemoryService;
  const gate = yield* ProjectMemorySendGate.ProjectMemorySendGate;
  const providers = yield* ProviderService.ProviderService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  /**
   * Memory reaches a provider through these tools, so they follow the same
   * driver allowlist as composer sends: a thread whose provider is not
   * admitted gets the unavailable error before any memory is read.
   */
  const requireMemory = Effect.fn("MemoryToolkit.requireMemory")(function* () {
    const invocation = yield* McpInvocationContext.requireMcpCapability("memory");
    const info = yield* providers
      .getInstanceInfo(invocation.providerInstanceId)
      .pipe(Effect.option);
    if (Option.isNone(info) || !gate.driverAllowed(info.value.driverKind)) {
      return yield* new McpCapabilityUnavailableError({
        capability: "memory",
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      });
    }
    const thread = yield* snapshots
      .getThreadShellById(invocation.threadId)
      .pipe(
        Effect.mapError(
          () => new ProjectMemoryStoreError({ message: "Project memory operation failed." }),
        ),
      );
    if (Option.isNone(thread)) {
      return yield* new ProjectMemoryRejectedError({ reason: "thread-missing" });
    }
    return { threadId: invocation.threadId, projectId: thread.value.projectId };
  });

  return MemoryToolkit.of({
    memory_recall: ({ query }) =>
      Effect.gen(function* () {
        const { projectId } = yield* requireMemory();
        const page = yield* memories.search({ projectId, query, limit: MEMORY_RECALL_MAX_RESULTS });
        // validUntil is enforced where content is consumed, and this is it.
        const now = yield* Clock.currentTimeMillis;
        const live = page.items.filter(
          (item) => item.validUntil === null || Date.parse(item.validUntil) > now,
        );
        const found = yield* Effect.forEach(live, (item) =>
          memories.get({ projectId, memoryId: item.memoryId }).pipe(
            Effect.map(({ memory }) => ({
              title: memory.title,
              kind: memory.kind,
              text: clip(memory.body),
            })),
            // Deleted between the search and the read.
            Effect.catchTag("ProjectMemoryNotFoundError", () => Effect.succeed(null)),
          ),
        );
        return {
          memories: found.filter((memory) => memory !== null),
          moreAvailable: page.truncated,
        };
      }),
    memory_propose: ({ text, reason }) =>
      Effect.gen(function* () {
        const { projectId, threadId } = yield* requireMemory();
        yield* memories.propose({ projectId, threadId, text, reason });
        return {
          status: "pending" as const,
          note: "Sent to the user for approval. It is not saved memory unless they approve it, so do not rely on it.",
        };
      }),
  });
});

export const MemoryToolkitHandlersLive = MemoryToolkit.toLayer(make);
