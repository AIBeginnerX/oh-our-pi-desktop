import { createClerkBridge } from "@clerk/electron";
import { assert, describe, it } from "@effect/vitest";
import { beforeEach, vi } from "vite-plus/test";

const { handlers, registerSchemesMock, setProtocolClientMock, onMock, removeListenerMock } =
  vi.hoisted(() => ({
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    registerSchemesMock: vi.fn(() => {
      throw new Error("Electron is already ready");
    }),
    setProtocolClientMock: vi.fn(),
    onMock: vi.fn(),
    removeListenerMock: vi.fn(),
  }));

vi.mock("electron", () => ({
  app: {
    hasSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: setProtocolClientMock,
    on: onMock,
    removeListener: removeListenerMock,
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  protocol: { registerSchemesAsPrivileged: registerSchemesMock },
  BrowserWindow: { fromWebContents: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

describe("patched Clerk Electron bridge", () => {
  beforeEach(() => {
    handlers.clear();
    registerSchemesMock.mockClear();
    setProtocolClientMock.mockClear();
    onMock.mockClear();
    removeListenerMock.mockClear();
  });

  it("keeps OAuth and token IPC when Electron has already registered the renderer scheme", () => {
    const bridge = createClerkBridge({
      storage: {
        getItem: async () => null,
        setItem: async () => {},
        removeItem: async () => {},
      },
      renderer: { scheme: "t3code", host: "app" },
      registerRendererScheme: false,
    });

    assert.isTrue(bridge.isPrimaryInstance);
    assert.equal(registerSchemesMock.mock.calls.length, 0);
    assert.deepEqual([...handlers.keys()].sort(), [
      "clerk:oauth-transport:get-redirect-url",
      "clerk:oauth-transport:open",
      "clerk:token-cache:clear",
      "clerk:token-cache:get",
      "clerk:token-cache:save",
    ]);
    assert.deepEqual(setProtocolClientMock.mock.calls, [["t3code"]]);
    assert.deepEqual(
      onMock.mock.calls.map(([event]) => event),
      ["open-url", "second-instance"],
    );

    bridge.cleanup();
    assert.equal(handlers.size, 0);
    assert.deepEqual(
      removeListenerMock.mock.calls.map(([event]) => event),
      ["open-url", "second-instance"],
    );
  });
});
