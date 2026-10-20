import * as DateTime from "effect/DateTime";
import { useState } from "react";
import {
  parseSelectedCheckInstant,
  SELECTED_CHECK_MAX,
  selectedCheckTreeDisagreement,
  type ProjectScript,
  type SelectedCheckAdmission,
  type SelectedCheckReceipt,
  type SelectedCheckResult,
  type EnvironmentId,
  type SelectedChecksResolveOwnershipResult,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  SelectedChecksHeadline,
  SelectedChecksNotice,
  SelectedChecksRunRejectionReason,
  SelectedChecksView,
} from "@t3tools/client-runtime/state/selected-checks-control";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import type { ResultUsageDisclosureState } from "../../state/resultUsage";
import type { SelectedChecksCurrentSource } from "../../state/selectedChecks";
import { selectedChecksRecordKey } from "../../state/selectedChecks";
import { TaskResultPanel } from "./TaskResultPanel";
import {
  formatResultUsageRowLines,
  RESULT_USAGE_HEADLINE,
  RESULT_USAGE_SCOPE_NOTE,
  RESULT_USAGE_SNAPSHOT_NOTE,
  RESULT_USAGE_STATE_COPY,
} from "./resultUsageText";

const RECORD_SCOPE_NOTICE =
  "This is a record of how the selected checks ended at that time. It does not verify the whole task or the current workspace. Programs a check started outside its own process group are not tracked.";

const HEADLINE_COPY: Record<SelectedChecksHeadline, string> = {
  unknown: "Not confirmed",
  unsupported: "Not supported by this server version",
  error: "Not confirmed",
  starting: "Starting",
  running: "Running",
  "awaiting-confirmation": "Waiting for the recorded result",
  none: "No record yet",
  unreadable: "Record could not be read",
  failed: "Failed",
  incomplete: "Not confirmed",
  passed: "Selected checks passed",
};

const REJECTION_COPY: Record<SelectedChecksRunRejectionReason, string> = {
  "not-posix": "This server platform does not support selected checks.",
  "shell-unavailable": "The server's shell could not be found.",
  reconciling: "The server is starting up.",
  busy: "Another check run is active.",
  "owner-unresolved": "Previous run needs review.",
  "owner-corrupt": "Previous run needs review.",
  "owner-unreadable": "Previous run needs review.",
  "owner-unrecorded": "Previous run needs review.",
  "turn-active": "The agent is working in this thread.",
  "script-not-found": "That action no longer exists.",
  "record-failed": "A run record could not be saved.",
  "context-changed": "The thread changed before the run started.",
  "owner-marker-failed": "A run record could not be saved.",
};

const RESOLVE_OUTCOME_COPY: Record<SelectedChecksResolveOwnershipResult["outcome"], string> = {
  "cleared-gone":
    "The recorded process group is no longer running. Programs that left that group are not covered.",
  acknowledged: "Uncertainty recorded. Nothing was stopped.",
  "still-unresolved": "The previous run still needs review.",
  stale: "Status changed. Review it again.",
  "attempt-live": "The recorded attempt is still running.",
  unreadable: "The ownership file could not be read. Check its permissions on the server.",
  "persist-failed": "Could not save. Review the refreshed status.",
};

function noticeText(notice: SelectedChecksNotice): string {
  switch (notice.key) {
    case "run-rejected":
      return notice.reason === "script-not-found"
        ? `Action '${notice.scriptId ?? "?"}' no longer exists.`
        : REJECTION_COPY[notice.reason];
    case "run-superseded":
      return "That run is no longer the latest record for this thread.";
    case "run-unavailable":
      return "That run's record is unavailable.";
    case "start-unconfirmed":
      return "Start could not be confirmed.";
    case "cancel-unconfirmed":
      return "Stop could not be confirmed.";
    case "resolve-unconfirmed":
      return "The recovery result could not be confirmed.";
    case "cancel-requested":
      return "Stop requested; showing the recorded result.";
    case "cancel-no-match":
      return "No matching active check was stopped; refreshing status.";
    case "thread-unavailable":
      return "This thread is unavailable.";
    case "resolve-outcome":
      return RESOLVE_OUTCOME_COPY[notice.outcome];
  }
}

