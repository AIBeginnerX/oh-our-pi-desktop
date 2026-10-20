import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
  AuthOrchestrationOperateScope,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, EllipsisIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import GitActionsControl from "../GitActionsControl";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { useRemoteOpenState, type RemoteOpenMode } from "../../remoteOpen";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { readLocalApi } from "~/localApi";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { observeResponsiveBreakpointFade, usePanelAnimationSettings } from "../../panelAnimations";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { cn } from "~/lib/utils";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { MenuItem } from "../ui/menu";
import { ReleaseVerificationPanel } from "./ReleaseVerificationPanel";
import { SelectedChecksPanel } from "./SelectedChecksPanel";
import {
  releaseVerificationEnvironment,
  useReleaseVerification,
} from "../../state/releaseVerification";
import { useSelectedChecks } from "../../state/selectedChecks";
import { useResultUsageDisclosure } from "../../state/resultUsage";
import { useEnvironmentSessionState } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { skillSourceFromChecks } from "../settings/ProjectSkillsSection.logic";
import {
  ProjectSkillCandidateDialog,
  readManageCapability,
  skillCandidateScopeKey,
  type FrozenSkillSource,
} from "../settings/ProjectSkillsSection";
import {
  ProjectSkillTrialDialog,
  trialScopeKey,
  type FrozenTrialScope,
} from "./ProjectSkillTrialDialog";

function ReleaseVerificationControl({
  environmentId,
  threadId,
  collapsed,
  onRequestMenuClose,
  onAvailabilityChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly collapsed: boolean;
  readonly onRequestMenuClose: () => void;
  readonly onAvailabilityChange: (visible: boolean) => void;
}) {
  const query = useReleaseVerification(environmentId, threadId);
  const session = useEnvironmentSessionState(environmentId);
  const run = useAtomCommand(releaseVerificationEnvironment.run, { reportFailure: false });
  const cancel = useAtomCommand(releaseVerificationEnvironment.cancel, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expectedAttemptId, setExpectedAttemptId] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const readOnly =
    session.data?.authenticated === false ||
    (session.data?.scopes !== undefined &&
      !session.data.scopes.includes(AuthOrchestrationOperateScope));
  const visible =
    !query.unsupported && (query.result?.capability.available === true || query.error !== null);
  useEffect(() => onAvailabilityChange(visible), [onAvailabilityChange, visible]);
  const refresh = query.refresh;

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);
  useEffect(() => {
    if (!open) return;
    const refreshOnFocus = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [open, refresh]);
  const liveAttemptId = query.live?.attempt.attemptId;
  const liveRevision = query.live?.attempt.revision;
  const livePhase = query.live?.attempt.phase;
  const terminalRevision =
    liveAttemptId && livePhase !== "running" ? `${liveAttemptId}:${liveRevision}` : null;
  if (expectedAttemptId !== null && expectedAttemptId === query.result?.attempt?.attemptId) {
    setExpectedAttemptId(null);
  }
  const starting =
    expectedAttemptId !== null && query.result?.attempt?.attemptId !== expectedAttemptId;
  useEffect(() => {
    if (open && terminalRevision !== null) refresh();
  }, [open, terminalRevision, refresh]);

  if (!visible) return null;
  const openPanel = () => {
    onRequestMenuClose();
    setCommandError(null);
    setOpen(true);
  };
  const runVerification = () => {
    if (busy || readOnly) return;
    setBusy(true);
    setCommandError(null);
    void run({ environmentId, input: { threadId } }).then((outcome) => {
      if (outcome._tag === "Success") setExpectedAttemptId(outcome.value.attemptId);
      if (outcome._tag === "Failure" && !isAtomCommandInterrupted(outcome)) {
        const failure = squashAtomCommandFailure(outcome);
        setCommandError(
          failure instanceof Error ? failure.message : "Verification could not start.",
        );
      }
      refresh();
      setBusy(false);
    });
  };
  const cancelVerification = () => {
    if (busy || readOnly) return;
    setBusy(true);
    setCommandError(null);
    void cancel({ environmentId, input: { threadId } }).then((outcome) => {
      if (outcome._tag === "Failure" && !isAtomCommandInterrupted(outcome)) {
        const failure = squashAtomCommandFailure(outcome);
        setCommandError(
          failure instanceof Error ? failure.message : "Verification could not be cancelled.",
        );
      }
      refresh();
      setBusy(false);
    });
  };
  return (
    <>
      {collapsed ? (
        <MenuItem onClick={openPanel}>Verify macOS build</MenuItem>
      ) : (
        <Button size="sm" variant="outline" onClick={openPanel}>
          Verify macOS build
        </Button>
      )}
      <ReleaseVerificationPanel
        open={open}
        onOpenChange={setOpen}
        result={starting ? null : query.result}
        pending={query.isPending || busy || expectedAttemptId !== null}
        starting={starting}
        busy={busy}
        readOnly={readOnly}
        error={commandError ?? query.error}
        onRefresh={refresh}
        onRun={runVerification}
        onCancel={cancelVerification}
      />
    </>
  );
}

