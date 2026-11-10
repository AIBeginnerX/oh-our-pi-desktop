/**
 * Boots the real CodexSessionRuntime against the mock app-server peer, which
 * exits with a code right after its turn starts, as an app server that handles
 * the server's shutdown signal does.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const peerPath = NodePath.join(
  import.meta.dirname,
  `../testFixtures/codexCollabMockPeer.${HostProcessPlatform.defaultValue() === "win32" ? "cmd" : "sh"}`,
);

describe("Codex app server exit during server shutdown", () => {
  it.effect("leaves the running turn for runStopAll", () =>
    Effect.gen(function* () {
      const scriptDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-shutdown-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptDir, { recursive: true, force: true })),
      );
      const scriptPath = NodePath.join(scriptDir, "script.json");
      NodeFS.writeFileSync(
        scriptPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({ rootThreadId: wireFixture.rootThreadId, exitAfterTurnStarted: true }),
        "utf8",
      );
      // The exit watcher consults the marker once the app server has exited.
      let markExitObserved = () => {};
      const exitObserved = new Promise<void>((resolve) => {
        markExitObserved = resolve;
      });
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-shutdown"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        isShuttingDown: () => {
          markExitObserved();
          return true;
        },
      });

      yield* runtime.start();
      const turn = yield* runtime.sendTurn({ input: "keep working" });
      yield* Effect.promise(() => exitObserved);

      // What the adapter lists to `ProviderService.runStopAll`.
      const session = yield* runtime.getSession;
      assert.equal(session.status, "running");
      assert.equal(session.activeTurnId, turn.turnId);
      // runStopAll then closes it through stopAll.
      yield* runtime.close;
      assert.equal((yield* runtime.getSession).status, "closed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
