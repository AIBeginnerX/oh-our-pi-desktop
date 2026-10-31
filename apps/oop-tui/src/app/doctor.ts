import * as NodeFS from "node:fs";

import type { DiscoveryResult } from "../link/discovery.ts";
import { configDirectory, credentialsFilePath, type PathEnv } from "../link/paths.ts";
import { detectColorLevel, type ColorLevel } from "../render/color.ts";
import { railEnd, railGap, railNote, railStart, type Rail } from "../render/rail.ts";
import { makeStyle } from "../render/style.ts";
import { ASCII_SYMBOLS, resolveSymbols, UNICODE_SYMBOLS } from "../render/symbols.ts";
import { createTheme, BUILTIN_THEMES } from "../render/theme.ts";
import { loadStartupTheme, readSettings, resolveSettings, settingsFilePath } from "../settings.ts";
import { sanitizeForTerminal } from "../text/width.ts";
import { wrapWithPrefix } from "../text/wrap.ts";

type Verdict = "ok" | "warn" | "fail";

interface Check {
  readonly verdict: Verdict;
  readonly text: string;
}

interface Section {
  readonly title: string;
  readonly checks: ReadonlyArray<Check>;
}

export interface DoctorDeps {
  readonly paths: PathEnv;
  readonly isTty: boolean;
  /** Looks for the OOP server on this computer. It must not start anything. */
  readonly discover: () => Promise<DiscoveryResult>;
  /** What the file system says about a path; the contents are never asked for. */
  readonly stat?: (path: string) => { readonly mode: number } | null;
  /**
   * Whether this terminal can start the server of the installed app by itself: the script it would
   * run, or null when there is none. Leave out to skip the check.
   */
  readonly standalone?: { readonly script: string | null };
  /** Width of the terminal the lines go to; 80 when it is not known. */
  readonly columns?: number;
  readonly out: (line: string) => void;
}

const COLOR_NAMES: Record<ColorLevel, string> = {
  0: "없음",
  1: "16색",
  2: "256색",
  3: "트루컬러",
};

/** Which variable decided the colour level, in the order `detectColorLevel` looks at them. */
const colorReason = (env: NodeJS.ProcessEnv, isTty: boolean): string => {
  if (["0", "1", "2", "3"].includes(env.FORCE_COLOR?.trim() ?? "")) return "FORCE_COLOR";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "NO_COLOR";
  if (env.TERM === "dumb") return "TERM=dumb";
  if (!isTty) return "터미널이 아님";
  const colorTerm = env.COLORTERM?.toLowerCase();
  if (colorTerm === "truecolor" || colorTerm === "24bit") return "COLORTERM";
  if (env.WT_SESSION !== undefined && env.WT_SESSION !== "") return "Windows Terminal";
  if (env.TERM?.includes("-256color") === true) return "TERM";
  return "기본값";
};

const defaultStat = (path: string): { readonly mode: number } | null => {
  try {
    return { mode: NodeFS.statSync(path).mode };
  } catch {
    return null;
  }
};

const portOf = (origin: string): string => {
  try {
    const url = new URL(origin);
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return "?";
  }
};

const oneLine = (value: string): string => sanitizeForTerminal(value).replace(/\s+/gu, " ").trim();