const EMPTY_SELECTED_CHECK_CANDIDATES: ReadonlyArray<ProjectScript> = Object.freeze([]);

/** Entry point for every server thread: records and recovery stay reachable even with zero actions. */
export function SelectedChecksControl({
  environmentId,
  threadId,
  threadTitle,
  project,
  scripts,
  collapsed,
  onRequestMenuClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly project: EnvironmentProject | null;
  readonly scripts: ReadonlyArray<ProjectScript> | undefined;
  readonly collapsed: boolean;
  readonly onRequestMenuClose: () => void;
}) {
  const checks = useSelectedChecks({
    environmentId,
    threadId,
    project,
    candidates: scripts ?? EMPTY_SELECTED_CHECK_CANDIDATES,
  });
  // One-shot usage read for the current passed record, mounted only while
  // the panel is open on it; the panel Refresh button re-requests both.
  const resultUsage = useResultUsageDisclosure({
    identity: checks.recordIdentity,
    readRecordIdentity: checks.readRecordIdentity,
    open: checks.view.open,
  });
  const refreshChecksAndUsage = useCallback(() => {
    checks.refresh();
    resultUsage.refresh();
  }, [checks.refresh, resultUsage.refresh]);
  const registry = useContext(RegistryContext);
  const [candidate, setCandidate] = useState<FrozenSkillSource | null>(null);
  // The trial scope is frozen at click time like the candidate source; a scope
  // change remounts the dialog clean through its key.
  const [trialScope, setTrialScope] = useState<FrozenTrialScope | null>(null);
  const [useScope, setUseScope] = useState<FrozenTrialScope | null>(null);
  const running = checks.view.live?.receipt.phase === "running";
  const capability =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .projectSkills?.manage === true;
  const projectSkillsCapabilities = useAtomValue(serverEnvironment.configValueAtom(environmentId))
    ?.environment.capabilities.projectSkills;
  const trialCapability = projectSkillsCapabilities?.trial === true;
  const useCapability = projectSkillsCapabilities?.use === true;
  const saveable =
    skillSourceFromChecks({
      view: checks.view,
      permission: checks.permission,
      manage: capability,
    }) !== null;
  const openPanel = () => {
    onRequestMenuClose();
    checks.openPanel();
  };
  // Freeze the current source at click time; the panel's controller stays open
  // underneath (only hidden below), so its authority keeps updating for the
  // dialog's pre-submit recheck.
  const openCandidateDialog = () => {
    const current = checks.readCurrentSource();
    if (current === null) return;
    const source = skillSourceFromChecks({
      view: current.view,
      permission: current.permission,
      manage: readManageCapability(registry, environmentId),
    });
    if (source === null) return;
    setCandidate({
      environmentId,
      threadId,
      projectId: current.projectId,
      expected: {
        attemptId: source.attemptId,
        revision: source.revision,
        receiptSequence: source.receiptSequence,
      },
      checkNames: (current.view.record?.receipt.planned ?? []).map((check) => check.scriptName),
    });
  };
  const openTrialDialog = () => {
    onRequestMenuClose();
    if (project === null) return;
    setUseScope(null);
    setTrialScope({ environmentId, projectId: project.id, threadId });
  };
  const openUseDialog = () => {
    onRequestMenuClose();
    if (project === null || !useCapability) return;
    setTrialScope(null);
    setUseScope({ environmentId, projectId: project.id, threadId });
  };
  return (
    <>
      {collapsed ? (
        <MenuItem onClick={openPanel}>{running ? "Checks running" : "Checks"}</MenuItem>
      ) : (
        <Button size="sm" variant="outline" onClick={openPanel}>
          {running ? "Checks running" : "Checks"}
        </Button>
      )}
      <SelectedChecksPanel
        open={checks.view.open && candidate === null}
        onOpenChange={(open) => {
          if (!open) checks.closePanel();
        }}
        view={checks.view}
        candidates={checks.candidates}
        threadId={threadId}
        threadTitle={threadTitle}
        permission={checks.permission}
        permissionStatus={checks.permissionStatus}
        onRetryPermission={checks.retryPermission}
        onToggle={checks.toggle}
        onRefresh={refreshChecksAndUsage}
        onRun={checks.run}
        onStop={checks.stop}
        onRecheck={checks.recheck}
        onOpenRecoveryDialog={checks.openRecoveryDialog}
        onCloseRecoveryDialog={checks.closeRecoveryDialog}
        onSubmitRecovery={checks.submitRecoveryDialog}
        taskResult={{ environmentId, readCurrentSource: checks.readCurrentSource }}
        {...(checks.view.open ? { resultUsage: resultUsage.state } : {})}
        {...(saveable ? { onSaveAsSkillCandidate: openCandidateDialog } : {})}
      />
      {candidate !== null ? (
        <ProjectSkillCandidateDialog
          key={skillCandidateScopeKey(candidate)}
          source={candidate}
          readCurrentSource={checks.readCurrentSource}
          onClose={() => setCandidate(null)}
          view={checks.view}
          permission={checks.permission}
          manage={capability}
          onAuthorizationRejected={checks.retryPermission}
        />
      ) : null}
      {shouldShowSkillTrialEntry({ trialCapability, projectId: project?.id ?? null }) ? (
        collapsed ? (
          <MenuItem onClick={openTrialDialog}>스킬 시험</MenuItem>
        ) : (
          <Button size="sm" variant="outline" onClick={openTrialDialog}>
            스킬 시험
          </Button>
        )
      ) : null}
      {shouldShowSkillUseEntry({ useCapability, projectId: project?.id ?? null }) ? (
        collapsed ? (
          <MenuItem onClick={openUseDialog}>이번 요청에 사용</MenuItem>
        ) : (
          <Button size="sm" variant="outline" onClick={openUseDialog}>
            이번 요청에 사용
          </Button>
        )
      ) : null}
      {trialScope !== null ? (
        <ProjectSkillTrialDialog
          key={`${trialScopeKey(trialScope)}:trial`}
          scope={trialScope}
          mode="trial"
          onClose={() => setTrialScope(null)}
        />
      ) : null}
      {useScope !== null ? (
        <ProjectSkillTrialDialog
          key={`${trialScopeKey(useScope)}:use`}
          scope={useScope}
          mode="use"
          onClose={() => setUseScope(null)}
        />
      ) : null}
    </>
  );
}

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  /** Drafts have no server thread yet, so the title carries no action menu. */
  isServerThread: boolean;
  activeProject: EnvironmentProject | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  readonly onOpenPullRequest?: ((number: number) => void) | undefined;
  onNewThreadInProject: () => void;
  onOpenProjectSettings?: (() => void) | undefined;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

