// @effect-diagnostics nodeBuiltinImport:off - the CLI fixture exercises real engine commits and file databases.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "../bin.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { layer as restartContinuationsLayer } from "../restartContinuations.ts";
import type {
  OwnedThreadUsageOutcome,
  OwnedTurnUsageObservationV1,
} from "../usage/ownedUsage.schema.ts";
import { OWNED_USAGE_ACTIVITY_KIND } from "../usage/ownedUsage.schema.ts";

const at = "2026-01-01T00:00:00.000Z";
const instanceId = ProviderInstanceId.make("codex-personal");

const makeBaseDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-usage-cli-"));
const dbPathFor = (dir: string) => NodePath.join(dir, "userdata", "state.sqlite");

const CliTestLayer = Layer.mergeAll(
  NodeServices.layer,
  NetService.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
  TestConsole.layer,
);

const withCliLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, CliTestLayer);

const runCliWith = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args);

// Console output accumulates across CLI runs within a test, and each
// Console.log call is one entry — the latest command's output is the last
// string entry even when it spans many lines.
const runCliCapturingStdout = (args: ReadonlyArray<string>) =>
  withCliLayers(
    Effect.gen(function* () {
      yield* runCliWith(args);
      return yield* TestConsole.logLines;
    }),
  );

const stdoutLines = (lines: ReadonlyArray<unknown>) =>
  lines.filter((line): line is string => typeof line === "string");

const observationActivity = (input: {
  activityId: string;
  observation: OwnedTurnUsageObservationV1;
  turnId: string | null;
}): OrchestrationThreadActivity => ({
  id: EventId.make(input.activityId),
  tone: "info",
  kind: OWNED_USAGE_ACTIVITY_KIND,
  summary: "Turn usage observed",
  payload: input.observation,
  turnId: input.turnId === null ? null : TurnId.make(input.turnId),
  createdAt: at,
});

// Fixture writer only: commands through the real engine initialize an
// isolated migrated database, which is closed before the CLI opens it
// read-only. The ingestion-seam proof lives in ownedUsage.test.ts.
const writeThreadFixture = Effect.fn("usageCli.writeThreadFixture")(function* (
  dir: string,
  threadId: ThreadId,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
) {
  const projectId = ProjectId.make("usage-cli-project");
  const layer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(makeSqlitePersistenceLive(dbPathFor(dir))),
    // Same engine dependencies the ownedUsage integration wires: dispatch
    // requires the continuation registry and the background workers, and the
    // memoized persistence client (merged after them, like the integration)
    // feeds any SQL they need.
    Layer.provideMerge(restartContinuationsLayer),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(makeSqlitePersistenceLive(dbPathFor(dir))),
    Layer.provideMerge(ServerConfig.layerTest(dir, dir)),
    Layer.provideMerge(NodeServices.layer),
  );
  const scope = yield* Scope.make("sequential");
  try {
    const context = yield* Layer.buildWithScope(layer, scope);
    const live = Effect.provideContext(context);
    const engine = yield* live(Effect.service(OrchestrationEngineService));
    const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
      live(engine.dispatch(command));
    yield* dispatch({
      type: "project.create",
      commandId: CommandId.make("usage-cli-project-create"),
      projectId,
      title: "Usage CLI",
      workspaceRoot: dir,
      defaultModelSelection: { instanceId, model: "gpt-5-codex" },
      createdAt: at,
    });
    yield* dispatch({
      type: "thread.create",
      commandId: CommandId.make("usage-cli-thread-create"),
      threadId,
      projectId,
      title: "Usage CLI thread",
      modelSelection: { instanceId, model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: at,
    });
    for (const [index, activity] of activities.entries()) {
      yield* dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`usage-cli-activity-${index}`),
        threadId,
        activity,
        createdAt: at,
      });
    }
  } finally {
    // The writer connection closes before any read-only CLI open, success or
    // failure.
    yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
  }
  return dbPathFor(dir);
});

