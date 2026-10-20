import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const FAILED_AT = "2026-01-01T00:00:01.000Z";
const THREAD_ID = ThreadId.make("thread-turn-start-fail");
const PROJECT_ID = ProjectId.make("project-turn-start-fail");
const MESSAGE_ID = MessageId.make("message-turn-start-fail");
const OTHER_MESSAGE_ID = MessageId.make("message-other");
const SUMMARY = "Message not sent";
const DETAIL = "Project memory is not available for this thread.";
const ERROR_DETAIL = "Provider turn could not be started after the message was committed.";

type TurnStartFailCommand = Extract<OrchestrationCommand, { type: "thread.turn.start.fail" }>;
type TurnStartFailScan = {
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly complete: boolean;
};
type DecideResult = Effect.Success<ReturnType<typeof decideOrchestrationCommand>>;

function makeStartingSession(overrides: Partial<OrchestrationSession> = {}): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status: "starting",
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeReadModel(session: OrchestrationSession | null): OrchestrationReadModel {
  const thread: OrchestrationThread = {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session,
  };
  return {
    snapshotSequence: 100,
    projects: [],
    threads: [thread],
    updatedAt: NOW,
  };
}

const eventBase = (
  sequence: number,
  commandId = CommandId.make(`evt-${sequence}`),
): Pick<
  OrchestrationEvent,
  | "sequence"
  | "eventId"
  | "aggregateKind"
  | "aggregateId"
  | "occurredAt"
  | "commandId"
  | "causationEventId"
  | "correlationId"
  | "metadata"
> => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread",
  aggregateId: THREAD_ID,
  occurredAt: NOW,
  commandId,
  causationEventId: null,
  correlationId: commandId,
  metadata: {},
});

function turnStartRequestedEvent(
  sequence: number,
  messageId: MessageId = MESSAGE_ID,
): Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }> {
  return {
    ...eventBase(sequence),
    type: "thread.turn-start-requested",
    payload: {
      threadId: THREAD_ID,
      messageId,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: NOW,
    },
  };
}

function sessionSetStartingEvent(
  sequence: number,
): Extract<OrchestrationEvent, { type: "thread.session-set" }> {
  return {
    ...eventBase(sequence),
    type: "thread.session-set",
    payload: {
      threadId: THREAD_ID,
      session: makeStartingSession({ updatedAt: FAILED_AT }),
    },
  };
}

function metaUpdatedEvent(
  sequence: number,
): Extract<OrchestrationEvent, { type: "thread.meta-updated" }> {
  return {
    ...eventBase(sequence),
    type: "thread.meta-updated",
    payload: {
      threadId: THREAD_ID,
      title: "still starting",
      updatedAt: NOW,
    },
  };
}

function sessionStopRequestedEvent(
  sequence: number,
): Extract<OrchestrationEvent, { type: "thread.session-stop-requested" }> {
  return {
    ...eventBase(sequence),
    type: "thread.session-stop-requested",
    payload: {
      threadId: THREAD_ID,
      createdAt: NOW,
    },
  };
}

function turnInterruptRequestedEvent(
  sequence: number,
): Extract<OrchestrationEvent, { type: "thread.turn-interrupt-requested" }> {
  return {
    ...eventBase(sequence),
    type: "thread.turn-interrupt-requested",
    payload: {
      threadId: THREAD_ID,
      createdAt: NOW,
    },
  };
}

