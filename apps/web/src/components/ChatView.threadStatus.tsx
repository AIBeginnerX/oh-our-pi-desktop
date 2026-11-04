import { feedbackBannerItem } from "./chat/ComposerFeedback";
import { selectTurnStallNoticeEnabled, useTurnStallNotice } from "./chat/useTurnStallNotice";
import { effectiveSnoozed, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { resolveThreadReferenceCopyTarget } from "@t3tools/shared/threadReference";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useUiStateStore } from "../uiStateStore";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { useRightPanelStore } from "../rightPanelStore";
import { AlarmClockIcon, CheckCircle2Icon, GitBranchIcon, Minimize2Icon } from "lucide-react";
import { cn } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useClientSettings } from "../hooks/useSettings";
import { useNowMinute } from "../hooks/useNowMinute";
import { useOpenPanelPullRequestUrl } from "../hooks/useOpenPanelPullRequestUrl";
import { type DraftThreadEnvMode } from "../composerDraftStore";
import { threadEnvironment } from "../state/threads";
import { resolveComposerTimelineInset, resolveScrollToEndClearance } from "./composerFooterLayout";
import { resolveEffectiveEnvMode, resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import type { ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import { shouldOfferResumeCompaction } from "./chat/ContextWindowMeter.logic";
import { formatContextWindowTokens } from "../lib/contextWindow";
import {
  branchMismatchKey,
  buildThreadTurnInterruptInput,
  dismissBranchMismatchForSession,
  isBranchMismatchDismissedForSession,
  shouldShowBranchMismatchBanner,
  resolveSendEnvMode,
} from "./ChatView.logic";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useProjectMemoryRecovery } from "./chat/ProjectMemoryRecovery";
import {
  EMPTY_MESSAGES,
  isCompactCommandMessage,
  chatActionErrorMessage,
} from "./ChatView.helpers";
import type { useChatViewThreadState } from "./ChatView.threadState";
import type { useChatViewProjectAndEnvironment } from "./ChatView.projectEnvironment";
import type { useChatViewTimelineData } from "./ChatView.timelineData";
import type { useChatViewTerminalsAndScripts } from "./ChatView.terminalsAndScripts";

export function useChatViewThreadStatus({
  threadState,
  projectEnvironment,
  timelineData,
  terminalsAndScripts,
}: {
  threadState: ReturnType<typeof useChatViewThreadState>;
  projectEnvironment: ReturnType<typeof useChatViewProjectAndEnvironment>;
  timelineData: ReturnType<typeof useChatViewTimelineData>;
  terminalsAndScripts: ReturnType<typeof useChatViewTerminalsAndScripts>;
}) {
  const {
    setExpandedImage,
    activeThread,
    isServerThread,
    isLocalDraftThread,
    draftThread,
    pendingServerThreadEnvMode,
    pendingServerThreadBranch,
    pendingServerThreadStartFromOriginByThreadId,
    composerOverlayElement,
    setScrollToEndClearance,
    composerOverlayHeightRef,
    composerTimelineInsetRef,
    composerRestingRef,
    setComposerTimelineInset,
    activeThreadKey,
    showScrollToBottom,
    activeThreadRef,
    activeThreadId,
    activeThreadShell,
    markThreadVisited,
    composerHasUnsentContent,
    switchGitRef,
    environmentId,
    updateThreadMetadata,
    interruptThreadTurn,
    rightPanelOpen,
    activeRightPanelSurface,
    activeThreadEnvironmentId,
    threadDetailLoading,
    feedbackUploading,
    composerRef,
    feedbackSubmissions,
    setFeedbackSubmissionsByThreadKey,
    routeThreadKey,
    setPendingServerThreadEnvMode,
    setPendingServerThreadBranch,
    setTerminalUiLaunchContext,
    terminalUiState,
    terminalUiOpenByThreadRef,
    setTerminalFocusRequestId,
  } = threadState;
  const {
    envLocked,
    activeProjectSettings,
    activeLatestTurn,
    latestTurnSettled,
    supportsPullRequests,
    serverConfig,
    activeRunningTurnId,
    activeProject,
    activeEnvironmentUnavailable,
    projectCloneBannerItem,
  } = projectEnvironment;
  const {
    isPreparingWorktree,
    activePlan,
    isWorking,
    phase,
    needsInput,
    agentPanelModel,
    workLogEntries,
    threadActivities,
    activeContextWindow,
    pendingApprovals,
    pendingUserInputs,
    showPlanFollowUpPrompt,
    selectedProvider,
    usageLimitsBanner,
    systemComposerBannerItems,
  } = timelineData;
  const {
    isGitRepo,
    gitStatusQuery,
    activeThreadMetadata,
    linkedThreadPullRequest,
    activeProjectCwd,
    scheduleComposerFocus,
    setThreadError,
    canInterruptRunningThread,
    requestInterrupt,
    addAgentsSurface,
    manualCompactionProviderAvailable,
    resumeCompactionPermanentlyDismissed,
    nativeResumeCompactionDismissed,
    activeThreadWorktreePath,
    focusComposer,
  } = terminalsAndScripts;

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
    preparingWorktree: isPreparingWorktree,
  });
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeThread.messages.length === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranch !== undefined
      ? pendingServerThreadBranch
      : (activeThread?.branch ?? null);
  const startFromOrigin = isLocalDraftThread
    ? (draftThread?.startFromOrigin ?? false)
    : canOverrideServerThreadEnvMode
      ? (pendingServerThreadStartFromOriginByThreadId[activeThread?.id ?? ""] ??
        activeProjectSettings.settings.newWorktreesStartFromOrigin)
      : false;
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });
  const localCheckoutBranchMismatch = useMemo(
    () =>
      isServerThread
        ? resolveLocalCheckoutBranchMismatch({
            effectiveEnvMode: envMode,
            activeWorktreePath,
            activeThreadBranch,
            currentGitBranch: gitStatusQuery.data?.refName ?? null,
          })
        : null,
    [activeThreadBranch, activeWorktreePath, envMode, gitStatusQuery.data?.refName, isServerThread],
  );
  const activeComposerTasksProgress = useMemo(() => {
    if (!activeLatestTurn || latestTurnSettled || activePlan?.turnId !== activeLatestTurn.turnId) {
      return null;
    }
    const currentStep =
      activePlan.steps.find((step) => step.status === "inProgress") ??
      activePlan.steps.find((step) => step.status === "pending");
    if (!currentStep) return null;
    return {
      step: currentStep.step,
      completedSteps: activePlan.steps.filter((step) => step.status === "completed").length,
      totalSteps: activePlan.steps.length,
    };
  }, [activeLatestTurn, activePlan, latestTurnSettled]);
  const activeComposerTaskSteps =
    activeComposerTasksProgress && activePlan && activePlan.turnId === activeLatestTurn?.turnId
      ? activePlan.steps
      : null;

  const publishScrollToEndClearance = useCallback(
    (overlayHeight: number) => {
      const mainSurface = composerOverlayElement?.querySelector<HTMLElement>(
        '[data-chat-composer-main-surface="true"]',
      );
      const button = composerOverlayElement?.parentElement?.querySelector<HTMLElement>(
        'button[aria-label="Scroll to end"]',
      );
      const clearance =
        composerOverlayElement && mainSurface && button
          ? resolveScrollToEndClearance({
              overlayHeight,
              mainSurfaceTop: mainSurface.getBoundingClientRect().top,
              button: button.getBoundingClientRect(),
              attachments: Array.from(
                composerOverlayElement.querySelectorAll<HTMLElement>(
                  '[data-composer-banner-surface="attached"]',
                ),
                (element) => element.getBoundingClientRect(),
              ),
            })
          : overlayHeight;
      setScrollToEndClearance(clearance);
    },
    [composerOverlayElement],
  );
  const publishComposerOverlayHeight = useCallback(
    (height: number) => {
      const nextHeight = Math.ceil(height);
      if (nextHeight <= 0) return;
      composerOverlayHeightRef.current = nextHeight;
      const nextInset = resolveComposerTimelineInset({
        currentInset: composerTimelineInsetRef.current,
        overlayHeight: nextHeight,
        isResting: composerRestingRef.current,
      });
      if (composerTimelineInsetRef.current !== nextInset) {
        composerTimelineInsetRef.current = nextInset;
        setComposerTimelineInset(nextInset);
      }
      publishScrollToEndClearance(nextHeight);
    },
    [publishScrollToEndClearance],
  );
  // The composer reports its resting flag from a layout effect, which runs
  // before this component's own layout effects and before any resize
  // observation, so every measurement below sees the flag for its layout.
  // Only the flag is stored here: the stored height still belongs to the
  // previous layout, and the composer publishes the new layout's height
  // itself once it has measured it.
  const onComposerRestingChange = useCallback((resting: boolean) => {
    composerRestingRef.current = resting;
  }, []);
  // A held reservation belongs to the previous thread's draft. Rebuild it from
  // this thread's overlay so a tall draft elsewhere does not pad this one.
  useLayoutEffect(() => {
    if (!composerOverlayElement) return;
    composerTimelineInsetRef.current = 0;
    publishComposerOverlayHeight(composerOverlayElement.getBoundingClientRect().height);
  }, [activeThreadKey, composerOverlayElement, publishComposerOverlayHeight]);

  useLayoutEffect(() => {
    if (!composerOverlayElement) return;

    const updateHeight = () => {
      publishComposerOverlayHeight(composerOverlayElement.getBoundingClientRect().height);
    };

    updateHeight();
    if (typeof ResizeObserver === "undefined") return;

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(composerOverlayElement);
    return () => {
      resizeObserver.disconnect();
    };
  }, [composerOverlayElement, publishComposerOverlayHeight]);
  // The pill mounts and unmounts in the same commits that expand or rest the
  // composer, and a fast fling lands there while the previous resting tween
  // still pins the overlay at its old height. Measuring the overlay here would
  // publish that stale height against the new resting flag, drop the timeline
  // reservation, and yank the scroll position. The pill only needs its
  // clearance, so it reuses the height the composer last published.
  useLayoutEffect(() => {
    if (!composerOverlayElement) return;
    publishScrollToEndClearance(composerOverlayHeightRef.current);
  }, [composerOverlayElement, publishScrollToEndClearance, showScrollToBottom]);
  const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(activeThreadRef);
  const activeThreadReferenceCopyTarget = useMemo(
    () =>
      activeThreadId === null || !isServerThread
        ? null
        : resolveThreadReferenceCopyTarget({
            threadId: activeThreadId,
            openPanelPullRequestUrl,
            pullRequests: activeThreadMetadata?.pullRequests,
            linkedPullRequestUrl: linkedThreadPullRequest?.url ?? null,
          }),
    [
      activeThreadId,
      isServerThread,
      activeThreadMetadata?.pullRequests,
      linkedThreadPullRequest?.url,
      openPanelPullRequestUrl,
    ],
  );
  const copyActiveThreadReference = useCallback(() => {
    const target = activeThreadReferenceCopyTarget;
    if (target === null) return;
    void writeTextToClipboard(target.value, target.clipboardTarget).then(
      (didCopy) => {
        if (!didCopy) return;
        toastManager.add({
          type: "success",
          title: target.successTitle,
          description: target.value,
        });
      },
      (error) => {
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: target.failureTitle,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, [activeThreadReferenceCopyTarget]);
  const addPullRequestSurface = useCallback(() => {
    if (!supportsPullRequests || activeThreadRef === null || linkedThreadPullRequest === null)
      return;
    useRightPanelStore.getState().openPullRequest(activeThreadRef, linkedThreadPullRequest);
  }, [activeThreadRef, linkedThreadPullRequest, supportsPullRequests]);
  const pullRequestSurfaceAvailable = supportsPullRequests && linkedThreadPullRequest !== null;
  const supportsSettlement = serverConfig?.environment.capabilities.threadSettlement === true;
  const supportsSnooze = serverConfig?.environment.capabilities.threadSnooze === true;
  const supportsPinning = serverConfig?.environment.capabilities.threadPinning === true;
  const activeThreadPinned = supportsPinning && activeThreadShell?.pinnedAt != null;
  const nowMinute = useNowMinute();
  const snoozeNow = new Date().toISOString();
  const activeThreadSnoozed =
    activeThreadShell !== null &&
    supportsSnooze &&
    effectiveSnoozed(activeThreadShell, { now: snoozeNow });
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  void snoozeWakeTick;
  const activeThreadWokeAt =
    activeThreadShell !== null && supportsSnooze
      ? threadWokeAt(activeThreadShell, { now: snoozeNow })
      : null;
  useEffect(() => {
    if (!activeThreadSnoozed) return;
    const wakeAtMs = Date.parse(activeThreadShell?.snoozedUntil ?? "");
    if (!Number.isFinite(wakeAtMs)) return;
    const id = window.setTimeout(
      () => bumpSnoozeWakeTick((tick) => tick + 1),
      Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(id);
  }, [activeThreadShell?.snoozedUntil, activeThreadSnoozed, snoozeWakeTick]);
  const acknowledgeActiveThreadWoke = useCallback(() => {
    if (activeThreadRef === null || activeThreadWokeAt === null) return;
    markThreadVisited(scopedThreadKey(activeThreadRef), activeThreadWokeAt);
  }, [activeThreadRef, activeThreadWokeAt, markThreadVisited]);
  // Mirror of the sidebar's Woke pill for the open thread.
  const activeThreadLastVisitedAt = useUiStateStore((store) =>
    activeThreadKey === null ? undefined : store.threadLastVisitedAtById[activeThreadKey],
  );
  const activeThreadWokeVisible = useMemo(() => {
    if (activeThreadWokeAt === null) return false;
    if (activeThreadShell?.settledOverride === "settled") return false;
    const wokeAtMs = Date.parse(activeThreadWokeAt);
    if (Number.isNaN(wokeAtMs)) return false;
    // Having the thread open counts as a visit at completedAt (the effect
    // above stamps it); folding that floor in here keeps a completion-
    // triggered wake from flashing a banner for one frame before the stamp
    // lands. An unparseable stored visit counts as never-visited: corrupt
    // local data must not eat the wake signal.
    const storedVisitMs = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    const completedAtMs = activeLatestTurn?.completedAt
      ? Date.parse(activeLatestTurn.completedAt)
      : NaN;
    const lastVisitedMs = Math.max(
      Number.isNaN(storedVisitMs) ? -Infinity : storedVisitMs,
      Number.isNaN(completedAtMs) ? -Infinity : completedAtMs,
    );
    return lastVisitedMs < wokeAtMs;
  }, [
    activeLatestTurn?.completedAt,
    activeThreadLastVisitedAt,
    activeThreadShell,
    activeThreadWokeAt,
  ]);
  const activeThreadSettled =
    supportsSettlement && activeThreadShell?.settledOverride === "settled";
  const unsettleThreadMutation = useAtomCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
  // Keyed by thread, not a boolean: the pending state must follow the thread
  // it belongs to across navigation, and a request resolving for thread A
  // must never clear (or re-enable) thread B's button.
  const [unsettlingThreadKey, setUnsettlingThreadKey] = useState<string | null>(null);
  const isUnsettling = unsettlingThreadKey !== null && unsettlingThreadKey === activeThreadKey;
  const handleUnsettleActiveThread = useCallback(async () => {
    if (!activeThreadRef) return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsettlingThreadKey(threadKey);
    try {
      const result = await unsettleThreadMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, reason: "user" },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to un-settle thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    } finally {
      setUnsettlingThreadKey((current) => (current === threadKey ? null : current));
    }
  }, [activeThreadRef, unsettleThreadMutation]);
  const unsnoozeThreadMutation = useAtomCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const [unsnoozingThreadKey, setUnsnoozingThreadKey] = useState<string | null>(null);
  const isUnsnoozing = unsnoozingThreadKey !== null && unsnoozingThreadKey === activeThreadKey;
  const handleUnsnoozeActiveThread = useCallback(async () => {
    if (!activeThreadRef) return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsnoozingThreadKey(threadKey);
    try {
      const result = await unsnoozeThreadMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, reason: "user" },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to wake thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    } finally {
      setUnsnoozingThreadKey((current) => (current === threadKey ? null : current));
    }
  }, [activeThreadRef, unsnoozeThreadMutation]);
  const [isRestoringThreadBranch, setIsRestoringThreadBranch] = useState(false);
  const [branchRestoreConfirmOpen, setBranchRestoreConfirmOpen] = useState(false);
  // Once revealed for a given mismatch, the banner stays mounted until the
  // mismatch changes or resolves, so clearing the draft doesn't flicker it.
  const [revealedBranchMismatchKey, setRevealedBranchMismatchKey] = useState<string | null>(null);
  // Dismissal lives in a module-level set (survives remounts); this tick just
  // forces a re-render so the banner leaves immediately.
  const [, setBranchMismatchDismissTick] = useState(0);
  const activeBranchMismatchKey = branchMismatchKey(
    activeThread?.id ?? null,
    localCheckoutBranchMismatch,
  );
  const showBranchMismatchBanner = shouldShowBranchMismatchBanner({
    hasMismatch: localCheckoutBranchMismatch !== null,
    isDismissed: isBranchMismatchDismissedForSession(activeBranchMismatchKey),
    composerHasContent: composerHasUnsentContent,
    wasShownForCurrentMismatch:
      revealedBranchMismatchKey !== null && revealedBranchMismatchKey === activeBranchMismatchKey,
  });
  useEffect(() => {
    setRevealedBranchMismatchKey((revealed) => {
      if (showBranchMismatchBanner) {
        return activeBranchMismatchKey;
      }
      // Hysteresis is scoped to an uninterrupted mismatch: reset when the
      // mismatch resolves or changes so a recurrence re-gates on intent.
      return revealed !== null && revealed !== activeBranchMismatchKey ? null : revealed;
    });
  }, [activeBranchMismatchKey, showBranchMismatchBanner]);
  const handleSwitchCheckoutToThread = useCallback(async () => {
    if (
      !activeProjectCwd ||
      !activeThread ||
      !localCheckoutBranchMismatch ||
      isRestoringThreadBranch
    ) {
      return;
    }
    setIsRestoringThreadBranch(true);
    const checkoutResult = await switchGitRef({
      environmentId,
      input: {
        cwd: activeProjectCwd,
        refName: localCheckoutBranchMismatch.threadBranch,
      },
    });
    if (checkoutResult._tag === "Failure") {
      setIsRestoringThreadBranch(false);
      if (!isAtomCommandInterrupted(checkoutResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch checkout",
            description: chatActionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        );
      }
      return;
    }

    const nextBranch = checkoutResult.value.refName ?? localCheckoutBranchMismatch.threadBranch;
    if (nextBranch !== activeThread.branch) {
      const updateResult = await updateThreadMetadata({
        environmentId,
        input: { threadId: activeThread.id, branch: nextBranch, worktreePath: null },
      });
      if (updateResult._tag === "Failure") {
        setIsRestoringThreadBranch(false);
        if (!isAtomCommandInterrupted(updateResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Checkout switched, but the thread could not be updated",
              description: chatActionErrorMessage(squashAtomCommandFailure(updateResult)),
            }),
          );
        }
        gitStatusQuery.refresh();
        return;
      }
    }
    gitStatusQuery.refresh();
    setIsRestoringThreadBranch(false);
    scheduleComposerFocus();
  }, [
    activeProjectCwd,
    activeThread,
    environmentId,
    gitStatusQuery,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    scheduleComposerFocus,
    switchGitRef,
    updateThreadMetadata,
  ]);
  // Background work (subagent fleets, workflow runs, watch loops) can outlive
  // the turn; once it settles, the composer stop button is gone, so this
  // banner is the only visible stop affordance. Stop routes through the
  // stop-everything interrupt: it kills every live background task before
  // interrupting, and works by session, so no active turn is needed.
  const activeBackgroundLiveness =
    !isWorking && activeThread ? (activeThreadShell?.backgroundLiveness ?? null) : null;
  const [isStoppingBackgroundWork, setIsStoppingBackgroundWork] = useState(false);
  useEffect(() => {
    // "Stopping..." holds until the liveness clears; the interrupt command
    // returning only means the request was accepted.
    if (activeBackgroundLiveness === null) {
      setIsStoppingBackgroundWork(false);
    }
  }, [activeBackgroundLiveness]);
  useEffect(() => {
    // Per-thread state: switching threads while A's stop is pending must not
    // disable B's Stop button (review finding).
    setIsStoppingBackgroundWork(false);
  }, [activeThreadId]);
  const handleStopBackgroundWork = useCallback(async () => {
    if (!activeThread) return;
    setIsStoppingBackgroundWork(true);
    const result = await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(activeThread),
    });
    if (result._tag === "Failure") {
      // Every failure clears the pending state — an interrupted command
      // never reached the server, so liveness would hold "Stopping..."
      // forever. Only real failures toast.
      setIsStoppingBackgroundWork(false);
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to stop background work.",
        );
      }
    }
  }, [activeThread, environmentId, interruptThreadTurn, setThreadError]);
  // Off by default; see useTurnStallNotice. Passive: it never interrupts or retries a turn.
  const turnStallNoticeEnabled = useClientSettings(selectTurnStallNoticeEnabled);
  const turnStallNoticeItem = useTurnStallNotice({
    enabled: turnStallNoticeEnabled,
    runningTurnId: phase === "running" ? activeRunningTurnId : null,
    waitingOnUser: needsInput,
    backgroundWorkLive:
      (activeThreadShell?.backgroundLiveness ?? null) !== null || agentPanelModel.liveCount > 0,
    workLogEntries,
    activities: threadActivities,
    messages: activeThread?.messages ?? EMPTY_MESSAGES,
    turnStartedAt: activeLatestTurn?.startedAt ?? null,
    sessionUpdatedAt: activeThread?.session?.updatedAt ?? null,
    onStop: canInterruptRunningThread ? requestInterrupt : null,
  });
  const backgroundLivenessBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (activeBackgroundLiveness === null || !activeThread) {
      return null;
    }
    const working = activeBackgroundLiveness === "working";
    const liveCount = agentPanelModel.liveCount;
    // Hidden once the Agents surface is on screen; the link would point at nothing.
    const showViewAgents =
      liveCount > 0 && !(rightPanelOpen && activeRightPanelSurface?.kind === "agents");
    return {
      id: `background-liveness:${activeThread.id}`,
      variant: "default",
      priority: "activity",
      icon: (
        <span
          className={cn("size-1.5 rounded-full bg-foreground", working && "animate-status-pulse")}
          aria-hidden="true"
        />
      ),
      title: working
        ? liveCount > 0
          ? `${liveCount} ${liveCount === 1 ? "agent" : "agents"} working`
          : "Background work"
        : "Monitoring",
      actions: (
        <>
          {showViewAgents ? (
            <Button size="xs" variant="ghost" aria-label="View agents" onClick={addAgentsSurface}>
              View
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            disabled={isStoppingBackgroundWork}
            onClick={() => void handleStopBackgroundWork()}
          >
            {isStoppingBackgroundWork ? "Stopping..." : "Stop"}
          </Button>
        </>
      ),
    };
  }, [
    activeBackgroundLiveness,
    activeRightPanelSurface?.kind,
    activeThread,
    addAgentsSurface,
    agentPanelModel.liveCount,
    handleStopBackgroundWork,
    isStoppingBackgroundWork,
    rightPanelOpen,
  ]);
  // A woken thread announces itself in the open view, not just the sidebar
  // pill. Dismissing marks the wake as seen (same acknowledgment as the
  // pill); sending a message clears it as a side effect of the send path.
  const wokeThreadBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeThreadWokeVisible) {
      return null;
    }
    return {
      id: `thread-woke:${activeThread?.id ?? "unknown"}`,
      variant: "info",
      icon: <AlarmClockIcon />,
      title: "Thread woke from snooze",
      description: "Send a message to continue",
      dismissLabel: "Dismiss Woke notification",
      onDismiss: acknowledgeActiveThreadWoke,
    };
  }, [acknowledgeActiveThreadWoke, activeThread?.id, activeThreadWokeVisible]);
  const { bannerItem: projectMemoryRecoveryBannerItem, dialog: projectMemoryRecoveryDialog } =
    useProjectMemoryRecovery({
      environmentId: activeThreadEnvironmentId,
      projectId: activeProject?.id ?? null,
      threadId: activeThreadId,
      isServerThread,
      activities: threadActivities,
    });
  const parkedThreadBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeThreadSnoozed && !activeThreadSettled) {
      return null;
    }
    const isSnoozed = activeThreadSnoozed;
    return {
      id: `thread-${isSnoozed ? "snoozed" : "settled"}:${activeThread?.id ?? "unknown"}`,
      variant: "info",
      icon: isSnoozed ? <AlarmClockIcon /> : <CheckCircle2Icon />,
      title: `This thread is ${isSnoozed ? "snoozed" : "settled"}`,
      description: `Send a message to ${isSnoozed ? "wake" : "unsettle"}`,
      actions: (
        <Button
          size="xs"
          variant="ghost"
          disabled={isSnoozed ? isUnsnoozing : isUnsettling}
          onClick={() =>
            void (isSnoozed ? handleUnsnoozeActiveThread() : handleUnsettleActiveThread())
          }
        >
          {isSnoozed
            ? isUnsnoozing
              ? "Waking..."
              : "Wake now"
            : isUnsettling
              ? "Un-settling..."
              : "Un-settle"}
        </Button>
      ),
    };
  }, [
    activeThread?.id,
    activeThreadSettled,
    activeThreadSnoozed,
    handleUnsnoozeActiveThread,
    handleUnsettleActiveThread,
    isUnsnoozing,
    isUnsettling,
  ]);
  // Session-scoped dismissals, one key per (thread, snapshot). A set rather
  // than a single slot so dismissing the banner on one thread does not
  // resurface it on another thread dismissed earlier.
  const [dismissedResumeCompactionKeys, setDismissedResumeCompactionKeys] = useState<
    ReadonlySet<string>
  >(new Set());
  const resumeCompactionKey =
    activeThread && activeContextWindow
      ? `${activeThread.id}:${activeContextWindow.updatedAt}`
      : null;
  const activeThreadHasCompactableConversation =
    activeThread?.messages.some(
      (message) => message.role === "user" && !isCompactCommandMessage(message),
    ) ?? false;
  const compactThreadUnavailable =
    !activeThread ||
    !activeThreadHasCompactableConversation ||
    !activeProject ||
    !isServerThread ||
    !manualCompactionProviderAvailable ||
    isWorking ||
    threadDetailLoading ||
    isPreparingWorktree ||
    activeEnvironmentUnavailable ||
    feedbackUploading ||
    pendingApprovals.length > 0 ||
    pendingUserInputs.length > 0 ||
    showPlanFollowUpPrompt;
  const compactDisabled = compactThreadUnavailable;
  const compactDisabledReason = compactDisabled
    ? !activeProject
      ? "Choose a project before compacting"
      : !manualCompactionProviderAvailable
        ? "Compaction is unavailable for this provider"
        : "Compacting is unavailable right now"
    : null;
  const resumeCompactionBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (
      !activeThread ||
      !activeContextWindow ||
      resumeCompactionKey === null ||
      dismissedResumeCompactionKeys.has(resumeCompactionKey) ||
      resumeCompactionPermanentlyDismissed ||
      nativeResumeCompactionDismissed ||
      pendingUserInputs.length > 0 ||
      phase === "running" ||
      !shouldOfferResumeCompaction({
        provider: selectedProvider,
        usedTokens: activeContextWindow.usedTokens,
        updatedAt: activeContextWindow.updatedAt,
        now: `${nowMinute}:00.000Z`,
      })
    ) {
      return null;
    }

    const dismiss = () =>
      setDismissedResumeCompactionKeys((keys) => new Set(keys).add(resumeCompactionKey));
    const compactAction = (
      <Button
        size="xs"
        variant="ghost"
        disabled={compactDisabled}
        onClick={() => {
          if (compactDisabled) return;
          composerRef.current?.compactContext();
        }}
      >
        Compact
      </Button>
    );
    return {
      id: `resume-compaction:${resumeCompactionKey}`,
      variant: "info",
      icon: <Minimize2Icon />,
      title: "Resume with less context",
      description: `${formatContextWindowTokens(activeContextWindow.usedTokens)} tokens from earlier`,
      actions: compactDisabledReason ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex">{compactAction}</span>} />
          <TooltipPopup side="top">{compactDisabledReason}</TooltipPopup>
        </Tooltip>
      ) : (
        compactAction
      ),
      dismissLabel: "Keep full history",
      onDismiss: dismiss,
    };
  }, [
    activeContextWindow,
    activeThread,
    compactDisabled,
    compactDisabledReason,
    composerRef,
    dismissedResumeCompactionKeys,
    nativeResumeCompactionDismissed,
    nowMinute,
    pendingUserInputs.length,
    phase,
    resumeCompactionKey,
    resumeCompactionPermanentlyDismissed,
    selectedProvider,
  ]);
  const handleRestoreThreadBranch = useCallback(() => {
    if (gitStatusQuery.data?.hasWorkingTreeChanges) {
      setBranchRestoreConfirmOpen(true);
      return;
    }
    void handleSwitchCheckoutToThread();
  }, [gitStatusQuery.data?.hasWorkingTreeChanges, handleSwitchCheckoutToThread]);
  const feedbackBannerItems = useMemo(
    () =>
      feedbackSubmissions.flatMap((submission) => {
        const item = feedbackBannerItem(submission, () => {
          setFeedbackSubmissionsByThreadKey((current) => ({
            ...current,
            [routeThreadKey]: (current[routeThreadKey] ?? []).filter(
              (entry) => entry.id !== submission.id,
            ),
          }));
        });
        return item ? [item] : [];
      }),
    [feedbackSubmissions, routeThreadKey],
  );
  const composerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const backgroundLivenessItems =
      backgroundLivenessBannerItem === null ? [] : [backgroundLivenessBannerItem];
    const turnStallItems = turnStallNoticeItem === null ? [] : [turnStallNoticeItem];
    const resumeCompactionItems =
      resumeCompactionBannerItem === null ? [] : [resumeCompactionBannerItem];
    const wokeThreadItems = wokeThreadBannerItem === null ? [] : [wokeThreadBannerItem];
    const parkedThreadItems = parkedThreadBannerItem === null ? [] : [parkedThreadBannerItem];
    // The user asked for this one, so it leads the notice tier instead of trailing it.
    const usageLimitsItems = usageLimitsBanner === null ? [] : [usageLimitsBanner];
    const projectCloneItems = projectCloneBannerItem === null ? [] : [projectCloneBannerItem];
    const projectMemoryRecoveryItems =
      projectMemoryRecoveryBannerItem === null ? [] : [projectMemoryRecoveryBannerItem];
    if (!localCheckoutBranchMismatch || !showBranchMismatchBanner || !activeBranchMismatchKey) {
      return [
        ...feedbackBannerItems,
        ...usageLimitsItems,
        ...projectCloneItems,
        ...projectMemoryRecoveryItems,
        ...systemComposerBannerItems,
        ...backgroundLivenessItems,
        ...turnStallItems,
        ...resumeCompactionItems,
        ...wokeThreadItems,
        ...parkedThreadItems,
      ];
    }
    return [
      ...feedbackBannerItems,
      ...usageLimitsItems,
      ...projectCloneItems,
      ...projectMemoryRecoveryItems,
      ...systemComposerBannerItems,
      ...backgroundLivenessItems,
      ...turnStallItems,
      ...resumeCompactionItems,
      ...wokeThreadItems,
      {
        id: `branch-mismatch:${activeBranchMismatchKey}`,
        variant: "info",
        icon: <GitBranchIcon />,
        title: (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-normal text-muted-foreground">Branch changed — was</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <code className="min-w-0 truncate font-medium text-foreground">
                    {localCheckoutBranchMismatch.threadBranch}
                  </code>
                }
              />
              <TooltipPopup side="top">
                This thread last ran on {localCheckoutBranchMismatch.threadBranch}. Sending will
                continue on {localCheckoutBranchMismatch.currentBranch}.
              </TooltipPopup>
            </Tooltip>
          </span>
        ),
        actions: (
          <Button
            size="xs"
            variant="ghost"
            disabled={isRestoringThreadBranch}
            onClick={handleRestoreThreadBranch}
          >
            {isRestoringThreadBranch ? "Restoring..." : "Restore branch"}
          </Button>
        ),
        dismissLabel: "Dismiss branch change notice",
        onDismiss: () => {
          dismissBranchMismatchForSession(activeBranchMismatchKey);
          setBranchMismatchDismissTick((tick) => tick + 1);
        },
      },
      ...parkedThreadItems,
    ];
  }, [
    activeBranchMismatchKey,
    backgroundLivenessBannerItem,
    feedbackBannerItems,
    handleRestoreThreadBranch,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    parkedThreadBannerItem,
    projectCloneBannerItem,
    projectMemoryRecoveryBannerItem,
    resumeCompactionBannerItem,
    showBranchMismatchBanner,
    systemComposerBannerItems,
    turnStallNoticeItem,
    usageLimitsBanner,
    wokeThreadBannerItem,
  ]);
  useEffect(() => {
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [activeThread?.id]);

  useEffect(() => {
    if (canOverrideServerThreadEnvMode) {
      return;
    }
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [canOverrideServerThreadEnvMode]);

  useEffect(() => {
    if (!activeThreadId) {
      setTerminalUiLaunchContext(null);
      return;
    }
    setTerminalUiLaunchContext((current) => {
      if (!current) return current;
      if (current.threadId === activeThreadId) return current;
      return null;
    });
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThreadId || !activeProjectCwd) {
      return;
    }
    setTerminalUiLaunchContext((current) => {
      if (!current || current.threadId !== activeThreadId) {
        return current;
      }
      const settledCwd = projectScriptCwd({
        project: { cwd: activeProjectCwd },
        worktreePath: activeThreadWorktreePath,
      });
      if (
        settledCwd === current.cwd &&
        (activeThreadWorktreePath ?? null) === current.worktreePath
      ) {
        return null;
      }
      return current;
    });
  }, [activeProjectCwd, activeThreadId, activeThreadWorktreePath]);

  useEffect(() => {
    if (terminalUiState.terminalOpen) {
      return;
    }
    setTerminalUiLaunchContext((current) =>
      current?.threadId === activeThreadId ? null : current,
    );
  }, [activeThreadId, terminalUiState.terminalOpen]);

  useEffect(() => {
    if (!activeThreadKey) return;
    const previous = terminalUiOpenByThreadRef.current[activeThreadKey] ?? false;
    const current = Boolean(terminalUiState.terminalOpen);

    if (!previous && current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalUiOpenByThreadRef.current[activeThreadKey] = current;
  }, [activeThreadKey, focusComposer, terminalUiState.terminalOpen]);

  return {
    copyActiveThreadReference,
    supportsSettlement,
    activeThreadSettled,
    handleUnsettleActiveThread,
    supportsPinning,
    activeThreadPinned,
    compactDisabled,
    localCheckoutBranchMismatch,
    acknowledgeActiveThreadWoke,
    activeThreadBranch,
    sendEnvMode,
    startFromOrigin,
    canOverrideServerThreadEnvMode,
    composerBannerItems,
    activeComposerTasksProgress,
    activeComposerTaskSteps,
    compactThreadUnavailable,
    compactDisabledReason,
    publishComposerOverlayHeight,
    onComposerRestingChange,
    envMode,
    projectMemoryRecoveryDialog,
    branchRestoreConfirmOpen,
    setBranchRestoreConfirmOpen,
    handleSwitchCheckoutToThread,
    addPullRequestSurface,
    pullRequestSurfaceAvailable,
    activeWorktreePath,
    closeExpandedImage,
  };
}
