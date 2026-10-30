import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Tool } from "effect/unstable/ai";

import {
  ProjectMemorySendPolicy,
  layer as sendGateLayer,
} from "../../../memory/ProjectMemorySendGate.ts";
import {
  ProjectMemoryService,
  layer as projectMemoryServiceLayer,
} from "../../../memory/ProjectMemoryService.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "../../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../../../persistence/Layers/ProjectionThreads.ts";
import { layer as projectMemoriesLayer } from "../../../persistence/ProjectMemories.ts";
import { layer as sendLedgerLayer } from "../../../persistence/ProjectMemorySendLedger.ts";
import { ProviderService } from "../../../provider/Services/ProviderService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MemoryToolkitHandlersLive } from "./handlers.ts";
import { MEMORY_RECALL_MAX_RESULTS, MEMORY_RECALL_TEXT_MAX_CHARS, MemoryToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const INSTANCE_ID = ProviderInstanceId.make("claude");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");
const NOW = "2026-10-29T00:00:00.000Z";

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: INSTANCE_ID,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const thread: OrchestrationThreadShell = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: INSTANCE_ID, model: "sonnet" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: NOW,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

/**
 * The real memory service and send gate over one in-memory database; only the
 * thread-to-provider lookups are mocked. `driverKind` is what the thread's
 * provider instance reports, `allowed` is the gate's boot-time allowlist.
 */
const makeHarness = Effect.fn("makeMemoryToolkitHarness")(function* (
  options: {
    readonly driverKind?: ProviderDriverKind;
    readonly allowed?: ReadonlyArray<ProviderDriverKind>;
  } = {},
) {
  const memoryStack = projectMemoryServiceLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        projectMemoriesLayer,
        sendLedgerLayer,
        ProjectionThreadRepositoryLive,
        ProjectionProjectRepositoryLive,
      ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ),
    Layer.provide(NodeServices.layer),
  );
  const gate = sendGateLayer.pipe(
    Layer.provide(
      Layer.succeed(ProjectMemorySendPolicy, {
        driverKinds: new Set(options.allowed ?? [CLAUDE]),
      }),
    ),
    // The same SqlitePersistenceMemory value: memoized to one database.
    Layer.provide(SqlitePersistenceMemory),
  );
  const context = yield* Layer.build(
    Layer.mergeAll(
      memoryStack,
      gate,
      Layer.mock(ProviderService)({
        getInstanceInfo: (instanceId) =>
          Effect.succeed({
            instanceId,
            driverKind: options.driverKind ?? CLAUDE,
            displayName: undefined,
            enabled: true,
            continuationIdentity: {
              driverKind: options.driverKind ?? CLAUDE,
              continuationKey: instanceId,
            },
          }),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: (threadId) =>
          Effect.succeed(threadId === THREAD_ID ? Option.some(thread) : Option.none()),
      }),
    ),
  );
  const memories = yield* ProjectMemoryService.pipe(Effect.provide(context));
  const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(context));
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    )
    VALUES (${PROJECT_ID}, 'Project', '/tmp/project', '[]', ${NOW}, ${NOW}, NULL)
  `;
  // TestClock starts at the epoch; recall judges expiry against the clock.
  yield* TestClock.setTime(Date.parse(NOW));

  const toolkit = yield* MemoryToolkit.pipe(
    Effect.provide(MemoryToolkitHandlersLive),
    Effect.provide(context),
  );
  const call = <Name extends keyof typeof MemoryToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["memory"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof MemoryToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
    );
  const save = (title: string, body: string, validUntil?: string) =>
    memories.create({
      projectId: PROJECT_ID,
      kind: "fact",
      title,
      body,
      ...(validUntil === undefined ? {} : { validUntil }),
    });
  return { call, memories, save };
});

describe("memory toolkit handlers", () => {
  it.effect("refuses a credential without the memory capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("memory_recall", { query: "pnpm" }, ["crew"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "memory" });
    }),
  );

  it.effect("denies both tools when the gate does not admit the thread's provider driver", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ driverKind: CODEX });
      yield* harness.save("Package manager", "The secretive body must never leave the gate.");

      const recall = yield* harness.call("memory_recall", { query: "Package" }).pipe(Effect.flip);
      const propose = yield* harness
        .call("memory_propose", { text: "Use pnpm.", reason: "User said so." })
        .pipe(Effect.flip);

      for (const error of [recall, propose]) {
        expect(error).toMatchObject({
          _tag: "McpCapabilityUnavailableError",
          capability: "memory",
          threadId: THREAD_ID,
        });
        expect(error.message).toContain("not shared with this thread's provider");
        expect(error.message).not.toContain("secretive");
      }
      expect((yield* harness.memories.listProposals({ projectId: PROJECT_ID })).items).toEqual([]);
    }),
  );

  it.effect("denies everything under the default empty allowlist", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ allowed: [] });
      const error = yield* harness.call("memory_recall", { query: "anything" }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "memory" });
    }),
  );

  it.effect("recalls live matches only, clipped and capped, and never a pending proposal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.save("Runbook long", `deploy ${"x".repeat(MEMORY_RECALL_TEXT_MAX_CHARS * 2)}`);
      yield* harness.save(
        "Runbook expired",
        "deploy with the old script",
        "2026-01-01T00:00:00.000Z",
      );
      yield* harness.save("Unrelated", "nothing about it");
      yield* harness.call("memory_propose", {
        text: "deploy via the pending route",
        reason: "seen",
      });

      const recalled = yield* harness.call("memory_recall", { query: "deploy" });
      expect(recalled.moreAvailable).toBe(false);
      expect(recalled.memories.map((memory) => memory.title)).toEqual(["Runbook long"]);
      expect(recalled.memories[0]?.text).toHaveLength(MEMORY_RECALL_TEXT_MAX_CHARS + 1);
      expect(recalled.memories[0]?.text.endsWith("…")).toBe(true);

      for (let index = 0; index < MEMORY_RECALL_MAX_RESULTS + 2; index += 1) {
        yield* harness.save(`Convention ${index}`, `convention number ${index}`);
      }
      const capped = yield* harness.call("memory_recall", { query: "convention" });
      expect(capped.memories).toHaveLength(MEMORY_RECALL_MAX_RESULTS);
      expect(capped.moreAvailable).toBe(true);
    }),
  );

  it.effect("stores a proposal as pending until a user approves it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("memory_propose", {
        text: "Use pnpm, not npm.\nThe lockfile is pnpm-lock.yaml.",
        reason: "The user corrected me.",
      });
      expect(result.status).toBe("pending");

      const [pending] = (yield* harness.memories.listProposals({ projectId: PROJECT_ID })).items;
      expect(pending).toMatchObject({
        threadId: THREAD_ID,
        title: "Use pnpm, not npm.",
        reason: "The user corrected me.",
      });
      expect((yield* harness.call("memory_recall", { query: "lockfile" })).memories).toEqual([]);

      yield* harness.memories.approveProposal({
        projectId: PROJECT_ID,
        proposalId: pending!.proposalId,
      });
      const approved = yield* harness.call("memory_recall", { query: "lockfile" });
      expect(approved.memories.map((memory) => memory.title)).toEqual(["Use pnpm, not npm."]);
    }),
  );

  it.effect("rejects a proposal that looks like a secret and stores nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const secret = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");
      const error = yield* harness
        .call("memory_propose", {
          text: `Deploy with ${["api_key", `"${secret}"`].join(" = ")}`,
          reason: "Handy.",
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ProjectMemoryRejectedError", reason: "sensitive" });
      expect(error.message).not.toContain("sk_");
      expect((yield* harness.memories.listProposals({ projectId: PROJECT_ID })).items).toEqual([]);
    }),
  );
});
