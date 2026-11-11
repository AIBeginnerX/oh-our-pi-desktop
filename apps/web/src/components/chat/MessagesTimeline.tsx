import {
  TimelineRowSharedState,
  TimelineRowActivityState,
  TimelineRowCtx,
  TimelineRowActivityCtx,
  WorkGroupViewState,
  TimelineRow,
  MESSAGE_HEADING_LEVEL,
  MessageAuthorHeading,
  TimelineRowTimestamp,
} from "./MessagesTimeline.shared";
import {
  resolveTimelineRowTop,
  resolveTimelineRowHeight,
  TimelineMinimap,
} from "./MessagesTimeline.minimap";
import {
  UserMessageContextReferenceChip,
  CollapsibleUserMessageBody,
  UserMessageBody,
} from "./MessagesTimeline.userContext";
import { workEntryIconName } from "./MessagesTimeline.workEntries";
import {
  CompactingLabel,
  WorkingTimer,
  WorkGroupSection,
  ActivityShimmerOverlay,
  LiveActivityRow,
  LiveWorkEntryTimelineRow,
  WorkGroupToggleTimelineRow,
  AssistantChangedFilesSection,
} from "./MessagesTimeline.workGroup";
import { ArrowUpIcon, ClockIcon } from "lucide-react";

import { deriveTimelineMinimapItems } from "./timelineMinimapItems";
import {
  type AssistantCitation,
  type EnvironmentId,
  type MessageId,
  type ServerProviderSkill,
  type TurnId,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import type { CodexArtifactTemplate } from "@t3tools/client-runtime/codex-artifact-templates";
import {
  summarizeToolGroup,
  omitSupersededLifecycleMarkers,
} from "@t3tools/client-runtime/work-log/presentation";
import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";

import {
  emptyAgentPanelModel,
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";

const EMPTY_AGENT_PANEL_MODEL = emptyAgentPanelModel();
const NOOP_OPEN_AGENTS = () => {};
const EMPTY_QUEUED_MESSAGES: ReadonlyArray<QueuedComposerMessage> = [];
const NOOP_QUEUED_MESSAGE_ACTION = (_id: string) => {};
const NOOP_USE_ARTIFACT_TEMPLATE = () => {};
const NOOP_OPEN_ATTACHMENT = (_attachment: ChatFileAttachment) => {};
import { resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";

import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import {
  memo,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  LegendList,
  type LegendListRef,
  type MaintainScrollAtEndOptions,
} from "@legendapp/list/react";

import {
  createMessageAttachmentPreviewProjector,
  deriveTimelineEntries,
  selectMessageImageResources,
  workEntryDisplayIndicatesToolFailure,
} from "../../session-logic";
import {
  type ChatMessage,
  type ChatFileAttachment,
  type ChatImageAttachment,
  isFileAttachment,
  isImageAttachment,
  isVideoAttachment,
  type TurnDiffSummary,
} from "../../types";

import ChatMarkdown from "../ChatMarkdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";

import {
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  EyeIcon,
  Minimize2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import type { ComposerContextRecord, KnownComposerContextRecord } from "@t3tools/contracts";
import { Button } from "../ui/button";
import type { QueuedComposerMessage } from "../../queuedMessageStore";
import { useAssetUrlRefresh, useAssetUrls, useAssetUrlState } from "../../assets/assetUrls";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";

import {
  buildAttachmentVideoAsset,
  buildAttachmentVideoPreview,
  buildExpandedImagePreview,
  ExpandedImagePreview,
} from "./ExpandedImagePreview";
import {
  SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
  SnapShotAttachmentDetails,
} from "./SnapShotAttachmentDetails";
import { ProposedPlanCard } from "./ProposedPlanCard";

import { useT } from "../../i18n";

import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  readTimelinePosition,
  rememberTimelinePosition,
  timelineContentOverflowsViewport,
} from "./timelineScrollAnchoring";
import { MessageCopyButton } from "./MessageCopyButton";
import { SaveToProjectMemoryAction } from "./SaveToProjectMemoryAction";
import { PierreEntryIcon } from "./PierreEntryIcon";

import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { AssistantCitationSource, type AssistantCitationRequest } from "./AssistantCitationSource";
import { useAssistantCitationTarget, type CitationHistoryPage } from "./useAssistantCitationTarget";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  deriveUnsettledTurnId,
  type MessagesTimelineRowsProjection,
  countFailedToolEntries,
  liveWorkEntryLabel,
  workEntryIsActiveTurnActivity,
  resolveAssistantMessageCopyState,
  resolveTimelineIsAtEnd,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapCurrentIndex,
  resolveTimelineMinimapHitStripWidth,
  shouldPreserveAssistantLineBreaks,
  workEntryIsVisibleInGroup,
  worktreeSetupAgentStarted,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  type TimelineLatestTurn,
} from "./MessagesTimeline.logic";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorktreeSetupCard } from "./WorktreeSetupCard";

import {
  asKnownContextRecord,
  resolveUserMessageContext,
  selectedMessageContextFragment,
} from "~/lib/composerContextRecords";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { chatMarkdownClipboardPayload } from "../../markdown-clipboard";

import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useClientSettings } from "~/hooks/useSettings";
import { THREAD_USAGE_NOTE } from "./threadUsageText";
import type { ChatMarkdownContextReference } from "../ChatMarkdown";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";

import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";

const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FADE_HEADER = (
  <div className="h-[var(--workspace-titlebar-scroll-fade-height)]" />
);

// Header row shown when older turns exist beyond the loaded window. Plain
// button, no spinner animation; the label change is the loading indicator.
function TimelineLoadEarlierHeader({
  loading,
  onLoadEarlier,
  fade,
}: {
  loading: boolean;
  onLoadEarlier: () => void;
  fade: boolean;
}) {
  return (
    <div className={fade ? "pt-(--workspace-titlebar-scroll-fade-height)" : "pt-3 sm:pt-4"}>
      <div className="mx-auto w-full max-w-(--chat-max-width) pb-2">
        <button
          type="button"
          onClick={onLoadEarlier}
          disabled={loading}
          className="w-full py-1.5 text-xs text-muted-foreground/60 hover:text-foreground disabled:cursor-default"
        >
          {loading ? "Loading earlier turns…" : "Load earlier turns"}
        </button>
      </div>
    </div>
  );
}
function TimelineListFooter({ composerInset }: { readonly composerInset: number }) {
  return (
    <div aria-hidden>
      <div style={{ height: composerInset }} />
      <div className="h-3 sm:h-4" />
    </div>
  );
}

/**
 * One muted line after the latest settled turn. The hover text carries the
 * estimate caveat; there is deliberately no animation and no interaction.
 */
