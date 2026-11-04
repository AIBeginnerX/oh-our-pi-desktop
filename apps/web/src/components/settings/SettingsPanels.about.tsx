import { searchableSetting } from "./settingsSearch";
import type { DesktopMenuLanguage } from "@t3tools/contracts";
import { Fragment, useCallback, useState } from "react";
import { type DesktopUpdateChannel } from "@t3tools/contracts";
import { APP_VERSION, HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL } from "../../branding";
import {
  canCheckForUpdate,
  describeDesktopBuild,
  getDisplayedAppVersion,
  getDesktopUpdateActionLabel,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDescription,
  getDesktopUpdateInstallConfirmationMessage,
  isLocalPackageUpdate,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { buildHostedChannelSelectionUrl, type HostedAppChannel } from "../../hostedPairing";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useT } from "../../i18n";
import { MENU_LANGUAGE_OPTIONS, useMenuLanguage } from "../../state/menuLanguage";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";

export function AboutVersionTitle() {
  const t = useT();
  const version = getDisplayedAppVersion(
    useDesktopUpdateState(),
    typeof window !== "undefined" && Boolean(window.desktopBridge),
    APP_VERSION,
  );
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{t("Version")}</span>
      {version ? (
        <code className="text-2xs font-medium text-muted-foreground">{version}</code>
      ) : null}
    </span>
  );
}

/**
 * The native application menu's language. Desktop-only: browsers and older desktop builds keep
 * the English menu, so the row is hidden when the bridge method is missing.
 */

export function MenuLanguageRow() {
  const {
    supported: supportsMenuLanguage,
    language: menuLanguage,
    isChanging: isChangingMenuLanguage,
    change: handleMenuLanguageChange,
  } = useMenuLanguage();
  const t = useT();

  if (!supportsMenuLanguage) return null;

  return (
    <SettingsRow
      {...searchableSetting("setting-menu-language")}
      title={t("Language")}
      description={t("The language of the interface, and of the menu bar in the desktop app.")}
      control={
        <Select
          value={menuLanguage ?? "system"}
          onValueChange={(value) => {
            handleMenuLanguageChange(value as DesktopMenuLanguage);
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-40"
            aria-label={t("Language")}
            disabled={isChangingMenuLanguage || menuLanguage === null}
          >
            <SelectValue>
              {(menuLanguage ?? "system") === "system"
                ? t("System")
                : MENU_LANGUAGE_OPTIONS.find((option) => option.value === menuLanguage)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {MENU_LANGUAGE_OPTIONS.map((option) => (
              <SelectItem hideIndicator key={option.value} value={option.value}>
                {option.value === "system" ? t(option.label) : option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function AboutVersionSection() {
  const t = useT();
  const updateState = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);
  const [isUpdateActionPending, setIsUpdateActionPending] = useState(false);

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const isLocalPackage = isLocalPackageUpdate(updateState);
  const selectedUpdateChannel = updateState?.channel ?? "latest";
  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL;

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: t("Could not change update track"),
              description:
                error instanceof Error ? error.message : t("Update track change failed."),
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [selectedUpdateChannel, t],
  );

  const handleButtonClick = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Could not download update"),
            description: error instanceof Error ? error.message : t("Download failed."),
          }),
        );
      });
      return;
    }

    if (action === "install") {
      if (isUpdateActionPending) return;
      setIsUpdateActionPending(true);
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(
            updateState ?? { availableVersion: null, downloadedVersion: null },
          ),
        );
      } catch (error) {
        setIsUpdateActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Could not confirm update"),
            description: error instanceof Error ? error.message : t("Update confirmation failed."),
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsUpdateActionPending(false);
        return;
      }
      void bridge
        .installUpdate()
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: t("Could not install update"),
              description: error instanceof Error ? error.message : t("Install failed."),
            }),
          );
        })
        .finally(() => setIsUpdateActionPending(false));
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: t("Could not check for updates"),
              description:
                result.state.message ?? t("Automatic updates are not available in this build."),
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Could not check for updates"),
            description: error instanceof Error ? error.message : t("Update check failed."),
          }),
        );
      });
  }, [isUpdateActionPending, t, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel = getDesktopUpdateActionLabel(action, updateState);
  const statusLabel: Record<string, string> = {
    checking: t("Checking…"),
    downloading: t("Downloading…"),
    "up-to-date": t("Up to Date"),
  };
  const buttonLabel =
    (actionLabel ? t(actionLabel) : null) ??
    statusLabel[updateState?.status ?? ""] ??
    t("Check for Updates");
  const updateDescription = getDesktopUpdateDescription(updateState, action);
  const description =
    updateDescription === "Update available." ||
    updateDescription === "Current version of the application."
      ? t(updateDescription)
      : updateDescription;

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={buttonDisabled || isUpdateActionPending}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {updateState?.build ? (
        <SettingsRow
          title={t("Build")}
          description={
            <span className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
              {describeDesktopBuild(updateState.build).map((fact) => (
                <Fragment key={fact.label}>
                  <span>{t(fact.label)}</span>
                  <code className="break-all text-foreground/80">{t(fact.value)}</code>
                </Fragment>
              ))}
            </span>
          }
        />
      ) : null}
      {hasDesktopBridge && !isLocalPackage ? (
        <SettingsRow
          title={t("Update track")}
          description={t("Use stable releases or nightly builds. Switch back anytime.")}
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) => {
                handleUpdateChannelChange(value as DesktopUpdateChannel);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label={t("Update track")}
                disabled={isChangingUpdateChannel}
              >
                <SelectValue>
                  {t(selectedUpdateChannel === "nightly" ? "Nightly" : "Stable")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  {t("Stable")}
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  {t("Nightly")}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : selectedHostedAppChannel ? (
        <SettingsRow
          title={t("Update track")}
          description={t("Switches the hosted app release channel.")}
          control={
            <Select
              value={selectedHostedAppChannel}
              onValueChange={(value) => {
                if (value === selectedHostedAppChannel) return;
                window.location.assign(
                  buildHostedChannelSelectionUrl({ channel: value as HostedAppChannel }),
                );
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={t("Update track")}>
                <SelectValue>
                  {HOSTED_APP_CHANNEL_LABEL ? t(HOSTED_APP_CHANNEL_LABEL) : null}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  {t("Latest")}
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  {t("Nightly")}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  );
}
