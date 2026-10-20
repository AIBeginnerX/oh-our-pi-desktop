import {
  ProviderInstanceEnvironmentVariableName,
  type ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveOpenCodeProviderScope, scopedOpenCodeModelIssue } from "./openCodeProviderScope.ts";

const variable = (name: string, value: string, sensitive = false) => ({
  name: ProviderInstanceEnvironmentVariableName.make(name),
  value,
  sensitive,
});

describe("OpenCode provider scope", () => {
  it("uses only the configured instance environment and requires its dedicated key", () => {
    expect(resolveOpenCodeProviderScope([])).toBeUndefined();
    const environment: ProviderInstanceEnvironment = [
      variable("T3CODE_OPENCODE_PROVIDER_ID", "zai-coding-plan"),
      variable("OOP_ZAI_API_KEY", "test-key", true),
    ];
    expect(resolveOpenCodeProviderScope(environment)).toEqual({
      providerId: "zai-coding-plan",
      credentialConfigured: true,
    });
    expect(resolveOpenCodeProviderScope(environment.slice(0, 1))).toEqual({
      providerId: "zai-coding-plan",
      credentialConfigured: false,
    });
    expect(
      resolveOpenCodeProviderScope([
        variable("T3CODE_OPENCODE_PROVIDER_ID", "minimax"),
        variable("OOP_ZAI_API_KEY", "test-key", true),
      ]),
    ).toEqual({ providerId: "minimax", credentialConfigured: false });
  });

  it("rejects cross-provider models and external servers without affecting ordinary OpenCode", () => {
    const scope = { providerId: "minimax", credentialConfigured: true };
    expect(scopedOpenCodeModelIssue(undefined, "openai", "")).toBeUndefined();
    expect(scopedOpenCodeModelIssue(scope, "minimax", "")).toBeUndefined();
    expect(scopedOpenCodeModelIssue(scope, "openai", "")).toMatch(/only permits minimax/u);
    expect(scopedOpenCodeModelIssue(scope, "minimax", "http://example.test")).toMatch(
      /local OpenCode server/u,
    );
    expect(
      scopedOpenCodeModelIssue({ ...scope, credentialConfigured: false }, "minimax", ""),
    ).toMatch(/needs its API key/u);
  });
});