function TimelineUsageFooterRow({
  text,
  audit,
}: {
  readonly text: string;
  readonly audit: boolean;
}) {
  const t = useT();
  return (
    <div className="mx-auto w-full max-w-(--chat-max-width) pb-3 sm:pb-4">
      {audit ? (
        <p className="text-muted-foreground text-xs">{text}</p>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<p className="text-muted-foreground text-xs" />}>
            {text}
          </TooltipTrigger>
          <TooltipPopup side="top">{t(THREAD_USAGE_NOTE)}</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const TIMELINE_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: {
    dataChange: true,
    // Composer inset changes must not move already-visible messages. New
    // rows and row growth still keep live-follow pinned through the other
    // triggers below.
    footerLayout: false,
    itemLayout: true,
    layout: true,
  },
} as const satisfies MaintainScrollAtEndOptions;
// Streamed text lands a paragraph at a time. A smooth scroll to the end
// turns each landing into a short glide instead of a jump. Thread switches
// and layout settles keep the instant variant so nothing visibly travels.
const TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH = {
  ...TIMELINE_MAINTAIN_SCROLL_AT_END,
  animated: true,
} as const satisfies MaintainScrollAtEndOptions;

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  citationRequest?: AssistantCitationRequest | null;
  citationHistoryLoading?: boolean;
  onCiteAssistantText?: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  agentPanelModel?: AgentPanelModel;
  onOpenAgents?: () => void;
  isWorking: boolean;
  /** Settled usage footer text; rendered only while no turn is running. */
  threadUsageFooter?: string | null;
  threadAuditRunning?: boolean;
  isPreparingWorktree?: boolean;
  isCompacting?: boolean;
  activeTurnStartedAt: string | null;
  /** Live bootstrap progress for this thread, or null when none is tracked. */
  worktreeSetup?: WorktreeSetupSnapshot | null;
  onCancelWorktreeSetup?: () => void;
  onWorktreeSetupWorkLocally?: () => void;
  onOpenWorktreeSetupTerminal?: (terminalId: string) => void;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  latestTurn: TimelineLatestTurn | null;
  runningTurnId: TurnId | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  routeThreadKey: string;
  /**
   * Thread whose entries are currently painted. Differs from `routeThreadKey`
   * while a jump is still holding the previous list. Identity for row
   * projection and list extraData — do not remount on this value.
   */
  displayThreadKey?: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  supportsConversationRollback: boolean;
  onRevertToTurnCount: (targetTurnCount: number, messageId: MessageId) => void;
  onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
  onRunShellCommand?: (command: string) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onFileOpen?: (attachment: ChatFileAttachment) => void;
  onFileDownload?: (attachment: ChatFileAttachment) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  anchorMessageId: MessageId | null;
  onAnchorReady: (messageId: MessageId, anchorIndex: number) => void;
  contentInsetEndAdjustment: number;
  /**
   * Whether the timeline should keep pinning to the live edge as content
   * grows. Off while the user is reading history; LegendList's own
   * maintainScrollAtEnd would otherwise re-pin regardless of ChatView's
   * scroll-mode refs whenever the user drifts near the bottom.
   */
  liveFollowEnabled: boolean;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  /**
   * Whether the real rows extend past the viewport above the composer.
   * Reported after scrolls, row size changes, and viewport resizes.
   */
  onContentOverflowChange?: (overflows: boolean) => void;
  onToolOutputCollapsedAtEnd?: () => void;
  onManualNavigation: () => void;
  cancelPositionRestoreRef?: React.RefObject<(() => void) | null>;
  hideEmptyPlaceholder?: boolean;
  topFadeEnabled?: boolean;
  /** Non-null when older turns exist beyond the loaded window. */
  loadEarlier?: CitationHistoryPage | null;
  /** Messages sent during the running turn. They render as ghost bubbles after the live rows. */
  queuedMessages?: ReadonlyArray<QueuedComposerMessage>;
  onSteerQueuedMessage?: (id: string) => void;
  steerQueuedMessageShortcutLabel?: string | null;
  onRemoveQueuedMessage?: (id: string) => void;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  citationRequest = null,
  citationHistoryLoading = false,
  onCiteAssistantText,
  isWorking,
  threadUsageFooter = null,
  threadAuditRunning = false,
  worktreeSetup = null,
  onCancelWorktreeSetup,
  onWorktreeSetupWorkLocally,
  onOpenWorktreeSetupTerminal,
  isPreparingWorktree = false,
  isCompacting = false,
  activeTurnStartedAt,
  agentPanelModel,
  onOpenAgents = NOOP_OPEN_AGENTS,
  listRef,
  timelineEntries,
  latestTurn,
  runningTurnId,
  turnDiffSummaries,
  routeThreadKey,
  displayThreadKey,
  onOpenTurnDiff,
  supportsConversationRollback,
  onRevertToTurnCount,
  onUseArtifactTemplate = NOOP_USE_ARTIFACT_TEMPLATE,
  onRunShellCommand,
  isRevertingCheckpoint,
  onImageExpand,
  onFileOpen = NOOP_OPEN_ATTACHMENT,
  onFileDownload = NOOP_OPEN_ATTACHMENT,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  anchorMessageId,
  onAnchorReady,
  contentInsetEndAdjustment,
  liveFollowEnabled,
  onIsAtEndChange,
  onContentOverflowChange,
  onToolOutputCollapsedAtEnd,
  onManualNavigation,
  cancelPositionRestoreRef,
  hideEmptyPlaceholder = false,
  topFadeEnabled = false,
  loadEarlier = null,
  queuedMessages = EMPTY_QUEUED_MESSAGES,
  onSteerQueuedMessage = NOOP_QUEUED_MESSAGE_ACTION,
  steerQueuedMessageShortcutLabel = null,
  onRemoveQueuedMessage = NOOP_QUEUED_MESSAGE_ACTION,
}: MessagesTimelineProps) {
  const threadUsageFooterText = !isWorking && threadUsageFooter ? threadUsageFooter : null;
  const listIdentityKey = displayThreadKey ?? routeThreadKey;
  const rememberedPosition = useMemo(
    () => readTimelinePosition(listIdentityKey),
    [listIdentityKey],
  );
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<TurnId>>(
    () => rememberedPosition?.disclosures?.turns ?? new Set(),
  );
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(
    () => rememberedPosition?.disclosures?.workGroups ?? new Set(),
  );
  const [expandedSpawnEntryIds, setExpandedSpawnEntryIds] = useState<ReadonlySet<string>>(
    () => rememberedPosition?.disclosures?.spawnEntries ?? new Set(),
  );
  const [expandedReasoningMessageIds, setExpandedReasoningMessageIds] = useState<
    ReadonlySet<string>
  >(() => rememberedPosition?.disclosures?.reasoningMessages ?? new Set());
  const [positionedThreadKey, setPositionedThreadKey] = useState<string | null>(() =>
    rememberedPosition?.atEnd === false ? null : listIdentityKey,
  );
  const restoringThreadPosition = positionedThreadKey !== listIdentityKey;
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const listIdentityRef = useRef(listIdentityKey);
  const previousLatestTurnRef = useRef(latestTurn);
  // The list stays mounted across thread switches. Its first end pins on the
  // new thread must snap, not glide, even if that thread is mid-turn.
  const [settlingListIdentity, setSettlingListIdentity] = useState<string | null>(null);
  let paintedExpandedTurnIds = expandedTurnIds;
  let paintedExpandedWorkGroupIds = expandedWorkGroupIds;
  let paintedExpandedSpawnEntryIds = expandedSpawnEntryIds;
  let paintedExpandedReasoningMessageIds = expandedReasoningMessageIds;
  if (listIdentityRef.current !== listIdentityKey) {
    listIdentityRef.current = listIdentityKey;
    setPositionedThreadKey(null);
    previousLatestTurnRef.current = latestTurn;
    setSettlingListIdentity(listIdentityKey);
    paintedExpandedTurnIds = rememberedPosition?.disclosures?.turns ?? new Set();
    paintedExpandedWorkGroupIds = rememberedPosition?.disclosures?.workGroups ?? new Set();
    paintedExpandedSpawnEntryIds = rememberedPosition?.disclosures?.spawnEntries ?? new Set();
    paintedExpandedReasoningMessageIds =
      rememberedPosition?.disclosures?.reasoningMessages ?? new Set();
    setExpandedTurnIds(paintedExpandedTurnIds);
    setExpandedWorkGroupIds(paintedExpandedWorkGroupIds);
    setExpandedSpawnEntryIds(paintedExpandedSpawnEntryIds);
    setExpandedReasoningMessageIds(paintedExpandedReasoningMessageIds);
  }
  const onToggleSpawnRow = useCallback((entryId: string, expanded: boolean) => {
    setExpandedSpawnEntryIds((current) => {
      if (current.has(entryId) === expanded) return current;
      const next = new Set(current);
      if (expanded) next.add(entryId);
      else next.delete(entryId);
      return next;
    });
  }, []);
  const citationThreadRef = useMemo(() => parseScopedThreadKey(routeThreadKey), [routeThreadKey]);
  const openPullRequest = useOpenPrLink(citationThreadRef ?? undefined);
  const expandCitedTurn = useCallback((turnId: TurnId) => {
    setExpandedTurnIds((current) =>
      current.has(turnId) ? current : new Set([...current, turnId]),
    );
  }, []);
  // Nested tool state shares the bounded thread-position cache.
  const workGroupViewState = useMemo<WorkGroupViewState>(
    () =>
      rememberedPosition?.disclosures?.workGroupState ?? {
        scrollPositions: new Map(),
        expandedEntries: new Set(),
      },
    [listIdentityKey, rememberedPosition],
  );
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  const disclosureSettleSecondFrameRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (disclosureSettleFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleFrameRef.current);
      }
      if (disclosureSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (settlingListIdentity === null) return;
    // Two frames covers the fresh-data layout pass and the initial end pin.
    let second: number | null = null;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        setSettlingListIdentity((current) => (current === settlingListIdentity ? null : current));
      });
    });
    return () => {
      cancelAnimationFrame(first);
      if (second !== null) cancelAnimationFrame(second);
    };
  }, [settlingListIdentity]);

  const suspendEndScrollMaintenanceForDisclosure = useCallback(
    (anchorKey: string, collapsed = false) => {
      disclosureAnchorKeyRef.current = anchorKey;
      setDisclosureToggleSettling(true);
      if (disclosureSettleFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleFrameRef.current);
      }
      if (disclosureSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
      }
      disclosureSettleFrameRef.current = requestAnimationFrame(() => {
        disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
          disclosureAnchorKeyRef.current = null;
          setDisclosureToggleSettling(false);
          disclosureSettleFrameRef.current = null;
          disclosureSettleSecondFrameRef.current = null;
          // Wait for row measurement and the disclosure click's blur check.
          // Closing output can reveal the end without a scroll event.
          if (collapsed && resolveTimelineIsAtEnd(listRef.current?.getState()) === true) {
            onToolOutputCollapsedAtEnd?.();
          }
        });
      });
    },
    [listRef, onToolOutputCollapsedAtEnd],
  );

  const shouldRestoreVisibleContentPosition = useCallback((row: MessagesTimelineRow) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || row.id === disclosureAnchorKey;
  }, []);

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition,
    }),
    [shouldRestoreVisibleContentPosition],
  );

  const onToggleTurnFold = useCallback(
    (turnId: TurnId) => {
      suspendEndScrollMaintenanceForDisclosure(`turn-fold:${turnId}`);
      setExpandedTurnIds((existing) => {
        const next = new Set(existing);
        if (next.has(turnId)) {
          next.delete(turnId);
        } else {
          next.add(turnId);
        }
        return next;
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );
  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorKey: string) => {
      suspendEndScrollMaintenanceForDisclosure(anchorKey, expandedWorkGroupIds.has(groupId));
      setExpandedWorkGroupIds((existing) => {
        const next = new Set(existing);
        if (next.has(groupId)) {
          next.delete(groupId);
        } else {
          next.add(groupId);
        }
        return next;
      });
    },
    [expandedWorkGroupIds, suspendEndScrollMaintenanceForDisclosure],
  );
  const onToggleReasoning = useCallback(
    (messageId: string, expanded: boolean, anchorKey: string) => {
      suspendEndScrollMaintenanceForDisclosure(anchorKey, !expanded);
      setExpandedReasoningMessageIds((current) => {
        if (current.has(messageId) === expanded) return current;
        const next = new Set(current);
        if (expanded) next.add(messageId);
        else next.delete(messageId);
        return next;
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  // An in-session interrupt leaves its turn expanded so the user keeps their
  // place; the next turn (or a reload, since this is local state) folds it.
  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = latestTurn;
    if (!latestTurn || previous?.turnId === undefined) {
      return;
    }
    if (latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && latestTurn.state === "interrupted") {
        setExpandedTurnIds((existing) => {
          const next = new Set(existing);
          next.add(latestTurn.turnId);
          return next;
        });
      }
      return;
    }
    setExpandedTurnIds((existing) => {
      if (!existing.has(previous.turnId)) {
        return existing;
      }
      const next = new Set(existing);
      next.delete(previous.turnId);
      return next;
    });
  }, [latestTurn]);

  const rowsProjectionRef = useRef<{
    threadKey: string;
    workspaceRoot: string | undefined;
    projection: MessagesTimelineRowsProjection;
  } | null>(null);
  // Match the row header's liveness, retaining projection input identity
  // across unrelated panel updates.
  const liveAgentTaskKey = useMemo(() => {
    if (agentPanelModel === undefined) return undefined;
    const ids: string[] = [];
    const consider = (agent: { id: string; status: RuntimeSubagent["status"] }) => {
      if (isActiveSubagentStatus(agent.status)) ids.push(agent.id);
    };
    agentPanelModel.directAgents.forEach(consider);
    for (const group of agentPanelModel.workflows) {
      if (!isTerminalSubagentStatus(group.workflow.status)) ids.push(group.workflow.id);
      group.unphasedMembers.forEach(consider);
      group.phases.forEach((phase) => phase.members.forEach(consider));
    }
    return ids.sort().join("\n");
  }, [agentPanelModel]);
  const liveAgentTaskIds = useMemo(
    () =>
      liveAgentTaskKey === undefined
        ? undefined
        : new Set(liveAgentTaskKey.length > 0 ? liveAgentTaskKey.split("\n") : []),
    [liveAgentTaskKey],
  );
  const rawRows = useMemo(() => {
    const previous = rowsProjectionRef.current;
    const projection = deriveMessagesTimelineRowsWithState(
      {
        timelineEntries,
        latestTurn,
        runningTurnId,
        expandedTurnIds: paintedExpandedTurnIds,
        expandedWorkGroupIds: paintedExpandedWorkGroupIds,
        isWorking,
        activeTurnStartedAt,
        turnDiffSummaries,
        supportsConversationRollback,
        liveAgentTaskIds,
        worktreeSetup,
        queuedMessages,
      },
      previous?.threadKey === listIdentityKey && previous.workspaceRoot === workspaceRoot
        ? previous.projection
        : null,
    );
    rowsProjectionRef.current = { threadKey: listIdentityKey, workspaceRoot, projection };
    return projection.rows;
  }, [
    rowsProjectionRef,
    listIdentityKey,
    workspaceRoot,
    timelineEntries,
    latestTurn,
    runningTurnId,
    paintedExpandedTurnIds,
    paintedExpandedWorkGroupIds,
    isWorking,
    activeTurnStartedAt,
    turnDiffSummaries,
    supportsConversationRollback,
    liveAgentTaskIds,
    worktreeSetup,
    queuedMessages,
  ]);
  const rows = useStableRows(rawRows, listIdentityKey);
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);
  const restoreRowIndex =
    restoringThreadPosition && rememberedPosition?.atEnd === false
      ? rows.findIndex((row) => row.id === rememberedPosition.rowId)
      : -1;
  const restoringAlwaysRender = useMemo(
    () =>
      restoringThreadPosition && restoreRowIndex >= 0 ? { indices: [restoreRowIndex] } : undefined,
    [restoreRowIndex, restoringThreadPosition],
  );
  useLayoutEffect(() => {
    if (!restoringThreadPosition || rows.length === 0) return;
    const list = listRef.current;
    if (!list) return;
    if (citationRequest !== null) {
      setPositionedThreadKey(listIdentityKey);
      return;
    }
    let cancelled = false;
    let settleFrame: number | null = null;
    const viewport: HTMLElement | null = list.getScrollableNode();
    const cancelRestoration = () => {
      if (cancelled) return;
      cancelled = true;
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      // Supersede any pending estimated-index scroll before the browser applies the gesture.
      if (viewport) void list.scrollToOffset({ offset: viewport.scrollTop, animated: false });
      setPositionedThreadKey(listIdentityKey);
    };
    const cancelForNavigation = () => {
      cancelRestoration();
      onManualNavigation();
    };
    const onScrollKey = (event: globalThis.KeyboardEvent) => {
      if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
        !(
          event.target instanceof Element &&
          event.target.closest("input, textarea, [contenteditable=true]")
        )
      )
        cancelForNavigation();
    };
    viewport?.addEventListener("wheel", cancelForNavigation, { passive: true });
    viewport?.addEventListener("touchmove", cancelForNavigation, { passive: true });
    viewport?.addEventListener("pointerdown", cancelForNavigation, { passive: true });
    viewport?.ownerDocument.addEventListener("keydown", onScrollKey);
    const position = rememberedPosition;
    const index = position ? rows.findIndex((row) => row.id === position.rowId) : -1;
    if (position?.atEnd === false) onManualNavigation();
    if (cancelPositionRestoreRef) cancelPositionRestoreRef.current = cancelRestoration;
    const scrolling =
      position?.atEnd === false
        ? index >= 0
          ? list.scrollToIndex({
              index,
              animated: false,
              viewPosition: 0,
              viewOffset: -position.offsetWithinRow,
            })
          : list.scrollToOffset({ offset: position.scrollOffset, animated: false })
        : list.scrollToEnd({ animated: false });
    void Promise.resolve(scrolling).then(() => {
      if (cancelled) return;
      if (position?.atEnd !== false || index < 0) {
        setPositionedThreadKey(listIdentityKey);
        return;
      }
      // Index scrolling starts from estimates. Keep the saved row mounted
      // until its measured position and the DOM agree for two layout frames.
      let stableFrames = 0;
      const reconcile = () => {
        if (cancelled) return;
        const state = list.getState();
        const rowIndex = state.indexByKey(position.rowId);
        const row = rowIndex === undefined ? undefined : state.elementAtIndex(rowIndex);
        const element = list.getScrollableNode();
        if (!row || !element) return;
        const offset = Math.max(
          0,
          Math.min(
            element.scrollTop +
              row.getBoundingClientRect().top -
              element.getBoundingClientRect().top +
              position.offsetWithinRow,
            element.scrollHeight - element.clientHeight,
          ),
        );
        if (Math.abs(element.scrollTop - offset) > 1) {
          stableFrames = 0;
          void list.scrollToOffset({ offset, animated: false }).then(() => {
            if (!cancelled) settleFrame = requestAnimationFrame(reconcile);
          });
          return;
        }
        if (++stableFrames >= 2) {
          setPositionedThreadKey(listIdentityKey);
        } else {
          settleFrame = requestAnimationFrame(reconcile);
        }
      };
      settleFrame = requestAnimationFrame(reconcile);
    });
    return () => {
      cancelled = true;
      if (cancelPositionRestoreRef?.current === cancelRestoration) {
        cancelPositionRestoreRef.current = null;
      }
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      viewport?.removeEventListener("wheel", cancelForNavigation);
      viewport?.removeEventListener("touchmove", cancelForNavigation);
      viewport?.removeEventListener("pointerdown", cancelForNavigation);
      viewport?.ownerDocument.removeEventListener("keydown", onScrollKey);
    };
  }, [
    citationRequest,
    cancelPositionRestoreRef,
    listIdentityKey,
    listRef,
    onManualNavigation,
    rememberedPosition,
    restoringThreadPosition,
    rows,
  ]);

  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  // Re-measure the minimap gutter when the chat column changes width without a viewport resize.
  const chatWidth = useClientSettings((settings) => settings.chatWidth);
  const {
    target: readyCitationRequest,
    positioning: citationPositioning,
    onListLoad: onCitationListLoad,
    alwaysRender: citationAlwaysRender,
  } = useAssistantCitationTarget({
    request: citationRequest,
    entries: timelineEntries,
    rows,
    listRef,
    viewport: timelineViewportElement,
    historyLoading: citationHistoryLoading,
    loadEarlier,
    onExpandTurn: expandCitedTurn,
    onManualNavigation,
  });
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  const alwaysRender = citationAlwaysRender ?? restoringAlwaysRender;
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0);
  const [minimapCurrentIndex, setMinimapCurrentIndex] = useState<number | null>(null);
  const handleAnchorReady = useCallback(
    (info: { anchorIndex: number | undefined }) => {
      if (anchorMessageId !== null && info.anchorIndex !== undefined) {
        onAnchorReady(anchorMessageId, info.anchorIndex);
      }
    },
    [anchorMessageId, onAnchorReady],
  );
  const anchoredEndSpace = useMemo(() => {
    const config = resolveChatListAnchoredEndSpace(
      rows,
      anchorMessageId,
      (row) => (row.kind === "message" && row.message.role === "user" ? row.message.id : null),
      { anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET },
    );
    return config ? { ...config, onReady: handleAnchorReady } : undefined;
  }, [anchorMessageId, handleAnchorReady, rows]);
  const timelineListFooter = useMemo(
    () => (
      <>
        {threadUsageFooterText !== null ? (
          <TimelineUsageFooterRow text={threadUsageFooterText} audit={threadAuditRunning} />
        ) : null}
        <TimelineListFooter composerInset={anchoredEndSpace ? 0 : contentInsetEndAdjustment} />
      </>
    ),
    [anchoredEndSpace, contentInsetEndAdjustment, threadUsageFooterText, threadAuditRunning],
  );

  const measureContentOverflow = useCallback(
    () =>
      timelineContentOverflowsViewport(listRef.current?.getState?.(), {
        composerInset: contentInsetEndAdjustment,
        anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
      }),
    [contentInsetEndAdjustment, listRef],
  );
  // LegendList lays rows out from layout effects, so a read on the next frame
  // sees the settled positions. One frame is shared across bursts of size
  // changes.
  const contentOverflowFrameRef = useRef<number | null>(null);
  const cancelContentOverflowFrame = useCallback(() => {
    if (contentOverflowFrameRef.current !== null) {
      cancelAnimationFrame(contentOverflowFrameRef.current);
      contentOverflowFrameRef.current = null;
    }
  }, []);
  const reportContentOverflow = useCallback(() => {
    if (!onContentOverflowChange || contentOverflowFrameRef.current !== null) return;
    contentOverflowFrameRef.current = requestAnimationFrame(() => {
      contentOverflowFrameRef.current = null;
      onContentOverflowChange(measureContentOverflow());
    });
  }, [measureContentOverflow, onContentOverflowChange]);
  useEffect(() => cancelContentOverflowFrame, [cancelContentOverflowFrame]);
  // The list's own layout effects have already run here, so estimated row
  // positions are in place. Reporting before the first paint lets a thread
  // open in its final composer layout instead of correcting it a frame later.
  // A frame scheduled with the previous inset would overwrite this read, so
  // it is dropped first.
  useLayoutEffect(() => {
    cancelContentOverflowFrame();
    onContentOverflowChange?.(measureContentOverflow());
  }, [cancelContentOverflowFrame, measureContentOverflow, onContentOverflowChange, rows.length]);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (restoringThreadPosition || state?.data !== rows) return;
    const isAtEnd = resolveTimelineIsAtEnd(state);
    const position = state?.data?.length ? resolveWorkGroupScrollAnchor(state) : undefined;
    if (position && state && isAtEnd !== undefined) {
      const index = state.indexByKey(position.rowId);
      const row = index === undefined ? undefined : state.elementAtIndex(index);
      const element = listRef.current?.getScrollableNode();
      if (row && element) {
        rememberTimelinePosition(listIdentityKey, {
          ...position,
          // DOM geometry includes the header and the virtualizer's layout adjustment.
          offsetWithinRow: element.getBoundingClientRect().top - row.getBoundingClientRect().top,
          scrollOffset: element.scrollTop,
          atEnd: isAtEnd,
          disclosures: {
            turns: paintedExpandedTurnIds,
            workGroups: paintedExpandedWorkGroupIds,
            spawnEntries: paintedExpandedSpawnEntryIds,
            reasoningMessages: paintedExpandedReasoningMessageIds,
            workGroupState: workGroupViewState,
          },
        });
      }
    }
    if (isAtEnd !== undefined && !citationPositioning) {
      onIsAtEndChange(isAtEnd);
    }
    reportContentOverflow();
    if (!state || minimapItems.length === 0) {
      return;
    }

    const scrollTop = state.scroll ?? 0;
    const scrollBottom = scrollTop + (state.scrollLength ?? 0);

    const itemBounds = minimapItems.map((item) => ({
      top: resolveTimelineRowTop(state, item.rowIndex),
      height: resolveTimelineRowHeight(state, item.rowIndex),
    }));

    for (const [index, item] of minimapItems.entries()) {
      const strip = minimapStripMap.get(item.id);
      const bounds = itemBounds[index];
      const rowTop = bounds?.top ?? null;
      const rowHeight = bounds?.height ?? null;
      const inView =
        rowTop !== null &&
        rowTop < scrollBottom &&
        rowTop + Math.max(1, rowHeight ?? 1) > scrollTop;

      if (strip) {
        strip.dataset.inView = inView ? "true" : "false";
      }
    }
    const nextCurrentIndex = resolveTimelineMinimapCurrentIndex({
      scrollTop,
      scrollBottom,
      itemBounds,
    });
    setMinimapCurrentIndex((current) =>
      current === nextCurrentIndex ? current : nextCurrentIndex,
    );
  }, [
    citationPositioning,
    paintedExpandedTurnIds,
    paintedExpandedWorkGroupIds,
    paintedExpandedSpawnEntryIds,
    paintedExpandedReasoningMessageIds,
    workGroupViewState,
    rows,
    listIdentityKey,
    restoringThreadPosition,
    listRef,
    minimapItems,
    minimapStripMap,
    onIsAtEndChange,
    reportContentOverflow,
  ]);

  useEffect(() => {
    const frame = requestAnimationFrame(handleScroll);
    return () => cancelAnimationFrame(frame);
  }, [handleScroll, rows.length]);

  useEffect(() => {
    if (!timelineViewportElement) {
      return;
    }

    const measure = () => {
      const viewportWidth = timelineViewportElement.getBoundingClientRect().width;
      // Without a mounted row, treat the column as full width so the strip stays inert.
      const contentWidth =
        timelineViewportElement
          .querySelector<HTMLElement>("[data-timeline-root]")
          ?.getBoundingClientRect().width ?? viewportWidth;
      const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(
        viewportWidth,
        contentWidth,
      );
      setMinimapHasPersistentGutter((current) =>
        current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
      );
      setMinimapHitStripWidth(resolveTimelineMinimapHitStripWidth(viewportWidth, contentWidth));
      reportContentOverflow();
    };

    const frame = requestAnimationFrame(measure);

    const observer = new ResizeObserver(measure);
    observer.observe(timelineViewportElement);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [timelineViewportElement, rows.length, reportContentOverflow, chatWidth]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      citationRequest: readyCitationRequest,
      listRef,
      timestampFormat,
      routeThreadKey,
      // Keep Markdown callbacks memoized during unrelated activity updates.
      threadRef: citationThreadRef,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      onRevertToTurnCount,
      onUseArtifactTemplate,
      onRunShellCommand,
      onImageExpand,
      onFileOpen,
      onFileDownload,
      openPullRequest,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      onToggleWorkEntry: suspendEndScrollMaintenanceForDisclosure,
      onToggleSpawnRow,
      onToggleReasoning,
      expandedReasoningMessageIds: paintedExpandedReasoningMessageIds,
      workGroupViewState,
      agentPanelModel: agentPanelModel ?? EMPTY_AGENT_PANEL_MODEL,
      expandedSpawnEntryIds: paintedExpandedSpawnEntryIds,
      onOpenAgents,
      onCancelWorktreeSetup: onCancelWorktreeSetup ?? null,
      onWorktreeSetupWorkLocally: onWorktreeSetupWorkLocally ?? null,
      onOpenWorktreeSetupTerminal: onOpenWorktreeSetupTerminal ?? null,
      onSteerQueuedMessage,
      steerQueuedMessageShortcutLabel,
      onRemoveQueuedMessage,
    }),
    [
      readyCitationRequest,
      listRef,
      timestampFormat,
      routeThreadKey,
      citationThreadRef,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      onRevertToTurnCount,
      onUseArtifactTemplate,
      onRunShellCommand,
      onImageExpand,
      onFileOpen,
      onFileDownload,
      openPullRequest,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      suspendEndScrollMaintenanceForDisclosure,
      onToggleSpawnRow,
      onToggleReasoning,
      paintedExpandedReasoningMessageIds,
      workGroupViewState,
      agentPanelModel,
      paintedExpandedSpawnEntryIds,
      onOpenAgents,
      onCancelWorktreeSetup,
      onWorktreeSetupWorkLocally,
      onOpenWorktreeSetupTerminal,
      onSteerQueuedMessage,
      steerQueuedMessageShortcutLabel,
      onRemoveQueuedMessage,
    ],
  );
  const backgroundWorktreeSetup =
    worktreeSetup !== null &&
    worktreeSetup.phase === "running" &&
    worktreeSetupAgentStarted(worktreeSetup) &&
    latestTurn?.startedAt != null
      ? worktreeSetup
      : null;
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isPreparingWorktree,
      isCompacting,
      isRevertingCheckpoint,
      latestTurnId: latestTurn?.turnId ?? null,
      // The same value the row-derivation uses, so a block and the placeholder
      // beside it can never disagree about whether a turn is still live.
      unsettledTurnId: deriveUnsettledTurnId(latestTurn ?? null, runningTurnId),
      backgroundWorktreeSetup,
    }),
    [
      backgroundWorktreeSetup,
      isCompacting,
      isRevertingCheckpoint,
      isWorking,
      isPreparingWorktree,
      // Deliberately the fields `deriveUnsettledTurnId` reads, not the object:
      // its identity changes on every thread-shell patch.
      latestTurn?.turnId,
      latestTurn?.state,
      latestTurn?.completedAt,
      runningTurnId,
    ],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div
        className="mx-auto w-full min-w-0 max-w-(--chat-max-width) overflow-x-clip"
        data-timeline-root="true"
      >
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
    if (hideEmptyPlaceholder) {
      // Occupy the pane with the theme surface so a thread switch cannot
      // punch a hole through to the window chrome (white in light mode).
      return <div className="h-full min-h-0 bg-background" data-timeline-loading="true" />;
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-placeholder text-sm">Send a message to start the conversation.</p>
      </div>
    );
  }

  return (
    <TimelineRowCtx value={sharedState}>
      <TimelineRowActivityCtx value={activityState}>
        <div
          ref={setTimelineViewportElement}
          className="relative h-full min-h-0"
          data-assistant-citation-viewport="true"
        >
          {onCiteAssistantText && citationThreadRef ? (
            <AssistantSelectionToolbar
              viewport={timelineViewportElement}
              threadRef={citationThreadRef}
              onCite={onCiteAssistantText}
            />
          ) : null}
          <LegendList<MessagesTimelineRow>
            ref={listRef}
            data={rows}
            extraData={`${listIdentityKey}:${rows.length}`}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            renderItem={renderItem}
            estimatedItemSize={90}
            initialScrollAtEnd={citationRequest === null && rememberedPosition?.atEnd !== false}
            // Legend needs a data refresh to mount new pins without a scroll event.
            dataVersion={readyCitationRequest?.key ?? listIdentityKey}
            {...(alwaysRender ? { alwaysRender } : {})}
            onLoad={onCitationListLoad}
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            contentInsetEndAdjustment={anchoredEndSpace ? contentInsetEndAdjustment : 0}
            maintainScrollAtEnd={
              citationPositioning ||
              (restoringThreadPosition && rememberedPosition?.atEnd === false) ||
              anchoredEndSpace ||
              !liveFollowEnabled ||
              disclosureToggleSettling
                ? false
                : isWorking && !prefersReducedMotion && settlingListIdentity === null
                  ? TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH
                  : TIMELINE_MAINTAIN_SCROLL_AT_END
            }
            maintainVisibleContentPosition={
              citationPositioning ||
              (restoringThreadPosition && rememberedPosition?.atEnd === false)
                ? false
                : maintainVisibleContentPosition
            }
            maintainScrollAtEndThreshold={1}
            onScroll={handleScroll}
            onItemSizeChanged={reportContentOverflow}
            className={cn(
              "scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain px-3 [overflow-anchor:none] sm:px-5",
              topFadeEnabled && "topbar-scroll-fade",
            )}
            ListHeaderComponent={
              loadEarlier !== null ? (
                <TimelineLoadEarlierHeader
                  loading={loadEarlier.loading}
                  onLoadEarlier={loadEarlier.onLoadEarlier}
                  fade={topFadeEnabled}
                />
              ) : topFadeEnabled ? (
                TIMELINE_LIST_FADE_HEADER
              ) : (
                TIMELINE_LIST_HEADER
              )
            }
            ListFooterComponent={timelineListFooter}
          />
          <TimelineMinimap
            items={minimapItems}
            hasPersistentGutter={minimapHasPersistentGutter}
            hitStripWidth={minimapHitStripWidth}
            currentIndex={minimapCurrentIndex}
            stripMap={minimapStripMap}
            onSelect={(item) => {
              onManualNavigation();
              void listRef.current?.scrollToIndex({
                index: item.rowIndex,
                animated: true,
                viewOffset: 24,
              });
            }}
          />
        </div>
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
});

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

