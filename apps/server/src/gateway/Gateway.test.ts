import { expect, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  GATEWAY_ENVIRONMENTS_PATH,
  GATEWAY_UPSTREAMS_PATH,
  GATEWAY_UPSTREAMS_REMOVE_PATH,
  gatewayEnvironmentPath,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as NodeZlib from "node:zlib";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import {
  EnvironmentAuth,
  ServerAuthMissingCredentialError,
  type AuthenticatedSession,
} from "../auth/EnvironmentAuth.ts";
import * as LoopbackHttpServer from "../testUtils/loopbackHttpServer.ts";
import { gatewayRoutesLayer, upstreamsLayer } from "./Gateway.ts";

const UPSTREAM_BEARER = "upstream-bearer-secret";
const UPSTREAM_TICKET = "upstream-ticket";
const HOST_TICKET = "host-ticket";

const GZIPPED_JSON = JSON.stringify({ padding: "environment ".repeat(200) });

const STANDARD: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
];
const ADMIN: ReadonlyArray<AuthEnvironmentScope> = [...STANDARD, AuthAccessWriteScope];

const session = (scopes: ReadonlyArray<AuthEnvironmentScope>): AuthenticatedSession => ({
  sessionId: AuthSessionId.make("test"),
  subject: "test",
  method: "bearer-access-token",
  scopes,
});

/** `x-test-scopes: admin|standard|read` stands in for the host's cookie or bearer session. */
const authenticateHeaders = (request: HttpServerRequest.HttpServerRequest) => {
  switch (request.headers["x-test-scopes"]) {
    case "admin":
      return Effect.succeed(session(ADMIN));
    case "standard":
      return Effect.succeed(session(STANDARD));
    case "read":
      return Effect.succeed(session([AuthOrchestrationReadScope]));
    default:
      return Effect.fail(new ServerAuthMissingCredentialError({}));
  }
};

const hostAuthLayer = Layer.succeed(EnvironmentAuth, {
  authenticateHttpRequest: authenticateHeaders,
  authenticateWebSocketUpgrade: (request: HttpServerRequest.HttpServerRequest) =>
    new URL(request.url, "http://host.test").searchParams.get("wsTicket") === HOST_TICKET
      ? Effect.succeed(session(STANDARD))
      : authenticateHeaders(request),
  issueWebSocketTicket: () =>
    Effect.succeed({ ticket: HOST_TICKET, expiresAt: DateTime.makeUnsafe(0) }),
} as unknown as EnvironmentAuth["Service"]);

const serveOptions = { disableListenLog: true, disableLogger: true } as const;

const serve = <A, E>(served: Layer.Layer<A, E, HttpServer.HttpServer | HttpClient.HttpClient>) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      served.pipe(Layer.provideMerge(LoopbackHttpServer.layerTest)),
    );
    const address = Context.get(context, HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
    return {
      host: `127.0.0.1:${address.port}`,
      client: Context.get(context, HttpClient.HttpClient),
    };
  });

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | undefined>;
  readonly body: string;
}

const startUpstream = Effect.gen(function* () {
  const seen: SeenRequest[] = [];
  const record = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = request.method === "GET" ? "" : yield* request.text;
    seen.push({ method: request.method, url: request.url, headers: { ...request.headers }, body });
    return { request, body };
  });
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/.well-known/t3/environment",
      Effect.succeed(HttpServerResponse.text("{}", { contentType: "application/json" })),
    ),
    HttpRouter.add(
      "GET",
      "/gzipped",
      Effect.sync(() => {
        const compressed = NodeZlib.gzipSync(GZIPPED_JSON);
        return HttpServerResponse.uint8Array(compressed, {
          contentType: "application/json",
          headers: {
            "content-encoding": "gzip",
            "content-length": String(compressed.byteLength),
          },
        });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/api/auth/websocket-ticket",
      Effect.gen(function* () {
        const { request } = yield* record;
        if (request.headers.authorization !== `Bearer ${UPSTREAM_BEARER}`) {
          return HttpServerResponse.text("no", { status: 401 });
        }
        return HttpServerResponse.jsonUnsafe({
          ticket: UPSTREAM_TICKET,
          expiresAt: "2030-01-01T00:00:00.000Z",
        });
      }),
    ),
    HttpRouter.add(
      "*",
      "/echo/*",
      Effect.gen(function* () {
        const { request, body } = yield* record;
        return HttpServerResponse.text(`${request.method} ${request.url} ${body}`, {
          headers: { "set-cookie": "upstream=1" },
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const { request } = yield* record;
        if (new URL(request.url, "http://x").searchParams.get("wsTicket") !== UPSTREAM_TICKET) {
          return HttpServerResponse.text("no", { status: 401 });
        }
        const socket = yield* request.upgrade;
        const write = yield* socket.writer;
        const { pull } = yield* socket.reader;
        while (true) yield* write.writeAll(yield* pull);
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty())),
    ),
  );
  const { host } = yield* serve(HttpRouter.serve(routes, serveOptions));
  return { seen, baseUrl: `http://${host}` };
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = <S extends Schema.Decoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema));

interface CallInit {
  readonly method?: "GET" | "POST";
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

const startGateway = Effect.gen(function* () {
  const { host, client } = yield* serve(
    HttpRouter.serve(gatewayRoutesLayer, serveOptions).pipe(
      Layer.provideMerge(upstreamsLayer),
      Layer.provideMerge(hostAuthLayer),
      Layer.provideMerge(FetchHttpClient.layer),
    ),
  );
  const call = (path: string, init: CallInit = {}, scopes?: string) => {
    const request = HttpClientRequest.make(init.method ?? "GET")(`http://${host}${path}`, {
      headers: { ...(scopes ? { "x-test-scopes": scopes } : {}), ...init.headers },
    });
    return client.execute(
      init.body === undefined
        ? request
        : HttpClientRequest.bodyText(
            request,
            init.body,
            init.headers?.["content-type"] ?? "text/plain",
          ),
    );
  };
  const json = (path: string, body: unknown, scopes: string) =>
    call(
      path,
      {
        method: "POST",
        body: encodeJson(body),
        headers: { "content-type": "application/json" },
      },
      scopes,
    );
  const register = (upstreamBaseUrl: string, environmentId = "env-a") =>
    json(
      GATEWAY_UPSTREAMS_PATH,
      {
        environmentId,
        label: "Linux box",
        httpBaseUrl: upstreamBaseUrl,
        bearerToken: UPSTREAM_BEARER,
      },
      "admin",
    );
  return { host, call, json, register };
});

const openSocket = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
  });

