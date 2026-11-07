import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Environment gateway: a host server forwards the HTTP and WebSocket traffic of other
 * environments it can reach (an SSH-forwarded host, a Tailscale or LAN server) under
 * `GATEWAY_PATH_PREFIX/<environmentId>/`, so a phone connected to that host through the relay
 * can open them too. The host stores a credential for each upstream; clients of the host never
 * see it.
 */
export const GATEWAY_PATH_PREFIX = "/_gw";

/** Where a client of the host reaches the gateway-forwarded environment `environmentId`. */
export const gatewayEnvironmentPath = (environmentId: string): string =>
  `${GATEWAY_PATH_PREFIX}/${encodeURIComponent(environmentId)}`;

/** Registered by the desktop that owns the route to the upstream (admin scope on the host). */
export const GatewayUpstreamInput = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  /** The upstream's HTTP origin as the host reaches it, e.g. `http://127.0.0.1:41234`. */
  httpBaseUrl: TrimmedNonEmptyString,
  /** A standard-scope bearer session on the upstream, minted for the gateway alone. */
  bearerToken: TrimmedNonEmptyString,
});
export type GatewayUpstreamInput = typeof GatewayUpstreamInput.Type;

export const GatewayUpstreamRemoveInput = Schema.Struct({
  environmentId: EnvironmentId,
});
export type GatewayUpstreamRemoveInput = typeof GatewayUpstreamRemoveInput.Type;

export const GatewayEnvironmentStatus = Schema.Literals(["online", "offline", "auth-failed"]);
export type GatewayEnvironmentStatus = typeof GatewayEnvironmentStatus.Type;

/** What clients of the host see: never the upstream URL or credential. */
export const GatewayEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  status: GatewayEnvironmentStatus,
});
export type GatewayEnvironment = typeof GatewayEnvironment.Type;

export const GatewayEnvironmentList = Schema.Struct({
  environments: Schema.Array(GatewayEnvironment),
});
export type GatewayEnvironmentList = typeof GatewayEnvironmentList.Type;

/**
 * HTTP endpoints on the host (added to `EnvironmentHttpApi` by the server change):
 * - `GET  /api/gateway/environments`      → GatewayEnvironmentList (standard client scope)
 * - `POST /api/gateway/upstreams`         ← GatewayUpstreamInput (admin scope; upsert)
 * - `POST /api/gateway/upstreams/remove`  ← GatewayUpstreamRemoveInput (admin scope)
 * - `GATEWAY_PATH_PREFIX/<environmentId>/**` forwards HTTP and WebSocket to the upstream.
 */
export const GATEWAY_ENVIRONMENTS_PATH = "/api/gateway/environments";
export const GATEWAY_UPSTREAMS_PATH = "/api/gateway/upstreams";
export const GATEWAY_UPSTREAMS_REMOVE_PATH = "/api/gateway/upstreams/remove";
