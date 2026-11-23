// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { DesktopDiscoveredSshHost } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  // Keep the dialog mounted so the final input value remains observable.
  connect: vi.fn(() => new Promise<never>(() => {})),
  refresh: vi.fn(),
  hosts: [] as DesktopDiscoveredSshHost[],
}));
// Supply an empty environment and idle server without starting the application runtime.
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (value: unknown) =>
    Array.isArray(value) || (value && typeof value === "object" && "status" in value) ? value : [],
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => null,
}));
vi.mock("~/localEnvironment", () => ({ isLocalEnvironmentDisabled: () => true }));
vi.mock("~/state/server", () => ({
  primaryServerKeybindingsAtom: [],
  serverEnvironment: { updateStateAtom: () => ({ status: "idle" }) },
}));
vi.mock("~/state/query", async () => {
  const { desktopSshHostsStateAtom } = await import("~/state/desktopSshHosts");
  return {
    useEnvironmentQuery: (atom: unknown) => ({
      data: atom === desktopSshHostsStateAtom ? mocks.hosts : null,
      error: null,
      isPending: false,
      refresh: mocks.refresh,
    }),
  };
});
vi.mock("~/environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null }),
}));
vi.mock("~/connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("~/connection/onboarding", () => ({
  connectPairing: "pairing",
  connectSshEnvironment: "ssh",
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "ssh" ? mocks.connect : vi.fn()),
}));
vi.mock(import("~/cloud/publicConfig"), async (original) => ({
  ...(await original()),
  hasCloudPublicConfig: () => false,
}));
// Cloud rows require account providers unrelated to SSH selection.
vi.mock("./ConnectionsSettings.cloud", () => ({
  CloudLinkRow: () => null,
  CloudRemoteEnvironmentRows: () => null,
  SavedBackendListRow: () => null,
}));
// Animation is unrelated to selection and depends on layout unavailable in jsdom.
vi.mock("../AnimatedHeight", () => ({
  AnimatedHeight: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useLocation: ({ select }: { select: (location: { hash: string; state: object }) => unknown }) =>
    select({ hash: "", state: {} }),
}));

import { ConnectionsSettings } from "./ConnectionsSettings";

const hosts = [
  {
    alias: "2001:db8::1",
    hostname: "2001:db8::1",
    port: 2222,
    username: null,
    source: "known-hosts",
  },
  {
    alias: "2001:db8::1:2222",
    hostname: "2001:db8::1:2222",
    port: null,
    username: null,
    source: "known-hosts",
  },
] satisfies DesktopDiscoveredSshHost[];

const prototypeDescriptors = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Base UI uses browser layout APIs that jsdom does not implement.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  vi.stubGlobal("desktopBridge", {
    resolveSshHost: async (alias: string) => ({
      alias,
      hostname: alias,
      port: null,
      username: null,
    }),
  });
  mocks.connect.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  for (const key of ["getAnimations", "scrollIntoView"] as const) {
    const descriptor = prototypeDescriptors[key];
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, key);
  }
  vi.unstubAllGlobals();
});

const keydown = (input: HTMLInputElement, key: string) =>
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

it.each(
  [false, true].flatMap((reversed) =>
    hosts.flatMap((host) =>
      ["click", "enter", "mouseup"].map((path) => ({ reversed, host, path })),
    ),
  ),
)("$path selects $host.alias (reversed=$reversed)", async ({ reversed, host, path }) => {
  mocks.hosts = reversed ? hosts.toReversed() : hosts;
  await act(async () => root.render(<ConnectionsSettings />));
  const add = document.querySelector<HTMLButtonElement>('button[aria-label="Add environment"]');
  expect(add).not.toBeNull();
  await act(async () => add!.click());
  const ssh = [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
    (button) => button.textContent?.startsWith("SSH"),
  );
  expect(ssh).toBeDefined();
  await act(async () => ssh!.click());
  const input = document.querySelector<HTMLInputElement>("#saved-backend-ssh-host")!;
  expect(input).toBeInstanceOf(HTMLInputElement);
  await act(async () => {
    input.focus();
    keydown(input, "ArrowDown");
  });
  const writes: string[] = [];
  const value = Object.getOwnPropertyDescriptor(input, "value")!;
  // Observe every React input write, including a transient internal suggestion key.
  Object.defineProperty(input, "value", {
    ...value,
    set(next: string) {
      writes.push(next);
      value.set!.call(this, next);
    },
  });

  try {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="autocomplete-item"]')];
    expect(rows).toHaveLength(2);
    const index = mocks.hosts.indexOf(host);
    const row = rows[index]!;
    expect(row.firstElementChild?.textContent).toBe(host.alias);

    if (path === "click") {
      await act(async () => row.click());
    } else {
      for (
        let i = 0;
        i < rows.length && input.getAttribute("aria-activedescendant") !== row.id;
        i++
      ) {
        await act(async () => keydown(input, "ArrowDown"));
      }
      expect(input.getAttribute("aria-activedescendant")).toBe(row.id);
      if (path === "enter") {
        await act(async () => keydown(input, "Enter"));
      } else {
        await act(async () =>
          row.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true })),
        );
      }
    }

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.connect).toHaveBeenCalledWith({
      label: "",
      target: { alias: host.alias, hostname: host.hostname, port: host.port, username: null },
    });
    expect(input.value).toBe(host.alias);
    expect(writes.filter((write) => write !== "")).toEqual([host.alias]);
  } finally {
    Object.defineProperty(input, "value", value);
  }
});
