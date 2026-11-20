import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import { useEffect, useRef } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { t } from "../../i18n";
import { currentUiLanguage } from "../../state/menuLanguage";
import { hasDesktopNotifications } from "../../threadNotifications";
import { getDriverOption } from "../settings/providerDriverMeta";
import { toastManager } from "../ui/toast";
import { capWeeklyUsageAlertKeys, planWeeklyUsageAlerts } from "./weeklyUsageAlerts";
import { weeklyUsageAlertsAtom } from "./weeklyUsageAlertsAtom";

const STORAGE_KEY = "oop:weekly-usage-alerts";

export function WeeklyUsageNotificationCoordinator() {
  const selection = useAtomValue(weeklyUsageAlertsAtom);
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppEnabled = useClientSettings((settings) => settings.inAppNotificationsEnabled);
  const navigate = useNavigate();
  const notified = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (notified.current === null) {
      notified.current = new Set();
      try {
        const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
        if (Array.isArray(stored)) {
          for (const key of stored) {
            if (typeof key === "string") notified.current.add(key);
          }
        }
      } catch {
        // The in-memory set still covers renders when storage is unavailable.
      }
    }

    const { pending, retained: keys } = planWeeklyUsageAlerts(notified.current, selection);
    let changed = keys.size !== notified.current.size;

    const windowInView = document.visibilityState === "visible" && document.hasFocus();
    const desktopEnabled =
      hasDesktopNotifications(mode) &&
      !windowInView &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted";
    const viewUsage = () => void navigate({ to: "/usage" });

    for (const { key, account, window: usageWindow } of pending) {
      if (keys.has(key) || (!inAppEnabled && !desktopEnabled)) continue;
      const title = t("Weekly usage almost used up");
      // Notifications can show on a locked screen or a shared one, so the account email stays out.
      const name =
        account.displayName ?? getDriverOption(account.driver)?.label ?? String(account.driver);
      const percent = remainingPercent(usageWindow);
      const resetAt = Date.parse(usageWindow.resetsAt ?? "");
      const description = Number.isFinite(resetAt)
        ? t("{account} · {percent}% left, resets {time}", {
            account: name,
            percent,
            time: new Intl.DateTimeFormat(currentUiLanguage(), {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(resetAt),
          })
        : t("{account} · {percent}% left", { account: name, percent });

      let delivered = false;
      if (inAppEnabled) {
        const toastId = toastManager.add({
          type: "warning",
          title,
          description,
          data: { hideCopyButton: true },
          actionProps: {
            children: t("View usage"),
            onClick: () => {
              toastManager.close(toastId);
              viewUsage();
            },
          },
        });
        delivered = true;
      }

      if (desktopEnabled) {
        try {
          const notification = new Notification(title, {
            body: description,
            silent: true,
          });
          delivered = true;
          notification.addEventListener("click", () => {
            notification.close();
            window.focus();
            viewUsage();
          });
        } catch {
          // Some browsers expose Notification but reject desktop presentation.
        }
      }

      if (delivered) {
        keys.add(key);
        changed = true;
      }
    }

    const sizeBeforeCap = keys.size;
    capWeeklyUsageAlertKeys(keys, new Set(selection.alerts.map(({ key }) => key)));
    notified.current = keys;
    if (changed || keys.size !== sizeBeforeCap) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
      } catch {
        // The in-memory set remains available.
      }
    }
  }, [inAppEnabled, mode, navigate, selection]);

  return null;
}
