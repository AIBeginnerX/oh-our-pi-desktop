import {
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderTurnStartResult,
  type ProviderUploadFeedbackInput,
  type ProviderUploadFeedbackResult,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderAdapterRequestError, type ProviderAdapterError } from "../provider/Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderMemoryAdmissionSupport,
  ProviderSendTurnAdmission,
} from "../provider/Services/ProviderAdapter.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";

// Deterministic terminal provider adapter + instance registry for the L2
// harness: the full production ProviderRuntimeLayerLive runs, and only this
// adapter stands in for the real provider CLI. `admission.admit` is evaluated
// synchronously as the publish step's first action — immediately before the
// publication counters move — so a refused verdict queues no prompt and
// publishes nothing, while an admitted send is fully counted and captured.

const L2_FAKE_DRIVER = ProviderDriverKind.make("codex");
const L2_TIMESTAMP = "2026-01-01T00:00:00.000Z";

export interface L2FakeAdapterHandles {
  readonly counts: {
    readonly startSession: number;
    readonly sendTurn: number;
    readonly stopSession: number;
  };
  readonly sendInputs: ReadonlyArray<ProviderSendTurnInput>;
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
}

export const makeL2FakeAdapter = (input?: { readonly turnId?: TurnId }): L2FakeAdapterHandles => {
  const counts = { startSession: 0, sendTurn: 0, stopSession: 0 };
  const sendInputs: ProviderSendTurnInput[] = [];
  const hasSessions = new Set<ThreadId>();
  const sessionRecords = new Map<ThreadId, ProviderSession>();
  const sessionIdentity = new Map<
    ThreadId,
    { generation: number; nativeSessionId: string | undefined }
  >();
  let nextSessionGeneration = 0;

  // Pure resumeCursor → native session id parse, mirroring the real adapter
  // support hook: only `{opaque: string}` cursors carry an id.
  const nativeSessionIdOf = (cursor: unknown): string | undefined =>
    typeof cursor === "object" &&
    cursor !== null &&
    "opaque" in cursor &&
    typeof (cursor as { readonly opaque?: unknown }).opaque === "string"
      ? (cursor as { readonly opaque: string }).opaque
      : undefined;

  const memoryAdmission: ProviderMemoryAdmissionSupport = {
    sessionGeneration: (threadId) => sessionIdentity.get(threadId)?.generation,
    nativeSessionId: (cursor) => nativeSessionIdOf(cursor),
  };

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: L2_FAKE_DRIVER,
    capabilities: {
      sessionModelSwitch: "in-session",
      promptlessTurnContinuation: true,
    },
    startSession: (startInput: ProviderSessionStartInput) =>
      Effect.sync(() => {
        counts.startSession += 1;
        hasSessions.add(startInput.threadId);
        const session: ProviderSession = {
          provider: L2_FAKE_DRIVER,
          providerInstanceId: startInput.providerInstanceId,
          status: "ready",
          runtimeMode: startInput.runtimeMode,
          threadId: startInput.threadId,
          resumeCursor: { opaque: `resume-${counts.startSession}` },
          createdAt: L2_TIMESTAMP,
          updatedAt: L2_TIMESTAMP,
        };
        sessionRecords.set(session.threadId, session);
        sessionIdentity.set(session.threadId, {
          generation: ++nextSessionGeneration,
          nativeSessionId: nativeSessionIdOf(session.resumeCursor),
        });
        return session;
      }),
    sendTurn: (sendInput: ProviderSendTurnInput, admission?: ProviderSendTurnAdmission) =>
      Effect.gen(function* () {
        // A refused admission queues no prompt, so the send counter stays
        // where it was; only an admitted publish moves it.
        if (admission !== undefined) {
          const identity = sessionIdentity.get(sendInput.threadId);
          if (
            !admission.admit({
              sessionGeneration: identity?.generation ?? 0,
              nativeSessionId: identity?.nativeSessionId,
            })
          ) {
            return yield* new ProviderAdapterRequestError({
              provider: L2_FAKE_DRIVER,
              method: "thread/send",
              detail: "adapter admission refused",
            });
          }
        }
        counts.sendTurn += 1;
        sendInputs.push(sendInput);
        const turnId = input?.turnId ?? TurnId.make(`l2-${String(sendInput.threadId)}`);
        const result: ProviderTurnStartResult = {
          threadId: sendInput.threadId,
          turnId,
          resumeCursor: { opaque: `cursor-${String(turnId)}` },
        };
        return result;
      }),
    memoryAdmission,
    interruptTurn: () => Effect.die("unused interruptTurn"),
    respondToRequest: () => Effect.die("unused respondToRequest"),
    respondToUserInput: () => Effect.die("unused respondToUserInput"),
    stopSession: (threadId: ThreadId) =>
      Effect.sync(() => {
        counts.stopSession += 1;
        hasSessions.delete(threadId);
        sessionRecords.delete(threadId);
        sessionIdentity.delete(threadId);
      }),
    listSessions: () => Effect.sync(() => Array.from(sessionRecords.values())),
    hasSession: (threadId: ThreadId) => Effect.succeed(hasSessions.has(threadId)),
    readThread: (threadId: ThreadId) =>
      Effect.succeed({ threadId, turns: [] as ReadonlyArray<{ id: TurnId; items: [] }> }),
    rollbackThread: (threadId: ThreadId) =>
      Effect.succeed({ threadId, turns: [] as ReadonlyArray<never> }),
    stopAll: () =>
      Effect.sync(() => {
        hasSessions.clear();
        sessionRecords.clear();
        sessionIdentity.clear();
      }),
    uploadFeedback: (feedbackInput: ProviderUploadFeedbackInput) =>
      Effect.succeed({
        feedbackId: `feedback-${String(feedbackInput.threadId)}`,
      } as ProviderUploadFeedbackResult),
    get streamEvents() {
      return Stream.empty;
    },
  };

  return { counts, sendInputs, adapter };
};

