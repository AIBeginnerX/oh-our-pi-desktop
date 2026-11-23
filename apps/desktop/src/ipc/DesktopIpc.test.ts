import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import * as DesktopIpc from "./DesktopIpc.ts";

const invokeMethod: DesktopIpc.DesktopIpcMethod<never, never> = {
  channel: "desktop.test.invoke",
  handler: () => Effect.void,
};

const syncMethod: DesktopIpc.DesktopSyncIpcMethod<never, never> = {
  channel: "desktop.test.sync",
  handler: () => Effect.void,
};

function makeIpcMain(
  overrides: Partial<DesktopIpc.DesktopIpcMain> = {},
): DesktopIpc.DesktopIpcMain {
  return {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    ...overrides,
  };
}

describe("DesktopIpc", () => {
  it.effect("refuses app IPC from a guest, subframe, foreign origin, or detached frame", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
        const ipc = DesktopIpc.make(
          makeIpcMain({
            handle: (_channel, registered) => {
              listener = registered;
            },
          }),
        );
        yield* ipc.handle({
          channel: invokeMethod.channel,
          handler: () => Effect.succeed("app-only result"),
        });

        const mainFrame = { origin: "t3code://app" };
        const foreignFrame = { origin: "https://example.test" };
        const window = { id: 7, mainFrame };
        const guest = { id: 8, mainFrame: { ...mainFrame } };
        const navigatedWindow = { id: 9, mainFrame: foreignFrame };
        DesktopIpc.registerAppWindow(window, mainFrame.origin);
        DesktopIpc.registerAppWindow(navigatedWindow, mainFrame.origin);
        for (const event of [
          { sender: guest, senderFrame: guest.mainFrame },
          { sender: window, senderFrame: { ...mainFrame } },
          { sender: navigatedWindow, senderFrame: foreignFrame },
          { sender: window, senderFrame: null },
        ]) {
          const answer = yield* Effect.promise(async () =>
            Promise.resolve()
              .then(() => listener!(event, undefined))
              .catch((error: unknown) => error),
          );
          assert.instanceOf(answer, Error);
        }
      }),
    ),
  );

  it.effect("preserves invoke registration context and cause", () =>
    Effect.gen(function* () {
      const cause = new Error("invoke registration failed");
      const ipcMain = makeIpcMain({
        handle: () => {
          throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain);

      const error = yield* Effect.flip(Effect.scoped(ipc.handle(invokeMethod)));

      assert.instanceOf(error, DesktopIpc.DesktopIpcRegistrationError);
      assert.strictEqual(error.handlerKind, "invoke");
      assert.strictEqual(error.channel, invokeMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "invoke");
      assert.include(error.message, invokeMethod.channel);
      assert.notInclude(error.message, cause.message);
    }),
  );

  it.effect("allows registered app main frames on packaged and dev origins", () =>
    Effect.gen(function* () {
      let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
      const ipc = DesktopIpc.make(
        makeIpcMain({
          handle: (_channel, registered) => {
            listener = registered;
          },
        }),
      );
      const primaryFrame = { origin: "t3code://app" };
      const secondaryFrame = { origin: "t3code-dev://app" };
      const primaryWindow = { id: 7, mainFrame: primaryFrame };
      const secondaryWindow = { id: 8, mainFrame: secondaryFrame };
      DesktopIpc.registerAppWindow(primaryWindow, primaryFrame.origin);
      DesktopIpc.registerAppWindow(secondaryWindow, secondaryFrame.origin);
      let received: DesktopIpc.DesktopIpcInvokeEvent | undefined;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handle({
            channel: "desktop.test.sender",
            handler: (_raw, event) =>
              Effect.sync(() => {
                received = event;
              }),
          });
          for (const sender of [primaryWindow, secondaryWindow]) {
            const event = { sender, senderFrame: sender.mainFrame };
            yield* Effect.promise(async () => listener!(event, undefined));
            assert.strictEqual(received, event);
          }
        }),
      );
    }),
  );

  it.effect("returns sync results only to the registered app main frame", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let listener: DesktopIpc.DesktopIpcSyncListener | undefined;
        const ipc = DesktopIpc.make(
          makeIpcMain({
            on: (_channel, registered) => {
              listener = registered;
            },
          }),
        );
        yield* ipc.handleSync({
          channel: syncMethod.channel,
          handler: () => Effect.succeed("branding"),
        });
        const mainFrame = { origin: "t3code://app" };
        const sender = { id: 7, mainFrame };
        DesktopIpc.registerAppWindow(sender, mainFrame.origin);
        const main = { sender, senderFrame: mainFrame, returnValue: undefined };
        const subframe = { ...main, senderFrame: { ...mainFrame } };
        listener!(main);
        listener!(subframe);
        assert.strictEqual(main.returnValue, "branding");
        assert.isNull(subframe.returnValue);
      }),
    ),
  );

  it.effect("preserves sync unregistration context and cause in the finalizer defect", () =>
    Effect.gen(function* () {
      const cause = new Error("sync unregistration failed");
      let removeCount = 0;
      const ipcMain = makeIpcMain({
        removeAllListeners: () => {
          removeCount += 1;
          if (removeCount === 2) throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain);

      const exit = yield* Effect.exit(Effect.scoped(ipc.handleSync(syncMethod)));

      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Success") return;
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, DesktopIpc.DesktopIpcUnregistrationError);
      assert.strictEqual(error.handlerKind, "sync");
      assert.strictEqual(error.channel, syncMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }),
  );
});
