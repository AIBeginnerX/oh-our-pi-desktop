import {
  type MessageId,
  type ModelSelection,
  ProviderInstanceId,
  type TurnId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { truncate } from "@t3tools/shared/String";
import { useCallback, useEffect, useRef } from "react";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useDiffPanelStore } from "../diffPanelStore";
import { buildPlanImplementationThreadTitle, buildPlanImplementationPrompt } from "../proposedPlan";
import { useRightPanelStore } from "../rightPanelStore";
import {
  isSameSidebarThreadRef,
  useSidebarPendingFileDropStore,
} from "../sidebarPendingFileDropStore";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { newMessageId, newThreadId } from "~/lib/utils";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import { type DraftThreadEnvMode } from "../composerDraftStore";
import { type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import {
  getStartedThreadModelChangeBlockReason,
  waitForStartedServerThread,
} from "./ChatView.logic";
import { formatOutgoingPrompt } from "./ChatView.helpers";
import type { useChatViewThreadState } from "./ChatView.threadState";
import type { useChatViewProjectAndEnvironment } from "./ChatView.projectEnvironment";
import type { useChatViewTimelineData } from "./ChatView.timelineData";
import type { useChatViewTerminalsAndScripts } from "./ChatView.terminalsAndScripts";
import type { useChatViewThreadStatus } from "./ChatView.threadStatus";
import type { useChatViewShortcutsAndRevert } from "./ChatView.shortcutsAndRevert";
import type { useChatViewSend } from "./ChatView.send";

export function useChatViewActions({
  threadState,
  projectEnvironment,
  timelineData,
  terminalsAndScripts,
  threadStatus,
  shortcutsAndRevert,
  sendState,
}: {
  threadState: ReturnType<typeof useChatViewThreadState>;
  projectEnvironment: ReturnType<typeof useChatViewProjectAndEnvironment>;
  timelineData: ReturnType<typeof useChatViewTimelineData>;
  terminalsAndScripts: ReturnType<typeof useChatViewTerminalsAndScripts>;
  threadStatus: ReturnType<typeof useChatViewThreadStatus>;
  shortcutsAndRevert: ReturnType<typeof useChatViewShortcutsAndRevert>;
  sendState: ReturnType<typeof useChatViewSend>;
}) {
  const {
    activeThread,
    isServerThread,
    isConnecting,
    sendInFlightRef,
    composerRef,
    createThread,
    environmentId,
    defaultRuntimeMode,
    startThreadTurn,
    navigate,
    deleteThread,
    settings,
    setComposerDraftModelSelection,
    setStickyComposerModelSelection,
    multipleModelSelections,
    setPendingServerThreadEnvMode,
    isLocalDraftThread,
    setDraftThreadContext,
    composerDraftTarget,
    draftThread,
    draftId,
    routeThreadRef,
    setWorkLocallyResendDraftId,
    workLocallyResendDraftId,
    isRevertingCheckpoint,
    threadDetailLoading,
    feedbackUploading,
    feedbackUploadsInFlightRef,
    routeThreadKey,
    setPendingServerThreadStartFromOriginByThreadId,
    setExpandedImage,
    activeThreadRef,
    explicitDiffOpenRef,
    diffOpen,
    onDiffPanelOpen,
  } = threadState;
  const {
    activeProject,
    activeEnvironmentUnavailable,
    providerStatuses,
    lockedProvider,
    activeProjectSettings,
    clientSettingsHydrated,
  } = projectEnvironment;
  const {
    activeProposedPlan,
    isSendBusy,
    beginLocalDispatch,
    resetLocalDispatch,
    worktreeSetup,
    cancelWorktreeSetup,
    activePendingProgress,
  } = timelineData;
  const { scheduleComposerFocus, needsLoadBalancing } = terminalsAndScripts;
  const { activeThreadBranch, canOverrideServerThreadEnvMode, sendEnvMode } = threadStatus;
  const { onRevertToTurnCount } = shortcutsAndRevert;
  const { onSend } = sendState;

  const onImplementPlanInNewThread = useCallback(async () => {
    if (
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable || !sendCtx.interactionModeEnabled) {
      return;
    }
    const {
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: implementationPrompt,
    });
    if (composerRef.current?.validateProviderInput(outgoingImplementationPrompt) === false) {
      return;
    }
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = ctxSelectedModelSelection;

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    const createResult = await createThread({
      environmentId,
      input: {
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode: defaultRuntimeMode,
        interactionMode: "default",
        branch: activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      },
    });
    let failure: AtomCommandResult<unknown, unknown> | null =
      createResult._tag === "Failure" ? createResult : null;

    if (failure === null) {
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode: defaultRuntimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        },
      });
      failure = startResult._tag === "Failure" ? startResult : null;
    }

    if (failure === null) {
      const startedResult = await settlePromise(() =>
        waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId)),
      );
      failure = startedResult._tag === "Failure" ? startedResult : null;
    }

    if (failure === null) {
      const navigateResult = await settlePromise(() =>
        navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        }),
      );
      failure = navigateResult._tag === "Failure" ? navigateResult : null;
    }

    if (failure !== null) {
      const cleanupResult = await deleteThread({
        environmentId,
        input: {
          threadId: nextThreadId,
        },
      });
      if (cleanupResult._tag === "Failure" && !isAtomCommandInterrupted(cleanupResult)) {
        console.warn(
          "Failed to clean up implementation thread after start failure.",
          squashAtomCommandFailure(cleanupResult),
        );
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start implementation thread",
            description:
              error instanceof Error
                ? error.message
                : "An error occurred while creating the new thread.",
          }),
        );
      }
    }
    finish();
  }, [
    activeProject,
    activeProposedPlan,
    activeThreadBranch,
    activeThread,
    beginLocalDispatch,
    activeEnvironmentUnavailable,
    createThread,
    deleteThread,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    resetLocalDispatch,
    defaultRuntimeMode,
    startThreadTurn,
    environmentId,
    composerRef,
  ]);

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null => {
      if (!activeThread) {
        return null;
      }
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeThread.session?.providerInstanceId ?? null,
        nextModelSelection: { instanceId, model },
      });
      return reason ? `${reason.description} Start a new thread to use this model.` : null;
    },
    [activeThread, providerStatuses],
  );

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string, options?: { focusComposer?: boolean }) => {
      if (!activeThread) return;
      // Look up the configured instance so model normalization and custom
      // model lookup stay scoped to that exact instance. Unknown instance ids
      // are rejected by returning early; the server remains authoritative too.
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
      const resolvedDriverKind = entry?.driver ?? null;
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      ) {
        if (options?.focusComposer !== false) scheduleComposerFocus();
        return;
      }
      if (lockedProvider !== null && activeThread.session?.providerInstanceId) {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === activeThread.session?.providerInstanceId,
        );
        if (
          currentEntry?.continuation?.groupKey &&
          entry?.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        ) {
          if (options?.focusComposer !== false) scheduleComposerFocus();
          return;
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        if (options?.focusComposer !== false) scheduleComposerFocus();
        return;
      }
      const nextModelSelection: ModelSelection = {
        instanceId,
        model: resolvedModel,
      };
      const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeThread.session?.providerInstanceId ?? null,
        nextModelSelection,
      });
      if (modelChangeBlockReason) {
        toastManager.add({
          type: "warning",
          title: modelChangeBlockReason.title,
          description: modelChangeBlockReason.description,
        });
        if (options?.focusComposer !== false) scheduleComposerFocus();
        return;
      }
      setComposerDraftModelSelection(
        scopeThreadRef(activeThread.environmentId, activeThread.id),
        nextModelSelection,
        { explicit: true },
      );
      setStickyComposerModelSelection(nextModelSelection);
      if (options?.focusComposer !== false) scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      providerStatuses,
      settings,
    ],
  );
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (multipleModelSelections !== null) return;
      if (canOverrideServerThreadEnvMode) {
        setPendingServerThreadEnvMode(mode);
        scheduleComposerFocus();
        return;
      }
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, {
          envMode: mode,
          startFromOrigin: resolveNewDraftStartFromOrigin({
            envMode: mode,
            newWorktreesStartFromOrigin: activeProjectSettings.settings.newWorktreesStartFromOrigin,
          }),
          ...(mode === "worktree" && draftThread?.worktreePath ? { worktreePath: null } : {}),
        });
      }
      scheduleComposerFocus();
    },
    [
      canOverrideServerThreadEnvMode,
      composerDraftTarget,
      draftThread?.worktreePath,
      isLocalDraftThread,
      multipleModelSelections,
      activeProjectSettings.settings.newWorktreesStartFromOrigin,
      setPendingServerThreadEnvMode,
      scheduleComposerFocus,
      setDraftThreadContext,
    ],
  );

  // "Work locally" on the setup card: cancel the bootstrap and remember the
  // draft. The cancelled dispatch deletes the half-made thread and puts the
  // message back in the composer; the effect below then flips the draft to
  // local mode and resends. The draft is a server thread for the whole
  // setup (the bootstrap created it), so this keys off the route, not
  // `isLocalDraftThread`.
  const onWorktreeSetupWorkLocally = useCallback(() => {
    if (!worktreeSetup || worktreeSetup.phase !== "running" || !draftId) {
      return;
    }
    const target = {
      environmentId: routeThreadRef.environmentId,
      input: { threadId: worktreeSetup.threadId },
    };
    void (async () => {
      const result = await cancelWorktreeSetup(target);
      if (result._tag !== "Success" || !result.value.cancelled) return;
      setWorkLocallyResendDraftId(draftId);
    })();
  }, [cancelWorktreeSetup, draftId, routeThreadRef.environmentId, worktreeSetup]);
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  // Resend once the cancelled dispatch has settled and the composer is free.
  // Every state that makes `onSend` bail and wait is part of the readiness
  // check, so the flag survives a reconnect, a reverting checkpoint, or a
  // feedback upload in between. What remains inside `onSend` are the checks
  // that need the user to change something, and those should not auto retry.
  const workLocallyResendReady =
    workLocallyResendDraftId !== null &&
    workLocallyResendDraftId === draftId &&
    isLocalDraftThread &&
    !isSendBusy &&
    !isConnecting &&
    !isRevertingCheckpoint &&
    !threadDetailLoading &&
    clientSettingsHydrated &&
    !needsLoadBalancing &&
    !activeEnvironmentUnavailable &&
    !activePendingProgress &&
    !feedbackUploading;
  useEffect(() => {
    if (
      !workLocallyResendReady ||
      sendInFlightRef.current ||
      feedbackUploadsInFlightRef.current.has(routeThreadKey)
    ) {
      return;
    }
    if (sendEnvMode !== "local") {
      // The draft is back; switch it to the project checkout and let the next
      // render resend.
      setDraftThreadContext(composerDraftTarget, { envMode: "local", startFromOrigin: false });
      return;
    }
    setWorkLocallyResendDraftId(null);
    void onSendRef.current();
  }, [
    composerDraftTarget,
    routeThreadKey,
    sendEnvMode,
    setDraftThreadContext,
    workLocallyResendReady,
  ]);

  const onStartFromOriginChange = (nextStartFromOrigin: boolean) => {
    if (canOverrideServerThreadEnvMode && activeThread) {
      setPendingServerThreadStartFromOriginByThreadId((current) =>
        current[activeThread.id] === nextStartFromOrigin
          ? current
          : { ...current, [activeThread.id]: nextStartFromOrigin },
      );
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        startFromOrigin: nextStartFromOrigin,
      });
    }
  };

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (!isServerThread || !activeThreadRef) return;
      explicitDiffOpenRef.current = diffOpen ? null : activeThreadRef;
      useDiffPanelStore.getState().selectTurn(activeThreadRef, turnId, filePath);
      useRightPanelStore.getState().open(activeThreadRef, "diff");
      onDiffPanelOpen?.();
    },
    [activeThreadRef, diffOpen, isServerThread, onDiffPanelOpen],
  );
  // The revert handler is read from a ref at call-time so the callback
  // reference is fully stable and never busts TimelineRowCtx identity.
  const onRevertToTurnCountRef = useRef(onRevertToTurnCount);
  onRevertToTurnCountRef.current = onRevertToTurnCount;
  const onRevertTimelineTurn = useCallback((targetTurnCount: number, messageId: MessageId) => {
    void onRevertToTurnCountRef.current(targetTurnCount, messageId);
  }, []);

  // Files dropped on a sidebar row land here once the dropped-on thread is
  // actually open, then take the exact same path as a workspace drop:
  // validate, compress, focus the composer, never send. Kept above the
  // no-active-thread early return so hook order never changes.
  const pendingSidebarFileDrops = useSidebarPendingFileDropStore((state) => state.pending);
  const consumePendingFileDrop = useSidebarPendingFileDropStore(
    (state) => state.consumePendingFileDrop,
  );
  useEffect(() => {
    if (pendingSidebarFileDrops.length === 0) return;
    // A promoting draft can mount this view with the server thread id while
    // its composer is still draft-keyed; finalization would discard what we
    // attach there. Only the canonical thread target may consume a drop.
    if (
      typeof composerDraftTarget === "string" ||
      !pendingSidebarFileDrops.some((drop) =>
        isSameSidebarThreadRef(composerDraftTarget, drop.threadRef),
      )
    ) {
      return;
    }
    if (!activeThread) return;
    if (!composerRef.current) {
      const raf = window.requestAnimationFrame(() => {
        if (!composerRef.current) return;
        if (typeof composerDraftTarget === "string") return;
        // Consume matches by target, so a newer drop that arrived meanwhile
        // is collected too rather than orphaned.
        const files = consumePendingFileDrop(composerDraftTarget);
        if (files !== null) {
          composerRef.current?.addDroppedFiles(files);
        }
      });
      return () => window.cancelAnimationFrame(raf);
    }
    const files = consumePendingFileDrop(composerDraftTarget);
    if (files !== null) {
      composerRef.current.addDroppedFiles(files);
    }
  }, [
    activeThread,
    composerDraftTarget,
    composerRef,
    consumePendingFileDrop,
    pendingSidebarFileDrops,
  ]);

  return {
    onWorktreeSetupWorkLocally,
    onOpenTurnDiff,
    onRevertTimelineTurn,
    onExpandTimelineImage,
    onImplementPlanInNewThread,
    onProviderModelSelect,
    getModelDisabledReason,
    onEnvModeChange,
    onStartFromOriginChange,
  };
}
