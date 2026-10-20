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
});
