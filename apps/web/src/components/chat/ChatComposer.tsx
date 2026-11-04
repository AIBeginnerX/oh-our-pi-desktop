import { useComposerImperativeHandle } from "./ChatComposer.handle";
import { useComposerAttachmentHandlers } from "./ChatComposer.attachments";
import { useComposerRestingChrome } from "./ChatComposer.resting";
import { useComposerStash } from "./ChatComposer.stash";
import { useComposerSubmitHandlers } from "./ChatComposer.submit";
import { useComposerPromptHandlers } from "./ChatComposer.promptHandlers";
import { useComposerDraftEffects } from "./ChatComposer.draftEffects";
import { useComposerContextImport } from "./ChatComposer.contextImport";
import { useComposerMenuModel } from "./ChatComposer.menu";
import { useComposerProviderSelection } from "./ChatComposer.provider";
import { ComposerVideoThumbnail, SnapShotAttachmentFrame } from "./ChatComposer.attachmentPreview";
import { ComposerCommandMenuLayer } from "./ChatComposer.commandMenuLayer";
import { useRestingComposerControlsLayout } from "./ChatComposer.restingLayout";
import { ComposerFooterPrimaryActions } from "./ChatComposer.footer";
import type { ChatComposerProps } from "./ChatComposer.types";
import { DESKTOP_PASTE_AS_TEXT_EVENT } from "../../lib/desktopPasteAsText";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useRightPanelStore } from "~/rightPanelStore";
import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  questionAttachmentDraftId,
  useQuestionAttachmentPreparation,
} from "../../questionAttachments";
import { isPasteAsTextShortcut } from "@t3tools/client-runtime/text-paste";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { collapseExpandedComposerCursor, detectComposerTrigger } from "../../composer-logic";
import { DISCONNECTED_COMPOSER_PLACEHOLDER } from "../../composerPlaceholder";
import {
  dataTransferHasComposerMention,
  makeComposerMentionDragHandlers,
} from "./composerMentionDrag";
import {
  composerFloatingLayerProps,
  isInsideCollapsedComposerControls,
  isInsideRestingComposerControlScope,
} from "./composerEventScope";
import {
  composerFileNeedsReattach,
  composerTargetKey,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import { ComposerStashBadge } from "./ComposerStashBadge";
import { ComposerStashMenu } from "./ComposerStashMenu";
import { useComposerTriggerState } from "./useComposerTriggerState";
import { useComposerFocusState } from "./useComposerFocusState";
import { useComposerMultilinePrompt } from "./useComposerMultilinePrompt";
import {
  ComposerTasksBadge,
  ComposerTasksContent,
  ComposerTasksDrawer,
} from "./ComposerTasksBadge";
import { ComposerActivityRow } from "./ComposerActivityStatus";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerSurface } from "./ComposerSurface";
import { ComposerBannerStack, type ComposerBannerStackContent } from "./ComposerBannerStack";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  attachmentsToReleaseOnUploadCapabilityLoss,
  composerOtherFilesForPresentation,
  fileAttachmentCapabilityBlockReason,
  fileAttachmentStagingLimit,
  isPreviewableComposerVideo,
} from "./composerAttachmentFiles";
import {
  releaseAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import {
  attachmentUploadBlockReason,
  formatAttachmentUploadProgress,
} from "../../lib/attachmentUploadState";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { useT } from "../../i18n";
import { type ComposerPromptEditorHandle, ComposerPromptEditor } from "../ComposerPromptEditor";
import {
  ComposerContextActionsContext,
  composerContextRecordsFromDraft,
} from "../composerContextPresentation";
import {
  ProjectMemoryComposerControl,
  ProjectMemoryTitleProvider,
  ProjectMemoryUnsupportedWarning,
  readCurrentServerThreadInsertionScope,
} from "./ProjectMemoryPicker";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import {
  collectInlineContextIds,
  toKindScopedComposerContextId,
} from "~/lib/composerContextReferences";
import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerImageThumbnail } from "./ComposerImageThumbnail";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import {
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import { buildAttachmentVideoPreview, buildExpandedImagePreview } from "./ExpandedImagePreview";
import {
  SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
  SnapShotAttachmentDetails,
} from "./SnapShotAttachmentDetails";
import {
  getPendingSnapShotAnimations,
  pendingSnapShotAnimationIdsForTarget,
  shouldAnimateSnapShotArrival,
  subscribeToPendingSnapShotAnimations,
} from "../../lib/snapShotAnimation";
import { cn, isMacPlatform } from "~/lib/utils";
import { ComposerPromptLengthValidation } from "./ComposerPromptLengthValidation";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { createComposerScrollGestureState } from "./composerScrollGesture";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { CircleAlertIcon, PaperclipIcon, PlayIcon, ShieldIcon, XIcon } from "lucide-react";
import { proposedPlanTitle } from "../../proposedPlan";
import { isVideoAttachment } from "../../types";
import { type ComposerPromptHistoryPosition } from "./composerPromptHistory";
import { useDelayedStatus } from "../../hooks/useDelayedStatus";
import { useMediaQuery } from "../../hooks/useMediaQuery";
// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export type { ChatComposerHandle, ChatComposerProps } from "./ChatComposer.types";

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const {
    composerDraftTarget,
    environmentId,
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    supportsQuestionAttachments,
    maxFileAttachmentBytes,
    routeKind,
    routeThreadRef,
    draftId,
    multipleModelSelections,
    supportsMultipleModels,
    onMultipleModelSelectionsChange: setMultipleModelSelections,
    activeThreadId,
    activeThreadEnvironmentId: _activeThreadEnvironmentId,
    activeThread,
    promptHistoryMessages,
    isServerThread: _isServerThread,
    isLocalDraftThread: _isLocalDraftThread,
    forceExpandedOnMobile,
    projectSelectionRequired,
    phase,
    liveBackgroundAgentCount = 0,
    isConnecting,
    isSendBusy,
    isRevertingCheckpoint = false,
    sendDisabledReason: externalSendDisabledReason,
    isPreparingWorktree,
    environmentUnavailable,
    activePendingApproval,
    pendingApprovals,
    pendingUserInputs,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    respondingRequestIds,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    runtimeMode,
    interactionMode: requestedInteractionMode,
    lockedProvider,
    providerStatuses,
    providerCatalogKnown,
    activeProjectDefaultModelSelection,
    activeThreadModelSelection,
    activeContextWindow,
    compactThreadUnavailable,
    compactDisabled,
    compactDisabledReason,
    resolvedTheme,
    settings,
    keybindings,
    terminalOpen,
    gitCwd,
    pullRequestProjectId,
    pullRequestRepository,
    projectMemoryCapability,
    restingControlsHost,
    restingControlsHaveLeadingContext,
    onRestingControlsVisibilityChange,
    getTimelineScrollableNode,
    isTimelineAtLogicalEnd,
    timelineOverflows,
    onComposerOverlayHeightChange,
    onRestingChange,
    promptRef,
    composerRef,
    composerImagesRef,
    composerFilesRef,
    composerTerminalContextsRef,
    onPageScrollKeyDown,
    onPageScrollKeyUp,
    onPageScrollRelease,
    onCompactContext,
    onSend,
    onInterrupt,
    onImplementPlanInNewThread,
    onRespondToApproval,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onDismissActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
    onProviderModelSelect,
    onOpenProviderSetup,
    getModelDisabledReason,
    toggleInteractionMode,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    focusComposer,
    scheduleComposerFocus,
    setThreadError,
    onExpandImage,
    onFileOpen,
  } = props;
  const t = useT();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const composerDraftTargetKey = composerTargetKey(composerDraftTarget);
  // Opening a running thread resyncs for a few frames. Show the sync row, and
  // hide the tasks row for it, only when the sync lasts. Logic that depends on
  // the real phase keeps reading `props.threadSyncPhase`.
  const shownSyncPhase = useDelayedStatus(composerDraftTargetKey, props.threadSyncPhase);
  const activeTasksProgress = shownSyncPhase === null ? props.activeTasksProgress : null;
  const activeTaskSteps = shownSyncPhase === null ? props.activeTaskSteps : null;
  // ------------------------------------------------------------------
  // Store subscriptions (prompt / images / terminal contexts)
  // ------------------------------------------------------------------
  const composerDraft = useComposerThreadDraft(composerDraftTarget);
  // Live target key, for async flows that must notice a thread switch that
  // happened while they awaited.
  const composerDraftTargetKeyRef = useRef("");
  composerDraftTargetKeyRef.current = composerDraftTargetKey;
  const questionAttachmentTarget =
    pendingUserInputs[0] && activePendingProgress?.activeQuestion
      ? questionAttachmentDraftId(
          environmentId,
          activeThreadId!,
          pendingUserInputs[0].requestId,
          activePendingProgress.activeQuestion.id,
        )
      : null;
  const attachmentDraftTarget = questionAttachmentTarget ?? composerDraftTarget;
  const attachmentDraft = useComposerThreadDraft(attachmentDraftTarget);
  const attachmentTargetKey = composerTargetKey(attachmentDraftTarget);
  // An import that finishes after a draft change must compare against the draft open *now*, not
  // the one captured in the closure that started it.
  const attachmentTargetKeyRef = useRef(attachmentTargetKey);
  attachmentTargetKeyRef.current = attachmentTargetKey;
  const questionPreparations = useQuestionAttachmentPreparation((state) => state.counts);
  const prompt = composerDraft.prompt;
  const composerImages = attachmentDraft.images;
  const composerFiles = attachmentDraft.files;
  // A question answer has no chips: its files live in the question draft and show in the
  // strip. Only the thread prompt's references decide which files leave the strip.
  const inlineFileIdSet = useMemo(() => {
    if (questionAttachmentTarget) return new Set<string>();
    const contextIds = new Set(collectInlineContextIds(prompt));
    return new Set(
      composerFiles
        .filter((file) => contextIds.has(toKindScopedComposerContextId("file", file.id)))
        .map((file) => file.id),
    );
  }, [composerFiles, prompt, questionAttachmentTarget]);
  const composerVideos = composerFiles.filter((file) =>
    isPreviewableComposerVideo(file, environmentId),
  );
  const composerOtherFiles = composerOtherFilesForPresentation(
    composerFiles,
    environmentId,
    inlineFileIdSet,
  );
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerPreviewAnnotations = composerDraft.previewAnnotations;
  const composerReviewComments = composerDraft.reviewComments;
  const composerProjectMemoryReferences = composerDraft.projectMemoryReferences;
  const pendingSnapShotAnimations = useSyncExternalStore(
    subscribeToPendingSnapShotAnimations,
    getPendingSnapShotAnimations,
    getPendingSnapShotAnimations,
  );
  const pendingSnapShotIds = useMemo(
    () => pendingSnapShotAnimationIdsForTarget(pendingSnapShotAnimations, composerDraftTarget),
    [composerDraftTarget, pendingSnapShotAnimations],
  );
  const pendingSnapShotIdSet = useMemo(() => new Set(pendingSnapShotIds), [pendingSnapShotIds]);
  const uncommittedSnapShotIds = pendingSnapShotIds.filter(
    (id) => !composerImages.some((image) => image.id === id),
  );
  const standaloneComposerImages = useMemo(() => {
    const previewAnnotationIds = new Set(
      composerPreviewAnnotations.map((annotation) => annotation.id),
    );
    return composerImages.filter((image) => !previewAnnotationIds.has(image.id));
  }, [composerImages, composerPreviewAnnotations]);
  const nonPersistedComposerImageIds = attachmentDraft.nonPersistedImageIds;
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const openPrLink = useOpenPrLink(routeThreadRef);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const previewFile = composerFiles.find((file) => file.id === previewFileId);
  const composerContextActions = useMemo(
    () => ({
      environmentId,
      expandImage: (imageId: string) => {
        const preview = buildExpandedImagePreview(composerImages, imageId);
        if (preview) onExpandImage(preview);
      },
      openFile: setPreviewFileId,
      openMention: (path: string) => useRightPanelStore.getState().openFile(routeThreadRef, path),
      expandVideo: (fileId: string) => {
        const file = composerFiles.find((candidate) => candidate.id === fileId);
        if (!file || !isVideoAttachment(file)) return;
        const localPreview = buildExpandedImagePreview([file], file.id);
        if (localPreview) {
          onExpandImage(localPreview);
          return;
        }
        if (file.uploadedAttachmentId === undefined || file.uploadEnvironmentId !== environmentId) {
          return;
        }
        const persistedPreview = buildAttachmentVideoPreview(environmentId, {
          type: "file",
          id: file.uploadedAttachmentId,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        });
        if (persistedPreview) onExpandImage(persistedPreview);
      },
      openPullRequest: (event: React.MouseEvent<HTMLElement>, url: string) => {
        openPrLink(event, url);
      },
    }),
    [composerFiles, composerImages, environmentId, onExpandImage, openPrLink, routeThreadRef],
  );
  const composerContextRecords = useMemo(
    () =>
      composerContextRecordsFromDraft({
        terminalContexts: composerTerminalContexts,
        reviewComments: composerReviewComments,
        previewAnnotations: composerPreviewAnnotations,
        images: composerImages,
        files: composerFiles,
        uploadsByImageId,
        projectMemoryReferences: composerProjectMemoryReferences,
      }),
    [
      composerFiles,
      composerImages,
      composerPreviewAnnotations,
      composerProjectMemoryReferences,
      composerReviewComments,
      composerTerminalContexts,
      uploadsByImageId,
    ],
  );
  const needsReattachFileCount = composerFiles.filter(composerFileNeedsReattach).length;
  const fileStagingLimit = fileAttachmentStagingLimit({
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    maxFileAttachmentBytes,
  });
  const fileCapabilityBlockReason = fileAttachmentCapabilityBlockReason({
    files: composerFiles,
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    maxFileAttachmentBytes,
  });
  const attachmentBlockReason =
    (questionAttachmentTarget &&
    !supportsQuestionAttachments &&
    (composerImages.length > 0 || composerFiles.length > 0)
      ? "Update this server to send files with question answers"
      : null) ??
    fileCapabilityBlockReason ??
    (supportsAttachmentUploads
      ? needsReattachFileCount > 0
        ? needsReattachFileCount === 1
          ? "Attach the interrupted file again or remove it"
          : "Attach the interrupted files again or remove them"
        : attachmentUploadBlockReason({
            imageIds: [...composerImages, ...composerFiles].map((attachment) => attachment.id),
            uploadsByImageId,
            environmentId,
          })
      : null);
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const removeComposerDraftFile = useComposerDraftStore((store) => store.removeFile);
  const setComposerDraftFileUpload = useComposerDraftStore((store) => store.setFileUpload);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const removeComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.removePreviewAnnotation,
  );
  const removeComposerDraftReviewComment = useComposerDraftStore(
    (store) => store.removeReviewComment,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const clearComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.clearTerminalContexts,
  );
  const clearComposerDraftPromptAndImages = useComposerDraftStore(
    (store) => store.clearComposerPromptAndImages,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

  useEffect(() => {
    if (!attachmentUploadsCapabilityKnown) {
      return;
    }
    if (!supportsAttachmentUploads) {
      // The capability can flap on reconnect or version skew. Deleting a
      // persisted hydrated upload here would make the next send fail
      // verification while the file still sits in the draft.
      for (const attachment of attachmentsToReleaseOnUploadCapabilityLoss([
        ...composerImages,
        ...composerFiles,
      ])) {
        releaseAttachmentUpload(attachment.id);
      }
      return;
    }
    const invalidFiles =
      maxFileAttachmentBytes === null
        ? composerFiles
        : composerFiles.filter((file) => file.sizeBytes > maxFileAttachmentBytes);
    for (const attachment of attachmentsToReleaseOnUploadCapabilityLoss(invalidFiles)) {
      releaseAttachmentUpload(attachment.id);
    }
    const uploadableFiles =
      maxFileAttachmentBytes === null
        ? []
        : composerFiles.filter((file) => file.sizeBytes <= maxFileAttachmentBytes);
    const uploadableAttachments = [...composerImages, ...uploadableFiles];
    for (const attachment of uploadableAttachments) {
      // A needs-reattach file has no bytes to upload and no upload to verify.
      if (attachment.type === "file" && composerFileNeedsReattach(attachment)) {
        continue;
      }
      startAttachmentUpload({
        environmentId,
        image: attachment,
        draftTarget: attachmentDraftTarget,
      });
    }
  }, [
    attachmentUploadsCapabilityKnown,
    attachmentDraftTarget,
    composerFiles,
    composerImages,
    environmentId,
    maxFileAttachmentBytes,
    supportsAttachmentUploads,
  ]);

  useEffect(() => {
    for (const file of composerFiles) {
      if (
        !attachmentUploadsCapabilityKnown ||
        !supportsAttachmentUploads ||
        maxFileAttachmentBytes === null ||
        file.sizeBytes > maxFileAttachmentBytes
      ) {
        continue;
      }
      const upload = uploadsByImageId[file.id];
      if (upload?.status === "ready" && upload.environmentId === environmentId) {
        setComposerDraftFileUpload(
          attachmentDraftTarget,
          file.id,
          environmentId,
          upload.attachmentId,
        );
      }
    }
  }, [
    attachmentUploadsCapabilityKnown,
    attachmentDraftTarget,
    composerFiles,
    environmentId,
    maxFileAttachmentBytes,
    setComposerDraftFileUpload,
    supportsAttachmentUploads,
    uploadsByImageId,
  ]);

  const {
    providerInstanceEntries,
    lockedContinuationGroupKey,
    selectedInstanceId,
    noProviderAvailable,
    providerCatalogPending,
    showProviderUnavailable,
    runningComposerPlaceholder,
    projectMemoryGate,
    providerSetupInstanceId,
    resolvedCompactDisabledReason,
    selectedProvider,
    composerModelOptions,
    selectedModel,
    providerSendBlockReason,
    sendDisabledReason,
    isSendDisabled,
    selectedProviderStatus,
    compactCommandAvailable,
    selectedProviderSkills,
    selectedProviderSlashCommands,
    selectedProviderModels,
    composerProviderState,
    selectedPromptEffort,
    selectedModelOptionsForDispatch,
    planModeUiEnabled,
    interactionMode,
    selectedModelSelection,
    modelOptionsByInstance,
    selectedModelForPickerWithCustomFallback,
    activeThreadModelDisplayName,
    reserveContextWindowMeter,
  } = useComposerProviderSelection({
    activePendingProgress,
    activeProjectDefaultModelSelection,
    activeThread,
    activeThreadModelSelection,
    attachmentBlockReason,
    compactDisabledReason,
    composerDraft,
    composerDraftTarget,
    composerProjectMemoryReferences,
    environmentId,
    externalSendDisabledReason,
    gitCwd,
    keybindings,
    liveBackgroundAgentCount,
    lockedProvider,
    multipleModelSelections,
    phase,
    projectMemoryCapability,
    prompt,
    props,
    providerCatalogKnown,
    providerStatuses,
    requestedInteractionMode,
    settings,
    t,
  });

  // ------------------------------------------------------------------
  // Composer-local state
  // ------------------------------------------------------------------
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const {
    trigger: composerTrigger,
    setTrigger: setComposerTrigger,
    resolveTrigger: resolveComposerTrigger,
    dismissTrigger: dismissComposerTrigger,
    resetTrigger: resetComposerTrigger,
  } = useComposerTriggerState(() => detectComposerTrigger(prompt, prompt.length));
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  // Active ArrowUp recall. Cleared on edit and on thread switch.
  const promptHistoryPositionRef = useRef<ComposerPromptHistoryPosition | null>(null);
  const [composerHighlightedSearchKey, setComposerHighlightedSearchKey] = useState<string | null>(
    null,
  );
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  const [isComposerModelPickerOpen, setIsComposerModelPickerOpen] = useState(false);
  const isMobileViewport = useMediaQuery("max-sm");
  const {
    isComposerFocused,
    setIsComposerFocused,
    isComposerScrollCollapsed,
    setIsComposerScrollCollapsed,
    restoreAfterTimelineReachedEnd,
  } = useComposerFocusState();
  const [composerSubmissionError, setComposerSubmissionError] = useState<string | null>(null);
  const [providerInputSubmissionError, setProviderInputSubmissionError] = useState<string | null>(
    null,
  );
  const [composerMenuAnchor, setComposerMenuAnchor] = useState<HTMLDivElement | null>(null);
  const hasWrappedPrompt = useComposerMultilinePrompt(composerMenuAnchor);
  const hasMultilinePrompt = prompt.includes("\n") || hasWrappedPrompt;
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);
  const [isTasksDrawerOpen, setIsTasksDrawerOpen] = useState(false);
  const [stashPulse, setStashPulse] = useState<{ key: number; active: boolean }>({
    key: 0,
    active: false,
  });
  const isComposerCollapsedMobile =
    isMobileViewport && !forceExpandedOnMobile && !isComposerFocused && !hasMultilinePrompt;

  // ------------------------------------------------------------------
  // Refs
  // ------------------------------------------------------------------
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const pasteAsTextShortcutUntilRef = useRef(0);
  const pastedTextFileNamesRef = useRef<{ targetKey: string; names: Set<string> }>({
    targetKey: "",
    names: new Set(),
  });
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const providerInputRejectedRef = useRef(false);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const composerBlurFrameRef = useRef<number | null>(null);
  const mobileComposerExpandFrameRef = useRef<number | null>(null);
  const mobileComposerExpandReleaseFrameRef = useRef<number | null>(null);
  const mobileComposerExpandInFlightRef = useRef(false);
  const composerScrollCollapseTimeoutRef = useRef<number | null>(null);
  const composerScrollCollapseEligibleRef = useRef(false);
  const windowRefocusInFlightRef = useRef(false);
  const composerScrollGestureRef = useRef(createComposerScrollGestureState());
  const stashPulseKeyRef = useRef(0);
  const stashPulseTimeoutRef = useRef<number | null>(null);
  /**
   * Snapshots currently being encoded, keyed by target+prompt+image ids.
   * Keyed rather than boolean so a genuinely different prompt (or a different
   * thread) can still be stashed while an earlier encode is running.
   */
  const stashInFlightRef = useRef<Set<string>>(new Set());
  /**
   * Count of pasted images still being compressed, per thread. Reserved
   * against the attachment limit so concurrent pastes can't overshoot it,
   * and checked before sending so an image cannot move into
   * the next draft.
   */
  const pendingImageCompressionsRef = useRef<Map<string, number>>(new Map());
  const isRevertingCheckpointRef = useRef(isRevertingCheckpoint);
  isRevertingCheckpointRef.current = isRevertingCheckpoint;

  useEffect(() => {
    const armPasteAsTextShortcut = () => {
      // Electron can deliver its native menu action just before the paste
      // event, while browsers normally deliver keydown first. A short deadline
      // bridges both event paths without leaving later pastes in bypass mode.
      pasteAsTextShortcutUntilRef.current = Date.now() + 1_000;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof Node &&
        composerFormRef.current?.contains(event.target) &&
        isPasteAsTextShortcut(event, isMacPlatform(navigator.platform))
      ) {
        armPasteAsTextShortcut();
      }
    };
    const onBlur = () => {
      pasteAsTextShortcutUntilRef.current = 0;
    };
    const onDesktopPasteAsText = () => {
      const activeElement = document.activeElement;
      const blocksPasteToFocus =
        activeElement instanceof Element &&
        activeElement.closest(
          'input, textarea, select, button, a[href], summary, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], [role="button"], [role="menuitem"], [role="option"]',
        ) !== null;
      if (
        (activeElement instanceof Node && composerFormRef.current?.contains(activeElement)) ||
        !blocksPasteToFocus
      ) {
        armPasteAsTextShortcut();
      }
    };
    window.addEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, onDesktopPasteAsText);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, onDesktopPasteAsText);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const {
    composerSendState,
    composerTriggerKind,
    composerMenuItems,
    composerMenuOpen,
    composerMenuSearchKey,
    activeComposerMenuItem,
    nonPersistedComposerImageIdSet,
    isComposerApprovalState,
    activePendingUserInput,
    isChoiceOnlyPendingQuestion,
    showComposerTopDrawer,
    showCollapsedMobilePromptRow,
    showComposerAttachAction,
    composerFooterHasWideActions,
    composerFooterActionLayoutKey,
    isComposerMenuLoading,
    composerMenuEmptyState,
  } = useComposerMenuModel({
    activeComposerMenuItemRef,
    activePendingApproval,
    activePendingIsResponding,
    activePendingProgress,
    activeProposedPlan,
    compactThreadUnavailable,
    composerDraft,
    composerFiles,
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerImages,
    composerMenuItemsRef,
    composerMenuOpenRef,
    composerPreviewAnnotations,
    composerReviewComments,
    composerTerminalContexts,
    composerTrigger,
    environmentId,
    fileStagingLimit,
    gitCwd,
    isComposerCollapsedMobile,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    nonPersistedComposerImageIds,
    pendingUserInputs,
    phase,
    planModeUiEnabled,
    prompt,
    pullRequestProjectId,
    pullRequestRepository,
    selectedProvider,
    selectedProviderSkills,
    selectedProviderSlashCommands,
    selectedProviderStatus,
    settings,
    showPlanFollowUpPrompt,
    supportsQuestionAttachments,
  });

  // ------------------------------------------------------------------
  // Provider traits UI
  // ------------------------------------------------------------------
  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      if (nextPrompt === promptRef.current) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [
      composerDraftTarget,
      promptRef,
      scheduleComposerFocus,
      setComposerDraftPrompt,
      setComposerTrigger,
    ],
  );

  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    prompt,
    onPromptChange: setPromptFromTraits,
    planModeEnabled: settings.planModeEnabled,
  });
  const providerTraitsPickerInput = {
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    prompt,
    onPromptChange: setPromptFromTraits,
    planModeEnabled: settings.planModeEnabled,
    isComposerOwned: true,
  } satisfies Parameters<typeof renderProviderTraitsPicker>[0];
  const providerTraitsPicker = renderProviderTraitsPicker(providerTraitsPickerInput);
  const {
    controlsRef: restingComposerControlsRef,
    attachControls: attachRestingComposerControls,
    hiddenBlockCount: restingControlsHiddenBlockCount,
    iconOnlyBlockCount: restingControlsIconOnlyBlockCount,
    controlsVisible: restingControlsVisible,
  } = useRestingComposerControlsLayout(restingControlsHost);
  const expandedControlsLayout = useRestingComposerControlsLayout(null, true);
  const pendingPrimaryAction = useMemo(
    () =>
      activePendingProgress
        ? {
            questionIndex: activePendingProgress.questionIndex,
            isLastQuestion: activePendingProgress.isLastQuestion,
            canAdvance:
              activePendingProgress.canAdvance &&
              !attachmentBlockReason &&
              !(questionPreparations[attachmentTargetKey] ?? 0),
            isResponding: activePendingIsResponding,
            isComplete: Boolean(activePendingResolvedAnswers),
          }
        : null,
    [
      activePendingIsResponding,
      activePendingProgress,
      activePendingResolvedAnswers,
      attachmentBlockReason,
      questionPreparations,
      attachmentTargetKey,
    ],
  );
  const collapsedComposerPrimaryActionDisabled =
    phase === "running" ||
    isSendBusy ||
    isSendDisabled ||
    isConnecting ||
    noProviderAvailable ||
    projectSelectionRequired ||
    environmentUnavailable !== null ||
    !composerSendState.hasSendableContent;
  const collapsedComposerPrimaryActionLabel = "Send message";
  const showMobilePendingAnswerActions =
    isMobileViewport && !isComposerCollapsedMobile && pendingPrimaryAction !== null;

  const {
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
  } = useComposerContextImport({
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
  });

  const {
    expandComposerForEditorChange,
    removedContextPayloadsRef,
    reconcileProjectMemoryFromPrompt,
    removedAttachmentContextPayloadsRef,
  } = useComposerDraftEffects({
    activePendingProgress,
    activePendingUserInput,
    activeThreadId,
    attachmentDraftTarget,
    clearComposerDraftPersistedAttachments,
    composerDraftTarget,
    composerFiles,
    composerFilesRef,
    composerFooterActionLayoutKey,
    composerFooterHasWideActions,
    composerFormRef,
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerImages,
    composerImagesRef,
    composerMenuItems,
    composerMenuOpen,
    composerMenuSearchKey,
    composerPreviewAnnotations,
    composerReviewComments,
    composerScrollGestureRef,
    composerSubmissionError,
    composerTerminalContexts,
    composerTerminalContextsRef,
    draftId,
    getComposerDraft,
    isComposerApprovalState,
    isComposerCollapsedMobile,
    prompt,
    promptRef,
    resetComposerTrigger,
    selectedModel,
    selectedPromptEffort,
    selectedProvider,
    setComposerCursor,
    setComposerHighlightedItemId,
    setComposerHighlightedSearchKey,
    setComposerSubmissionError,
    setIsComposerFooterCompact,
    setIsComposerPrimaryActionsCompact,
    setIsComposerScrollCollapsed,
    setIsDragOverComposer,
    setProviderInputSubmissionError,
    syncComposerDraftPersistedAttachments,
  });

  const {
    onPromptChange,
    applyPromptReplacement,
    readComposerSnapshot,
    resolveActiveComposerTrigger,
    onSelectComposerItem,
    onComposerMenuItemHighlighted,
    nudgeComposerMenuHighlight,
    blurMobileComposerAfterSend,
  } = useComposerPromptHandlers({
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
  });

  const {
    submitComposer,
    submitCitationAndSend,
    compactThreadContext,
    expandMobileComposer,
    onComposerCommandKey,
  } = useComposerSubmitHandlers({
    activeComposerMenuItemRef,
    activePendingApproval,
    activePendingProgress,
    activePendingResolvedAnswers,
    activeThreadId,
    applyPromptReplacement,
    attachmentTargetKey,
    blurMobileComposerAfterSend,
    compactDisabled,
    composerBlurFrameRef,
    composerDraftTarget,
    composerEditorRef,
    composerFilesRef,
    composerImagesRef,
    composerMenuItemsRef,
    composerMenuOpenRef,
    composerPreviewAnnotations,
    composerReviewComments,
    composerSendState,
    composerTerminalContextsRef,
    dismissComposerTrigger,
    environmentUnavailable,
    isComposerApprovalState,
    isConnecting,
    isMobileViewport,
    isSendBusy,
    isSendDisabled,
    mobileComposerExpandFrameRef,
    mobileComposerExpandInFlightRef,
    mobileComposerExpandReleaseFrameRef,
    noProviderAvailable,
    nudgeComposerMenuHighlight,
    onCompactContext,
    onSelectComposerItem,
    onSend,
    pendingImageCompressionsRef,
    pendingUserInputs,
    phase,
    planModeUiEnabled,
    promptHistoryMessages,
    promptHistoryPositionRef,
    promptRef,
    providerInputRejectedRef,
    readComposerSnapshot,
    resolveActiveComposerTrigger,
    routeKind,
    setComposerCursor,
    setComposerDraftPrompt,
    setComposerHighlightedItemId,
    setComposerSubmissionError,
    setComposerTrigger,
    setIsComposerFocused,
    settings,
    showPlanFollowUpPrompt,
    toggleInteractionMode,
  });

  const { stashQueue, restoreStashEntry, deleteStashEntry, stashCurrentPrompt } = useComposerStash({
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
  });

  const toggleStashMenu = useCallback(() => {
    if (isComposerCollapsedMobile) {
      expandMobileComposer();
      setIsStashMenuOpen(true);
      return;
    }
    setIsStashMenuOpen((open) => !open);
  }, [expandMobileComposer, isComposerCollapsedMobile]);
  const toggleTasksDrawer = useCallback(() => {
    setIsTasksDrawerOpen((open) => !open);
  }, []);
  const hasBannerItems = props.bannerItems.length > 0;
  const hasBlockingComposerTopDrawer =
    activePendingApproval !== null || pendingUserInputs.length > 0;
  const showInlineTasksBadge =
    activeTasksProgress !== null &&
    activeTaskSteps !== null &&
    !isTasksDrawerOpen &&
    !hasBlockingComposerTopDrawer &&
    (hasBannerItems || showComposerTopDrawer || isComposerCollapsedMobile);
  const inlineTasksBadge = showInlineTasksBadge ? (
    <ComposerTasksBadge
      expanded={false}
      onToggle={toggleTasksDrawer}
      placement="inline"
      progress={activeTasksProgress}
      steps={activeTaskSteps}
    />
  ) : null;

  const {
    isComposerResting,
    expandedComposerImages,
    composerControlsInStrip,
    composerControlsHidden,
    collapsedComposerImagePreviews,
    composerMainSurfaceRef,
    composerControls,
  } = useComposerRestingChrome({
    activeThreadId,
    activeThreadModelSelection,
    composerDraftTarget,
    composerImages,
    composerMenuOpen,
    composerProviderState,
    composerScrollCollapseEligibleRef,
    composerScrollCollapseTimeoutRef,
    composerScrollGestureRef,
    composerSubmissionError,
    environmentId,
    environmentUnavailable,
    expandedControlsLayout,
    expandMobileComposer,
    getModelDisabledReason,
    getTimelineScrollableNode,
    handleRuntimeModeChange,
    hasMultilinePrompt,
    interactionMode,
    isComposerCollapsedMobile,
    isComposerModelPickerOpen,
    isComposerScrollCollapsed,
    isDragOverComposer,
    isMobileViewport,
    isPreparingWorktree,
    isSendBusy,
    isStashMenuOpen,
    isTasksDrawerOpen,
    isTimelineAtLogicalEnd,
    keybindings,
    lockedContinuationGroupKey,
    lockedProvider,
    modelOptionsByInstance,
    multipleModelSelections,
    nonPersistedComposerImageIdSet,
    onComposerOverlayHeightChange,
    onExpandImage,
    onOpenProviderSetup,
    onProviderModelSelect,
    onRestingChange,
    onRestingControlsVisibilityChange,
    pendingSnapShotIdSet,
    planModeUiEnabled,
    projectSelectionRequired,
    providerCatalogPending,
    providerInputSubmissionError,
    providerInstanceEntries,
    providerSetupInstanceId,
    providerStatuses,
    providerTraitsMenuContent,
    providerTraitsPicker,
    providerTraitsPickerInput,
    resolvedTheme,
    restingComposerControlsRef,
    restingControlsHaveLeadingContext,
    restingControlsHiddenBlockCount,
    restingControlsIconOnlyBlockCount,
    restingControlsVisible,
    routeKind,
    runtimeMode,
    scheduleComposerFocus,
    selectedInstanceId,
    selectedModelForPickerWithCustomFallback,
    selectedModelSelection,
    setIsComposerFocused,
    setIsComposerModelPickerOpen,
    setIsComposerScrollCollapsed,
    setMultipleModelSelections,
    settings,
    showComposerTopDrawer,
    showInlineTasksBadge,
    showProviderUnavailable,
    standaloneComposerImages,
    supportsAttachmentUploads,
    supportsMultipleModels,
    terminalOpen,
    timelineOverflows,
    toggleInteractionMode,
    uploadsByImageId,
    windowRefocusInFlightRef,
  });
  const showTasksTab =
    !hasBannerItems &&
    !showComposerTopDrawer &&
    !isTasksDrawerOpen &&
    !isComposerCollapsedMobile &&
    activeTasksProgress !== null &&
    activeTaskSteps !== null &&
    activeTasksProgress.totalSteps > 0;
  const activityStackContent = hasBannerItems ? (
    shownSyncPhase ? (
      <ComposerActivityRow phase={shownSyncPhase} />
    ) : !hasBlockingComposerTopDrawer && activeTasksProgress && activeTaskSteps ? (
      <ComposerTasksContent
        expanded={isTasksDrawerOpen}
        onToggle={toggleTasksDrawer}
        progress={activeTasksProgress}
        steps={activeTaskSteps}
      />
    ) : null
  ) : null;
  const activityStackItem: ComposerBannerStackContent | null = activityStackContent
    ? {
        id: "composer-activity",
        variant: "default",
        priority: "activity",
        content: activityStackContent,
      }
    : null;
  const bannerStackItems = activityStackItem
    ? [activityStackItem, ...props.bannerItems]
    : props.bannerItems;
  useEffect(() => {
    if (activeTasksProgress === null || activeTaskSteps === null) {
      setIsTasksDrawerOpen(false);
    }
  }, [activeTaskSteps, activeTasksProgress]);

  useEffect(() => {
    if (hasBlockingComposerTopDrawer) {
      setIsTasksDrawerOpen(false);
    }
  }, [hasBlockingComposerTopDrawer]);

  useEffect(() => {
    setIsTasksDrawerOpen(false);
  }, [activeThreadId]);

  // Close the stash menu whenever the trigger-driven command menu opens so
  // the two popovers never stack in the same layer, and when the user
  // resumes typing (the menu is a transient picker, not a panel).
  useEffect(() => {
    if (composerMenuOpen) {
      setIsStashMenuOpen(false);
    }
  }, [composerMenuOpen]);
  useEffect(() => {
    setIsStashMenuOpen(false);
  }, [prompt]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          terminalOpen,
          modelPickerOpen: isComposerModelPickerOpen,
        },
      });
      if (command !== "composer.stash") return;
      // Always claim the shortcut so the browser save dialog never opens,
      // even when the composer is in a state that can't stash.
      event.preventDefault();
      event.stopPropagation();
      if (isCommandPaletteOpen() || isRevertingCheckpoint) {
        return;
      }
      if (pendingUserInputs.length > 0 && !isComposerApprovalState) {
        setIsStashMenuOpen((open) => !open);
        return;
      }
      if (isComposerApprovalState || projectSelectionRequired || activePendingProgress !== null) {
        return;
      }
      void stashCurrentPrompt();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activePendingProgress,
    isComposerApprovalState,
    isComposerModelPickerOpen,
    keybindings,
    pendingUserInputs.length,
    projectSelectionRequired,
    stashCurrentPrompt,
    isRevertingCheckpoint,
    terminalOpen,
  ]);

  const {
    addComposerAttachments,
    removeComposerImage,
    foldPastedText,
    onComposerPaste,
    insertComposerText,
    insertComposerTextAtEnd,
    insertContextReferencesAtCaret,
  } = useComposerAttachmentHandlers({
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
  });
  const setContextInsertionHandler = useComposerDraftStore(
    (store) => store.setContextInsertionHandler,
  );
  useEffect(() => {
    return setContextInsertionHandler(composerDraftTarget, insertContextReferencesAtCaret);
  }, [composerDraftTarget, insertContextReferencesAtCaret, setContextInsertionHandler]);

  // File-tree drags land as mentions. Handled in the capture phase so the
  // editor never sees the drop; the load-bearing rules (native stop, "move"
  // effect, no eager focus) live in makeComposerMentionDragHandlers.
  const composerMentionDragHandlers = makeComposerMentionDragHandlers({
    insertMentionAtEnd: (text) => insertComposerTextAtEnd(text, { ensureLeadingBoundary: true }),
    setDragActive: setIsDragOverComposer,
    onInsertRejected: () => {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "The composer is busy; try again once it is ready.",
      });
    },
  });

  const onComposerMentionDragLeaveCapture = (event: React.DragEvent<HTMLFormElement>) => {
    if (!dataTransferHasComposerMention(event.dataTransfer.types)) return;
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsDragOverComposer(false);
  };

  // A cancelled drag (Escape) can end without a dragleave on the hovered
  // target, which would leave the drop highlight stuck. dragend always fires
  // on the in-page drag source and bubbles to window, so it is the reset of
  // last resort while the highlight is up.
  useEffect(() => {
    if (!isDragOverComposer) return;
    const onWindowDragEnd = () => {
      setIsDragOverComposer(false);
    };
    window.addEventListener("dragend", onWindowDragEnd);
    return () => window.removeEventListener("dragend", onWindowDragEnd);
  }, [isDragOverComposer]);
  const handleInterruptPrimaryAction = useCallback(() => {
    void onInterrupt();
  }, [onInterrupt]);
  const handleImplementPlanInNewThreadPrimaryAction = useCallback(() => {
    void onImplementPlanInNewThread();
  }, [onImplementPlanInNewThread]);
  // The phone composer collapses when the editor loses focus. Desktop only
  // rests on a timeline scroll, so losing focus there changes nothing.
  const scheduleComposerCollapseCheck = useCallback(() => {
    if (!isMobileViewport || mobileComposerExpandInFlightRef.current) {
      return;
    }
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
    }
    composerBlurFrameRef.current = window.requestAnimationFrame(() => {
      composerBlurFrameRef.current = null;
      if (mobileComposerExpandInFlightRef.current) {
        return;
      }
      const composerSurface = composerSurfaceRef.current;
      const composerForm = composerFormRef.current;
      const activeElement = document.activeElement;
      if (isInsideRestingComposerControlScope(activeElement)) {
        return;
      }
      if (
        activeElement instanceof Node &&
        ((composerSurface && composerSurface.contains(activeElement)) ||
          (composerForm && composerForm.contains(activeElement)))
      ) {
        return;
      }
      setIsComposerFocused(false);
    });
  }, [isMobileViewport, setIsComposerFocused]);

  useEffect(() => {
    return () => {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
      }
      if (mobileComposerExpandFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
      }
      if (mobileComposerExpandReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
      }
    };
  }, []);

  // ------------------------------------------------------------------
  // Imperative handle
  // ------------------------------------------------------------------
  const openModelPicker = useCallback(() => {
    if (composerControlsHidden) {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
        composerBlurFrameRef.current = null;
      }
      setIsComposerScrollCollapsed(false);
      setIsComposerFocused(true);
    }
    setIsComposerModelPickerOpen(true);
  }, [composerControlsHidden, setIsComposerFocused, setIsComposerScrollCollapsed]);

  useComposerImperativeHandle({
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
  });

  // Render
  // ------------------------------------------------------------------
  return (
    <form
      ref={composerFormRef}
      onSubmit={submitComposer}
      onPointerDownCapture={(event) => {
        const target = event.target;
        if (isInsideRestingComposerControlScope(target)) return;
        if (isInsideCollapsedComposerControls(target)) return;
        if (!(target instanceof Element)) return;
        const isInteractive = Boolean(
          target.closest('button, a, input, select, [role="button"], [role="menuitem"]'),
        );
        if (isInteractive) return;

        setIsComposerScrollCollapsed(false);
        if (isComposerResting && !target.closest('[data-testid="composer-editor"]')) {
          // Clicking resting-surface padding would otherwise blur the editor.
          // Treat that padding like the editor without stealing native caret
          // placement from text.
          event.preventDefault();
          setIsComposerFocused(true);
          scheduleComposerFocus();
        }
      }}
      onFocusCapture={(event) => {
        const activeElement = event.target;
        if (composerControlsInStrip && isInsideRestingComposerControlScope(activeElement)) {
          return;
        }
        if (isInsideCollapsedComposerControls(activeElement)) {
          return;
        }
        // Focus returning from another window or tab lands on the element
        // that already held it, which is not a request to expand a
        // scroll-collapsed composer.
        if (!windowRefocusInFlightRef.current) {
          setIsComposerScrollCollapsed(false);
        }
        if (composerBlurFrameRef.current !== null) {
          window.cancelAnimationFrame(composerBlurFrameRef.current);
          composerBlurFrameRef.current = null;
        }
        setIsComposerFocused(true);
      }}
      onBlurCapture={() => {
        scheduleComposerCollapseCheck();
      }}
      onDragEnterCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDragEnter(event);
      }}
      onDragOverCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDragOver(event);
      }}
      onDragLeaveCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        onComposerMentionDragLeaveCapture(event);
      }}
      onDropCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDrop(event);
      }}
      className="mx-auto w-full min-w-0 max-w-(--chat-max-width)"
      data-chat-composer-form="true"
    >
      {composerControlsInStrip && restingControlsHost
        ? createPortal(
            <div
              ref={attachRestingComposerControls}
              data-chat-composer-resting-controls="true"
              aria-hidden={restingControlsVisible ? undefined : true}
              inert={restingControlsVisible ? undefined : true}
              className={cn(
                "relative flex w-max min-w-0 max-w-full items-center gap-1 font-normal text-muted-foreground/70 [&_button]:text-xs!",
                !restingControlsVisible && "invisible",
              )}
            >
              {composerControls}
            </div>,
            restingControlsHost,
          )
        : null}
      <ComposerBanner.Dock>
        <ComposerBanner.Column>
          <ComposerBannerStack
            key={activeThreadId}
            className="relative z-0"
            items={bannerStackItems}
          />
          {!activityStackItem && (shownSyncPhase || inlineTasksBadge) ? (
            <ComposerBanner.Attachment>
              <ComposerBanner.Root data-chat-composer-activity-strip="true">
                {shownSyncPhase ? <ComposerActivityRow phase={shownSyncPhase} /> : inlineTasksBadge}
              </ComposerBanner.Root>
            </ComposerBanner.Attachment>
          ) : null}
          {showComposerTopDrawer && (!isTasksDrawerOpen || hasBlockingComposerTopDrawer) ? (
            <ComposerBanner.Attachment>
              <ComposerBanner.Root
                data-chat-composer-top-drawer="true"
                variant={activePendingApproval ? "warning" : "info"}
                density={activePendingApproval ? "spacious" : "default"}
              >
                {activePendingApproval ? (
                  <ComposerBanner.Row
                    layout="approval"
                    data-chat-composer-collapsed-controls="true"
                  >
                    <ComposerBanner.Icon>
                      <ShieldIcon />
                    </ComposerBanner.Icon>
                    <ComposerBanner.Content>
                      <ComposerPendingApprovalPanel
                        approval={activePendingApproval}
                        pendingCount={pendingApprovals.length}
                      />
                    </ComposerBanner.Content>
                    <ComposerBanner.Actions>
                      <ComposerPendingApprovalActions
                        requestId={activePendingApproval.requestId}
                        isResponding={respondingRequestIds.includes(
                          activePendingApproval.requestId,
                        )}
                        options={activePendingApproval.options}
                        onRespondToApproval={onRespondToApproval}
                      />
                    </ComposerBanner.Actions>
                  </ComposerBanner.Row>
                ) : !isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    respondingRequestIds={
                      activePendingIsResponding && activePendingUserInput
                        ? [...respondingRequestIds, activePendingUserInput.requestId]
                        : respondingRequestIds
                    }
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onToggleOption={onSelectActivePendingUserInputOption}
                    onAdvance={onAdvanceActivePendingUserInput}
                    onDismiss={onDismissActivePendingUserInput}
                  />
                ) : !isComposerCollapsedMobile && showPlanFollowUpPrompt && activeProposedPlan ? (
                  <ComposerPlanFollowUpBanner
                    key={activeProposedPlan.id}
                    planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                  />
                ) : isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
                  <div data-chat-composer-collapsed-controls="true">
                    <ComposerPendingUserInputPanel
                      pendingUserInputs={pendingUserInputs}
                      respondingRequestIds={
                        activePendingIsResponding && activePendingUserInput
                          ? [...respondingRequestIds, activePendingUserInput.requestId]
                          : respondingRequestIds
                      }
                      answers={activePendingDraftAnswers}
                      questionIndex={activePendingQuestionIndex}
                      onToggleOption={onSelectActivePendingUserInputOption}
                      onAdvance={onAdvanceActivePendingUserInput}
                      onDismiss={onDismissActivePendingUserInput}
                    />
                    {!isChoiceOnlyPendingQuestion ||
                    activePendingProgress?.activeQuestion?.multiSelect ? (
                      <ComposerBanner.Body>
                        <div
                          data-chat-composer-mobile-pending-compact="true"
                          className={cn(
                            "flex min-w-0 items-center gap-2 rounded-lg border border-border/55 bg-background/55 p-1.5 pl-3 transition-colors hover:bg-background/80",
                            !activePendingProgress?.activeQuestion?.multiSelect && "p-0",
                          )}
                        >
                          {!isChoiceOnlyPendingQuestion ? (
                            <button
                              type="button"
                              className={cn(
                                "min-w-0 flex-1 truncate bg-transparent py-1.5 text-left text-sm",
                                activePendingProgress?.customAnswer
                                  ? "text-foreground"
                                  : "text-placeholder",
                                !activePendingProgress?.activeQuestion?.multiSelect && "px-3 py-2",
                              )}
                              onPointerDown={(event) => event.preventDefault()}
                              onClick={expandMobileComposer}
                              aria-label="Write custom answer"
                            >
                              {activePendingProgress?.customAnswer || "Write custom answer"}
                            </button>
                          ) : null}
                          {activePendingProgress?.activeQuestion?.multiSelect ? (
                            <ComposerPrimaryActions
                              compact
                              pendingAction={pendingPrimaryAction}
                              isRunning={false}
                              showPlanFollowUpPrompt={false}
                              promptHasText={false}
                              isSendBusy={isSendBusy}
                              sendDisabledReason={sendDisabledReason}
                              isConnecting={isConnecting}
                              isEnvironmentUnavailable={
                                environmentUnavailable !== null ||
                                noProviderAvailable ||
                                projectSelectionRequired
                              }
                              isPreparingWorktree={false}
                              hasSendableContent={false}
                              preserveComposerFocusOnPointerDown
                              onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                              onInterrupt={handleInterruptPrimaryAction}
                              onImplementPlanInNewThread={
                                handleImplementPlanInNewThreadPrimaryAction
                              }
                            />
                          ) : null}
                        </div>
                      </ComposerBanner.Body>
                    ) : null}
                  </div>
                ) : null}
              </ComposerBanner.Root>
            </ComposerBanner.Attachment>
          ) : null}
          {!activityStackItem &&
          isTasksDrawerOpen &&
          !hasBlockingComposerTopDrawer &&
          activeTasksProgress &&
          activeTaskSteps ? (
            <ComposerTasksDrawer
              onCollapse={toggleTasksDrawer}
              progress={activeTasksProgress}
              steps={activeTaskSteps}
            />
          ) : null}
          {showTasksTab ? (
            <ComposerBanner.Attachment>
              <ComposerTasksBadge
                expanded={false}
                onToggle={toggleTasksDrawer}
                progress={activeTasksProgress}
                steps={activeTaskSteps}
              />
            </ComposerBanner.Attachment>
          ) : null}
        </ComposerBanner.Column>
        {!isComposerApprovalState ? (
          <ComposerStashBadge
            count={stashQueue.length}
            menuOpen={isStashMenuOpen}
            pulseKey={stashPulse.key}
            pulsing={stashPulse.active}
            onToggleMenu={toggleStashMenu}
          />
        ) : null}
      </ComposerBanner.Dock>
      <div className="relative">
        <ComposerSurface.Main
          ref={composerMainSurfaceRef}
          className={composerProviderState.composerFrameClassName}
        >
          <div
            ref={composerSurfaceRef}
            data-chat-composer-surface="true"
            data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
            className={cn(
              "rounded-3xl transition-[background-color] duration-200",
              isDragOverComposer ? "bg-accent/45 ring-1 ring-primary/70" : null,
              projectSelectionRequired ? "opacity-75" : null,
              composerProviderState.composerSurfaceClassName,
            )}
          >
            {showCollapsedMobilePromptRow ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <button
                  type="button"
                  data-chat-composer-transition-prompt="true"
                  className={cn(
                    "min-w-0 flex-1 truncate bg-transparent p-0 text-left text-sm focus:outline-none",
                    (activePendingProgress ? activePendingProgress.customAnswer : prompt.trim())
                      ? "text-foreground"
                      : "text-placeholder",
                  )}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={isChoiceOnlyPendingQuestion ? undefined : expandMobileComposer}
                  disabled={isChoiceOnlyPendingQuestion}
                  aria-label="Expand composer"
                >
                  {activePendingProgress
                    ? isChoiceOnlyPendingQuestion
                      ? "Choose an option above"
                      : activePendingProgress.customAnswer ||
                        "Type your own answer, or leave this blank to use the selected option"
                    : prompt.trim() ||
                      (showProviderUnavailable
                        ? "Enable a provider in Settings"
                        : (runningComposerPlaceholder ?? "Ask anything..."))}
                </button>
                {collapsedComposerImagePreviews}
                <button
                  type="button"
                  data-chat-composer-transition-actions="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover disabled:opacity-64"
                  disabled={collapsedComposerPrimaryActionDisabled}
                  aria-label={collapsedComposerPrimaryActionLabel}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    submitComposer();
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M8 3L8 13M8 3L4 7M8 3L12 7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            ) : null}

            <div
              ref={setComposerMenuAnchor}
              data-chat-composer-body="true"
              className={cn(
                "relative px-3 pb-2 sm:px-4",
                "pt-3.5 sm:pt-4",
                isComposerApprovalState && "pb-3 sm:pb-4",
                isComposerCollapsedMobile && "hidden",
                isComposerResting && "py-2 sm:py-2",
              )}
            >
              {isStashMenuOpen && !composerMenuOpen && !isComposerApprovalState && (
                <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                  <ComposerStashMenu
                    entries={stashQueue}
                    stashShortcutLabel={shortcutLabelForCommand(keybindings, "composer.stash", {
                      context: {
                        terminalFocus: false,
                        terminalOpen,
                        modelPickerOpen: false,
                      },
                    })}
                    onRestore={restoreStashEntry}
                    onDelete={deleteStashEntry}
                    onClose={() => setIsStashMenuOpen(false)}
                  />
                </ComposerCommandMenuLayer>
              )}

              {composerMenuOpen && !isComposerApprovalState && (
                <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                  <ComposerCommandMenu
                    items={composerMenuItems}
                    resolvedTheme={resolvedTheme}
                    isLoading={isComposerMenuLoading}
                    triggerKind={composerTriggerKind}
                    emptyStateText={composerMenuEmptyState}
                    activeItemId={activeComposerMenuItem?.id ?? null}
                    onHighlightedItemChange={onComposerMenuItemHighlighted}
                    onSelect={onSelectComposerItem}
                  />
                </ComposerCommandMenuLayer>
              )}

              {!isComposerCollapsedMobile &&
                !isComposerApprovalState &&
                (uncommittedSnapShotIds.length > 0 ||
                  composerVideos.length > 0 ||
                  expandedComposerImages.length > 0) && (
                  <div
                    className={cn(
                      "mb-3 flex max-w-full gap-2",
                      pendingSnapShotIds.length > 0 ||
                        expandedComposerImages.some((image) => image.source?.kind === "snap-shot")
                        ? "snap-x snap-proximity overflow-x-auto overscroll-x-contain pb-1 scrollbar-thumb-foreground/18 scrollbar-track-transparent [scrollbar-width:thin] [&::-webkit-scrollbar]:h-2.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-3 [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-foreground/18 [&::-webkit-scrollbar-thumb]:bg-clip-content [&::-webkit-scrollbar-thumb:hover]:bg-foreground/28 [&::-webkit-scrollbar-track]:mx-1 [&::-webkit-scrollbar-track]:bg-transparent"
                        : "flex-wrap",
                    )}
                  >
                    {expandedComposerImages
                      .map((image) => {
                        const upload = supportsAttachmentUploads
                          ? uploadsByImageId[image.id]
                          : undefined;
                        const snapShotAnimationPending =
                          image.source?.kind === "snap-shot" && pendingSnapShotIdSet.has(image.id);
                        const snapShotArrival =
                          image.source?.kind === "snap-shot" &&
                          shouldAnimateSnapShotArrival(image.source.capturedAt);
                        return (
                          <SnapShotAttachmentFrame
                            key={image.id}
                            data-chat-composer-expanded-image="true"
                            aria-hidden={snapShotAnimationPending || undefined}
                            inert={snapShotAnimationPending || undefined}
                            arrival={snapShotArrival}
                            animateArrival={
                              settings.snapShotAnimations &&
                              !snapShotAnimationPending &&
                              snapShotArrival
                            }
                            animationId={snapShotAnimationPending ? image.id : undefined}
                            animationSource={snapShotAnimationPending ? image.source : undefined}
                            className={cn(
                              "group/attachment shrink-0 snap-start bg-background",
                              image.source?.kind === "snap-shot"
                                ? SNAP_SHOT_ATTACHMENT_FRAME_CLASS
                                : "relative h-16 w-16 overflow-hidden rounded-lg border border-border/80",
                              snapShotAnimationPending && "invisible",
                            )}
                          >
                            {image.previewUrl ? (
                              <button
                                type="button"
                                className="h-full w-full cursor-zoom-in"
                                aria-label={`Preview ${image.name}`}
                                onClick={() => {
                                  const preview = buildExpandedImagePreview(
                                    composerImages,
                                    image.id,
                                  );
                                  if (!preview) return;
                                  onExpandImage(preview);
                                }}
                              >
                                <ComposerImageThumbnail
                                  file={image.file}
                                  alt={image.name}
                                  className="h-full w-full object-cover"
                                  fallback={
                                    <span className="flex h-full items-center justify-center px-1 text-3xs text-secondary-label">
                                      {image.name}
                                    </span>
                                  }
                                />
                              </button>
                            ) : (
                              <div className="flex h-full w-full items-center justify-center px-1 text-center text-3xs text-secondary-label">
                                {image.name}
                              </div>
                            )}
                            {image.source?.kind === "snap-shot" ? (
                              <SnapShotAttachmentDetails
                                source={image.source}
                                className={cn(
                                  upload?.status === "uploading" && "bottom-4",
                                  upload?.status === "failed" && "bottom-8",
                                )}
                              />
                            ) : null}
                            {nonPersistedComposerImageIdSet.has(image.id) && (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <span
                                      role="img"
                                      aria-label="Draft attachment may not persist"
                                      className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-warning-foreground"
                                    >
                                      <CircleAlertIcon className="size-3" />
                                    </span>
                                  }
                                />
                                <TooltipPopup side="top">
                                  Draft attachment could not be saved locally and may be lost on
                                  navigation.
                                </TooltipPopup>
                              </Tooltip>
                            )}
                            {upload?.status === "uploading" && (
                              <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground">
                                {formatAttachmentUploadProgress(upload.progress)}
                              </span>
                            )}
                            {upload?.status === "failed" && (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="overlay"
                                      size="icon-xs"
                                      className="absolute bottom-1 left-1"
                                      onClick={() =>
                                        retryAttachmentUpload({
                                          environmentId,
                                          image,
                                          draftTarget: attachmentDraftTarget,
                                        })
                                      }
                                      aria-label={`Retry upload for ${image.name}`}
                                    />
                                  }
                                >
                                  <RefreshIcon />
                                </TooltipTrigger>
                                <TooltipPopup side="top">{upload.reason}</TooltipPopup>
                              </Tooltip>
                            )}
                            {/* Snap-shot frames reveal their remove button on hover or focus. */}
                            <span
                              className={cn(
                                "absolute right-1 top-1 flex",
                                image.source?.kind === "snap-shot" &&
                                  "opacity-0 transition-opacity pointer-coarse:opacity-100 group-hover/attachment:opacity-100 group-focus-within/attachment:opacity-100",
                              )}
                            >
                              <Button
                                variant="media-close"
                                size="icon-xs"
                                onClick={() => removeComposerImage(image.id)}
                                aria-label={`Remove ${image.name}`}
                              >
                                <XIcon />
                              </Button>
                            </span>
                          </SnapShotAttachmentFrame>
                        );
                      })
                      .concat(
                        uncommittedSnapShotIds.map((captureId) => (
                          <SnapShotAttachmentFrame
                            key={captureId}
                            aria-hidden="true"
                            animationId={captureId}
                            animationSource={
                              pendingSnapShotAnimations.find((capture) => capture.id === captureId)
                                ?.source
                            }
                            className={cn(
                              SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
                              "invisible shrink-0 snap-start bg-background",
                            )}
                          />
                        )),
                      )}
                    {composerVideos.map((file) => {
                      const fileCanUpload =
                        supportsAttachmentUploads &&
                        maxFileAttachmentBytes !== null &&
                        file.sizeBytes <= maxFileAttachmentBytes;
                      const upload = fileCanUpload ? uploadsByImageId[file.id] : undefined;
                      return (
                        <div
                          key={file.id}
                          className="relative h-16 w-16 shrink-0 snap-start overflow-hidden rounded-lg border border-border/80 bg-black"
                        >
                          <button
                            type="button"
                            className="flex h-full w-full cursor-zoom-in flex-col items-center justify-center gap-1 px-1 text-white"
                            aria-label={`Play ${file.name}`}
                            onClick={() => {
                              if (file.file !== null) {
                                const preview = buildExpandedImagePreview([file], file.id);
                                if (preview) onExpandImage(preview);
                                return;
                              }
                              if (!file.uploadedAttachmentId) return;
                              onFileOpen({ ...file, id: file.uploadedAttachmentId });
                            }}
                          >
                            {file.file && (
                              <>
                                <ComposerVideoThumbnail file={file.file} />
                                <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/10" />
                              </>
                            )}
                            <PlayIcon className="relative z-10 size-4 fill-current drop-shadow-md" />
                          </button>
                          {upload?.status === "uploading" && (
                            <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground">
                              {formatAttachmentUploadProgress(upload.progress)}
                            </span>
                          )}
                          {upload?.status === "failed" && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    variant="overlay"
                                    size="icon-xs"
                                    className="absolute bottom-1 left-1"
                                    onClick={() =>
                                      retryAttachmentUpload({
                                        environmentId,
                                        image: file,
                                        draftTarget: attachmentDraftTarget,
                                      })
                                    }
                                    aria-label={`Retry upload for ${file.name}`}
                                  />
                                }
                              >
                                <RefreshIcon />
                              </TooltipTrigger>
                              <TooltipPopup side="top">{upload.reason}</TooltipPopup>
                            </Tooltip>
                          )}
                          <Button
                            variant="media-close"
                            size="icon-xs"
                            className="absolute right-1 top-1"
                            onClick={() => removeComposerFileFromDraft(file.id)}
                            aria-label={`Remove ${file.name}`}
                          >
                            <XIcon />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}

              {!isComposerCollapsedMobile &&
                !isComposerApprovalState &&
                composerOtherFiles.length > 0 && (
                  <div className="mb-3 flex flex-col gap-1">
                    {composerOtherFiles.map((file) => {
                      const fileCanUpload =
                        supportsAttachmentUploads &&
                        maxFileAttachmentBytes !== null &&
                        file.sizeBytes <= maxFileAttachmentBytes;
                      const upload = fileCanUpload ? uploadsByImageId[file.id] : undefined;
                      const needsReattach = composerFileNeedsReattach(file);
                      const canReattachFile =
                        fileStagingLimit !== null && file.sizeBytes <= fileStagingLimit;
                      return (
                        <div
                          key={file.id}
                          className="flex min-w-0 items-center gap-2 py-1 text-sm text-foreground"
                        >
                          <PierreEntryIcon
                            pathValue={file.name}
                            kind="file"
                            theme={resolvedTheme}
                          />
                          <button
                            type="button"
                            disabled={needsReattach}
                            className="min-w-0 flex-1 truncate text-left hover:underline focus-visible:outline-2"
                            onClick={() => setPreviewFileId(file.id)}
                          >
                            {file.name}
                          </button>
                          <span className="shrink-0 text-xs text-secondary-label">
                            {needsReattach
                              ? canReattachFile
                                ? "Attach again"
                                : "Remove to send"
                              : upload?.status === "uploading"
                                ? formatAttachmentUploadProgress(upload.progress)
                                : formatAttachmentSize(file.sizeBytes)}
                          </span>
                          {!needsReattach && upload?.status === "failed" ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() =>
                                      retryAttachmentUpload({
                                        environmentId,
                                        image: file,
                                        draftTarget: attachmentDraftTarget,
                                      })
                                    }
                                    aria-label={`Retry upload for ${file.name}`}
                                  />
                                }
                              >
                                <RefreshIcon />
                              </TooltipTrigger>
                              <TooltipPopup side="top">{upload.reason}</TooltipPopup>
                            </Tooltip>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => removeComposerFileFromDraft(file.id)}
                            aria-label={`Remove ${file.name}`}
                          >
                            <XIcon />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}

              <div
                className={cn(
                  "relative",
                  isComposerResting && "flex min-w-0 items-center gap-1",
                  isComposerResting &&
                    ((settings.contextWindowMeterEnabled && activeContextWindow) ||
                    reserveContextWindowMeter
                      ? "pr-28"
                      : showComposerAttachAction
                        ? "pr-20"
                        : "pr-12"),
                )}
              >
                {previewFile ? (
                  <Dialog
                    open
                    onOpenChange={(open) => {
                      if (!open) setPreviewFileId(null);
                    }}
                  >
                    <DialogPopup
                      {...composerFloatingLayerProps}
                      className="h-[min(85vh,52rem)] max-w-4xl overflow-hidden"
                      showCloseButton={false}
                    >
                      <DialogTitle className="sr-only">{previewFile.name}</DialogTitle>
                      <AttachmentFilePreview
                        key={previewFile.id}
                        name={previewFile.name}
                        mimeType={previewFile.mimeType}
                        sizeBytes={previewFile.sizeBytes}
                        file={previewFile.file}
                        origin="Draft"
                        {...(previewFile.uploadedAttachmentId && previewFile.uploadEnvironmentId
                          ? {
                              asset: {
                                environmentId: previewFile.uploadEnvironmentId,
                                attachmentId: previewFile.uploadedAttachmentId,
                              },
                            }
                          : {})}
                        onRemove={() => {
                          removeComposerFileFromDraft(previewFile.id);
                          setPreviewFileId(null);
                        }}
                        onClose={() => setPreviewFileId(null)}
                      />
                    </DialogPopup>
                  </Dialog>
                ) : null}
                <ComposerContextActionsContext value={composerContextActions}>
                  <ProjectMemoryTitleProvider
                    environmentId={environmentId}
                    projectId={
                      projectMemoryCapability !== null &&
                      (projectMemoryGate?.pickerVisible ||
                        composerProjectMemoryReferences.length > 0)
                        ? projectMemoryCapability.projectId
                        : null
                    }
                  >
                    <ComposerPromptEditor
                      editorRef={composerEditorRef}
                      richTextEnabled={settings.composerRichTextEnabled}
                      value={
                        isComposerApprovalState
                          ? ""
                          : activePendingProgress
                            ? activePendingProgress.customAnswer
                            : prompt
                      }
                      cursor={composerCursor}
                      contextRecords={composerContextRecords}
                      buildContextClipboardFragment={buildContextClipboardFragment}
                      importContextFragment={importContextFragment}
                      skills={selectedProviderSkills}
                      containerClassName={cn(isComposerResting && "min-w-0 flex-1")}
                      className={cn(
                        showMobilePendingAnswerActions && "max-sm:pb-12",
                        isComposerResting &&
                          "my-0 max-h-8 min-h-8 overflow-hidden py-0 whitespace-pre! leading-8",
                        isComposerApprovalState && "min-h-10",
                      )}
                      placeholderClassName={cn(
                        isComposerResting &&
                          "flex items-center overflow-hidden whitespace-nowrap leading-8",
                      )}
                      onChange={onPromptChange}
                      onVisibleSelectionChange={expandComposerForEditorChange}
                      onCommandKeyDown={onComposerCommandKey}
                      onPageScrollKeyDown={onPageScrollKeyDown}
                      onPageScrollKeyUp={onPageScrollKeyUp}
                      onPageScrollRelease={onPageScrollRelease}
                      onCitationSubmitAndSend={submitCitationAndSend}
                      onPaste={onComposerPaste}
                      placeholder={
                        isComposerApprovalState
                          ? "Resolve this approval request to continue"
                          : activePendingProgress
                            ? isChoiceOnlyPendingQuestion
                              ? "Choose an option above"
                              : "Type your own answer, or leave this blank to use the selected option"
                            : showPlanFollowUpPrompt && activeProposedPlan
                              ? "Add feedback to refine the plan, or leave this blank to implement it"
                              : projectSelectionRequired
                                ? "Choose a project above to start a thread"
                                : showProviderUnavailable
                                  ? "Enable a provider in Settings to send a message"
                                  : phase === "disconnected"
                                    ? DISCONNECTED_COMPOSER_PLACEHOLDER
                                    : (runningComposerPlaceholder ??
                                      "Ask anything, @tag files/folders, $use skills, or / for commands")
                      }
                      disabled={
                        isConnecting ||
                        isComposerApprovalState ||
                        projectSelectionRequired ||
                        isChoiceOnlyPendingQuestion ||
                        activePendingIsResponding
                      }
                    />
                  </ProjectMemoryTitleProvider>
                </ComposerContextActionsContext>
                {isComposerResting ? collapsedComposerImagePreviews : null}
                {showMobilePendingAnswerActions ? (
                  <div
                    data-chat-composer-mobile-pending-actions="true"
                    className="absolute bottom-0 right-0 flex items-center justify-end gap-1"
                  >
                    <ComposerPrimaryActions
                      compact
                      pendingAction={pendingPrimaryAction}
                      isRunning={false}
                      showPlanFollowUpPrompt={false}
                      promptHasText={false}
                      isSendBusy={isSendBusy}
                      sendDisabledReason={sendDisabledReason}
                      isConnecting={isConnecting}
                      isEnvironmentUnavailable={
                        environmentUnavailable !== null ||
                        noProviderAvailable ||
                        projectSelectionRequired
                      }
                      isPreparingWorktree={false}
                      hasSendableContent={false}
                      preserveComposerFocusOnPointerDown
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={handleInterruptPrimaryAction}
                      onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                    />
                  </div>
                ) : null}
              </div>
            </div>

            <ComposerPromptLengthValidation
              message={providerInputSubmissionError ?? composerSubmissionError}
            />
            {projectMemoryGate?.warnExistingReferences ? <ProjectMemoryUnsupportedWarning /> : null}

            {/* Bottom toolbar */}
            {isComposerCollapsedMobile || isComposerApprovalState ? null : (
              <div
                data-chat-composer-footer="true"
                data-chat-composer-footer-compact={isComposerFooterCompact ? "true" : "false"}
                className={cn(
                  "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4",
                  pendingUserInputs.length > 0 && "pt-2",
                  isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
                  showMobilePendingAnswerActions && "hidden sm:flex",
                  isComposerResting &&
                    "absolute bottom-px right-px z-10 h-12 w-auto gap-0 py-0 sm:gap-0 sm:py-0",
                )}
              >
                <div
                  ref={expandedControlsLayout.attachControls}
                  data-chat-composer-controls="left"
                  data-chat-composer-footer-controls="true"
                  className={cn(
                    "relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                    isComposerResting && "hidden",
                  )}
                >
                  {composerControlsInStrip ? null : composerControls}
                </div>

                {/* Right side: send / stop button */}
                <div
                  data-chat-composer-actions="right"
                  data-chat-composer-transition-actions="true"
                  data-chat-composer-primary-actions-compact={
                    isComposerPrimaryActionsCompact ? "true" : "false"
                  }
                  className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
                >
                  {projectMemoryCapability !== null && projectMemoryGate?.pickerVisible ? (
                    <ProjectMemoryComposerControl
                      environmentId={environmentId}
                      projectId={projectMemoryCapability.projectId}
                      composerDraftTarget={composerDraftTarget}
                      gate={projectMemoryGate}
                      // Both callbacks re-resolve the CURRENT store/shell/
                      // catalog at mutation time via the shared reader — the
                      // render values here are only the initial closures.
                      readServerThreadInsertionInstanceId={() =>
                        typeof composerDraftTarget !== "string"
                          ? readCurrentServerThreadInsertionScope({
                              environmentId,
                              threadRef: composerDraftTarget,
                            }).instanceId
                          : null
                      }
                      readServerThreadProjectId={() =>
                        typeof composerDraftTarget !== "string"
                          ? readCurrentServerThreadInsertionScope({
                              environmentId,
                              threadRef: composerDraftTarget,
                            }).projectId
                          : null
                      }
                    />
                  ) : null}
                  {showComposerAttachAction ? (
                    <>
                      <input
                        ref={attachmentInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                          const files = Array.from(event.currentTarget.files ?? []);
                          event.currentTarget.value = "";
                          // Inserting a chip refocuses the editor after the draft renders;
                          // focusing synchronously here would report the editor's stale text
                          // over the prompt that was just written.
                          void addComposerAttachments(files).then((inserted) => {
                            if (!inserted) focusComposer();
                          });
                        }}
                      />
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onPointerDown={(event) => event.preventDefault()}
                              onClick={() => attachmentInputRef.current?.click()}
                              aria-label="Attach files"
                            />
                          }
                        >
                          <PaperclipIcon />
                        </TooltipTrigger>
                        <TooltipPopup>Attach files</TooltipPopup>
                      </Tooltip>
                    </>
                  ) : null}
                  <ComposerFooterPrimaryActions
                    compact={isComposerResting || isComposerPrimaryActionsCompact}
                    activeContextWindow={
                      settings.contextWindowMeterEnabled ? activeContextWindow : null
                    }
                    reserveContextWindowMeter={reserveContextWindowMeter}
                    activeThreadModelDisplayName={activeThreadModelDisplayName}
                    pendingAction={pendingPrimaryAction}
                    isRunning={phase === "running"}
                    showPlanFollowUpPrompt={
                      pendingUserInputs.length === 0 && showPlanFollowUpPrompt
                    }
                    promptHasText={prompt.trim().length > 0}
                    isSendBusy={isSendBusy}
                    sendDisabledReason={sendDisabledReason}
                    isConnecting={isConnecting}
                    isEnvironmentUnavailable={
                      environmentUnavailable !== null ||
                      noProviderAvailable ||
                      projectSelectionRequired
                    }
                    isPreparingWorktree={isPreparingWorktree}
                    hasSendableContent={composerSendState.hasSendableContent}
                    preserveComposerFocusOnPointerDown={isMobileViewport || isComposerResting}
                    onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                    onInterrupt={handleInterruptPrimaryAction}
                    onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                    compactDisabled={
                      compactDisabled || noProviderAvailable || isSendBusy || isConnecting
                    }
                    compactDisabledReason={resolvedCompactDisabledReason}
                    {...(compactCommandAvailable ? { onCompactContext: compactThreadContext } : {})}
                  />
                </div>
              </div>
            )}
          </div>
        </ComposerSurface.Main>
      </div>
    </form>
  );
});
