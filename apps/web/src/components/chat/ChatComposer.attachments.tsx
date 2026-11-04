import type { ChatComposerHandle } from "./ChatComposer.types";
import { importPastedComposerText, readPastedComposerContext } from "../composerInlineTokenPaste";
import {
  questionAttachmentDraftId,
  countQuestionAttachments,
  useQuestionAttachmentPreparation,
  changeQuestionAttachmentPreparation,
} from "../../questionAttachments";
import type { ChatFileAttachment, EnvironmentId } from "@t3tools/contracts";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@t3tools/contracts";
import {
  nextPastedTextFileName,
  pastedTextDisposition,
  wouldTextPasteExceedLimit,
} from "@t3tools/client-runtime/text-paste";
import { useCallback } from "react";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  composerFileMatchesReattachMarker,
  composerFileNeedsReattach,
} from "../../composerDraftStore";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import {
  fileAttachmentTooLargeMessage,
  formatAttachmentSize,
} from "@t3tools/client-runtime/state/attachments";
import {
  classifyComposerAttachmentFile,
  normalizeComposerImageFileMimeType,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import {
  collectInlineContextIds,
  stripInlineContextReferences,
  type ComposerContextReference,
  ensureInlineContextReferences,
  formatInlineContextReference,
  inlineContextReferenceReplacement,
} from "~/lib/composerContextReferences";
import { fileContextReference, imageContextReference } from "~/lib/composerContextRecords";
import { requestConfirmDialog } from "~/confirmDialog";
import type { ComposerContextClipboardFragment } from "@t3tools/contracts";
import { isMacPlatform, randomUUID } from "~/lib/utils";
import { toastManager } from "../ui/toast";
import { videoMimeType } from "../../types";
import { ThreadId } from "@t3tools/contracts";
import { RefObject } from "react";
import { PendingUserInput } from "../../session-logic";
import { DraftId } from "../../composerDraftStore";
import { extendReplacementRangeForTrailingSpace } from "./ChatComposer.constants";

export function useComposerAttachmentHandlers(args: {
  activePendingIsResponding: boolean;
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
  activeThreadId: ThreadId | null;
  addComposerFilesToDraft: (files: ComposerFileAttachment[]) => string[];
  addComposerImage: (image: ComposerImageAttachment) => string[];
  addComposerImagesToDraft: (images: ComposerImageAttachment[]) => string[];
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
  composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  composerFilesRef: RefObject<ComposerFileAttachment[]>;
  composerImagesRef: RefObject<ComposerImageAttachment[]>;
  environmentId: EnvironmentId;
  expandMobileComposer: () => void;
  fileStagingLimit: number | null;
  importContextFragment: (
    fragment: ComposerContextClipboardFragment,
  ) => ReadonlyMap<string, string>;
  isComposerApprovalState: boolean;
  isComposerCollapsedMobile: boolean;
  isConnecting: boolean;
  isRevertingCheckpointRef: RefObject<boolean>;
  pasteAsTextShortcutUntilRef: RefObject<number>;
  pastedTextFileNamesRef: RefObject<{ targetKey: string; names: Set<string> }>;
  pendingImageCompressionsRef: RefObject<Map<string, number>>;
  pendingUserInputs: PendingUserInput[];
  projectSelectionRequired: boolean;
  promptRef: RefObject<string>;
  questionAttachmentTarget: DraftId | null;
  readComposerSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  removeComposerImageFromDraft: (imageId: string) => void;
  setPrompt: (nextPrompt: string) => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  supportsQuestionAttachments: boolean;
}) {
  const {
    activePendingIsResponding,
    activePendingProgress,
    activeThreadId,
    addComposerFilesToDraft,
    addComposerImage,
    addComposerImagesToDraft,
    applyPromptReplacement,
    attachmentTargetKey,
    composerEditorRef,
    composerFilesRef,
    composerImagesRef,
    environmentId,
    expandMobileComposer,
    fileStagingLimit,
    importContextFragment,
    isComposerApprovalState,
    isComposerCollapsedMobile,
    isConnecting,
    isRevertingCheckpointRef,
    pasteAsTextShortcutUntilRef,
    pastedTextFileNamesRef,
    pendingImageCompressionsRef,
    pendingUserInputs,
    projectSelectionRequired,
    promptRef,
    questionAttachmentTarget,
    readComposerSnapshot,
    removeComposerImageFromDraft,
    setPrompt,
    setThreadError,
    supportsQuestionAttachments,
  } = args;

  // ------------------------------------------------------------------
  // Callbacks: attachments
  // ------------------------------------------------------------------
  const countReservedAttachments = () => {
    const questionRequest = pendingUserInputs[0];
    const otherQuestionKeys =
      questionAttachmentTarget && questionRequest && activeThreadId
        ? questionRequest.questions
            .map((question) =>
              questionAttachmentDraftId(
                environmentId,
                activeThreadId,
                questionRequest.requestId,
                question.id,
              ),
            )
            .filter((key) => key !== questionAttachmentTarget)
        : [];
    return (
      composerImagesRef.current.length +
      composerFilesRef.current.length +
      (pendingImageCompressionsRef.current.get(attachmentTargetKey) ?? 0) +
      countQuestionAttachments(otherQuestionKeys)
    );
  };
  /** Resolves true when at least one chip was inserted for the accepted attachments. */
  const addComposerAttachments = async (
    files: File[],
    options?: {
      readonly source?: ChatFileAttachment["source"];
      readonly selection?: { start: number; end: number };
      readonly skipImageInlineChip?: boolean;
    },
  ): Promise<boolean> => {
    if (!activeThreadId || files.length === 0 || isRevertingCheckpointRef.current) return false;
    if (
      pendingUserInputs.length > 0 &&
      (!supportsQuestionAttachments ||
        activePendingProgress?.activeQuestion?.allowCustomAnswer === false ||
        activePendingIsResponding)
    ) {
      toastManager.add({
        type: "error",
        title: "This question cannot accept attachments.",
      });
      return false;
    }
    // Captured before the awaits below: the user may switch threads while a
    // large image is being compressed, and the attachments and errors belong
    // to the thread the paste happened in.
    const threadId = activeThreadId;
    // Images landing with no prose live on the shelf with no chip. Read before
    // the awaits below: compression is async and the prompt may change while it
    // runs. An explicit selection replace and states where the editor refuses
    // input (connecting, approval, pending questions, project selection) still
    // get chips so the image is never invisible, unless paste-as-text explicitly
    // requests no inline image chip.
    const imageAttachmentsGetChips =
      !options?.skipImageInlineChip &&
      (options?.selection !== undefined ||
        isConnecting ||
        isComposerApprovalState ||
        pendingUserInputs.length > 0 ||
        projectSelectionRequired ||
        stripInlineContextReferences(promptRef.current).trim().length > 0);

    // Validation happens synchronously so concurrent pastes see each other:
    // accepted files reserve their attachment slots (via the pending counter)
    // before the first await, keeping the total under the limit.
    const pendingCount = pendingImageCompressionsRef.current.get(attachmentTargetKey) ?? 0;
    let reservedCount = countReservedAttachments();
    // A pick that matches a needs-reattach marker replaces it in the draft, so
    // it must not consume a slot; a draft full of markers would otherwise hit
    // the capacity error before the replacement path could run.
    const reattachMarkers = composerFilesRef.current.filter(composerFileNeedsReattach);
    const replacedReattachMarkerIds = new Set<string>();
    const acceptedImages: File[] = [];
    const acceptedFiles: ComposerFileAttachment[] = [];
    let error: string | null = null;
    for (const file of files) {
      const attachmentKind = classifyComposerAttachmentFile(file);
      const fileMimeType =
        attachmentKind === "file"
          ? (videoMimeType({ name: file.name, mimeType: file.type }) ??
            (file.type || "application/octet-stream"))
          : file.type;
      const matchingReattachMarker =
        attachmentKind === "file"
          ? reattachMarkers.find(
              (marker) =>
                !replacedReattachMarkerIds.has(marker.id) &&
                composerFileMatchesReattachMarker(marker, {
                  name: file.name || "file",
                  mimeType: fileMimeType,
                  sizeBytes: file.size,
                }),
            )
          : undefined;
      if (matchingReattachMarker) {
        replacedReattachMarkerIds.add(matchingReattachMarker.id);
      }
      if (!matchingReattachMarker && reservedCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
        // Keep scanning: a later file in this batch can still replace a
        // needs-reattach marker without needing a free slot.
        continue;
      }
      if (attachmentKind === "unsupported-image") {
        error = `'${file.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`;
        continue;
      }
      if (attachmentKind === "image") {
        acceptedImages.push(normalizeComposerImageFileMimeType(file));
      } else {
        if (fileStagingLimit === null) {
          error = "This server does not support file attachments.";
          continue;
        }
        if (file.size <= 0) {
          error = `'${file.name}' is empty or could not be read.`;
          continue;
        }
        if (file.size > fileStagingLimit) {
          error = fileAttachmentTooLargeMessage(file.name, fileStagingLimit);
          continue;
        }
        const attachmentFile =
          file.type === fileMimeType
            ? file
            : new File([file], file.name, { type: fileMimeType, lastModified: file.lastModified });
        acceptedFiles.push({
          type: "file",
          id: randomUUID(),
          name: attachmentFile.name || "file",
          mimeType: fileMimeType,
          sizeBytes: attachmentFile.size,
          file: attachmentFile,
          ...(options?.source ? { source: options.source } : {}),
        });
      }
      if (!matchingReattachMarker) {
        reservedCount += 1;
      }
    }
    setThreadError(threadId, error);
    let insertedAny = false;
    if (acceptedFiles.length > 0) {
      // Only files the draft actually took get a chip; a duplicate is deduped by the store
      // and a chip for it would point at nothing.
      const storedIds = new Set(addComposerFilesToDraft(acceptedFiles));
      const storedFiles = acceptedFiles.filter((file) => storedIds.has(file.id));
      if (storedFiles.length > 0) {
        insertedAny = insertAttachmentReferences(
          storedFiles.map(fileContextReference),
          options?.selection,
        );
      }
      if (options?.source?._tag === "pasted-text" && storedFiles.length > 0) {
        const attached = storedFiles[0]!;
        toastManager.add({
          type: "info",
          title: `Large paste attached as ${attached.name}`,
          description: `${formatAttachmentSize(attached.sizeBytes)} · Use ${
            isMacPlatform(navigator.platform) ? "⌘⇧V" : "Ctrl+Shift+V"
          } to keep a large paste inline.`,
          data: { hideCopyButton: true },
        });
      }
    }
    if (acceptedImages.length === 0) return insertedAny;

    pendingImageCompressionsRef.current.set(
      attachmentTargetKey,
      pendingCount + acceptedImages.length,
    );
    if (questionAttachmentTarget)
      changeQuestionAttachmentPreparation(questionAttachmentTarget, acceptedImages.length);
    try {
      const nextImages: ComposerImageAttachment[] = [];
      let compressionError: string | null = null;
      for (const file of acceptedImages) {
        // Images over the wire cap are downscaled to fit rather than
        // refused; files already within it pass through byte-for-byte.
        const compressed = await prepareImageForAttachment(
          file,
          PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
        );
        if (!compressed.ok) {
          compressionError =
            compressed.reason === "unreadable"
              ? `'${file.name}' could not be read as an image.`
              : `'${file.name}' is too large to attach, even after compression.`;
          continue;
        }
        const attachmentFile = compressed.file;
        const previewUrl = URL.createObjectURL(attachmentFile);
        nextImages.push({
          type: "image",
          id: randomUUID(),
          name: attachmentFile.name || "image",
          mimeType: attachmentFile.type,
          sizeBytes: attachmentFile.size,
          previewUrl,
          file: attachmentFile,
        });
      }
      if (
        questionAttachmentTarget &&
        !useQuestionAttachmentPreparation.getState().counts[questionAttachmentTarget]
      ) {
        for (const image of nextImages) URL.revokeObjectURL(image.previewUrl);
        return false;
      }
      const storedImageIds = new Set(
        nextImages.length === 1 && nextImages[0]
          ? addComposerImage(nextImages[0])
          : nextImages.length > 1
            ? addComposerImagesToDraft(nextImages)
            : [],
      );
      const storedImages = nextImages.filter((image) => storedImageIds.has(image.id));
      if (storedImages.length > 0 && imageAttachmentsGetChips) {
        insertedAny =
          insertAttachmentReferences(storedImages.map(imageContextReference)) || insertedAny;
      }
      // Only failures are reported here. Success must not pass `null`: by
      // now other work (a failed send, an overlapping paste) may have set a
      // thread error this call knows nothing about, and clearing it would
      // swallow that message.
      if (compressionError !== null) {
        setThreadError(threadId, compressionError);
      }
    } finally {
      if (questionAttachmentTarget)
        changeQuestionAttachmentPreparation(questionAttachmentTarget, -acceptedImages.length);
      const remaining =
        (pendingImageCompressionsRef.current.get(attachmentTargetKey) ?? 0) - acceptedImages.length;
      if (remaining > 0) {
        pendingImageCompressionsRef.current.set(attachmentTargetKey, remaining);
      } else {
        pendingImageCompressionsRef.current.delete(attachmentTargetKey);
      }
    }
    return insertedAny;
  };

  /**
   * Chips for freshly attached files land at the caret; when the editor cannot take
   * input (approval, pending questions) they are appended so the file is never invisible.
   * Images skip this when they land with no prose and the editor takes input:
   * the shelf thumbnail is enough.
   */
  const insertAttachmentReferences = (
    references: ReadonlyArray<ComposerContextReference>,
    selection?: { start: number; end: number },
  ): boolean => {
    if (references.length === 0) return false;
    // Question answers carry attachments beside the answer, never as chips. Falling back to
    // the thread prompt here would hide the file behind a reference the question never shows.
    if (questionAttachmentTarget) return false;
    if (selection) {
      const edit = inlineContextReferenceReplacement(promptRef.current, selection, references);
      return applyPromptReplacement(edit.start, edit.end, edit.text);
    }
    const text = references.map(formatInlineContextReference).join(" ");
    const inserted = insertComposerText(`${text} `, "cursor", { ensureLeadingBoundary: true });
    if (!inserted) {
      setPrompt(ensureInlineContextReferences(promptRef.current, references));
    }
    return true;
  };

  const removeComposerImage = (imageId: string) => {
    const image = composerImagesRef.current.find((candidate) => candidate.id === imageId);
    const referenced = collectInlineContextIds(promptRef.current).includes(
      image ? imageContextReference(image).contextId : "",
    );
    if (!referenced) {
      removeComposerImageFromDraft(imageId);
      return;
    }
    const confirmation = requestConfirmDialog(
      `Remove ${image?.name ?? "this image"} from the message?\nIt is referenced in your text; removing it also removes every reference.`,
      { variant: "destructive" },
    );
    if (!confirmation) {
      removeComposerImageFromDraft(imageId);
      return;
    }
    void confirmation.then((confirmed) => {
      if (confirmed) removeComposerImageFromDraft(imageId);
    });
  };

  // ------------------------------------------------------------------
  // Callbacks: paste / drag
  // ------------------------------------------------------------------
  const foldPastedText = (
    plainText: string,
    bypassAutoAttachment: boolean,
    selectionOverride?: { start: number; end: number },
  ): boolean => {
    const questionCanAttach =
      pendingUserInputs.length === 0 ||
      (supportsQuestionAttachments &&
        activePendingProgress?.activeQuestion?.allowCustomAnswer !== false &&
        !activePendingIsResponding);
    const hasAttachmentSlot = countReservedAttachments() < PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
    const selection = selectionOverride ?? composerEditorRef.current?.readSelectionRange();
    const wouldExceedInputLimit = wouldTextPasteExceedLimit({
      valueLength: promptRef.current.length,
      selection: selection ?? { start: 0, end: 0 },
      textLength: plainText.length,
      maxLength: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    });
    const shouldFold =
      pastedTextDisposition({
        text: plainText,
        bypassAutoAttachment,
        wouldExceedInputLimit,
        canAttach: true,
      }) === "attachment";
    if (!shouldFold) {
      return false;
    }

    const canStageAttachment =
      Boolean(activeThreadId) &&
      !isRevertingCheckpointRef.current &&
      questionCanAttach &&
      hasAttachmentSlot;
    if (!canStageAttachment || fileStagingLimit === null) {
      if (!wouldExceedInputLimit) {
        return false;
      }
      toastManager.add({
        type: "error",
        title: "Pasted text is too large for this message",
        description: "Remove some text or an attachment, then paste again.",
        data: { hideCopyButton: true },
      });
      return true;
    }

    if (pastedTextFileNamesRef.current.targetKey !== attachmentTargetKey) {
      pastedTextFileNamesRef.current = { targetKey: attachmentTargetKey, names: new Set() };
    }
    const reservedNames = pastedTextFileNamesRef.current.names;
    for (const file of composerFilesRef.current) reservedNames.add(file.name);
    const foldedFileName = nextPastedTextFileName([...reservedNames]);
    reservedNames.add(foldedFileName);
    const foldedFile = new File([plainText], foldedFileName, {
      type: "text/plain;charset=utf-8",
    });
    if (foldedFile.size > fileStagingLimit) {
      reservedNames.delete(foldedFileName);
      if (!wouldExceedInputLimit) return false;
      toastManager.add({
        type: "error",
        title: "Pasted text is too large to attach",
        description: "Reduce the clipboard contents or save a smaller excerpt as a file.",
        data: { hideCopyButton: true },
      });
      return true;
    }

    void addComposerAttachments([foldedFile], {
      source: { _tag: "pasted-text" },
      ...(selection ? { selection } : {}),
    });
    return true;
  };

  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    const plainText = event.clipboardData.getData("text/plain");
    const bypassAutoAttachment = Date.now() <= pasteAsTextShortcutUntilRef.current;
    pasteAsTextShortcutUntilRef.current = 0;
    // Claimable pastes go through even when agent questions are pending or the
    // composer is at its attachment limit: `addComposerAttachments` surfaces
    // those as a toast and a thread error. An early return here would swallow
    // the paste with no feedback.
    if (
      files.length > 0 &&
      activeThreadId &&
      shouldHandleComposerAttachmentPaste({ files, plainText })
    ) {
      event.preventDefault();
      event.stopPropagation();
      void addComposerAttachments(files, { skipImageInlineChip: bypassAutoAttachment });
      return;
    }

    // Copied T3 chips need the structured importer to bring their records and files along.
    if ((readPastedComposerContext(event.clipboardData)?.records.length ?? 0) > 0) return;
    if (!foldPastedText(plainText, bypassAutoAttachment)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  const insertComposerText = useCallback(
    (
      text: string,
      position: "cursor" | "end",
      options?: {
        ensureLeadingBoundary?: boolean;
        citationCommentAnchor?: AssistantCitationSourceAnchor;
        clipboardData?: DataTransfer;
      },
    ): boolean => {
      if (
        text.length === 0 ||
        isConnecting ||
        isComposerApprovalState ||
        pendingUserInputs.length > 0 ||
        projectSelectionRequired ||
        (options?.citationCommentAnchor && !composerEditorRef.current)
      ) {
        return false;
      }
      if (options?.clipboardData) {
        text = importPastedComposerText(options.clipboardData, importContextFragment);
      }
      const prompt = promptRef.current;
      const cursor = position === "cursor" ? readComposerSnapshot().expandedCursor : prompt.length;
      const needsLeadingSpace =
        (options?.ensureLeadingBoundary ?? false) &&
        cursor > 0 &&
        !/\s/.test(prompt[cursor - 1] ?? "");
      const rangeEnd = extendReplacementRangeForTrailingSpace(prompt, cursor, text);
      return applyPromptReplacement(
        cursor,
        rangeEnd,
        needsLeadingSpace ? ` ${text}` : text,
        options?.citationCommentAnchor
          ? {
              citationComment: {
                start: cursor + (needsLeadingSpace ? 1 : 0),
                sourceAnchor: options.citationCommentAnchor,
              },
              focusEditorAfterReplace: false,
            }
          : undefined,
      );
    },
    [
      applyPromptReplacement,
      isComposerApprovalState,
      isConnecting,
      pendingUserInputs.length,
      projectSelectionRequired,
      promptRef,
      readComposerSnapshot,
      importContextFragment,
    ],
  );

  const insertComposerTextAtEnd = useCallback<ChatComposerHandle["insertTextAtEnd"]>(
    (text, options) => {
      const inserted = insertComposerText(text, "end", options);
      if (inserted && isComposerCollapsedMobile) {
        // The expanded editor is hidden at phone widths, so its scheduled
        // focus cannot expand the composer by itself. Reveal it before the
        // focus frame runs to preserve type-to-focus and external inserts.
        expandMobileComposer();
      }
      return inserted;
    },
    [expandMobileComposer, insertComposerText, isComposerCollapsedMobile],
  );

  // Context produced by other panels (diff comments, preview picks) asks the store to place
  // its chip; while this composer is mounted for the draft, that means the caret.
  const insertContextReferencesAtCaret = useCallback(
    (references: ReadonlyArray<ComposerContextReference>): boolean =>
      insertComposerText(`${references.map(formatInlineContextReference).join(" ")} `, "cursor", {
        ensureLeadingBoundary: true,
      }),
    [insertComposerText],
  );

  return {
    addComposerAttachments,
    removeComposerImage,
    foldPastedText,
    onComposerPaste,
    insertComposerText,
    insertComposerTextAtEnd,
    insertContextReferencesAtCaret,
  };
}
