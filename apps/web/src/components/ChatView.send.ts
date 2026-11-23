import {
  parseCodexFeedbackCommand,
  submitCodexFeedback,
} from "@t3tools/client-runtime/state/threads";
import {
  type PreviewAnnotationPayload,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import { applyClaudePromptEffortPrefix, createModelSelection } from "@t3tools/shared/model";
import { isUsageLimitsCommand } from "@t3tools/shared/usageLimits";
import { flushSync } from "react-dom";
import { newMessageId } from "~/lib/utils";
import {
  collapseExpandedComposerCursor,
  type ComposerSubmissionIntent,
  handleComposerSideQuestion,
  parseStandaloneComposerSlashCommand,
} from "../composer-logic";
import { type ComposerImageAttachment, useComposerDraftStore } from "../composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  startAttachmentUpload,
} from "../lib/attachmentUploadQueue";
import {
  buildMessageContext,
  previewAnnotationContextReference,
  terminalContextReference,
} from "../lib/composerContextRecords";
import {
  ensureInlineContextReferences,
  removeInlineContextReference,
} from "../lib/composerContextReferences";
import { resolvePlanFollowUpSubmission } from "../proposedPlan";
import { latestCompletedToolActivityId, useQueuedMessageStore } from "../queuedMessageStore";
import { type ReviewCommentContext } from "../reviewCommentContext";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { fileAttachmentCapabilityBlockReason } from "./chat/composerAttachmentFiles";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./chat/composerPromptHistory";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
} from "./chat/composerProviderState";
import { runMobileComposerTransition } from "./chat/draftHeroTransition";
import { readEarlyComposerMemoryDispatchHold } from "./chat/sendQueuedMessage";
import {
  ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE,
  formatOutgoingPrompt,
} from "./ChatView.helpers";
import {
  buildExpiredTerminalContextToastCopy,
  deriveComposerSendState,
  getAntigravitySendBlockReason,
  hasComposerDraftChangedWhilePreparing,
  readFileAsDataUrl,
  resolveComposerInteractionMode,
  restorePlanFollowUpComposer,
  shouldDockDraftHeroForSubmission,
} from "./ChatView.logic";
import type { useChatViewPendingRequests } from "./ChatView.pendingRequests";
import type { useChatViewProjectAndEnvironment } from "./ChatView.projectEnvironment";
import type { useChatViewRightPanel } from "./ChatView.rightPanel";
import { sendDirectMessage } from "./ChatView.send.direct";
import { sendMultipleModels } from "./ChatView.send.multiple";
import { createSendRecovery } from "./ChatView.send.recovery";
import type { useChatViewShortcutsAndRevert } from "./ChatView.shortcutsAndRevert";
import type { useChatViewTerminalsAndScripts } from "./ChatView.terminalsAndScripts";
import type { useChatViewThreadState } from "./ChatView.threadState";
import type { useChatViewThreadStatus } from "./ChatView.threadStatus";
import type { useChatViewTimelineData } from "./ChatView.timelineData";
import type { useChatViewTimelineScroll } from "./ChatView.timelineScroll";
import { stackedThreadToast, toastManager } from "./ui/toast";

export type SendSources = {
  threadState: ReturnType<typeof useChatViewThreadState>;
  projectEnvironment: ReturnType<typeof useChatViewProjectAndEnvironment>;
  timelineData: ReturnType<typeof useChatViewTimelineData>;
  terminalsAndScripts: ReturnType<typeof useChatViewTerminalsAndScripts>;
  rightPanel: ReturnType<typeof useChatViewRightPanel>;
  timelineScroll: ReturnType<typeof useChatViewTimelineScroll>;
  threadStatus: ReturnType<typeof useChatViewThreadStatus>;
  shortcutsAndRevert: ReturnType<typeof useChatViewShortcutsAndRevert>;
  pendingRequests: ReturnType<typeof useChatViewPendingRequests>;
};

