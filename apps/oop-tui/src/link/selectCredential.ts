import type { CredentialStore, StoredCredential } from "./credentials.ts";
import { t } from "../i18n/index.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const parse = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const isLoopback = (url: URL): boolean => LOOPBACK_HOSTS.has(url.hostname);

export const isLoopbackOrigin = (origin: string): boolean => {
  const url = parse(origin);
  return url !== null && isLoopback(url);
};

/** One line for the user when the address is plain http to another machine; null otherwise. */
export const plainHttpWarning = (origin: string): string | null => {
  const url = parse(origin);
  if (url === null || url.protocol !== "http:" || isLoopback(url)) return null;
  return t("link.plainHttp", { host: url.host });
};

/**
 * Whether a token issued for `stored` may be sent to `requested`. Anything that answers with the
 * right (public) environment id could otherwise collect the token. The desktop app's port changes
 * between launches, so two loopback addresses count as the same server whatever their ports.
 */
export const originsMatch = (stored: string, requested: string): boolean => {
  const from = parse(stored);
  const to = parse(requested);
  if (from === null || to === null) return false;
  if (from.protocol !== to.protocol) return false;
  if (isLoopback(from) && isLoopback(to)) return true;
  return from.origin === to.origin;
};

export interface ResolvedServer {
  readonly origin: string;
  readonly environmentId: string;
  readonly label: string;
}

/**
 * The server when this computer may ask it for a new token: one the desktop app announced on the
 * loopback. An address given with --server carries no pid and is never asked.
 */
export const localServer = (server: {
  readonly origin: string;
  readonly pid?: number;
}): { readonly origin: string; readonly pid: number } | null =>
  server.pid !== undefined && isLoopbackOrigin(server.origin)
    ? { origin: server.origin, pid: server.pid }
    : null;

/** The saved token for the server at hand, or the reason there is none to use (`replaceable`: a new token would fix it). */
export const selectCredential = async (
  store: CredentialStore,
  server: ResolvedServer,
): Promise<
  | { readonly credential: StoredCredential }
  | { readonly error: string; readonly replaceable: boolean }
> => {
  let credential: StoredCredential | null;
  let elsewhere: string | null = null;
  try {
    credential = await store.find(server.environmentId, server.origin);
    if (credential === null) elsewhere = await store.savedAddress(server.environmentId);
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause), replaceable: false };
  }
  if (credential !== null) return { credential };
  if (elsewhere === null) {
    return {
      error: t("link.notPaired", { label: server.label }),
      replaceable: true,
    };
  }
  return {
    error: t("link.otherServer", { origin: server.origin, elsewhere }),
    replaceable: true,
  };
};