const unusedTextGeneration: TextGeneration["Service"] = {
  generateCommitMessage: () => Effect.die("unused generateCommitMessage"),
  generatePrContent: () => Effect.die("unused generatePrContent"),
  generateBranchName: () => Effect.die("unused generateBranchName"),
  generateThreadTitle: () => Effect.die("unused generateThreadTitle"),
};

const makeL2FakeInstance = (
  requested: ProviderInstanceId,
  adapter: ProviderAdapterShape<ProviderAdapterError>,
): ProviderInstance => ({
  instanceId: requested,
  driverKind: adapter.provider,
  continuationIdentity: {
    driverKind: adapter.provider,
    continuationKey: `${adapter.provider}:l2-fake-instance`,
  },
  displayName: undefined,
  enabled: true,
  snapshot: {
    resolveMaintenance: () => Effect.die("unused resolveMaintenance"),
    getSnapshot: Effect.die("unused getSnapshot"),
    refresh: Effect.die("unused refresh"),
    streamChanges: Stream.empty,
    applyUsageLimits: () => Effect.die("unused applyUsageLimits"),
  },
  adapter,
  textGeneration: unusedTextGeneration,
});

// Every requested instance id resolves to the same instance carrying the given
// adapter (the codex fake unless a test supplies another, listed as
// `instanceId`), so the harness's model selection and the server's routed
// instance always land on the one terminal adapter. `getInstanceUnsafe` is the
// synchronous ownership re-check the registry facade answers at the publish point.
export const makeL2FakeInstanceRegistryLayer = (
  adapter: ProviderAdapterShape<ProviderAdapterError>,
  instanceId = ProviderInstanceId.make("codex"),
) =>
  Layer.succeed(ProviderInstanceRegistry, {
    getInstance: (requested) => Effect.succeed(makeL2FakeInstance(requested, adapter)),
    getInstanceUnsafe: (requested) => makeL2FakeInstance(requested, adapter),
    listInstances: Effect.succeed([makeL2FakeInstance(instanceId, adapter)]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (changes) =>
      PubSub.subscribe(changes),
    ),
  });
