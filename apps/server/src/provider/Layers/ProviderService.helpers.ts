import {
  MessageId,
  ModelSelection,
  NonNegativeInt,
  ProviderSendTurnInput,
  type SnapShotAccessibility,
  type SnapShotAccessibilityNode,
  ThreadId,
  TurnId,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import {
  ProviderContinuationRevokedError,
  ProviderMemoryHandoffRefusedError,
  ProviderSkillTrialHandoffRefusedError,
  type ProviderAdapterError,
  ProviderSessionDirectoryPersistenceError,
  ProviderValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import * as RestartContinuations from "../../restartContinuations.ts";

export const isModelSelection = Schema.is(ModelSelection);

export const encodePromptJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface SnapShotPromptAccessibilityNode {
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly bounds?: NonNullable<SnapShotAccessibilityNode["bounds"]>;
  readonly state?: SnapShotAccessibilityNode["state"];
  readonly actions?: ReadonlyArray<string>;
  readonly children?: ReadonlyArray<SnapShotPromptAccessibilityNode>;
}

export type SnapShotPromptAccessibility =
  | {
      readonly format: "flat-text";
      readonly text: string;
      readonly truncated?: true;
    }
  | {
      readonly format: "element-tree";
      readonly coordinateSpace?: "captured-image";
      readonly imageSize?: { readonly width: number; readonly height: number };
      readonly truncated?: true;
      readonly root: SnapShotPromptAccessibilityNode;
    };

export function normalizedAccessibilityLabel(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

export function isRedundantWindowButtonDescription(node: SnapShotAccessibilityNode): boolean {
  if (node.role !== "button" || !node.name || !node.description) return false;
  return (
    normalizedAccessibilityLabel(node.description) ===
    `${normalizedAccessibilityLabel(node.name)} the window`
  );
}

export function isFullImageBounds(
  bounds: NonNullable<SnapShotAccessibilityNode["bounds"]>,
  imageSize: { readonly width: number; readonly height: number },
): boolean {
  return (
    bounds.x === 0 &&
    bounds.y === 0 &&
    bounds.width === imageSize.width &&
    bounds.height === imageSize.height
  );
}

export function compactAccessibilityNodeForPrompt(
  node: SnapShotAccessibilityNode,
  imageSize: { readonly width: number; readonly height: number },
  options: { readonly isRoot: boolean; readonly parentName?: string },
): ReadonlyArray<SnapShotPromptAccessibilityNode> {
  const bounds =
    node.bounds && !(options.isRoot && isFullImageBounds(node.bounds, imageSize))
      ? node.bounds
      : undefined;
  const name = node.role !== "group" && node.name === options.parentName ? undefined : node.name;
  const description = isRedundantWindowButtonDescription(node) ? undefined : node.description;
  const actions = node.actions?.filter((action) => node.role !== "button" || action !== "press");
  const children = node.children.flatMap((child) =>
    compactAccessibilityNodeForPrompt(child, imageSize, {
      isRoot: false,
      ...(node.name
        ? { parentName: node.name }
        : options.parentName
          ? { parentName: options.parentName }
          : {}),
    }),
  );
  const compacted: SnapShotPromptAccessibilityNode = {
    role: node.role,
    ...(name ? { name } : {}),
    ...(node.value ? { value: node.value } : {}),
    ...(description ? { description } : {}),
    ...(bounds ? { bounds } : {}),
    ...(node.state ? { state: node.state } : {}),
    ...(actions && actions.length > 0 ? { actions } : {}),
    ...(children.length > 0 ? { children } : {}),
  };

  const hasMetadata = Boolean(
    compacted.name ||
    compacted.value ||
    compacted.description ||
    compacted.bounds ||
    compacted.state ||
    compacted.actions,
  );
  if (!options.isRoot && node.role === "group" && !hasMetadata) return children;
  if (
    !options.isRoot &&
    (node.role === "separator" || node.role === "tab_group") &&
    !hasMetadata &&
    children.length === 0
  ) {
    return [];
  }
  if (
    !options.isRoot &&
    node.role === "static_text" &&
    node.name === options.parentName &&
    !hasMetadata &&
    children.length === 0
  ) {
    return [];
  }
  return [compacted];
}

export function accessibilityNodeHasBounds(node: SnapShotPromptAccessibilityNode): boolean {
  return Boolean(node.bounds || node.children?.some(accessibilityNodeHasBounds));
}

export function compactAccessibilityForPrompt(
  accessibility: SnapShotAccessibility,
): SnapShotPromptAccessibility {
  if (accessibility.format === "flat-text") {
    return {
      format: "flat-text",
      text: accessibility.text,
      ...(accessibility.truncated ? { truncated: true } : {}),
    };
  }

  const root = compactAccessibilityNodeForPrompt(accessibility.root, accessibility.imageSize, {
    isRoot: true,
  })[0]!;
  const hasBounds = accessibilityNodeHasBounds(root);
  return {
    format: "element-tree",
    ...(hasBounds
      ? { coordinateSpace: accessibility.coordinateSpace, imageSize: accessibility.imageSize }
      : {}),
    ...(accessibility.truncated ? { truncated: true } : {}),
    root,
  };
}

/** How long a manual context compaction may run before ProviderService gives up on it. */
export const COMPACTION_COMPLETION_TIMEOUT = "10 minutes";

export interface PendingCompaction {
  readonly completion: Deferred.Deferred<string>;
  readonly native: boolean;
  readonly providerInstanceId: ProviderInstanceId;
  readonly requestId: MessageId | undefined;
  readonly earlyEvents: ProviderRuntimeEvent[];
  compactedEventObserved: boolean;
  expectedTurnId: TurnId | undefined;
}

export interface TurnAnalyticsMetadata {
  readonly requestId: number;
  readonly provider: ProviderDriverKind;
  readonly startedAtMs: number;
  readonly mixedModels: boolean;
  readonly subscriptionSharing?: boolean;
  readonly model?: string;
  readonly effort?: string;
  readonly interactionMode?: string;
  readonly runtimeMode?: string;
}

export interface ActiveTurnAnalytics {
  readonly metadata: TurnAnalyticsMetadata;
  readonly requestAssociated: boolean;
}

export interface DeferredTurnAnalyticsCompletion {
  readonly completionKey: string;
  readonly completedAtMs: number;
  readonly terminalProperties: Readonly<Record<string, unknown>>;
}

export interface TurnAnalyticsSessionState {
  readonly pendingByRequestId: Map<number, TurnAnalyticsMetadata>;
  readonly activeByTurnId: Map<string, ActiveTurnAnalytics>;
  readonly deferredCompletionsByTurnId: Map<string, DeferredTurnAnalyticsCompletion>;
}

export interface TurnAnalyticsState {
  readonly sessions: Map<string, TurnAnalyticsSessionState>;
  readonly completedKeys: Set<string>;
  readonly completedOrder: Array<string>;
}

export const MAX_COMPLETED_TURN_ANALYTICS_KEYS = 512;

export const MAX_ACTIVE_TURN_ANALYTICS_PER_SESSION = 8;

export function setActiveTurnAnalytics(
  session: TurnAnalyticsSessionState,
  turnId: string,
  active: ActiveTurnAnalytics,
): void {
  session.activeByTurnId.set(turnId, active);
  while (session.activeByTurnId.size > MAX_ACTIVE_TURN_ANALYTICS_PER_SESSION) {
    const oldestTurnId = session.activeByTurnId.keys().next().value;
    if (oldestTurnId === undefined) return;
    session.activeByTurnId.delete(oldestTurnId);
  }
}

export function turnAnalyticsSessionKey(
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
): string {
  return `${String(instanceId)}\u0000${String(threadId)}`;
}

export function turnAnalyticsCompletionKey(
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
  turnId: string,
): string {
  return `${turnAnalyticsSessionKey(instanceId, threadId)}\u0000${turnId}`;
}

export function turnEffort(
  modelSelection: ProviderSendTurnInput["modelSelection"],
): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
    getModelSelectionStringOptionValue(modelSelection, "effort")
  );
}

export type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

export const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

export function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export function toContinuationRevokedError(
  operation: string,
  threadId: ThreadId,
  issue: string,
): ProviderContinuationRevokedError {
  return new ProviderContinuationRevokedError({
    operation,
    threadId,
    issue,
  });
}

export const refuseHandoff = (
  threadId: ThreadId,
  reason: "binding-changed" | "check-refused",
): ProviderMemoryHandoffRefusedError =>
  new ProviderMemoryHandoffRefusedError({
    operation: "ProviderService.sendTurn",
    threadId,
    reason,
  });

export const refuseSkillTrial = (
  threadId: ThreadId,
  reason: "binding-changed" | "claim-refused" | "conflicting-handoff" | "trials-unsupported",
): ProviderSkillTrialHandoffRefusedError =>
  new ProviderSkillTrialHandoffRefusedError({
    operation: "ProviderService.sendTurn",
    threadId,
    reason,
  });

// Directory writes can fail with the memory-echo ledger's raw SqlError. At
// this facade only that Fail becomes a fixed, cause-free persistence error;
// directory domain errors, Die and Interrupt reasons pass through.
export const normalizeDirectoryWrite = <A>(
  effect: Effect.Effect<A, ProviderSessionDirectory.ProviderSessionDirectoryWriteError>,
): Effect.Effect<A, ProviderValidationError | ProviderSessionDirectoryPersistenceError> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.failCause(
        Cause.map(cause, (error) =>
          error._tag === "SqlError"
            ? new ProviderSessionDirectoryPersistenceError({
                operation: "ProviderService.writeBinding",
                detail: "Failed to persist provider session binding.",
              })
            : error,
        ),
      ),
    ),
  );

