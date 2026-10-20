import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProjectId,
  type ProjectMemoryThreadState,
  type ServerConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { HistoryIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { composerDraftHasUserContent, useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readThreadShell } from "../../state/entities";
import { projectMemory } from "../../state/projectMemory";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  canConfirmAcknowledge,
  isTaggedError,
  latestTurnStartFailureId,
  recoveryScopeKey,
  recoveryView,
  sanitizeUnsentPrompt,
  type CapturedAck,
} from "./ProjectMemoryRecovery.logic";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * The hook reads one of these instead of returning early, so capability flips
 * keep React hook order stable and an unsupported scope never issues the
 * thread-state RPC. Same pattern as the settings section's empty detail atom.
 */
const INERT_THREAD_STATE = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("project-memory-recovery:inert-thread-state"),
);
const INERT_CONFIG = Atom.make<ServerConfig | null>(null).pipe(
  Atom.withLabel("project-memory-recovery:inert-config"),
);

const CONTINUE_IN_NEW_THREAD_TOOLTIP =
  "Opens a new draft in this project with your current unsent draft text, if any. " +
  "A new provider session starts only when you send. Attachments and context chips are not copied.";

/**
 * Recovery surface for one server thread whose affected project-memory changes
 * hold its turns. Owns the whole flow — banner item plus the consent dialog —
 * so the dialog survives checking/error banner transitions, and ChatView only
 * renders the returned pieces once.
 *
 * Consent is captured per full environment/project/thread scope and the exact
 * displayed watermark; confirming rechecks both against the current view.
 * "Continue in new thread" copies only the current unsent composer prompt,
 * sanitized, into the specific draft the new-thread handler returns — never
 * persisted messages, chips, or attachments, and never an automatic send.
 */
