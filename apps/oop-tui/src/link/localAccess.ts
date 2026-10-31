import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { hostPlatform } from "../host.ts";

/** Runs a program and returns its stdout. Stdout may hold a token, so failures never quote it. */
export type RunProgram = (
  file: string,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
) => Promise<string>;

const PROGRAM_TIMEOUT_MS = 30_000;
const SESSION_CHECK_TIMEOUT_MS = 3_000;

const runProgram: RunProgram = (file, args, env) =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      file,
      [...args],
      { env: { ...process.env, ...env }, timeout: PROGRAM_TIMEOUT_MS },
      (error, stdout) => (error ? reject(new Error(`${file} failed`)) : resolve(stdout)),
    );
  });

export interface LocalAccessDeps {
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  readonly run: RunProgram;
  readonly readLink: (path: string) => Promise<string>;
}

const defaultDeps: LocalAccessDeps = {
  platform: hostPlatform(),
  uid: NodeOS.userInfo().uid,
  run: runProgram,
  readLink: (path) => NodeFSP.readlink(path),
};

/**
 * The server's script in its command line: a POSIX path (it may hold spaces, but not a space before
 * the start of another path) or a Windows path. Node's Windows command lines put a path with spaces
 * in quotes, so an unquoted Windows path is taken to end at the first space.
 */
export const parseServerScript = (command: string): string | null => {
  const posix =
    /(?:^|\s)(\/(?:(?!\s\/).)*\/apps\/server\/(?:dist\/bin\.mjs|src\/bin\.ts))(?=\s|$)/u.exec(
      command,
    );
  if (posix !== null) return posix[1] ?? null;
  const windows =
    /(?:^|\s)(?:"([A-Za-z]:\\[^"]*\\apps\\server\\(?:dist\\bin\.mjs|src\\bin\.ts))"|([A-Za-z]:\\\S*\\apps\\server\\(?:dist\\bin\.mjs|src\\bin\.ts))(?=\s|$))/u.exec(
      command,
    );
  return windows?.[1] ?? windows?.[2] ?? null;
};

export const parsePairingToken = (output: string): string | null =>
  /^Token: (\S+)$/mu.exec(output)?.[1] ?? null;

/**
 * Fixed script (pid and port are checked integers): the process must belong to this user's SID and
 * listen on the port. It prints its executable and command line as one JSON line, and fails with
 * a non-zero exit otherwise.
 */
const windowsInspectScript = (pid: number, port: number): string =>
  `$ErrorActionPreference = 'Stop'; try { ${[
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    `$serverPid = ${pid}`,
    `$serverPort = ${port}`,
    "$process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $serverPid)",
    "$owner = (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid",
    "$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "if ($owner -ne $me) { exit 1 }",
    "$null = Get-NetTCPConnection -State Listen -LocalPort $serverPort -OwningProcess $serverPid",
    "@{ executable = $process.ExecutablePath; command = $process.CommandLine } | ConvertTo-Json -Compress",
  ].join("; ")} } catch { exit 1 }`;

/**
 * Windows PowerShell by absolute path: a bare `powershell.exe` is looked up in the current folder
 * first, where any program of that name would be run instead.
 */