const nextMessage = (socket: WebSocket) =>
  new Promise<string | ArrayBuffer>((resolve) => {
    socket.addEventListener("message", (event) => resolve(event.data as string | ArrayBuffer), {
      once: true,
    });
  });

const closed = (socket: WebSocket) =>
  new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));

const scoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.scoped(effect);

const Ticket = Schema.Struct({ ticket: Schema.String });
const Environments = Schema.Struct({
  environments: Schema.Array(Schema.Struct({ status: Schema.String })),
});

it.live("rejects unauthenticated callers and non-admin registration", () =>
  scoped(
    Effect.gen(function* () {
      const upstream = yield* startUpstream;
      const gateway = yield* startGateway;
      const input = {
        environmentId: "env-a",
        label: "Linux box",
        httpBaseUrl: upstream.baseUrl,
        bearerToken: UPSTREAM_BEARER,
      };
      expect((yield* gateway.json(GATEWAY_UPSTREAMS_PATH, input, "none")).status).toBe(401);
      expect((yield* gateway.json(GATEWAY_UPSTREAMS_PATH, input, "standard")).status).toBe(403);
      expect((yield* gateway.json(GATEWAY_UPSTREAMS_REMOVE_PATH, input, "standard")).status).toBe(
        403,
      );
      expect((yield* gateway.call(GATEWAY_ENVIRONMENTS_PATH)).status).toBe(401);
      yield* gateway.register(upstream.baseUrl);
      const forwarded = `${gatewayEnvironmentPath("env-a")}/echo/x`;
      expect((yield* gateway.call(forwarded)).status).toBe(401);
      expect((yield* gateway.call(forwarded, {}, "standard")).status).toBe(200);
      // A read-only host session may not borrow the upstream bearer for mutations.
      expect((yield* gateway.call(forwarded, { method: "POST" }, "read")).status).toBe(403);
      expect(upstream.seen.filter((request) => request.url.startsWith("/echo"))).toHaveLength(1);
    }),
  ),
);

it.live("forwards HTTP with the bearer injected and client credentials removed", () =>
  scoped(
    Effect.gen(function* () {
      const upstream = yield* startUpstream;
      const gateway = yield* startGateway;
      yield* gateway.register(`${upstream.baseUrl}/`);
      const response = yield* gateway.call(
        `${gatewayEnvironmentPath("env-a")}/echo/a%20b?x=1&wsTicket=${HOST_TICKET}`,
        {
          method: "POST",
          body: "payload",
          headers: {
            cookie: "host-session=1",
            dpop: "proof",
            authorization: "Bearer host-credential",
          },
        },
        "standard",
      );
      const text = yield* response.text;
      expect(text).toBe("POST /echo/a%20b?x=1 payload");
      expect(response.headers["set-cookie"]).toBeUndefined();
      const seen = upstream.seen.find((request) => request.url.startsWith("/echo"))!;
      expect(seen.headers.authorization).toBe(`Bearer ${UPSTREAM_BEARER}`);
      expect(seen.headers.cookie).toBeUndefined();
      expect(seen.headers.dpop).toBeUndefined();
      expect(encodeJson(Object.entries(response.headers)) + text).not.toContain(UPSTREAM_BEARER);
    }),
  ),
);

it.live("returns 404 for unknown environments", () =>
  scoped(
    Effect.gen(function* () {
      const gateway = yield* startGateway;
      const response = yield* gateway.call(
        `${gatewayEnvironmentPath("missing")}/echo/x`,
        {},
        "standard",
      );
      expect(response.status).toBe(404);
    }),
  ),
);

