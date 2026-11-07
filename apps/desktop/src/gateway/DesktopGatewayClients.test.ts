import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as Clients from "./DesktopGatewayClients.ts";

const BASE = "https://host.example.ts.net/";
const decodeJsonString = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const session = (sessionId: string, label: string, current = false) => ({
  sessionId,
  subject: "bearer",
  scopes: ["orchestration:read"],
  method: "bearer-access-token",
  client: { label, deviceType: "desktop" },
  issuedAt: "2026-11-07T00:00:00.000Z",
  expiresAt: "2026-11-08T00:00:00.000Z",
  lastConnectedAt: "2026-11-07T01:00:00.000Z",
  connected: false,
  current,
});

/** Serves the upstream auth API's real wire shape: DateTime fields are ISO strings. */
const fakeUpstream = () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array"
          ? decodeJsonString(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ method: request.method, path, body });
      const json = (value: unknown) =>
        HttpClientResponse.fromWeb(request, Response.json(value, { status: 200 }));
      switch (path) {
        case "/api/auth/session":
          return json({
            authenticated: true,
            auth: {
              policy: "loopback-browser",
              bootstrapMethods: ["one-time-token"],
              sessionMethods: ["bearer-access-token"],
              sessionCookieName: "t3_session",
            },
            scopes: ["orchestration:read", "access:read"],
            sessionMethod: "bearer-access-token",
            expiresAt: "2026-11-08T00:00:00.000Z",
          });
        case "/api/auth/pairing-token":
          return json({
            id: "pairing-1",
            credential: "minted-credential",
            label: "OOP Gateway",
            expiresAt: "2026-11-07T00:05:00.000Z",
          });
        case "/api/auth/clients":
          return json([
            session("s-gateway", "OOP Gateway phone"),
            session("s-other", "My laptop"),
            session("s-current", "OOP Gateway self", true),
          ]);
        default:
          return json({});
      }
    }),
  );
  return {
    requests,
    layer: Clients.upstreamLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
  };
};

const run = <A, E>(
  body: (
    upstream: Clients.DesktopGatewayUpstream["Service"],
    requests: ReturnType<typeof fakeUpstream>["requests"],
  ) => Effect.Effect<A, E>,
) => {
  const { requests, layer } = fakeUpstream();
  return Effect.gen(function* () {
    return yield* body(yield* Clients.DesktopGatewayUpstream, requests);
  }).pipe(Effect.provide(layer));
};

describe("DesktopGatewayUpstream over the wire", () => {
  it.effect("reads session scopes from a body with an ISO expiresAt", () =>
    run((upstream) =>
      Effect.gen(function* () {
        const scopes = yield* upstream.sessionScopes({ httpBaseUrl: BASE, bearerToken: "t" });
        assert.deepStrictEqual(scopes, ["orchestration:read", "access:read"]);
      }),
    ),
  );

  it.effect("mints a pairing credential from a body with an ISO expiresAt", () =>
    run((upstream) =>
      Effect.gen(function* () {
        const credential = yield* upstream.mintPairingCredential({
          httpBaseUrl: BASE,
          bearerToken: "t",
          scopes: ["orchestration:read"],
          label: "OOP Gateway",
        });
        assert.strictEqual(credential, "minted-credential");
      }),
    ),
  );

  it.effect("revokes only other sessions carrying the gateway label", () =>
    run((upstream, requests) =>
      Effect.gen(function* () {
        yield* upstream.revokeGatewaySessions({
          httpBaseUrl: BASE,
          bearerToken: "t",
          label: Clients.GATEWAY_SESSION_LABEL,
        });
        const revokes = requests.filter((entry) => entry.path === "/api/auth/clients/revoke");
        assert.deepStrictEqual(
          revokes.map((entry) => entry.body),
          [{ sessionId: "s-gateway" }],
        );
      }),
    ),
  );
});
