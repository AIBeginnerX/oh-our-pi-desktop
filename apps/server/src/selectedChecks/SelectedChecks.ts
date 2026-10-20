import {
  CommandId,
  EventId,
  type ProjectId,
  type SelectedCheckAdmission,
  SELECTED_CHECK_RECEIPT_KIND,
  SelectedCheckReceipt,
  type SelectedCheckResult,
  SelectedChecksRejectedError,
  type SelectedChecksCancelInput,
  type SelectedChecksCancelResult,
  type SelectedChecksGetResult,
  type SelectedChecksResolveOwnershipInput,
  type SelectedChecksResolveOwnershipResult,
  type SelectedChecksRunInput,
  type SelectedChecksRunResult,
  SelectedChecksThreadNotFoundError,
  type ServerSettingsError,
  type Sha256Hex,
  type ThreadId,
  type VcsError,
  selectedCheckReceiptId,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as OwnerMarker from "./ownerMarker.ts";
import * as ScriptExecutor from "./ScriptExecutor.ts";

/**
 * Runs and records the server-side selected checks for a thread's workspace.
 *
 * One attempt at a time holds the slot. Ownership is a single marker file
 * (`ownerMarker`) claimed before the first spawn and released only when the
 * attempt can prove nothing is left unresolved — otherwise the unresolved owner
 * survives in memory (`stranded`) until that exact owner is durably
 * re-persisted; acknowledging an obstructing marker never clears it. Receipts
 * are rewritten per milestone as one fixed server-written activity, and the
 * first write's event sequence anchors the record against a thread deleted and
 * recreated during the attempt.
 *
 * A finished record is a historical, scope-bounded claim: a fixed plan ran, each
 * check exited 0 on its own with an empty captured group, output digests are
 * complete, and the workspace tree and repository matched at the attempt's two
 * ends. It never claims the current tree matches or that any task is verified,
 * and it survives a server-process restart, not a power loss or external
 * tampering.
 */
export class SelectedChecks extends Context.Service<
  SelectedChecks,
  {
    /**
     * Reads the thread's record, what a run would meet right now, and the live
     * admission. With `measureCurrent` the finished record is also compared
     * against the current workspace, context, and environment; every current
     * observation stays absent (unknown) unless the record row, attempt, and
     * context are re-read unchanged after the measurement. Absent or null is
     * never a match.
     */
    readonly get: (
      threadId: ThreadId,
      options?: { readonly measureCurrent?: boolean },
    ) => Effect.Effect<
      SelectedChecksGetResult,
      SelectedChecksThreadNotFoundError | SelectedChecksGetError
    >;
    /** Starts one attempt in request order and returns once it is registered. */
    readonly run: (
      input: SelectedChecksRunInput,
    ) => Effect.Effect<
      SelectedChecksRunResult,
      SelectedChecksRejectedError | SelectedChecksThreadNotFoundError
    >;
    /**
     * Read-only internal resolution of the target a run would fix right now:
     * the thread's context, the explicit environment digest, and the plan in
     * request order — hashes only. It runs no attempt, claims no slot, touches
     * no marker, record, process, or tree, and deliberately resolves while the
     * thread's turn is running; only `run` refuses there. Never exposed on the
     * wire.
     */
    readonly resolveTargetPlan: (
      input: SelectedChecksRunInput,
    ) => Effect.Effect<
      SelectedChecksTargetPlan,
      SelectedChecksThreadNotFoundError | SelectedChecksRejectedError
    >;
    /**
     * Latches the cooperative stop for the exact live attempt and waits for its
     * final record. A cancel that lands after the attempt's exit is `false`.
     */
    readonly cancel: (
      input: SelectedChecksCancelInput,
    ) => Effect.Effect<SelectedChecksCancelResult>;
    /**
     * Resolves the owner marker when the owning process group is provably gone
     * or the uncertainty is acknowledged. Never opens admission past an
     * unresolved owner that only memory holds.
     */
    readonly resolveOwnership: (
      input: SelectedChecksResolveOwnershipInput,
    ) => Effect.Effect<SelectedChecksResolveOwnershipResult>;
    /** Settles a previous process's running receipts and dead groups. Run once at startup. */
    readonly reconcile: Effect.Effect<void>;
  }
>()("t3/selectedChecks/SelectedChecks") {}

export interface SelectedChecksOptions {
  /** Replaces the frozen executor; the default is the real one. */
  readonly runScript?: typeof ScriptExecutor.runScript;
  /** Signal-0 group probe seam, with the executor probe's semantics. */
  readonly probeGroup?: (pgid: number) => ScriptExecutor.GroupProbeResult;
  /**
   * Bound on the cooperative shutdown wait for the live attempt's `done` — an
   * individual wait, not a global shutdown deadline. After it the worker is
   * interrupted; its finalizer (marker and record I/O) still runs, unbounded.
   */
  readonly shutdownGrace?: Duration.Duration;
}

/**
 * The typed failures a `get` can surface beyond `thread-not-found`. Reads
 * feeding the measurement only produce one when the failure cause already
 * carries an interruption — the whole cause is re-raised rather than
 * collapsed into a defect, an absent row, or an unknown observation. A plain
 * failure keeps the ordinary policy at that boundary.
 */
export type SelectedChecksGetError = ProjectionRepositoryError | ServerSettingsError | VcsError;

/**
 * What `resolveTargetPlan` answers: everything one run would fix right now,
 * bounded to identifiers and hashes — command text, environment values, and
 * any execution evidence stay out. `threadCreatedAt` is comparison context for
 * the caller, never an incarnation verdict; the claim resolves the real
 * `thread.created` anchor itself. `planned` keeps the exact requested order.
 */
export interface SelectedChecksTargetPlan {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly threadCreatedAt: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly cwd: string;
  readonly shell: string;
  readonly envSha256: Sha256Hex;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly planned: ReadonlyArray<{
    readonly scriptId: string;
    readonly commandSha256: Sha256Hex;
  }>;
}

/**
 * `Effect.orDie` with one exception: a cause already carrying an interruption
 * is re-raised whole — squashing a Fail+Interrupt into a defect would lose the
 * interrupt and let a torn read judge stale state as current.
 */
const orDiePreservingInterrupt = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.die(Cause.squash(cause)),
    ),
  );

/**
 * Fail-closed reads: a plain failure becomes `Option.none` (unknown), while an
 * interrupt-bearing cause is re-raised instead of reading as a finished
 * "nothing found".
 */
const readOrNone = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.map(Option.some),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(Option.none<A>()),
    ),
  );

const WRITE_TIMEOUT = Duration.seconds(10);
const RUN_CHECK_TIMEOUT_MS = 600_000;
const SERVER_COMMAND_PREFIX = "server:selected-checks:";

const SUMMARY = {
  running: "Running selected checks",
  completed: "Selected checks finished",
  cancelled: "Selected checks cancelled",
  interrupted: "Selected checks interrupted",
  errored: "Selected checks could not finish",
} as const satisfies Record<SelectedCheckReceipt["phase"], string>;