/**
 * Rename commit rule shared with the sidebar's inline rename: trim, reject
 * empty (the caller toasts), and skip the mutation when nothing changed.
 */
export function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

// How long a click on the thread title waits before opening the action menu,
// so a double-click-to-rename can cancel it first. Only the native desktop
// menu needs this: it swallows input while open, so the wait must cover the
// OS double-click interval. The browser fallback menu keeps seeing DOM
// events (the second click dismisses it and dblclick still fires), so it
// opens immediately.
const TITLE_MENU_OPEN_DELAY_MS = 500;
// Matches the @3xl/header-actions container breakpoint owned by this header.
const HEADER_ACTIONS_EXPANDED_BREAKPOINT_REM = 48;

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly remoteOpenMode: RemoteOpenMode;
}): boolean {
  if (!input.activeProjectName) return false;
  if (
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  ) {
    return true;
  }
  // Remote environments get the picker in deep-link mode (or its explicit
  // "no SSH route" state). Non-primary local backends (e.g. WSL) keep it
  // hidden, matching pre-remote behavior.
  return input.remoteOpenMode !== "local-exec";
}

/**
 * The trial entry is dormant unless the server advertises the trial capability
 * and the thread has a project to freeze the send to.
 */
export function shouldShowSkillTrialEntry(input: {
  readonly trialCapability: boolean;
  readonly projectId: string | null;
}): boolean {
  return input.trialCapability && input.projectId !== null;
}

