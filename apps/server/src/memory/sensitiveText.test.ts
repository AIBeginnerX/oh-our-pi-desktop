import { describe, expect, it } from "@effect/vitest";

import { looksLikeSensitiveText } from "./sensitiveText.ts";

describe("looksLikeSensitiveText", () => {
  it("rejects well-known token shapes", () => {
    const fixtures = [
      "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg",
      "aws key AKIAIOSFODNN7EXAMPLE in notes",
      "token ghp_abcdefghij0123456789abcd",
      "github_pat_11ABCDEFGH0ijklmnopqrstuvwxyz0123456789AB",
      "key sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaa",
      "sk-abcdefghijklmnopqrstuvwxyz012345",
      "xoxb-1234567890-abcdefghijkl",
      "AIzaSyD4iE2x8SpqT0k9jH3uN5vF7bM1cX6wZaB",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PLf",
      'api_key = "sk_live_4eC39HqLyjWDarjtT1zdp7dc"',
      "secret: abcd1234efgh5678ijkl90mn",
    ];
    for (const fixture of fixtures) {
      expect(looksLikeSensitiveText(fixture)).toBe(true);
    }
  });

  it("accepts ordinary prose and code-shaped text", () => {
    const fixtures = [
      "프로젝트는 React 19 기반으로 마이그레이션했다",
      "remember to run vp test before pushing",
      "token bucket rate limiting design notes",
      "the secret to good diffs is small commits",
      "API keys are stored in the OS keychain",
      "password policy: 12 chars minimum",
      "sk- short fragment",
      "AKIA too short",
    ];
    for (const fixture of fixtures) {
      expect(looksLikeSensitiveText(fixture)).toBe(false);
    }
  });

  it("rejects secrets assigned to suffixed or shorter-valued key names", () => {
    const fixtures = [
      "SECRET_KEY=django-insecure-a1b2c3d4e5",
      ["aws_secret", "access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY"].join("_"),
      'DB_PASSWORD="hunter2hunter2"',
      "password: hunter2hunter2",
      '{"client_secret": "aaaabbbbcccc"}',
      "x-api-key: 8f14e45fceea167a",
      "GITHUB_TOKEN=abc12345",
    ];
    for (const fixture of fixtures) {
      expect(looksLikeSensitiveText(fixture), fixture).toBe(true);
    }
  });

  it("rejects vendor token shapes beyond the original set", () => {
    const fixtures = [
      ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"),
      ["sk", "test", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"),
      ["rk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"),
      ["npm", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_"),
      ["hf", "abcdefghijklmnopqrstuvwxyzABCDEFGH"].join("_"),
      "bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw9",
      "Authorization: Bearer 3f9a8c7d6e5b4a3f2e1d0c9b8a7f",
      ["curl -H 'Authorization: Bearer", "abcdefghijklmnop1234'"].join(" "),
    ];
    for (const fixture of fixtures) {
      expect(looksLikeSensitiveText(fixture), fixture).toBe(true);
    }
  });

  it("rejects credentials embedded in URLs", () => {
    const fixtures = [
      "postgres://user:pass@localhost:5432/db",
      "https://octocat:ghx9Zk2@github.com/org/repo.git",
    ];
    for (const fixture of fixtures) {
      expect(looksLikeSensitiveText(fixture), fixture).toBe(true);
    }
  });

  it("rejects Korean credential statements", () => {
    const fixtures = [
      "비밀번호는 abc12345",
      "비번: Xy7!pq93",
      "토큰: a1b2c3d4e5f6",
      "DB 패스워드는 `qwer1234!`",
    ];
    for (const fixture of fixtures) {
      expect(looksLikeSensitiveText(fixture), fixture).toBe(true);
    }
  });

  it("does not flag prose, identifiers, or placeholders around credential words", () => {
    const fixtures = [
      "the token count is high",
      "password reset flow needs a redesign",
      "const tokenCount = 12345678;",
      "tokenCount: 123456789",
      "max_token_limit = 100000000",
      "password: <your-password>",
      "api_key = <your-key>",
      "SECRET_KEY=***",
      "password: ********",
      "token = xxxxxxxxxx",
      "SECRET=${SECRET_VALUE}",
      'password = "${DB_PASSWORD}"',
      "token = process.env.GITHUB_TOKEN",
      "password = config.dbPassword",
      "const password = getPassword();",
      "password: passwordInput",
      "secret:",
      "token_url = https://example.com/oauth/token",
      "비밀번호 재설정 흐름을 개선한다",
      "토큰 사용량이 1234567890개 늘었다",
      "비번은 변경해야 한다",
      "https://github.com/org/repo",
      "postgres://localhost:5432/db",
      "meeting at 12:30 with Authorization: Bearer token docs",
      "Bearer token authentication design notes",
    ];
    for (const fixture of fixtures) {
      expect(looksLikeSensitiveText(fixture), fixture).toBe(false);
    }
  });

  it("stays fast on adversarial long inputs", () => {
    const inputs = [
      `${"a-".repeat(5000)}secret`,
      `token${"=".repeat(5000)}`,
      `password: ${"a".repeat(20000)}`,
      `password: ${"A1".repeat(20000)}(`,
      `${"비번 ".repeat(5000)}`,
    ];
    const start = performance.now();
    for (const input of inputs) looksLikeSensitiveText(input);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
