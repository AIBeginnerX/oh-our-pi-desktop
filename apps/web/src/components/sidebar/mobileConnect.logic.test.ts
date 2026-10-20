import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mobileConnectEndpoints } from "./mobileConnect.logic";

function endpoint(
  id: string,
  reachability: AdvertisedEndpoint["reachability"],
  status: AdvertisedEndpoint["status"] = "available",
): AdvertisedEndpoint {
  return {
    id,
    label: id,
    provider: { id: "core", label: "Core", kind: "core", isAddon: false },
    httpBaseUrl: `http://${id}:3773`,
    wsBaseUrl: `ws://${id}:3773`,
    reachability,
    compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
    source: "desktop-core",
    status,
  };
}

describe("mobileConnectEndpoints", () => {
  it("drops endpoints a phone cannot reach and prefers routes that work away from home", () => {
    const result = mobileConnectEndpoints([
      endpoint("loopback", "loopback"),
      endpoint("lan", "lan"),
      endpoint("tailscale-off", "private-network", "unavailable"),
      endpoint("tailscale", "private-network"),
      endpoint("tunnel", "public"),
      endpoint("unverified-forward", "public", "unknown"),
    ]);

    expect(result.map((candidate) => candidate.id)).toEqual([
      "tunnel",
      "tailscale",
      "lan",
      "unverified-forward",
    ]);
  });
});
