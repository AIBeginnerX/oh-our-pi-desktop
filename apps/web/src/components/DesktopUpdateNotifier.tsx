import { useEffect, useRef } from "react";

import { isElectron } from "../env";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { getDesktopUpdateVersionToAnnounce } from "./desktopUpdate.logic";
import { showDesktopUpdateAvailableToast } from "./desktopUpdate.toast";

/**
 * Announces each newly found desktop update once: an in-app toast, plus a system
 * notification when the window is in the background. Mounted once at the app root.
 */
export function DesktopUpdateNotifier() {
  return isElectron ? <DesktopUpdateNotifierEffect /> : null;
}

function DesktopUpdateNotifierEffect() {
  const state = useDesktopUpdateState();
  const announced = useRef(new Set<string>());

  useEffect(() => {
    const bridge = window.desktopBridge;
    const version = getDesktopUpdateVersionToAnnounce(state, announced.current);
    if (!bridge || !state || version === null) return;
    announced.current.add(version);
    showDesktopUpdateAvailableToast(bridge, state, version);

    if (
      (document.visibilityState === "visible" && document.hasFocus()) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    ) {
      return;
    }
    try {
      const notification = new Notification(`Update ${version} available`, {
        body: "Open the app to update.",
        tag: `desktop-update:${version}`,
        silent: true,
      });
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
      });
    } catch {
      // Some runtimes expose Notification but reject desktop presentation.
    }
  }, [state]);

  return null;
}
