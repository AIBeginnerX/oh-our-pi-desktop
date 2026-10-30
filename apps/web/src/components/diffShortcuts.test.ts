import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveShortcutCommand } from "../keybindings";
import { resolveDiffShortcut } from "./diffShortcuts";

class TestElement extends EventTarget {
  constructor(
    readonly tagName: string,
    readonly isContentEditable = false,
    private readonly insideMenu = false,
  ) {
    super();
  }

  closest() {
    return this.insideMenu ? this : null;
  }
}

const key = (value: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}) => ({
  key: value,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

afterEach(() => vi.unstubAllGlobals());

describe("diff review shortcuts", () => {
  function stubBrowser() {
    vi.stubGlobal("HTMLElement", TestElement);
    vi.stubGlobal("navigator", { platform: "Linux" });
  }

  it("maps the default keys to next, previous and viewed", () => {
    stubBrowser();
    const body = new TestElement("DIV");
    expect(resolveDiffShortcut(key("]"), body, DEFAULT_RESOLVED_KEYBINDINGS)).toBe("diff.nextFile");
    expect(resolveDiffShortcut(key("["), body, DEFAULT_RESOLVED_KEYBINDINGS)).toBe(
      "diff.previousFile",
    );
    expect(resolveDiffShortcut(key("v"), body, DEFAULT_RESOLVED_KEYBINDINGS)).toBe(
      "diff.toggleViewed",
    );
  });

  it("does not take the keys while the reader types or a menu is open", () => {
    stubBrowser();
    for (const target of [
      new TestElement("INPUT"),
      new TestElement("TEXTAREA"),
      new TestElement("DIV", true),
      new TestElement("DIV", false, true),
    ]) {
      expect(resolveDiffShortcut(key("v"), target, DEFAULT_RESOLVED_KEYBINDINGS)).toBeNull();
    }
  });

  it("leaves chords with modifiers, such as page navigation, alone", () => {
    stubBrowser();
    expect(
      resolveDiffShortcut(key("[", { metaKey: true }), null, DEFAULT_RESOLVED_KEYBINDINGS),
    ).toBeNull();
  });

  it("is inert for the app-wide shortcut handlers, which never set the diff context", () => {
    vi.stubGlobal("navigator", { platform: "Linux" });
    for (const value of ["]", "[", "v"]) {
      expect(resolveShortcutCommand(key(value), DEFAULT_RESOLVED_KEYBINDINGS)).toBeNull();
    }
  });
});