/** The checks, as data. Nothing here prints, starts the app, or reads a credential. */
export const collectChecks = async (
  deps: DoctorDeps,
): Promise<{ readonly sections: ReadonlyArray<Section>; readonly symbolsAscii: boolean }> => {
  const { paths } = deps;
  const stat = deps.stat ?? defaultStat;
  const level = detectColorLevel(paths.env, deps.isTty);
  const settingsFile = settingsFilePath(paths);
  const file = readSettings(settingsFile);
  const { settings } = resolveSettings(file.values, paths.env);
  const symbols = resolveSymbols(settings.symbols, paths.env, paths.platform);
  const startup = loadStartupTheme({
    theme: settings.theme,
    level,
    configDir: configDirectory(paths),
    env: paths.env,
  });

  const terminal: Check[] = [
    {
      verdict: "ok",
      text: `색: ${COLOR_NAMES[level]} (${colorReason(paths.env, deps.isTty)})`,
    },
    {
      verdict: "ok",
      text: `심볼: ${symbols === ASCII_SYMBOLS ? "ascii" : "unicode"} (${settings.symbols})`,
    },
    { verdict: "ok", text: `테마: ${startup.theme.name}` },
    ...startup.warnings.map((warning): Check => ({ verdict: "warn", text: oneLine(warning) })),
  ];

  const settingsChecks: Check[] = [];
  if (file.damaged) {
    settingsChecks.push({
      verdict: "fail",
      text: file.warnings[0] ?? `설정 파일을 읽을 수 없어 기본값을 씁니다: ${settingsFile}`,
    });
  } else if (stat(settingsFile) === null) {
    settingsChecks.push({ verdict: "ok", text: "설정 파일 없음 (기본값 사용)" });
  } else {
    settingsChecks.push({ verdict: "ok", text: `설정 파일 정상: ${settingsFile}` });
  }
  for (const warning of file.warnings.filter(() => !file.damaged)) {
    settingsChecks.push({ verdict: "warn", text: oneLine(warning) });
  }

  const found = await deps.discover().catch((): DiscoveryResult | null => null);
  const server: Check =
    found?.kind === "found"
      ? {
          verdict: "ok",
          text: `이 컴퓨터의 OOP 서버: 있음 (포트 ${portOf(found.origin)}) — ${
            found.daemon === true ? "터미널 단독 서버" : "앱이 쓰는 서버"
          }`,
        }
      : {
          verdict: "warn",
          text: `이 컴퓨터의 OOP 서버: 없음${found === null ? "" : ` — ${oneLine(found.detail)}`}`,
        };

  const credentialsFile = credentialsFilePath(paths);
  const credentials = stat(credentialsFile);
  const loose = credentials !== null && (credentials.mode & 0o077) !== 0;
  const credentialCheck: Check =
    credentials === null
      ? {
          verdict: "warn",
          text: "자격증명 파일 없음 — 이 컴퓨터는 'oop' 이 자동 연결하고, 다른 컴퓨터는 'oop pair' 로 연결합니다",
        }
      : paths.platform !== "win32" && loose
        ? {
            verdict: "fail",
            text: `자격증명 파일 권한이 넓습니다 (${(credentials.mode & 0o777).toString(8)}): chmod 600 으로 줄이세요`,
          }
        : { verdict: "ok", text: "자격증명 파일 있음 (내용은 읽지 않음)" };

  const standalone: Check[] =
    deps.standalone === undefined
      ? []
      : [
          deps.standalone.script !== null
            ? { verdict: "ok", text: `터미널 단독 실행: 가능 (${deps.standalone.script})` }
            : paths.platform === "darwin" || paths.platform === "win32"
              ? {
                  verdict: "warn",
                  text: "터미널 단독 실행: 불가 — 설치된 OOP 앱을 찾지 못했습니다 (앱이 꺼지면 연결이 끊어집니다)",
                }
              : {
                  verdict: "ok",
                  text: "터미널 단독 실행: 이 운영체제에서는 지원하지 않습니다 (앱이 꺼지면 연결이 끊어집니다)",
                },
        ];

  return {
    symbolsAscii: symbols === ASCII_SYMBOLS,
    sections: [
      { title: "터미널", checks: terminal },
      { title: "설정", checks: settingsChecks },
      { title: "연결", checks: [server, ...standalone, credentialCheck] },
    ],
  };
};

/** `oop doctor`'s mark for each verdict, in the colour that goes with it. */
const MARKS = {
  ok: (rail: Rail) => rail.style.theme.success(rail.symbols.check),
  warn: (rail: Rail) => rail.style.theme.warning(rail.symbols.warning),
  fail: (rail: Rail) => rail.style.theme.error(rail.symbols.cross),
} as const;

/** The widest a terminal is taken to be when the output is not one. */
const DEFAULT_COLUMNS = 80;

/**
 * `oop doctor`: one note on the rail for each group of checks, then the count that passed. Returns 1
 * when a check failed, else 0. A check too long for the box is folded under its own mark, not cut:
 * what the doctor says is the whole point of it.
 */
export const runDoctor = async (deps: DoctorDeps): Promise<number> => {
  const { sections, symbolsAscii } = await collectChecks(deps);
  const level = detectColorLevel(deps.paths.env, deps.isTty);
  const theme = createTheme("ansi", BUILTIN_THEMES.ansi, level);
  const rail: Rail = {
    style: makeStyle(theme),
    symbols: symbolsAscii ? ASCII_SYMBOLS : UNICODE_SYMBOLS,
  };
  const width = Math.max(20, deps.columns ?? DEFAULT_COLUMNS);
  // The room inside a note: its frame takes the rail, the padding and the right edge.
  const room = width - 6;

  const { out } = deps;
  out(railStart(rail, "oop doctor", "터미널 점검"));
  for (const section of sections) {
    out(railGap(rail));
    const body = section.checks.flatMap((check) =>
      wrapWithPrefix(oneLine(check.text), room, `${MARKS[check.verdict](rail)} `, "  "),
    );
    for (const row of railNote(rail, theme.text.bold(section.title), body, width)) out(row);
  }
  const all = sections.flatMap((section) => section.checks);
  const failed = all.filter((check) => check.verdict === "fail").length;
  const attention = failed + all.filter((check) => check.verdict === "warn").length;
  const passed = all.length - attention;
  out(railGap(rail));
  out(
    railEnd(
      rail,
      attention === 0
        ? theme.success(`${passed}/${all.length} 점검 통과 ${rail.symbols.check}`)
        : (failed > 0 ? theme.error : theme.warning)(
            `${attention}건 확인 필요 ${rail.symbols.warning}`,
          ),
    ),
  );
  return failed > 0 ? 1 : 0;
};
