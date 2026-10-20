import { RegistryContext, useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AuthOrchestrationOperateScope,
  SELECTED_CHECK_RECEIPT_KIND,
  SelectedCheckReceipt,
  selectedCheckReceiptId,
  WS_METHODS,
  type AuthSessionState,
  type EnvironmentId,
  type ProjectId,
  type ProjectScript,
  type SelectedCheckAdmission,
  type SelectedChecksCancelResult,
  type SelectedChecksGetResult,
  type SelectedChecksResolveOwnershipResult,
  type SelectedChecksRunResult,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  type ConnectionCatalogEntry,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  createEnvironmentCommand,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { fetchEnvironmentSessionState } from "@t3tools/client-runtime/state/session";
import { createSelectedChecksEnvironmentAtoms } from "@t3tools/client-runtime/state/selected-checks";
import {
  deriveSelectedChecksView,
  initialSelectedChecksControl,
  reduceSelectedChecksControl,
  type SelectedChecksCommandOutcome,
  type SelectedChecksControlEffect,
  type SelectedChecksControlEvent,
  type SelectedChecksControlState,
  type SelectedChecksGetOutcome,
  type SelectedChecksRunRejectionReason,
  type SelectedChecksTarget,
  type SelectedChecksView,
} from "@t3tools/client-runtime/state/selected-checks-control";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { useProject, useThreadDetail, useThreadShell } from "./entities";
import { environmentProjects } from "./projects";
import { serverEnvironment } from "./server";
import { environmentSession, usePreparedConnection } from "./session";
import { environmentThreadDetails, environmentThreadShells } from "./threads";
import { useAtomCommand } from "./use-atom-command";

export const selectedChecksEnvironment =
  createSelectedChecksEnvironmentAtoms(connectionAtomRuntime);

const decodeReceipt = Schema.decodeUnknownOption(SelectedCheckReceipt);

/** Old hosts have no RPC. Transport and authorization failures remain visible. */
export function isSelectedChecksGetMethodMissing(error: unknown): boolean {
  return (
    error === `Unknown request tag: ${WS_METHODS.selectedChecksGet}` ||
    (error instanceof Error &&
      error.message === `Unknown request tag: ${WS_METHODS.selectedChecksGet}`)
  );
}

// ── Auth identity ─────────────────────────────────────────────────────────

const objectIdentities = new WeakMap<object, number>();
let nextObjectIdentity = 0;

/** In-memory epoch for objects that must not be serialized into keys. */
function identityOf(value: object): number {
  const existing = objectIdentities.get(value);
  if (existing !== undefined) return existing;
  const next = ++nextObjectIdentity;
  objectIdentities.set(value, next);
  return next;
}

/**
 * Invocation stamp for one observed connection identity. Only the opaque
 * identity numbers ever enter lifecycle keys — never prepared contents,
 * URLs, or tokens.
 */
export interface SelectedChecksAuthStamp {
  readonly entryId: number;
  readonly generation: number;
  readonly preparedId: number;
  readonly prepared: PreparedConnection;
}

export interface SelectedChecksConfirmation {
  readonly stamp: SelectedChecksAuthStamp;
  readonly status: "checking" | "confirmed" | "failed" | "stale";
  readonly session: AuthSessionState | null;
  readonly attempt: number;
  readonly target: SelectedChecksTarget;
}

const sameStamp = (a: SelectedChecksAuthStamp, b: SelectedChecksAuthStamp): boolean =>
  a.entryId === b.entryId && a.generation === b.generation && a.preparedId === b.preparedId;

export interface SelectedChecksPermissionResult {
  readonly permission: "allowed" | "read-only" | "unknown";
  /** Sorted scopes, present only from the matching confirmed response. */
  readonly scopes: ReadonlyArray<string>;
  readonly status: "checking" | "confirmed" | "failed" | "stale" | "idle";
}

/**
 * Permission for this exact connection identity. Shared SWR session values
 * are never authority: only a confirmed response carrying this stamp can
 * grant `allowed`, and an omitted scope list denies mutations outright.
 */
export function deriveSelectedChecksPermission(
  stamp: SelectedChecksAuthStamp | null,
  confirmation: SelectedChecksConfirmation | null,
): SelectedChecksPermissionResult {
  if (stamp === null) return { permission: "unknown", scopes: [], status: "idle" };
  if (confirmation === null || !sameStamp(confirmation.stamp, stamp)) {
    return { permission: "unknown", scopes: [], status: "idle" };
  }
  if (confirmation.status !== "confirmed") {
    return { permission: "unknown", scopes: [], status: confirmation.status };
  }
  const session = confirmation.session;
  if (session === null) return { permission: "unknown", scopes: [], status: "confirmed" };
  if (session.authenticated !== true) {
    return { permission: "read-only", scopes: [], status: "confirmed" };
  }
  if (session.scopes === undefined) {
    return { permission: "unknown", scopes: [], status: "confirmed" };
  }
  const scopes = [...session.scopes].sort();
  return {
    permission: scopes.includes(AuthOrchestrationOperateScope) ? "allowed" : "read-only",
    scopes,
    status: "confirmed",
  };
}

export interface SelectedChecksLifecycleKeyInput {
  readonly environmentId: string;
  readonly threadId: string;
  readonly incarnation: number;
  readonly connected: boolean;
  readonly connectionGeneration: number;
  readonly auth: {
    readonly permission: string;
    readonly entryId: number | null;
    readonly generation: number | null;
    readonly preparedId: number | null;
    readonly scopes: ReadonlyArray<string>;
  };
  readonly project: { readonly id: string; readonly workspaceRoot: string | null } | null;
  readonly thread: {
    readonly createdAt: string;
    readonly projectId: string;
    readonly worktreePath: string | null;
  } | null;
}

/** JSON scalar tuple; only opaque identity numbers, never auth material. */
export function selectedChecksLifecycleKey(input: SelectedChecksLifecycleKeyInput): string {
  return JSON.stringify([
    input.environmentId,
    input.threadId,
    input.incarnation,
    input.connected ? input.connectionGeneration : "down",
    [
      input.auth.permission,
      input.auth.entryId,
      input.auth.generation,
      input.auth.preparedId,
      input.auth.scopes,
    ],
    input.project === null ? null : [input.project.id, input.project.workspaceRoot],
    input.thread === null
      ? "missing"
      : [input.thread.createdAt, input.thread.projectId, input.thread.worktreePath],
  ]);
}

// ── Stamped session confirmation (direct fetch) ───────────────────────────

interface SessionConfirmationInput {
  readonly generation: number;
  readonly prepared: PreparedConnection;
  readonly entry: ConnectionCatalogEntry;
}

export type SelectedChecksConfirmationOutcome =
  | { readonly kind: "confirmed"; readonly session: AuthSessionState }
  | { readonly kind: "stale" }
  | { readonly kind: "failed" };

/**
 * One bounded, stamped `/api/auth/session` read. Pre-checks the captured
 * lease (connected, expected generation, exact prepared object, present
 * session), fetches with the shared 6s bound and auth/signing services,
 * then re-verifies through `EnvironmentRegistry.run` — a registry swap,
 * reconnect, or session change mid-request settles stale, never confirmed.
 */
export function createSelectedChecksSessionConfirmation<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "selected-checks:confirm-session",
    execute: (input: SessionConfirmationInput, _registry, environmentId) =>
      Effect.gen(function* () {
        const environments = yield* EnvironmentRegistry;
        const readServiceEntry = Effect.gen(function* () {
          const entries = yield* SubscriptionRef.get(environments.entries);
          return entries.get(environmentId) ?? null;
        });

        if ((yield* readServiceEntry) !== input.entry) {
          return { kind: "stale" as const };
        }

        const supervisor = yield* EnvironmentSupervisor;
        const readLease = Effect.gen(function* () {
          const state = yield* SubscriptionRef.get(supervisor.state);
          const prepared = Option.getOrNull(yield* SubscriptionRef.get(supervisor.prepared));
          const session = Option.getOrNull(yield* SubscriptionRef.get(supervisor.session));
          return { state, prepared, session };
        });
        const leaseMatches = (lease: {
          readonly state: SupervisorConnectionState;
          readonly prepared: PreparedConnection | null;
          readonly session: unknown;
        }) =>
          lease.state.phase === "connected" &&
          lease.state.generation === input.generation &&
          lease.prepared === input.prepared &&
          lease.session !== null;

        const before = yield* readLease;
        if (!leaseMatches(before)) return { kind: "stale" as const };

        const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
        const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
        const fetched = yield* fetchEnvironmentSessionState({
          prepared: input.prepared,
          signer,
          remoteAuthorization,
        }).pipe(Effect.result);

        const current = yield* environments
          .run(environmentId, EnvironmentSupervisor)
          .pipe(Effect.result);
        if (Result.isFailure(current) || current.success !== supervisor) {
          return { kind: "stale" as const };
        }
        const after = yield* readLease;
        if (!leaseMatches(after) || after.session !== before.session) {
          return { kind: "stale" as const };
        }
        if ((yield* readServiceEntry) !== input.entry) {
          return { kind: "stale" as const };
        }
        return Result.isSuccess(fetched)
          ? ({ kind: "confirmed", session: fetched.success } as const)
          : ({ kind: "failed" } as const);
      }).pipe(
        // Every other path — registry, transport, defect — settles failed;
        // causes are never logged or surfaced with auth material.
        Effect.catchCause(() => Effect.succeed({ kind: "failed" } as const)),
      ),
  });
}

