import { COMPOSER_SCROLL_GESTURE_RESET_MS } from "./ChatComposer.restingLayout";
import type { EnvironmentId } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  composerStateAtPromptEnd,
  detectComposerTrigger,
} from "../../composer-logic";
import { readFileAsDataUrl } from "../ChatView.logic";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type PersistedComposerImageAttachment,
} from "../../composerDraftStore";
import { type RetainedAttachmentContextPayloads } from "./composerContextUndo";
import { type TerminalContextDraft } from "../../lib/terminalContext";
import {
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "../composerFooterLayout";
import { useProjectMemoryPromptReconciliation } from "./ProjectMemoryPicker";
import { type ComposerCommandItem } from "./ComposerCommandMenu";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { getComposerPromptLengthValidationMessage } from "./composerSubmission";
import { suppressActiveComposerScrollGesture } from "./composerScrollGesture";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { PendingUserInput } from "../../session-logic";
import { ThreadId, PreviewAnnotationPayload } from "@t3tools/contracts";
import { DraftId, ComposerThreadTarget, ComposerThreadDraftState } from "../../composerDraftStore";
import { RefObject, Dispatch, SetStateAction } from "react";
import { ComposerScrollGestureState } from "./composerScrollGesture";

export function useComposerDraftEffects(args: {
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
  activePendingUserInput: PendingUserInput | null;
  activeThreadId: ThreadId | null;
  attachmentDraftTarget:
    | { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
    | DraftId;
  clearComposerDraftPersistedAttachments: (threadRef: ComposerThreadTarget) => void;
  composerDraftTarget:
    | { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
    | DraftId;
  composerFiles: ComposerFileAttachment[];
  composerFilesRef: RefObject<ComposerFileAttachment[]>;
  composerFooterActionLayoutKey: string;
  composerFooterHasWideActions: boolean;
  composerFormRef: RefObject<HTMLFormElement | null>;
  composerHighlightedItemId: string | null;
  composerHighlightedSearchKey: string | null;
  composerImages: ComposerImageAttachment[];
  composerImagesRef: RefObject<ComposerImageAttachment[]>;
  composerMenuItems: ComposerCommandItem[];
  composerMenuOpen: boolean;
  composerMenuSearchKey: string | null;
  composerPreviewAnnotations: PreviewAnnotationPayload[];
  composerReviewComments: ReviewCommentContext[];
  composerScrollGestureRef: RefObject<ComposerScrollGestureState>;
  composerSubmissionError: string | null;
  composerTerminalContexts: TerminalContextDraft[];
  composerTerminalContextsRef: RefObject<TerminalContextDraft[]>;
  draftId: DraftId | null;
  getComposerDraft: (target: ComposerThreadTarget) => ComposerThreadDraftState | null;
  isComposerApprovalState: boolean;
  isComposerCollapsedMobile: boolean;
  prompt: string;
  promptRef: RefObject<string>;
  resetComposerTrigger: (candidate: ComposerTrigger | null) => void;
  selectedModel: string;
  selectedPromptEffort: string | null;
  selectedProvider: ProviderDriverKind;
  setComposerCursor: Dispatch<SetStateAction<number>>;
  setComposerHighlightedItemId: Dispatch<SetStateAction<string | null>>;
  setComposerHighlightedSearchKey: Dispatch<SetStateAction<string | null>>;
  setComposerSubmissionError: Dispatch<SetStateAction<string | null>>;
  setIsComposerFooterCompact: Dispatch<SetStateAction<boolean>>;
  setIsComposerPrimaryActionsCompact: Dispatch<SetStateAction<boolean>>;
  setIsComposerScrollCollapsed: Dispatch<SetStateAction<boolean>>;
  setIsDragOverComposer: Dispatch<SetStateAction<boolean>>;
  setProviderInputSubmissionError: Dispatch<SetStateAction<string | null>>;
  syncComposerDraftPersistedAttachments: (
    threadRef: ComposerThreadTarget,
    attachments: PersistedComposerImageAttachment[],
  ) => Promise<void>;
}) {
  const {
    activePendingProgress,
    activePendingUserInput,
    activeThreadId,
    attachmentDraftTarget,
    clearComposerDraftPersistedAttachments,
    composerDraftTarget,
    composerFiles,
    composerFilesRef,
    composerFooterActionLayoutKey,
    composerFooterHasWideActions,
    composerFormRef,
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerImages,
    composerImagesRef,
    composerMenuItems,
    composerMenuOpen,
    composerMenuSearchKey,
    composerPreviewAnnotations,
    composerReviewComments,
    composerScrollGestureRef,
    composerSubmissionError,
    composerTerminalContexts,
    composerTerminalContextsRef,
    draftId,
    getComposerDraft,
    isComposerApprovalState,
    isComposerCollapsedMobile,
    prompt,
    promptRef,
    resetComposerTrigger,
    selectedModel,
    selectedPromptEffort,
    selectedProvider,
    setComposerCursor,
    setComposerHighlightedItemId,
    setComposerHighlightedSearchKey,
    setComposerSubmissionError,
    setIsComposerFooterCompact,
    setIsComposerPrimaryActionsCompact,
    setIsComposerScrollCollapsed,
    setIsDragOverComposer,
    setProviderInputSubmissionError,
    syncComposerDraftPersistedAttachments,
  } = args;

  // ------------------------------------------------------------------
  // Sync refs back to parent
  // ------------------------------------------------------------------
  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt, promptRef]);

  useEffect(() => {
    if (composerSubmissionError === null) return;
    const nextError = getComposerPromptLengthValidationMessage(prompt);
    if (nextError !== composerSubmissionError) {
      setComposerSubmissionError(nextError);
    }
  }, [composerSubmissionError, prompt]);

  useEffect(() => {
    setProviderInputSubmissionError(null);
  }, [
    composerPreviewAnnotations,
    composerReviewComments,
    composerTerminalContexts,
    prompt,
    selectedModel,
    selectedPromptEffort,
    selectedProvider,
  ]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages, composerImagesRef]);

  useEffect(() => {
    composerFilesRef.current = composerFiles;
  }, [composerFiles, composerFilesRef]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts, composerTerminalContextsRef]);

  // ------------------------------------------------------------------
  // Composer menu highlight sync
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      setComposerHighlightedSearchKey(null);
      return;
    }
    const nextActiveItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    setComposerHighlightedItemId((existing) =>
      existing === nextActiveItemId ? existing : nextActiveItemId,
    );
    setComposerHighlightedSearchKey((existing) =>
      existing === composerMenuSearchKey ? existing : composerMenuSearchKey,
    );
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuOpen,
    composerMenuSearchKey,
  ]);

  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);

  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      // The question is gone and the editor shows the thread draft again. The
      // ref still holds the last answer text, and Send reads the ref. Place
      // the caret at the end so the next keystroke appends.
      if (lastSyncedPendingInputRef.current !== null) {
        promptRef.current = prompt;
        const { cursor, trigger } = composerStateAtPromptEnd(prompt);
        setComposerCursor(cursor);
        resetComposerTrigger(trigger);
      }
      lastSyncedPendingInputRef.current = null;
      return;
    }

    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const { cursor, trigger } = composerStateAtPromptEnd(nextCustomAnswer);
    setComposerCursor(cursor);
    resetComposerTrigger(trigger);
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingProgress?.activeQuestion?.id,
    activePendingUserInput?.requestId,
    prompt,
    promptRef,
    resetComposerTrigger,
  ]);

  // ------------------------------------------------------------------
  // Reset compositor state on thread/draft change
  // ------------------------------------------------------------------
  useEffect(() => {
    setComposerHighlightedItemId(null);
    setComposerSubmissionError(null);
    setProviderInputSubmissionError(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    resetComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    setIsDragOverComposer(false);
    setIsComposerScrollCollapsed(false);
  }, [draftId, activeThreadId, promptRef, resetComposerTrigger, setIsComposerScrollCollapsed]);

  // ------------------------------------------------------------------
  // Footer compact layout observation
  // ------------------------------------------------------------------
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const measureFooterCompactness = () => {
      const composerFormWidth = measureComposerFormWidth();
      const footerCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      const primaryActionsCompact =
        footerCompact &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });
      return {
        primaryActionsCompact,
        footerCompact,
      };
    };

    const initialCompactness = measureFooterCompactness();
    setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
    setIsComposerFooterCompact(initialCompactness.footerCompact);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const nextCompactness = measureFooterCompactness();
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextCompactness.primaryActionsCompact
          ? previous
          : nextCompactness.primaryActionsCompact,
      );
      setIsComposerFooterCompact((previous) =>
        previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
      );
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [
    activeThreadId,
    composerFooterActionLayoutKey,
    composerFooterHasWideActions,
    isComposerApprovalState,
    isComposerCollapsedMobile,
  ]);

  // ------------------------------------------------------------------
  // Image persist effect
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(attachmentDraftTarget);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        getComposerDraft(attachmentDraftTarget)?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
                ...(image.source ? { source: image.source } : {}),
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(attachmentDraftTarget, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds: Array<string> = [];
        for (const attachment of fallbackPersistedAttachments) {
          if (currentImageIds.has(attachment.id)) {
            fallbackPersistedIds.push(attachment.id);
          }
        }
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(attachmentDraftTarget, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    attachmentDraftTarget,
    clearComposerDraftPersistedAttachments,
    composerImages,
    getComposerDraft,
    syncComposerDraftPersistedAttachments,
  ]);

  // ------------------------------------------------------------------
  // Callbacks: prompt change
  // ------------------------------------------------------------------
  const expandComposerForEditorChange = useCallback(() => {
    // Editor changes win over the momentum tail of the active scroll gesture.
    suppressActiveComposerScrollGesture(
      composerScrollGestureRef.current,
      window.performance.now(),
      COMPOSER_SCROLL_GESTURE_RESET_MS,
    );
    setIsComposerScrollCollapsed(false);
  }, [setIsComposerScrollCollapsed]);

  /**
   * Payloads for chips the prompt no longer references. History undo restores the
   * reference text but knows nothing about the draft records behind it, so a delete keeps its
   * payload here and an undo puts it back rather than leaving a dangling chip.
   */
  const removedContextPayloadsRef = useRef<{
    terminals: Map<string, TerminalContextDraft>;
    reviewComments: Map<string, ReviewCommentContext>;
  }>({
    terminals: new Map(),
    reviewComments: new Map(),
  });
  const reconcileProjectMemoryFromPrompt =
    useProjectMemoryPromptReconciliation(composerDraftTarget);
  const removedAttachmentContextPayloadsRef = useRef<RetainedAttachmentContextPayloads>({
    files: new Map(),
    previewAnnotations: new Map(),
  });

  return {
    expandComposerForEditorChange,
    removedContextPayloadsRef,
    reconcileProjectMemoryFromPrompt,
    removedAttachmentContextPayloadsRef,
  };
}
