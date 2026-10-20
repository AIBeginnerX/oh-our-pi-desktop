import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

const PRESET_KEYS: Readonly<Record<string, string>> = {
  zai: "OOP_ZAI_API_KEY",
  "zai-coding-plan": "OOP_ZAI_API_KEY",
  minimax: "OOP_MINIMAX_API_KEY",
  "minimax-coding-plan": "OOP_MINIMAX_API_KEY",
};

export interface OpenCodeProviderScope {
  readonly providerId: string;
  readonly credentialConfigured: boolean;
}

/** Only an explicitly configured instance marker scopes OpenCode. */
export function resolveOpenCodeProviderScope(
  environment: ProviderInstanceEnvironment,
): OpenCodeProviderScope | undefined {
  const providerId = environment
    .findLast((entry) => entry.name === "T3CODE_OPENCODE_PROVIDER_ID")
    ?.value.trim();
  if (!providerId) return undefined;
  const keyName = PRESET_KEYS[providerId];
  const key = keyName
    ? environment.findLast((entry) => entry.name === keyName)?.value.trim()
    : undefined;
  return { providerId, credentialConfigured: !!key };
}

export function scopedOpenCodeModelIssue(
  scope: OpenCodeProviderScope | undefined,
  selectedProviderId: string,
  serverUrl: string,
): string | undefined {
  if (!scope) return undefined;
  if (serverUrl.trim()) return "This provider preset requires a local OpenCode server.";
  if (!scope.credentialConfigured) return "This provider preset needs its API key in Settings.";
  if (selectedProviderId !== scope.providerId) {
    return `This provider instance only permits ${scope.providerId} models.`;
  }
  return undefined;
}
