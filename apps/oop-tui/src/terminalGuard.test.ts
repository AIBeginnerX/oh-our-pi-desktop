import * as NodeEvents from "node:events";

import { describe, expect, it } from "vite-plus/test";

import { guardTerminal } from "./terminalGuard.ts";

const setup = () => {
  const proc = Object.assign(new NodeEvents.EventEmitter(), {
    exit: (code: number) => {
      exits.push(code);
      // What the real process does on the way out.
      proc.emit("exit");
    },
  });
  const exits: number[] = [];
  const written: string[] = [];
  const raw: boolean[] = [];
  const stop = guardTerminal(
    { process: proc, write: (text) => written.push(text), setRawMode: (mode) => raw.push(mode) },
    "darwin",
    { on: "<paste-on>", off: "<paste-off>" },
  );
  return { proc, exits, written, raw, stop };
};

describe("guardTerminal", () => {
  it("turns bracketed paste off and raw mode off when a signal ends the process", () => {
    for (const [signal, code] of [
      ["SIGTERM", 143],
      ["SIGHUP", 129],
      ["SIGINT", 130],
    ] as const) {
      const t = setup();
      t.proc.emit(signal);
      expect(t.exits).toEqual([code]);
      expect(t.written).toEqual(["<paste-off>"]);
      expect(t.raw).toEqual([false]);
    }
  });

  it("puts the modes back after Ctrl-Z and fg", () => {
    const t = setup();
    t.proc.emit("SIGCONT");
    expect(t.raw).toEqual([true]);
    expect(t.written).toEqual(["<paste-on>"]);
  });

  it("is gone once the screen ended by itself: nothing is written for a later exit", () => {
    const t = setup();
    t.stop();
    expect(t.proc.listenerCount("SIGTERM")).toBe(0);
    expect(t.proc.listenerCount("exit")).toBe(0);
    t.proc.emit("exit");
    expect(t.written).toEqual([]);
  });
});
