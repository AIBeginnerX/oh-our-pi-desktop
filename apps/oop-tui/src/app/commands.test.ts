import { describe, expect, it } from "vite-plus/test";

import { makeConfig, makeProject } from "../testing/fixtures.ts";
import {
  availableModels,
  compatibleModels,
  defaultModelSelection,
  titleFromMessage,
  turnStartCommand,
  withoutBootstrap,
} from "./commands.ts";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

const context = { uuid: () => "fixed", now: () => new Date("2026-10-30T09:00:00.000Z") };

describe("titleFromMessage", () => {
  it("uses the first non-empty line", () => {
    expect(titleFromMessage("\n\n  버그 고쳐 줘  \n두 번째")).toBe("버그 고쳐 줘");
    expect(titleFromMessage("   ")).toBe("새 대화");
  });

  it("cuts long titles on a character boundary with an ellipsis", () => {
    const title = titleFromMessage("가".repeat(100));
    expect(Array.from(title)).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);
    expect(titleFromMessage("😀".repeat(70))).toBe(`${"😀".repeat(59)}…`);
  });
});

describe("models", () => {
  it("lists only what the server can run", () => {
    const config = makeConfig({
      providers: [
        {
          instanceId: "off",
          driver: "x",
          displayName: "끔",
          enabled: false,
          installed: true,
          models: [{ slug: "m", name: "M" }],
        },
        {
          instanceId: "missing",
          driver: "x",
          enabled: true,
          installed: false,
          models: [{ slug: "m", name: "M" }],
        },
        {
          instanceId: "ok",
          driver: "x",
          displayName: "Ok",
          enabled: true,
          installed: true,
          models: [{ slug: "a", name: "A" }],
        },
      ],
    });
    expect(availableModels(config).map((model) => model.label)).toEqual(["Ok / A"]);
    expect(availableModels(null)).toEqual([]);
  });

  it("prefers the project's default, then the provider's flagged default model", () => {
    const config = makeConfig();
    expect(defaultModelSelection(undefined, config)).toEqual({
      instanceId: "codex",
      model: "gpt-5",
    });
    const project = makeProject({ defaultModelSelection: { instanceId: "claude", model: "opus" } });
    expect(defaultModelSelection(project, config)).toEqual({ instanceId: "claude", model: "opus" });
    expect(defaultModelSelection(undefined, null)).toBeNull();
  });
});

describe("turnStartCommand", () => {
  it("only bootstraps a thread when asked to", () => {
    const base = {
      threadId: ThreadId.make("t"),
      text: "안녕",
      runtimeMode: "approval-required" as const,
    };
    const follow = turnStartCommand(context, base);
    expect(follow).not.toHaveProperty("bootstrap");
    expect(follow).toMatchObject({
      type: "thread.turn.start",
      message: { text: "안녕", role: "user" },
    });

    const first = turnStartCommand(context, {
      ...base,
      create: {
        projectId: "project-1" as never,
        modelSelection: { instanceId: "codex", model: "gpt-5" } as never,
      },
    });
    expect(first).toMatchObject({
      titleSeed: "안녕",
      bootstrap: { createThread: { title: "안녕" } },
    });
  });
});

describe("compatibleModels", () => {
  const provider = (over: Record<string, unknown>) => ({
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    models: [
      { slug: "a", name: "A", isCustom: false, capabilities: null },
      { slug: "b", name: "B", isCustom: false, capabilities: null },
    ],
    ...over,
  });
  const config = makeConfig({
    providers: [
      provider({}),
      provider({ instanceId: "codex-work", displayName: "Codex Work" }),
      provider({ instanceId: "claude", driver: "claudeAgent", displayName: "Claude" }),
      provider({
        instanceId: "g1",
        driver: "antigravity",
        continuation: { groupKey: "profile-1" },
      }),
      provider({
        instanceId: "g2",
        driver: "antigravity",
        continuation: { groupKey: "profile-2" },
      }),
      provider({
        instanceId: "sticky",
        driver: "cursor",
        requiresNewThreadForModelChange: true,
      }),
    ],
  });

  it("keeps a started thread on its own provider driver", () => {
    expect(
      compatibleModels(config, { instanceId: "codex", model: "a" }).map((m) => m.instanceId),
    ).toEqual(["codex", "codex", "codex-work", "codex-work"]);
  });

  it("stays inside the continuation group when the provider names one", () => {
    expect(
      new Set(compatibleModels(config, { instanceId: "g1", model: "a" }).map((m) => m.instanceId)),
    ).toEqual(new Set(["g1"]));
  });

  it("offers only the current model when the provider cannot switch in place", () => {
    expect(compatibleModels(config, { instanceId: "sticky", model: "b" })).toMatchObject([
      { instanceId: "sticky", model: "b", label: expect.stringContaining("B") },
    ]);
  });

  it("offers nothing when the thread's provider is gone from the catalog", () => {
    expect(compatibleModels(config, { instanceId: "removed", model: "a" })).toEqual([]);
  });
});

describe("withoutBootstrap", () => {
  it("keeps ids and text but drops thread creation, for a resend after the thread exists", () => {
    const create = {
      projectId: ProjectId.make("p"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    };
    const command = turnStartCommand(context, {
      threadId: ThreadId.make("t"),
      text: "안녕",
      runtimeMode: "approval-required",
      create,
    });
    const resend = withoutBootstrap(command);
    expect(resend).toMatchObject({
      type: "thread.turn.start",
      commandId: "fixed",
      message: { messageId: "fixed", text: "안녕" },
    });
    expect("bootstrap" in resend).toBe(false);
    expect("titleSeed" in resend).toBe(false);
  });
});
