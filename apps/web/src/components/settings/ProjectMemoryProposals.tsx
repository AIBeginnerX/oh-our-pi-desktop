import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { projectMemoryProposalView } from "@t3tools/client-runtime/state/project-memory-proposals";
import {
  PROJECT_MEMORY_DERIVED_VALID_DAYS,
  type EnvironmentId,
  type ProjectId,
  type ProjectMemoryProposal,
  type ProjectMemoryProposalId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useT } from "../../i18n";
import { buildThreadRouteParams } from "../../threadRoutes";
import { projectMemory } from "../../state/projectMemory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * Memories an agent proposed through `memory_propose`, and suggestions from
 * "Analyse recent work". They stay out of search and sends until approved;
 * rejecting deletes them, and a rejected suggestion is not offered again.
 * Hidden when there is nothing to review.
 */
export function ProjectMemoryProposals({
  environmentId,
  projectId,
  writeLock,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** Why decisions are unavailable, or null when the user may decide. */
  readonly writeLock: string | null;
}) {
  const t = useT();
  const proposals = useEnvironmentQuery(
    projectMemory.proposals({ environmentId, input: { projectId } }),
  );
  const approve = useAtomCommand(projectMemory.approveProposal, { reportFailure: false });
  const reject = useAtomCommand(projectMemory.rejectProposal, { reportFailure: false });
  const [busyId, setBusyId] = useState<ProjectMemoryProposalId | null>(null);
  const navigate = useNavigate();

  const items = proposals.data?.items ?? [];
  if (items.length === 0) return null;

  const decide = async (
    proposal: ProjectMemoryProposal,
    run: () => Promise<AtomCommandResult<unknown, unknown>>,
    done: string,
  ) => {
    if (busyId !== null || writeLock !== null) return;
    setBusyId(proposal.proposalId);
    try {
      const result = await run();
      if (result._tag === "Success") {
        toastManager.add({ type: "success", title: done });
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      // Memory RPC failures carry fixed server messages, never the proposal text.
      const cause = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: cause instanceof Error ? cause.message : "The memory request failed.",
      });
    } finally {
      setBusyId(null);
    }
  };

  const input = (proposal: ProjectMemoryProposal) => ({
    environmentId,
    input: { projectId, proposalId: proposal.proposalId },
  });

  return (
    <div className="flex flex-col gap-2 pb-2">
      <p className="text-sm font-medium text-foreground">Proposed memories</p>
      <p className="text-xs text-muted-foreground">
        Not saved until you approve. Approved proposals become normal memories.
      </p>
      <ul className="flex flex-col gap-2">
        {items.map((proposal) => {
          const view = projectMemoryProposalView(proposal);
          const disabled = busyId !== null || writeLock !== null;
          return (
            <li
              key={proposal.proposalId}
              className="flex flex-col gap-1 rounded-md border border-border px-3 py-2"
            >
              <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                {proposal.body}
              </p>
              {view.source === "agent" ? (
                <p className="break-words text-xs text-muted-foreground">Why: {proposal.reason}</p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    {view.target === "skill"
                      ? t("A procedure seen in recent work. Save it from the thread's skill draft.")
                      : t(
                          "Suggested from recent work. If approved, it expires {days} days later unless you change that.",
                          { days: PROJECT_MEMORY_DERIVED_VALID_DAYS },
                        )}
                  </p>
                  <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    {t("Seen in:")}
                    {view.evidenceThreadIds.map((threadId, index) => (
                      <Button
                        key={threadId}
                        size="xs"
                        variant="link"
                        onClick={() =>
                          void navigate({
                            to: "/$environmentId/$threadId",
                            params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
                          })
                        }
                      >
                        {t("Thread {index}", { index: index + 1 })}
                      </Button>
                    ))}
                  </p>
                  {view.related.map((memory) => (
                    <div
                      key={memory.memoryId}
                      className="rounded-md border border-border bg-muted/40 px-2 py-1"
                    >
                      <p className="text-xs font-medium text-muted-foreground">
                        {t("Similar existing memory: {title}", { title: memory.title })}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-xs text-foreground">
                        {memory.body}
                      </p>
                    </div>
                  ))}
                </>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  title={writeLock ?? undefined}
                  onClick={() =>
                    void decide(
                      proposal,
                      () => reject(input(proposal)),
                      view.source === "agent" ? "Proposal rejected" : t("Suggestion dismissed"),
                    )
                  }
                >
                  {view.source === "agent" ? "Reject" : t("Dismiss")}
                </Button>
                {view.canApprove ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    title={writeLock ?? undefined}
                    onClick={() =>
                      void decide(
                        proposal,
                        () => approve(input(proposal)),
                        "Saved to project memory",
                      )
                    }
                  >
                    Approve
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(
                          scopeThreadRef(
                            environmentId,
                            view.evidenceThreadIds[0] ?? proposal.threadId,
                          ),
                        ),
                      })
                    }
                  >
                    {t("Open thread")}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
