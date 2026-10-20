import {
  AuthOrchestrationOperateScope,
  ComposerContextId,
  PROJECT_SKILL_LIST_LIMIT,
  type AuthSessionState,
  type EnvironmentId,
  type MessageId,
  type ProjectSkillDetail,
  type ProjectSkillId,
  SELECTED_CHECK_MAX,
  type ProjectScript,
  type ProjectSkillSummary,
  type ProjectSkillVersionRef,
  type ProjectSkillVersionView,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionCatalogEntry,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { useContext, useEffect, useMemo, useRef, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { newMessageId, randomUUID } from "../../lib/utils";
import { readThreadShell } from "../../state/entities";
import { environmentProjects } from "../../state/projects";
import { projectSkills } from "../../state/projectSkills";
import { useEnvironmentQuery } from "../../state/query";
import {
  selectedChecksSessionConfirmation,
  type SelectedChecksConfirmationOutcome,
} from "../../state/selectedChecks";
import { environmentSession } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjectMemoryOperateAccess } from "../settings/ProjectMemorySection";
import { sameProjectSkillVersionRef } from "../settings/ProjectSkillsSection.logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  activeVersionRefFromDetail,
  buildTrialSendDraft,
  projectSkillSendCapabilityOf,
  TRIAL_ACCESS_PENDING_COPY,
  TRIAL_AUTHORIZATION_COPY,
  TRIAL_CANCEL_LABEL,
  TRIAL_CONFIRM_FAILED_COPY,
  TRIAL_DIALOG_NOTICE,
  TRIAL_DIALOG_TITLE,
  TRIAL_DETAIL_FAILED_COPY,
  TRIAL_DETAIL_PENDING_COPY,
  TRIAL_LIST_EMPTY_COPY,
  TRIAL_LIST_FAILED_COPY,
  TRIAL_SKILL_LABEL,
  TRIAL_SUBMIT_LABEL,
  TRIAL_TASK_INVALID_COPY,
  TRIAL_TASK_LABEL,
  TRIAL_VERSION_LABEL,
  type ProjectSkillSendMode,
  trialScopeKey,
  trialScopeProblem,
  freezeSelectedScriptIds,
  freezeUseScriptBindings,
  type FrozenUseScriptBinding,
  USE_ACCEPTED_TOAST,
  USE_AUTHORIZATION_COPY,
  USE_DIALOG_NOTICE,
  USE_DIALOG_TITLE,
  USE_SCRIPTS_CHANGED_COPY,
  USE_SCRIPTS_INVALID_COPY,
  USE_SCRIPTS_LABEL,
  USE_SUBMIT_LABEL,
  USE_UNSUPPORTED_COPY,
  USE_VERSION_GONE_COPY,
  classifyTrialSendFailure,
  trialSendFailureCopy,
  trialSendStillCurrent,
  TRIAL_ACCEPTED_TOAST,
  TRIAL_REFRESH_DATA_LABEL,
  TRIAL_SEND_UNCONFIRMED_COPY,
  TRIAL_UNSUPPORTED_COPY,
  TRIAL_THREAD_UNAVAILABLE_COPY,
  TRIAL_VERSION_GONE_COPY,
  type FrozenTrialScope,
  type TrialFreshObservations,
  type TrialSendRequestIdentity,
} from "./ProjectSkillTrialDialog.logic";
import type { Atom } from "effect/unstable/reactivity";

/** Fresh capability read for action boundaries — a rendered boolean is not. */
function readSendCapability(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  mode: ProjectSkillSendMode,
): boolean {
  return projectSkillSendCapabilityOf(
    registry.get(serverEnvironment.configValueAtom(environmentId)),
    mode,
  );
}

/** Registry-fresh resolved scripts — same inputs as selected-checks `readObserved`. */
function readResolvedProjectScripts(
  registry: AtomRegistry.AtomRegistry,
  scope: FrozenTrialScope,
): ReadonlyArray<ProjectScript> {
  const shell = readThreadShell(scopeThreadRef(scope.environmentId, scope.threadId));
  if (shell === null || shell.projectId !== scope.projectId) return [];
  const project = registry.get(
    environmentProjects.projectAtom({
      environmentId: scope.environmentId,
      projectId: scope.projectId,
    }),
  );
  if (project === null) return [];
  const settings = registry.get(serverEnvironment.settingsValueAtom(scope.environmentId));
  if (settings === null) return [];
  return [...resolveProjectScripts(settings, project)];
}

