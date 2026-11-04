import {
  questionAttachmentDraftId,
  useQuestionAttachmentPreparation,
} from "../questionAttachments";
import { type ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useCallback } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  carryDisplacedCustomAnswerIntoPrompt,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "../pendingUserInput";
import { newMessageId } from "~/lib/utils";
import { useComposerDraftStore } from "../composerDraftStore";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import { buildMessageContext } from "../lib/composerContextRecords";
import { useQueuedMessageStore } from "../queuedMessageStore";
import { readPostPreparationMemoryDispatchHold, sendQueuedMessage } from "./chat/sendQueuedMessage";
import { environmentServerConfigsAtom } from "../state/server";
import { getUploadedAttachments } from "../lib/attachmentUploadQueue";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { formatOutgoingPrompt } from "./ChatView.helpers";
import type { useChatViewThreadState } from "./ChatView.threadState";
import type { useChatViewTimelineData } from "./ChatView.timelineData";
import type { useChatViewTerminalsAndScripts } from "./ChatView.terminalsAndScripts";
import type { useChatViewRightPanel } from "./ChatView.rightPanel";
import type { useChatViewTimelineScroll } from "./ChatView.timelineScroll";
import type { useChatViewThreadStatus } from "./ChatView.threadStatus";
import type { useChatViewShortcutsAndRevert } from "./ChatView.shortcutsAndRevert";

