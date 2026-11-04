import { type MessageId, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { readPastedComposerContext } from "./composerInlineTokenPaste";
import { isPasteAsTextShortcut } from "@t3tools/client-runtime/text-paste";
import { resolvePromptInjectedEffort } from "@t3tools/shared/model";
import { useCallback, useEffect, useRef, useState } from "react";
import { isMacPlatform } from "../lib/utils";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { collapseExpandedComposerCursor } from "../composer-logic";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { resolveShortcutCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { randomUUID } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { projectScriptIdFromCommand } from "~/projectScripts";
import { newMessageId } from "~/lib/utils";
import { getProviderModelCapabilities } from "../providerModels";
import { isTerminalCloseConfirmPending } from "../lib/terminalCloseConfirm";
import { isPreviewFocused } from "../lib/previewFocus";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import {
  preventRepeatedTerminalCloseShortcut,
  preventTerminalCloseShortcut,
} from "../lib/terminalCloseShortcut";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  enqueueHeldQueuedMemoryConflicts,
  latestCompletedToolActivityId,
  partitionQueuedRestoreByMemoryConflict,
  type QueuedComposerMessage,
  type QueuedMessageSendSettings,
  useQueuedMessages,
  useQueuedMessageStore,
} from "../queuedMessageStore";
import { type ChatComposerHandle } from "./chat/ChatComposer";
import { prepareRevertedMessageAttachments, waitForRevertedMessage } from "./ChatView.logic";
import { readPreparedConnection } from "../state/session";
import { recallableComposerPrompt } from "./chat/composerPromptHistory";
import {
  shouldRedirectInputToComposer,
  shouldTypeToFocusComposer,
  pasteTextToFocusComposer,
} from "./ChatView.helpers";
import type { useChatViewThreadState } from "./ChatView.threadState";
import type { useChatViewProjectAndEnvironment } from "./ChatView.projectEnvironment";
import type { useChatViewTimelineData } from "./ChatView.timelineData";
import type { useChatViewTerminalsAndScripts } from "./ChatView.terminalsAndScripts";
import type { useChatViewRightPanel } from "./ChatView.rightPanel";
import type { useChatViewTimelineScroll } from "./ChatView.timelineScroll";
import type { useChatViewThreadStatus } from "./ChatView.threadStatus";

export function useChatViewShortcutsAndRevert({
  threadState,
  projectEnvironment,
  timelineData,
  terminalsAndScripts,
  rightPanel,
  timelineScroll,
  threadStatus,
}: {
  threadState: ReturnType<typeof useChatViewThreadState>;
  projectEnvironment: ReturnType<typeof useChatViewProjectAndEnvironment>;
  timelineData: ReturnType<typeof useChatViewTimelineData>;
  terminalsAndScripts: ReturnType<typeof useChatViewTerminalsAndScripts>;
  rightPanel: ReturnType<typeof useChatViewRightPanel>;
  timelineScroll: ReturnType<typeof useChatViewTimelineScroll>;
  threadStatus: ReturnType<typeof useChatViewThreadStatus>;
}) {
  const {
    terminalUiState,
    previewPanelOpen,
    composerRef,
    activeThreadId,
    isServerThread,
    activeThreadRef,
    settleThread,
    confirmAndUnpinThread,
    pinThread,
    activeRightPanelSurface,
    branchToolbarRef,
    activeThreadKey,
    pasteAsTextShortcutUntilRef,
    routeThreadKey,
    activeThread,
    isRevertingCheckpoint,
    isConnecting,
    environmentId,
    createAttachmentAssetUrl,
    composerDraftTarget,
    routeThreadRef,
    revertThreadCheckpoint,
    currentRouteThreadKeyRef,
    promptRef,
    sendInFlightRef,
    setOptimisticUserMessages,
    runtimeMode,
    startThreadTurn,
    t,
    setComposerDraftPrompt,
    composerImagesRef,
    composerFilesRef,
    addComposerDraftImages,
    addComposerDraftFiles,
    composerTerminalContextsRef,
    setComposerDraftTerminalContexts,
    setComposerDraftPreviewAnnotations,
    setComposerDraftReviewComments,
    setComposerDraftProjectMemoryReferences,
  } = threadState;
  const {
    activeProject,
    activeProjectScripts,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    clientSettingsHydrated,
  } = projectEnvironment;
  const {
    supportsConversationRollback,
    phase,
    isSendBusy,
    beginLocalDispatch,
    resetLocalDispatch,
    clearUsageLimitsFor,
    threadActivities,
  } = timelineData;
  const {
    keybindings,
    toggleTerminalVisibility,
    setTerminalOpen,
    splitTerminal,
    createNewTerminal,
    onToggleDiff,
    canInterruptRunningThread,
    requestInterrupt,
    runProjectScript,
    setThreadError,
  } = terminalsAndScripts;
  const {
    toggleRightPanel,
    toggleRightPanelMaximized,
    closeRightPanelSurface,
    splitPanelTerminal,
    requestClosePanelTerminal,
    requestCloseTerminal,
    addTerminalSurface,
    persistThreadSettingsForNextTurn,
  } = rightPanel;
  const { scrollToEnd } = timelineScroll;
  const {
    copyActiveThreadReference,
    supportsSettlement,
    activeThreadSettled,
    handleUnsettleActiveThread,
    supportsPinning,
    activeThreadPinned,
    compactDisabled,
    localCheckoutBranchMismatch,
  } = threadStatus;

  const getShortcutContext = useCallback(
    (eventTarget: EventTarget | null = document.activeElement) => ({
      terminalFocus: getTerminalFocusOwner() !== null,
      terminalOpen: Boolean(terminalUiState.terminalOpen),
      previewFocus: isPreviewFocused(),
      previewOpen: previewPanelOpen,
      editableFocus: isEditableFocused(eventTarget),
      modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
      isWeb: !isElectron,
      isDesktop: isElectron,
    }),
    [composerRef, previewPanelOpen, terminalUiState.terminalOpen],
  );

  // The row handlers are read from refs at call-time so their identity stays
  // stable and does not bust TimelineRowCtx on every ChatView render.
  const queuedMessageActionsRef = useRef({
    steer: (_id: string) => {},
    remove: (_id: string) => {},
  });
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (preventRepeatedTerminalCloseShortcut(event, keybindings)) {
        event.stopPropagation();
        return;
      }
      // While a close confirmation is open, terminal focus has moved to the
      // dialog, so a deliberate second close shortcut would otherwise fall
      // through to the native window/tab close accelerator.
      if (isTerminalCloseConfirmPending() && preventTerminalCloseShortcut(event, keybindings)) {
        event.stopPropagation();
        return;
      }
      if (!activeThreadId || isCommandPaletteOpen()) {
        return;
      }
      const terminalFocusOwner = getTerminalFocusOwner();
      if (event.defaultPrevented && terminalFocusOwner === null) {
        return;
      }
      const shortcutContext = getShortcutContext(event.target);

      if (
        !shortcutContext.terminalFocus &&
        !shortcutContext.modelPickerOpen &&
        shouldTypeToFocusComposer(event)
      ) {
        if (composerRef.current?.insertTextAtEnd(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "thread.copyReference") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) copyActiveThreadReference();
        return;
      }

      if (command === "thread.settle") {
        event.preventDefault();
        event.stopPropagation();
        if (!isServerThread || !activeThreadRef || !supportsSettlement) return;
        if (activeThreadSettled) {
          void handleUnsettleActiveThread();
          return;
        }

        void settleThread(activeThreadRef).then((result) => {
          if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        });
        return;
      }

      if (command === "thread.pin") {
        event.preventDefault();
        event.stopPropagation();
        if (!isServerThread || !activeThreadRef || !supportsPinning) return;
        const pinned = activeThreadPinned;
        void (pinned ? confirmAndUnpinThread(activeThreadRef) : pinThread(activeThreadRef)).then(
          (result) => {
            if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: pinned ? "Failed to unpin thread" : "Failed to pin thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          },
        );
        return;
      }

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "rightPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleRightPanel();
        return;
      }

      if (command === "rightPanel.toggleMaximized") {
        event.preventDefault();
        event.stopPropagation();
        toggleRightPanelMaximized();
        return;
      }

      if (command === "rightPanel.close") {
        // Nothing open: leave the event alone so the shortcut keeps its
        // native meaning (close window on desktop, close tab in a browser).
        if (!activeRightPanelSurface) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) closeRightPanelSurface(activeRightPanelSurface);
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          splitPanelTerminal();
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.splitVertical") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          splitPanelTerminal("vertical");
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal("vertical");
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel" && activeRightPanelSurface?.kind === "terminal") {
          requestClosePanelTerminal(activeRightPanelSurface.activeTerminalId);
          return;
        }
        if (!terminalUiState.terminalOpen) return;
        requestCloseTerminal(terminalUiState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          addTerminalSurface();
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) composerRef.current?.toggleModelPicker();
        return;
      }

      if (
        command === "composer.host" ||
        command === "composer.effort" ||
        command === "composer.mode" ||
        command === "composer.workspace"
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) composerRef.current?.openControl(command);
        return;
      }

      if (command === "composer.branch") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) branchToolbarRef.current?.openBranchPicker();
        return;
      }

      if (command === "composer.previousWorktree") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) branchToolbarRef.current?.usePreviousWorktree();
        return;
      }

      if (command === "thread.steerQueuedMessage") {
        const message = activeThreadKey
          ? useQueuedMessageStore.getState().queuesByThreadKey[activeThreadKey]?.[0]
          : undefined;
        if (!message) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) queuedMessageActionsRef.current.steer(message.id);
        return;
      }

      if (command === "thread.stop") {
        // An unavailable command should not shadow contextual shortcuts such as Escape to close a dialog.
        if (!canInterruptRunningThread) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        requestInterrupt();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProjectScripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activeProject,
    activeRightPanelSurface,
    activeProjectScripts,
    addTerminalSurface,
    activeThreadRef,
    activeThreadPinned,
    activeThreadSettled,
    canInterruptRunningThread,
    activeThreadKey,
    terminalUiState.terminalOpen,
    terminalUiState.activeTerminalId,
    activeThreadId,
    closeRightPanelSurface,
    requestCloseTerminal,
    requestClosePanelTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    splitPanelTerminal,
    keybindings,
    handleUnsettleActiveThread,
    isServerThread,
    requestInterrupt,
    onToggleDiff,
    pinThread,
    settleThread,
    supportsPinning,
    supportsSettlement,
    confirmAndUnpinThread,
    copyActiveThreadReference,
    getShortcutContext,
    toggleRightPanel,
    toggleRightPanelMaximized,
    toggleTerminalVisibility,
    composerRef,
  ]);

  // Paste-to-focus: the resting composer blurs on a click into the timeline,
  // so a paste that follows has no editable target and would be dropped.
  // Route it to the composer like a typed key, which also expands it.
  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if (
        shouldRedirectInputToComposer(event) &&
        isPasteAsTextShortcut(event, isMacPlatform(navigator.platform))
      ) {
        pasteAsTextShortcutUntilRef.current = Date.now() + 1_000;
      }
    };
    const handler = (event: ClipboardEvent) => {
      if (!activeThreadId || isCommandPaletteOpen()) return;
      if (getTerminalFocusOwner() !== null) return;
      if (composerRef.current?.isModelPickerOpen()) return;
      const text = pasteTextToFocusComposer(event);
      const clipboardData = event.clipboardData;
      if (text === null || clipboardData === null) return;
      const bypassAutoAttachment = Date.now() <= pasteAsTextShortcutUntilRef.current;
      pasteAsTextShortcutUntilRef.current = 0;
      if (
        ((readPastedComposerContext(clipboardData)?.records.length ?? 0) === 0 &&
          composerRef.current?.pasteTextAtEnd(text, { bypassAutoAttachment })) ||
        composerRef.current?.insertTextAtEnd(text, { clipboardData })
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", keyHandler, true);
    window.addEventListener("paste", handler, true);
    return () => {
      window.removeEventListener("keydown", keyHandler, true);
      window.removeEventListener("paste", handler, true);
    };
  }, [activeThreadId, composerRef]);

  const [pendingRevert, setPendingRevert] = useState<{
    turnCount: number;
    messageId: MessageId;
    routeThreadKey: string;
  } | null>(null);

  if (pendingRevert && pendingRevert.routeThreadKey !== routeThreadKey) {
    setPendingRevert(null);
  }

  const onRevertToTurnCount = useCallback(
    async (turnCount: number, messageId: MessageId, restoreFiles?: boolean) => {
      const localApi = readLocalApi();
      if (!localApi || !activeThread || isRevertingCheckpoint) return;
      const message = activeThread.messages.find((message) => message.id === messageId);
      if (!message || message.role !== "user") return;

      if (!supportsConversationRollback) {
        setThreadError(
          activeThread.id,
          "This provider does not support reverting conversation history. Start a new thread instead.",
        );
        return;
      }
      if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
        setThreadError(
          activeThread.id,
          `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
        );
        return;
      }
      if (phase === "running" || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      if (restoreFiles === undefined) {
        setPendingRevert({ turnCount, messageId, routeThreadKey });
        return;
      }

      useComposerDraftStore.setState((store) => ({
        rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
      }));
      setThreadError(activeThread.id, null);
      try {
        if (composerRef.current?.hasPendingAttachments()) {
          throw new Error("Wait for attachments to finish preparing before rewinding.");
        }
        const connection = readPreparedConnection(environmentId);
        if (!connection) throw new Error("The environment is not connected.");
        const files = await prepareRevertedMessageAttachments({
          message,
          environmentId,
          httpBaseUrl: connection.httpBaseUrl,
          createAssetUrl: createAttachmentAssetUrl,
        });
        const store = useComposerDraftStore.getState();
        const draft = store.getComposerDraft(composerDraftTarget);
        if (
          (draft?.images.length ?? 0) + (draft?.files.length ?? 0) + files.length >
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS
        ) {
          throw new Error(
            "Make room for this message's attachments in the composer before rewinding.",
          );
        }
        await waitForRevertedMessage(routeThreadRef, messageId, turnCount, async () => {
          const result = await revertThreadCheckpoint({
            environmentId,
            input: { threadId: activeThread.id, turnCount, restoreFiles },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        });
        const currentPrompt = store.getComposerDraft(composerDraftTarget)?.prompt ?? "";
        const restoredPrompt = recallableComposerPrompt(message.text);
        const nextPrompt =
          restoredPrompt.length === 0
            ? currentPrompt
            : currentPrompt.length > 0
              ? `${currentPrompt}\n\n${restoredPrompt}`
              : restoredPrompt;
        store.setPrompt(composerDraftTarget, nextPrompt);
        const images: ComposerImageAttachment[] = [];
        const restoredFiles: ComposerFileAttachment[] = [];
        files.forEach((file, index) => {
          const attachment = {
            id: randomUUID(),
            name: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            file,
          };
          if (message.attachments?.[index]?.type === "image") {
            images.push({ ...attachment, type: "image", previewUrl: URL.createObjectURL(file) });
          } else {
            restoredFiles.push({ ...attachment, type: "file" });
          }
        });
        store.addImages(composerDraftTarget, images, { allowDuplicates: true });
        store.addFiles(composerDraftTarget, restoredFiles, { allowDuplicates: true });
        if (currentRouteThreadKeyRef.current === routeThreadKey) {
          promptRef.current = nextPrompt;
          composerRef.current?.resetCursorState({ prompt: nextPrompt, cursor: nextPrompt.length });
          requestAnimationFrame(() => {
            if (currentRouteThreadKeyRef.current === routeThreadKey)
              composerRef.current?.focusAtEnd();
          });
        }
      } catch (error) {
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to revert thread state.",
        );
      } finally {
        useComposerDraftStore.setState((store) => {
          const remaining = new Set(store.rewindingThreadKeys);
          remaining.delete(routeThreadKey);
          return { rewindingThreadKeys: remaining };
        });
      }
    },
    [
      activeThread,
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      composerDraftTarget,
      composerRef,
      createAttachmentAssetUrl,
      environmentId,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      phase,
      revertThreadCheckpoint,
      routeThreadKey,
      routeThreadRef,
      setThreadError,
      supportsConversationRollback,
    ],
  );

  const onCompactContext = async () => {
    if (compactDisabled || !activeThread || !clientSettingsHydrated || sendInFlightRef.current) {
      return;
    }
    const context = composerRef.current?.getSendContext();
    if (!context?.providerAvailable) return;

    // Compaction is a standalone command; the draft and its attachments stay local.
    const threadId = activeThread.id;
    const messageId = newMessageId();
    const createdAt = new Date().toISOString();
    sendInFlightRef.current = true;
    beginLocalDispatch();
    setThreadError(threadId, null);
    setOptimisticUserMessages((messages) => [
      ...messages,
      {
        id: messageId,
        role: "user",
        text: "/compact",
        turnId: null,
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      },
    ]);
    scrollToEnd();
    try {
      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId,
        createdAt,
        modelSelection: context.selectedModelSelection,
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode: context.interactionMode,
      });
      const result =
        settingsResult._tag === "Failure"
          ? settingsResult
          : await startThreadTurn({
              environmentId,
              input: {
                threadId,
                message: { messageId, role: "user", text: "/compact", attachments: [] },
                modelSelection: context.selectedModelSelection,
                runtimeMode,
                interactionMode: context.interactionMode,
                createdAt,
              },
            });
      if (result._tag === "Failure") {
        setOptimisticUserMessages((messages) =>
          messages.filter((message) => message.id !== messageId),
        );
        resetLocalDispatch();
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setThreadError(
            threadId,
            error instanceof Error ? error.message : "Failed to compact context.",
          );
        }
      } else {
        clearUsageLimitsFor(routeThreadKey);
      }
    } finally {
      sendInFlightRef.current = false;
    }
  };

  const queuedMessages = useQueuedMessages(activeThreadKey ?? "");
  // The composer's model and modes, as a queued message keeps them for its send.
  const readComposerSendSettings = (
    sendCtx: ReturnType<ChatComposerHandle["getSendContext"]>,
  ): QueuedMessageSendSettings => ({
    modelSelection: sendCtx.selectedModelSelection,
    runtimeMode,
    interactionMode: sendCtx.interactionMode,
    promptEffort: resolvePromptInjectedEffort(
      getProviderModelCapabilities(
        sendCtx.selectedProviderModels,
        sendCtx.selectedModel,
        sendCtx.selectedProvider,
      ),
      sendCtx.selectedPromptEffort,
    ),
  });
  // Puts queued messages back into the composer after Stop or Cancel. Prompts
  // join with blank lines; attachments and contexts are added. A message whose
  // memory selections disagree with the draft's (or another restored message's)
  // on a selected version is not merged: it returns to the queue, held intact,
  // so restoring never silently rewrites a chosen version.
  const restoreQueuedMessagesToComposer = (messages: ReadonlyArray<QueuedComposerMessage>) => {
    const draftBeforeRestore = useComposerDraftStore
      .getState()
      .getComposerDraft(composerDraftTarget);
    const { compatible: compatibleMessages, conflicts: heldConflicts } =
      partitionQueuedRestoreByMemoryConflict(
        draftBeforeRestore?.projectMemoryReferences ?? [],
        messages,
      );
    if (heldConflicts.length > 0 && activeThreadKey) {
      enqueueHeldQueuedMemoryConflicts(activeThreadKey, heldConflicts);
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: t("Memory version conflict"),
          description: t(
            "A different version of the same memory was selected, so the message was held in the queue.",
          ),
        }),
      );
    }
    const [firstMessage] = compatibleMessages;
    if (!firstMessage) return;
    const prompts = [promptRef.current, ...compatibleMessages.map((message) => message.prompt)]
      .map((prompt) => prompt.trim())
      .filter((prompt) => prompt.length > 0);
    const nextPrompt = prompts.join("\n\n");
    promptRef.current = nextPrompt;
    setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    // The draft store silently drops attachments over the per-turn cap. Split
    // the overflow back into the queue so nothing is lost; the user can send
    // the first batch and the rest follows as a queued message.
    const attachmentRoom = Math.max(
      0,
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS -
        composerImagesRef.current.length -
        composerFilesRef.current.length,
    );
    const attachments = compatibleMessages.flatMap((message) => [
      ...message.images,
      ...message.files,
    ]);
    const restored = attachments.slice(0, attachmentRoom);
    const overflow = attachments.slice(attachmentRoom);
    const restoredImages = restored.filter((attachment) => attachment.type === "image");
    const restoredFiles = restored.filter((attachment) => attachment.type === "file");
    // The composer syncs these refs from the draft in an effect; a send before
    // that effect runs must already see the restored content.
    composerImagesRef.current = [...composerImagesRef.current, ...restoredImages];
    composerFilesRef.current = [...composerFilesRef.current, ...restoredFiles];
    if (restoredImages.length > 0) addComposerDraftImages(composerDraftTarget, restoredImages);
    if (restoredFiles.length > 0) addComposerDraftFiles(composerDraftTarget, restoredFiles);
    if (overflow.length > 0 && activeThreadKey) {
      // The overflow is the rest of the restored draft, so it follows the composer.
      const sendCtx = composerRef.current?.getSendContext();
      useQueuedMessageStore.getState().enqueue(activeThreadKey, {
        prompt: "",
        images: overflow.filter((attachment) => attachment.type === "image"),
        files: overflow.filter((attachment) => attachment.type === "file"),
        terminalContexts: [],
        previewAnnotations: [],
        reviewComments: [],
        projectMemoryReferences: [],
        sendSettings: sendCtx ? readComposerSendSettings(sendCtx) : firstMessage.sendSettings,
        queuedAfterToolActivityId: latestCompletedToolActivityId(threadActivities),
        // Restoration is not a send. The user decides when the overflow goes.
        holdUntilUserAction: true,
        createdAt: new Date().toISOString(),
      });
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Some attachments stayed queued",
          description: `A message holds at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments. Use Send now on the queued row when you want the rest to go.`,
        }),
      );
    }
    const restoredTerminalContexts = [
      ...composerTerminalContextsRef.current,
      ...compatibleMessages.flatMap((message) => message.terminalContexts),
    ];
    composerTerminalContextsRef.current = restoredTerminalContexts;
    setComposerDraftTerminalContexts(composerDraftTarget, restoredTerminalContexts);
    const draft = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
    setComposerDraftPreviewAnnotations(composerDraftTarget, [
      ...(draft?.previewAnnotations ?? []),
      ...compatibleMessages.flatMap((message) => message.previewAnnotations),
    ]);
    setComposerDraftReviewComments(composerDraftTarget, [
      ...(draft?.reviewComments ?? []),
      ...compatibleMessages.flatMap((message) => message.reviewComments),
    ]);
    // Restored selections keep the exact identifiers they were queued with.
    const draftAfterContextRestore = useComposerDraftStore
      .getState()
      .getComposerDraft(composerDraftTarget);
    setComposerDraftProjectMemoryReferences(composerDraftTarget, [
      ...(draftAfterContextRestore?.projectMemoryReferences ?? []),
      ...compatibleMessages.flatMap((message) => message.projectMemoryReferences ?? []),
    ]);
    composerRef.current?.resetCursorState({
      cursor: collapseExpandedComposerCursor(nextPrompt, nextPrompt.length),
      prompt: nextPrompt,
      detectTrigger: true,
    });
  };

  return {
    queuedMessageActionsRef,
    restoreQueuedMessagesToComposer,
    readComposerSendSettings,
    onRevertToTurnCount,
    getShortcutContext,
    queuedMessages,
    onCompactContext,
    pendingRevert,
    setPendingRevert,
  };
}
