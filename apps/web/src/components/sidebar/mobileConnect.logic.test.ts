import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mobileConnectEndpoints, mobileConnectQrValue } from "./mobileConnect.logic";

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

describe("mobileConnectQrValue", () => {
  const pairingUrl = "http://192.168.0.163:3773/pair#token=ABC123";

  it("leaves the pairing URL untouched for the mobile web", () => {
    expect(mobileConnectQrValue(pairingUrl, "mobile-web")).toBe(pairingUrl);
  });

  it("wraps the pairing URL in the app's connect link", () => {
    expect(mobileConnectQrValue(pairingUrl, "oop-app")).toBe(
      "oop://connect?url=http%3A%2F%2F192.168.0.163%3A3773%2Fpair%23token%3DABC123",
    );
  });

  it("round-trips the pairing URL, fragment included", () => {
    const relayUrl = "https://relay.example.com/pair#token=ABC123";
    const link = new URL(mobileConnectQrValue(relayUrl, "oop-app"));
    expect(link.searchParams.get("url")).toBe(relayUrl);
  });
});
