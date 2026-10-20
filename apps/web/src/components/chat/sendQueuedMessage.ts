import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationMessageContext,
  ProviderInteractionMode,
  ProviderInstanceId,
  RuntimeMode,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import { applyClaudePromptEffortPrefix } from "@t3tools/shared/model";

import {
  buildMessageContext,
  hasProjectMemoryRecords,
  promptWithoutProjectMemoryReferences,
  terminalContextReference,
} from "../../lib/composerContextRecords";
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerProjectMemoryReference,
  ComposerThreadTarget,
} from "../../composerDraftStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { removeInlineContextReference } from "../../lib/composerContextReferences";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { newMessageId } from "../../lib/utils";
import {
  latestCompletedToolActivityId,
  PROJECT_MEMORY_INLINE_UNSUPPORTED_MESSAGE,
  useQueuedMessageStore,
} from "../../queuedMessageStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThread, readThreadShell } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import {
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  readFileAsDataUrl,
  resolveThreadMetadataUpdateForNextTurn,
  revokeBlobPreviewUrl,
} from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./composerPromptHistory";

async function run<W, A, E>(command: AtomCommand<W, A, E>, input: W): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

export const PROJECT_MEMORY_SEND_DISABLED_MESSAGE = "이 서버는 기억 전송을 지원하지 않습니다.";
export const PROJECT_MEMORY_PROVIDER_UNAVAILABLE_MESSAGE =
  "선택한 공급자를 지금 사용할 수 없습니다.";
export const PROJECT_MEMORY_SERVER_UNRESOLVED_MESSAGE = "서버 상태를 확인할 수 없습니다.";

/**
 * The one send-boundary decision for memory references, shared by the direct,
 * multi-model and queued dispatches. Reads the CURRENT descriptor after every
 * intervening await: generic inline context alone never makes a memory send
 * supported — the server's `projectMemory.send`, its advertised drivers, and
 * the resolved instance that will run the turn must all hold right now.
 * Null means the references may ride the dispatch; a string is the concise
 * hold reason. Never called for messages without memory references, so
 * non-memory sends keep their existing paths byte for byte.
 */
export function readProjectMemorySendHold(input: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId | null | undefined;
}): string | null {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(input.environmentId);
  if (config === undefined) {
    return PROJECT_MEMORY_SERVER_UNRESOLVED_MESSAGE;
  }
  const capability = config.environment.capabilities.projectMemory;
  if (capability?.send !== true) {
    return PROJECT_MEMORY_SEND_DISABLED_MESSAGE;
  }
  if (config.environment.capabilities.inlineMessageContext !== true) {
    return PROJECT_MEMORY_INLINE_UNSUPPORTED_MESSAGE;
  }
  if (input.instanceId === null || input.instanceId === undefined) {
    return PROJECT_MEMORY_PROVIDER_UNAVAILABLE_MESSAGE;
  }
  const snapshot = config.providers.find((provider) => provider.instanceId === input.instanceId);
  if (
    !snapshot ||
    !snapshot.enabled ||
    !snapshot.installed ||
    snapshot.status !== "ready" ||
    snapshot.availability === "unavailable"
  ) {
    return PROJECT_MEMORY_PROVIDER_UNAVAILABLE_MESSAGE;
  }
  const advertised = capability.sendDriverKinds;
  if (!advertised?.includes(snapshot.driver)) {
    return PROJECT_MEMORY_SEND_DISABLED_MESSAGE;
  }
  return null;
}

/** Thrown when a direct composer send must hold after preparation, not dispatch. */
export class DirectMemoryDispatchHoldError extends Error {
  readonly holdReason: string;
  constructor(holdReason: string) {
    super(holdReason);
    this.holdReason = holdReason;
  }
}

