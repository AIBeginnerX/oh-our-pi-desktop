import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeReadline from "node:readline";

import type { RuntimeMode } from "@t3tools/contracts";

import { AppController } from "./app/controller.ts";
import { runDoctor } from "./app/doctor.ts";
import { runStopCommand, terminateProcess } from "./app/stopCommand.ts";
import type { ProviderRequest } from "./app/providerArgs.ts";
import { runProviderCommand, type ProviderCommandDeps } from "./app/providerCommand.ts";
import { openDraftView, openPickView } from "./app/providerScreen.ts";
import { runAddWizard } from "./app/providerWizard.ts";
import { isReleaseVersion, lookupLatestRelease, updateCacheFilePath } from "./app/updateCheck.ts";
import { runUpdateCommand } from "./app/updateCommand.ts";
import { hostPlatform } from "./host.ts";
import { terminalInput } from "./terminalInput.ts";
import { KeyParser, type KeyEvent } from "./input/keys.ts";
import { LinkClient } from "./link/client.ts";
import { CredentialStore, type StoredCredential } from "./link/credentials.ts";
import {
  currentAppLookup,
  DAEMON_ENTRY_VARIABLE,
  defaultLauncher,
  desktopUpdateMarkerPath,
  findAppProgram,
  mayRunOwnServer,
  updateInProgress,
  type AppProgram,
  type DaemonLauncher,
} from "./link/daemon.ts";
import { discoverServer, isProcessAlive } from "./link/discovery.ts";
import {
  inspectServer,
  mintLocalPairingToken,
  sessionIsValid,
  startDesktopApp,
  windowsTaskkill,
} from "./link/localAccess.ts";
import {
  exchangePairingToken,
  makeEffectTransport,
  type OopClientIdentity,
  probeEnvironment,
} from "./link/effectTransport.ts";
import {
  configDirectory,
  credentialsFilePath,
  currentPathEnv,
  serverHome,
  serverRuntimeFilePath,
} from "./link/paths.ts";
import { carriesServerAddress, pairFailureMessage, resolvePairTarget } from "./link/pair.ts";
import { resolveServer } from "./link/resolveServer.ts";
import { localServer, plainHttpWarning, selectCredential } from "./link/selectCredential.ts";
import { defaultScheduler, LiveRegion } from "./render/liveRegion.ts";
import { RegionSwitch } from "./render/regionSwitch.ts";
import { SplitRegion } from "./render/splitRegion.ts";
import { detectColorLevel } from "./render/color.ts";
import { makeStyle } from "./render/style.ts";
import { resolveSymbols } from "./render/symbols.ts";
import { createTerminalHooks } from "./render/terminalHooks.ts";
import {
  createThemeSwitcher,
  loadStartupTheme,
  readSettings,
  resolveSettings,
  runConfigCommand,
  type ConfigAction,
  settingsFilePath,
} from "./settings.ts";
import { debounced, watchSignals } from "./signals.ts";
import { guardTerminal } from "./terminalGuard.ts";
import { sanitizeForTerminal } from "./text/width.ts";

/** Text from a server or a failure is untrusted; only the plain characters of it reach the terminal. */
const say = (stream: NodeJS.WriteStream, text: string) => {
  stream.write(`${sanitizeForTerminal(text)}\n`);
};

export const identity = (version: string): OopClientIdentity => ({
  label: `oop terminal (${NodeOS.hostname()})`,
  os: hostPlatform() === "darwin" ? "macOS" : hostPlatform() === "win32" ? "Windows" : "Linux",
  appVersion: version,
});

const probe = async (origin: string) => {
  const descriptor = await probeEnvironment(origin);
  return descriptor === null
    ? null
    : { environmentId: descriptor.environmentId, label: descriptor.label };
};

const isolatedHome = (home: string | null): boolean =>
  home !== null || Boolean(currentPathEnv().env.OOP_HOME?.trim());

