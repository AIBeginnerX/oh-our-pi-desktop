import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { githubMediaResponse } from "./GitHubMediaFetch.ts";

it.effect("does not cache credential refusals and serves media after credential rotation", () => {
  let credential = 0;
  const mockCredential = () => `fixture-${credential}`;
  return Effect.gen(function* () {
    const asset = {
      url: "https://raw.githubusercontent.com/owner/repo/main/shot.png",
      cwd: "/repo",
      expiresAt: 60_000,
    };

    for (const status of [401, 404]) {
      const response = yield* githubMediaResponse(asset, {});
      expect(response.status).toBe(status);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      credential++;
    }

    const recovered = yield* githubMediaResponse(asset, {});
    expect(recovered.status).toBe(200);
    expect(recovered.headers["cache-control"]).toBe("private, max-age=60");
  }).pipe(
    Effect.provide(
      Layer.mock(GitHubCli.GitHubCli)({
        execute: () =>
          Effect.sync(() => ({
            stdout: mockCredential(),
            stderr: "",
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdoutTruncated: false,
            stderrTruncated: false,
          })),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const current = request.headers.authorization === `Bearer ${mockCredential()}`;
        const status = !current || credential === 0 ? 401 : credential === 1 ? 404 : 200;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(null, { status, headers: { "content-type": "image/png" } }),
          ),
        );
      }),
    ),
    Effect.scoped,
  );
});

for (const redirect of [false, true]) {
  it.effect(`returns a private 504 when a media request stalls (redirect: ${redirect})`, () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const url = "https://raw.githubusercontent.com/owner/repo/main/shot.png";
      const client = HttpClient.make((request) => {
        if (redirect && request.url === url) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: 302,
                headers: { location: "https://objects.githubusercontent.com/shot.png" },
              }),
            ),
          );
        }
        return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
      });
      const request = yield* githubMediaResponse({ url, cwd: "/repo", expiresAt: 60_000 }, {}).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.scoped,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("15 seconds");
      expect(request.pollUnsafe(), "media request must finish at the deadline").toBeDefined();
      const response = yield* Fiber.join(request);
      expect(response.status).toBe(504);
      expect(response.headers["cache-control"]).toBe("private, no-store");
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubCli.GitHubCli)({
          execute: () =>
            Effect.succeed({
              stdout: "",
              stderr: "",
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
    ),
  );
}
