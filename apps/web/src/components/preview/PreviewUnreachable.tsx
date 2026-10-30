import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { useT } from "~/i18n";

import { describePreviewError } from "./errorCodeMessages";
import { isFailedServerListeningAgain, isLocalDevUrl } from "./previewUnreachableLogic";
import { useDiscoveredLocalServers } from "./useDiscoveredLocalServers";

interface Props {
  url: string;
  /** Environment whose port scan tells whether a local dev server answers again. */
  environmentId: EnvironmentId;
  /** Chromium net error code, e.g. -105. */
  code: number;
  /** Stringified Chromium error, e.g. "ERR_NAME_NOT_RESOLVED". */
  description: string;
  onReload: () => void;
}

/** Theme-aware tailwind port of Chromium's "This site can't be reached" page. */
export function PreviewUnreachable({ url, environmentId, code, description, onReload }: Props) {
  const t = useT();
  const servers = useDiscoveredLocalServers({ environmentId });
  const localDev = isLocalDevUrl(url);
  const serverBack =
    localDev &&
    isFailedServerListeningAgain({ failedUrl: url, errorDescription: description, servers });
  const [showDetails, setShowDetails] = useState(false);
  const host = safeHost(url) ?? url;
  const friendly = describePreviewError(description);
  const errorLabel = description.length > 0 ? description : `ERR_${Math.abs(code) || "FAILED"}`;

  return (
    <div className="relative flex h-full min-h-0 w-full overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-8 py-12 sm:py-16">
        <ErrorIcon className="mb-6 size-12 text-muted-foreground/70" />
        <h1 className="mb-3 text-2xl font-semibold leading-tight text-foreground">
          This site can&rsquo;t be reached
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">{host}</span>: {friendly}.
        </p>

        {localDev ? (
          <div className="mt-6 rounded-lg border border-border bg-muted/40 p-4 text-sm">
            <p className="font-medium text-foreground">
              {serverBack
                ? t("The dev server is answering again.")
                : t("Is the dev server running?")}
            </p>
            {serverBack ? null : (
              <p className="mt-1 text-muted-foreground">
                {t("Nothing is answering on {host}. Start it from a terminal, then reload.", {
                  host,
                })}
              </p>
            )}
          </div>
        ) : null}

        {showDetails ? (
          <div className="mt-6 rounded-lg border border-border bg-muted/40 p-4 text-sm">
            <p className="mb-2 font-medium text-foreground">Try:</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Checking your connection</li>
              <li>Confirming the dev server is running</li>
              <li>Checking the proxy and the firewall</li>
            </ul>
          </div>
        ) : null}

        <div className="mt-8 text-xs uppercase tracking-wide text-muted-foreground/70">
          {errorLabel}
        </div>

        <div className="mt-auto flex items-center gap-2 pt-8">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowDetails((value) => !value)}
          >
            {showDetails ? "Hide details" : "Details"}
          </Button>
          <div className="flex-1" />
          <Button type="button" size="sm" onClick={onReload}>
            {serverBack ? t("Server is back — Reload") : "Reload"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ErrorIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className={className}
    >
      <path d="M16 12 L48 12 L48 52 L16 52 Z" />
      <path d="M22 22 L42 22 M22 30 L36 30 M22 38 L40 38" strokeLinecap="round" />
      <path d="M52 8 L12 56" strokeLinecap="round" />
    </svg>
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