type ReceiptError = NonNullable<SelectedCheckReceipt["error"]>;

/** Why the worker stopped short; the final receipt carries the code. */
interface AttemptAbort {
  readonly error: ReceiptError;
}

/**
 * The only codes a registration step (R1–R3) can fail with; each is also a
 * `SelectedChecksRejectedError` reason, so the caller's rejection is exact.
 */
type RegistrationFailureReason = "record-failed" | "context-changed" | "owner-marker-failed";

interface PendingOwner {
  readonly attemptId: string;
  readonly threadId: ThreadId;
  readonly scriptId: string | null;
  readonly pgid: number | null;
}

interface LiveAttempt {
  readonly attemptId: string;
  readonly threadId: ThreadId;
  readonly cancel: Deferred.Deferred<void>;
  /** Read and flipped only under the ownership permit; false closes cancellation. */
  acceptingCancel: boolean;
  readonly registered: Deferred.Deferred<string, SelectedChecksRejectedError>;
  readonly done: Deferred.Deferred<void>;
}

/** What one run fixes at request time; the record never carries the command text. */
type PlannedScript = SelectedCheckReceipt["planned"][number] & {
  readonly command: string;
};

interface AttemptSnapshot {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly threadCreatedAt: string;
  readonly cwd: string;
  readonly shell: string;
  readonly platform: NodeJS.Platform;
  readonly env: Record<string, string>;
  readonly envSha256: Sha256Hex;
  readonly plan: Array<PlannedScript>;
}

/**
 * The thread's execution context resolved for measurement only: the six
 * fields a receipt pins, plus `threadCreatedAt` for the post-measurement
 * identity recheck. Any unresolved input means the observation is unknown,
 * never a match.
 */
interface CurrentContext {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly threadCreatedAt: string;
  readonly cwd: string;
  readonly shell: string;
  readonly envSha256: Sha256Hex;
}

/** Per-attempt facts the worker fiber writes and its own finalizer reads. */
interface AttemptState {
  /** The most recently applied owned marker: its sha and what it claims. */
  marker: {
    readonly sha256: Sha256Hex;
    readonly scriptId: string | null;
    readonly pgid: number | null;
  } | null;
  /** The check whose result has not landed — the owner the disk must keep representing. */
  inFlight: string | null;
  /** A finished check whose captured group could not be proven empty. */
  unknown: { readonly scriptId: string; readonly pgid: number | null } | null;
  registeredDone: boolean;
  /** The fixed rejection code when the attempt stopped during registration. */
  registrationError: ReceiptError | null;
  /** Set at every abort site in the worker fiber; the finalizer reads it directly. */
  abort: AttemptAbort | null;
}

const pendingCheck = (scriptId: string): SelectedCheckResult => ({
  scriptId,
  status: "pending",
  startedAt: null,
  endedAt: null,
  exitCode: null,
  exitedBy: null,
  exitSignal: null,
  pgid: null,
  group: null,
  stdout: null,
  stderr: null,
  failure: null,
});

const toneFor = (receipt: SelectedCheckReceipt): "error" | "info" =>
  receipt.phase === "errored" || receipt.checks.some((check) => check.status === "failed")
    ? "error"
    : "info";

/** A terminal record never leaves a check looking in progress. */
const settledChecks = (checks: ReadonlyArray<SelectedCheckResult>): Array<SelectedCheckResult> =>
  checks.map((check) =>
    check.status === "pending"
      ? { ...check, status: "not-run" }
      : check.status === "running"
        ? { ...check, status: "unproven" }
        : check,
  );

const toHex = (bytes: Uint8Array): string => {
  const digits = "0123456789abcdef";
  let hex = "";
  for (const byte of bytes) hex += digits.charAt(byte >> 4) + digits.charAt(byte & 15);
  return hex;
};

const errnoCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? ((error as { readonly code?: unknown }).code as string | undefined)
    : undefined;

/** Same semantics as the executor's own probe: signal 0 delivers nothing. */
const defaultProbeGroup = (pgid: number): ScriptExecutor.GroupProbeResult => {
  try {
    process.kill(-pgid, 0);
    return "exists";
  } catch (error) {
    return errnoCode(error) === "ESRCH" ? "gone" : "unknown";
  }
};

const decodeReceipt = Schema.decodeUnknownOption(SelectedCheckReceipt);

