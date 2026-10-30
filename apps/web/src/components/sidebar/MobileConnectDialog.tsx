import {
  AuthStandardClientScopes,
  type AdvertisedEndpoint,
  type ClientSettings,
  type DesktopRemoteRelayState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createServerPairingCredential } from "~/environments/primary";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import {
  desktopNetworkAccessStateAtom,
  refreshDesktopNetworkAccessState,
} from "~/state/desktopNetworkAccess";
import { useEnvironmentQuery } from "~/state/query";
import { formatExpiresInLabel } from "~/timestampFormat";
import { useT } from "../../i18n";
import { resolveDesktopPairingUrl } from "../settings/pairingUrls";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  mobileConnectEndpoints,
  mobileConnectQrValue,
  mobileEndpointHint,
} from "./mobileConnect.logic";

type MobilePairing = {
  readonly credential: string;
  readonly expiresAt: string;
};

const selectMobileConnectMode = (settings: ClientSettings) => settings.mobileConnectMode;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function useNowTick(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}

function RemoteRelaySection({ relayEndpoint }: { relayEndpoint: AdvertisedEndpoint | null }) {
  const [state, setState] = useState<DesktopRemoteRelayState | null>(null);
  const [draftUrl, setDraftUrl] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.desktopBridge?.getRemoteRelayState().then(
      (next) => {
        setState(next);
        setDraftUrl(next.url ?? "");
      },
      (cause: unknown) => setError(errorMessage(cause, "Could not read the relay settings.")),
    );
  }, []);

  const save = useCallback(async (url: string | null) => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    setIsSaving(true);
    setError(null);
    try {
      const next = await bridge.setRemoteRelayUrl(url);
      setState(next);
      setDraftUrl(next.url ?? "");
      refreshDesktopNetworkAccessState();
    } catch (cause) {
      setError(errorMessage(cause, "Could not save the relay address."));
    } finally {
      setIsSaving(false);
    }
  }, []);

  const copySecret = useCallback(async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
    } catch (cause) {
      setError(errorMessage(cause, "Could not copy the secret. Select and copy it instead."));
    }
  }, []);

  if (state === null) {
    return error ? <p className="text-sm text-destructive">{error}</p> : null;
  }

  const trimmedDraft = draftUrl.trim();
  const status =
    state.url === null
      ? "Connect through your own Cloudflare relay. This computer dials out, so no router setup is needed."
      : relayEndpoint?.status === "available" || state.connected
        ? "Connected to your relay. Pick Cloudflare relay above for the QR code."
        : "Not connected to the relay yet. Check the address and that the relay has this secret.";

  return (
    <div className="space-y-2 rounded-lg border border-border/50 p-3">
      <div className="space-y-0.5">
        <p className="text-xs font-medium text-foreground">Use away from home</p>
        <p className="text-2xs text-muted-foreground">{status}</p>
      </div>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            placeholder="https://oop-relay.you.workers.dev"
            disabled={isSaving}
            aria-label="Relay address"
          />
        </div>
        <Button
          size="sm"
          disabled={isSaving || trimmedDraft === (state.url ?? "")}
          onClick={() => void save(trimmedDraft.length > 0 ? trimmedDraft : null)}
        >
          {isSaving ? <Spinner size="sm" /> : null}
          {trimmedDraft.length > 0 ? "Save" : "Remove"}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
          {state.secret}
        </code>
        <Button size="xs" variant="ghost" onClick={() => void copySecret(state.secret)}>
          Copy secret
        </Button>
      </div>
      <p className="text-2xs text-muted-foreground/70">
        Store this as the relay secret: npx wrangler secret put OOP_RELAY_SECRET
      </p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

function MobileConnectPanel() {
  const t = useT();
  const mode = useClientSettings(selectMobileConnectMode);
  const updateClientSettings = useUpdateClientSettings();
  const networkAccess = useEnvironmentQuery(desktopNetworkAccessStateAtom);
  const isNetworkAccessible = networkAccess.data?.serverExposureState.mode === "network-accessible";
  const endpoints = useMemo(
    () => mobileConnectEndpoints(networkAccess.data?.advertisedEndpoints ?? []),
    [networkAccess.data],
  );
  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);
  const endpoint =
    endpoints.find((candidate) => candidate.id === selectedEndpointId) ?? endpoints[0] ?? null;

  const [pairing, setPairing] = useState<MobilePairing | null>(null);
  const [isCreatingPairing, setIsCreatingPairing] = useState(false);
  const [isEnablingNetwork, setIsEnablingNetwork] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "pairing link",
    onError: (cause) => setError(errorMessage(cause, t("Could not copy the pairing link."))),
  });
  const nowMs = useNowTick(pairing !== null);
  const isPairingExpired = pairing !== null && Date.parse(pairing.expiresAt) <= nowMs;

  const createPairing = useCallback(async () => {
    setIsCreatingPairing(true);
    setError(null);
    try {
      const created = await createServerPairingCredential({
        label: "Mobile",
        scopes: AuthStandardClientScopes,
      });
      setPairing({
        credential: created.credential,
        expiresAt: DateTime.formatIso(created.expiresAt),
      });
    } catch (cause) {
      setError(errorMessage(cause, "Could not create a pairing QR code."));
    } finally {
      setIsCreatingPairing(false);
    }
  }, []);

  // One credential per dialog open; the ref keeps StrictMode's double effect from minting two.
  const requestedInitialPairing = useRef(false);
  useEffect(() => {
    if (!isNetworkAccessible || requestedInitialPairing.current) return;
    requestedInitialPairing.current = true;
    void createPairing();
  }, [createPairing, isNetworkAccessible]);

  const enableNetworkAccess = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    setIsEnablingNetwork(true);
    setError(null);
    try {
      // The desktop relaunches when the mode changes; the setting persists across restarts.
      await bridge.setServerExposureMode("network-accessible");
      refreshDesktopNetworkAccessState();
    } catch (cause) {
      setError(errorMessage(cause, "Could not allow mobile connections."));
    } finally {
      setIsEnablingNetwork(false);
    }
  }, []);

  const pairingUrl =
    pairing && endpoint ? resolveDesktopPairingUrl(endpoint.httpBaseUrl, pairing.credential) : null;
  const remoteRelaySection = (
    <RemoteRelaySection
      relayEndpoint={
        endpoints.find((candidate) => candidate.provider.id === "cloudflare-relay") ?? null
      }
    />
  );

  if (networkAccess.data === null) {
    return networkAccess.error ? (
      <p className="text-sm text-destructive">{networkAccess.error}</p>
    ) : (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  if (!isNetworkAccessible) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Mobile connections are off. Allowing them lets paired phones reach this computer over your
          network. OOP will restart once.
        </p>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button disabled={isEnablingNetwork} onClick={() => void enableNetworkAccess()}>
          {isEnablingNetwork ? <Spinner size="sm" /> : null}
          {isEnablingNetwork ? "Restarting…" : "Allow mobile connections"}
        </Button>
      </div>
    );
  }

  if (endpoint === null) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          No network address your phone can reach. Connect this computer to Wi-Fi or Tailscale, then
          check again.
        </p>
        <Button variant="outline" onClick={refreshDesktopNetworkAccessState}>
          Check again
        </Button>
        {remoteRelaySection}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ToggleGroup
        aria-label={t("How to connect")}
        className="w-full *:flex-1"
        value={[mode]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "mobile-web" || value === "oop-app") {
            updateClientSettings({ mobileConnectMode: value });
          }
        }}
      >
        <Toggle value="mobile-web">{t("Mobile web")}</Toggle>
        <Toggle value="oop-app">{t("OOP app")}</Toggle>
      </ToggleGroup>

      {endpoints.length > 1 ? (
        <div className="space-y-1.5" role="radiogroup" aria-label="How your phone reaches OOP">
          {endpoints.map((option) => {
            const isSelected = option.id === endpoint.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                className={cn(
                  "flex w-full items-baseline gap-2 rounded-lg border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isSelected
                    ? "border-foreground/60 bg-muted/30"
                    : "border-border/50 hover:bg-muted/20",
                )}
                onClick={() => setSelectedEndpointId(option.id)}
              >
                <span
                  className={cn(
                    "text-xs font-medium",
                    isSelected ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {option.label}
                </span>
                <span className="min-w-0 truncate text-2xs text-muted-foreground/70">
                  {mobileEndpointHint(option)}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{mobileEndpointHint(endpoint)}</p>
      )}

      <div className="flex flex-col items-center gap-3">
        {pairingUrl && !isPairingExpired ? (
          <>
            <div className="w-fit rounded-xl bg-white p-3">
              <QRCodeSvg
                value={mobileConnectQrValue(pairingUrl, mode)}
                size={200}
                level="M"
                marginSize={1}
                title={
                  mode === "oop-app"
                    ? t("Scan with the OOP app to connect")
                    : t("Scan with your phone camera to open OOP")
                }
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {formatExpiresInLabel(pairing?.expiresAt ?? "", nowMs)} · one phone per code
            </p>
            {mode === "oop-app" ? (
              <Button size="xs" variant="outline" onClick={() => copyToClipboard(pairingUrl)}>
                {isCopied ? t("Copied") : t("Copy pairing link")}
              </Button>
            ) : null}
          </>
        ) : (
          <div className="flex size-[224px] flex-col items-center justify-center gap-3 rounded-xl border border-border/50 p-4 text-center">
            {isCreatingPairing ? (
              <Spinner />
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {isPairingExpired ? "This code expired." : "No code yet."}
                </p>
                <Button size="sm" variant="outline" onClick={() => void createPairing()}>
                  New QR code
                </Button>
              </>
            )}
          </div>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>

      {remoteRelaySection}

      <p className="text-xs text-muted-foreground">
        {mode === "oop-app"
          ? t(
              "Open the OOP app, choose Connect with QR code, and scan this code. If the app isn't installed, choose Mobile web.",
            )
          : t("Scan with your phone camera to open OOP in the browser.")}{" "}
        {t(
          "Once paired, the phone reconnects on its own whenever this computer is online. Manage paired phones in Settings → Connections.",
        )}
      </p>
      {/* App store links go here once the listings are public. */}
    </div>
  );
}

export function MobileConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("Connect mobile")}</DialogTitle>
          <DialogDescription>
            {t("Use this computer's OOP from your phone's browser or the OOP app.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>{open ? <MobileConnectPanel /> : null}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
