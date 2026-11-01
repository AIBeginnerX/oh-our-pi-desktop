import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { setLanguage } from "../i18n/index.ts";

import type { DiscoveryResult } from "../link/discovery.ts";
import type { PathEnv } from "../link/paths.ts";
import { stripAnsi, visibleWidth } from "../text/width.ts";
import { runDoctor } from "./doctor.ts";

const SECRET = "not-a-real-value";

let root: string;

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-doctor-"));
});

afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

const found: DiscoveryResult = {
  kind: "found",
  pid: 1,
  origin: "http://127.0.0.1:3773",
  environmentId: "env",
  label: "local",
};

const run = async (
  options: {
    env?: NodeJS.ProcessEnv;
    isTty?: boolean;
    discover?: DiscoveryResult;
    platform?: NodeJS.Platform;
    columns?: number;
    standalone?: { script: string | null };
  } = {},
) => {
  const paths: PathEnv = {
    env: { OOP_CONFIG_DIR: root, LANG: "en_US.UTF-8", COLORTERM: "truecolor", ...options.env },
    platform: options.platform ?? "darwin",
    home: root,
  };
  const lines: string[] = [];
  const code = await runDoctor({
    paths,
    isTty: options.isTty ?? true,
    discover: async () => options.discover ?? found,
    columns: options.columns ?? 80,
    ...(options.standalone !== undefined ? { standalone: options.standalone } : {}),
    out: (line) => lines.push(line),
  });
  return { code, lines, text: lines.join("\n"), plain: lines.map(stripAnsi).join("\n") };
};

const writeCredentials = (mode: number) => {
  const file = NodePath.join(root, "credentials.json");
  NodeFS.writeFileSync(file, JSON.stringify({ token: SECRET }));
  NodeFS.chmodSync(file, mode);
};

