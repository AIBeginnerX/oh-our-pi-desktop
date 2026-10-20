import { describe, expect, it } from "vite-plus/test";

import { createPresetProviderInstance, PROVIDER_PRESETS } from "./provider-presets.ts";

describe("OpenCode provider presets", () => {
  it.each([
    ["zai", "api", "zai", "https://api.z.ai/api/paas/v4", "glm-5.3"],
    ["zai", "coding", "zai-coding-plan", "https://api.z.ai/api/coding/paas/v4", "glm-5.3"],
    ["minimax", "api", "minimax", "https://api.minimax.io/anthropic/v1", "MiniMax-M3"],
    [
      "minimax",
      "coding",
      "minimax-coding-plan",
      "https://api.minimax.io/anthropic/v1",
      "MiniMax-M3.1-Flash-Preview",
    ],
  ] as const)(
    "builds isolated %s %s OpenCode config",
    (presetId, service, providerId, baseURL, model) => {
      const instance = createPresetProviderInstance({
        presetId,
        service,
        apiKey: "test-secret",
      });
      const environment = Object.fromEntries(
        instance.environment?.map((variable) => [variable.name, variable]) ?? [],
      );
      const keyName = PROVIDER_PRESETS[presetId].apiKeyEnvironmentVariable;
      const config = JSON.parse(environment.OPENCODE_CONFIG_CONTENT?.value ?? "null") as {
        enabled_providers: string[];
        model: string;
        small_model: string;
        provider: Record<string, { options: { baseURL: string; apiKey: string } }>;
      };

      expect(instance.driver).toBe("opencode");
      expect(instance.enabled).toBe(true);
      expect(environment[keyName]).toMatchObject({ value: "test-secret", sensitive: true });
      expect(environment.T3CODE_OPENCODE_PROVIDER_ID?.value).toBe(providerId);
      expect(config.enabled_providers).toEqual([providerId]);
      expect(config.model).toBe(`${providerId}/${model}`);
      expect(config.small_model).toBe(config.model);
      expect(Object.keys(config.provider)).toEqual([providerId]);
      expect(config.provider[providerId]?.options).toEqual({
        baseURL,
        apiKey: `{env:${keyName}}`,
      });
      expect(environment.OPENCODE_CONFIG_CONTENT?.value).not.toContain("test-secret");
    },
  );

  it("keeps a chosen model under the configured provider and rejects another provider", () => {
    const instance = createPresetProviderInstance({
      presetId: "zai",
      apiKey: "test-secret",
      model: "zai/glm-5.3-flash",
    });
    expect(instance.config).toMatchObject({ customModels: ["zai/glm-5.3-flash"] });
    expect(() =>
      createPresetProviderInstance({
        presetId: "zai",
        apiKey: "test-secret",
        model: "minimax/MiniMax-M3",
      }),
    ).toThrow(/valid zai model ID/u);
    expect(() =>
      createPresetProviderInstance({ presetId: "zai", apiKey: "test-secret", model: "zai/" }),
    ).toThrow(/valid zai model ID/u);
    expect(() => createPresetProviderInstance({ presetId: "zai", apiKey: " " })).toThrow(
      /API key is required/u,
    );
  });
});
