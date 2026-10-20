import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/unstable/http/HttpServer";

import * as LoopbackHttpServer from "./loopbackHttpServer.ts";

it.effect("serves tests on 127.0.0.1, where their requests go", () =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    // A server on all addresses could share its port with another process's loopback listener.
    assert.match(HttpServer.formatAddress(server.address), /^http:\/\/127\.0\.0\.1:\d+$/u);
  }).pipe(Effect.provide(LoopbackHttpServer.layerTest)),
);
