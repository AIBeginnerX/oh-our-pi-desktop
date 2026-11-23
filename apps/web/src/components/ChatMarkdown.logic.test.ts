import { describe, expect, it } from "vite-plus/test";
import { fileLinkContextMention } from "./ChatMarkdown.logic";

describe("fileLinkContextMention", () => {
  it.each([
    ["/repo/src/main.ts", "[main.ts](src/main.ts)"],
    ["/repo/src/main.ts:12", "[main.ts](src/main.ts)"],
    ["/elsewhere/main.ts", null],
    ["/repo-other/main.ts", null],
    ["/repo/../outside.ts", null],
    ["/repo", null],
  ])("converts only workspace files: %s", (path, expected) => {
    expect(fileLinkContextMention(path, "/repo")).toBe(expected);
  });

  it("serializes paths with spaces as a single mention", () => {
    expect(fileLinkContextMention("/repo/src/my file.ts:12", "/repo")).toBe(
      "[my file.ts](src/my%20file.ts)",
    );
  });

  it("requires a workspace", () => {
    expect(fileLinkContextMention("/repo/main.ts", undefined)).toBeNull();
  });
});
