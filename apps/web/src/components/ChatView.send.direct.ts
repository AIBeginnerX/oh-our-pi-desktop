import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { wasBootstrapThreadDeleted } from "@t3tools/client-runtime/errors";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_MODEL,
  type MessageId,
  type ModelSelection,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { createModelSelection } from "@t3tools/shared/model";
import { truncate } from "@t3tools/shared/String";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { newThreadId, randomHex } from "~/lib/utils";
import { collapseExpandedComposerCursor } from "../composer-logic";
import {
  beginBackgroundDraftSubmissionByRef,
  clearBackgroundDraftSubmissionByRef,
  type ComposerImageAttachment,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  restoreFailedBackgroundDraftThread,
  useComposerDraftStore,
} from "../composerDraftStore";
import { releaseDraftAttachments } from "../lib/attachmentUploadQueue";
import {
  buildMessageContext,
  previewAnnotationContextLabel,
  reviewCommentContextLabel,
} from "../lib/composerContextRecords";
import { stripInlineContextReferences } from "../lib/composerContextReferences";
import { formatTerminalContextLabel } from "../lib/terminalContext";
import { type ReviewCommentContext } from "../reviewCommentContext";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  dispatchDirectThreadTurnMessage,
  readPostPreparationMemoryDispatchHold,
  restoreComposerDraftAfterDirectSendFailure,
} from "./chat/sendQueuedMessage";
import {
  buildExpiredTerminalContextToastCopy,
  cloneComposerImageForRetry,
  resolveBackgroundDraftWorkspaceOptions,
  revokeUserMessagePreviewUrls,
} from "./ChatView.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

import type { SendSources } from "./ChatView.send";

