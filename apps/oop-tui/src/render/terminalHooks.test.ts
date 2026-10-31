import { describe, expect, it } from "vite-plus/test";

import { createTerminalHooks } from "./terminalHooks.ts";

const hooks = (colorLevel: number, term: string | undefined) => {
  const written: string[] = [];
  return {
    written,
    ...createTerminalHooks((text) => void written.push(text), { colorLevel, term }),
  };
};

describe("createTerminalHooks", () => {
  it("sets the window title with OSC 0 and rings the bell", () => {
    const h = hooks(3, "xterm-256color");
    h.setTitle("◆ OOP · 스레드");
    h.bell();
    expect(h.written).toEqual(["\u001b[22;0t", "\u001b]0;◆ OOP · 스레드\u0007", "\u0007"]);
  });

  it("saves the shell's title once before the first, and restores it at exit", () => {
    const h = hooks(3, "xterm-256color");
    h.restoreTitle();
    expect(h.written).toEqual([]);
    h.setTitle("a");
    h.setTitle("b");
    h.restoreTitle();
    expect(h.written).toEqual([
      "\u001b[22;0t",
      "\u001b]0;a\u0007",
      "\u001b]0;b\u0007",
      "\u001b]0;\u0007\u001b[23;0t",
    ]);
    h.restoreTitle();
    expect(h.written).toHaveLength(4);
  });

  it("cannot be talked into a second escape sequence by the title", () => {
    const h = hooks(3, "xterm");
    h.setTitle("a\u001b]52;c;QUFB\u0007b\u001b[2Jc\nd");
    const sent = h.written.find((text) => text.startsWith("\u001b]0;"));
    expect(sent?.startsWith("\u001b]0;")).toBe(true);
    expect(sent?.endsWith("\u0007")).toBe(true);
    const body = (sent ?? "").slice(4, -1);
    expect(body).not.toMatch(/\p{Cc}/u);
  });

  it("sends no title, nor a title stack push or pop, without colour or on a dumb terminal", () => {
    for (const h of [hooks(0, "xterm"), hooks(3, "dumb")]) {
      h.setTitle("OOP");
      h.restoreTitle();
      expect(h.written).toEqual([]);
    }
  });

  it("rings the bell without colour, but not on a dumb terminal", () => {
    const plain = hooks(0, "xterm");
    plain.bell();
    expect(plain.written).toEqual(["\u0007"]);
    const dumb = hooks(3, "dumb");
    dumb.bell();
    expect(dumb.written).toEqual([]);
  });
});
