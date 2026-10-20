import * as Schema from "effect/Schema";

import type { CheckpointServiceError } from "../checkpointing/Errors.ts";

/**
 * ProviderAdapterValidationError - Invalid adapter API input.
 */
export class ProviderAdapterValidationError extends Schema.TaggedError<ProviderAdapterValidationError>()(
  "ProviderAdapterValidationError",
  {
    provider: Schema.String,
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter validation failed (${this.provider}) in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderAdapterSessionNotFoundError - Adapter-owned session id is unknown.
 */
export class ProviderAdapterSessionNotFoundError extends Schema.TaggedError<ProviderAdapterSessionNotFoundError>()(
  "ProviderAdapterSessionNotFoundError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unknown ${this.provider} adapter thread: ${this.threadId}`;
  }
}

/**
 * ProviderAdapterSessionClosedError - Adapter session exists but is closed.
 */
export class ProviderAdapterSessionClosedError extends Schema.TaggedError<ProviderAdapterSessionClosedError>()(
  "ProviderAdapterSessionClosedError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} adapter thread is closed: ${this.threadId}`;
  }
}

/**
 * ProviderAdapterRequestError - Provider protocol request failed or timed out.
 */
export class ProviderAdapterRequestError extends Schema.TaggedError<ProviderAdapterRequestError>()(
  "ProviderAdapterRequestError",
  {
    provider: Schema.String,
    method: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter request failed (${this.provider}) for ${this.method}: ${this.detail}`;
  }
}

/**
 * ProviderAdapterProcessError - Provider process lifecycle failure.
 */
export class ProviderAdapterProcessError extends Schema.TaggedError<ProviderAdapterProcessError>()(
  "ProviderAdapterProcessError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter process error (${this.provider}) for thread ${this.threadId}: ${this.detail}`;
  }
}

/**
 * ProviderWorkspaceMissingError - The session's working directory no longer
 * exists on disk, so no provider process can start in it.
 */
export class ProviderWorkspaceMissingError extends Schema.TaggedError<ProviderWorkspaceMissingError>()(
  "ProviderWorkspaceMissingError",
  {
    threadId: Schema.String,
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return `This thread's workspace folder no longer exists or is not a directory: ${this.cwd}. Restore the folder at this path before retrying.`;
  }
}

/**
 * ProviderValidationError - Invalid provider API input.
 */
export class ProviderValidationError extends Schema.TaggedError<ProviderValidationError>()(
  "ProviderValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider validation failed in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderUnsupportedError - Requested provider is not implemented.
 */
export class ProviderUnsupportedError extends Schema.TaggedError<ProviderUnsupportedError>()(
  "ProviderUnsupportedError",
  {
    provider: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider '${this.provider}' is not implemented`;
  }
}

/**
 * ProviderInstanceNotFoundError - Lookup against the instance registry failed.
 *
 * Distinct from `ProviderUnsupportedError`: the driver is registered, but no
 * instance with the requested id has been bootstrapped — typically because
 * the persisted instance id refers to an instance the user removed from
 * settings, or because routing is asked for an instance before the registry
 * has finished its first reload.
 */
export class ProviderInstanceNotFoundError extends Schema.TaggedError<ProviderInstanceNotFoundError>()(
  "ProviderInstanceNotFoundError",
  {
    instanceId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `No provider instance bound to id '${this.instanceId}'`;
  }
}

/**
 * ProviderDriverError - A driver `create` call failed before producing an
 * instance. Surfaced to the registry, which marks the offending entry as
 * an "unavailable" shadow snapshot rather than crashing the server.
 */
export class ProviderDriverError extends Schema.TaggedError<ProviderDriverError>()(
  "ProviderDriverError",
  {
    driver: Schema.String,
    instanceId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider driver '${this.driver}' failed to create instance '${this.instanceId}': ${this.detail}`;
  }
}

/**
 * ProviderSessionNotFoundError - Provider-facing session not found.
 */
export class ProviderSessionNotFoundError extends Schema.TaggedError<ProviderSessionNotFoundError>()(
  "ProviderSessionNotFoundError",
  {
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unknown provider thread: ${this.threadId}`;
  }
}

/**
 * ProviderSessionDirectoryPersistenceError - Session directory persistence failure.
 */
export class ProviderSessionDirectoryPersistenceError extends Schema.TaggedError<ProviderSessionDirectoryPersistenceError>()(
  "ProviderSessionDirectoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider session directory persistence error in ${this.operation}: ${this.detail}`;
  }
}

/**
 * ProviderContinuationRevokedError - A restart-continuation token was checked
 * at a fenced point (entry, adapter-effect admission, or a conditional binding
 * write) and was no longer live, or the routed thread/instance no longer
 * matched the token. The turn attempt is rejected; late writes are skipped.
 */
export class ProviderContinuationRevokedError extends Schema.TaggedError<ProviderContinuationRevokedError>()(
  "ProviderContinuationRevokedError",
  {
    operation: Schema.String,
    threadId: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Restart continuation rejected in ${this.operation} for thread '${this.threadId}': ${this.issue}`;
  }
}

/**
 * ProviderMemoryHandoffRefusedError - A send carrying a committed memory
 * dispatch was refused at a fenced handoff point: the late memory recheck
 * declined (`check-refused`), or the routing binding, instance, or registry
 * adapter observed at handoff no longer matches what the attempt was admitted
 * for (`binding-changed`). Carries no foreign cause so details of an
 * underlying store or registry failure never cross the handoff boundary.
 */
export class ProviderMemoryHandoffRefusedError extends Schema.TaggedError<ProviderMemoryHandoffRefusedError>()(
  "ProviderMemoryHandoffRefusedError",
  {
    operation: Schema.String,
    threadId: Schema.String,
    reason: Schema.Literals(["binding-changed", "check-refused"]),
  },
) {
  override get message(): string {
    return `Memory handoff refused in ${this.operation} for thread '${this.threadId}': ${this.reason}`;
  }
}

/**
 * ProviderSkillTrialHandoffRefusedError - A send carrying a skill-trial
 * delivery claim was refused: a memory and a skill-trial handoff arrived on
 * the same send (`conflicting-handoff`), the asynchronous claim declined or
 * its receipt was lost (`claim-refused`), or the routed instance, binding, or
 * registry adapter re-observed after a committed claim no longer matches the
 * frozen route (`binding-changed`). Carries no foreign cause so details of an
 * underlying claim or registry failure never cross the handoff boundary.
 */
export class ProviderSkillTrialHandoffRefusedError extends Schema.TaggedError<ProviderSkillTrialHandoffRefusedError>()(
  "ProviderSkillTrialHandoffRefusedError",
  {
    operation: Schema.String,
    threadId: Schema.String,
    reason: Schema.Literals(["binding-changed", "claim-refused", "conflicting-handoff"]),
  },
) {
  override get message(): string {
    return `Skill trial handoff refused in ${this.operation} for thread '${this.threadId}': ${this.reason}`;
  }
}

export type ProviderAdapterError =
  | ProviderAdapterValidationError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterSessionClosedError
  | ProviderAdapterRequestError
  | ProviderAdapterProcessError;

export type ProviderServiceError =
  | ProviderValidationError
  | ProviderUnsupportedError
  | ProviderWorkspaceMissingError
  | ProviderInstanceNotFoundError
  | ProviderSessionNotFoundError
  | ProviderSessionDirectoryPersistenceError
  | ProviderContinuationRevokedError
  | ProviderMemoryHandoffRefusedError
  | ProviderSkillTrialHandoffRefusedError
  | ProviderAdapterError
  | CheckpointServiceError;
