import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { canLeadCrew } from "@t3tools/shared/crew";

/**
 * Whether the chat's model can lead an OOP Crew. The server decides (`canLeadCrew` on the
 * provider); a server that does not say falls back to the driver list (Claude and Codex), and a
 * provider the snapshot does not list is not blocked, since the server refuses anyway.
 */
export function crewLeadAvailability(
  providers: ReadonlyArray<ServerProvider>,
  brain: ModelSelection,
): { readonly canLead: boolean; readonly reason: string | null } {
  const provider = providers.find((candidate) => candidate.instanceId === brain.instanceId);
  if (provider === undefined) return { canLead: true, reason: null };
  if (provider.canLeadCrew ?? canLeadCrew(provider.driver)) return { canLead: true, reason: null };
  return {
    canLead: false,
    reason: `${provider.displayName ?? provider.driver} cannot lead an OOP Crew. The lead must be a Claude or Codex model.`,
  };
}