/** The installed app's server program, for the terminal to run itself; null where there is none. */
const appProgram = (): AppProgram | null => {
  const paths = currentPathEnv();
  return findAppProgram(currentAppLookup(paths.home, paths.platform));
};

/**
 * What starts the terminal's own server, or undefined where it must not: no usable app program
 * (Linux, no app installed), or an isolated home, which is someone's test server and not what the
 * app's program would serve. OOP_DAEMON_ENTRY names a server file to run instead, and is the one
 * switch that also allows an isolated home.
 */
const ownServerFor = (home: string | null): DaemonLauncher | undefined => {
  const paths = currentPathEnv();
  const program = appProgram();
  if (program === null) {
    if (paths.env[DAEMON_ENTRY_VARIABLE]?.trim()) {
      say(
        process.stderr,
        `${DAEMON_ENTRY_VARIABLE} 가 가리키는 파일이 없어 서버를 띄우지 않습니다.`,
      );
    }
    return undefined;
  }
  if (!mayRunOwnServer(program, isolatedHome(home))) return undefined;
  return defaultLauncher(program, serverHome(paths, home ?? undefined), NodeOS.homedir());
};

/**
 * Where no server runs, `mayStart` lets this bring one up: the terminal's own first, then the
 * desktop app. An isolated home is someone's test server; the desktop app would not bring that one up.
 */
const findServer = (server: string | null, home: string | null, options: { mayStart: boolean }) => {
  const paths = currentPathEnv();
  const ownServer = options.mayStart && server === null ? ownServerFor(home) : undefined;
  return resolveServer({
    server,
    probe,
    discover: () => discoverServer(serverRuntimeFilePath(paths, home ?? undefined), { probe }),
    ...(options.mayStart && !isolatedHome(home) ? { startApp: startDesktopApp } : {}),
    ...(ownServer !== undefined ? { ownServer } : {}),
    ...(options.mayStart
      ? {
          updating: () =>
            updateInProgress({
              markerPath: desktopUpdateMarkerPath(serverHome(paths, home ?? undefined)),
              now: Date.now,
            }),
        }
      : {}),
    notify: (text) => say(process.stderr, text),
  });
};

const exchangeAndSave = async (
  store: CredentialStore,
  target: { readonly httpBaseUrl: string; readonly credential: string },
  version: string,
): Promise<StoredCredential & { readonly label: string }> => {
  const paired = await exchangePairingToken({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
    identity: identity(version),
  });
  const credential = {
    environmentId: paired.environmentId,
    label: paired.label,
    httpBaseUrl: paired.httpBaseUrl,
    token: paired.token,
    savedAt: new Date().toISOString(),
  };
  await store.save(credential);
  return credential;
};

/** Connects to the server on this computer without a pairing step. Null when that is not possible. */
const connectLocally = async (
  store: CredentialStore,
  server: { readonly origin: string; readonly pid: number },
  home: string | null,
  version: string,
): Promise<StoredCredential | null> => {
  const token = await mintLocalPairingToken({
    pid: server.pid,
    origin: server.origin,
    home: serverHome(currentPathEnv(), home ?? undefined),
    label: identity(version).label,
  });
  if (token === null) {
    say(process.stderr, "자동 연결 실패: 실행 중인 OOP 서버에서 연결 토큰을 받지 못했습니다.");
    return null;
  }
  return exchangeAndSave(store, { httpBaseUrl: server.origin, credential: token }, version).catch(
    (cause: unknown) => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      say(process.stderr, `자동 연결 실패: ${reason}`);
      return null;
    },
  );
};

