import type { EnvironmentId } from "@t3tools/contracts";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { useCallback, useEffect } from "react";
import { type ComposerTrigger, collapseExpandedComposerCursor } from "../../composer-logic";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type PersistedComposerFileAttachment,
  type PersistedComposerImageAttachment,
  composerFileDedupKey,
  composerFileMatchesReattachMarker,
  composerFileNeedsReattach,
  composerTargetKey,
  hydrateImagesFromPersisted,
} from "../../composerDraftStore";
import {
  MAX_STASH_ENTRIES,
  partitionStashAttachments,
  usePromptStashStore,
  type PromptStashEntry,
} from "../../promptStashStore";
import { compressImageForStash } from "../../lib/imageCompression";
import {
  readAttachmentUpload,
  releaseAttachmentUpload,
  releasePersistedAttachmentUpload,
  verifyStashedAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { type TerminalContextDraft } from "../../lib/terminalContext";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { formatInlineContextReference } from "~/lib/composerContextReferences";
import {
  previewAnnotationContextRecord,
  reviewCommentContextRecord,
  terminalContextRecord,
} from "~/lib/composerContextRecords";
import type { ComposerContextRecord } from "@t3tools/contracts";
import { resizeSnapShotSource } from "../../lib/snapShotSource";
import { randomUUID } from "~/lib/utils";
import { pendingDraftWork } from "./pendingDraftWork";
import { toastManager } from "../ui/toast";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { ComposerThreadTarget, DraftId, ComposerThreadDraftState } from "../../composerDraftStore";
import { RefObject, Dispatch, SetStateAction } from "react";
import { ThreadId, PreviewAnnotationPayload } from "@t3tools/contracts";

export function useComposerStash(args: {
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
  attachmentTargetKeyRef: RefObject<string>;
  clearComposerDraftPromptAndImages: (threadRef: ComposerThreadTarget) => void;
  clearComposerDraftTerminalContexts: (threadRef: ComposerThreadTarget) => void;
  composerDraftTarget:
    | { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
    | DraftId;
  composerDraftTargetKeyRef: RefObject<string>;
  composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  composerFilesRef: RefObject<ComposerFileAttachment[]>;
  composerImagesRef: RefObject<ComposerImageAttachment[]>;
  composerPreviewAnnotations: PreviewAnnotationPayload[];
  composerReviewComments: ReviewCommentContext[];
  composerTerminalContextsRef: RefObject<TerminalContextDraft[]>;
  environmentId: EnvironmentId;
  getComposerDraft: (target: ComposerThreadTarget) => ComposerThreadDraftState | null;
  importContextRecords: (
    records: ReadonlyArray<ComposerContextRecord>,
    sourceEnvironmentId: EnvironmentId | null,
  ) => ReadonlyMap<string, string>;
  isRevertingCheckpointRef: RefObject<boolean>;
  promptRef: RefObject<string>;
  removeComposerDraftPreviewAnnotation: (
    threadRef: ComposerThreadTarget,
    annotationId: string,
  ) => void;
  removeComposerDraftReviewComment: (threadRef: ComposerThreadTarget, commentId: string) => void;
  setComposerCursor: Dispatch<SetStateAction<number>>;
  setComposerDraftPrompt: (threadRef: ComposerThreadTarget, prompt: string) => void;
  setComposerTrigger: (candidate: ComposerTrigger | null) => void;
  setIsStashMenuOpen: Dispatch<SetStateAction<boolean>>;
  setStashPulse: Dispatch<SetStateAction<{ key: number; active: boolean }>>;
  stashInFlightRef: RefObject<Set<string>>;
  stashPulseKeyRef: RefObject<number>;
  stashPulseTimeoutRef: RefObject<number | null>;
}) {
  const {
    addComposerDraftFiles,
    addComposerDraftImages,
    attachmentTargetKeyRef,
    clearComposerDraftPromptAndImages,
    clearComposerDraftTerminalContexts,
    composerDraftTarget,
    composerDraftTargetKeyRef,
    composerEditorRef,
    composerFilesRef,
    composerImagesRef,
    composerPreviewAnnotations,
    composerReviewComments,
    composerTerminalContextsRef,
    environmentId,
    getComposerDraft,
    importContextRecords,
    isRevertingCheckpointRef,
    promptRef,
    removeComposerDraftPreviewAnnotation,
    removeComposerDraftReviewComment,
    setComposerCursor,
    setComposerDraftPrompt,
    setComposerTrigger,
    setIsStashMenuOpen,
    setStashPulse,
    stashInFlightRef,
    stashPulseKeyRef,
    stashPulseTimeoutRef,
  } = args;

  // ------------------------------------------------------------------
  // Prompt stash (⌘S)
  // ------------------------------------------------------------------
  // Files remain tied to the environment that owns their uploaded bytes.
  const stashQueue = usePromptStashStore((state) => state.entries);
  const stashEntryToQueue = usePromptStashStore((state) => state.stashEntry);
  const takeStashEntry = usePromptStashStore((state) => state.takeEntry);
  const finalizeStashEntryImages = usePromptStashStore((state) => state.finalizeEntryImages);

  useEffect(() => {
    return () => {
      if (stashPulseTimeoutRef.current !== null) {
        window.clearTimeout(stashPulseTimeoutRef.current);
      }
    };
  }, []);

  /** Briefly highlight the badge so the save registers without a flourish. */
  const pulseStashBadge = useCallback(() => {
    stashPulseKeyRef.current += 1;
    setStashPulse({ key: stashPulseKeyRef.current, active: true });
    if (stashPulseTimeoutRef.current !== null) {
      window.clearTimeout(stashPulseTimeoutRef.current);
    }
    stashPulseTimeoutRef.current = window.setTimeout(() => {
      stashPulseTimeoutRef.current = null;
      setStashPulse((current) => ({ ...current, active: false }));
    }, 1200);
  }, []);

  const restoreStashEntry = useCallback(
    async (menuEntry: PromptStashEntry) => {
      const filesToVerify = menuEntry.files ?? [];
      if (filesToVerify.some((file) => file.environmentId !== environmentId)) {
        toastManager.add({
          type: "error",
          title: "Stashed files belong to another environment",
          description: "Restore this prompt in the environment that received its files.",
        });
        return;
      }
      setIsStashMenuOpen(false);

      // The server sweeps pending uploads after 24 hours, so ask before
      // reattaching. An expired upload restores as a needs-reattach row
      // instead of a reference the next send would fail to verify. Verify
      // BEFORE taking: the take removes the entry from durable storage, and a
      // tab closed during this await must still find it there after reload.
      const verifications = await Promise.all(
        filesToVerify.map((file) =>
          verifyStashedAttachmentUpload({ environmentId, attachmentId: file.attachmentId }),
        ),
      );
      const expiredAttachmentIds = new Set(
        filesToVerify
          .filter((_, index) => verifications[index]?.status === "missing")
          .map((file) => file.attachmentId),
      );

      // A thread switch during the verify await would mix the new thread's
      // prompt with this invocation's captured target. Nothing was taken yet,
      // so abort and leave the entry restorable where the user now is.
      if (
        isRevertingCheckpointRef.current ||
        composerTargetKey(composerDraftTarget) !== composerDraftTargetKeyRef.current
      ) {
        return;
      }

      // The take is also the double-activation guard (click + Enter): the
      // second caller finds the entry gone and stops here.
      const { entry, durable } = takeStashEntry(menuEntry.id);
      if (!entry) return;
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Restored prompt may reappear in the stash",
          description:
            "Browser storage rejected the update, so this entry could still be there after a reload.",
          data: { hideCopyButton: true },
        });
      }

      const rewrittenContextIds = entry.records
        ? importContextRecords(entry.records, null)
        : new Map<string, string>();
      const restoredPrompt = replaceComposerContextReferences(entry.prompt, (reference) => {
        const contextId = rewrittenContextIds.get(reference.contextId);
        return contextId
          ? formatInlineContextReference({
              ...reference,
              contextId,
              kind: reference.kind === "element" ? "preview-annotation" : reference.kind,
            })
          : reference.source;
      });
      const currentPrompt = promptRef.current;
      // An image-only stash must not append blank lines to whatever is
      // already in the composer.
      const nextPrompt =
        restoredPrompt.length === 0
          ? currentPrompt
          : currentPrompt.trim().length
            ? `${currentPrompt.replace(/\s+$/, "")}\n\n${restoredPrompt}`
            : restoredPrompt;
      let promptChanged = nextPrompt !== currentPrompt;
      if (promptChanged) {
        promptRef.current = nextPrompt;
        setComposerDraftPrompt(composerDraftTarget, nextPrompt);
        setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
        setComposerTrigger(null);
      }

      let unrestoredFileNames: string[] = [];
      const expiredFileNames: string[] = [];
      let restoredFileCount = 0;
      const stashedFiles = entry.files ?? [];
      if (stashedFiles.length > 0) {
        const composerFilesNow = composerFilesRef.current;
        const existingFileIds = new Set(composerFilesNow.map((file) => file.id));
        const retainedUploadIds = new Set(
          composerFilesNow.flatMap((file) =>
            file.uploadedAttachmentId ? [file.uploadedAttachmentId] : [],
          ),
        );
        const existingFileKeys = new Set(composerFilesNow.map(composerFileDedupKey));
        const reattachMarkers = composerFilesNow.filter(composerFileNeedsReattach);
        const restoredMarkerIds = new Set<string>();
        const duplicateFiles: PersistedComposerFileAttachment[] = [];
        const markerReplacements: ComposerFileAttachment[] = [];
        const appendedFiles: ComposerFileAttachment[] = [];
        for (const file of stashedFiles) {
          const expired = expiredAttachmentIds.has(file.attachmentId);
          const key = composerFileDedupKey(file);
          const restored: ComposerFileAttachment = {
            type: "file",
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            file: null,
            ...(file.source ? { source: file.source } : {}),
            // An expired upload carries no ids, so it hydrates as a
            // needs-reattach row and the "Attach again" flow takes over.
            ...(expired
              ? {}
              : { uploadedAttachmentId: file.attachmentId, uploadEnvironmentId: environmentId }),
          };
          if (existingFileIds.has(file.id)) {
            if (!expired && !retainedUploadIds.has(file.attachmentId)) {
              duplicateFiles.push(file);
            }
            continue;
          }
          const reattachMarker = reattachMarkers.find(
            (marker) =>
              !restoredMarkerIds.has(marker.id) && composerFileMatchesReattachMarker(marker, file),
          );
          if (reattachMarker) {
            restoredMarkerIds.add(reattachMarker.id);
            existingFileIds.add(file.id);
            existingFileKeys.add(key);
            if (expired) {
              expiredFileNames.push(file.name);
            } else {
              retainedUploadIds.add(file.attachmentId);
              markerReplacements.push(restored);
            }
            continue;
          }
          if (existingFileKeys.has(key)) {
            if (!expired && !retainedUploadIds.has(file.attachmentId)) {
              duplicateFiles.push(file);
            }
            continue;
          }
          existingFileIds.add(file.id);
          existingFileKeys.add(key);
          if (expired) {
            expiredFileNames.push(file.name);
          } else {
            retainedUploadIds.add(file.attachmentId);
          }
          appendedFiles.push(restored);
        }
        const capacity = Math.max(
          0,
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS -
            composerImagesRef.current.length -
            composerFilesNow.length,
        );
        // Marker replacements reuse their marker's slot; only appended files
        // consume capacity.
        const filesToAppend = appendedFiles.slice(0, capacity);
        const skippedFiles = appendedFiles.slice(capacity);
        unrestoredFileNames = skippedFiles.map((file) => file.name);
        // A non-durable take can resurrect the stash entry after a reload;
        // deleting these uploads would leave it pointing at nothing.
        if (durable) {
          for (const file of duplicateFiles) {
            releasePersistedAttachmentUpload({
              id: file.id,
              environmentId,
              attachmentId: file.attachmentId,
            });
          }
          for (const file of skippedFiles) {
            if (file.uploadedAttachmentId) {
              releasePersistedAttachmentUpload({
                id: file.id,
                environmentId,
                attachmentId: file.uploadedAttachmentId,
              });
            }
          }
        }
        const restoredFiles = [...markerReplacements, ...filesToAppend];
        if (restoredFiles.length > 0) {
          addComposerDraftFiles(composerDraftTarget, restoredFiles, { appendReference: true });
          const restoredFilePrompt = getComposerDraft(composerDraftTarget)?.prompt;
          if (restoredFilePrompt !== undefined && restoredFilePrompt !== promptRef.current) {
            promptRef.current = restoredFilePrompt;
            setComposerCursor(
              collapseExpandedComposerCursor(restoredFilePrompt, restoredFilePrompt.length),
            );
            setComposerTrigger(null);
            promptChanged = true;
          }
          restoredFileCount = filesToAppend.length;
        }
      }

      let unrestoredImageNames: string[] = [];
      if (entry.attachments.length > 0) {
        const existingIds = new Set(composerImagesRef.current.map((image) => image.id));
        // The draft store also dedupes by mimeType+sizeBytes+name, so filter
        // on the same key here. Counting a duplicate against capacity would
        // burn a slot the store then refuses to fill, pushing a genuinely
        // unique image into the overflow list for nothing.
        const existingDedupKeys = new Set(
          composerImagesRef.current.map(
            (image) => `${image.mimeType}\0${image.sizeBytes}\0${image.name}`,
          ),
        );
        const capacity = Math.max(
          0,
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS -
            composerImagesRef.current.length -
            composerFilesRef.current.length -
            restoredFileCount,
        );
        const pending = entry.attachments.filter(
          (attachment) =>
            !existingIds.has(attachment.id) &&
            !existingDedupKeys.has(
              `${attachment.mimeType}\0${attachment.sizeBytes}\0${attachment.name}`,
            ),
        );
        // Anything past the attachment limit cannot be restored. The entry is
        // already out of the queue, so report the overflow by name instead of
        // discarding it silently.
        unrestoredImageNames = pending.slice(capacity).map((attachment) => attachment.name);
        const restoredImages = hydrateImagesFromPersisted(pending.slice(0, capacity));
        if (restoredImages.length > 0) {
          addComposerDraftImages(composerDraftTarget, restoredImages);
        }
      }

      // Deliberately no model/provider restore: the stash exists to carry a
      // prompt across threads and providers, so whatever the composer has
      // selected right now stays selected.

      // Each cause gets its own sentence so "too large" is never blamed for a
      // file that actually failed to decode, or for one the composer simply
      // had no room to take back.
      const missingImageReasons: string[] = [];
      if (entry.droppedImageNames.length > 0) {
        missingImageReasons.push(
          `${entry.droppedImageNames.join(", ")} exceeded the stash size limit when this prompt was saved.`,
        );
      }
      if (entry.unreadableImageNames && entry.unreadableImageNames.length > 0) {
        missingImageReasons.push(
          `${entry.unreadableImageNames.join(", ")} could not be read when this prompt was saved.`,
        );
      }
      if (unrestoredImageNames.length > 0) {
        missingImageReasons.push(
          `${unrestoredImageNames.join(", ")} could not be restored: the composer is at its ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-attachment limit.`,
        );
      }
      if (unrestoredFileNames.length > 0) {
        missingImageReasons.push(
          `${unrestoredFileNames.join(", ")} could not be restored: the composer is at its ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-attachment limit.`,
        );
      }
      if (expiredFileNames.length > 0) {
        missingImageReasons.push(
          `${expiredFileNames.join(", ")}: stashed files are kept for 24 hours and this upload expired. Attach the file again.`,
        );
      }
      if (missingImageReasons.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Some attachments were not restored",
          description: missingImageReasons.join(" "),
        });
      }

      // Only yank the caret to the end when text was actually inserted;
      // restoring images alone should leave the user where they were typing.
      if (promptChanged) {
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAtEnd();
        });
      }
    },
    [
      addComposerDraftFiles,
      addComposerDraftImages,
      composerDraftTarget,
      composerFilesRef,
      composerImagesRef,
      environmentId,
      promptRef,
      setComposerDraftPrompt,
      setComposerTrigger,
      takeStashEntry,
      importContextRecords,
    ],
  );

  const deleteStashEntry = useCallback(
    (entry: PromptStashEntry) => {
      const { entry: removed, durable } = takeStashEntry(entry.id);
      if (!stashQueue.some((candidate) => candidate.id !== entry.id)) {
        setIsStashMenuOpen(false);
      }
      if (durable && removed) {
        for (const file of removed.files ?? []) {
          releasePersistedAttachmentUpload({
            id: file.id,
            environmentId: file.environmentId,
            attachmentId: file.attachmentId,
          });
        }
      }
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stash entry may come back",
          description:
            "Browser storage rejected the delete, so this prompt could reappear after a reload.",
          data: { hideCopyButton: true },
        });
      }
    },
    [stashQueue, takeStashEntry],
  );

  const stashCurrentPrompt = useCallback(async () => {
    // Stashing clears the draft. A pasted attachment still downloading would then land in the
    // emptied composer instead of travelling with the entry it belongs to.
    if (pendingDraftWork.has(attachmentTargetKeyRef.current)) {
      toastManager.add({
        type: "info",
        title: "Still bringing a pasted attachment into this message.",
        description: "Stash again once its chip resolves.",
      });
      return;
    }
    const prompt = promptRef.current.trim();
    const images = [...composerImagesRef.current];
    const files = [...composerFilesRef.current];
    // Context chips keep their links in the prompt; the payloads behind them travel as
    // records so the restore can resolve every chip.
    const stashedRecords: ComposerContextRecord[] = [
      ...composerTerminalContextsRef.current.map(terminalContextRecord),
      ...composerReviewComments.map(reviewCommentContextRecord),
      ...composerPreviewAnnotations.map((annotation) =>
        previewAnnotationContextRecord(annotation, {
          screenshotContextId: images.some((image) => image.id === annotation.id)
            ? annotation.id
            : undefined,
        }),
      ),
    ];
    if (prompt.length === 0 && images.length === 0 && files.length === 0) {
      const entries = usePromptStashStore.getState().entries;
      const entry = entries.length === 1 ? entries[0] : undefined;
      if (entry && !entry.pendingImageCount) {
        await restoreStashEntry(entry);
      } else {
        setIsStashMenuOpen((open) => !open);
      }
      return;
    }
    const stashedFiles: PersistedComposerFileAttachment[] = [];
    for (const file of files) {
      if (composerFileNeedsReattach(file)) {
        toastManager.add({
          type: "error",
          title: "Attach dropped files again or remove them before stashing",
        });
        return;
      }
      const upload = readAttachmentUpload(file.id);
      if (upload?.status !== "ready" || upload.environmentId !== environmentId) {
        toastManager.add({
          type: "error",
          title: "Wait for file uploads before stashing this prompt",
        });
        return;
      }
      stashedFiles.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        attachmentId: upload.attachmentId,
        environmentId,
        ...(file.source ? { source: file.source } : {}),
      });
    }
    // A repeat ⌘S on the *same* still-unencoded snapshot would stash it
    // twice. Guard on the snapshot itself rather than a bare boolean: once
    // the composer has been cleared the user can type something genuinely
    // new (or switch threads) while encoding continues, and that deserves its
    // own entry.
    const attachmentKey = images
      .map((image) => `image:${image.id}`)
      .concat(files.map((file) => `file:${file.id}`))
      .join(",");
    const snapshotKey = [String(composerDraftTarget), prompt, attachmentKey].join("\n");
    if (stashInFlightRef.current.has(snapshotKey)) return;
    stashInFlightRef.current.add(snapshotKey);

    const stashTarget = composerDraftTarget;
    const entryId = randomUUID();
    try {
      // Persist the text-only entry *first*, then clear. Ordering matters in
      // both directions: writing before clearing means a crash or closed tab
      // mid-encode still leaves the prompt recoverable, while clearing before
      // the async image work means edits typed during encoding are not wiped.
      // Images are appended to the stored entry as they finish encoding.
      const { evicted, written, durable } = stashEntryToQueue({
        id: entryId,
        createdAt: new Date().toISOString(),
        prompt,
        attachments: [],
        ...(stashedFiles.length > 0 ? { files: stashedFiles } : {}),
        droppedImageNames: [],
        unreadableImageNames: [],
        pendingImageCount: images.length,
        ...(stashedRecords.length > 0 ? { records: stashedRecords } : {}),
      });

      // Clearing the composer is only safe once the write actually landed.
      // If it was rejected (quota) the store has already rolled itself back,
      // so leave the composer untouched rather than making it the second
      // casualty of a reload.
      if (!written) {
        toastManager.add({
          type: "error",
          title: "Could not stash this prompt",
          description:
            "Browser storage rejected the write, so the composer was left as-is. Free up site data and try again.",
          data: { hideCopyButton: true },
        });
        return;
      }
      // Written but only into the in-memory fallback (localStorage blocked):
      // the entry is visible and restorable this session, so proceed with the
      // clear, but say it won't survive a reload.
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stashed prompt will not survive a reload",
          description:
            "Browser storage is unavailable, so this stash is kept in memory only for this session.",
          data: { hideCopyButton: true },
        });
      }

      // Everything the entry carries leaves the draft with it.
      promptRef.current = "";
      clearComposerDraftPromptAndImages(stashTarget);
      clearComposerDraftTerminalContexts(stashTarget);
      for (const comment of composerReviewComments) {
        removeComposerDraftReviewComment(stashTarget, comment.id);
      }
      for (const annotation of composerPreviewAnnotations) {
        releaseAttachmentUpload(annotation.id);
        removeComposerDraftPreviewAnnotation(stashTarget, annotation.id);
      }
      setComposerDraftPrompt(stashTarget, "");
      for (const image of images) {
        releaseAttachmentUpload(image.id);
      }
      setComposerCursor(0);
      setComposerTrigger(null);
      pulseStashBadge();

      if (evicted) {
        for (const file of evicted.files ?? []) {
          releasePersistedAttachmentUpload({
            id: file.id,
            environmentId: file.environmentId,
            attachmentId: file.attachmentId,
          });
        }
        toastManager.add({
          type: "warning",
          title: "Oldest stashed prompt discarded",
          description: `The stash holds ${MAX_STASH_ENTRIES} prompts; the oldest was removed to make room.`,
          data: { hideCopyButton: true },
        });
      }

      // Images are re-encoded for the stash rather than stored verbatim: the
      // composer allows up to 10MB per image, but localStorage gives the whole
      // origin ~5MB. Only the stashed copy shrinks; the live attachment (and
      // anything sent without stashing) keeps the original file.
      const candidateAttachments: PersistedComposerImageAttachment[] = [];
      const oversizedImageNames: string[] = [];
      const unreadableImageNames: string[] = [];
      for (const image of images) {
        const result = await compressImageForStash(image.file);
        if (!result.ok) {
          // "too large" and "could not be read" are distinct outcomes; the
          // menu and restore toast report them separately.
          (result.reason === "too-large" ? oversizedImageNames : unreadableImageNames).push(
            image.name,
          );
          continue;
        }
        candidateAttachments.push({
          id: image.id,
          name: image.name,
          mimeType: result.image.mimeType,
          sizeBytes: result.image.sizeBytes,
          dataUrl: result.image.dataUrl,
          ...(image.source
            ? { source: resizeSnapShotSource(image.source, result.image.imageSize) }
            : {}),
        });
      }
      const { kept, droppedNames } = partitionStashAttachments(candidateAttachments);

      const { attached, durable: imagesDurable } = finalizeStashEntryImages(entryId, {
        attachments: kept,
        droppedImageNames: [...oversizedImageNames, ...droppedNames],
        unreadableImageNames,
      });
      if (attached) {
        // The second phase can be rejected on its own: the text-only entry
        // fit, but adding image payloads pushed past the quota. Disk would
        // then still hold the phase-one entry with pendingImageCount set,
        // which reads as an orphan after reload — so say so now. Gated on the
        // entry write having been durable: on the in-memory fallback nothing
        // is ever durable, and the session-only warning already covered it.
        if (!imagesDurable && durable && images.length > 0) {
          toastManager.add({
            type: "warning",
            title: "Stashed images were not saved",
            description:
              "The prompt was stashed, but browser storage rejected its images. They will be missing if you reload.",
            data: { hideCopyButton: true },
          });
        }
      } else if (kept.length > 0) {
        // The entry was restored or deleted before its images finished
        // encoding, so they have nowhere to land. Say so rather than letting
        // them evaporate.
        toastManager.add({
          type: "warning",
          title: "Stashed images did not attach",
          description: `That prompt was restored or deleted before ${kept.length} image${kept.length === 1 ? "" : "s"} finished saving. Re-attach ${kept.length === 1 ? "it" : "them"} if you still need ${kept.length === 1 ? "it" : "them"}.`,
          data: { hideCopyButton: true },
        });
      }
    } finally {
      // Must clear on every path: a throw that left this set would wedge this
      // snapshot's ⌘S until the composer remounts.
      stashInFlightRef.current.delete(snapshotKey);
    }
  }, [
    clearComposerDraftPromptAndImages,
    clearComposerDraftTerminalContexts,
    setComposerDraftPrompt,
    setComposerTrigger,
    composerDraftTarget,
    composerFilesRef,
    composerImagesRef,
    composerTerminalContextsRef,
    composerReviewComments,
    composerPreviewAnnotations,
    removeComposerDraftReviewComment,
    removeComposerDraftPreviewAnnotation,
    environmentId,
    finalizeStashEntryImages,
    promptRef,
    pulseStashBadge,
    restoreStashEntry,
    stashEntryToQueue,
  ]);

  return { stashQueue, restoreStashEntry, deleteStashEntry, stashCurrentPrompt };
}
