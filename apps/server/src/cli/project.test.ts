import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";
import { ServerAuthSessionTokenIssueError } from "../auth/EnvironmentAuth.ts";
import { persistServerRuntimeState } from "../serverRuntimeState.ts";

import { EnvironmentInternalError } from "@t3tools/contracts";

import {
  tryResolveLiveProjectExecutionMode,
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  projectCommandErrorFromLiveServerRequest,
} from "./project.ts";

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "orchestration_snapshot_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});

for (const alive of [true, false]) {
  it.effect(`preserves runtime after live resolution failure when owner is alive: ${alive}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "project-runtime-test-" });
      const statePath = `${root}/server-runtime.json`;
      yield* persistServerRuntimeState({
        path: statePath,
        state: {
          version: 1,
          pid: 4242,
          port: 4971,
          origin: "http://127.0.0.1:4971",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      });
      const probe = vi.spyOn(process, "kill").mockImplementation(() => {
        if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return true;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => probe.mockRestore()));
      const result = yield* tryResolveLiveProjectExecutionMode(
        {
          issueSession: () =>
            Effect.fail(new ServerAuthSessionTokenIssueError({ cause: new Error("unavailable") })),
          revokeSession: () => Effect.succeed(true),
        },
        { serverRuntimeStatePath: statePath },
      );
      assert.isTrue(Option.isNone(result));
      assert.equal(yield* fs.exists(statePath), alive);
    }).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer]), Effect.scoped),
  );
}
