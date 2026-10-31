import type { DiscoveryResult } from "../link/discovery.ts";
import { parseServerScript } from "../link/localAccess.ts";

export interface StopCommandDeps {
  /** Looks for the server on this computer. It must not start anything. */
  readonly discover: () => Promise<DiscoveryResult>;
  /**
   * The command line of the process when it is this user's and listens on the announced port: the
   * proof asked for before a token is sent. Null for anything else.
   */
  readonly inspect: (pid: number, port: number) => Promise<{ readonly command: string } | null>;
  /** Asks the process to end. */
  readonly terminate: (pid: number) => void;
  readonly isAlive: (pid: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface TerminatePorts {
  readonly platform: NodeJS.Platform;
  readonly kill: (pid: number, signal: "SIGTERM") => void;
  /** Runs `taskkill` with the arguments; its output is not wanted. */
  readonly taskkill: (args: ReadonlyArray<string>) => void;
}

/**
 * Asks the server to end. Windows has no graceful signal, and `process.kill` there would leave the
 * server's provider and terminal children running, so the whole tree goes, the way the desktop app
 * ends its own backend. Elsewhere it is SIGTERM, which lets the server finish writing its data.
 */
export const terminateProcess = (pid: number, ports: TerminatePorts): void => {
  if (ports.platform === "win32") ports.taskkill(["/pid", String(pid), "/T", "/F"]);
  else ports.kill(pid, "SIGTERM");
};

/** How long the server gets to end after it is asked; it finishes writing its data first. */
const STOP_WAIT_MS = 10_000;
const POLL_MS = 200;

const portOf = (origin: string): number => {
  const url = new URL(origin);
  return url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
};

/**
 * `oop stop`: ends the terminal's own server, and only that. The desktop app's server is the app's
 * to run (it ends with the app), and nothing is signalled to a process that does not check out as
 * this user's server on its announced port: the announcement is a file, and a pid can be reused.
 * Returns 0 when no server is left running, else 1.
 */
export const runStopCommand = async (deps: StopCommandDeps): Promise<number> => {
  const found = await deps.discover();
  if (found.kind === "missing" || found.kind === "stale") {
    deps.out("실행 중인 OOP 서버가 없습니다.");
    return 0;
  }
  if (found.kind === "unreachable") {
    deps.err("OOP 서버가 응답하지 않아 확인할 수 없습니다. 아무것도 멈추지 않았습니다.");
    return 1;
  }
  if (found.daemon !== true) {
    deps.out(
      "지금 서버는 OOP 앱이 쓰는 서버입니다. 앱을 종료하면 함께 멈추므로 여기서는 멈추지 않았습니다.",
    );
    return 1;
  }
  const proof = await deps.inspect(found.pid, portOf(found.origin)).catch(() => null);
  if (proof === null || parseServerScript(proof.command) === null) {
    deps.err(
      `서버(pid ${found.pid})가 이 사용자의 OOP 서버이고 ${found.origin} 에서 리슨 중인지 확인하지 못해 멈추지 않았습니다.`,
    );
    return 1;
  }
  deps.out("터미널 단독 서버를 멈춥니다. 진행 중인 턴이 있으면 끊깁니다.");
  deps.terminate(found.pid);
  const deadline = deps.now() + STOP_WAIT_MS;
  while (deps.isAlive(found.pid)) {
    if (deps.now() >= deadline) {
      deps.err(`서버(pid ${found.pid})가 아직 끝나지 않았습니다. 잠시 뒤 다시 확인하세요.`);
      return 1;
    }
    await deps.sleep(POLL_MS);
  }
  deps.out("멈췄습니다. 열려 있는 oop 창이 있으면 5초 뒤 서버를 다시 띄우니, 먼저 창을 닫으세요.");
  return 0;
};