export const selectedChecksSessionConfirmation =
  createSelectedChecksSessionConfirmation(connectionAtomRuntime);

// ── Command outcome mapping ───────────────────────────────────────────────

const failureTag = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "_tag" in value && typeof value._tag === "string"
    ? value._tag
    : undefined;

function toGetOutcome(
  result: AtomCommandResult<SelectedChecksGetResult, unknown>,
): SelectedChecksGetOutcome {
  if (result._tag === "Success") return { kind: "ok", result: result.value };
  const failure = squashAtomCommandFailure(result);
  if (isSelectedChecksGetMethodMissing(failure)) return { kind: "unsupported" };
  if (isAtomCommandInterrupted(result)) {
    return { kind: "error", message: "The request was interrupted." };
  }
  return {
    kind: "error",
    message:
      failure instanceof Error
        ? failure.message
        : typeof failure === "string"
          ? failure
          : "The request failed.",
  };
}

function rejectedOutcome(failure: unknown): SelectedChecksCommandOutcome | null {
  const tag = failureTag(failure);
  if (tag === "SelectedChecksRejectedError") {
    const { reason, scriptId } = failure as {
      reason: SelectedChecksRunRejectionReason;
      scriptId?: string;
    };
    return { kind: "run-rejected", reason, scriptId };
  }
  if (tag === "SelectedChecksThreadNotFoundError") return { kind: "thread-unavailable" };
  return null;
}

function toRunOutcome(
  result: AtomCommandResult<SelectedChecksRunResult, unknown>,
): SelectedChecksCommandOutcome {
  if (result._tag === "Success") return { kind: "run-ok", attemptId: result.value.attemptId };
  return rejectedOutcome(squashAtomCommandFailure(result)) ?? { kind: "unknown" };
}

function toCancelOutcome(
  result: AtomCommandResult<SelectedChecksCancelResult, unknown>,
): SelectedChecksCommandOutcome {
  if (result._tag === "Success") return { kind: "cancel-ok", cancelled: result.value.cancelled };
  return rejectedOutcome(squashAtomCommandFailure(result)) ?? { kind: "unknown" };
}

