import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

// Test spawners report pid 1. Signalling that "process group" would be
// kill(-1), which reaches every process the user owns.
const pidOneSpawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode("1.0.0\n")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  ),
);

const testLayer = OpenCodeRuntimeLive.pipe(
  Layer.provide(pidOneSpawnerLayer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer)("OpenCodeRuntime process groups", (it) => {
  it.effect("never signals process group 1 when cleaning up a command", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: process.execPath,
        args: ["--version"],
      });

      NodeAssert.equal(result.code, 0);
      NodeAssert.deepEqual(
        kill.mock.calls.filter(([pid]) => Number(pid) <= 1),
        [],
      );
    }).pipe(Effect.ensuring(Effect.sync(() => kill.mockRestore())));
  });
});
