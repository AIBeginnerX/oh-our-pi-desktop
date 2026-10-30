import type {
  EnvironmentId,
  ProjectId,
  ProjectMemoryProposal,
  ProjectMemoryProposalId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { projectMemory } from "../../state/projectMemory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * Memories an agent proposed through `memory_propose`. They stay out of
 * search and sends until approved; rejecting deletes them. Hidden when there is
 * nothing to review.
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
  const proposals = useEnvironmentQuery(
    projectMemory.proposals({ environmentId, input: { projectId } }),
  );
  const approve = useAtomCommand(projectMemory.approveProposal, { reportFailure: false });
  const reject = useAtomCommand(projectMemory.rejectProposal, { reportFailure: false });
  const [busyId, setBusyId] = useState<ProjectMemoryProposalId | null>(null);

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
      <p className="text-sm font-medium text-foreground">Proposed by agents</p>
      <p className="text-xs text-muted-foreground">
        Not saved until you approve. Approved proposals become normal memories.
      </p>
      <ul className="flex flex-col gap-2">
        {items.map((proposal) => (
          <li
            key={proposal.proposalId}
            className="flex flex-col gap-1 rounded-md border border-border px-3 py-2"
          >
            <p className="whitespace-pre-wrap break-words text-sm text-foreground">
              {proposal.body}
            </p>
            <p className="break-words text-xs text-muted-foreground">Why: {proposal.reason}</p>
            <div className="flex justify-end gap-2">
              <Button
                size="xs"
                variant="ghost"
                disabled={busyId !== null || writeLock !== null}
                title={writeLock ?? undefined}
                onClick={() =>
                  void decide(proposal, () => reject(input(proposal)), "Proposal rejected")
                }
              >
                Reject
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busyId !== null || writeLock !== null}
                title={writeLock ?? undefined}
                onClick={() =>
                  void decide(proposal, () => approve(input(proposal)), "Saved to project memory")
                }
              >
                Approve
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
