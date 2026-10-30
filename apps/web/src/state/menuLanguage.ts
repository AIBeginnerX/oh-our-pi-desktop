import type { DesktopMenuLanguage } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { t } from "../i18n";

/** The language choices, each named in its own language. */
export const MENU_LANGUAGE_OPTIONS: ReadonlyArray<{
  readonly value: DesktopMenuLanguage;
  readonly label: string;
}> = [
  { value: "system", label: "System" },
  { value: "en", label: "English" },
  { value: "ko", label: "한국어" },
  { value: "ja", label: "日本語" },
  { value: "zh-CN", label: "简体中文" },
  { value: "es", label: "Español" },
];

/** A language the interface ships in; "system" resolves to one of these. */
export type UiLanguage = Exclude<DesktopMenuLanguage, "system">;

const BROWSER_STORAGE_KEY = "oop:language";

interface LanguageState {
  readonly setting: DesktopMenuLanguage | null;
  readonly isChanging: boolean;
}

const isLanguageSetting = (value: unknown): value is DesktopMenuLanguage =>
  MENU_LANGUAGE_OPTIONS.some((option) => option.value === value);

const desktopBridge = () => (typeof window === "undefined" ? undefined : window.desktopBridge);

/** The desktop app keeps the choice with its menu; a browser keeps it in local storage. */
const hasDesktopLanguage = () => {
  const bridge = desktopBridge();
  return bridge?.getMenuLanguage !== undefined && bridge?.setMenuLanguage !== undefined;
};

const readBrowserSetting = (): DesktopMenuLanguage => {
  try {
    const stored = window.localStorage.getItem(BROWSER_STORAGE_KEY);
    return isLanguageSetting(stored) ? stored : "system";
  } catch {
    return "system";
  }
};

let state: LanguageState = { setting: null, isChanging: false };
let loaded = false;
const listeners = new Set<() => void>();

const publish = (next: LanguageState) => {
  state = next;
  for (const listener of listeners) listener();
};

const load = () => {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  const bridge = desktopBridge();
  if (!hasDesktopLanguage() || bridge?.getMenuLanguage === undefined) {
    publish({ ...state, setting: readBrowserSetting() });
    return;
  }
  void bridge
    .getMenuLanguage()
    .then((setting) => publish({ ...state, setting }))
    .catch(() => publish({ ...state, setting: "system" }));
};

const subscribe = (listener: () => void) => {
  load();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => state;
const getServerSnapshot = () => state;

/** Maps a BCP 47 locale to a shipped interface language, else English. */
export function resolveUiLanguage(locale: string | null | undefined): UiLanguage {
  const tag = (locale ?? "").toLowerCase().replace(/_/g, "-");
  if (tag.startsWith("ko")) return "ko";
  if (tag.startsWith("ja")) return "ja";
  if (tag.startsWith("zh")) return "zh-CN";
  if (tag.startsWith("es")) return "es";
  return "en";
}

/**
 * The OS language. The packaged desktop renderer reports en-US through `navigator`, so the
 * desktop bridge reads it from the operating system instead.
 */
const systemLocale = () => {
  const fromDesktop = desktopBridge()?.getSystemLocale?.();
  if (fromDesktop) return fromDesktop;
  return typeof navigator === "undefined" ? undefined : navigator.language;
};

export function uiLanguageFor(setting: DesktopMenuLanguage | null): UiLanguage {
  return setting === null || setting === "system" ? resolveUiLanguage(systemLocale()) : setting;
}

/** The interface language right now, for code that runs outside React (toasts, errors). */
export function currentUiLanguage(): UiLanguage {
  load();
  return uiLanguageFor(state.setting);
}

/** Applies a language choice: the desktop menu bar and the interface change together. */
export function changeLanguage(next: DesktopMenuLanguage) {
  if (next === state.setting || state.isChanging) return;
  const bridge = desktopBridge();
  if (!hasDesktopLanguage() || bridge?.setMenuLanguage === undefined) {
    try {
      window.localStorage.setItem(BROWSER_STORAGE_KEY, next);
    } catch {
      // Private browsing may refuse storage; the choice still applies until reload.
    }
    publish({ ...state, setting: next });
    return;
  }
  publish({ ...state, isChanging: true });
  void bridge
    .setMenuLanguage(next)
    .then((applied) => publish({ setting: applied, isChanging: false }))
    .catch((error: unknown) => {
      publish({ ...state, isChanging: false });
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Could not change language"),
          description: error instanceof Error ? error.message : t("Language change failed."),
        }),
      );
    });
}

/** The language choice, shared by every control that shows or changes it. */
export function useMenuLanguage() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    supported: typeof window !== "undefined",
    language: current.setting,
    isChanging: current.isChanging,
    change: changeLanguage,
  };
}

/** The interface language, re-rendering the caller when it changes. */
export function useUiLanguage(): UiLanguage {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return uiLanguageFor(current.setting);
}
