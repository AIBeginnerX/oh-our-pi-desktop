import {
  deriveTaskResultState,
  WS_METHODS,
  type EnvironmentId,
  type TaskResultAcceptInput,
  type TaskResultDerivedState,
  type TaskResultGetResult,
  type TaskResultRequirementItem,
  type TaskResultSetRequirementsInput,
  type ThreadId,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useThreadShell } from "./entities";
import type { SelectedChecksCurrentSource } from "./selectedChecks";
import { useAtomCommand } from "./use-atom-command";

const TASK_RESULT_RPC = {
  get: WS_METHODS.taskResultGet,
  setRequirements: WS_METHODS.taskResultSetRequirements,
  accept: WS_METHODS.taskResultAccept,
  withdraw: WS_METHODS.taskResultWithdraw,
} as const;

export const taskResultGet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:task-result:get",
  tag: TASK_RESULT_RPC.get,
});

export const taskResultSetRequirements = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:task-result:set-requirements",
  tag: TASK_RESULT_RPC.setRequirements,
});

export const taskResultAccept = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:task-result:accept",
  tag: TASK_RESULT_RPC.accept,
});

export const taskResultWithdraw = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:task-result:withdraw",
  tag: TASK_RESULT_RPC.withdraw,
});

export function isTaskResultMethodMissing(error: unknown): boolean {
  const tags = Object.values(TASK_RESULT_RPC);
  if (typeof error === "string" && tags.some((tag) => error === `Unknown request tag: ${tag}`)) {
    return true;
  }
  if (error instanceof Error) {
    return tags.some((tag) => error.message === `Unknown request tag: ${tag}`);
  }
  return false;
}

export interface TaskResultAuthorityBinding {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly lifecycleKey: string;
  readonly permission: "allowed" | "read-only" | "unknown";
  readonly permissionStatus: SelectedChecksCurrentSource["permissionStatus"];
  readonly confirmationAttempt: number;
  readonly recordKey: string | null;
}

export function taskResultAuthorityFromSource(
  source: SelectedChecksCurrentSource,
): TaskResultAuthorityBinding {
  return {
    environmentId: source.environmentId,
    threadId: source.threadId,
    lifecycleKey: source.lifecycleKey,
    permission: source.permission,
    permissionStatus: source.permissionStatus,
    confirmationAttempt: source.confirmationAttempt,
    recordKey: source.recordKey,
  };
}

export function sameTaskResultAuthority(
  a: TaskResultAuthorityBinding,
  b: TaskResultAuthorityBinding,
): boolean {
  return (
    a.environmentId === b.environmentId &&
    a.threadId === b.threadId &&
    a.lifecycleKey === b.lifecycleKey &&
    a.permission === b.permission &&
    a.permissionStatus === b.permissionStatus &&
    a.confirmationAttempt === b.confirmationAttempt &&
    a.recordKey === b.recordKey
  );
}

export function taskResultFetchTrigger(
  authority: TaskResultAuthorityBinding,
  recordKeyProp: string | null,
): string {
  return JSON.stringify([
    authority.environmentId,
    authority.threadId,
    authority.lifecycleKey,
    authority.permission,
    authority.permissionStatus,
    authority.confirmationAttempt,
    authority.recordKey,
    recordKeyProp ?? "",
  ]);
}

export function canIssueTaskResultRead(authority: TaskResultAuthorityBinding): boolean {
  return authority.permissionStatus === "confirmed";
}

export interface TaskResultControls {
  readonly base: {
    readonly threadId: ThreadId;
    readonly threadIncarnation: number;
    readonly expectedRevision: number | null;
  } | null;
  readonly canEdit: boolean;
  readonly canWithdraw: boolean;
  readonly accept: TaskResultAcceptInput | null;
}

