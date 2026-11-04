import type { ChatComposerProps } from "./ChatComposer.types";
import type { EnvironmentId } from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { USAGE_LIMITS_COMMAND } from "@t3tools/shared/usageLimits";
import { useCallback } from "react";
import {
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
} from "../../composer-logic";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import {
  reconcileAttachmentContextReferences,
  type RetainedAttachmentContextPayloads,
} from "./composerContextUndo";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { type TerminalContextDraft } from "../../lib/terminalContext";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import {
  collectInlineContextIds,
  formatInlineContextReference,
} from "~/lib/composerContextReferences";
import {
  reviewCommentContextId,
  reviewCommentContextReference,
  terminalContextReference,
} from "~/lib/composerContextRecords";
import { type ComposerCommandItem } from "./ComposerCommandMenu";
import { buildPullRequestReferenceContext } from "../pullRequest/pullRequestDetail.logic";
import { type ComposerPromptHistoryPosition } from "./composerPromptHistory";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { PendingUserInput } from "../../session-logic";
import { ComposerThreadTarget, ComposerContextAddOptions, DraftId } from "../../composerDraftStore";
import { PreviewAnnotationPayload, ThreadId, ProviderInteractionMode } from "@t3tools/contracts";
import { RefObject, Dispatch, SetStateAction } from "react";
import { extendReplacementRangeForTrailingSpace } from "./ChatComposer.constants";

