/**
 * Environment gateway: forwards HTTP and WebSocket traffic under `/_gw/<environmentId>/` to
 * other environments the desktop registered (see `packages/contracts/src/gateway.ts`).
 *
 * Upstreams live in memory only. The desktop owns the route to each one (an SSH `-L` forward
 * binds the desktop's loopback, with a port that changes per connection), so a stored entry
 * would go stale across restarts while the desktop republishes fresh ones on start.
 *
 * Clients authenticate to this host only. Every forwarded request has the client's credentials
 * stripped and the upstream bearer injected, and the bearer never appears in a response.
 */
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthWebSocketTicketResult,
  GATEWAY_ENVIRONMENTS_PATH,
  GATEWAY_PATH_PREFIX,
  GATEWAY_UPSTREAMS_PATH,
  GATEWAY_UPSTREAMS_REMOVE_PATH,
  GatewayEnvironmentList,
  GatewayUpstreamInput,
  GatewayUpstreamRemoveInput,
  type AuthEnvironmentScope,
  type GatewayEnvironment,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";

const STATUS_CACHE_MS = 15_000;
const PROBE_TIMEOUT = "3 seconds";
const ENVIRONMENT_PROBE_PATH = "/.well-known/t3/environment";
const WEBSOCKET_TICKET_PATH = "/api/auth/websocket-ticket";

interface Upstream {
  readonly environmentId: GatewayEnvironment["environmentId"];
  label: GatewayEnvironment["label"];
  httpBaseUrl: string;
  bearerToken: string;
  /** Completed when the upstream is removed or moves, which closes its open sockets. */
  revoked: Deferred.Deferred<void>;
  /** The last forwarded request was rejected by the upstream's auth. */
  authFailed: boolean;
  probe: { readonly at: number; readonly reachable: boolean } | undefined;
}

export interface ResolvedUpstream {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly revoked: Deferred.Deferred<void>;
  /** Record whether the upstream accepted the bearer, for `auth-failed` status. */
  readonly noteStatus: (status: number) => Effect.Effect<void>;
}

export class GatewayUpstreams extends Context.Service<
  GatewayUpstreams,
  {
    readonly upsert: (input: GatewayUpstreamInput) => Effect.Effect<void>;
    readonly remove: (environmentId: string) => Effect.Effect<void>;
    readonly list: Effect.Effect<GatewayEnvironmentList>;
    readonly resolve: (environmentId: string) => Effect.Effect<Option.Option<ResolvedUpstream>>;
  }
>()("t3/gateway/Gateway/GatewayUpstreams") {}

/** Origin plus path without a trailing slash; null when it is not an http(s) URL. */
export const normalizeUpstreamBaseUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
};

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const upstreams = new Map<string, Upstream>();

  const probe = (upstream: Upstream) =>
    Effect.scoped(
      httpClient.get(`${upstream.httpBaseUrl}${ENVIRONMENT_PROBE_PATH}`).pipe(
        Effect.map((response) => response.status < 500),
        Effect.timeout(PROBE_TIMEOUT),
        Effect.orElseSucceed(() => false),
      ),
    ).pipe(
      Effect.tap((reachable) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((at) => {
            upstream.probe = { at, reachable };
          }),
        ),
      ),
    );

  return GatewayUpstreams.of({
    upsert: (input) =>
      Effect.gen(function* () {
        const httpBaseUrl = normalizeUpstreamBaseUrl(input.httpBaseUrl) ?? input.httpBaseUrl;
        const existing = upstreams.get(input.environmentId);
        if (existing && existing.httpBaseUrl === httpBaseUrl) {
          existing.label = input.label;
          existing.authFailed = existing.bearerToken === input.bearerToken && existing.authFailed;
          existing.bearerToken = input.bearerToken;
          return;
        }
        // A moved route invalidates sockets opened through the old one.
        if (existing) yield* Deferred.succeed(existing.revoked, undefined);
        upstreams.set(input.environmentId, {
          environmentId: input.environmentId,
          label: input.label,
          httpBaseUrl,
          bearerToken: input.bearerToken,
          revoked: yield* Deferred.make<void>(),
          authFailed: false,
          probe: undefined,
        });
      }),
    remove: (environmentId) =>
      Effect.gen(function* () {
        const existing = upstreams.get(environmentId);
        if (!existing) return;
        upstreams.delete(environmentId);
        yield* Deferred.succeed(existing.revoked, undefined);
      }),
    list: Effect.gen(function* () {
      const entries = [...upstreams.values()];
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(
        entries,
        (upstream) =>
          upstream.probe && now - upstream.probe.at < STATUS_CACHE_MS
            ? Effect.void
            : probe(upstream),
        { concurrency: "unbounded", discard: true },
      );
      return {
        environments: entries.map((upstream) => ({
          environmentId: upstream.environmentId,
          label: upstream.label,
          status: !upstream.probe?.reachable
            ? ("offline" as const)
            : upstream.authFailed
              ? ("auth-failed" as const)
              : ("online" as const),
        })),
      };
    }),
    resolve: (environmentId) =>
      Effect.sync(() => {
        const upstream = upstreams.get(environmentId);
        if (!upstream) return Option.none();
        return Option.some<ResolvedUpstream>({
          httpBaseUrl: upstream.httpBaseUrl,
          bearerToken: upstream.bearerToken,
          revoked: upstream.revoked,
          noteStatus: (status) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((at) => {
                if (status === 401) upstream.authFailed = true;
                else if (status < 500) upstream.authFailed = false;
                // Any answer below 500 proves the route is up, which saves a probe.
                if (status < 500) upstream.probe = { at, reachable: true };
              }),
            ),
        });
      }),
  });
});

