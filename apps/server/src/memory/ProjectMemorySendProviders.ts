/**
 * Build-time provider decisions for sending project memory. This is the one
 * place that says which drivers receive memory; there is no settings or
 * environment switch (see `ProjectMemorySendGate`).
 *
 * A driver joins the allow list only after its adapter has been verified on
 * all of these:
 * - the adapter implements `memoryAdmission` and calls the sendTurn admission
 *   at its synchronous publish point, so a late hold or a swapped session
 *   fails closed before the prompt leaves;
 * - the memory envelope reaches the provider through `sendTurn` input and not
 *   through any other path;
 * - echoed memory text is withheld by `memoryEcho.ts` wherever that driver's
 *   errors, notices and diagnostics are persisted.
 *
 * Drivers not named here are denied, which includes `minimax` and `zcode`.
 */
import { ProviderDriverKind } from "@t3tools/contracts";

export type ProjectMemorySendDecision =
  | { readonly status: "supported"; readonly verifiedBy: string }
  | { readonly status: "not-supported-yet"; readonly reason: string };

const NOT_VERIFIED = "not supported yet - not verified";

export const PROJECT_MEMORY_SEND_DECISIONS = {
  claudeAgent: {
    status: "supported",
    verifiedBy: "ClaudeAdapter.memoryAdmission and the claude/assistant error snapshot echo mask",
  },
  codex: {
    status: "supported",
    verifiedBy:
      "CodexAdapter.memoryAdmission with the turn/start publish admission, and the generic echo mask over Codex error, warning, stderr and turn.completed events",
  },
  cursor: {
    status: "not-supported-yet",
    reason: `${NOT_VERIFIED}: no memoryAdmission or publish admission, no echo review of ACP error frames`,
  },
  grok: {
    status: "not-supported-yet",
    reason: `${NOT_VERIFIED}: no memoryAdmission or publish admission, no echo review of its error frames`,
  },
  opencode: {
    status: "not-supported-yet",
    reason: `${NOT_VERIFIED}: no memoryAdmission or publish admission, no echo review of its error events`,
  },
  antigravity: {
    status: "not-supported-yet",
    reason: `${NOT_VERIFIED}: no memoryAdmission or publish admission, no echo review of its error events`,
  },
} as const satisfies Record<string, ProjectMemorySendDecision>;

export const PROJECT_MEMORY_SEND_DRIVER_KINDS: ReadonlySet<ProviderDriverKind> = new Set(
  Object.entries(PROJECT_MEMORY_SEND_DECISIONS).flatMap(([driver, decision]) =>
    decision.status === "supported" ? [ProviderDriverKind.make(driver)] : [],
  ),
);
