import {
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

// Fixed public payloads for normalized reasons. The original error or defect
// is never attached: AgentSessionScanError.cause and the RPC defect schema are
// Schema.Defect, so a real error value would serialize its message and cause
// chain onto the wire.
const PUBLIC_IMPORT_FAILURE = "Agent session import could not complete.";
const PUBLIC_IMPORT_DEFECT = "Agent session import failed unexpectedly.";

/**
 * Rewrites the typed failure and defect payloads of an agentSessions.import
 * failure cause to this endpoint's public wire payloads.
 *
 * The first pass (Cause.map) normalizes every Fail reason: ProjectNotFound and
 * ProjectChanged instances pass through unchanged, an existing ScanError keeps
 * its operation with the fixed public cause, and every other typed error
 * becomes a "read-projects" ScanError with that same cause.
 *
 * The second pass replaces each Die reason with a fresh fixed-string Die,
 * copying that reason's annotation entries (the annotations Map itself is not
 * shared). Relative to that intermediate cause, Fail and Interrupt reasons are
 * the same objects, so interrupt fiber ids survive. Reason kinds, count, and
 * order are identical, so hasDies/hasInterrupts and the fatal-versus-Exit
 * branch are preserved. A cause with no Die reasons is the Cause.map result —
 * a pure Interrupt cause is still returned as the same object.
 *
 * Removed payload: the original defect's message, cause chain, and stack leave
 * the boundary cause. Preserved reason annotations may still carry stack or
 * log metadata — they are not scrubbed, though they do not cross the wire.
 * Nothing here claims privacy for other endpoints or for defects raised
 * outside this normalization boundary.
 */
export const toAgentSessionImportRpcCause = (
  cause: Cause.Cause<unknown>,
): Cause.Cause<
  | AgentSessionImportProjectChangedError
  | AgentSessionImportProjectNotFoundError
  | AgentSessionScanError
> => {
  const publicCause = Cause.map(cause, (error) =>
    error instanceof AgentSessionImportProjectNotFoundError ||
    error instanceof AgentSessionImportProjectChangedError
      ? error
      : new AgentSessionScanError({
          operation: error instanceof AgentSessionScanError ? error.operation : "read-projects",
          cause: PUBLIC_IMPORT_FAILURE,
        }),
  );
  return Cause.hasDies(publicCause)
    ? Cause.fromReasons(
        publicCause.reasons.map((reason) =>
          Cause.isDieReason(reason)
            ? Cause.makeDieReason(PUBLIC_IMPORT_DEFECT).annotate(Cause.reasonAnnotations(reason))
            : reason,
        ),
      )
    : publicCause;
};
