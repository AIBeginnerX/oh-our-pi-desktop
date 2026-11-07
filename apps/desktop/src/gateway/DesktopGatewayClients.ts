import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import {
  AuthClientSession,
  AuthPairingCredentialResult,
  AuthSessionState,
  GATEWAY_ENVIRONMENTS_PATH,
  GATEWAY_UPSTREAMS_PATH,
  GATEWAY_UPSTREAMS_REMOVE_PATH,
  GatewayEnvironmentList,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type AuthEnvironmentScope,
  type GatewayEnvironmentStatus,
  type GatewayUpstreamInput,
  type GatewayUpstreamRemoveInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";

export class DesktopGatewayError extends Schema.TaggedError<DesktopGatewayError>()(
  "DesktopGatewayError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const isDesktopGatewayError = Schema.is(DesktopGatewayError);

/** Label every gateway-owned upstream session starts with, so stale ones can be found and revoked. */
export const GATEWAY_SESSION_LABEL = "OOP Gateway";

/** The desktop's own backend (the host phones connect to), reached with the desktop's admin session. */
export class DesktopGatewayHost extends Context.Service<
  DesktopGatewayHost,
  {
    /** Identifies the running local backend; changes when it restarts. None while it is not up. */
    readonly hostKey: Effect.Effect<Option.Option<string>>;
    readonly upsert: (input: GatewayUpstreamInput) => Effect.Effect<void, DesktopGatewayError>;
    readonly remove: (
      input: GatewayUpstreamRemoveInput,
    ) => Effect.Effect<void, DesktopGatewayError>;
    readonly statuses: Effect.Effect<
      ReadonlyMap<string, GatewayEnvironmentStatus>,
      DesktopGatewayError
    >;
  }
>()("@t3tools/desktop/gateway/DesktopGatewayClients/DesktopGatewayHost") {}

/** The auth API of one upstream environment, as reachable from this computer. */
export class DesktopGatewayUpstream extends Context.Service<
  DesktopGatewayUpstream,
  {
    /** Exchanges a pairing credential for a bearer session limited to `scopes`. */
    readonly exchange: (input: {
      readonly httpBaseUrl: string;
      readonly credential: string;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly label: string;
    }) => Effect.Effect<
      { readonly accessToken: string; readonly scopes: ReadonlyArray<string> },
      DesktopGatewayError
    >;
    /** Asks an administrative bearer session for a pairing credential limited to `scopes`. */
    readonly mintPairingCredential: (input: {
      readonly httpBaseUrl: string;
      readonly bearerToken: string;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly label: string;
    }) => Effect.Effect<string, DesktopGatewayError>;
    readonly sessionScopes: (input: {
      readonly httpBaseUrl: string;
      readonly bearerToken: string;
    }) => Effect.Effect<ReadonlyArray<string>, DesktopGatewayError>;
    /** Revokes every session whose label starts with `label`, except the caller's own. */
    readonly revokeGatewaySessions: (input: {
      readonly httpBaseUrl: string;
      readonly bearerToken: string;
      readonly label: string;
    }) => Effect.Effect<void, DesktopGatewayError>;
  }
>()("@t3tools/desktop/gateway/DesktopGatewayClients/DesktopGatewayUpstream") {}

const toGatewayError = (what: string) => (cause: unknown) =>
  isDesktopGatewayError(cause)
    ? cause
    : new DesktopGatewayError({ message: `${what} failed.`, cause });

const authed = (base: string, path: string, bearerToken: string, method: "GET" | "POST") =>
  (method === "GET" ? HttpClientRequest.get : HttpClientRequest.post)(
    new URL(path, base).toString(),
  ).pipe(HttpClientRequest.bearerToken(bearerToken));

const send = (what: string, request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request);
    if (response.status < 200 || response.status >= 300) {
      return yield* new DesktopGatewayError({
        message: `${what} failed (HTTP ${response.status}).`,
      });
    }
    return response;
  }).pipe(Effect.timeout("15 seconds"), Effect.mapError(toGatewayError(what)));

/** Decodes through the JSON codec: wire bodies carry DateTimeUtc fields as ISO strings. */
const sendJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  what: string,
  schema: S,
  request: HttpClientRequest.HttpClientRequest,
) =>
  send(what, request).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(schema))),
    Effect.mapError(toGatewayError(what)),
  ) as Effect.Effect<S["Type"], DesktopGatewayError, HttpClient.HttpClient>;