export const runPair = async (input: {
  readonly target: string;
  readonly server: string | null;
  readonly home: string | null;
  readonly version: string;
}): Promise<number> => {
  let origin: string | null = null;
  if (!carriesServerAddress(input.target)) {
    const resolved = await findServer(input.server, input.home, { mayStart: false });
    if ("error" in resolved) {
      say(process.stderr, resolved.error);
      return 1;
    }
    origin = resolved.origin;
  }
  try {
    const target = resolvePairTarget(input.target, origin);
    const warning = plainHttpWarning(target.httpBaseUrl);
    if (warning !== null) say(process.stderr, warning);
    // A damaged credential file is found before the one-time token is spent on it.
    const store = new CredentialStore(credentialsFilePath(currentPathEnv()));
    await store.verify();
    const paired = await exchangeAndSave(store, target, input.version);
    say(process.stdout, `연결되었습니다: ${paired.label}\n이제 'oop' 으로 시작하세요.`);
    return 0;
  } catch (cause) {
    say(process.stderr, pairFailureMessage(cause));
    return 1;
  }
};

export const runConfig = (action: ConfigAction): number =>
  runConfigCommand(action, {
    paths: currentPathEnv(),
    out: (line) => say(process.stdout, line),
    err: (line) => say(process.stderr, line),
  });

/** `oop doctor`: checks only; it never starts the app, a server, or a pairing. */
export const runDoctorCommand = (home: string | null): Promise<number> => {
  const paths = currentPathEnv();
  return runDoctor({
    paths,
    isTty: process.stdout.isTTY === true,
    discover: () => discoverServer(serverRuntimeFilePath(paths, home ?? undefined), { probe }),
    standalone: { script: appProgram()?.serverScript ?? null },
    columns: process.stdout.columns || 80,
    out: (line) => void process.stdout.write(`${line}\n`),
  });
};

/** `oop stop`: ends the terminal's own server; the app's is left alone. */
export const runStop = (home: string | null): Promise<number> => {
  const paths = currentPathEnv();
  return runStopCommand({
    discover: () => discoverServer(serverRuntimeFilePath(paths, home ?? undefined), { probe }),
    inspect: (pid, port) => inspectServer(pid, port),
    terminate: (pid) =>
      terminateProcess(pid, {
        platform: hostPlatform(),
        kill: (target, signal) => process.kill(target, signal),
        taskkill: (args) =>
          void NodeChildProcess.spawnSync(windowsTaskkill(), [...args], {
            stdio: "ignore",
            windowsHide: true,
          }),
      }),
    isAlive: isProcessAlive,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    out: (line) => say(process.stdout, line),
    err: (line) => say(process.stderr, line),
  });
};

/**
 * Version of the OOP app that is running, from the descriptor it publishes to anyone who asks; null
 * when none answers. It starts nothing and sends no token, and a version that is not a plain
 * dotted number is not believed.
 */
const runningAppVersion = async (
  server: string | null,
  home: string | null,
): Promise<string | null> => {
  let version: string | null = null;
  const ask = async (origin: string) => {
    const descriptor = await probeEnvironment(origin);
    if (descriptor === null) return null;
    version = descriptor.serverVersion.trim();
    return { environmentId: descriptor.environmentId, label: descriptor.label };
  };
  if (server !== null) {
    await ask(/^[a-z][a-z0-9+.-]*:\/\//iu.test(server) ? server : `http://${server}`);
  } else {
    await discoverServer(serverRuntimeFilePath(currentPathEnv(), home ?? undefined), {
      probe: ask,
    });
  }
  return version !== null && isReleaseVersion(version) ? version : null;
};

/** `oop update`: says whether a newer release exists and how to get it. It installs nothing. */
export const runUpdate = (input: {
  readonly server: string | null;
  readonly home: string | null;
  readonly version: string;
}): Promise<number> => {
  const cacheFile = updateCacheFilePath(currentPathEnv());
  return runUpdateCommand({
    terminalVersion: input.version,
    appVersion: () => runningAppVersion(input.server, input.home),
    check: (options) => lookupLatestRelease({ now: Date.now, cacheFile }, options),
    out: (line) => say(process.stdout, line),
    err: (line) => say(process.stderr, line),
  });
};

const ESC_FLUSH_MS = 30;
const RESIZE_SETTLE_MS = 80;
const SHOW_CURSOR = "\u001b[?25h";
const BRACKETED_PASTE_ON = "\u001b[?2004h";
const BRACKETED_PASTE_OFF = "\u001b[?2004l";

/** `host:port` of a server address; the rest of it (user, path, query) is not something to print. */
const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
};

