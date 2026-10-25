/**
 * `t3 usage owned <thread-id>` - report usage the local server itself recorded
 * for one thread, straight from the retained orchestration event history.
 *
 * Opens the state database through the same CLI location resolution as other
 * commands, but strictly read-only: no directory creation, no migrations, no
 * writes, and no blank database when the file is missing. One read-only SQL
 * client is built here and shared into the event store with `Layer.provideMerge`
 * (also feeding the reader's captured head query). The report is the bounded,
 * source-scoped `OwnedThreadUsageOutcome` from `ownedUsage.ts` — sums live only
 * inside driver/instance/conversation buckets, and `--json` prints exactly one
 * JSON document to stdout. Expected operational failures report through one
 * `CliError.UserError`, which the CLI runner renders as a fixed sentence on
 * the error channel — so a failing `--json` run leaves stdout empty and never
 * leaks the raw error, its causes, or its stack.
 */
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import type { OwnedThreadUsageOutcome } from "../usage/ownedUsage.schema.ts";
import {
  OWNED_USAGE_MAX_EVENTS,
  OwnedUsageReader,
  OwnedUsageReaderLive,
  OwnedUsageStoreError,
} from "../usage/ownedUsage.ts";
import { baseDirFlag } from "./config.ts";

export class OwnedUsageDatabaseMissingError extends Schema.TaggedError<OwnedUsageDatabaseMissingError>()(
  "OwnedUsageDatabaseMissingError",
  { dbPath: Schema.String },
) {
  override get message(): string {
    return `No OOP database found at ${this.dbPath}. Run on the machine and --base-dir that hold the thread; this command never creates one.`;
  }
}

export class OwnedUsageDatabaseIncompatibleError extends Schema.TaggedError<OwnedUsageDatabaseIncompatibleError>()(
  "OwnedUsageDatabaseIncompatibleError",
  { dbPath: Schema.String },
) {
  override get message(): string {
    return `${this.dbPath} is not a readable OOP state database (its orchestration event store is missing or unreadable).`;
  }
}

// Same location resolution as `t3 trace summary`: --base-dir, else T3CODE_HOME,
// else the default home. Paths are derived without creating anything.
const resolveOwnedUsageDbPath = Effect.fn("cli.usage.resolveDbPath")(function* (
  baseDir: Option.Option<string>,
) {
  const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
  const resolvedBaseDir = yield* resolveBaseDir(
    Option.getOrUndefined(Option.orElse(baseDir, () => envHome)),
  );
  return (yield* ServerConfig.deriveServerPaths(resolvedBaseDir, undefined)).dbPath;
});

// Fixed local text only. Missing/incompatible detection reads node:sqlite's
// fixed condition strings, and missing/incompatible may name the user-selected
// db path; a failure before the path resolves renders one path-free sentence.
// Every other failure renders one stable sentence with the original error and
// its nested causes kept out of the output entirely.
const summarizeFailure = (dbPath: string | undefined, error: unknown): string => {
  if (error instanceof OwnedUsageDatabaseMissingError) return error.message;
  if (error instanceof OwnedUsageDatabaseIncompatibleError) return error.message;
  if (error instanceof OwnedUsageStoreError) return error.message;
  if (dbPath === undefined) {
    return "Could not resolve the OOP database location for owned usage. Check the server logs for the underlying condition.";
  }
  const text = error instanceof Error ? error.message : "";
  if (/no such table/i.test(text)) {
    return new OwnedUsageDatabaseIncompatibleError({ dbPath }).message;
  }
  if (/unable to open database file/i.test(text)) {
    return new OwnedUsageDatabaseMissingError({ dbPath }).message;
  }
  return `Could not read owned usage from ${dbPath}. Check the server logs for the underlying database condition.`;
};

const formatBucketLine = (bucket: {
  scope: { driver: string; instanceId: string; nativeConversationId: string | null };
  reportedCompleteSubtotal: {
    completeTurns: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: { sum: number; reportedTurns: number };
    cacheCreationTokens: { sum: number; reportedTurns: number };
    reasoningTokens: { sum: number; reportedTurns: number };
  };
}): string => {
  const { scope, reportedCompleteSubtotal: subtotal } = bucket;
  const conversation =
    scope.nativeConversationId === null ? "(turn identity)" : scope.nativeConversationId;
  return [
    `  ${scope.driver}/${scope.instanceId}/${conversation}:`,
    `${subtotal.completeTurns} complete turn(s),`,
    `in ${subtotal.inputTokens}, out ${subtotal.outputTokens},`,
    `cached ${subtotal.cachedInputTokens.sum} over ${subtotal.cachedInputTokens.reportedTurns} turn(s),`,
    `cache-write ${subtotal.cacheCreationTokens.sum} over ${subtotal.cacheCreationTokens.reportedTurns} turn(s),`,
    `reasoning ${subtotal.reasoningTokens.sum} over ${subtotal.reasoningTokens.reportedTurns} turn(s)`,
  ].join(" ");
};