function getItemType(item: MessagesTimelineRow) {
  return item.kind === "message" ? `message:${item.message.role}` : item.kind;
}

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  const isExpandedToolGroup = row.kind === "work" && row.isExpandedToolGroup;
  const isExpandedToolGroupHeader =
    (row.kind === "work-toggle" && row.expanded) || (row.kind === "work-live" && row.expanded);

  return (
    <div
      className={cn(
        // Commentary (non-terminal assistant) rows carry no metadata row, so
        // they sit closer to the work that follows them.
        isExpandedToolGroup
          ? "pb-1"
          : isExpandedToolGroupHeader
            ? "pb-0"
            : row.kind === "turn-fold" || row.kind === "working"
              ? "pb-1.5"
              : (row.kind === "message" &&
                    row.message.role === "assistant" &&
                    !row.showAssistantMeta) ||
                  (row.kind === "message" && row.message.role === "reasoning") ||
                  row.kind === "work" ||
                  row.kind === "work-live" ||
                  row.kind === "work-toggle" ||
                  row.kind === "activity-group" ||
                  row.kind === "thinking" ||
                  row.kind === "worktree-setup"
                ? "pb-2"
                : "pb-4",
        (row.kind === "message" && row.message.role === "assistant") ||
          row.kind === "assistant-meta"
          ? "group/assistant"
          : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={
        row.kind === "message" || row.kind === "assistant-meta" ? row.message.id : undefined
      }
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" ? (
        <WorkGroupSection
          anchorKey={row.id}
          groupedEntries={row.groupedEntries}
          isExpandedToolGroup={row.isExpandedToolGroup}
          displayLabel={row.displayLabel}
        />
      ) : null}
      {row.kind === "work-live" ? <LiveWorkEntryTimelineRow row={row} /> : null}
      {row.kind === "activity-group" ? <ActivityGroupTimelineRow row={row} /> : null}
      {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === "context-compaction" ? <ContextCompactionTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "message" && row.message.role === "reasoning" ? (
        <ReasoningTimelineRow row={row} />
      ) : null}
      {row.kind === "assistant-meta" ? <AssistantMetaTimelineRow row={row} /> : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
      {row.kind === "thinking" ? <ThinkingTimelineRow /> : null}
      {row.kind === "worktree-setup" ? <WorktreeSetupTimelineRow row={row} /> : null}
      {row.kind === "queued-message" ? <QueuedMessageTimelineRow row={row} /> : null}
    </div>
  );
});

function WorktreeSetupTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "worktree-setup" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const terminalId = row.snapshot.setupScript?.terminalId ?? null;
  const openTerminal = ctx.onOpenWorktreeSetupTerminal;
  const onOpenTerminal = useMemo(
    () => (openTerminal && terminalId ? () => openTerminal(terminalId) : null),
    [openTerminal, terminalId],
  );
  return (
    <WorktreeSetupCard
      snapshot={row.snapshot}
      embedded={row.embedded}
      onCancel={row.embedded ? null : ctx.onCancelWorktreeSetup}
      onWorkLocally={
        !row.embedded && row.snapshot.phase === "running" ? ctx.onWorktreeSetupWorkLocally : null
      }
      onOpenTerminal={onOpenTerminal}
    />
  );
}

/** A message waiting for the running turn: a dashed user bubble with icon actions inside it. */
function QueuedMessageTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "queued-message" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const { queuedMessage } = row;
  const attachmentCount = queuedMessage.images.length + queuedMessage.files.length;
  const contextCount =
    queuedMessage.terminalContexts.length +
    queuedMessage.previewAnnotations.length +
    queuedMessage.reviewComments.length;
  const text = queuedMessage.prompt.trim();
  const sending = queuedMessage.sending !== undefined;
  const statusLabel = sending
    ? "Sending to the agent"
    : queuedMessage.holdUntilUserAction
      ? "Waits for Send now"
      : row.isNext
        ? "Sends after the next tool call or when the turn ends"
        : "Sends after the messages above it";
  return (
    <div className="flex flex-col items-end" data-queued-message-id={queuedMessage.id}>
      <div className="max-w-[80%] rounded-2xl border border-dashed border-border p-3 text-message-foreground/80">
        {text.length > 0 ? (
          <UserMessageBody text={text} skills={ctx.skills} markdownCwd={ctx.markdownCwd} />
        ) : null}
        {attachmentCount > 0 || contextCount > 0 ? (
          <div className={cn("text-secondary-label text-xs", text.length > 0 && "mt-1.5")}>
            {[
              attachmentCount > 0
                ? `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
                : null,
              contextCount > 0
                ? `${contextCount} context item${contextCount === 1 ? "" : "s"}`
                : null,
            ]
              .filter(Boolean)
              .join(", ")}
          </div>
        ) : null}
        <div
          className="mt-2 flex items-center gap-4 text-secondary-label text-xs"
          data-scroll-anchor-ignore
        >
          <Tooltip>
            <TooltipTrigger
              render={<span className="inline-flex h-6 items-center gap-1" />}
              aria-label={`${sending ? "Sending" : "Queued"}. ${statusLabel}.`}
            >
              <ClockIcon className="size-3.5" aria-hidden />
              {sending ? "Sending" : "Queued"}
            </TooltipTrigger>
            <TooltipPopup side="bottom">{statusLabel}</TooltipPopup>
          </Tooltip>
          <div className={cn("ml-auto flex items-center gap-0.5", sending && "invisible")}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => ctx.onSteerQueuedMessage(queuedMessage.id)}
                    aria-label="Send now"
                  />
                }
              >
                <ArrowUpIcon className="size-3.5" aria-hidden />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                Send now
                {row.isNext && ctx.steerQueuedMessageShortcutLabel
                  ? ` (${ctx.steerQueuedMessageShortcutLabel})`
                  : null}
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => ctx.onRemoveQueuedMessage(queuedMessage.id)}
                    aria-label="Cancel and return to the composer"
                  />
                }
              >
                <XIcon className="size-3.5" aria-hidden />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Cancel and return to the composer</TooltipPopup>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}

function ContextCompactionTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "context-compaction" }>;
}) {
  return (
    <div
      role="separator"
      aria-label={row.label}
      className="mx-auto flex w-full max-w-(--chat-max-width) items-center gap-3 py-1 text-muted-foreground text-xs"
    >
      <span className="h-px flex-1 bg-border/70" />
      <span className="flex shrink-0 items-center gap-1.5">
        <Minimize2Icon aria-hidden="true" className="size-3" />
        {row.label}
      </span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

function UserVideoAttachment({ file }: { readonly file: ChatFileAttachment }) {
  const ctx = use(TimelineRowCtx);
  const asset = useMemo(
    () =>
      file.downloadable === false
        ? null
        : buildAttachmentVideoAsset(ctx.activeThreadEnvironmentId, file),
    [ctx.activeThreadEnvironmentId, file.downloadable, file.id, file.mimeType, file.name],
  );
  const resource = asset?.resource ?? null;
  const assetUrl = useAssetUrlState(ctx.activeThreadEnvironmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(ctx.activeThreadEnvironmentId, resource);
  const src = assetUrl._tag === "Success" ? assetUrl.url : (file.previewUrl ?? null);

  if (asset === null && src === null) {
    return (
      <div className="flex aspect-[4/3] w-full items-center justify-center rounded-lg border border-border/80 bg-black px-2 py-3 text-center text-2xs text-white/70">
        {file.name}
      </div>
    );
  }

  return (
    <MediaVideoPlayer
      src={src}
      sourceFailed={
        file.previewUrl === undefined && resource !== null && assetUrl._tag === "Failure"
      }
      label={file.name}
      preload="visible"
      onOpen={() => {
        const preview = buildAttachmentVideoPreview(ctx.activeThreadEnvironmentId, file);
        if (preview) ctx.onImageExpand(preview);
      }}
      className="block aspect-[4/3] w-full"
      videoClassName="aspect-auto size-full rounded-lg border border-border/80"
      stateClassName="aspect-auto min-h-full rounded-lg border border-border/80 bg-black text-white"
      onRetry={asset ? refreshAssetUrl : undefined}
      actionsSource={asset ? { kind: "video", name: file.name, src, asset } : undefined}
    />
  );
}

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const { onImageExpand, onFileOpen } = ctx;
  const resources = useMemo(
    () => selectMessageImageResources(row.message.attachments),
    [row.message.attachments],
  );
  const previewUrls = useAssetUrls(ctx.activeThreadEnvironmentId, resources);
  const [projectPreviews] = useState(createMessageAttachmentPreviewProjector);
  const messageWithPreviews = useMemo(() => {
    const urlsById = new Map(
      resources.flatMap((resource, index) => {
        const url = previewUrls[index];
        return url ? [[resource.attachmentId, url] as const] : [];
      }),
    );
    return projectPreviews(row.message, (attachment) => urlsById.get(attachment.id));
  }, [previewUrls, projectPreviews, resources, row.message]);
  // The attachment union has an open member, so guards (not literal type
  // comparisons) split it. Unknown types render as inert rows below the files.
  const userImages = useMemo(
    () => (messageWithPreviews.attachments ?? []).filter(isImageAttachment),
    [messageWithPreviews.attachments],
  );
  const userFiles = useMemo(
    () => (row.message.attachments ?? []).filter(isFileAttachment),
    [row.message.attachments],
  );
  const userVideos = userFiles.filter(isVideoAttachment);
  const otherUserFiles = userFiles.filter((file) => !isVideoAttachment(file));
  const unknownAttachments = (row.message.attachments ?? []).filter(
    (attachment) => !isImageAttachment(attachment) && !isFileAttachment(attachment),
  );
  const resolvedContext = useMemo(() => resolveUserMessageContext(row.message), [row.message]);
  const previewImages = useMemo(
    () => userImages.filter((image) => image.name.startsWith("preview-annotation-")),
    [userImages],
  );
  const revertTurnCount = row.revertTurnCount;
  // A file with a chip in the prose needs no standalone row. Media is the exception: the
  // thumbnail is the only way to actually see it, so it shows whether or not it has a chip.
  const chippedAttachmentIds = new Set(
    collectComposerContextReferences(resolvedContext.text).flatMap((occurrence) => {
      const record = asKnownContextRecord(resolvedContext.recordsById.get(occurrence.contextId));
      return record?.kind === "file" || record?.kind === "image" ? [record.attachmentId] : [];
    }),
  );
  const regularImages = userImages.filter((image) => !image.name.startsWith("preview-annotation-"));
  const unchippedFiles = otherUserFiles.filter((file) => !chippedAttachmentIds.has(file.id));
  const annotationRecordIds = useMemo(
    () =>
      resolvedContext.records
        .filter((record) => record.kind === "preview-annotation")
        .map((record) => record.contextId),
    [resolvedContext.records],
  );
  const contextClipboardFragment =
    resolvedContext.records.length === 0
      ? null
      : encodeComposerContextFragment({
          version: 1,
          source: {
            environmentId: ctx.activeThreadEnvironmentId,
            ...(ctx.threadRef ? { threadId: ctx.threadRef.threadId } : {}),
            messageId: row.message.id,
          },
          records: resolvedContext.records,
        });
  // Chips inside the selection copy as their links (data-markdown-copy); the structured
  // fragment rides beside so a paste into a draft brings the payloads along. Only records
  // for chips that are actually inside the selection travel, so copying prose next to an
  // image never starts importing that image somewhere else.
  const onBodyCopyCapture = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (resolvedContext.records.length === 0 || !event.clipboardData) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const copiedMarkdown: string[] = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const container = document.createElement("div");
      container.appendChild(selection.getRangeAt(index).cloneContents());
      for (const element of container.querySelectorAll("[data-markdown-copy]")) {
        copiedMarkdown.push(element.getAttribute("data-markdown-copy") ?? "");
      }
    }
    const fragment = selectedMessageContextFragment({
      markdown: copiedMarkdown.join("\n"),
      records: resolvedContext.records,
      environmentId: ctx.activeThreadEnvironmentId,
      ...(ctx.threadRef ? { threadId: ctx.threadRef.threadId } : {}),
      messageId: row.message.id,
    });
    if (!fragment) return;
    // Claim the copy: without preventDefault the browser default overwrites the
    // custom MIME type. The default content must then be written back explicitly.
    const payload = chatMarkdownClipboardPayload(selection);
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload?.text ?? selection.toString());
    if (payload) {
      event.clipboardData.setData(
        "text/html",
        encodeComposerContextClipboardHtml(payload.text, fragment, payload.html),
      );
    }
    event.clipboardData.setData(COMPOSER_CONTEXT_CLIPBOARD_MIME, fragment);
  };
  const renderContextReference = useCallback(
    (reference: ChatMarkdownContextReference) => {
      const record = asKnownContextRecord(resolvedContext.recordsById.get(reference.contextId));
      // Structured annotations point at the image record, which in turn points at the persisted
      // attachment. Filename and order are compatibility fallbacks for legacy messages only.
      const annotationImage =
        record?.kind === "preview-annotation"
          ? resolvePreviewAnnotationImage({
              record,
              recordsById: resolvedContext.recordsById,
              userImages,
              previewImages,
              annotationRecordIds,
            })
          : null;
      const attachment =
        record?.kind === "image"
          ? (userImages.find((image) => image.id === record.attachmentId) ?? null)
          : record?.kind === "file"
            ? (userFiles.find((file) => file.id === record.attachmentId) ?? null)
            : null;
      return (
        <UserMessageContextReferenceChip
          reference={reference}
          record={record}
          annotationImage={annotationImage}
          attachment={attachment}
          onExpandImage={(image) => {
            const preview = buildExpandedImagePreview(userImages, image.id);
            if (preview) onImageExpand(preview);
          }}
          onOpenFile={onFileOpen}
          onExpandVideo={(file) => {
            const preview = buildAttachmentVideoPreview(ctx.activeThreadEnvironmentId, file);
            if (preview) onImageExpand(preview);
          }}
        />
      );
    },
    [
      resolvedContext.recordsById,
      userImages,
      userFiles,
      previewImages,
      annotationRecordIds,
      onImageExpand,
      onFileOpen,
      ctx.activeThreadEnvironmentId,
    ],
  );

  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
        <MessageAuthorHeading>You</MessageAuthorHeading>
        {(regularImages.length > 0 || userVideos.length > 0) && (
          <div className="mb-2 grid max-w-[210px] grid-cols-2 gap-2">
            {regularImages.map((image) => (
              <div
                key={image.id}
                className={cn(
                  "bg-background/70",
                  image.source?.kind === "snap-shot" && image.previewUrl
                    ? cn(SNAP_SHOT_ATTACHMENT_FRAME_CLASS, "col-span-2")
                    : "aspect-[4/3] overflow-hidden rounded-lg border border-border/80",
                )}
              >
                {image.previewUrl ? (
                  <button
                    type="button"
                    className="block h-full w-full cursor-zoom-in"
                    aria-label={`Preview ${image.name}`}
                    onClick={() => {
                      const preview = buildExpandedImagePreview(regularImages, image.id);
                      if (!preview) return;
                      ctx.onImageExpand(preview);
                    }}
                  >
                    <img
                      src={image.previewUrl}
                      alt={image.name}
                      className="block size-full object-cover"
                    />
                  </button>
                ) : (
                  <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-secondary-label text-2xs">
                    {image.name}
                  </div>
                )}
                {image.previewUrl && image.source?.kind === "snap-shot" ? (
                  <SnapShotAttachmentDetails source={image.source} />
                ) : null}
              </div>
            ))}
            {userVideos.map((file) => (
              <UserVideoAttachment key={file.id} file={file} />
            ))}
          </div>
        )}
        {unchippedFiles.length > 0 || unknownAttachments.length > 0 ? (
          <div className="mb-2 flex flex-col gap-1">
            {unchippedFiles.map((file) => {
              const fileIdentity = (
                <>
                  <PierreEntryIcon pathValue={file.name} kind="file" theme={ctx.resolvedTheme} />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                </>
              );
              if (file.downloadable !== false) {
                return (
                  <div key={file.id} className="flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Preview ${file.name}`}
                      onClick={() => ctx.onFileOpen(file)}
                      className="focus-visible:ring-ring/70 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1 text-left text-sm hover:underline focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
                    >
                      {fileIdentity}
                      <EyeIcon className="size-4 shrink-0" />
                    </button>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label={`Download ${file.name}`}
                            onClick={() => ctx.onFileDownload(file)}
                          />
                        }
                      >
                        <DownloadIcon />
                      </TooltipTrigger>
                      <TooltipPopup side="top">Download {file.name}</TooltipPopup>
                    </Tooltip>
                  </div>
                );
              }

              return (
                <div key={file.id} className="flex min-w-0 items-center gap-2 py-1 text-sm">
                  {fileIdentity}
                </div>
              );
            })}
            {unknownAttachments.map((attachment) => (
              <div key={attachment.id} className="flex min-w-0 items-center gap-2 py-1 text-sm">
                <PierreEntryIcon
                  pathValue={attachment.name}
                  kind="file"
                  theme={ctx.resolvedTheme}
                />
                <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div onCopyCapture={onBodyCopyCapture}>
          <CollapsibleUserMessageBody
            text={resolvedContext.text}
            renderContextReference={renderContextReference}
            skills={ctx.skills}
            markdownCwd={ctx.markdownCwd}
          />
        </div>
      </div>
      <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
              {formatDayAwareTimestamp(row.message.createdAt, ctx.timestampFormat)}
            </TooltipTrigger>
            <TooltipPopup>
              {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
            </TooltipPopup>
          </Tooltip>
          <div className="flex items-center gap-0.5">
            {typeof revertTurnCount === "number" && (
              <RevertUserMessageButton turnCount={revertTurnCount} messageId={row.message.id} />
            )}
            {resolvedContext.text && (
              <MessageCopyButton
                // Structured paste needs the canonical links to retain their positions.
                text={
                  contextClipboardFragment
                    ? resolvedContext.text
                    : replaceComposerContextReferences(
                        resolvedContext.text,
                        (reference) => reference.label,
                      )
                }
                {...(contextClipboardFragment
                  ? {
                      extraFlavors: { [COMPOSER_CONTEXT_CLIPBOARD_MIME]: contextClipboardFragment },
                    }
                  : {})}
                variant="ghost"
              />
            )}
            {resolvedContext.text && (
              <SaveToProjectMemoryAction
                environmentId={ctx.activeThreadEnvironmentId}
                threadId={ctx.threadRef?.threadId ?? null}
                messageId={row.message.id}
                text={resolvedContext.text}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function resolvePreviewAnnotationImage(input: {
  record: Extract<KnownComposerContextRecord, { kind: "preview-annotation" }>;
  recordsById: ReadonlyMap<string, ComposerContextRecord>;
  userImages: ReadonlyArray<ChatImageAttachment>;
  previewImages: ReadonlyArray<ChatImageAttachment>;
  annotationRecordIds: ReadonlyArray<string>;
}): ChatImageAttachment | null {
  const screenshotRecord = input.record.screenshotContextId
    ? asKnownContextRecord(input.recordsById.get(input.record.screenshotContextId))
    : undefined;
  return (
    (screenshotRecord?.kind === "image"
      ? input.userImages.find((image) => image.id === screenshotRecord.attachmentId)
      : undefined) ??
    input.previewImages.find(
      (image) => image.name === `preview-annotation-${input.record.annotationId}.png`,
    ) ??
    input.previewImages[input.annotationRecordIds.indexOf(input.record.contextId)] ??
    null
  );
}

function RevertUserMessageButton({
  turnCount,
  messageId,
}: {
  turnCount: number;
  messageId: MessageId;
}) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activity.isRevertingCheckpoint || activity.isWorking}
            onClick={() => ctx.onRevertToTurnCount(turnCount, messageId)}
            aria-label="Edit from here"
          />
        }
      >
        <Undo2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Edit from here</TooltipPopup>
    </Tooltip>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  const Icon = row.expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="group/timeline-row relative flex items-center gap-1 border-b border-border/60 pb-2 pe-0.5 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        onClick={() => ctx.onToggleTurnFold(row.turnId)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{row.label}</span>
        <Icon className="size-3.5" />
      </button>
      <TimelineRowTimestamp
        createdAt={row.createdAt}
        timestampFormat={ctx.timestampFormat}
        className="ms-auto"
      />
    </div>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        <MessageAuthorHeading>OOP</MessageAuthorHeading>
        <AssistantCitationSource
          messageId={row.message.id}
          {...(ctx.threadRef ? { threadRef: ctx.threadRef } : {})}
          itemKey={row.id}
          request={ctx.citationRequest}
          listRef={ctx.listRef}
        >
          <ChatMarkdown
            text={messageText}
            cwd={ctx.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            isStreaming={Boolean(row.message.streaming)}
            lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
            skills={ctx.skills}
            headingLevelOffset={MESSAGE_HEADING_LEVEL}
            onUseArtifactTemplate={ctx.onUseArtifactTemplate}
            onRunShellCommand={ctx.onRunShellCommand}
            onImageExpand={ctx.onImageExpand}
          />
        </AssistantCitationSource>
        <AssistantChangedFilesSection
          turnSummary={row.assistantTurnDiffSummary}
          routeThreadKey={ctx.routeThreadKey}
          resolvedTheme={ctx.resolvedTheme}
          onOpenTurnDiff={ctx.onOpenTurnDiff}
        />
        {row.showAssistantMeta ? (
          <AssistantMessageMeta
            className="mt-1.5"
            message={row.message}
            showCopyButton={row.showAssistantCopyButton}
            copyStreaming={row.assistantCopyStreaming}
          />
        ) : null}
      </div>
    </>
  );
}

function AssistantMetaTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "assistant-meta" }>;
}) {
  return (
    <div className="px-1">
      <AssistantMessageMeta
        className="mt-0.5"
        message={row.message}
        showCopyButton={row.showAssistantCopyButton}
        copyStreaming={row.assistantCopyStreaming}
        alwaysVisible
      />
    </div>
  );
}

