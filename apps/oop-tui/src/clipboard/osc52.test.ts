import { describe, expect, it } from "vite-plus/test";

import { OSC52_MAX_BASE64, osc52Sequence } from "./osc52.ts";

describe("osc52Sequence", () => {
  it("is ESC ] 52 ; c ; base64 BEL, with the text as UTF-8", () => {
    expect(osc52Sequence("hello")).toBe("\u001b]52;c;aGVsbG8=\u0007");
    const korean = osc52Sequence("안녕") as string;
    const payload = korean.slice("\u001b]52;c;".length, -1);
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe("안녕");
  });

  it("is wrapped for tmux, with every ESC doubled, so it passes through to the terminal", () => {
    expect(osc52Sequence("hi", { tmux: true })).toBe(
      "\u001bPtmux;\u001b\u001b]52;c;aGk=\u0007\u001b\\",
    );
  });

  it("is refused above the limit, so a huge selection never floods the terminal", () => {
    const atLimit = "a".repeat((OSC52_MAX_BASE64 / 4) * 3);
    expect(osc52Sequence(atLimit)).not.toBeNull();
    expect(osc52Sequence(`${atLimit}a`)).toBeNull();
    expect(osc52Sequence("abcdef", { maxBase64: 4 })).toBeNull();
  });
});
