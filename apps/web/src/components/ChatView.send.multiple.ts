import type { dispatchDirectThreadTurnMessage } from "./chat/sendQueuedMessage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
} from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type ModelSelection, type PreviewAnnotationPayload } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { truncate } from "@t3tools/shared/String";
import { newMessageId, newThreadId, randomHex } from "~/lib/utils";
import { collapseExpandedComposerCursor } from "../composer-logic";
import { type ComposerImageAttachment, useComposerDraftStore } from "../composerDraftStore";
import { releaseDraftAttachments } from "../lib/attachmentUploadQueue";
import {
  buildMessageContext,
  promptWithoutProjectMemoryReferences,
} from "../lib/composerContextRecords";
import { stripInlineContextReferences } from "../lib/composerContextReferences";
import { readLocalApi } from "../localApi";
import { type ReviewCommentContext } from "../reviewCommentContext";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import { readPostPreparationMemoryDispatchHold } from "./chat/sendQueuedMessage";
import { cloneComposerImageForRetry, revokeBlobPreviewUrl } from "./ChatView.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

import type { SendSources } from "./ChatView.send";

export async function sendMultipleModels({
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
}: {
  turnAttachmentsPromise: Promise<
    ReadonlyArray<Parameters<typeof dispatchDirectThreadTurnMessage>[0]["attachments"][number]>
  >;
  composerChangedWhilePreparing: () => boolean;
  reportChangedDraft: () => void;
  setDockedDraftHeroThreadKey: SendSources["terminalsAndScripts"]["setDockedDraftHeroThreadKey"];
  activeThreadKey: SendSources["threadState"]["activeThreadKey"];
  readLiveAttachmentCapabilities: () => {
    supportsAttachmentUploads: boolean;
    fileBlockReason: string | null;
  };
  buildOutgoingMessageContext: (
    attachmentIds: ReadonlyArray<string>,
  ) => ReturnType<typeof buildMessageContext>;
  composerAttachmentsSnapshot: (
    | ComposerImageAttachment
    | import("../composerDraftStore.types").ComposerFileAttachment
  )[];
  trimmed: string;
  clearSubmittedComposer: () => void;
  composerImagesSnapshot: ComposerImageAttachment[];
  composerDraftTarget: SendSources["threadState"]["composerDraftTarget"];
  multipleModelSelectionsRef: SendSources["threadState"]["multipleModelSelectionsRef"];
  currentRouteThreadKeyRef: SendSources["threadState"]["currentRouteThreadKeyRef"];
  routeThreadKey: SendSources["threadState"]["routeThreadKey"];
  composerSendGenerationRef: SendSources["threadState"]["composerSendGenerationRef"];
  sendGeneration: number;
  setThreadError: SendSources["terminalsAndScripts"]["setThreadError"];
  threadIdForSend: string & import("effect/Brand").Brand<"ThreadId">;
  multipleTargets: Array<{
    selection: ModelSelection;
    text: string;
    interactionMode: import("@t3tools/contracts").ProviderInteractionMode;
  }>;
  uncertainMultipleSubmissionsRef: SendSources["threadState"]["uncertainMultipleSubmissionsRef"];
  environmentId: SendSources["threadState"]["environmentId"];
  startThreadTurn: SendSources["threadState"]["startThreadTurn"];
  runtimeMode: SendSources["threadState"]["runtimeMode"];
  activeProject: NonNullable<SendSources["projectEnvironment"]["activeProject"]>;
  activeThreadBranch: SendSources["threadStatus"]["activeThreadBranch"];
  draftThread: SendSources["threadState"]["draftThread"];
  messageCreatedAt: string;
  startFromOrigin: SendSources["threadStatus"]["startFromOrigin"];
  navigate: SendSources["threadState"]["navigate"];
  sendInFlightRef: SendSources["threadState"]["sendInFlightRef"];
  isSendingComposerVisible: () => boolean;
  resetLocalDispatch: SendSources["timelineData"]["resetLocalDispatch"];
  turnUsesAttachmentUploads: boolean;
  multipleModelSelections: readonly {
    readonly instanceId: string & import("effect/Brand").Brand<"ProviderInstanceId">;
    readonly model: string;
    readonly options?: readonly { readonly id: string; readonly value: string | boolean }[];
  }[];
  setMultipleModelSelections: SendSources["threadState"]["setMultipleModelSelections"];
  isLocalDraftThread: SendSources["threadState"]["isLocalDraftThread"];
  draftId: SendSources["threadState"]["draftId"];
  sendProjectRef: import("@t3tools/contracts").ScopedProjectRef;
  messageTextForSend: string;
  composerProjectMemoryReferencesSnapshot: import("../composerDraftStore.types").ComposerProjectMemoryReference[];
  setComposerDraftPrompt: SendSources["threadState"]["setComposerDraftPrompt"];
  addComposerDraftImages: SendSources["threadState"]["addComposerDraftImages"];
  addComposerDraftFiles: SendSources["threadState"]["addComposerDraftFiles"];
  composerFilesSnapshot: import("../composerDraftStore.types").ComposerFileAttachment[];
  setComposerDraftTerminalContexts: SendSources["threadState"]["setComposerDraftTerminalContexts"];
  composerTerminalContextsSnapshot: import("../lib/terminalContext").TerminalContextDraft[];
  setComposerDraftPreviewAnnotations: SendSources["threadState"]["setComposerDraftPreviewAnnotations"];
  composerPreviewAnnotationsSnapshot: PreviewAnnotationPayload[];
  setComposerDraftReviewComments: SendSources["threadState"]["setComposerDraftReviewComments"];
  composerReviewCommentsSnapshot: ReviewCommentContext[];
  setComposerDraftProjectMemoryReferences: SendSources["threadState"]["setComposerDraftProjectMemoryReferences"];
  composerRef: SendSources["threadState"]["composerRef"];
  readDraft: () => import("../composerDraftStore.types").ComposerThreadDraftState | null;
  promptRef: SendSources["threadState"]["promptRef"];
  composerTerminalContextsRef: SendSources["threadState"]["composerTerminalContextsRef"];
  recoveryTargetExists: () => boolean;
  hasNewerDraft: () => boolean;
  offerFailedSendRecovery: (restore: () => void, errorMessage?: string) => void;
  reportSendFailure: (message: string, recoveryOffered?: boolean) => void;
}) {
  const failedSelections: ModelSelection[] = [];
  let clearedDraft = false;
  let releasedComposer = false;
  let errorMessage: string | undefined;
  let canRestoreDraft = () => false;
  let startedCount = 0;
  try {
    const attachments = await turnAttachmentsPromise;
    if (composerChangedWhilePreparing()) {
      reportChangedDraft();
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      return;
    }
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
    clearSubmittedComposer();
    clearedDraft = true;
    for (const image of composerImagesSnapshot) revokeBlobPreviewUrl(image.previewUrl);
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
    if (isSendingComposerVisible()) resetLocalDispatch();
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
    errorMessage = error instanceof Error ? error.message : "Failed to send messages.";
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
        setComposerDraftPreviewAnnotations(composerDraftTarget, composerPreviewAnnotationsSnapshot);
        setComposerDraftReviewComments(composerDraftTarget, composerReviewCommentsSnapshot);
        if (memoryRestoreMatchesProject) {
          setComposerDraftProjectMemoryReferences(
            composerDraftTarget,
            composerProjectMemoryReferencesSnapshot,
          );
        }
        if (composerRef.current && currentRouteThreadKeyRef.current === routeThreadKey) {
          const restoredDraft = readDraft();
          const prompt = restoredDraft?.prompt ?? "";
          promptRef.current = prompt;
          composerTerminalContextsRef.current = restoredDraft?.terminalContexts ?? [];
          composerRef.current.resetCursorState({
            cursor: collapseExpandedComposerCursor(prompt, prompt.length),
            prompt,
            detectTrigger: true,
          });
        }
      }
    };
    let recoveryOffered = false;
    if (failedSelections.length > 0 && clearedDraft) {
      if (canRestoreDraft() && recoveryTargetExists() && !hasNewerDraft()) {
        restoreFailedDraft();
      } else {
        offerFailedSendRecovery(restoreFailedDraft, errorMessage);
        recoveryOffered = true;
      }
    }
    if (errorMessage !== undefined) reportSendFailure(errorMessage, recoveryOffered);
    if (!releasedComposer) {
      sendInFlightRef.current = false;
      if (isSendingComposerVisible()) resetLocalDispatch();
    }
  }
}