/** Use entry is independent of trial; both require a project scope to freeze. */
export function shouldShowSkillUseEntry(input: {
  readonly useCapability: boolean;
  readonly projectId: string | null;
}): boolean {
  return input.useCapability && input.projectId !== null;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  isServerThread,
  activeProject,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  onOpenPullRequest,
  onNewThreadInProject,
  onOpenProjectSettings,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderProps) {
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const headerActionsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const actions = headerActionsRef.current;
    const container = actions?.parentElement;
    if (!actions || !container) return;
    return observeResponsiveBreakpointFade({
      target: actions,
      container,
      active: panelAnimationsActive,
      durationMs: panelAnimationDurationMs,
      breakpoint: { value: HEADER_ACTIONS_EXPANDED_BREAKPOINT_REM, unit: "rem" },
    });
  }, [panelAnimationDurationMs, panelAnimationsActive]);
  const isMobile = useIsMobile();
  // Side panels can leave a desktop header narrower than a phone.
  const [isNarrowHeader, setIsNarrowHeader] = useState(false);
  useEffect(() => {
    const container = headerActionsRef.current?.parentElement;
    if (!container) return;
    const update = () => setIsNarrowHeader(container.clientWidth < 512);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const actionsCollapsed = isMobile || isNarrowHeader;
  const [actionsOpen, setActionsOpen] = useState(false);
  const [releaseActionVisibility, setReleaseActionVisibility] = useState<{
    key: string;
    visible: boolean;
  } | null>(null);
  const releaseActionKey = `${activeThreadEnvironmentId}:${activeThreadId}`;
  const releaseActionVisible =
    releaseActionVisibility?.key === releaseActionKey && releaseActionVisibility.visible;
  const onReleaseActionAvailabilityChange = useCallback(
    (visible: boolean) => {
      setReleaseActionVisibility({ key: releaseActionKey, visible });
    },
    [releaseActionKey],
  );
  const [actionsContainer] = useState(() => {
    const container = document.createElement("div");
    container.className = "contents";
    return container;
  });
  // Reparent the DOM host, not the React controls: rotating a phone or resizing
  // a window must not discard an unsaved script or Git dialog.
  const mountInlineActions = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && !actionsCollapsed) node.appendChild(actionsContainer);
    },
    [actionsContainer, actionsCollapsed],
  );
  const mountMenuActions = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && actionsCollapsed) node.appendChild(actionsContainer);
    },
    [actionsContainer, actionsCollapsed],
  );
  if (!actionsCollapsed && actionsOpen) setActionsOpen(false);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeProjectName = activeProject?.title;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const fileScripts = useT3ProjectFileScripts(
    activeThreadEnvironmentId,
    activeProjectScripts ? activeProjectCwd : null,
  );
  const remoteOpenState = useRemoteOpenState(activeThreadEnvironmentId);
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
    remoteOpenMode: remoteOpenState.mode,
  });
  const activeThreadRef = useMemo(
    () => scopeThreadRef(activeThreadEnvironmentId, activeThreadId),
    [activeThreadEnvironmentId, activeThreadId],
  );
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  // Inline rename, keyed by thread: navigating away drops an in-progress
  // rename instead of committing stale text. Cleared on thread change (not
  // just hidden) so returning to the thread doesn't revive the old draft.
  const [renaming, setRenaming] = useState<{ threadId: ThreadId; title: string } | null>(null);
  if (renaming !== null && renaming.threadId !== activeThreadId) {
    setRenaming(null);
  }
  const renamingTitle = renaming?.threadId === activeThreadId ? renaming.title : null;
  const renameCommittedRef = useRef(false);
  const startRename = useCallback(() => {
    renameCommittedRef.current = false;
    setRenaming({ threadId: activeThreadId, title: activeThreadTitle });
  }, [activeThreadId, activeThreadTitle]);
  const commitRename = useCallback(
    (title: string) => {
      setRenaming(null);
      const resolution = resolveRenameCommit({ title, originalTitle: activeThreadTitle });
      if (resolution.action === "reject-empty") {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (resolution.action === "noop") return;
      void updateThreadMetadata({
        environmentId: activeThreadEnvironmentId,
        input: { threadId: activeThreadId, title: resolution.title },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
      });
    },
    [activeThreadEnvironmentId, activeThreadId, activeThreadTitle, updateThreadMetadata],
  );
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    onStartRename: startRename,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleMenuTimerRef = useRef<number | null>(null);
  const cancelPendingTitleMenu = useCallback(() => {
    if (titleMenuTimerRef.current === null) return;
    clearTimeout(titleMenuTimerRef.current);
    titleMenuTimerRef.current = null;
  }, []);
  // Drop a pending menu-open when the thread changes or the header unmounts,
  // so it can never fire for a thread the user already left.
  useEffect(
    () => () => {
      cancelPendingTitleMenu();
    },
    [activeThreadId, cancelPendingTitleMenu],
  );
  const openTitleMenuNow = useCallback(() => {
    cancelPendingTitleMenu();
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  }, [cancelPendingTitleMenu, openMenu]);
  const openMenuFromTitle = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      // The trailing click of a double-click belongs to rename, not the menu.
      if (isTrailingDoubleClick(event.detail)) return;
      // Keyboard activation and the explicit chevron affordance can never be
      // the first half of a double-click, so they open without waiting.
      const clickedChevron =
        (event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null;
      if (event.detail === 0 || clickedChevron || window.desktopBridge === undefined) {
        openTitleMenuNow();
        return;
      }
      // Stay pending long enough for dblclick to cancel the open before the
      // native menu appears and swallows the second click.
      cancelPendingTitleMenu();
      titleMenuTimerRef.current = window.setTimeout(() => {
        titleMenuTimerRef.current = null;
        openTitleMenuNow();
      }, TITLE_MENU_OPEN_DELAY_MS);
    },
    [cancelPendingTitleMenu, openTitleMenuNow],
  );
  const handleTitleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      // The chevron is the explicit menu affordance; only the title text renames.
      if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
      cancelPendingTitleMenu();
      closeMenu();
      startRename();
    },
    [cancelPendingTitleMenu, closeMenu, startRename],
  );
  const handleHeaderContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (renamingTitle !== null) return;
      // The right-side controls (git, scripts, open-in) keep their own
      // behavior; only the breadcrumb area opens the thread menu.
      if ((event.target as HTMLElement).closest("[data-chat-header-actions]")) return;
      if (!isServerThread && onOpenProjectSettings === undefined) return;
      cancelPendingTitleMenu();
      event.preventDefault();
      if (!isServerThread) {
        const api = readLocalApi();
        if (!api) return;
        void api.contextMenu
          .show([{ id: "project-settings", label: "Project settings", icon: "settings" }], {
            x: event.clientX,
            y: event.clientY,
          })
          .then((action) => {
            if (action === "project-settings") onOpenProjectSettings?.();
          });
        return;
      }
      openMenu({ x: event.clientX, y: event.clientY });
    },
    [cancelPendingTitleMenu, isServerThread, onOpenProjectSettings, openMenu, renamingTitle],
  );
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        renameCommittedRef.current = true;
        commitRename(event.currentTarget.value);
      } else if (event.key === "Escape") {
        renameCommittedRef.current = true;
        setRenaming(null);
      }
    },
    [commitRename],
  );
  const headerActions = (
    <>
      {activeProjectScripts && (
        <>
          <ProjectScriptsControl
            onRequestMenuClose={() => setActionsOpen(false)}
            presentation={actionsCollapsed ? "menu" : "toolbar"}
            scripts={activeProjectScripts}
            fileScripts={fileScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        </>
      )}
      {showOpenInPicker && (
        <>
          {actionsCollapsed && activeProjectScripts && <MenuSeparator />}
          <OpenInPicker
            presentation={actionsCollapsed ? "menu" : "toolbar"}
            environmentId={activeThreadEnvironmentId}
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        </>
      )}
      {activeProjectName && gitCwd && (
        <>
          {actionsCollapsed && (activeProjectScripts || showOpenInPicker) && <MenuSeparator />}
          <GitActionsControl
            presentation={actionsCollapsed ? "menu" : "toolbar"}
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            onOpenPullRequest={onOpenPullRequest}
            {...(draftId ? { draftId } : {})}
          />
        </>
      )}
      {isServerThread && (
        <>
          {actionsCollapsed &&
            releaseActionVisible &&
            (activeProjectScripts || showOpenInPicker || (activeProjectName && gitCwd)) && (
              <MenuSeparator />
            )}
          <ReleaseVerificationControl
            key={`${activeThreadEnvironmentId}:${activeThreadId}`}
            environmentId={activeThreadEnvironmentId}
            threadId={activeThreadId}
            collapsed={actionsCollapsed}
            onRequestMenuClose={() => setActionsOpen(false)}
            onAvailabilityChange={onReleaseActionAvailabilityChange}
          />
          {actionsCollapsed &&
            (activeProjectScripts ||
              showOpenInPicker ||
              (activeProjectName && gitCwd) ||
              releaseActionVisible) && <MenuSeparator />}
          <SelectedChecksControl
            key={`selected-checks:${activeThreadEnvironmentId}:${activeThreadId}:${activeProject?.id ?? "none"}`}
            environmentId={activeThreadEnvironmentId}
            threadId={activeThreadId}
            threadTitle={activeThreadTitle}
            project={activeProject}
            scripts={activeProjectScripts}
            collapsed={actionsCollapsed}
            onRequestMenuClose={() => setActionsOpen(false)}
          />
        </>
      )}
    </>
  );
  return (
    <div
      className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3"
      onContextMenu={handleHeaderContextMenu}
    >
      <WorkspaceBreadcrumb
        ariaLabel="Thread breadcrumb"
        className="flex-1 overflow-clip [overflow-clip-margin:2px]"
      >
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProject ? (
          <>
            <WorkspaceBreadcrumbItem className="shrink">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`New thread in ${activeProjectName}`}
                      onClick={onNewThreadInProject}
                      className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  }
                >
                  <ProjectFavicon project={activeProject} className="size-3.5" />
                  <WorkspaceBreadcrumbText className="max-w-40">
                    {activeProjectName}
                  </WorkspaceBreadcrumbText>
                </TooltipTrigger>
                <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
              </Tooltip>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator>
              <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbSeparator>
          </>
        ) : null}
        <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
          {renamingTitle !== null ? (
            <input
              autoFocus
              aria-label="Thread title"
              className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-ring/50 focus:ring-ring"
              defaultValue={renamingTitle}
              onBlur={(event) => {
                if (renameCommittedRef.current) return;
                commitRename(event.currentTarget.value);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleRenameKeyDown}
            />
          ) : isServerThread ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    ref={titleButtonRef}
                    type="button"
                    aria-label={`Thread actions for ${activeThreadTitle}`}
                    aria-haspopup="menu"
                    onClick={openMenuFromTitle}
                    onDoubleClick={handleTitleDoubleClick}
                    onBlur={cancelPendingTitleMenu}
                    className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <h2 className="min-w-0">
                  <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
                </h2>
                <ChevronDownIcon
                  aria-hidden
                  data-thread-title-chevron
                  className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={<h2 aria-label={activeThreadTitle} className="min-w-0 flex-1" />}
              >
                <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
              </TooltipTrigger>
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          )}
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <div
        ref={headerActionsRef}
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
          // Reserve two panel toggles plus their 4px gaps and 1px edge inset.
          // The page header adds 8px more right padding at sm.
          rightPanelOpen ? "pr-0" : "pr-18.25 sm:pr-14.25",
          "[[data-panel-animations=true]_&]:motion-safe:transition-[padding-right] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
        )}
      >
        <Menu open={actionsCollapsed && actionsOpen} onOpenChange={setActionsOpen}>
          <MenuTrigger
            className={
              actionsCollapsed &&
              (activeProjectScripts ||
                showOpenInPicker ||
                (activeProjectName && gitCwd) ||
                releaseActionVisible ||
                isServerThread)
                ? undefined
                : "hidden"
            }
            render={<Button size="icon-sm" variant="ghost" aria-label="More header actions" />}
          >
            <EllipsisIcon className="size-4" />
          </MenuTrigger>
          <div ref={mountInlineActions} className="contents" />
          <MenuPopup
            data-chat-header-actions
            keepMounted
            aria-label="Header actions"
            align="end"
            finalFocus={actionsCollapsed ? undefined : false}
          >
            <div ref={mountMenuActions} className="contents" />
            {createPortal(headerActions, actionsContainer)}
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
});