describe("runDoctor", () => {
  it("prints a tree with the colour, symbols, theme, settings, server and credential checks", async () => {
    writeCredentials(0o600);
    const { code, plain } = await run();
    expect(code).toBe(0);
    expect(plain).toMatch(/^┌ +oop doctor +터미널 점검$/mu);
    expect(plain).toContain("◇  터미널 ");
    expect(plain).toContain("◇  설정 ");
    expect(plain).toContain("◇  연결 ");
    expect(plain).toContain("│  ✓ 색: 트루컬러 (COLORTERM)");
    expect(plain).toContain("│  ✓ 심볼: unicode");
    expect(plain).toContain("│  ✓ 테마:");
    expect(plain).toContain("│  ✓ 설정 파일 없음");
    expect(plain).toContain("│  ✓ 이 컴퓨터의 OOP 서버: 있음 (포트 3773)");
    expect(plain).toContain("│  ✓ 자격증명 파일 있음 (내용은 읽지 않음)");
    expect(plain.trimEnd().split("\n").at(-1)).toBe("└  6/6 점검 통과 ✓");
  });

  it("says whose the server is: the app's, the terminal's own, or none", async () => {
    expect((await run()).plain).toContain("있음 (포트 3773) — 앱이 쓰는 서버");
    expect((await run({ discover: { ...found, daemon: true } })).plain).toContain(
      "있음 (포트 3773) — 터미널 단독 서버",
    );
    expect((await run({ discover: { kind: "missing", detail: "x" } })).plain).toContain(
      "OOP 서버: 없음",
    );
  });

  it("says whether the terminal can start the server by itself", async () => {
    const can = await run({ standalone: { script: "/Applications/OOP.app/x/bin.mjs" } });
    expect(can.plain).toContain("✓ 터미널 단독 실행: 가능 (/Applications/OOP.app/x/bin.mjs)");
    const cannot = await run({ standalone: { script: null } });
    expect(cannot.plain).toContain("▲ 터미널 단독 실행: 불가 — 설치된 OOP 앱을 찾지 못했습니다");
    const linux = await run({ standalone: { script: null }, platform: "linux" });
    expect(linux.plain).toContain("✓ 터미널 단독 실행: 이 운영체제에서는 지원하지 않습니다");
  });

  it("never prints the credential's contents or the server address", async () => {
    writeCredentials(0o600);
    const { text } = await run();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("127.0.0.1");
  });

  it("exits 1 when the credential file is readable by others, and says how to fix it", async () => {
    writeCredentials(0o644);
    const { code, plain } = await run();
    expect(code).toBe(1);
    expect(plain).toContain("✗ 자격증명 파일 권한이 넓습니다 (644)");
    expect(plain).toContain("chmod 600");
    expect(plain.trimEnd().split("\n").at(-1)).toBe("└  1건 확인 필요 ▲");
    expect(plain).not.toContain(SECRET);
  });

  it("does not judge unix permission bits on Windows", async () => {
    writeCredentials(0o644);
    const { code } = await run({ platform: "win32", env: { OOP_CONFIG_DIR: root } });
    expect(code).toBe(0);
  });

  it("warns, without failing, when there is no server or no credential file", async () => {
    const { code, plain } = await run({
      discover: { kind: "missing", detail: "server-runtime.json 없음" },
    });
    expect(code).toBe(0);
    expect(plain).toContain("▲ 이 컴퓨터의 OOP 서버: 없음 — server-runtime.json 없음");
    expect(plain).toContain("▲ 자격증명 파일 없음");
    expect(plain.trimEnd().split("\n").at(-1)).toBe("└  2건 확인 필요 ▲");
  });

  it("fails on a settings file it cannot read, and leaves the file as it was", async () => {
    const file = NodePath.join(root, "settings.json");
    NodeFS.writeFileSync(file, "{ not json");
    const { code, plain } = await run();
    expect(code).toBe(1);
    expect(plain).toContain("✗");
    expect(NodeFS.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("explains why colour is off, and prints no escape codes then", async () => {
    const { lines, plain } = await run({ env: { NO_COLOR: "1", COLORTERM: undefined } });
    expect(plain).toContain("색: 없음 (NO_COLOR)");
    for (const line of lines) expect(line).toBe(stripAnsi(line));
  });

  it("is plain without a terminal", async () => {
    const { lines, plain } = await run({ isTty: false, env: { COLORTERM: undefined } });
    expect(plain).toContain("색: 없음 (터미널이 아님)");
    for (const line of lines) expect(line).not.toContain("\u001b");
  });

  it("draws the tree in ASCII under the ascii preset", async () => {
    const { plain } = await run({ env: { OOP_SYMBOLS: undefined, LANG: "C", LC_ALL: undefined } });
    expect(plain).toContain("심볼: ascii");
    expect(plain).not.toMatch(/[┌◇│└✓✗▲]/u);
    expect(plain).toContain("+  oop doctor");
  });

  it("keeps every line inside the terminal and every note box one width, at any width", async () => {
    writeCredentials(0o644);
    for (const columns of [30, 40, 80, 120]) {
      for (const env of [{}, { NO_COLOR: "1" }, { LANG: "C", LC_ALL: undefined }]) {
        const { lines } = await run({
          columns,
          env,
          discover: { kind: "missing", detail: "서버 실행 기록이 없습니다 ".repeat(6) },
        });
        for (const line of lines) {
          expect(visibleWidth(line), `@ ${columns}: ${stripAnsi(line)}`).toBeLessThanOrEqual(
            columns,
          );
        }
        // Each note box is the rows from its title to its closing joint; they end in one column.
        const rows = lines.map(stripAnsi);
        let box: number[] = [];
        for (const row of rows) {
          if (/^(◇|o)  /u.test(row)) box = [visibleWidth(row)];
          else if (box.length > 0 && /^(\||│)/u.test(row)) box.push(visibleWidth(row));
          else if (box.length > 0 && /^(\+|├)/u.test(row)) {
            box.push(visibleWidth(row));
            expect(new Set(box).size, `@ ${columns}: ${box.join(",")}`).toBe(1);
            box = [];
          }
        }
      }
    }
  });

  it("counts the checks that need a look, and says so in the warning colour", async () => {
    const { plain, lines } = await run();
    expect(plain.trimEnd().split("\n").at(-1)).toBe("└  1건 확인 필요 ▲");
    expect(lines.at(-1)).toContain("\u001b[");
  });
});

describe("runDoctor in English", () => {
  afterEach(() => setLanguage("ko"));

  it("prints the checks and the summary in English", async () => {
    setLanguage("en");
    const { plain } = await run();
    expect(plain).toContain("Terminal check");
    expect(plain).toContain("Color: true color (COLORTERM)");
    expect(plain).toContain("No settings file (using defaults)");
    expect(plain).toMatch(/\d+\/\d+ checks passed|need attention/u);
    expect(plain).not.toMatch(/[가-힣]/u);
  });
});
