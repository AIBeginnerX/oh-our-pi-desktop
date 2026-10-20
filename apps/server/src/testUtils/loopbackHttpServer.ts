import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpServer from "effect/unstable/http/HttpServer";

/**
 * `NodeHttpServer.layerTest` bound to 127.0.0.1, the address every test request goes to.
 *
 * `layerTest` listens on all addresses. On macOS a socket listening on all addresses can share
 * its port with another process's 127.0.0.1 listener, and requests to 127.0.0.1 then reach that
 * process. CI runs on a Mac beside provider CLIs that open loopback servers on ephemeral ports,
 * so tests intermittently got their answers ("auth required", an HTML page) instead.
 */
export const makeLayerTest = (options: Omit<NodeHttpServer.Options, "host" | "port"> = {}) =>
  HttpServer.layerTestClient.pipe(
    Layer.provide(
      Layer.fresh(FetchHttpClient.layer).pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
      ),
    ),
    Layer.provideMerge(
      Layer.unwrap(
        Effect.map(
          Effect.promise(() => import("node:http")),
          (NodeHttp) =>
            NodeHttpServer.layer(NodeHttp.createServer, { ...options, host: "127.0.0.1", port: 0 }),
        ),
      ),
    ),
  );

export const layerTest = makeLayerTest();
