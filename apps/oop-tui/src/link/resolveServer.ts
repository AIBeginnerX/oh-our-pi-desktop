import { STARTUP_TIMEOUT_MS, type DaemonLauncher } from "./daemon.ts";
import type { DiscoveryResult } from "./discovery.ts";
import { inspectServer, originPort, waitUntilFound } from "./localAccess.ts";
import { isLoopbackOrigin, originsMatch, type ResolvedServer } from "./selectCredential.ts";
import { TransportError } from "./transport.ts";

type Inspect = (pid: number, port: number) => Promise<object | null>;

type Discovery = DiscoveryResult | { readonly kind: "unverified"; readonly detail: string };

/**
 * Discovery plus the proof that a token may go to what it found. A server announced on the
 * loopback counts as found only when its process is this user's and listens on the announced port:
 * the announcement may be stale or name someone else's server. Both the first connection and every
 * reconnection go through this.
 */
const discoverVerified = async (
  discover: () => Promise<DiscoveryResult>,
  inspect: Inspect,
): Promise<Discovery> => {
  const result = await discover();
  if (result.kind !== "found" || !isLoopbackOrigin(result.origin)) return result;
  if ((await inspect(result.pid, originPort(result.origin)).catch(() => null)) !== null) {
    return result;
  }
  return {
    kind: "unverified",
    detail: `토큰을 보내지 않았습니다: ${result.origin} 의 서버(pid ${result.pid})가 이 사용자의 프로세스이고 그 포트에서 리슨 중인지 확인하지 못했습니다.\n믿을 수 있는 서버라면 'oop --server <주소>' 로 직접 지정하세요.`,
  };
};

/**
 * The reasons shown in the banner while reconnecting. The banner is one row with a countdown, so
 * these stay short enough to be read whole at 80 columns; the long explanation is for a failed start.
 */
const UNVERIFIED_REASON = "서버 확인 실패, 토큰 보내지 않음";
const OTHER_SERVER_REASON = "다른 서버라서 토큰 보내지 않음";
const NO_SERVER_REASON = "OOP 앱 꺼짐 — 켜면 자동 재연결";
/** With the terminal's own server available, the wait is the terminal's to end, not the user's. */
const WAITING_FOR_OWN_SERVER_REASON = "서버 없음 — 곧 자동으로 띄웁니다";
const OWN_SERVER_FAILED_REASON = "서버 시작 실패 — 앱을 켜세요";
const APP_UPDATING_REASON = "앱 업데이트 중 — 자동 재연결";
const OWN_SERVER_SLOW_REASON = "서버 시작이 느림 — 계속 확인";

/** How long a server may stay gone before the terminal starts its own; the app may be restarting. */
export const OWN_SERVER_GRACE_MS = 5_000;

type Down = Exclude<Discovery, { readonly kind: "found" | "unverified" }>;

/** No server was found (as opposed to one that was found but may not be trusted). */
const isDown = (result: Discovery): result is Down =>
  result.kind !== "found" && result.kind !== "unverified";

/** What lets the reconnection start the terminal's own server once the old one has stayed gone. */
export interface OwnServer {
  readonly launcher: DaemonLauncher;
  readonly graceMs: number;
  readonly now: () => number;
}

/**
 * The address for the next connection of a server that was found by discovery. The desktop app may
 * have restarted on another port, so it is looked up and verified again; the saved token goes only
 * to the same environment at an address that token is valid for. Anything else is a transient
 * failure (the app is often just restarting) and nothing is sent. When `own` is given and no server
 * has been there for its grace, the terminal's own server is started; the app takes it over when it
 * comes back (it is the same environment, so the same token holds).
 */
const reverifiedOrigin = (
  rediscover: () => Promise<Discovery>,
  known: { environmentId: string; origin: string },
  own: OwnServer | undefined,
) => {
  let goneSince: number | null = null;
  return async (): Promise<string> => {
    let result = await rediscover();
    let reason = own === undefined ? NO_SERVER_REASON : WAITING_FOR_OWN_SERVER_REASON;
    if (!isDown(result)) {
      goneSince = null;
    } else if (own !== undefined) {
      goneSince ??= own.now();
      if (own.now() - goneSince >= own.graceMs) {
        const outcome = await own.launcher.start(rediscover);
        if (outcome.kind === "ready" || outcome.kind === "occupied") result = await rediscover();
        else if (outcome.kind === "unusable") reason = OWN_SERVER_FAILED_REASON;
        else if (outcome.kind === "slow") reason = OWN_SERVER_SLOW_REASON;
        // Only the start is held back; the loop keeps looking, and the app's server is found
        // when the updated app comes up.
        else if (outcome.kind === "updating") reason = APP_UPDATING_REASON;
      }
    }
    if (result.kind === "unverified") throw new TransportError("transient", UNVERIFIED_REASON);
    if (result.kind !== "found") throw new TransportError("transient", reason);
    if (
      result.environmentId !== known.environmentId ||
      !originsMatch(known.origin, result.origin)
    ) {
      throw new TransportError("transient", OTHER_SERVER_REASON);
    }
    return result.origin;
  };
};

