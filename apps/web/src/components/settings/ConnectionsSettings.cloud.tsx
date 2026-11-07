import { ChevronsLeftRightEllipsisIcon, EllipsisIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useState } from "react";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { PhoneShareToggle } from "./ConnectionsSettings.phone";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "~/versionSkew";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { type EnvironmentPresentation, useRelayEnvironmentDiscovery } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { gatewayStatusText, useGatewayEnvironmentInfo } from "~/state/gateway";
import { ServerUpdateAction, ServerUpdateProgress } from "../ServerUpdateAction";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";

type SavedBackendListRowProps = {
  environment: EnvironmentPresentation;
  removingEnvironmentId: EnvironmentId | null;
  onSetEnabled: (environmentId: EnvironmentId, enabled: boolean) => void;
  onRemove: (environment: EnvironmentPresentation) => void;
};

/**
 * Status word for a row subtitle: "Reconnecting: <reason>" instead of the
 * long-form sentence, since the row has one line and the full text is one
 * hover away.
 */

function savedBackendStatus(environment: EnvironmentPresentation): {
  readonly text: string;
  readonly tone: "muted" | "error";
} {
  if (!environment.entry.enabled && environment.connection.phase !== "unsupported")
    return { text: "Off", tone: "muted" };
  const { connection } = environment;
  switch (connection.phase) {
    case "connected":
      return { text: "Connected", tone: "muted" };
    case "connecting":
      return { text: "Connecting", tone: "muted" };
    case "reconnecting":
      return {
        text: connection.error ? `Reconnecting: ${connection.error}` : "Reconnecting",
        tone: "error",
      };
    // Not a failure: the machine is fine, this build just cannot talk to it.
    case "unsupported":
      return { text: "Client not supported", tone: "muted" };
    case "error":
      return {
        text: connection.error ? `Connection failed: ${connection.error}` : "Connection failed",
        tone: "error",
      };
    case "offline":
      return { text: "Offline", tone: "muted" };
    case "available":
      return { text: "Not connected", tone: "muted" };
  }
}

/**
 * One added machine in the Environments list. The switch is the main action;
 * the update icon appears only when that machine can take an update; the
 * row menu holds the icon override, trace ID, and removal.
 */

