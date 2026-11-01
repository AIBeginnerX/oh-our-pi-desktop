import * as NodeStringDecoder from "node:string_decoder";

export type KeyName =
  | "enter"
  | "newline"
  | "tab"
  | "backtab"
  | "escape"
  | "backspace"
  | "delete"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown";

export type KeyEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "paste"; readonly text: string }
  | {
      readonly type: "key";
      readonly name: KeyName;
      readonly ctrl: boolean;
      readonly alt: boolean;
      readonly shift: boolean;
    }
  | { readonly type: "ctrl"; readonly letter: string }
  /** The terminal window gained or lost focus (needs focus reporting, `ESC [ ? 1004 h`). */
  | { readonly type: "focus"; readonly focused: boolean }
  /** A mouse report (SGR 1006, `ESC [ ? 1000 h` + `ESC [ ? 1006 h`); `x` and `y` count from 1. */
  | {
      readonly type: "mouse";
      readonly action: MouseAction;
      readonly x: number;
      readonly y: number;
    };

export type MouseAction = "wheelUp" | "wheelDown" | "press" | "release" | "drag";

/**
 * `ESC [ < b ; x ; y M|m`: the button code carries the wheel (64, 65), motion (32) and the
 * modifiers (4, 8, 16), which are not told apart here. Other wheels (66, 67: sideways) are dropped.
 */
const parseSgrMouse = (params: string, final: string): KeyEvent | null => {
  const match = /^<(\d+);(\d+);(\d+)$/u.exec(params);
  if (match === null) return null;
  const code = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const base = code & ~(4 | 8 | 16);
  if (base === 64) return { type: "mouse", action: "wheelUp", x, y };
  if (base === 65) return { type: "mouse", action: "wheelDown", x, y };
  if (base >= 66 && base < 128) return null;
  if ((base & 32) !== 0) return { type: "mouse", action: "drag", x, y };
  return { type: "mouse", action: final === "M" ? "press" : "release", x, y };
};

const key = (
  name: KeyName,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): KeyEvent => ({
  type: "key",
  name,
  ctrl: mods.ctrl ?? false,
  alt: mods.alt ?? false,
  shift: mods.shift ?? false,
});

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

const CSI_FINAL: Record<string, KeyName> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "backtab",
};

const TILDE_KEYS: Record<string, KeyName> = {
  "1": "home",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
};

