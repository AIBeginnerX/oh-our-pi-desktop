import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";
import {
  type ComposerSubmissionIntent,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  composerSubmissionIntentForEnter,
} from "../../composer-logic";
import { listContinuationForEnter, listIndentForTab } from "../../composer-list-continuation";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  composerTargetKey,
} from "../../composerDraftStore";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { type TerminalContextDraft } from "../../lib/terminalContext";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { type ComposerCommandItem } from "./ComposerCommandMenu";
import { submitComposerDraft } from "./composerSubmission";
import { pendingDraftWork } from "./pendingDraftWork";
import { toastManager } from "../ui/toast";
import {
  buildComposerPromptHistoryEntries,
  stepComposerPromptHistory,
  type ComposerPromptHistoryPosition,
} from "./composerPromptHistory";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { RefObject, Dispatch, SetStateAction } from "react";
import { PendingApproval, PendingUserInput } from "../../session-logic";
import { ThreadId, PreviewAnnotationPayload } from "@t3tools/contracts";
import { DraftId, ComposerThreadTarget } from "../../composerDraftStore";
import { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { SessionPhase, ChatMessage } from "../../types";
import { UnifiedSettings } from "@t3tools/contracts/settings";

export function useComposerSubmitHandlers(args: {
  activeComposerMenuItemRef: RefObject<ComposerCommandItem | null>;
  activePendingApproval: PendingApproval | null;
  activePendingProgress: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    customAnswer: string;
    activeQuestion: {
      id: string;
      multiSelect?: boolean | undefined;
      allowCustomAnswer?: boolean | undefined;
    } | null;
  } | null;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  activeThreadId: ThreadId | null;
  applyPromptReplacement: (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options?: {
      expectedText?: string;
      expandedCursorAfterReplace?: number;
      focusEditorAfterReplace?: boolean;
      citationComment?: { start: number; sourceAnchor: AssistantCitationSourceAnchor };
    },
  ) => boolean;
  attachmentTargetKey: string;
  blurMobileComposerAfterSend: () => void;
  compactDisabled: boolean;
  composerBlurFrameRef: RefObject<number | null>;
  composerDraftTarget:
    | { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
    | DraftId;
  composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  composerFilesRef: RefObject<ComposerFileAttachment[]>;
  composerImagesRef: RefObject<ComposerImageAttachment[]>;
  composerMenuItemsRef: RefObject<ComposerCommandItem[]>;
  composerMenuOpenRef: RefObject<boolean>;
  composerPreviewAnnotations: PreviewAnnotationPayload[];
  composerReviewComments: ReviewCommentContext[];
  composerSendState: {
    trimmedPrompt: string;
    sendableTerminalContexts: TerminalContextDraft[];
    expiredTerminalContextCount: number;
    hasSendableContent: boolean;
  };
  composerTerminalContextsRef: RefObject<TerminalContextDraft[]>;
  dismissComposerTrigger: (candidate: ComposerTrigger | null) => void;
  environmentUnavailable: {
    readonly label: string;
    readonly connection: EnvironmentConnectionPresentation;
  } | null;
  isComposerApprovalState: boolean;
  isConnecting: boolean;
  isMobileViewport: boolean;
  isSendBusy: boolean;
  isSendDisabled: boolean;
  mobileComposerExpandFrameRef: RefObject<number | null>;
  mobileComposerExpandInFlightRef: RefObject<boolean>;
  mobileComposerExpandReleaseFrameRef: RefObject<number | null>;
  noProviderAvailable: boolean;
  nudgeComposerMenuHighlight: (key: "ArrowDown" | "ArrowUp") => void;
  onCompactContext: () => void;
  onSelectComposerItem: (item: ComposerCommandItem) => void;
  onSend: (e?: { preventDefault: () => void }, intent?: ComposerSubmissionIntent) => void;
  pendingImageCompressionsRef: RefObject<Map<string, number>>;
  pendingUserInputs: PendingUserInput[];
  phase: SessionPhase;
  planModeUiEnabled: boolean;
  promptHistoryMessages: readonly ChatMessage[];
  promptHistoryPositionRef: RefObject<ComposerPromptHistoryPosition | null>;
  promptRef: RefObject<string>;
  providerInputRejectedRef: RefObject<boolean>;
  readComposerSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  resolveActiveComposerTrigger: () => {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  };
  routeKind: "draft" | "server";
  setComposerCursor: Dispatch<SetStateAction<number>>;
  setComposerDraftPrompt: (threadRef: ComposerThreadTarget, prompt: string) => void;
  setComposerHighlightedItemId: Dispatch<SetStateAction<string | null>>;
  setComposerSubmissionError: Dispatch<SetStateAction<string | null>>;
  setComposerTrigger: (candidate: ComposerTrigger | null) => void;
  setIsComposerFocused: Dispatch<SetStateAction<boolean>>;
  settings: UnifiedSettings;
  showPlanFollowUpPrompt: boolean;
  toggleInteractionMode: () => void;
}) {
  const {
    activeComposerMenuItemRef,
    activePendingApproval,
    activePendingProgress,
    activePendingResolvedAnswers,
    activeThreadId,
    applyPromptReplacement,
    attachmentTargetKey,
    blurMobileComposerAfterSend,
    compactDisabled,
    composerBlurFrameRef,
    composerDraftTarget,
    composerEditorRef,
    composerFilesRef,
    composerImagesRef,
    composerMenuItemsRef,
    composerMenuOpenRef,
    composerPreviewAnnotations,
    composerReviewComments,
    composerSendState,
    composerTerminalContextsRef,
    dismissComposerTrigger,
    environmentUnavailable,
    isComposerApprovalState,
    isConnecting,
    isMobileViewport,
    isSendBusy,
    isSendDisabled,
    mobileComposerExpandFrameRef,
    mobileComposerExpandInFlightRef,
    mobileComposerExpandReleaseFrameRef,
    noProviderAvailable,
    nudgeComposerMenuHighlight,
    onCompactContext,
    onSelectComposerItem,
    onSend,
    pendingImageCompressionsRef,
    pendingUserInputs,
    phase,
    planModeUiEnabled,
    promptHistoryMessages,
    promptHistoryPositionRef,
    promptRef,
    providerInputRejectedRef,
    readComposerSnapshot,
    resolveActiveComposerTrigger,
    routeKind,
    setComposerCursor,
    setComposerDraftPrompt,
    setComposerHighlightedItemId,
    setComposerSubmissionError,
    setComposerTrigger,
    setIsComposerFocused,
    settings,
    showPlanFollowUpPrompt,
    toggleInteractionMode,
  } = args;

  const shouldBlurMobileComposerOnSubmit = useCallback(() => {
    if (!isMobileViewport) return false;
    if (
      isSendBusy ||
      isSendDisabled ||
      isConnecting ||
      noProviderAvailable ||
      environmentUnavailable !== null ||
      phase === "running"
    ) {
      return false;
    }
    if (activePendingProgress) {
      return activePendingProgress.isLastQuestion && Boolean(activePendingResolvedAnswers);
    }
    return showPlanFollowUpPrompt || composerSendState.hasSendableContent;
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    composerSendState.hasSendableContent,
    environmentUnavailable,
    isConnecting,
    isMobileViewport,
    isSendBusy,
    isSendDisabled,
    noProviderAvailable,
    phase,
    showPlanFollowUpPrompt,
  ]);

  const submitComposer = useCallback(
    (event?: { preventDefault: () => void }, intent: ComposerSubmissionIntent = "foreground") => {
      if (noProviderAvailable || isSendDisabled) {
        event?.preventDefault();
        return;
      }
      // A send while a pasted image is still compressing would strand that
      // image: the turn snapshot wouldn't include it, and it would surface
      // in the *next* draft instead. Only oversized images hit this — small
      // files clear the pending counter within a microtask.
      if (
        activeThreadId &&
        (pendingImageCompressionsRef.current.get(attachmentTargetKey) ?? 0) > 0
      ) {
        event?.preventDefault();
        toastManager.add({
          type: "info",
          title: "Still compressing a pasted image.",
          description: "Send again once its thumbnail appears.",
        });
        return;
      }
      // A pasted chip's bytes arrive over the network, so the same hazard applies for longer:
      // sending now would snapshot a chip with no attachment behind it.
      if (pendingDraftWork.has(attachmentTargetKey)) {
        event?.preventDefault();
        toastManager.add({
          type: "info",
          title: "Still bringing a pasted attachment into this message.",
          description: "Send again once its chip resolves.",
        });
        return;
      }
      const submission = submitComposerDraft({
        prompt: promptRef.current,
        submissionTarget: activePendingProgress ? "pending-user-input" : "provider-turn",
        event,
        onSend: (sendEvent) => {
          // ChatView reports its final composed-input preflight through the
          // composer handle before its first asynchronous send step.
          providerInputRejectedRef.current = false;
          onSend(sendEvent, intent);
          return !providerInputRejectedRef.current;
        },
      });
      setComposerSubmissionError(submission.validationMessage);
      if (!submission.didDispatch) return;
      if (shouldBlurMobileComposerOnSubmit()) {
        blurMobileComposerAfterSend();
      }
    },
    [
      activeThreadId,
      activePendingProgress,
      attachmentTargetKey,
      blurMobileComposerAfterSend,
      isSendDisabled,
      noProviderAvailable,
      onSend,
      promptRef,
      shouldBlurMobileComposerOnSubmit,
    ],
  );
  const submitCitationAndSend = useCallback(() => {
    const intent = composerSubmissionIntentForEnter({
      isMobileViewport,
      shiftKey: false,
      modifierKey: true,
      isDraftThread: routeKind === "draft",
    });
    submitComposer(undefined, intent ?? "foreground");
  }, [isMobileViewport, routeKind, submitComposer]);
  const compactThreadContext = useCallback(() => {
    if (
      compactDisabled ||
      noProviderAvailable ||
      activePendingApproval !== null ||
      pendingUserInputs.length > 0 ||
      phase === "running" ||
      isSendBusy ||
      isConnecting ||
      !activeThreadId
    ) {
      return;
    }
    onCompactContext();
  }, [
    activePendingApproval,
    activeThreadId,
    compactDisabled,
    isConnecting,
    isSendBusy,
    noProviderAvailable,
    onCompactContext,
    pendingUserInputs.length,
    phase,
  ]);
  const expandMobileComposer = useCallback(() => {
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    if (mobileComposerExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
    }
    mobileComposerExpandInFlightRef.current = true;
    setIsComposerFocused(true);
    mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() => {
      mobileComposerExpandFrameRef.current = null;
      composerEditorRef.current?.focusAtEnd();
      mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() => {
        mobileComposerExpandReleaseFrameRef.current = null;
        mobileComposerExpandInFlightRef.current = false;
      });
    });
  }, [setIsComposerFocused]);

  // ------------------------------------------------------------------
  // Prompt history (ArrowUp / ArrowDown)
  // ------------------------------------------------------------------
  // Entries are built on the keypress, not per render: the timeline changes
  // on every streamed delta and ArrowUp is rare.
  const promptHistoryMessagesRef = useRef(promptHistoryMessages);
  promptHistoryMessagesRef.current = promptHistoryMessages;

  // The composer persists across threads. A recall from thread A must not
  // be treated as active in thread B, where the text-match fallback could
  // otherwise turn B's own draft into a browsing position.
  const promptHistoryTargetKey = composerTargetKey(composerDraftTarget);
  useEffect(() => {
    promptHistoryPositionRef.current = null;
  }, [promptHistoryTargetKey]);

  const replacePromptFromHistory = useCallback(
    (nextPrompt: string) => {
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(null);
      setComposerHighlightedItemId(null);
    },
    [composerDraftTarget, promptRef, setComposerDraftPrompt, setComposerTrigger],
  );

  const navigatePromptHistory = useCallback(
    (direction: "backward" | "forward", event: KeyboardEvent): boolean => {
      if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
        return false;
      }
      if (isComposerApprovalState || pendingUserInputs.length > 0) return false;
      // A composer holding an image, file, picked element, preview
      // annotation, or review comment is not empty. Recalling text into it
      // would send the old prompt with the new context, which is never what
      // ArrowUp meant.
      if (
        composerImagesRef.current.length > 0 ||
        composerFilesRef.current.length > 0 ||
        composerTerminalContextsRef.current.length > 0 ||
        composerPreviewAnnotations.length > 0 ||
        composerReviewComments.length > 0
      ) {
        return false;
      }
      // A typed draft with no active recall can never step, so skip the
      // layout read and the entry build for that common case.
      if (promptHistoryPositionRef.current === null && promptRef.current.length > 0) {
        return false;
      }
      const editor = composerEditorRef.current;
      if (!editor?.isCaretOnVisualEdge(direction === "backward" ? "start" : "end")) {
        return false;
      }
      const step = stepComposerPromptHistory({
        direction,
        entries: buildComposerPromptHistoryEntries(promptHistoryMessagesRef.current),
        position: promptHistoryPositionRef.current,
        currentPrompt: promptRef.current,
      });
      if (!step) return false;
      promptHistoryPositionRef.current = step.position;
      replacePromptFromHistory(step.prompt);
      return true;
    },
    [
      composerTerminalContextsRef,
      composerFilesRef,
      composerImagesRef,
      composerPreviewAnnotations.length,
      composerReviewComments.length,
      isComposerApprovalState,
      pendingUserInputs.length,
      promptRef,
      replacePromptFromHistory,
    ],
  );

  // ------------------------------------------------------------------
  // Callbacks: command key
  // ------------------------------------------------------------------
  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape",
    event: KeyboardEvent,
    isTaskItem = false,
  ) => {
    if (key === "Tab" && event.shiftKey) {
      if (!planModeUiEnabled) return false;
      toggleInteractionMode();
      return true;
    }
    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;
    if (key === "Escape") {
      if (!menuIsActive || event.isComposing || event.keyCode === 229) return false;
      dismissComposerTrigger(trigger);
      composerMenuOpenRef.current = false;
      return true;
    }
    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if ((key === "Enter" || key === "Tab") && selectedItem) {
        onSelectComposerItem(selectedItem);
        return true;
      }
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      return navigatePromptHistory(key === "ArrowUp" ? "backward" : "forward", event);
    }
    const submissionIntent =
      key === "Enter"
        ? composerSubmissionIntentForEnter({
            isMobileViewport,
            shiftKey: event.shiftKey,
            modifierKey: event.metaKey || event.ctrlKey,
            isDraftThread: routeKind === "draft",
            isRunning: phase === "running",
            sendShortcut: settings.sendShortcut,
            prompt: promptRef.current,
          })
        : null;
    if (submissionIntent) {
      submitComposer(undefined, submissionIntent);
      return true;
    }
    // Native task splitting preserves marks and chips on both sides of the caret.
    if (key === "Enter" && isTaskItem) return false;
    if (!event.isComposing && (key === "Enter" || (key === "Tab" && !event.shiftKey))) {
      const selection = composerEditorRef.current?.readSelectionRange();
      const snapshot = readComposerSnapshot();
      if (selection && selection.start === selection.end && snapshot.value === promptRef.current) {
        const edit =
          key === "Enter"
            ? listContinuationForEnter(snapshot.value, selection.start)
            : listIndentForTab(snapshot.value, selection.start, selection.end);
        if (
          edit &&
          applyPromptReplacement(
            edit.start,
            edit.end,
            edit.replacement,
            key === "Tab"
              ? { expandedCursorAfterReplace: selection.start + edit.replacement.length }
              : undefined,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  };

  return {
    submitComposer,
    submitCitationAndSend,
    compactThreadContext,
    expandMobileComposer,
    onComposerCommandKey,
  };
}