export function deriveTaskResultControls(
  result: TaskResultGetResult,
  threadId: ThreadId,
  permission: "allowed" | "read-only" | "unknown",
  turnActive: boolean,
): TaskResultControls {
  const threadIncarnation = result.threadIncarnation;
  if (threadIncarnation === undefined) {
    return { base: null, canEdit: false, canWithdraw: false, accept: null };
  }

  const recordView = result.record;
  if (recordView.kind === "malformed") {
    return { base: null, canEdit: false, canWithdraw: false, accept: null };
  }

  if (recordView.kind === "present") {
    const stored = recordView.record;
    if (stored.threadId !== threadId || stored.threadIncarnation !== threadIncarnation) {
      return { base: null, canEdit: false, canWithdraw: false, accept: null };
    }
  }

  const expectedRevision = recordView.kind === "present" ? recordView.record.revision : null;
  const base = { threadId, threadIncarnation, expectedRevision };

  const derived = deriveTaskResultState(result, turnActive);
  const canMutate = permission === "allowed" && !turnActive;
  const canEdit = canMutate;
  const canWithdraw =
    canMutate && recordView.kind === "present" && recordView.record.acceptance !== null;

  let accept: TaskResultAcceptInput | null = null;
  if (
    canMutate &&
    derived.state === "awaiting-acceptance" &&
    recordView.kind === "present" &&
    recordView.record.requirements !== null
  ) {
    const checksRecord = result.checks.record;
    if (checksRecord.kind === "present") {
      accept = {
        threadId,
        threadIncarnation,
        expectedRevision: recordView.record.revision,
        requirementsVersion: recordView.record.requirements.version,
        checkAttemptId: checksRecord.receipt.attemptId,
        checkReceiptSequence: checksRecord.sequence,
      };
    }
  }

  return { base, canEdit, canWithdraw, accept };
}

const REJECTION_COPY = {
  conflict: "The record changed. Refresh and try again.",
  "write-unconfirmed": "The write could not be confirmed. Refresh before trying again.",
  "turn-active": "Wait until the agent finishes this turn.",
  "not-awaiting-acceptance": "This result is not ready to accept.",
  "requirements-invalid": "Fix the requirements before saving.",
  "script-not-found": "A bound check no longer exists.",
  "thread-unavailable": "This thread is unavailable.",
  authorization: "You do not have permission to change the task result.",
  unsupported: "Task results are not supported on this server.",
} as const;

type RejectionCopyKey = keyof typeof REJECTION_COPY;

const rejectionMessage = (key: string): string =>
  key in REJECTION_COPY ? REJECTION_COPY[key as RejectionCopyKey] : REJECTION_COPY.conflict;

const failureTag = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "_tag" in value && typeof value._tag === "string"
    ? value._tag
    : undefined;

export function noticeForMutationFailure(failure: unknown): TaskResultNotice {
  if (isTaskResultMethodMissing(failure)) {
    return { kind: "rejected", message: REJECTION_COPY["unsupported"] };
  }
  const tag = failureTag(failure);
  if (tag === "TaskResultRejectedError") {
    const rejected = failure as { reason: string; detail?: string };
    if (rejected.reason === "conflict" && rejected.detail === "write-unconfirmed") {
      return { kind: "rejected", message: REJECTION_COPY["write-unconfirmed"] };
    }
    return { kind: "rejected", message: rejectionMessage(rejected.reason) };
  }
  if (tag === "TaskResultThreadNotFoundError") {
    return { kind: "rejected", message: REJECTION_COPY["thread-unavailable"] };
  }
  if (tag === "EnvironmentAuthorizationError") {
    return { kind: "rejected", message: REJECTION_COPY.authorization };
  }
  return { kind: "rejected", message: REJECTION_COPY["write-unconfirmed"] };
}

function settleGetFailure(failure: unknown): "unsupported" | "read-failed" {
  return isTaskResultMethodMissing(failure) ? "unsupported" : "read-failed";
}

export type TaskResultNotice = { readonly kind: "rejected"; readonly message: string };

export type TaskResultHookState =
  | { readonly phase: "loading" }
  | { readonly phase: "unsupported" }
  | { readonly phase: "read-failed" }
  | { readonly phase: "stale" }
  | {
      readonly phase: "ready";
      readonly result: TaskResultGetResult;
      readonly derived: TaskResultDerivedState;
      readonly controls: TaskResultControls;
    };

type ReadySnapshot = {
  readonly authority: TaskResultAuthorityBinding;
  readonly result: TaskResultGetResult;
  readonly derived: TaskResultDerivedState;
  readonly controls: TaskResultControls;
};

type InternalRead =
  | { readonly kind: "idle" }
  | {
      readonly kind: "pending";
      readonly token: number;
      readonly authority: TaskResultAuthorityBinding;
    }
  | { readonly kind: "ready"; readonly token: number; readonly snapshot: ReadySnapshot };

type GetPhase = "unsupported" | "read-failed" | null;

export function serverRequirementItems(
  result: TaskResultGetResult,
): ReadonlyArray<TaskResultRequirementItem> {
  const record = result.record;
  if (record.kind !== "present" || record.record.requirements === null) return [];
  return record.record.requirements.items;
}