export async function sendDirectMessage({
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
}: {
  composerAttachmentsSnapshot: (
    | ComposerImageAttachment
    | import("../composerDraftStore.types").ComposerFileAttachment
  )[];
  isSendingComposerVisible: () => boolean;
  activeThread: NonNullable<SendSources["threadState"]["activeThread"]>;
  timelineMessages: SendSources["timelineData"]["timelineMessages"];
  isAtEndRef: SendSources["threadState"]["isAtEndRef"];
  timelineScrollModeRef: SendSources["timelineScroll"]["timelineScrollModeRef"];
  liveFollowUserScrollGenerationRef: SendSources["timelineScroll"]["liveFollowUserScrollGenerationRef"];
  anchorUserScrollGenerationRef: SendSources["timelineScroll"]["anchorUserScrollGenerationRef"];
  setTimelineLiveFollowEnabled: SendSources["timelineScroll"]["setTimelineLiveFollowEnabled"];
  pendingTimelineAnchorRef: SendSources["timelineScroll"]["pendingTimelineAnchorRef"];
  messageIdForSend: string & import("effect/Brand").Brand<"MessageId">;
  activeTimelineAnchorIndexRef: SendSources["timelineScroll"]["activeTimelineAnchorIndexRef"];
  showScrollDebouncer: SendSources["timelineScroll"]["showScrollDebouncer"];
  setShowScrollToBottom: SendSources["threadState"]["setShowScrollToBottom"];
  setTimelineAnchor: SendSources["threadState"]["setTimelineAnchor"];
  threadIdForSend: string & import("effect/Brand").Brand<"ThreadId">;
  scrollToEnd: SendSources["timelineScroll"]["scrollToEnd"];
  outgoingMessageText: string;
  outgoingMessageContext: ReturnType<typeof buildMessageContext>;
  messageCreatedAt: string;
  messageTextForSend: string;
  composerProjectMemoryReferencesSnapshot: import("../composerDraftStore.types").ComposerProjectMemoryReference[];
  composerImagesSnapshot: ComposerImageAttachment[];
  composerFilesSnapshot: import("../composerDraftStore.types").ComposerFileAttachment[];
  composerTerminalContextsSnapshot: import("../lib/terminalContext").TerminalContextDraft[];
  composerPreviewAnnotationsSnapshot: PreviewAnnotationPayload[];
  composerReviewCommentsSnapshot: ReviewCommentContext[];
  setOptimisticUserMessages: SendSources["threadState"]["setOptimisticUserMessages"];
  setThreadError: SendSources["terminalsAndScripts"]["setThreadError"];
  expiredTerminalContextCount: number;
  clearSubmittedComposer: () => void;
  trimmed: string;
  ctxSelectedModelSelection: ModelSelection;
  ctxSelectedModel: string;
  activeProjectDefaultModelSelection: SendSources["projectEnvironment"]["activeProjectDefaultModelSelection"];
  isFirstMessage: boolean;
  isServerThread: SendSources["threadState"]["isServerThread"];
  updateThreadMetadata: SendSources["threadState"]["updateThreadMetadata"];
  environmentId: SendSources["threadState"]["environmentId"];
  persistThreadSettingsForNextTurn: SendSources["rightPanel"]["persistThreadSettingsForNextTurn"];
  localCheckoutBranchMismatch: SendSources["threadStatus"]["localCheckoutBranchMismatch"];
  runtimeMode: SendSources["threadState"]["runtimeMode"];
  sendInteractionMode: import("@t3tools/contracts").ProviderInteractionMode;
  turnAttachmentsPromise: Promise<
    ReadonlyArray<Parameters<typeof dispatchDirectThreadTurnMessage>[0]["attachments"][number]>
  >;
  readLiveAttachmentCapabilities: () => {
    supportsAttachmentUploads: boolean;
    fileBlockReason: string | null;
  };
  isLocalDraftThread: SendSources["threadState"]["isLocalDraftThread"];
  baseBranchForWorktree: string | null;
  activeProject: NonNullable<SendSources["projectEnvironment"]["activeProject"]>;
  activeThreadBranch: SendSources["threadStatus"]["activeThreadBranch"];
  draftThread: SendSources["threadState"]["draftThread"];
  startFromOrigin: SendSources["threadStatus"]["startFromOrigin"];
  resolvedSubmissionIntent: "background" | "foreground";
  buildOutgoingMessageContext: (
    attachmentIds: ReadonlyArray<string>,
  ) => ReturnType<typeof buildMessageContext>;
  handleNewThread: SendSources["threadState"]["handleNewThread"];
  sendEnvMode: SendSources["threadStatus"]["sendEnvMode"];
  clearUsageLimitsFor: SendSources["timelineData"]["clearUsageLimitsFor"];
  routeThreadKey: SendSources["threadState"]["routeThreadKey"];
  turnUsesAttachmentUploads: boolean;
  acknowledgeActiveThreadWoke: SendSources["threadStatus"]["acknowledgeActiveThreadWoke"];
  currentRouteThreadKeyRef: SendSources["threadState"]["currentRouteThreadKeyRef"];
  navigate: SendSources["threadState"]["navigate"];
  draftId: SendSources["threadState"]["draftId"];
  recoverFailedSend: <Draft extends object>(
    send: { messageId: MessageId; draft: Draft },
    restore: (draft: Draft) => void,
    errorMessage?: string,
  ) => boolean;
  sendProjectRef: import("@t3tools/contracts").ScopedProjectRef;
  composerDraftTarget: SendSources["threadState"]["composerDraftTarget"];
  readDraft: () => import("../composerDraftStore.types").ComposerThreadDraftState | null;
  promptRef: SendSources["threadState"]["promptRef"];
  composerImagesRef: SendSources["threadState"]["composerImagesRef"];
  composerFilesRef: SendSources["threadState"]["composerFilesRef"];
  composerTerminalContextsRef: SendSources["threadState"]["composerTerminalContextsRef"];
  composerRef: SendSources["threadState"]["composerRef"];
  getDraftSession: SendSources["threadState"]["getDraftSession"];
  setLogicalProjectDraftThreadId: SendSources["threadState"]["setLogicalProjectDraftThreadId"];
  reportSendFailure: (message: string, recoveryOffered?: boolean) => void;
  sendInFlightRef: SendSources["threadState"]["sendInFlightRef"];
  setDockedDraftHeroThreadKey: SendSources["terminalsAndScripts"]["setDockedDraftHeroThreadKey"];
  activeThreadKey: SendSources["threadState"]["activeThreadKey"];
  resetLocalDispatch: SendSources["timelineData"]["resetLocalDispatch"];
}) {
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
  const showOptimisticMessage = isSendingComposerVisible();
  if (showOptimisticMessage) {
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
  }
  const optimisticMessage = {
    id: messageIdForSend,
    role: "user" as const,
    text: outgoingMessageText,
    ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
    ...(outgoingMessageContext !== undefined ? { context: outgoingMessageContext } : {}),
    turnId: null,
    createdAt: messageCreatedAt,
    updatedAt: messageCreatedAt,
    streaming: false,
  };
  const send = {
    messageId: messageIdForSend,
    draft: {
      messageTextForSend,
      projectMemoryReferences: composerProjectMemoryReferencesSnapshot,
      images: composerImagesSnapshot,
      files: composerFilesSnapshot,
      terminalContexts: composerTerminalContextsSnapshot,
      previewAnnotations: composerPreviewAnnotationsSnapshot,
      reviewComments: composerReviewCommentsSnapshot,
    },
  };
  if (showOptimisticMessage) {
    setOptimisticUserMessages((existing) => [...existing, optimisticMessage]);
  }
  setThreadError(threadIdForSend, null);
  if (expiredTerminalContextCount > 0) {
    const toastCopy = buildExpiredTerminalContextToastCopy(expiredTerminalContextCount, "omitted");
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      }),
    );
  }
  clearSubmittedComposer();

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
      ...(localCheckoutBranchMismatch ? { branch: localCheckoutBranchMismatch.currentBranch } : {}),
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
      : settlePromise(() =>
          dispatchDirectThreadTurnMessage({
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
          }),
        );
    if (backgroundThreadRef && !memorySkewHold) {
      markPromotedDraftThreadByRef(backgroundThreadRef);
      try {
        backgroundDraftOpened =
          isSendingComposerVisible() &&
          Boolean(
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
      if (!showOptimisticMessage) revokeUserMessagePreviewUrls(optimisticMessage);
      if (isSendingComposerVisible()) acknowledgeActiveThreadWoke();
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
    const interrupted = isAtomCommandInterrupted(failure);
    const error = squashAtomCommandFailure(failure);
    const errorMessage = error instanceof Error ? error.message : "Failed to send message.";
    if (!showOptimisticMessage) revokeUserMessagePreviewUrls(optimisticMessage);
    const recoveryOffered = recoverFailedSend(
      send,
      (draft) => {
        const draftSessionAtFailure =
          isLocalDraftThread && draftId
            ? useComposerDraftStore.getState().getDraftSession(draftId)
            : null;
        const memoryRestoreMatchesProject =
          !isLocalDraftThread ||
          (draftSessionAtFailure !== null &&
            draftSessionAtFailure.environmentId === sendProjectRef.environmentId &&
            draftSessionAtFailure.projectId === sendProjectRef.projectId);
        const retryComposerImages = draft.images.map(cloneComposerImageForRetry);
        restoreComposerDraftAfterDirectSendFailure({
          ...draft,
          composerDraftTarget,
          images: retryComposerImages,
          memoryRestoreMatchesProject,
        });
        if (isSendingComposerVisible()) {
          const restoredDraft = readDraft();
          const prompt = restoredDraft?.prompt ?? "";
          promptRef.current = prompt;
          composerImagesRef.current = retryComposerImages;
          composerFilesRef.current = draft.files;
          composerTerminalContextsRef.current = restoredDraft?.terminalContexts ?? [];
          composerRef.current?.resetCursorState({
            cursor: collapseExpandedComposerCursor(prompt, prompt.length),
            prompt,
            detectTrigger: true,
          });
        }
      },
      interrupted ? undefined : errorMessage,
    );
    if (!interrupted) {
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
      reportSendFailure(errorMessage, recoveryOffered);
      if (!recoveryOffered && backgroundDraftOpened && draftId) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Background task failed",
            description: errorMessage,
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
    if (isSendingComposerVisible()) resetLocalDispatch();
  }
}
