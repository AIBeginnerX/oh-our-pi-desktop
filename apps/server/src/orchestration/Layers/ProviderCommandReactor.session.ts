import {
  type ChatAttachment,
  type CrewThreadOverride,
  type ModelSelection,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  type ThreadId,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderCapacity } from "../../provider/Services/ProviderCapacity.ts";
import type { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import type { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { canLeadCrew, resolveCrew } from "@t3tools/shared/crew";
import {
  THREAD_GOAL_ACTIVITY,
  threadGoalNote,
  threadGoalProgress,
} from "@t3tools/shared/threadGoal";
import {
  claudeSubagentModel,
  CREW_OFF_NOTE,
  crewBrief,
  isCrewThreadTitle,
} from "../../crew/crewLogic.ts";
import type { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  isProviderDriverKind,
  toNonEmptyProviderInput,
  mapProviderSessionStatusToOrchestrationStatus,
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  type makeProviderFailureReporting,
} from "./ProviderCommandReactor.helpers.ts";

export const makeProviderSessionOperations = ({
  orchestrationEngine,
  projectionSnapshotQuery,
  providerService,
  capacity,
  providerRegistry,
  gitWorkflow,
  fileSystem,
  serverSettingsService,
  providerDiagnosticText,
  serverCommandId,
  threadModelSelections,
}: {
  readonly orchestrationEngine: OrchestrationEngineService["Service"];
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly providerService: ProviderService["Service"];
  readonly capacity: Option.Option<ProviderCapacity["Service"]>;
  readonly providerRegistry: ProviderRegistry["Service"];
  readonly gitWorkflow: GitWorkflowService["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly serverSettingsService: ServerSettingsService["Service"];
  readonly providerDiagnosticText: ReturnType<
    typeof makeProviderFailureReporting
  >["providerDiagnosticText"];
  readonly serverCommandId: ReturnType<typeof makeProviderFailureReporting>["serverCommandId"];
  readonly threadModelSelections: Map<string, ModelSelection>;
}) => {
  /** Environment settings with the thread's project overrides applied. */
  const projectSettingsForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const settings = yield* serverSettingsService.getSettings;
    if (Object.keys(settings.projectSettingsOverrides).length === 0) return settings;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return resolveProjectSettings(settings, Option.isSome(thread) ? thread.value.projectId : null)
      .settings;
  });

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    // Lazily-formatted raw detail. Judged against the memory-send ledger only
    // after the shell read, immediately before the session write.
    readonly rawDetail: () => string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    const detail = yield* providerDiagnosticText(input.threadId, input.rawDetail);
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Recreates a thread's worktree from its branch when the directory has
   * disappeared. Provider sessions resume into the persisted cwd, so a missing
   * worktree makes every later turn fail as a bogus "session not found".
   * Best-effort: on failure the turn proceeds and reports the real error.
   */
  const ensureThreadWorktree = Effect.fnUntraced(function* (thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) {
    const { worktreePath, branch } = thread;
    if (!worktreePath || !branch) {
      return;
    }
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (exists) {
      return;
    }
    const project = yield* resolveProject(thread.projectId);
    if (!project) {
      return;
    }
    const cwd = project.workspaceRoot;
    yield* Effect.logWarning("provider command reactor recreating missing worktree", {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    // A directory deleted without `git worktree remove` leaves an admin entry
    // that makes `git worktree add` refuse the path; prune clears it.
    // Best effort like the rest of this recovery: a settings read failure
    // falls back to the checkout's t3.json.
    const submodules = yield* projectSettingsForThread(thread.id).pipe(
      Effect.map((settings) => settings.worktreeSubmodules),
      Effect.orElseSucceed(() => null),
    );
    yield* gitWorkflow.pruneWorktrees({ cwd }).pipe(
      Effect.andThen(
        gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath }, { submodules }),
      ),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("provider command reactor failed to recreate worktree", {
            threadId: thread.id,
            worktreePath,
            cause: Cause.pretty(cause),
          }),
      ),
    );
  });

  const resolveThreadShell = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadDetail = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
      // First-turn prompt seed. A manual title that still equals this seed was
      // written by the client's auto-title, not a user rename.
      readonly titleSeed?: string;
      // Acknowledged session-set sequences this ensure wrote, reported back to
      // the owning preparation entry so a canceled preparation can cite the
      // exact write as its cancel anchor.
      readonly onSessionSet?: (sequence: number, session: OrchestrationSession) => void;
    },
  ) {
    const thread = yield* resolveThreadShell(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    // Sequence of the last session-set this invocation acknowledged. A failure
    // report may restore the session only against that exact write.
    let sessionSetSequence: number | null = null;
    // Dispatch and sequence capture together stay uninterruptible: an
    // acknowledged write always reaches the owner before an interrupt can
    // overtake it, so a committed anchor can never be lost.
    const setThreadSessionAndRecord = (input: Parameters<typeof setThreadSession>[0]) =>
      setThreadSession(input).pipe(
        Effect.tap((result) =>
          Effect.sync(() => options?.onSessionSet?.(result.sequence, input.session)),
        ),
        Effect.uninterruptible,
      );
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      sessionSetSequence = (yield* setThreadSessionAndRecord({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      })).sequence;
    }
    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });
    const refreshWorkspaceSnapshot = effectiveCwd
      ? providerRegistry
          .refreshWorkspaceSnapshot({ instanceId: desiredInstanceId, cwd: effectiveCwd })
          .pipe(Effect.forkDetach)
      : Effect.void;
    // OpenCode skips SessionPrompt.ensureTitle when session.create already has
    // a title. Prompt seeds and "New thread" are not user titles, so omit them
    // and let the provider generate one. A real rename is source "manual" and
    // differs from the first-turn prompt seed (the web client writes that seed
    // through thread.meta.update, which also marks the title manual).
    const manualTitle = thread.titleState?.source === "manual" ? thread.title.trim() : "";
    const promptSeed = options?.titleSeed?.trim();
    const sessionTitle =
      manualTitle.length > 0 && manualTitle !== promptSeed ? thread.title : undefined;

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      // A new process may push the machine past its live-session budget; stop idle ones first.
      (Option.isSome(capacity) ? capacity.value.makeRoom(threadId) : Effect.void).pipe(
        Effect.andThen(
          providerService
            .startSession(threadId, {
              threadId,
              ...(preferredProvider ? { provider: preferredProvider } : {}),
              providerInstanceId: desiredInstanceId,
              ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
              ...(sessionTitle ? { title: sessionTitle } : {}),
              modelSelection: desiredModelSelection,
              ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
              runtimeMode: desiredRuntimeMode,
            })
            .pipe(Effect.tap(() => refreshWorkspaceSnapshot)),
        ),
      );

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        return yield* setThreadSessionAndRecord({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        yield* refreshWorkspaceSnapshot;
        return { sessionSetSequence };
      }

      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      sessionSetSequence = (yield* bindSessionToThread(restartedSession)).sequence;
      return { sessionSetSequence };
    }

    const startedSession = yield* startProviderSession(undefined);
    sessionSetSequence = (yield* bindSessionToThread(startedSession)).sequence;
    return { sessionSetSequence };
  });

  // A lead session keeps the crew note in its conversation, so the note is sent again only when
  // the crew changes or a new provider session starts.
  const sentCrewBriefs = new Map<ThreadId, string>();
  // The open thread goal travels the same way.
  const sentGoalNotes = new Map<ThreadId, string>();

  /**
   * The OOP Crew note for a lead turn, or null when the crew is off or the brain cannot reach it;
   * undefined when that could not be worked out, so nothing about the note changes.
   */
  const crewBriefFor = (thread: {
    readonly id: ThreadId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly crew?: CrewThreadOverride | null | undefined;
  }) =>
    Effect.gen(function* () {
      if (isCrewThreadTitle(thread.title)) return null;
      const settings = yield* serverSettingsService.getSettings;
      const providers = yield* providerRegistry.getProviders;
      const brainDriver = providers.find(
        (provider) => provider.instanceId === thread.modelSelection.instanceId,
      )?.driver;
      // A snapshot without the thread's instance cannot say whether the crew applies, so leave the
      // note and its sent state as they are.
      if (brainDriver === undefined) return undefined;
      if (!canLeadCrew(brainDriver)) return null;
      const crew = resolveCrew({
        settings: settings.crew,
        override: thread.crew,
        providers,
        brain: thread.modelSelection,
      });
      if (!crew.enabled) return null;
      // Roles on the brain's own Claude instance run as in-process subagents (the fast path).
      const route = (option: (typeof crew.roles)["worker"]) =>
        option === null
          ? null
          : {
              label: option.label,
              providerLabel: option.providerLabel,
              native:
                brainDriver === "claudeAgent" &&
                option.selection.instanceId === thread.modelSelection.instanceId
                  ? (claudeSubagentModel(option.selection.model) ?? undefined)
                  : undefined,
            };
      return crewBrief({
        worker: route(crew.roles.worker),
        expert: route(crew.roles.expert),
        auditor: route(crew.roles.auditor),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("crew brief skipped", { cause }).pipe(Effect.as(undefined)),
      ),
    );

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
    readonly titleSeed?: string;
    readonly onSessionSet?: (sequence: number, session: OrchestrationSession) => void;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    const { sessionSetSequence } = yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.titleSeed !== undefined ? { titleSeed: input.titleSeed } : {}),
      ...(input.onSessionSet !== undefined ? { onSessionSet: input.onSessionSet } : {}),
      pendingTurnStart: true,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const brief = yield* crewBriefFor({
      id: thread.id,
      title: thread.title,
      modelSelection: input.modelSelection ?? thread.modelSelection,
      crew: thread.crew,
    });
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionPrefix = `${activeSession?.createdAt ?? ""}\n`;
    const briefKey = brief === null || brief === undefined ? null : `${sessionPrefix}${brief}`;
    const freshBrief =
      briefKey !== null && sentCrewBriefs.get(input.threadId) !== briefKey ? (brief ?? null) : null;
    // The earlier note stays in this session's conversation, so tell the model once it is void.
    const crewOffNote =
      brief === null && sentCrewBriefs.get(input.threadId)?.startsWith(sessionPrefix) === true
        ? CREW_OFF_NOTE
        : null;
    // Recorded only once sendTurn succeeds: a Stop, hold, or start failure
    // before that must leave the brief undelivered so the next turn carries it.
    const commitCrewBrief = () => {
      if (brief === undefined) return;
      if (briefKey === null) sentCrewBriefs.delete(input.threadId);
      else sentCrewBriefs.set(input.threadId, briefKey);
    };
    const goal = (yield* serverSettingsService.getSettings).threadGoals[input.threadId];
    const goalOpen =
      goal !== undefined &&
      goal.active &&
      threadGoalProgress(
        goal,
        Option.match(
          yield* projectionSnapshotQuery.getThreadDetailById(input.threadId, {
            activityKinds: Object.values(THREAD_GOAL_ACTIVITY),
          }),
          { onNone: () => [], onSome: (detail) => detail.activities },
        ),
      ).status === "working";
    const goalKey = goalOpen ? `${activeSession?.createdAt ?? ""}\n${goal.id}` : null;
    const freshGoalNote =
      goalOpen && sentGoalNotes.get(input.threadId) !== goalKey ? threadGoalNote(goal) : null;
    if (goalKey === null) sentGoalNotes.delete(input.threadId);
    else sentGoalNotes.set(input.threadId, goalKey);
    const normalizedInput = toNonEmptyProviderInput(
      [freshBrief, freshGoalNote, crewOffNote, input.messageText]
        .filter((part) => part !== null)
        .join("\n\n"),
    );
    const normalizedAttachments = input.attachments ?? [];
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      request: {
        threadId: input.threadId,
        ...(normalizedInput ? { input: normalizedInput } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      },
      // The actual session instance that admitted turns are bound to; the L1′
      // instance hint is only an early rejection, never proof of this value.
      activeInstanceId: activeSession?.providerInstanceId,
      commitCrewBrief,
      // This ensure's own last session-set; the only write a failure report may restore.
      sessionSetSequence,
    };
  });

  return {
    projectSettingsForThread,
    resolveProject,
    ensureThreadWorktree,
    resolveThreadShell,
    resolveThreadDetail,
    ensureSessionForThread,
    buildSendTurnRequestForThread,
    setThreadSession,
    setThreadSessionErrorOnTurnStartFailure,
  };
};