export const upstreamLayer = Layer.effect(
  DesktopGatewayUpstream,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const provide = <A>(effect: Effect.Effect<A, DesktopGatewayError, HttpClient.HttpClient>) =>
      effect.pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    return DesktopGatewayUpstream.of({
      exchange: ({ httpBaseUrl, credential, scopes, label }) =>
        bootstrapRemoteBearerSession({
          httpBaseUrl,
          credential,
          scopes,
          clientMetadata: { label, deviceType: "desktop" },
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.mapError(toGatewayError("Gateway session exchange")),
          Effect.map((session) => ({
            accessToken: session.access_token,
            scopes: session.scope.split(/\s+/u).filter((scope) => scope.length > 0),
          })),
        ),
      mintPairingCredential: ({ httpBaseUrl, bearerToken, scopes, label }) =>
        provide(
          sendJson(
            "Gateway pairing credential",
            AuthPairingCredentialResult,
            authed(httpBaseUrl, "/api/auth/pairing-token", bearerToken, "POST").pipe(
              HttpClientRequest.bodyJsonUnsafe({ label, scopes }),
            ),
          ),
        ).pipe(Effect.map((result) => result.credential)),
      sessionScopes: ({ httpBaseUrl, bearerToken }) =>
        provide(
          sendJson(
            "Upstream session lookup",
            AuthSessionState,
            authed(httpBaseUrl, "/api/auth/session", bearerToken, "GET"),
          ),
        ).pipe(Effect.map((state) => state.scopes ?? [])),
      revokeGatewaySessions: ({ httpBaseUrl, bearerToken, label }) =>
        provide(
          Effect.gen(function* () {
            const sessions = yield* sendJson(
              "Upstream client list",
              Schema.Array(AuthClientSession),
              authed(httpBaseUrl, "/api/auth/clients", bearerToken, "GET"),
            );
            for (const session of sessions) {
              if (session.current || !session.client.label?.startsWith(label)) {
                continue;
              }
              yield* send(
                "Gateway session revoke",
                authed(httpBaseUrl, "/api/auth/clients/revoke", bearerToken, "POST").pipe(
                  HttpClientRequest.bodyJsonUnsafe({ sessionId: session.sessionId }),
                ),
              );
            }
          }),
        ),
    });
  }),
);

export const hostLayer = Layer.effect(
  DesktopGatewayHost,
  Effect.gen(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
    const httpClient = yield* HttpClient.HttpClient;

    const primaryConfig = Effect.gen(function* () {
      const instance = (yield* pool.list).find(
        (entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID,
      );
      return instance === undefined ? Option.none() : yield* instance.currentConfig;
    });
    // Every call carries the desktop's own admin session on its backend.
    const call = (
      what: string,
      path: string,
      method: "GET" | "POST",
      body?: GatewayUpstreamInput | GatewayUpstreamRemoveInput,
    ) =>
      Effect.gen(function* () {
        const config = yield* primaryConfig;
        if (Option.isNone(config)) {
          return yield* new DesktopGatewayError({ message: "The local backend is not running." });
        }
        const token = yield* auth.getBearerToken.pipe(
          Effect.mapError((cause) => new DesktopGatewayError({ message: cause.message, cause })),
        );
        const request = authed(config.value.httpBaseUrl.href, path, token, method);
        return yield* send(
          what,
          body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, body),
        );
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

    return DesktopGatewayHost.of({
      hostKey: primaryConfig.pipe(
        Effect.map(
          Option.map(
            (config) =>
              `${config.httpBaseUrl.href}|${config.bootstrap.desktopBootstrapToken ?? ""}`,
          ),
        ),
      ),
      upsert: (input) =>
        call("Gateway upstream publish", GATEWAY_UPSTREAMS_PATH, "POST", input).pipe(Effect.asVoid),
      remove: (input) =>
        call("Gateway upstream removal", GATEWAY_UPSTREAMS_REMOVE_PATH, "POST", input).pipe(
          Effect.asVoid,
        ),
      statuses: call("Gateway status", GATEWAY_ENVIRONMENTS_PATH, "GET").pipe(
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(GatewayEnvironmentList)),
            Effect.mapError(toGatewayError("Gateway status")),
          ),
        ),
        Effect.map(
          (list) =>
            new Map(
              list.environments.map((entry) => [entry.environmentId, entry.status]),
            ) as ReadonlyMap<string, GatewayEnvironmentStatus>,
        ),
      ),
    });
  }),
);
