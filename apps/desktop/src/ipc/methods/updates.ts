import {
  DesktopUpdateActionResultSchema,
  DesktopUpdateChannelSchema,
  DesktopUpdateCheckResultSchema,
  DesktopUpdateStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import * as LocalPkgUpdates from "../../updates/LocalPkgUpdates.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getUpdateState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.getState")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.getState;
  }),
});

export const setUpdateChannel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_SET_CHANNEL_CHANNEL,
  payload: DesktopUpdateChannelSchema,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.setChannel")(function* (channel) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.setChannel(channel);
  }),
});

export const downloadUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_DOWNLOAD_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.download")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.download;
  }),
});

export const installUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_INSTALL_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.install")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.install;
  }),
});

export const checkForUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCheckResultSchema,
  handler: Effect.fn("desktop.ipc.updates.check")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.check("web-ui");
  }),
});

/**
 * Opens the share named in the app's bundled update config, never a renderer-supplied URL:
 * Finder's Connect to Server on macOS, File Explorer on the `\\host\share` path on Windows.
 */
export const openUpdateSource = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_OPEN_SOURCE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.updates.openSource")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const config = yield* LocalPkgUpdates.loadConfig(environment.resourcesPath);
    if (config._tag !== "Ready" || config.connectUrl === undefined) return false;
    const connectUrl = config.connectUrl;
    if (environment.platform === "win32") {
      const url = new URL(connectUrl);
      const uncPath = `\\\\${url.hostname}${decodeURIComponent(url.pathname).replaceAll("/", "\\")}`;
      return yield* Effect.promise(() => Electron.shell.openPath(uncPath)).pipe(
        Effect.map((error) => error === ""),
      );
    }
    return yield* Effect.promise(() =>
      Electron.shell.openExternal(connectUrl).then(
        () => true,
        () => false,
      ),
    );
  }),
});
