import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vite-plus/test";

import { minimaxRemainsToWindows, readMiniMaxUsageLimits } from "./minimaxUsageLimits.ts";

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

describe("minimaxRemainsToWindows", () => {
  it("maps a Token Plan response to interval and weekly windows per model", () => {
    expect(
      minimaxRemainsToWindows({
        model_remains: [
          {
            start_time: 1792213200000,
            end_time: 1792231200000,
            model_name: "general",
            weekly_end_time: 1792368000000,
            current_interval_remaining_percent: 98,
            current_weekly_remaining_percent: 88,
          },
          {
            start_time: 1792195200000,
            end_time: 1792281600000,
            model_name: "video",
            weekly_end_time: 1792368000000,
            current_interval_remaining_percent: 100,
            current_weekly_remaining_percent: 100,
          },
        ],
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    ).toEqual([
      {
        id: "general_interval",
        kind: "session",
        label: "5-hour",
        windowDurationMins: 300,
        usedPercent: 2,
        resetsAt: iso(1792231200000),
      },
      {
        id: "general_weekly",
        kind: "weekly",
        label: "Weekly",
        windowDurationMins: 10080,
        usedPercent: 12,
        resetsAt: iso(1792368000000),
      },
      {
        id: "video_interval",
        kind: "other",
        label: "Video · Daily",
        windowDurationMins: 1440,
        usedPercent: 0,
        resetsAt: iso(1792281600000),
      },
      {
        id: "video_weekly",
        kind: "weekly",
        label: "Video · Weekly",
        windowDurationMins: 10080,
        usedPercent: 0,
        resetsAt: iso(1792368000000),
      },
    ]);
  });

  it("reports nothing for a rejected key or an empty plan", () => {
    expect(
      minimaxRemainsToWindows({
        base_resp: { status_code: 1004, status_msg: "login fail" },
      }),
    ).toBeNull();
    expect(
      minimaxRemainsToWindows({
        model_remains: [{ model_name: "general" }],
        base_resp: { status_code: 0 },
      }),
    ).toBeNull();
  });
});

const finishedProcess = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const mcodeAuth = (accessToken: string, expiresAtMs: number) =>
  JSON.stringify({ records: { "com.minimax.mcode.oauth.prod.en": { accessToken, expiresAtMs } } });

const REMAINS = {
  base_resp: { status_code: 0 },
  model_remains: [{ model_name: "general", current_weekly_remaining_percent: 70 }],
};

/** Runs the reader against a throwaway home where `mcode provider list` rewrites the auth file. */
const readWith = (initialAuth: ((nowMs: number) => string) | null) =>
  Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "oop-minimax-usage-" });
    const authFile = path.join(home, ".minimax", "auth", "prod", "en", "mcode-public", "auth.json");
    if (initialAuth !== null) {
      yield* fs.makeDirectory(path.dirname(authFile), { recursive: true });
      yield* fs.writeFileString(authFile, initialAuth(nowMs));
    }
    const commands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
      commands.push(args);
      return fs
        .writeFileString(authFile, mcodeAuth("fresh-token", nowMs + 3_600_000))
        .pipe(Effect.as(finishedProcess()), Effect.orDie);
    });
    const authorizations: Array<string | undefined> = [];
    const client = HttpClient.make((request) => {
      authorizations.push(request.headers.authorization);
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(REMAINS)));
    });
    const limits = yield* readMiniMaxUsageLimits({ HOME: home }, "mcode").pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(HostProcessPlatform, "darwin"),
    );
    return { limits, commands, authorizations };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("readMiniMaxUsageLimits", () => {
  effectIt.effect(
    "refreshes an expired MiniMax Code token through mcode when no CLI key exists",
    () =>
      Effect.gen(function* () {
        const { limits, commands, authorizations } = yield* readWith((nowMs) =>
          mcodeAuth("stale-token", nowMs - 60_000),
        );
        expect(commands).toEqual([["provider", "list"]]);
        expect(authorizations).toEqual(["Bearer fresh-token"]);
        expect(limits.unavailable).toBeUndefined();
        expect(limits.windows.map((window) => window.usedPercent)).toEqual([30]);
      }),
  );

  effectIt.effect("does not run mcode for an account that never signed in", () =>
    Effect.gen(function* () {
      const { limits, commands, authorizations } = yield* readWith(null);
      expect(commands).toEqual([]);
      expect(authorizations).toEqual([]);
      expect(limits.unavailable?.reason).toBe("unsupported");
    }),
  );
});
