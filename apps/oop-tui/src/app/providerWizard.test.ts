import { describe, expect, it } from "vite-plus/test";

import type { KeyEvent } from "../input/keys.ts";
import type { RegionFrame } from "../render/liveRegion.ts";
import { makeStyle } from "../render/style.ts";
import { UNICODE_SYMBOLS } from "../render/symbols.ts";
import { stripAnsi } from "../text/width.ts";
import { key, SECRET, text } from "../testing/providerFixtures.ts";
import { openDraftView, openPickView, type ProviderContext } from "./providerScreen.ts";
import { newDraft, parseTarget, withId } from "./providerSpec.ts";
import { runAddWizard } from "./providerWizard.ts";

const context: ProviderContext = {
  taken: new Set(["codex_work"]),
  rows: [],
  checkRemove: () => ({ ok: false, reason: "-" }),
};

const terminal = () => {
  const frames: string[] = [];
  let clears = 0;
  let listener: ((event: KeyEvent) => void) | null = null;
  let onResize: (() => void) | null = null;
  return {
    frames,
    clears: () => clears,
    send: (...events: KeyEvent[]) => events.forEach((event) => listener?.(event)),
    resize: () => onResize?.(),
    listening: () => listener !== null,
    terminal: {
      region: {
        set: (frame: RegionFrame) => void frames.push(frame.lines.map(stripAnsi).join("\n")),
        clear: () => void (clears += 1),
      },
      columns: () => 60,
      rows: () => 24,
      keys: (next: (event: KeyEvent) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      resized: (next: () => void) => {
        onResize = next;
        return () => {
          onResize = null;
        };
      },
    },
  };
};

const start = (t: ReturnType<typeof terminal>, view = openPickView()) =>
  runAddWizard({
    terminal: t.terminal,
    style: makeStyle(false),
    symbols: UNICODE_SYMBOLS,
    context,
    start: view,
  });

describe("runAddWizard", () => {
  it("draws once at the start and then only after a key or a resize", async () => {
    const t = terminal();
    const result = start(t);
    expect(t.frames).toHaveLength(1);
    t.send(key("down"));
    expect(t.frames).toHaveLength(2);
    t.resize();
    expect(t.frames).toHaveLength(3);
    t.send(key("escape"));
    expect(await result).toBeNull();
  });

  it("walks from the list of kinds to a confirmed draft, with the secret never on screen", async () => {
    const t = terminal();
    const result = start(t);
    // Z.AI is the ninth kind.
    t.send(text("9"), key("enter"));
    // The form starts on the key, the one thing the preset cannot do without.
    expect(t.frames.at(-1)).toContain("API 키");
    t.send(key("enter"), text(SECRET), key("enter"));
    t.send(...Array.from({ length: 4 }, () => key("down")), key("enter"));
    expect(t.frames.at(-1)).toContain("추가할까요?");
    t.send(key("enter"));
    const draft = await result;
    expect(draft).toMatchObject({ id: "opencode_zai", values: { apiKey: SECRET } });
    expect(t.frames.join("\n")).not.toContain(SECRET);
    expect(t.clears()).toBe(1);
    expect(t.listening()).toBe(false);
  });

  it("starts at the form for a draft it was given", async () => {
    const t = terminal();
    const result = start(
      t,
      openDraftView(withId(newDraft(parseTarget("codex")!), "codex_x"), context),
    );
    expect(t.frames[0]).toContain("추가할까요?");
    t.send({ type: "ctrl", letter: "c" });
    expect(await result).toBeNull();
    expect(t.clears()).toBe(1);
  });

  it("shows why a step was refused and clears it on the next key", async () => {
    const t = terminal();
    const result = start(t, openDraftView(newDraft(parseTarget("codex")!), context));
    t.send(key("enter"), text("codex_work"), key("enter"));
    expect(t.frames.at(-1)).toContain("이미 있는");
    t.send(key("escape"));
    expect(t.frames.at(-1)).not.toContain("이미 있는");
    t.send({ type: "ctrl", letter: "c" });
    await result;
  });
});
