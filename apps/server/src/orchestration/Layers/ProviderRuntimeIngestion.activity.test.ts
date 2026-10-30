import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities task progress", () => {
  it("persists usage independently from replaceable activity", () => {
    const taskId = RuntimeTaskId.make("agent-1");
    const usageOnly = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-usage"),
      payload: {
        taskId,
        description: "Agent one",
        typedUsage: { totalTokens: 73_700_000 },
      },
    } satisfies ProviderRuntimeEvent;
    const command = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-command"),
      payload: {
        taskId,
        description: "Agent one",
        summary: "Running tests",
        lastToolName: "exec_command",
      },
    } satisfies ProviderRuntimeEvent;

    const usageActivities = runtimeEventToActivities(usageOnly);
    const commandActivities = runtimeEventToActivities(command);

    expect(usageActivities.map((activity) => activity.id)).toEqual(["task-usage:thread-1:agent-1"]);
    expect(commandActivities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-1",
    ]);
    const usagePayload = usageActivities[0]?.payload as Record<string, unknown> | undefined;
    expect(usagePayload?.typedUsage).toEqual({ totalTokens: 73_700_000 });
    expect(usagePayload?.usageSnapshot).toBe(true);
  });

  it("splits combined progress and usage into their independent snapshots", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-combined"),
      payload: {
        taskId: RuntimeTaskId.make("agent-2"),
        description: "Agent two",
        summary: "Inspecting the panel",
        typedUsage: { totalTokens: 4_200, toolUses: 7 },
        status: "running",
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const progressPayload = activities[0]?.payload as Record<string, unknown>;
    const usagePayload = activities[1]?.payload as Record<string, unknown>;

    expect(activities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-2",
      "task-usage:thread-1:agent-2",
    ]);
    expect(progressPayload.summary).toBe("Inspecting the panel");
    expect(progressPayload.status).toBe("running");
    expect(progressPayload).not.toHaveProperty("typedUsage");
    expect(usagePayload.typedUsage).toEqual({ totalTokens: 4_200, toolUses: 7 });
    expect(usagePayload.usageSnapshot).toBe(true);
    expect(usagePayload).not.toHaveProperty("status");
  });
});
describe("runtimeEventToActivities tool streaming persistence", () => {
  const accumulatedStdout = [
    "first line of output",
    ...Array.from({ length: 500 }, (_, index) => `Capturing frame ${index}/9028`),
  ].join("\n");
  const streamingData = {
    toolCallId: "tool-call-1",
    kind: "execute",
    command: "blender --render",
    rawOutput: { stdout: accumulatedStdout },
    content: [{ type: "content", content: { type: "text", text: accumulatedStdout } }],
  };

  it("persists tool.updated with the wire projection of data, not the accumulated stream", () => {
    const event = {
      ...base,
      type: "item.updated",
      eventId: EventId.make("evt-tool-streaming-updated"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Render",
        detail: accumulatedStdout,
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(payload.status).toBe("inProgress");
    expect(data.toolCallId).toBe("tool-call-1");
    expect(data.command).toBe("blender --render");
    expect(data.rawOutput).toEqual({ content: "first line of output" });
    expect(data.content).toBeUndefined();
    expect(JSON.stringify(data).length).toBeLessThan(1_000);
  });

  it("persists tool.completed with the wire projection, so a large output is stored as a preview", () => {
    const event = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-tool-streaming-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Render",
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(payload.status).toBe("completed");
    expect(data.toolCallId).toBe("tool-call-1");
    expect(data.command).toBe("blender --render");
    expect(data.rawOutput).toEqual({ content: "first line of output" });
    expect(data.content).toBeUndefined();
    expect(JSON.stringify(data).length).toBeLessThan(1_000);
  });

  it("keeps the command of a Codex item and reduces its aggregated output to a preview", () => {
    const event = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-tool-codex-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        data: { item: { command: "bun test", aggregatedOutput: accumulatedStdout } },
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);
    const payload = activity?.payload as Record<string, unknown>;
    const data = payload.data as { item: Record<string, unknown> };

    expect(data.item.command).toBe("bun test");
    expect(data.item.aggregatedOutput).toBe("first line of output");
    expect(JSON.stringify(data).length).toBeLessThan(1_000);
  });

  it("persists tool.started with the wire projection of data", () => {
    const event = {
      ...base,
      type: "item.started",
      eventId: EventId.make("evt-tool-streaming-started"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Render",
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);
    const payload = activity?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;

    expect(activity?.kind).toBe("tool.started");
    expect(data.command).toBe("blender --render");
    expect(data.rawOutput).toEqual({ content: "first line of output" });
    expect(JSON.stringify(data).length).toBeLessThan(1_000);
  });
});

describe("runtimeEventToActivities owned usage observations", () => {
  const completeUsage = {
    usageScope: "main_agent",
    usageStatus: "complete",
    inputTokens: 1200,
    outputTokens: 340,
    hasSubagents: false,
  } as const;

  it("appends a main-turn observation for a token-bearing turn.completed", () => {
    const event = {
      ...base,
      type: "turn.completed",
      eventId: EventId.make("evt-turn-1"),
      turnId: TurnId.make("turn-1"),
      providerInstanceId: ProviderInstanceId.make("codex_personal"),
      raw: {
        source: "codex.app-server.notification",
        method: "turn/completed",
        payload: {
          threadId: "codex-thread-9",
          turn: { id: "turn-1", status: "completed" },
        },
      },
      payload: { state: "completed", tokenUsage: completeUsage },
    } satisfies ProviderRuntimeEvent;
    const usageless = {
      ...base,
      type: "turn.completed",
      eventId: EventId.make("evt-turn-2"),
      turnId: TurnId.make("turn-2"),
      payload: { state: "completed" },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(runtimeEventToActivities(usageless)).toEqual([]);
    expect(activities).toHaveLength(1);
    const activity = activities[0]!;
    expect(activity.id).toBe("owned-usage:thread-1:evt-turn-1");
    expect(activity.kind).toBe("owned-usage");
    expect(activity.turnId).toBe("turn-1");
    expect(activity.payload).toEqual({
      v: 1,
      scope: "main-turn",
      source: {
        driver: "codex",
        instanceId: "codex_personal",
        turnId: "turn-1",
        runtimeEventId: "evt-turn-1",
        nativeConversationId: "codex-thread-9",
      },
      terminal: "completed",
      usage: completeUsage,
    });
  });

  it("keeps the cost a provider reported and adds none when it reported none", () => {
    const completed = (eventId: string, payload: Record<string, unknown>) =>
      ({
        ...base,
        type: "turn.completed",
        eventId: EventId.make(eventId),
        turnId: TurnId.make("turn-1"),
        payload: { state: "completed", tokenUsage: completeUsage, ...payload },
      }) as ProviderRuntimeEvent;

    const [priced] = runtimeEventToActivities(completed("evt-priced", { totalCostUsd: 0.42 }));
    const [unpriced] = runtimeEventToActivities(completed("evt-unpriced", {}));

    expect(priced?.payload).toMatchObject({ costUsd: 0.42 });
    expect(unpriced?.payload).not.toHaveProperty("costUsd");
  });

  it("records an aborted terminal without a native conversation id", () => {
    const event = {
      ...base,
      type: "turn.aborted",
      eventId: EventId.make("evt-abort-1"),
      turnId: TurnId.make("turn-2"),
      providerInstanceId: ProviderInstanceId.make("codex_personal"),
      // A non turn/completed raw method never positively establishes the
      // conversation, even when its payload happens to carry a thread id.
      raw: {
        source: "codex.app-server.notification",
        method: "turn/aborted",
        payload: { threadId: "codex-thread-9" },
      },
      payload: { reason: "stop requested", tokenUsage: completeUsage },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);

    expect(activity?.kind).toBe("owned-usage");
    expect(activity?.payload).toEqual({
      v: 1,
      scope: "main-turn",
      source: {
        driver: "codex",
        instanceId: "codex_personal",
        turnId: "turn-2",
        runtimeEventId: "evt-abort-1",
        nativeConversationId: null,
      },
      terminal: "aborted",
      usage: completeUsage,
    });
  });

  it("keeps a missing turn id null instead of inventing an active-turn fallback", () => {
    const event = {
      ...base,
      type: "turn.completed",
      eventId: EventId.make("evt-null-turn"),
      payload: { state: "completed", tokenUsage: completeUsage },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);

    expect(activity?.kind).toBe("owned-usage");
    expect(activity?.turnId).toBeNull();
    const observation = activity?.payload as {
      source: { turnId: string | null; instanceId: string | null; nativeConversationId: unknown };
    };
    expect(observation.source.turnId).toBeNull();
    expect(observation.source.instanceId).toBeNull();
    expect(observation.source.nativeConversationId).toBeNull();
  });

  it("leaves nativeConversationId null when the raw terminal is not a positive codex turn/completed", () => {
    const rawVariants = [
      {
        source: "codex.app-server.notification",
        method: "turn/completed",
        payload: {},
      },
      {
        source: "codex.app-server.notification",
        method: "turn/completed",
        payload: { threadId: 42 },
      },
      {
        source: "codex.app-server.notification",
        method: "turn/completed",
        payload: { threadId: "   " },
      },
      {
        source: "codex.app-server.notification",
        method: "turn/completed",
        payload: "not-a-record",
      },
      {
        source: "codex.app-server.notification",
        method: "turn/started",
        payload: { threadId: "codex-thread-9" },
      },
    ] as const;

    for (const [index, raw] of rawVariants.entries()) {
      const event = {
        ...base,
        type: "turn.completed",
        eventId: EventId.make(`evt-raw-${index}`),
        turnId: TurnId.make("turn-3"),
        raw,
        payload: { state: "completed", tokenUsage: completeUsage },
      } satisfies ProviderRuntimeEvent;
      const [activity] = runtimeEventToActivities(event);
      const observation = activity?.payload as {
        source: { nativeConversationId: string | null };
      };
      expect(observation.source.nativeConversationId).toBeNull();
    }

    // Only the codex driver can positively establish the id; the same raw
    // method on another driver proves nothing about a codex conversation.
    const claudeEvent = {
      ...base,
      provider: ProviderDriverKind.make("claudeAgent"),
      type: "turn.completed",
      eventId: EventId.make("evt-raw-claude"),
      turnId: TurnId.make("turn-4"),
      raw: {
        source: "claude.sdk.message",
        method: "turn/completed",
        payload: { threadId: "not-a-codex-thread" },
      },
      payload: { state: "completed", tokenUsage: completeUsage },
    } satisfies ProviderRuntimeEvent;
    const [claudeActivity] = runtimeEventToActivities(claudeEvent);
    const claudeObservation = claudeActivity?.payload as {
      source: { nativeConversationId: string | null };
    };
    expect(claudeObservation.source.nativeConversationId).toBeNull();
  });

  it("stamps a task.completed usage row with its delivery source and completed phase", () => {
    const event = {
      ...base,
      type: "task.completed",
      eventId: EventId.make("evt-child-1"),
      providerInstanceId: ProviderInstanceId.make("codex_personal"),
      payload: {
        taskId: RuntimeTaskId.make("agent-9"),
        status: "completed",
        typedUsage: { totalTokens: 4200, outputTokens: 400 },
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);
    const payload = activity?.payload as Record<string, unknown>;

    expect(activity?.kind).toBe("task.completed");
    expect(payload.typedUsage).toEqual({ totalTokens: 4200, outputTokens: 400 });
    expect(payload.usageSource).toEqual({
      v: 1,
      driver: "codex",
      instanceId: "codex_personal",
      runtimeEventId: "evt-child-1",
      phase: "completed",
    });
  });

  it("stamps a task.progress usage snapshot with progress phase", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-child-2"),
      payload: {
        taskId: RuntimeTaskId.make("agent-10"),
        description: "Agent ten",
        typedUsage: { totalTokens: 64_000 },
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);
    const payload = activity?.payload as Record<string, unknown>;

    expect(activity?.kind).toBe("task.progress");
    expect(payload.usageSnapshot).toBe(true);
    expect(payload.usageSource).toEqual({
      v: 1,
      driver: "codex",
      instanceId: null,
      runtimeEventId: "evt-child-2",
      phase: "progress",
    });
  });

  it("leaves legacy untyped usage rows unstamped", () => {
    const event = {
      ...base,
      type: "task.completed",
      eventId: EventId.make("evt-legacy-1"),
      payload: {
        taskId: RuntimeTaskId.make("agent-11"),
        status: "completed",
        summary: "Done",
        usage: { total: 512 },
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);
    const payload = activity?.payload as Record<string, unknown>;

    expect(payload.typedUsage).toBeUndefined();
    expect(payload.usageSource).toBeUndefined();
  });
});