it.live("lists environments without URLs or credentials and reports reachability", () =>
  scoped(
    Effect.gen(function* () {
      const upstream = yield* startUpstream;
      const gateway = yield* startGateway;
      yield* gateway.register(upstream.baseUrl);
      // Nothing listens on port 1.
      yield* gateway.register("http://127.0.0.1:1", "env-down");
      const response = yield* gateway.call(GATEWAY_ENVIRONMENTS_PATH, {}, "read");
      const text = yield* response.text;
      expect(decodeJson(Schema.Unknown)(text)).toEqual({
        environments: [
          { environmentId: "env-a", label: "Linux box", status: "online" },
          { environmentId: "env-down", label: "Linux box", status: "offline" },
        ],
      });
      expect(text).not.toContain(UPSTREAM_BEARER);
      expect(text).not.toContain("127.0.0.1");
    }),
  ),
);

it.live("marks an upstream auth-failed after it rejects the bearer", () =>
  scoped(
    Effect.gen(function* () {
      const upstream = yield* startUpstream;
      const gateway = yield* startGateway;
      yield* gateway.json(
        GATEWAY_UPSTREAMS_PATH,
        {
          environmentId: "env-a",
          label: "Linux box",
          httpBaseUrl: upstream.baseUrl,
          bearerToken: "stale",
        },
        "admin",
      );
      // The stub rejects any bearer but its own on the ticket endpoint, which the gateway
      // reaches through the host ticket flow.
      const ticket = yield* gateway.call(
        `${gatewayEnvironmentPath("env-a")}/api/auth/websocket-ticket`,
        { method: "POST" },
        "standard",
      );
      expect(decodeJson(Ticket)(yield* ticket.text).ticket).toBe(HOST_TICKET);
      const socket = yield* Effect.promise(() =>
        openSocket(
          `ws://${gateway.host}${gatewayEnvironmentPath("env-a")}/ws?wsTicket=${HOST_TICKET}`,
        ).then(
          () => "open",
          () => "rejected",
        ),
      );
      expect(socket).toBe("rejected");
      const list = yield* gateway.call(GATEWAY_ENVIRONMENTS_PATH, {}, "read");
      expect(decodeJson(Environments)(yield* list.text).environments[0]?.status).toBe(
        "auth-failed",
      );
    }),
  ),
);

it.live("pipes WebSocket frames both ways and closes them when the upstream is removed", () =>
  scoped(
    Effect.gen(function* () {
      const upstream = yield* startUpstream;
      const gateway = yield* startGateway;
      yield* gateway.register(upstream.baseUrl);
      const ticketResponse = yield* gateway.call(
        `${gatewayEnvironmentPath("env-a")}/api/auth/websocket-ticket`,
        { method: "POST" },
        "standard",
      );
      const ticket = decodeJson(Ticket)(yield* ticketResponse.text);
      expect(ticket.ticket).toBe(HOST_TICKET);

      const socket = yield* Effect.promise(() =>
        openSocket(
          `ws://${gateway.host}${gatewayEnvironmentPath("env-a")}/ws?wsTicket=${ticket.ticket}&clientSurface=web`,
        ),
      );
      const text = nextMessage(socket);
      socket.send("hello");
      expect(yield* Effect.promise(() => text)).toBe("hello");
      const binary = nextMessage(socket);
      socket.send(new Uint8Array([1, 2, 3, 255]));
      const reply = yield* Effect.promise(() => binary);
      expect([...new Uint8Array(reply as ArrayBuffer)]).toEqual([1, 2, 3, 255]);

      const upgrade = upstream.seen.find((request) => request.url.startsWith("/ws"))!;
      const upstreamUrl = new URL(upgrade.url, "http://x");
      expect(upstreamUrl.searchParams.get("wsTicket")).toBe(UPSTREAM_TICKET);
      expect(upstreamUrl.searchParams.get("clientSurface")).toBe("web");
      expect(upgrade.headers.cookie).toBeUndefined();
      expect(upgrade.headers.origin).toBeUndefined();

      const closing = closed(socket);
      const removal = yield* gateway.json(
        GATEWAY_UPSTREAMS_REMOVE_PATH,
        { environmentId: "env-a" },
        "admin",
      );
      expect(removal.status).toBe(204);
      yield* Effect.promise(() => closing);

      const afterRemoval = yield* gateway.call(
        `${gatewayEnvironmentPath("env-a")}/echo/x`,
        {},
        "standard",
      );
      expect(afterRemoval.status).toBe(404);
    }),
  ),
);

it.live("forwards a compressed upstream body without its stale content-length", () =>
  scoped(
    Effect.gen(function* () {
      const upstream = yield* startUpstream;
      const gateway = yield* startGateway;
      yield* gateway.register(upstream.baseUrl);
      const response = yield* gateway.call(
        `${gatewayEnvironmentPath("env-a")}/gzipped`,
        {},
        "standard",
      );
      expect(response.status).toBe(200);
      expect(response.headers["content-length"]).not.toBe(
        String(NodeZlib.gzipSync(GZIPPED_JSON).byteLength),
      );
      expect(yield* response.text).toBe(GZIPPED_JSON);
    }),
  ),
);
