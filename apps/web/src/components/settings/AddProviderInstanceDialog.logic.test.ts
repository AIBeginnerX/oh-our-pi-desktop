import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createProviderInstanceFromWizard } from "./AddProviderInstanceDialog.logic";

describe("provider instance wizard serialization", () => {
  it("saves a Z.AI selection as a separate OpenCode instance with a sensitive key", () => {
    const instance = createProviderInstanceFromWizard({
      driver: ProviderDriverKind.make("opencode"),
      presetId: "zai",
      presetDraft: { apiKey: "test-secret", service: "coding", model: "glm-5.3", binaryPath: "" },
      label: "Work Z.AI",
      accentColor: undefined,
      configDraft: {},
    });

    expect(instance.driver).toBe("opencode");
    expect(instance.displayName).toBe("Work Z.AI");
    expect(instance.environment).toContainEqual({
      name: "OOP_ZAI_API_KEY",
      value: "test-secret",
      sensitive: true,
    });
    expect(JSON.stringify(instance.config)).not.toContain("test-secret");
    expect(instance.config).toMatchObject({ serverUrl: "" });
  });

  it("rejects a model qualified for a different service without saving", () => {
    expect(() =>
      createProviderInstanceFromWizard({
        driver: ProviderDriverKind.make("opencode"),
        presetId: "minimax",
        presetDraft: {
          apiKey: "test-secret",
          service: "api",
          model: "openai/gpt-5",
          binaryPath: "",
        },
        label: "",
        accentColor: undefined,
        configDraft: {},
      }),
    ).toThrow(/valid minimax model ID/);
  });

  it("keeps ordinary driver configuration behavior", () => {
    const openCode = createProviderInstanceFromWizard({
      driver: ProviderDriverKind.make("opencode"),
      presetId: null,
      presetDraft: null,
      label: "",
      accentColor: undefined,
      configDraft: { binaryPath: "/opt/opencode", serverUrl: "http://127.0.0.1:4096" },
    });
    expect(openCode).toEqual({
      driver: "opencode",
      enabled: true,
      config: { binaryPath: "/opt/opencode", serverUrl: "http://127.0.0.1:4096" },
    });

    const codex = createProviderInstanceFromWizard({
      driver: ProviderDriverKind.make("codex"),
      presetId: null,
      presetDraft: null,
      label: "Work",
      accentColor: undefined,
      configDraft: {},
    });
    expect(codex.config).toEqual({ setupMode: "existing" });
  });
});