/** @public Service construction is part of the canonical Effect module API. */
export const make = (options?: SelectedChecksOptions) =>
  Effect.gen(function* () {
    const runScript = options?.runScript ?? ScriptExecutor.runScript;
    const rawProbe = options?.probeGroup ?? defaultProbeGroup;
    const shutdownGrace = options?.shutdownGrace ?? Duration.seconds(30);
    // A throwing probe is denied evidence, never a crash — the executor's own rule.
    const probeGroup = (pgid: number): ScriptExecutor.GroupProbeResult => {
      try {
        return rawProbe(pgid);
      } catch {
        return "unknown";
      }
    };

    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const activityRepository = yield* ProjectionThreadActivityRepository;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const settings = yield* ServerSettingsService.ServerSettingsService;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const vcs = yield* VcsDriverRegistry.VcsDriverRegistry;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const markerPath = path.join(serverConfig.stateDir, OwnerMarker.OWNER_MARKER_FILE);
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const sha256HexUtf8 = (text: string): Effect.Effect<Sha256Hex> =>
      crypto
        .digest("SHA-256", new TextEncoder().encode(text))
        .pipe(Effect.orDie, Effect.map(toHex));

    // The marker API runs on the platform services this server already holds.
    const withMarkerDeps = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
      );
    const readMarkerNow = () => withMarkerDeps(OwnerMarker.readMarker(markerPath));
    const transitionMarkerNow = (
      expect: OwnerMarker.MarkerExpectation,
      next: OwnerMarker.OwnerMarker,
    ) => withMarkerDeps(OwnerMarker.transitionMarker(markerPath, expect, next));

    const ownership = yield* Semaphore.make(1);
    const reconciledRef = yield* Ref.make(false);
    const strandedRef = yield* Ref.make<PendingOwner | null>(null);
    const liveRef = yield* Ref.make<LiveAttempt | null>(null);
    // Attempts outlive the RPC that started them but not the server.
    const runScope = yield* Scope.make("parallel");
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const current = yield* Ref.get(liveRef);
        if (current !== null) {
          // Ask for a cooperative stop, then wait — bounded — for the attempt to
          // record itself. The scope close below interrupts whatever is left, and
          // that finalizer keeps the unresolved owner represented.
          yield* ownership.withPermit(
            Effect.gen(function* () {
              const live = yield* Ref.get(liveRef);
              if (live !== null && live.acceptingCancel) {
                yield* Deferred.succeed(live.cancel, undefined);
              }
            }),
          );
          yield* Deferred.await(current.done).pipe(Effect.timeoutOption(shutdownGrace));
        }
        yield* Scope.close(runScope, Exit.void);
      }),
    );

    const ownedMarker = (owner: PendingOwner, writtenAt: string): OwnerMarker.OwnedMarker => ({
      version: 1,
      state: "owned",
      attemptId: owner.attemptId,
      threadId: owner.threadId,
      scriptId: owner.scriptId,
      pgid: owner.pgid,
      writtenAt,
    });

    const releasedMarker = (
      how: OwnerMarker.ReleasedMarker["how"],
      previousSha256: Sha256Hex,
      previous: OwnerMarker.ReleasedMarker["previous"],
      releasedAt: string,
    ): OwnerMarker.ReleasedMarker => ({
      version: 1,
      state: "released",
      how,
      previousSha256,
      previous,
      releasedAt,
    });

    /** Persist a stranded owner. Only a successful write of the exact owner clears the latch. */
    const flushStranded = Effect.gen(function* () {
      const stranded = yield* Ref.get(strandedRef);
      if (stranded === null) return;
      const applied = yield* transitionMarkerNow(
        { kind: "free" },
        ownedMarker(stranded, yield* nowIso),
      );
      if (applied.kind === "applied") yield* Ref.set(strandedRef, null);
    });

    /** What a run would meet right now, read without the permit. Disk state speaks before memory. */
    const computeAdmission: Effect.Effect<SelectedCheckAdmission> = Effect.gen(function* () {
      if (!(yield* Ref.get(reconciledRef))) return { state: "reconciling" };
      const live = yield* Ref.get(liveRef);
      if (live !== null) {
        return { state: "busy", threadId: live.threadId, attemptId: live.attemptId };
      }
      const marker = yield* readMarkerNow();
      if (marker.kind === "unreadable") return { state: "owner-unreadable" };
      if (marker.kind === "corrupt") {
        return { state: "owner-corrupt", marker: { sha256: marker.sha256, bytes: marker.bytes } };
      }
      if (marker.kind === "owned") {
        return {
          state: "owner-unresolved",
          marker: {
            sha256: marker.sha256,
            attemptId: marker.marker.attemptId,
            threadId: marker.marker.threadId,
            scriptId: marker.marker.scriptId,
            pgid: marker.marker.pgid,
            writtenAt: marker.marker.writtenAt,
          },
        };
      }
      const stranded = yield* Ref.get(strandedRef);
      if (stranded !== null) {
        return {
          state: "owner-unrecorded",
          owner: {
            attemptId: stranded.attemptId,
            threadId: stranded.threadId,
            scriptId: stranded.scriptId,
            pgid: stranded.pgid,
          },
        };
      }
      return { state: "open" };
    });

    const currentScripts = (projectId: ProjectId) =>
      Effect.gen(function* () {
        const projectShell = yield* query
          .getProjectShellById(projectId)
          .pipe(orDiePreservingInterrupt);
        if (Option.isNone(projectShell)) return [];
        return resolveProjectScripts(yield* settings.getSettings.pipe(orDiePreservingInterrupt), {
          id: projectShell.value.id,
          scripts: projectShell.value.scripts,
        });
      });

    const writeRecord = (receipt: SelectedCheckReceipt) =>
      Effect.gen(function* () {
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const at = yield* nowIso;
        const { sequence } = yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`${SERVER_COMMAND_PREFIX}${uuid}`),
          threadId: receipt.threadId,
          activity: {
            id: EventId.make(selectedCheckReceiptId(receipt.threadId)),
            tone: toneFor(receipt),
            kind: SELECTED_CHECK_RECEIPT_KIND,
            summary: SUMMARY[receipt.phase],
            payload: receipt,
            turnId: null,
            // A stable creation time keeps the row's place; `createdAt` is this write's time.
            createdAt: receipt.startedAt,
          },
          createdAt: at,
        });
        return sequence;
      });

    /** Every record write is individually bounded; no global deadline is claimed. */
    const boundedWrite = (receipt: SelectedCheckReceipt) =>
      writeRecord(receipt).pipe(
        Effect.mapError(() => "record-failed" as const),
        Effect.timeoutOption(WRITE_TIMEOUT),
        Effect.flatMap((written) =>
          Option.isSome(written)
            ? Effect.succeed(written.value)
            : Effect.fail("record-failed" as const),
        ),
      );

    /** The thread's stored record exactly as written, judged only from the row. */
    const readStoredRecord = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const rows = yield* activityRepository
          .listByThreadId({ threadId, activityKinds: [SELECTED_CHECK_RECEIPT_KIND] })
          .pipe(orDiePreservingInterrupt);
        const row = rows.find(
          (candidate) => candidate.activityId === selectedCheckReceiptId(threadId),
        );
        if (row === undefined) return { kind: "none" } as const;
        const receipt = Option.getOrNull(decodeReceipt(row.payload));
        if (receipt === null || receipt.threadId !== threadId)
          return { kind: "malformed" } as const;
        if (typeof row.sequence !== "number") return { kind: "malformed" } as const;
        return { kind: "present", receipt, sequence: row.sequence } as const;
      });

    const capability: Effect.Effect<SelectedChecksGetResult["capability"]> = Effect.gen(
      function* () {
        const platform = yield* HostProcessPlatform;
        if (platform === "win32") return { available: false, reason: "not-posix" };
        const shell = process.env.SHELL;
        return shell !== undefined && shell.startsWith("/")
          ? { available: true, reason: null }
          : { available: false, reason: "shell-unavailable" };
      },
    );

    const changedScriptIds = (receipt: SelectedCheckReceipt) =>
      Effect.gen(function* () {
        const scripts = yield* currentScripts(receipt.context.projectId);
        const changed: Array<string> = [];
        for (const planned of receipt.planned) {
          const script = scripts.find((candidate) => candidate.id === planned.scriptId);
          if (script === undefined) {
            changed.push(planned.scriptId);
            continue;
          }
          if ((yield* sha256HexUtf8(script.command)) !== planned.commandSha256) {
            changed.push(planned.scriptId);
          }
        }
        return changed;
      });

    const readCurrentContext = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const shell = process.env.SHELL;
        if (shell === undefined || !shell.startsWith("/")) return null;
        const threadShell = yield* query
          .getThreadShellById(threadId)
          .pipe(readOrNone, Effect.map(Option.flatten));
        if (Option.isNone(threadShell)) return null;
        const projectShell = yield* query
          .getProjectShellById(threadShell.value.projectId)
          .pipe(readOrNone, Effect.map(Option.flatten));
        if (Option.isNone(projectShell)) return null;
        const workspaceRoot = projectShell.value.workspaceRoot;
        const worktreePath = threadShell.value.worktreePath;
        const env = projectScriptRuntimeEnv({
          project: { cwd: workspaceRoot },
          worktreePath,
        });
        return {
          projectId: threadShell.value.projectId,
          workspaceRoot,
          worktreePath,
          threadCreatedAt: threadShell.value.createdAt,
          cwd: projectScriptCwd({ project: { cwd: workspaceRoot }, worktreePath }),
          shell,
          envSha256: yield* sha256HexUtf8(JSON.stringify(Object.entries(env).sort())),
        } satisfies CurrentContext;
      });

    const contextEquals = (a: CurrentContext, b: CurrentContext) =>
      a.projectId === b.projectId &&
      a.workspaceRoot === b.workspaceRoot &&
      a.worktreePath === b.worktreePath &&
      a.threadCreatedAt === b.threadCreatedAt &&
      a.cwd === b.cwd &&
      a.shell === b.shell &&
      a.envSha256 === b.envSha256;

    /**
     * Compares the current worktree tree with the attempt's end observation in
     * the *current* cwd. Bounded like the service's own record writes; a
     * timeout, failure, or unsupported observation reads unknown, not a match.
     */
    const measureTreeUnchanged = (receipt: SelectedCheckReceipt, cwd: string) =>
      Effect.gen(function* () {
        const atEnd = receipt.tree.atEnd;
        if (atEnd.kind !== "complete" || receipt.tree.repoAtEnd === null) return null;
        const observed = yield* observeTree(cwd).pipe(
          readOrNone,
          Effect.timeoutOption(Duration.seconds(5)),
          Effect.map(Option.flatten),
        );
        if (Option.isNone(observed)) return null;
        const { observation, repoIdentity } = observed.value;
        if (observation.kind !== "complete" || repoIdentity === null) return null;
        return (
          observation.treeOid === atEnd.treeOid &&
          repoIdentity.topLevel === receipt.tree.repoAtEnd.topLevel &&
          repoIdentity.commonDir === receipt.tree.repoAtEnd.commonDir
        );
      });

    const measureEnvironmentMatches = (receipt: SelectedCheckReceipt) =>
      Effect.gen(function* () {
        const descriptor = yield* environment.getDescriptor;
        return (
          receipt.environment.environmentId === descriptor.environmentId &&
          receipt.environment.platform === (yield* HostProcessPlatform) &&
          receipt.environment.arch === (yield* HostProcessArchitecture) &&
          receipt.environment.osRelease === NodeOS.release() &&
          receipt.environment.serverVersion === descriptor.serverVersion &&
          receipt.environment.nodeVersion === process.version
        );
      });

    /**
     * A measurement is only bound to the record it was taken against when the
     * durable row, the attempt's own revision, the recreation anchor, and the
     * context still read the same after it. Anything newer or gone drops the
     * observation instead of attaching a stale `true` to another state.
     */
    const measurementIdentityIntact = (input: {
      readonly threadId: ThreadId;
      readonly recordSequence: number;
      readonly attemptId: SelectedCheckReceipt["attemptId"];
      readonly revision: number;
      readonly anchor: number;
      readonly context: CurrentContext;
    }) =>
      Effect.gen(function* () {
        const stored = yield* readStoredRecord(input.threadId).pipe(readOrNone);
        if (
          Option.isNone(stored) ||
          stored.value.kind !== "present" ||
          stored.value.sequence !== input.recordSequence ||
          stored.value.receipt.attemptId !== input.attemptId ||
          stored.value.receipt.revision !== input.revision
        ) {
          return false;
        }
        const recreated = yield* events
          .hasEventAfter({
            aggregateKind: "thread",
            aggregateId: input.threadId,
            type: "thread.created",
            sequenceExclusive: input.anchor,
          })
          .pipe(readOrNone);
        if (Option.isNone(recreated) || recreated.value) return false;
        const after = yield* readCurrentContext(input.threadId);
        return after !== null && contextEquals(input.context, after);
      });

    const readBase = (
      threadId: ThreadId,
    ): Effect.Effect<
      SelectedChecksGetResult,
      SelectedChecksThreadNotFoundError | SelectedChecksGetError
    > =>
      Effect.gen(function* () {
        const threadShell = yield* query
          .getThreadShellById(threadId)
          .pipe(orDiePreservingInterrupt);
        if (Option.isNone(threadShell)) {
          return yield* new SelectedChecksThreadNotFoundError({ threadId });
        }
        const admission = yield* computeAdmission;
        const stored = yield* readStoredRecord(threadId);
        if (stored.kind === "none") {
          return {
            capability: yield* capability,
            record: { kind: "none" },
            changedScriptIds: [],
            admission,
          };
        }
        if (stored.kind === "malformed") {
          return {
            capability: yield* capability,
            record: { kind: "malformed" },
            changedScriptIds: [],
            admission,
          };
        }
        // Recreation after the record's anchor invalidates it; a store read error
        // is never allowed to read as "no recreation".
        const anchor = stored.receipt.threadAnchorSequence ?? stored.sequence;
        const recreated = yield* events
          .hasEventAfter({
            aggregateKind: "thread",
            aggregateId: threadId,
            type: "thread.created",
            sequenceExclusive: anchor,
          })
          .pipe(readOrNone);
        if (Option.isNone(recreated) || recreated.value) {
          return {
            capability: yield* capability,
            record: { kind: "malformed" },
            changedScriptIds: [],
            admission,
          };
        }
        const live = yield* Ref.get(liveRef);
        // Display only: a running record nobody here is running was left by a stop.
        const receipt =
          stored.receipt.phase === "running" && live?.attemptId !== stored.receipt.attemptId
            ? { ...stored.receipt, phase: "interrupted" as const, error: "server-stopped" as const }
            : stored.receipt;
        return {
          capability: yield* capability,
          record: { kind: "present", receipt, sequence: stored.sequence },
          changedScriptIds: yield* changedScriptIds(receipt),
          admission,
        };
      });

    const get: SelectedChecks["Service"]["get"] = Effect.fn("SelectedChecks.get")(
      function* (threadId, options) {
        const base = yield* readBase(threadId);
        // A running attempt is never measured: its tree observations are not
        // final and a live turn-active record is a different question.
        if (
          options?.measureCurrent !== true ||
          base.record.kind !== "present" ||
          base.record.receipt.phase === "running"
        ) {
          return base;
        }
        const { receipt, sequence } = base.record;
        const context = yield* readCurrentContext(threadId);
        if (context === null) return base;
        const treeUnchanged = yield* measureTreeUnchanged(receipt, context.cwd);
        const environmentMatches = yield* measureEnvironmentMatches(receipt);
        const contextMatches =
          context.projectId === receipt.context.projectId &&
          context.workspaceRoot === receipt.context.workspaceRoot &&
          context.worktreePath === receipt.context.worktreePath &&
          context.cwd === receipt.context.cwd &&
          context.shell === receipt.context.shell &&
          context.envSha256 === receipt.context.envSha256;
        const intact = yield* measurementIdentityIntact({
          threadId,
          recordSequence: sequence,
          attemptId: receipt.attemptId,
          revision: receipt.revision,
          anchor: receipt.threadAnchorSequence ?? sequence,
          context,
        });
        if (!intact) return base;
        return { ...base, treeUnchanged, contextMatches, environmentMatches };
      },
    );

    /**
     * The one snapshot calculation both consumers share: `run` fixes it to
     * execute, `resolveTargetPlan` fixes it to describe. The whole validation
     * order — platform, shell, thread existence, turn-active (run only), the
     * project, settings/scripts in request order, the environment digest —
     * lives only here, so neither consumer can answer the same question
     * differently and a run never reads the thread twice. The plan carries the
     * command text for the executor; the record and the facade carry only its
     * hash.
     */
    const resolveSnapshot = (
      input: SelectedChecksRunInput,
      options: { readonly refuseTurnActive: boolean },
    ) =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        if (platform === "win32") {
          return yield* new SelectedChecksRejectedError({ reason: "not-posix" });
        }
        const shell = process.env.SHELL;
        if (shell === undefined || !shell.startsWith("/")) {
          return yield* new SelectedChecksRejectedError({ reason: "shell-unavailable" });
        }
        const threadShell = yield* query.getThreadShellById(input.threadId).pipe(Effect.orDie);
        if (Option.isNone(threadShell)) {
          return yield* new SelectedChecksThreadNotFoundError({ threadId: input.threadId });
        }
        if (options.refuseTurnActive && threadShell.value.latestTurn?.state === "running") {
          return yield* new SelectedChecksRejectedError({ reason: "turn-active" });
        }
        const projectShell = yield* query
          .getProjectShellById(threadShell.value.projectId)
          .pipe(Effect.orDie);
        if (Option.isNone(projectShell)) {
          return yield* new SelectedChecksThreadNotFoundError({ threadId: input.threadId });
        }
        const scripts = resolveProjectScripts(yield* settings.getSettings.pipe(Effect.orDie), {
          id: projectShell.value.id,
          scripts: projectShell.value.scripts,
        });
        const plan: Array<PlannedScript> = [];
        for (const scriptId of input.scriptIds) {
          const script = scripts.find((candidate) => candidate.id === scriptId);
          if (script === undefined) {
            return yield* new SelectedChecksRejectedError({ reason: "script-not-found", scriptId });
          }
          plan.push({
            scriptId,
            scriptName: script.name.slice(0, 80),
            command: script.command,
            commandSha256: yield* sha256HexUtf8(script.command),
            timeoutMs: RUN_CHECK_TIMEOUT_MS,
          });
        }
        const workspaceRoot = projectShell.value.workspaceRoot;
        const worktreePath = threadShell.value.worktreePath;
        // Only the explicit overrides are hashed — the executor still merges the
        // ambient environment at spawn, and the record must not read as a pin of it.
        const env = projectScriptRuntimeEnv({ project: { cwd: workspaceRoot }, worktreePath });
        return {
          threadId: input.threadId,
          projectId: threadShell.value.projectId,
          workspaceRoot,
          worktreePath,
          threadCreatedAt: threadShell.value.createdAt,
          cwd: projectScriptCwd({ project: { cwd: workspaceRoot }, worktreePath }),
          shell,
          platform,
          env,
          envSha256: yield* sha256HexUtf8(JSON.stringify(Object.entries(env).sort())),
          plan,
        } satisfies AttemptSnapshot;
      });

    /** `run`'s snapshot: the shared calculation with the run-only turn refusal. */
    const snapshotFor = (input: SelectedChecksRunInput) =>
      resolveSnapshot(input, { refuseTurnActive: true });

    /**
     * The read-only plan facade over the same snapshot `run` takes: bounded to
     * identifiers and hashes, with no attempt, marker, record write, spawn, or
     * tree observation behind the answer — and a running turn is context, not
     * a refusal.
     */
    const resolveTargetPlan: SelectedChecks["Service"]["resolveTargetPlan"] = (input) =>
      Effect.gen(function* () {
        const snapshot = yield* resolveSnapshot(input, { refuseTurnActive: false });
        return {
          threadId: snapshot.threadId,
          projectId: snapshot.projectId,
          threadCreatedAt: snapshot.threadCreatedAt,
          workspaceRoot: snapshot.workspaceRoot,
          worktreePath: snapshot.worktreePath,
          cwd: snapshot.cwd,
          shell: snapshot.shell,
          envSha256: snapshot.envSha256,
          platform: snapshot.platform,
          arch: yield* HostProcessArchitecture,
          planned: snapshot.plan.map(({ scriptId, commandSha256 }) => ({
            scriptId,
            commandSha256,
          })),
        } satisfies SelectedChecksTargetPlan;
      });

    const observeTree = (cwd: string) =>
      Effect.gen(function* () {
        const detected = yield* vcs.detect({ cwd });
        const observe = detected?.driver.checkpoints?.observeTree;
        const tree = yield* observe === undefined
          ? Effect.succeed({ kind: "unsupported" as const, reason: "not-git" as const })
          : observe({ cwd });
        return tree.kind === "complete"
          ? {
              observation: { kind: "complete" as const, treeOid: tree.treeOid },
              repoIdentity: { topLevel: tree.topLevel, commonDir: tree.commonDir },
            }
          : {
              observation:
                tree.kind === "unsupported"
                  ? { kind: "unsupported" as const, reason: tree.reason }
                  : tree,
              repoIdentity: null,
            };
      });

    const initialReceipt = (snapshot: AttemptSnapshot, attemptId: string) =>
      Effect.gen(function* () {
        const descriptor = yield* environment.getDescriptor;
        return {
          schemaVersion: 1,
          threadId: snapshot.threadId,
          attemptId,
          revision: 0,
          threadAnchorSequence: null,
          context: {
            projectId: snapshot.projectId,
            workspaceRoot: snapshot.workspaceRoot,
            worktreePath: snapshot.worktreePath,
            cwd: snapshot.cwd,
            shell: snapshot.shell,
            envSha256: snapshot.envSha256,
          },
          planned: snapshot.plan.map(({ command: _command, ...planned }) => planned),
          environment: {
            environmentId: descriptor.environmentId,
            platform: yield* HostProcessPlatform,
            arch: yield* HostProcessArchitecture,
            osRelease: NodeOS.release(),
            serverVersion: descriptor.serverVersion,
            nodeVersion: process.version,
          },
          tree: {
            atStart: { kind: "not-captured" },
            atEnd: { kind: "not-captured" },
            repoAtStart: null,
            repoAtEnd: null,
          },
          phase: "running",
          checks: snapshot.plan.map(({ scriptId }) => pendingCheck(scriptId)),
          startedAt: yield* nowIso,
          endedAt: null,
          error: null,
        } satisfies SelectedCheckReceipt;
      });

    const releaseOwnedMarker = (state: AttemptState, claimed: LiveAttempt) =>
      Effect.gen(function* () {
        const marker = state.marker;
        if (marker === null) return;
        yield* transitionMarkerNow(
          { kind: "exact", sha256: marker.sha256 },
          releasedMarker(
            "groups-gone",
            marker.sha256,
            {
              attemptId: claimed.attemptId,
              threadId: claimed.threadId,
              scriptId: marker.scriptId,
              pgid: marker.pgid,
            },
            yield* nowIso,
          ),
        );
        // The disk decides — a rejected or uncertain release changes nothing here.
      });

    /** The exact owner identity a sufficient read may unlatch — all four fields. */
    const sameOwner = (a: PendingOwner | null, b: PendingOwner) =>
      a !== null &&
      a.attemptId === b.attemptId &&
      a.threadId === b.threadId &&
      a.scriptId === b.scriptId &&
      a.pgid === b.pgid;

    /**
     * Runs inside the permit after `unresolved` was already latched, so this
     * read can only release memory and a defect on it still leaves the latch.
     * A readable owned marker naming this attempt's current check with a
     * conservative pgid already represents the owner — clear exactly that
     * owner's latch, nobody else's; every other observed state keeps it until
     * that exact owner is re-persisted.
     */
    const keepOrStrandUnresolved = (claimed: LiveAttempt, unresolved: PendingOwner) =>
      Effect.gen(function* () {
        const marker = yield* readMarkerNow();
        const sufficient =
          marker.kind === "owned" &&
          marker.marker.attemptId === claimed.attemptId &&
          marker.marker.threadId === claimed.threadId &&
          marker.marker.scriptId === unresolved.scriptId &&
          (marker.marker.pgid === null ||
            (unresolved.pgid !== null && marker.marker.pgid === unresolved.pgid));
        if (sufficient) {
          yield* Ref.update(strandedRef, (s) => (sameOwner(s, unresolved) ? null : s));
        }
      });

    /** The one owner an attempt leaves behind without a recorded result. */
    const unresolvedOwner = (claimed: LiveAttempt, state: AttemptState): PendingOwner | null =>
      state.inFlight !== null
        ? {
            attemptId: claimed.attemptId,
            threadId: claimed.threadId,
            scriptId: state.inFlight,
            pgid: null,
          }
        : state.unknown !== null
          ? {
              attemptId: claimed.attemptId,
              threadId: claimed.threadId,
              scriptId: state.unknown.scriptId,
              pgid: state.unknown.pgid,
            }
          : null;

    const finalizeAttempt = (
      claimed: LiveAttempt,
      state: AttemptState,
      receiptRef: Ref.Ref<SelectedCheckReceipt>,
    ) =>
      Effect.gen(function* () {
        const disposition = Effect.gen(function* () {
          // Finality and cancellation sampling share the one ownership permit —
          // the serialized linearization boundary with cancellation acceptance.
          const { cancelled } = yield* ownership.withPermit(
            Effect.gen(function* () {
              // A cancel accepted after this flip is late and changes nothing.
              claimed.acceptingCancel = false;
              const cancelled = yield* Deferred.isDone(claimed.cancel);
              const unresolved = unresolvedOwner(claimed, state);
              if (unresolved !== null) {
                // The memory latch lands before any fallible marker I/O, so a
                // defect below still leaves this exact owner represented.
                // Admission refuses new claims while a latch is held — during
                // this attempt only its own finalizer could have set it.
                yield* Ref.update(strandedRef, (s) => s ?? unresolved);
                if (state.marker !== null) {
                  yield* keepOrStrandUnresolved(claimed, unresolved);
                }
              } else if (state.marker !== null) {
                yield* releaseOwnedMarker(state, claimed);
              }
              return { cancelled };
            }),
          );

          const abort = state.abort;
          const current = yield* Ref.get(receiptRef);
          let phase: SelectedCheckReceipt["phase"];
          let error: ReceiptError | null = null;
          if (cancelled) {
            // Cancel-first for the shared latch: an accepted cancel owns the
            // phase even when a result never landed. Registration failures and
            // the missing result stay recorded as evidence, never dropped to
            // make the phase look cleaner.
            phase = "cancelled";
            error = state.registrationError ?? (state.inFlight !== null ? "result-missing" : null);
          } else if (state.registrationError !== null) {
            phase = "errored";
            error = state.registrationError;
          } else if (abort !== null) {
            phase = "errored";
            error = abort.error;
          } else {
            phase = "completed";
          }

          const final: SelectedCheckReceipt = {
            ...current,
            revision: current.revision + 1,
            phase,
            error,
            endedAt: yield* nowIso,
            checks: settledChecks(current.checks),
          };
          yield* Ref.set(receiptRef, final);
          yield* boundedWrite(final).pipe(
            Effect.catch(() =>
              Effect.logWarning("selected checks outcome could not be recorded (record-failed)", {
                threadId: claimed.threadId,
                attemptId: claimed.attemptId,
              }),
            ),
          );
        });

        const outcome = yield* Effect.exit(disposition);
        // No fallible work stands between the captured outcome and settlement:
        // the slot and both Deferreds settle exactly once, then the original
        // cause — defect and interrupt alike — ends the worker unchanged.
        yield* Effect.uninterruptible(settleSlot(claimed, state));
        if (Exit.isFailure(outcome)) {
          return yield* Effect.failCause(outcome.cause);
        }
      });

    const settleSlot = (claimed: LiveAttempt, state: AttemptState) =>
      ownership.withPermit(
        Effect.gen(function* () {
          yield* Ref.update(liveRef, (live) =>
            live?.attemptId === claimed.attemptId ? null : live,
          );
          yield* Deferred.succeed(claimed.done, undefined);
          if (!state.registeredDone) {
            yield* Deferred.fail(
              claimed.registered,
              new SelectedChecksRejectedError({ reason: "record-failed" }),
            );
          }
        }),
      );

    const attemptBody = (
      snapshot: AttemptSnapshot,
      claimed: LiveAttempt,
      state: AttemptState,
      receiptRef: Ref.Ref<SelectedCheckReceipt>,
    ) =>
      Effect.gen(function* () {
        // Every abort records itself in the shared attempt state — the finalizer
        // runs in this same fiber, so it reads the reason without digging
        // through the exit cause.
        const failRun = (error: ReceiptError): Effect.Effect<never, AttemptAbort> =>
          Effect.sync(() => {
            state.abort = { error };
          }).pipe(Effect.andThen(Effect.fail<AttemptAbort>({ error })));
        // A failed or timed-out record write ends the attempt as record-failed.
        const writeOrAbort = (receipt: SelectedCheckReceipt) =>
          boundedWrite(receipt).pipe(Effect.catch(() => failRun("record-failed")));
        // Registration failures settle `registered` themselves, with their exact
        // reason; the finalizer's fixed record-failed only covers interrupts that
        // never got there.
        const registrationFailure = (reason: RegistrationFailureReason) =>
          Effect.gen(function* () {
            state.registrationError = reason;
            state.abort = { error: reason };
            state.registeredDone = true;
            yield* Deferred.fail(claimed.registered, new SelectedChecksRejectedError({ reason }));
            return yield* Effect.fail<AttemptAbort>({ error: reason });
          });
        const writeNext = (patch: (receipt: SelectedCheckReceipt) => SelectedCheckReceipt) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(receiptRef);
            const next = { ...patch(current), revision: current.revision + 1 };
            yield* Ref.set(receiptRef, next);
            yield* writeOrAbort(next);
          });

        // R1 — the first write anchors the attempt against later thread recreation.
        const initial = yield* Ref.get(receiptRef);
        const s0 = yield* writeOrAbort(initial).pipe(
          Effect.catch(() => registrationFailure("record-failed")),
        );
        yield* Ref.set(receiptRef, { ...initial, threadAnchorSequence: s0 });

        // R2 — the thread this snapshot was taken from must still be this one.
        const threadShell = yield* query.getThreadShellById(snapshot.threadId).pipe(Effect.orDie);
        if (
          Option.isNone(threadShell) ||
          threadShell.value.projectId !== snapshot.projectId ||
          threadShell.value.worktreePath !== snapshot.worktreePath ||
          threadShell.value.createdAt !== snapshot.threadCreatedAt
        ) {
          return yield* registrationFailure("context-changed");
        }

        // R3 — claim the marker before anything can spawn.
        const claimedMarker: OwnerMarker.MarkerTransition = yield* ownership.withPermit(
          transitionMarkerNow(
            { kind: "free" },
            ownedMarker(
              {
                attemptId: claimed.attemptId,
                threadId: claimed.threadId,
                scriptId: null,
                pgid: null,
              },
              yield* nowIso,
            ),
          ),
        );
        if (claimedMarker.kind !== "applied") {
          return yield* registrationFailure("owner-marker-failed");
        }
        state.marker = { sha256: claimedMarker.sha256, scriptId: null, pgid: null };
        yield* Deferred.succeed(claimed.registered, claimed.attemptId);
        state.registeredDone = true;

        const atStart = yield* observeTree(snapshot.cwd).pipe(
          Effect.catch(() => failRun("tree-capture-failed")),
        );
        yield* Ref.update(receiptRef, (receipt) => ({
          ...receipt,
          tree: {
            ...receipt.tree,
            atStart: atStart.observation,
            repoAtStart: atStart.repoIdentity,
          },
        }));

        for (const planned of snapshot.plan) {
          // a — a latched cancel stops before the next spawn.
          if (yield* Deferred.isDone(claimed.cancel)) return "cancelled";
          const currentMarker: AttemptState["marker"] = state.marker;
          if (currentMarker === null) {
            return yield* failRun("owner-marker-failed");
          }
          // b — re-own for this exact check; any non-applied answer stops the
          // attempt with zero spawns, even when the bytes on disk already changed.
          const renewed: OwnerMarker.MarkerTransition = yield* ownership.withPermit(
            transitionMarkerNow(
              { kind: "exact", sha256: currentMarker.sha256 },
              ownedMarker(
                {
                  attemptId: claimed.attemptId,
                  threadId: claimed.threadId,
                  scriptId: planned.scriptId,
                  pgid: null,
                },
                yield* nowIso,
              ),
            ),
          );
          if (renewed.kind === "applied") {
            state.marker = { sha256: renewed.sha256, scriptId: planned.scriptId, pgid: null };
          } else {
            return yield* failRun(
              renewed.kind === "rejected" ? "owner-marker-mismatch" : "owner-marker-failed",
            );
          }

          // c — record the check as running.
          const startedAt = yield* nowIso;
          yield* writeNext((receipt) => ({
            ...receipt,
            checks: receipt.checks.map((check) =>
              check.scriptId === planned.scriptId
                ? { ...check, status: "running", startedAt }
                : check,
            ),
          }));

          // d — the one spawn boundary of the attempt.
          state.inFlight = planned.scriptId;
          const result = yield* runScript({
            shell: snapshot.shell,
            command: planned.command,
            cwd: snapshot.cwd,
            env: snapshot.env,
            timeoutMs: planned.timeoutMs,
            cancelSignal: claimed.cancel,
          });
          state.inFlight = null;

          // e — enrich the marker with observed group evidence for an unknown group.
          if (result.group === "unknown") {
            state.unknown = { scriptId: planned.scriptId, pgid: result.pgid };
            const enriched: OwnerMarker.MarkerTransition = yield* ownership.withPermit(
              transitionMarkerNow(
                { kind: "exact", sha256: renewed.sha256 },
                ownedMarker(
                  {
                    attemptId: claimed.attemptId,
                    threadId: claimed.threadId,
                    scriptId: planned.scriptId,
                    pgid: result.pgid,
                  },
                  yield* nowIso,
                ),
              ),
            );
            if (enriched.kind === "applied") {
              state.marker = {
                sha256: enriched.sha256,
                scriptId: planned.scriptId,
                pgid: result.pgid,
              };
            }
          }

          // f — record the result.
          const endedAt = yield* nowIso;
          yield* writeNext((receipt) => ({
            ...receipt,
            checks: receipt.checks.map((check) =>
              check.scriptId === planned.scriptId
                ? {
                    ...check,
                    status: result.status,
                    endedAt,
                    exitCode: result.exitCode,
                    exitedBy: result.exitedBy,
                    exitSignal: result.exitSignal,
                    pgid: result.pgid,
                    group: result.group,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    failure: result.failure,
                  }
                : check,
            ),
          }));

          // g — stop unless this check proved itself.
          if (result.status !== "passed") return "stopped";
        }

        const atEnd = yield* observeTree(snapshot.cwd).pipe(
          Effect.catch(() => failRun("tree-capture-failed")),
        );
        yield* Ref.update(receiptRef, (receipt) => ({
          ...receipt,
          tree: { ...receipt.tree, atEnd: atEnd.observation, repoAtEnd: atEnd.repoIdentity },
        }));
        return "completed";
      });

    /** Frees an exact claimed slot whose worker never came to own its finalizer. */
    const abandonClaim = (claimed: LiveAttempt) =>
      Effect.gen(function* () {
        yield* Ref.update(liveRef, (live) => (live?.attemptId === claimed.attemptId ? null : live));
        yield* Deferred.fail(
          claimed.registered,
          new SelectedChecksRejectedError({ reason: "record-failed" }),
        );
        yield* Deferred.succeed(claimed.done, undefined);
      });

    const run: SelectedChecks["Service"]["run"] = Effect.fn("SelectedChecks.run")(
      function* (input) {
        const snapshot = yield* snapshotFor(input);
        const attemptId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const state: AttemptState = {
          marker: null,
          inFlight: null,
          unknown: null,
          registeredDone: false,
          registrationError: null,
          abort: null,
        };
        const receiptRef = yield* Ref.make<SelectedCheckReceipt>(
          yield* initialReceipt(snapshot, attemptId),
        );
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const claimed = yield* ownership.withPermit(
              Effect.gen(function* () {
                yield* flushStranded;
                if (!(yield* Ref.get(reconciledRef))) {
                  return yield* new SelectedChecksRejectedError({ reason: "reconciling" });
                }
                if ((yield* Ref.get(liveRef)) !== null) {
                  return yield* new SelectedChecksRejectedError({ reason: "busy" });
                }
                if ((yield* Ref.get(strandedRef)) !== null) {
                  return yield* new SelectedChecksRejectedError({ reason: "owner-unrecorded" });
                }
                const marker = yield* readMarkerNow();
                if (marker.kind === "owned") {
                  return yield* new SelectedChecksRejectedError({ reason: "owner-unresolved" });
                }
                if (marker.kind === "corrupt") {
                  return yield* new SelectedChecksRejectedError({ reason: "owner-corrupt" });
                }
                if (marker.kind === "unreadable") {
                  return yield* new SelectedChecksRejectedError({ reason: "owner-unreadable" });
                }
                const live: LiveAttempt = {
                  attemptId,
                  threadId: input.threadId,
                  cancel: yield* Deferred.make<void>(),
                  acceptingCancel: true,
                  registered: yield* Deferred.make<string, SelectedChecksRejectedError>(),
                  done: yield* Deferred.make<void>(),
                };
                yield* Ref.set(liveRef, live);
                return live;
              }),
            );
            // One uninterruptible handoff: the finalizer rides the body into the
            // fork, so the moment the slot is claimed a fiber owns its release.
            // The fork cannot fail; the guard below still frees the exact claimed
            // slot and completes both signals once if anything ever did.
            yield* attemptBody(snapshot, claimed, state, receiptRef).pipe(
              Effect.onExit(() => finalizeAttempt(claimed, state, receiptRef)),
              Effect.forkIn(runScope, { startImmediately: true, uninterruptible: false }),
              Effect.onError(() => abandonClaim(claimed)),
            );
            // Only the caller's wait is interruptible; the worker above is
            // independent of it and cannot be orphaned by an interrupt here.
            const registered = yield* restore(Deferred.await(claimed.registered));
            return { attemptId: registered };
          }),
        );
      },
    );

    const cancel: SelectedChecks["Service"]["cancel"] = (input) =>
      Effect.gen(function* () {
        // Acceptance and the latch complete together under the permit; only the
        // wait is outside, on the exact accepted run's done reference.
        const done = yield* ownership.withPermit(
          Effect.gen(function* () {
            const live = yield* Ref.get(liveRef);
            if (
              live === null ||
              live.threadId !== input.threadId ||
              live.attemptId !== input.attemptId ||
              !live.acceptingCancel
            ) {
              return null;
            }
            yield* Deferred.succeed(live.cancel, undefined);
            return live.done;
          }),
        );
        if (done === null) return { cancelled: false };
        yield* Deferred.await(done);
        return { cancelled: true };
      });

    const resolveOwnership: SelectedChecks["Service"]["resolveOwnership"] = (input) =>
      ownership.withPermit(
        Effect.gen(function* () {
          yield* flushStranded;
          if ((yield* Ref.get(liveRef)) !== null) {
            return { outcome: "attempt-live", admission: yield* computeAdmission };
          }
          if (input.markerSha256 === null) {
            return { outcome: "still-unresolved", admission: yield* computeAdmission };
          }
          const marker = yield* readMarkerNow();
          if (marker.kind === "unreadable") {
            return { outcome: "unreadable", admission: yield* computeAdmission };
          }
          if (
            marker.kind === "absent" ||
            marker.kind === "released" ||
            marker.sha256 !== input.markerSha256
          ) {
            return { outcome: "stale", admission: yield* computeAdmission };
          }
          const summary: OwnerMarker.ReleasedMarker["previous"] =
            marker.kind === "owned"
              ? {
                  attemptId: marker.marker.attemptId,
                  threadId: marker.marker.threadId,
                  scriptId: marker.marker.scriptId,
                  pgid: marker.marker.pgid,
                }
              : null;
          if (
            marker.kind === "owned" &&
            marker.marker.pgid !== null &&
            probeGroup(marker.marker.pgid) === "gone"
          ) {
            // Signal-zero only: an exists/unknown probe keeps the slot closed.
            const gone = yield* transitionMarkerNow(
              { kind: "exact", sha256: marker.sha256 },
              releasedMarker("gone-observed", marker.sha256, summary, yield* nowIso),
            );
            return {
              outcome:
                gone.kind === "applied"
                  ? "cleared-gone"
                  : gone.kind === "rejected"
                    ? "stale"
                    : "persist-failed",
              admission: yield* computeAdmission,
            };
          }
          if (!input.acknowledgeUncertainty) {
            return { outcome: "still-unresolved", admission: yield* computeAdmission };
          }
          const acknowledged = yield* transitionMarkerNow(
            { kind: "exact", sha256: marker.sha256 },
            releasedMarker("acknowledged", marker.sha256, summary, yield* nowIso),
          );
          return {
            outcome:
              acknowledged.kind === "applied"
                ? "acknowledged"
                : acknowledged.kind === "rejected"
                  ? "stale"
                  : "persist-failed",
            admission: yield* computeAdmission,
          };
        }),
      );

    const reconcile: SelectedChecks["Service"]["reconcile"] = Effect.gen(function* () {
      yield* ownership.withPermit(
        Effect.gen(function* () {
          const marker = yield* readMarkerNow();
          if (
            marker.kind === "owned" &&
            marker.marker.pgid !== null &&
            probeGroup(marker.marker.pgid) === "gone"
          ) {
            yield* transitionMarkerNow(
              { kind: "exact", sha256: marker.sha256 },
              releasedMarker(
                "gone-observed",
                marker.sha256,
                {
                  attemptId: marker.marker.attemptId,
                  threadId: marker.marker.threadId,
                  scriptId: marker.marker.scriptId,
                  pgid: marker.marker.pgid,
                },
                yield* nowIso,
              ),
            );
          }
          yield* Ref.set(reconciledRef, true);
        }),
      );
      // Best effort: a running receipt no process here owns was left by a restart.
      yield* Effect.gen(function* () {
        const activities = yield* query
          .listActivitiesByKind(SELECTED_CHECK_RECEIPT_KIND)
          .pipe(Effect.orDie);
        const live = yield* Ref.get(liveRef);
        for (const activity of activities) {
          const receipt = Option.getOrNull(decodeReceipt(activity.payload));
          if (
            receipt === null ||
            receipt.phase !== "running" ||
            receipt.attemptId === live?.attemptId
          ) {
            continue;
          }
          const settled: SelectedCheckReceipt = {
            ...receipt,
            revision: receipt.revision + 1,
            phase: "interrupted",
            error: "server-restarted",
            endedAt: yield* nowIso,
            checks: settledChecks(receipt.checks),
          };
          yield* boundedWrite(settled).pipe(
            Effect.catch(() =>
              Effect.logWarning("a restarted selected-checks record could not be settled", {
                threadId: receipt.threadId,
                attemptId: receipt.attemptId,
              }),
            ),
          );
        }
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) => Effect.logWarning("selected checks startup reconciliation failed", { cause }),
        ),
      );
    });

    return SelectedChecks.of({
      get,
      run,
      resolveTargetPlan,
      cancel,
      resolveOwnership,
      reconcile,
    });
  });

export const layer = Layer.effect(SelectedChecks, make()).pipe(
  Layer.provide(ProjectionThreadActivityRepositoryLive),
);
