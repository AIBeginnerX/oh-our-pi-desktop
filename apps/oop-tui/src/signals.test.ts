import * as NodeEvents from "node:events";

import { describe, expect, it, vi } from "vite-plus/test";

import { debounced, signalsFor, watchSignals } from "./signals.ts";

describe("watchSignals", () => {
  const setup = (platform: NodeJS.Platform = "darwin") => {
    const proc = new NodeEvents.EventEmitter();
    const exits: number[] = [];
    let resumed = 0;
    const stop = watchSignals(
      proc,
      { exit: (code) => exits.push(code), resume: () => void (resumed += 1) },
      platform,
    );
    return { proc, exits, resumed: () => resumed, stop };
  };

  it("leaves with the conventional exit code for each terminating signal", () => {
    const { proc, exits } = setup();
    proc.emit("SIGINT");
    proc.emit("SIGQUIT");
    proc.emit("SIGTERM");
    proc.emit("SIGHUP");
    expect(exits).toEqual([130, 131, 143, 129]);
  });

  it("re-enters the terminal on SIGCONT", () => {
    const { proc, resumed } = setup();
    proc.emit("SIGCONT");
    expect(resumed()).toBe(1);
  });

  it("stops listening when asked", () => {
    const { proc, exits, stop } = setup();
    stop();
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGCONT")).toBe(0);
    expect(exits).toEqual([]);
  });

  it("only registers signals Windows has", () => {
    expect(signalsFor("win32")).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    expect(signalsFor("linux")).toContain("SIGQUIT");
    expect(signalsFor("linux")).toContain("SIGCONT");
  });
});

describe("debounced", () => {
  it("runs once, after the last call of a burst", () => {
    vi.useFakeTimers();
    try {
      const calls: number[] = [];
      const run = debounced(100, () => calls.push(1));
      run();
      vi.advanceTimersByTime(60);
      run();
      vi.advanceTimersByTime(60);
      expect(calls).toEqual([]);
      vi.advanceTimersByTime(60);
      expect(calls).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can be cancelled", () => {
    vi.useFakeTimers();
    try {
      const calls: number[] = [];
      const run = debounced(100, () => calls.push(1));
      run();
      run.cancel();
      vi.advanceTimersByTime(500);
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
