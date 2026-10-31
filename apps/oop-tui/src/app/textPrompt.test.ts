import { describe, expect, it } from "vite-plus/test";

import { editorText, editorFromText, emptyEditor } from "../input/editor.ts";
import type { KeyEvent } from "../input/keys.ts";
import { editPromptText, editSecretText, maskEditor } from "./textPrompt.ts";

const key = (
  name: Extract<KeyEvent, { type: "key" }>["name"],
  over: { ctrl?: boolean; alt?: boolean } = {},
): KeyEvent => ({
  type: "key",
  name,
  ctrl: over.ctrl ?? false,
  alt: over.alt ?? false,
  shift: false,
});

describe("editPromptText", () => {
  it("types, pastes Korean, and deletes by letter and by word", () => {
    let editor = editPromptText(emptyEditor, { type: "text", text: "테스트 통과" });
    editor = editPromptText(editor, { type: "paste", text: " 시키기" });
    expect(editorText(editor)).toBe("테스트 통과 시키기");
    editor = editPromptText(editor, key("backspace"));
    expect(editorText(editor)).toBe("테스트 통과 시키");
    editor = editPromptText(editor, key("backspace", { alt: true }));
    expect(editorText(editor)).toBe("테스트 통과 ");
  });

  it("moves and edits in the middle with the line keys", () => {
    let editor = editorFromText("abc def");
    editor = editPromptText(editor, { type: "ctrl", letter: "a" });
    editor = editPromptText(editor, { type: "text", text: ">" });
    expect(editorText(editor)).toBe(">abc def");
    editor = editPromptText(editor, { type: "ctrl", letter: "k" });
    expect(editorText(editor)).toBe(">");
  });

  it("leaves Enter, Esc and unknown keys to the caller", () => {
    const editor = editorFromText("x");
    expect(editPromptText(editor, key("enter"))).toBe(editor);
    expect(editPromptText(editor, key("escape"))).toBe(editor);
    expect(editPromptText(editor, { type: "ctrl", letter: "q" })).toBe(editor);
  });
});

describe("editSecretText", () => {
  it("types and pastes a single line: a pasted line break is dropped, not kept in the secret", () => {
    let editor = editSecretText(emptyEditor, { type: "text", text: "test-" });
    editor = editSecretText(editor, { type: "paste", text: "value\r\n12\n34" });
    expect(editorText(editor)).toBe("test-value1234");
  });

  it("ignores a line-feed key", () => {
    const editor = editorFromText("abc");
    expect(editSecretText(editor, key("newline"))).toBe(editor);
  });

  it("edits like the plain field otherwise", () => {
    let editor = editorFromText("abc def");
    editor = editSecretText(editor, key("backspace", { alt: true }));
    expect(editorText(editor)).toBe("abc ");
    editor = editSecretText(editor, { type: "ctrl", letter: "u" });
    expect(editorText(editor)).toBe("");
  });
});

describe("maskEditor", () => {
  it("shows one mark per letter, wide ones included, and keeps the cursor where it was", () => {
    const masked = maskEditor(editorFromText("가a나"), "*");
    expect(masked.chars).toEqual(["*", "*", "*"]);
    expect(masked.cursor).toBe(3);
    const middle = maskEditor({ ...editorFromText("abcd"), cursor: 2 }, "•");
    expect(editorText(middle)).toBe("••••");
    expect(middle.cursor).toBe(2);
  });
});