export function SavedBackendListRow({
  environment,
  removingEnvironmentId,
  onSetEnabled,
  onRemove,
}: SavedBackendListRowProps) {
  const environmentId = environment.environmentId;
  const unsupported = environment.connection.phase === "unsupported";
  const enabled = environment.entry.enabled && !unsupported;
  const isConnected = environment.connection.phase === "connected";
  const isRemoving = removingEnvironmentId === environmentId;
  const errorTraceId = environment.connection.traceId;
  const { copyToClipboard: copyTraceIdToClipboard } = useCopyToClipboard<{ traceId: string }>({
    target: "trace ID",
    onCopy: ({ traceId }) => {
      toastManager.add({
        type: "success",
        title: "Trace ID copied",
        description: traceId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy trace ID",
          description: error.message,
        }),
      );
    },
  });
  const copyTraceId = useCallback(
    (traceId: string) => {
      copyTraceIdToClipboard(traceId, { traceId });
    },
    [copyTraceIdToClipboard],
  );
  const versionMismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
  const serverUpdateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const resumingServerUpdate =
    serverUpdateState.status === "running" && serverUpdateState.stage === "resuming";
  // A gateway environment belongs to the host's desktop: it is shared or unshared there, so
  // this device can neither switch it off nor remove it.
  const gatewayInfo = useGatewayEnvironmentInfo(environmentId);
  const gatewayManaged = environment.entry.target._tag === "GatewayConnectionTarget";
  const status = savedBackendStatus(environment);
  const gatewayStatus = gatewayManaged ? gatewayStatusText(gatewayInfo?.status) : null;
  const serverVersion = environment.serverConfig?.environment.serverVersion ?? null;
  // A saved T3 Connect machine this device has never reached (unsupported,
  // or not yet connected) still has a descriptor from relay discovery, so
  // it can wear its detected glyph instead of the generic server. Discovery
  // empties its map on every refresh, so hold the last descriptor seen or
  // the glyph would blink back to the generic one each time.
  const relayDiscovery = useRelayEnvironmentDiscovery();
  const discoveredDescriptor = Option.getOrNull(
    relayDiscovery.environments.get(environmentId)?.status ?? Option.none(),
  )?.descriptor;
  const [lastDescriptor, setLastDescriptor] = useState(discoveredDescriptor);
  if (discoveredDescriptor !== undefined && discoveredDescriptor !== lastDescriptor) {
    setLastDescriptor(discoveredDescriptor);
  }
  const machineKind = resolveEnvironmentMachineKind(
    environment.serverConfig ??
      (lastDescriptor === undefined ? null : { environment: lastDescriptor }),
  );
  const subtitleText = [
    environmentTransportLabel(environment, gatewayInfo),
    resumingServerUpdate ? "Restarting" : (gatewayStatus ?? status.text),
    enabled && versionMismatch ? serverVersion : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" · ");

  // Only a connected, enabled machine can take a remote update; a switched-off
  // one keeps the version note so the icon is not a surprise later.
  const showUpdateAction =
    enabled &&
    isConnected &&
    versionMismatch !== null &&
    (serverUpdateState.status === "idle" || serverUpdateState.status === "failed");

  const statusTooltip = `${
    unsupported
      ? (environment.connection.error ?? connectionStatusText(environment.connection))
      : enabled
        ? connectionStatusText(environment.connection)
        : "Switched off"
  }${
    versionMismatch
      ? `\nUpdate available: ${versionMismatch.serverVersion} → ${versionMismatch.clientVersion}`
      : ""
  }`;

  return (
    <EnvironmentRow
      kind={machineKind}
      label={environment.label}
      dimmed={!enabled}
      subtitle={
        <Tooltip>
          {/* The status can change while the tooltip is open, and base-ui only
              re-measures the popup when the trigger's payload changes. */}
          <TooltipTrigger
            payload={statusTooltip}
            render={
              <span
                className={cn(
                  "block truncate",
                  enabled && status.tone === "error" && !resumingServerUpdate && "text-destructive",
                )}
              />
            }
          >
            {subtitleText}
          </TooltipTrigger>
          <TooltipPopup side="top" className="whitespace-pre-wrap">
            {statusTooltip}
          </TooltipPopup>
        </Tooltip>
      }
      below={
        <>
          {serverUpdateState.status !== "idle" ? (
            <div className="mt-1 max-w-md">
              <ServerUpdateProgress state={serverUpdateState} />
            </div>
          ) : null}
          <PhoneShareToggle
            environmentId={environmentId}
            label={environment.label}
            targetTag={environment.entry.target._tag}
          />
        </>
      }
    >
      {showUpdateAction ? (
        <ServerUpdateAction
          environmentId={environmentId}
          serverLabel={`${environment.label} server`}
          selfUpdate={resolveServerSelfUpdateCapability(environment.serverConfig)}
          desktopAppUpdate={supportsDesktopAppUpdate(environment.serverConfig)}
          threadContinuation={supportsServerUpdateThreadContinuation(environment.serverConfig)}
          targetVersion={versionMismatch.clientVersion}
          label={serverUpdateState.status === "failed" ? "Retry update" : "Update"}
          appearance="icon"
        />
      ) : null}
      {gatewayManaged ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Switch
                size="sm"
                checked={enabled}
                disabled={isRemoving || unsupported}
                aria-label={`${enabled ? "Switch off" : "Switch on"} ${environment.label}`}
                onCheckedChange={(checked) => onSetEnabled(environmentId, checked)}
              />
            }
          />
          <TooltipPopup side="top">
            {unsupported ? "Client not supported" : enabled ? "Switch off" : "Switch on"}
          </TooltipPopup>
        </Tooltip>
      )}
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              disabled={isRemoving}
              aria-label={`More actions for ${environment.label}`}
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          <EnvironmentIconMenu
            environmentId={environmentId}
            serverConfig={environment.serverConfig}
          />
          {errorTraceId ? (
            <MenuItem onClick={() => copyTraceId(errorTraceId)}>Copy trace ID</MenuItem>
          ) : null}
          {gatewayManaged ? null : (
            <>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => onRemove(environment)}>
                {isRemoving ? "Removing…" : "Remove from this device…"}
              </MenuItem>
            </>
          )}
        </MenuPopup>
      </Menu>
    </EnvironmentRow>
  );
}

function CloudLinkSwitch({
  checked,
  disabled,
  disabledReason,
  onCheckedChange,
  ariaLabel = "Enable OOP Connect",
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly onCheckedChange?: (enabled: boolean) => void;
  readonly ariaLabel?: string;
}) {
  const control = (
    <Switch
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      {...(onCheckedChange ? { onCheckedChange } : {})}
    />
  );
  return disabledReason ? (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{control}</span>} />
      <TooltipPopup side="top">{disabledReason}</TooltipPopup>
    </Tooltip>
  ) : (
    control
  );
}