/** Length of the longest proper prefix of `marker` that `value` ends with. */
const markerPrefixLength = (value: string, marker: string): number => {
  for (let length = Math.min(marker.length - 1, value.length); length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
};

/** CSI parameter 2 encodes modifiers as 1 + (shift 1, alt 2, ctrl 4). */
const decodeModifiers = (param: number) => {
  const bits = Math.max(0, param - 1);
  return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
};

/**
 * Turns raw stdin bytes into key events. Input arrives in arbitrary chunks: a UTF-8 character or an
 * escape sequence can be split, so incomplete tails are held back until the next chunk (or
 * `flush`, which the caller schedules for a lone Escape). Only committed text reaches this parser;
 * an input method composes Hangul inside the terminal and sends the finished syllables.
 */
export class KeyParser {
  private readonly decoder = new NodeStringDecoder.StringDecoder("utf8");
  private pending = "";
  private pasteBuffer: string | null = null;

  feed(chunk: Buffer | string): KeyEvent[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.pending += text;
    return this.drain(false);
  }

  /** Resolves a held-back lone Escape or incomplete sequence. */
  flush(): KeyEvent[] {
    return this.drain(true);
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  private drain(force: boolean): KeyEvent[] {
    const events: KeyEvent[] = [];
    const input = this.pending;
    this.pending = "";
    let index = 0;

    while (index < input.length) {
      if (this.pasteBuffer !== null) {
        const end = input.indexOf(PASTE_END, index);
        if (end === -1) {
          // The end marker may be cut by the chunk boundary, so a trailing prefix of it waits.
          const rest = input.slice(index);
          const held = markerPrefixLength(rest, PASTE_END);
          this.pasteBuffer += rest.slice(0, rest.length - held);
          this.pending = rest.slice(rest.length - held);
          return events;
        }
        const pasted = this.pasteBuffer + input.slice(index, end);
        this.pasteBuffer = null;
        events.push({ type: "paste", text: pasted });
        index = end + PASTE_END.length;
        continue;
      }

      const ch = input[index] as string;
      if (ch === "\u001b") {
        const rest = input.slice(index);
        if (rest.startsWith(PASTE_START)) {
          this.pasteBuffer = "";
          index += PASTE_START.length;
          continue;
        }
        const parsed = this.parseEscape(rest, force);
        if (parsed === "incomplete") {
          this.pending = rest;
          return events;
        }
        events.push(...parsed.events);
        index += parsed.length;
        continue;
      }

      if (ch === "\r") {
        // CRLF from a pasted block without bracketed paste counts as one Enter.
        if (input[index + 1] === "\n") index += 1;
        events.push(key("enter"));
        index += 1;
        continue;
      }
      if (ch === "\n") {
        events.push(key("newline"));
        index += 1;
        continue;
      }
      if (ch === "\t") {
        events.push(key("tab"));
        index += 1;
        continue;
      }
      if (ch === "\u007f" || ch === "\b") {
        events.push(key("backspace"));
        index += 1;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        events.push({ type: "ctrl", letter: String.fromCharCode(code + 0x60) });
        index += 1;
        continue;
      }

      let end = index;
      while (end < input.length) {
        const c = input.charCodeAt(end);
        if (c < 0x20 || c === 0x7f) break;
        end += 1;
      }
      events.push({ type: "text", text: input.slice(index, end) });
      index = end;
    }

    return events;
  }

  private parseEscape(
    rest: string,
    force: boolean,
  ): { events: KeyEvent[]; length: number } | "incomplete" {
    if (rest.length === 1) {
      return force ? { events: [key("escape")], length: 1 } : "incomplete";
    }
    const next = rest[1] as string;

    if (next === "[") {
      // CSI: parameters (0x30-0x3f), intermediates (0x20-0x2f), final (0x40-0x7e).
      let end = 2;
      while (end < rest.length && rest.charCodeAt(end) >= 0x30 && rest.charCodeAt(end) <= 0x3f) {
        end += 1;
      }
      while (end < rest.length && rest.charCodeAt(end) >= 0x20 && rest.charCodeAt(end) <= 0x2f) {
        end += 1;
      }
      if (end >= rest.length) {
        return force ? { events: [], length: rest.length } : "incomplete";
      }
      const final = rest[end] as string;
      const params = rest.slice(2, end).split(";");
      const length = end + 1;
      const first = Number.parseInt(params[0] ?? "", 10);
      const second = Number.parseInt(params[1] ?? "", 10);
      const mods = Number.isNaN(second) ? {} : decodeModifiers(second);

      if ((final === "M" || final === "m") && rest[2] === "<") {
        const mouse = parseSgrMouse(rest.slice(2, end), final);
        return { events: mouse === null ? [] : [mouse], length };
      }
      const named = CSI_FINAL[final];
      if (named !== undefined) {
        return { events: [key(named, mods)], length };
      }
      if ((final === "I" || final === "O") && end === 2) {
        return { events: [{ type: "focus", focused: final === "I" }], length };
      }
      if (final === "~") {
        const tilde = TILDE_KEYS[String(first)];
        if (tilde !== undefined) return { events: [key(tilde, mods)], length };
        // xterm modifyOtherKeys: ESC [ 27 ; mod ; code ~
        if (first === 27 && params.length === 3) {
          const code = Number.parseInt(params[2] ?? "", 10);
          if (code === 13) return { events: [key("enter", decodeModifiers(second))], length };
        }
        return { events: [], length };
      }
      if (final === "u") {
        // kitty / CSI-u: ESC [ code ; mod u
        if (first === 13) {
          const decoded = decodeModifiers(Number.isNaN(second) ? 1 : second);
          return {
            events: [key(decoded.shift || decoded.alt || decoded.ctrl ? "newline" : "enter")],
            length,
          };
        }
        if (first === 27) return { events: [key("escape")], length };
        if (first === 127) return { events: [key("backspace")], length };
        return { events: [], length };
      }
      return { events: [], length };
    }

    if (next === "O") {
      if (rest.length < 3) return force ? { events: [], length: 2 } : "incomplete";
      const named = CSI_FINAL[rest[2] as string];
      return { events: named ? [key(named)] : [], length: 3 };
    }

    if (next === "\r") return { events: [key("newline")], length: 2 };
    if (next === "\u007f") return { events: [key("backspace", { alt: true })], length: 2 };
    if (next === "b") return { events: [key("left", { alt: true })], length: 2 };
    if (next === "f") return { events: [key("right", { alt: true })], length: 2 };
    if (next === "d") return { events: [key("delete", { alt: true })], length: 2 };
    if (next === "\u001b") return { events: [key("escape")], length: 1 };
    // Alt + printable: not bound; swallow the pair so it is not typed into the buffer.
    return { events: [], length: 2 };
  }
}