export function useChatViewSend({
  threadState,
  projectEnvironment,
  timelineData,
  terminalsAndScripts,
  rightPanel,
  timelineScroll,
  threadStatus,
  shortcutsAndRevert,
  pendingRequests,
}: SendSources) {
  const {
    composerHasNonPromptContent,
    promptRef,
    setComposerDraftPrompt,
    composerDraftTarget,
    composerRef,
    activeThread,
    isConnecting,
    isRevertingCheckpoint,
    threadDetailLoading,
    sendInFlightRef,
    feedbackUploadsInFlightRef,
    routeThreadKey,
    environmentUnavailableSendToastSlotRef,
    isLocalDraftThread,
    isServerThread,
    clearComposerDraftContent,
    setFeedbackSubmissionsByThreadKey,
    uploadThreadFeedback,
    environmentId,
    composerTerminalContextsRef,
    setComposerDraftTerminalContexts,
    setComposerDraftReviewComments,
    setComposerDraftPreviewAnnotations,
    setComposerDraftProjectMemoryReferences,
    activeThreadKey,
    settings,
    composerImagesRef,
    composerFilesRef,
    composerSendGenerationRef,
    panelAnimationsActive,
    panelAnimationDurationMs,
    multipleModelSelectionsRef,
    currentRouteThreadKeyRef,
    uncertainMultipleSubmissionsRef,
    startThreadTurn,
    runtimeMode,
    draftThread,
    navigate,
    setMultipleModelSelections,
    draftId,
    addComposerDraftImages,
    addComposerDraftFiles,
    isAtEndRef,
    setShowScrollToBottom,
    setTimelineAnchor,
    setOptimisticUserMessages,
    updateThreadMetadata,
    handleNewThread,
    getDraftSession,
    setLogicalProjectDraftThreadId,
  } = threadState;
  const {
    clientSettingsHydrated,
    activeEnvironmentUnavailable,
    serverConfig,
    activeProject,
    supportsAttachmentUploads,
    activeProjectDefaultModelSelection,
  } = projectEnvironment;
  const {
    usageLimitsOffered,
    usageLimitsKey,
    openUsageLimits,
    isSendBusy,
    activePendingProgress,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    phase,
    threadActivities,
    providerInstanceEntries,
    beginLocalDispatch,
    resetLocalDispatch,
    timelineMessages,
    clearUsageLimitsFor,
  } = timelineData;
  const {
    needsLoadBalancing,
    loadBalancing,
    setThreadError,
    isGitRepo,
    handleInteractionModeChange,
    isDraftHeroState,
    captureDraftHeroComposerRect,
    setDockedDraftHeroThreadKey,
  } = terminalsAndScripts;
  const { persistThreadSettingsForNextTurn } = rightPanel;
  const {
    timelineScrollModeRef,
    liveFollowUserScrollGenerationRef,
    anchorUserScrollGenerationRef,
    setTimelineLiveFollowEnabled,
    pendingTimelineAnchorRef,
    activeTimelineAnchorIndexRef,
    showScrollDebouncer,
    scrollToEnd,
  } = timelineScroll;
  const {
    activeThreadBranch,
    sendEnvMode,
    startFromOrigin,
    localCheckoutBranchMismatch,
    acknowledgeActiveThreadWoke,
  } = threadStatus;
  const { readComposerSendSettings } = shortcutsAndRevert;
  const { onAdvanceActivePendingUserInput, onSubmitPlanFollowUp } = pendingRequests;

  const readDraft = () => useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
  const isSendingComposerVisible = () => currentRouteThreadKeyRef.current === routeThreadKey;
  const { hasNewerDraft, recoveryTargetExists, offerFailedSendRecovery, recoverFailedSend } =
    createSendRecovery({
      readDraft,
      draftId,
      activeThread,
      isSendingComposerVisible,
      navigate,
      sendInFlightRef,
      setOptimisticUserMessages,
    });
  const onSend = async (
    e?: { preventDefault: () => void },
    submissionIntent: ComposerSubmissionIntent = "foreground",
    directAnnotation?: {
      annotation: PreviewAnnotationPayload;
      image: ComposerImageAttachment | null;
    },
  ) => {
    e?.preventDefault();
    if (handleComposerSideQuestion(promptRef)) return;
    // Typed out in full rather than picked from the menu. Attachments or contexts
    // mean the user is sending a prompt, so those go through as usual.
    if (
      usageLimitsOffered &&
      usageLimitsKey !== null &&
      !directAnnotation &&
      !composerHasNonPromptContent &&
      isUsageLimitsCommand(promptRef.current)
    ) {
      if (openUsageLimits()) {
        promptRef.current = "";
        setComposerDraftPrompt(composerDraftTarget, "");
        composerRef.current?.resetCursorState();
      }
      return;
    }

    const notifyDirectAnnotationAttached = () => {
      if (!directAnnotation) return;
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Annotation attached to draft",
          description: "Sending is unavailable right now. Finish the current action, then send.",
        }),
      );
    };
    if (
      !activeThread ||
      isSendBusy ||
      isConnecting ||
      isRevertingCheckpoint ||
      !clientSettingsHydrated ||
      threadDetailLoading ||
      sendInFlightRef.current ||
      feedbackUploadsInFlightRef.current.has(routeThreadKey)
    ) {
      notifyDirectAnnotationAttached();
      return;
    }
    if (needsLoadBalancing) {
      toastManager.add({
        type: "warning",
        title: loadBalancing.pending
          ? "Checking machine resources"
          : "Choose a machine to continue",
        description: loadBalancing.pending
          ? "Resource checks are still running. You can choose a machine in the composer."
          : "No eligible machine has available resources. Choose a machine in the composer to override.",
      });
      return;
    }
    if (activeEnvironmentUnavailable) {
      const toastSlot = environmentUnavailableSendToastSlotRef.current;
      environmentUnavailableSendToastSlotRef.current =
        (toastSlot + 1) % ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE;
      toastManager.add({
        ...stackedThreadToast({
          type: "warning",
          title: "Not connected: message not sent",
          description: "Reconnecting to the environment. Try again once it is connected.",
        }),
        id: `chat-send-environment-unavailable:${toastSlot}`,
      });
      return;
    }
    if (activePendingProgress) {
      if (directAnnotation) {
        notifyDirectAnnotationAttached();
        return;
      }
      onAdvanceActivePendingUserInput();
      return;
    }
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) {
      notifyDirectAnnotationAttached();
      return;
    }
    const multipleModelSelections = sendCtx.multipleModelSelections;
    if (
      multipleModelSelections !== null &&
      serverConfig?.environment.capabilities.requiredWorktreeBootstrap !== true
    ) {
      setThreadError(activeThread.id, "Update this server before starting multiple models.");
      return;
    }
    if (
      multipleModelSelections !== null &&
      (!isLocalDraftThread ||
        !isGitRepo ||
        !activeThreadBranch ||
        multipleModelSelections.length === 0)
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Choose models and a base branch",
          description:
            "Multiple models need a new thread in a Git project. Each gets its own worktree.",
        }),
      );
      return;
    }
    const {
      images: sendContextImages,
      files: composerFiles,
      terminalContexts: composerTerminalContexts,
      previewAnnotations: sendContextPreviewAnnotations,
      reviewComments: composerReviewComments,
      projectMemoryReferences: composerProjectMemoryReferences,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
      interactionMode: sendInteractionMode,
      interactionModeEnabled: sendInteractionModeEnabled,
    } = sendCtx;
    const annotationImageAlreadyAttached =
      directAnnotation?.image !== undefined &&
      sendContextImages.some((image) => image.id === directAnnotation.image?.id);
    // A full composer (e.g. 8 files) cannot take the annotation screenshot;
    // over the cap the server rejects the whole turn.
    const annotationImageAppended =
      directAnnotation?.image !== undefined &&
      !annotationImageAlreadyAttached &&
      sendContextImages.length + composerFiles.length < PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
    const composerImages =
      directAnnotation?.image && annotationImageAppended
        ? [...sendContextImages, directAnnotation.image]
        : sendContextImages;
    const composerPreviewAnnotations =
      directAnnotation &&
      !sendContextPreviewAnnotations.some(
        (annotation) => annotation.id === directAnnotation.annotation.id,
      )
        ? [
            ...sendContextPreviewAnnotations,
            {
              ...directAnnotation.annotation,
              // Claim an attached crop only when the screenshot really rides
              // along; a cap-dropped image must not produce a lying prompt.
              screenshot:
                directAnnotation.annotation.screenshot &&
                (annotationImageAppended || annotationImageAlreadyAttached)
                  ? { ...directAnnotation.annotation.screenshot, dataUrl: "" }
                  : null,
            },
          ]
        : sendContextPreviewAnnotations;
    // A direct "send annotation" writes the draft and sends in the same tick; the reference
    // must be in the text now, not after the next render.
    const promptForSend = directAnnotation
      ? ensureInlineContextReferences(promptRef.current, [
          previewAnnotationContextReference(directAnnotation.annotation),
        ])
      : promptRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length + composerFiles.length,
      terminalContexts: composerTerminalContexts,
      // Memory selections count like element contexts: a memory-only draft is
      // a valid send; the server re-resolves the content.
      elementContextCount:
        composerPreviewAnnotations.length +
        composerReviewComments.length +
        composerProjectMemoryReferences.length,
    });
    const feedbackCommand =
      ctxSelectedProvider === "codex" &&
      composerImages.length === 0 &&
      composerFiles.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0 &&
      composerProjectMemoryReferences.length === 0
        ? parseCodexFeedbackCommand(trimmed)
        : null;
    if (feedbackCommand && multipleModelSelections === null) {
      if (!isServerThread || activeThread.session === null) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Start a Codex thread first",
            description: "Send a message before you submit feedback.",
          }),
        );
        return;
      }
      feedbackUploadsInFlightRef.current.add(routeThreadKey);
      await submitCodexFeedback({
        submission: {
          id: newMessageId(),
          command: trimmed,
          createdAt: new Date().toISOString(),
        },
        clearDraft: () => {
          promptRef.current = "";
          clearComposerDraftContent(composerDraftTarget);
          composerRef.current?.resetCursorState();
        },
        onUpdate: (submission) => {
          setFeedbackSubmissionsByThreadKey((current) => {
            const existing = current[routeThreadKey] ?? [];
            const found = existing.some((entry) => entry.id === submission.id);
            return {
              ...current,
              [routeThreadKey]: found
                ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                : [...existing, submission],
            };
          });
        },
        upload: () =>
          uploadThreadFeedback({
            environmentId,
            input: {
              threadId: activeThread.id,
              ...feedbackCommand,
            },
          }),
      }).finally(() => {
        feedbackUploadsInFlightRef.current.delete(routeThreadKey);
      });

      return;
    }
    // Expired terminal excerpts are not sent; their chips leave the text with them.
    const promptWithoutExpiredTerminalContexts = composerTerminalContexts
      .filter((context) => !sendableComposerTerminalContexts.includes(context))
      .reduce(
        (text, context) =>
          removeInlineContextReference(text, terminalContextReference(context).contextId).prompt,
        promptForSend,
      );
    if (
      !directAnnotation &&
      sendInteractionModeEnabled &&
      showPlanFollowUpPrompt &&
      activeProposedPlan &&
      composerImages.length === 0 &&
      composerFiles.length === 0 &&
      composerProjectMemoryReferences.length === 0
    ) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: promptForSend,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      const outgoingFollowUpText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: followUp.text.trim(),
      });
      if (composerRef.current?.validateProviderInput(outgoingFollowUpText) === false) {
        return;
      }
      const send = {
        messageId: newMessageId(),
        draft: {
          prompt: promptWithoutExpiredTerminalContexts,
          terminalContexts: [...sendableComposerTerminalContexts],
          reviewComments: [...composerReviewComments],
          previewAnnotations: [...composerPreviewAnnotations],
        },
      };
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      const recoverFollowUp = (errorMessage?: string) => {
        return recoverFailedSend(
          send,
          (draft) => {
            restorePlanFollowUpComposer({
              snapshot: draft,
              writePrompt: (prompt) => setComposerDraftPrompt(composerDraftTarget, prompt),
              writeTerminalContexts: (contexts) =>
                setComposerDraftTerminalContexts(composerDraftTarget, [...contexts]),
              writeReviewComments: (comments) =>
                setComposerDraftReviewComments(composerDraftTarget, [...comments]),
              writePreviewAnnotations: (annotations) =>
                setComposerDraftPreviewAnnotations(composerDraftTarget, [...annotations]),
              resetCursor: () => {
                if (!isSendingComposerVisible()) return;
                const restoredDraft = readDraft();
                const prompt = restoredDraft?.prompt ?? "";
                promptRef.current = prompt;
                composerTerminalContextsRef.current = restoredDraft?.terminalContexts ?? [];
                composerRef.current?.resetCursorState({
                  cursor: collapseExpandedComposerCursor(prompt, prompt.length),
                  prompt,
                  detectTrigger: true,
                });
              },
            });
          },
          errorMessage,
        );
      };
      let failureHandled = false;
      const followUpSent = await onSubmitPlanFollowUp({
        messageId: send.messageId,
        text: followUp.text,
        context: buildMessageContext({
          terminalContexts: sendableComposerTerminalContexts,
          reviewComments: send.draft.reviewComments,
          previewAnnotations: send.draft.previewAnnotations,
        }),
        interactionMode: followUp.interactionMode,
        onFailure: (message) => {
          failureHandled = true;
          return recoverFollowUp(message);
        },
      });
      if (!followUpSent && !failureHandled) {
        recoverFollowUp();
      }
      return;
    }
    // Providers without the legacy toggle receive their native commands unchanged.
    const standaloneSlashCommand =
      sendInteractionModeEnabled &&
      composerImages.length === 0 &&
      composerFiles.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0 &&
      composerProjectMemoryReferences.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand && multipleModelSelections === null) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          }),
        );
      }
      return;
    }
    if (!activeProject) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Choose a project first",
          description: "This draft no longer points to an available project.",
        }),
      );
      return;
    }
    // A queued message that will still leave on its own goes first, so a new
    // send lines up behind it instead of overtaking it.
    const queueStillSending =
      activeThreadKey !== null &&
      (useQueuedMessageStore.getState().queuesByThreadKey[activeThreadKey] ?? []).some(
        (message) => message.sending !== undefined || !message.holdUntilUserAction,
      );
    if (
      !directAnnotation &&
      activeThreadKey &&
      (queueStillSending ||
        (phase === "running" &&
          (settings.followUpBehavior === "queue") !== (submissionIntent === "alternate")))
    ) {
      const sendSettings = readComposerSendSettings(sendCtx);
      if (
        composerRef.current?.validateProviderInput(
          applyClaudePromptEffortPrefix(promptForSend, sendSettings.promptEffort),
        ) === false
      ) {
        return;
      }
      useQueuedMessageStore.getState().enqueue(activeThreadKey, {
        prompt: promptForSend,
        images: [...composerImages],
        files: [...composerFiles],
        terminalContexts: [...composerTerminalContexts],
        previewAnnotations: [...composerPreviewAnnotations],
        reviewComments: [...composerReviewComments],
        projectMemoryReferences: [...composerProjectMemoryReferences],
        sendSettings,
        queuedAfterToolActivityId: latestCompletedToolActivityId(threadActivities),
        createdAt: new Date().toISOString(),
      });
      promptRef.current = "";
      // Attachments move with the message; their uploads stay pending. The
      // refs clear now too, so a Stop before the composer's sync effect runs
      // does not restore the moved attachments twice.
      composerImagesRef.current = [];
      composerFilesRef.current = [];
      composerTerminalContextsRef.current = [];
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath
        ? activeThreadBranch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThreadBranch) {
      setThreadError(threadIdForSend, "Select a base branch before sending in New worktree mode.");
      return;
    }

    const submittedDraft = readDraft();
    const composerChangedWhilePreparing = () =>
      hasComposerDraftChangedWhilePreparing(submittedDraft, readDraft());
    const composerImagesSnapshot = [...composerImages];
    const composerFilesSnapshot = [...composerFiles];
    const composerAttachmentsSnapshot = [...composerImagesSnapshot, ...composerFilesSnapshot];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const composerPreviewAnnotationsSnapshot = [...composerPreviewAnnotations];
    const composerReviewCommentsSnapshot: ReviewCommentContext[] = [...composerReviewComments];
    const composerProjectMemoryReferencesSnapshot = [...composerProjectMemoryReferences];
    // Memory ids are project-scoped: a draft retargeted while the send is in
    // flight must not regain this send's selections at restore time.
    const sendProjectRef = {
      environmentId: activeProject.environmentId,
      projectId: activeProject.id,
    };
    const messageTextForSend = promptWithoutExpiredTerminalContexts.trim();
    // Records bind attachments by the id each side knows: the local id for the optimistic
    // row, the upload id (or local id on the data-URL path) on the wire; the server
    // rebinds them to the persisted id.
    const buildOutgoingMessageContext = (attachmentIds: ReadonlyArray<string>) =>
      buildMessageContext({
        terminalContexts: composerTerminalContextsSnapshot,
        reviewComments: composerReviewCommentsSnapshot,
        previewAnnotations: composerPreviewAnnotationsSnapshot,
        projectMemoryReferences: composerProjectMemoryReferencesSnapshot,
        attachments: composerAttachmentsSnapshot.map((attachment, index) => ({
          attachment,
          attachmentId: attachmentIds[index] ?? attachment.id,
        })),
      });
    const outgoingMessageContext = buildOutgoingMessageContext(
      composerAttachmentsSnapshot.map((attachment) => attachment.id),
    );
    const outgoingMessageText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    });
    if (composerRef.current?.validateProviderInput(outgoingMessageText) === false) {
      return;
    }
    // A memory reference must never reach a dispatch that cannot send it: the
    // early hold reads the current descriptor (memory capability, inline
    // support, resolved provider) before anything is cleared, so the draft is
    // untouched for correction. The same guard runs again at dispatch below,
    // after the upload and persistence awaits.
    const earlyMemoryHold = readEarlyComposerMemoryDispatchHold({
      environmentId,
      instanceId: ctxSelectedModelSelection.instanceId,
      projectMemoryReferenceCount: composerProjectMemoryReferencesSnapshot.length,
    });
    if (earlyMemoryHold !== null) {
      setThreadError(threadIdForSend, earlyMemoryHold);
      return;
    }

    const readLiveAttachmentCapabilities = () => {
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
      const liveSupportsAttachmentUploads =
        config?.environment.capabilities.attachmentUploads === true;
      return {
        supportsAttachmentUploads: liveSupportsAttachmentUploads,
        fileBlockReason: fileAttachmentCapabilityBlockReason({
          files: composerFilesSnapshot,
          attachmentUploadsCapabilityKnown: config !== null,
          supportsAttachmentUploads: liveSupportsAttachmentUploads,
          maxFileAttachmentBytes:
            config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
        }),
      };
    };

    const multipleTargets = [];
    for (const selection of multipleModelSelections ?? []) {
      const provider = providerInstanceEntries.find(
        (entry) => entry.instanceId === selection.instanceId,
      );
      if (!provider?.enabled || !provider.isAvailable || provider.status !== "ready") {
        setThreadError(threadIdForSend, `Provider for ${selection.model} is unavailable.`);
        return;
      }
      const providerBlockReason = getAntigravitySendBlockReason(provider.snapshot, selection.model);
      if (providerBlockReason) {
        setThreadError(threadIdForSend, providerBlockReason);
        return;
      }
      const providerState = getComposerProviderState({
        provider: provider.driverKind,
        model: selection.model,
        models: provider.models,
        modelOptions: selection.options,
        promptInjectionState: getComposerPromptInjectionState(messageTextForSend),
        planModeEnabled: settings.planModeEnabled,
      });
      const text = formatOutgoingPrompt({
        provider: provider.driverKind,
        model: selection.model,
        models: provider.models,
        effort: providerState.promptEffort,
        text: messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      });
      if (composerRef.current?.validateProviderInput(text) === false) return;
      multipleTargets.push({
        selection: createModelSelection(
          selection.instanceId,
          selection.model,
          providerState.modelOptionsForDispatch,
        ),
        text,
        interactionMode: resolveComposerInteractionMode({
          planModeEnabled: settings.planModeEnabled,
          provider: provider.snapshot,
          interactionMode: sendInteractionMode,
        }).interactionMode,
      });
    }

    const reportSendFailure = (message: string, recoveryOffered = false) => {
      setThreadError(threadIdForSend, message);
      if (!recoveryOffered && !isSendingComposerVisible()) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Message could not be sent",
            description: message,
          }),
        );
      }
    };
    const reportChangedDraft = () =>
      reportSendFailure("The draft changed while preparing. Send the updated draft when ready.");
    const clearSubmittedComposer = () => {
      clearComposerDraftContent(composerDraftTarget);
      if (isSendingComposerVisible()) {
        promptRef.current = "";
        composerRef.current?.resetCursorState();
      }
    };

    sendInFlightRef.current = true;
    const sendGeneration = ++composerSendGenerationRef.current;
    const attachmentCapabilitiesBeforeUpload = readLiveAttachmentCapabilities();
    if (attachmentCapabilitiesBeforeUpload.fileBlockReason !== null) {
      sendInFlightRef.current = false;
      reportSendFailure(attachmentCapabilitiesBeforeUpload.fileBlockReason);
      return;
    }
    const turnUsesAttachmentUploads =
      composerFilesSnapshot.length > 0
        ? attachmentCapabilitiesBeforeUpload.supportsAttachmentUploads
        : supportsAttachmentUploads;
    if (turnUsesAttachmentUploads && composerAttachmentsSnapshot.length > 0) {
      for (const attachment of composerAttachmentsSnapshot) {
        startAttachmentUpload({
          environmentId,
          image: attachment,
          draftTarget: composerDraftTarget,
        });
      }
      await awaitAttachmentUploads(composerAttachmentsSnapshot.map((attachment) => attachment.id));
      const attachmentCapabilitiesAfterUpload = readLiveAttachmentCapabilities();
      if (attachmentCapabilitiesAfterUpload.fileBlockReason !== null) {
        sendInFlightRef.current = false;
        reportSendFailure(attachmentCapabilitiesAfterUpload.fileBlockReason);
        return;
      }
      if (getUploadedAttachments({ environmentId, images: composerAttachmentsSnapshot }) === null) {
        sendInFlightRef.current = false;
        reportSendFailure("Retry or remove failed uploads before sending.");
        return;
      }
    }

    const resolvedSubmissionIntent =
      (multipleModelSelections !== null || submissionIntent === "background") && isLocalDraftThread
        ? "background"
        : "foreground";
    if (
      shouldDockDraftHeroForSubmission({
        isDraftHeroState,
        activeThreadKey,
        submissionIntent: resolvedSubmissionIntent,
      }) &&
      isSendingComposerVisible() &&
      activeThreadKey
    ) {
      let resolveDockStarted: (() => void) | undefined;
      const dockStarted = new Promise<void>((resolve) => {
        resolveDockStarted = resolve;
      });
      const dockTransition = runMobileComposerTransition(
        () => {
          flushSync(() => {
            if (isSendingComposerVisible()) {
              captureDraftHeroComposerRect();
              setDockedDraftHeroThreadKey(activeThreadKey);
            }
          });
          resolveDockStarted?.();
        },
        {
          active: panelAnimationsActive,
          durationMs: panelAnimationDurationMs,
        },
      );
      void dockTransition.catch(() => resolveDockStarted?.());
      await dockStarted;
    }

    if (composerChangedWhilePreparing()) {
      sendInFlightRef.current = false;
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      reportChangedDraft();
      return;
    }
    const attachmentCapabilitiesBeforeDispatch = readLiveAttachmentCapabilities();
    if (attachmentCapabilitiesBeforeDispatch.fileBlockReason !== null) {
      sendInFlightRef.current = false;
      reportSendFailure(attachmentCapabilitiesBeforeDispatch.fileBlockReason);
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      return;
    }
    if (isSendingComposerVisible()) {
      beginLocalDispatch({
        preparingWorktree: multipleModelSelections !== null || Boolean(baseBranchForWorktree),
        submissionIntent: resolvedSubmissionIntent,
      });
    }

    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const turnAttachmentsPromise = Promise.all(
      composerAttachmentsSnapshot.map(async (attachment) => {
        if (turnUsesAttachmentUploads) {
          const uploaded = getUploadedAttachments({ environmentId, images: [attachment] })?.[0];
          if (!uploaded) {
            throw new Error(`Attachment '${attachment.name}' did not finish uploading.`);
          }
          return uploaded;
        }
        if (attachment.type !== "image") {
          throw new Error("This server does not support file attachments.");
        }
        return {
          type: "image" as const,
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          dataUrl: await readFileAsDataUrl(attachment.file),
          ...(attachment.source ? { source: attachment.source } : {}),
        };
      }),
    );
    if (multipleModelSelections !== null) {
      return sendMultipleModels({
        turnAttachmentsPromise,
        composerChangedWhilePreparing,
        reportChangedDraft,
        setDockedDraftHeroThreadKey,
        activeThreadKey,
        readLiveAttachmentCapabilities,
        buildOutgoingMessageContext,
        composerAttachmentsSnapshot,
        trimmed,
        clearSubmittedComposer,
        composerImagesSnapshot,
        composerDraftTarget,
        multipleModelSelectionsRef,
        currentRouteThreadKeyRef,
        routeThreadKey,
        composerSendGenerationRef,
        sendGeneration,
        setThreadError,
        threadIdForSend,
        multipleTargets,
        uncertainMultipleSubmissionsRef,
        environmentId,
        startThreadTurn,
        runtimeMode,
        activeProject,
        activeThreadBranch,
        draftThread,
        messageCreatedAt,
        startFromOrigin,
        navigate,
        sendInFlightRef,
        isSendingComposerVisible,
        resetLocalDispatch,
        turnUsesAttachmentUploads,
        multipleModelSelections,
        setMultipleModelSelections,
        isLocalDraftThread,
        draftId,
        sendProjectRef,
        messageTextForSend,
        composerProjectMemoryReferencesSnapshot,
        setComposerDraftPrompt,
        addComposerDraftImages,
        addComposerDraftFiles,
        composerFilesSnapshot,
        setComposerDraftTerminalContexts,
        composerTerminalContextsSnapshot,
        setComposerDraftPreviewAnnotations,
        composerPreviewAnnotationsSnapshot,
        setComposerDraftReviewComments,
        composerReviewCommentsSnapshot,
        setComposerDraftProjectMemoryReferences,
        composerRef,
        readDraft,
        promptRef,
        composerTerminalContextsRef,
        recoveryTargetExists,
        hasNewerDraft,
        offerFailedSendRecovery,
        reportSendFailure,
      });
    }
    return sendDirectMessage({
      composerAttachmentsSnapshot,
      isSendingComposerVisible,
      activeThread,
      timelineMessages,
      isAtEndRef,
      timelineScrollModeRef,
      liveFollowUserScrollGenerationRef,
      anchorUserScrollGenerationRef,
      setTimelineLiveFollowEnabled,
      pendingTimelineAnchorRef,
      messageIdForSend,
      activeTimelineAnchorIndexRef,
      showScrollDebouncer,
      setShowScrollToBottom,
      setTimelineAnchor,
      threadIdForSend,
      scrollToEnd,
      outgoingMessageText,
      outgoingMessageContext,
      messageCreatedAt,
      messageTextForSend,
      composerProjectMemoryReferencesSnapshot,
      composerImagesSnapshot,
      composerFilesSnapshot,
      composerTerminalContextsSnapshot,
      composerPreviewAnnotationsSnapshot,
      composerReviewCommentsSnapshot,
      setOptimisticUserMessages,
      setThreadError,
      expiredTerminalContextCount,
      clearSubmittedComposer,
      trimmed,
      ctxSelectedModelSelection,
      ctxSelectedModel,
      activeProjectDefaultModelSelection,
      isFirstMessage,
      isServerThread,
      updateThreadMetadata,
      environmentId,
      persistThreadSettingsForNextTurn,
      localCheckoutBranchMismatch,
      runtimeMode,
      sendInteractionMode,
      turnAttachmentsPromise,
      readLiveAttachmentCapabilities,
      isLocalDraftThread,
      baseBranchForWorktree,
      activeProject,
      activeThreadBranch,
      draftThread,
      startFromOrigin,
      resolvedSubmissionIntent,
      buildOutgoingMessageContext,
      handleNewThread,
      sendEnvMode,
      clearUsageLimitsFor,
      routeThreadKey,
      turnUsesAttachmentUploads,
      acknowledgeActiveThreadWoke,
      currentRouteThreadKeyRef,
      navigate,
      draftId,
      recoverFailedSend,
      sendProjectRef,
      composerDraftTarget,
      readDraft,
      promptRef,
      composerImagesRef,
      composerFilesRef,
      composerTerminalContextsRef,
      composerRef,
      getDraftSession,
      setLogicalProjectDraftThreadId,
      reportSendFailure,
      sendInFlightRef,
      setDockedDraftHeroThreadKey,
      activeThreadKey,
      resetLocalDispatch,
    });
  };

  return { onSend };
}
