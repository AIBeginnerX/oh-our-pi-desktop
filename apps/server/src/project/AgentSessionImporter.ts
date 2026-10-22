import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionSource,
  AgentSessionScanError,
  isImportedAgentSessionMessageId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import {
  nativeSessionRefOf,
  type ProviderSessionRef,
  type ProviderSessionRefsMalformedError,
  readPriorProviderSessionRefs,
} from "../provider/providerSessionIds.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import {
  deriveThreadTitleFromUserTexts,
  importedSessionFallbackTitle,
  isInjectedPreambleTitle,
} from "./AgentSessionUserRequest.ts";

const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' changed before its history import completed.`;
  }
}

/** Every imported thread id starts with this; the repair matches on it. */
const IMPORTED_THREAD_ID_PREFIX = "import:";

const importedThreadIdOf = (providerInstanceId: string, providerSessionId: string): ThreadId =>
  ThreadId.make(`${IMPORTED_THREAD_ID_PREFIX}${providerInstanceId}:${providerSessionId}`);

const isImportedThreadId = (threadId: string) => threadId.startsWith(IMPORTED_THREAD_ID_PREFIX);

const importedThreadProviderInstanceId = (threadId: string): string =>
  threadId.slice(IMPORTED_THREAD_ID_PREFIX.length).split(":")[0] ?? "";

function hasImportedHistory(thread: OrchestrationThread): boolean {
  return thread.messages.some((message) => isImportedAgentSessionMessageId(message.id));
}

function hasImportBlockingActivity(
  thread: OrchestrationThread,
  importedHistoryPresent: boolean,
): boolean {
  return (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.latestTurn !== null ||
    thread.session !== null ||
    thread.messages.some((message) => !isImportedAgentSessionMessageId(message.id)) ||
    thread.proposedPlans.length > 0 ||
    thread.activities.length > 0 ||
    thread.checkpoints.length > 0 ||
    thread.snoozedUntil != null ||
    thread.snoozedAt != null ||
    thread.pinnedAt != null ||
    thread.pinOrderKey != null ||
    thread.autoSettleDisabledAt != null ||
    thread.titleRegeneration != null ||
    thread.linkedPullRequest != null ||
    thread.unsettledAt != null ||
    (importedHistoryPresent
      ? thread.settledOverride !== "settled"
      : thread.settledOverride !== null || thread.settledAt !== null)
  );
}

/**
 * Retitle imported threads whose title is harness preamble instead of a
 * request. Such threads were created before titles were derived from the real
 * user message, and the title is all the sidebar shows, so they all read as
 * the same plugin list.
 *
 * Archived threads are repaired too: an archived thread stays searchable, so a
 * broken title there is as visible as one in the live list.
 *
 * The rename goes through the engine like any other title change, so it lands
 * in the event log and the projection catches up through the normal path. It is
 * idempotent by construction: the repair only considers threads whose stored
 * title still looks like preamble, and it rewrites each at most once.
 */
export const repairInjectedImportedThreadTitles = Effect.fn("repairInjectedImportedThreadTitles")(
  function* () {
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const crypto = yield* Crypto.Crypto;
    const [shell, archived] = yield* Effect.all([
      snapshots.getShellSnapshot(),
      snapshots.getArchivedShellSnapshot(),
    ]);
    const brokenThreads = [...shell.threads, ...archived.threads].filter(
      (thread) => isImportedThreadId(thread.id) && isInjectedPreambleTitle(thread.title),
    );
    for (const thread of brokenThreads) {
      const detail = yield* snapshots.getThreadDetailById(thread.id);
      if (Option.isNone(detail)) continue;
      // Some imports kept only the preamble message (no request was ever stored); name those
      // plainly by source and date rather than leave the plugin list as the title.
      // A derived title that still reads as markup (e.g. a Codex app event) would be picked up
      // again on every start, so it takes the fallback too.
      const derived = deriveThreadTitleFromUserTexts(
        detail.value.messages.flatMap((message) => (message.role === "user" ? [message.text] : [])),
      );
      const title =
        derived !== null && !isInjectedPreambleTitle(derived)
          ? derived
          : importedSessionFallbackTitle(
              importedThreadProviderInstanceId(thread.id),
              thread.createdAt,
            );
      if (title === thread.title) continue;
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId: thread.id,
        title,
      });
    }
  },
);