function buildScopeScriptGuard(
  mode: ProjectSkillSendMode,
  frozenScriptBindings: ReadonlyArray<FrozenUseScriptBinding> | null | undefined,
  scripts: ReadonlyArray<ProjectScript> | undefined,
): Pick<Parameters<typeof trialScopeProblem>[0], "frozenScriptBindings" | "scripts"> {
  if (
    mode !== "use" ||
    frozenScriptBindings === null ||
    frozenScriptBindings === undefined ||
    scripts === undefined
  ) {
    return {};
  }
  return { frozenScriptBindings, scripts };
}

interface ConnectionStamp {
  readonly entry: ConnectionCatalogEntry;
  readonly generation: number;
  readonly prepared: PreparedConnection;
}

/** The exact connection identity a trial send confirms against. */
function readConnectionStamp(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): ConnectionStamp | null {
  const entry =
    registry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId) ?? null;
  const connection = Option.getOrElse(
    AsyncResult.value(registry.get(environmentCatalog.stateAtom(environmentId))),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const prepared = Option.getOrNull(
    registry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  if (entry === null || connection.phase !== "connected" || prepared === null) return null;
  return { entry, generation: connection.generation, prepared };
}

function sessionHasOperateScope(session: AuthSessionState): boolean {
  return (
    session.authenticated === true &&
    session.scopes !== undefined &&
    session.scopes.includes(AuthOrchestrationOperateScope)
  );
}

/**
 * Per-dialog synchronous send lock. `submitting` state alone lets two
 * handlers run before React commits; `begin` returns one invocation id or
 * null, and late results must confirm both mounted status and invocation
 * identity via `isCurrent` before touching state.
 */
function useTrialSubmitLock() {
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);
  const busyRef = useRef(false);
  const seqRef = useRef(0);
  const begin = () => {
    if (busyRef.current) return null;
    busyRef.current = true;
    return ++seqRef.current;
  };
  const end = (invocation: number) => {
    if (seqRef.current === invocation) busyRef.current = false;
  };
  const isCurrent = (invocation: number) => liveRef.current && seqRef.current === invocation;
  return { begin, end, isCurrent };
}

/**
 * One trial send against an exact candidate version in one existing thread.
 * The scope (environment, project, thread) is frozen by the opener and the
 * dialog remounts clean when it changes; the selected version is frozen as a
 * full ref, so a detail refresh that renumbers or rehashes it never silently
 * moves the send onto another version.
 */
export type { FrozenTrialScope } from "./ProjectSkillTrialDialog.logic";
export { trialScopeKey } from "./ProjectSkillTrialDialog.logic";

export function ProjectSkillTrialDialog({
  scope,
  mode = "trial",
  onClose,
}: {
  readonly scope: FrozenTrialScope;
  readonly mode?: ProjectSkillSendMode;
  readonly onClose: () => void;
}) {
  const dialogKey = `${trialScopeKey(scope)}:${mode}`;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <ProjectSkillTrialInner key={dialogKey} scope={scope} mode={mode} onClose={onClose} />
      </DialogPopup>
    </Dialog>
  );
}

