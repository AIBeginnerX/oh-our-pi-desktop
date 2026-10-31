import { describe, expect, it } from "vite-plus/test";

import { pairFailureMessage, resolvePairTarget } from "./pair.ts";
import { TransportError } from "./transport.ts";

describe("resolvePairTarget", () => {
  it("reads the server and token out of a pairing link", () => {
    expect(resolvePairTarget("http://127.0.0.1:3773/pair#token=abc123", null)).toEqual({
      credential: "abc123",
      httpBaseUrl: "http://127.0.0.1:3773/",
    });
  });

  it("takes the token out of a link to the desktop app's own window", () => {
    expect(resolvePairTarget("t3code://app/pair#token=abc123", "http://127.0.0.1:3773")).toEqual({
      credential: "abc123",
      httpBaseUrl: "http://127.0.0.1:3773/",
    });
  });

  it("asks for the server when a desktop window link has no address to go with it", () => {
    expect(() => resolvePairTarget("t3code://app/pair#token=abc123", null)).toThrow(
      "서버를 알 수 없습니다",
    );
  });

  it("accepts a bare token when the server address is known", () => {
    expect(resolvePairTarget("abc123", "http://127.0.0.1:3773")).toEqual({
      credential: "abc123",
      httpBaseUrl: "http://127.0.0.1:3773/",
    });
  });

  it("explains in Korean what is missing instead of guessing a server", () => {
    expect(() => resolvePairTarget("abc123", null)).toThrow("서버를 알 수 없습니다");
    expect(() => resolvePairTarget("   ", null)).toThrow("입력하세요");
  });

  it("rejects a link that carries no token", () => {
    expect(() => resolvePairTarget("http://127.0.0.1:3773/pair", null)).toThrow();
  });
});

describe("pairFailureMessage", () => {
  it("tells a refused link to be replaced by a new one", () => {
    const message = pairFailureMessage(new TransportError("blocked", "거절됨", "authentication"));
    expect(message).toContain("페어링에 실패했습니다: 거절됨");
    expect(message).toContain("새 링크를 만들어 다시 시도하세요");
  });

  it("tells a protocol mismatch to update, since a new link would not help", () => {
    const message = pairFailureMessage(
      new TransportError("blocked", "newer server", "unsupported"),
    );
    expect(message).toContain("앱이나 oop 을 업데이트하세요");
    expect(message).not.toContain("새 링크");
  });

  it("asks for a new link with more rights when the link's scopes are refused", () => {
    const message = pairFailureMessage(new TransportError("blocked", "x", "configuration"));
    expect(message).toContain("읽기 전용이 아닌 새 링크");
  });

  it("gives no advice for a cause it was not told, or a failure that is not a refusal", () => {
    for (const cause of [
      new TransportError("blocked", "x"),
      new TransportError("transient", "x"),
      new Error("x"),
    ]) {
      expect(pairFailureMessage(cause)).toBe("페어링에 실패했습니다: x");
    }
  });
});