type ResolvedServer = Exclude<Awaited<ReturnType<typeof findServer>>, { readonly error: string }>;

/**
 * Finds the server and a credential for it, replacing a missing or outdated token when the server
 * is on this computer. Says why on stderr and returns null when it cannot.
 */
const openConnection = async (input: {
  readonly server: string | null;
  readonly home: string | null;
  readonly version: string;
  readonly mayStart: boolean;
}): Promise<{ resolved: ResolvedServer; credential: StoredCredential } | null> => {
  const resolved = await findServer(input.server, input.home, { mayStart: input.mayStart });
  if ("error" in resolved) {
    say(process.stderr, resolved.error);
    return null;
  }
  const store = new CredentialStore(credentialsFilePath(currentPathEnv()));
  const selected = await selectCredential(store, resolved);
  let credential = "credential" in selected ? selected.credential : null;
  // On this computer a missing or outdated token is simply replaced.
  const local = localServer(resolved);
  if (local !== null) {
    const needsToken =
      credential === null
        ? "replaceable" in selected && selected.replaceable
        : !(await sessionIsValid(resolved.origin, credential.token));
    if (needsToken) {
      credential = (await connectLocally(store, local, input.home, input.version)) ?? credential;
    }
  }
  if (credential === null) {
    say(process.stderr, "error" in selected ? selected.error : "서버에 연결할 수 없습니다.");
    return null;
  }
  const warning = plainHttpWarning(resolved.origin);
  if (warning !== null) say(process.stderr, warning);
  return { resolved, credential };
};