function formatInstant(value: string | null): string {
  const instant = value === null ? null : parseSelectedCheckInstant(value);
  if (instant === null) return "time unavailable";
  const date = new Date(DateTime.toEpochMillis(instant));
  return Number.isNaN(date.getTime()) ? "time unavailable" : date.toLocaleString();
}

function checkStatusText(check: SelectedCheckResult): string {
  switch (check.status) {
    case "passed":
      return "passed";
    case "failed":
      return check.exitCode === null ? "failed" : `exited ${check.exitCode}`;
    case "timed-out":
      return "timed out";
    case "cancelled":
      return "stopped";
    case "unproven":
      return "not confirmed";
    case "not-run":
      return "not run";
    case "pending":
      return "waiting";
    case "running":
      return "running";
  }
}

function incompleteLines(
  receipt: SelectedCheckReceipt,
  recordedName: (id: string) => string,
): string[] {
  const lines = new Set<string>();
  if (receipt.phase === "cancelled") lines.add("Stopped before finishing.");
  else if (receipt.phase === "interrupted") lines.add("The attempt did not finish.");
  switch (receipt.error) {
    case "result-missing":
      lines.add("The check result could not be recovered.");
      break;
    case "server-restarted":
    case "server-stopped":
      lines.add("The server restarted or stopped during the attempt.");
      break;
    case "context-changed":
      lines.add("The thread changed before the run started.");
      break;
    case "owner-marker-mismatch":
      lines.add("The ownership record changed or could not be matched.");
      break;
    case "record-failed":
    case "owner-marker-failed":
      lines.add("A run record could not be saved.");
      break;
    case "tree-capture-failed":
      lines.add("The workspace changed during the run or could not be checked.");
      break;
  }
  if (selectedCheckTreeDisagreement(receipt.tree.atStart, receipt.tree.atEnd) !== null) {
    lines.add("The workspace changed during the run or could not be checked.");
  }
  const { repoAtStart, repoAtEnd } = receipt.tree;
  if (
    repoAtStart === null ||
    repoAtEnd === null ||
    repoAtStart.topLevel !== repoAtEnd.topLevel ||
    repoAtStart.commonDir !== repoAtEnd.commonDir
  ) {
    lines.add("The start and end repository could not be matched.");
  }
  for (const check of receipt.checks) {
    if (check.status === "unproven") {
      lines.add(`'${recordedName(check.scriptId)}' could not be fully confirmed.`);
    }
  }
  if (lines.size === 0) lines.add("Not every condition for a pass was recorded.");
  return [...lines];
}

function CopyButton({ value }: { readonly value: string }) {
  return (
    <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(value)}>
      Copy
    </Button>
  );
}

function AdmissionDetails({
  admission,
  threadId,
  threadTitle,
  nameForOwner,
}: {
  readonly admission: SelectedCheckAdmission;
  readonly threadId: ThreadId;
  readonly threadTitle: string | null;
  readonly nameForOwner: (
    scriptId: string,
    ownerThreadId: ThreadId,
    ownerAttemptId: string,
  ) => string;
}) {
  switch (admission.state) {
    case "owner-unresolved": {
      const marker = admission.marker;
      const ownThread = marker.threadId === threadId;
      return (
        <div className="space-y-1 text-muted-foreground">
          <p>
            {ownThread && threadTitle !== null
              ? threadTitle
              : `Thread name unavailable (${marker.threadId})`}
          </p>
          <p>
            Check:{" "}
            {marker.scriptId === null
              ? "unknown"
              : nameForOwner(marker.scriptId, marker.threadId, marker.attemptId)}
          </p>
          <p>Recorded: {formatInstant(marker.writtenAt)}</p>
          <p>Process group: {marker.pgid ?? "unknown"}</p>
          <p className="break-all font-mono text-xs">
            {marker.sha256} <CopyButton value={marker.sha256} />
          </p>
        </div>
      );
    }
    case "owner-corrupt": {
      const marker = admission.marker;
      return (
        <div className="space-y-1 text-muted-foreground">
          <p className="break-all font-mono text-xs">
            {marker.sha256} <CopyButton value={marker.sha256} />
          </p>
          <p>{marker.bytes} bytes</p>
        </div>
      );
    }
    case "owner-unrecorded": {
      const owner = admission.owner;
      const ownThread = owner.threadId === threadId;
      return (
        <div className="space-y-1 text-muted-foreground">
          <p>
            {ownThread && threadTitle !== null
              ? threadTitle
              : `Thread name unavailable (${owner.threadId})`}
          </p>
          <p>
            Check:{" "}
            {owner.scriptId === null
              ? "unknown"
              : nameForOwner(owner.scriptId, owner.threadId, owner.attemptId)}
          </p>
          <p>Process group: {owner.pgid ?? "unknown"}</p>
          <p className="font-mono text-xs">attempt {owner.attemptId}</p>
        </div>
      );
    }
    case "owner-unreadable":
      return (
        <p className="text-muted-foreground">
          The ownership file could not be read. Check its permissions on the server.
        </p>
      );
    default:
      return null;
  }
}

