import type { CredentialStore, StoredCredential } from "./credentials.ts";

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
  return `주의: ${url.host} 에 암호화 없는 http 로 연결합니다. 토큰과 대화 내용이 네트워크에 그대로 보입니다.`;
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
      error: `${server.label} 와(과) 아직 연결되지 않았습니다.\n데스크톱 앱에서 페어링 링크를 만든 뒤 'oop pair <링크>' 를 한 번 실행하세요.`,
      replaceable: true,
    };
  }
  return {
    error: `${server.origin} 은(는) 연결할 때 저장한 서버(${elsewhere})가 아니므로 저장된 토큰을 보내지 않습니다.\n저장한 서버를 쓰려면 'oop --server ${elsewhere}' 를, 이 서버를 쓰려면 이 서버에서 만든 페어링 링크로 'oop pair <링크>' 를 실행하세요.`,
    replaceable: true,
  };
};