function ConfiguredCloudLinkRow({ canManageRelay }: { readonly canManageRelay: boolean }) {
  const {
    isSignedIn,
    linkState: primaryCloudLinkState,
    managedTunnelActive,
    publishAgentActivity,
    operationError,
    reconcileCloudState,
  } = useCloudLinkController();
  const [isUpdating, setIsUpdating] = useState(false);
  const [isUpdatingPreference, setIsUpdatingPreference] = useState(false);

  const disabledReason = !isSignedIn
    ? "Sign in to OOP Connect to manage this environment."
    : !canManageRelay
      ? "Your session does not have permission to manage OOP Connect access."
      : null;
  const isBusy = isUpdating || isUpdatingPreference;

  const updateManagedTunnel = async (enabled: boolean) => {
    setIsUpdating(true);
    const ok = await reconcileCloudState({ managedTunnel: enabled, publish: publishAgentActivity });
    if (ok) {
      // Turning the tunnel off while publishing stays on downgrades the link
      // rather than removing it — say so instead of claiming an unlink.
      toastManager.add({
        type: "success",
        title: enabled
          ? "OOP Connect linked"
          : publishAgentActivity
            ? "OOP Connect tunnel disabled"
            : "OOP Connect unlinked",
        description: enabled
          ? "This environment is available through OOP Connect."
          : publishAgentActivity
            ? "The managed tunnel was removed. Agent activity publishing stays on."
            : "This environment is no longer available through OOP Connect.",
      });
    }
    setIsUpdating(false);
  };

  const updatePublishAgentActivity = async (enabled: boolean) => {
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({ managedTunnel: managedTunnelActive, publish: enabled });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled ? "Agent activity enabled" : "Agent activity disabled",
        description: enabled
          ? "This environment publishes agent activity to your mobile clients."
          : "This environment will stop publishing agent activity.",
      });
    }
    setIsUpdatingPreference(false);
  };

  return (
    <>
      {window.desktopBridge ? (
        <SettingsRow
          title={searchableSetting("t3-connect").title}
          description={
            managedTunnelActive
              ? "This environment is available to your other devices through OOP Connect."
              : "Make this environment available to your other devices through OOP Connect."
          }
          status={operationError ?? primaryCloudLinkState.error}
          control={
            <CloudLinkSwitch
              checked={managedTunnelActive}
              disabled={!canManageRelay || !isSignedIn || primaryCloudLinkState.isPending || isBusy}
              disabledReason={disabledReason}
              onCheckedChange={(enabled) => void updateManagedTunnel(enabled)}
            />
          }
        />
      ) : null}
      <SettingsRow
        title={searchableSetting("publish-agent-activity").title}
        description="Send activity to mobile notifications and Live Activities without OOP Connect."
        control={
          <CloudLinkSwitch
            ariaLabel="Publish agent activity to mobile clients"
            checked={publishAgentActivity}
            disabled={!canManageRelay || !isSignedIn || primaryCloudLinkState.isPending || isBusy}
            disabledReason={disabledReason}
            onCheckedChange={(enabled) => void updatePublishAgentActivity(enabled)}
          />
        }
      />
    </>
  );
}

export function CloudLinkRow({ canManageRelay }: { readonly canManageRelay: boolean }) {
  return hasCloudPublicConfig() ? <ConfiguredCloudLinkRow canManageRelay={canManageRelay} /> : null;
}

function EmptyRemoteEnvironments({ cloudEnabled = true }: { readonly cloudEnabled?: boolean }) {
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <ChevronsLeftRightEllipsisIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No saved remote environments</EmptyTitle>
        <EmptyDescription>
          {cloudEnabled
            ? "Click “Add environment” to pair another environment, or connect one from OOP Connect."
            : "Click “Add environment” to pair another environment."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function CloudRemoteEnvironmentRows({
  primaryEnvironmentId,
  savedEnvironments,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
}) {
  return hasCloudPublicConfig() ? (
    <CloudEnvironmentConnectRows
      primaryEnvironmentId={primaryEnvironmentId}
      savedEnvironments={savedEnvironments}
      empty={<EmptyRemoteEnvironments />}
    />
  ) : savedEnvironments.length === 0 ? (
    <EmptyRemoteEnvironments cloudEnabled={false} />
  ) : null;
}
