import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type MessageId } from "@t3tools/contracts";
import { composerDraftHasUserContent, useComposerDraftStore } from "../composerDraftStore";
import { readThreadShell } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { recoverFailedComposerSend } from "./ChatView.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

import type { SendSources } from "./ChatView.send";

export function createSendRecovery({
  readDraft,
  draftId,
  activeThread,
  isSendingComposerVisible,
  navigate,
  sendInFlightRef,
  setOptimisticUserMessages,
}: {
  readDraft: () => import("../composerDraftStore.types").ComposerThreadDraftState | null;
  draftId: SendSources["threadState"]["draftId"];
  activeThread: SendSources["threadState"]["activeThread"];
  isSendingComposerVisible: () => boolean;
  navigate: SendSources["threadState"]["navigate"];
  sendInFlightRef: SendSources["threadState"]["sendInFlightRef"];
  setOptimisticUserMessages: SendSources["threadState"]["setOptimisticUserMessages"];
}) {
  const hasNewerDraft = () => {
    const draft = readDraft();
    return Boolean(draft?.prompt.length) || composerDraftHasUserContent(draft);
  };

  const recoveryTargetExists = () => {
    if (draftId) return Boolean(useComposerDraftStore.getState().getDraftSession(draftId));
    return (
      activeThread != null &&
      Boolean(readThreadShell(scopeThreadRef(activeThread.environmentId, activeThread.id)))
    );
  };
  const openSendingComposer = async () => {
    if (isSendingComposerVisible()) return;
    if (draftId) {
      await navigate({ to: "/draft/$draftId", params: { draftId } });
    } else if (activeThread) {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, activeThread.id)),
      });
    }
  };

  const offerFailedSendRecovery = (restore: () => void, errorMessage?: string) => {
    let restored = false;
    let opening = false;
    const toastId = toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Message could not be sent",
        description: errorMessage ?? "Restore the message when the original composer is empty.",
        timeout: 0,
        actionProps: {
          children: "Restore message",
          onClick: async () => {
            if (opening) return;
            const blockedReason = !recoveryTargetExists()
              ? "The original thread or draft is no longer available."
              : !restored && sendInFlightRef.current
                ? "Wait for the current send in the original thread to finish."
                : !restored && hasNewerDraft()
                  ? "Send or clear the newer draft in the original thread before restoring."
                  : null;
            if (blockedReason) {
              toastManager.update(toastId, { description: blockedReason });
              return;
            }
            opening = true;
            try {
              if (!restored) {
                restore();
                restored = true;
              }
              await openSendingComposer();
              toastManager.close(toastId);
            } catch {
              toastManager.update(toastId, {
                description: restored
                  ? "The message was restored, but the original thread could not be opened."
                  : "The message could not be restored. Try again.",
              });
            } finally {
              opening = false;
            }
          },
        },
      }),
    );
  };

  const recoverFailedSend = <Draft extends object>(
    send: { messageId: MessageId; draft: Draft },
    restore: (draft: Draft) => void,
    errorMessage?: string,
  ) => {
    let recoveryOffered = false;
    recoverFailedComposerSend({
      ...send,
      updateMessages: setOptimisticUserMessages,
      canRestore: () => recoveryTargetExists() && !hasNewerDraft(),
      restore,
      offerRecovery: (restoreDraft) => {
        recoveryOffered = true;
        offerFailedSendRecovery(restoreDraft, errorMessage);
      },
    });
    return recoveryOffered;
  };

  return { hasNewerDraft, recoveryTargetExists, offerFailedSendRecovery, recoverFailedSend };
}
