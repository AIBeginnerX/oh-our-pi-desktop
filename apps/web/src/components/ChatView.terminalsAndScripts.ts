import { useLoadBalancedEnvironment } from "../hooks/useLoadBalancedEnvironment";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { decideStop } from "./chat/stopBackgroundAgents.logic";
import {
  type EnvironmentId,
  type ProjectScript,
  type ProjectId,
  ProviderInstanceId,
  type ScopedThreadRef,
  type ThreadId,
  type ThreadLinkedPullRequest,
  type KeybindingCommand,
  ProviderInteractionMode,
  RuntimeMode,
  TerminalOpenInput,
} from "@t3tools/contracts";
import { type CodexArtifactTemplate } from "@t3tools/client-runtime/codex-artifact-templates";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { isElectron } from "../env";
import { useDiffPanelStore } from "../diffPanelStore";
import { useWorkspaceMutationRefresh } from "../hooks/useWorkspaceMutationRefresh";
import { DEFAULT_THREAD_TERMINAL_ID, MAX_TERMINALS_PER_GROUP } from "../types";
import { subscribeSnapShotComposerFocus } from "../lib/desktopSnapShot";
import { useRightPanelStore } from "../rightPanelStore";
import { BrowserSettingsReadError } from "../browser/openFileInPreview";
import { addBrowserSurface } from "./preview/addBrowserSurface";
import { usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
import { useDeviceState } from "~/state/device";
import { shortcutLabelForCommand } from "../keybindings";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import { buildProjectScript, commandForProjectScript, nextProjectScriptId } from "~/projectScripts";
import { useClientSettings } from "../hooks/useSettings";
import { type TerminalContextSelection } from "../lib/terminalContext";
import { type QueuedComposerMessage, useQueuedMessageStore } from "../queuedMessageStore";
import { useEnvironmentQuery } from "../state/query";
import { primaryServerAvailableEditorsAtom, primaryServerKeybindingsAtom } from "../state/server";
import { vcsEnvironment } from "../state/vcs";
import { shouldShowComposerContextStrip } from "./BranchToolbar.logic";
import {
  getProviderStatusBannerKey,
  shouldShowProviderStatusBanner,
} from "./chat/ProviderStatusBanner";
import {
  hasAvailableCompactionProvider,
  hasDismissedResumeCompaction,
} from "./chat/ContextWindowMeter.logic";
import {
  buildRunningThreadTurnInterruptInput,
  recallCheckoutIsRepo,
  rememberCheckoutIsRepo,
  resolveDraftHeroState,
  peekHeldThreadTimeline,
  rememberReadyThreadTimeline,
  timelineHasEphemeralPreviewUrls,
  shouldWriteThreadErrorToCurrentServerThread,
  codexArtifactTemplatePromptToAppend,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { sanitizeThreadErrorMessage } from "~/rpc/transportError";
import {
  selectAutoShowFloatingPreview,
  SCRIPT_TERMINAL_COLS,
  SCRIPT_TERMINAL_ROWS,
  LocalThreadErrorEntry,
} from "./ChatView.helpers";
import { useDraftHeroLayoutTransition } from "./ChatView.localHooks";
import type { useChatViewThreadState } from "./ChatView.threadState";
import type { useChatViewProjectAndEnvironment } from "./ChatView.projectEnvironment";
import type { useChatViewTimelineData } from "./ChatView.timelineData";

export function useChatViewTerminalsAndScripts({
  threadState,
  projectEnvironment,
  timelineData,
}: {
  threadState: ReturnType<typeof useChatViewThreadState>;
  projectEnvironment: ReturnType<typeof useChatViewProjectAndEnvironment>;
  timelineData: ReturnType<typeof useChatViewTimelineData>;
}) {
  const {
    activeThreadKey,
    isLocalDraftThread,
    panelAnimationsActive,
    panelAnimationDurationMs,
    activeThread,
    environmentId,
    visibleThreadError,
    threadDetailLoading,
    terminalUiLaunchContext,
    activeThreadId,
    routeKind,
    restingComposerControlsVisible,
    terminalUiState,
    isServerThread,
    diffOpen,
    onDiffPanelOpen,
    activeThreadRef,
    draftThread,
    environmentById,
    draftId,
    sendInFlightRef,
    setDraftThreadContext,
    composerHasAttachments,
    activeServerThread,
    routeThreadRef,
    setLocalServerErrorsByThreadKey,
    routeThreadKey,
    setLocalDraftErrorsByDraftId,
    interruptThreadTurn,
    composerRef,
    storeSetTerminalOpen,
    allocatableActiveTerminalIds,
    storeEnsureTerminal,
    openTerminal,
    storeSplitTerminalVertical,
    storeSplitTerminal,
    setTerminalFocusRequestId,
    storeNewTerminal,
    writeTerminal,
    closeTerminalMutation,
    storeCloseTerminal,
    setLastInvokedScriptByProjectId,
    activeKnownTerminalIds,
    runningTerminalIds,
    setTerminalUiLaunchContext,
    storeSetActiveTerminal,
    updateProjectScriptSettings,
    settings,
    upsertKeybinding,
    runtimeMode,
    setComposerDraftRuntimeMode,
    composerDraftTarget,
    setComposerDraftInteractionMode,
    navigate,
    openPreview,
    activeThreadShell,
    shouldUseRightPanelSheet,
    activePreviewMiniPlayer,
  } = threadState;
  const {
    activeProject,
    lockedProvider,
    showComposerEnvironmentIndicator,
    automaticEnvironment,
    logicalProjectEnvironments,
    loadBalancingSettings,
    envLocked,
    activeProjectScripts,
    serverConfig,
    supportsPullRequests,
  } = projectEnvironment;
  const {
    timelineEntries,
    isWorking,
    backgroundSubmissionPending,
    worktreeSetup,
    workspaceMutationId,
    providerInstanceEntries,
    selectedProvider,
    activeProviderInstanceId,
    threadActivities,
    activeProviderStatus,
    paintOnlyDisplayedTimeline,
    phase,
    agentPanelModel,
    interactionModeEnabled,
    interactionMode,
  } = timelineData;

  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null);
  const draftHeroDockRequested =
    activeThreadKey !== null && dockedDraftHeroThreadKey === activeThreadKey;
  const isDraftHeroState = resolveDraftHeroState({
    isLocalDraftThread,
    hasTimelineEntries: timelineEntries.length > 0,
    isWorking,
    draftHeroDockRequested,
    backgroundSubmissionPending,
    // A cancelled or failed setup card stays on the draft's timeline; the
    // hero headline would paint over it.
    hasWorktreeSetupCard: worktreeSetup !== null,
  });
  const [
    attachDraftHeroTransitionGroupRef,
    attachDraftHeroComposerAnchorRef,
    captureDraftHeroComposerRect,
  ] = useDraftHeroLayoutTransition(
    isDraftHeroState,
    panelAnimationsActive,
    panelAnimationDurationMs,
  );

  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const gitStatusCwd = activeThread?.worktreePath ?? gitCwd;
  const gitStatusQuery = useEnvironmentQuery(
    gitStatusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: gitStatusCwd },
        }),
  );
  useWorkspaceMutationRefresh({
    enabled: gitStatusCwd !== null,
    mutationId: workspaceMutationId,
    refresh: gitStatusQuery.refresh,
    resourceKey: `git-status:${activeThreadKey ?? ""}:${gitStatusCwd ?? ""}`,
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const manualCompactionProviderAvailable = useMemo(
    () =>
      hasAvailableCompactionProvider({
        providers: providerInstanceEntries,
        driverKind: selectedProvider,
        instanceId: activeProviderInstanceId,
        lockedInstanceId: lockedProvider
          ? (activeThread?.session?.providerInstanceId ??
            activeThread?.modelSelection.instanceId ??
            null)
          : null,
      }),
    [
      activeProviderInstanceId,
      activeThread?.modelSelection.instanceId,
      activeThread?.session?.providerInstanceId,
      lockedProvider,
      providerInstanceEntries,
      selectedProvider,
    ],
  );
  const [resumeCompactionPermanentlyDismissed, setResumeCompactionPermanentlyDismissed] =
    useLocalStorage(
      `t3code:resume-compaction-dismissed:${environmentId}:${activeProviderInstanceId ?? "claudeAgent"}`,
      false,
      Schema.Boolean,
    );
  const nativeResumeCompactionDismissed = useMemo(
    () => hasDismissedResumeCompaction(threadActivities),
    [threadActivities],
  );
  useEffect(() => {
    if (nativeResumeCompactionDismissed && !resumeCompactionPermanentlyDismissed) {
      setResumeCompactionPermanentlyDismissed(true);
    }
  }, [
    nativeResumeCompactionDismissed,
    resumeCompactionPermanentlyDismissed,
    setResumeCompactionPermanentlyDismissed,
  ]);
  const providerStatusBannerKey = getProviderStatusBannerKey(activeProviderStatus);
  const [dismissedProviderStatusBannerKey, setDismissedProviderStatusBannerKey] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (providerStatusBannerKey === null && dismissedProviderStatusBannerKey !== null) {
      setDismissedProviderStatusBannerKey(null);
    }
  }, [dismissedProviderStatusBannerKey, providerStatusBannerKey]);
  const visibleProviderStatus = shouldShowProviderStatusBanner(
    activeProviderStatus,
    dismissedProviderStatusBannerKey,
  )
    ? activeProviderStatus
    : null;
  const hasTimelineTopBanner = Boolean(visibleThreadError) || visibleProviderStatus !== null;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  useLayoutEffect(() => {
    if (
      threadDetailLoading ||
      timelineEntries.length === 0 ||
      timelineHasEphemeralPreviewUrls(timelineEntries)
    ) {
      return;
    }
    rememberReadyThreadTimeline({
      threadKey: activeThreadKey,
      entries: timelineEntries,
      markdownCwd: gitCwd,
      workspaceRoot: activeWorkspaceRoot ?? null,
    });
  }, [activeThreadKey, activeWorkspaceRoot, gitCwd, threadDetailLoading, timelineEntries]);
  const heldPaintContext = paintOnlyDisplayedTimeline
    ? peekHeldThreadTimeline<typeof timelineEntries>()
    : null;
  const activeTerminalLaunchContext =
    terminalUiLaunchContext?.threadId === activeThreadId ? terminalUiLaunchContext : null;
  // Git status arrives after the composer paints. A checkout seen earlier in
  // this session answers from memory, so a non-Git project does not mount the
  // branch strip and then drop it. A never-seen checkout assumes Git, which
  // is what nearly every project is.
  const liveIsGitRepo = gitStatusQuery.data?.isRepo;
  useEffect(() => {
    if (gitStatusCwd !== null && liveIsGitRepo !== undefined) {
      rememberCheckoutIsRepo(environmentId, gitStatusCwd, liveIsGitRepo);
    }
  }, [environmentId, gitStatusCwd, liveIsGitRepo]);
  const isGitRepo = liveIsGitRepo ?? recallCheckoutIsRepo(environmentId, gitStatusCwd) ?? true;
  // Keep a hidden, off-flow strip mounted for existing threads so the composer
  // can measure whether its relocated controls fit. The visible chrome remains
  // content-driven: Git/environment context or controls that actually fit.
  const mountComposerContextStrip = shouldShowComposerContextStrip({
    hasActiveProject: activeProject !== null,
    isGitRepo,
    showEnvironmentIndicator: showComposerEnvironmentIndicator,
    hostsRestingComposerControls: routeKind === "server",
  });
  const showComposerContextStrip = shouldShowComposerContextStrip({
    hasActiveProject: activeProject !== null,
    isGitRepo,
    showEnvironmentIndicator: showComposerEnvironmentIndicator,
    hostsRestingComposerControls: routeKind === "server" && restingComposerControlsVisible,
  });
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: Boolean(terminalUiState.terminalOpen),
      },
    }),
    [terminalUiState.terminalOpen],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const splitTerminalVerticalShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "terminal.splitVertical", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const onToggleDiff = useCallback(() => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
    }
    if (activeThreadRef) {
      useRightPanelStore.getState().toggle(activeThreadRef, "diff");
    }
  }, [activeThreadRef, diffOpen, isServerThread, onDiffPanelOpen]);

  const needsLoadBalancing = automaticEnvironment && !draftThread?.loadBalancedEnvironmentId;
  const loadBalancingCandidates = useMemo(
    () =>
      needsLoadBalancing
        ? logicalProjectEnvironments
            .filter((candidate) => {
              const environment = environmentById.get(candidate.environmentId);
              return (
                environment?.connection.phase === "connected" &&
                (loadBalancingSettings.loadBalancingWeights[candidate.environmentId] ?? 50) > 0 &&
                environment.serverConfig?.providers.some(
                  (provider) =>
                    (activeProviderInstanceId === null ||
                      provider.instanceId === activeProviderInstanceId) &&
                    provider.driver === selectedProvider &&
                    provider.enabled &&
                    provider.installed &&
                    provider.status !== "error" &&
                    provider.auth.status !== "unauthenticated" &&
                    provider.availability !== "unavailable",
                )
              );
            })
            .map((candidate) => candidate.environmentId)
        : [],
    [
      needsLoadBalancing,
      logicalProjectEnvironments,
      environmentById,
      loadBalancingSettings.loadBalancingWeights,
      activeProviderInstanceId,
      selectedProvider,
    ],
  );
  const loadBalancing = useLoadBalancedEnvironment(
    loadBalancingCandidates,
    loadBalancingSettings.loadBalancingWeights,
  );
  useEffect(() => {
    if (!needsLoadBalancing || loadBalancing.pending || !draftId || sendInFlightRef.current) return;
    const target = logicalProjectEnvironments.find(
      (environment) => environment.environmentId === loadBalancing.environmentId,
    );
    if (!target) return;
    setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(target.environmentId, target.projectId),
      environmentSelection: "auto",
      loadBalancedEnvironmentId: target.environmentId,
    });
  }, [
    needsLoadBalancing,
    loadBalancing.pending,
    loadBalancing.environmentId,
    draftId,
    logicalProjectEnvironments,
    setDraftThreadContext,
  ]);
  const onAutoEnvironment = useCallback(() => {
    if (envLocked || !draftId) return;
    if (composerHasAttachments) {
      toastManager.add({
        type: "warning",
        id: "load-balancing-attachments",
        title: "Keep attachments on this machine",
        description:
          "Remove attachments before choosing automatic routing, then attach them on the selected machine.",
      });
      return;
    }
    loadBalancing.refresh(
      logicalProjectEnvironments.map((environment) => environment.environmentId),
    );
    setDraftThreadContext(draftId, {
      environmentSelection: "auto",
      loadBalancedEnvironmentId: null,
      branch: null,
      worktreePath: null,
    });
  }, [
    envLocked,
    draftId,
    setDraftThreadContext,
    loadBalancing.refresh,
    logicalProjectEnvironments,
    composerHasAttachments,
  ]);
  const autoEnvironmentLabel = automaticEnvironment
    ? draftThread?.loadBalancedEnvironmentId
      ? "Auto balance"
      : loadBalancing.pending
        ? "Checking machines…"
        : loadBalancing.failed
          ? "Auto balance unavailable"
          : "Auto balance"
    : undefined;

  // Handle environment change for draft threads.  When the user picks a
  // different environment we update the draft context to point at the physical
  // project in that environment while keeping the same logical project.
  const onEnvironmentChange = useCallback(
    (nextEnvironmentId: EnvironmentId) => {
      if (envLocked || !draftId) return;
      const target = logicalProjectEnvironments.find(
        (env) => env.environmentId === nextEnvironmentId,
      );
      if (!target) return;
      setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(target.environmentId, target.projectId),
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
      });
    },
    [draftId, envLocked, logicalProjectEnvironments, setDraftThreadContext],
  );

  const activeTerminalGroup =
    terminalUiState.terminalGroups.find(
      (group) => group.id === terminalUiState.activeTerminalGroupId,
    ) ??
    terminalUiState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalUiState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      const nextError = sanitizeThreadErrorMessage(error);
      const nextEntry: LocalThreadErrorEntry = { message: nextError, at: Date.now() };
      if (
        shouldWriteThreadErrorToCurrentServerThread({
          activeServerThread,
          routeThreadRef,
          targetThreadId,
        })
      ) {
        setLocalServerErrorsByThreadKey((existing) => {
          if ((existing[routeThreadKey]?.message ?? null) === nextError) {
            return existing;
          }
          return {
            ...existing,
            [routeThreadKey]: nextEntry,
          };
        });
        return;
      }
      const localDraftErrorKey = draftId ?? targetThreadId;
      setLocalDraftErrorsByDraftId((existing) => {
        if ((existing[localDraftErrorKey]?.message ?? null) === nextError) {
          return existing;
        }
        return {
          ...existing,
          [localDraftErrorKey]: nextEntry,
        };
      });
    },
    [activeServerThread, draftId, routeThreadKey, routeThreadRef],
  );

  const interruptContextRef = useRef({ activeThread, phase, setThreadError });
  interruptContextRef.current = { activeThread, phase, setThreadError };
  const restoreQueuedMessagesRef = useRef<(messages: ReadonlyArray<QueuedComposerMessage>) => void>(
    () => {},
  );
  const onInterrupt = useCallback(async () => {
    const { activeThread, phase, setThreadError } = interruptContextRef.current;
    const input = buildRunningThreadTurnInterruptInput(activeThread, phase);
    if (!input || !activeThread) return;
    restoreQueuedMessagesRef.current(
      useQueuedMessageStore
        .getState()
        .drain(scopedThreadKey(scopeThreadRef(activeThread.environmentId, activeThread.id))),
    );
    const result = await interruptThreadTurn({
      environmentId: activeThread.environmentId,
      input,
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to interrupt the current turn.",
      );
    }
  }, [interruptThreadTurn]);
  const canInterruptRunningThread =
    buildRunningThreadTurnInterruptInput(activeThread, phase) !== null;
  // Stop ends the session and every background agent with it, so it asks first
  // when any are live. The dialog's "Stop all" is the only path to onInterrupt.
  const liveBackgroundAgentCountRef = useRef(0);
  liveBackgroundAgentCountRef.current = agentPanelModel.liveCount;
  const [stopAgentsConfirmCount, setStopAgentsConfirmCount] = useState<number | null>(null);
  const requestInterrupt = useCallback(() => {
    const decision = decideStop(liveBackgroundAgentCountRef.current);
    if (decision.kind === "confirm") {
      setStopAgentsConfirmCount(decision.agentCount);
      return;
    }
    void onInterrupt();
  }, [onInterrupt]);

  const focusComposer = useCallback(() => {
    composerRef.current?.focusAtEnd();
  }, [composerRef]);
  useEffect(() => subscribeSnapShotComposerFocus(focusComposer), [focusComposer]);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const useArtifactTemplate = useCallback(
    (template: CodexArtifactTemplate) => {
      const composer = composerRef.current;
      if (!composer) return;

      const currentDraft = composer.getSendContext().prompt;
      const prompt = codexArtifactTemplatePromptToAppend(currentDraft, template);
      if (prompt !== null && !composer.insertTextAtEnd(prompt, { ensureLeadingBoundary: true })) {
        toastManager.add({
          type: "error",
          title: "Unable to add to chat",
          description: "The composer is busy; try again once it is ready.",
        });
        return;
      }
      scheduleComposerFocus();
    },
    [composerRef, scheduleComposerFocus],
  );
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      composerRef.current?.addTerminalContext(selection);
    },
    [composerRef],
  );
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadRef) return;
      storeSetTerminalOpen(activeThreadRef, open);
    },
    [activeThreadRef, storeSetTerminalOpen],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadRef) return;
    const nextOpen = !terminalUiState.terminalOpen;
    if (nextOpen && terminalUiState.terminalIds.length === 0) {
      if (!activeThreadId || !activeProject) {
        return;
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
      if (!cwdForOpen) {
        return;
      }
      const terminalId = nextTerminalId(allocatableActiveTerminalIds);
      storeEnsureTerminal(activeThreadRef, terminalId, { open: true });
      void openTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd: cwdForOpen,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
      return;
    }
    setTerminalOpen(nextOpen);
  }, [
    activeProject,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    allocatableActiveTerminalIds,
    environmentId,
    gitCwd,
    openTerminal,
    setTerminalOpen,
    storeEnsureTerminal,
    terminalUiState.terminalIds.length,
    terminalUiState.terminalOpen,
  ]);
  const splitTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (!activeThreadRef || hasReachedSplitLimit || !activeThreadId || !activeProject) {
        return;
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
      if (!cwdForOpen) {
        return;
      }
      const terminalId = nextTerminalId(allocatableActiveTerminalIds);
      if (direction === "vertical") {
        storeSplitTerminalVertical(activeThreadRef, terminalId);
      } else {
        storeSplitTerminal(activeThreadRef, terminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd: cwdForOpen,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
    },
    [
      activeProject,
      activeThreadId,
      allocatableActiveTerminalIds,
      activeThreadRef,
      openTerminal,
      activeThreadWorktreePath,
      environmentId,
      gitCwd,
      hasReachedSplitLimit,
      storeSplitTerminal,
      storeSplitTerminalVertical,
    ],
  );
  const createNewTerminal = useCallback(() => {
    if (!activeThreadRef || !activeThreadId || !activeProject) {
      return;
    }
    const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
    if (!cwdForOpen) {
      return;
    }
    const terminalId = nextTerminalId(allocatableActiveTerminalIds);
    storeNewTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
    void openTerminal({
      environmentId,
      input: {
        threadId: activeThreadId,
        terminalId,
        cwd: cwdForOpen,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      },
    });
  }, [
    activeProject,
    activeThreadId,
    allocatableActiveTerminalIds,
    activeThreadRef,
    openTerminal,
    activeThreadWorktreePath,
    environmentId,
    gitCwd,
    storeNewTerminal,
  ]);
  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId || !activeThreadRef) return;
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId,
          input: { threadId: activeThreadId, terminalId, data: "exit\n" },
        });
      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId,
          input: {
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (closeResult._tag === "Failure" && !isAtomCommandInterrupted(closeResult)) {
          await fallbackExitWrite();
        }
      })();
      storeCloseTerminal(activeThreadRef, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeThreadId,
      activeThreadRef,
      closeTerminalMutation,
      environmentId,
      storeCloseTerminal,
      writeTerminal,
    ],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      if (!activeThreadId || !activeProject || !activeThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.workspaceRoot;
      const baseTerminalId =
        terminalUiState.activeTerminalId || activeKnownTerminalIds[0] || DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal = wantsNewTerminal;
      const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

      setTerminalUiLaunchContext({
        threadId: activeThreadId,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
      });
      setTerminalOpen(true);
      if (!activeThreadRef) {
        return;
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.workspaceRoot,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const targetTerminalId = shouldCreateNewTerminal
        ? nextTerminalId(allocatableActiveTerminalIds)
        : baseTerminalId;
      const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          };

      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadRef, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadRef, targetTerminalId);
      }

      const openResult = await openTerminal({ environmentId, input: openTerminalInput });
      if (openResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(openResult)) {
          const error = squashAtomCommandFailure(openResult);
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
          );
        }
        return;
      }

      const writeResult = await writeTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        },
      });
      if (writeResult._tag === "Failure" && !isAtomCommandInterrupted(writeResult)) {
        const error = squashAtomCommandFailure(writeResult);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      activeThreadRef,
      gitCwd,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      environmentId,
      openTerminal,
      activeKnownTerminalIds,
      allocatableActiveTerminalIds,
      runningTerminalIds,
      terminalUiState.activeTerminalId,
      writeTerminal,
    ],
  );

  const runProjectScriptRef = useRef(runProjectScript);
  useLayoutEffect(() => {
    runProjectScriptRef.current = runProjectScript;
  }, [runProjectScript]);
  const runShellCommand = useCallback((command: string) => {
    void runProjectScriptRef.current(
      {
        id: "chat-code-block",
        name: "Chat code block",
        command,
        icon: "play",
        runOnWorktreeCreate: false,
      },
      { rememberAsLastInvoked: false },
    );
  }, []);

  const supportsProjectSettingsOverrides =
    environmentById.get(environmentId)?.serverConfig?.environment.capabilities
      .projectSettingsOverrides === true;
  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ReadonlyArray<ProjectScript>;
      nextScripts: ReadonlyArray<ProjectScript>;
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand | null;
    }): Promise<AtomCommandResult<void, unknown>> => {
      const updateResult = mapAtomCommandResult(
        await updateProjectScriptSettings({
          environmentId,
          input: {
            // The canonical key on servers that understand it; the legacy
            // per-project map is still translated on older ones.
            patch: supportsProjectSettingsOverrides
              ? {
                  projectSettingsOverrides: {
                    [input.projectId]: {
                      ...settings.projectSettingsOverrides[input.projectId],
                      defaultProjectScripts: input.nextScripts,
                    },
                  },
                }
              : {
                  projectScriptOverrides: {
                    [input.projectId]: input.nextScripts,
                  },
                },
          },
        }),
        () => undefined,
      );
      if (updateResult._tag === "Failure") {
        return updateResult;
      }

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        return mapAtomCommandResult(
          await upsertKeybinding({
            environmentId,
            input: keybindingRule,
          }),
          () => undefined,
        );
      }
      return updateResult;
    },
    [
      environmentId,
      settings.projectSettingsOverrides,
      supportsProjectSettingsOverrides,
      updateProjectScriptSettings,
      upsertKeybinding,
    ],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const nextId = nextProjectScriptId(
        input.name,
        activeProjectScripts.map((script) => script.id),
      );
      const nextScript = buildProjectScript(nextId, input);
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProjectScripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProjectScripts, nextScript];

      return persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProjectScripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, activeProjectScripts, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (
      scriptId: string,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const existingScript = activeProjectScripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        return AsyncResult.failure(Cause.fail(new Error("Script not found.")));
      }

      const updatedScript = buildProjectScript(existingScript.id, input);
      const nextScripts = activeProjectScripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      return persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProjectScripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, activeProjectScripts, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const nextScripts = activeProjectScripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProjectScripts.find((s) => s.id === scriptId)?.name;

      const result = await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProjectScripts,
        nextScripts,
        keybinding: null,
        keybindingCommand: commandForProjectScript(scriptId),
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not delete action",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
      return result;
    },
    [activeProject, activeProjectScripts, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === "plan" && !interactionModeEnabled) return;
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      interactionModeEnabled,
      isLocalDraftThread,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    if (!interactionModeEnabled) return;
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode, interactionModeEnabled]);
  const openProviderSetup = useCallback(
    (instanceId: ProviderInstanceId) => {
      void navigate({
        to: "/settings/providers",
        search: { environmentId, instanceId },
      });
    },
    [environmentId, navigate],
  );
  const createBrowserSurface = useCallback(
    (profileId?: string) => {
      if (!activeThreadRef) return;
      void addBrowserSurface({
        threadRef: activeThreadRef,
        openPreview,
        ...(profileId === undefined ? {} : { profileId }),
      }).then((result) => {
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        if (error instanceof BrowserSettingsReadError) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to open browser",
              description: error.message,
            }),
          );
        }
      });
    },
    [activeThreadRef, openPreview],
  );
  const addDiffSurface = useCallback(() => {
    if (!activeThreadRef || !isServerThread || !isGitRepo) return;
    useDiffPanelStore.getState().selectGitScope(activeThreadRef, "unstaged");
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  }, [activeThreadRef, isGitRepo, isServerThread, onDiffPanelOpen]);
  const addFilesSurface = useCallback(() => {
    if (!activeThreadRef || !activeProject) return;
    useRightPanelStore.getState().open(activeThreadRef, "files");
  }, [activeProject, activeThreadRef]);
  const addAgentsSurface = useCallback(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().open(activeThreadRef, "agents");
  }, [activeThreadRef]);
  const workflowsSurfaceAvailable = activeThreadRef !== null;
  const addWorkflowsSurface = useCallback(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().open(activeThreadRef, "workflows");
  }, [activeThreadRef]);
  const supportsThreadPullRequests =
    serverConfig?.environment.capabilities.threadPullRequests === true;
  const visiblePullRequests = visibleThreadPullRequests(
    (activeThreadShell ?? activeThread)?.pullRequests ?? [],
  );
  const visiblePullRequestCount = visiblePullRequests.length;
  const pullRequestsSurfaceAvailable =
    isServerThread && supportsThreadPullRequests && visiblePullRequestCount > 0;
  const addPullRequestsSurface = useCallback(() => {
    if (!activeThreadRef || !pullRequestsSurfaceAvailable) return;
    useRightPanelStore.getState().open(activeThreadRef, "pull-requests");
  }, [activeThreadRef, pullRequestsSurfaceAvailable]);
  const { state: deviceState, loaded: deviceStateLoaded } = useDeviceState(
    activeThreadRef?.environmentId ?? null,
  );
  const [deviceSetupThread, setDeviceSetupThread] = useState<ScopedThreadRef | null>(null);
  const addDeviceSurface = useCallback(() => {
    if (!activeThreadRef) return;
    if (!deviceState.onboardingCompleted || deviceState.hostStatus === "disabled") {
      setDeviceSetupThread(activeThreadRef);
      return;
    }
    useRightPanelStore.getState().open(activeThreadRef, "device");
  }, [activeThreadRef, deviceState.onboardingCompleted, deviceState.hostStatus]);
  // A device the agent opens floats over chat like an agent-driven browser,
  // or becomes a panel tab when floating previews are off. Sessions opened by
  // another client arrive the same way; sheet layouts get neither. The first
  // snapshot is a baseline: persisted tabs restore themselves, and existing
  // sessions must not resurrect closed tabs. A session whose device summary
  // has not arrived yet stays out of the baseline so a later snapshot opens it.
  const autoShowFloatingPreview = useClientSettings(selectAutoShowFloatingPreview);
  const previousDeviceSessions = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    if (!activeThreadRef || !deviceStateLoaded) return;
    const threadKey = `${activeThreadRef.environmentId}:${activeThreadRef.threadId}`;
    const sessions = deviceState.sessions.filter(
      (session) => session.threadId === activeThreadRef.threadId,
    );
    const key = (session: (typeof sessions)[number]) => `${session.hostId}:${session.deviceId}`;
    const deviceFor = (session: (typeof sessions)[number]) =>
      deviceState.devices.find(
        (entry) => entry.hostId === session.hostId && entry.id === session.deviceId,
      );
    const previous = previousDeviceSessions.current.get(threadKey);
    previousDeviceSessions.current.set(
      threadKey,
      new Set(sessions.filter((session) => deviceFor(session) !== undefined).map(key)),
    );
    if (!previous || shouldUseRightPanelSheet) return;
    for (const session of sessions) {
      if (previous.has(key(session))) continue;
      const device = deviceFor(session);
      if (!device) continue;
      const target = {
        hostId: session.hostId,
        deviceId: session.deviceId,
        platform: device.platform,
        name: device.name,
      };
      if (autoShowFloatingPreview) {
        usePreviewMiniPlayerStore.getState().open(activeThreadRef, { kind: "device", ...target });
        continue;
      }
      const existing = useRightPanelStore
        .getState()
        .byThreadKey[scopedThreadKey(activeThreadRef)]?.surfaces.some(
          (surface) =>
            surface.kind === "device" &&
            surface.target?.hostId === session.hostId &&
            surface.target.deviceId === session.deviceId,
        );
      if (existing) continue;
      useRightPanelStore.getState().openDevice(activeThreadRef, target, true);
    }
  }, [
    activeThreadRef,
    autoShowFloatingPreview,
    deviceStateLoaded,
    shouldUseRightPanelSheet,
    deviceState.sessions,
    deviceState.devices,
  ]);
  // A floating device follows its session: once the agent or another client
  // closes the device there is nothing left to stream.
  useEffect(() => {
    if (!activeThreadRef || !deviceStateLoaded) return;
    const source = activePreviewMiniPlayer?.source;
    if (source?.kind !== "device") return;
    const sessionStillExists = deviceState.sessions.some(
      (session) =>
        session.threadId === activeThreadRef.threadId &&
        session.hostId === source.hostId &&
        session.deviceId === source.deviceId,
    );
    if (!sessionStillExists) usePreviewMiniPlayerStore.getState().close(activeThreadRef);
  }, [activePreviewMiniPlayer, activeThreadRef, deviceState.sessions, deviceStateLoaded]);
  const openFileSurface = useCallback(
    (relativePath: string) => {
      if (!activeThreadRef || !activeProject) return;
      useRightPanelStore.getState().openFile(activeThreadRef, relativePath);
    },
    [activeProject, activeThreadRef],
  );
  // The shell carries server PR updates even while thread detail is still loading.
  const activeThreadMetadata = activeThreadShell ?? activeThread;
  const hasLinkedPullRequestDetail = activeThreadMetadata?.linkedPullRequest != null;
  const linkedThreadPullRequest =
    activeThreadMetadata?.linkedPullRequest ?? activeThreadMetadata?.branchPullRequest ?? null;
  const activeProjectRepository = sourceControlRepositorySelector(
    activeProject?.repositoryIdentity,
  );
  const linkedThreadPullRequestKey = linkedThreadPullRequest
    ? JSON.stringify([
        linkedThreadPullRequest.projectId,
        linkedThreadPullRequest.repository,
        linkedThreadPullRequest.number,
      ])
    : null;
  const proactivePullRequestsKey = pullRequestsSurfaceAvailable
    ? JSON.stringify(
        visiblePullRequests.map((link) => [link.host, link.repository, link.number]).sort(),
      )
    : linkedThreadPullRequestKey;
  const observedThreadPullRequestRef = useRef<{
    readonly threadKey: string;
    readonly reference: ThreadLinkedPullRequest | null;
  } | null>(null);
  const openProjectPullRequest = useCallback(
    (number: number) => {
      if (
        !supportsPullRequests ||
        !activeThreadRef ||
        !activeProject ||
        activeProjectRepository === null
      ) {
        return;
      }
      useRightPanelStore.getState().openPullRequest(activeThreadRef, {
        projectId: activeProject.id,
        repository: activeProjectRepository,
        number,
      });
    },
    [activeProject, activeProjectRepository, activeThreadRef, supportsPullRequests],
  );

  return {
    observedThreadPullRequestRef,
    linkedThreadPullRequest,
    proactivePullRequestsKey,
    pullRequestsSurfaceAvailable,
    visiblePullRequestCount,
    hasLinkedPullRequestDetail,
    gitStatusQuery,
    createBrowserSurface,
    gitCwd,
    activeThreadWorktreePath,
    closeTerminal,
    focusComposer,
    isGitRepo,
    activeThreadMetadata,
    activeProjectCwd,
    scheduleComposerFocus,
    setThreadError,
    canInterruptRunningThread,
    requestInterrupt,
    addAgentsSurface,
    manualCompactionProviderAvailable,
    resumeCompactionPermanentlyDismissed,
    nativeResumeCompactionDismissed,
    keybindings,
    toggleTerminalVisibility,
    setTerminalOpen,
    splitTerminal,
    createNewTerminal,
    onToggleDiff,
    runProjectScript,
    restoreQueuedMessagesRef,
    needsLoadBalancing,
    loadBalancing,
    handleInteractionModeChange,
    isDraftHeroState,
    captureDraftHeroComposerRect,
    setDockedDraftHeroThreadKey,
    activeTerminalLaunchContext,
    addTerminalContextToDraft,
    splitTerminalShortcutLabel,
    splitTerminalVerticalShortcutLabel,
    newTerminalShortcutLabel,
    closeTerminalShortcutLabel,
    addPullRequestsSurface,
    activeWorkspaceRoot,
    availableEditors,
    openFileSurface,
    deviceSetupThread,
    setDeviceSetupThread,
    deviceState,
    activeProjectRepository,
    openProjectPullRequest,
    saveProjectScript,
    updateProjectScript,
    deleteProjectScript,
    visibleProviderStatus,
    setDismissedProviderStatusBannerKey,
    providerStatusBannerKey,
    openProviderSetup,
    useArtifactTemplate,
    runShellCommand,
    heldPaintContext,
    hasTimelineTopBanner,
    attachDraftHeroTransitionGroupRef,
    showComposerContextStrip,
    attachDraftHeroComposerAnchorRef,
    toggleInteractionMode,
    handleRuntimeModeChange,
    mountComposerContextStrip,
    onEnvironmentChange,
    autoEnvironmentLabel,
    onAutoEnvironment,
    stopAgentsConfirmCount,
    setStopAgentsConfirmCount,
    onInterrupt,
    addDiffSurface,
    addFilesSurface,
    addWorkflowsSurface,
    workflowsSurfaceAvailable,
    addDeviceSurface,
  };
}
