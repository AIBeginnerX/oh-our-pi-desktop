import * as NodeOS from "node:os";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const QUOTA_PATH = "/api/monitor/usage/quota/limit";

const ZCodeConfig = Schema.Struct({
  provider: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        enabled: Schema.optional(Schema.Boolean),
        options: Schema.optional(
          Schema.Struct({
            apiKey: Schema.optional(Schema.String),
            baseURL: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  ),
});
const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(ZCodeConfig));

const finite = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * Used percent of one GLM limit: remaining/used counters when present, then used over total,
 * then the legacy `percentage` field (a used percent).
 */
function usedPercentOf(limit: Record<string, unknown>): number | null {
  const remaining = finite(limit.remaining);
  const used = finite(limit.currentValue);
  const parts = remaining !== null && used !== null ? remaining + used : null;
  const total = parts !== null && parts > 0 ? parts : finite(limit.usage);
  if (total !== null && total > 0) {
    if (remaining !== null && remaining >= 0 && remaining <= total) {
      return clampPercent(100 - (remaining / total) * 100);
    }
    if (used !== null && used >= 0 && used <= total) return clampPercent((used / total) * 100);
  }
  const percentage = finite(limit.percentage);
  return percentage === null ? null : clampPercent(percentage);
}

// GLM limits carry a period as `unit` + `number`: unit 3 is hours, 4 days, 5 months, 6 weeks
// (observed: 5 hours, 1 week, and a monthly MCP allowance). Older responses only send `number`.
function cadenceOf(
  unit: number | null,
  number: number | null,
): Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins"> & { key: string } {
  const count = number ?? 1;
  if (unit === 3 || (unit === null && number === 5)) {
    return {
      key: `${count}h`,
      kind: "session",
      label: `${count}-hour`,
      windowDurationMins: count * 60,
    };
  }
  if (unit === 6 || (unit === null && number === 7)) {
    const weeks = unit === 6 ? count : 1;
    return {
      key: "week",
      kind: "weekly",
      label: weeks === 1 ? "Weekly" : `${weeks}-week`,
      windowDurationMins: weeks * 10080,
    };
  }
  if (unit === 5)
    return { key: "month", kind: "monthly", label: count === 1 ? "Monthly" : `${count}-month` };
  if (unit === 4) {
    return {
      key: `${count}d`,
      kind: "other",
      label: `${count}-day`,
      windowDurationMins: count * 1440,
    };
  }
  return { key: String(number ?? "limit"), kind: "other", label: "Quota" };
}

/** Windows from the GLM coding-plan quota response, or null when it carries none. */
export function zcodeQuotaToWindows(payload: unknown): ServerProviderUsageWindow[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { success, data } = payload as { success?: unknown; data?: { limits?: unknown } };
  if (success !== true || !Array.isArray(data?.limits)) return null;
  const windows: ServerProviderUsageWindow[] = [];
  for (const raw of data.limits) {
    if (typeof raw !== "object" || raw === null) continue;
    const limit = raw as Record<string, unknown>;
    const usedPercent = usedPercentOf(limit);
    if (usedPercent === null) continue;
    const type = typeof limit.type === "string" ? limit.type : "Quota";
    const { key, ...cadence } = cadenceOf(finite(limit.unit), finite(limit.number));
    const reset = finite(limit.nextResetTime);
    const resetsAt =
      reset !== null && reset > 0 ? DateTime.formatIso(DateTime.makeUnsafe(reset)) : undefined;
    const tool = type === "MCP_LIMIT" || type === "TIME_LIMIT";
    windows.push({
      ...cadence,
      id: type === "TOKENS_LIMIT" ? `token_${key}` : tool ? "mcp" : type.toLowerCase(),
      label: type === "TOKENS_LIMIT" ? cadence.label : tool ? `MCP tools · ${cadence.label}` : type,
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows.length > 0 ? windows : null;
}

/**
 * GLM coding-plan limits for the Z.ai or BigModel key ZCode signs in with, read from
 * `~/.zcode/v2/config.json`. Other ZCode providers (custom endpoints, MiniMax) report nothing.
 */
export const readZCodeUsageLimits = Effect.fn("readZCodeUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const home = environment.HOME || environment.USERPROFILE || NodeOS.homedir();
  const read = Effect.gen(function* () {
    const config = yield* fs
      .readFileString(path.join(home, ".zcode", "v2", "config.json"))
      .pipe(Effect.flatMap(decodeConfig));
    const plan = Object.entries(config.provider ?? {}).find(
      ([id, provider]) =>
        id.startsWith("builtin:") &&
        (id.includes("zai") || id.includes("bigmodel")) &&
        provider.enabled === true &&
        (provider.options?.apiKey?.trim().length ?? 0) > 0,
    );
    if (plan === undefined) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Sign in to ZCode with a Z.ai or BigModel plan to see GLM limits.",
      });
    }
    const [id, provider] = plan;
    const host =
      id.includes("zai") || provider.options?.baseURL?.includes("api.z.ai")
        ? "https://api.z.ai"
        : "https://open.bigmodel.cn";
    const response = yield* client.execute(
      HttpClientRequest.get(`${host}${QUOTA_PATH}`).pipe(
        HttpClientRequest.setHeaders({
          Accept: "application/json",
          Authorization: `Bearer ${provider.options?.apiKey?.trim() ?? ""}`,
        }),
      ),
    );
    const windows = zcodeQuotaToWindows(yield* response.json);
    return windows === null
      ? makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Z.ai did not return GLM plan limits.",
        })
      : makeUsageLimits({ checkedAt, windows });
  });
  return yield* read.pipe(
    Effect.timeout("10 seconds"),
    Effect.catch(() =>
      Effect.succeed(
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Could not read GLM plan limits. Refresh provider status to retry.",
        }),
      ),
    ),
  );
});
