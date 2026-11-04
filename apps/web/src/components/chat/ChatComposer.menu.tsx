import { filterComposerPullRequestMatches } from "@t3tools/shared/composerPullRequestMatches";
import type { EnvironmentId } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { useMemo } from "react";
import { type ComposerTrigger } from "../../composer-logic";
import { deriveComposerSendState } from "../ChatView.logic";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { type TerminalContextDraft } from "../../lib/terminalContext";
import { useComposerPathSearch } from "../../lib/composerPathSearchState";
import { pullRequestEnvironment, usePullRequestList } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";
import { type ComposerCommandItem } from "./ComposerCommandMenu";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import {
  matchesPullRequestQuery,
  rankPullRequestMatches,
} from "../pullRequest/pullRequestList.logic";
import {
  searchSlashCommandItems,
  slashCommandItemsForPromptPosition,
} from "./composerSlashCommandSearch";
import { basenameOfPath } from "../../pierre-icons";
import {
  formatProviderSkillDisplayName,
  getProviderSlashCommandsForSlashMenu,
  getProviderSkillsForSlashMenu,
} from "@t3tools/client-runtime/providerSkills";
import { searchProviderSkills } from "../../providerSkillSearch";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { RefObject } from "react";
import { PendingApproval, PendingUserInput } from "../../session-logic";
import { TurnId, ThreadId, PreviewAnnotationPayload, ProjectId } from "@t3tools/contracts";
import { ComposerThreadDraftState } from "../../composerDraftStore";
import { SessionPhase } from "../../types";
import { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  EMPTY_PULL_REQUEST_LIST_TARGETS,
  COMPOSER_PULL_REQUEST_LIST_LIMIT,
  COMPOSER_PULL_REQUEST_RESULT_LIMIT,
} from "./ChatComposer.constants";

