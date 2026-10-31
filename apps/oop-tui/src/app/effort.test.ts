import type { ModelSelection, ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  effortControl,
  effortStillValid,
  noEffortReason,
  reasoningEffortOf,
  resolveEffort,
  withPromptEffort,
} from "./effort.ts";

const select = (id: string, values: string[], extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  type: "select",
  options: values.map((value, index) => ({
    id: value,
    label: value.toUpperCase(),
    ...(index === 1 ? { isDefault: true } : {}),
  })),
  ...extra,
});

const config = {
  providers: [
    {
      instanceId: "claude",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      models: [
        {
          slug: "opus",
          name: "Opus",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              select("effort", ["low", "high", "ultrathink"], {
                promptInjectedValues: ["ultrathink"],
              }),
              { id: "fast", label: "Fast", type: "boolean" },
            ],
          },
        },
        { slug: "plain", name: "Plain", isCustom: false, capabilities: null },
      ],
    },
    {
      instanceId: "anti",
      driver: "antigravity",
      enabled: true,
      installed: true,
      models: [{ slug: "pro-high", name: "Pro High", isCustom: false, capabilities: null }],
    },
  ],
} as unknown as ServerConfig;

const on = (instanceId: string, model: string, options?: ModelSelection["options"]) =>
  ({ instanceId, model, ...(options ? { options } : {}) }) as unknown as ModelSelection;

describe("effortControl", () => {
  it("reads the first select option of the model, values as the server gives them", () => {
    expect(effortControl(config, on("claude", "opus"))).toEqual({
      descriptorId: "effort",
      choices: [
        { value: "low", label: "LOW" },
        { value: "high", label: "HIGH" },
        { value: "ultrathink", label: "ULTRATHINK" },
      ],
      promptInjected: ["ultrathink"],
    });
  });

  it("is null for a model without one", () => {
    expect(effortControl(config, on("claude", "plain"))).toBeNull();
    expect(effortControl(config, on("claude", "missing"))).toBeNull();
    expect(effortControl(config, on("gone", "opus"))).toBeNull();
  });
});

describe("resolveEffort", () => {
  it("shows and sends the server's default when nothing was picked", () => {
    const resolved = resolveEffort(config, on("claude", "opus"), null);
    expect(resolved.shown).toBe("high");
    expect(resolved.selection.options).toEqual([{ id: "effort", value: "high" }]);
    expect(resolved.promptEffort).toBeNull();
  });

  it("lets a pick win over the selection's own value, and sends it as an option", () => {
    const resolved = resolveEffort(
      config,
      on("claude", "opus", [{ id: "effort", value: "low" }]),
      "high",
    );
    expect(resolved.shown).toBe("high");
    expect(resolved.selection.options).toEqual([{ id: "effort", value: "high" }]);
  });

  it("keeps the selection's own value when no pick is made", () => {
    expect(
      resolveEffort(config, on("claude", "opus", [{ id: "effort", value: "low" }]), null).shown,
    ).toBe("low");
  });

  it("keeps other options of the selection", () => {
    const resolved = resolveEffort(
      config,
      on("claude", "opus", [{ id: "fast", value: true }]),
      "low",
    );
    expect(resolved.selection.options).toEqual([
      { id: "fast", value: true },
      { id: "effort", value: "low" },
    ]);
  });

  it("treats a prompt-injected value as a word in the prompt", () => {
    const resolved = resolveEffort(config, on("claude", "opus"), "ultrathink");
    expect(resolved.promptEffort).toBe("ultrathink");
    expect(resolved.shown).toBe("ultrathink");
  });

  it("ignores a pick the model does not offer", () => {
    expect(resolveEffort(config, on("claude", "opus"), "max").shown).toBe("high");
  });

  it("sends a model without a control as it is", () => {
    const selection = on("claude", "plain", [{ id: "effort", value: "max" }]);
    const resolved = resolveEffort(config, selection, "low");
    expect(resolved.selection).toBe(selection);
    expect(resolved.shown).toBe("max");
  });
});

describe("the rest of the effort helpers", () => {
  it("knows whether a pick still fits a model", () => {
    expect(effortStillValid(config, on("claude", "opus"), "low")).toBe(true);
    expect(effortStillValid(config, on("claude", "plain"), "low")).toBe(false);
  });

  it("says why a model has no effort", () => {
    expect(noEffortReason(config, on("anti", "pro-high"))).toContain("Antigravity");
    expect(noEffortReason(config, on("claude", "plain"))).toContain("바꿀 수 없습니다");
    expect(noEffortReason(config, on("claude", "missing"))).toContain("서버 목록에 없는");
  });

  it("reads an effort from option ids as the old status bar did", () => {
    expect(reasoningEffortOf(on("x", "y", [{ id: "reasoningEffort", value: "xhigh" }]))).toBe(
      "xhigh",
    );
    expect(reasoningEffortOf(null)).toBeNull();
  });

  it("puts the prompt word in front of the message, once", () => {
    expect(withPromptEffort("고쳐 줘", null)).toBe("고쳐 줘");
    expect(withPromptEffort("고쳐 줘", "ultrathink")).toMatch(/^Ultrathink:/u);
  });
});
