import { includeForeignProviderSkills } from "../../providerSkillSearch";
import type { ChatComposerProps } from "./ChatComposer.types";
import { isQueuedBehindBackgroundAgents } from "./stopBackgroundAgents.logic";
import type { EnvironmentId, ModelSelection, ServerProvider } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection, normalizeModelSlug } from "@t3tools/shared/model";
import { useEffect, useMemo, useRef } from "react";
import {
  getAntigravitySendBlockReason,
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
  threadShellHasStarted,
} from "../ChatView.logic";
import { useEffectiveComposerModelState } from "../../composerDraftStore";
import { shortcutLabelForCommand } from "../../keybindings";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { deriveProjectMemoryComposerGate } from "./ProjectMemoryPicker";
import { getComposerPromptInjectionState, getComposerProviderState } from "./composerProviderState";
import {
  providerSupportsManualCompaction,
  resolveContextWindowModelDisplayName,
  shouldReserveContextWindowMeter,
} from "./ContextWindowMeter.logic";
import { hasProviderSetup } from "./ProviderStatusBanner";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { type AppModelOption, getAppModelOptionsForInstance } from "../../modelSelection";
import {
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import {
  ComposerThreadDraftState,
  DraftId,
  ComposerProjectMemoryReference,
} from "../../composerDraftStore";
import { ThreadId, KeybindingWhenNode, ProjectId } from "@t3tools/contracts";
import { SessionPhase } from "../../types";
import { UnifiedSettings } from "@t3tools/contracts/settings";
import { TranslationValues } from "../../i18n";
import { WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS } from "./ChatComposer.constants";

export function useComposerProviderSelection(args: {
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
  activeProjectDefaultModelSelection:
    | {
        readonly instanceId: ProviderInstanceId;
        readonly model: string;
        readonly options?: readonly { readonly id: string; readonly value: string | boolean }[];
      }
    | null
    | undefined;
  activeThread: EnvironmentThread | undefined;
  activeThreadModelSelection:
    | {
        readonly instanceId: ProviderInstanceId;
        readonly model: string;
        readonly options?: readonly { readonly id: string; readonly value: string | boolean }[];
      }
    | null
    | undefined;
  attachmentBlockReason: string | null;
  compactDisabledReason: string | null;
  composerDraft: ComposerThreadDraftState;
  composerDraftTarget:
    | { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
    | DraftId;
  composerProjectMemoryReferences: ComposerProjectMemoryReference[];
  environmentId: EnvironmentId;
  externalSendDisabledReason: string | null;
  gitCwd: string | null;
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
  liveBackgroundAgentCount: number;
  lockedProvider: ProviderDriverKind | null;
  multipleModelSelections:
    | readonly {
        readonly instanceId: ProviderInstanceId;
        readonly model: string;
        readonly options?: readonly { readonly id: string; readonly value: string | boolean }[];
      }[]
    | null;
  phase: SessionPhase;
  projectMemoryCapability: {
    projectId: ProjectId;
    send: boolean;
    sendDriverKinds: ReadonlyArray<ProviderDriverKind> | undefined;
  } | null;
  prompt: string;
  props: ChatComposerProps;
  providerCatalogKnown: boolean;
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
  requestedInteractionMode: "default" | "plan";
  settings: UnifiedSettings;
  t: (text: string, values?: TranslationValues) => string;
}) {
  const {
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
  } = args;

  // ------------------------------------------------------------------
  // Model state
  // ------------------------------------------------------------------
  // Instance-aware projection of the wire provider list. One entry per
  // configured instance (default built-in + any custom `providerInstances.*`),
  // sorted default-first per driver kind for a stable picker order.
  const providerInstanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings],
  );
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
  const {
    selectedProviderEntry,
    requestedDriverKind,
    lockedContinuationGroupKey,
    unavailableProviderInstanceId,
  } = useMemo(
    () =>
      resolveComposerProviderSelection({
        entries: providerInstanceEntries,
        candidateInstanceIds: [
          selectedProviderByThreadId,
          activeThread?.session?.providerInstanceId,
          activeThreadModelSelection?.instanceId,
          activeProjectDefaultModelSelection?.instanceId,
        ],
        lockedProvider,
        lockedInstanceId:
          activeThread?.session?.providerInstanceId ?? activeThreadModelSelection?.instanceId,
      }),
    [
      activeProjectDefaultModelSelection?.instanceId,
      activeThread?.session?.providerInstanceId,
      activeThreadModelSelection?.instanceId,
      selectedProviderByThreadId,
      lockedProvider,
      providerInstanceEntries,
    ],
  );
  const selectedInstanceId =
    selectedProviderEntry?.instanceId ?? NO_PROVIDER_MODEL_SELECTION.instanceId;
  const noProviderAvailable =
    selectedProviderEntry === undefined && multipleModelSelections === null;
  // Before the catalog arrives, every thread resolves to "no provider". Send
  // stays blocked either way; only the chrome waits, keeping the picker with
  // the thread's own selection instead of swapping in the setup button and
  // back once the catalog lands.
  const providerCatalogPending = noProviderAvailable && !providerCatalogKnown;
  const showProviderUnavailable = noProviderAvailable && !providerCatalogPending;
  const followUpBehavior = useEnvironmentSettings(
    environmentId,
    (settings) => settings.followUpBehavior,
  );
  const sendNowShortcutLabel =
    phase === "running" && followUpBehavior === "queue"
      ? shortcutLabelForCommand(keybindings, "thread.steerQueuedMessage", {
          context: { terminalFocus: false },
        })
      : null;
  const queuedBehindBackgroundAgents = isQueuedBehindBackgroundAgents({
    running: phase === "running",
    liveAgentCount: liveBackgroundAgentCount,
  });
  const runningComposerPlaceholder =
    phase !== "running" || followUpBehavior !== "queue"
      ? null
      : queuedBehindBackgroundAgents
        ? t("Your message will be delivered when the background agents finish. Stop ends them too.")
        : sendNowShortcutLabel
          ? t(
              "Your message will be queued while the agent works ({shortcut} sends the next one now)",
              {
                shortcut: sendNowShortcutLabel,
              },
            )
          : t("Your message will be queued while the agent works");
  // Memory picker gating combines the server capability with the driver kind of
  // the instance that will actually run the turn; unresolved states only ever
  // disable or hide, never imply support.
  const projectMemoryGate = useMemo(
    () =>
      projectMemoryCapability === null
        ? null
        : deriveProjectMemoryComposerGate({
            send: projectMemoryCapability.send,
            sendDriverKinds: projectMemoryCapability.sendDriverKinds,
            selectedDriverKind: selectedProviderEntry?.driverKind,
            providerCatalogPending,
            hasReferences: composerProjectMemoryReferences.length > 0,
          }),
    [
      composerProjectMemoryReferences.length,
      projectMemoryCapability,
      providerCatalogPending,
      selectedProviderEntry,
    ],
  );
  const providerSetupInstanceId = noProviderAvailable
    ? (unavailableProviderInstanceId ??
      (lockedProvider === null
        ? providerInstanceEntries.find((entry) => hasProviderSetup(entry.snapshot))?.instanceId
        : undefined))
    : undefined;
  const resolvedCompactDisabledReason =
    compactDisabledReason ?? (noProviderAvailable ? "Compacting is unavailable right now" : null);
  // The driver kind follows the instance that will actually run the turn,
  // which can differ from the persisted selection when that selection is
  // disabled.
  const selectedProvider: ProviderDriverKind =
    selectedProviderEntry?.driverKind ?? requestedDriverKind;

  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadRef: composerDraftTarget,
    providers: providerStatuses,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection: activeThreadModelSelection,
    projectModelSelection: activeProjectDefaultModelSelection,
    settings,
  });
  const providerSendBlockReason = getAntigravitySendBlockReason(
    selectedProviderEntry?.snapshot,
    selectedModel,
  );
  const sendDisabledReason =
    externalSendDisabledReason ??
    (multipleModelSelections?.length === 0 ? "Select at least one model." : null) ??
    (activePendingProgress
      ? attachmentBlockReason
      : (attachmentBlockReason ??
        (multipleModelSelections === null ? providerSendBlockReason : null)));
  const isSendDisabled = sendDisabledReason !== null;
  const selectedProviderStatus = useMemo(
    () => selectedProviderEntry?.snapshot ?? null,
    [selectedProviderEntry],
  );
  const compactCommandAvailable = providerSupportsManualCompaction(selectedProviderEntry);
  const selectedProviderSkills = includeForeignProviderSkills(
    selectedProviderStatus ? resolveProviderSkillsForCwd(selectedProviderStatus, gitCwd) : [],
    providerStatuses
      .filter((provider) => provider.enabled && provider.instanceId !== selectedInstanceId)
      .map((provider) => ({
        provider: provider.driver === "claude-code" ? "Claude" : provider.driver,
        skills: resolveProviderSkillsForCwd(provider, gitCwd),
      })),
  );
  const selectedProviderSlashCommands = selectedProviderStatus
    ? resolveProviderSlashCommandsForCwd(selectedProviderStatus, gitCwd)
    : [];
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const workspaceRefreshKeyRef = useRef<string | null>(null);
  const workspaceRefreshRetryRef = useRef<{ key: string; notBefore: number } | null>(null);
  const hadWorkspaceSnapshotRef = useRef(false);
  useEffect(() => {
    const hasWorkspaceSnapshot = Boolean(
      gitCwd &&
      selectedProviderStatus?.workspaceSnapshots?.some((snapshot) => snapshot.cwd === gitCwd),
    );
    if (hadWorkspaceSnapshotRef.current && !hasWorkspaceSnapshot) {
      workspaceRefreshKeyRef.current = null;
      workspaceRefreshRetryRef.current = null;
    }
    hadWorkspaceSnapshotRef.current = hasWorkspaceSnapshot;
  }, [gitCwd, selectedProviderStatus]);
  useEffect(() => {
    if (!gitCwd || !selectedProviderEntry) return;
    const key = `${environmentId}:${selectedProviderEntry.instanceId}:${gitCwd}`;
    const hasWorkspaceSnapshot = selectedProviderStatus?.workspaceSnapshots?.some(
      (snapshot) => snapshot.cwd === gitCwd,
    );
    if (workspaceRefreshKeyRef.current === key) return;
    if (hasWorkspaceSnapshot) {
      workspaceRefreshKeyRef.current = key;
      workspaceRefreshRetryRef.current = null;
      return;
    }
    const retry = workspaceRefreshRetryRef.current;
    if (retry?.key === key && Date.now() < retry.notBefore) return;
    workspaceRefreshKeyRef.current = key;
    const retryLater = () => {
      if (workspaceRefreshKeyRef.current !== key) return;
      workspaceRefreshKeyRef.current = null;
      workspaceRefreshRetryRef.current = {
        key,
        notBefore: Date.now() + WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS,
      };
    };
    void refreshProviders({
      environmentId,
      input: { instanceId: selectedProviderEntry.instanceId, cwd: gitCwd },
    }).then((result) => {
      const hasWorkspaceSnapshot =
        result._tag === "Success" &&
        result.value.providers
          .find((provider) => provider.instanceId === selectedProviderEntry.instanceId)
          ?.workspaceSnapshots?.some((snapshot) => snapshot.cwd === gitCwd);
      if (!hasWorkspaceSnapshot && workspaceRefreshKeyRef.current === key) {
        retryLater();
      }
    }, retryLater);
  }, [environmentId, gitCwd, prompt, refreshProviders, selectedProviderEntry]);
  const selectedProviderModels = useMemo<ReadonlyArray<ServerProvider["models"][number]>>(
    () => selectedProviderEntry?.models ?? [],
    [selectedProviderEntry],
  );

  const composerPromptInjectionState = useMemo(
    () => getComposerPromptInjectionState(prompt),
    [prompt],
  );
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        promptInjectionState: composerPromptInjectionState,
        modelOptions: composerModelOptions?.[selectedInstanceId],
        planModeEnabled: settings.planModeEnabled,
      }),
    [
      composerModelOptions,
      composerPromptInjectionState,
      selectedInstanceId,
      selectedModel,
      selectedProvider,
      selectedProviderModels,
      settings.planModeEnabled,
    ],
  );

  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const { enabled: planModeUiEnabled, interactionMode } = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: selectedProviderStatus,
    interactionMode: requestedInteractionMode,
  });
  const selectedModelSelection = useMemo<ModelSelection>(
    () => createModelSelection(selectedInstanceId, selectedModel, selectedModelOptionsForDispatch),
    [selectedInstanceId, selectedModel, selectedModelOptionsForDispatch],
  );
  const selectedModelForPicker = selectedModel;
  // Instance-keyed option list so the picker can show each configured
  // instance (built-in + custom) as a first-class sidebar entry. The
  // options are server-reported models plus that exact instance's
  // configured custom models. A missing OpenCode selection is included as
  // an unavailable row until the catalog reports it again.
  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of providerInstanceEntries) {
      out.set(
        entry.instanceId,
        getAppModelOptionsForInstance(
          settings,
          entry,
          entry.instanceId === selectedInstanceId ? selectedModelForPicker : null,
        ),
      );
    }
    return out;
  }, [providerInstanceEntries, selectedInstanceId, selectedModelForPicker, settings]);
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByInstance.get(selectedInstanceId) ?? [];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByInstance, selectedInstanceId, selectedModelForPicker, selectedProvider]);

  // ------------------------------------------------------------------
  // Context window
  // ------------------------------------------------------------------
  const activeThreadModelDisplayName = useMemo(
    () => resolveContextWindowModelDisplayName(activeThreadModelSelection, modelOptionsByInstance),
    [activeThreadModelSelection, modelOptionsByInstance],
  );
  const reserveContextWindowMeter = shouldReserveContextWindowMeter({
    meterEnabled: settings.contextWindowMeterEnabled,
    detailLoading: props.threadSyncPhase === "loading",
    threadStarted: threadShellHasStarted(props.activeThreadShell),
    providerReportsContextWindow: selectedProviderStatus
      ? selectedProviderStatus.reportsContextWindow === true
      : null,
  });

  return {
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
  };
}
