import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  type ComposerContextRecord,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-08-24T10:00:00.000Z";
const projectId = ProjectId.make("project-memory");
const threadId = ThreadId.make("thread-memory");
const messageId = MessageId.make("message-memory");
const contextId = "mem_1" as ComposerContextRecord["contextId"];

const readModelWithThread = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(createdAt), {
    sequence: 1,
    eventId: EventId.make("event-project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: createdAt,
    commandId: CommandId.make("command-project-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-project-created"),
    metadata: {},
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("event-thread-created"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: createdAt,
    commandId: CommandId.make("command-thread-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-thread-created"),
    metadata: {},
    payload: {
      threadId,
      projectId,
      title: "Memory thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    },
  });
});

const memoryRecord: ComposerContextRecord = {
  version: 1,
  contextId,
  kind: "memory",
  label: "SECRET-L",
  payload: {
    memoryId: "memory-1",
    selectedVersion: 3,
    title: "SECRET-T",
    body: "SECRET-B",
  },
};

const memoryLinkText = "Use [SECRET-L](t3-context://v1/memory/mem_1) for this.";

const memoryContext = { version: 1 as const, records: [memoryRecord] };

const appendCommand = {
  type: "thread.message.user.append" as const,
  commandId: CommandId.make("command-append-memory"),
  threadId,
  message: {
    messageId,
    text: memoryLinkText,
    attachments: [],
    context: memoryContext,
  },
  createdAt,
};

const turnStartCommand = {
  type: "thread.turn.start" as const,
  commandId: CommandId.make("command-turn-start-memory"),
  threadId,
  message: {
    messageId,
    role: "user" as const,
    text: memoryLinkText,
    attachments: [],
    context: memoryContext,
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdAt,
};

const messageSentPayload = (planned: unknown) => {
  const events = Array.isArray(planned) ? planned : [planned];
  const messageSent = events.find(
    (event) => (event as { type?: string }).type === "thread.message-sent",
  );
  return { events, payload: (messageSent as { payload?: unknown } | undefined)?.payload };
};

it.layer(NodeServices.layer)("project memory references", (it) => {
  it.effect("canonicalizes text, label and payload on thread.turn.start", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithThread;
      const planned = yield* decideOrchestrationCommand({
        command: turnStartCommand,
        readModel,
      });
      const { events, payload } = messageSentPayload(planned);
      expect(events.map((event) => (event as { type: string }).type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      expect(JSON.stringify(payload)).not.toContain("SECRET-");
      expect(payload).toMatchObject({
        text: "Use [Project memory](t3-context://v1/memory/mem_1) for this.",
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId,
              kind: "memory",
              label: "Project memory",
              payload: { memoryId: "memory-1", selectedVersion: 3 },
            },
          ],
        },
      });
    }),
  );

  it.effect("canonicalizes text, label and payload on thread.message.user.append", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithThread;
      const planned = yield* decideOrchestrationCommand({
        command: appendCommand,
        readModel,
      });
      const { payload } = messageSentPayload(planned);
      expect(JSON.stringify(payload)).not.toContain("SECRET-");
      expect(payload).toMatchObject({
        text: "Use [Project memory](t3-context://v1/memory/mem_1) for this.",
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId,
              kind: "memory",
              label: "Project memory",
              payload: { memoryId: "memory-1", selectedVersion: 3 },
            },
          ],
        },
      });
    }),
  );

  const badCases: ReadonlyArray<readonly [string, ComposerContextRecord[]]> = [
    ["a non-string memoryId", [{ ...memoryRecord, payload: { memoryId: 7, selectedVersion: 1 } }]],
    ["a missing memoryId", [{ ...memoryRecord, payload: { selectedVersion: 1 } }]],
    [
      "a non-positive selectedVersion",
      [{ ...memoryRecord, payload: { memoryId: "memory-1", selectedVersion: 0 } }],
    ],
    [
      "a memory link whose record disagrees on kind",
      [
        {
          version: 1,
          contextId,
          kind: "file",
          label: "SECRET-F",
          attachmentId: "att_1",
          name: "SECRET-F",
          mimeType: "text/plain",
          sizeBytes: 1,
        },
      ],
    ],
  ];
  for (const [name, records] of badCases) {
    it.effect(`rejects ${name} with the fixed detail and emits no events`, () =>
      Effect.gen(function* () {
        const readModel = yield* readModelWithThread;
        const command = {
          ...turnStartCommand,
          message: { ...turnStartCommand.message, context: { version: 1 as const, records } },
        };
        const error = yield* Effect.flip(decideOrchestrationCommand({ command, readModel }));
        expect(error).toMatchObject({
          _tag: "OrchestrationCommandInvariantError",
          detail: "Project memory reference is invalid.",
        });
        expect(JSON.stringify(error)).not.toContain("SECRET-");
      }),
    );
  }

  it.effect("keeps the reuse branch untouched: no rewrite, no rejection", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithThread;
      const appended = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.user.append" as const,
          commandId: CommandId.make("command-append-plain"),
          threadId,
          message: { messageId, text: "Plain", attachments: [] },
          createdAt,
        },
        readModel,
      });
      const appendedEvent = Array.isArray(appended) ? appended[0]! : appended;
      const withMessage = yield* projectEvent(readModel, { ...appendedEvent, sequence: 3 });

      // New malformed memory data on the command is ignored: the persisted
      // row wins and the turn references it without re-validation.
      const reused = {
        ...turnStartCommand,
        message: {
          ...turnStartCommand.message,
          text: "Use [SECRET-L](t3-context://v1/file/mem_1)",
          context: {
            version: 1 as const,
            records: [
              {
                ...memoryRecord,
                payload: { memoryId: null, selectedVersion: "x" },
              } as ComposerContextRecord,
            ],
          },
        },
      };
      const planned = yield* decideOrchestrationCommand({
        command: reused,
        readModel: withMessage,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => (event as { type: string }).type)).toEqual([
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("leaves ordinary messages and nonmemory records untouched", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithThread;
      const terminalRecord: ComposerContextRecord = {
        version: 1,
        contextId: "ctx_t" as ComposerContextRecord["contextId"],
        kind: "terminal",
        label: "build",
        terminalId: "term-1",
        terminalLabel: "build",
        lineStart: 1,
        lineEnd: 2,
        text: "one\ntwo",
      };
      const text = "See [build](t3-context://v1/terminal/ctx_t)";
      const planned = yield* decideOrchestrationCommand({
        command: {
          ...turnStartCommand,
          message: {
            ...turnStartCommand.message,
            text,
            context: { version: 1 as const, records: [terminalRecord] },
          },
        },
        readModel,
      });
      const { payload } = messageSentPayload(planned);
      expect(payload).toMatchObject({ text, context: { records: [terminalRecord] } });
    }),
  );
});
