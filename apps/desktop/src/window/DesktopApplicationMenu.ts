import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import {
  MENU_LANGUAGES,
  resolveMenuLanguage,
  type MenuLabels,
} from "./DesktopApplicationMenuLabels.ts";

export class DesktopApplicationMenuActionError extends Schema.TaggedError<DesktopApplicationMenuActionError>()(
  "DesktopApplicationMenuActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices =
  | DesktopUpdates.DesktopUpdates
  | DesktopWindow.DesktopWindow
  | ElectronDialog.ElectronDialog;

const { logInfo: logUpdaterInfo } = makeComponentLogger("desktop-updater");

const { logError: logMenuError } = makeComponentLogger("desktop-menu");

const dispatchMenuAction = Effect.fn("desktop.menu.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action, {
    reveal: action !== "paste-as-text",
  });
});

const zoomMainWindow = Effect.fn("desktop.menu.zoomMainWindow")(function* (
  direction: DesktopWindow.MainWindowZoomDirection,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.zoomMain(direction);
});

const checkForUpdatesFromMenu = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const result = yield* updates.check("menu");
  const updateState = result.state;

  if (updateState.status === "up-to-date") {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `OOP ${updateState.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (updateState.status === "error") {
    yield* electronDialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: updateState.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
}).pipe(Effect.withSpan("desktop.menu.checkForUpdates"));

const handleCheckForUpdatesMenuClick = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const disabledReason = yield* updates.disabledReason;
  if (Option.isSome(disabledReason)) {
    yield* logUpdaterInfo("manual update check requested, but updates are disabled", {
      disabledReason: disabledReason.value,
    });
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason.value,
      buttons: ["OK"],
    });
    return;
  }

  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.ensureMain;
  yield* checkForUpdatesFromMenu;
}).pipe(Effect.withSpan("desktop.menu.handleCheckForUpdatesClick"));

export interface ApplicationMenuTemplateHandlers {
  readonly checkForUpdatesClick: () => void;
  readonly settingsClick: () => void;
  readonly pasteAsTextClick: (
    item: Electron.MenuItem,
    window: Electron.BaseWindow | undefined,
    event: Electron.KeyboardEvent,
  ) => void;
  readonly zoomClick: (direction: DesktopWindow.MainWindowZoomDirection) => () => void;
}

/**
 * Builds the application menu template with localized labels. Roles keep their behavior; only
 * their labels are overridden, so localization can never change what an item does.
 */
export function buildApplicationMenuTemplate(input: {
  readonly platform: NodeJS.Platform;
  readonly appName: string;
  readonly labels: MenuLabels;
  readonly handlers: ApplicationMenuTemplateHandlers;
}): Electron.MenuItemConstructorOptions[] {
  const { platform, appName, labels, handlers } = input;
  const appLabel = (key: "about" | "hide" | "quit") => labels[key].replace("{app}", appName);
  const template: Electron.MenuItemConstructorOptions[] = [];

  if (platform === "darwin") {
    template.push({
      label: appName,
      submenu: [
        { role: "about", label: appLabel("about") },
        {
          label: labels.checkForUpdates,
          click: handlers.checkForUpdatesClick,
        },
        { type: "separator" },
        {
          label: labels.settings,
          accelerator: "CmdOrCtrl+,",
          click: handlers.settingsClick,
        },
        { type: "separator" },
        { role: "services", label: labels.services },
        { type: "separator" },
        { role: "hide", label: appLabel("hide") },
        { role: "hideOthers", label: labels.hideOthers },
        { role: "unhide", label: labels.showAll },
        { type: "separator" },
        { role: "quit", label: appLabel("quit") },
      ],
    });
  }

  template.push(
    {
      label: labels.file,
      submenu: [
        ...(platform === "darwin"
          ? []
          : [
              {
                label: labels.settings,
                accelerator: "CmdOrCtrl+,",
                click: handlers.settingsClick,
              },
              { type: "separator" as const },
            ]),
        {
          role: platform === "darwin" ? "close" : "quit",
          label: platform === "darwin" ? labels.close : appLabel("quit"),
        },
      ],
    },
    {
      label: labels.edit,
      submenu: [
        { role: "undo", label: labels.undo },
        { role: "redo", label: labels.redo },
        { type: "separator" },
        { role: "cut", label: labels.cut },
        { role: "copy", label: labels.copy },
        { role: "paste", label: labels.paste },
        {
          label: labels.pasteAsText,
          accelerator: "CmdOrCtrl+Shift+V",
          click: handlers.pasteAsTextClick,
        },
        { role: "delete", label: labels.remove },
        { type: "separator" },
        { role: "selectAll", label: labels.selectAll },
        ...(platform === "darwin"
          ? [
              { type: "separator" as const },
              {
                label: labels.speech,
                submenu: [
                  { role: "startSpeaking" as const, label: labels.startSpeaking },
                  { role: "stopSpeaking" as const, label: labels.stopSpeaking },
                ],
              },
            ]
          : []),
      ],
    },
    {
      label: labels.view,
      submenu: [
        { role: "reload", label: labels.reload },
        { role: "forceReload", label: labels.forceReload },
        { role: "toggleDevTools", label: labels.toggleDevTools },
        { type: "separator" },
        /*
          Not the zoom roles: those act on the focused webContents, so with
          an embedded preview WebContentsView focused they zoom the guest
          page and the app UI appears stuck. These always zoom the main
          window (see DesktopWindow.zoomMain).
        */
        {
          label: labels.actualSize,
          accelerator: "CmdOrCtrl+0",
          click: handlers.zoomClick("reset"),
        },
        { label: labels.zoomIn, accelerator: "CmdOrCtrl+=", click: handlers.zoomClick("in") },
        {
          label: labels.zoomIn,
          accelerator: "CmdOrCtrl+Plus",
          visible: false,
          click: handlers.zoomClick("in"),
        },
        { label: labels.zoomOut, accelerator: "CmdOrCtrl+-", click: handlers.zoomClick("out") },
        { type: "separator" },
        { role: "togglefullscreen", label: labels.toggleFullScreen },
      ],
    },
    {
      label: labels.window,
      submenu: [
        { role: "minimize", label: labels.minimize },
        { role: "zoom", label: labels.zoom },
        ...(platform === "darwin"
          ? [
              { type: "separator" as const },
              { role: "front" as const, label: labels.bringAllToFront },
            ]
          : []),
      ],
    },
    {
      role: "help",
      label: labels.help,
      submenu: [
        {
          label: labels.checkForUpdates,
          click: handlers.checkForUpdatesClick,
        },
      ],
    },
  );

  return template;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const appName = yield* electronApp.name;
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopApplicationMenuActionError({ action, cause });
          return logMenuError(error.message, { error });
        }),
      ),
    );
  };

  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const configure = Effect.gen(function* () {
    const settings = yield* appSettings.get;
    const systemLocale = yield* electronApp.systemLocale;
    const language = resolveMenuLanguage(settings.menuLanguage, systemLocale);
    const labels = MENU_LANGUAGES[language];

    const checkForUpdatesClick = () => {
      runMenuEffect("check-for-updates", handleCheckForUpdatesMenuClick);
    };
    const settingsClick = () => {
      runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
    };
    // Chromium already pastes as plain text for this chord, so the accelerator
    // needs nothing from the menu: the composer and the terminal each arm
    // themselves from the same keydown. Routing it through the renderer anyway
    // lands a second, injected paste and doubles the text. Only a menu click,
    // which produces no keystroke for them to see, needs that round trip.
    const pasteAsTextClick = (
      _item: Electron.MenuItem,
      _window: Electron.BaseWindow | undefined,
      event: Electron.KeyboardEvent,
    ) => {
      if (event.triggeredByAccelerator === true) return;
      runMenuEffect("paste-as-text", dispatchMenuAction("paste-as-text"));
    };
    const zoomClick = (direction: DesktopWindow.MainWindowZoomDirection) => () => {
      runMenuEffect(`zoom-${direction}`, zoomMainWindow(direction));
    };

    yield* electronMenu.setApplicationMenu(
      buildApplicationMenuTemplate({
        platform: environment.platform,
        appName,
        labels,
        handlers: { checkForUpdatesClick, settingsClick, pasteAsTextClick, zoomClick },
      }),
    );
  }).pipe(Effect.withSpan("desktop.menu.configure"));

  return DesktopApplicationMenu.of({
    configure,
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