/** Import recent transcript text and persist the cursor needed to resume its provider session. */
export const importRecentAgentThreads = Effect.fn("importRecentAgentThreads")(function* (
  input: AgentSessionImportInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;
  // A stale title must never fail the import the user asked for.
  yield* repairInjectedImportedThreadTitles().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not repair imported thread titles", { cause }).pipe(Effect.asVoid),
    ),
  );
  const project = yield* snapshots.getProjectShellById(input.projectId).pipe(
    Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
        onSome: Effect.succeed,
      }),
    ),
  );
  const workspaceRoot = project.workspaceRoot;
  if (
    input.expectedWorkspaceRoot !== undefined &&
    normalizeProjectPathForComparison(workspaceRoot) !==
      normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
  ) {
    return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
  }
  const completedSources = yield* snapshots
    .getImportedAgentSessionSources(input.projectId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );

  // Ownership preload. provider_session_runtime rows survive thread and
  // project deletion and are listed across every status, so stopped and
  // orphaned bindings keep blocking their sessions — they are the ownership
  // tombstones. A lookup failure fails the whole import before the stream is
  // consumed or anything is written; it must never degrade to an empty
  // ownership set or a skipped count.
  const ownedRefsFromBindings = (
    bindings: ReadonlyArray<ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata>,
  ): Result.Result<ReadonlyArray<ProviderSessionRef>, ProviderSessionRefsMalformedError> => {
    const refs: Array<ProviderSessionRef> = [];
    for (const binding of bindings) {
      const current = nativeSessionRefOf(
        binding.provider,
        binding.providerInstanceId ?? null,
        binding.resumeCursor,
      );
      if (Option.isSome(current)) refs.push(current.value);
      const priors = readPriorProviderSessionRefs(binding.runtimePayload);
      if (Result.isFailure(priors)) return Result.fail(priors.failure);
      refs.push(...priors.success);
    }
    return Result.succeed(refs);
  };
  const loadOwnedSessionRefs = Effect.suspend(() =>
    directory.listBindings().pipe(
      Effect.catchCause(
        (
          cause,
        ): Effect.Effect<
          never,
          ProviderSessionDirectory.ProviderSessionDirectoryReadError | AgentSessionScanError
        > => {
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
          if (cause.reasons.some(Cause.isDieReason)) return Effect.failCause(cause);
          const failure = Cause.findErrorOption(cause);
          if (Option.isNone(failure)) return Effect.failCause(cause);
          return Effect.fail(
            new AgentSessionScanError({ operation: "read-projects", cause: failure.value }),
          );
        },
      ),
      Effect.flatMap((bindings) => {
        const refs = ownedRefsFromBindings(bindings);
        return Result.isSuccess(refs)
          ? Effect.succeed(refs.success)
          : Effect.fail(
              new AgentSessionScanError({ operation: "read-projects", cause: refs.failure }),
            );
      }),
    ),
  );
  const ownedSessionRefs = yield* loadOwnedSessionRefs;
  // The write-time ownership gate. It runs after the per-thread preparatory
  // reads and immediately before the outcome's first write, so a publication
  // landing while those reads are in flight is still caught. Its typed
  // failure must never pass as a skipped count.
  const freshSessionIsOwned = (source: {
    readonly provider: string;
    readonly providerSessionId: string;
  }) =>
    Effect.map(loadOwnedSessionRefs, (refs) =>
      refs.some(
        (ref) => ref.provider === source.provider && ref.sessionId === source.providerSessionId,
      ),
    );

  const threads = scanner.recentThreads(
    workspaceRoot,
    completedSources.map((entry) => entry.source),
    ownedSessionRefs,
  );
  const importedThreadIds = new Set<ThreadId>();
  let importedCount = 0;
  let skippedCount = 0;

  yield* Stream.runForEach(threads, (outcome) =>
    Effect.gen(function* () {
      if (outcome._tag === "Skipped") {
        skippedCount += 1;
        return;
      }
      if (outcome._tag === "AlreadyImported" || outcome._tag === "Duplicate") {
        const threadId = importedThreadIdOf(
          outcome.source.providerInstanceId,
          outcome.source.providerSessionId,
        );
        if (outcome._tag === "AlreadyImported") {
          // The no-write count exception: the completed source was validated
          // against the live projection and the file identity is unchanged.
          // No other owned-session exception exists — a changed file or an
          // unverifiable source never reaches here.
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (importedThreadIds.has(threadId)) {
          if (yield* freshSessionIsOwned(outcome.source)) return;
          const recorded = yield* directory
            .recordImportedTranscript({ threadId, source: outcome.source })
            .pipe(Effect.result);
          if (recorded._tag === "Failure") {
            skippedCount += 1;
            yield* Effect.logWarning("Could not record an imported transcript copy", {
              threadId,
              cause: recorded.failure,
            });
          }
        }
        return;
      }
      const thread = outcome.thread;
      const threadId = importedThreadIdOf(thread.providerInstanceId, thread.providerSessionId);
      const importThread = Effect.gen(function* () {
        const provider = ProviderDriverKind.make(thread.source);
        const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
        const existingThread = yield* snapshots.getThreadDetailById(threadId);
        const existingBinding = yield* directory.getBinding(threadId);

        if (
          thread.source === "claudeAgent" &&
          !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
        ) {
          return yield* new AgentSessionUnresumableSessionError({
            source: thread.source,
            providerSessionId: thread.providerSessionId,
          });
        }

        if (Option.isSome(existingThread) && existingThread.value.projectId !== input.projectId) {
          return yield* new AgentSessionThreadProjectConflictError({
            threadId,
            expectedProjectId: input.projectId,
            actualProjectId: existingThread.value.projectId,
          });
        }

        const importedHistoryPresent = Option.isSome(existingThread)
          ? hasImportedHistory(existingThread.value)
          : false;
        // The final ownership gate: the last check before this outcome can
        // write anything, placed after the preparatory reads above. The catch
        // below rethrows AgentSessionScanError so a lookup failure fails the
        // whole import instead of passing as a skipped count.
        if (yield* freshSessionIsOwned(outcome.source)) return null;

        if (
          Option.isSome(existingThread) &&
          importedHistoryPresent &&
          Option.isSome(existingBinding)
        ) {
          yield* directory.recordImportedTranscript({ threadId, source: outcome.source });
          return true;
        }

        if (
          Option.isSome(existingThread) &&
          hasImportBlockingActivity(existingThread.value, importedHistoryPresent)
        ) {
          return yield* new AgentSessionThreadModifiedError({ threadId });
        }

        if (
          Option.isSome(existingBinding) &&
          (existingBinding.value.provider !== provider ||
            existingBinding.value.providerInstanceId !== thread.providerInstanceId ||
            existingBinding.value.status !== "stopped")
        ) {
          return yield* new AgentSessionThreadModifiedError({ threadId });
        }

        // Install the cursor before the thread becomes visible. A concurrent
        // real session can replace it, while insert-ignore keeps this import
        // from replacing that newer binding.
        if (Option.isNone(existingBinding)) {
          yield* directory.upsert(
            {
              threadId,
              provider,
              providerInstanceId: thread.providerInstanceId,
              status: "stopped",
              runtimeMode: DEFAULT_RUNTIME_MODE,
              resumeCursor:
                thread.source === "codex"
                  ? { threadId: thread.providerSessionId }
                  : { threadId, resume: thread.providerSessionId },
              runtimePayload: { cwd: workspaceRoot },
            },
            { onConflict: "ignore" },
          );
        }

        if (Option.isNone(existingThread)) {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            projectId: input.projectId,
            title: thread.title,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: thread.createdAt,
            historyImport: true,
          });
        }

        if (!importedHistoryPresent) {
          yield* engine.dispatch({
            type: "thread.history.import",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            messages: thread.messages.map((message, index) => ({
              messageId: MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
              role: message.role,
              text: message.text,
              createdAt: message.createdAt,
            })),
          });
        }

        yield* directory.recordImportedTranscript({ threadId, source: outcome.source });

        return true;
      });
      const imported = yield* importThread.pipe(
        Effect.catchCause((cause): Effect.Effect<boolean, Effect.Error<typeof importThread>> => {
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
          if (cause.reasons.some(Cause.isDieReason)) return Effect.failCause(cause);
          const failure = Cause.findErrorOption(cause);
          if (Option.isNone(failure)) return Effect.failCause(cause);
          // The ownership gate's typed failure must escape the per-thread
          // catch-as-skipped; only import-specific errors count as skips.
          return failure.value._tag === "AgentSessionScanError"
            ? Effect.fail(failure.value)
            : Effect.logWarning("Could not import an agent session", {
                provider: thread.source,
                sessionId: thread.providerSessionId,
                cause: failure.value,
              }).pipe(Effect.as(false));
        }),
      );

      if (imported === null) return;
      if (imported) {
        importedThreadIds.add(threadId);
        importedCount += 1;
      } else {
        skippedCount += 1;
      }
    }),
  );

  return { importedCount, skippedCount } satisfies AgentSessionImportResult;
});
