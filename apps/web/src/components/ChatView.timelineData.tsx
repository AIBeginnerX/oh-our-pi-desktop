import { useT } from "../i18n";
import { runningCrewAudit, completedCrewAuditCount } from "@t3tools/client-runtime/crew-board";
import { collectProviderUsageLimits, hasProviderUsageLimits } from "@t3tools/shared/usageLimits";
import { usageLimitsBannerItem } from "./chat/ComposerUsageLimits";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import {
  questionAttachmentDraftId,
  questionAttachmentDraftPrefix,
  clearQuestionAttachmentDraft,
  useQuestionAttachmentPreparation,
} from "../questionAttachments";
import { useAttachmentUploadStore } from "../lib/attachmentUploadQueue";
import { type ChatFileAttachment, type MessageId } from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  createMessageAttachmentPreviewProjector,
  derivePhase,
  deriveTimelineEntriesWithState,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasActionableProposedPlan,
  selectHandoffImageResources,
  type TimelineEntriesProjection,
} from "../session-logic";
import { buildPendingUserInputAnswers, derivePendingUserInputProgress } from "../pendingUserInput";
import { latestWorkspaceMutationId } from "../hooks/useWorkspaceMutationRefresh";
import { DEFAULT_INTERACTION_MODE, type ChatMessage, isImageAttachment } from "../types";
import { useRightPanelStore } from "../rightPanelStore";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { WifiOffIcon } from "lucide-react";
import { toastManager } from "./ui/toast";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { getAppModelOptionsForInstance } from "../modelSelection";
import { getTriggerDisplayModelName } from "./chat/providerIconUtils";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { worktreeSetupAgentStarted } from "./chat/MessagesTimeline.logic";
import type { ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import { deriveLatestContextWindowSnapshot } from "../lib/contextWindow";
import { useThreadUsageSummary } from "../state/threadUsageSummary";
import { formatCrewAuditFooter, formatThreadUsageFooter } from "./chat/threadUsageText";
import {
  latestTurnStartFailureId,
  shouldShowPlanFollowUpPrompt,
  resolveFileAttachmentUrl,
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
  findRecordedWorktreeSetup,
  resolveVisibleWorktreeSetup,
  isPaintOnlyThreadTimeline,
  peekRememberedThreadTimeline,
  resolveThreadSwitchTimeline,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
} from "./ChatView.logic";
import { readPreparedConnection } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ServerUpdateAction } from "./ServerUpdateAction";
import {
  ComposerServerUpdateIcon,
  ComposerServerUpdateStatus,
} from "./chat/ComposerServerUpdateStatus";
import {
  dismissServerUpdateFailure,
  dismissVersionMismatch,
  serverUpdateGuidance,
} from "../versionSkew";
import { useAssetUrls } from "../assets/assetUrls";
import {
  EMPTY_ACTIVITIES,
  EMPTY_USAGE_LIMIT_SOURCES,
  EMPTY_PENDING_USER_INPUT_ANSWERS,
  isCompactCommandMessage,
} from "./ChatView.helpers";
import { useLocalDispatchState } from "./ChatView.localHooks";
import type { useChatViewThreadState } from "./ChatView.threadState";
import type { useChatViewProjectAndEnvironment } from "./ChatView.projectEnvironment";

