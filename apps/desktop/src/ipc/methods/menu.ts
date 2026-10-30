import { DesktopMenuLanguageSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopApplicationMenu from "../../window/DesktopApplicationMenu.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getMenuLanguage = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MENU_GET_LANGUAGE_CHANNEL,
  payload: Schema.Void,
  result: DesktopMenuLanguageSchema,
  handler: Effect.fn("desktop.ipc.menu.getLanguage")(function* () {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const settings = yield* appSettings.get;
    return settings.menuLanguage;
  }),
});

export const setMenuLanguage = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MENU_SET_LANGUAGE_CHANNEL,
  payload: DesktopMenuLanguageSchema,
  result: DesktopMenuLanguageSchema,
  handler: Effect.fn("desktop.ipc.menu.setLanguage")(function* (language) {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
    const change = yield* appSettings.setMenuLanguage(language);
    // The native menu is a build-time artifact of the setting, so it is rebuilt
    // here rather than watching the settings file.
    if (change.changed) yield* menu.configure;
    return change.settings.menuLanguage;
  }),
});
