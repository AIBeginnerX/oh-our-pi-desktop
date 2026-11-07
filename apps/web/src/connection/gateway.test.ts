import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { EnvironmentId } from "@t3tools/contracts";
import { describe as effectDescribe, expect as effectExpect, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { fetchGatewayEnvironments, gatewayRegistrations } from "./gateway";

const HOST = "https://phone-host.example.test";

function listFrom(response: () => Response) {
  const requested: Array<string> = [];
  const fetchFn = ((input: Parameters<typeof fetch>[0]) => {
    requested.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(response());
  }) satisfies typeof fetch;
  return {
    requested,
    fetch: fetchGatewayEnvironments(HOST).pipe(Effect.provide(remoteHttpClientLayer(fetchFn))),
  };
}

effectDescribe("fetchGatewayEnvironments", () => {
  effectIt.effect("reads the host's list", () =>
    Effect.gen(function* () {
      const source = listFrom(() =>
        Response.json({
          environments: [
            { environmentId: "env-linux", label: "Linux box", status: "online" },
            { environmentId: "env-nas", label: "NAS", status: "auth-failed" },
          ],
        }),
      );

      effectExpect(yield* source.fetch).toEqual([
        { environmentId: "env-linux", label: "Linux box", status: "online" },
        { environmentId: "env-nas", label: "NAS", status: "auth-failed" },
      ]);
      effectExpect(source.requested).toEqual([`${HOST}/api/gateway/environments`]);
    }),
  );

  effectIt.effect("treats a host without the gateway (404) as having none", () =>
    Effect.gen(function* () {
      const source = listFrom(() => new Response("not found", { status: 404 }));
      effectExpect(yield* source.fetch).toEqual([]);
    }),
  );

  effectIt.effect("fails on other errors so the caller keeps its current list", () =>
    Effect.gen(function* () {
      const serverError = yield* Effect.flip(
        listFrom(() => new Response("nope", { status: 500 })).fetch,
      );
      effectExpect(serverError).toMatchObject({ _tag: "GatewayListStatusError", status: 500 });
      yield* Effect.flip(listFrom(() => Response.json({ unexpected: true })).fetch);
    }),
  );
});

describe("gatewayRegistrations", () => {
  const environments = [
    { environmentId: EnvironmentId.make("env/one two"), label: "One", status: "online" },
    { environmentId: EnvironmentId.make("env-direct"), label: "Direct", status: "offline" },
    { environmentId: EnvironmentId.make("env-three"), label: "Three", status: "online" },
  ] as const;

  it("builds a gateway target per environment under the host origin with encoded ids", () => {
    const registrations = gatewayRegistrations({
      environments,
      hostOrigin: HOST,
      skipEnvironmentIds: new Set(),
    });

    expect(registrations.map((registration) => registration.target.httpBaseUrl)).toEqual([
      `${HOST}/_gw/env%2Fone%20two`,
      `${HOST}/_gw/env-direct`,
      `${HOST}/_gw/env-three`,
    ]);
    expect(registrations[0]?.target.label).toBe("One");
  });

  it("skips environments the client registers directly", () => {
    const registrations = gatewayRegistrations({
      environments,
      hostOrigin: HOST,
      skipEnvironmentIds: new Set(["env-direct"]),
    });

    expect(registrations.map((registration) => registration.target.environmentId)).toEqual([
      "env/one two",
      "env-three",
    ]);
  });

  it("registers nothing for an empty list, which removes earlier entries on reconcile", () => {
    expect(
      gatewayRegistrations({ environments: [], hostOrigin: HOST, skipEnvironmentIds: new Set() }),
    ).toEqual([]);
  });
});
