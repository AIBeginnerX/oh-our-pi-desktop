import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  compareReleaseVersions,
  localizedHighlight,
  releaseNotes,
  type ReleaseNoteHighlight,
  type ReleaseNoteVersion,
} from "@t3tools/shared/releaseNotes";

import { configDirectory, type PathEnv } from "../link/paths.ts";
import { sanitizeForTerminal } from "../text/width.ts";
import { getLanguage, t, type Language } from "../i18n/index.ts";

/** The newest release's update feed, as the desktop app reads it. Only `version` is used. */
export const RELEASE_FEED_URL =
  "https://github.com/AIBeginnerX/oh-our-pi-desktop/releases/latest/download/oop-update-macos.json";
/** The release notes shown inside the app, newest first. */
export const RELEASE_NOTES_URL =
  "https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/packages/shared/src/releaseNotes.json";

export const FETCH_TIMEOUT_MS = 3000;
export const CACHE_TTL_MS = 60 * 60 * 1000;
const FEED_LIMIT_BYTES = 64 * 1024;
const NOTES_LIMIT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 40;
const MAX_HIGHLIGHTS = 6;
const TEXT_LIMIT = 300;
const VERSION = /^\d{1,6}(?:\.\d{1,6}){1,3}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** Whether a string from a server or the network is a plain dotted version such as `0.0.127`. */
export const isReleaseVersion = (value: string): boolean => VERSION.test(value);

/** How to update the desktop app, in the words of its own menu and buttons. */
export const updateHowTo = (): string => t("cli.update.howTo");
/** What to run, in a source checkout, to bring the terminal app up to the version of the desktop app. */
export const REINSTALL_COMMAND = "sh apps/oop-tui/install.sh";

/** Whether this process is the desktop app's own runtime, which is how the bundled `oop` is started. */
export const runsInDesktopApp = (): boolean => process.versions.electron !== undefined;

/** The newest release and the notes of the recent ones, cleaned of anything a terminal could act on. */
export interface LatestRelease {
  readonly latest: string;
  /** Newest first. */
  readonly releases: ReadonlyArray<ReleaseNoteVersion>;
}

/** The lookup of a `LatestRelease`: `null` when the network gave nothing usable and there is no cache. */
export type CheckUpdate = (options: { readonly refresh: boolean }) => Promise<LatestRelease | null>;

export type FetchLike = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

const defaultFetch: FetchLike = (url, init) => fetch(url, { signal: init.signal });

const oneLine = (value: string): string =>
  sanitizeForTerminal(value).replace(/\s+/gu, " ").trim().slice(0, TEXT_LIMIT);

// ---- reading what came from the network ---------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `version` of the update feed, or null when it is missing or does not look like a version. */
export const parseFeedVersion = (text: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    const version = isRecord(parsed) && typeof parsed.version === "string" ? parsed.version : "";
    return VERSION.test(version.trim()) ? version.trim() : null;
  } catch {
    return null;
  }
};

const cleanEntry = (raw: unknown): ReleaseNoteVersion | null => {
  if (!isRecord(raw) || typeof raw.version !== "string") return null;
  const version = raw.version.trim();
  if (!VERSION.test(version) || !Array.isArray(raw.highlights)) return null;
  const highlights: Array<{ en: string; ko?: string }> = [];
  for (const item of raw.highlights.slice(0, MAX_HIGHLIGHTS)) {
    if (!isRecord(item)) continue;
    const ko = typeof item.ko === "string" ? oneLine(item.ko) : "";
    const en = typeof item.en === "string" ? oneLine(item.en) : "";
    if (en === "" && ko === "") continue;
    // `en` stays empty when the note has no English text: an English reader gets no body, not Korean.
    highlights.push({ en, ...(ko === "" ? {} : { ko }) });
  }
  const date = typeof raw.date === "string" && DATE.test(raw.date.trim()) ? raw.date.trim() : "";
  return { version, date, highlights };
};

const cleanEntries = (raw: unknown): ReleaseNoteVersion[] =>
  (Array.isArray(raw) ? raw : [])
    .slice(0, MAX_ENTRIES)
    .map(cleanEntry)
    .filter((entry): entry is ReleaseNoteVersion => entry !== null);