const formatOwnedUsageText = (outcome: OwnedThreadUsageOutcome): string => {
  if (outcome.status === "missing-create") {
    return `No retained thread.created event for ${outcome.threadId} through sequence ${outcome.readThroughSequence}. Nothing to report.`;
  }
  if (outcome.status === "too-large") {
    return `Thread ${outcome.threadId} history is too large to read: ${outcome.eventCount} events (limit ${OWNED_USAGE_MAX_EVENTS}) through sequence ${outcome.readThroughSequence}. No usage reported.`;
  }
  const { report } = outcome;
  const { main } = report;
  const childFrames = report.children.reduce((sum, child) => sum + child.frames.length, 0);
  const duplicateDeliveries = report.children.reduce(
    (sum, child) => sum + child.duplicateDeliveryCount,
    main.duplicateDeliveryCount,
  );
  return [
    `Owned usage for ${report.threadId} — read through sequence ${report.readThroughSequence}, current incarnation starts at ${report.incarnationSequence}.`,
    `main: ${main.complete} complete, ${main.partial} partial, ${main.unavailable} unavailable, ${main.ambiguous} ambiguous, ${main.conflict} conflicted deliveries, ${main.unscoped} unscoped, ${main.unrecorded} unrecorded (observed without a receipt), ${main.invalid} invalid.`,
    ...main.buckets.map(formatBucketLine),
    ...(main.buckets.length === 0 ? ["  no bucketable main-turn usage in this incarnation."] : []),
    `children: ${report.children.length} identity-unknown group(s) with ${childFrames} frame(s), ${report.legacyChildFrames} legacy frame(s).`,
    `${duplicateDeliveries} duplicate delivery(ies) folded across main and children.`,
    "Numbers are adapter-reported sums per source bucket only; parent/child overlap is unknown, so no combined total exists.",
  ].join("\n");
};

const ownedCommand = Command.make("owned", {
  threadId: Argument.String("thread-id").pipe(
    Argument.withDescription("Thread to report owned usage for."),
    Argument.withSchema(ThreadId),
  ),
  baseDir: baseDirFlag,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit the report as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Report usage the server recorded for one thread, from the local event store.",
  ),
  Command.withHandler(
    Effect.fn("cli.usage.owned")(function* (flags) {
      const cliLogLevel = yield* GlobalFlag.LogLevel;
      // JSON must own stdout; an explicit --log-level still wins.
      const minimumLogLevel = Option.getOrElse(cliLogLevel, () =>
        flags.json ? ("Error" as const) : ("Warn" as const),
      );
      // The whole local operation — path resolution, the existence probe, the
      // read-only open, and the read — reports typed failures through one
      // CliError.UserError so the runner renders the fixed message on the
      // error channel instead of the runtime reporter dumping the raw error
      // and stack on stdout. dbPath rides the closure so the summary names
      // the selected path only once resolution produced it.
      let dbPath: string | undefined;
      const outcome = yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const selectedDbPath = yield* resolveOwnedUsageDbPath(flags.baseDir);
        dbPath = selectedDbPath;
        if (!(yield* fs.exists(selectedDbPath))) {
          return yield* new OwnedUsageDatabaseMissingError({ dbPath: selectedDbPath });
        }
        // One read-only SQL layer, provided into the event store (whose head
        // query and replay share that client) and into the reader through
        // provideMerge — never a second client, never the migrating layer.
        // The log level reference rides outside that composition.
        const sqlite = NodeSqliteClient.layer({ filename: selectedDbPath, readonly: true });
        const readerLayer = Layer.provideMerge(
          OwnedUsageReaderLive,
          Layer.provideMerge(OrchestrationEventStoreLive, sqlite),
        );
        return yield* Effect.gen(function* () {
          const reader = yield* OwnedUsageReader;
          return yield* reader.read(flags.threadId);
        }).pipe(
          // Provide before catching: a failed read-only open (SqlError at
          // layer build) must reach the same typed summary as read failures
          // instead of escaping as a raw defect.
          Effect.provide(
            Layer.merge(readerLayer, Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        );
      }).pipe(
        // Cause-aware boundary: only a non-interrupted cause carrying a typed
        // failure becomes the fixed UserError — interrupt-bearing causes are
        // re-raised untouched and defect-only causes stay defects. Effect.catch
        // would wrongly swallow the interrupt alongside a found failure.
        Effect.catchCause(
          <E>(cause: Cause.Cause<E>): Effect.Effect<never, E | CliError.UserError> => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
            const error = Cause.findErrorOption(cause);
            if (Option.isNone(error)) return Effect.failCause(cause);
            return Effect.fail(
              new CliError.UserError({
                cause: error.value,
                userMessage: summarizeFailure(dbPath, error.value),
              }),
            );
          },
        ),
      );
      yield* Console.log(
        flags.json ? JSON.stringify(outcome, null, 2) : formatOwnedUsageText(outcome),
      );
    }),
  ),
);

export const usageCommand = Command.make("usage").pipe(
  Command.withDescription("Inspect recorded provider usage."),
  Command.withSubcommands([ownedCommand]),
);