function ProjectSkillTrialInner({
  scope,
  mode,
  onClose,
}: {
  readonly scope: FrozenTrialScope;
  readonly mode: ProjectSkillSendMode;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, {
    reportFailure: false,
    reportDefect: false,
  });
  const confirmSession = useAtomCommand(selectedChecksSessionConfirmation, {
    reportFailure: false,
    reportDefect: false,
  });
  const operateAccess = useProjectMemoryOperateAccess(scope.environmentId);
  const configValue = useAtomValue(serverEnvironment.configValueAtom(scope.environmentId));
  const projectRecord = useAtomValue(
    environmentProjects.projectAtom({
      environmentId: scope.environmentId,
      projectId: scope.projectId,
    }),
  );
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(scope.environmentId));
  const resolvedScripts = useMemo((): ReadonlyArray<ProjectScript> => {
    if (projectRecord === null || settings === null) return [];
    return [...resolveProjectScripts(settings, projectRecord)];
  }, [projectRecord, settings]);
  const lock = useTrialSubmitLock();

  const listAtom = projectSkills.list({
    environmentId: scope.environmentId,
    input: { projectId: scope.projectId, limit: PROJECT_SKILL_LIST_LIMIT.default },
  });
  const list = useEnvironmentQuery(listAtom);
  const items: ReadonlyArray<ProjectSkillSummary> = list.data?.items ?? [];

  // The skill and the exact version are frozen client state; refreshing the
  // detail re-resolves the same ref and never substitutes a newer version.
  const [skillId, setSkillId] = useState<ProjectSkillId | null>(null);
  const [frozenRef, setFrozenRef] = useState<ProjectSkillVersionRef | null>(null);
  const [task, setTask] = useState("");
  const [selectedScriptIds, setSelectedScriptIds] = useState<ReadonlyArray<string>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when startTurn was invoked; blocks a second ordinary send for this attempt. */
  const [uncertainAttemptId, setUncertainAttemptId] = useState<MessageId | null>(null);

  const selectedSummary = items.find((item) => item.ref.skillId === skillId) ?? null;
  const effectiveSkillId = selectedSummary?.ref.skillId ?? null;
  const detailAtom =
    effectiveSkillId !== null
      ? projectSkills.get({
          environmentId: scope.environmentId,
          input: { projectId: scope.projectId, skillId: effectiveSkillId },
        })
      : null;
  const detail = useEnvironmentQuery(detailAtom);

  useEffect(() => {
    if (skillId === null && items.length > 0) setSkillId(items[0]!.ref.skillId);
  }, [skillId, items]);

  useEffect(() => {
    if (frozenRef !== null) return;
    const summary = selectedSummary;
    const fresh = detail.data;
    if (summary === null || fresh === null) return;
    if (fresh.projectId !== scope.projectId || fresh.skillId !== summary.ref.skillId) return;
    if (mode === "use") {
      const activeRef = activeVersionRefFromDetail(fresh);
      if (activeRef === null || activeRef.skillId !== summary.ref.skillId) return;
      setFrozenRef(activeRef);
      return;
    }
    if (!fresh.versions.some((view) => sameProjectSkillVersionRef(view.version.ref, summary.ref))) {
      return;
    }
    setFrozenRef(summary.ref);
  }, [frozenRef, selectedSummary, detail.data, scope.projectId, mode]);

  /** Registry-fresh settled detail; stale success during refresh/failure is ignored. */
  const readSettledDetail = (
    atom: Atom.Atom<AsyncResult.AsyncResult<ProjectSkillDetail, unknown>> | null,
  ): ProjectSkillDetail | null => {
    if (atom === null) return null;
    const result = registry.get(atom);
    if (result._tag !== "Success" || result.waiting) return null;
    const value = result.value;
    return value.projectId === scope.projectId && value.skillId === effectiveSkillId ? value : null;
  };

  const refreshTrialData = () => {
    list.refresh();
    detail.refresh();
  };

  const readObservations = (): TrialFreshObservations => ({
    capability: readSendCapability(registry, scope.environmentId, mode),
    shell: readThreadShell(scopeThreadRef(scope.environmentId, scope.threadId)),
    detail: readSettledDetail(detailAtom),
  });

  const frozenView = (): ProjectSkillVersionView | null => {
    if (frozenRef === null || detail.data === null) return null;
    return (
      detail.data.versions.find((view) =>
        sameProjectSkillVersionRef(view.version.ref, frozenRef),
      ) ?? null
    );
  };

  const selectSkill = (value: string) => {
    setFrozenRef(null);
    setSkillId(value as ProjectSkillId);
  };

  const selectVersion = (value: string) => {
    const fresh = detail.data;
    if (fresh === null) return;
    const view = fresh.versions.find((entry) => String(entry.version.ref.version) === value);
    if (view === undefined) return;
    if (mode === "use" && view.version.state !== "active") return;
    setFrozenRef(view.version.ref);
  };

  const toggleScript = (scriptId: string) => {
    setSelectedScriptIds((current) => {
      if (current.includes(scriptId)) return current.filter((id) => id !== scriptId);
      if (current.length >= SELECTED_CHECK_MAX) return current;
      return [...current, scriptId];
    });
  };

  /** The reactive display gate; the submit path re-reads everything fresh. */
  const unsupportedCopy = mode === "use" ? USE_UNSUPPORTED_COPY : TRIAL_UNSUPPORTED_COPY;
  const authorizationCopy = mode === "use" ? USE_AUTHORIZATION_COPY : TRIAL_AUTHORIZATION_COPY;
  const dialogTitle = mode === "use" ? USE_DIALOG_TITLE : TRIAL_DIALOG_TITLE;
  const dialogNotice = mode === "use" ? USE_DIALOG_NOTICE : TRIAL_DIALOG_NOTICE;
  const submitLabel = mode === "use" ? USE_SUBMIT_LABEL : TRIAL_SUBMIT_LABEL;
  const acceptedToast = mode === "use" ? USE_ACCEPTED_TOAST : TRIAL_ACCEPTED_TOAST;
  const gate = (): string | null => {
    if (!projectSkillSendCapabilityOf(configValue, mode)) return unsupportedCopy;
    if (operateAccess === "pending") return TRIAL_ACCESS_PENDING_COPY;
    if (operateAccess === "denied") return authorizationCopy;
    if (list.error !== null) return TRIAL_LIST_FAILED_COPY;
    if (items.length === 0 && !list.isPending) return TRIAL_LIST_EMPTY_COPY;
    if (selectedSummary === null) return TRIAL_DETAIL_PENDING_COPY;
    if (detail.error !== null) return TRIAL_DETAIL_FAILED_COPY;
    if (detail.isPending || detail.data === null) return TRIAL_DETAIL_PENDING_COPY;
    if (frozenRef === null || frozenView() === null) return TRIAL_DETAIL_PENDING_COPY;
    if (mode === "use" && freezeSelectedScriptIds(selectedScriptIds) === null) {
      return USE_SCRIPTS_INVALID_COPY;
    }
    if (task.trim() === "") return TRIAL_TASK_INVALID_COPY;
    return null;
  };

  const versionRows =
    mode === "use"
      ? (detail.data?.versions ?? []).filter((view) => view.version.state === "active")
      : (detail.data?.versions ?? []);

  const submit = async () => {
    if (submitting || frozenRef === null || uncertainAttemptId !== null) return;
    const invocation = lock.begin();
    if (invocation === null) return;
    setSubmitting(true);
    setError(null);
    const scriptsNow = mode === "use" ? readResolvedProjectScripts(registry, scope) : undefined;
    const frozenScriptBindings =
      scriptsNow !== undefined ? freezeUseScriptBindings(selectedScriptIds, scriptsNow) : undefined;
    if (frozenScriptBindings === null) {
      setError(USE_SCRIPTS_INVALID_COPY);
      lock.end(invocation);
      setSubmitting(false);
      return;
    }
    const frozenScriptIds = frozenScriptBindings?.map((row) => row.id);
    const scriptGuard = buildScopeScriptGuard(mode, frozenScriptBindings, scriptsNow);
    try {
      // The button gate again, registry-fresh: capability, live thread in the
      // frozen project, and the frozen ref against a settled fresh detail.
      const pre = trialScopeProblem({
        mode,
        observations: readObservations(),
        scope,
        frozenRef,
        ...scriptGuard,
      });
      if (pre !== null) {
        setError(pre);
        return;
      }
      // The accepted fresh-confirmation pattern: capture the exact connection
      // identity, let the command re-verify it around a direct session fetch,
      // and require the operate scope before anything is sent.
      const stamp = readConnectionStamp(registry, scope.environmentId);
      if (stamp === null) {
        setError(TRIAL_CONFIRM_FAILED_COPY);
        return;
      }
      const shellBeforeConfirm = readThreadShell(
        scopeThreadRef(scope.environmentId, scope.threadId),
      );
      if (shellBeforeConfirm === null || shellBeforeConfirm.projectId !== scope.projectId) {
        setError(TRIAL_THREAD_UNAVAILABLE_COPY);
        return;
      }
      const boundShellCreatedAt = shellBeforeConfirm.createdAt;
      let confirmed: AtomCommandResult<SelectedChecksConfirmationOutcome, unknown>;
      try {
        confirmed = await confirmSession({
          environmentId: scope.environmentId,
          input: { generation: stamp.generation, prepared: stamp.prepared, entry: stamp.entry },
        });
      } catch {
        if (!lock.isCurrent(invocation)) return;
        setError(TRIAL_CONFIRM_FAILED_COPY);
        return;
      }
      if (!lock.isCurrent(invocation)) return;
      if (confirmed._tag === "Failure") {
        setError(TRIAL_CONFIRM_FAILED_COPY);
        return;
      }
      if (
        confirmed._tag !== "Success" ||
        confirmed.value.kind !== "confirmed" ||
        confirmed.value.session === undefined ||
        !sessionHasOperateScope(confirmed.value.session)
      ) {
        setError(authorizationCopy);
        return;
      }
      // Post-confirmation guard, in this same synchronous continuation: the
      // confirmed identity must still be current, and every observation is
      // re-read fresh immediately before invocation.
      const now = readConnectionStamp(registry, scope.environmentId);
      if (
        now === null ||
        now.entry !== stamp.entry ||
        now.prepared !== stamp.prepared ||
        now.generation !== stamp.generation
      ) {
        setError(TRIAL_CONFIRM_FAILED_COPY);
        return;
      }
      const scriptsAfterConfirm =
        mode === "use" ? readResolvedProjectScripts(registry, scope) : undefined;
      const scriptGuardAfterConfirm = buildScopeScriptGuard(
        mode,
        frozenScriptBindings,
        scriptsAfterConfirm,
      );
      const final = trialScopeProblem({
        mode,
        observations: readObservations(),
        scope,
        frozenRef,
        boundShellCreatedAt,
        ...scriptGuardAfterConfirm,
      });
      if (final !== null) {
        setError(final);
        return;
      }
      const fresh = readSettledDetail(detailAtom);
      const view =
        fresh?.versions.find((entry) => sameProjectSkillVersionRef(entry.version.ref, frozenRef)) ??
        null;
      const shell = readThreadShell(scopeThreadRef(scope.environmentId, scope.threadId));
      if (
        view === null ||
        shell === null ||
        shell.projectId !== scope.projectId ||
        shell.createdAt !== boundShellCreatedAt
      ) {
        setError(
          shell === null || shell.createdAt !== boundShellCreatedAt
            ? TRIAL_THREAD_UNAVAILABLE_COPY
            : mode === "use"
              ? USE_VERSION_GONE_COPY
              : TRIAL_VERSION_GONE_COPY,
        );
        return;
      }
      const messageId = newMessageId();
      const requestIdentity: TrialSendRequestIdentity = {
        stamp: { entry: stamp.entry, prepared: stamp.prepared, generation: stamp.generation },
        scope,
        frozenRef,
        shellCreatedAt: boundShellCreatedAt,
        messageId,
      };
      const draft = buildTrialSendDraft({
        ref: frozenRef,
        content: view.version.content,
        task,
        mode,
        ...(frozenScriptIds !== undefined ? { selectedScriptIds: frozenScriptIds } : {}),
        contextId: ComposerContextId.make(`project-skill_${randomUUID()}`),
      });
      if (draft === null) {
        setError(TRIAL_TASK_INVALID_COPY);
        return;
      }
      setUncertainAttemptId(messageId);
      let outcome: AtomCommandResult<unknown, unknown>;
      try {
        outcome = await startTurn({
          environmentId: scope.environmentId,
          input: {
            threadId: scope.threadId,
            message: {
              messageId,
              role: "user",
              text: draft.text,
              attachments: [],
              context: draft.context,
            },
            modelSelection: shell.modelSelection,
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
            createdAt: new Date().toISOString(),
          },
        });
      } catch {
        if (!lock.isCurrent(invocation)) return;
        setError(TRIAL_SEND_UNCONFIRMED_COPY);
        return;
      }
      if (!lock.isCurrent(invocation)) return;
      const postStamp = readConnectionStamp(registry, scope.environmentId);
      const postObservations = readObservations();
      const scriptsAfterSend =
        mode === "use" ? readResolvedProjectScripts(registry, scope) : undefined;
      const scriptGuardAfterSend = buildScopeScriptGuard(
        mode,
        frozenScriptBindings,
        scriptsAfterSend,
      );
      if (
        !trialSendStillCurrent({
          mode,
          identity: requestIdentity,
          stamp: postStamp,
          observations: postObservations,
          frozenRef,
          ...scriptGuardAfterSend,
        })
      ) {
        return;
      }
      if (outcome._tag === "Success") {
        setUncertainAttemptId(null);
        toastManager.add({ type: "success", title: acceptedToast });
        onClose();
        return;
      }
      if (isAtomCommandInterrupted(outcome)) {
        setError(TRIAL_SEND_UNCONFIRMED_COPY);
        return;
      }
      const failureKind = classifyTrialSendFailure(squashAtomCommandFailure(outcome));
      if (failureKind === "authorization") setUncertainAttemptId(null);
      setError(trialSendFailureCopy(failureKind));
    } finally {
      lock.end(invocation);
      if (lock.isCurrent(invocation)) setSubmitting(false);
    }
  };

  const versionSelected =
    frozenRef !== null &&
    detail.data !== null &&
    detail.data.versions.some((view) => sameProjectSkillVersionRef(view.version.ref, frozenRef));
  const versionValue = versionSelected && frozenRef !== null ? String(frozenRef.version) : "";
  const problem = uncertainAttemptId !== null ? TRIAL_SEND_UNCONFIRMED_COPY : gate();
  const showRefresh =
    problem === TRIAL_DETAIL_FAILED_COPY ||
    problem === TRIAL_LIST_FAILED_COPY ||
    error === TRIAL_VERSION_GONE_COPY ||
    error === USE_VERSION_GONE_COPY ||
    error === USE_SCRIPTS_CHANGED_COPY ||
    error === TRIAL_DETAIL_FAILED_COPY;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{dialogTitle}</DialogTitle>
        <DialogDescription>{dialogNotice}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <label className="grid gap-1 text-sm">
          {TRIAL_SKILL_LABEL}
          <select
            aria-label={TRIAL_SKILL_LABEL}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            value={skillId ?? ""}
            disabled={submitting}
            onChange={(event) => selectSkill(event.currentTarget.value)}
          >
            {items.map((item) => (
              <option key={item.ref.skillId} value={item.ref.skillId}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          {TRIAL_VERSION_LABEL}
          <select
            aria-label={TRIAL_VERSION_LABEL}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            value={versionValue}
            disabled={submitting || detail.data === null}
            onChange={(event) => selectVersion(event.currentTarget.value)}
          >
            {versionSelected ? null : <option value="">—</option>}
            {versionRows.map((view) => (
              <option key={view.version.ref.version} value={String(view.version.ref.version)}>
                v{view.version.ref.version} · {view.version.ref.contentSha256.slice(0, 16)}…
              </option>
            ))}
          </select>
        </label>
        {mode === "use" ? (
          <div className="grid gap-2 text-sm">
            <p>{USE_SCRIPTS_LABEL}</p>
            {resolvedScripts.length === 0 ? (
              <p className="text-xs text-muted-foreground">이 프로젝트에 스크립트가 없습니다.</p>
            ) : (
              resolvedScripts.map((script) => {
                const checked = selectedScriptIds.includes(script.id);
                const atMax = selectedScriptIds.length >= SELECTED_CHECK_MAX;
                return (
                  <label key={script.id} className="flex items-center gap-2">
                    <Checkbox
                      checked={checked}
                      disabled={submitting || (!checked && atMax)}
                      onCheckedChange={() => toggleScript(script.id)}
                    />
                    <span>{script.name}</span>
                  </label>
                );
              })
            )}
          </div>
        ) : null}
        {frozenRef !== null ? (
          <p className="text-xs text-muted-foreground">
            선택한 버전: v{frozenRef.version} · {frozenRef.contentSha256.slice(0, 16)}…
          </p>
        ) : null}
        <label className="grid gap-1 text-sm">
          {TRIAL_TASK_LABEL}
          <Textarea
            aria-label={TRIAL_TASK_LABEL}
            rows={4}
            value={task}
            disabled={submitting}
            onChange={(event) => setTask(event.currentTarget.value)}
          />
        </label>
        {problem !== null ? (
          <p className="text-sm text-muted-foreground" role="status">
            {problem}
          </p>
        ) : null}
        {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
        {showRefresh ? (
          <Button size="sm" variant="outline" disabled={submitting} onClick={refreshTrialData}>
            {TRIAL_REFRESH_DATA_LABEL}
          </Button>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" disabled={submitting} onClick={onClose}>
          {TRIAL_CANCEL_LABEL}
        </Button>
        <Button
          size="sm"
          disabled={submitting || problem !== null || uncertainAttemptId !== null}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
