import {
  McpCapabilityUnavailableError,
  ProjectMemoryRejectedError,
  ProjectMemoryStoreError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
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
    return {
      threadId: invocation.threadId,
      projectId: thread.value.projectId,
      providerInstanceId: invocation.providerInstanceId,
    };
  });

  return MemoryToolkit.of({
    memory_recall: ({ query }) =>
      Effect.gen(function* () {
        const { projectId, threadId, providerInstanceId } = yield* requireMemory();
        // A held thread has a memory it already received that changed since. Like a
        // composer send, it gets no further memory until the user reviews that. A
        // hold check that could not be read fails closed too, with its own message.
        const hold = yield* gate.threadHold(threadId);
        if (Option.isSome(hold)) {
          return yield* new ProjectMemoryStoreError({
            message:
              hold.value === "store-failed"
                ? "Project memory could not be checked for this thread right now. Continue without recalling memory."
                : "Project memory is paused for this thread because memory it already received was changed or deleted. The user needs to review it in the app; continue without recalling memory.",
          });
        }
        const page = yield* memories.search({
          projectId,
          query,
          limit: MEMORY_RECALL_MAX_RESULTS,
          relevantOnly: true,
        });
        // validUntil is enforced where content is consumed, and this is it.
        const now = yield* Clock.currentTimeMillis;
        const live = page.items.filter(
          (item) => item.validUntil === null || Date.parse(item.validUntil) > now,
        );
        // Bodies reach the provider only through the send ledger, like a
        // composer send: the thread is recorded against each id and version,
        // so a later edit or delete holds it and its diagnostics are masked.
        const recorded = yield* gate.recordRecall({
          threadId,
          projectId,
          providerInstanceId,
          memoryIds: live.map((item) => item.memoryId),
          now: DateTime.makeUnsafe(now),
        });
        if (recorded.status === "held") {
          return yield* new ProjectMemoryStoreError({
            message: "Project memory operation failed.",
          });
        }
        // Memories deleted between the search and the read are simply absent.
        const byId = new Map(recorded.memories.map((memory) => [memory.memoryId, memory]));
        return {
          memories: live.flatMap((item) => {
            const memory = byId.get(item.memoryId);
            return memory === undefined
              ? []
              : [{ title: memory.title, kind: memory.kind, text: clip(memory.body) }];
          }),
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
