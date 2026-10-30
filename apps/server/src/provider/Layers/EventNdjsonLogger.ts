// @effect-diagnostics nodeBuiltinImport:off
/**
 * Best-effort provider event logging with one shared writer per thread.
 *
 * Native and canonical views share batching, rotation, and retention state so
 * they cannot race while appending to the same thread-scoped file.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ThreadId } from "@t3tools/contracts";
import { RotatingFileSink } from "@t3tools/shared/logging";
import { errorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import type { ResourceAttribution } from "../../resourceTelemetry/ResourceAttribution.ts";

const MEBIBYTE = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 10 * MEBIBYTE;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_BATCH_WINDOW_MS = 1_000;
// Diagnostic logs: a week and 256 MiB cover a support request without filling a small disk.
const DEFAULT_MAX_TOTAL_BYTES = 256 * MEBIBYTE;
const DEFAULT_MAX_AGE_MS = 7 * DAY_MS;
const DEFAULT_RETENTION_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_BUFFERED_BYTES = MEBIBYTE;
const DEFAULT_MAX_BUFFERED_RECORDS = 512;
/** Restricted taint lookups are chunked below typical SQLite variable limits. */
const MAX_TAINT_LOOKUP_IDS = 500;
const MAX_RECORD_CHARACTERS = 64 * 1024;
const MAX_RECORD_FIELDS = 1_024;
const MAX_RECORD_DEPTH = 16;
const GLOBAL_THREAD_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const transientCanonicalEventTypes = new Set([
  "content.delta",
  "hook.progress",
  "item.updated",
  "task.progress",
  "thread.realtime.audio.delta",
  "tool.progress",
  "turn.proposed.delta",
]);
const transientNativeMethods = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/transcript/delta",
  "turn/diff/updated",
]);
const transientAcpUpdates = new Set(["agent_message_chunk", "agent_thought_chunk"]);

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

