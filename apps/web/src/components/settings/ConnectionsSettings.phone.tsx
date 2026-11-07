import type { DesktopPhoneSharedEnvironment, EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";

const REFRESH_INTERVAL_MS = 10_000;

/** Target kinds the desktop can forward to phones: bearer/Tailscale remotes and SSH hosts. */
export function canSharePhoneEnvironment(targetTag: string): boolean {
  return targetTag === "BearerConnectionTarget" || targetTag === "SshConnectionTarget";
}

/**
 * "Available on phone" for one saved environment, desktop app only. The desktop publishes the
 * environment to its own server, which phones connected to this computer reach; turning it off
 * removes access.
 */
export function PhoneShareToggle({
  environmentId,
  label,
  targetTag,
}: {
  environmentId: EnvironmentId;
  label: string;
  targetTag: string;
}) {
  const bridge = window.desktopBridge;
  const supported =
    bridge?.getPhoneSharedEnvironments !== undefined &&
    bridge.setEnvironmentPhoneShared !== undefined &&
    canSharePhoneEnvironment(targetTag);
  const [shared, setShared] = useState<ReadonlyArray<DesktopPhoneSharedEnvironment>>([]);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const refresh = () => {
      void bridge.getPhoneSharedEnvironments!().then(
        (next) => {
          if (!cancelled) setShared(next);
        },
        () => undefined,
      );
    };
    refresh();
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bridge, supported]);

  const onCheckedChange = useCallback(
    (checked: boolean) => {
      if (!supported || pending) return;
      setPending(true);
      bridge.setEnvironmentPhoneShared!(environmentId, checked).then(
        (next) => {
          setShared(next);
          setPending(false);
        },
        (error: unknown) => {
          setPending(false);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change phone access",
              description: error instanceof Error ? error.message : String(error),
            }),
          );
        },
      );
    },
    [bridge, environmentId, pending, supported],
  );

  if (!supported) return null;
  const entry = shared.find((value) => value.environmentId === environmentId);
  return (
    <div className="mt-1 flex max-w-md items-start gap-2">
      <Switch
        size="sm"
        checked={entry !== undefined}
        disabled={pending}
        aria-label={`Available on phone: ${label}`}
        onCheckedChange={onCheckedChange}
      />
      <div className="min-w-0 text-xs text-muted-foreground">
        <span className="text-foreground">Available on phone</span>
        {entry?.state === "error" ? (
          <span className="text-destructive">{` · ${entry.message ?? "Could not share"}`}</span>
        ) : entry?.state === "connecting" ? (
          " · Connecting"
        ) : null}
        <div>
          Phones connected to this computer can open this device. Turning it off removes access.
        </div>
      </div>
    </div>
  );
}