function toResolveOutcome(
  result: AtomCommandResult<SelectedChecksResolveOwnershipResult, unknown>,
): SelectedChecksCommandOutcome {
  if (result._tag === "Success") {
    return {
      kind: "resolve-ok",
      outcome: result.value.outcome,
      admission: result.value.admission,
    };
  }
  return rejectedOutcome(squashAtomCommandFailure(result)) ?? { kind: "unknown" };
}

const readCatalogEntry = (
  catalog: EnvironmentCatalogState,
  environmentId: EnvironmentId,
): ConnectionCatalogEntry | null => catalog.entries.get(environmentId) ?? null;

const candidateSignature = (scripts: ReadonlyArray<ProjectScript>): string =>
  JSON.stringify(scripts.map((script) => [script.id, script.command]));

const scriptsForProject = (
  settings: ServerSettings | null,
  project: EnvironmentProject | null,
): ReadonlyArray<ProjectScript> => {
  if (settings === null || project === null) return [];
  return [...resolveProjectScripts(settings, project)];
};

/**
 * Re-validated current checks source: the guarded view plus the stamped
 * permission and the thread's actual project at read time, so a caller can
 * compare a scope it froze earlier. Null when the current target cannot be
 * re-validated.
 */
/** Receipt row identity for bounded downstream reads (task result, usage). */
export function selectedChecksRecordKey(view: SelectedChecksView): string | null {
  const authority = view.recordAuthority;
  if (authority !== "current" && authority !== "live") return null;
  const record = view.record;
  if (record === null || record.sequence === null) return null;
  const receipt = record.receipt;
  return `${receipt.attemptId}:${receipt.revision}:${record.sequence}:${receipt.phase}`;
}

export interface SelectedChecksCurrentSource {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Scalar lifecycle tuple from the guarded snapshot (`selectedChecksLifecycleKey`). */
  readonly lifecycleKey: string;
  readonly permission: "allowed" | "read-only" | "unknown";
  readonly permissionStatus: SelectedChecksPermissionResult["status"];
  /** Stamped session confirmation attempt; blocks auth ABA resurrection. */
  readonly confirmationAttempt: number;
  /** Current passed-record key (`attempt:revision:sequence:phase`) or null. */
  readonly recordKey: string | null;
  readonly view: SelectedChecksView;
  readonly projectId: ProjectId;
}

/**
 * Render-fresh identity of the displayed current passed record, bound for
 * downstream reads (result usage): environment, connection stamp identity,
 * thread incarnation, permission, and the exact attempt/revision/row
 * sequence. Null whenever the panel has no current passed record to bind —
 * a previous or live record never produces one.
 */
export interface SelectedChecksRecordIdentity {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly attemptId: string;
  readonly revision: number;
  readonly receiptSequence: number;
  readonly stamp: {
    readonly entryId: number;
    readonly generation: number;
    readonly preparedId: number;
  } | null;
  readonly incarnation: number;
  readonly permission: "allowed" | "read-only" | "unknown";
  readonly permissionStatus: "checking" | "confirmed" | "failed" | "stale" | "idle";
}

export interface SelectedChecksHandle {
  readonly view: SelectedChecksView;
  readonly candidates: ReadonlyArray<ProjectScript>;
  readonly permission: "allowed" | "read-only" | "unknown";
  readonly permissionStatus: "checking" | "confirmed" | "failed" | "stale" | "idle";
  readonly retryPermission: () => void;
  readonly openPanel: () => void;
  readonly closePanel: () => void;
  readonly toggle: (id: string) => void;
  readonly refresh: () => void;
  readonly run: () => void;
  readonly stop: () => void;
  readonly recheck: () => void;
  readonly openRecoveryDialog: () => void;
  readonly closeRecoveryDialog: () => void;
  readonly submitRecoveryDialog: (acknowledged: boolean) => void;
  readonly readCurrentSource: () => SelectedChecksCurrentSource | null;
  /** Current passed-record identity for bounded downstream reads; null otherwise. */
  readonly recordIdentity: SelectedChecksRecordIdentity | null;
  /**
   * Registry-fresh version of `recordIdentity`, revalidated through the same
   * guarded read as command dispatch; for acceptance-time checks that must
   * not trust the last render. Null when the guard rejects the read.
   */
  readonly readRecordIdentity: () => SelectedChecksRecordIdentity | null;
}

interface ReconcileInput {
  readonly key: string;
  readonly canRead: boolean;
  readonly target: SelectedChecksTarget;
  readonly candidates: ReadonlyArray<string>;
  readonly signature: string;
}

interface Observed {
  readonly connected: boolean;
  readonly canRead: boolean;
  readonly key: string;
  readonly auth: SelectedChecksPermissionResult;
  readonly stamp: SelectedChecksAuthStamp | null;
  readonly shell: EnvironmentThreadShell | null;
  readonly scopedProject: EnvironmentProject | null;
  readonly registryScripts: ReadonlyArray<ProjectScript>;
  readonly live: {
    readonly receipt: SelectedCheckReceipt;
    readonly sequence: number | null;
  } | null;
  readonly latestTurnRequestedAt: string | null;
}

interface RenderSnapshot extends ReconcileInput {
  readonly permission: "allowed" | "read-only" | "unknown";
  readonly connected: boolean;
  readonly live: Observed["live"];
  readonly latestTurnRequestedAt: string | null;
}

const snapshotFromObserved = (
  observedNow: Observed,
  target: SelectedChecksTarget,
): RenderSnapshot => {
  const signature = candidateSignature(observedNow.registryScripts);
  return {
    key: observedNow.key,
    canRead: observedNow.canRead,
    target,
    candidates: observedNow.registryScripts.map((script) => script.id),
    signature,
    permission: observedNow.auth.permission,
    connected: observedNow.connected,
    live: observedNow.live,
    latestTurnRequestedAt: observedNow.latestTurnRequestedAt,
  };
};

