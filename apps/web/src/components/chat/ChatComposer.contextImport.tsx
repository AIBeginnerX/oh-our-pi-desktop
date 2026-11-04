import { elementContextToPreviewAnnotation } from "../../lib/elementContext";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { releaseAttachmentUpload, releaseDraftAttachment } from "../../lib/attachmentUploadQueue";
import { type TerminalContextDraft } from "../../lib/terminalContext";
import { uploadedContextRecordFromDraft } from "../composerContextPresentation";
import { toKindScopedComposerContextId } from "~/lib/composerContextReferences";
import {
  asKnownContextRecord,
  composerContextImportLookupIds,
  isSameComposerContextPayload,
  uploadedAttachmentContextRecord,
  previewAnnotationContextId,
  previewAnnotationContextRecord,
  previewAnnotationFromRecord,
  reviewCommentContextId,
  reviewCommentContextRecord,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
  terminalContextReference,
  terminalContextRecord,
} from "~/lib/composerContextRecords";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import type { ComposerContextClipboardFragment, ComposerContextRecord } from "@t3tools/contracts";
import { resolveAssetUrl } from "~/assets/assetUrls";
import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { randomUUID } from "~/lib/utils";
import { pendingDraftWork } from "./pendingDraftWork";
import { toastManager } from "../ui/toast";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import { ThreadId, PreviewAnnotationPayload } from "@t3tools/contracts";
import { ComposerThreadTarget, DraftId } from "../../composerDraftStore";
import { RefObject } from "react";
import { ComposerDraftContextRecords } from "../composerContextPresentation";
import { AttachmentUploadState } from "../../lib/attachmentUploadState";

