import {
  ProviderDriverKind,
  ProviderInstanceEnvironmentVariableName,
  TrimmedNonEmptyString,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";

export type ProviderPresetId = "zai" | "minimax";
export type ProviderPresetService = "api" | "coding";

export interface ProviderPresetServiceOption {
  readonly value: ProviderPresetService;
  readonly label: string;
  readonly providerId: string;
  readonly baseURL: string;
  readonly defaultModel: string;
}

export interface ProviderPreset {
  readonly label: string;
  readonly subtitle: string;
  readonly suggestedInstanceId: string;
  readonly defaultService: ProviderPresetService;
  readonly apiKeyEnvironmentVariable: string;
  readonly services: readonly ProviderPresetServiceOption[];
}

export const PROVIDER_PRESETS: Readonly<Record<ProviderPresetId, ProviderPreset>> = {
  zai: {
    label: "Z.AI",
    subtitle: "via OpenCode",
    suggestedInstanceId: "opencode_zai",
    defaultService: "api",
    apiKeyEnvironmentVariable: "OOP_ZAI_API_KEY",
    services: [
      {
        value: "api",
        label: "API",
        providerId: "zai",
        baseURL: "https://api.z.ai/api/paas/v4",
        defaultModel: "glm-5.3",
      },
      {
        value: "coding",
        label: "Coding Plan",
        providerId: "zai-coding-plan",
        baseURL: "https://api.z.ai/api/coding/paas/v4",
        defaultModel: "glm-5.3",
      },
    ],
  },
  minimax: {
    label: "MiniMax",
    subtitle: "via OpenCode",
    suggestedInstanceId: "opencode_minimax",
    defaultService: "api",
    apiKeyEnvironmentVariable: "OOP_MINIMAX_API_KEY",
    services: [
      {
        value: "api",
        label: "API",
        providerId: "minimax",
        baseURL: "https://api.minimax.io/anthropic/v1",
        defaultModel: "MiniMax-M3",
      },
      {
        value: "coding",
        label: "Token Plan",
        providerId: "minimax-coding-plan",
        baseURL: "https://api.minimax.io/anthropic/v1",
        defaultModel: "MiniMax-M3.1-Flash-Preview",
      },
    ],
  },
};

export function createPresetProviderInstance(input: {
  readonly presetId: ProviderPresetId;
  readonly service?: ProviderPresetService;
  readonly apiKey: string;
  readonly model?: string;
  readonly binaryPath?: string;
}): ProviderInstanceConfig {
  const preset = PROVIDER_PRESETS[input.presetId];
  const service = preset.services.find(
    (candidate) => candidate.value === (input.service ?? preset.defaultService),
  );
  if (!service) {
    throw new Error(`Unsupported ${preset.label} service: ${input.service}`);
  }
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error(`${preset.label} API key is required.`);
  }
  const chosenModel = input.model?.trim() || service.defaultModel;
  const model = chosenModel.startsWith(`${service.providerId}/`)
    ? chosenModel.slice(service.providerId.length + 1)
    : chosenModel;
  if (
    !model ||
    model.includes("/") ||
    [...model].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new Error(`Model must be a valid ${service.providerId} model ID.`);
  }
  const modelSlug = `${service.providerId}/${model}`;

  // The credential is a sensitive instance environment value. OpenCode sees
  // only an env reference in its config, so it cannot select a global account.
  const configContent = JSON.stringify({
    enabled_providers: [service.providerId],
    model: modelSlug,
    small_model: modelSlug,
    provider: {
      [service.providerId]: {
        options: {
          baseURL: service.baseURL,
          apiKey: `{env:${preset.apiKeyEnvironmentVariable}}`,
        },
      },
    },
  });

  return {
    driver: ProviderDriverKind.make("opencode"),
    displayName: TrimmedNonEmptyString.make(preset.label),
    enabled: true,
    config: {
      enabled: true,
      binaryPath: input.binaryPath?.trim() || "opencode",
      serverUrl: "",
      customModels: [modelSlug],
    },
    environment: [
      {
        name: ProviderInstanceEnvironmentVariableName.make(preset.apiKeyEnvironmentVariable),
        value: apiKey,
        sensitive: true,
      },
      {
        name: ProviderInstanceEnvironmentVariableName.make("OPENCODE_CONFIG_CONTENT"),
        value: configContent,
        sensitive: false,
      },
      {
        name: ProviderInstanceEnvironmentVariableName.make("T3CODE_OPENCODE_PROVIDER_ID"),
        value: service.providerId,
        sensitive: false,
      },
    ],
  };
}
