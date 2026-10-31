import { getPairingTokenFromUrl, resolveRemotePairingTarget } from "@t3tools/shared/remote";

import { TransportError } from "./transport.ts";

export interface PairTarget {
  readonly credential: string;
  readonly httpBaseUrl: string;
}

const LINK = /^[a-z][a-z0-9+.-]*:\/\//iu;
const APP_WINDOW_LINK = /^t3code(-dev)?:\/\//iu;

/** With network access off the desktop app links to its own window, which is not a server address. */
export const carriesServerAddress = (input: string): boolean => {
  const value = input.trim();
  return LINK.test(value) && !APP_WINDOW_LINK.test(value);
};

/**
 * `oop pair` takes either the full pairing link the app shows or the bare one-time token. A bare
 * token, or a link to the app's own window, needs a server address: the discovered one, or `--server`.
 */
export const resolvePairTarget = (input: string, serverOrigin: string | null): PairTarget => {
  const value = input.trim();
  if (value.length === 0) throw new Error("페어링 링크 또는 토큰을 입력하세요.");
  if (carriesServerAddress(value)) {
    const target = resolveRemotePairingTarget({ pairingUrl: value });
    return { credential: target.credential, httpBaseUrl: target.httpBaseUrl };
  }
  if (serverOrigin === null) {
    throw new Error(
      "토큰만으로는 서버를 알 수 없습니다. 페어링 링크 전체를 쓰거나 --server 주소를 지정하세요.",
    );
  }
  const pairingCode = APP_WINDOW_LINK.test(value)
    ? (getPairingTokenFromUrl(new URL(value)) ?? "")
    : value;
  const target = resolveRemotePairingTarget({ host: serverOrigin, pairingCode });
  return { credential: target.credential, httpBaseUrl: target.httpBaseUrl };
};

/**
 * What `oop pair` prints when pairing fails. A refused token is fixed by a new link; a server
 * speaking another protocol never looked at the link, and only an update fixes that. A cause that
 * was not named gets no advice rather than a wrong one (the same split as the connection banner).
 * During pairing the server answers `configuration` only for a link that may not grant this client
 * its scopes, such as a read-only one, and it has used the link up by then.
 */
export const pairFailureMessage = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const failure = `페어링에 실패했습니다: ${message}`;
  if (!(cause instanceof TransportError) || cause.kind !== "blocked") return failure;
  if (cause.reason === "authentication") {
    return `${failure}\n링크는 한 번만 쓸 수 있고 곧 만료됩니다. 새 링크를 만들어 다시 시도하세요.`;
  }
  if (cause.reason === "unsupported") {
    return `${failure}\n프로토콜 불일치: 앱이나 oop 을 업데이트하세요.`;
  }
  if (cause.reason === "configuration") {
    return `${failure}\n이 링크의 권한으로는 oop 을 연결할 수 없고 링크는 이미 쓰였습니다. 읽기 전용이 아닌 새 링크를 만들어 다시 시도하세요.`;
  }
  return failure;
};