export function useChatViewTimelineData({
  threadState,
  projectEnvironment,
}: {
  threadState: ReturnType<typeof useChatViewThreadState>;
  projectEnvironment: ReturnType<typeof useChatViewProjectAndEnvironment>;
}) {
  const {
    settings,
    activeThread,
    composerInteractionMode,
    environmentId,
    activeThreadId,
    routeThreadState,
    pendingUserInputAnswersByRequestId,
    pendingUserInputQuestionIndexByRequestId,
    respondingUserInputRequestIds,
    composerHasAttachments,
    isServerThread,
    routeThreadKey,
    threadError,
    optimisticUserMessages,
    routeThreadRef,
    activeServerThread,
    isConnecting,
    isRevertingCheckpoint,
    attachmentPreviewHandoffByMessageIdRef,
    attachmentPreviewHandoffByMessageId,
    attachmentPreviewPromotionInFlightByMessageIdRef,
    setAttachmentPreviewHandoffByMessageId,
    optimisticUserMessagesRef,
    createAttachmentAssetUrl,
    activeThreadRef,
    activeThreadKey,
    threadSyncPhase,
    heldWorktreeSetup,
    setHeldWorktreeSetup,
    activeThreadShell,
    storeEnsureTerminal,
  } = threadState;
  const {
    serverUpdateState,
    activeEnvironmentUnavailableState,
    canDisconnectActiveEnvironment,
    disconnectingEnvironment,
    handleDisconnectActiveEnvironment,
    reconnectWarningGraceElapsed,
    handleReconnectActiveEnvironment,
    automaticEnvironment,
    serverUpdateEnvironmentId,
    showVersionMismatchBanner,
    serverUpdateFailureDismissed,
    versionMismatchServerLabel,
    versionMismatch,
    versionMismatchSelfUpdate,
    versionMismatchDesktopAppUpdate,
    versionMismatchThreadContinuation,
    versionMismatchDismissKey,
    setDismissedServerUpdateState,
    setDismissedVersionMismatchKey,
    autoBalanceUpdateBanner,
    providerStatuses,
    selectedProviderByThreadId,
    activeProjectDefaultModelSelection,
    lockedProvider,
    supportsQuestionAttachments,
    latestTurnSettled,
    activeLatestTurn,
    serverConfig,
  } = projectEnvironment;

  const systemComposerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
    const updateRunning = serverUpdateState.status === "running";
    const unavailableConnection = activeEnvironmentUnavailableState?.connection ?? null;
    const disconnectAction =
      canDisconnectActiveEnvironment && activeEnvironmentUnavailableState ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={disconnectingEnvironment}
          title="Hide this server's threads. Switch it on again in Connections."
          onClick={() =>
            void handleDisconnectActiveEnvironment(activeEnvironmentUnavailableState.environmentId)
          }
        >
          Disconnect server
        </Button>
      ) : undefined;
    const environmentReconnecting =
      unavailableConnection !== null &&
      (unavailableConnection.phase === "connecting" ||
        unavailableConnection.phase === "reconnecting");
    // While an update runs, transient connect blips are expected (the server
    // restarts) and the update banner already shows progress. Hard failure
    // phases still surface so the Reconnect action stays reachable.
    const suppressUnavailableBanner =
      environmentReconnecting && (updateRunning || !reconnectWarningGraceElapsed);
    if (activeEnvironmentUnavailableState && unavailableConnection && !suppressUnavailableBanner) {
      items.push({
        id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
        variant: unavailableConnection.phase === "error" ? "error" : "warning",
        icon: <WifiOffIcon />,
        title: `${activeEnvironmentUnavailableState.label} is ${environmentReconnecting ? "reconnecting" : "offline"}`,
        actions: (
          <>
            {!environmentReconnecting ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void handleReconnectActiveEnvironment(
                    activeEnvironmentUnavailableState.environmentId,
                  )
                }
              >
                Reconnect
              </Button>
            ) : null}
            {disconnectAction}
          </>
        ),
      });
    }
    if (
      !automaticEnvironment &&
      serverUpdateEnvironmentId &&
      (serverUpdateState.status === "idle"
        ? showVersionMismatchBanner
        : !serverUpdateFailureDismissed)
    ) {
      const updateInProgress = serverUpdateState.status === "running";
      const updateFailed = serverUpdateState.status === "failed";
      items.push({
        id: `server-version:${serverUpdateEnvironmentId}`,
        variant: updateFailed ? "error" : "default",
        // Prioritize update progress over passive notices, but keep activity attached.
        priority: updateInProgress ? "urgent" : "notice",
        icon: <ComposerServerUpdateIcon status={serverUpdateState.status} />,
        title:
          updateInProgress || updateFailed ? (
            <ComposerServerUpdateStatus
              state={serverUpdateState}
              serverLabel={versionMismatchServerLabel}
            />
          ) : versionMismatch ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="block max-w-full cursor-help truncate rounded-sm text-left"
                  >
                    Server update available
                  </button>
                }
              />
              <TooltipPopup side="top">
                {versionMismatchServerLabel} {versionMismatch.serverVersion}{" "}
                <span aria-hidden="true">→</span> {versionMismatch.clientVersion}
              </TooltipPopup>
            </Tooltip>
          ) : (
            "Server update available"
          ),
        description:
          !updateInProgress &&
          !updateFailed &&
          versionMismatchSelfUpdate !== null &&
          (versionMismatchSelfUpdate !== "desktop-managed" || !versionMismatchDesktopAppUpdate)
            ? serverUpdateGuidance(versionMismatchSelfUpdate)
            : undefined,
        actions: updateInProgress ? (
          disconnectAction
        ) : !versionMismatch ||
          (versionMismatchSelfUpdate === "desktop-managed" &&
            !versionMismatchDesktopAppUpdate) ? undefined : (
          <ServerUpdateAction
            environmentId={serverUpdateEnvironmentId}
            serverLabel={versionMismatchServerLabel}
            selfUpdate={versionMismatchSelfUpdate}
            desktopAppUpdate={versionMismatchDesktopAppUpdate}
            threadContinuation={versionMismatchThreadContinuation}
            targetVersion={versionMismatch.clientVersion}
            label={updateFailed ? "Retry" : "Update"}
            variant="ghost"
          />
        ),
        ...(updateInProgress || (!updateFailed && !versionMismatchDismissKey)
          ? {}
          : {
              dismissLabel: "Dismiss update notice",
              onDismiss: () => {
                if (updateFailed) {
                  dismissServerUpdateFailure(serverUpdateState);
                  setDismissedServerUpdateState(serverUpdateState);
                }
                dismissVersionMismatch(versionMismatchDismissKey);
                setDismissedVersionMismatchKey(versionMismatchDismissKey);
              },
            }),
      });
    }
    if (autoBalanceUpdateBanner) items.push(autoBalanceUpdateBanner);
    return items;
  }, [
    automaticEnvironment,
    autoBalanceUpdateBanner,
    activeEnvironmentUnavailableState,
    reconnectWarningGraceElapsed,
    handleReconnectActiveEnvironment,
    canDisconnectActiveEnvironment,
    disconnectingEnvironment,
    handleDisconnectActiveEnvironment,
    setDismissedVersionMismatchKey,
    showVersionMismatchBanner,
    serverUpdateFailureDismissed,
    serverUpdateState,
    versionMismatch,
    versionMismatchDismissKey,
    serverUpdateEnvironmentId,
    versionMismatchSelfUpdate,
    versionMismatchDesktopAppUpdate,
    versionMismatchThreadContinuation,
    versionMismatchServerLabel,
  ]);
  const providerInstanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings],
  );
  const { selectedProviderEntry, requestedDriverKind } = useMemo(
    () =>
      resolveComposerProviderSelection({
        entries: providerInstanceEntries,
        candidateInstanceIds: [
          selectedProviderByThreadId,
          activeThread?.session?.providerInstanceId,
          activeThread?.modelSelection.instanceId,
          activeProjectDefaultModelSelection?.instanceId,
        ],
        lockedProvider,
        lockedInstanceId:
          activeThread?.session?.providerInstanceId ?? activeThread?.modelSelection.instanceId,
      }),
    [
      activeProjectDefaultModelSelection?.instanceId,
      activeThread?.modelSelection.instanceId,
      activeThread?.session?.providerInstanceId,
      lockedProvider,
      providerInstanceEntries,
      selectedProviderByThreadId,
    ],
  );
  const selectedProvider = selectedProviderEntry?.driverKind ?? requestedDriverKind;
  const activeProviderInstanceId = selectedProviderEntry?.instanceId ?? null;
  const activeProviderStatus = selectedProviderEntry?.snapshot ?? null;
  const { enabled: interactionModeEnabled, interactionMode } = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: activeProviderStatus,
    interactionMode:
      composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
  });
  const conversationProviderStatus =
    providerStatuses.find(
      (status) => status.instanceId === activeThread?.session?.providerInstanceId,
    ) ?? activeProviderStatus;
  const supportsConversationRollback =
    conversationProviderStatus !== null &&
    conversationProviderStatus.supportsConversationRollback !== false;
  const phase = derivePhase(activeThread?.session ?? null);
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const latestCheckpointCompletedAt = activeThread?.checkpoints.at(-1)?.completedAt ?? null;
  const workspaceMutationId = useMemo(() => {
    const activityId = latestWorkspaceMutationId(threadActivities);
    return activityId === null && latestCheckpointCompletedAt === null
      ? null
      : JSON.stringify([activityId, latestCheckpointCompletedAt]);
  }, [latestCheckpointCompletedAt, threadActivities]);
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(threadActivities),
    [threadActivities],
  );
  const t = useT();
  const audit = useMemo(() => runningCrewAudit(threadActivities), [threadActivities]);
  const completedAuditCount = useMemo(
    () => completedCrewAuditCount(threadActivities),
    [threadActivities],
  );
  // The chat usage footer read: fetched on thread open, turn settle, and audit completion.
  const threadUsageSummary = useThreadUsageSummary({
    environmentId,
    threadId: activeThreadId,
    latestTurnId: activeLatestTurn?.turnId ?? null,
    latestTurnSettled,
    auditRunning: audit !== null,
    completedAuditCount,
  });
  const workLogEntries = useMemo(() => deriveWorkLogEntries(threadActivities), [threadActivities]);
  // Native subagent fold: memoized by activity-list identity, shared by the
  // Agents surface, live strip, and workflow cards. v2Projection is null
  // until orchestration-v2 lands (source precedence lives in the derive).
  // sessionLive derives interruption for agents orphaned by session death.
  const agentSessionLive = phase !== "disconnected";
  const leadModelSlug = activeThread?.modelSelection.model ?? null;
  const leadInstanceId = activeThread?.modelSelection.instanceId ?? null;
  // The lead's model as the composer's picker names it ("Claude Opus 5.5"), not its slug.
  const leadModel = useMemo(() => {
    if (leadModelSlug === null) return null;
    const entry = providerInstanceEntries.find(
      (candidate) => candidate.instanceId === leadInstanceId,
    );
    const option = entry
      ? getAppModelOptionsForInstance(settings, entry, leadModelSlug).find(
          (candidate) => candidate.slug === leadModelSlug,
        )
      : undefined;
    return option ? getTriggerDisplayModelName(option) : leadModelSlug;
  }, [leadInstanceId, leadModelSlug, providerInstanceEntries, settings]);
  const agentPanelLead = useMemo(
    () => ({
      model: leadModel,
      instanceId: leadInstanceId === null ? null : String(leadInstanceId),
    }),
    [leadModel, leadInstanceId],
  );
  const agentPanelModel = useMemo(
    () =>
      deriveAgentPanelModel({
        agents: foldSubagentActivities(threadActivities, { sessionLive: agentSessionLive }),
      }),
    [agentSessionLive, threadActivities],
  );
  const { approvals: pendingApprovals, userInputs: pendingUserInputs } = useMemo(
    () => derivePendingRequests(threadActivities),
    [threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingRequestKey = JSON.stringify([
    environmentId,
    activeThreadId,
    activePendingUserInput?.requestId,
  ]);
  const pendingQuestionDraftKeys = useMemo(
    () =>
      activeThreadId
        ? pendingUserInputs.flatMap((request) =>
            request.questions.map((question) =>
              questionAttachmentDraftId(
                environmentId,
                activeThreadId,
                request.requestId,
                question.id,
              ),
            ),
          )
        : [],
    [activeThreadId, environmentId, pendingUserInputs],
  );
  const questionComposerDrafts = useComposerDraftStore(
    useShallow((state) =>
      Object.fromEntries(
        pendingQuestionDraftKeys.map((key) => [key, state.draftsByThreadKey[key]]),
      ),
    ),
  );
  const questionUploadsBlocked = useAttachmentUploadStore(
    useShallow((state) =>
      Object.fromEntries(
        pendingQuestionDraftKeys.map((key) => {
          const draft = questionComposerDrafts[key];
          const attachments = draft ? [...draft.images, ...draft.files] : [];
          return [
            key,
            attachments.some((attachment) => {
              const upload = state.uploadsByImageId[attachment.id];
              return upload?.status !== "ready" || upload.environmentId !== environmentId;
            }),
          ];
        }),
      ),
    ),
  );
  const questionPreparations = useQuestionAttachmentPreparation(
    useShallow((state) =>
      Object.fromEntries(pendingQuestionDraftKeys.map((key) => [key, state.counts[key] ?? 0])),
    ),
  );
  useEffect(() => {
    if (routeThreadState.status !== "live" || routeThreadState.data._tag !== "Some") return;
    const questionThread = routeThreadState.data.value;
    const { userInputs: currentRequests } = derivePendingRequests(questionThread.activities);
    const prefix = questionAttachmentDraftPrefix(environmentId, questionThread.id);
    const retained = new Set(
      currentRequests.flatMap((request) =>
        request.questions.map((question) =>
          questionAttachmentDraftId(
            environmentId,
            questionThread.id,
            request.requestId,
            question.id,
          ),
        ),
      ),
    );
    const keys = new Set([
      ...Object.keys(useComposerDraftStore.getState().draftsByThreadKey),
      ...Object.keys(useQuestionAttachmentPreparation.getState().counts),
    ]);
    for (const key of keys) {
      if (key.startsWith(prefix) && !retained.has(DraftId.make(key)))
        clearQuestionAttachmentDraft(DraftId.make(key));
    }
  }, [environmentId, routeThreadState.data, routeThreadState.status]);
  const activePendingDraftAnswers = useMemo(() => {
    if (!activePendingUserInput || !activeThreadId) return EMPTY_PENDING_USER_INPUT_ANSWERS;
    return Object.fromEntries(
      activePendingUserInput.questions.map((question) => {
        const key = questionAttachmentDraftId(
          environmentId,
          activeThreadId,
          activePendingUserInput.requestId,
          question.id,
        );
        const draft = questionComposerDrafts[key];
        const attachments = draft ? [...draft.images, ...draft.files] : [];
        return [
          question.id,
          {
            ...pendingUserInputAnswersByRequestId[activePendingRequestKey]?.[question.id],
            attachmentCount: attachments.length,
            attachmentsBlocked:
              (attachments.length > 0 && !supportsQuestionAttachments) ||
              (questionPreparations[key] ?? 0) > 0 ||
              questionUploadsBlocked[key] === true,
          },
        ];
      }),
    );
  }, [
    activePendingUserInput,
    activeThreadId,
    environmentId,
    questionComposerDrafts,
    questionUploadsBlocked,
    supportsQuestionAttachments,
    questionPreparations,
    pendingUserInputAnswersByRequestId,
    activePendingRequestKey,
  ]);
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingRequestKey] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const showPlanFollowUpPrompt = shouldShowPlanFollowUpPrompt({
    pendingUserInputCount: pendingUserInputs.length,
    interactionMode,
    latestTurnSettled,
    hasActionableProposedPlan: hasActionableProposedPlan(activeProposedPlan),
    hasComposerAttachments: composerHasAttachments,
  });
  const activePendingApproval = pendingApprovals[0] ?? null;
  // The open /usage-limits panel for this thread, model and turn. Only the open
  // moment is stored: the rows read live provider data, so a redeemed reset
  // credit or refreshed probe shows through. Anything that spends quota closes
  // it: a new turn from any source, or the agent resuming after an approval or
  // answered question.
  const [usageLimitsPanel, setUsageLimitsPanel] = useState<{
    readonly key: string;
    readonly threadKey: string;
    readonly now: number;
  } | null>(null);
  // Null while the provider list or the thread itself is unavailable, such as
  // during a reconnect; the panel then stays hidden rather than being dropped.
  // A pending approval or question is part of the key: once it is answered,
  // from this client or any other, the agent resumes and spends quota.
  const usageLimitsKey =
    activeProviderInstanceId === null || (isServerThread && activeThread === undefined)
      ? null
      : [
          routeThreadKey,
          activeProviderInstanceId,
          activeThread?.latestTurn?.turnId ?? "",
          activePendingApproval?.requestId ?? activePendingUserInput?.requestId ?? "",
        ].join(":");
  // Drop the snapshot as soon as the thread or model changes so it cannot resurface stale.
  if (
    usageLimitsPanel !== null &&
    usageLimitsKey !== null &&
    usageLimitsPanel.key !== usageLimitsKey
  ) {
    setUsageLimitsPanel(null);
  }
  const usageLimitSources = serverConfig?.usageLimitSources ?? EMPTY_USAGE_LIMIT_SOURCES;
  const usageLimitsReport = useMemo(
    () =>
      usageLimitsPanel !== null &&
      usageLimitsKey !== null &&
      usageLimitsPanel.key === usageLimitsKey &&
      activeProviderInstanceId !== null
        ? collectProviderUsageLimits(
            activeProviderInstanceId,
            providerStatuses,
            usageLimitSources,
            usageLimitsPanel.now,
          )
        : null,
    [
      activeProviderInstanceId,
      providerStatuses,
      usageLimitSources,
      usageLimitsKey,
      usageLimitsPanel,
    ],
  );
  const usageLimitsBanner = useMemo(
    () =>
      usageLimitsReport !== null && usageLimitsPanel !== null
        ? // A fresh id per opening: the stack keeps the last dismissed id as "exiting".
          usageLimitsBannerItem(
            `usage-limits:${usageLimitsPanel.key}:${usageLimitsPanel.now}`,
            usageLimitsReport,
            environmentId,
            () => setUsageLimitsPanel(null),
          )
        : null,
    [environmentId, usageLimitsPanel, usageLimitsReport],
  );
  // T3 owns /usage-limits only where Limits has data for the selected provider;
  // elsewhere the name stays the provider's own and is sent through untouched.
  const usageLimitsOffered =
    activeProviderStatus !== null &&
    hasProviderUsageLimits(activeProviderStatus.driver, providerStatuses, usageLimitSources);
  // Answered locally from the last Limits snapshot; the agent never sees it.
  const openUsageLimits = useCallback(() => {
    const now = Date.now();
    const report =
      activeProviderInstanceId !== null && usageLimitsKey !== null
        ? collectProviderUsageLimits(
            activeProviderInstanceId,
            providerStatuses,
            usageLimitSources,
            now,
          )
        : null;
    if (report && usageLimitsKey !== null) {
      setUsageLimitsPanel({ key: usageLimitsKey, threadKey: routeThreadKey, now });
      return true;
    }
    setUsageLimitsPanel(null);
    toastManager.add({ type: "info", title: "Usage limits are unavailable for this provider" });
    return false;
  }, [
    activeProviderInstanceId,
    providerStatuses,
    routeThreadKey,
    usageLimitSources,
    usageLimitsKey,
  ]);
  // Responses can resolve after navigating away; only the originating thread's panel clears.
  const clearUsageLimitsFor = useCallback(
    (threadKey: string) =>
      setUsageLimitsPanel((current) =>
        current !== null && current.threadKey === threadKey ? null : current,
      ),
    [],
  );
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    latestUserMessageAt,
    isPreparingWorktree: isLocallyPreparingWorktree,
    isSendBusy,
    backgroundSubmissionPending,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError,
  });
  const optimisticCompactionMessage = optimisticUserMessages.at(-1);
  const pendingCompactionMessage =
    isSendBusy &&
    optimisticCompactionMessage !== undefined &&
    isCompactCommandMessage(optimisticCompactionMessage)
      ? optimisticCompactionMessage
      : activeThread?.messages.findLast(isCompactCommandMessage);
  const compactRequestIsActive =
    pendingCompactionMessage !== undefined &&
    (pendingCompactionMessage.createdAt >
      (activeLatestTurn?.requestedAt ?? pendingCompactionMessage.createdAt) ||
      (activeLatestTurn?.state === "running" &&
        pendingCompactionMessage.createdAt === activeLatestTurn.requestedAt));
  const compactionSettled =
    pendingCompactionMessage !== undefined &&
    (latestTurnStartFailureId(activeThread, pendingCompactionMessage.id) !== null ||
      activeThread?.activities.some((activity) => {
        if (activity.kind !== "context-compaction") return false;
        const payload = activity.payload as { readonly requestId?: unknown } | null | undefined;
        return payload?.requestId === pendingCompactionMessage.id;
      }));
  const isCompacting =
    (isSendBusy || phase === "connecting" || phase === "running") &&
    compactRequestIsActive &&
    !compactionSettled;
  // The server records a running worktree setup on the thread for the whole
  // bootstrap window. That record, with no turn yet, is how a reload or another
  // client sees a worktree still being prepared, so it counts as working like
  // the local dispatch that started it. It settles on every failure path and
  // on restart, so this cannot outlive the setup. The placeholder "starting"
  // session is not used here: an ordinary first turn projects one too, and it
  // already drives the connecting state on its own.
  const recordedWorktreeSetup = useMemo(
    () => findRecordedWorktreeSetup(activeThread?.activities ?? [], routeThreadRef.threadId),
    [activeThread?.activities, routeThreadRef.threadId],
  );
  const awaitingBootstrapTurn =
    activeServerThread !== null &&
    activeServerThread.id === routeThreadRef.threadId &&
    activeServerThread.latestTurn === null &&
    recordedWorktreeSetup?.phase === "running";
  const isWorking =
    phase === "running" ||
    isSendBusy ||
    isConnecting ||
    isRevertingCheckpoint ||
    isCompacting ||
    awaitingBootstrapTurn;
  // Hidden while anything is running, so the line never flickers per update.
  const threadUsageFooter = useMemo(
    () =>
      isWorking
        ? ""
        : audit
          ? formatCrewAuditFooter(audit, t)
          : formatThreadUsageFooter(threadUsageSummary, activeContextWindow),
    [activeContextWindow, isWorking, threadUsageSummary, audit, t],
  );
  const isPreparingWorktree = isLocallyPreparingWorktree || awaitingBootstrapTurn;
  const needsInput = pendingApprovals.length > 0 || pendingUserInputs.length > 0;
  const pillWorking = isWorking && !isRevertingCheckpoint;
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
    latestUserMessageAt,
  );
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoff = useCallback(
    (messageId: MessageId, previewUrls?: ReadonlyArray<string>) => {
      delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
      const currentPreviewUrls =
        previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) {
          return existing;
        }
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      for (const previewUrl of currentPreviewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    },
    [],
  );
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const nextPreviewUrlSet = new Set(previewUrls);
    for (const previewUrl of previousPreviewUrls) {
      if (!nextPreviewUrlSet.has(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
  }, []);
  const serverMessages = activeThread?.messages;
  const [projectServerMessagePreviews] = useState(createMessageAttachmentPreviewProjector);
  const [projectHandoffMessagePreviews] = useState(createMessageAttachmentPreviewProjector);
  const downloadFileAttachment = useCallback(
    async (attachment: ChatFileAttachment) => {
      const connection = readPreparedConnection(environmentId);
      if (!connection) {
        toastManager.add({ type: "error", title: "The environment is not connected." });
        return;
      }

      try {
        const url = await resolveFileAttachmentUrl({
          attachment,
          environmentId,
          httpBaseUrl: connection.httpBaseUrl,
          createAssetUrl: createAttachmentAssetUrl,
        });
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = attachment.name;
        anchor.click();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not download " + attachment.name,
          description: error instanceof Error ? error.message : "The attachment is unavailable.",
        });
      }
    },
    [createAttachmentAssetUrl, environmentId],
  );
  const openFileAttachment = useCallback(
    (attachment: ChatFileAttachment) => {
      if (activeThreadRef) {
        useRightPanelStore.getState().openAttachment(activeThreadRef, attachment);
        return;
      }
    },
    [activeThreadRef],
  );
  const serverAttachmentResources = useMemo(
    () => selectHandoffImageResources(serverMessages, attachmentPreviewHandoffByMessageId),
    [serverMessages, attachmentPreviewHandoffByMessageId],
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = useMemo(
    () =>
      new Map(
        serverAttachmentResources.flatMap((resource, index) => {
          const url = serverAttachmentUrls[index];
          return url ? [[resource.attachmentId, url] as const] : [];
        }),
      ),
    [serverAttachmentResources, serverAttachmentUrls],
  );
  const displayServerMessages = useMemo<ReadonlyArray<ChatMessage>>(() => {
    if (!serverMessages) return [];
    return serverMessages.map((message) =>
      projectServerMessagePreviews(message, (attachment) =>
        serverAttachmentUrlById.get(attachment.id),
      ),
    );
  }, [projectServerMessagePreviews, serverAttachmentUrlById, serverMessages]);
  useEffect(() => {
    if (typeof Image === "undefined" || displayServerMessages.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];
    const userMessagesById = new Map<string, ChatMessage>(
      displayServerMessages
        .filter((message) => message.role === "user")
        .map((message) => [String(message.id), message] as const),
    );

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
        continue;
      }

      const serverMessage = userMessagesById.get(messageId);
      if (!serverMessage?.attachments || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        isImageAttachment(attachment) && attachment.previewUrl ? [attachment.previewUrl] : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoff(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => {
          if (!cancelled) {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          }
        });

      cleanups.push(() => {
        cancelled = true;
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [attachmentPreviewHandoffByMessageId, clearAttachmentPreviewHandoff, displayServerMessages]);
  const timelineMessages = useMemo(() => {
    const messages = displayServerMessages;
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let imageIndex = 0;
            return projectHandoffMessagePreviews(message, (attachment) => {
              if (!isImageAttachment(attachment)) {
                return undefined;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              return handoffPreviewUrl;
            });
          });

    const localMessages = optimisticUserMessages;
    if (localMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = localMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [
    attachmentPreviewHandoffByMessageId,
    displayServerMessages,
    optimisticUserMessages,
    projectHandoffMessagePreviews,
  ]);
  const timelineProjectionRef = useRef<{
    threadKey: string | null;
    projection: TimelineEntriesProjection;
  } | null>(null);
  const timelineEntries = useMemo(() => {
    const previous = timelineProjectionRef.current;
    const projection = deriveTimelineEntriesWithState(
      timelineMessages,
      activeThread?.proposedPlans ?? [],
      workLogEntries,
      previous?.threadKey === activeThreadKey ? previous.projection : null,
    );
    timelineProjectionRef.current = { threadKey: activeThreadKey, projection };
    return projection.entries;
  }, [
    timelineProjectionRef,
    activeThreadKey,
    activeThread?.proposedPlans,
    timelineMessages,
    workLogEntries,
  ]);
  const displayedTimeline = resolveThreadSwitchTimeline({
    loading: timelineEntries.length === 0 && threadSyncPhase !== null,
    activeThreadKey,
    nextEntries: timelineEntries,
    rememberedForActive: peekRememberedThreadTimeline<typeof timelineEntries>(activeThreadKey),
  });
  const displayedTimelineKey = displayedTimeline.displayThreadKey ?? routeThreadKey;
  const paintOnlyDisplayedTimeline = isPaintOnlyThreadTimeline(
    displayedTimeline.displayThreadKey,
    activeThreadKey,
  );
  const displayedThreadRef = parseScopedThreadKey(displayedTimelineKey);
  // Live stages of a bootstrap worktree setup. A worktree send creates the
  // server thread under the route's thread id before anything else, so the
  // stream is keyed by that id alone: no owner bookkeeping, and a remount,
  // reload, or second client picks it up the same way. The subscription is
  // held only while a snapshot can still change.
  const routeThreadPreparesWorktree =
    (isPreparingWorktree && activeThread?.id === routeThreadRef.threadId) ||
    heldWorktreeSetup?.phase === "running";
  const worktreeSetupQuery = useEnvironmentQuery(
    routeThreadPreparesWorktree
      ? vcsEnvironment.worktreeSetup({
          environmentId: routeThreadRef.environmentId,
          input: { threadId: routeThreadRef.threadId },
        })
      : null,
  );
  const latestWorktreeSetup = worktreeSetupQuery.data;
  useEffect(() => {
    if (latestWorktreeSetup) setHeldWorktreeSetup(latestWorktreeSetup);
  }, [latestWorktreeSetup]);
  useEffect(() => {
    setHeldWorktreeSetup(null);
  }, [routeThreadKey]);
  const liveWorktreeSetup =
    heldWorktreeSetup?.threadId === routeThreadRef.threadId ? heldWorktreeSetup : null;
  const worktreeSetup = resolveVisibleWorktreeSetup({
    live: liveWorktreeSetup,
    recorded: recordedWorktreeSetup,
    turnStarted: activeThread?.latestTurn?.startedAt != null,
    // Counts the optimistic send too, so the row retires the moment the
    // follow-up is on screen rather than when the server echoes it back.
    followUpSent: timelineMessages.filter((message) => message.role === "user").length > 1,
  });
  // Sends wait for the agent handoff, not for the setup script: an async
  // script keeps the snapshot running while the agent already works, and a
  // follow-up must not be held behind a slow install. Before the first
  // snapshot arrives the starting session stands in for it.
  const worktreeSetupBlocksSend =
    worktreeSetup !== null
      ? worktreeSetup.phase === "running" && !worktreeSetupAgentStarted(worktreeSetup)
      : isServerThread &&
        activeThreadShell?.session?.status === "starting" &&
        activeThreadShell.latestTurn === null;
  const cancelWorktreeSetup = useAtomCommand(vcsEnvironment.cancelWorktreeSetup, {
    reportFailure: false,
  });
  const onCancelWorktreeSetup = useCallback(() => {
    if (!worktreeSetup || worktreeSetup.phase !== "running") return;
    void cancelWorktreeSetup({
      environmentId: routeThreadRef.environmentId,
      input: { threadId: worktreeSetup.threadId },
    });
  }, [cancelWorktreeSetup, routeThreadRef.environmentId, worktreeSetup]);
  // The setup terminal belongs to the thread that was set up. A failed
  // bootstrap deletes that thread and closes its terminals, so only offer the
  // terminal while the setup thread is still the active one.
  const onOpenWorktreeSetupTerminal = useMemo(() => {
    if (!worktreeSetup || !activeThreadRef || worktreeSetup.threadId !== activeThreadRef.threadId) {
      return null;
    }
    const setupThreadRef = activeThreadRef;
    return (terminalId: string) => {
      storeEnsureTerminal(setupThreadRef, terminalId, { open: true, active: true });
    };
  }, [activeThreadRef, storeEnsureTerminal, worktreeSetup]);

  return {
    timelineEntries,
    isWorking,
    threadUsageFooter,
    threadAuditRunning: audit !== null,
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
    handoffAttachmentPreviews,
    resetLocalDispatch,
    isPreparingWorktree,
    activePlan,
    needsInput,
    workLogEntries,
    activeContextWindow,
    pendingApprovals,
    pendingUserInputs,
    showPlanFollowUpPrompt,
    usageLimitsBanner,
    systemComposerBannerItems,
    supportsConversationRollback,
    isSendBusy,
    beginLocalDispatch,
    clearUsageLimitsFor,
    activePendingApproval,
    activePendingUserInput,
    activePendingIsResponding,
    activePendingRequestKey,
    activePendingProgress,
    activePendingResolvedAnswers,
    activeProposedPlan,
    usageLimitsOffered,
    usageLimitsKey,
    openUsageLimits,
    timelineMessages,
    cancelWorktreeSetup,
    agentPanelLead,
    isCompacting,
    activeWorkStartedAt,
    onCancelWorktreeSetup,
    onOpenWorktreeSetupTerminal,
    displayedTimeline,
    displayedThreadRef,
    displayedTimelineKey,
    openFileAttachment,
    downloadFileAttachment,
    pillWorking,
    worktreeSetupBlocksSend,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
  };
}
