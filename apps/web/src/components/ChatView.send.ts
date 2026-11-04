import { isUsageLimitsCommand } from "@t3tools/shared/usageLimits";
import {
  DEFAULT_MODEL,
  type ModelSelection,
  type PreviewAnnotationPayload,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import {
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
} from "@t3tools/client-runtime/errors";
import {
  parseCodexFeedbackCommand,
  submitCodexFeedback,
} from "@t3tools/client-runtime/state/threads";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { applyClaudePromptEffortPrefix, createModelSelection } from "@t3tools/shared/model";
import { truncate } from "@t3tools/shared/String";
import { flushSync } from "react-dom";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { readLocalApi } from "../localApi";
import {
  collapseExpandedComposerCursor,
  type ComposerSubmissionIntent,
  parseStandaloneComposerSlashCommand,
} from "../composer-logic";
import { resolvePlanFollowUpSubmission } from "../proposedPlan";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { randomHex } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { newMessageId, newThreadId } from "~/lib/utils";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
} from "./chat/composerProviderState";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  beginBackgroundDraftSubmissionByRef,
  clearBackgroundDraftSubmissionByRef,
  composerDraftHasUserContent,
  type ComposerImageAttachment,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  restoreFailedBackgroundDraftThread,
  useComposerDraftStore,
} from "../composerDraftStore";
import { formatTerminalContextLabel } from "../lib/terminalContext";
import {
  ensureInlineContextReferences,
  removeInlineContextReference,
  stripInlineContextReferences,
} from "../lib/composerContextReferences";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import {
  buildMessageContext,
  promptWithoutProjectMemoryReferences,
  previewAnnotationContextLabel,
  previewAnnotationContextReference,
  reviewCommentContextLabel,
  terminalContextReference,
} from "../lib/composerContextRecords";
import { latestCompletedToolActivityId, useQueuedMessageStore } from "../queuedMessageStore";
import {
  dispatchDirectThreadTurnMessage,
  DirectMemoryDispatchHoldError,
  readEarlyComposerMemoryDispatchHold,
  readPostPreparationMemoryDispatchHold,
  restoreComposerDraftAfterDirectSendFailure,
} from "./chat/sendQueuedMessage";
import { type ReviewCommentContext } from "../reviewCommentContext";
import { environmentServerConfigsAtom } from "../state/server";
import { runMobileComposerTransition } from "./chat/draftHeroTransition";
import {
  buildExpiredTerminalContextToastCopy,
  deriveComposerSendState,
  shouldDockDraftHeroForSubmission,
  cloneComposerImageForRetry,
  readFileAsDataUrl,
  resolveBackgroundDraftWorkspaceOptions,
  resolveComposerInteractionMode,
  getAntigravitySendBlockReason,
  restorePlanFollowUpComposer,
  revokeUserMessagePreviewUrls,
} from "./ChatView.logic";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../lib/attachmentUploadQueue";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { fileAttachmentCapabilityBlockReason } from "./chat/composerAttachmentFiles";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./chat/composerPromptHistory";
import {
  formatOutgoingPrompt,
  ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE,
} from "./ChatView.helpers";
import type { useChatViewThreadState } from "./ChatView.threadState";
import type { useChatViewProjectAndEnvironment } from "./ChatView.projectEnvironment";
import type { useChatViewTimelineData } from "./ChatView.timelineData";
import type { useChatViewTerminalsAndScripts } from "./ChatView.terminalsAndScripts";
import type { useChatViewRightPanel } from "./ChatView.rightPanel";
import type { useChatViewTimelineScroll } from "./ChatView.timelineScroll";
import type { useChatViewThreadStatus } from "./ChatView.threadStatus";
import type { useChatViewShortcutsAndRevert } from "./ChatView.shortcutsAndRevert";
import type { useChatViewPendingRequests } from "./ChatView.pendingRequests";

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
}: {
  threadState: ReturnType<typeof useChatViewThreadState>;
  projectEnvironment: ReturnType<typeof useChatViewProjectAndEnvironment>;
  timelineData: ReturnType<typeof useChatViewTimelineData>;
  terminalsAndScripts: ReturnType<typeof useChatViewTerminalsAndScripts>;
  rightPanel: ReturnType<typeof useChatViewRightPanel>;
  timelineScroll: ReturnType<typeof useChatViewTimelineScroll>;
  threadStatus: ReturnType<typeof useChatViewThreadStatus>;
  shortcutsAndRevert: ReturnType<typeof useChatViewShortcutsAndRevert>;
  pendingRequests: ReturnType<typeof useChatViewPendingRequests>;
}) {
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

  const onSend = async (
    e?: { preventDefault: () => void },
    submissionIntent: ComposerSubmissionIntent = "foreground",
    directAnnotation?: {
      annotation: PreviewAnnotationPayload;
      image: ComposerImageAttachment | null;
    },
  ) => {
    e?.preventDefault();
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
      // The composer is cleared before the send resolves, so hold everything it carried: a
      // transient failure must give the prose and its context back, as the ordinary send does.
      // Snapshot exactly what was sent, copied, so later mutations cannot alias the backup.
      const followUpPromptSnapshot = promptRef.current;
      const followUpTerminalContexts = [...sendableComposerTerminalContexts];
      const followUpReviewComments = [...composerReviewComments];
      const followUpPreviewAnnotations = [...composerPreviewAnnotations];
      const followUpProjectMemoryReferences = [...composerProjectMemoryReferences];
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      const followUpSent = await onSubmitPlanFollowUp({
        text: followUp.text,
        context: buildMessageContext({
          terminalContexts: sendableComposerTerminalContexts,
          reviewComments: composerReviewComments,
          previewAnnotations: composerPreviewAnnotations,
          projectMemoryReferences: composerProjectMemoryReferences,
        }),
        interactionMode: followUp.interactionMode,
      });
      if (!followUpSent) {
        promptRef.current = followUpPromptSnapshot;
        composerTerminalContextsRef.current = [...followUpTerminalContexts];
        restorePlanFollowUpComposer({
          snapshot: {
            prompt: followUpPromptSnapshot,
            terminalContexts: followUpTerminalContexts,
            reviewComments: followUpReviewComments,
            previewAnnotations: followUpPreviewAnnotations,
          },
          writePrompt: (prompt) => setComposerDraftPrompt(composerDraftTarget, prompt),
          writeTerminalContexts: (contexts) =>
            setComposerDraftTerminalContexts(composerDraftTarget, [...contexts]),
          writeReviewComments: (comments) =>
            setComposerDraftReviewComments(composerDraftTarget, [...comments]),
          writePreviewAnnotations: (annotations) =>
            setComposerDraftPreviewAnnotations(composerDraftTarget, [...annotations]),
          resetCursor: (options) => composerRef.current?.resetCursorState(options),
        });
        // Memory selections restore alongside the shared snapshot writer; the
        // exact identifiers captured before the clear go back verbatim.
        setComposerDraftProjectMemoryReferences(
          composerDraftTarget,
          followUpProjectMemoryReferences,
        );
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
    // Expired terminal excerpts are not sent; their chips leave the text with them.
    const messageTextForSend = composerTerminalContexts
      .filter((context) => !composerTerminalContextsSnapshot.includes(context))
      .reduce(
        (text, context) =>
          removeInlineContextReference(text, terminalContextReference(context).contextId).prompt,
        promptForSend,
      )
      .trim();
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

    sendInFlightRef.current = true;
    const sendGeneration = ++composerSendGenerationRef.current;
    const attachmentCapabilitiesBeforeUpload = readLiveAttachmentCapabilities();
    if (attachmentCapabilitiesBeforeUpload.fileBlockReason !== null) {
      sendInFlightRef.current = false;
      setThreadError(threadIdForSend, attachmentCapabilitiesBeforeUpload.fileBlockReason);
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
        setThreadError(threadIdForSend, attachmentCapabilitiesAfterUpload.fileBlockReason);
        return;
      }
      if (getUploadedAttachments({ environmentId, images: composerAttachmentsSnapshot }) === null) {
        sendInFlightRef.current = false;
        setThreadError(threadIdForSend, "Retry or remove failed uploads before sending.");
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
      activeThreadKey
    ) {
      let resolveDockStarted: (() => void) | undefined;
      const dockStarted = new Promise<void>((resolve) => {
        resolveDockStarted = resolve;
      });
      const dockTransition = runMobileComposerTransition(
        () => {
          flushSync(() => {
            captureDraftHeroComposerRect();
            setDockedDraftHeroThreadKey(activeThreadKey);
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

    const attachmentCapabilitiesBeforeDispatch = readLiveAttachmentCapabilities();
    if (attachmentCapabilitiesBeforeDispatch.fileBlockReason !== null) {
      sendInFlightRef.current = false;
      setThreadError(threadIdForSend, attachmentCapabilitiesBeforeDispatch.fileBlockReason);
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      return;
    }
    beginLocalDispatch({
      preparingWorktree: multipleModelSelections !== null || Boolean(baseBranchForWorktree),
      submissionIntent: resolvedSubmissionIntent,
    });

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
      const failedSelections: ModelSelection[] = [];
      let clearedDraft = false;
      let releasedComposer = false;
      let canRestoreDraft = () => false;
      let startedCount = 0;
      try {
        const attachments = await turnAttachmentsPromise;
        const fileBlockReason = readLiveAttachmentCapabilities().fileBlockReason;
        if (fileBlockReason !== null) throw new Error(fileBlockReason);
        const context = buildOutgoingMessageContext(
          attachments.map((attachment, index) =>
            "id" in attachment && attachment.id !== undefined
              ? attachment.id
              : composerAttachmentsSnapshot[index]!.id,
          ),
        );
        const title = truncate(
          assistantCitationsToPlainText(stripInlineContextReferences(trimmed)).trim() ||
            composerAttachmentsSnapshot[0]?.name ||
            "New thread",
        );
        promptRef.current = "";
        clearComposerDraftContent(composerDraftTarget);
        composerRef.current?.resetCursorState();
        clearedDraft = true;
        const clearedDraftSnapshot = useComposerDraftStore
          .getState()
          .getComposerDraft(composerDraftTarget);
        const submittedSelections = multipleModelSelectionsRef.current;
        canRestoreDraft = () =>
          currentRouteThreadKeyRef.current === routeThreadKey &&
          composerSendGenerationRef.current === sendGeneration &&
          useComposerDraftStore.getState().getComposerDraft(composerDraftTarget) ===
            clearedDraftSnapshot &&
          multipleModelSelectionsRef.current === submittedSelections;
        setThreadError(threadIdForSend, null);
        const starts = Promise.all(
          multipleTargets.map(async (target) => {
            const retryKey = JSON.stringify([
              routeThreadKey,
              target.selection.instanceId,
              target.selection.model,
            ]);
            const uncertainThreadId = uncertainMultipleSubmissionsRef.current.get(retryKey);
            const targetThreadId = uncertainThreadId ?? newThreadId();
            let requestMayHaveStarted = false;
            try {
              if (uncertainThreadId) {
                throw new Error(
                  "The previous request may have started. Open its thread to check before sending again.",
                );
              }
              const supportsInlineMessageContext =
                appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment
                  .capabilities.inlineMessageContext === true;
              const hold = readPostPreparationMemoryDispatchHold({
                environmentId,
                instanceId: target.selection.instanceId,
                dispatchContext: context,
              });
              if (hold !== null) {
                throw new Error(hold);
              }
              requestMayHaveStarted = true;
              const result = await startThreadTurn({
                environmentId,
                input: {
                  threadId: targetThreadId,
                  message: {
                    messageId: newMessageId(),
                    role: "user",
                    text:
                      context && !supportsInlineMessageContext
                        ? serializeLegacyContextMessage({
                            text: target.text,
                            records: context.records,
                          })
                        : target.text,
                    attachments,
                    ...(context && supportsInlineMessageContext ? { context } : {}),
                  },
                  modelSelection: target.selection,
                  titleSeed: title,
                  runtimeMode,
                  interactionMode: target.interactionMode,
                  bootstrap: {
                    createThread: {
                      projectId: activeProject.id,
                      title,
                      modelSelection: target.selection,
                      runtimeMode,
                      interactionMode: target.interactionMode,
                      branch: activeThreadBranch,
                      worktreePath: null,
                      ...(draftThread?.crew !== undefined ? { crew: draftThread.crew } : {}),
                      createdAt: messageCreatedAt,
                    },
                    prepareWorktree: {
                      projectCwd: activeProject.workspaceRoot,
                      baseBranch: activeThreadBranch!,
                      requireWorktree: true,
                      branch: buildTemporaryWorktreeBranchName(randomHex),
                      ...(startFromOrigin ? { startFromOrigin: true } : {}),
                    },
                    runSetupScript: true,
                  },
                  createdAt: messageCreatedAt,
                },
              });
              if (result._tag === "Failure") {
                const error = squashAtomCommandFailure(result);
                if (wasBootstrapThreadDeleted(error) || wasBootstrapThreadNotCreated(error)) {
                  requestMayHaveStarted = false;
                }
                throw error;
              }
              startedCount += 1;
            } catch (error) {
              if (requestMayHaveStarted && !uncertainMultipleSubmissionsRef.current.has(retryKey)) {
                uncertainMultipleSubmissionsRef.current.set(retryKey, targetThreadId);
              }
              failedSelections.push(target.selection);
              const retainedThreadId = uncertainMultipleSubmissionsRef.current.get(retryKey);
              const failureToastId = toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: `Could not start ${target.selection.model}`,
                  description: error instanceof Error ? error.message : "Failed to send message.",
                  ...(retainedThreadId
                    ? {
                        timeout: 0,
                        data: {
                          secondaryActionProps: {
                            children: "Allow retry",
                            onClick: () => {
                              void readLocalApi()
                                ?.dialogs.confirm(
                                  "The previous request may already be running. Check its thread first. Allow another send that could create a duplicate thread?",
                                )
                                .then(
                                  (confirmed) => {
                                    if (
                                      confirmed &&
                                      uncertainMultipleSubmissionsRef.current.get(retryKey) ===
                                        retainedThreadId
                                    ) {
                                      uncertainMultipleSubmissionsRef.current.delete(retryKey);
                                      toastManager.close(failureToastId);
                                    }
                                  },
                                  () => undefined,
                                );
                            },
                          },
                        },
                        actionProps: {
                          children: "Open thread",
                          onClick: () => {
                            void navigate({
                              to: "/$environmentId/$threadId",
                              params: buildThreadRouteParams(
                                scopeThreadRef(environmentId, retainedThreadId),
                              ),
                            });
                          },
                        },
                      }
                    : {}),
                }),
              );
            }
          }),
        );
        // Each request now owns its background thread. The original draft is
        // ready for another prompt while checkout and setup scripts finish.
        sendInFlightRef.current = false;
        resetLocalDispatch();
        releasedComposer = true;
        await starts;
        if (startedCount > 0) {
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Started ${startedCount} ${startedCount === 1 ? "thread" : "threads"} in background`,
            }),
          );
        }
        if (failedSelections.length === 0 && turnUsesAttachmentUploads) {
          releaseDraftAttachments(composerAttachmentsSnapshot);
        }
      } catch (error) {
        failedSelections.push(...multipleModelSelections);
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send messages.",
        );
      } finally {
        const restoreFailedDraft = () => {
          setMultipleModelSelections(failedSelections);
          if (clearedDraft) {
            // Same project-origin contract as the single-send restore.
            const draftSessionAtRestore =
              isLocalDraftThread && draftId
                ? useComposerDraftStore.getState().getDraftSession(draftId)
                : null;
            const memoryRestoreMatchesProject =
              !isLocalDraftThread ||
              (draftSessionAtRestore !== null &&
                draftSessionAtRestore.environmentId === sendProjectRef.environmentId &&
                draftSessionAtRestore.projectId === sendProjectRef.projectId);
            const restoredPrompt = memoryRestoreMatchesProject
              ? messageTextForSend
              : promptWithoutProjectMemoryReferences(
                  messageTextForSend,
                  composerProjectMemoryReferencesSnapshot,
                );
            setComposerDraftPrompt(composerDraftTarget, restoredPrompt);
            addComposerDraftImages(
              composerDraftTarget,
              composerImagesSnapshot.map(cloneComposerImageForRetry),
            );
            addComposerDraftFiles(composerDraftTarget, composerFilesSnapshot);
            setComposerDraftTerminalContexts(composerDraftTarget, composerTerminalContextsSnapshot);
            setComposerDraftPreviewAnnotations(
              composerDraftTarget,
              composerPreviewAnnotationsSnapshot,
            );
            setComposerDraftReviewComments(composerDraftTarget, composerReviewCommentsSnapshot);
            if (memoryRestoreMatchesProject) {
              setComposerDraftProjectMemoryReferences(
                composerDraftTarget,
                composerProjectMemoryReferencesSnapshot,
              );
            }
            if (composerRef.current && currentRouteThreadKeyRef.current === routeThreadKey) {
              promptRef.current = restoredPrompt;
              composerRef.current.resetCursorState({
                cursor: collapseExpandedComposerCursor(restoredPrompt, restoredPrompt.length),
                prompt: restoredPrompt,
                detectTrigger: true,
              });
            }
          }
        };
        if (failedSelections.length > 0) {
          if (canRestoreDraft() && composerRef.current) {
            restoreFailedDraft();
          } else if (clearedDraft) {
            const recoveryToastId = toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "A background prompt could not be sent",
                description:
                  "Your newer draft is unchanged. Restore the failed prompt when this composer is empty.",
                timeout: 0,
                actionProps: {
                  children: "Restore prompt",
                  onClick: () => {
                    if (
                      !draftId ||
                      !useComposerDraftStore.getState().getDraftSession(draftId) ||
                      sendInFlightRef.current ||
                      composerDraftHasUserContent(
                        useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
                      )
                    ) {
                      toastManager.update(recoveryToastId, {
                        description:
                          "Return to the original draft and send or clear its current prompt before restoring.",
                      });
                      return;
                    }
                    restoreFailedDraft();
                    void navigate({ to: "/draft/$draftId", params: { draftId } });
                    toastManager.close(recoveryToastId);
                  },
                },
              }),
            );
          }
        }
        if (!releasedComposer) {
          sendInFlightRef.current = false;
          resetLocalDispatch();
        }
      }
      return;
    }
    const optimisticAttachments = composerAttachmentsSnapshot.map((attachment) =>
      attachment.type === "image"
        ? {
            type: "image" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            previewUrl: attachment.previewUrl,
            ...(attachment.source ? { source: attachment.source } : {}),
          }
        : {
            type: "file" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            downloadable: false,
            ...(attachment.source ? { source: attachment.source } : {}),
          },
    );
    const shouldAnchorFirstMessage =
      activeThread.latestTurn === null &&
      !timelineMessages.some((message) => message.role === "user");
    if (shouldAnchorFirstMessage) {
      isAtEndRef.current = true;
      timelineScrollModeRef.current = "anchoring-new-turn";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      setTimelineLiveFollowEnabled(true);
      pendingTimelineAnchorRef.current = messageIdForSend;
      activeTimelineAnchorIndexRef.current = null;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      setTimelineAnchor({
        threadKey: scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
        messageId: messageIdForSend,
      });
    } else {
      scrollToEnd();
    }
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        ...(outgoingMessageContext !== undefined ? { context: outgoingMessageContext } : {}),
        turnId: null,
        createdAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
        streaming: false,
      },
    ]);
    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        }),
      );
    }
    promptRef.current = "";
    clearComposerDraftContent(composerDraftTarget);
    composerRef.current?.resetCursorState();

    let firstComposerImageName: string | null = null;
    if (composerImagesSnapshot.length > 0) {
      const firstComposerImage = composerImagesSnapshot[0];
      if (firstComposerImage) {
        firstComposerImageName = firstComposerImage.name;
      }
    }
    let titleSeed = assistantCitationsToPlainText(stripInlineContextReferences(trimmed)).trim();
    if (!titleSeed) {
      if (firstComposerImageName) {
        titleSeed = `Image: ${firstComposerImageName}`;
      } else if (composerFilesSnapshot[0]) {
        titleSeed = `File: ${composerFilesSnapshot[0].name}`;
      } else if (composerTerminalContextsSnapshot.length > 0) {
        titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
      } else if (composerReviewCommentsSnapshot.length > 0) {
        titleSeed = `Review: ${reviewCommentContextLabel(composerReviewCommentsSnapshot[0]!)}`;
      } else if (composerPreviewAnnotationsSnapshot.length > 0) {
        titleSeed = previewAnnotationContextLabel(composerPreviewAnnotationsSnapshot[0]!);
      } else {
        titleSeed = "New thread";
      }
    }
    const title = truncate(titleSeed);
    const threadCreateModelSelection = createModelSelection(
      ctxSelectedModelSelection.instanceId,
      ctxSelectedModel || activeProjectDefaultModelSelection?.model || DEFAULT_MODEL,
      ctxSelectedModelSelection.options,
    );

    let failure: AtomCommandResult<unknown, unknown> | null = null;
    // Auto-title from first message
    if (isFirstMessage && isServerThread) {
      const titleResult = await updateThreadMetadata({
        environmentId,
        input: {
          threadId: threadIdForSend,
          title,
        },
      });
      if (titleResult._tag === "Failure") {
        failure = titleResult;
      }
    }

    if (failure === null && isServerThread) {
      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        ...(ctxSelectedModel ? { modelSelection: ctxSelectedModelSelection } : {}),
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode: sendInteractionMode,
      });
      if (settingsResult._tag === "Failure") {
        failure = settingsResult;
      }
    }

    const turnAttachmentsResult = await settlePromise(async () => {
      const turnAttachments = await turnAttachmentsPromise;
      const liveFileBlockReason = readLiveAttachmentCapabilities().fileBlockReason;
      if (liveFileBlockReason !== null) {
        throw new Error(liveFileBlockReason);
      }
      return turnAttachments;
    });
    if (failure === null && turnAttachmentsResult._tag === "Failure") {
      failure = turnAttachmentsResult;
    }

    let turnStartSucceeded = false;
    let backgroundDraftOpened = false;
    if (failure === null && turnAttachmentsResult._tag === "Success") {
      const bootstrap =
        isLocalDraftThread || baseBranchForWorktree
          ? {
              ...(isLocalDraftThread
                ? {
                    createThread: {
                      projectId: activeProject.id,
                      title,
                      modelSelection: threadCreateModelSelection,
                      runtimeMode,
                      interactionMode: sendInteractionMode,
                      branch: activeThreadBranch,
                      worktreePath: activeThread.worktreePath,
                      ...(draftThread?.crew !== undefined ? { crew: draftThread.crew } : {}),
                      createdAt: activeThread.createdAt,
                    },
                  }
                : {}),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: activeProject.workspaceRoot,
                      baseBranch: baseBranchForWorktree,
                      branch: buildTemporaryWorktreeBranchName(randomHex),
                      ...(startFromOrigin ? { startFromOrigin: true } : {}),
                    },
                    runSetupScript: true,
                  }
                : {}),
            }
          : undefined;
      const backgroundThreadRef =
        resolvedSubmissionIntent === "background"
          ? scopeThreadRef(activeThread.environmentId, threadIdForSend)
          : null;
      if (backgroundThreadRef) {
        beginBackgroundDraftSubmissionByRef(backgroundThreadRef);
      }
      // Read the capability at dispatch time: the upload and persistence
      // awaits above can span a server reconnect that changes it. Servers
      // from before inline context drop the records and forward the links
      // as literal text, so their turns carry the payload the legacy way —
      // except memory references, which never flatten: they hold the send.
      const dispatchContext = buildOutgoingMessageContext(
        turnAttachmentsResult.value.map((attachment, index) =>
          "id" in attachment && attachment.id !== undefined
            ? attachment.id
            : composerAttachmentsSnapshot[index]!.id,
        ),
      );
      // Second, post-await reconciliation with the shared guard: the upload
      // and persistence awaits above can span a server reconnect that changes
      // the descriptor or provider. Memory holds with the exact failed-send
      // restoration; non-memory context keeps the legacy path.
      const memoryHoldReason = readPostPreparationMemoryDispatchHold({
        environmentId,
        instanceId: ctxSelectedModelSelection.instanceId,
        dispatchContext,
      });
      const memorySkewHold = memoryHoldReason !== null;
      if (memorySkewHold) {
        failure = AsyncResult.failure(Cause.fail(new Error(memoryHoldReason)));
      }
      const startPromise = memorySkewHold
        ? null
        : dispatchDirectThreadTurnMessage({
            environmentId,
            threadId: threadIdForSend,
            instanceId: ctxSelectedModelSelection.instanceId,
            outgoingMessageText,
            dispatchContext,
            attachments: turnAttachmentsResult.value,
            modelSelection: ctxSelectedModelSelection,
            runtimeMode,
            interactionMode: sendInteractionMode,
            messageId: messageIdForSend,
            createdAt: messageCreatedAt,
            titleSeed: title,
            ...(bootstrap ? { bootstrap } : {}),
          }).then(
            () => ({ _tag: "Success" as const, value: undefined }),
            (error) => {
              if (error instanceof DirectMemoryDispatchHoldError) {
                return AsyncResult.failure(Cause.fail(new Error(error.holdReason)));
              }
              throw error;
            },
          );
      if (backgroundThreadRef && !memorySkewHold) {
        markPromotedDraftThreadByRef(backgroundThreadRef);
        try {
          backgroundDraftOpened = Boolean(
            await handleNewThread(
              scopeProjectRef(activeProject.environmentId, activeProject.id),
              resolveBackgroundDraftWorkspaceOptions({
                envMode: sendEnvMode,
                branch: activeThreadBranch,
                startFromOrigin,
              }),
            ),
          );
        } catch (error) {
          clearBackgroundDraftSubmissionByRef(backgroundThreadRef);
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Could not open a fresh composer",
              description: error instanceof Error ? error.message : undefined,
            }),
          );
        }
      }
      const startResult = startPromise === null ? null : await startPromise;
      if (startResult !== null && startResult._tag === "Failure") {
        failure = startResult;
      } else if (startResult !== null) {
        turnStartSucceeded = true;
        // The turn is under way and will spend quota, so that thread's limits
        // snapshot is stale. Uploads may have outlasted a navigation, so only
        // the sending thread's panel clears.
        clearUsageLimitsFor(routeThreadKey);
        if (turnUsesAttachmentUploads) {
          releaseDraftAttachments(composerAttachmentsSnapshot);
        }
        acknowledgeActiveThreadWoke();
        if (backgroundThreadRef) {
          if (backgroundDraftOpened || currentRouteThreadKeyRef.current !== routeThreadKey) {
            finalizePromotedDraftThreadByRef(backgroundThreadRef);
          } else {
            clearBackgroundDraftSubmissionByRef(backgroundThreadRef);
          }
          if (backgroundDraftOpened) {
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: "Started in background",
                timeout: 5_000,
                actionProps: {
                  children: "Open",
                  onClick: () => {
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(backgroundThreadRef),
                    });
                  },
                },
              }),
            );
          }
        }
      }
    }

    if (failure !== null) {
      if (resolvedSubmissionIntent === "background" && draftId && draftThread) {
        restoreFailedBackgroundDraftThread(
          draftId,
          draftThread,
          wasBootstrapThreadDeleted(squashAtomCommandFailure(failure))
            ? newThreadId()
            : threadIdForSend,
        );
        clearBackgroundDraftSubmissionByRef(scopeThreadRef(environmentId, threadIdForSend));
      }
      if (
        backgroundDraftOpened
          ? !composerDraftHasUserContent(
              useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
            )
          : promptRef.current.length === 0 &&
            composerImagesRef.current.length === 0 &&
            composerFilesRef.current.length === 0 &&
            composerTerminalContextsRef.current.length === 0 &&
            (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)
              ?.previewAnnotations.length ?? 0) === 0 &&
            (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.reviewComments
              .length ?? 0) === 0 &&
            (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)
              ?.projectMemoryReferences.length ?? 0) === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        const draftSessionAtFailure =
          isLocalDraftThread && draftId
            ? useComposerDraftStore.getState().getDraftSession(draftId)
            : null;
        const memoryRestoreMatchesProject =
          !isLocalDraftThread ||
          (draftSessionAtFailure !== null &&
            draftSessionAtFailure.environmentId === sendProjectRef.environmentId &&
            draftSessionAtFailure.projectId === sendProjectRef.projectId);
        const restoredPrompt = memoryRestoreMatchesProject
          ? messageTextForSend
          : promptWithoutProjectMemoryReferences(
              messageTextForSend,
              composerProjectMemoryReferencesSnapshot,
            );
        promptRef.current = restoredPrompt;
        const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry);
        composerImagesRef.current = retryComposerImages;
        composerFilesRef.current = composerFilesSnapshot;
        composerTerminalContextsRef.current = composerTerminalContextsSnapshot;
        restoreComposerDraftAfterDirectSendFailure({
          composerDraftTarget,
          messageTextForSend,
          projectMemoryReferences: composerProjectMemoryReferencesSnapshot,
          images: retryComposerImages,
          files: composerFilesSnapshot,
          terminalContexts: composerTerminalContextsSnapshot,
          previewAnnotations: composerPreviewAnnotationsSnapshot,
          reviewComments: composerReviewCommentsSnapshot,
          memoryRestoreMatchesProject,
        });
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(restoredPrompt, restoredPrompt.length),
          prompt: restoredPrompt,
          detectTrigger: true,
        });
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        if (
          resolvedSubmissionIntent !== "background" &&
          isLocalDraftThread &&
          draftId &&
          wasBootstrapThreadDeleted(error)
        ) {
          const failedDraftSession = getDraftSession(draftId);
          if (failedDraftSession?.threadId === threadIdForSend) {
            setLogicalProjectDraftThreadId(
              failedDraftSession.logicalProjectKey,
              scopeProjectRef(failedDraftSession.environmentId, failedDraftSession.projectId),
              draftId,
              {
                threadId: newThreadId(),
                createdAt: new Date().toISOString(),
              },
            );
          }
        }
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send message.",
        );
        if (backgroundDraftOpened && draftId) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Background task failed",
              description: error instanceof Error ? error.message : "Failed to send message.",
              actionProps: {
                children: "Open draft",
                onClick: () => {
                  void navigate({ to: "/draft/$draftId", params: { draftId } });
                },
              },
            }),
          );
        }
      }
    }
    sendInFlightRef.current = false;
    if (!turnStartSucceeded) {
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      resetLocalDispatch();
    }
  };

  return { onSend };
}
