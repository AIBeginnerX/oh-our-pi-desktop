import * as NodeFSP from "node:fs/promises";

export interface RuntimeAnnouncement {
  readonly pid: number;
  readonly origin: string;
  /** Present (true) only for the terminal's own server, started by `serve --daemon`. */
  readonly daemon?: true;
}

/** Keeps only the fields discovery needs; nothing else from the file is carried around. */
export const parseRuntimeAnnouncement = (text: string): RuntimeAnnouncement | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0)
    return null;
  if (typeof record.origin !== "string") return null;
  try {
    const url = new URL(record.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return {
    pid: record.pid,
    origin: record.origin,
    ...(record.daemon === true ? { daemon: true as const } : {}),
  };
};

/** `kill(pid, 0)` probes without signalling. EPERM means the process exists but is not ours. */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

export type DiscoveryResult =
  | {
      readonly kind: "found";
      readonly pid: number;
      readonly origin: string;
      readonly environmentId: string;
      readonly label: string;
      /** Set (true) when the server is the terminal's own rather than the desktop app's. */
      readonly daemon?: true;
    }
  | { readonly kind: "missing"; readonly detail: string }
  | { readonly kind: "stale"; readonly detail: string }
  | { readonly kind: "unreachable"; readonly detail: string };

export interface DiscoveryDeps {
  readonly readFile?: (path: string) => Promise<string>;
  readonly isAlive?: (pid: number) => boolean;
  /** Returns the environment answering at `origin`, or null when nothing OOP-like does. */
  readonly probe: (origin: string) => Promise<{ environmentId: string; label: string } | null>;
}

export const discoverServer = async (
  runtimeFile: string,
  deps: DiscoveryDeps,
): Promise<DiscoveryResult> => {
  const readFile = deps.readFile ?? ((path: string) => NodeFSP.readFile(path, "utf8"));
  const isAlive = deps.isAlive ?? isProcessAlive;
  let text: string;
  try {
    text = await readFile(runtimeFile);
  } catch {
    return {
      kind: "missing",
      detail:
        "실행 중인 OOP 서버를 찾지 못했습니다. 데스크톱 앱을 켜거나 --server 주소를 지정하세요.",
    };
  }
  const announcement = parseRuntimeAnnouncement(text);
  if (announcement === null) {
    return {
      kind: "missing",
      detail: "서버 실행 정보를 읽을 수 없습니다. --server 주소를 지정하세요.",
    };
  }
  if (!isAlive(announcement.pid)) {
    return { kind: "stale", detail: "마지막으로 실행된 OOP 서버가 이미 종료되었습니다." };
  }
  const environment = await deps.probe(announcement.origin).catch(() => null);
  if (environment === null) {
    return {
      kind: "unreachable",
      detail: "OOP 서버가 응답하지 않습니다. 잠시 후 다시 시도하세요.",
    };
  }
  return {
    kind: "found",
    pid: announcement.pid,
    origin: announcement.origin,
    ...environment,
    ...(announcement.daemon === true ? { daemon: true as const } : {}),
  };
};