export function useProjectMemoryRecovery(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly isServerThread: boolean;
  readonly activities: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
}): { readonly bannerItem: ComposerBannerStackItem | null; readonly dialog: ReactNode } {
  const { environmentId, projectId, threadId, isServerThread, activities } = input;

  const config = useAtomValue(
    environmentId === null ? INERT_CONFIG : serverEnvironment.configValueAtom(environmentId),
  );
  const supported =
    config?.environment.capabilities.projectMemory?.threadRecovery === true &&
    isServerThread &&
    environmentId !== null &&
    projectId !== null &&
    threadId !== null;

  const queryAtom = useMemo(
    (): Atom.Atom<AsyncResult.AsyncResult<ProjectMemoryThreadState, unknown>> =>
      supported
        ? projectMemory.threadState({ environmentId, input: { projectId, threadId } })
        : INERT_THREAD_STATE,
    [environmentId, projectId, supported, threadId],
  );
  const result = useAtomValue(queryAtom);

  const scopeKey = recoveryScopeKey(environmentId ?? "", projectId ?? "", threadId ?? "");

  // Last settled verdict for this scope, so repeated pending renders keep the
  // checking marker instead of flashing "none" and old rows. A different
  // scopeKey never inherits the latch; only settled held/none results update it.
  const [heldLatch, setHeldLatch] = useState<{ scopeKey: string; held: boolean }>({
    scopeKey,
    held: false,
  });
  const wasHeld = heldLatch.scopeKey === scopeKey && heldLatch.held;
  const view = recoveryView({ supported, result, wasHeld });
  useEffect(() => {
    if (view.kind === "held") {
      setHeldLatch({ scopeKey, held: true });
    } else if (view.kind === "none") {
      setHeldLatch({ scopeKey, held: false });
    }
  }, [scopeKey, view.kind]);

  const revalidate = useAtomCommand(projectMemory.revalidate, { reportFailure: false });
  // The M2 query is a cached read, so opening a scope (or noticing a new turn
  // start failure) must refresh explicitly or the cached verdict hides fresh
  // holds. One refresh per scope|failure key; capability-off drops the marker
  // so off→on re-runs the activation refresh.
  const failureId = latestTurnStartFailureId(activities);
  const refreshKey = `${scopeKey}|${failureId ?? "open"}`;
  const revalidatedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!supported) {
      revalidatedRef.current = null;
      return;
    }
    if (environmentId === null || projectId === null) return;
    if (revalidatedRef.current === refreshKey) return;
    revalidatedRef.current = refreshKey;
    void revalidate({ environmentId, input: { projectId } });
  }, [environmentId, projectId, refreshKey, revalidate, supported]);

  const acknowledgeThread = useAtomCommand(projectMemory.acknowledgeThread, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();

  // The dialog lives here, not in the banner, so checking/error transitions in
  // the same scope keep it open. busyRef is the synchronous single-flight gate;
  // pending mirrors it for rendering. Late async results are dropped when the
  // scope moved on so they can never clear a newer action's state.
  const [captured, setCaptured] = useState<CapturedAck | null>(null);
  const [pending, setPending] = useState<"ack" | "continue" | null>(null);
  const [ackError, setAckError] = useState<"retry" | "permission" | null>(null);
  const busyRef = useRef(false);
  /** Unique object per in-flight ack/continue; identity is compared, never scope strings. */
  const busyOwnerRef = useRef<object | null>(null);
  const scopeRef = useRef(scopeKey);
  const releaseBusy = (owner: object) => {
    if (busyOwnerRef.current !== owner) {
      return;
    }
    busyOwnerRef.current = null;
    busyRef.current = false;
  };
  const stillOwnsBusy = (owner: object) => busyOwnerRef.current === owner;
  useEffect(() => {
    scopeRef.current = scopeKey;
  }, [scopeKey]);
  useEffect(() => {
    busyOwnerRef.current = null;
    busyRef.current = false;
    setCaptured(null);
    setAckError(null);
    setPending(null);
  }, [scopeKey, supported]);

  const keepThisThreadsContext = useCallback(() => {
    if (busyRef.current || view.kind !== "held") return;
    setAckError(null);
    setCaptured({ scopeKey, seq: view.latestChangeSeq });
  }, [scopeKey, view]);

  const confirmAck = useCallback(async () => {
    if (busyRef.current || captured === null || ackError === "permission") return;
    if (environmentId === null || projectId === null || threadId === null) return;
    if (!canConfirmAcknowledge(captured, { scopeKey, supported, view })) return;
    const busyOwner = {};
    busyOwnerRef.current = busyOwner;
    busyRef.current = true;
    setPending("ack");
    setAckError(null);
    const ackCaptured = captured;
    try {
      const result = await acknowledgeThread({
        environmentId,
        input: { projectId, threadId, throughChangeSeq: ackCaptured.seq },
      });
      if (!stillOwnsBusy(busyOwner)) {
        return;
      }
      if (scopeRef.current !== ackCaptured.scopeKey) {
        return;
      }
      if (result._tag === "Success") {
        // The acknowledged watermark is not trusted to clear anything here;
        // the M2 change signal refetches, and only a fresh held:false does.
        setCaptured(null);
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      if (isTaggedError(cause, "EnvironmentAuthorizationError")) {
        setAckError("permission");
        return;
      }
      setAckError("retry");
    } finally {
      const owned = stillOwnsBusy(busyOwner);
      releaseBusy(busyOwner);
      if (owned) {
        setPending(null);
      }
    }
  }, [
    ackError,
    acknowledgeThread,
    captured,
    environmentId,
    projectId,
    scopeKey,
    supported,
    threadId,
    view,
  ]);

  const continueInNewThread = useCallback(async () => {
    if (busyRef.current) return;
    if (environmentId === null || projectId === null || threadId === null) return;
    const busyOwner = {};
    busyOwnerRef.current = busyOwner;
    busyRef.current = true;
    setPending("continue");
    // The source prompt is captured now, before any await, and the source
    // thread is never modified. Intentionally no unmount guard below: this
    // action navigates away, so the source surface unmounting is the normal
    // path and must not discard a validated destination write.
    const draftStore = useComposerDraftStore.getState();
    const prompt = sanitizeUnsentPrompt(
      draftStore.getComposerDraft(scopeThreadRef(environmentId, threadId))?.prompt ?? "",
    );
    try {
      const opened = await handleNewThread(scopeProjectRef(environmentId, projectId));
      if (opened === null) return;
      // Only the returned draft id may be written, and only while it is still
      // a live, unpromoted, empty draft of this exact project/thread with no
      // server shell behind it.
      const session = draftStore.getDraftSession(opened.draftId);
      if (
        session === null ||
        session.promotedTo != null ||
        session.environmentId !== environmentId ||
        session.projectId !== projectId ||
        session.threadId !== opened.threadId ||
        readThreadShell(scopeThreadRef(environmentId, opened.threadId)) !== null ||
        composerDraftHasUserContent(draftStore.getComposerDraft(opened.draftId)) ||
        prompt === ""
      ) {
        return;
      }
      draftStore.setPrompt(opened.draftId, prompt);
    } finally {
      const owned = stillOwnsBusy(busyOwner);
      releaseBusy(busyOwner);
      if (owned) {
        setPending(null);
      }
    }
  }, [environmentId, handleNewThread, projectId, scopeKey, threadId]);

  const retryCheck = useCallback(() => {
    if (environmentId === null || projectId === null) return;
    void revalidate({ environmentId, input: { projectId } });
  }, [environmentId, projectId, revalidate]);

  const bannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    const id = `project-memory-recovery:${scopeKey}`;
    if (view.kind === "checking") {
      return {
        id,
        variant: "info",
        compact: true,
        icon: <HistoryIcon />,
        title: "Checking project memory changes…",
      };
    }
    if (view.kind === "error") {
      return {
        id,
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: "Couldn't check project memory changes for this thread.",
        description: "Messages in this thread may be held until this is resolved.",
        actions: (
          <Button size="xs" variant="ghost" onClick={retryCheck}>
            Retry
          </Button>
        ),
      };
    }
    if (view.kind === "held") {
      const busy = pending !== null;
      return {
        id,
        variant: "warning",
        priority: "urgent",
        icon: <HistoryIcon />,
        title: "Project memory used by this thread changed",
        description:
          `${view.updated} updated · ${view.deleted} deleted in the latest ${view.shown} recorded changes` +
          (view.mayHaveMore ? " — earlier changes may also exist" : "") +
          ". Messages here stay on hold until you choose.",
        actions: (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      size="xs"
                      variant="default"
                      disabled={busy}
                      onClick={() => void continueInNewThread()}
                    >
                      Continue in new thread
                    </Button>
                  </span>
                }
              />
              <TooltipPopup side="top">{CONTINUE_IN_NEW_THREAD_TOOLTIP}</TooltipPopup>
            </Tooltip>
            <Button size="xs" variant="ghost" disabled={busy} onClick={keepThisThreadsContext}>
              Keep this thread's context
            </Button>
          </>
        ),
      };
    }
    return null;
  }, [continueInNewThread, keepThisThreadsContext, pending, retryCheck, scopeKey, view]);

  const closeDialog = useCallback(() => {
    setCaptured(null);
    setAckError(null);
  }, []);
  const canConfirm =
    pending === null &&
    ackError !== "permission" &&
    canConfirmAcknowledge(captured, { scopeKey, supported, view });
  const dialog: ReactNode =
    captured === null ? null : (
      <AlertDialog
        open
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Project memory changes</AlertDialogTitle>
            <AlertDialogDescription>
              This accepts all project-memory changes recorded for this thread through change #
              {captured.seq}, including changes not shown here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2 px-6 text-sm">
            <p className="text-muted-foreground">
              The provider may still have the earlier memory content. Nothing is removed from the
              provider or its history.
            </p>
            <p className="text-muted-foreground">Any later change will hold this thread again.</p>
            {pending === null && ackError === null && !canConfirm ? (
              <p className="text-warning-foreground">
                Changes were updated. Close and review again.
              </p>
            ) : null}
            {ackError === "permission" ? (
              <p className="text-destructive">
                You don't have permission to confirm this on this server.
              </p>
            ) : null}
            {ackError === "retry" ? (
              <p className="text-destructive">
                Couldn't confirm. Review the changes and try again.
              </p>
            ) : null}
          </div>
          <AlertDialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              Close
            </Button>
            <Button disabled={!canConfirm} onClick={() => void confirmAck()}>
              Confirm
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    );

  return { bannerItem, dialog };
}