export function useComposerMenuModel(args: {
  activeComposerMenuItemRef: RefObject<ComposerCommandItem | null>;
  activePendingApproval: PendingApproval | null;
  activePendingIsResponding: boolean;
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
  activeProposedPlan: {
    readonly id: string;
    readonly turnId: TurnId | null;
    readonly planMarkdown: string;
    readonly implementedAt: string | null;
    readonly implementationThreadId: ThreadId | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  } | null;
  compactThreadUnavailable: boolean;
  composerDraft: ComposerThreadDraftState;
  composerFiles: ComposerFileAttachment[];
  composerHighlightedItemId: string | null;
  composerHighlightedSearchKey: string | null;
  composerImages: ComposerImageAttachment[];
  composerMenuItemsRef: RefObject<ComposerCommandItem[]>;
  composerMenuOpenRef: RefObject<boolean>;
  composerPreviewAnnotations: PreviewAnnotationPayload[];
  composerReviewComments: ReviewCommentContext[];
  composerTerminalContexts: TerminalContextDraft[];
  composerTrigger: ComposerTrigger | null;
  environmentId: EnvironmentId;
  fileStagingLimit: number | null;
  gitCwd: string | null;
  isComposerCollapsedMobile: boolean;
  isConnecting: boolean;
  isPreparingWorktree: boolean;
  isSendBusy: boolean;
  nonPersistedComposerImageIds: string[];
  pendingUserInputs: PendingUserInput[];
  phase: SessionPhase;
  planModeUiEnabled: boolean;
  prompt: string;
  pullRequestProjectId: ProjectId | null;
  pullRequestRepository: string | null;
  selectedProvider: ProviderDriverKind;
  selectedProviderSkills: readonly {
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
  selectedProviderSlashCommands: readonly {
    readonly name: string;
    readonly description?: string | undefined;
    readonly input?: { readonly hint: string } | undefined;
  }[];
  selectedProviderStatus: {
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
  } | null;
  settings: UnifiedSettings;
  showPlanFollowUpPrompt: boolean;
  supportsQuestionAttachments: boolean;
}) {
  const {
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
  } = args;

  // ------------------------------------------------------------------
  // Derived: composer send state
  // ------------------------------------------------------------------
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length + composerFiles.length,
        terminalContexts: composerTerminalContexts,
        elementContextCount: composerPreviewAnnotations.length + composerReviewComments.length,
      }),
    [
      composerFiles.length,
      composerImages.length,
      composerPreviewAnnotations.length,
      composerReviewComments.length,
      composerTerminalContexts,
      prompt,
    ],
  );
  // ------------------------------------------------------------------
  // Derived: composer trigger / menu
  // ------------------------------------------------------------------
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const pullRequestTriggerQuery =
    composerTrigger?.kind === "pull-request" ? composerTrigger.query : "";
  const pullRequestTextQuery =
    composerTriggerKind === "pull-request" &&
    pullRequestTriggerQuery.length > 0 &&
    !/^\d+$/u.test(pullRequestTriggerQuery)
      ? pullRequestTriggerQuery
      : null;
  const debouncedPullRequestTextQuery = useDebouncedValue(pullRequestTextQuery, 180);
  const settledPullRequestTextQuery =
    pullRequestTextQuery === debouncedPullRequestTextQuery ? pullRequestTextQuery : null;
  const isPathTrigger = composerTriggerKind === "path";
  const workspaceEntries = useComposerPathSearch({
    environmentId,
    cwd: isPathTrigger ? gitCwd : null,
    query: isPathTrigger ? pathTriggerQuery : null,
  });
  const compactSlashCommandAvailable =
    composerTrigger?.kind === "slash-command" &&
    prompt.slice(0, composerTrigger.rangeStart).trim() === "" &&
    !compactThreadUnavailable &&
    prompt.slice(composerTrigger.rangeEnd).trim() === "" &&
    composerImages.length + composerFiles.length === 0 &&
    composerDraft.persistedAttachments.length === 0 &&
    composerTerminalContexts.length === 0 &&
    composerPreviewAnnotations.length === 0 &&
    composerReviewComments.length === 0;

  const pullRequestListTargets = useMemo(
    () =>
      composerTriggerKind !== "pull-request" ||
      pullRequestProjectId === null ||
      (pullRequestTextQuery !== null && settledPullRequestTextQuery === null)
        ? EMPTY_PULL_REQUEST_LIST_TARGETS
        : [
            {
              environmentId,
              input: {
                state: "all" as const,
                projectId: pullRequestProjectId,
                limit: COMPOSER_PULL_REQUEST_LIST_LIMIT,
                ...(settledPullRequestTextQuery === null
                  ? {}
                  : { query: settledPullRequestTextQuery }),
              },
            },
          ],
    [
      composerTriggerKind,
      environmentId,
      pullRequestProjectId,
      pullRequestTextQuery,
      settledPullRequestTextQuery,
    ],
  );
  const pullRequestLookup = usePullRequestList(pullRequestListTargets);
  const pullRequestTriggerNumber = useMemo(() => {
    if (composerTrigger?.kind !== "pull-request" || composerTrigger.query.length === 0) {
      return null;
    }
    const number = Number(composerTrigger.query);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }, [composerTrigger]);
  const debouncedPullRequestNumber = useDebouncedValue(pullRequestTriggerNumber, 180);
  const settledPullRequestNumber =
    pullRequestTriggerNumber === debouncedPullRequestNumber ? pullRequestTriggerNumber : null;
  const recentHasExactPullRequest =
    settledPullRequestNumber !== null &&
    pullRequestLookup.data?.entries.some(
      (entry) =>
        entry.projectId === pullRequestProjectId &&
        entry.repository.trim().toLowerCase() === pullRequestRepository?.trim().toLowerCase() &&
        entry.number === settledPullRequestNumber,
    ) === true;
  const exactPullRequestLookup = useEnvironmentQuery(
    settledPullRequestNumber === null ||
      pullRequestProjectId === null ||
      pullRequestRepository === null ||
      recentHasExactPullRequest
      ? null
      : pullRequestEnvironment.detail({
          environmentId,
          input: {
            projectId: pullRequestProjectId,
            repository: pullRequestRepository,
            number: settledPullRequestNumber,
          },
        }),
  );

  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.entries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
      }));
    }
    if (composerTrigger.kind === "slash-command") {
      const builtInSlashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        ...(planModeUiEnabled
          ? ([
              {
                id: "slash:plan",
                type: "slash-command",
                command: "plan",
                label: "/plan",
                description: "Switch this thread into plan mode",
              },
              {
                id: "slash:default",
                type: "slash-command",
                command: "default",
                label: "/default",
                description: "Switch this thread back to normal build mode",
              },
            ] as const)
          : []),
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const slashMenuSkills = getProviderSkillsForSlashMenu(
        selectedProviderSkills,
        settings.showSkillsInSlashMenu,
      );
      const providerSlashCommandItems = getProviderSlashCommandsForSlashMenu(
        selectedProviderSlashCommands,
        slashMenuSkills,
      ).map((command) => ({
        id: `provider-slash-command:${selectedProvider}:${command.name}`,
        type: "provider-slash-command" as const,
        provider: selectedProvider,
        command,
        label: `/${command.name}`,
        description: command.description ?? command.input?.hint ?? "Run provider command",
      }));
      const query = composerTrigger.query.trim().toLowerCase();
      const skillItems = slashMenuSkills.map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: `/skill:${skill.name}`,
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : ""),
      }));
      const visibleProviderSlashCommandItems = providerSlashCommandItems.filter(
        (item) => item.command.name !== "compact" || compactSlashCommandAvailable,
      );
      const slashCommandItems = slashCommandItemsForPromptPosition(
        [...builtInSlashCommandItems, ...visibleProviderSlashCommandItems, ...skillItems],
        composerTrigger.rangeStart === 0,
      );
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(selectedProviderSkills, composerTrigger.query).map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: formatProviderSkillDisplayName(skill),
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
      }));
    }
    if (
      composerTrigger.kind === "pull-request" &&
      pullRequestProjectId !== null &&
      pullRequestRepository !== null
    ) {
      const exactPullRequest =
        exactPullRequestLookup.data?.number === pullRequestTriggerNumber
          ? [exactPullRequestLookup.data]
          : [];
      const matches = /^\d*$/u.test(composerTrigger.query)
        ? filterComposerPullRequestMatches({
            entries: [...exactPullRequest, ...(pullRequestLookup.data?.entries ?? [])],
            projectId: pullRequestProjectId,
            repository: pullRequestRepository,
            query: composerTrigger.query,
            limit: COMPOSER_PULL_REQUEST_RESULT_LIMIT,
          })
        : rankPullRequestMatches(
            (pullRequestLookup.data?.entries ?? []).filter((entry) => {
              if (
                entry.projectId !== pullRequestProjectId ||
                entry.repository.trim().toLowerCase() !== pullRequestRepository.trim().toLowerCase()
              ) {
                return false;
              }
              const provider = pullRequestLookup.data?.providers.find(
                (candidate) => candidate.host === entry.host,
              );
              return (
                provider?.searchesOnHost === true ||
                matchesPullRequestQuery(entry, composerTrigger.query)
              );
            }),
            composerTrigger.query,
          ).slice(0, COMPOSER_PULL_REQUEST_RESULT_LIMIT);
      return matches.map((pullRequest) => ({
        id: `pull-request:${pullRequest.projectId}:${pullRequest.repository}:${pullRequest.number}`,
        type: "pull-request",
        pullRequest: {
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          headBranch: pullRequest.headBranch,
          baseBranch: pullRequest.baseBranch,
          state: pullRequest.state,
          isDraft: pullRequest.isDraft,
        },
        label: `#${pullRequest.number}`,
        description: pullRequest.title,
      }));
    }
    return [];
  }, [
    compactSlashCommandAvailable,
    composerTrigger,
    exactPullRequestLookup.data,
    planModeUiEnabled,
    pullRequestLookup.data,
    pullRequestProjectId,
    pullRequestRepository,
    pullRequestTriggerNumber,
    selectedProvider,
    selectedProviderSkills,
    selectedProviderSlashCommands,
    selectedProviderStatus,
    settings.showSkillsInSlashMenu,
    workspaceEntries.entries,
  ]);

  const composerMenuOpen = Boolean(composerTrigger);
  const composerMenuSearchKey = composerTrigger
    ? `${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`
    : null;
  const activeComposerMenuItem = useMemo(() => {
    const activeItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    return composerMenuItems.find((item) => item.id === activeItemId) ?? null;
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuSearchKey,
  ]);

  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;

  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );

  const isComposerApprovalState = activePendingApproval !== null;
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const isChoiceOnlyPendingQuestion =
    activePendingProgress?.activeQuestion?.allowCustomAnswer === false;
  const showComposerTopDrawer =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (!isComposerCollapsedMobile && showPlanFollowUpPrompt && activeProposedPlan !== null);
  const showCollapsedMobilePromptRow =
    isComposerCollapsedMobile && !isComposerApprovalState && pendingUserInputs.length === 0;
  const showComposerAttachAction =
    fileStagingLimit !== null &&
    (!activePendingProgress ||
      (supportsQuestionAttachments &&
        activePendingProgress.activeQuestion?.allowCustomAnswer !== false));
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const composerFooterActionLayoutKey = useMemo(() => {
    if (activePendingProgress) {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
    }
    if (phase === "running") {
      return "running";
    }
    if (showPlanFollowUpPrompt) {
      return prompt.trim().length > 0 ? "plan:refine" : "plan:implement";
    }
    return `idle:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
  }, [
    activePendingIsResponding,
    activePendingProgress,
    composerSendState.hasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    phase,
    prompt,
    showPlanFollowUpPrompt,
  ]);

  const isComposerMenuLoading =
    (composerTriggerKind === "path" && pathTriggerQuery.length > 0 && workspaceEntries.isPending) ||
    (composerTriggerKind === "pull-request" &&
      pullRequestProjectId !== null &&
      pullRequestRepository !== null &&
      (pullRequestLookup.isPending ||
        pullRequestTextQuery !== debouncedPullRequestTextQuery ||
        pullRequestTriggerNumber !== debouncedPullRequestNumber ||
        exactPullRequestLookup.isPending));
  const composerMenuEmptyState = useMemo(() => {
    if (composerTriggerKind === "skill") {
      return "No skills found. Try / to browse provider commands.";
    }
    if (composerTriggerKind === "pull-request") {
      if (pullRequestProjectId === null || pullRequestRepository === null) {
        return "Pull requests are not available for this project.";
      }
      if (
        pullRequestLookup.error !== null ||
        pullRequestLookup.data?.errors.some((error) => error.projectId === pullRequestProjectId)
      ) {
        return "Pull requests could not be read for this project.";
      }
      return composerTrigger?.query
        ? `No pull request matches ${composerTrigger.query}.`
        : "No pull requests found in this repository.";
    }
    return composerTriggerKind === "path"
      ? "No matching files or folders."
      : "No matching command.";
  }, [
    composerTrigger,
    composerTriggerKind,
    pullRequestLookup.data?.errors,
    pullRequestLookup.error,
    pullRequestProjectId,
    pullRequestRepository,
  ]);

  return {
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
  };
}