function RecoveryConsent({
  dialog,
  submit,
  onSubmit,
  onCancel,
}: {
  readonly dialog: NonNullable<SelectedChecksView["dialog"]>;
  readonly submit: SelectedChecksView["dialogSubmit"];
  readonly onSubmit: (acknowledged: boolean) => void;
  readonly onCancel: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <section className="space-y-2 rounded-md border border-border p-3">
      <p className="font-medium">Continue without confirmation?</p>
      <p className="break-all font-mono text-xs">
        {dialog.sha256} <CopyButton value={dialog.sha256} />
      </p>
      <label className="flex items-center gap-2">
        <Checkbox
          checked={acknowledged}
          onCheckedChange={(checked) => setAcknowledged(checked === true)}
        />
        <span>Programs from the previous run may still be running.</span>
      </label>
      <p className="text-muted-foreground">OOP will not stop those programs or rerun any check.</p>
      {submit !== null && !submit.allowed ? (
        <p className="text-muted-foreground">Status changed. Review it again.</p>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!acknowledged || submit === null || !submit.allowed}
          onClick={() => onSubmit(acknowledged)}
        >
          Continue without confirmation
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

/**
 * The passed-record usage disclosure: one guarded state from the result
 * usage read rendered as fixed copy or exact row lines. Numbers only ever
 * appear in the "row" phase — every other phase is honest unavailable copy.
 */
export function ResultUsageDisclosure({ state }: { readonly state: ResultUsageDisclosureState }) {
  const [open, setOpen] = useState(false);
  return (
    <details open={open} className="rounded-md border border-border">
      <summary
        className="cursor-pointer px-3 py-2 text-muted-foreground"
        onClick={(event) => {
          // The controlled open state alone drives the native toggle; letting
          // the summary's default toggle also run would double-flip each click.
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        이 결과까지의 사용량
      </summary>
      <div className="space-y-1 px-3 pb-2 text-muted-foreground">
        {state.phase === "row" ? (
          <>
            <p className="font-medium text-foreground">{RESULT_USAGE_HEADLINE}</p>
            <p>{RESULT_USAGE_SCOPE_NOTE}</p>
            {formatResultUsageRowLines(state.row).map((line, index) => (
              <p key={`${index}:${line}`}>{line}</p>
            ))}
            <p>{RESULT_USAGE_SNAPSHOT_NOTE}</p>
          </>
        ) : state.phase === "hidden" ? null : (
          <p>{RESULT_USAGE_STATE_COPY[state.phase]}</p>
        )}
      </div>
    </details>
  );
}

export interface SelectedChecksPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly view: SelectedChecksView;
  readonly candidates: ReadonlyArray<ProjectScript>;
  readonly threadId: ThreadId;
  readonly threadTitle: string | null;
  readonly permission: "allowed" | "read-only" | "unknown";
  readonly permissionStatus: "checking" | "confirmed" | "failed" | "stale" | "idle";
  readonly onRetryPermission: () => void;
  readonly onToggle: (id: string) => void;
  readonly onRefresh: () => void;
  readonly onRun: () => void;
  readonly onStop: () => void;
  readonly onRecheck: () => void;
  readonly onOpenRecoveryDialog: () => void;
  readonly onCloseRecoveryDialog: () => void;
  readonly onSubmitRecovery: (acknowledged: boolean) => void;
  /** Present only when the current record can back a skill candidate. */
  readonly onSaveAsSkillCandidate?: () => void;
  /** Guarded result-usage read state; rendered only for a current passed record. */
  readonly resultUsage?: ResultUsageDisclosureState | null;
  readonly taskResult?: {
    readonly environmentId: EnvironmentId;
    readonly readCurrentSource: () => SelectedChecksCurrentSource | null;
  } | null;
}

export function SelectedChecksPanel({
  open,
  onOpenChange,
  view,
  candidates,
  threadId,
  threadTitle,
  permission,
  permissionStatus,
  onRetryPermission,
  onToggle,
  onRefresh,
  onRun,
  onStop,
  onRecheck,
  onOpenRecoveryDialog,
  onCloseRecoveryDialog,
  onSubmitRecovery,
  onSaveAsSkillCandidate,
  resultUsage,
  taskResult,
}: SelectedChecksPanelProps) {
  const record = view.record;
  const receipt = record?.receipt ?? null;
  // Recorded names come only from the receipt's own plan — a renamed or
  // deleted action keeps the name the record captured.
  const recordedName = (id: string): string =>
    receipt?.planned.find((check) => check.scriptId === id)?.scriptName ?? id;
  const nameForOwner = (
    scriptId: string,
    ownerThreadId: ThreadId,
    ownerAttemptId: string,
  ): string =>
    ownerThreadId === threadId && receipt !== null && receipt.attemptId === ownerAttemptId
      ? recordedName(scriptId)
      : scriptId;
  const failedNames = receipt
    ? receipt.checks
        .filter((check) => check.status === "failed")
        .map((check) => recordedName(check.scriptId))
    : [];
  const headlineText =
    view.headline === "passed"
      ? `Selected checks passed · recorded ${formatInstant(receipt?.endedAt ?? null)}`
      : view.headline === "failed"
        ? `Failed: ${failedNames.join(", ")}`
        : HEADLINE_COPY[view.headline];
  const badgeVariant =
    view.headline === "passed" ? "info" : view.headline === "failed" ? "error" : "outline";
  const showVerdict =
    (view.headline === "incomplete" || view.headline === "failed") &&
    view.derived !== null &&
    receipt !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Selected checks</DialogTitle>
          <DialogDescription>{RECORD_SCOPE_NOTICE}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-center justify-between gap-3">
            <Badge variant={badgeVariant} size="control" role="status">
              {headlineText}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={onRefresh}
              disabled={view.commandInFlight !== null}
            >
              Refresh
            </Button>
          </div>

          {permission === "unknown" ? (
            <p className="text-muted-foreground">
              {permissionStatus === "checking"
                ? "Checking permissions…"
                : "Permission could not be confirmed."}
              {permissionStatus === "failed" || permissionStatus === "stale" ? (
                <>
                  {" "}
                  <Button size="sm" variant="ghost" onClick={onRetryPermission}>
                    Try again
                  </Button>
                </>
              ) : null}
            </p>
          ) : null}
          {permission === "read-only" ? (
            <p className="text-muted-foreground">This connection can view results only.</p>
          ) : null}
          {view.notice !== null ? <p role="status">{noticeText(view.notice)}</p> : null}
          {view.getError !== null ? (
            <p role="alert" className="text-destructive">
              {view.getError}
            </p>
          ) : null}

          {candidates.length > 0 ? (
            <section className="space-y-1">
              <p className="font-medium">
                Checks · {view.selection.length} of {SELECTED_CHECK_MAX} selected
              </p>
              <ul className="space-y-1">
                {candidates.map((script) => {
                  const checked = view.selection.includes(script.id);
                  const disabled = !checked && view.selection.length >= SELECTED_CHECK_MAX;
                  return (
                    <li key={script.id}>
                      <label className="flex items-start gap-2">
                        <Checkbox
                          className="mt-0.5"
                          checked={checked}
                          disabled={disabled}
                          onCheckedChange={() => onToggle(script.id)}
                        />
                        <span className="min-w-0">
                          <span className="block">{script.name}</span>
                          <span className="block break-all font-mono text-xs text-muted-foreground">
                            {script.command}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : (
            <p className="text-muted-foreground">
              This project has no actions to select. Records and recovery are still available here.
            </p>
          )}

          {taskResult ? (
            <TaskResultPanel
              environmentId={taskResult.environmentId}
              threadId={threadId}
              readCurrentSource={taskResult.readCurrentSource}
              candidates={candidates}
              recordKey={selectedChecksRecordKey(view)}
            />
          ) : null}

          {receipt !== null ? (
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium">
                  {view.recordAuthority === "previous"
                    ? "Previous record"
                    : view.recordAuthority === "live"
                      ? "Latest activity"
                      : "Recorded record"}
                </p>
                <span className="font-mono text-xs text-muted-foreground">
                  attempt {receipt.attemptId}
                </span>
              </div>
              {view.recordAuthority === "live" ? (
                <p className="text-muted-foreground">
                  Latest activity has not been confirmed by a fresh read.
                </p>
              ) : null}
              <p className="text-muted-foreground">
                {receipt.phase === "running"
                  ? `Started ${formatInstant(receipt.startedAt)}`
                  : `Recorded ${formatInstant(receipt.endedAt ?? receipt.startedAt)}`}
              </p>
              {receipt.checks.length > 0 ? (
                <ul className="divide-y divide-border rounded-md border">
                  {receipt.checks.map((check) => (
                    <li
                      key={check.scriptId}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <span className="min-w-0 truncate">{recordedName(check.scriptId)}</span>
                      <span className="shrink-0 text-muted-foreground">
                        Recorded: {checkStatusText(check)} ·{" "}
                        {formatInstant(check.endedAt ?? check.startedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">No checks were recorded in this attempt.</p>
              )}
              {view.changedScriptIds.length > 0 ? (
                <p className="text-muted-foreground">
                  Changed since this record:{" "}
                  {view.changedScriptIds.map((id) => recordedName(id)).join(", ")}
                </p>
              ) : null}
              {view.newerTurnAfterRecord ? (
                <p className="text-muted-foreground">
                  A newer agent turn started after this record.
                </p>
              ) : null}
              <p className="text-muted-foreground">The current workspace was not rechecked.</p>
              {view.comparisonStale ? (
                <p className="text-muted-foreground">Comparison may be out of date — Refresh.</p>
              ) : null}
              {view.headline === "passed" &&
              resultUsage !== undefined &&
              resultUsage !== null &&
              resultUsage.phase !== "hidden" ? (
                <ResultUsageDisclosure state={resultUsage} />
              ) : null}
              {showVerdict ? (
                <div className="space-y-1">
                  <ul className="list-inside list-disc space-y-1 text-muted-foreground">
                    {incompleteLines(receipt, recordedName).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">Details</summary>
                    <ul className="mt-1 list-inside list-disc space-y-1 text-muted-foreground">
                      {view.derived!.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      attempt {receipt.attemptId}
                    </p>
                  </details>
                </div>
              ) : null}
            </section>
          ) : null}

          {view.admission !== null && view.admission.state.startsWith("owner-") ? (
            <section className="space-y-2 rounded-md border border-border p-3">
              <p className="font-medium">A previous run needs review</p>
              <AdmissionDetails
                admission={view.admission}
                threadId={threadId}
                threadTitle={threadTitle}
                nameForOwner={nameForOwner}
              />
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={!view.canRecover} onClick={onRecheck}>
                  Recheck
                </Button>
                {view.admission.state === "owner-unresolved" ||
                view.admission.state === "owner-corrupt" ? (
                  <Button size="sm" variant="ghost" onClick={onOpenRecoveryDialog}>
                    Continue without confirmation…
                  </Button>
                ) : null}
              </div>
            </section>
          ) : null}

          {view.dialog !== null ? (
            <RecoveryConsent
              key={`${view.dialog.gen}:${view.dialog.sha256}`}
              dialog={view.dialog}
              submit={view.dialogSubmit}
              onSubmit={onSubmitRecovery}
              onCancel={onCloseRecoveryDialog}
            />
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {onSaveAsSkillCandidate !== undefined && view.headline !== "running" ? (
            <Button size="sm" variant="outline" onClick={onSaveAsSkillCandidate}>
              Save as skill candidate…
            </Button>
          ) : null}
          {view.headline === "running" ? (
            <Button size="sm" variant="outline" disabled={!view.canStop} onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button size="sm" disabled={!view.canRun} onClick={onRun}>
              Run selected
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