export const runInteractive = async (input: {
  readonly continueLast: boolean;
  readonly server: string | null;
  readonly home: string | null;
  readonly runtimeMode: RuntimeMode | null;
  readonly prompt: string | null;
  readonly version: string;
}): Promise<number> => {
  const stdin = terminalInput();
  const { stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) {
    say(
      process.stderr,
      "oop 은 대화형 터미널에서만 실행됩니다. (표준 입출력이 터미널이 아닙니다.)",
    );
    return 2;
  }

  const connection = await openConnection({ ...input, mayStart: true });
  if (connection === null) return 1;
  const { resolved, credential } = connection;

  const paths = currentPathEnv();
  const file = readSettings(settingsFilePath(paths));
  const { settings } = resolveSettings(file.values, process.env);
  const level = detectColorLevel(process.env, true);
  const startup = loadStartupTheme({
    theme: settings.theme,
    level,
    configDir: configDirectory(paths),
    env: process.env,
  });
  for (const line of [...file.warnings, ...startup.warnings]) say(process.stderr, line);
  const themes = createThemeSwitcher({
    initial: startup.theme,
    level,
    configDir: configDirectory(paths),
    settingsFile: settingsFilePath(paths),
    env: process.env,
  });
  const style = makeStyle(themes.current);
  const symbols = resolveSymbols(settings.symbols, process.env, hostPlatform());
  const cacheFile = updateCacheFilePath(paths);

  let controller: AppController | null = null;
  const screen = {
    write: (text: string) => void stdout.write(text),
    columns: () => stdout.columns || 80,
    rows: () => stdout.rows || 24,
  };
  // The inline layout, and the one with the workflow panel beside the conversation (`/dag-workflow`).
  const region = new RegionSwitch(
    new LiveRegion(screen),
    new SplitRegion(screen, defaultScheduler, {
      divider: () => style.theme.border(symbols.separator),
    }),
    screen,
    { onClosed: (reason, part) => controller?.onSplitClosed(reason, part) },
  );
  let countdown: ReturnType<typeof setInterval> | null = null;
  const link = new LinkClient(
    makeEffectTransport({
      httpBaseUrl: resolved.origin,
      bearerToken: credential.token,
      identity: identity(input.version),
      locateOrigin: resolved.locateOrigin,
    }),
    {
      status: (status) => {
        // The reconnect countdown ticks once a second, and only while there is something to count.
        if (status.phase === "reconnecting" && countdown === null) {
          countdown = setInterval(() => controller?.onLinkStatus(), 1000);
        } else if (status.phase !== "reconnecting" && countdown !== null) {
          clearInterval(countdown);
          countdown = null;
        }
        controller?.onLinkStatus();
      },
      shell: () => controller?.onShell(),
      config: () => controller?.onConfig(),
      thread: (mirror) => controller?.onThread(mirror),
      threadFailed: (threadId, message) => controller?.onThreadFailed(threadId, message),
    },
    { turnLimit: 20 },
  );

  let finish: (code: number) => void = () => undefined;
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });
  controller = new AppController({
    link,
    region,
    split: region,
    style,
    themes,
    symbols,
    animations: settings.animations,
    statusLine: settings.statusLine,
    notify: settings.notify,
    home: NodeOS.homedir(),
    server: hostOf(resolved.origin),
    terminal: createTerminalHooks((text) => void stdout.write(text), {
      colorLevel: level,
      term: process.env.TERM,
    }),
    cwd: process.cwd(),
    platform: hostPlatform(),
    context: { uuid: () => crypto.randomUUID(), now: () => new Date() },
    schedule: (run) => {
      const handle = setTimeout(run, 16);
      return () => clearTimeout(handle);
    },
    now: Date.now,
    runtimeMode: input.runtimeMode ?? "full-access",
    continueLast: input.continueLast,
    prompt: input.prompt,
    startup: {
      banner: settings.banner,
      version: input.version,
      checkUpdate: (options) => lookupLatestRelease({ now: Date.now, cacheFile }, options),
    },
    exit: () => finish(0),
    ...(hostPlatform() === "win32" ? {} : { suspend: () => suspend() }),
  });

  // Raw mode and bracketed paste are undone on every way out, including a crash.
  const releaseInput = () => {
    stdout.write(`${BRACKETED_PASTE_OFF}${SHOW_CURSOR}`);
    if (stdin.isTTY) stdin.setRawMode(false);
  };
  // The alternate screen of the workflow layout is left first, so what was said in it is not lost.
  const restoreTerminal = () => {
    region.restore();
    releaseInput();
  };
  process.once("exit", restoreTerminal);
  // An exception would print its stack in the alternate screen, where leaving it erases the text.
  const onCrash = (error: unknown) => {
    restoreTerminal();
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  };
  process.once("uncaughtException", onCrash);
  const parser = new KeyParser();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const deliver = (events: ReturnType<KeyParser["feed"]>) => {
    for (const event of events) controller?.handleKey(event);
  };
  const onData = (chunk: Buffer) => {
    deliver(parser.feed(chunk));
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = parser.hasPending()
      ? setTimeout(() => deliver(parser.flush()), ESC_FLUSH_MS)
      : null;
  };
  // Dragging a window edge fires a resize per step. The region is held from the first one, since
  // the spinner's timer would keep drawing onto a screen the terminal has reflowed, and is drawn
  // once the size settles.
  const settleResize = debounced(RESIZE_SETTLE_MS, () => {
    region.release();
    controller?.render();
  });
  const onResize = () => {
    region.hold();
    settleResize();
  };
  const enterTerminal = () => {
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(BRACKETED_PASTE_ON);
  };
  // Ctrl-Z: hand the terminal back, then stop. SIGCONT (from `fg`) re-enters and redraws.
  const suspend = () => {
    region.suspend();
    releaseInput();
    process.kill(process.pid, "SIGTSTP");
  };
  const stopWatchingSignals = watchSignals(
    process,
    {
      exit: finish,
      resume: () => {
        enterTerminal();
        // The window may have been resized while stopped, and no SIGWINCH reaches a job then.
        // `getWindowSize()` only repeats the size Node has, so the private refresh is used when
        // there is one; it emits "resize" if the size changed.
        (stdout as { _refreshSize?: () => void })._refreshSize?.();
        region.resume();
        controller?.render();
      },
    },
    hostPlatform(),
  );

  enterTerminal();
  stdin.on("data", onData);
  stdout.on("resize", onResize);

  // The start screen is drawn at once; the lookup of the newest release never holds anything up.
  controller.render();
  void lookupLatestRelease({ now: Date.now, cacheFile }, { refresh: false }).then((info) =>
    controller?.onLatestRelease(info),
  );
  void link.start();

  const code = await finished;
  stdin.off("data", onData);
  stdout.off("resize", onResize);
  settleResize.cancel();
  stopWatchingSignals();
  if (flushTimer !== null) clearTimeout(flushTimer);
  if (countdown !== null) clearInterval(countdown);
  controller.dispose();
  controller.farewell(code);
  // The terminal is handed back before the wait for the server: a Ctrl-C must not leave the
  // alternate screen and raw mode up for up to a second and a half. The farewell is already queued
  // in the region, so it is written here; after that the region writes nothing, and what a request
  // that ends during the wait has to say is written once the wait is over.
  region.close();
  restoreTerminal();
  process.off("exit", restoreTerminal);
  process.off("uncaughtException", onCrash);
  await Promise.race([link.stop(), new Promise((resolve) => setTimeout(resolve, 1500))]);
  region.drain();
  stdin.pause();
  return code;
};

