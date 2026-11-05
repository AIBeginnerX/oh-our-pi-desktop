import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  readPersistedTailscaleServe,
  writePersistedTailscaleServe,
} from "./tailscaleServeState.ts";

it.effect("remembers the paired mapping and ignores a missing or unreadable file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-tailscale-serve-test-" });

    assert.isTrue(Option.isNone(yield* readPersistedTailscaleServe(stateDir)));

    yield* writePersistedTailscaleServe(stateDir, { servePort: 443, localPort: 32855 });
    const stored = yield* readPersistedTailscaleServe(stateDir);
    assert.deepEqual(Option.getOrNull(stored), { version: 1, servePort: 443, localPort: 32855 });

    yield* writePersistedTailscaleServe(stateDir, { servePort: 443, localPort: 33813 });
    assert.equal(Option.getOrNull(yield* readPersistedTailscaleServe(stateDir))?.localPort, 33813);

    yield* fs.writeFileString(path.join(stateDir, "tailscale-serve.json"), "{broken");
    assert.isTrue(Option.isNone(yield* readPersistedTailscaleServe(stateDir)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