const sameTarget = (a: SelectedChecksTarget | null, b: SelectedChecksTarget): boolean =>
  a !== null && a.environmentId === b.environmentId && a.threadId === b.threadId;

const confirmationForTarget = (
  confirmation: SelectedChecksConfirmation | null,
  activeTarget: SelectedChecksTarget,
): SelectedChecksConfirmation | null =>
  confirmation !== null && sameTarget(confirmation.target, activeTarget) ? confirmation : null;

const confirmationInFlightForTarget = (
  confirmation: SelectedChecksConfirmation,
  activeTarget: SelectedChecksTarget,
  attempt: number,
): boolean =>
  confirmation.status === "checking" &&
  confirmation.attempt === attempt &&
  sameTarget(confirmation.target, activeTarget);

/**
 * Sole executor of control effects and sole owner of the mutation guard.
 * Every mutating dispatch first rereads the atom registry synchronously,
 * reconciles lifecycle/candidates into the reducer, then re-derives the
 * current view — a rendered view or a disabled button never authorizes a
 * command. Async settlements are dropped unless their captured
 * target/lifecycle still matches the newest observed snapshot.
 */
export function useSelectedChecks(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly project: EnvironmentProject | null;
  readonly candidates: ReadonlyArray<ProjectScript>;
}): SelectedChecksHandle {
  const { environmentId, threadId } = input;
  const target = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
  const targetRef = useRef(target);
  targetRef.current = target;
  const registry = useContext(RegistryContext);

  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const connectionResult = useAtomValue(environmentCatalog.stateAtom(environmentId));
  const connection = Option.getOrElse(
    AsyncResult.value(connectionResult),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const threadRef = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
  const shell = useThreadShell(threadRef);
  const scopedProject = useProject(
    shell === null ? null : { environmentId, projectId: shell.projectId },
  );
  const detail = useThreadDetail(threadRef);
  const threadStatus = useAtomValue(environmentThreadDetails.statusAtom(threadRef));
  const catalogEntry = readCatalogEntry(catalog, environmentId);
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const resolvedScripts = useMemo(
    () => scriptsForProject(settings, scopedProject),
    [scopedProject, settings],
  );

  // Newest validated live receipt only: schema decode, canonical activity
  // id, receipt thread and environment must all match. Detail may lag the
  // shell, so this stays a hint and never produces a verdict.
  const live = useMemo(() => {
    const activity = (detail?.activities ?? []).find(
      (entry) =>
        entry.kind === SELECTED_CHECK_RECEIPT_KIND && entry.id === selectedCheckReceiptId(threadId),
    );
    if (activity === undefined) return null;
    const receipt = Option.getOrNull(decodeReceipt(activity.payload));
    if (
      receipt === null ||
      receipt.threadId !== threadId ||
      receipt.environment.environmentId !== environmentId
    ) {
      return null;
    }
    return { receipt, sequence: activity.sequence ?? null };
  }, [detail, environmentId, threadId]);

  // Observed removal/reappearance: the subscription sees transitions that
  // React batching could lose; an identical scalar tuple still invalidates
  // through the incarnation number.
  const incarnationRef = useRef(0);
  const tombstoneRef = useRef(false);
  const [incarnationTick, setIncarnationTick] = useState(0);
  const observeIncarnation = useCallback((exists: boolean, status: string | null) => {
    if (!exists || status === "deleted") {
      tombstoneRef.current = true;
      return;
    }
    if (!tombstoneRef.current) return;
    tombstoneRef.current = false;
    incarnationRef.current += 1;
    setIncarnationTick((tick) => tick + 1);
  }, []);
  useEffect(() => {
    tombstoneRef.current = false;
    const statusAtom = environmentThreadDetails.statusAtom(threadRef);
    const shellAtom = environmentThreadShells.threadShellAtom(threadRef);
    const syncIncarnation = () => {
      observeIncarnation(registry.get(shellAtom) !== null, registry.get(statusAtom));
    };
    syncIncarnation();
    const unsubscribeStatus = registry.subscribe(statusAtom, syncIncarnation);
    const unsubscribeShell = registry.subscribe(shellAtom, syncIncarnation);
    return () => {
      unsubscribeStatus();
      unsubscribeShell();
    };
  }, [observeIncarnation, registry, threadRef]);

  const stamp = useMemo<SelectedChecksAuthStamp | null>(() => {
    if (connection.phase !== "connected" || catalogEntry === null || prepared === null) {
      return null;
    }
    return {
      entryId: identityOf(catalogEntry),
      generation: connection.generation,
      preparedId: identityOf(prepared),
      prepared,
    };
  }, [catalogEntry, connection.phase, connection.generation, prepared]);

  const confirmSession = useAtomCommand(selectedChecksSessionConfirmation, {
    reportFailure: false,
    reportDefect: false,
  });
  const attemptRef = useRef(0);
  const [confirmation, setConfirmation] = useState<SelectedChecksConfirmation | null>(null);
  const confirmationRef = useRef(confirmation);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attemptRef.current += 1;
      confirmationRef.current = null;
    };
  }, []);

  const readObservedRef = useRef<() => Observed>(() => {
    throw new Error("readObserved not initialized");
  });

  const startConfirmation = useCallback(
    (next: SelectedChecksAuthStamp) => {
      const entry =
        registry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId) ?? null;
      if (entry === null || identityOf(entry) !== next.entryId) return;

      const attempt = ++attemptRef.current;
      const pendingTarget = targetRef.current;
      const pending: SelectedChecksConfirmation = {
        stamp: next,
        status: "checking",
        session: null,
        attempt,
        target: pendingTarget,
      };
      confirmationRef.current = pending;
      setConfirmation(pending);
      void confirmSession({
        environmentId,
        input: { generation: next.generation, prepared: next.prepared, entry },
      }).then((result) => {
        if (!mountedRef.current || attemptRef.current !== attempt) return;
        const observedNow = readObservedRef.current();
        const stampNow = observedNow.stamp;
        if (stampNow === null || !sameStamp(stampNow, next)) return;
        if (!sameTarget(targetRef.current, pending.target)) return;
        const outcome =
          result._tag === "Success"
            ? result.value
            : ({ kind: "failed" } satisfies SelectedChecksConfirmationOutcome);
        const settled: SelectedChecksConfirmation =
          outcome.kind === "confirmed"
            ? {
                stamp: next,
                status: "confirmed",
                session: outcome.session,
                attempt,
                target: pending.target,
              }
            : { stamp: next, status: outcome.kind, session: null, attempt, target: pending.target };
        confirmationRef.current = settled;
        setConfirmation(settled);
      });
    },
    [confirmSession, environmentId, registry, threadId],
  );

  // Bounded confirmation per observed identity. No auto-retry: an unchanged
  // identity needs an explicit invalidation/retry path to check again.
  useEffect(() => {
    if (stamp === null) {
      if (confirmationRef.current !== null) {
        attemptRef.current += 1;
        confirmationRef.current = null;
        setConfirmation(null);
      }
      return;
    }
    const current = confirmationRef.current;
    const latestTarget = targetRef.current;
    if (current !== null && sameStamp(current.stamp, stamp) && current.status !== "stale") {
      if (
        sameTarget(current.target, latestTarget) &&
        (current.status !== "checking" ||
          confirmationInFlightForTarget(current, latestTarget, attemptRef.current))
      ) {
        return;
      }
    }
    startConfirmation(stamp);
  }, [environmentId, stamp, startConfirmation, threadId]);

  // Focus/manual refresh and retry invalidate locally first: permission
  // drops to unknown before a new bounded confirmation starts. A check
  // already in flight coalesces instead of duplicating.
  const invalidateConfirmation = useCallback(() => {
    const current = confirmationRef.current;
    if (
      current === null ||
      confirmationInFlightForTarget(current, targetRef.current, attemptRef.current)
    ) {
      return;
    }
    const stale: SelectedChecksConfirmation = { ...current, status: "stale" };
    confirmationRef.current = stale;
    setConfirmation(stale);
  }, []);

  const get = useAtomCommand(selectedChecksEnvironment.get, { reportFailure: false });
  const runCommand = useAtomCommand(selectedChecksEnvironment.run, { reportFailure: false });
  const cancel = useAtomCommand(selectedChecksEnvironment.cancel, { reportFailure: false });
  const resolve = useAtomCommand(selectedChecksEnvironment.resolveOwnership, {
    reportFailure: false,
  });
  const commandsRef = useRef({ get, run: runCommand, cancel, resolve });
  commandsRef.current = { get, run: runCommand, cancel, resolve };

  const [control, setControl] = useState<SelectedChecksControlState>(initialSelectedChecksControl);
  const controlRef = useRef(control);
  const snapshotRef = useRef<{
    key: string;
    canRead: boolean;
    target: SelectedChecksTarget;
  } | null>(null);
  const lastReconciledSignatureRef = useRef("");

  const publishSnapshot = useCallback((snap: ReconcileInput) => {
    snapshotRef.current = { key: snap.key, canRead: snap.canRead, target: snap.target };
  }, []);

  const applyEventsRef = useRef<(events: ReadonlyArray<SelectedChecksControlEvent>) => void>(
    () => {},
  );
  const executeEffectRef = useRef<(effect: SelectedChecksControlEffect) => void>(() => {});
  const reconcileRef = useRef<(snap: ReconcileInput) => void>(() => {});
  applyEventsRef.current = (events) => {
    // Transitions from one input batch coalesce into the newest emitted
    // effect, so a lifecycle+candidate reconcile issues exactly one get.
    let effect: SelectedChecksControlEffect | null = null;
    for (const event of events) {
      const { state, effect: next } = reduceSelectedChecksControl(controlRef.current, event);
      if (state !== controlRef.current) {
        controlRef.current = state;
        setControl(state);
      }
      if (next !== null) effect = next;
    }
    if (effect !== null) {
      const observedNow = readObservedRef.current();
      publishSnapshot(snapshotFromObserved(observedNow, targetRef.current));
      executeEffectRef.current(effect);
    }
  };
  executeEffectRef.current = (effect) => {
    if (!mountedRef.current) return;
    const environmentId = effect.target.environmentId;
    const acceptsSettlement = () => {
      if (!mountedRef.current) return false;
      const currentTarget = targetRef.current;
      if (!sameTarget(effect.target, currentTarget)) return false;
      const observedNow = readObservedRef.current();
      const snap = snapshotFromObserved(observedNow, currentTarget);
      publishSnapshot(snap);
      reconcileRef.current(snap);
      const current = controlRef.current;
      return (
        sameTarget(current.target, effect.target) &&
        current.lifecycle === effect.lifecycle &&
        current.gen === effect.gen &&
        current.canRead === observedNow.canRead
      );
    };
    const { get, run, cancel, resolve } = commandsRef.current;
    if (effect.type === "get") {
      void get({ environmentId, input: { threadId: effect.target.threadId } }).then((result) => {
        if (!acceptsSettlement()) return;
        applyEventsRef.current([
          { type: "get-settled", gen: effect.gen, outcome: toGetOutcome(result) },
        ]);
      });
      return;
    }
    const spec = effect.spec;
    const settle = (outcome: SelectedChecksCommandOutcome) => {
      if (!acceptsSettlement()) return;
      applyEventsRef.current([{ type: "command-settled", gen: effect.gen, outcome }]);
    };
    if (spec.kind === "run") {
      void run({ environmentId, input: spec.input }).then((result) => settle(toRunOutcome(result)));
    } else if (spec.kind === "cancel") {
      void cancel({ environmentId, input: spec.input }).then((result) =>
        settle(toCancelOutcome(result)),
      );
    } else {
      void resolve({ environmentId, input: spec.input }).then((result) =>
        settle(toResolveOutcome(result)),
      );
    }
  };

  const buildObserved = useCallback(
    (raw: {
      readonly connection: SupervisorConnectionState;
      readonly prepared: PreparedConnection | null;
      readonly catalogEntry: ConnectionCatalogEntry | null;
      readonly shell: EnvironmentThreadShell | null;
      readonly scopedProject: EnvironmentProject | null;
      readonly detail: EnvironmentThread | null;
      readonly threadStatus: string | null;
      readonly confirmation: SelectedChecksConfirmation | null;
      readonly registryScripts: ReadonlyArray<ProjectScript>;
    }): Observed => {
      const connected = raw.connection.phase === "connected";
      const observedStamp =
        connected && raw.catalogEntry !== null && raw.prepared !== null
          ? {
              entryId: identityOf(raw.catalogEntry),
              generation: raw.connection.generation,
              preparedId: identityOf(raw.prepared),
              prepared: raw.prepared,
            }
          : null;
      const auth = deriveSelectedChecksPermission(
        observedStamp,
        confirmationForTarget(raw.confirmation, { environmentId, threadId }),
      );
      const exists = raw.shell !== null && raw.threadStatus !== "deleted";
      const canRead = connected && exists;
      const key = selectedChecksLifecycleKey({
        environmentId,
        threadId,
        incarnation: incarnationRef.current,
        connected,
        connectionGeneration: raw.connection.generation,
        auth: {
          permission: auth.permission,
          entryId: observedStamp?.entryId ?? null,
          generation: observedStamp?.generation ?? null,
          preparedId: observedStamp?.preparedId ?? null,
          scopes: auth.scopes,
        },
        project:
          raw.scopedProject === null
            ? null
            : { id: raw.scopedProject.id, workspaceRoot: raw.scopedProject.workspaceRoot },
        thread:
          raw.shell === null
            ? null
            : {
                createdAt: raw.shell.createdAt,
                projectId: raw.shell.projectId,
                worktreePath: raw.shell.worktreePath,
              },
      });
      const activity = (raw.detail?.activities ?? []).find(
        (entry) =>
          entry.kind === SELECTED_CHECK_RECEIPT_KIND &&
          entry.id === selectedCheckReceiptId(threadId),
      );
      let liveResult: Observed["live"] = null;
      if (activity !== undefined) {
        const receipt = Option.getOrNull(decodeReceipt(activity.payload));
        if (
          receipt !== null &&
          receipt.threadId === threadId &&
          receipt.environment.environmentId === environmentId
        ) {
          liveResult = { receipt, sequence: activity.sequence ?? null };
        }
      }
      return {
        connected,
        canRead,
        key,
        auth,
        stamp: observedStamp,
        shell: raw.shell,
        scopedProject: raw.scopedProject,
        registryScripts: raw.registryScripts,
        live: liveResult,
        latestTurnRequestedAt: raw.shell?.latestTurn?.requestedAt ?? null,
      };
    },
    [environmentId, threadId],
  );

  const observed = useMemo(
    () =>
      buildObserved({
        connection,
        prepared,
        catalogEntry,
        shell,
        scopedProject,
        detail,
        threadStatus,
        confirmation,
        registryScripts: resolvedScripts,
      }),
    [
      buildObserved,
      catalogEntry,
      confirmation,
      connection,
      detail,
      incarnationTick,
      prepared,
      resolvedScripts,
      scopedProject,
      shell,
      threadStatus,
    ],
  );

  // Synchronous registry re-read for the click boundary and refresh paths —
  // never the last render's props.
  const readObserved = useCallback((): Observed => {
    const conn = Option.getOrElse(
      AsyncResult.value(registry.get(environmentCatalog.stateAtom(environmentId))),
      () => AVAILABLE_CONNECTION_STATE,
    );
    const preparedNow = Option.getOrNull(
      registry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
    const cat = registry.get(environmentCatalog.catalogValueAtom);
    const shellNow = registry.get(environmentThreadShells.threadShellAtom(threadRef));
    const detailNow = registry.get(environmentThreadDetails.detailAtom(threadRef));
    const statusNow = registry.get(environmentThreadDetails.statusAtom(threadRef));
    const scopedProjectNow =
      shellNow === null
        ? null
        : registry.get(
            environmentProjects.projectAtom({ environmentId, projectId: shellNow.projectId }),
          );
    const settingsNow = registry.get(serverEnvironment.settingsValueAtom(environmentId));
    const scriptsNow = scriptsForProject(settingsNow, scopedProjectNow);
    observeIncarnation(shellNow !== null, statusNow);
    return buildObserved({
      connection: conn,
      prepared: preparedNow,
      catalogEntry: readCatalogEntry(cat, environmentId),
      shell: shellNow,
      scopedProject: scopedProjectNow,
      detail: detailNow,
      threadStatus: statusNow,
      confirmation: confirmationRef.current,
      registryScripts: scriptsNow,
    });
  }, [buildObserved, environmentId, observeIncarnation, registry, threadRef]);
  readObservedRef.current = readObserved;

  const syncConfirmation = useCallback(
    (observedNow: Observed) => {
      const stampNow = observedNow.stamp;
      if (stampNow === null) {
        if (confirmationRef.current !== null) {
          attemptRef.current += 1;
          confirmationRef.current = null;
          setConfirmation(null);
        }
        return;
      }
      const current = confirmationRef.current;
      const latestTarget = targetRef.current;
      if (
        current !== null &&
        sameStamp(current.stamp, stampNow) &&
        confirmationInFlightForTarget(current, latestTarget, attemptRef.current)
      ) {
        return;
      }
      startConfirmation(stampNow);
    },
    [startConfirmation],
  );

  const reconcile = useCallback((snap: ReconcileInput) => {
    const events: SelectedChecksControlEvent[] = [];
    const current = controlRef.current;
    if (
      !sameTarget(current.target, snap.target) ||
      current.lifecycle !== snap.key ||
      current.canRead !== snap.canRead
    ) {
      events.push({
        type: "lifecycle",
        key: snap.key,
        canRead: snap.canRead,
        target: snap.target,
      });
    }
    // A lifecycle target reset clears lastCandidates, so the snapshot must
    // follow it even when the id list is identical.
    const last = current.lastCandidates;
    const idsDiffer =
      last.length !== snap.candidates.length ||
      snap.candidates.some((id, index) => last[index] !== id);
    const signatureDiffer = lastReconciledSignatureRef.current !== snap.signature;
    if (events.length > 0 || idsDiffer || signatureDiffer) {
      events.push({ type: "candidates-changed", ids: snap.candidates });
      lastReconciledSignatureRef.current = snap.signature;
    }
    if (events.length > 0) applyEventsRef.current(events);
  }, []);
  reconcileRef.current = reconcile;

  const renderSnapshot = useMemo(() => snapshotFromObserved(observed, target), [observed, target]);
  publishSnapshot(renderSnapshot);

  useLayoutEffect(() => {
    reconcile(renderSnapshot);
  }, [reconcile, renderSnapshot]);

  const liveTerminalKey =
    observed.live !== null && observed.live.receipt.phase !== "running"
      ? `${observed.live.receipt.attemptId}:${observed.live.receipt.revision}`
      : null;
  useEffect(() => {
    if (liveTerminalKey !== null) {
      applyEventsRef.current([{ type: "live-terminal", key: liveTerminalKey }]);
    }
  }, [liveTerminalKey]);

  /**
   * One registry-fresh observed snapshot reconciled into the controller,
   * then verified: null when the read cannot synchronize (target, lifecycle
   * or readability drifted between read and reconcile). The derived view and
   * every consumer share this single read — never a second, divergent one.
   */
  const readGuarded = useCallback(() => {
    const observedNow = readObserved();
    const snap = snapshotFromObserved(observedNow, target);
    publishSnapshot(snap);
    reconcile(snap);
    const current = controlRef.current;
    if (
      !sameTarget(current.target, snap.target) ||
      current.lifecycle !== snap.key ||
      current.canRead !== snap.canRead
    ) {
      return null;
    }
    return {
      observed: observedNow,
      snapshot: snap,
      view: deriveSelectedChecksView({
        control: current,
        live: snap.live,
        permission: snap.permission,
        connected: snap.connected,
        candidateIds: snap.candidates,
        latestTurnRequestedAt: snap.latestTurnRequestedAt,
      }),
    };
  }, [publishSnapshot, readObserved, reconcile, target]);

  const guardCurrentView = useCallback(
    (): SelectedChecksView | null => readGuarded()?.view ?? null,
    [readGuarded],
  );

  /**
   * Fresh source for flows that must re-validate the current record at act
   * time (e.g. saving a candidate from a passed record): the same guarded
   * read as command dispatch, plus the stamped permission and the thread's
   * actual project for the caller to compare against its frozen scope. Null
   * when the current target cannot be re-validated — the guard rejected the
   * read, the target is unreadable, or the thread or project record is
   * missing or no longer matches.
   */
  const readCurrentSource = useCallback((): SelectedChecksCurrentSource | null => {
    const guarded = readGuarded();
    if (guarded === null || !guarded.observed.canRead) return null;
    const shell = guarded.observed.shell;
    const project = guarded.observed.scopedProject;
    if (
      shell === null ||
      shell.id !== threadId ||
      shell.environmentId !== environmentId ||
      project === null ||
      project.id !== shell.projectId ||
      project.environmentId !== environmentId
    ) {
      return null;
    }
    const conf = confirmationForTarget(confirmationRef.current, { environmentId, threadId });
    return {
      environmentId,
      threadId,
      lifecycleKey: guarded.snapshot.key,
      permission: guarded.snapshot.permission,
      permissionStatus: guarded.observed.auth.status,
      confirmationAttempt: conf?.attempt ?? 0,
      recordKey: selectedChecksRecordKey(guarded.view),
      view: guarded.view,
      projectId: project.id,
    };
  }, [environmentId, readGuarded, threadId]);

  const openPanel = useCallback(() => {
    const observedNow = readObserved();
    const snap = snapshotFromObserved(observedNow, target);
    publishSnapshot(snap);
    reconcile(snap);
    const receipt =
      observedNow.live?.receipt ??
      (controlRef.current.lastResult?.record.kind === "present"
        ? controlRef.current.lastResult.record.receipt
        : null);
    applyEventsRef.current([
      {
        type: "open",
        seedIds: receipt?.planned.map((check) => check.scriptId) ?? [],
        canRead: observedNow.canRead,
        target,
      },
    ]);
  }, [publishSnapshot, readObserved, reconcile, target, threadId]);

  const closePanel = useCallback(() => applyEventsRef.current([{ type: "close" }]), []);
  const toggle = useCallback((id: string) => applyEventsRef.current([{ type: "toggle", id }]), []);

  const boundedRefresh = useCallback(
    (event: "manual-refresh" | "focus-refresh") => {
      invalidateConfirmation();
      const observedNow = readObserved();
      const snap = snapshotFromObserved(observedNow, target);
      publishSnapshot(snap);
      const before = controlRef.current.lifecycle;
      reconcile(snap);
      syncConfirmation(observedNow);
      // Lifecycle reconciliation already emitted the one new-generation get
      // whenever invalidating permission moved the key.
      if (controlRef.current.lifecycle === before) {
        applyEventsRef.current([{ type: event }]);
      }
    },
    [invalidateConfirmation, publishSnapshot, readObserved, reconcile, syncConfirmation, target],
  );
  const refresh = useCallback(() => boundedRefresh("manual-refresh"), [boundedRefresh]);

  useEffect(() => {
    if (!control.open) return;
    const refreshOnFocus = () => {
      if (document.visibilityState === "visible") boundedRefresh("focus-refresh");
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [boundedRefresh, control.open]);

  const runChecks = useCallback(() => {
    const view = guardCurrentView();
    if (view === null || !view.canRun) return;
    applyEventsRef.current([
      {
        type: "command-start",
        spec: { kind: "run", input: { threadId, scriptIds: [...view.selection] } },
      },
    ]);
  }, [guardCurrentView, threadId]);

  const stop = useCallback(() => {
    const view = guardCurrentView();
    if (view === null || !view.canStop || view.stopAttemptId === null) return;
    applyEventsRef.current([
      {
        type: "command-start",
        spec: { kind: "cancel", input: { threadId, attemptId: view.stopAttemptId } },
      },
    ]);
  }, [guardCurrentView, threadId]);

  const recheck = useCallback(() => {
    const view = guardCurrentView();
    if (view === null || !view.canRecover || view.admission === null) return;
    const admission: SelectedCheckAdmission = view.admission;
    applyEventsRef.current([
      {
        type: "command-start",
        spec: {
          kind: "resolve",
          input: {
            markerSha256: admission.state === "owner-unresolved" ? admission.marker.sha256 : null,
            acknowledgeUncertainty: false,
          },
        },
      },
    ]);
  }, [guardCurrentView]);

  const openRecoveryDialog = useCallback(() => {
    const view = guardCurrentView();
    const admission = view?.admission ?? null;
    if (
      admission === null ||
      (admission.state !== "owner-unresolved" && admission.state !== "owner-corrupt")
    ) {
      return;
    }
    applyEventsRef.current([
      { type: "dialog-open", state: admission.state, sha256: admission.marker.sha256 },
    ]);
  }, [guardCurrentView]);

  const closeRecoveryDialog = useCallback(
    () => applyEventsRef.current([{ type: "dialog-close" }]),
    [],
  );

  const submitRecoveryDialog = useCallback(
    (acknowledged: boolean) => {
      const view = guardCurrentView();
      if (
        !acknowledged ||
        view === null ||
        view.dialogSubmit === null ||
        !view.dialogSubmit.allowed
      ) {
        return;
      }
      applyEventsRef.current([
        { type: "command-start", spec: { kind: "resolve", input: view.dialogSubmit.input } },
        { type: "dialog-close" },
      ]);
    },
    [guardCurrentView],
  );

  const retryPermission = useCallback(() => {
    invalidateConfirmation();
    const observedNow = readObserved();
    const snap = snapshotFromObserved(observedNow, target);
    publishSnapshot(snap);
    reconcile(snap);
    syncConfirmation(observedNow);
  }, [invalidateConfirmation, publishSnapshot, readObserved, reconcile, syncConfirmation, target]);

  const view = useMemo(
    () =>
      deriveSelectedChecksView({
        control,
        live: renderSnapshot.live,
        permission: renderSnapshot.permission,
        connected: renderSnapshot.connected,
        candidateIds: renderSnapshot.candidates,
        latestTurnRequestedAt: renderSnapshot.latestTurnRequestedAt,
      }),
    [control, renderSnapshot],
  );

  // One identity builder shared by the render accessor and the fresh guarded
  // read, so both expose the same bound record identity.
  const buildRecordIdentity = useCallback(
    (
      observedNow: Observed,
      currentView: SelectedChecksView,
    ): SelectedChecksRecordIdentity | null => {
      if (!observedNow.canRead) return null;
      if (currentView.headline !== "passed" || currentView.recordAuthority !== "current") {
        return null;
      }
      const record = currentView.record;
      if (record === null || record.sequence === null) return null;
      return {
        environmentId,
        threadId,
        attemptId: record.receipt.attemptId,
        revision: record.receipt.revision,
        receiptSequence: record.sequence,
        stamp:
          observedNow.stamp === null
            ? null
            : {
                entryId: observedNow.stamp.entryId,
                generation: observedNow.stamp.generation,
                preparedId: observedNow.stamp.preparedId,
              },
        incarnation: incarnationRef.current,
        permission: observedNow.auth.permission,
        permissionStatus: observedNow.auth.status,
      };
    },
    [environmentId, threadId],
  );

  // Pure render-time accessor over the same observed/view authority as
  // everything else the hook returns — no second read, no side effects.
  const recordIdentity = useMemo(
    () => buildRecordIdentity(observed, view),
    [buildRecordIdentity, observed, view],
  );

  /**
   * Fresh guarded identity for acceptance-time checks: the same readGuarded
   * source as command dispatch, judged synchronously against the identity a
   * request captured when it started.
   */
  const readRecordIdentity = useCallback((): SelectedChecksRecordIdentity | null => {
    const guarded = readGuarded();
    if (guarded === null) return null;
    return buildRecordIdentity(guarded.observed, guarded.view);
  }, [buildRecordIdentity, readGuarded]);

  return {
    view,
    candidates: resolvedScripts,
    permission: observed.auth.permission,
    permissionStatus: observed.auth.status,
    retryPermission,
    openPanel,
    closePanel,
    toggle,
    refresh,
    run: runChecks,
    stop,
    recheck,
    openRecoveryDialog,
    closeRecoveryDialog,
    submitRecoveryDialog,
    readCurrentSource,
    recordIdentity,
    readRecordIdentity,
  };
}
