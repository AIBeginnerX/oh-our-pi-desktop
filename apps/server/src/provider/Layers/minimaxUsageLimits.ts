import * as NodeOS from "node:os";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess } from "effect/unstable/process";

import { spawnAndCollect } from "../providerSnapshot.ts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const DAY_MS = 86_400_000;

const finite = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const isoOf = (ms: number | null) =>
  ms !== null && ms > 0 ? DateTime.formatIso(DateTime.makeUnsafe(ms)) : undefined;

function intervalCadence(
  durationMs: number | null,
): Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins"> {
  if (durationMs === null || durationMs <= 0) return { kind: "other", label: "Interval" };
  const minutes = Math.round(durationMs / 60_000);
  if (durationMs < DAY_MS) {
    const hours = Math.round(minutes / 60);
    return { kind: "session", label: `${hours}-hour`, windowDurationMins: minutes };
  }
  const days = Math.round(durationMs / DAY_MS);
  return {
    kind: "other",
    label: days === 1 ? "Daily" : `${days}-day`,
    windowDurationMins: minutes,
  };
}

/**
 * Windows from a MiniMax Token Plan `remains` response. Each `model_remains` entry (the
 * `general` text allowance, then media such as `video`) carries a rolling interval and a weekly
 * window as remaining percentages; non-general models are prefixed with their name.
 */
export function minimaxRemainsToWindows(payload: unknown): ServerProviderUsageWindow[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { base_resp: baseResp, model_remains: models } = payload as {
    base_resp?: { status_code?: unknown };
    model_remains?: unknown;
  };
  if (finite(baseResp?.status_code) !== 0 || !Array.isArray(models)) return null;
  const windows: ServerProviderUsageWindow[] = [];
  for (const raw of models) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.model_name === "string" ? entry.model_name.trim() : "";
    const id = name || "plan";
    const prefix = name && name !== "general" ? `${name[0]!.toUpperCase()}${name.slice(1)} · ` : "";

    const intervalRemaining = finite(entry.current_interval_remaining_percent);
    if (intervalRemaining !== null) {
      const start = finite(entry.start_time);
      const end = finite(entry.end_time);
      const cadence = intervalCadence(start !== null && end !== null ? end - start : null);
      const resetsAt = isoOf(end);
      windows.push({
        ...cadence,
        id: `${id}_interval`,
        label: `${prefix}${cadence.label}`,
        usedPercent: clampPercent(100 - intervalRemaining),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }

    const weeklyRemaining = finite(entry.current_weekly_remaining_percent);
    if (weeklyRemaining !== null) {
      const resetsAt = isoOf(finite(entry.weekly_end_time));
      windows.push({
        id: `${id}_weekly`,
        kind: "weekly",
        label: `${prefix}Weekly`,
        windowDurationMins: 10_080,
        usedPercent: clampPercent(100 - weeklyRemaining),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return windows.length > 0 ? windows : null;
}

const McodeAuth = Schema.Struct({
  records: Schema.Record(
    Schema.String,
    Schema.Struct({
      accessToken: Schema.optional(Schema.String),
      expiresAtMs: Schema.optional(Schema.Number),
    }),
  ),
});
const decodeMcodeAuth = Schema.decodeEffect(Schema.fromJsonString(McodeAuth));

const MmxConfig = Schema.Struct({
  api_key: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  base_url: Schema.optional(Schema.String),
});
const decodeMmxConfig = Schema.decodeEffect(Schema.fromJsonString(MmxConfig));

interface RemainsRequest {
  readonly url: string;
  readonly token: string;
}

/**
 * MiniMax Token Plan limits for the account MiniMax Code signs in with. The OAuth token from
 * `mcode login` (`~/.minimax/auth/prod/<region>/mcode-public/auth.json`) reads the coding-plan
 * endpoint; it expires an hour after MiniMax Code last ran. The MiniMax CLI's API key
 * (`~/.mmx/config.json`) is the fallback, and without one `mcodeCommand provider list` refreshes the
 * expired token: any `mcode` command that loads the account does, and this one spends no model
 * tokens.
 */
export const readMiniMaxUsageLimits = Effect.fn("readMiniMaxUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
  mcodeCommand: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const now = yield* DateTime.now;
  const checkedAt = DateTime.formatIso(now);
  const nowMs = DateTime.toEpochMillis(now);
  const home = environment.HOME || environment.USERPROFILE || NodeOS.homedir();

  const fromMcode = (region: "en" | "cn") =>
    fs
      .readFileString(
        path.join(home, ".minimax", "auth", "prod", region, "mcode-public", "auth.json"),
      )
      .pipe(
        Effect.flatMap(decodeMcodeAuth),
        Effect.map((auth): RemainsRequest | null => {
          const record = Object.values(auth.records).find(
            (entry) =>
              (entry.accessToken?.trim().length ?? 0) > 0 &&
              (entry.expiresAtMs ?? 0) > nowMs + 60_000,
          );
          const host = region === "cn" ? "https://api.minimaxi.com" : "https://api.minimax.io";
          return record?.accessToken
            ? { url: `${host}/v1/api/openplatform/coding_plan/remains`, token: record.accessToken }
            : null;
        }),
        Effect.orElseSucceed(() => null),
      );
  const fromMmx = fs.readFileString(path.join(home, ".mmx", "config.json")).pipe(
    Effect.flatMap(decodeMmxConfig),
    Effect.map((config): RemainsRequest | null => {
      const key = config.api_key?.trim();
      if (!key) return null;
      const host =
        config.base_url?.trim().replace(/\/+$/u, "") ||
        (config.region === "cn" ? "https://api.minimaxi.com" : "https://api.minimax.io");
      return { url: `${host}/v1/token_plan/remains`, token: key };
    }),
    Effect.orElseSucceed(() => null),
  );

  const signedInToMcode = Effect.gen(function* () {
    for (const region of ["en", "cn"]) {
      const file = path.join(home, ".minimax", "auth", "prod", region, "mcode-public", "auth.json");
      if (yield* fs.exists(file)) return true;
    }
    return false;
  }).pipe(Effect.orElseSucceed(() => false));
  const refreshMcodeToken = Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(mcodeCommand, ["provider", "list"], {
      env: environment,
    });
    yield* spawnAndCollect(
      mcodeCommand,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.scoped, Effect.timeout("15 seconds"), Effect.ignore);

  let request = (yield* fromMcode("en")) ?? (yield* fromMcode("cn")) ?? (yield* fromMmx);
  if (request === null && (yield* signedInToMcode)) {
    yield* refreshMcodeToken;
    request = (yield* fromMcode("en")) ?? (yield* fromMcode("cn"));
  }
  if (request === null) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message:
        "Run MiniMax Code once (or sign in to the MiniMax CLI with `mmx auth login`) to see Token Plan limits.",
    });
  }

  return yield* client
    .execute(
      HttpClientRequest.get(request.url).pipe(
        HttpClientRequest.setHeaders({
          Accept: "application/json",
          Authorization: `Bearer ${request.token}`,
        }),
      ),
    )
    .pipe(
      Effect.flatMap((response) => response.json),
      Effect.map((payload) => {
        const windows = minimaxRemainsToWindows(payload);
        return windows === null
          ? makeUnavailableUsageLimits({
              checkedAt,
              reason: "probeFailed",
              message: "MiniMax did not return Token Plan limits.",
            })
          : makeUsageLimits({ checkedAt, windows });
      }),
      Effect.timeout("10 seconds"),
      Effect.catch(() =>
        Effect.succeed(
          makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "Could not read MiniMax Token Plan limits. Refresh provider status to retry.",
          }),
        ),
      ),
    );
});