// Decoded JSON columns carry no identity; comparing their serialized shape is
// the bounded observed-field check used by the memory recovery write.
export const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * ContinuationRun - Per-call fencing state for a restart-continuation send.
 *
 * `guard` is the single fence evaluated at every admission point and every
 * conditional binding write: token liveness (current identity plus all flags,
 * through `RestartContinuations.isLive`), the exact input thread, and the
 * actually-routed provider instance. `admitted` flips once a session-mutating
 * adapter effect has been entered, which is what licenses one best-effort
 * compensation stop if a later fenced point rejects.
 */
export interface ContinuationRun {
  readonly token: RestartContinuations.ContinuationToken;
  readonly guard: (instanceId: ProviderInstanceId) => boolean;
  /**
   * The first admitted adapter effect, bound once with `??=`. Compensation
   * stops this captured adapter only; a later registry swap does not retarget
   * it, and a replaced or retired token skips compensation entirely.
   */
  admitted:
    | {
        readonly instanceId: ProviderInstanceId;
        readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
      }
    | undefined;
}

export const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

export function toRuntimeStatus(
  session: ProviderSession,
): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

export function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly continueAfterServerUpdate?: TurnId;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.continueAfterServerUpdate !== undefined
      ? { continueAfterServerUpdate: extra.continueAfterServerUpdate }
      : {}),
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

export function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

export function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Stopped rows with no active turn are settled; shutdown leaves them untouched. */
export function isSettledBinding(
  binding: ProviderSessionDirectory.ProviderRuntimeBinding,
): boolean {
  if (binding.status !== "stopped") return false;
  const payload = binding.runtimePayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return true;
  return !("activeTurnId" in payload) || payload.activeTurnId == null;
}

export const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

export const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};
