import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { readThreadShell } from "../state/entities";
import { threadHandoffSeed } from "../state/threadHandoff";
import { useAtomCommand } from "../state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

function failureToast(error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Could not continue in a new thread",
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * "Continue in new thread": opens a draft in the same project, workspace and model selection as
 * `threadRef`, with the server's handoff seed in the composer. The seed is a draft the user edits
 * and sends; nothing is sent here.
 */
export function useContinueInNewThread() {
  const fetchSeed = useAtomCommand(threadHandoffSeed, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  return useCallback(
    async (threadRef: ScopedThreadRef) => {
      const thread = readThreadShell(threadRef);
      if (!thread) return;
      const seedResult = await fetchSeed({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (seedResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(seedResult))
          failureToast(squashAtomCommandFailure(seedResult));
        return;
      }
      let opened: Awaited<ReturnType<typeof handleNewThread>>;
      try {
        // The thread's own worktree and branch carry over: the files it changed live there.
        opened = await handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          envMode: thread.worktreePath ? "worktree" : "local",
          startFromOrigin: false,
        });
      } catch (error) {
        failureToast(error);
        return;
      }
      if (!opened) return;
      const { setModelSelection, setPrompt } = useComposerDraftStore.getState();
      setModelSelection(opened.draftId, thread.modelSelection, { replaceOptions: true });
      setPrompt(opened.draftId, seedResult.value.seed);
    },
    [fetchSeed, handleNewThread],
  );
}