const PROVIDER_ONLINE_TIMEOUT_MS = 15_000;
const PROVIDER_SHELL_GRACE_MS = 5_000;

/** One line typed at the terminal; null when the input ended before an answer. */
const askLine = (question: string): Promise<string | null> =>
  new Promise((resolve) => {
    const lines = NodeReadline.createInterface({ input: terminalInput(), output: process.stdout });
    let answered = false;
    lines.once("close", () => {
      if (!answered) resolve(null);
    });
    lines.question(question, (answer) => {
      answered = true;
      lines.close();
      resolve(answer);
    });
  });

const readAllStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of terminalInput()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

/** Theme and symbols as the chat would use them, for the screens a shell command shows. */
const loadLook = () => {
  const paths = currentPathEnv();
  const file = readSettings(settingsFilePath(paths));
  const { settings } = resolveSettings(file.values, process.env);
  const level = detectColorLevel(process.env, true);
  const startup = loadStartupTheme({
    theme: settings.theme,
    level,
    configDir: configDirectory(paths),
    env: process.env,
  });
  return {
    style: makeStyle(startup.theme),
    symbols: resolveSymbols(settings.symbols, process.env, hostPlatform()),
  };
};

/** `oop provider ...`: connects, does the one thing, disconnects. */
export const runProvider = async (input: {
  readonly request: ProviderRequest;
  readonly server: string | null;
  readonly home: string | null;
  readonly version: string;
}): Promise<number> => {
  const stdin = terminalInput();
  const { stdout } = process;
  const interactive = stdin.isTTY === true && stdout.isTTY === true;
  const connection = await openConnection({ ...input, mayStart: interactive });
  if (connection === null) return 1;
  const { resolved, credential } = connection;

  let wake: () => void = () => undefined;
  const link = new LinkClient(
    makeEffectTransport({
      httpBaseUrl: resolved.origin,
      bearerToken: credential.token,
      identity: identity(input.version),
      locateOrigin: resolved.locateOrigin,
    }),
    {
      status: () => wake(),
      shell: () => wake(),
      config: () => wake(),
      thread: () => undefined,
      threadFailed: () => undefined,
    },
    { turnLimit: 20 },
  );

  /** Resolves true when `ready` holds, false after `timeoutMs`, and null when the link was refused. */
  const until = (ready: () => boolean, timeoutMs: number): Promise<boolean | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => settle(false), timeoutMs);
      const settle = (result: boolean | null) => {
        clearTimeout(timer);
        wake = () => undefined;
        resolve(result);
      };
      const check = () => {
        if (link.status.phase === "blocked") settle(null);
        else if (ready()) settle(true);
      };
      wake = check;
      check();
    });

  const waitReady = async (need: { readonly shell: boolean }): Promise<string | null> => {
    const online = await until(
      () => link.status.phase === "online" && link.config !== null,
      PROVIDER_ONLINE_TIMEOUT_MS,
    );
    if (online === null) {
      return `서버가 연결을 거부했습니다${link.status.detail === null ? "" : `: ${link.status.detail}`}`;
    }
    if (!online)
      return "서버에 연결하지 못했습니다. OOP 앱이나 터미널 서버가 실행 중인지 확인하세요.";
    // The thread list only sharpens the impact of a removal; without it that part is unknown.
    if (need.shell) await until(() => link.shell !== null, PROVIDER_SHELL_GRACE_MS);
    return null;
  };

  const wizard: ProviderCommandDeps["wizard"] = async (start, context) => {
    const look = loadLook();
    const region = new LiveRegion({
      write: (text) => void stdout.write(text),
      columns: () => stdout.columns || 80,
      rows: () => stdout.rows || 24,
    });
    const parser = new KeyParser();
    let listener: ((event: KeyEvent) => void) | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const deliver = (events: ReturnType<KeyParser["feed"]>) => {
      for (const event of events) listener?.(event);
    };
    const onData = (chunk: Buffer) => {
      deliver(parser.feed(chunk));
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = parser.hasPending()
        ? setTimeout(() => deliver(parser.flush()), ESC_FLUSH_MS)
        : null;
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(BRACKETED_PASTE_ON);
    stdin.on("data", onData);
    // A signal that ends the process here must not leave bracketed paste on in the shell.
    const stopGuarding = guardTerminal(
      {
        process,
        write: (text) => void stdout.write(text),
        setRawMode: (raw) => void stdin.setRawMode(raw),
      },
      hostPlatform(),
      { on: BRACKETED_PASTE_ON, off: `${BRACKETED_PASTE_OFF}${SHOW_CURSOR}` },
    );
    try {
      return await runAddWizard({
        terminal: {
          region,
          columns: () => stdout.columns || 80,
          rows: () => stdout.rows || 24,
          keys: (next) => {
            listener = next;
            return () => {
              listener = null;
            };
          },
          resized: (next) => {
            stdout.on("resize", next);
            return () => void stdout.off("resize", next);
          },
        },
        ...look,
        context,
        start: start === null ? openPickView() : openDraftView(start, context),
      });
    } finally {
      stopGuarding();
      stdin.off("data", onData);
      if (flushTimer !== null) clearTimeout(flushTimer);
      stdout.write(`${BRACKETED_PASTE_OFF}${SHOW_CURSOR}`);
      stdin.setRawMode(false);
      stdin.pause();
    }
  };

  void link.start();
  try {
    return await runProviderCommand(input.request, {
      link,
      waitReady,
      out: (line) => say(process.stdout, line),
      err: (line) => say(process.stderr, line),
      env: process.env,
      interactive,
      stdinIsTerminal: stdin.isTTY === true,
      readStdin: readAllStdin,
      ask: askLine,
      wizard,
      columns: stdout.columns || 80,
    });
  } finally {
    await Promise.race([link.stop(), new Promise((resolve) => setTimeout(resolve, 1500))]);
  }
};
