import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";

import { readZCodeUsageLimits, zcodeQuotaToWindows } from "./zcodeUsageLimits.ts";

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const QUOTA = {
  success: true,
  data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 40 }] },
};

/**
 * Runs the reader against a throwaway home, recording any HTTP request it makes. `asDirectory`
 * puts a directory where `config.json` belongs, so the read fails for a reason other than absence.
 */
const readWith = (
  config: string | null,
  {
    asDirectory = false,
    environment = {},
    payload = QUOTA,
    status = 200,
  }: {
    asDirectory?: boolean;
    environment?: NodeJS.ProcessEnv;
    payload?: unknown;
    status?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "oop-zcode-usage-" });
    const configFile = path.join(home, ".zcode", "v2", "config.json");
    if (asDirectory) {
      yield* fs.makeDirectory(configFile, { recursive: true });
    } else if (config !== null) {
      yield* fs.makeDirectory(path.dirname(configFile), { recursive: true });
      yield* fs.writeFileString(configFile, config);
    }
    const requests: string[] = [];
    const recorded: HttpClientRequest.HttpClientRequest[] = [];
    const client = HttpClient.make((request) => {
      requests.push(request.url);
      recorded.push(request);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(payload, { status })),
      );
    });
    const limits = yield* readZCodeUsageLimits({ ...environment, HOME: home }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );
    return { limits, requests, recorded };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("zcodeQuotaToWindows", () => {
  it("maps a Z.ai coding plan response to 5-hour, weekly, and monthly MCP windows", () => {
    expect(
      zcodeQuotaToWindows({
        success: true,
        data: {
          level: "pro",
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
            {
              type: "TOKENS_LIMIT",
              unit: 6,
              number: 1,
              percentage: 33,
              nextResetTime: 1792398266968,
            },
            {
              type: "TIME_LIMIT",
              unit: 5,
              number: 1,
              usage: 1000,
              currentValue: 250,
              remaining: 750,
              percentage: 25,
              nextResetTime: 1792938650998,
            },
          ],
        },
      }),
    ).toEqual([
      { id: "token_5h", kind: "session", label: "5-hour", windowDurationMins: 300, usedPercent: 0 },
      {
        id: "token_week",
        kind: "weekly",
        label: "Weekly",
        windowDurationMins: 10080,
        usedPercent: 33,
        resetsAt: iso(1792398266968),
      },
      {
        id: "mcp",
        kind: "monthly",
        label: "MCP tools · Monthly",
        modelFamilies: [],
        usedPercent: 25,
        resetsAt: iso(1792938650998),
      },
    ]);
  });

  it("reports nothing for failed or empty responses", () => {
    expect(zcodeQuotaToWindows({ success: false, code: 1001, msg: "auth failed" })).toBeNull();
    expect(
      zcodeQuotaToWindows({ success: true, data: { limits: [{ type: "TOKENS_LIMIT" }] } }),
    ).toBeNull();
  });
});

describe("readZCodeUsageLimits", () => {
  effectIt.effect(
    "reports a ZCode without config.json as unsupported without any HTTP request",
    () =>
      Effect.gen(function* () {
        const { limits, requests } = yield* readWith(null);
        expect(limits.unavailable?.reason).toBe("unsupported");
        expect(limits.unavailable?.message).toContain("OOP_ZAI_API_KEY");
        expect(limits.windows).toEqual([]);
        expect(requests).toEqual([]);
      }),
  );

  effectIt.effect("prefers the trimmed instance key over the legacy config", () =>
    Effect.gen(function* () {
      const { limits, recorded } = yield* readWith(
        `{"provider":{"builtin:bigmodel":{"enabled":true,"options":{"apiKey":"fixture-legacy"}}}}`,
        { environment: { OOP_ZAI_API_KEY: " fixture-instance " } },
      );
      expect(recorded[0]?.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
      expect(recorded[0]?.headers.authorization === "Bearer fixture-instance").toBe(true);
      expect(limits.unavailable).toBeUndefined();
    }),
  );

  effectIt.effect("reads limits with an instance key and no config", () =>
    Effect.gen(function* () {
      const { limits, requests } = yield* readWith(null, {
        environment: { OOP_ZAI_API_KEY: "fixture-instance" },
      });
      expect(requests).toHaveLength(1);
      expect(limits.windows.map((window) => window.usedPercent)).toEqual([40]);
    }),
  );

  effectIt.effect("explains how to replace a rejected plan key", () =>
    Effect.gen(function* () {
      for (const rejection of [
        { payload: { success: false, code: 1000, msg: "auth failed" } },
        { payload: { code: 401, msg: "unauthorized" }, status: 401 },
      ]) {
        const { limits } = yield* readWith(null, {
          environment: { OOP_ZAI_API_KEY: "fixture-instance" },
          ...rejection,
        });
        expect(limits.unavailable?.reason).toBe("probeFailed");
        expect(limits.unavailable?.message).toBe(
          "Z.ai rejected the plan key. Add OOP_ZAI_API_KEY with your Z.ai API key under this ZCode instance's Variables to see GLM limits.",
        );
      }
    }),
  );

  effectIt.effect("still reports a failed probe for a config.json that cannot be read", () =>
    Effect.gen(function* () {
      const { limits, requests } = yield* readWith(null, { asDirectory: true });
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(requests).toEqual([]);
    }),
  );

  effectIt.effect("still reports a failed probe for a config that will not decode", () =>
    Effect.gen(function* () {
      const { limits, requests } = yield* readWith("{ not json");
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(limits.windows).toEqual([]);
      expect(requests).toEqual([]);
    }),
  );

  effectIt.effect("reads GLM limits from a signed-in Z.ai plan", () =>
    Effect.gen(function* () {
      const { limits, requests } = yield* readWith(
        `{"provider":{"builtin:zai":{"enabled":true,"options":{"apiKey":"test-key"}}}}`,
      );
      expect(requests).toEqual(["https://api.z.ai/api/monitor/usage/quota/limit"]);
      expect(limits.unavailable).toBeUndefined();
      expect(limits.windows.map((window) => window.usedPercent)).toEqual([40]);
    }),
  );
});
