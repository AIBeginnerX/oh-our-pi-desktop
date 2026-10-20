import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { usePrimaryEnvironment } from "../state/environments";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { primaryServerProvidersAtom, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  collectProviderSetupIssues,
  describeProviderSetupIssue,
  isUpdateFolderUnreachable,
  providerSetupNotificationKey,
} from "./setupNotifications.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

type ToastId = ReturnType<typeof toastManager.add>;
const announcedKeys = new Set<string>();

/**
 * Points the user at what still has to be finished before OOP works: an unreachable
 * update folder and providers to install or sign in to. Each situation is announced once
 * per session and its toast closes when the situation clears. Settings → General →
 * Setup notifications turns this off.
 */
export function SetupNotificationCoordinator() {
  const enabled = useClientSettings((settings) => settings.setupNotificationsEnabled);
  return enabled ? <SetupNotifications /> : null;
}

function SetupNotifications() {
  const navigate = useNavigate();
  const updateState = useDesktopUpdateState();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const folderToast = useRef<ToastId | null>(null);
  const providerToast = useRef<{ readonly id: ToastId; readonly key: string } | null>(null);

  useEffect(
    () => () => {
      if (folderToast.current !== null) toastManager.close(folderToast.current);
      if (providerToast.current !== null) toastManager.close(providerToast.current.id);
    },
    [],
  );

  const folderUnreachable = isUpdateFolderUnreachable(updateState);
  // The desktop app's own message says what to do: set up Google Drive, or reach the NAS share.
  const folderMessage = updateState?.message ?? null;
  const canOpenFolder = updateState?.canOpenUpdateSource === true;
  useEffect(() => {
    if (!folderUnreachable) {
      if (folderToast.current !== null) toastManager.close(folderToast.current);
      folderToast.current = null;
      return;
    }
    if (folderToast.current !== null || announcedKeys.has("update-folder")) return;
    announcedKeys.add("update-folder");
    folderToast.current = toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Can't reach the update folder",
        description:
          folderMessage ??
          "OOP could not read its update folder. Check that it is available; OOP checks again every few minutes.",
        timeout: 0,
        ...(canOpenFolder
          ? {
              actionProps: {
                children: "Connect",
                onClick: () => {
                  void window.desktopBridge?.openUpdateSource?.().then((opened) => {
                    if (!opened) {
                      toastManager.add({
                        type: "error",
                        title: "Could not open the shared folder",
                      });
                    }
                  });
                },
              },
            }
          : {}),
        data: {
          onClose: () => {
            folderToast.current = null;
          },
        },
      }),
    );
  }, [folderUnreachable, folderMessage, canOpenFolder]);

  const issues = useMemo(() => collectProviderSetupIssues(providers), [providers]);
  const issuesKey = providerSetupNotificationKey(issues);
  useEffect(() => {
    const active = providerToast.current;
    if (active !== null && active.key !== issuesKey) {
      toastManager.close(active.id);
      providerToast.current = null;
    }
    if (issuesKey === null || providerToast.current !== null || announcedKeys.has(issuesKey)) {
      return;
    }
    announcedKeys.add(issuesKey);
    const installable = issues.filter((issue) => issue.need === "install");
    const id = toastManager.add(
      stackedThreadToast({
        type: "warning",
        title:
          issues.length === 1
            ? `${issues[0]!.name} needs setup`
            : `${issues.length} providers need setup`,
        description: issues.map(describeProviderSetupIssue).join("\n"),
        timeout: 0,
        actionProps:
          installable.length > 0 && primaryEnvironment
            ? {
                children:
                  installable.length === 1 ? `Install ${installable[0]!.name}` : "Install all",
                onClick: () => {
                  toastManager.close(id);
                  providerToast.current = null;
                  void (async () => {
                    for (const issue of installable) {
                      await updateProvider({
                        environmentId: primaryEnvironment.environmentId,
                        input: {
                          provider: issue.provider.driver,
                          instanceId: issue.provider.instanceId,
                        },
                      });
                    }
                  })();
                  void navigate({ to: "/settings/providers" });
                },
              }
            : {
                children: "Open settings",
                onClick: () => {
                  toastManager.close(id);
                  providerToast.current = null;
                  void navigate({ to: "/settings/providers" });
                },
              },
        data: {
          onClose: () => {
            providerToast.current = null;
          },
        },
      }),
    );
    providerToast.current = { id, key: issuesKey };
  }, [issues, issuesKey, navigate, primaryEnvironment, updateProvider]);

  return null;
}