function threadCreatedEvent(
  sequence: number,
): Extract<OrchestrationEvent, { type: "thread.created" }> {
  return {
    ...eventBase(sequence),
    type: "thread.created",
    payload: {
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "recreated",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function messageSentEvent(
  sequence: number,
): Extract<OrchestrationEvent, { type: "thread.message-sent" }> {
  return {
    ...eventBase(sequence),
    type: "thread.message-sent",
    payload: {
      threadId: THREAD_ID,
      messageId: MESSAGE_ID,
      role: "user",
      text: "hello",
      attachments: [],
      turnId: null,
      streaming: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function makeFailCommand(overrides: Partial<TurnStartFailCommand> = {}): TurnStartFailCommand {
  return {
    type: "thread.turn.start.fail",
    commandId: CommandId.make("cmd-turn-start-fail"),
    threadId: THREAD_ID,
    messageId: MESSAGE_ID,
    requestSequence: 10,
    sessionSequence: 11,
    restoreStatus: "ready",
    activityId: EventId.make("activity-turn-start-fail"),
    summary: SUMMARY,
    detail: DETAIL,
    createdAt: NOW,
    failedAt: FAILED_AT,
    ...overrides,
  };
}

function plannedEvents(result: DecideResult) {
  return Array.isArray(result) ? result : [result];
}

function failureActivity(events: DecideResult) {
  const planned = plannedEvents(events);
  const appended = planned.find((event) => event.type === "thread.activity-appended");
  expect(appended).toBeDefined();
  return appended!.payload.activity;
}

function requestIdFromActivity(activity: OrchestrationThread["activities"][number]) {
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null || !("requestId" in payload)) {
    return undefined;
  }
  const requestId = payload.requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

function quietRestorableScan(T: number, S: number): TurnStartFailScan {
  return {
    events: [turnStartRequestedEvent(T), sessionSetStartingEvent(S)],
    complete: true,
  };
}

function decideTurnStartFail(input: {
  readonly command: TurnStartFailCommand;
  readonly readModel: OrchestrationReadModel;
  readonly turnStartFailScan: TurnStartFailScan;
}) {
  return decideOrchestrationCommand({
    command: input.command,
    readModel: input.readModel,
    turnStartFailScan: input.turnStartFailScan,
  });
}

it.layer(NodeServices.layer)("thread.turn.start.fail decider", (it) => {
  it.effect("D1 restores ready and links requestId when the incarnation is current", () =>
    Effect.gen(function* () {
      const T = 10;
      const S = 11;
      const result = yield* decideTurnStartFail({
        command: makeFailCommand({ requestSequence: T, sessionSequence: S }),
        readModel: makeReadModel(makeStartingSession()),
        turnStartFailScan: quietRestorableScan(T, S),
      });
      const events = plannedEvents(result);
      expect(events.map((event) => event.type)).toEqual([
        "thread.session-set",
        "thread.activity-appended",
      ]);
      const restored = events[0]!;
      expect(restored.payload).toMatchObject({
        threadId: THREAD_ID,
        session: {
          status: "ready",
          activeTurnId: null,
          lastError: null,
          updatedAt: FAILED_AT,
        },
      });
      const activity = failureActivity(result);
      expect(activity).toMatchObject({
        kind: "provider.turn.start.failed",
        tone: "error",
        summary: SUMMARY,
        turnId: null,
      });
      expect(activity.payload).toMatchObject({
        detail: DETAIL,
        requestId: String(MESSAGE_ID),
      });
    }),
  );

  it.effect("D2 error restore stores the fixed detail as lastError", () =>
    Effect.gen(function* () {
      const T = 10;
      const S = 11;
      const result = yield* decideTurnStartFail({
        command: makeFailCommand({
          requestSequence: T,
          sessionSequence: S,
          restoreStatus: "error",
          detail: ERROR_DETAIL,
        }),
        readModel: makeReadModel(makeStartingSession()),
        turnStartFailScan: quietRestorableScan(T, S),
      });
      const events = plannedEvents(result);
      expect(events[0]?.payload).toMatchObject({
        session: { status: "error", lastError: ERROR_DETAIL, updatedAt: FAILED_AT },
      });
      expect(requestIdFromActivity(failureActivity(result))).toBe(String(MESSAGE_ID));
    }),
  );

  it.effect("D3 with null session sequence emits only the failure activity", () =>
    Effect.gen(function* () {
      const T = 10;
      const result = yield* decideTurnStartFail({
        command: makeFailCommand({ requestSequence: T, sessionSequence: null }),
        readModel: makeReadModel(makeStartingSession()),
        turnStartFailScan: {
          events: [turnStartRequestedEvent(T)],
          complete: true,
        },
      });
      const events = plannedEvents(result);
      expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
      expect(requestIdFromActivity(failureActivity(result))).toBe(String(MESSAGE_ID));
    }),
  );

  it.effect("D4 refuses restore when an event follows the session-set sequence", () =>
    Effect.gen(function* () {
      const T = 10;
      const S = 11;
      const result = yield* decideTurnStartFail({
        command: makeFailCommand({ requestSequence: T, sessionSequence: S }),
        readModel: makeReadModel(makeStartingSession()),
        turnStartFailScan: {
          events: [turnStartRequestedEvent(T), sessionSetStartingEvent(S), metaUpdatedEvent(12)],
          complete: true,
        },
      });
      const events = plannedEvents(result);
      expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
      expect(requestIdFromActivity(failureActivity(result))).toBe(String(MESSAGE_ID));
    }),
  );

  it.effect.each([
    {
      id: "D5-other-message",
      later: [turnStartRequestedEvent(11, OTHER_MESSAGE_ID)],
    },
    {
      id: "D5-stop",
      later: [sessionStopRequestedEvent(11)],
    },
    {
      id: "D5-interrupt",
      later: [turnInterruptRequestedEvent(11)],
    },
  ])("$id blocks restore but keeps requestId", ({ later }) =>
    Effect.gen(function* () {
      const T = 10;
      const S = 12;
      const result = yield* decideTurnStartFail({
        command: makeFailCommand({ requestSequence: T, sessionSequence: S }),
        readModel: makeReadModel(makeStartingSession()),
        turnStartFailScan: {
          events: [turnStartRequestedEvent(T), ...later, sessionSetStartingEvent(S)],
          complete: true,
        },
      });
      const events = plannedEvents(result);
      expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
      expect(requestIdFromActivity(failureActivity(result))).toBe(String(MESSAGE_ID));
    }),
  );

  it.effect("D5-prime treats thread.created in the scan tail as a reissue without requestId", () =>
    Effect.gen(function* () {
      const T = 10;
      const S = 12;
      const result = yield* decideTurnStartFail({
        command: makeFailCommand({ requestSequence: T, sessionSequence: S }),
        readModel: makeReadModel(makeStartingSession()),
        turnStartFailScan: {
          events: [turnStartRequestedEvent(T), threadCreatedEvent(11), sessionSetStartingEvent(S)],
          complete: true,
        },
      });
      const events = plannedEvents(result);
      expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
      expect(requestIdFromActivity(failureActivity(result))).toBeUndefined();
    }),
  );

  it.effect("D6 suppresses requestId when the same messageId was reissued", () =>
    Effect.gen(function* () {
      const T = 10;
      const S = 12;
      const result = yield* decideTurnStartFail({
        command: makeFailCommand({ requestSequence: T, sessionSequence: S }),
        readModel: makeReadModel(makeStartingSession()),
        turnStartFailScan: {
          events: [
            turnStartRequestedEvent(T),
            turnStartRequestedEvent(11, MESSAGE_ID),
            sessionSetStartingEvent(S),
          ],
          complete: true,
        },
      });
      const events = plannedEvents(result);
      expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
      expect(requestIdFromActivity(failureActivity(result))).toBeUndefined();
    }),
  );

  it.effect.each([
    {
      id: "D7-wrong-first-sequence",
      scan: {
        events: [turnStartRequestedEvent(9), sessionSetStartingEvent(11)],
        complete: true,
      },
      requestSequence: 10,
      sessionSequence: 11,
      linkedRequestId: false,
    },
    {
      id: "D7-wrong-first-type",
      scan: {
        events: [messageSentEvent(10), sessionSetStartingEvent(11)],
        complete: true,
      },
      requestSequence: 10,
      sessionSequence: 11,
      linkedRequestId: false,
    },
    {
      id: "D7-wrong-message-id",
      scan: quietRestorableScan(10, 11),
      requestSequence: 10,
      sessionSequence: 11,
      messageId: OTHER_MESSAGE_ID,
      linkedRequestId: false,
    },
    {
      id: "D7-missing-session-event",
      scan: { events: [turnStartRequestedEvent(10)], complete: true },
      requestSequence: 10,
      sessionSequence: 11,
      linkedRequestId: true,
    },
    {
      id: "D7-session-not-session-set",
      scan: {
        events: [turnStartRequestedEvent(10), metaUpdatedEvent(11)],
        complete: true,
      },
      requestSequence: 10,
      sessionSequence: 11,
      linkedRequestId: true,
    },
    {
      id: "D7-session-not-after-request",
      scan: { events: [turnStartRequestedEvent(10)], complete: true },
      requestSequence: 10,
      sessionSequence: 10,
      linkedRequestId: true,
    },
    {
      id: "D7-stale-T",
      scan: {
        events: [turnStartRequestedEvent(10), sessionSetStartingEvent(11)],
        complete: true,
      },
      requestSequence: 9,
      sessionSequence: 11,
      linkedRequestId: false,
    },
  ])(
    "$id keeps activity-only output and links requestId only when T is authentic",
    ({ scan, requestSequence, sessionSequence, messageId, linkedRequestId }) =>
      Effect.gen(function* () {
        const commandMessageId = messageId ?? MESSAGE_ID;
        const result = yield* decideTurnStartFail({
          command: makeFailCommand({
            requestSequence,
            sessionSequence,
            messageId: commandMessageId,
          }),
          readModel: makeReadModel(makeStartingSession()),
          turnStartFailScan: scan,
        });
        const events = plannedEvents(result);
        expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
        const linkedId = requestIdFromActivity(failureActivity(result));
        if (linkedRequestId) {
          expect(linkedId).toBe(String(commandMessageId));
        } else {
          expect(linkedId).toBeUndefined();
        }
      }),
  );

  it.effect("D8 treats an incomplete scan as diagnostic-only without requestId", () =>
    Effect.gen(function* () {
      const T = 10;
      const S = 11;
      const result = yield* decideTurnStartFail({
        command: makeFailCommand({ requestSequence: T, sessionSequence: S }),
        readModel: makeReadModel(makeStartingSession()),
        turnStartFailScan: { events: quietRestorableScan(T, S).events, complete: false },
      });
      const events = plannedEvents(result);
      expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
      expect(requestIdFromActivity(failureActivity(result))).toBeUndefined();
    }),
  );

  it.effect.each([
    { id: "D9-null-session", session: null },
    { id: "D9-not-starting", session: makeStartingSession({ status: "ready" }) },
    { id: "D9-active-turn", session: makeStartingSession({ activeTurnId: TurnId.make("turn-1") }) },
  ])("$id blocks restore but keeps requestId", ({ session }) =>
    Effect.gen(function* () {
      const T = 10;
      const S = 11;
      const result = yield* decideTurnStartFail({
        command: makeFailCommand({ requestSequence: T, sessionSequence: S }),
        readModel: makeReadModel(session),
        turnStartFailScan: quietRestorableScan(T, S),
      });
      const events = plannedEvents(result);
      expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
      expect(requestIdFromActivity(failureActivity(result))).toBe(String(MESSAGE_ID));
    }),
  );
});