/** Pre-clear guard for the foreground direct send path in ChatView. */
export function readEarlyComposerMemoryDispatchHold(input: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  projectMemoryReferenceCount: number;
}): string | null {
  if (input.projectMemoryReferenceCount === 0) {
    return null;
  }
  return readProjectMemorySendHold({
    environmentId: input.environmentId,
    instanceId: input.instanceId,
  });
}

/** Post-upload/persistence guard shared by direct and multi-target dispatches. */
export function readPostPreparationMemoryDispatchHold(input: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  dispatchContext: OrchestrationMessageContext | undefined;
}): string | null {
  if (input.dispatchContext === undefined || !hasProjectMemoryRecords(input.dispatchContext)) {
    return null;
  }
  return readProjectMemorySendHold({
    environmentId: input.environmentId,
    instanceId: input.instanceId,
  });
}

export type DirectThreadTurnWireAttachment = StartThreadTurnInput["message"]["attachments"][number];

export type DirectThreadTurnDispatchInput = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  instanceId: ProviderInstanceId;
  outgoingMessageText: string;
  dispatchContext: OrchestrationMessageContext | undefined;
  attachments: ReadonlyArray<DirectThreadTurnWireAttachment>;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  messageId: MessageId;
  createdAt: string;
  titleSeed: string;
  bootstrap?: StartThreadTurnInput["bootstrap"];
  /** Test hook: runs after ChatView's upload/persistence awaits, before the final hold. */
  awaitPreparationBarrier?: () => Promise<void>;
};

/**
 * The production direct-send dispatch boundary ChatView calls after preparation.
 * Re-checks memory support, then issues `startTurn` with inline context intact.
 */
export async function dispatchDirectThreadTurnMessage(
  input: DirectThreadTurnDispatchInput,
): Promise<void> {
  await input.awaitPreparationBarrier?.();
  const hold = readPostPreparationMemoryDispatchHold({
    environmentId: input.environmentId,
    instanceId: input.instanceId,
    dispatchContext: input.dispatchContext,
  });
  if (hold !== null) {
    throw new DirectMemoryDispatchHoldError(hold);
  }
  const inlineContext =
    appAtomRegistry.get(environmentServerConfigsAtom).get(input.environmentId)?.environment
      .capabilities.inlineMessageContext === true;
  const messageText =
    input.dispatchContext !== undefined && !inlineContext
      ? serializeLegacyContextMessage({
          text: input.outgoingMessageText,
          records: input.dispatchContext.records,
        })
      : input.outgoingMessageText;
  const message: StartThreadTurnInput["message"] = {
    messageId: input.messageId,
    role: "user",
    text: messageText,
    attachments: input.attachments,
    ...(input.dispatchContext !== undefined && inlineContext
      ? { context: input.dispatchContext }
      : {}),
  };
  const turnInput: StartThreadTurnInput = {
    threadId: input.threadId,
    message,
    modelSelection: input.modelSelection,
    titleSeed: input.titleSeed,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdAt: input.createdAt,
    ...(input.bootstrap !== undefined ? { bootstrap: input.bootstrap } : {}),
  };
  await run(threadEnvironment.startTurn, {
    environmentId: input.environmentId,
    input: turnInput,
  });
}

/** Restores the composer draft after a held or failed direct send (ChatView failure path). */
export function restoreComposerDraftAfterDirectSendFailure(input: {
  composerDraftTarget: ComposerThreadTarget;
  messageTextForSend: string;
  projectMemoryReferences: ReadonlyArray<ComposerProjectMemoryReference>;
  images: ReadonlyArray<ComposerImageAttachment>;
  files: ReadonlyArray<ComposerFileAttachment>;
  terminalContexts: ReadonlyArray<import("../../lib/terminalContext").TerminalContextDraft>;
  previewAnnotations: ReadonlyArray<import("@t3tools/contracts").PreviewAnnotationPayload>;
  reviewComments: ReadonlyArray<import("../../reviewCommentContext").ReviewCommentContext>;
  memoryRestoreMatchesProject: boolean;
}): void {
  const restoredPrompt = input.memoryRestoreMatchesProject
    ? input.messageTextForSend
    : promptWithoutProjectMemoryReferences(input.messageTextForSend, input.projectMemoryReferences);
  const store = useComposerDraftStore.getState();
  store.setPrompt(input.composerDraftTarget, restoredPrompt);
  if (input.images.length > 0) {
    store.addImages(input.composerDraftTarget, [...input.images]);
  }
  if (input.files.length > 0) {
    store.addFiles(input.composerDraftTarget, [...input.files]);
  }
  store.setTerminalContexts(input.composerDraftTarget, [...input.terminalContexts]);
  store.setPreviewAnnotations(input.composerDraftTarget, [...input.previewAnnotations]);
  store.setReviewComments(input.composerDraftTarget, [...input.reviewComments]);
  if (input.memoryRestoreMatchesProject) {
    store.setProjectMemoryReferences(input.composerDraftTarget, [...input.projectMemoryReferences]);
  }
}