export const upstreamsLayer = Layer.effect(GatewayUpstreams, make);

const authenticate = (requiredScope: AuthEnvironmentScope, mode: "http" | "upgrade" = "http") =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    // The upgrade authenticator also accepts a host `wsTicket`, which `<img>` and WebSocket
    // need because they cannot set headers.
    const session = yield* (
      mode === "upgrade"
        ? serverAuth.authenticateWebSocketUpgrade(request)
        : serverAuth.authenticateHttpRequest(request)
    ).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (EnvironmentAuth.isServerAuthCredentialError(error)) {
            return yield* failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            );
          }
          return yield* failEnvironmentInternal("internal_error", error);
        }),
      ),
    );
    if (!session.scopes.includes(requiredScope)) {
      return yield* failEnvironmentScopeRequired(requiredScope);
    }
    return session;
  });

const noContent = () => HttpServerResponse.empty({ status: 204 });
const badRequest = () => HttpServerResponse.text("Bad Request", { status: 400 });
const notFound = () => HttpServerResponse.text("Not Found", { status: 404 });
const badGateway = () => HttpServerResponse.text("Bad Gateway", { status: 502 });

const readJsonBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* request.json;
});

const decodeUpstreamInput = Schema.decodeUnknownEffect(GatewayUpstreamInput);
const decodeUpstreamRemoveInput = Schema.decodeUnknownEffect(GatewayUpstreamRemoveInput);
const encodeEnvironmentList = Schema.encodeEffect(GatewayEnvironmentList);
const encodeWebSocketTicket = Schema.encodeEffect(AuthWebSocketTicketResult);
const decodeUpstreamTicket = Schema.decodeUnknownEffect(Schema.Struct({ ticket: Schema.String }));

const upsertRoute = HttpRouter.add(
  "POST",
  GATEWAY_UPSTREAMS_PATH,
  Effect.gen(function* () {
    yield* authenticate(AuthAccessWriteScope);
    const input = yield* readJsonBody.pipe(Effect.flatMap(decodeUpstreamInput), Effect.option);
    if (Option.isNone(input) || normalizeUpstreamBaseUrl(input.value.httpBaseUrl) === null) {
      return badRequest();
    }
    yield* (yield* GatewayUpstreams).upsert(input.value);
    return noContent();
  }),
);

const removeRoute = HttpRouter.add(
  "POST",
  GATEWAY_UPSTREAMS_REMOVE_PATH,
  Effect.gen(function* () {
    yield* authenticate(AuthAccessWriteScope);
    const input = yield* readJsonBody.pipe(
      Effect.flatMap(decodeUpstreamRemoveInput),
      Effect.option,
    );
    if (Option.isNone(input)) return badRequest();
    yield* (yield* GatewayUpstreams).remove(input.value.environmentId);
    return noContent();
  }),
);

const listRoute = HttpRouter.add(
  "GET",
  GATEWAY_ENVIRONMENTS_PATH,
  Effect.gen(function* () {
    yield* authenticate(AuthOrchestrationReadScope);
    const list = yield* (yield* GatewayUpstreams).list;
    return HttpServerResponse.jsonUnsafe(yield* encodeEnvironmentList(list).pipe(Effect.orDie), {
      headers: { "cache-control": "no-store" },
    });
  }),
);

/** Credentials and hop-by-hop headers that must not cross the gateway. */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
  "referer",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

// The HttpClient (fetch) decodes the upstream body, so the upstream's encoding and length no
// longer describe what is streamed to the client; a stale content-length truncates the body.
const DROPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

const forwardHeaders = (
  request: HttpServerRequest.HttpServerRequest,
  upstream: ResolvedUpstream,
) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  // The upstream sees this host as its client, so a browser Origin would never match it.
  if (request.headers.origin !== undefined) headers.origin = new URL(upstream.httpBaseUrl).origin;
  headers.authorization = `Bearer ${upstream.bearerToken}`;
  return headers;
};

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