export function useComposerPromptHandlers(args: {
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
  addComposerDraftFiles: (
    threadRef: ComposerThreadTarget,
    files: ComposerFileAttachment[],
    options?: { allowDuplicates?: boolean; appendReference?: boolean },
  ) => string[];
  addComposerDraftImages: (
    threadRef: ComposerThreadTarget,
    images: ComposerImageAttachment[],
    options?: { allowDuplicates?: boolean },
  ) => string[];
  addComposerDraftPreviewAnnotation: (
    threadRef: ComposerThreadTarget,
    annotation: PreviewAnnotationPayload,
    options?: ComposerContextAddOptions,
  ) => void;
  addComposerDraftReviewComment: (
    threadRef: ComposerThreadTarget,
    comment: ReviewCommentContext,
    options?: ComposerContextAddOptions,
  ) => void;
  attachmentDraftTarget:
    | { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
    | DraftId;
  composerBlurFrameRef: RefObject<number | null>;
  composerCursor: number;
  composerDraftTarget:
    | { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
    | DraftId;
  composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  composerFiles: ComposerFileAttachment[];
  composerHighlightedItemId: string | null;
  composerImages: ComposerImageAttachment[];
  composerMenuItems: ComposerCommandItem[];
  composerMenuItemsRef: RefObject<ComposerCommandItem[]>;
  composerMenuSearchKey: string | null;
  composerPreviewAnnotations: PreviewAnnotationPayload[];
  composerReviewComments: ReviewCommentContext[];
  composerSelectLockRef: RefObject<boolean>;
  composerTerminalContexts: TerminalContextDraft[];
  expandComposerForEditorChange: () => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  isMobileViewport: boolean;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;
  pendingUserInputs: PendingUserInput[];
  planModeUiEnabled: boolean;
  promptHistoryPositionRef: RefObject<ComposerPromptHistoryPosition | null>;
  promptRef: RefObject<string>;
  props: ChatComposerProps;
  reconcileProjectMemoryFromPrompt: (referencedContextIds: ReadonlySet<string>) => void;
  removeComposerDraftFile: (threadRef: ComposerThreadTarget, fileId: string) => void;
  removeComposerDraftPreviewAnnotation: (
    threadRef: ComposerThreadTarget,
    annotationId: string,
  ) => void;
  removeComposerDraftReviewComment: (threadRef: ComposerThreadTarget, commentId: string) => void;
  removedAttachmentContextPayloadsRef: RefObject<RetainedAttachmentContextPayloads>;
  removedContextPayloadsRef: RefObject<{
    terminals: Map<string, TerminalContextDraft>;
    reviewComments: Map<string, ReviewCommentContext>;
  }>;
  resolveComposerTrigger: (candidate: ComposerTrigger | null) => ComposerTrigger | null;
  setComposerCursor: Dispatch<SetStateAction<number>>;
  setComposerDraftTerminalContexts: (
    threadRef: ComposerThreadTarget,
    contexts: TerminalContextDraft[],
  ) => void;
  setComposerHighlightedItemId: Dispatch<SetStateAction<string | null>>;
  setComposerHighlightedSearchKey: Dispatch<SetStateAction<string | null>>;
  setComposerTrigger: (candidate: ComposerTrigger | null) => void;
  setIsComposerFocused: Dispatch<SetStateAction<boolean>>;
  setIsComposerModelPickerOpen: Dispatch<SetStateAction<boolean>>;
  setPrompt: (nextPrompt: string) => void;
}) {
  const {
    activePendingProgress,
    activePendingUserInput,
    addComposerDraftFiles,
    addComposerDraftImages,
    addComposerDraftPreviewAnnotation,
    addComposerDraftReviewComment,
    attachmentDraftTarget,
    composerBlurFrameRef,
    composerCursor,
    composerDraftTarget,
    composerEditorRef,
    composerFiles,
    composerHighlightedItemId,
    composerImages,
    composerMenuItems,
    composerMenuItemsRef,
    composerMenuSearchKey,
    composerPreviewAnnotations,
    composerReviewComments,
    composerSelectLockRef,
    composerTerminalContexts,
    expandComposerForEditorChange,
    handleInteractionModeChange,
    isMobileViewport,
    onChangeActivePendingUserInputCustomAnswer,
    pendingUserInputs,
    planModeUiEnabled,
    promptHistoryPositionRef,
    promptRef,
    props,
    reconcileProjectMemoryFromPrompt,
    removeComposerDraftFile,
    removeComposerDraftPreviewAnnotation,
    removeComposerDraftReviewComment,
    removedAttachmentContextPayloadsRef,
    removedContextPayloadsRef,
    resolveComposerTrigger,
    setComposerCursor,
    setComposerDraftTerminalContexts,
    setComposerHighlightedItemId,
    setComposerHighlightedSearchKey,
    setComposerTrigger,
    setIsComposerFocused,
    setIsComposerModelPickerOpen,
    setPrompt,
  } = args;

  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      contextIds: string[],
    ) => {
      expandComposerForEditorChange();
      if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0) {
        if (activePendingProgress.activeQuestion.allowCustomAnswer === false) return;
        setComposerCursor(nextCursor);
        setComposerTrigger(
          cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
        );
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      // Any edit ends browsing, even one later undone by hand: typing a
      // character and deleting it leaves the text equal to the recall, and
      // ArrowDown must move the caret then, not clear the composer.
      if (promptHistoryPositionRef.current?.recalled !== nextPrompt) {
        promptHistoryPositionRef.current = null;
      }
      const referenced = new Set(contextIds);
      const retained = removedContextPayloadsRef.current;

      // An undone delete brings the reference back; restore the payload it points at.
      const liveTerminalIds = new Set<string>(
        composerTerminalContexts.map((context) => terminalContextReference(context).contextId),
      );
      const restoredTerminals = [...referenced].flatMap((contextId) => {
        if (liveTerminalIds.has(contextId)) return [];
        const context = retained.terminals.get(contextId);
        return context ? [context] : [];
      });
      const nextTerminals = [
        ...composerTerminalContexts.filter((context) =>
          referenced.has(terminalContextReference(context).contextId),
        ),
        ...restoredTerminals,
      ];
      for (const context of composerTerminalContexts) {
        const contextId = terminalContextReference(context).contextId;
        if (!referenced.has(contextId)) retained.terminals.set(contextId, context);
      }
      if (
        nextTerminals.length !== composerTerminalContexts.length ||
        restoredTerminals.length > 0
      ) {
        setComposerDraftTerminalContexts(composerDraftTarget, nextTerminals);
      }

      for (const comment of composerReviewComments) {
        const contextId = reviewCommentContextId(comment.id);
        if (!referenced.has(contextId)) {
          retained.reviewComments.set(contextId, comment);
          removeComposerDraftReviewComment(composerDraftTarget, comment.id);
        }
      }
      const liveReviewIds = new Set<string>(
        composerReviewComments.map((comment) => reviewCommentContextId(comment.id)),
      );
      for (const contextId of referenced) {
        if (liveReviewIds.has(contextId)) continue;
        const comment = retained.reviewComments.get(contextId);
        if (comment) {
          addComposerDraftReviewComment(composerDraftTarget, comment, { appendReference: false });
        }
      }

      reconcileProjectMemoryFromPrompt(referenced);

      const attachmentChanges = reconcileAttachmentContextReferences({
        referencedContextIds: referenced,
        files: composerFiles,
        images: composerImages,
        previewAnnotations: composerPreviewAnnotations,
        retained: removedAttachmentContextPayloadsRef.current,
      });
      for (const annotationId of attachmentChanges.annotationIdsToRemove) {
        // Keep the upload queue entry alive: undo restores the image that owns it.
        removeComposerDraftPreviewAnnotation(composerDraftTarget, annotationId);
      }
      for (const restored of attachmentChanges.annotationsToRestore) {
        if (restored.image) addComposerDraftImages(attachmentDraftTarget, [restored.image]);
        addComposerDraftPreviewAnnotation(composerDraftTarget, restored.annotation, {
          appendReference: false,
        });
      }
      for (const fileId of attachmentChanges.filesToRemove) {
        // The retained File and upload are still sendable if the editor restores the chip.
        removeComposerDraftFile(attachmentDraftTarget, fileId);
      }
      if (attachmentChanges.filesToRestore.length > 0) {
        addComposerDraftFiles(attachmentDraftTarget, attachmentChanges.filesToRestore);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      expandComposerForEditorChange,
      pendingUserInputs.length,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
      setComposerTrigger,
      composerDraftTarget,
      composerTerminalContexts,
      setComposerDraftTerminalContexts,
      composerReviewComments,
      composerPreviewAnnotations,
      composerImages,
      composerFiles,
      removeComposerDraftReviewComment,
      removeComposerDraftPreviewAnnotation,
      removeComposerDraftFile,
      addComposerDraftReviewComment,
      addComposerDraftPreviewAnnotation,
      addComposerDraftImages,
      addComposerDraftFiles,
      reconcileProjectMemoryFromPrompt,
      attachmentDraftTarget,
    ],
  );

  // ------------------------------------------------------------------
  // Callbacks: prompt replacement / menu
  // ------------------------------------------------------------------
  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: {
        expectedText?: string;
        expandedCursorAfterReplace?: number;
        focusEditorAfterReplace?: boolean;
        citationComment?: { start: number; sourceAnchor: AssistantCitationSourceAnchor };
      },
    ): boolean => {
      if (
        activePendingUserInput &&
        activePendingProgress?.activeQuestion?.allowCustomAnswer === false
      ) {
        return false;
      }
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(
        next.text,
        options?.expandedCursorAfterReplace ?? next.cursor,
      );
      const nextExpandedCursor = expandCollapsedComposerCursor(next.text, nextCursor);
      if (options?.citationComment) {
        composerEditorRef.current?.requestCitationComment({
          previousValue: currentText,
          value: next.text,
          citationStart: options.citationComment.start,
          sourceAnchor: options.citationComment.sourceAnchor,
        });
      }
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingQuestion.id,
          next.text,
          nextCursor,
          nextExpandedCursor,
          false,
        );
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(next.text, nextExpandedCursor));
      if (options?.focusEditorAfterReplace !== false) {
        window.requestAnimationFrame(() => {
          // Type-to-focus routes only the first key through here; once the
          // controlled update focuses the editor, later keys land natively.
          // Skip the deferred caret placement when the draft has moved on,
          // or it drags the caret back behind what was typed since.
          if (promptRef.current !== next.text) return;
          composerEditorRef.current?.focusAt(nextCursor);
        });
      }
      return true;
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
      setComposerTrigger,
    ],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      contextIds: collectInlineContextIds(promptRef.current),
    };
  }, [composerCursor, promptRef]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: resolveComposerTrigger(
        detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
      ),
    };
  }, [readComposerSnapshot, resolveComposerTrigger]);

  const { onUsageLimitsCommand } = props;
  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        const replacement = `${serializeComposerFileLink(item.path)} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "slash-command") {
        if (item.command === "model") {
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            focusEditorAfterReplace: false,
          });
          if (applied) {
            setComposerHighlightedItemId(null);
            setIsComposerModelPickerOpen(true);
          }
          return;
        }
        if (!planModeUiEnabled) return;
        void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "provider-slash-command") {
        if (item.command.name === USAGE_LIMITS_COMMAND.name && onUsageLimitsCommand) {
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            focusEditorAfterReplace: false,
          });
          if (applied) {
            setComposerHighlightedItemId(null);
            onUsageLimitsCommand();
          }
          return;
        }
        const replacement = `/${item.command.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "skill") {
        const replacement = `$${item.skill.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "pull-request") {
        if (
          trigger.kind !== "pull-request" ||
          !composerMenuItemsRef.current.some((candidate) => candidate.id === item.id)
        ) {
          return;
        }
        const comment = buildPullRequestReferenceContext(item.pullRequest);
        const replacement = `${formatInlineContextReference(
          reviewCommentContextReference(comment),
        )} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          addComposerDraftReviewComment(composerDraftTarget, comment, {
            appendReference: false,
          });
          setComposerHighlightedItemId(null);
        }
        return;
      }
    },
    [
      addComposerDraftReviewComment,
      applyPromptReplacement,
      composerDraftTarget,
      handleInteractionModeChange,
      planModeUiEnabled,
      onUsageLimitsCommand,
      resolveActiveComposerTrigger,
    ],
  );

  const onComposerMenuItemHighlighted = useCallback(
    (itemId: string | null) => {
      setComposerHighlightedItemId(itemId);
      setComposerHighlightedSearchKey(composerMenuSearchKey);
    },
    [composerMenuSearchKey],
  );

  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) return;
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );

  const blurMobileComposerAfterSend = useCallback(() => {
    if (!isMobileViewport) return;
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    setIsComposerFocused(false);
  }, [isMobileViewport, setIsComposerFocused]);

  return {
    onPromptChange,
    applyPromptReplacement,
    readComposerSnapshot,
    resolveActiveComposerTrigger,
    onSelectComposerItem,
    onComposerMenuItemHighlighted,
    nudgeComposerMenuHighlight,
    blurMobileComposerAfterSend,
  };
}
