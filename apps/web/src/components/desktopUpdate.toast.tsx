import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { ArrowRightIcon } from "lucide-react";

import {
  getDesktopUpdateActionError,
  getDesktopUpdateActionLabel,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateReleaseUrl,
  isLocalPackageUpdate,
} from "./desktopUpdate.logic";
import { toastManager } from "./ui/toast";

type DesktopUpdateShell = Pick<DesktopBridge, "openExternal">;

export async function openDesktopUpdateReleaseNotes(
  shell: DesktopUpdateShell | undefined,
  releaseUrl: string,
): Promise<void> {
  try {
    if (shell && (await shell.openExternal(releaseUrl))) return;
  } catch {
    // Surface rejected IPC calls through the same user-visible fallback.
  }
  toastManager.add({ type: "error", title: "Unable to open release notes" });
}

function ReleaseNotesLink({
  shell,
  releaseUrl,
}: {
  shell: DesktopUpdateShell;
  releaseUrl: string;
}) {
  return (
    <button
      className="ml-2 inline cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
      onClick={() => {
        void openDesktopUpdateReleaseNotes(shell, releaseUrl);
      }}
      type="button"
    >
      Read more
      <ArrowRightIcon
        aria-hidden
        className="ml-1 inline size-3 -rotate-45 align-[-0.125em]"
        strokeWidth={2.25}
      />
    </button>
  );
}

/** Announces a newly found update with a button that starts the same download as the sidebar. */
export function showDesktopUpdateAvailableToast(
  bridge: Pick<DesktopBridge, "downloadUpdate" | "openExternal">,
  state: DesktopUpdateState,
  version: string,
): void {
  const localPackage = isLocalPackageUpdate(state);
  const toastId = toastManager.add({
    type: "info",
    title: `Update ${version} available`,
    description: localPackage
      ? "Prepare it now, or later from the update button in the sidebar."
      : "Download it now, or later from the update button in the sidebar.",
    actionProps: {
      children: getDesktopUpdateActionLabel("download", state) ?? "Download",
      onClick: () => {
        toastManager.close(toastId);
        void bridge
          .downloadUpdate()
          .then((result) => {
            if (result.completed) showDesktopUpdateDownloadedToast(bridge, result.state);
            const actionError = getDesktopUpdateActionError(result);
            if (actionError) {
              toastManager.add({
                type: "error",
                title: "Could not download update",
                description: actionError,
              });
            }
          })
          .catch((error: unknown) => {
            toastManager.add({
              type: "error",
              title: "Could not start update download",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            });
          });
      },
    },
  });
}

export function showDesktopUpdateDownloadedToast(
  shell: DesktopUpdateShell,
  state: DesktopUpdateState,
): void {
  const localPackage = isLocalPackageUpdate(state);
  const releaseUrl = getDesktopUpdateReleaseUrl(getDesktopUpdateDownloadedVersion(state), state);
  toastManager.add({
    type: "success",
    title: localPackage ? "Update prepared" : "Update downloaded",
    description: (
      <>
        {localPackage
          ? "Open the installer to finish. Complete installation, then reopen T3 Code from Applications."
          : "Restart the app from the update button to install it."}
        {releaseUrl ? <ReleaseNotesLink releaseUrl={releaseUrl} shell={shell} /> : null}
      </>
    ),
  });
}
