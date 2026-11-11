import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, type ReactNode } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { t } from "../i18n";
import { useEnvironments } from "../state/environments";
import { environmentShell } from "../state/shell";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  unlockNotificationAudio,
} from "../threadNotifications";
import {
  NO_ACTIVITY_ALERT_CHECK_MS,
  isNoActivityAlertCandidate,
  noActivityAlerts,
} from "./threadNotifications.logic";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { toastManager } from "./ui/toast";

export function ThreadNotificationCoordinator() {
  const { environments } = useEnvironments();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const pending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: Notification }>(),
  );
  const onNotification = useCallback((environmentId: EnvironmentId, notification: Notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.current.size);
  }, []);

  useEffect(() => {
    const activeIds = new Set(environments.map(({ environmentId }) => environmentId));
    const count = pending.current.size;
    for (const [tag, { environmentId, notification }] of pending.current) {
      if (activeIds.has(environmentId)) continue;
      notification.close();
      pending.current.delete(tag);
    }
    if (count !== pending.current.size) setNotificationBadge(pending.current.size);
  }, [environments]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification.close();
      pending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    if (!hasDesktopNotifications(mode)) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return environments.map((environment) => (
    <EnvironmentNotifications
      key={environment.environmentId}
      environmentId={environment.environmentId}
      onNotification={onNotification}
    />
  ));
}

/**
 * One delivered thread alert. Sound, toast, and desktop notification all follow
 * the same channel rules no matter which event raised it.
 */
interface ThreadAlertDelivery {
  readonly title: string;
  readonly description: string;
  readonly toastType: "success" | "error" | "warning";
  readonly icon: ReactNode;
  readonly sound: "completion" | "input";
  readonly threadId: ThreadId;
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const noActivityAlertMinutes =
    useClientSettings((settings) => settings.noActivityAlertMinutes) ?? null;
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const previous = useRef(
    new Map<ThreadId, { attention: string | null; completion: number | null }>(),
  );
  // Keys already alerted, one per silence. Pruned inside noActivityAlerts so it
  // never holds keys of threads that no longer qualify.
  const alerted = useRef(new Set<string>());

  const deliverAlert = useCallback(
    (delivery: ThreadAlertDelivery) => {
      if (hasNotificationSound(mode)) {
        void playNotificationSound(delivery.sound, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      const windowInView = document.visibilityState === "visible" && document.hasFocus();
      // A toast is only redundant when the user is already looking at the thread that raised
      // the event. While the window is unfocused or hidden the toast is queued and shown when
      // the user returns (Base UI pauses toast timers while out of focus), and the desktop
      // notification below still fires, so background work is not missed either way.
      const openThreadIsInView =
        windowInView &&
        activeEnvironmentId === environmentId &&
        activeThreadId === delivery.threadId;
      if (inAppNotificationsEnabled && !openThreadIsInView) {
        const toastId = toastManager.add({
          type: delivery.toastType,
          title: delivery.title,
          description: delivery.description,
          data: { hideCopyButton: true, leadingIcon: delivery.icon },
          actionProps: {
            children: t("Open thread"),
            onClick: () => {
              toastManager.close(toastId);
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: delivery.threadId },
              });
            },
          },
        });
      }
      if (
        !hasDesktopNotifications(mode) ||
        windowInView ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        return;
      try {
        const notification = new Notification(delivery.title, {
          body: delivery.description,
          tag: `${environmentId}:${delivery.threadId}`,
          silent: true,
        });
        onNotification(environmentId, notification);
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: delivery.threadId },
          });
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    },
    [
      activeEnvironmentId,
      activeThreadId,
      environmentId,
      inAppNotificationsEnabled,
      mode,
      navigate,
      onNotification,
    ],
  );

  useEffect(() => {
    if (shell.status !== "live" || Option.isNone(shell.snapshot)) {
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, { attention: string | null; completion: number | null }>();
    for (const thread of shell.snapshot.value.threads) {
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestTurn?.state === "error") status = "failed";
      const prior = previous.current.get(thread.id);
      const attention =
        status === "input" || status === "approval" || status === "failed"
          ? `${thread.latestTurn?.turnId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestTurn?.completedAt ?? "");
      const completion =
        status === "ready" &&
        thread.latestTurn?.state === "completed" &&
        Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      next.set(thread.id, { attention, completion });
      if (!prior || thread.archivedAt !== null) continue;
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : completion !== null && (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
      deliverAlert({
        title: t(
          kind === "completion"
            ? "Thread completed"
            : status === "approval"
              ? "Approval needed"
              : status === "failed"
                ? "Thread failed"
                : "Input needed",
        ),
        description: thread.title,
        toastType: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
        icon:
          kind === "completion" ? (
            <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
          ) : status === "approval" ? (
            <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
          ) : status === "failed" ? (
            <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
          ) : (
            <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
          ),
        sound: kind,
        threadId: thread.id,
      });
    }
    previous.current = next;
  }, [deliverAlert, shell]);

  // The no-activity alert works from the passage of time, not from an event: a
  // quiet running thread only pushes shell updates about twice a minute. So it
  // polls on one coarse interval, only while a candidate exists, and mutates a
  // ref — a tick with nothing due re-renders nothing. The interval reads the
  // latest shell through a ref synced after each render instead of
  // restarting on every shell push: a busy sibling thread would otherwise keep
  // resetting it, and the silent thread would never be checked.
  const threads =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : [];
  const hasNoActivityCandidate =
    noActivityAlertMinutes !== null && threads.some(isNoActivityAlertCandidate);
  const noActivityLatest = useRef({ threads, deliverAlert });
  useEffect(() => {
    noActivityLatest.current = { threads, deliverAlert };
  });
  useEffect(() => {
    if (noActivityAlertMinutes === null || !hasNoActivityCandidate) return;
    const interval = setInterval(() => {
      const { threads: current, deliverAlert: deliver } = noActivityLatest.current;
      for (const thread of noActivityAlerts(
        current,
        Date.now(),
        noActivityAlertMinutes,
        alerted.current,
      )) {
        deliver({
          title: t("No activity for {minutes} minutes", { minutes: noActivityAlertMinutes }),
          description: thread.title,
          toastType: "warning",
          icon: <ClockIcon aria-hidden className="size-4 text-warning-foreground" />,
          sound: "input",
          threadId: thread.id,
        });
      }
    }, NO_ACTIVITY_ALERT_CHECK_MS);
    return () => clearInterval(interval);
  }, [hasNoActivityCandidate, noActivityAlertMinutes]);

  return null;
}
