import type { ChatComposerHandle } from "./ChatComposer.types";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import type { ChatFileAttachment, EnvironmentId } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { folderDropTarget, resolveDroppedFolderPath } from "./folderDrop";
import { useImperativeHandle } from "react";
import { flushSync } from "react-dom";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  formatAssistantCitationForComposer,
} from "../../composer-logic";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import {
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../../lib/terminalContext";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { insertInlineContextReference } from "~/lib/composerContextReferences";
import { terminalContextReference } from "~/lib/composerContextRecords";
import { randomUUID } from "~/lib/utils";
import { getComposerSubmissionValidationMessage } from "./composerSubmission";
import { shouldCollapseComposerForScrollKey } from "./composerScrollGesture";
import { toastManager } from "../ui/toast";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import { RefObject, Dispatch, SetStateAction } from "react";
import { ThreadId, PreviewAnnotationPayload } from "@t3tools/contracts";
import {
  DraftId,
  ComposerProjectMemoryReference,
  ComposerThreadTarget,
} from "../../composerDraftStore";
import { PendingUserInput } from "../../session-logic";

export function useComposerImperativeHandle(args: {
  activeThread: EnvironmentThread | undefined;
  addComposerAttachments: (
    files: File[],
    options?: {
      readonly source?: ChatFileAttachment["source"];
      readonly selection?: { start: number; end: number };
      readonly skipImageInlineChip?: boolean;
    },
  ) => Promise<boolean>;
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
  compactThreadContext: () => void;
  composerBlurFrameRef: RefObject<number | null>;
  composerCursor: number;
  composerDraftTarget:
    | { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
    | DraftId;
  composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  composerFilesRef: RefObject<ComposerFileAttachment[]>;
  composerFormRef: RefObject<HTMLFormElement | null>;
  composerImagesRef: RefObject<ComposerImageAttachment[]>;
  composerPreviewAnnotations: PreviewAnnotationPayload[];
  composerProjectMemoryReferences: ComposerProjectMemoryReference[];
  composerRef: RefObject<ChatComposerHandle | null>;
  composerReviewComments: ReviewCommentContext[];
  composerScrollCollapseEligibleRef: RefObject<boolean>;
  composerTerminalContexts: TerminalContextDraft[];
  composerTerminalContextsRef: RefObject<TerminalContextDraft[]>;
  environmentId: EnvironmentId;
  focusComposer: () => void;
  foldPastedText: (
    plainText: string,
    bypassAutoAttachment: boolean,
    selectionOverride?: { start: number; end: number },
  ) => boolean;
  getTimelineScrollableNode: () => HTMLElement | null;
  insertComposerDraftTerminalContext: (
    threadRef: ComposerThreadTarget,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  insertComposerText: (
    text: string,
    position: "cursor" | "end",
    options?: {
      ensureLeadingBoundary?: boolean;
      citationCommentAnchor?: AssistantCitationSourceAnchor;
      clipboardData?: DataTransfer;
    },
  ) => boolean;
  insertComposerTextAtEnd: (
    text: string,
    options?: { ensureLeadingBoundary?: boolean; clipboardData?: DataTransfer },
  ) => boolean;
  interactionMode: "default" | "plan";
  isChoiceOnlyPendingQuestion: boolean;
  isComposerApprovalState: boolean;
  isComposerModelPickerOpen: boolean;
  isConnecting: boolean;
  isTimelineAtLogicalEnd: () => boolean;
  multipleModelSelections:
    | readonly {
        readonly instanceId: ProviderInstanceId;
        readonly model: string;
        readonly options?: readonly { readonly id: string; readonly value: string | boolean }[];
      }[]
    | null;
  noProviderAvailable: boolean;
  openModelPicker: () => void;
  pasteAsTextShortcutUntilRef: RefObject<number>;
  pendingImageCompressionsRef: RefObject<Map<string, number>>;
  pendingUserInputs: PendingUserInput[];
  planModeUiEnabled: boolean;
  primaryEnvironmentId: EnvironmentId | null;
  projectSelectionRequired: boolean;
  promptRef: RefObject<string>;
  providerInputRejectedRef: RefObject<boolean>;
  providerSendBlockReason: string | null;
  readComposerSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  resetComposerTrigger: (candidate: ComposerTrigger | null) => void;
  restoreAfterTimelineReachedEnd: () => void;
  routeKind: "draft" | "server";
  selectedModel: string;
  selectedModelOptionsForDispatch:
    | readonly { readonly id: string; readonly value: string | boolean }[]
    | undefined;
  selectedModelSelection: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly options?: readonly { readonly id: string; readonly value: string | boolean }[];
  };
  selectedPromptEffort: string | null;
  selectedProvider: ProviderDriverKind;
  selectedProviderModels: readonly {
    readonly name: string;
    readonly capabilities: {
      readonly optionDescriptors?:
        | readonly (
            | {
                readonly id: string;
                readonly options: readonly {
                  readonly id: string;
                  readonly label: string;
                  readonly description?: string | undefined;
                  readonly isDefault?: boolean | undefined;
                }[];
                readonly type: "select";
                readonly label: string;
                readonly description?: string | undefined;
                readonly currentValue?: string | undefined;
                readonly promptInjectedValues?: readonly string[] | undefined;
              }
            | {
                readonly id: string;
                readonly type: "boolean";
                readonly label: string;
                readonly description?: string | undefined;
                readonly currentValue?: boolean | undefined;
              }
          )[]
        | undefined;
    } | null;
    readonly slug: string;
    readonly isCustom: boolean;
    readonly shortName?: string | undefined;
    readonly subProvider?: string | undefined;
    readonly aliases?: readonly string[] | undefined;
    readonly badge?: "new" | undefined;
    readonly isDefault?: boolean | undefined;
    readonly isLegacy?: boolean | undefined;
  }[];
  setComposerCursor: Dispatch<SetStateAction<number>>;
  setComposerHighlightedItemId: Dispatch<SetStateAction<string | null>>;
  setComposerTrigger: (candidate: ComposerTrigger | null) => void;
  setIsComposerFocused: Dispatch<SetStateAction<boolean>>;
  setIsComposerModelPickerOpen: Dispatch<SetStateAction<boolean>>;
  setIsComposerScrollCollapsed: Dispatch<SetStateAction<boolean>>;
  setMultipleModelSelections: Dispatch<
    SetStateAction<
      | readonly {
          readonly instanceId: ProviderInstanceId;
          readonly model: string;
          readonly options?: readonly { readonly id: string; readonly value: string | boolean }[];
        }[]
      | null
    >
  >;
  setProviderInputSubmissionError: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    activeThread,
    addComposerAttachments,
    applyPromptReplacement,
    attachmentTargetKey,
    compactThreadContext,
    composerBlurFrameRef,
    composerCursor,
    composerDraftTarget,
    composerEditorRef,
    composerFilesRef,
    composerFormRef,
    composerImagesRef,
    composerPreviewAnnotations,
    composerProjectMemoryReferences,
    composerRef,
    composerReviewComments,
    composerScrollCollapseEligibleRef,
    composerTerminalContexts,
    composerTerminalContextsRef,
    environmentId,
    focusComposer,
    foldPastedText,
    getTimelineScrollableNode,
    insertComposerDraftTerminalContext,
    insertComposerText,
    insertComposerTextAtEnd,
    interactionMode,
    isChoiceOnlyPendingQuestion,
    isComposerApprovalState,
    isComposerModelPickerOpen,
    isConnecting,
    isTimelineAtLogicalEnd,
    multipleModelSelections,
    noProviderAvailable,
    openModelPicker,
    pasteAsTextShortcutUntilRef,
    pendingImageCompressionsRef,
    pendingUserInputs,
    planModeUiEnabled,
    primaryEnvironmentId,
    projectSelectionRequired,
    promptRef,
    providerInputRejectedRef,
    providerSendBlockReason,
    readComposerSnapshot,
    resetComposerTrigger,
    restoreAfterTimelineReachedEnd,
    routeKind,
    selectedModel,
    selectedModelOptionsForDispatch,
    selectedModelSelection,
    selectedPromptEffort,
    selectedProvider,
    selectedProviderModels,
    setComposerCursor,
    setComposerHighlightedItemId,
    setComposerTrigger,
    setIsComposerFocused,
    setIsComposerModelPickerOpen,
    setIsComposerScrollCollapsed,
    setMultipleModelSelections,
    setProviderInputSubmissionError,
  } = args;

  useImperativeHandle(
    composerRef,
    () => ({
      focusAtEnd: () => {
        composerEditorRef.current?.focusAtEnd();
      },
      focusAt: (cursor: number) => {
        composerEditorRef.current?.focusAt(cursor);
      },
      restoreAfterTimelineReachedEnd,
      collapseForTimelineScrollKey: (key) => {
        const scrollNode = getTimelineScrollableNode();
        if (
          composerScrollCollapseEligibleRef.current &&
          scrollNode &&
          shouldCollapseComposerForScrollKey({
            key,
            scrollTop: scrollNode.scrollTop,
            scrollHeight: scrollNode.scrollHeight,
            clientHeight: scrollNode.clientHeight,
            isAtLogicalEnd: isTimelineAtLogicalEnd(),
          })
        ) {
          setIsComposerScrollCollapsed(true);
        }
      },
      addDroppedFiles: (files: File[]) => {
        void addComposerAttachments(files).then((inserted) => {
          if (!inserted) focusComposer();
        });
      },
      addDroppedFolders: (folders: File[]) => {
        const target = folderDropTarget({
          localEnvironmentDisabled: isLocalEnvironmentDisabled(),
          environmentId,
          primaryEnvironmentId,
        });
        if (target === "remote") {
          toastManager.add({
            type: "error",
            title: "Folders can't be dropped into remote environments",
          });
          return;
        }
        for (const folder of folders) {
          const path = resolveDroppedFolderPath(folder, window.desktopBridge?.getPathForFile);
          if (path === null) {
            toastManager.add({
              type: "error",
              title: `Couldn't get the path of "${folder.name}"`,
              description: "Type the folder path with @ instead.",
            });
            continue;
          }
          insertComposerTextAtEnd(`${serializeComposerFileLink(path)} `, {
            ensureLeadingBoundary: true,
          });
        }
        focusComposer();
      },
      hasPendingAttachments: () =>
        (pendingImageCompressionsRef.current.get(attachmentTargetKey) ?? 0) > 0,
      insertTextAtEnd: insertComposerTextAtEnd,
      pasteTextAtEnd: (text: string, options) => {
        const bypassAutoAttachment =
          options?.bypassAutoAttachment === true ||
          Date.now() <= pasteAsTextShortcutUntilRef.current;
        pasteAsTextShortcutUntilRef.current = 0;
        const promptLength = promptRef.current.length;
        if (
          !foldPastedText(text, bypassAutoAttachment, {
            start: promptLength,
            end: promptLength,
          })
        ) {
          return false;
        }
        focusComposer();
        return true;
      },
      citeAssistantText: (citation, sourceAnchor) =>
        insertComposerText(
          formatAssistantCitationForComposer(citation, citation.comment),
          "cursor",
          { ensureLeadingBoundary: true, citationCommentAnchor: sourceAnchor },
        ),
      openModelPicker,
      toggleModelPicker: () => {
        if (isComposerModelPickerOpen) {
          setIsComposerModelPickerOpen(false);
        } else {
          openModelPicker();
        }
      },
      openControl: (command) => {
        if (composerBlurFrameRef.current !== null) {
          window.cancelAnimationFrame(composerBlurFrameRef.current);
          composerBlurFrameRef.current = null;
        }
        flushSync(() => {
          setIsComposerScrollCollapsed(false);
          setIsComposerFocused(true);
        });
        const shell = composerFormRef.current?.closest('[data-slot="composer-shell"]');
        const trigger = Array.from(
          shell?.querySelectorAll<HTMLButtonElement>(
            `button[data-composer-shortcut~="${command}"]:not(:disabled)`,
          ) ?? [],
        ).find(
          (element) =>
            !element.closest("[inert]") && element.checkVisibility({ visibilityProperty: true }),
        );
        if (!trigger) return;
        trigger.focus({ preventScroll: true });
        trigger.click();
      },
      compactContext: compactThreadContext,
      isModelPickerOpen: () => isComposerModelPickerOpen,
      readSnapshot: () => {
        return readComposerSnapshot();
      },
      resetCursorState: (options?: {
        cursor?: number;
        prompt?: string;
        detectTrigger?: boolean;
      }) => {
        const promptForState = options?.prompt ?? promptRef.current;
        const cursor = clampCollapsedComposerCursor(promptForState, options?.cursor ?? 0);
        setComposerHighlightedItemId(null);
        setComposerCursor(cursor);
        resetComposerTrigger(
          options?.detectTrigger
            ? detectComposerTrigger(
                promptForState,
                expandCollapsedComposerCursor(promptForState, cursor),
              )
            : null,
        );
      },
      addTerminalContext: (selection: TerminalContextSelection) => {
        if (!activeThread || isChoiceOnlyPendingQuestion) return;
        const snapshot = readComposerSnapshot();
        const context = {
          id: randomUUID(),
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
          ...selection,
        };
        const insertion = insertInlineContextReference(
          snapshot.value,
          snapshot.expandedCursor,
          terminalContextReference(context),
        );
        const nextCollapsedCursor = collapseExpandedComposerCursor(
          insertion.prompt,
          insertion.cursor,
        );
        const inserted = insertComposerDraftTerminalContext(
          composerDraftTarget,
          insertion.prompt,
          context,
          composerTerminalContexts.length,
        );
        if (!inserted) return;
        promptRef.current = insertion.prompt;
        setComposerCursor(nextCollapsedCursor);
        setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCollapsedCursor);
        });
      },
      getSendContext: () => ({
        prompt: promptRef.current,
        images: composerImagesRef.current,
        files: composerFilesRef.current,
        terminalContexts: composerTerminalContextsRef.current,
        previewAnnotations: composerPreviewAnnotations,
        reviewComments: composerReviewComments,
        projectMemoryReferences: composerProjectMemoryReferences,
        selectedPromptEffort,
        selectedModelOptionsForDispatch,
        selectedModelSelection,
        multipleModelSelections:
          routeKind === "draft" && multipleModelSelections !== null
            ? multipleModelSelections.map((selection) =>
                selection.instanceId === selectedModelSelection.instanceId &&
                selection.model === selectedModelSelection.model
                  ? selectedModelSelection
                  : selection,
              )
            : null,
        providerAvailable:
          multipleModelSelections !== null ||
          (!noProviderAvailable && providerSendBlockReason === null),
        selectedProvider,
        selectedModel,
        selectedProviderModels,
        interactionMode,
        interactionModeEnabled: planModeUiEnabled,
      }),
      setMultipleModelSelections,
      validateProviderInput: (providerInput: string) => {
        const validationMessage = getComposerSubmissionValidationMessage({
          prompt: promptRef.current,
          providerInput,
          submissionTarget: "provider-turn",
        });
        providerInputRejectedRef.current = validationMessage !== null;
        setProviderInputSubmissionError(validationMessage);
        return validationMessage === null;
      },
    }),
    [
      activeThread,
      addComposerAttachments,
      foldPastedText,
      composerDraftTarget,
      composerCursor,
      composerTerminalContexts,
      insertComposerDraftTerminalContext,
      insertComposerText,
      insertComposerTextAtEnd,
      promptRef,
      composerImagesRef,
      composerFilesRef,
      composerTerminalContextsRef,
      composerPreviewAnnotations,
      composerReviewComments,
      composerProjectMemoryReferences,
      focusComposer,
      environmentId,
      primaryEnvironmentId,
      isConnecting,
      isComposerApprovalState,
      isChoiceOnlyPendingQuestion,
      pendingUserInputs.length,
      projectSelectionRequired,
      applyPromptReplacement,
      isComposerModelPickerOpen,
      openModelPicker,
      readComposerSnapshot,
      resetComposerTrigger,
      setComposerTrigger,
      selectedModel,
      selectedModelOptionsForDispatch,
      selectedModelSelection,
      multipleModelSelections,
      setMultipleModelSelections,
      routeKind,
      noProviderAvailable,
      providerSendBlockReason,
      selectedPromptEffort,
      selectedProvider,
      selectedProviderModels,
      interactionMode,
      planModeUiEnabled,
      compactThreadContext,
      restoreAfterTimelineReachedEnd,
      getTimelineScrollableNode,
      isTimelineAtLogicalEnd,
      setIsComposerScrollCollapsed,
    ],
  );
}