describe("t3 usage owned", () => {
  effectIt.live("reports scoped buckets as one JSON document through the registered command", () =>
    Effect.gen(function* () {
      const dir = makeBaseDir();
      try {
        const threadId = ThreadId.make("usage-cli-thread");
        const codexObservation: OwnedTurnUsageObservationV1 = {
          v: 1,
          scope: "main-turn",
          source: {
            driver: ProviderDriverKind.make("codex"),
            instanceId,
            turnId: TurnId.make("turn-codex-1"),
            runtimeEventId: EventId.make("rt-codex-1"),
            nativeConversationId: "codex-native-77",
          },
          terminal: "completed",
          usage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 1200,
            outputTokens: 340,
            hasSubagents: false,
          },
        };
        const claudeObservation: OwnedTurnUsageObservationV1 = {
          v: 1,
          scope: "main-turn",
          source: {
            driver: ProviderDriverKind.make("claudeAgent"),
            instanceId: ProviderInstanceId.make("claude-personal"),
            turnId: TurnId.make("turn-claude-1"),
            runtimeEventId: EventId.make("rt-claude-1"),
            nativeConversationId: null,
          },
          terminal: "completed",
          usage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 900,
            outputTokens: 260,
            hasSubagents: false,
          },
        };
        yield* writeThreadFixture(dir, threadId, [
          observationActivity({
            activityId: "owned-usage:usage-cli-thread:rt-codex-1",
            observation: codexObservation,
            turnId: "turn-codex-1",
          }),
          observationActivity({
            activityId: "owned-usage:usage-cli-thread:rt-claude-1",
            observation: claudeObservation,
            turnId: "turn-claude-1",
          }),
          {
            id: EventId.make("task-usage:usage-cli-thread:agent-1"),
            tone: "info",
            kind: "task.progress",
            summary: "Task usage updated",
            payload: {
              taskId: "agent-1",
              typedUsage: { totalTokens: 64000, outputTokens: 4000 },
              usageSource: {
                v: 1,
                driver: "codex",
                instanceId,
                runtimeEventId: "evt-child-1",
                phase: "progress",
              },
            },
            turnId: null,
            createdAt: at,
          },
        ]);

        // Clean JSON stdout: exactly one log entry, no extra or non-string
        // output riding along with the one document.
        const jsonCapture = yield* runCliCapturingStdout([
          "usage",
          "owned",
          threadId,
          "--json",
          "--base-dir",
          dir,
        ]);
        expect(jsonCapture).toHaveLength(1);
        const parsed = JSON.parse(stdoutLines(jsonCapture)[0]!) as OwnedThreadUsageOutcome;
        expect(parsed.status).toBe("ok");
        if (parsed.status !== "ok") return;
        expect(parsed.report.main.buckets).toEqual([
          {
            scope: {
              driver: "codex",
              instanceId: "codex-personal",
              nativeConversationId: "codex-native-77",
            },
            reportedCompleteSubtotal: {
              completeTurns: 1,
              inputTokens: 1200,
              outputTokens: 340,
              cachedInputTokens: { sum: 0, reportedTurns: 0 },
              cacheCreationTokens: { sum: 0, reportedTurns: 0 },
              reasoningTokens: { sum: 0, reportedTurns: 0 },
            },
          },
          {
            scope: {
              driver: "claudeAgent",
              instanceId: "claude-personal",
              nativeConversationId: null,
            },
            reportedCompleteSubtotal: {
              completeTurns: 1,
              inputTokens: 900,
              outputTokens: 260,
              cachedInputTokens: { sum: 0, reportedTurns: 0 },
              cacheCreationTokens: { sum: 0, reportedTurns: 0 },
              reasoningTokens: { sum: 0, reportedTurns: 0 },
            },
          },
        ]);
        expect(
          parsed.report.children.map((child) => [
            child.taskId,
            child.frames.length,
            child.lifetime,
          ]),
        ).toEqual([["agent-1", 1, "unknown"]]);
        expect(parsed.report.legacyChildFrames).toBe(0);

        // The human summary keeps the per-bucket numbers and states that no
        // combined total exists, instead of printing one.
        const textCapture = yield* runCliCapturingStdout([
          "usage",
          "owned",
          threadId,
          "--base-dir",
          dir,
        ]);
        expect(textCapture).toHaveLength(1);
        const text = stdoutLines(textCapture)[0] ?? "";
        expect(text).toContain("codex/codex-personal/codex-native-77");
        expect(text).toContain("1 complete turn(s)");
        expect(text).toContain("no combined total exists");
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  effectIt.live("reports missing-create as JSON without inventing zero usage", () =>
    Effect.gen(function* () {
      const dir = makeBaseDir();
      try {
        // A migrated writer database with no events at all: the reader sees a
        // real schema but no thread creation for the requested id.
        const scope = yield* Scope.make("sequential");
        try {
          yield* Layer.buildWithScope(
            makeSqlitePersistenceLive(dbPathFor(dir)).pipe(Layer.provide(NodeServices.layer)),
            scope,
          );
        } finally {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        }

        const capture = yield* runCliCapturingStdout([
          "usage",
          "owned",
          "usage-empty-thread",
          "--json",
          "--base-dir",
          dir,
        ]);
        expect(capture).toHaveLength(1);
        expect(JSON.parse(stdoutLines(capture)[0]!)).toEqual({
          status: "missing-create",
          threadId: "usage-empty-thread",
          readThroughSequence: 0,
        });
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  effectIt.live("fails typed on a missing database and creates nothing", () =>
    Effect.gen(function* () {
      const dir = makeBaseDir();
      try {
        const failure = yield* withCliLayers(
          Effect.gen(function* () {
            const flipped = yield* runCliWith([
              "usage",
              "owned",
              "usage-cli-thread",
              "--json",
              "--base-dir",
              dir,
            ]).pipe(Effect.flip);
            const lines = yield* TestConsole.logLines;
            const errors = yield* TestConsole.errorLines;
            return { flipped, lines, errors } as const;
          }),
        );

        // The registered boundary reports one CliError.UserError whose cause
        // keeps the typed detail for callers, while the rendered channel only
        // ever sees the fixed user message.
        expect(failure.flipped).toMatchObject({
          _tag: "UserError",
          userMessage: expect.stringContaining("No OOP database found"),
          cause: { _tag: "OwnedUsageDatabaseMissingError" },
        });
        expect(String(failure.flipped)).toContain("No OOP database found");
        expect(String(failure.flipped)).toContain(dir);
        // Expected command errors print nothing to stdout.
        expect(stdoutLines(failure.lines)).toEqual([]);
        // The error channel carries the fixed message — the same text the
        // real runner renders on stderr — and never the raw tag, cause
        // detail, or stack the runtime reporter would have dumped.
        const stderrText = failure.errors.join("\n");
        expect(stderrText).toContain("No OOP database found");
        expect(stderrText).toContain(dir);
        expect(stderrText).not.toContain("OwnedUsageDatabaseMissingError");
        expect(stderrText).not.toContain("    at ");
        // A diagnostic read must never bootstrap state: no directory, no blank
        // database at the path it was asked about.
        expect(NodeFS.existsSync(NodePath.join(dir, "userdata"))).toBe(false);
        expect(NodeFS.existsSync(dbPathFor(dir))).toBe(false);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  effectIt.live(
    "fails closed when the database path cannot be probed, without leaking the cause",
    () =>
      Effect.gen(function* () {
        const dir = makeBaseDir();
        const dbPath = dbPathFor(dir);
        try {
          // `userdata` exists as a regular file, so probing
          // userdata/state.sqlite fails ENOTDIR inside the existence check
          // instead of returning false.
          NodeFS.writeFileSync(NodePath.join(dir, "userdata"), "not a directory");
          const failure = yield* withCliLayers(
            Effect.gen(function* () {
              const flipped = yield* runCliWith([
                "usage",
                "owned",
                "usage-cli-thread",
                "--json",
                "--base-dir",
                dir,
              ]).pipe(Effect.flip);
              const lines = yield* TestConsole.logLines;
              const errors = yield* TestConsole.errorLines;
              return { flipped, lines, errors } as const;
            }),
          );

          expect(failure.flipped).toMatchObject({
            _tag: "UserError",
            userMessage: `Could not read owned usage from ${dbPath}. Check the server logs for the underlying database condition.`,
          });
          // Expected command errors print nothing to stdout.
          expect(stdoutLines(failure.lines)).toEqual([]);
          // The rendered error channel names the probed path but never the
          // filesystem cause — no PlatformError, errno, syscall, or stack.
          const stderrText = failure.errors.join("\n");
          expect(stderrText).toContain(`Could not read owned usage from ${dbPath}`);
          expect(stderrText).not.toContain("PlatformError");
          expect(stderrText).not.toContain("ENOTDIR");
          expect(stderrText).not.toContain("    at ");
          // Nothing was created or altered at the probed path.
          expect(NodeFS.existsSync(dbPath)).toBe(false);
          expect(NodeFS.readFileSync(NodePath.join(dir, "userdata"), "utf8")).toBe(
            "not a directory",
          );
        } finally {
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }
      }),
  );

  effectIt.live("re-raises mixed and pure interrupt causes untouched, with silent output", () =>
    Effect.gen(function* () {
      const dir = makeBaseDir();
      const dbPath = dbPathFor(dir);
      try {
        const probeError = PlatformError.systemError({
          _tag: "BadResource",
          module: "FileSystem",
          method: "access",
          description: "injected probe failure",
          pathOrDescriptor: dbPath,
        });
        const probed: Array<string> = [];
        const run = (cause: Cause.Cause<PlatformError.PlatformError>) =>
          Effect.provide(
            Effect.gen(function* () {
              const exit = yield* Effect.exit(
                runCliWith(["usage", "owned", "usage-cli-thread", "--json", "--base-dir", dir]),
              );
              const lines = yield* TestConsole.logLines;
              const errors = yield* TestConsole.errorLines;
              return { exit, lines, errors } as const;
            }),
            Layer.mergeAll(
              CliTestLayer,
              FileSystem.layerNoop({
                exists: (path) => {
                  probed.push(path);
                  return Effect.failCause(cause);
                },
              }),
            ),
          );

        // A cause carrying an interrupt reaches the registered boundary
        // untouched: the typed probe failure and the interrupt survive
        // together instead of collapsing into a rendered UserError.
        const mixed = yield* run(Cause.combine(Cause.fail(probeError), Cause.interrupt()));
        expect(probed).toEqual([dbPath]);
        expect(Exit.isFailure(mixed.exit)).toBe(true);
        if (Exit.isSuccess(mixed.exit)) return;
        expect(Cause.hasInterrupts(mixed.exit.cause)).toBe(true);
        const mixedError = Cause.findErrorOption(mixed.exit.cause);
        expect(mixedError._tag).toBe("Some");
        if (mixedError._tag === "Some") {
          expect(mixedError.value).toBe(probeError);
        }
        expect(stdoutLines(mixed.lines)).toEqual([]);
        expect(mixed.errors).toEqual([]);

        // Same fixture, interruption alone: still untouched and silent.
        const interruptOnly = yield* run(Cause.interrupt());
        expect(probed).toEqual([dbPath, dbPath]);
        expect(Exit.isFailure(interruptOnly.exit)).toBe(true);
        if (Exit.isSuccess(interruptOnly.exit)) return;
        expect(Cause.hasInterruptsOnly(interruptOnly.exit.cause)).toBe(true);
        expect(Cause.findErrorOption(interruptOnly.exit.cause)._tag).toBe("None");
        expect(stdoutLines(interruptOnly.lines)).toEqual([]);
        expect(interruptOnly.errors).toEqual([]);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  effectIt.live(
    "fails closed on a foreign database without dumping or altering stored content",
    () =>
      Effect.gen(function* () {
        const dir = makeBaseDir();
        const dbPath = dbPathFor(dir);
        const sentinel = "t3-usage-cli-secret-4f0ab2";
        try {
          NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
          const foreignScope = yield* Scope.make("sequential");
          try {
            const context = yield* Layer.buildWithScope(
              NodeSqliteClient.layer({ filename: dbPath }),
              foreignScope,
            );
            const sql = yield* Effect.provideContext(context)(Effect.service(SqlClient.SqlClient));
            yield* sql`CREATE TABLE provider_secrets (value TEXT)`;
            yield* sql`INSERT INTO provider_secrets (value) VALUES (${sentinel})`;
          } finally {
            yield* Scope.close(foreignScope, Exit.void).pipe(Effect.ignore);
          }
          // Byte fingerprint of the closed, checkpointed foreign database.
          const beforeBytes = NodeFS.readFileSync(dbPath);

          const failure = yield* withCliLayers(
            Effect.gen(function* () {
              const flipped = yield* runCliWith([
                "usage",
                "owned",
                "usage-cli-thread",
                "--json",
                "--base-dir",
                dir,
              ]).pipe(Effect.flip);
              const lines = yield* TestConsole.logLines;
              const errors = yield* TestConsole.errorLines;
              return { flipped, lines, errors } as const;
            }),
          );

          expect(failure.flipped).toMatchObject({
            _tag: "UserError",
            userMessage: expect.stringContaining("could not be read from the local database"),
          });
          const rendered = String(failure.flipped);
          expect(rendered).not.toContain(sentinel);
          // Expected command errors print nothing to stdout.
          expect(stdoutLines(failure.lines)).toEqual([]);
          // The rendered stderr carries the fixed message and never the stored
          // content — inspected directly, not inferred from stdout.
          const stderrText = failure.errors.join("\n");
          expect(stderrText).toContain("could not be read from the local database");
          expect(stderrText).not.toContain(sentinel);
          // Nor the raw tag or stack of the typed error behind the boundary.
          expect(stderrText).not.toContain("OwnedUsageStoreError");
          expect(stderrText).not.toContain("    at ");
          // The registered read neither wrote nor migrated the foreign file.
          expect(Buffer.compare(beforeBytes, NodeFS.readFileSync(dbPath))).toBe(0);
          // Independent read-only reopen: exactly the original foreign schema
          // and data exist — no orchestration_events, no migration artifacts.
          const verifyScope = yield* Scope.make("sequential");
          try {
            const verifyContext = yield* Layer.buildWithScope(
              NodeSqliteClient.layer({ filename: dbPath, readonly: true }),
              verifyScope,
            );
            const verifySql = yield* Effect.provideContext(verifyContext)(
              Effect.service(SqlClient.SqlClient),
            );
            const tables =
              yield* verifySql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
            expect(tables.map((row) => row.name)).toEqual(["provider_secrets"]);
            const secrets = yield* verifySql`SELECT value FROM provider_secrets`;
            expect(secrets).toEqual([{ value: sentinel }]);
          } finally {
            yield* Scope.close(verifyScope, Exit.void).pipe(Effect.ignore);
          }
        } finally {
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }
      }),
  );
});
