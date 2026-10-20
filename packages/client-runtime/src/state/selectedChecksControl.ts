import * as DateTime from "effect/DateTime";
import {
  deriveSelectedCheckState,
  parseSelectedCheckInstant,
  SELECTED_CHECK_MAX,
  type SelectedCheckAdmission,
  type SelectedCheckReceipt,
  type SelectedChecksCancelInput,
  type SelectedChecksDerivedState,
  type SelectedChecksGetResult,
  type SelectedChecksRejectedError,
  type SelectedChecksResolveOwnershipInput,
  type SelectedChecksResolveOwnershipResult,
  type SelectedChecksRunInput,
  type Sha256Hex,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";

/**
 * Selected-checks panel state machine (U1): a pure reducer plus a view
 * derivation, shared by web and mobile. It reads no atoms and no globals —
 * every fact arrives as a typed event or a derive input, and every outbound
 * request is one returned effect carrying its generation. Stale callbacks
 * are rejected by generation equality, never by clocks or arrival order.
 */

/** Reason a run was rejected, exactly as the rejected-run error reports it. */
export type SelectedChecksRunRejectionReason = SelectedChecksRejectedError["reason"];

/**
 * Immutable request target captured into state and every emitted effect, so
 * executors never re-read mutable hook props. It also scopes retained data:
 * records and selection of one target are never shown or seeded under
 * another.
 */
export interface SelectedChecksTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** How one get request ended. `unsupported` is the exact unknown-method defect only. */
export type SelectedChecksGetOutcome =
  | { readonly kind: "ok"; readonly result: SelectedChecksGetResult }
  | { readonly kind: "unsupported" }
  | { readonly kind: "error"; readonly message: string };

/**
 * How one issued command ended. `unknown` covers send failure, defect, and
 * interruption: the server outcome is not known and must not be fabricated.
 */
export type SelectedChecksCommandOutcome =
  | { readonly kind: "run-ok"; readonly attemptId: string }
  | {
      readonly kind: "run-rejected";
      readonly reason: SelectedChecksRunRejectionReason;
      readonly scriptId?: string | undefined;
    }
  | { readonly kind: "thread-unavailable" }
  | { readonly kind: "cancel-ok"; readonly cancelled: boolean }
  | {
      readonly kind: "resolve-ok";
      readonly outcome: SelectedChecksResolveOwnershipResult["outcome"];
      readonly admission: SelectedCheckAdmission;
    }
  | { readonly kind: "unknown" };

/**
 * Immutable typed input captured once when a command is dispatched. The
 * executor never rebuilds it from later UI state: run's selected ids,
 * cancel's displayed attempt id, or resolve's exact marker digest and
 * acknowledgement flag.
 */
export type SelectedChecksCommandSpec =
  | { readonly kind: "run"; readonly input: SelectedChecksRunInput }
  | { readonly kind: "cancel"; readonly input: SelectedChecksCancelInput }
  | { readonly kind: "resolve"; readonly input: SelectedChecksResolveOwnershipInput };

/** Transient user-facing messages; each key maps to fixed copy in the panel. */
export type SelectedChecksNotice =
  | {
      readonly key: "run-rejected";
      readonly reason: SelectedChecksRunRejectionReason;
      readonly scriptId: string | null;
    }
  | {
      readonly key:
        | "run-superseded"
        | "run-unavailable"
        | "start-unconfirmed"
        | "cancel-unconfirmed"
        | "resolve-unconfirmed"
        | "cancel-requested"
        | "cancel-no-match"
        | "thread-unavailable";
    }
  | {
      readonly key: "resolve-outcome";
      readonly outcome: SelectedChecksResolveOwnershipResult["outcome"];
    };

export interface SelectedChecksControlState {
  /** Identity tuple of connection/auth/thread context; changes reset authority. */
  readonly lifecycle: string;
  readonly open: boolean;
  /** Connected and the target thread exists; only then may a get be sent. */
  readonly canRead: boolean;
  /** Request target copied into every emitted effect. */
  readonly target: SelectedChecksTarget | null;
  /**
   * Authority generation. Bumped on every transition that invalidates
   * outstanding callbacks; only events tagged with the current gen land.
   */
  readonly gen: number;
  readonly get: {
    /** Generation the last request was issued at. */
    readonly gen: number;
    readonly phase: "idle" | "loading" | "settled";
    readonly outcome: SelectedChecksGetOutcome | null;
  };
  /**
   * Last accepted ok result for the current target, retained across
   * authority loss so it can render as "Previous record" only. Cleared on
   * target change.
   */
  readonly lastResult: SelectedChecksGetResult | null;
  /** In-flight command with the input captured at dispatch. */
  readonly command: {
    readonly gen: number;
    readonly lifecycle: string;
    readonly target: SelectedChecksTarget;
    readonly spec: SelectedChecksCommandSpec;
  } | null;
  /**
   * Admission observed by an accepted resolve; an observation for the current
   * generation only, never a substitute for the post-command get.
   */
  readonly resolveSeen: {
    readonly gen: number;
    readonly admission: SelectedCheckAdmission;
  } | null;
  /** Attempt the next accepted ok get must represent. */
  readonly pendingRun: { readonly attemptId: string } | null;
  readonly notice: SelectedChecksNotice | null;
  /**
   * `${attemptId}:${revision}` of a terminal live record that already
   * triggered its one automatic refresh; never rearmed for the same key.
   */
  readonly refreshedLiveKey: string | null;
  readonly dialog: {
    readonly gen: number;
    readonly lifecycle: string;
    readonly state: "owner-unresolved" | "owner-corrupt";
    readonly sha256: Sha256Hex;
  } | null;
  readonly selection: {
    /** Lifecycle this seed belongs to; null while a deferred seed is allowed. */
    readonly seededFor: string | null;
    readonly userEdited: boolean;
    readonly ids: ReadonlyArray<string>;
  };
  /** Newest candidate list seen; prunes selection and filters deferred seeds. */
  readonly lastCandidates: ReadonlyArray<string>;
}

export type SelectedChecksControlEvent =
  | {
      /**
       * `key`: full lifecycle tuple. `canRead`: connected and the thread
       * exists. `target`: environment/thread identity. A repeated key still
       * transitions when readiness or target changed.
       */
      readonly type: "lifecycle";
      readonly key: string;
      readonly canRead: boolean;
      readonly target: SelectedChecksTarget;
    }
  | {
      readonly type: "open";
      /** Plan ids from a live/previous record; re-filtered to candidates here. */
      readonly seedIds: ReadonlyArray<string>;
      readonly canRead: boolean;
      readonly target: SelectedChecksTarget;
    }
  | { readonly type: "close" }
  | { readonly type: "candidates-changed"; readonly ids: ReadonlyArray<string> }
  | { readonly type: "toggle"; readonly id: string }
  | {
      readonly type: "get-settled";
      readonly gen: number;
      readonly outcome: SelectedChecksGetOutcome;
    }
  | { readonly type: "command-start"; readonly spec: SelectedChecksCommandSpec }
  | {
      readonly type: "command-settled";
      readonly gen: number;
      readonly outcome: SelectedChecksCommandOutcome;
    }
  | {
      /** `${attemptId}:${revision}` of a live record that reached a terminal phase. */
      readonly type: "live-terminal";
      readonly key: string;
    }
  | { readonly type: "manual-refresh" }
  /** Bounded focus/visibility refresh while open; handled like manual-refresh. */
  | { readonly type: "focus-refresh" }
  | {
      readonly type: "dialog-open";
      readonly state: "owner-unresolved" | "owner-corrupt";
      readonly sha256: Sha256Hex;
    }
  | { readonly type: "dialog-close" };

export type SelectedChecksControlEffect =
  | {
      readonly type: "get";
      readonly gen: number;
      readonly lifecycle: string;
      readonly target: SelectedChecksTarget;
    }
  | {
      readonly type: "command";
      readonly gen: number;
      readonly lifecycle: string;
      readonly target: SelectedChecksTarget;
      readonly spec: SelectedChecksCommandSpec;
    };

export interface SelectedChecksControlResult {
  readonly state: SelectedChecksControlState;
  readonly effect: SelectedChecksControlEffect | null;
}

export function initialSelectedChecksControl(): SelectedChecksControlState {
  return {
    lifecycle: "",
    open: false,
    canRead: false,
    target: null,
    gen: 0,
    get: { gen: 0, phase: "idle", outcome: null },
    lastResult: null,
    command: null,
    resolveSeen: null,
    pendingRun: null,
    notice: null,
    refreshedLiveKey: null,
    dialog: null,
    selection: { seededFor: null, userEdited: false, ids: [] },
    lastCandidates: [],
  };
}

const targetsEqual = (a: SelectedChecksTarget, b: SelectedChecksTarget): boolean =>
  a.environmentId === b.environmentId && a.threadId === b.threadId;

/** Transient fields every authority-invalidating transition clears. */
const clearedTransients = {
  command: null,
  resolveSeen: null,
  pendingRun: null,
  notice: null,
  refreshedLiveKey: null,
  dialog: null,
} as const;

/**
 * Bumps the generation — invalidating outstanding callbacks and current get
 * authority — and requests one new-generation get only while the panel is
 * open, readable, free of an in-flight command, and targeted. Otherwise it
 * goes idle without a request; it never reports loading for a request that
 * will not run. The caller performs its own transition-specific mutations
 * first, then hands the state here.
 */
const refresh = (state: SelectedChecksControlState): SelectedChecksControlResult => {
  const gen = state.gen + 1;
  const target = state.target;
  const request = target !== null && state.open && state.canRead && state.command === null;
  const next: SelectedChecksControlState = {
    ...state,
    gen,
    get: { gen, phase: request ? "loading" : "idle", outcome: null },
  };
  if (!request || target === null) return { state: next, effect: null };
  return {
    state: next,
    effect: { type: "get", gen, lifecycle: state.lifecycle, target },
  };
};

const ownerMarkerSha = (admission: SelectedCheckAdmission): Sha256Hex | null =>
  admission.state === "owner-unresolved" || admission.state === "owner-corrupt"
    ? admission.marker.sha256
    : null;

export function reduceSelectedChecksControl(
  state: SelectedChecksControlState,
  event: SelectedChecksControlEvent,
): SelectedChecksControlResult {
  const unchanged: SelectedChecksControlResult = { state, effect: null };
  switch (event.type) {
    case "lifecycle": {
      // A repeated opaque key still transitions when readiness or target
      // changed; only a fully identical tuple is a no-op.
      const targetChanged = state.target === null || !targetsEqual(state.target, event.target);
      if (event.key === state.lifecycle && event.canRead === state.canRead && !targetChanged) {
        return unchanged;
      }
      return refresh({
        ...state,
        lifecycle: event.key,
        canRead: event.canRead,
        target: event.target,
        lastResult: targetChanged ? null : state.lastResult,
        lastCandidates: targetChanged ? [] : state.lastCandidates,
        selection: targetChanged
          ? { seededFor: null, userEdited: false, ids: [] }
          : state.selection.seededFor === null && !state.selection.userEdited
            ? state.selection
            : { ...state.selection, seededFor: event.key },
        ...clearedTransients,
      });
    }
    case "open": {
      if (state.open) return unchanged;
      const targetChanged = state.target === null || !targetsEqual(state.target, event.target);
      const lastCandidates: ReadonlyArray<string> = targetChanged ? [] : state.lastCandidates;
      let selection: SelectedChecksControlState["selection"] = targetChanged
        ? { seededFor: null, userEdited: false, ids: [] }
        : state.selection;
      if (selection.seededFor !== state.lifecycle) {
        const ids = [...new Set(event.seedIds)]
          .filter((id) => lastCandidates.includes(id))
          .slice(0, SELECTED_CHECK_MAX);
        selection = {
          seededFor: ids.length > 0 ? state.lifecycle : null,
          userEdited: false,
          ids,
        };
      }
      return refresh({
        ...state,
        open: true,
        canRead: event.canRead,
        target: event.target,
        lastResult: targetChanged ? null : state.lastResult,
        lastCandidates,
        selection,
      });
    }
    case "close": {
      if (!state.open) return unchanged;
      const gen = state.gen + 1;
      return {
        state: {
          ...state,
          open: false,
          gen,
          get: { gen, phase: "idle", outcome: null },
          ...clearedTransients,
        },
        effect: null,
      };
    }
    case "candidates-changed": {
      // Pruning never invalidates a captured command input or its generation.
      const next: SelectedChecksControlState = {
        ...state,
        lastCandidates: event.ids,
        selection: {
          ...state.selection,
          ids: state.selection.ids.filter((id) => event.ids.includes(id)),
        },
      };
      if (!state.open || state.command !== null) {
        return { state: next, effect: null };
      }
      return refresh(next);
    }
    case "toggle": {
      const selection = state.selection;
      const ids = selection.ids.includes(event.id)
        ? selection.ids.filter((id) => id !== event.id)
        : selection.ids.length >= SELECTED_CHECK_MAX || !state.lastCandidates.includes(event.id)
          ? selection.ids
          : [...selection.ids, event.id];
      if (ids === selection.ids) return unchanged;
      return {
        state: {
          ...state,
          // The first edit marks the current lifecycle seeded so a
          // close/reopen can never reseed over the user's choices.
          selection: {
            ...selection,
            ids,
            userEdited: true,
            seededFor: selection.seededFor ?? state.lifecycle,
          },
        },
        effect: null,
      };
    }
    case "get-settled": {
      if (event.gen !== state.gen || state.get.gen !== state.gen || state.get.phase !== "loading") {
        return unchanged;
      }
      let next: SelectedChecksControlState = {
        ...state,
        get: { gen: state.gen, phase: "settled", outcome: event.outcome },
      };
      if (event.outcome.kind === "ok") {
        const result = event.outcome.result;
        const record = result.record;
        next = { ...next, lastResult: result };
        if (state.pendingRun !== null) {
          const sameAttempt =
            record.kind === "present" && record.receipt.attemptId === state.pendingRun.attemptId;
          next = {
            ...next,
            pendingRun: null,
            notice: sameAttempt
              ? state.notice
              : record.kind === "present"
                ? { key: "run-superseded" }
                : { key: "run-unavailable" },
          };
        }
        if (
          state.selection.seededFor === null &&
          !state.selection.userEdited &&
          record.kind === "present"
        ) {
          const ids = [...new Set(record.receipt.planned.map((check) => check.scriptId))]
            .filter((id) => state.lastCandidates.includes(id))
            .slice(0, SELECTED_CHECK_MAX);
          next = {
            ...next,
            selection: { seededFor: state.lifecycle, userEdited: false, ids },
          };
        }
      }
      return { state: next, effect: null };
    }
    case "command-start": {
      // Internal transition only. The dispatching hook owns the mutation
      // guard: it must evaluate the synchronously derived current view
      // (canRun/canStop/canRecover, or dialogSubmit.allowed plus the
      // acknowledgement checkbox) at click time before sending this event —
      // a disabled button alone is not the guard.
      if (!state.open || state.command !== null || state.target === null) return unchanged;
      const gen = state.gen + 1;
      const spec: SelectedChecksCommandSpec =
        event.spec.kind === "run"
          ? {
              kind: "run",
              input: { ...event.spec.input, scriptIds: [...event.spec.input.scriptIds] },
            }
          : event.spec;
      return {
        state: {
          ...state,
          gen,
          notice: null,
          command: { gen, lifecycle: state.lifecycle, target: state.target, spec },
        },
        effect: {
          type: "command",
          gen,
          lifecycle: state.lifecycle,
          target: state.target,
          spec,
        },
      };
    }
    case "command-settled": {
      const command = state.command;
      if (command === null || command.gen !== event.gen || event.gen !== state.gen) {
        return unchanged;
      }
      const gen = state.gen + 1;
      let notice = state.notice;
      let pendingRun = state.pendingRun;
      let resolveSeen = state.resolveSeen;
      const outcome = event.outcome;
      switch (outcome.kind) {
        case "run-ok":
          pendingRun = { attemptId: outcome.attemptId };
          notice = null;
          break;
        case "run-rejected":
          notice = {
            key: "run-rejected",
            reason: outcome.reason,
            scriptId: outcome.scriptId ?? null,
          };
          break;
        case "thread-unavailable":
          notice = { key: "thread-unavailable" };
          break;
        case "cancel-ok":
          notice = { key: outcome.cancelled ? "cancel-requested" : "cancel-no-match" };
          break;
        case "resolve-ok":
          resolveSeen = { gen, admission: outcome.admission };
          notice = { key: "resolve-outcome", outcome: outcome.outcome };
          break;
        case "unknown":
          notice = {
            key:
              command.spec.kind === "run"
                ? "start-unconfirmed"
                : command.spec.kind === "cancel"
                  ? "cancel-unconfirmed"
                  : "resolve-unconfirmed",
          };
          break;
      }
      // refresh() bumps to this same `gen` (state.gen + 1) and issues the
      // one post-command get only while open and readable.
      return refresh({
        ...state,
        command: null,
        pendingRun,
        notice,
        resolveSeen,
      });
    }
    case "live-terminal": {
      if (!state.open || state.command !== null || event.key === state.refreshedLiveKey) {
        return unchanged;
      }
      return refresh({ ...state, refreshedLiveKey: event.key });
    }
    case "manual-refresh":
    case "focus-refresh": {
      if (!state.open || state.command !== null) return unchanged;
      return refresh(state);
    }
    case "dialog-open": {
      if (!state.open) return unchanged;
      return {
        state: {
          ...state,
          dialog: {
            gen: state.gen,
            lifecycle: state.lifecycle,
            state: event.state,
            sha256: event.sha256,
          },
        },
        effect: null,
      };
    }
    case "dialog-close": {
      if (state.dialog === null) return unchanged;
      return { state: { ...state, dialog: null }, effect: null };
    }
  }
}

export type SelectedChecksHeadline =
  | "unknown"
  | "unsupported"
  | "error"
  | "starting"
  | "running"
  | "awaiting-confirmation"
  | "none"
  | "unreadable"
  | "failed"
  | "incomplete"
  | "passed";

export interface SelectedChecksViewInput {
  readonly control: SelectedChecksControlState;
  /**
   * Newest live receipt already validated by the caller: schema-decoded,
   * `receipt.threadId` matches, activity id matches `selectedCheckReceiptId`.
   * Live data only ever hints a refresh — it never produces a verdict.
   */
  readonly live: {
    readonly receipt: SelectedCheckReceipt;
    readonly sequence: number | null;
  } | null;
  readonly permission: "allowed" | "read-only" | "unknown";
  readonly connected: boolean;
  readonly candidateIds: ReadonlyArray<string>;
  readonly latestTurnRequestedAt: string | null;
}

export interface SelectedChecksView {
  readonly open: boolean;
  readonly headline: SelectedChecksHeadline;
  /** A get accepted at the current generation exists (any outcome kind). */
  readonly hasCurrentAuthority: boolean;
  readonly getInFlight: boolean;
  readonly getError: string | null;
  /**
   * The record the panel displays, aligned with the headline owner: a newer
   * live receipt displays as "live" (no derived verdict), a current get
   * record as "current", a retained same-target result only as "previous".
   */
  readonly record: {
    readonly receipt: SelectedCheckReceipt;
    readonly sequence: number | null;
  } | null;
  readonly recordAuthority: "current" | "previous" | "live" | null;
  /** Derived record state; only set for a current record. */
  readonly derived: SelectedChecksDerivedState | null;
  readonly live: {
    readonly receipt: SelectedCheckReceipt;
    readonly sequence: number | null;
  } | null;
  readonly liveIsNewer: boolean;
  /**
   * Newest admission for display: accepted get at this generation, else the
   * current resolveSeen observation. Mutations require the get source via
   * the common gate — this field alone never authorizes them.
   */
  readonly admission: SelectedCheckAdmission | null;
  readonly capability: SelectedChecksGetResult["capability"] | null;
  readonly changedScriptIds: ReadonlyArray<string>;
  /** Accepted record data exists but is no longer current-generation. */
  readonly comparisonStale: boolean;
  readonly newerTurnAfterRecord: boolean;
  readonly selection: ReadonlyArray<string>;
  readonly pendingRunAttemptId: string | null;
  readonly commandInFlight: "run" | "cancel" | "resolve" | null;
  readonly notice: SelectedChecksNotice | null;
  /** Attempt id of the displayed running check, sent verbatim as cancel input. */
  readonly stopAttemptId: string | null;
  readonly canRun: boolean;
  readonly canStop: boolean;
  readonly canRecover: boolean;
  readonly dialog: SelectedChecksControlState["dialog"];
  /**
   * `allowed` encodes generation, lifecycle, admission-state, full-SHA,
   * permission and connection checks; the panel's acknowledgement checkbox
   * is a separate required gate on top of this value.
   */
  readonly dialogSubmit: {
    readonly allowed: boolean;
    readonly input: SelectedChecksResolveOwnershipInput;
  } | null;
}

const instantMillis = (value: unknown): number | null => {
  const instant = parseSelectedCheckInstant(value);
  return instant === null ? null : DateTime.toEpochMillis(instant);
};

export function deriveSelectedChecksView(input: SelectedChecksViewInput): SelectedChecksView {
  const s = input.control;
  const settledOutcome = s.get.phase === "settled" && s.get.gen === s.gen ? s.get.outcome : null;
  const currentGet = settledOutcome?.kind === "ok" ? settledOutcome.result : null;
  // A retained ok result only ever displays as "Previous record": once a
  // new authoritative get lands, it supersedes it entirely.
  const previousResult = currentGet === null ? s.lastResult : null;

  const resolveAdmission =
    s.resolveSeen !== null && s.resolveSeen.gen === s.gen ? s.resolveSeen.admission : null;
  const admission = currentGet?.admission ?? resolveAdmission;

  const currentRecord = currentGet?.record.kind === "present" ? currentGet.record : null;
  const previousRecord = previousResult?.record.kind === "present" ? previousResult.record : null;

  // A live record counts as newer only against a present current record (or
  // when there is no current get at all); a fresh none/malformed is final and
  // is decided before this comparison is ever consulted.
  const live = input.live;
  let liveIsNewer = false;
  if (live !== null) {
    if (currentGet === null) {
      liveIsNewer = true;
    } else if (currentGet.record.kind === "present") {
      liveIsNewer =
        live.receipt.attemptId === currentGet.record.receipt.attemptId
          ? live.receipt.revision > currentGet.record.receipt.revision
          : live.sequence === null || live.sequence > currentGet.record.sequence;
    }
  }

  let headline: SelectedChecksHeadline = "unknown";
  let derived: SelectedChecksDerivedState | null = null;
  let stopAttemptId: string | null = null;

  if (settledOutcome?.kind === "unsupported") {
    headline = "unsupported";
  } else if (settledOutcome?.kind === "error") {
    headline = "error";
  } else if (currentGet?.record.kind === "none") {
    headline = "none";
  } else if (currentGet?.record.kind === "malformed") {
    headline = "unreadable";
  } else if (s.pendingRun !== null) {
    headline = "starting";
  } else if (liveIsNewer && live !== null) {
    if (live.receipt.phase === "running") {
      headline = "running";
      stopAttemptId = live.receipt.attemptId;
    } else {
      headline = "awaiting-confirmation";
    }
  } else if (currentRecord !== null) {
    derived = deriveSelectedCheckState(currentGet!.record);
    headline = derived.state === "all-selected-passed" ? "passed" : derived.state;
    if (derived.state === "running") stopAttemptId = currentRecord.receipt.attemptId;
  }

  // The displayed record follows whichever source owns the headline: a
  // newer live receipt displays as "live" (no derived verdict), the current
  // get record as "current", a retained same-target result only as
  // "previous". A fresh none/malformed suppresses all of them.
  const displayedLive = liveIsNewer ? live : null;
  const record =
    displayedLive !== null
      ? { receipt: displayedLive.receipt, sequence: displayedLive.sequence }
      : currentRecord !== null
        ? { receipt: currentRecord.receipt, sequence: currentRecord.sequence as number | null }
        : currentGet === null && previousRecord !== null
          ? { receipt: previousRecord.receipt, sequence: previousRecord.sequence as number | null }
          : null;
  const recordAuthority =
    displayedLive !== null
      ? ("live" as const)
      : currentRecord !== null
        ? ("current" as const)
        : record !== null
          ? ("previous" as const)
          : null;

  const recordEndMs =
    record !== null && recordAuthority === "current" ? instantMillis(record.receipt.endedAt) : null;
  const turnMs = instantMillis(input.latestTurnRequestedAt);
  const newerTurnAfterRecord = recordEndMs !== null && turnMs !== null && turnMs > recordEndMs;

  // Mutations need a current successful get: a resolveSeen observation and
  // a retained previous result inform display only and never authorize a
  // command. The same gate wraps dialog submission.
  const common =
    s.open &&
    input.permission === "allowed" &&
    input.connected &&
    s.command === null &&
    currentGet !== null;
  const canRun =
    common &&
    currentGet?.capability.available === true &&
    admission?.state === "open" &&
    s.selection.ids.length >= 1 &&
    s.selection.ids.length <= SELECTED_CHECK_MAX &&
    s.selection.ids.every((id) => input.candidateIds.includes(id)) &&
    headline !== "running" &&
    s.pendingRun === null;
  const canStop = common && stopAttemptId !== null;
  const canRecover = common && admission !== null && admission.state.startsWith("owner-");

  const dialog = s.dialog;
  let dialogSubmit: SelectedChecksView["dialogSubmit"] = null;
  if (dialog !== null) {
    const admissionSha = admission === null ? null : ownerMarkerSha(admission);
    dialogSubmit = {
      allowed:
        common &&
        dialog.gen === s.gen &&
        dialog.lifecycle === s.lifecycle &&
        admission !== null &&
        admission.state === dialog.state &&
        admissionSha === dialog.sha256,
      input: { markerSha256: dialog.sha256, acknowledgeUncertainty: true },
    };
  }

  return {
    open: s.open,
    headline,
    hasCurrentAuthority: settledOutcome !== null,
    getInFlight: s.get.phase === "loading",
    getError: settledOutcome?.kind === "error" ? settledOutcome.message : null,
    record,
    recordAuthority,
    derived,
    live,
    liveIsNewer,
    admission,
    capability: currentGet?.capability ?? null,
    changedScriptIds:
      recordAuthority === "current"
        ? (currentGet?.changedScriptIds ?? [])
        : recordAuthority === "previous"
          ? (previousResult?.changedScriptIds ?? [])
          : [],
    comparisonStale: previousResult !== null,
    newerTurnAfterRecord,
    selection: s.selection.ids,
    pendingRunAttemptId: s.pendingRun?.attemptId ?? null,
    commandInFlight: s.command?.spec.kind ?? null,
    notice: s.notice,
    stopAttemptId,
    canRun,
    canStop,
    canRecover,
    dialog,
    dialogSubmit,
  };
}
