import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { releaseNotes } from "@t3tools/shared/releaseNotes";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { hostPlatform } from "../host.ts";
import { setLanguage } from "../i18n/index.ts";
import {
  buildUpdateReport,
  CACHE_TTL_MS,
  isReleaseVersion,
  lookupLatestRelease,
  parseFeedVersion,
  parseNotes,
  RELEASE_FEED_URL,
  RELEASE_NOTES_URL,
  terminalBehindText,
  terminalIsBehind,
  updateCacheFilePath,
  type FetchLike,
  type LatestRelease,
} from "./updateCheck.ts";

const NOTES = {
  versions: [
    {
      version: "0.0.129",
      date: "2026-11-02",
      highlights: [{ en: "Nine", ko: "아홉" }, { en: "Ten" }],
    },
    { version: "0.0.128", date: "2026-11-01", highlights: [{ en: "Eight", ko: "여덟" }] },
    { version: "0.0.127", date: "2026-10-31", highlights: [{ en: "Seven", ko: "일곱" }] },
  ],
};

interface Call {
  readonly url: string;
  readonly init: { readonly signal: AbortSignal };
}

/** A network that answers the two addresses with the given bodies, and remembers what was asked. */
const network = (
  answers: { feed?: string | Error; notes?: string | Error },
  calls: Call[] = [],
): FetchLike => {
  return async (url, init) => {
    calls.push({ url, init });
    const answer = url === RELEASE_FEED_URL ? answers.feed : answers.notes;
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error("no route");
    return new Response(answer);
  };
};

const feed = (version: string) => JSON.stringify({ version, extra: "ignored" });

let directory = "";
let cacheFile = "";
let clock = 1_000_000;
const deps = (fetch: FetchLike, extra: { cacheFile?: string | null; timeoutMs?: number } = {}) => ({
  fetch,
  now: () => clock,
  cacheFile: extra.cacheFile === undefined ? cacheFile : extra.cacheFile,
  ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
});

beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-update-"));
  cacheFile = NodePath.join(directory, "sub", "update-cache.json");
  clock = 1_000_000;
});
afterEach(() => {
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("parsing what the network sends", () => {
  it("reads only a plain version out of the update feed", () => {
    expect(parseFeedVersion(feed("0.0.127"))).toBe("0.0.127");
    expect(parseFeedVersion(feed(" 1.2.3 "))).toBe("1.2.3");
    for (const bad of [
      "",
      "not json",
      "[]",
      "{}",
      feed("latest"),
      feed("1.2.3\u001b[31m"),
      '{"version":5}',
    ]) {
      expect(parseFeedVersion(bad), bad).toBeNull();
    }
    expect(isReleaseVersion("0.0.127")).toBe(true);
    expect(isReleaseVersion("v1")).toBe(false);
  });

  it("keeps the entries it understands and drops the rest without failing", () => {
    const parsed = parseNotes(
      JSON.stringify({
        versions: [
          "junk",
          {
            version: "0.0.9",
            date: "2026-01-02",
            highlights: [{ en: "ok" }, 3, { ko: "한글만" }, {}],
          },
          { version: "bad", highlights: [] },
          { version: "0.0.8", date: "yesterday", highlights: "nope" },
          { version: "0.0.7", highlights: [{ en: "no date" }] },
        ],
      }),
    );
    expect(parsed).toEqual([
      {
        version: "0.0.9",
        date: "2026-01-02",
        highlights: [{ en: "ok" }, { en: "", ko: "한글만" }],
      },
      { version: "0.0.7", date: "", highlights: [{ en: "no date" }] },
    ]);
  });

  it("is null for anything that is not a notes file", () => {
    for (const bad of [
      "",
      "{",
      "null",
      "[]",
      '{"versions":5}',
      '{"versions":[]}',
      '{"versions":[1,2]}',
    ]) {
      expect(parseNotes(bad), bad).toBeNull();
    }
  });

  it("strips control characters and escape sequences from every text, and cuts long ones", () => {
    const parsed = parseNotes(
      JSON.stringify({
        versions: [
          {
            version: "0.0.9",
            date: "2026-01-02",
            highlights: [
              { en: `A\u001b[31mred\u001b[0m\u0007\u0000 line\nbreak ${"x".repeat(500)}` },
            ],
          },
        ],
      }),
    );
    const text = parsed?.[0]?.highlights[0]?.en ?? "";
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect(text.startsWith("Ared")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(300);
  });
});

describe("lookupLatestRelease", () => {
  it("makes two GETs with no headers of ours and returns the newest version with the notes", async () => {
    const calls: Call[] = [];
    const info = await lookupLatestRelease(
      deps(network({ feed: feed("0.0.129"), notes: JSON.stringify(NOTES) }, calls)),
      { refresh: false },
    );
    expect(info?.latest).toBe("0.0.129");
    expect(info?.releases.map((entry) => entry.version)).toEqual(["0.0.129", "0.0.128", "0.0.127"]);
    expect(calls.map((call) => call.url).toSorted()).toEqual(
      [RELEASE_FEED_URL, RELEASE_NOTES_URL].toSorted(),
    );
    for (const call of calls) expect(Object.keys(call.init)).toEqual(["signal"]);
  });

  it("falls back to the notes bundled with the build when the notes do not come", async () => {
    for (const notes of [new Error("offline"), "{ not json", JSON.stringify({ versions: [] })]) {
      const info = await lookupLatestRelease(
        deps(network({ feed: feed("9.9.9"), notes }), { cacheFile: null }),
        { refresh: true },
      );
      expect(info?.latest).toBe("9.9.9");
      expect(info?.releases.map((entry) => entry.version)).toEqual(
        releaseNotes.slice(0, 40).map((entry) => entry.version),
      );
    }
  });

  it("is null when the feed fails, is not JSON, or has no usable version, and there is no cache", async () => {
    for (const bad of [new Error("offline"), "<html>", feed("x"), "{}"]) {
      const info = await lookupLatestRelease(
        deps(network({ feed: bad, notes: JSON.stringify(NOTES) }), { cacheFile: null }),
        { refresh: false },
      );
      expect(info, String(bad)).toBeNull();
    }
  });

  it("gives up after the time limit even from a fetch that never answers or ignores the signal", async () => {
    const hangs: FetchLike = () => new Promise<Response>(() => undefined);
    const started = Date.now();
    const info = await lookupLatestRelease(deps(hangs, { cacheFile: null, timeoutMs: 30 }), {
      refresh: true,
    });
    expect(info).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("aborts the request when the time is up", async () => {
    const calls: Call[] = [];
    const slow: FetchLike = (url, init) => {
      calls.push({ url, init });
      return new Promise<Response>((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    await lookupLatestRelease(deps(slow, { cacheFile: null, timeoutMs: 20 }), { refresh: true });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.init.signal.aborted).toBe(true);
  });

  it("refuses a body over the limit, declared or streamed, and an error status", async () => {
    const huge = "x".repeat(2 * 1024 * 1024);
    const declared: FetchLike = async () =>
      new Response("{}", { headers: { "content-length": String(huge.length) } });
    const streamed: FetchLike = async (url) =>
      new Response(url === RELEASE_FEED_URL ? huge : feed("1.0.0"));
    const failing: FetchLike = async () => new Response(feed("1.0.0"), { status: 503 });
    for (const fetch of [declared, streamed, failing]) {
      expect(
        await lookupLatestRelease(deps(fetch, { cacheFile: null }), { refresh: true }),
      ).toBeNull();
    }
  });

  it("falls back to the bundled notes when the notes body is over the limit", async () => {
    const fetch: FetchLike = async (url) =>
      new Response(url === RELEASE_FEED_URL ? feed("9.9.9") : "x".repeat(2 * 1024 * 1024));
    const info = await lookupLatestRelease(deps(fetch, { cacheFile: null }), { refresh: true });
    expect(info?.latest).toBe("9.9.9");
    expect(info?.releases.length).toBeGreaterThan(0);
  });
});

describe("the cache", () => {
  const answered = (calls: Call[]) =>
    network({ feed: feed("0.0.129"), notes: JSON.stringify(NOTES) }, calls);

  it("is written beside the other settings, readable by its owner alone, and holds no secrets", async () => {
    await lookupLatestRelease(deps(answered([])), { refresh: false });
    const mode = NodeFS.statSync(cacheFile).mode & 0o777;
    if (hostPlatform() !== "win32") expect(mode).toBe(0o600);
    const saved = JSON.parse(NodeFS.readFileSync(cacheFile, "utf8")) as Record<string, unknown>;
    expect(Object.keys(saved).toSorted()).toEqual(["checkedAt", "latest", "releases"]);
    expect(NodeFS.readdirSync(NodePath.dirname(cacheFile))).toEqual(["update-cache.json"]);
  });

  it("answers from the cache for an hour without asking the network", async () => {
    await lookupLatestRelease(deps(answered([])), { refresh: false });
    clock += CACHE_TTL_MS - 1;
    const calls: Call[] = [];
    const info = await lookupLatestRelease(deps(answered(calls)), { refresh: false });
    expect(calls).toEqual([]);
    expect(info?.latest).toBe("0.0.129");
  });

  it("asks again after an hour, or when told to, and keeps the new answer", async () => {
    await lookupLatestRelease(deps(answered([])), { refresh: false });
    clock += CACHE_TTL_MS;
    const calls: Call[] = [];
    const newer = network({ feed: feed("0.0.130"), notes: JSON.stringify(NOTES) }, calls);
    expect((await lookupLatestRelease(deps(newer), { refresh: false }))?.latest).toBe("0.0.130");
    expect(calls).toHaveLength(2);
    const again: Call[] = [];
    const newest = network({ feed: feed("0.0.131"), notes: JSON.stringify(NOTES) }, again);
    expect((await lookupLatestRelease(deps(newest), { refresh: true }))?.latest).toBe("0.0.131");
    expect(again).toHaveLength(2);
    expect((await lookupLatestRelease(deps(answered([])), { refresh: false }))?.latest).toBe(
      "0.0.131",
    );
  });

  it("serves an old cache when the network fails, but a fresh lookup that fails is a failure", async () => {
    await lookupLatestRelease(deps(answered([])), { refresh: false });
    clock += CACHE_TTL_MS * 5;
    const offline = network({ feed: new Error("offline"), notes: new Error("offline") });
    expect((await lookupLatestRelease(deps(offline), { refresh: false }))?.latest).toBe("0.0.129");
    expect(await lookupLatestRelease(deps(offline), { refresh: true })).toBeNull();
  });

  it("ignores a cache from the future or one that is damaged", async () => {
    NodeFS.mkdirSync(NodePath.dirname(cacheFile), { recursive: true });
    NodeFS.writeFileSync(
      cacheFile,
      JSON.stringify({ checkedAt: clock + 10 * CACHE_TTL_MS, latest: "0.0.1", releases: [] }),
    );
    const calls: Call[] = [];
    expect((await lookupLatestRelease(deps(answered(calls)), { refresh: false }))?.latest).toBe(
      "0.0.129",
    );
    expect(calls).toHaveLength(2);
    NodeFS.writeFileSync(cacheFile, "{ damaged");
    const offline = network({ feed: new Error("offline") });
    expect(await lookupLatestRelease(deps(offline), { refresh: false })).toBeNull();
  });

  it("does not trust what a cache says: a bad version or text is cleaned or dropped", async () => {
    NodeFS.mkdirSync(NodePath.dirname(cacheFile), { recursive: true });
    NodeFS.writeFileSync(
      cacheFile,
      JSON.stringify({
        checkedAt: clock,
        latest: "0.0.5",
        releases: [
          { version: "0.0.5", date: "2026-01-01", highlights: [{ en: "ok\u001b[2Jgone" }] },
          { version: "x" },
        ],
      }),
    );
    const info = await lookupLatestRelease(deps(network({})), { refresh: false });
    expect(info?.releases).toEqual([
      { version: "0.0.5", date: "2026-01-01", highlights: [{ en: "okgone" }] },
    ]);
  });

  it("is only a missed shortcut when it cannot be written", async () => {
    NodeFS.writeFileSync(NodePath.join(directory, "sub"), "a file where a folder should be");
    const info = await lookupLatestRelease(deps(answered([])), { refresh: false });
    expect(info?.latest).toBe("0.0.129");
  });

  it("lives under OOP_CONFIG_DIR, or the default config folder", () => {
    const path = (env: Record<string, string>, platform: NodeJS.Platform = "darwin") =>
      updateCacheFilePath({ env, platform, home: "/home/me" });
    expect(path({ OOP_CONFIG_DIR: "/custom" })).toBe("/custom/update-cache.json");
    expect(path({})).toBe("/home/me/.config/oop-tui/update-cache.json");
  });
});

describe("buildUpdateReport", () => {
  const info: LatestRelease = {
    latest: "0.0.129",
    releases: [
      { version: "0.0.127", date: "2026-10-31", highlights: [{ en: "Seven", ko: "일곱" }] },
      { version: "0.0.130", date: "2026-11-05", highlights: [{ en: "Not yet published" }] },
      {
        version: "0.0.129",
        date: "2026-11-02",
        highlights: [{ en: "Nine", ko: "아홉" }, { en: "Ten" }],
      },
      { version: "0.0.128", date: "2026-11-01", highlights: [{ en: "Eight" }] },
    ],
  };

  it("lists the releases after the current one up to the newest, newest first, in Korean where there is Korean", () => {
    const report = buildUpdateReport("0.0.127", info, "ko");
    expect(report.status).toBe("update");
    expect(report.latest).toBe("0.0.129");
    expect(report.releases.map((release) => release.version)).toEqual(["0.0.129", "0.0.128"]);
    expect(report.releases[0]?.highlights).toEqual(["아홉", "Ten"]);
    expect(report.releases[1]?.highlights).toEqual(["Eight"]);
  });

  it("shows English notes for an English reader, and never Korean", () => {
    const report = buildUpdateReport("0.0.127", info, "en");
    expect(report.releases[0]?.highlights).toEqual(["Nine", "Ten"]);
    expect(report.releases[1]?.highlights).toEqual(["Eight"]);
    const koreanOnly: LatestRelease = {
      latest: "0.0.2",
      releases: [
        {
          version: "0.0.2",
          date: "2026-01-01",
          highlights: [{ en: "", ko: "한글만" }, { en: "Kept" }],
        },
      ],
    };
    expect(buildUpdateReport("0.0.1", koreanOnly, "en").releases[0]?.highlights).toEqual(["Kept"]);
    expect(buildUpdateReport("0.0.1", koreanOnly, "ko").releases[0]?.highlights).toEqual([
      "한글만",
      "Kept",
    ]);
  });

  it("follows the app language when none is given", () => {
    setLanguage("en");
    try {
      expect(buildUpdateReport("0.0.127", info).releases[0]?.highlights).toEqual(["Nine", "Ten"]);
    } finally {
      setLanguage("ko");
    }
  });

  it("is current at the newest version, and when the app is ahead of it", () => {
    expect(buildUpdateReport("0.0.129", info)).toEqual({
      status: "current",
      current: "0.0.129",
      latest: "0.0.129",
      releases: [],
    });
    expect(buildUpdateReport("0.1.0", info).status).toBe("current");
  });

  it("still says there is an update when the notes have nothing for it", () => {
    const report = buildUpdateReport("0.0.1", { latest: "0.0.2", releases: [] });
    expect(report).toMatchObject({ status: "update", latest: "0.0.2", releases: [] });
  });

  it("compares numbers, not strings", () => {
    expect(buildUpdateReport("0.0.9", { latest: "0.0.10", releases: [] }).status).toBe("update");
    expect(buildUpdateReport("0.0.10", { latest: "0.0.9", releases: [] }).status).toBe("current");
  });
});

describe("terminalIsBehind", () => {
  it("is true only for a known app that is newer", () => {
    expect(terminalIsBehind("0.0.120", "0.0.127")).toBe(true);
    expect(terminalIsBehind("0.0.127", "0.0.127")).toBe(false);
    expect(terminalIsBehind("0.0.128", "0.0.127")).toBe(false);
    expect(terminalIsBehind("0.0.120", null)).toBe(false);
  });
});

describe("terminalBehindText", () => {
  it("sends a terminal run by the desktop app to the app update, not to a reinstall", () => {
    const text = terminalBehindText("0.0.120", "0.0.127", true);
    expect(text).toBe(
      "터미널 앱 0.0.120 이 앱 0.0.127 보다 오래되었습니다 — 앱을 업데이트하면 함께 갱신됩니다",
    );
    expect(text).not.toContain("install.sh");
  });

  it("keeps the checkout reinstall for a terminal run any other way", () => {
    expect(terminalBehindText("0.0.120", "0.0.127", false)).toBe(
      "터미널 앱 0.0.120 이 앱 0.0.127 보다 오래되었습니다 — 다시 설치: sh apps/oop-tui/install.sh",
    );
  });
});