export interface EventNdjsonLogger {
  readonly filePath: string;
  readonly write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export interface EventNdjsonLogStore {
  readonly filePath: string;
  readonly logger: (stream: EventNdjsonStream) => EventNdjsonLogger;
  readonly close: () => Effect.Effect<void>;
}

export interface EventNdjsonLogStoreOptions {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly batchWindowMs?: number;
  readonly maxTotalBytes?: number;
  readonly maxAgeMs?: number;
  readonly retentionCheckIntervalMs?: number;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedRecords?: number;
  readonly attribution?: ResourceAttribution["Service"];
  /** Committed-memory threads among `threadIds`, or all when `undefined`. Failures and defects
   *  are classified by the store with fixed tags; interrupts propagate. */
  readonly taintedThreads?: (
    threadIds: ReadonlyArray<ThreadId> | undefined,
  ) => Effect.Effect<ReadonlySet<ThreadId>, unknown>;
}

export interface EventNdjsonLoggerOptions extends EventNdjsonLogStoreOptions {
  readonly stream: EventNdjsonStream;
}

export class EventNdjsonLogConfigurationError extends Schema.TaggedError<EventNdjsonLogConfigurationError>()(
  "EventNdjsonLogConfigurationError",
  {
    filePath: Schema.String,
    option: Schema.String,
    value: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `Provider event log option '${this.option}' must be an integer >= ${this.minimum}; received ${this.value} for '${this.filePath}'`;
  }
}

export class EventNdjsonLogDirectoryError extends Schema.TaggedError<EventNdjsonLogDirectoryError>()(
  "EventNdjsonLogDirectoryError",
  {
    directory: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create provider event log directory '${this.directory}'`;
  }
}

export type EventNdjsonLogStoreError =
  | EventNdjsonLogConfigurationError
  | EventNdjsonLogDirectoryError;

interface ResolvedOptions {
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly retentionCheckIntervalMs: number;
  readonly maxBufferedBytes: number;
  readonly maxBufferedRecords: number;
  readonly attribution: ResourceAttribution["Service"] | undefined;
}

export interface PendingRecord {
  readonly stream: EventNdjsonStream;
  readonly threadId: ThreadId | null;
  readonly threadSegment: string;
  readonly line: string;
  readonly bytes: number;
}

/**
 * Fixed local classifications for committed-memory taint work. Foreign causes,
 * messages, and error tags never cross into the diagnostics.
 */
type TaintFailure = "lookup-failed" | "lookup-defect" | "purge-failed" | "unrepresentable-segment";

type TaintLookupOutcome =
  | { readonly found: ReadonlySet<ThreadId> }
  | { readonly failure: "lookup-failed" | "lookup-defect" };

type InterruptRestore = <AX, EX, RX>(
  effect: Effect.Effect<AX, EX, RX>,
) => Effect.Effect<AX, EX, RX>;

/** Interrupts propagate; typed failures and defects collapse to fixed tags. */
const runTaintLookup = (
  lookup: Effect.Effect<ReadonlySet<ThreadId>, unknown>,
): Effect.Effect<TaintLookupOutcome> =>
  lookup.pipe(
    Effect.map((found) => ({ found })),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(Cause.interrupt())
        : Effect.succeed({
            failure: Cause.hasFails(cause)
              ? ("lookup-failed" as const)
              : ("lookup-defect" as const),
          }),
    ),
  );

interface StoreState {
  readonly pending: Array<PendingRecord>;
  readonly pendingBytes: number;
  readonly sinks: ReadonlyMap<string, RotatingFileSink>;
  readonly flushScheduled: boolean;
  readonly closed: boolean;
  readonly lastRetentionAt: number;
  readonly fullScanPending: boolean;
  readonly purgePending: ReadonlySet<string>;
}

interface AttributionSummary {
  readonly stream: EventNdjsonStream;
  readonly count: number;
  readonly logicalWriteBytes: number;
}

interface FileOperationFailure {
  readonly filePath: string;
  readonly cause: unknown;
}

interface RetentionResult {
  readonly failures: ReadonlyArray<FileOperationFailure>;
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  return stream === "native" ? "NTIVE" : stream === "orchestration" ? "ORCH" : "CANON";
}

function providerLogPrefix(filePath: string): string {
  const basename = NodePath.basename(filePath);
  const extension = NodePath.extname(basename);
  return `${extension.length > 0 ? basename.slice(0, -extension.length) : basename}.`;
}

function providerLogPath(directory: string, prefix: string, threadSegment: string): string {
  return NodePath.join(directory, `${prefix}${threadSegment}.log`);
}

function shouldPersistProviderEvent(stream: EventNdjsonStream, event: unknown): boolean {
  if (stream === "orchestration" || typeof event !== "object" || event === null) {
    return true;
  }
  try {
    const type = Reflect.get(event, "type");
    if (typeof type === "string" && transientCanonicalEventTypes.has(type)) {
      return false;
    }
    if (stream !== "native") return true;

    const nested = Reflect.get(event, "event");
    const envelope = typeof nested === "object" && nested !== null ? nested : event;
    // Decoded frames carry the same information as raw frames without another
    // copy of every token delta. Decode failures have their own diagnostic frame.
    if (Reflect.get(envelope, "stage") === "raw") return false;
    const decodedPayload = Reflect.get(envelope, "payload");
    const nativeEvent =
      Reflect.get(envelope, "stage") === "decoded" &&
      typeof decodedPayload === "object" &&
      decodedPayload !== null
        ? decodedPayload
        : envelope;
    const method = Reflect.get(nativeEvent, "method");
    if (
      typeof method === "string" &&
      (transientNativeMethods.has(method) ||
        method.startsWith("claude/stream_event/content_block_delta/"))
    ) {
      return false;
    }

    const nativeType = Reflect.get(nativeEvent, "type");
    if (nativeType === "message.part.delta") return false;
    if (nativeType === "stream_event") {
      const streamEvent = Reflect.get(nativeEvent, "event");
      if (
        typeof streamEvent === "object" &&
        streamEvent !== null &&
        Reflect.get(streamEvent, "type") === "content_block_delta"
      ) {
        return false;
      }
    }

    const payload = Reflect.get(nativeEvent, "payload");
    if (typeof payload !== "object" || payload === null) return true;

    if (method === "session/update") {
      const update = Reflect.get(payload, "update");
      if (typeof update !== "object" || update === null) return true;
      const updateType = Reflect.get(update, "sessionUpdate");
      return typeof updateType !== "string" || !transientAcpUpdates.has(updateType);
    }

    if (nativeType === "message.part.updated") {
      const properties = Reflect.get(payload, "properties");
      if (typeof properties !== "object" || properties === null) return true;
      const part = Reflect.get(properties, "part");
      if (typeof part !== "object" || part === null) return true;
      const partType = Reflect.get(part, "type");
      if (partType === "text" || partType === "reasoning") return false;
      if (partType === "tool") {
        // Running snapshots repeat growing output. Pending and terminal states stay in the log.
        const state = Reflect.get(part, "state");
        if (typeof state === "object" && state !== null) {
          return Reflect.get(state, "status") !== "running";
        }
      }
      return true;
    }

    return true;
  } catch {
    return true;
  }
}

const summaryFields = [
  "provider",
  "protocol",
  "kind",
  "providerSessionId",
  "direction",
  "stage",
  "type",
  "subtype",
  "method",
  "id",
  "threadId",
  "turnId",
  "requestId",
  "session_id",
  "status",
  "is_error",
  "api_error_status",
  "terminal_reason",
  "stop_reason",
  "operation",
  "code",
  "willRetry",
  "message",
  "event",
  "payload",
  "params",
  "result",
  "thread",
  "turn",
  "error",
  "turns",
  "items",
  "content",
] as const;

function summarizeProviderEvent(event: unknown): unknown {
  let remainingFields = 128;
  let remainingCharacters = 8 * 1024;
  const summarize = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      if (value.length > Math.min(1_024, remainingCharacters)) {
        return { omittedCharacters: value.length };
      }
      remainingCharacters -= value.length;
      return value;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value !== "object") return undefined;
    if (Array.isArray(value)) return { itemCount: value.length };
    const summary: Record<string, unknown> = { truncated: true };
    if (depth >= 6) return summary;
    for (const key of summaryFields) {
      if (remainingFields <= 0) break;
      const nested = Reflect.get(value, key);
      if (nested === undefined) continue;
      remainingFields -= 1;
      summary[key] = summarize(nested, depth + 1);
    }
    return summary;
  };
  try {
    return summarize(event, 0);
  } catch {
    return { truncated: true };
  }
}

/** Bounds traversal before the logger encodes payloads. */
function boundProviderEventForLogging(event: unknown): unknown {
  let remainingCharacters = MAX_RECORD_CHARACTERS;
  let remainingFields = MAX_RECORD_FIELDS;
  const ancestors = new WeakSet<object>();
  const fits = (value: unknown, depth: number): boolean => {
    if (typeof value === "string") {
      remainingCharacters -= value.length;
      return remainingCharacters >= 0;
    }
    if (typeof value !== "object" || value === null) return true;
    if (depth > MAX_RECORD_DEPTH || ancestors.has(value)) return false;
    if (Array.isArray(value) && value.length > remainingFields) return false;
    ancestors.add(value);
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      remainingFields -= 1;
      remainingCharacters -= key.length;
      if (
        remainingFields < 0 ||
        remainingCharacters < 0 ||
        !fits(Reflect.get(value, key), depth + 1)
      )
        return false;
    }
    ancestors.delete(value);
    return true;
  };
  try {
    if (fits(event, 0)) return event;
  } catch {
    // A failing accessor must not escape into provider processing.
  }
  return summarizeProviderEvent(event);
}

export function writeBatchedMessages(
  sink: Pick<RotatingFileSink, "write">,
  records: ReadonlyArray<PendingRecord>,
  maxBytes: number,
  onWritten: (records: ReadonlyArray<PendingRecord>) => void,
): void {
  let pendingRecords: Array<PendingRecord> = [];
  let pendingBytes = 0;

  const flush = () => {
    if (pendingRecords.length === 0) return;
    const writtenRecords = pendingRecords;
    sink.write(writtenRecords.map((record) => record.line).join(""));
    onWritten(writtenRecords);
    pendingRecords = [];
    pendingBytes = 0;
  };

  for (const record of records) {
    if (pendingBytes > 0 && pendingBytes + record.bytes > maxBytes) {
      flush();
    }
    pendingRecords.push(record);
    pendingBytes += record.bytes;
    if (pendingBytes >= maxBytes) {
      flush();
    }
  }
  flush();
}

function isProviderLogFile(filePath: string, fileName: string, filePrefix: string): boolean {
  if (!/\.log(?:\.\d+)?$/u.test(fileName)) return false;
  if (fileName.startsWith(filePrefix)) return true;

  const descriptor = NodeFS.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(256);
    const bytesRead = NodeFS.readSync(descriptor, header, 0, header.byteLength, 0);
    return /^\[[^\]\r\n]+\] (?:NTIVE|CANON|ORCH): /u.test(header.toString("utf8", 0, bytesRead));
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

function enforceRetention(input: {
  readonly directory: string;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly activeFilePaths: ReadonlySet<string>;
  readonly filePrefix: string;
  readonly now: number;
}): RetentionResult {
  const failures: Array<FileOperationFailure> = [];
  const files: Array<{ filePath: string; mtimeMs: number; size: number }> = [];

  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(input.directory, { withFileTypes: true });
  } catch (cause) {
    return { failures: [{ filePath: input.directory, cause }] };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = NodePath.join(input.directory, entry.name);
    try {
      if (!isProviderLogFile(filePath, entry.name, input.filePrefix)) continue;
      const stat = NodeFS.statSync(filePath);
      files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (cause) {
      failures.push({ filePath, cause });
    }
  }

  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  const remove = (file: (typeof files)[number]) => {
    if (input.activeFilePaths.has(file.filePath)) return false;
    try {
      NodeFS.rmSync(file.filePath, { force: true });
      totalBytes -= file.size;
      return true;
    } catch (cause) {
      failures.push({ filePath: file.filePath, cause });
      return false;
    }
  };

  const retained = files.filter((file) => {
    if (input.now - file.mtimeMs <= input.maxAgeMs) return true;
    return !remove(file);
  });

  for (const file of retained.toSorted(
    (left, right) => left.mtimeMs - right.mtimeMs || left.filePath.localeCompare(right.filePath),
  )) {
    if (totalBytes <= input.maxTotalBytes) break;
    remove(file);
  }

  return { failures };
}

function validateOption(input: {
  readonly filePath: string;
  readonly option: string;
  readonly value: number;
  readonly minimum: number;
}): EventNdjsonLogConfigurationError | undefined {
  if (Number.isInteger(input.value) && input.value >= input.minimum) return undefined;
  return new EventNdjsonLogConfigurationError(input);
}

function resolveOptions(
  filePath: string,
  options: EventNdjsonLogStoreOptions,
): Effect.Effect<ResolvedOptions, EventNdjsonLogConfigurationError> {
  const resolved = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    batchWindowMs: options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    retentionCheckIntervalMs:
      options.retentionCheckIntervalMs ?? DEFAULT_RETENTION_CHECK_INTERVAL_MS,
    maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
    maxBufferedRecords: options.maxBufferedRecords ?? DEFAULT_MAX_BUFFERED_RECORDS,
    attribution: options.attribution,
  } satisfies ResolvedOptions;

  const validations = [
    ["maxBytes", resolved.maxBytes, 1],
    ["maxFiles", resolved.maxFiles, 1],
    ["batchWindowMs", resolved.batchWindowMs, 0],
    ["maxTotalBytes", resolved.maxTotalBytes, 1],
    ["maxAgeMs", resolved.maxAgeMs, 1],
    ["retentionCheckIntervalMs", resolved.retentionCheckIntervalMs, 1],
    ["maxBufferedBytes", resolved.maxBufferedBytes, 1],
    ["maxBufferedRecords", resolved.maxBufferedRecords, 1],
  ] as const;

  for (const [option, value, minimum] of validations) {
    const error = validateOption({ filePath, option, value, minimum });
    if (error) return Effect.fail(error);
  }
  return Effect.succeed(resolved);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes exactly the current log file and every decimal rotation of one
 * segment, including rotations beyond `maxFiles`. The name pattern never
 * matches historical `_global` files, other segments, or other prefixes, and
 * file content is never inspected to authorize a deletion.
 */
function purgeSegmentFiles(input: {
  readonly directory: string;
  readonly filePrefix: string;
  readonly segment: string;
}): ReadonlyArray<FileOperationFailure> {
  const filePattern = new RegExp(
    `^${escapeRegExp(`${input.filePrefix}${input.segment}.log`)}(?:\\.\\d+)?$`,
    "u",
  );
  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(input.directory, { withFileTypes: true });
  } catch (cause) {
    return [{ filePath: input.directory, cause }];
  }
  const failures: Array<FileOperationFailure> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !filePattern.test(entry.name)) continue;
    const filePath = NodePath.join(input.directory, entry.name);
    try {
      NodeFS.rmSync(filePath, { force: true });
    } catch (cause) {
      failures.push({ filePath, cause });
    }
  }
  return failures;
}

/**
 * Writes already-admitted records to segment sinks and runs retention when
 * due. There is deliberately no `closed` check: the final drain after
 * `closed=true` must still write the last admitted batch.
 */
function writeRecordsToSinks(input: {
  readonly directory: string;
  readonly options: ResolvedOptions;
  readonly filePrefix: string;
  readonly now: number;
  readonly records: ReadonlyArray<PendingRecord>;
  readonly sinks: Map<string, RotatingFileSink>;
  readonly lastRetentionAt: number;
}): {
  readonly attributions: ReadonlyArray<AttributionSummary>;
  readonly failures: ReadonlyArray<FileOperationFailure>;
  readonly lastRetentionAt: number;
} {
  const sinks = input.sinks;
  const failures: Array<FileOperationFailure> = [];
  const attributionByStream = new Map<
    EventNdjsonStream,
    { count: number; logicalWriteBytes: number }
  >();
  const recordsBySegment = new Map<string, Array<PendingRecord>>();

  for (const record of input.records) {
    const records = recordsBySegment.get(record.threadSegment) ?? [];
    records.push(record);
    recordsBySegment.set(record.threadSegment, records);
  }

  for (const [threadSegment, records] of recordsBySegment) {
    const filePath = providerLogPath(input.directory, input.filePrefix, threadSegment);
    let sink = sinks.get(threadSegment);
    if (!sink) {
      try {
        sink = new RotatingFileSink({
          filePath,
          maxBytes: input.options.maxBytes,
          maxFiles: input.options.maxFiles,
          throwOnError: true,
        });
        sinks.set(threadSegment, sink);
      } catch (cause) {
        failures.push({ filePath, cause });
        continue;
      }
    }

    try {
      writeBatchedMessages(sink, records, input.options.maxBytes, (writtenRecords) => {
        for (const record of writtenRecords) {
          const current = attributionByStream.get(record.stream) ?? {
            count: 0,
            logicalWriteBytes: 0,
          };
          attributionByStream.set(record.stream, {
            count: current.count + 1,
            logicalWriteBytes: current.logicalWriteBytes + record.bytes,
          });
        }
      });
    } catch (cause) {
      sinks.delete(threadSegment);
      failures.push({ filePath, cause });
    }
  }

  const retentionDue = input.now - input.lastRetentionAt >= input.options.retentionCheckIntervalMs;
  const retention = retentionDue
    ? enforceRetention({
        directory: input.directory,
        maxTotalBytes: input.options.maxTotalBytes,
        maxAgeMs: input.options.maxAgeMs,
        activeFilePaths: new Set(
          Array.from(sinks.keys(), (threadSegment) =>
            providerLogPath(input.directory, input.filePrefix, threadSegment),
          ),
        ),
        filePrefix: input.filePrefix,
        now: input.now,
      })
    : { failures: [] };

  return {
    attributions: Array.from(attributionByStream, ([stream, value]) => ({
      stream,
      ...value,
    })),
    failures: [...failures, ...retention.failures],
    lastRetentionAt: retentionDue ? input.now : input.lastRetentionAt,
  };
}

const serializeEvent = Effect.fnUntraced(function* (event: unknown) {
  return yield* encodeUnknownJsonString(event).pipe(
    Effect.catch((error) =>
      logWarning("failed to serialize provider event log record", {
        errorTag: errorTag(error),
      }).pipe(Effect.as(undefined)),
    ),
  );
});

export const makeEventNdjsonLogStore = Effect.fnUntraced(function* (
  filePath: string,
  options: EventNdjsonLogStoreOptions = {},
): Effect.fn.Return<EventNdjsonLogStore, EventNdjsonLogStoreError> {
  const resolved = yield* resolveOptions(filePath, options);
  const taintedThreads = options.taintedThreads;
  const directory = NodePath.dirname(filePath);
  const filePrefix = providerLogPrefix(filePath);

  yield* Effect.try({
    try: () => NodeFS.mkdirSync(directory, { recursive: true }),
    catch: (cause) => new EventNdjsonLogDirectoryError({ directory, cause }),
  });

  const initializedAt = yield* Clock.currentTimeMillis;
  const initialRetention = yield* Effect.sync(() =>
    enforceRetention({
      directory,
      maxTotalBytes: resolved.maxTotalBytes,
      maxAgeMs: resolved.maxAgeMs,
      activeFilePaths: new Set(),
      filePrefix,
      now: initializedAt,
    }),
  );
  for (const failure of initialRetention.failures) {
    yield* logWarning("provider event log retention failed", {
      filePath: failure.filePath,
      errorTag: errorTag(failure.cause),
    });
  }

  // Monotonic cache of decoded positive taint results. Negative results are
  // never cached, so unknown threads keep being re-checked until resolved.
  const tainted = new Set<ThreadId>();
  const stateRef = yield* SynchronizedRef.make<StoreState>({
    pending: [],
    pendingBytes: 0,
    sinks: new Map(),
    flushScheduled: false,
    closed: false,
    lastRetentionAt: initializedAt,
    fullScanPending: options.taintedThreads !== undefined,
    purgePending: new Set<string>(),
  });
  const timerScope = yield* Scope.make();
  // Only the flusher runs lookups, purges, and drains. SQL awaits happen while
  // this permit is held but outside the SynchronizedRef lock.
  const flushLock = yield* Semaphore.make(1);

  // One protected transition: a cached positive always carries its durable
  // purge obligation (and, for a full scan, the completed-scan flag), so no
  // interrupt between lookups can lose the historical cleanup. Purge-failure
  // retries stay in purgePending independently of cache membership.
  const admitPositives = (found: ReadonlySet<ThreadId>, clearFullScan: boolean) =>
    SynchronizedRef.modify(stateRef, (state): readonly [number, StoreState] => {
      const purgePending = new Set(state.purgePending);
      let unrepresentable = 0;
      for (const id of found) {
        if (tainted.has(id)) continue;
        tainted.add(id);
        const segment = toSafeThreadAttachmentSegment(id);
        if (segment === null) {
          unrepresentable += 1;
          continue;
        }
        purgePending.add(segment);
      }
      return [
        unrepresentable,
        {
          ...state,
          purgePending,
          fullScanPending: clearFullScan ? false : state.fullScanPending,
        },
      ];
    });

  const scheduleFlush = Effect.fnUntraced(function* () {
    yield* Effect.forkIn(
      Effect.sleep(resolved.batchWindowMs).pipe(Effect.andThen(flush(true))),
      timerScope,
      { startImmediately: true },
    );
  });

  const flushBody = Effect.fnUntraced(function* (timerFired: boolean, restore: InterruptRestore) {
    const startedAt = yield* Clock.currentTimeMillis;

    // Masked: no interrupt can land between detaching the batch and installing
    // its ownership recovery below. Detach is atomic; writes arriving during
    // the lookups replace `pending` instead of pushing into the detached
    // array, so they cannot mix with records whose taint state is unresolved.
    const batch = yield* SynchronizedRef.modify(
      stateRef,
      (state): readonly [Array<PendingRecord>, StoreState] => [
        state.pending,
        {
          ...state,
          pending: [],
          pendingBytes: 0,
          flushScheduled: timerFired ? false : state.flushScheduled,
        },
      ],
    );
    const batchBytes = batch.reduce((total, record) => total + record.bytes, 0);

    // The detached batch stays owned until the drain commits its outcome. The
    // flag is cleared inside the same synchronous section that consumes the
    // batch, so an interrupt during later warnings must not replay written
    // records.
    let batchOwned = true;

    yield* Effect.gen(function* () {
      let lookupFailed = false;
      let lookupFailureTag: "lookup-failed" | "lookup-defect" = "lookup-failed";
      const taintCounts = new Map<TaintFailure, number>();
      const countTaint = (tag: TaintFailure, count: number) => {
        taintCounts.set(tag, (taintCounts.get(tag) ?? 0) + count);
      };
      // Lookups are the only waits inside the protected body; they stay
      // interruptible for every caller, including masked finalizers.
      const lookup = (call: Effect.Effect<ReadonlySet<ThreadId>, unknown>) =>
        Effect.interruptible(restore(runTaintLookup(call)));

      const currentState = yield* SynchronizedRef.get(stateRef);
      if (taintedThreads !== undefined && currentState.fullScanPending) {
        const outcome = yield* lookup(taintedThreads(undefined));
        if ("found" in outcome) {
          const unrepresentable = yield* admitPositives(outcome.found, true);
          if (unrepresentable > 0) countTaint("unrepresentable-segment", unrepresentable);
        } else {
          countTaint(outcome.failure, 0);
        }
      }

      const ids = new Set<ThreadId>();
      for (const record of batch) {
        if (record.threadId !== null && !tainted.has(record.threadId)) {
          ids.add(record.threadId);
        }
      }
      if (taintedThreads !== undefined && ids.size > 0) {
        // Concurrent writers can grow a batch past the admission window while
        // a flusher waits, so the restricted lookup is chunked. Any failed
        // chunk fails the whole batch lookup, and no partial result is cached.
        const chunked = Array.from(ids);
        const found = new Set<ThreadId>();
        let failure: "lookup-failed" | "lookup-defect" | undefined;
        for (let index = 0; index < chunked.length; index += MAX_TAINT_LOOKUP_IDS) {
          const outcome = yield* lookup(
            taintedThreads(chunked.slice(index, index + MAX_TAINT_LOOKUP_IDS)),
          );
          if (!("found" in outcome)) {
            failure = outcome.failure;
            break;
          }
          for (const id of outcome.found) found.add(id);
        }
        if (failure === undefined) {
          const unrepresentable = yield* admitPositives(found, false);
          if (unrepresentable > 0) countTaint("unrepresentable-segment", unrepresentable);
        } else {
          lookupFailed = true;
          lookupFailureTag = failure;
        }
      }

      // Masked: the drain commits its outcome without an interruption window.
      const written = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
        Effect.sync(() => {
          // Ownership of the batch ends here, together with the state
          // commit that consumes it.
          batchOwned = false;
          const sinks = new Map(state.sinks);
          let purgePending = state.purgePending;
          let purgeFailedSegments = 0;
          if (purgePending.size > 0) {
            const remaining = new Set<string>();
            for (const segment of purgePending) {
              // Evict the sink before deleting so later writes cannot reuse
              // its cached size; RotatingFileSink has no close API.
              sinks.delete(segment);
              const purgeFailures = purgeSegmentFiles({ directory, filePrefix, segment });
              if (purgeFailures.length > 0) {
                remaining.add(segment);
                purgeFailedSegments += 1;
              }
            }
            purgePending = remaining;
          }

          // Fail-closed: an unresolved lookup discards every thread record
          // in the batch, while null-thread records always stay. Known
          // tainted threads are dropped even when the lookup succeeded.
          const kept = batch.filter(
            (record) =>
              record.threadId === null || (!lookupFailed && !tainted.has(record.threadId)),
          );
          if (lookupFailed) {
            countTaint(lookupFailureTag, batch.length - kept.length);
          }
          const result = writeRecordsToSinks({
            directory,
            options: resolved,
            filePrefix,
            now: startedAt,
            records: kept,
            sinks,
            lastRetentionAt: state.lastRetentionAt,
          });
          return [
            { result, purgeFailedSegments },
            {
              ...state,
              sinks,
              lastRetentionAt: result.lastRetentionAt,
              purgePending,
            },
          ] as const;
        }),
      );

      for (const failure of written.result.failures) {
        yield* logWarning("provider event log write or retention failed", {
          filePath: failure.filePath,
          errorTag: errorTag(failure.cause),
        });
      }
      if (written.purgeFailedSegments > 0) {
        countTaint("purge-failed", written.purgeFailedSegments);
      }
      for (const [tag, count] of taintCounts) {
        yield* logWarning(`provider event log taint ${tag}`, { failure: tag, count });
      }

      if (resolved.attribution && written.result.attributions.length > 0) {
        const completedAt = yield* Clock.currentTimeMillis;
        const durationMs = Math.max(0, completedAt - startedAt);
        const totalBytes = written.result.attributions.reduce(
          (total, entry) => total + entry.logicalWriteBytes,
          0,
        );
        yield* Effect.forEach(
          written.result.attributions,
          (entry) =>
            resolved.attribution?.record({
              component: "provider-event-log",
              operation: `${entry.stream}.append`,
              logicalWriteBytes: entry.logicalWriteBytes,
              count: entry.count,
              durationMs:
                totalBytes === 0
                  ? 0
                  : Math.round(durationMs * (entry.logicalWriteBytes / totalBytes)),
            }) ?? Effect.void,
          { discard: true },
        );
      }
    }).pipe(
      Effect.onInterrupt(() => {
        if (!batchOwned) {
          return Effect.void;
        }
        return SynchronizedRef.modify(stateRef, (state) => {
          // The batch was never checked, so it returns to the front unsent.
          const pending = [...batch, ...state.pending];
          // A timer flush already cleared `flushScheduled`; without a
          // replacement timer the requeued records would never drain.
          const needsTimer = pending.length > 0 && !state.closed && !state.flushScheduled;
          return [
            needsTimer,
            {
              ...state,
              pending,
              pendingBytes: batchBytes + state.pendingBytes,
              flushScheduled: state.flushScheduled || needsTimer,
            },
          ] as const;
        }).pipe(Effect.flatMap((needsTimer) => (needsTimer ? scheduleFlush() : Effect.void)));
      }),
    );
  });

  // The body runs masked so detach, ownership, drain, and purge cannot be torn
  // by a boundary interrupt; only the lookup waits restore interruptibility.
  // The permit wait itself is left to the caller's interrupt status.
  const flush = (timerFired: boolean): Effect.Effect<void> =>
    flushLock.withPermit(Effect.uninterruptibleMask((restore) => flushBody(timerFired, restore)));

  // Every close exit must run the final drain behind the flush permit and tear
  // down the timer scope, including exits where the drain is interrupted, so
  // no timer can fire into a closed store. The closed transition stays in the
  // protected entry; the permit-plus-drain invocation is explicitly marked
  // interruptible because `restore` is identity under an inherited mask, so an
  // already-masked scope finalizer could otherwise never be interrupted while
  // waiting behind a flusher. An abandoned drain reports the historical
  // cleanup that still pends instead of claiming it completed.
  const close = () =>
    Effect.uninterruptibleMask(() => {
      let drained = false;
      return Effect.gen(function* () {
        // Protected close entry: once close starts, no new writes are admitted.
        yield* SynchronizedRef.update(stateRef, (state) =>
          state.closed ? state : { ...state, closed: true },
        );
        yield* Effect.interruptible(flush(false));
        drained = true;
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Scope.close(timerScope, Exit.void);
            if (drained) return;
            const state = yield* SynchronizedRef.get(stateRef);
            if (state.fullScanPending) {
              yield* logWarning("provider event log taint lookup-failed", {
                failure: "lookup-failed",
                count: 0,
              });
            }
            if (state.purgePending.size > 0) {
              yield* logWarning("provider event log taint purge-failed", {
                failure: "purge-failed",
                count: state.purgePending.size,
              });
            }
          }),
        ),
      );
    });

  // The open flush performs the initial full taint scan and any historical
  // purge for this store. Failures stay pending and are retried by later
  // flushes and at close.
  yield* flush(false);

  const loggerViews = new Map<EventNdjsonStream, EventNdjsonLogger>();
  const logger = (stream: EventNdjsonStream): EventNdjsonLogger => {
    const existing = loggerViews.get(stream);
    if (existing) return existing;

    const write = Effect.fnUntraced(function* (event: unknown, threadId: ThreadId | null) {
      if (!shouldPersistProviderEvent(stream, event)) return;
      // Cached positives never reach serialization.
      if (threadId !== null && tainted.has(threadId)) return;
      let payload = yield* serializeEvent(boundProviderEventForLogging(event));
      if (payload === undefined) return;
      // Escaping can expand strings beyond their input size. Keep that bounded
      // serialization out of the file too, while retaining routing/error fields.
      if (Buffer.byteLength(payload) > MAX_RECORD_CHARACTERS) {
        payload = yield* serializeEvent(summarizeProviderEvent(event));
        if (payload === undefined) return;
      }

      const observedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const line = `[${observedAt}] ${resolveStreamLabel(stream)}: ${payload}\n`;
      const bytes = Buffer.byteLength(line);
      const record: PendingRecord = {
        stream,
        threadId,
        threadSegment: resolveThreadSegment(threadId),
        line,
        bytes,
      };
      const action = yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
        if (state.closed) {
          return Effect.succeed([{ flush: false }, state] as const);
        }
        // A fresh array keeps the detached batch of an in-flight flush
        // separate from records admitted after it.
        const pending = [...state.pending, record];
        const pendingBytes = state.pendingBytes + bytes;
        const flushNow =
          resolved.batchWindowMs === 0 ||
          pending.length >= resolved.maxBufferedRecords ||
          pendingBytes >= resolved.maxBufferedBytes;
        const schedule = !flushNow && !state.flushScheduled;
        const nextState = {
          ...state,
          pending,
          pendingBytes,
          flushScheduled: state.flushScheduled || schedule,
        };
        return (schedule ? scheduleFlush() : Effect.void).pipe(
          Effect.as([{ flush: flushNow }, nextState] as const),
        );
      }).pipe(Effect.uninterruptible);

      if (action.flush) {
        yield* flush(false);
      }
    });

    const view = { filePath, write, close: () => Effect.void } satisfies EventNdjsonLogger;
    loggerViews.set(stream, view);
    return view;
  };

  return { filePath, logger, close } satisfies EventNdjsonLogStore;
});

export const makeEventNdjsonLogger = Effect.fnUntraced(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonLogger | undefined> {
  const store = yield* makeEventNdjsonLogStore(filePath, options).pipe(
    Effect.catch((error) =>
      logWarning(error.message, { error }).pipe(
        Effect.as<EventNdjsonLogStore | undefined>(undefined),
      ),
    ),
  );
  if (!store) return undefined;
  return { ...store.logger(options.stream), close: store.close };
});