export function useTaskResult(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly readCurrentSource: () => SelectedChecksCurrentSource | null;
  readonly recordKey: string | null;
}): {
  readonly state: TaskResultHookState;
  readonly notice: TaskResultNotice | null;
  readonly busy: boolean;
  readonly draftItems: ReadonlyArray<TaskResultRequirementItem>;
  readonly draftUnsaved: boolean;
  readonly refresh: () => void;
  readonly setRequirements: (items: ReadonlyArray<TaskResultRequirementItem>) => void;
  readonly accept: () => void;
  readonly withdraw: () => void;
  readonly setDraftItems: (items: ReadonlyArray<TaskResultRequirementItem>) => void;
} {
  const { environmentId, threadId, readCurrentSource, recordKey } = input;
  const shell = useThreadShell({ environmentId, threadId });
  const turnActive = shell?.latestTurn?.state === "running";

  const get = useAtomCommand(taskResultGet, { reportFailure: false, reportDefect: false });
  const setRequirementsCommand = useAtomCommand(taskResultSetRequirements, {
    reportFailure: false,
    reportDefect: false,
  });
  const acceptCommand = useAtomCommand(taskResultAccept, {
    reportFailure: false,
    reportDefect: false,
  });
  const withdrawCommand = useAtomCommand(taskResultWithdraw, {
    reportFailure: false,
    reportDefect: false,
  });

  const tokenRef = useRef(0);
  const mountedRef = useRef(false);
  const writeLockRef = useRef(false);
  const writeBlockedRef = useRef(false);
  const reconcileScheduledRef = useRef(false);
  const readyRef = useRef<ReadySnapshot | null>(null);
  const fetchTriggerRef = useRef<string | null>(null);
  const draftDirtyRef = useRef(false);
  const draftTargetRef = useRef<{
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  } | null>(null);

  const [read, setRead] = useState<InternalRead>({ kind: "idle" });
  const [getPhase, setGetPhase] = useState<GetPhase>(null);
  const [notice, setNotice] = useState<TaskResultNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeBlocked, setWriteBlocked] = useState(false);
  const [draftItems, setDraftItemsState] = useState<ReadonlyArray<TaskResultRequirementItem>>([]);
  const [draftUnsaved, setDraftUnsaved] = useState(false);

  const draftMatchesTarget = useCallback((): boolean => {
    const target = draftTargetRef.current;
    return (
      target !== null && target.environmentId === environmentId && target.threadId === threadId
    );
  }, [environmentId, threadId]);

  const applyServerDraft = useCallback(
    (result: TaskResultGetResult, options: { readonly clearDirty: boolean }) => {
      if (!options.clearDirty && draftDirtyRef.current && draftMatchesTarget()) {
        setDraftUnsaved(true);
        return;
      }
      setDraftItemsState([...serverRequirementItems(result)]);
      draftDirtyRef.current = false;
      setDraftUnsaved(false);
    },
    [draftMatchesTarget],
  );

  const publishReady = useCallback(
    (
      token: number,
      authority: TaskResultAuthorityBinding,
      result: TaskResultGetResult,
      options: { readonly clearDirty: boolean },
    ) => {
      const derived = deriveTaskResultState(result, turnActive);
      const controls = deriveTaskResultControls(result, threadId, authority.permission, turnActive);
      const snapshot: ReadySnapshot = { authority, result, derived, controls };
      readyRef.current = snapshot;
      writeBlockedRef.current = false;
      setWriteBlocked(false);
      reconcileScheduledRef.current = false;
      setGetPhase(null);
      applyServerDraft(result, options);
      setRead({ kind: "ready", token, snapshot });
      setBusy(false);
    },
    [applyServerDraft, threadId, turnActive],
  );

  const authorityMatchesTarget = useCallback(
    (authority: TaskResultAuthorityBinding): boolean =>
      authority.environmentId === environmentId && authority.threadId === threadId,
    [environmentId, threadId],
  );

  const issueGet = useCallback(
    (authority: TaskResultAuthorityBinding, reason: "mount" | "refresh" | "reconcile") => {
      if (!canIssueTaskResultRead(authority) || !authorityMatchesTarget(authority)) return;
      const token = ++tokenRef.current;
      setRead({ kind: "pending", token, authority });
      if (reason !== "reconcile") setBusy(true);
      void get({ environmentId, input: { threadId } }).then((result) => {
        if (!mountedRef.current || tokenRef.current !== token) return;
        const src = readCurrentSource();
        if (src === null) return;
        const fresh = taskResultAuthorityFromSource(src);
        if (!authorityMatchesTarget(fresh) || !sameTaskResultAuthority(fresh, authority)) {
          return;
        }
        if (result._tag === "Success") {
          publishReady(token, authority, result.value, {
            clearDirty: reason !== "reconcile" && !draftDirtyRef.current,
          });
          return;
        }
        const phase = settleGetFailure(squashAtomCommandFailure(result));
        readyRef.current = null;
        setRead({ kind: "idle" });
        setGetPhase(phase);
        setBusy(false);
        if (reason === "reconcile") {
          writeBlockedRef.current = true;
          setWriteBlocked(true);
        }
      });
    },
    [authorityMatchesTarget, environmentId, get, publishReady, readCurrentSource, threadId],
  );

  const issueGetRef = useRef(issueGet);
  issueGetRef.current = issueGet;

  const scheduleReconcileGet = useCallback((authority: TaskResultAuthorityBinding) => {
    if (reconcileScheduledRef.current) return;
    reconcileScheduledRef.current = true;
    issueGetRef.current(authority, "reconcile");
  }, []);

  const afterUncertainWrite = useCallback(
    (authority: TaskResultAuthorityBinding) => {
      readyRef.current = null;
      writeBlockedRef.current = true;
      setWriteBlocked(true);
      setRead({ kind: "idle" });
      setBusy(false);
      const src = readCurrentSource();
      if (src === null) return;
      const fresh = taskResultAuthorityFromSource(src);
      if (authorityMatchesTarget(fresh) && sameTaskResultAuthority(fresh, authority)) {
        scheduleReconcileGet(fresh);
      }
    },
    [authorityMatchesTarget, readCurrentSource, scheduleReconcileGet],
  );

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      tokenRef.current += 1;
      fetchTriggerRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const target = draftTargetRef.current;
    if (
      target !== null &&
      (target.environmentId !== environmentId || target.threadId !== threadId)
    ) {
      draftDirtyRef.current = false;
      draftTargetRef.current = null;
      setDraftItemsState([]);
      setDraftUnsaved(false);
    }
  }, [environmentId, threadId]);

  const refresh = useCallback(() => {
    setNotice(null);
    const src = readCurrentSource();
    if (src === null) return;
    const authority = taskResultAuthorityFromSource(src);
    if (!canIssueTaskResultRead(authority) || !authorityMatchesTarget(authority)) return;
    fetchTriggerRef.current = taskResultFetchTrigger(authority, recordKey);
    issueGetRef.current(authority, "refresh");
  }, [authorityMatchesTarget, readCurrentSource, recordKey]);

  const sourceNow = readCurrentSource();
  const observedAuthority =
    sourceNow === null
      ? null
      : (() => {
          const authority = taskResultAuthorityFromSource(sourceNow);
          if (!canIssueTaskResultRead(authority) || !authorityMatchesTarget(authority)) {
            return null;
          }
          return authority;
        })();
  const observedFetchTrigger =
    observedAuthority === null ? null : taskResultFetchTrigger(observedAuthority, recordKey);
  const observedAuthorityRef = useRef(observedAuthority);
  observedAuthorityRef.current = observedAuthority;

  useLayoutEffect(() => {
    if (observedFetchTrigger === null) {
      if (fetchTriggerRef.current !== null) {
        tokenRef.current += 1;
        readyRef.current = null;
        setRead({ kind: "idle" });
        setGetPhase(null);
        setBusy(false);
        fetchTriggerRef.current = null;
      }
      return;
    }
    if (fetchTriggerRef.current === observedFetchTrigger) return;
    fetchTriggerRef.current = observedFetchTrigger;
    const authority = observedAuthorityRef.current;
    if (authority === null) return;
    issueGetRef.current(authority, "mount");
  }, [observedFetchTrigger]);

  const runMutation = useCallback(
    (
      run: (
        snapshot: ReadySnapshot,
        controls: TaskResultControls,
      ) => Promise<AtomCommandResult<TaskResultGetResult, unknown>> | null,
      options: { readonly clearDirtyOnSuccess: boolean },
    ) => {
      if (writeLockRef.current || writeBlockedRef.current) return;
      const src = readCurrentSource();
      if (src === null || src.permission !== "allowed") return;
      const authority = taskResultAuthorityFromSource(src);
      if (!authorityMatchesTarget(authority)) return;
      const snapshot = readyRef.current;
      if (snapshot === null || !sameTaskResultAuthority(snapshot.authority, authority)) {
        return;
      }
      const controls = deriveTaskResultControls(
        snapshot.result,
        threadId,
        authority.permission,
        turnActive,
      );
      if (controls.base === null) return;

      const work = run(snapshot, controls);
      if (work === null) return;

      writeLockRef.current = true;
      setBusy(true);
      setNotice(null);
      const token = ++tokenRef.current;
      const frozenAuthority = authority;

      void work.then((result) => {
        writeLockRef.current = false;
        if (!mountedRef.current || tokenRef.current !== token) return;
        const afterSrc = readCurrentSource();
        if (afterSrc === null) {
          setBusy(false);
          return;
        }
        const afterAuthority = taskResultAuthorityFromSource(afterSrc);
        if (
          !authorityMatchesTarget(afterAuthority) ||
          !sameTaskResultAuthority(afterAuthority, frozenAuthority)
        ) {
          setBusy(false);
          return;
        }
        if (result._tag === "Success") {
          publishReady(token, afterAuthority, result.value, {
            clearDirty: options.clearDirtyOnSuccess,
          });
          return;
        }
        setNotice(noticeForMutationFailure(squashAtomCommandFailure(result)));
        draftDirtyRef.current = true;
        draftTargetRef.current = { environmentId, threadId };
        setDraftUnsaved(true);
        afterUncertainWrite(afterAuthority);
      });
    },
    [
      afterUncertainWrite,
      authorityMatchesTarget,
      publishReady,
      readCurrentSource,
      threadId,
      turnActive,
    ],
  );

  const setRequirements = useCallback(
    (items: ReadonlyArray<TaskResultRequirementItem>) => {
      runMutation(
        (_, controls) => {
          if (!controls.canEdit || controls.base === null) return null;
          const base = controls.base;
          const input: TaskResultSetRequirementsInput = {
            threadId,
            threadIncarnation: base.threadIncarnation,
            expectedRevision: base.expectedRevision,
            items: [...items],
          };
          return setRequirementsCommand({ environmentId, input });
        },
        { clearDirtyOnSuccess: true },
      );
    },
    [environmentId, runMutation, setRequirementsCommand, threadId],
  );

  const accept = useCallback(() => {
    runMutation(
      (_, controls) => {
        const acceptInput = controls.accept;
        if (acceptInput === null) return null;
        return acceptCommand({ environmentId, input: acceptInput });
      },
      { clearDirtyOnSuccess: false },
    );
  }, [acceptCommand, environmentId, runMutation]);

  const withdraw = useCallback(() => {
    runMutation(
      (_, controls) => {
        if (!controls.canWithdraw || controls.base === null) return null;
        const base = controls.base;
        return withdrawCommand({
          environmentId,
          input: {
            threadId,
            threadIncarnation: base.threadIncarnation,
            expectedRevision: base.expectedRevision,
          },
        });
      },
      { clearDirtyOnSuccess: false },
    );
  }, [environmentId, runMutation, threadId, withdrawCommand]);

  const setDraftItems = useCallback(
    (items: ReadonlyArray<TaskResultRequirementItem>) => {
      draftDirtyRef.current = true;
      draftTargetRef.current = { environmentId, threadId };
      setDraftItemsState([...items]);
      setDraftUnsaved(true);
    },
    [environmentId, threadId],
  );

  const renderAuthority = observedAuthority;

  let state: TaskResultHookState;
  if (renderAuthority === null || !canIssueTaskResultRead(renderAuthority)) {
    state = { phase: "loading" };
  } else if (getPhase === "unsupported") {
    state = { phase: "unsupported" };
  } else if (getPhase === "read-failed") {
    state = { phase: "read-failed" };
  } else if (read.kind === "pending" || (read.kind === "idle" && busy)) {
    state = { phase: "loading" };
  } else if (read.kind === "ready") {
    if (!sameTaskResultAuthority(read.snapshot.authority, renderAuthority)) {
      state = { phase: "stale" };
    } else {
      const derived = deriveTaskResultState(read.snapshot.result, turnActive);
      const controls = deriveTaskResultControls(
        read.snapshot.result,
        threadId,
        renderAuthority.permission,
        turnActive,
      );
      state = {
        phase: "ready",
        result: read.snapshot.result,
        derived,
        controls: {
          ...controls,
          canEdit: controls.canEdit && !writeBlocked,
          canWithdraw: controls.canWithdraw && !writeBlocked,
          accept: writeBlocked || controls.accept === null ? null : controls.accept,
        },
      };
    }
  } else {
    state = { phase: "loading" };
  }

  return {
    state,
    notice,
    busy,
    draftItems,
    draftUnsaved,
    refresh,
    setRequirements,
    accept,
    withdraw,
    setDraftItems,
  };
}
