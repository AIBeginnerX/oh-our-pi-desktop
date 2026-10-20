import type { AdvertisedEndpoint, AdvertisedEndpointReachability } from "@t3tools/contracts";

import { isQrShareableEndpoint } from "../settings/ConnectionsSettings.logic";

const REACHABILITY_RANK: Record<AdvertisedEndpointReachability, number> = {
  public: 0,
  "private-network": 1,
  lan: 2,
  loopback: 3,
};

/**
 * Endpoints a phone browser can open, best first: public and private-network
 * routes keep working away from home, LAN only on the same Wi-Fi. Unconfirmed
 * routes (a port forward nobody has verified) sort after confirmed ones. Loopback
 * and unavailable endpoints never qualify because a scanning phone cannot reach them.
 */
export function mobileConnectEndpoints(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
): ReadonlyArray<AdvertisedEndpoint> {
  const rank = (endpoint: AdvertisedEndpoint) =>
    (endpoint.status === "available" ? 0 : 10) + REACHABILITY_RANK[endpoint.reachability];
  return endpoints
    .filter(isQrShareableEndpoint)
    .toSorted((left, right) => rank(left) - rank(right));
}

export function mobileEndpointHint(endpoint: AdvertisedEndpoint): string {
  switch (endpoint.reachability) {
    case "public":
      return "Works anywhere with internet";
    case "private-network":
      return `Works anywhere while ${endpoint.provider.label} is on for both devices`;
    case "lan":
    case "loopback":
      return "Phone must be on the same Wi-Fi";
  }
}