function AssistantMessageMeta({
  className,
  message,
  showCopyButton,
  copyStreaming,
  alwaysVisible = false,
}: {
  className?: string;
  message: ChatMessage;
  showCopyButton: boolean;
  copyStreaming: boolean;
  alwaysVisible?: boolean;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200",
        alwaysVisible
          ? "opacity-100"
          : "opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100",
        className,
      )}
    >
      <AssistantCopyButton
        message={message}
        showCopyButton={showCopyButton}
        streaming={copyStreaming}
      />
      {!message.streaming && (
        <Tooltip>
          <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
            {formatDayAwareTimestamp(message.updatedAt, ctx.timestampFormat)}
          </TooltipTrigger>
          <TooltipPopup>
            {formatChatTimestampTooltip(message.updatedAt, ctx.timestampFormat)}
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

function AssistantCopyButton({
  message,
  showCopyButton,
  streaming,
}: {
  message: ChatMessage;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: message.text ?? null,
    showCopyButton,
    streaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
      />
    </div>
  );
}

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const { isCompacting, isPreparingWorktree, isRevertingCheckpoint, backgroundWorktreeSetup } =
    use(TimelineRowActivityCtx);
  const t = useT();
  // One span for every label so the setup-to-working handoff swaps text in
  // place instead of remounting the row.
  const shimmer = isPreparingWorktree || isCompacting;
  const label = isPreparingWorktree ? (
    "Setting up worktree…"
  ) : isCompacting ? (
    <CompactingLabel />
  ) : isRevertingCheckpoint ? (
    t("Restoring checkpoint…")
  ) : row.createdAt ? (
    <>
      Working for <WorkingTimer createdAt={row.createdAt} />
    </>
  ) : (
    "Working..."
  );
  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <div className="flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
        <span
          ref={shimmer ? observeVisibleAnimation : undefined}
          className="relative shrink-0 overflow-hidden whitespace-nowrap"
        >
          {label}
          {shimmer ? <ActivityShimmerOverlay>{label}</ActivityShimmerOverlay> : null}
        </span>
        {backgroundWorktreeSetup ? (
          <BackgroundWorktreeSetupChip snapshot={backgroundWorktreeSetup} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Trailing chip in the working header while a setup script still runs after
 * the agent started. Opens the stage list and live output in a popover; the
 * chip leaves with the script, so nothing lingers in the timeline.
 */
function BackgroundWorktreeSetupChip({ snapshot }: { snapshot: WorktreeSetupSnapshot }) {
  const ctx = use(TimelineRowCtx);
  const terminalId = snapshot.setupScript?.terminalId ?? null;
  const openTerminal = ctx.onOpenWorktreeSetupTerminal;
  const onOpenTerminal = useMemo(
    () => (openTerminal && terminalId ? () => openTerminal(terminalId) : null),
    [openTerminal, terminalId],
  );
  const scriptName = snapshot.setupScript?.name ?? "Setup script";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="micro"
            className="ml-auto min-w-0 shrink-0"
            aria-label={`${scriptName} is still running. Show setup progress.`}
          />
        }
      >
        <Spinner size="xs" className="shrink-0" />
        <span className="truncate">{scriptName}</span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="lg" padding="compact">
        <WorktreeSetupCard
          snapshot={snapshot}
          embedded
          onCancel={null}
          onWorkLocally={null}
          onOpenTerminal={onOpenTerminal}
        />
      </PopoverPopup>
    </Popover>
  );
}

function ActivityGroupTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "activity-group" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const work = omitSupersededLifecycleMarkers(
    row.entries.flatMap((entry) =>
      entry.kind === "work" && workEntryIsVisibleInGroup(entry.entry, row.active)
        ? [entry.entry]
        : [],
    ),
    (entry) => entry,
  );
  const thoughtCount = row.entries.filter((entry) => entry.kind === "message").length;
  const lastThoughtIndex = row.entries.findLastIndex((entry) => entry.kind === "message");
  const trailingWork = omitSupersededLifecycleMarkers(
    row.entries
      .slice(lastThoughtIndex + 1)
      .flatMap((entry) =>
        entry.kind === "work" && workEntryIsVisibleInGroup(entry.entry, row.active)
          ? [entry.entry]
          : [],
      ),
    (entry) => entry,
  );
  const liveWork = trailingWork.findLast(workEntryIsActiveTurnActivity) ?? trailingWork.at(-1);
  const thinking = row.active && liveWork === undefined;
  const iconWork = row.active ? liveWork : work.at(-1);
  const failedCount = row.active ? 0 : countFailedToolEntries(work);
  const failed =
    failedCount > 0 || (iconWork !== undefined && workEntryDisplayIndicatesToolFailure(iconWork));
  const label = row.active
    ? liveWork
      ? liveWorkEntryLabel(liveWork, ctx.workspaceRoot, true)
      : "Thinking"
    : work.length > 0
      ? summarizeToolGroup(work)
      : `Thought${thoughtCount > 1 ? ` (×${thoughtCount})` : ""}`;
  const details: ReactNode[] = [];
  if (row.expanded) {
    for (let index = 0; index < row.entries.length; index += 1) {
      const entry = row.entries[index]!;
      if (entry.kind === "work") {
        const entries = [entry.entry];
        while (row.entries[index + 1]?.kind === "work") {
          const next = row.entries[++index]!;
          if (next.kind === "work") entries.push(next.entry);
        }
        details.push(
          <WorkGroupSection
            key={entry.id}
            anchorKey={entry.id}
            disclosureAnchorKey={row.id}
            groupedEntries={omitSupersededLifecycleMarkers(entries, (entry) => entry)}
            isExpandedToolGroup
          />,
        );
      } else {
        const messages = [entry.message];
        while (row.entries[index + 1]?.kind === "message") {
          const next = row.entries[++index]!;
          if (next.kind === "message") messages.push(next.message);
        }
        details.push(
          <ReasoningTraceBlock
            key={entry.id}
            anchorKey={row.id}
            messages={messages}
            live={row.active && index === row.entries.length - 1}
            showHeader={work.length > 0}
          />,
        );
      }
    }
  }
  return (
    <div>
      <button
        type="button"
        className="group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        aria-label={failed ? `${label}, tool call failed` : undefined}
        aria-expanded={row.expanded}
        onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
      >
        <LiveActivityRow
          label={label}
          iconName={iconWork ? workEntryIconName(iconWork) : "brain"}
          toolIcon={iconWork?.toolIcon ?? iconWork?.toolSource?.icon}
          failed={failed}
          failedCount={failedCount}
          active={row.active}
          shimmer={thinking}
        />
      </button>
      {row.expanded ? <div className="mt-2">{details}</div> : null}
    </div>
  );
}

function ThinkingTimelineRow() {
  const { isCompacting, isPreparingWorktree } = use(TimelineRowActivityCtx);
  // Reserve the activity row during setup so the handoff keeps the same height.
  return (
    <div className="min-h-7">
      {isPreparingWorktree || isCompacting ? null : (
        <LiveActivityRow label="Thinking" iconName="brain" active shimmer />
      )}
    </div>
  );
}

function remarkThoughtPreview(fallback: string) {
  return (tree: Root) => {
    const plainText = (node: Root | RootContent): string => {
      if (node.type === "html" || node.type === "definition") return "";
      if ("alt" in node) return node.alt ?? "";
      if ("value" in node) return node.value;
      if ("children" in node) {
        const separator = ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(
          node.type,
        )
          ? " "
          : "";
        return node.children.map(plainText).join(separator);
      }
      return node.type === "break" ? " " : "";
    };
    tree.children = [
      { type: "text", value: plainText(tree).replace(/\s+/g, " ").trim() || fallback },
    ];
  };
}

/**
 * Thinking inside a tool group has its own disclosure, preserved across recycling.
 * A group whose row already reads "Thought" (no visible tool) skips the header.
 */
function ReasoningTraceBlock({
  anchorKey,
  messages,
  live,
  showHeader,
}: {
  anchorKey: string;
  messages: ReadonlyArray<ChatMessage>;
  live: boolean;
  showHeader: boolean;
}) {
  const ctx = use(TimelineRowCtx);
  const { isWorking, unsettledTurnId } = use(TimelineRowActivityCtx);
  const first = messages[0]!;
  const expanded = !showHeader || ctx.expandedReasoningMessageIds.has(first.id);
  const streaming =
    live &&
    messages.some((reasoningMessage) => reasoningMessage.streaming) &&
    isWorking &&
    first.turnId !== null &&
    first.turnId === unsettledTurnId;
  if (
    messages.every((reasoningMessage) => reasoningMessage.text.trim().length === 0) &&
    !streaming
  ) {
    return null;
  }
  const label = streaming ? "Thinking" : "Thought";
  const collapsedPreview = messages.find((message) => message.text.trim().length > 0)?.text.trim();
  const headerText = expanded ? (
    label
  ) : (
    <ReactMarkdown remarkPlugins={[remarkGfm, [remarkThoughtPreview, label]]}>
      {collapsedPreview ?? label}
    </ReactMarkdown>
  );
  return (
    <div className="flex flex-col">
      {showHeader ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => ctx.onToggleReasoning(first.id, !expanded, anchorKey)}
          className="flex min-h-6 cursor-pointer select-none items-center gap-1.5 rounded-md ps-0.5 pe-2 text-start text-sm leading-relaxed transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
            <BrainIcon aria-hidden className="block size-4 shrink-0 stroke-2 opacity-70" />
          </span>
          <span
            ref={streaming ? observeVisibleAnimation : undefined}
            className="relative min-w-0 flex-1 truncate text-secondary-label"
          >
            {headerText}
            {streaming ? <ActivityShimmerOverlay>{headerText}</ActivityShimmerOverlay> : null}
          </span>
          <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-90",
              )}
            />
          </span>
        </button>
      ) : null}
      {expanded ? (
        <div className="ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text">
          {messages.map((reasoningMessage) => (
            <ChatMarkdown
              key={reasoningMessage.id}
              className="text-foreground"
              text={reasoningMessage.text}
              cwd={ctx.markdownCwd}
              threadRef={ctx.threadRef ?? undefined}
              isStreaming={streaming && reasoningMessage.streaming}
              lineBreaks
              skills={ctx.skills}
              headingLevelOffset={MESSAGE_HEADING_LEVEL}
              onUseArtifactTemplate={ctx.onUseArtifactTemplate}
              onImageExpand={ctx.onImageExpand}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A provider's thinking trace. Collapsed by default: reasoning is context for
 * the answer, not the answer. The open/closed flag lives on the list so it
 * survives row recycling in the virtualizer.
 */
const ReasoningTimelineRow = memo(function ReasoningTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "message" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const { message } = row;
  const expanded = ctx.expandedReasoningMessageIds.has(message.id);
  const { onToggleReasoning } = ctx;
  const toggle = useCallback(() => {
    onToggleReasoning(message.id, !expanded, row.id);
  }, [expanded, message.id, row.id, onToggleReasoning]);

  if (message.text.trim().length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-col", expanded && "mb-1")}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggle}
        className="flex cursor-pointer select-none items-center gap-1.5 rounded-md px-0.5 py-0.5 text-start transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
          <BrainIcon aria-hidden className="block size-4 shrink-0 stroke-2 opacity-70" />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="relative min-w-0 flex-1 truncate text-secondary-label text-sm leading-relaxed">
            Thought
          </span>
          <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-90",
              )}
            />
          </span>
        </span>
      </button>
      {expanded ? (
        <div className="mt-1 ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text">
          <ChatMarkdown
            className="text-foreground"
            text={message.text}
            cwd={ctx.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            lineBreaks
            skills={ctx.skills}
            headingLevelOffset={MESSAGE_HEADING_LEVEL}
            onUseArtifactTemplate={ctx.onUseArtifactTemplate}
            onImageExpand={ctx.onImageExpand}
          />
        </div>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[], identity: string): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });
  const prevIdentity = useRef(identity);

  return useMemo(() => {
    const previous =
      prevIdentity.current === identity
        ? prevState.current
        : { byId: new Map<string, MessagesTimelineRow>(), result: [] };
    prevIdentity.current = identity;
    const nextState = computeStableMessagesTimelineRows(rows, previous);
    prevState.current = nextState;
    return nextState.result;
  }, [identity, rows]);
}
