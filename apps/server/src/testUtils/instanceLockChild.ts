// @effect-diagnostics nodeBuiltinImport:off - Test child process: runs the server's lock layer as its own process.
// Usage: node instanceLockChild.ts <baseDir> <lock|nolock>
// Prints "ready" once the layer is up, then stays alive until killed. A taken
// lock ends the process with the server's exit code (75), like `serve --daemon`.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerInstanceLock from "../serverInstanceLock.ts";

const [baseDir, mode] = process.argv.slice(2);
if (baseDir === undefined) {
  throw new Error("instanceLockChild needs a base directory");
}

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return ServerConfig.make({ ...config, instanceLock: mode === "lock" });
  }),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  Layer.provide(NodeServices.layer),
);

const ready = Layer.effectDiscard(Effect.sync(() => process.stdout.write("ready\n")));

Layer.launch(ready.pipe(Layer.provide(ServerInstanceLock.layer))).pipe(
  Effect.provide(Layer.mergeAll(configLayer, NodeServices.layer)),
  NodeRuntime.runMain,
);
