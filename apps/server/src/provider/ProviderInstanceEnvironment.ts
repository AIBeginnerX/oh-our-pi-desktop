import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { expandHomePath } from "../pathExpansion.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
        : variable.value;
  }
  return next;
}

/** The defaults each CLI reads; its telemetry switch removes only these. */
const TELEMETRY_DEFAULTS_READ_BY = {
  claudeCode: ["DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING"],
  grok: ["GROK_TELEMETRY_ENABLED", "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING"],
  zcode: ["ZCODE_MODEL_TELEMETRY_ENABLED"],
} as const;

/** Build a provider process environment without overriding explicit telemetry choices. */
export function makeProviderProcessEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  /**
   * The CLI whose telemetry switch is on. Its own defaults are left out; the others stay, so
   * CLIs that its tools start keep theirs.
   */
  options: { readonly telemetryOn?: keyof typeof TELEMETRY_DEFAULTS_READ_BY } = {},
): NodeJS.ProcessEnv {
  const merged = mergeProviderInstanceEnvironment(environment, baseEnv);
  const next = { ...merged };
  // Claude Code: https://code.claude.com/docs/en/data-usage#telemetry-services
  // Grok: bundled user guide, Configuration > Telemetry and Environment Variables.
  // Keep explicit opt-ins (including instance overrides) in control as well.
  const hasTelemetryChoice = next.DISABLE_TELEMETRY !== undefined;
  if (
    !hasTelemetryChoice &&
    next.CLAUDE_CODE_ENABLE_TELEMETRY === undefined &&
    next.GROK_TELEMETRY_ENABLED === undefined
  ) {
    next.DISABLE_TELEMETRY = "1";
  }
  if (!hasTelemetryChoice && next.GROK_TELEMETRY_ENABLED === undefined) {
    next.GROK_TELEMETRY_ENABLED = "false";
  }
  if (next.DISABLE_ERROR_REPORTING === undefined && next.GROK_ERROR_REPORTING === undefined) {
    next.DISABLE_ERROR_REPORTING = "1";
  }
  // ZCode: its bundled CLI skips model telemetry when this is 0, false, off or disabled.
  if (next.ZCODE_MODEL_TELEMETRY_ENABLED === undefined) {
    next.ZCODE_MODEL_TELEMETRY_ENABLED = "false";
  }
  for (const name of options.telemetryOn ? TELEMETRY_DEFAULTS_READ_BY[options.telemetryOn] : []) {
    if (merged[name] === undefined) delete next[name];
  }
  return next;
}