export function useComposerContextImport(args: {
  activePendingIsResponding: boolean;
  activeThread: EnvironmentThread | undefined;
  activeThreadId: ThreadId | null;
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
  attachmentDraftTarget:
    | { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
    | DraftId;
  attachmentTargetKey: string;
  attachmentTargetKeyRef: RefObject<string>;
  composerContextRecords: ComposerDraftContextRecords;
  composerDraftTarget:
    | { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
    | DraftId;
  composerFiles: ComposerFileAttachment[];
  composerFilesRef: RefObject<ComposerFileAttachment[]>;
  composerImages: ComposerImageAttachment[];
  composerPreviewAnnotations: PreviewAnnotationPayload[];
  composerReviewComments: ReviewCommentContext[];
  composerTerminalContexts: TerminalContextDraft[];
  environmentId: EnvironmentId;
  questionAttachmentTarget: DraftId | null;
  removeComposerDraftFile: (threadRef: ComposerThreadTarget, fileId: string) => void;
  removeComposerDraftImage: (threadRef: ComposerThreadTarget, imageId: string) => void;
  setComposerDraftPrompt: (threadRef: ComposerThreadTarget, prompt: string) => void;
  uploadsByImageId: Readonly<Record<string, AttachmentUploadState>>;
}) {
  const {
    activePendingIsResponding,
    activeThread,
    activeThreadId,
    addComposerDraftFiles,
    addComposerDraftImages,
    attachmentDraftTarget,
    attachmentTargetKey,
    attachmentTargetKeyRef,
    composerContextRecords,
    composerDraftTarget,
    composerFiles,
    composerFilesRef,
    composerImages,
    composerPreviewAnnotations,
    composerReviewComments,
    composerTerminalContexts,
    environmentId,
    questionAttachmentTarget,
    removeComposerDraftFile,
    removeComposerDraftImage,
    setComposerDraftPrompt,
    uploadsByImageId,
  } = args;

  // ------------------------------------------------------------------
  // Prompt helpers
  // ------------------------------------------------------------------
  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    },
    [composerDraftTarget, setComposerDraftPrompt],
  );

  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => addComposerDraftImages(attachmentDraftTarget, [image]),
    [attachmentDraftTarget, addComposerDraftImages],
  );

  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => addComposerDraftImages(attachmentDraftTarget, images),
    [attachmentDraftTarget, addComposerDraftImages],
  );

  const addComposerFilesToDraft = useCallback(
    (files: ComposerFileAttachment[]) =>
      addComposerDraftFiles(attachmentDraftTarget, files, {
        appendReference: questionAttachmentTarget === null,
      }),
    [addComposerDraftFiles, attachmentDraftTarget, questionAttachmentTarget],
  );

  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      if (questionAttachmentTarget && activePendingIsResponding) return;
      releaseAttachmentUpload(imageId);
      removeComposerDraftImage(attachmentDraftTarget, imageId);
    },
    [
      attachmentDraftTarget,
      questionAttachmentTarget,
      activePendingIsResponding,
      removeComposerDraftImage,
    ],
  );

  const removeComposerFileFromDraft = useCallback(
    (fileId: string) => {
      if (questionAttachmentTarget && activePendingIsResponding) return;
      // Release by the draft attachment, not the bare queue key: a hydrated
      // file's upload lives server-side under its persisted attachment id.
      const file = composerFilesRef.current.find((candidate) => candidate.id === fileId);
      if (file) {
        releaseDraftAttachment(file);
      } else {
        releaseAttachmentUpload(fileId);
      }
      removeComposerDraftFile(attachmentDraftTarget, fileId);
    },
    [
      attachmentDraftTarget,
      questionAttachmentTarget,
      activePendingIsResponding,
      composerFilesRef,
      removeComposerDraftFile,
    ],
  );

  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const addComposerDraftReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const addComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.addPreviewAnnotation,
  );
  const buildContextClipboardFragment = useCallback(
    (contextIds: ReadonlyArray<string>): string | null => {
      const wanted = new Set(contextIds);
      // An annotation's screenshot is referenced by the annotation record, not by the copied
      // text. Pull it in so the round-trip keeps the image the annotation points at.
      for (const annotation of composerPreviewAnnotations) {
        if (
          wanted.has(previewAnnotationContextId(annotation.id)) &&
          composerImages.some((image) => image.id === annotation.id)
        ) {
          wanted.add(toKindScopedComposerContextId("image", annotation.id));
        }
      }
      const records: ComposerContextRecord[] = [
        ...composerTerminalContexts
          .filter((c) => wanted.has(terminalContextReference(c).contextId))
          .map(terminalContextRecord),
        ...composerReviewComments
          .filter((c) => wanted.has(reviewCommentContextId(c.id)))
          .map(reviewCommentContextRecord),
        ...composerPreviewAnnotations
          .filter((a) => wanted.has(previewAnnotationContextId(a.id)))
          .map((annotation) =>
            previewAnnotationContextRecord(annotation, {
              screenshotContextId: composerImages.some((image) => image.id === annotation.id)
                ? annotation.id
                : undefined,
            }),
          ),
        ...[...composerImages, ...composerFiles]
          .filter((attachment) =>
            wanted.has(toKindScopedComposerContextId(attachment.type, attachment.id)),
          )
          .flatMap((attachment) => {
            const record = uploadedAttachmentContextRecord(
              attachment,
              uploadsByImageId[attachment.id],
            );
            return record ? [record] : [];
          }),
      ];
      if (records.length === 0) return null;
      return encodeComposerContextFragment({
        version: 1,
        source: { environmentId, ...(activeThread ? { threadId: activeThread.id } : {}) },
        records,
      });
    },
    [
      activeThread,
      composerFiles,
      composerImages,
      composerPreviewAnnotations,
      composerReviewComments,
      composerTerminalContexts,
      environmentId,
      uploadsByImageId,
    ],
  );
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  /**
   * Bytes for a pasted image or file come back through the source environment's asset URL
   * (the client is the only party that can reach both) and re-enter this draft as a normal
   * attachment under a fresh id. The pasted chip is rewritten to that id and reads as
   * unresolved until the bytes land; a failed transfer says so and leaves the chip to remove.
   */
  const runAttachmentImport = useCallback(
    async (
      record: Extract<ComposerContextRecord, { kind: "image" | "file" }>,
      localId: string,
      sourceEnvironmentId: EnvironmentId,
      importTargetKey: string,
    ) => {
      const fail = (reason: string) => {
        toastManager.add({
          type: "error",
          title: `Couldn't bring ${record.name} into this message`,
          description: `${reason} Remove the chip or attach the file again.`,
        });
      };
      const sourceConnection = readPreparedConnection(sourceEnvironmentId);
      if (!sourceConnection) {
        fail("The environment it came from is not connected.");
        return;
      }
      const result = await createAssetUrl({
        environmentId: sourceEnvironmentId,
        input: { resource: { _tag: "attachment", attachmentId: record.attachmentId } },
      });
      const url =
        result._tag === "Success"
          ? resolveAssetUrl(sourceConnection.httpBaseUrl, result.value.relativeUrl)
          : null;
      if (!url) {
        fail("The original attachment is no longer available.");
        return;
      }
      let blob: Blob;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        blob = await response.blob();
      } catch {
        fail("Downloading it from the source failed.");
        return;
      }
      const file = new File([blob], record.name, { type: record.mimeType || blob.type });
      // The draft these bytes belong to may have been sent or switched away from while they
      // downloaded. Dropping them here keeps them out of whatever draft is open now.
      if (attachmentTargetKeyRef.current !== importTargetKey) return;
      if (record.kind === "image") {
        const accepted = addComposerImage({
          type: "image",
          id: localId,
          name: record.name,
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl: URL.createObjectURL(file),
          file,
        });
        if (!accepted.includes(localId))
          fail("The draft rejected this attachment (duplicate or attachment limit reached).");
      } else {
        const accepted = addComposerFilesToDraft([
          {
            type: "file",
            id: localId,
            name: record.name,
            mimeType: file.type,
            sizeBytes: file.size,
            file,
          },
        ]);
        if (!accepted.includes(localId))
          fail("The draft rejected this attachment (duplicate or attachment limit reached).");
      }
    },
    [addComposerFilesToDraft, addComposerImage, attachmentTargetKey, createAssetUrl],
  );
  const importAttachmentRecord = useCallback(
    async (
      record: Extract<ComposerContextRecord, { kind: "image" | "file" }>,
      localId: string,
      sourceEnvironmentId: EnvironmentId,
    ) => {
      // The chip lands in the draft immediately while these bytes are still downloading. Count
      // the transfer against its own draft so a send cannot snapshot a message whose chip has no
      // attachment behind it, and so bytes for an abandoned draft never enter the next one.
      const importTargetKey = attachmentTargetKey;
      pendingDraftWork.begin(importTargetKey);
      try {
        await runAttachmentImport(record, localId, sourceEnvironmentId, importTargetKey);
      } finally {
        pendingDraftWork.end(importTargetKey);
      }
    },
    [attachmentTargetKey, runAttachmentImport],
  );
  /**
   * Brings records into this draft (paste, stash restore). Binaries are transferred only
   * when `sourceEnvironmentId` is given; the stash restores its own images and files.
   */
  const importContextRecords = useCallback(
    (
      records: ReadonlyArray<ComposerContextRecord>,
      sourceEnvironmentId: EnvironmentId | null,
    ): ReadonlyMap<string, string> => {
      const rewritten = new Map<string, string>();
      const dependentAttachmentLocalIds = new Map<string, string>();
      const skippedDependentAttachmentIds = new Set<string>();
      // Resolve annotations before their dependent screenshot records even if a foreign
      // clipboard producer emitted the records in a different order.
      const orderedRecords = records.toSorted((left, right) =>
        left.kind === "preview-annotation" && right.kind !== "preview-annotation"
          ? -1
          : right.kind === "preview-annotation" && left.kind !== "preview-annotation"
            ? 1
            : 0,
      );
      for (const candidate of orderedRecords) {
        // Producer ids fold into context ids, so two different excerpts can collide. Only skip
        // when the draft already holds the same payload; a colliding but different record is
        // re-minted under a fresh id so both survive the paste.
        const record = asKnownContextRecord(candidate);
        if (!record) continue;
        const existing = composerContextImportLookupIds(record).flatMap((contextId) => {
          const found = composerContextRecords.get(contextId);
          return found ? [found] : [];
        })[0];
        const existingRecord =
          existing?.kind === "terminal"
            ? terminalContextRecord(existing.record)
            : existing?.kind === "review-comment"
              ? reviewCommentContextRecord(existing.record)
              : existing?.kind === "preview-annotation"
                ? previewAnnotationContextRecord(existing.record)
                : existing
                  ? (uploadedContextRecordFromDraft(existing) ?? undefined)
                  : undefined;
        if (existingRecord && isSameComposerContextPayload(existingRecord, record)) {
          if (record.kind === "preview-annotation" && record.screenshotContextId) {
            skippedDependentAttachmentIds.add(record.screenshotContextId);
          }
          continue;
        }
        const conflicts = existing !== undefined;
        switch (record.kind) {
          case "terminal": {
            const threadId = activeThread?.id ?? activeThreadId;
            if (!threadId) break;
            const imported = terminalContextDraftFromRecord(record, threadId);
            const draft = conflicts ? { ...imported, id: randomUUID() } : imported;
            addComposerDraftTerminalContexts(composerDraftTarget, [draft], {
              appendReference: false,
            });
            rewritten.set(record.contextId, terminalContextReference(draft).contextId);
            break;
          }
          case "review-comment": {
            const imported = reviewCommentFromRecord(record);
            const comment = conflicts ? { ...imported, id: randomUUID() } : imported;
            addComposerDraftReviewComment(composerDraftTarget, comment, {
              appendReference: false,
            });
            rewritten.set(record.contextId, reviewCommentContextId(comment.id));
            break;
          }
          case "element":
          case "preview-annotation": {
            const imported =
              record.kind === "element"
                ? elementContextToPreviewAnnotation(record, randomUUID(), new Date().toISOString())
                : previewAnnotationFromRecord(record);
            const annotation = conflicts ? { ...imported, id: randomUUID() } : imported;
            if (record.kind === "preview-annotation" && record.screenshotContextId) {
              dependentAttachmentLocalIds.set(record.screenshotContextId, annotation.id);
            }
            addComposerDraftPreviewAnnotation(composerDraftTarget, annotation, {
              appendReference: false,
            });
            rewritten.set(record.contextId, previewAnnotationContextId(annotation.id));
            break;
          }
          case "image":
          case "file": {
            if (skippedDependentAttachmentIds.has(record.contextId)) break;
            if (sourceEnvironmentId === null && !conflicts) {
              rewritten.set(record.contextId, record.contextId);
              break;
            }
            if (sourceEnvironmentId === null) break;
            const localId = dependentAttachmentLocalIds.get(record.contextId) ?? randomUUID();
            rewritten.set(record.contextId, toKindScopedComposerContextId(record.kind, localId));
            void importAttachmentRecord(record, localId, sourceEnvironmentId);
            break;
          }
          default:
            break;
        }
      }
      return rewritten;
    },
    [
      activeThread,
      activeThreadId,
      addComposerDraftPreviewAnnotation,
      addComposerDraftReviewComment,
      addComposerDraftTerminalContexts,
      composerContextRecords,
      composerDraftTarget,
      importAttachmentRecord,
    ],
  );
  const importContextFragment = useCallback(
    (fragment: ComposerContextClipboardFragment): ReadonlyMap<string, string> =>
      importContextRecords(fragment.records, fragment.source.environmentId),
    [importContextRecords],
  );

  return {
    setPrompt,
    addComposerImage,
    addComposerImagesToDraft,
    addComposerFilesToDraft,
    removeComposerImageFromDraft,
    removeComposerFileFromDraft,
    addComposerDraftReviewComment,
    addComposerDraftPreviewAnnotation,
    buildContextClipboardFragment,
    importContextRecords,
    importContextFragment,
  };
}
