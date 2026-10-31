import { describe, expect, it } from "vite-plus/test";

import { type KeyEvent, KeyParser } from "./keys.ts";

const names = (events: ReadonlyArray<KeyEvent>) =>
  events.map((event) => (event.type === "key" ? event.name : event.type));

describe("KeyParser", () => {
  it("decodes a Hangul syllable split across chunks", () => {
    const parser = new KeyParser();
    const bytes = Buffer.from("한");
    expect(parser.feed(bytes.subarray(0, 1))).toEqual([]);
    expect(parser.feed(bytes.subarray(1, 2))).toEqual([]);
    expect(parser.feed(bytes.subarray(2))).toEqual([{ type: "text", text: "한" }]);
  });

  it("keeps typed text together and separates control keys", () => {
    const parser = new KeyParser();
    const events = parser.feed("안녕\r\u007f");
    expect(events).toEqual([
      { type: "text", text: "안녕" },
      { type: "key", name: "enter", ctrl: false, alt: false, shift: false },
      { type: "key", name: "backspace", ctrl: false, alt: false, shift: false },
    ]);
  });

  it("parses arrows, home/end and modified arrows", () => {
    const parser = new KeyParser();
    expect(names(parser.feed("\u001b[A\u001b[B\u001b[C\u001b[D\u001b[H\u001b[F\u001b[3~"))).toEqual(
      ["up", "down", "right", "left", "home", "end", "delete"],
    );
    const [ctrlLeft] = parser.feed("\u001b[1;5D");
    expect(ctrlLeft).toMatchObject({ name: "left", ctrl: true, alt: false });
  });

  it("reads PageUp and PageDown with and without Shift as the same keys", () => {
    // macOS Terminal.app may only send the Shift form to a program on the alternate screen.
    const parser = new KeyParser();
    expect(parser.feed("\u001b[5~\u001b[6~\u001b[5;2~\u001b[6;2~")).toEqual([
      { type: "key", name: "pageup", ctrl: false, alt: false, shift: false },
      { type: "key", name: "pagedown", ctrl: false, alt: false, shift: false },
      { type: "key", name: "pageup", ctrl: false, alt: false, shift: true },
      { type: "key", name: "pagedown", ctrl: false, alt: false, shift: true },
    ]);
  });

  it("holds an escape sequence split across chunks until it is complete", () => {
    const parser = new KeyParser();
    expect(parser.feed("\u001b")).toEqual([]);
    expect(parser.hasPending()).toBe(true);
    expect(names(parser.feed("[A"))).toEqual(["up"]);
    expect(parser.hasPending()).toBe(false);
  });

  it("resolves a lone Escape only when flushed", () => {
    const parser = new KeyParser();
    expect(parser.feed("\u001b")).toEqual([]);
    expect(names(parser.flush())).toEqual(["escape"]);
  });

  it("delivers a bracketed paste as one event, even when split and containing newlines", () => {
    const parser = new KeyParser();
    expect(parser.feed("\u001b[200~첫 줄\n두")).toEqual([]);
    expect(parser.feed("번째 줄\u001b[201~")).toEqual([
      { type: "paste", text: "첫 줄\n두번째 줄" },
    ]);
    expect(names(parser.feed("\r"))).toEqual(["enter"]);
  });

  it("treats CRLF as a single Enter and a lone LF as a newline key", () => {
    const parser = new KeyParser();
    expect(names(parser.feed("\r\n"))).toEqual(["enter"]);
    expect(names(parser.feed("\n"))).toEqual(["newline"]);
  });

  it("maps modified Enter from kitty and modifyOtherKeys terminals to a newline", () => {
    const parser = new KeyParser();
    expect(names(parser.feed("\u001b[13;2u"))).toEqual(["newline"]);
    expect(names(parser.feed("\u001b[13u"))).toEqual(["enter"]);
    expect(names(parser.feed("\u001b[27;2;13~"))).toEqual(["enter"]);
  });

  it("reports control letters and does not type unbound Alt combinations", () => {
    const parser = new KeyParser();
    expect(parser.feed("\u0003\u0001")).toEqual([
      { type: "ctrl", letter: "c" },
      { type: "ctrl", letter: "a" },
    ]);
    expect(parser.feed("\u001bx")).toEqual([]);
  });

  it("reads Alt-b and Alt-f as word movement", () => {
    const parser = new KeyParser();
    const events = parser.feed("\u001bb\u001bf");
    expect(events[0]).toMatchObject({ name: "left", alt: true });
    expect(events[1]).toMatchObject({ name: "right", alt: true });
  });
  it("waits for a paste end marker that arrives in pieces", () => {
    const parser = new KeyParser();
    expect(parser.feed("\u001b[200~hello\u001b[20")).toEqual([]);
    expect(parser.feed("1~")).toEqual([{ type: "paste", text: "hello" }]);
    expect(parser.feed("a")).toEqual([{ type: "text", text: "a" }]);
  });

  it("finds the paste end however the marker is cut", () => {
    const end = "\u001b[201~";
    for (let cut = 1; cut < end.length; cut += 1) {
      const parser = new KeyParser();
      expect(parser.feed(`\u001b[200~가나${end.slice(0, cut)}`)).toEqual([]);
      expect(parser.feed(end.slice(cut))).toEqual([{ type: "paste", text: "가나" }]);
    }
  });

  it("keeps escape bytes that are really pasted text", () => {
    const parser = new KeyParser();
    expect(parser.feed("\u001b[200~a\u001b[2")).toEqual([]);
    expect(parser.feed("Jb\u001b[201~")).toEqual([{ type: "paste", text: "a\u001b[2Jb" }]);
  });

  it("does not drop a held-back marker prefix when the flush timer fires", () => {
    const parser = new KeyParser();
    parser.feed("\u001b[200~x\u001b[20");
    expect(parser.flush()).toEqual([]);
    expect(parser.feed("1~")).toEqual([{ type: "paste", text: "x" }]);
  });
});
