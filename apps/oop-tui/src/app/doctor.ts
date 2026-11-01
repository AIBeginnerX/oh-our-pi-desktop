import * as NodeFS from "node:fs";

import type { DiscoveryResult } from "../link/discovery.ts";
import { configDirectory, credentialsFilePath, type PathEnv } from "../link/paths.ts";
import { t } from "../i18n/index.ts";
import { detectColorLevel } from "../render/color.ts";
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

/** Which variable decided the colour level, in the order `detectColorLevel` looks at them. */
const colorReason = (env: NodeJS.ProcessEnv, isTty: boolean): string => {
  if (["0", "1", "2", "3"].includes(env.FORCE_COLOR?.trim() ?? "")) return "FORCE_COLOR";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "NO_COLOR";
  if (env.TERM === "dumb") return "TERM=dumb";
  if (!isTty) return t("doctor.reason.notTty");
  const colorTerm = env.COLORTERM?.toLowerCase();
  if (colorTerm === "truecolor" || colorTerm === "24bit") return "COLORTERM";
  if (env.WT_SESSION !== undefined && env.WT_SESSION !== "") return "Windows Terminal";
  if (env.TERM?.includes("-256color") === true) return "TERM";
  return t("doctor.reason.default");
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
      text: t("doctor.color", {
        name: t(`doctor.color.${level}`),
        reason: colorReason(paths.env, deps.isTty),
      }),
    },
    {
      verdict: "ok",
      text: t("doctor.symbols", {
        kind: symbols === ASCII_SYMBOLS ? "ascii" : "unicode",
        setting: settings.symbols,
      }),
    },
    { verdict: "ok", text: t("doctor.theme", { name: startup.theme.name }) },
    ...startup.warnings.map((warning): Check => ({ verdict: "warn", text: oneLine(warning) })),
  ];

  const settingsChecks: Check[] = [];
  if (file.damaged) {
    settingsChecks.push({
      verdict: "fail",
      text: file.warnings[0] ?? t("doctor.settings.unreadable", { file: settingsFile }),
    });
  } else if (stat(settingsFile) === null) {
    settingsChecks.push({ verdict: "ok", text: t("doctor.settings.none") });
  } else {
    settingsChecks.push({ verdict: "ok", text: t("doctor.settings.ok", { file: settingsFile }) });
  }
  for (const warning of file.warnings.filter(() => !file.damaged)) {
    settingsChecks.push({ verdict: "warn", text: oneLine(warning) });
  }

  const found = await deps.discover().catch((): DiscoveryResult | null => null);
  const server: Check =
    found?.kind === "found"
      ? {
          verdict: "ok",
          text: t("doctor.server.found", {
            port: portOf(found.origin),
            kind: t(found.daemon === true ? "doctor.server.standalone" : "doctor.server.app"),
          }),
        }
      : {
          verdict: "warn",
          text: t("doctor.server.none", {
            detail: found === null ? "" : ` — ${oneLine(found.detail)}`,
          }),
        };

  const credentialsFile = credentialsFilePath(paths);
  const credentials = stat(credentialsFile);
  const loose = credentials !== null && (credentials.mode & 0o077) !== 0;
  const credentialCheck: Check =
    credentials === null
      ? {
          verdict: "warn",
          text: t("doctor.credentials.none"),
        }
      : paths.platform !== "win32" && loose
        ? {
            verdict: "fail",
            text: t("doctor.credentials.wide", { mode: (credentials.mode & 0o777).toString(8) }),
          }
        : { verdict: "ok", text: t("doctor.credentials.ok") };

  const standalone: Check[] =
    deps.standalone === undefined
      ? []
      : [
          deps.standalone.script !== null
            ? { verdict: "ok", text: t("doctor.standalone.ok", { script: deps.standalone.script }) }
            : paths.platform === "darwin" || paths.platform === "win32"
              ? {
                  verdict: "warn",
                  text: t("doctor.standalone.noApp"),
                }
              : {
                  verdict: "ok",
                  text: t("doctor.standalone.unsupported"),
                },
        ];

  return {
    symbolsAscii: symbols === ASCII_SYMBOLS,
    sections: [
      { title: t("doctor.section.terminal"), checks: terminal },
      { title: t("doctor.section.settings"), checks: settingsChecks },
      { title: t("doctor.section.connection"), checks: [server, ...standalone, credentialCheck] },
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
  out(railStart(rail, "oop doctor", t("doctor.title")));
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
        ? theme.success(
            `${t("doctor.passed", { passed, total: all.length })} ${rail.symbols.check}`,
          )
        : (failed > 0 ? theme.error : theme.warning)(
            `${t("doctor.attention", { count: attention })} ${rail.symbols.warning}`,
          ),
    ),
  );
  return failed > 0 ? 1 : 0;
};
