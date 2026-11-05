import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "./atomicWrite.ts";

/**
 * Remembers the Tailscale Serve mapping `t3 pair --tailscale` created for this
 * home. The mapping outlives the server but points at its old local port, so
 * a server that restarts on a new port (the background service does) reads
 * this to re-aim its own mapping. See `repointTailscaleServe`.
 */
const PersistedTailscaleServe = Schema.Struct({
  version: Schema.Literal(1),
  servePort: Schema.Int,
  localPort: Schema.Int,
});
export type PersistedTailscaleServe = typeof PersistedTailscaleServe.Type;

const PersistedTailscaleServeJson = Schema.fromJsonString(PersistedTailscaleServe);
const decode = Schema.decodeUnknownEffect(PersistedTailscaleServeJson);
const encode = Schema.encodeEffect(PersistedTailscaleServeJson);

const statePathFor = Effect.fn("tailscaleServeState.path")(function* (stateDir: string) {
  const path = yield* Path.Path;
  return path.join(stateDir, "tailscale-serve.json");
});

export const readPersistedTailscaleServe = Effect.fn("tailscaleServeState.read")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const statePath = yield* statePathFor(stateDir);
  const raw = yield* fs.readFileString(statePath).pipe(Effect.option);
  if (Option.isNone(raw)) {
    return Option.none<PersistedTailscaleServe>();
  }
  return yield* decode(raw.value).pipe(Effect.option);
});

export const writePersistedTailscaleServe = Effect.fn("tailscaleServeState.write")(function* (
  stateDir: string,
  input: { readonly servePort: number; readonly localPort: number },
) {
  const filePath = yield* statePathFor(stateDir);
  const json = yield* encode({ version: 1, ...input });
  yield* writeFileStringAtomically({ filePath, contents: `${json}\n` });
});
