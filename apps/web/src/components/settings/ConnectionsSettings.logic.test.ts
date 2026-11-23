import type { AdvertisedEndpoint, DesktopWslState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { parseManualDesktopSshTarget } from "./ConnectionsSettings.helpers";
import {
  applyWslEnableSelection,
  isSavedSshHostSuggestion,
  findSshHostSuggestion,
  isQrShareableEndpoint,
  isWslSettingsRowVisible,
  selectQrEndpointOption,
  sshHostSuggestionKey,
} from "./ConnectionsSettings.logic";
import { formatDesktopSshTarget } from "./EnvironmentRow";

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("isWslSettingsRowVisible", () => {
  it("shows the retry row when the WSL state failed to load", () => {
    expect(isWslSettingsRowVisible({ state: null, error: "load failed" })).toBe(true);
  });

  it("hides an unavailable and unused WSL snapshot", () => {
    expect(
      isWslSettingsRowVisible({
        state: { ...baseWslState, available: false, wslOnly: false },
        error: null,
      }),
    ).toBe(false);
  });

  it("shows an available WSL snapshot", () => {
    expect(isWslSettingsRowVisible({ state: baseWslState, error: null })).toBe(true);
  });
});

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });

  it("stages WSL-only before enabling without rewriting an unchanged distro", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = false;
    const setWslDistro = vi.fn(async () => baseWslState);
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, wslOnly: enabled };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return { ...baseWslState, enabled, wslOnly: persistedWslOnly };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "wsl-only",
      nextDistro: null,
      persistedDistro: null,
    });

    expect(calls).toEqual(["setWslOnly:true", "setWslBackendEnabled:true"]);
    expect(setWslDistro).not.toHaveBeenCalled();
    expect(state).toMatchObject({ enabled: true, wslOnly: true });
  });
});

function makeEndpoint(overrides: Partial<AdvertisedEndpoint>): AdvertisedEndpoint {
  return {
    id: "desktop-lan:http://192.168.1.42:4780",
    label: "Local network",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: "http://192.168.1.42:4780",
    wsBaseUrl: "ws://192.168.1.42:4780",
    reachability: "lan",
    compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  };
}

describe("isQrShareableEndpoint", () => {
  it("excludes loopback endpoints so a scanned phone never dials itself", () => {
    expect(
      isQrShareableEndpoint(
        makeEndpoint({
          id: "desktop-loopback:4780",
          reachability: "loopback",
          httpBaseUrl: "http://127.0.0.1:4780",
        }),
      ),
    ).toBe(false);
  });

  it("excludes unavailable endpoints and keeps reachable ones", () => {
    expect(isQrShareableEndpoint(makeEndpoint({ status: "unavailable" }))).toBe(false);
    expect(isQrShareableEndpoint(makeEndpoint({}))).toBe(true);
    expect(
      isQrShareableEndpoint(makeEndpoint({ reachability: "private-network", status: "unknown" })),
    ).toBe(true);
  });
});

describe("selectQrEndpointOption", () => {
  const options = [
    {
      id: "desktop-loopback:4780",
      preferenceKey: "desktop-core:loopback:http",
      qrShareable: false,
    },
    {
      id: "tailscale-ip:http://100.84.12.7:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "tailscale-ip:http://100.84.12.8:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "desktop-lan:http://192.168.1.42:4780",
      preferenceKey: "desktop-core:lan:http",
      qrShareable: true,
    },
  ];

  it("resolves an explicit selection by unique endpoint id, not the shared preference key", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:http://100.84.12.8:4780", null)?.id).toBe(
      "tailscale-ip:http://100.84.12.8:4780",
    );
  });

  it("falls back to the saved default preference key when nothing is selected", () => {
    expect(selectQrEndpointOption(options, null, "desktop-core:lan:http")?.id).toBe(
      "desktop-lan:http://192.168.1.42:4780",
    );
  });

  it("skips non-QR-shareable options in the fallback so the panel never opens on loopback", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:gone", "nope")?.id).toBe(
      "tailscale-ip:http://100.84.12.7:4780",
    );
  });

  it("returns the first option when nothing is QR-shareable, and null when empty", () => {
    const loopbackOnly = options.slice(0, 1);
    expect(selectQrEndpointOption(loopbackOnly, null, null)?.id).toBe("desktop-loopback:4780");
    expect(selectQrEndpointOption([], "anything", "anything")).toBeNull();
  });
});

it("resolves same-host suggestions by port and preserves config aliases", () => {
  const hosts = [
    { alias: "host", hostname: "host", port: null, username: null, source: "known-hosts" as const },
    { alias: "host", hostname: "host", port: 2222, username: null, source: "known-hosts" as const },
    {
      alias: "dev",
      hostname: "internal",
      port: 2200,
      username: "me",
      source: "ssh-config" as const,
    },
  ] as const;
  expect(findSshHostSuggestion(hosts, sshHostSuggestionKey(hosts[1]))).toBe(hosts[1]);
  expect(findSshHostSuggestion(hosts, sshHostSuggestionKey(hosts[0]))).toBe(hosts[0]);
  expect(findSshHostSuggestion(hosts, sshHostSuggestionKey(hosts[2]))).toBe(hosts[2]);
});

const ipv6WithPort = {
  alias: "2001:db8::1",
  hostname: "2001:db8::1",
  username: null,
  port: 2222,
  source: "known-hosts",
} as const;
const ipv6WithoutPort = {
  ...ipv6WithPort,
  alias: "2001:db8::1:2222",
  hostname: "2001:db8::1:2222",
  port: null,
} as const;

it.each([
  { order: "port first", hosts: [ipv6WithPort, ipv6WithoutPort] },
  { order: "port last", hosts: [ipv6WithoutPort, ipv6WithPort] },
])("resolves distinct IPv6 suggestions with $order", ({ hosts }) => {
  for (const host of hosts) {
    expect(findSshHostSuggestion(hosts, sshHostSuggestionKey(host))).toBe(host);
  }
});

it("formats IPv6 suggestions as distinct addresses that round-trip through the manual parser", () => {
  const withPort = formatDesktopSshTarget(ipv6WithPort);
  const withoutPort = formatDesktopSshTarget(ipv6WithoutPort);
  expect(withPort).toBe("[2001:db8::1]:2222");
  expect(withoutPort).toBe("2001:db8::1:2222");
  for (const target of [ipv6WithPort, ipv6WithoutPort, { ...ipv6WithPort, username: "me" }]) {
    expect(
      parseManualDesktopSshTarget({ host: formatDesktopSshTarget(target), username: "", port: "" }),
    ).toMatchObject({
      hostname: target.hostname,
      port: target.port,
      username: target.username,
    });
  }
});

it("hides known hosts only at the same port and config hosts by alias", () => {
  const saved = [{ alias: "host", port: 2200 }];
  const host = {
    alias: "host",
    hostname: "host",
    username: null,
    port: 2222,
    source: "known-hosts" as const,
  };
  expect(isSavedSshHostSuggestion(host, saved)).toBe(false);
  expect(isSavedSshHostSuggestion({ ...host, port: 2200 }, saved)).toBe(true);
  expect(isSavedSshHostSuggestion({ ...host, port: null }, [{ alias: "host", port: 22 }])).toBe(
    true,
  );
  expect(isSavedSshHostSuggestion({ ...host, source: "ssh-config" }, saved)).toBe(true);
});
