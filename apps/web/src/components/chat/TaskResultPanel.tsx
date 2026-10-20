import {
  validateTaskResultItems,
  type EnvironmentId,
  type ProjectScript,
  type TaskResultRequirementItem,
  type ThreadId,
} from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import type { SelectedChecksCurrentSource } from "../../state/selectedChecks";
import { serverRequirementItems, useTaskResult } from "../../state/taskResult";

const SCOPE_NOTE = "이 Git 작업 트리(추적·비무시 파일)와 최신 검사 시도 1개만 봅니다.";

const STATE_BADGE: Record<string, string> = {
  loading: "Loading task result",
  unsupported: "Not supported on this server",
  "read-failed": "Could not read task result",
  stale: "Out of date — refresh",
};

const DERIVED_STATE_BADGE: Record<string, string> = {
  "no-requirements": "No requirements yet",
  failed: "A required check failed",
  running: "Checks still running",
  "needs-confirmation": "Needs confirmation",
  "awaiting-acceptance": "Awaiting your acceptance",
  verified: "Verified by you",
};

const ACCEPTANCE_BADGE: Record<string, string> = {
  none: "Not accepted",
  current: "Accepted (current)",
  stale: "Accepted (stale)",
};

const sameScriptIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

function draftItemDirty(
  item: TaskResultRequirementItem,
  server: ReadonlyArray<TaskResultRequirementItem>,
): boolean {
  const baseline = server.find((entry) => entry.id === item.id);
  if (baseline === undefined) return true;
  return baseline.text !== item.text || !sameScriptIds(baseline.scriptIds, item.scriptIds);
}

function itemStatusLabel(
  item: TaskResultRequirementItem,
  server: ReadonlyArray<TaskResultRequirementItem>,
  draftUnsaved: boolean,
  derivedStatus: "checked" | "user-judged" | "unproven" | undefined,
  acceptance: "none" | "current" | "stale",
): string {
  if (draftUnsaved && draftItemDirty(item, server)) return "Unsaved edits";
  if (derivedStatus === "checked") return "Check passed";
  if (derivedStatus === "unproven") return "Not proven";
  if (acceptance === "current") return "Accepted by you";
  return "Needs your judgment";
}

function newItemId(): string {
  return `req-${Date.now().toString(36)}`;
}

export interface TaskResultPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly readCurrentSource: () => SelectedChecksCurrentSource | null;
  readonly candidates: ReadonlyArray<ProjectScript>;
  readonly recordKey: string | null;
}

export function TaskResultPanel({
  environmentId,
  threadId,
  readCurrentSource,
  candidates,
  recordKey,
}: TaskResultPanelProps) {
  const task = useTaskResult({ environmentId, threadId, readCurrentSource, recordKey });
  const {
    state,
    notice,
    busy,
    draftItems,
    draftUnsaved,
    refresh,
    setRequirements,
    accept,
    withdraw,
    setDraftItems,
  } = task;

  const serverItems =
    state.phase === "ready"
      ? serverRequirementItems(state.result)
      : ([] as TaskResultRequirementItem[]);
  const candidateIds = new Set(candidates.map((script) => script.id));

  const canEdit = state.phase === "ready" && state.controls.canEdit;
  const acceptance = state.phase === "ready" ? state.derived.acceptance : "none";

  const saveDisabled = !canEdit || validateTaskResultItems(draftItems).length > 0 || busy;

  const headlineBadge =
    state.phase === "ready" ? DERIVED_STATE_BADGE[state.derived.state] : STATE_BADGE[state.phase];

  const acceptanceBadge =
    state.phase === "ready" ? ACCEPTANCE_BADGE[state.derived.acceptance] : null;

  const toggleScript = (itemId: string, scriptId: string, checked: boolean) => {
    setDraftItems(
      draftItems.map((item) => {
        if (item.id !== itemId) return item;
        const ids = new Set(item.scriptIds);
        if (checked) ids.add(scriptId);
        else ids.delete(scriptId);
        return { ...item, scriptIds: [...ids] };
      }),
    );
  };

  const updateText = (itemId: string, text: string) => {
    setDraftItems(draftItems.map((item) => (item.id === itemId ? { ...item, text } : item)));
  };

  const addItem = () => {
    const id = newItemId();
    setDraftItems([...draftItems, { id, text: "", scriptIds: [] }]);
  };

  const removeItem = (itemId: string) => {
    setDraftItems(draftItems.filter((item) => item.id !== itemId));
  };

  const removeMissingScript = (itemId: string, scriptId: string) => {
    setDraftItems(
      draftItems.map((item) =>
        item.id === itemId
          ? { ...item, scriptIds: item.scriptIds.filter((id) => id !== scriptId) }
          : item,
      ),
    );
  };

  const derivedItems = state.phase === "ready" ? state.derived.items : [];

  return (
    <section className="mt-4 space-y-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">Task result</h3>
        <Badge variant="outline">{headlineBadge}</Badge>
        {acceptanceBadge !== null ? <Badge variant="outline">{acceptanceBadge}</Badge> : null}
      </div>
      <p className="text-muted-foreground text-sm">{SCOPE_NOTE}</p>
      {notice !== null ? <p className="text-destructive text-sm">{notice.message}</p> : null}
      {draftUnsaved ? (
        <p className="text-muted-foreground text-sm">Unsaved requirement edits.</p>
      ) : null}
      {state.phase === "ready" && state.derived.reasons.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground text-sm">Details</summary>
          <ul className="mt-1 list-inside list-disc text-muted-foreground text-sm">
            {state.derived.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {state.phase === "ready" || draftUnsaved ? (
        <ul className="space-y-3">
          {draftItems.map((item) => {
            const derived = derivedItems.find((entry) => entry.id === item.id);
            const missingScripts = item.scriptIds.filter((id) => !candidateIds.has(id));
            return (
              <li key={item.id} className="space-y-2 rounded border border-border p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Input
                    value={item.text}
                    disabled={!canEdit || busy}
                    onChange={(event) => updateText(item.id, event.target.value)}
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs">
                      {itemStatusLabel(
                        item,
                        serverItems,
                        draftUnsaved,
                        derived?.status,
                        acceptance,
                      )}
                    </span>
                    {canEdit ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => removeItem(item.id)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  {candidates.map((script) => (
                    <label
                      key={`${item.id}:${script.id}`}
                      className="flex items-center gap-1 text-sm"
                    >
                      <Checkbox
                        checked={item.scriptIds.includes(script.id)}
                        disabled={!canEdit || busy}
                        onCheckedChange={(value) =>
                          toggleScript(item.id, script.id, value === true)
                        }
                      />
                      {script.name}
                    </label>
                  ))}
                </div>
                {missingScripts.length > 0 ? (
                  <ul className="space-y-1 text-destructive text-sm">
                    {missingScripts.map((scriptId) => (
                      <li
                        key={`${item.id}:missing:${scriptId}`}
                        className="flex items-center gap-2"
                      >
                        <span>Missing check binding: {scriptId}</span>
                        {canEdit ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => removeMissingScript(item.id, scriptId)}
                          >
                            Remove binding
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canEdit ? (
          <>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={addItem}>
              Add requirement
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={saveDisabled}
              onClick={() => setRequirements(draftItems)}
            >
              Save requirements
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={
            busy || draftUnsaved || state.phase !== "ready" || state.controls.accept === null
          }
          onClick={accept}
        >
          Accept
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || state.phase !== "ready" || !state.controls.canWithdraw}
          onClick={withdraw}
        >
          Withdraw
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={refresh}>
          Re-measure
        </Button>
      </div>
    </section>
  );
}