export const windowsPowerShell = (
  systemRoot: string | undefined = process.env.SystemRoot,
): string =>
  NodePath.win32.join(
    systemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

/** `taskkill.exe` by absolute path, for the same reason as {@link windowsPowerShell}. */
export const windowsTaskkill = (systemRoot: string | undefined = process.env.SystemRoot): string =>
  NodePath.win32.join(systemRoot || "C:\\Windows", "System32", "taskkill.exe");

const runPowerShell = (script: string, deps: LocalAccessDeps) =>
  deps.run(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-Command", script]);

/** The port an origin means: written out, or the scheme's default (an empty `URL.port`). */
export const originPort = (origin: string): number => {
  const url = new URL(origin);
  return url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
};

/** True when `ss -ltnp` lists a socket on `port` that `pid` owns. */
const listensOn = (ssOutput: string, pid: number, port: number): boolean =>
  ssOutput.split("\n").some((line) => {
    const local = line.trim().split(/\s+/u)[3];
    const owners = [...line.matchAll(/\bpid=(\d+)/gu)].map((match) => Number(match[1]));
    return local?.endsWith(`:${port}`) === true && owners.includes(pid);
  });

/**
 * What the announced pid runs, if it is this user's process listening on the announced port: its
 * program and command line. Null otherwise, because the announcement may be stale or point at
 * someone else's server, and nothing should be sent to or run for such a process.
 */
export const inspectServer = async (
  pid: number,
  port: number,
  deps: LocalAccessDeps = defaultDeps,
): Promise<{ readonly executable: string; readonly command: string } | null> => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isInteger(port)) return null;
  if (port < 1 || port > 65_535) return null;
  try {
    if (deps.platform === "win32") {
      const output = await runPowerShell(windowsInspectScript(pid, port), deps);
      const { executable, command } = JSON.parse(output.replace(/^\uFEFF/u, "")) as {
        executable?: unknown;
        command?: unknown;
      };
      return typeof executable === "string" && executable !== "" && typeof command === "string"
        ? { executable, command: command.trim() }
        : null;
    }
    if (deps.platform !== "darwin" && deps.platform !== "linux") return null;
    const ps = async (field: string) =>
      (await deps.run("ps", ["-o", field, "-p", String(pid)])).trim();
    if (Number(await ps("uid=")) !== deps.uid) return null;
    // lsof exits non-zero when the pid does not listen on the port.
    if (deps.platform === "darwin") {
      await deps.run("lsof", ["-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    } else if (!listensOn(await deps.run("ss", ["-H", "-ltnp"]), pid, port)) {
      return null;
    }
    const executable =
      deps.platform === "linux" ? await deps.readLink(`/proc/${pid}/exe`) : await ps("comm=");
    const command = await ps("command=");
    return executable !== "" && command !== "" ? { executable, command } : null;
  } catch {
    return null;
  }
};

/**
 * Asks the running server's own program for a one-time pairing token, so it always matches the
 * server's version. Whoever can run it can already read this user's OOP data, which is why the same
 * computer needs no pairing step. Null when that is not possible here.
 */
export const mintLocalPairingToken = async (
  input: {
    readonly pid: number;
    readonly origin: string;
    readonly home: string;
    readonly label: string;
  },
  deps: LocalAccessDeps = defaultDeps,
): Promise<string | null> => {
  try {
    const server = await inspectServer(input.pid, originPort(input.origin), deps);
    const script = server === null ? null : parseServerScript(server.command);
    if (server === null || script === null) return null;
    const output = await deps.run(
      server.executable,
      [script, "pair", "--base-dir", input.home, "--label", input.label, "--ttl", "1m"],
      // The desktop app's executable is Electron; this makes it run the script as plain Node.
      { ELECTRON_RUN_AS_NODE: "1" },
    );
    return parsePairingToken(output);
  } catch {
    return null;
  }
};

/** False only when the server says the token is no good; an unreachable server is not that. */
export const sessionIsValid = async (
  origin: string,
  token: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> => {
  try {
    const response = await fetchFn(new URL("/api/auth/session", origin), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) return true;
    const body = (await response.json()) as { authenticated?: unknown };
    return body.authenticated !== false;
  } catch {
    return true;
  }
};

/**
 * The desktop app's per-user installer (oneClick off, perMachine off, product name OOP; see
 * scripts/build-desktop-artifact.ts) installs to %LOCALAPPDATA%\Programs\OOP\OOP.exe. An app put
 * elsewhere through the installer's folder page is not found.
 */
const WINDOWS_START_APP_SCRIPT =
  "$ErrorActionPreference = 'Stop'; try { $app = Join-Path $env:LOCALAPPDATA 'Programs\\OOP\\OOP.exe'; " +
  "if (-not (Test-Path -LiteralPath $app -PathType Leaf)) { exit 1 }; " +
  // oop.cmd sets this variable; the app and its terminals would inherit it and cmd.exe could not run programs from the current folder.
  "Remove-Item Env:NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue; " +
  "Start-Process -FilePath $app } catch { exit 1 }";

/** Starts the desktop app behind the terminal. False when this computer has no such app. */
export const startDesktopApp = async (deps: LocalAccessDeps = defaultDeps): Promise<boolean> => {
  try {
    if (deps.platform === "darwin") await deps.run("open", ["-g", "-a", "OOP"]);
    else if (deps.platform === "win32") await runPowerShell(WINDOWS_START_APP_SCRIPT, deps);
    else return false;
    return true;
  } catch {
    return false;
  }
};

const SERVER_POLL_MS = 1_000;
const SERVER_POLL_ATTEMPTS = 30;

/** Repeats discovery while the app that was just started brings its server up. */
export const waitUntilFound = async <Result extends { readonly kind: string }>(
  discover: () => Promise<Result>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  waitMs: number = SERVER_POLL_ATTEMPTS * SERVER_POLL_MS,
): Promise<Result> => {
  let result = await discover();
  for (
    let attempt = 0;
    attempt < Math.ceil(waitMs / SERVER_POLL_MS) && result.kind !== "found";
    attempt += 1
  ) {
    await sleep(SERVER_POLL_MS);
    result = await discover();
  }
  return result;
};
