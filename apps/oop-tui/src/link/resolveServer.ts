import { STARTUP_TIMEOUT_MS, type DaemonLauncher } from "./daemon.ts";
import type { DiscoveryResult } from "./discovery.ts";
import { inspectServer, originPort, waitUntilFound } from "./localAccess.ts";
import { isLoopbackOrigin, originsMatch, type ResolvedServer } from "./selectCredential.ts";
import { TransportError } from "./transport.ts";
import { t } from "../i18n/index.ts";

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
    detail: t("link.resolve.unverified", { origin: result.origin, pid: result.pid }),
  };
};

/**
 * The reasons shown in the banner while reconnecting. The banner is one row with a countdown, so
 * these stay short enough to be read whole at 80 columns; the long explanation is for a failed start.
 */
const UNVERIFIED_REASON = () => t("link.reason.unverified");
const OTHER_SERVER_REASON = () => t("link.reason.otherServer");
const NO_SERVER_REASON = () => t("link.reason.appClosed");
/** With the terminal's own server available, the wait is the terminal's to end, not the user's. */
const WAITING_FOR_OWN_SERVER_REASON = () => t("link.reason.startingSoon");
const OWN_SERVER_FAILED_REASON = () => t("link.reason.startFailed");
const APP_UPDATING_REASON = () => t("link.reason.appUpdating");
const OWN_SERVER_SLOW_REASON = () => t("link.reason.startSlow");

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
    let reason = own === undefined ? NO_SERVER_REASON() : WAITING_FOR_OWN_SERVER_REASON();
    if (!isDown(result)) {
      goneSince = null;
    } else if (own !== undefined) {
      goneSince ??= own.now();
      if (own.now() - goneSince >= own.graceMs) {
        const outcome = await own.launcher.start(rediscover);
        if (outcome.kind === "ready" || outcome.kind === "occupied") result = await rediscover();
        else if (outcome.kind === "unusable") reason = OWN_SERVER_FAILED_REASON();
        else if (outcome.kind === "slow") reason = OWN_SERVER_SLOW_REASON();
        // Only the start is held back; the loop keeps looking, and the app's server is found
        // when the updated app comes up.
        else if (outcome.kind === "updating") reason = APP_UPDATING_REASON();
      }
    }
    if (result.kind === "unverified") throw new TransportError("transient", UNVERIFIED_REASON());
    if (result.kind !== "found") throw new TransportError("transient", reason);
    if (
      result.environmentId !== known.environmentId ||
      !originsMatch(known.origin, result.origin)
    ) {
      throw new TransportError("transient", OTHER_SERVER_REASON());
    }
    return result.origin;
  };
};

const STARTING_OWN_SERVER_NOTICE = () => t("link.notice.startingServer");
const APP_UPDATING_ERROR = () => t("link.err.appUpdating");
const OWN_SERVER_SLOW_ERROR = () => t("link.err.serverSlow");

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
    if (found === null) return { error: t("link.resolve.noAnswer", { origin }) };
    return { origin, ...found };
  }
  const discover = () => discoverVerified(input.discover, input.inspect ?? inspectServer);
  let result = await discover();
  // Checked apart from the two starters: mid-install the app's program may be missing, and then
  // there is no `ownServer` to ask while `startApp` would run the half-installed app.
  if (isDown(result) && (await input.updating?.()) === true) return { error: APP_UPDATING_ERROR() };
  if (isDown(result) && input.ownServer !== undefined) {
    input.notify(STARTING_OWN_SERVER_NOTICE());
    const outcome = await input.ownServer.start(discover);
    if (outcome.kind === "ready") result = await discover();
    // The lock is held by a server that is still coming up (the app's, or another terminal's). It
    // gets as long as a server of ours does: giving up sooner would start the app behind it.
    else if (outcome.kind === "occupied") {
      result = await waitUntilFound(discover, input.sleep, STARTUP_TIMEOUT_MS);
    } else if (outcome.kind === "slow") return { error: OWN_SERVER_SLOW_ERROR() };
    // The install began between the check above and this start.
    else if (outcome.kind === "updating") return { error: APP_UPDATING_ERROR() };
  }
  // An app that answers but whose process does not check out is running: starting it again would
  // only wait out the timeout, and the token has not gone anywhere. A terminal's own server that
  // could not be started leaves this as it was.
  if (isDown(result) && input.startApp !== undefined && (await input.startApp())) {
    input.notify(t("link.resolve.startingApp"));
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