/**
 * Sends one queued message as a turn on its thread. `QueuedMessageSender`
 * calls it when the head message is due, and Send now calls it directly. It
 * reads nothing from the composer, so it works for threads that are not on
 * screen. A failed send stays at the head of the queue, held for Send now.
 */
export async function sendQueuedMessage(
  threadRef: ScopedThreadRef,
  messageId: string,
): Promise<void> {
  const { environmentId, threadId } = threadRef;
  const threadKey = scopedThreadKey(threadRef);
  const queue = useQueuedMessageStore.getState();
  const message = queue.beginSend(
    threadKey,
    messageId,
    latestCompletedToolActivityId(readThread(threadRef)?.activities ?? []),
  );
  if (!message) return;
  const { sendSettings } = message;
  const attachments = [...message.images, ...message.files];
  const readConfig = () => appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  const assertFilesAllowed = () => {
    const config = readConfig();
    const reason = fileAttachmentCapabilityBlockReason({
      files: message.files,
      attachmentUploadsCapabilityKnown: config !== undefined,
      supportsAttachmentUploads: config?.environment.capabilities.attachmentUploads === true,
      maxFileAttachmentBytes:
        config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
    });
    if (reason !== null) throw new Error(reason);
  };
  try {
    const { sendableTerminalContexts, hasSendableContent } = deriveComposerSendState({
      prompt: message.prompt,
      imageCount: attachments.length,
      terminalContexts: message.terminalContexts,
      // Memory selections count like element contexts: a memory-only queued
      // message is still sendable content.
      elementContextCount:
        message.previewAnnotations.length +
        message.reviewComments.length +
        (message.projectMemoryReferences?.length ?? 0),
    });
    // Only expired terminal context was left. Retrying would block the queue
    // on every boundary, so drop it and let the queue move on.
    if (!hasSendableContent) {
      queue.finishSend(threadKey, message.id);
      return;
    }
    // Expired terminal excerpts are not sent; their chips leave the text with them.
    const prompt = message.terminalContexts
      .filter((context) => !sendableTerminalContexts.includes(context))
      .reduce(
        (text, context) =>
          removeInlineContextReference(text, terminalContextReference(context).contextId).prompt,
        message.prompt,
      )
      .trim();
    const text = applyClaudePromptEffortPrefix(
      prompt || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      sendSettings.promptEffort,
    );

    assertFilesAllowed();
    const useUploads = readConfig()?.environment.capabilities.attachmentUploads === true;
    if (useUploads && attachments.length > 0) {
      for (const attachment of attachments) {
        startAttachmentUpload({ environmentId, image: attachment, draftTarget: threadRef });
      }
      await awaitAttachmentUploads(attachments.map((attachment) => attachment.id));
    }
    const wireAttachments = await Promise.all(
      attachments.map(async (attachment) => {
        if (useUploads) {
          const uploaded = getUploadedAttachments({ environmentId, images: [attachment] })?.[0];
          if (!uploaded) throw new Error(`Attachment '${attachment.name}' did not upload.`);
          return uploaded;
        }
        if (attachment.type !== "image") {
          throw new Error("This server does not support file attachments.");
        }
        return {
          type: "image" as const,
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          dataUrl: await readFileAsDataUrl(attachment.file),
          ...(attachment.source ? { source: attachment.source } : {}),
        };
      }),
    );
    assertFilesAllowed();

    // The server starts the turn with the thread's stored modes, so a change
    // made in the composer before queueing is saved first.
    const createdAt = new Date().toISOString();
    const shell = readThreadShell(threadRef);
    const metadataUpdate = shell
      ? resolveThreadMetadataUpdateForNextTurn({
          currentModelSelection: shell.modelSelection,
          nextModelSelection: sendSettings.modelSelection,
          currentBranch: shell.branch,
        })
      : null;
    if (metadataUpdate) {
      await run(threadEnvironment.updateMetadata, {
        environmentId,
        input: { threadId, ...metadataUpdate },
      });
    }
    if (shell && shell.runtimeMode !== sendSettings.runtimeMode) {
      await run(threadEnvironment.setRuntimeMode, {
        environmentId,
        input: { threadId, runtimeMode: sendSettings.runtimeMode, createdAt },
      });
    }
    if (shell && shell.interactionMode !== sendSettings.interactionMode) {
      await run(threadEnvironment.setInteractionMode, {
        environmentId,
        input: { threadId, interactionMode: sendSettings.interactionMode, createdAt },
      });
    }

    // Stop hands a preparing message back to the composer. Past this point
    // the send can no longer be taken back.
    const thread = readThread(threadRef) ?? undefined;
    if (!queue.markDispatching(threadKey, message.id, createLocalDispatchSnapshot(thread))) return;
    const context = buildMessageContext({
      terminalContexts: sendableTerminalContexts,
      reviewComments: message.reviewComments,
      previewAnnotations: message.previewAnnotations,
      projectMemoryReferences: message.projectMemoryReferences ?? [],
      attachments: attachments.map((attachment, index) => ({
        attachment,
        attachmentId: wireAttachments[index]?.id ?? attachment.id,
      })),
    });
    if (context !== undefined && hasProjectMemoryRecords(context)) {
      // The upload and metadata awaits above can span a capability change: the
      // memory support decision reads the CURRENT descriptor here, using the
      // queued selection rather than whatever composer is open now. Throwing
      // lands in the catch below, which holds the message — exact ids and
      // versions intact — instead of flattening it into a legacy text send.
      const hold = readProjectMemorySendHold({
        environmentId,
        instanceId: sendSettings.modelSelection.instanceId,
      });
      if (hold !== null) {
        throw new Error(hold);
      }
    }
    // Servers from before inline context drop the records, so their turns
    // carry the payload in the text instead. Memory never reaches this branch:
    // the hold above refuses it first, so only non-memory context flattens.
    const inlineContext = readConfig()?.environment.capabilities.inlineMessageContext === true;
    await run(threadEnvironment.startTurn, {
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text:
            context !== undefined && !inlineContext
              ? serializeLegacyContextMessage({ text, records: context.records })
              : text,
          attachments: wireAttachments,
          ...(context !== undefined && inlineContext ? { context } : {}),
        },
        modelSelection: sendSettings.modelSelection,
        runtimeMode: sendSettings.runtimeMode,
        interactionMode: sendSettings.interactionMode,
        createdAt,
      },
    });
    queue.finishSend(threadKey, message.id);
    if (useUploads) releaseDraftAttachments(attachments);
    for (const image of message.images) revokeBlobPreviewUrl(image.previewUrl);
  } catch (error) {
    if (!queue.failSend(threadKey, message.id)) return;
    const title = readThreadShell(threadRef)?.title;
    toastManager.add({
      type: "error",
      title: title ? `Queued message not sent in "${title}"` : "Queued message not sent",
      description: error instanceof Error ? error.message : "Use Send now to try again.",
    });
  }
}
