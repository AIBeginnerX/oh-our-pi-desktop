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
 * Drivers not named here are denied.
 */
import { ProviderDriverKind } from "@t3tools/contracts";

export type ProjectMemorySendDecision =
  | { readonly status: "supported"; readonly verifiedBy: string }
  | { readonly status: "not-supported-yet"; readonly reason: string };

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
    status: "supported",
    verifiedBy:
      "CursorAdapter.memoryAdmission with the session/prompt publish admission re-judged inside the ACP dispatch, refusing stale contexts and holds placed while the prompt queued, and the generic echo mask over Cursor's persisted runtime events",
  },
  grok: {
    status: "supported",
    verifiedBy:
      "GrokAdapter.memoryAdmission with the session/prompt publish admission re-judged inside the ACP dispatch — refusing stale or replaced contexts, prompts queued behind an in-flight turn when the gate closes while they wait, and steering, epoch and liveness state restored on refusal, except that a refused steer ends the turn whose prompt it already cancelled — plus the generic echo mask over the adapter's persisted error, warning and turn.completed frames (shared with zcode and minimax)",
  },
  zcode: {
    status: "supported",
    verifiedBy:
      "ZCodeDriver builds the shared Grok ACP adapter, so the same GrokAdapter.memoryAdmission publish admission and echo audit cover it; see the grok entry",
  },
  minimax: {
    status: "supported",
    verifiedBy:
      "MiniMaxDriver builds the shared Grok ACP adapter, so the same GrokAdapter.memoryAdmission publish admission and echo audit cover it; see the grok entry",
  },
  opencode: {
    status: "supported",
    verifiedBy:
      "OpenCodeAdapter and OpenCode2Adapter memoryAdmission, fronted by the adapter selector and drawing session generations from one shared sequence, with the publish admission judged inside the SDK request callback — refusing stopped or replaced contexts and sends queued behind an in-flight turn when the gate closes while they wait, with no turn.aborted or lastError on refusal — plus the generic echo mask over OpenCode's runtime.error, runtime.warning, turn.completed and session-title frames",
  },
  antigravity: {
    status: "supported",
    verifiedBy:
      "AntigravityAdapter.memoryAdmission with the session/prompt publish admission re-judged inside the ACP dispatch — refusing stopped or replaced contexts before the prompt forks and at the publish point, binding the turn only once admitted (the send holds the prompt lock until then), so a refusal leaves no turn boundary or activity, except that a refused steer ends the turn whose prompt it already cancelled — plus the generic echo mask over the adapter's persisted turn.completed and task.* error frames",
  },
} as const satisfies Record<string, ProjectMemorySendDecision>;

export const PROJECT_MEMORY_SEND_DRIVER_KINDS: ReadonlySet<ProviderDriverKind> = new Set(
  Object.entries(PROJECT_MEMORY_SEND_DECISIONS).flatMap(([driver, decision]) =>
    decision.status === "supported" ? [ProviderDriverKind.make(driver)] : [],
  ),
);
