import { describe, expect, it } from "vite-plus/test";

import type { CheckUpdate, LatestRelease } from "./updateCheck.ts";
import { runUpdateCommand } from "./updateCommand.ts";

const INFO: LatestRelease = {
  latest: "0.0.130",
  releases: [
    {
      version: "0.0.130",
      date: "2026-11-03",
      highlights: [
        { en: "A", ko: "가" },
        { en: "B", ko: "나" },
      ],
    },
    { version: "0.0.129", date: "", highlights: [{ en: "C", ko: "다" }] },
    { version: "0.0.128", date: "2026-11-01", highlights: [{ en: "D", ko: "라" }] },
    { version: "0.0.127", date: "2026-10-31", highlights: [{ en: "E", ko: "마" }] },
  ],
};

const run = async (input: {
  readonly terminal?: string;
  readonly app?: string | null;
  readonly check?: CheckUpdate;
}) => {
  const out: string[] = [];
  const err: string[] = [];
  const asked: boolean[] = [];
  const code = await runUpdateCommand({
    terminalVersion: input.terminal ?? "0.0.127",
    appVersion: async () => (input.app === undefined ? "0.0.127" : input.app),
    check:
      input.check ??
      (async ({ refresh }) => {
        asked.push(refresh);
        return INFO;
      }),
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
  });
  return { code, out, err, asked };
};

describe("oop update", () => {
  it("says the version, that it is checking, and that the app is already the newest", async () => {
    const result = await run({ check: async () => ({ latest: "0.0.127", releases: [] }) });
    expect(result.out).toEqual([
      "현재 버전: 0.0.127",
      "업데이트 확인 중…",
      "이미 최신입니다 (0.0.127).",
    ]);
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
  });

  it("lists each newer release with its highlights, then how to update", async () => {
    const result = await run({});
    expect(result.out.slice(0, 3)).toEqual([
      "현재 버전: 0.0.127",
      "업데이트 확인 중…",
      "업데이트 있음: 0.0.127 → 0.0.130",
    ]);
    expect(result.out.slice(3, -1)).toEqual([
      "  0.0.130 (2026-11-03)",
      "    - 가",
      "    - 나",
      "  0.0.129",
      "    - 다",
      "  0.0.128 (2026-11-01)",
      "    - 라",
    ]);
    expect(result.out.at(-1)).toMatch(/^업데이트 방법: /u);
    expect(result.code).toBe(0);
  });

  it("always looks the release up again", async () => {
    expect((await run({})).asked).toEqual([true]);
  });

  it("measures from the terminal app's own version when no app is running", async () => {
    const result = await run({ app: null, terminal: "0.0.128" });
    expect(result.out[0]).toBe("현재 버전: 0.0.128");
    expect(result.out[2]).toBe("업데이트 있음: 0.0.128 → 0.0.130");
    expect(result.out.join("\n")).not.toContain("터미널 앱");
  });

  it("measures from the app's version when it answers, and says when the terminal app is older", async () => {
    const result = await run({ app: "0.0.129", terminal: "0.0.120" });
    expect(result.out[0]).toBe("현재 버전: 0.0.129");
    expect(result.out[2]).toBe("업데이트 있음: 0.0.129 → 0.0.130");
    expect(result.out.at(-1)).toBe(
      "터미널 앱 0.0.120 이 앱 0.0.129 보다 오래되었습니다 — 다시 설치: sh apps/oop-tui/install.sh",
    );
    const current = await run({
      app: "0.0.130",
      terminal: "0.0.120",
      check: async () => INFO,
    });
    expect(current.out).toContain("이미 최신입니다 (0.0.130).");
    expect(current.out.at(-1)).toContain("터미널 앱 0.0.120");
  });

  it("leaves out the releases past ten with a count", async () => {
    const many: LatestRelease = {
      latest: "0.0.150",
      releases: Array.from({ length: 24 }, (_, index) => ({
        version: `0.0.${150 - index}`,
        date: "",
        highlights: [{ en: "x" }],
      })),
    };
    const result = await run({ app: "0.0.127", check: async () => many });
    expect(result.out.filter((line) => /^ {2}0\.0\.\d+$/u.test(line))).toHaveLength(10);
    expect(result.out).toContain("  외 13개 릴리스");
  });

  it("fails with a message and exit 1 when the release cannot be looked up", async () => {
    const result = await run({ check: async () => null });
    expect(result.out).toEqual(["현재 버전: 0.0.127", "업데이트 확인 중…"]);
    expect(result.err).toEqual(["업데이트를 확인하지 못했습니다. 네트워크 연결을 확인하세요."]);
    expect(result.code).toBe(1);
  });
});