/** The notes file `{ versions: [...] }`, entry by entry; null when not a single entry is usable. */
export const parseNotes = (text: string): ReleaseNoteVersion[] | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    const entries = cleanEntries(isRecord(parsed) ? parsed.versions : undefined);
    return entries.length === 0 ? null : entries;
  } catch {
    return null;
  }
};

/** The body of a response, read only up to `limit` bytes. */
const readCapped = async (response: Response, limit: number): Promise<string> => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error(t("cli.update.tooLarge"));
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(t("cli.update.tooLarge"));
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

/**
 * One GET with no headers of ours, cut off after `timeoutMs` even by a fetch that ignores its
 * signal, and when `cancelled` is aborted because the other GET already failed.
 */
const getText = async (
  doFetch: FetchLike,
  url: string,
  limit: number,
  timeoutMs: number,
  cancelled: AbortSignal,
): Promise<string> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCancel = () => {};
  const expired = new Promise<never>((_, reject) => {
    const stop = (reason: string) => () => {
      controller.abort();
      reject(new Error(reason));
    };
    timer = setTimeout(stop(t("cli.update.timeout")), timeoutMs);
    onCancel = stop(t("cli.update.cancelled"));
    cancelled.addEventListener("abort", onCancel, { once: true });
  });
  try {
    return await Promise.race([
      doFetch(url, { signal: controller.signal }).then((response) => readCapped(response, limit)),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
    cancelled.removeEventListener("abort", onCancel);
  }
};

// ---- cache --------------------------------------------------------------------------------

export const updateCacheFilePath = (paths: PathEnv): string =>
  (paths.platform === "win32" ? NodePath.win32 : NodePath).join(
    configDirectory(paths),
    "update-cache.json",
  );

interface Cached {
  readonly checkedAt: number;
  readonly info: LatestRelease;
}

const readCache = (file: string): Cached | null => {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    if (!isRecord(parsed) || typeof parsed.checkedAt !== "number") return null;
    const latest = typeof parsed.latest === "string" ? parsed.latest.trim() : "";
    if (!VERSION.test(latest)) return null;
    return {
      checkedAt: parsed.checkedAt,
      info: { latest, releases: cleanEntries(parsed.releases) },
    };
  } catch {
    return null;
  }
};

/** A cache that cannot be written is only a missed optimisation. */
const writeCache = (file: string, cached: Cached): void => {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(
      temporary,
      JSON.stringify({
        checkedAt: cached.checkedAt,
        latest: cached.info.latest,
        releases: cached.info.releases,
      }),
      { mode: 0o600 },
    );
    NodeFS.chmodSync(temporary, 0o600);
    NodeFS.renameSync(temporary, file);
  } catch {
    try {
      NodeFS.rmSync(temporary, { force: true });
    } catch {
      // Nothing to clean up.
    }
  }
};

// ---- the lookup ---------------------------------------------------------------------------

export interface LookupDeps {
  readonly fetch?: FetchLike;
  readonly now: () => number;
  /** Where the last answer is kept; null for no cache. */
  readonly cacheFile: string | null;
  readonly timeoutMs?: number;
}

/**
 * The newest release and its notes: from the cache while it is under an hour old, else from two
 * GETs made at once. Notes the network did not give are the ones bundled with this build. Any
 * failure is `null`, or, when the caller did not ask for a fresh answer, whatever the cache holds.
 */