const proxyHttp = Effect.fn("Gateway.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstream: ResolvedUpstream,
  upstreamUrl: string,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method;
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(forwardHeaders(request, upstream)),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream),
  );
  const response = yield* httpClient.execute(upstreamRequest);
  yield* upstream.noteStatus(response.status);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (!DROPPED_RESPONSE_HEADERS.has(name) && value !== undefined) headers[name] = value;
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

/**
 * Sockets authenticate to the upstream with a ticket the gateway mints from the bearer: a
 * WebSocket cannot carry the bearer header, and the ticket path skips the browser Origin check.
 */
const mintUpstreamTicket = (upstream: ResolvedUpstream) =>
  Effect.gen(function* () {
    const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
    const response = yield* httpClient.execute(
      HttpClientRequest.post(`${upstream.httpBaseUrl}${WEBSOCKET_TICKET_PATH}`).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${upstream.bearerToken}`),
      ),
    );
    yield* upstream.noteStatus(response.status);
    if (response.status !== 200) return yield* Effect.fail("ticket rejected" as const);
    const body = yield* response.json;
    return yield* decodeUpstreamTicket(body);
  }).pipe(Effect.map((result) => result.ticket));

const pumpFrames = (reader: Socket.Reader, sink: Socket.Writer) =>
  Effect.gen(function* () {
    while (true) {
      yield* sink.writeAll(yield* reader.pull);
    }
  });

/** Frames are opaque: nothing is parsed or re-encoded, and either side closing ends both. */
const proxyWebSocket = Effect.fn("Gateway.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstream: ResolvedUpstream,
  upstreamUrl: string,
) {
  const ticket = yield* mintUpstreamTicket(upstream);
  const target = new URL(upstreamUrl);
  target.searchParams.set("wsTicket", ticket);
  const upstreamSocket = yield* Socket.makeWebSocket(target.toString(), {
    openTimeout: "10 seconds",
  }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
  // Acquiring the reader dials, so a dead upstream still answers 502 before the client upgrades.
  const upstreamReader = yield* upstreamSocket.reader;
  const client = yield* request.upgrade;
  const clientReader = yield* client.reader;
  const writeToClient = yield* client.writer;
  const writeToUpstream = yield* upstreamSocket.writer;
  yield* Effect.raceAll([
    pumpFrames(upstreamReader, writeToClient),
    pumpFrames(clientReader, writeToUpstream),
    Deferred.await(upstream.revoked),
  ]).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const gatewayRoute = HttpRouter.add(
  "*",
  `${GATEWAY_PATH_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return badRequest();
    const upgrade = isWebSocketUpgrade(request);
    const readOnly = request.method === "GET" || request.method === "HEAD";
    // The upstream bearer is a standard-scope session, so the host session must be able to
    // operate to borrow it; the upstream still enforces its own scopes per request.
    const session = yield* authenticate(
      readOnly && !upgrade ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope,
      "upgrade",
    );

    const match = /^\/([^/]+)(\/.*)?$/.exec(url.value.pathname.slice(GATEWAY_PATH_PREFIX.length));
    if (!match) return notFound();
    const environmentId = (() => {
      try {
        return decodeURIComponent(match[1]!);
      } catch {
        return null;
      }
    })();
    const upstreamPath = match[2] ?? "/";
    const upstream =
      environmentId === null
        ? Option.none<ResolvedUpstream>()
        : yield* (yield* GatewayUpstreams).resolve(environmentId);
    if (Option.isNone(upstream)) return notFound();

    // Clients ask the gateway for a socket ticket like any bearer environment, but a ticket
    // minted by the upstream could not be verified here. Hand out a host ticket instead; the
    // gateway swaps in an upstream one when it dials.
    if (request.method === "POST" && upstreamPath === WEBSOCKET_TICKET_PATH) {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* serverAuth
        .issueWebSocketTicket(session)
        .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
      return HttpServerResponse.jsonUnsafe(
        yield* encodeWebSocketTicket(issued).pipe(Effect.orDie),
        {
          headers: { "cache-control": "no-store" },
        },
      );
    }

    // The host ticket authenticated this request and must not travel on.
    const search = new URLSearchParams(url.value.search);
    search.delete("wsTicket");
    const query = search.size > 0 ? `?${search.toString()}` : "";
    const base = upstream.value.httpBaseUrl;
    if (upgrade) {
      return yield* proxyWebSocket(
        request,
        upstream.value,
        `${base.replace(/^http/, "ws")}${upstreamPath}${query}`,
      ).pipe(Effect.orElseSucceed(badGateway));
    }
    return yield* proxyHttp(request, upstream.value, `${base}${upstreamPath}${query}`).pipe(
      Effect.orElseSucceed(badGateway),
    );
  }),
);

export const gatewayRoutesLayer = Layer.mergeAll(upsertRoute, removeRoute, listRoute, gatewayRoute);
