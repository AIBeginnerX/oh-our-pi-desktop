import {
  COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX,
  COMPOSER_SCROLL_GESTURE_RESET_MS,
  useComposerRestingTransition,
} from "./ChatComposer.restingLayout";
import { ComposerFooterModeControls } from "./ChatComposer.footer";
import { CrewChip } from "./CrewChip";
import { GoalChip } from "./GoalChip";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useEffect, useLayoutEffect } from "react";
import { type ComposerImageAttachment } from "../../composerDraftStore";
import {
  getRestingComposerImagePreviewCounts,
  shouldUseRestingComposerLayout,
} from "../composerFooterLayout";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerImageThumbnail } from "./ComposerImageThumbnail";
import { ComposerControl, ComposerControlSeparator } from "./ComposerControl";
import { renderProviderTraitsPicker } from "./composerProviderState";
import { buildExpandedImagePreview } from "./ExpandedImagePreview";
import { cn } from "~/lib/utils";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { isTimelineScrollTarget } from "./timelineScrollTarget";
import {
  recordComposerScrollGestureEvent,
  resetComposerScrollGesture,
} from "./composerScrollGesture";
import { CircleAlertIcon } from "lucide-react";
import { type ProviderInstanceEntry } from "../../providerInstances";
import { type AppModelOption } from "../../modelSelection";
import { usePanelAnimationSettings } from "../../panelAnimations";
import { ThreadId, RuntimeMode, KeybindingWhenNode } from "@t3tools/contracts";
import { DraftId } from "../../composerDraftStore";
import { ComposerProviderState } from "./composerProviderState";
import { RefObject, ReactNode, Dispatch, SetStateAction } from "react";
import { ComposerScrollGestureState } from "./composerScrollGesture";
import { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { ExpandedImagePreview } from "./ExpandedImagePreview";
import { UnifiedSettings } from "@t3tools/contracts/settings";
import { AttachmentUploadState } from "../../lib/attachmentUploadState";

export function useComposerRestingChrome(args: {
  activeThreadId: ThreadId | null;
  activeThreadModelSelection:
    | {
        readonly instanceId: ProviderInstanceId;
        readonly model: string;
        readonly options?: readonly { readonly id: string; readonly value: string | boolean }[];
      }
    | null
    | undefined;
  composerDraftTarget:
    | { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
    | DraftId;
  composerImages: ComposerImageAttachment[];
  composerMenuOpen: boolean;
  composerProviderState: ComposerProviderState;
  composerScrollCollapseEligibleRef: RefObject<boolean>;
  composerScrollCollapseTimeoutRef: RefObject<number | null>;
  composerScrollGestureRef: RefObject<ComposerScrollGestureState>;
  composerSubmissionError: string | null;
  environmentId: EnvironmentId;
  environmentUnavailable: {
    readonly label: string;
    readonly connection: EnvironmentConnectionPresentation;
  } | null;
  expandedControlsLayout: {
    controlsRef: RefObject<HTMLDivElement | null>;
    attachControls: (element: HTMLDivElement | null) => void;
    hiddenBlockCount: number;
    iconOnlyBlockCount: number;
    controlsVisible: boolean;
  };
  expandMobileComposer: () => void;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  getTimelineScrollableNode: () => HTMLElement | null;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  hasMultilinePrompt: boolean;
  interactionMode: "default" | "plan";
  isComposerCollapsedMobile: boolean;
  isComposerModelPickerOpen: boolean;
  isComposerScrollCollapsed: boolean;
  isDragOverComposer: boolean;
  isMobileViewport: boolean;
  isPreparingWorktree: boolean;
  isSendBusy: boolean;
  isStashMenuOpen: boolean;
  isTasksDrawerOpen: boolean;
  isTimelineAtLogicalEnd: () => boolean;
  keybindings: readonly {
    readonly command:
      | "sidebar.toggle"
      | "navigation.back"
      | "navigation.forward"
      | "terminal.toggle"
      | "terminal.split"
      | "terminal.splitVertical"
      | "terminal.new"
      | "terminal.close"
      | "rightPanel.toggle"
      | "rightPanel.toggleMaximized"
      | "rightPanel.close"
      | "pullRequest.copyNumber"
      | "diff.toggle"
      | "diff.nextFile"
      | "diff.previousFile"
      | "diff.toggleViewed"
      | "preview.toggle"
      | "preview.refresh"
      | "preview.focusUrl"
      | "preview.zoomIn"
      | "preview.zoomOut"
      | "preview.resetZoom"
      | "commandPalette.toggle"
      | "filePicker.toggle"
      | "projectSearch.toggle"
      | "usage.open"
      | "workflows.open"
      | "theme.select"
      | "appearance.cycle"
      | "themeEditor.toggle"
      | "composer.stash"
      | "composer.host"
      | "composer.effort"
      | "composer.mode"
      | "composer.workspace"
      | "composer.previousWorktree"
      | "composer.branch"
      | "chat.new"
      | "chat.newLocal"
      | "editor.openFavorite"
      | "usage.cost"
      | "usage.tokens"
      | "usage.limits"
      | "usage.period.day"
      | "usage.period.week"
      | "usage.period.month"
      | "usage.period.quarter"
      | "modelPicker.toggle"
      | "modelPicker.previousProvider"
      | "modelPicker.nextProvider"
      | "modelPicker.jump.1"
      | "modelPicker.jump.2"
      | "modelPicker.jump.3"
      | "modelPicker.jump.4"
      | "modelPicker.jump.5"
      | "modelPicker.jump.6"
      | "modelPicker.jump.7"
      | "modelPicker.jump.8"
      | "modelPicker.jump.9"
      | "thread.stop"
      | "thread.steerQueuedMessage"
      | "thread.previous"
      | "thread.next"
      | "thread.copyReference"
      | "thread.settle"
      | "thread.pin"
      | "thread.undo"
      | "thread.jump.1"
      | "thread.jump.2"
      | "thread.jump.3"
      | "thread.jump.4"
      | "thread.jump.5"
      | "thread.jump.6"
      | "thread.jump.7"
      | "thread.jump.8"
      | "thread.jump.9"
      | `script.${string}.run`;
    readonly shortcut: {
      readonly key: string;
      readonly metaKey: boolean;
      readonly ctrlKey: boolean;
      readonly shiftKey: boolean;
      readonly altKey: boolean;
      readonly modKey: boolean;
    };
    readonly whenAst?:
      | { readonly type: "identifier"; readonly name: string }
      | { readonly type: "not"; readonly node: KeybindingWhenNode }
      | {
          readonly type: "and";
          readonly left: KeybindingWhenNode;
          readonly right: KeybindingWhenNode;
        }
      | {
          readonly type: "or";
          readonly left: KeybindingWhenNode;
          readonly right: KeybindingWhenNode;
        }
      | undefined;
  }[];
  lockedContinuationGroupKey: string | null;
  lockedProvider: ProviderDriverKind | null;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, readonly AppModelOption[]>;
  multipleModelSelections:
    | readonly {
        readonly instanceId: ProviderInstanceId;
        readonly model: string;
        readonly options?: readonly { readonly id: string; readonly value: string | boolean }[];
      }[]
    | null;
  nonPersistedComposerImageIdSet: Set<string>;
  onComposerOverlayHeightChange: (height: number) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  onProviderModelSelect: (
    instanceId: ProviderInstanceId,
    model: string,
    options?: { focusComposer?: boolean },
  ) => void;
  onRestingChange: (resting: boolean) => void;
  onRestingControlsVisibilityChange: (visible: boolean) => void;
  pendingSnapShotIdSet: Set<string>;
  planModeUiEnabled: boolean;
  projectSelectionRequired: boolean;
  providerCatalogPending: boolean;
  providerInputSubmissionError: string | null;
  providerInstanceEntries: readonly ProviderInstanceEntry[];
  providerSetupInstanceId: ProviderInstanceId | undefined;
  providerStatuses: {
    readonly instanceId: ProviderInstanceId;
    readonly enabled: boolean;
    readonly version: string | null;
    readonly status: "error" | "ready" | "disabled" | "warning";
    readonly models: readonly {
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
    readonly slashCommands: readonly {
      readonly name: string;
      readonly description?: string | undefined;
      readonly input?: { readonly hint: string } | undefined;
    }[];
    readonly skills: readonly {
      readonly name: string;
      readonly enabled: boolean;
      readonly path: string;
      readonly description?: string | undefined;
      readonly displayName?: string | undefined;
      readonly scope?: string | undefined;
      readonly shortDescription?: string | undefined;
      readonly userInvocationOnly?: boolean | undefined;
      readonly userInvocable?: boolean | undefined;
    }[];
    readonly checkedAt: string;
    readonly driver: ProviderDriverKind;
    readonly installed: boolean;
    readonly auth: {
      readonly status: "unknown" | "authenticated" | "unauthenticated";
      readonly type?: string | undefined;
      readonly label?: string | undefined;
      readonly email?: string | undefined;
      readonly subscriptionSharing?: boolean | undefined;
      readonly profileId?: string | undefined;
    };
    readonly message?: string | undefined;
    readonly displayName?: string | undefined;
    readonly accentColor?: string | undefined;
    readonly badgeLabel?: string | undefined;
    readonly continuation?: { readonly groupKey: string } | undefined;
    readonly showInteractionModeToggle?: boolean | undefined;
    readonly canLeadCrew?: boolean | undefined;
    readonly reportsContextWindow?: boolean | undefined;
    readonly requiresNewThreadForModelChange?: boolean | undefined;
    readonly supportsConversationRollback?: boolean | undefined;
    readonly supportsTextGeneration?: boolean | undefined;
    readonly setup?:
      | { readonly canAuthenticate: boolean; readonly canInstall: boolean }
      | undefined;
    readonly runtimePaths?: { readonly homePath: string; readonly shadowHomePath: string | null };
    readonly diagnosis?: "disabled" | "runtime-missing" | "runtime-error" | "api-key-invalid";
    readonly availability?: "available" | "unavailable" | undefined;
    readonly unavailableReason?: string | undefined;
    readonly workspaceSnapshots?: readonly {
      readonly cwd: string;
      readonly checkedAt: string;
      readonly slashCommands: readonly {
        readonly name: string;
        readonly description?: string | undefined;
        readonly input?: { readonly hint: string } | undefined;
      }[];
      readonly skills: readonly {
        readonly name: string;
        readonly enabled: boolean;
        readonly path: string;
        readonly description?: string | undefined;
        readonly displayName?: string | undefined;
        readonly scope?: string | undefined;
        readonly shortDescription?: string | undefined;
        readonly userInvocationOnly?: boolean | undefined;
        readonly userInvocable?: boolean | undefined;
      }[];
    }[];
    readonly usageLimits?:
      | {
          readonly windows: readonly {
            readonly kind: "session" | "other" | "weekly" | "monthly";
            readonly id: string;
            readonly label: string;
            readonly usedPercent: number;
            readonly resetsAt?: string | undefined;
            readonly windowDurationMins?: number | undefined;
          }[];
          readonly checkedAt: string;
          readonly unavailable?:
            | {
                readonly reason: "unsupported" | "probeFailed";
                readonly message?: string | undefined;
              }
            | undefined;
          readonly resetCredits?:
            | {
                readonly availableCount: number;
                readonly nextExpiresAt?: string | undefined;
                readonly nextCreditId?: string | undefined;
              }
            | undefined;
          readonly externalUsage?: { readonly label: string; readonly url: string } | undefined;
        }
      | undefined;
    readonly versionAdvisory?: {
      readonly status: "unknown" | "current" | "behind_latest";
      readonly message: string | null;
      readonly checkedAt: string | null;
      readonly currentVersion: string | null;
      readonly latestVersion: string | null;
      readonly updateCommand: string | null;
      readonly canUpdate: boolean;
      readonly canInstallVersion?: boolean;
    };
    readonly compatibilityAdvisory?: {
      readonly status: "unknown" | "unsupported" | "supported" | "graceful" | "broken";
      readonly message: string | null;
      readonly recommendedVersion: string | null;
      readonly recommendedRange: string | null;
      readonly latestVersionStatus?:
        | "unknown"
        | "unsupported"
        | "supported"
        | "graceful"
        | "broken";
    };
    readonly updateState?: {
      readonly status: "running" | "idle" | "queued" | "succeeded" | "failed" | "unchanged";
      readonly startedAt: string | null;
      readonly finishedAt: string | null;
      readonly message: string | null;
      readonly output: string | null;
    };
  }[];
  providerTraitsMenuContent: ReactNode;
  providerTraitsPicker: ReactNode;
  providerTraitsPickerInput: {
    model: string;
    models: readonly {
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
    modelOptions: readonly { readonly id: string; readonly value: string | boolean }[] | undefined;
    prompt: string;
    onPromptChange: (nextPrompt: string) => void;
    planModeEnabled: boolean;
    isComposerOwned: true;
    draftId?: DraftId;
    threadRef?: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
    provider: ProviderDriverKind;
    instanceId: ProviderInstanceId;
  };
  resolvedTheme: "light" | "dark";
  restingComposerControlsRef: RefObject<HTMLDivElement | null>;
  restingControlsHaveLeadingContext: boolean;
  restingControlsHiddenBlockCount: number;
  restingControlsIconOnlyBlockCount: number;
  restingControlsVisible: boolean;
  routeKind: "draft" | "server";
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  scheduleComposerFocus: () => void;
  selectedInstanceId: ProviderInstanceId;
  selectedModelForPickerWithCustomFallback: string;
  selectedModelSelection: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly options?: readonly { readonly id: string; readonly value: string | boolean }[];
  };
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
  settings: UnifiedSettings;
  showComposerTopDrawer: boolean;
  showInlineTasksBadge: boolean;
  showProviderUnavailable: boolean;
  standaloneComposerImages: ComposerImageAttachment[];
  supportsAttachmentUploads: boolean;
  supportsMultipleModels: boolean;
  terminalOpen: boolean;
  timelineOverflows: boolean;
  toggleInteractionMode: () => void;
  uploadsByImageId: Readonly<Record<string, AttachmentUploadState>>;
  windowRefocusInFlightRef: RefObject<boolean>;
}) {
  const {
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
  } = args;

  const hasImageAttachmentAttention = standaloneComposerImages.some((image) => {
    const upload = uploadsByImageId[image.id];
    const failedInCurrentEnvironment =
      supportsAttachmentUploads &&
      upload?.status === "failed" &&
      upload.environmentId === environmentId;
    // A failed upload remains actionable in the expanded attachment tray, but
    // its collapsed thumbnail is enough to signal that the draft has images.
    return nonPersistedComposerImageIdSet.has(image.id) && !failedInCurrentEnvironment;
  });
  // Banners and the tasks badge dock above the surface rather than inside
  // it, so they do not hold the composer open; only surface-internal chrome
  // does.
  const composerHasExpandedChrome =
    showComposerTopDrawer ||
    isTasksDrawerOpen ||
    composerMenuOpen ||
    isStashMenuOpen ||
    isDragOverComposer ||
    isPreparingWorktree ||
    showProviderUnavailable ||
    projectSelectionRequired ||
    environmentUnavailable !== null ||
    composerSubmissionError !== null ||
    providerInputSubmissionError !== null ||
    hasImageAttachmentAttention;
  const isComposerResting = shouldUseRestingComposerLayout({
    isExistingThread: routeKind === "server" && activeThreadId !== null,
    isMobileViewport,
    isScrollCollapsed: isComposerScrollCollapsed,
    hasExpandedChrome: composerHasExpandedChrome,
    hasMultilinePrompt,
    timelineOverflows,
  });
  const expandedComposerImages = isComposerResting
    ? standaloneComposerImages.filter((image) => pendingSnapShotIdSet.has(image.id))
    : standaloneComposerImages;
  // The relocated controls live in the context strip whenever the composer is
  // collapsed for any reason, the desktop resting layout or the phone
  // collapse. Both leave the footer unrendered, so the strip is the only place
  // to see or change the model without expanding the composer.
  const composerControlsInStrip = isComposerResting || isComposerCollapsedMobile;
  const composerControlsVisibleInStrip = composerControlsInStrip && restingControlsVisible;
  const composerControlsHidden = composerControlsInStrip && !restingControlsVisible;
  if (composerControlsHidden && isComposerModelPickerOpen) {
    setIsComposerModelPickerOpen(false);
  }
  useLayoutEffect(() => {
    onRestingControlsVisibilityChange(composerControlsVisibleInStrip);
  }, [composerControlsVisibleInStrip, onRestingControlsVisibilityChange]);
  useLayoutEffect(() => {
    onRestingChange(isComposerResting);
  }, [isComposerResting, onRestingChange]);
  const restingImagePreviewCounts = getRestingComposerImagePreviewCounts(
    standaloneComposerImages.length,
  );
  const restingComposerImages = standaloneComposerImages.slice(
    0,
    restingImagePreviewCounts.visibleCount,
  );
  const collapsedComposerImagePreviews =
    restingComposerImages.length > 0 ? (
      <div
        data-chat-composer-resting-images="true"
        className="flex shrink-0 items-center gap-1 ps-1"
      >
        {restingComposerImages.map((image) => (
          <button
            key={image.id}
            type="button"
            className="relative size-7 shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-muted/60"
            aria-label={`Preview ${image.name}`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              const preview = buildExpandedImagePreview(composerImages, image.id);
              if (preview) onExpandImage(preview);
            }}
          >
            {image.previewUrl ? (
              <ComposerImageThumbnail
                file={image.file}
                alt=""
                className="size-full object-cover"
                fallback={
                  <PierreEntryIcon
                    pathValue={image.name}
                    kind="file"
                    theme={resolvedTheme}
                    className="m-auto size-3.5"
                  />
                }
              />
            ) : (
              <PierreEntryIcon
                pathValue={image.name}
                kind="file"
                theme={resolvedTheme}
                className="m-auto size-3.5"
              />
            )}
          </button>
        ))}
        {restingImagePreviewCounts.overflowCount > 0 ? (
          <button
            type="button"
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/70 bg-muted/60 font-medium text-secondary-label text-xs tabular-nums outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            aria-label={`Show ${String(restingImagePreviewCounts.overflowCount)} more image attachments`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (isComposerCollapsedMobile) {
                expandMobileComposer();
                return;
              }
              setIsComposerScrollCollapsed(false);
              setIsComposerFocused(true);
              scheduleComposerFocus();
            }}
          >
            +{restingImagePreviewCounts.overflowCount}
          </button>
        ) : null}
      </div>
    ) : null;
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const composerMainSurfaceRef = useComposerRestingTransition(
    composerControlsInStrip,
    isComposerResting,
    restingComposerControlsRef,
    onComposerOverlayHeightChange,
    panelAnimationsActive,
    panelAnimationDurationMs,
  );
  const canTrackComposerScrollGesture =
    routeKind === "server" && activeThreadId !== null && !isMobileViewport;
  const canScrollCollapseComposer =
    canTrackComposerScrollGesture &&
    settings.composerCollapseOnScroll &&
    !hasMultilinePrompt &&
    !composerHasExpandedChrome &&
    !showInlineTasksBadge;
  // Scrolling only has something to collapse while the composer is expanded,
  // focused or not, so the wheel handler keys off the resting state rather
  // than editor focus.
  composerScrollCollapseEligibleRef.current = canScrollCollapseComposer && !isComposerResting;

  useEffect(() => {
    if (!canScrollCollapseComposer) {
      setIsComposerScrollCollapsed(false);
    }
  }, [canScrollCollapseComposer, setIsComposerScrollCollapsed]);

  // Returning to the window re-fires focus on the element that already held
  // it. That focus arrives after the window's own event, so a window focus
  // marks the frame in which it should be ignored by the form's capture.
  useEffect(() => {
    if (!isComposerScrollCollapsed) return;
    let frame: number | null = null;
    const onWindowFocus = () => {
      windowRefocusInFlightRef.current = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        windowRefocusInFlightRef.current = false;
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      if (frame !== null) window.cancelAnimationFrame(frame);
      windowRefocusInFlightRef.current = false;
    };
  }, [isComposerScrollCollapsed]);

  useEffect(() => {
    if (!canTrackComposerScrollGesture) return;

    const finishScrollGesture = () => {
      if (composerScrollCollapseTimeoutRef.current !== null) {
        window.clearTimeout(composerScrollCollapseTimeoutRef.current);
      }
      composerScrollCollapseTimeoutRef.current = null;
      resetComposerScrollGesture(composerScrollGestureRef.current);
    };
    const handleTimelineWheel = (event: WheelEvent) => {
      if (event.ctrlKey || !(event.target instanceof Element)) {
        return;
      }

      const scrollNode = getTimelineScrollableNode();
      if (!scrollNode) return;
      const targetsTimeline = isTimelineScrollTarget(event.target, scrollNode, event.deltaY);
      if (
        !scrollNode.contains(event.target) &&
        !composerScrollGestureRef.current.collapseSuppressed
      )
        return;

      if (composerScrollCollapseTimeoutRef.current !== null) {
        window.clearTimeout(composerScrollCollapseTimeoutRef.current);
      }
      composerScrollCollapseTimeoutRef.current = window.setTimeout(
        finishScrollGesture,
        COMPOSER_SCROLL_GESTURE_RESET_MS,
      );

      const canScrollInGestureDirection =
        targetsTimeline &&
        (event.deltaY < 0
          ? scrollNode.scrollTop > 0
          : scrollNode.scrollTop < scrollNode.scrollHeight - scrollNode.clientHeight);
      const deltaPx =
        Math.abs(event.deltaY) *
        (event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? scrollNode.clientHeight
            : 1);
      const shouldCollapse = recordComposerScrollGestureEvent(composerScrollGestureRef.current, {
        now: window.performance.now(),
        deltaPx,
        collapseThresholdPx: COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX,
        collapseEligible: targetsTimeline && composerScrollCollapseEligibleRef.current,
        canScrollInGestureDirection,
        scrollsTowardLogicalEnd: event.deltaY > 0 && isTimelineAtLogicalEnd(),
      });
      if (!shouldCollapse) {
        return;
      }

      setIsComposerScrollCollapsed(true);
    };

    document.addEventListener("wheel", handleTimelineWheel, { capture: true, passive: true });
    return () => {
      document.removeEventListener("wheel", handleTimelineWheel, true);
      finishScrollGesture();
    };
  }, [
    activeThreadId,
    canTrackComposerScrollGesture,
    getTimelineScrollableNode,
    isTimelineAtLogicalEnd,
    setIsComposerScrollCollapsed,
  ]);

  const restingHiddenBlockCount = composerControlsInStrip
    ? restingControlsHiddenBlockCount
    : expandedControlsLayout.hiddenBlockCount;
  const iconOnlyBlockCount = composerControlsInStrip
    ? restingControlsIconOnlyBlockCount
    : expandedControlsLayout.iconOnlyBlockCount;
  const restingProviderTraitsPicker = renderProviderTraitsPicker({
    ...providerTraitsPickerInput,
    size: composerControlsInStrip ? "xs" : "sm",
    hidden: composerControlsHidden || restingHiddenBlockCount > 1,
  });
  const restingBlockDefs = [
    ...(providerTraitsPicker
      ? [
          {
            id: "traits",
            content: (
              <>
                <ComposerControlSeparator size={composerControlsInStrip ? "xs" : "sm"} />
                {restingProviderTraitsPicker}
              </>
            ),
          },
        ]
      : []),
    {
      id: "mode",
      content: (
        <ComposerFooterModeControls
          showInteractionModeToggle={planModeUiEnabled}
          interactionMode={interactionMode}
          runtimeMode={runtimeMode}
          size={composerControlsInStrip ? "xs" : "sm"}
          hidden={composerControlsHidden || restingHiddenBlockCount > 0}
          onToggleInteractionMode={toggleInteractionMode}
          onRuntimeModeChange={handleRuntimeModeChange}
        />
      ),
    },
  ];
  const hiddenRestingBlockIds = restingBlockDefs
    .slice(restingBlockDefs.length - restingHiddenBlockCount)
    .map((def) => def.id);
  const composerControls = showProviderUnavailable ? (
    <ComposerControl
      type="button"
      disabled={!providerSetupInstanceId}
      onClick={() => {
        if (providerSetupInstanceId) {
          onOpenProviderSetup(providerSetupInstanceId);
        }
      }}
      data-chat-provider-unavailable="true"
      className="shrink-0"
    >
      <CircleAlertIcon className="size-4" />
      {providerSetupInstanceId ? "Open provider settings" : "No provider available"}
    </ComposerControl>
  ) : (
    <>
      {composerControlsInStrip && restingControlsHaveLeadingContext ? (
        <ComposerControlSeparator
          size="xs"
          className="@max-[400px]/composer-surface:hidden"
          data-resting-controls-separator="true"
        />
      ) : null}
      <ProviderModelPicker
        isComposerOwned
        adviceEnvironmentId={environmentId}
        disabled={providerCatalogPending || isSendBusy}
        {...(routeKind === "draft" && supportsMultipleModels
          ? {
              ...(multipleModelSelections !== null
                ? { selectedModels: multipleModelSelections }
                : {}),
              onToggleModel: (instanceId: ProviderInstanceId, model: string) => {
                const current = multipleModelSelections ?? [selectedModelSelection];
                const matchesModel = (selection: ModelSelection) => {
                  if (selection.instanceId !== instanceId) return false;
                  const entry = providerInstanceEntries.find(
                    (entry) => entry.instanceId === selection.instanceId,
                  );
                  const resolvedModel = resolveModelPickerSelectedModel({
                    driverKind: entry?.driverKind,
                    model: selection.model,
                    options: modelOptionsByInstance.get(selection.instanceId) ?? [],
                  });
                  return (resolvedModel?.slug ?? selection.model) === model;
                };
                const exists = current.some(matchesModel);
                const next = exists
                  ? current.filter((selection) => !matchesModel(selection))
                  : [...current, createModelSelection(instanceId, model)];
                if (next.length > 1) {
                  setMultipleModelSelections(next);
                } else {
                  setMultipleModelSelections(null);
                  const remaining = next[0] ?? selectedModelSelection;
                  onProviderModelSelect(remaining.instanceId, remaining.model, {
                    focusComposer: false,
                  });
                }
              },
            }
          : {})}
        activeInstanceId={
          providerCatalogPending
            ? (activeThreadModelSelection?.instanceId ?? selectedInstanceId)
            : selectedInstanceId
        }
        model={
          providerCatalogPending
            ? (activeThreadModelSelection?.model ?? selectedModelForPickerWithCustomFallback)
            : selectedModelForPickerWithCustomFallback
        }
        lockedProvider={lockedProvider}
        lockedContinuationGroupKey={lockedContinuationGroupKey}
        instanceEntries={providerInstanceEntries}
        keybindings={keybindings}
        modelOptionsByInstance={modelOptionsByInstance}
        size={composerControlsInStrip ? "xs" : "sm"}
        triggerClassName={
          composerControlsInStrip
            ? "min-w-13 shrink text-xs! @max-[640px]/composer-surface:[&_[data-chat-provider-model-picker-label]]:w-0 @max-[640px]/composer-surface:[&_[data-chat-provider-model-picker-label]]:flex-none"
            : "-ms-2.5 min-w-13"
        }
        terminalOpen={terminalOpen}
        open={isComposerModelPickerOpen}
        instanceIndicatorBackground={
          composerControlsInStrip
            ? "color-mix(in srgb, var(--chat-composer-glass-surface) var(--glass-opacity), transparent)"
            : "var(--contrast-input)"
        }
        {...(composerProviderState.modelPickerIconClassName || composerControlsInStrip
          ? {
              activeProviderIconClassName: cn(
                composerProviderState.modelPickerIconClassName,
                composerControlsInStrip &&
                  "fill-muted-foreground/70! text-muted-foreground/70! [&_path]:fill-muted-foreground/70! [&_rect]:fill-muted-foreground/70! [&_[data-opencode-hole]]:fill-transparent!",
              ),
            }
          : {})}
        onOpenChange={setIsComposerModelPickerOpen}
        getModelDisabledReason={getModelDisabledReason}
        onInstanceModelChange={(instanceId, model) => {
          setMultipleModelSelections(null);
          onProviderModelSelect(instanceId, model);
        }}
        onOpenProviderSetup={onOpenProviderSetup}
      />
      <CrewChip
        environmentId={environmentId}
        target={composerDraftTarget}
        providers={providerStatuses}
        brain={selectedModelSelection}
        disabled={providerCatalogPending || isSendBusy}
      />
      {typeof composerDraftTarget === "string" ? null : (
        <GoalChip environmentId={environmentId} threadId={composerDraftTarget.threadId} />
      )}

      <>
        {restingBlockDefs.map((def, index) => {
          const hidden = index >= restingBlockDefs.length - restingHiddenBlockCount;
          return (
            <div
              key={def.id}
              data-resting-block={def.id}
              data-composer-block-icon-only={
                index >= restingBlockDefs.length - iconOnlyBlockCount ? "true" : "false"
              }
              aria-hidden={hidden || undefined}
              inert={hidden || undefined}
              className={cn(
                "flex w-max min-w-max shrink-0 items-center gap-1",
                hidden && "pointer-events-none invisible absolute",
                index >= restingBlockDefs.length - iconOnlyBlockCount &&
                  "[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none [&_[data-composer-control-compact-icon]]:[visibility:inherit] [&_[data-composer-control-compact-icon]]:relative",
              )}
            >
              {def.content}
            </div>
          );
        })}
        <div
          data-resting-controls-overflow
          aria-hidden={hiddenRestingBlockIds.length === 0 || undefined}
          inert={hiddenRestingBlockIds.length === 0 || undefined}
          className={cn(
            "min-w-0 shrink-0",
            hiddenRestingBlockIds.length === 0 && "pointer-events-none invisible absolute",
          )}
        >
          <CompactComposerControlsMenu
            interactionMode={interactionMode}
            runtimeMode={runtimeMode}
            size={composerControlsInStrip ? "xs" : "sm"}
            hidden={composerControlsHidden || hiddenRestingBlockIds.length === 0}
            showInteractionModeToggle={planModeUiEnabled && hiddenRestingBlockIds.includes("mode")}
            traitsMenuContent={
              hiddenRestingBlockIds.includes("traits") ? providerTraitsMenuContent : undefined
            }
            onToggleInteractionMode={toggleInteractionMode}
            onRuntimeModeChange={handleRuntimeModeChange}
          />
        </div>
      </>
    </>
  );

  return {
    isComposerResting,
    expandedComposerImages,
    composerControlsInStrip,
    composerControlsHidden,
    collapsedComposerImagePreviews,
    composerMainSurfaceRef,
    composerControls,
  };
}
