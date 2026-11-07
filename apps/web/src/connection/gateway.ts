import {
  GatewayConnectionRegistration,
  GatewayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  GATEWAY_ENVIRONMENTS_PATH,
  GatewayEnvironmentList,
  gatewayEnvironmentPath,
  type GatewayEnvironment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const GATEWAY_LIST_TIMEOUT = "10 seconds";
const decodeGatewayEnvironmentList = Schema.decodeUnknownEffect(GatewayEnvironmentList);

class GatewayListStatusError extends Schema.TaggedError<GatewayListStatusError>()(
  "GatewayListStatusError",
  { status: Schema.Number },
) {
  override get message(): string {
    return `Gateway environment list returned HTTP ${this.status}.`;
  }
}

/**
 * The environments the host forwards for this client. An older host without the gateway
 * answers 404, which means "none"; any other failure fails so the caller can keep the list it
 * already has.
 */
export const fetchGatewayEnvironments = Effect.fn("web.connectionGateway.fetchEnvironments")(
  function* (hostOrigin: string) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(HttpClientRequest.get(new URL(GATEWAY_ENVIRONMENTS_PATH, hostOrigin).toString()))
      .pipe(Effect.timeout(GATEWAY_LIST_TIMEOUT));
    if (response.status === 404) {
      return [] satisfies ReadonlyArray<GatewayEnvironment>;
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new GatewayListStatusError({ status: response.status });
    }
    const body = yield* response.json;
    return (yield* decodeGatewayEnvironmentList(body)).environments;
  },
);

/**
 * One platform registration per forwarded environment. Environments this client already
 * registers itself (`skipEnvironmentIds`) are left out; the registry also refuses to let a
 * gateway entry displace a saved one.
 */
export function gatewayRegistrations(input: {
  readonly environments: ReadonlyArray<GatewayEnvironment>;
  readonly hostOrigin: string;
  readonly skipEnvironmentIds: ReadonlySet<string>;
}): ReadonlyArray<GatewayConnectionRegistration> {
  const seen = new Set(input.skipEnvironmentIds);
  const registrations: Array<GatewayConnectionRegistration> = [];
  for (const environment of input.environments) {
    if (seen.has(environment.environmentId)) continue;
    seen.add(environment.environmentId);
    registrations.push(
      new GatewayConnectionRegistration({
        target: new GatewayConnectionTarget({
          environmentId: environment.environmentId,
          label: environment.label,
          httpBaseUrl: new URL(
            gatewayEnvironmentPath(environment.environmentId),
            input.hostOrigin,
          ).toString(),
        }),
      }),
    );
  }
  return registrations;
}