const STARTING_OWN_SERVER_NOTICE =
  "OOP 서버를 시작하는 중입니다… (앱 없이 터미널만 씁니다. 앱을 켜면 앱이 서버를 이어받고, 진행 중인 턴은 끊깁니다)";
const APP_UPDATING_ERROR =
  "OOP 앱이 업데이트를 설치하는 중일 수 있어 서버를 띄우지 않았습니다. 앱을 켜면 바로 이어지고, 아니면 최대 15분 뒤 다시 시도할 수 있습니다.";
const OWN_SERVER_SLOW_ERROR =
  "터미널 단독 서버가 제때 시작되지 않았습니다. 잠시 뒤 'oop' 을 다시 실행하세요.";

export interface ResolvedTarget extends ResolvedServer {
  /** Set for a server found by discovery; absent for an address given with --server. */
  readonly pid?: number;
  /** Set for a server found on the loopback: the address to use for each connection, see `reverifiedOrigin`. */
  readonly locateOrigin?: () => Promise<string>;
}

/**
 * Finds the server to talk to: an explicit address, else the one the desktop app announced and
 * whose process checks out. Where no server is running, `ownServer` (the terminal's own, no window)
 * is tried first and `startApp` (the desktop app) after it; each is given only where it may be used.
 */
export const resolveServer = async (input: {
  readonly server: string | null;
  readonly probe: (origin: string) => Promise<{ environmentId: string; label: string } | null>;
  readonly discover: () => Promise<DiscoveryResult>;
  readonly inspect?: Inspect;
  readonly startApp?: () => Promise<boolean>;
  readonly ownServer?: DaemonLauncher;
  /** True while the app may be installing an update: neither `ownServer` nor `startApp` is run. */
  readonly updating?: () => Promise<boolean>;
  readonly notify: (text: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}): Promise<ResolvedTarget | { readonly error: string }> => {
  if (input.server !== null) {
    const origin = /^[a-z][a-z0-9+.-]*:\/\//iu.test(input.server)
      ? input.server
      : `http://${input.server}`;
    const found = await input.probe(origin);
    if (found === null) return { error: `${origin} 에서 OOP 서버가 응답하지 않습니다.` };
    return { origin, ...found };
  }
  const discover = () => discoverVerified(input.discover, input.inspect ?? inspectServer);
  let result = await discover();
  // Checked apart from the two starters: mid-install the app's program may be missing, and then
  // there is no `ownServer` to ask while `startApp` would run the half-installed app.
  if (isDown(result) && (await input.updating?.()) === true) return { error: APP_UPDATING_ERROR };
  if (isDown(result) && input.ownServer !== undefined) {
    input.notify(STARTING_OWN_SERVER_NOTICE);
    const outcome = await input.ownServer.start(discover);
    if (outcome.kind === "ready") result = await discover();
    // The lock is held by a server that is still coming up (the app's, or another terminal's). It
    // gets as long as a server of ours does: giving up sooner would start the app behind it.
    else if (outcome.kind === "occupied") {
      result = await waitUntilFound(discover, input.sleep, STARTUP_TIMEOUT_MS);
    } else if (outcome.kind === "slow") return { error: OWN_SERVER_SLOW_ERROR };
    // The install began between the check above and this start.
    else if (outcome.kind === "updating") return { error: APP_UPDATING_ERROR };
  }
  // An app that answers but whose process does not check out is running: starting it again would
  // only wait out the timeout, and the token has not gone anywhere. A terminal's own server that
  // could not be started leaves this as it was.
  if (isDown(result) && input.startApp !== undefined && (await input.startApp())) {
    input.notify("OOP 앱을 시작하는 중입니다…");
    result = await waitUntilFound(discover, input.sleep);
  }
  if (result.kind !== "found") return { error: result.detail };
  const { origin, environmentId, label, pid } = result;
  return {
    origin,
    environmentId,
    label,
    pid,
    ...(isLoopbackOrigin(origin)
      ? {
          locateOrigin: reverifiedOrigin(
            discover,
            { environmentId, origin },
            input.ownServer === undefined
              ? undefined
              : {
                  launcher: input.ownServer,
                  graceMs: OWN_SERVER_GRACE_MS,
                  now: input.now ?? Date.now,
                },
          ),
        }
      : {}),
  };
};