export const lookupLatestRelease = async (
  deps: LookupDeps,
  options: { readonly refresh: boolean },
): Promise<LatestRelease | null> => {
  const cached = deps.cacheFile === null ? null : readCache(deps.cacheFile);
  const age = cached === null ? Number.NaN : deps.now() - cached.checkedAt;
  if (!options.refresh && cached !== null && age >= 0 && age < CACHE_TTL_MS) return cached.info;
  const doFetch = deps.fetch ?? defaultFetch;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const cancel = new AbortController();
  try {
    const [feed, notes] = await Promise.all([
      getText(doFetch, RELEASE_FEED_URL, FEED_LIMIT_BYTES, timeoutMs, cancel.signal).catch(
        (cause: unknown) => {
          // The notes are of no use without the version they belong to.
          cancel.abort();
          throw cause;
        },
      ),
      getText(doFetch, RELEASE_NOTES_URL, NOTES_LIMIT_BYTES, timeoutMs, cancel.signal)
        .then(parseNotes)
        .catch(() => null),
    ]);
    const latest = parseFeedVersion(feed);
    if (latest === null) throw new Error(t("cli.update.noVersion"));
    const info: LatestRelease = { latest, releases: notes ?? cleanEntries(releaseNotes) };
    if (deps.cacheFile !== null) writeCache(deps.cacheFile, { checkedAt: deps.now(), info });
    return info;
  } catch {
    return options.refresh ? null : (cached?.info ?? null);
  }
};

// ---- what the lookup means for a given version --------------------------------------------

export interface ReleaseView {
  readonly version: string;
  /** `YYYY-MM-DD`, or empty when the notes gave none. */
  readonly date: string;
  /** In the language of the app, one line each. */
  readonly highlights: ReadonlyArray<string>;
}

export interface UpdateReport {
  readonly status: "update" | "current";
  readonly current: string;
  readonly latest: string;
  /** The releases after `current`, up to `latest`, newest first; empty when `current` is the newest. */
  readonly releases: ReadonlyArray<ReleaseView>;
}

/** A highlight in `language`; empty when it has no text in a language the reader can use (English never falls back to Korean). */
const highlightText = (highlight: ReleaseNoteHighlight, language: Language): string =>
  language === "ko" ? localizedHighlight(highlight, "ko") : highlight.en;

/**
 * Compares `current` with the newest release; the notes of the releases in between are in
 * `language` (Korean where there is Korean, otherwise English), and a highlight with no usable
 * text is left out.
 */
export const buildUpdateReport = (
  current: string,
  info: LatestRelease,
  language: Language = getLanguage(),
): UpdateReport => {
  if (compareReleaseVersions(info.latest, current) <= 0) {
    return { status: "current", current, latest: info.latest, releases: [] };
  }
  const releases = info.releases
    .filter(
      (entry) =>
        compareReleaseVersions(entry.version, current) > 0 &&
        compareReleaseVersions(entry.version, info.latest) <= 0,
    )
    .toSorted((left, right) => compareReleaseVersions(right.version, left.version))
    .map((entry) => ({
      version: entry.version,
      date: entry.date,
      highlights: entry.highlights
        .map((highlight) => highlightText(highlight, language))
        .filter((text) => text !== ""),
    }));
  return { status: "update", current, latest: info.latest, releases };
};

/** The terminal app is older than the desktop app it talks to. */
export const terminalIsBehind = (terminal: string, app: string | null): boolean =>
  app !== null && compareReleaseVersions(terminal, app) < 0;

/**
 * The bundled terminal app is replaced by an app update; only a copy built from a checkout is
 * reinstalled by hand.
 */
export const terminalBehindText = (
  terminal: string,
  app: string,
  inDesktopApp: boolean = runsInDesktopApp(),
): string =>
  t("cli.update.behind", {
    terminal,
    app,
    fix: inDesktopApp
      ? t("cli.update.behindInApp")
      : t("cli.update.behindReinstall", { command: REINSTALL_COMMAND }),
  });

/** Most releases the full listings (`/update`, `oop update`) spell out. */
export const LISTED_RELEASES = 10;

/** Highlights the listings show for each release. */
export const LISTED_HIGHLIGHTS = 3;

/** The releases a listing spells out, and how many it leaves out. */
export const listedReleases = (
  report: UpdateReport,
  limit: number = LISTED_RELEASES,
): { readonly shown: ReadonlyArray<ReleaseView>; readonly omitted: number } => ({
  shown: report.releases.slice(0, limit),
  omitted: Math.max(0, report.releases.length - limit),
});

/** `0.0.127 (2026-10-31)`; the date is left out when the notes had none. */
export const releaseTitle = (release: ReleaseView): string =>
  release.date === "" ? release.version : `${release.version} (${release.date})`;
