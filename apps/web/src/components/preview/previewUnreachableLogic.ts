import { isLoopbackHost } from "@t3tools/shared/preview";

const PRIVATE_IPV4_PATTERN = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/** Connection-class failures: the address resolved but nothing answered (or stopped answering). */
const SERVER_DOWN_ERROR_PATTERN = /^ERR_(?:CONNECTION_|EMPTY_RESPONSE$)/;

function parseHttpUrl(raw: string): URL | null {
  if (!URL.canParse(raw)) return null;
  const parsed = new URL(raw);
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
}

function effectivePort(url: URL): number {
  if (url.port) return Number.parseInt(url.port, 10);
  return url.protocol === "https:" ? 443 : 80;
}

/** Loopback, `*.localhost`, mDNS `*.local`, and private LAN addresses: where a dev server lives. */
export function isLocalDevUrl(raw: string): boolean {
  const url = parseHttpUrl(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return (
    isLoopbackHost(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    PRIVATE_IPV4_PATTERN.test(host)
  );
}

/**
 * True when a failed connection to `failedUrl` now has a live listener on the same port:
 * the dev server it was waiting for has come back. Other failures (TLS, DNS, blocked) say
 * nothing about a listener, so they never read as "back".
 */
export function isFailedServerListeningAgain(input: {
  failedUrl: string;
  errorDescription: string;
  servers: ReadonlyArray<{ readonly url: string; readonly requestedUrl: string }>;
}): boolean {
  if (!SERVER_DOWN_ERROR_PATTERN.test(input.errorDescription)) return false;
  const failed = parseHttpUrl(input.failedUrl);
  if (!failed || !isLocalDevUrl(input.failedUrl)) return false;
  const failedHost = failed.hostname.toLowerCase();
  return input.servers.some((server) =>
    [server.url, server.requestedUrl].some((candidate) => {
      const listening = parseHttpUrl(candidate);
      if (!listening || effectivePort(listening) !== effectivePort(failed)) return false;
      const listeningHost = listening.hostname.toLowerCase();
      return (
        listeningHost === failedHost ||
        (isLoopbackHost(listeningHost) && isLoopbackHost(failedHost))
      );
    }),
  );
}
