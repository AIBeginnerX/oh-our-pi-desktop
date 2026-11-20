import { describe, expect, it } from "@effect/vitest";
import { acpConfigOptionModels } from "./AcpAgentProvider.ts";

describe("ACP config-option models", () => {
  it("exposes advertised thought levels in agent order with the current default", () => {
    const models = acpConfigOptionModels([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "glm",
        options: [{ value: "glm", name: "GLM" }],
      },
      {
        id: "thought",
        name: "Thought Level",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: ["low", "high", "max"].map((value) => ({ value, name: value })),
      },
    ]);
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Thought Level",
        type: "select",
        currentValue: "high",
        options: [
          { id: "low", label: "low" },
          { id: "high", label: "high", isDefault: true },
          { id: "max", label: "max" },
        ],
      },
    ]);
  });
  it("does not invent reasoning for model-only agents", () => {
    expect(
      acpConfigOptionModels([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "m3",
          options: [{ value: "m3", name: "M3" }],
        },
      ])[0]?.capabilities?.optionDescriptors,
    ).toEqual([]);
  });
});