export function useChatViewPendingRequests({
  threadState,
  timelineData,
  terminalsAndScripts,
  rightPanel,
  timelineScroll,
  threadStatus,
  shortcutsAndRevert,
}: {
  threadState: ReturnType<typeof useChatViewThreadState>;
  timelineData: ReturnType<typeof useChatViewTimelineData>;
  terminalsAndScripts: ReturnType<typeof useChatViewTerminalsAndScripts>;
  rightPanel: ReturnType<typeof useChatViewRightPanel>;
  timelineScroll: ReturnType<typeof useChatViewTimelineScroll>;
  threadStatus: ReturnType<typeof useChatViewThreadStatus>;
  shortcutsAndRevert: ReturnType<typeof useChatViewShortcutsAndRevert>;
}) {
  const {
    activeThreadRef,
    activeThreadKey,
    activeThreadId,
    setRespondingRequestIds,
    respondToThreadApproval,
    environmentId,
    userInputResponsesInFlight,
    setRespondingUserInputRequestIds,
    respondToThreadUserInput,
    dismissThreadUserInput,
    setPendingUserInputQuestionIndexByRequestId,
    pendingUserInputAnswersByRequestId,
    composerDraftTarget,
    setComposerDraftPrompt,
    setPendingUserInputAnswersByRequestId,
    promptRef,
    composerRef,
    activeThread,
    isServerThread,
    isConnecting,
    sendInFlightRef,
    setOptimisticUserMessages,
    runtimeMode,
    setComposerDraftInteractionMode,
    startThreadTurn,
    routeThreadKey,
  } = threadState;
  const {
    activePendingApproval,
    pendingUserInputs,
    activePendingUserInput,
    activePendingIsResponding,
    activePendingRequestKey,
    activePendingProgress,
    activePendingResolvedAnswers,
    isSendBusy,
    beginLocalDispatch,
    activeProposedPlan,
    clearUsageLimitsFor,
    resetLocalDispatch,
  } = timelineData;
  const { restoreQueuedMessagesRef, setThreadError } = terminalsAndScripts;
  const { persistThreadSettingsForNextTurn } = rightPanel;
  const { scrollToEnd } = timelineScroll;
  const { localCheckoutBranchMismatch, acknowledgeActiveThreadWoke } = threadStatus;
  const { queuedMessageActionsRef, restoreQueuedMessagesToComposer } = shortcutsAndRevert;

  // Queued messages go out from QueuedMessageSender, which also covers
  // threads that are not on screen. Send now uses the same path but skips the
  // wait for a boundary. Approvals and questions still hold it: a steer on
  // top of them would answer nothing and confuse the turn.
  const queueBlockedByPendingRequest =
    activePendingApproval !== null || pendingUserInputs.length > 0;

  queuedMessageActionsRef.current = {
    steer: (id) => {
      if (!activeThreadRef || queueBlockedByPendingRequest) return;
      void sendQueuedMessage(activeThreadRef, id);
    },
    remove: (id) => {
      if (!activeThreadKey) return;
      const message = useQueuedMessageStore.getState().remove(activeThreadKey, id);
      if (message) restoreQueuedMessagesToComposer([message]);
    },
  };
  const onSteerQueuedMessage = useCallback((id: string) => {
    queuedMessageActionsRef.current.steer(id);
  }, []);
  const onRemoveQueuedMessage = useCallback((id: string) => {
    queuedMessageActionsRef.current.remove(id);
  }, []);
  // Stop also cancels the queue: the messages return to the composer instead
  // of starting a new turn the moment the interrupted one settles.
  restoreQueuedMessagesRef.current = restoreQueuedMessagesToComposer;

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadApproval({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          decision,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit approval decision.",
        );
      }
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [activeThreadId, environmentId, respondToThreadApproval, setThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      if (!activeThreadId || !activePendingUserInput || activePendingIsResponding) return;
      const responseKey = JSON.stringify([environmentId, activeThreadId, requestId]);
      if (userInputResponsesInFlight.current.has(responseKey)) return;
      const attachmentsByQuestionId = new Map<
        string,
        import("@t3tools/contracts").UserInputAttachments[string]
      >();
      for (const question of activePendingUserInput.questions) {
        const target = questionAttachmentDraftId(
          environmentId,
          activeThreadId,
          requestId,
          question.id,
        );
        if ((useQuestionAttachmentPreparation.getState().counts[target] ?? 0) > 0) return;
        const draft = useComposerDraftStore.getState().getComposerDraft(target);
        const attachments = draft ? [...draft.images, ...draft.files] : [];
        if (attachments.length === 0) continue;
        const uploaded = getUploadedAttachments({ environmentId, images: attachments });
        if (!uploaded) {
          setThreadError(
            activeThreadId,
            "Wait for attachments to finish uploading, or remove failed uploads.",
          );
          return;
        }
        attachmentsByQuestionId.set(
          question.id,
          uploaded as import("@t3tools/contracts").UserInputAttachments[string],
        );
      }
      userInputResponsesInFlight.current.add(responseKey);
      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadUserInput({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          answers,
          ...(attachmentsByQuestionId.size > 0
            ? { attachmentsByQuestionId: Object.fromEntries(attachmentsByQuestionId) }
            : {}),
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit user input.",
        );
      }
      userInputResponsesInFlight.current.delete(responseKey);
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [
      activeThreadId,
      activePendingUserInput,
      activePendingIsResponding,
      environmentId,
      respondToThreadUserInput,
      setThreadError,
    ],
  );

  // Closes an async question without messaging the agent. The server records
  // the dismissal so every client releases the composer.
  const onDismissUserInput = useCallback(
    async (requestId: ApprovalRequestId) => {
      if (!activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await dismissThreadUserInput({
        environmentId,
        input: { threadId: activeThreadId, requestId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to dismiss the question.",
        );
      }
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [activeThreadId, dismissThreadUserInput, environmentId, setThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingRequestKey]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput, activePendingRequestKey],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionValue: string) => {
      if (!activePendingUserInput) {
        return;
      }
      // The option replaces the custom answer. Anything typed there is the
      // user's text, so it goes back to the thread draft instead of vanishing.
      const displacedAnswer =
        pendingUserInputAnswersByRequestId[activePendingRequestKey]?.[questionId]?.customAnswer;
      const currentPrompt =
        useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ?? "";
      const nextPrompt = carryDisplacedCustomAnswerIntoPrompt(currentPrompt, displacedAnswer);
      if (nextPrompt !== currentPrompt) {
        setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      }
      setPendingUserInputAnswersByRequestId((existing) => {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId);
        if (!question) {
          return existing;
        }

        return {
          ...existing,
          [activePendingRequestKey]: {
            ...existing[activePendingRequestKey],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[activePendingRequestKey]?.[questionId],
              optionValue,
            ),
          },
        };
      });
      promptRef.current = "";
      composerRef.current?.resetCursorState({ cursor: 0 });
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      activePendingRequestKey,
      composerDraftTarget,
      composerRef,
      pendingUserInputAnswersByRequestId,
      setComposerDraftPrompt,
    ],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      _cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
      if (!question || question.allowCustomAnswer === false) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingRequestKey]: {
          ...existing[activePendingRequestKey],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingRequestKey]?.[questionId],
            value,
          ),
        },
      }));
      const snapshot = composerRef.current?.readSnapshot();
      if (
        snapshot?.value !== value ||
        snapshot.cursor !== nextCursor ||
        snapshot.expandedCursor !== expandedCursor
      ) {
        composerRef.current?.focusAt(nextCursor);
      }
    },
    [activePendingUserInput, activePendingRequestKey, composerRef],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (
      !activePendingUserInput ||
      !activePendingProgress ||
      !activePendingProgress.canAdvance ||
      activePendingIsResponding
    ) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    activePendingIsResponding,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      context,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      context?: ReturnType<typeof buildMessageContext>;
      interactionMode: "default" | "plan";
      // Whether the message actually went out. A `false` return tells the caller to put the
      // composer back, because it cleared it before awaiting this.
    }): Promise<boolean> => {
      if (
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return false;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return false;
      }

      const sendCtx = composerRef.current?.getSendContext();
      if (!sendCtx?.providerAvailable || !sendCtx.interactionModeEnabled) {
        return false;
      }
      const {
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
      } = sendCtx;

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      // Memory references must find the same send support as any other direct
      // dispatch; returning false puts the composer back, untouched.
      const earlyPlanHold = readPostPreparationMemoryDispatchHold({
        environmentId,
        instanceId: ctxSelectedModelSelection.instanceId,
        dispatchContext: context,
      });
      if (earlyPlanHold !== null) {
        setThreadError(threadIdForSend, earlyPlanHold);
        return false;
      }
      const outgoingMessageText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: trimmed,
      });

      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);

      scrollToEnd();

      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          ...(context ? { context } : {}),
          turnId: null,
          createdAt: messageCreatedAt,
          updatedAt: messageCreatedAt,
          streaming: false,
        },
      ]);

      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        modelSelection: ctxSelectedModelSelection,
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode: nextInteractionMode,
      });
      let failure: AtomCommandResult<unknown, unknown> | null =
        settingsResult._tag === "Failure" ? settingsResult : null;

      if (failure === null) {
        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(
          scopeThreadRef(activeThread.environmentId, threadIdForSend),
          nextInteractionMode,
        );

        const holdAfterAwait = readPostPreparationMemoryDispatchHold({
          environmentId,
          instanceId: ctxSelectedModelSelection.instanceId,
          dispatchContext: context,
        });
        if (holdAfterAwait !== null) {
          failure = AsyncResult.failure(Cause.fail(new Error(holdAfterAwait)));
        }

        if (failure === null) {
          const startResult = await startThreadTurn({
            environmentId,
            input: {
              threadId: threadIdForSend,
              message: {
                messageId: messageIdForSend,
                role: "user",
                ...(appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)
                  ?.environment.capabilities.inlineMessageContext === true
                  ? { text: outgoingMessageText, ...(context ? { context } : {}) }
                  : {
                      text: serializeLegacyContextMessage({
                        text: outgoingMessageText,
                        records: context?.records ?? [],
                      }),
                    }),
                attachments: [],
              },
              modelSelection: ctxSelectedModelSelection,
              titleSeed: activeThread.title,
              runtimeMode,
              interactionMode: nextInteractionMode,
              ...(nextInteractionMode === "default" && activeProposedPlan
                ? {
                    sourceProposedPlan: {
                      threadId: activeThread.id,
                      planId: activeProposedPlan.id,
                    },
                  }
                : {}),
              createdAt: messageCreatedAt,
            },
          });
          failure = startResult._tag === "Failure" ? startResult : null;
        }
      }

      if (failure === null) {
        clearUsageLimitsFor(routeThreadKey);
        acknowledgeActiveThreadWoke();
        sendInFlightRef.current = false;
        return true;
      }

      setOptimisticUserMessages((existing) =>
        existing.filter((message) => message.id !== messageIdForSend),
      );
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send plan follow-up.",
        );
      }
      sendInFlightRef.current = false;
      resetLocalDispatch();
      return false;
    },
    [
      activeThread,
      activeProposedPlan,
      acknowledgeActiveThreadWoke,
      beginLocalDispatch,
      isConnecting,
      isSendBusy,
      isServerThread,
      localCheckoutBranchMismatch,
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      runtimeMode,
      scrollToEnd,
      setComposerDraftInteractionMode,
      setThreadError,
      startThreadTurn,
      environmentId,
      composerRef,
      clearUsageLimitsFor,
      routeThreadKey,
    ],
  );

  return {
    onAdvanceActivePendingUserInput,
    onSubmitPlanFollowUp,
    onSteerQueuedMessage,
    onRemoveQueuedMessage,
    onRespondToApproval,
    onSelectActivePendingUserInputOption,
    onDismissUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
  };
}
