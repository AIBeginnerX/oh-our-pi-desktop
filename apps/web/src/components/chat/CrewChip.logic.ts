import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { canLeadCrew, type CrewModelOption } from "@t3tools/shared/crew";

const sameSelection = (
  a: ModelSelection | null | undefined,
  b: ModelSelection | null | undefined,
) => a != null && b != null && a.instanceId === b.instanceId && a.model === b.model;

/**
 * Models the user may still list as a role's fallbacks: everything on offer except the role's own
 * model (the chain tries it first) and the ones already listed. The three-model cap is the
 * caller's to enforce.
 */
export function crewFallbackCandidates(
  options: ReadonlyArray<CrewModelOption>,
  assigned: CrewModelOption | null,
  listed: ReadonlyArray<ModelSelection>,
): CrewModelOption[] {
  return options.filter(
    (option) =>
      !sameSelection(option.selection, assigned?.selection) &&
      !listed.some((entry) => sameSelection(entry, option.selection)),
  );
}

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
