import {
  backspace,
  deleteForward,
  deleteWordBack,
  type EditorState,
  insertNewline,
  insertText,
  killToLineEnd,
  killToLineStart,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
} from "../input/editor.ts";
import type { KeyEvent } from "../input/keys.ts";

/**
 * The editing keys of a one-question text field (the goal prompt): the ones of the composer that
 * move or change the text. Enter, Esc and Ctrl-C belong to whoever shows the field.
 */
export const editPromptText = (editor: EditorState, event: KeyEvent): EditorState => {
  if (event.type === "text" || event.type === "paste") return insertText(editor, event.text);
  if (event.type === "ctrl") {
    switch (event.letter) {
      case "a":
        return moveHome(editor);
      case "e":
        return moveEnd(editor);
      case "u":
        return killToLineStart(editor);
      case "k":
        return killToLineEnd(editor);
      case "w":
        return deleteWordBack(editor);
      case "b":
        return moveLeft(editor);
      case "f":
        return moveRight(editor);
      default:
        return editor;
    }
  }
  if (event.type !== "key") return editor;
  const word = event.alt || event.ctrl;
  switch (event.name) {
    case "backspace":
      return word ? deleteWordBack(editor) : backspace(editor);
    case "delete":
      return deleteForward(editor);
    case "left":
      return word ? moveWordLeft(editor) : moveLeft(editor);
    case "right":
      return word ? moveWordRight(editor) : moveRight(editor);
    case "home":
      return moveHome(editor);
    case "end":
      return moveEnd(editor);
    case "newline":
      return insertNewline(editor);
    default:
      return editor;
  }
};

/** A secret is one line: a line feed typed or pasted into it is dropped, not kept as part of the value. */
const withoutLineBreaks = (text: string): string => text.replace(/[\r\n]+/gu, "");

/**
 * `editPromptText` for a field that holds a secret (an API key): a single line, whatever is pasted.
 * The value is never drawn; `maskEditor` is what the screen shows.
 */
export const editSecretText = (editor: EditorState, event: KeyEvent): EditorState => {
  if (event.type === "text" || event.type === "paste") {
    return editPromptText(editor, { ...event, text: withoutLineBreaks(event.text) });
  }
  if (event.type === "key" && event.name === "newline") return editor;
  return editPromptText(editor, event);
};

/**
 * The editor as it is drawn for a secret: one `mark` for each character typed, and the cursor where
 * it really is, so the length can be seen but not the text.
 */
export const maskEditor = (editor: EditorState, mark: string): EditorState => ({
  chars: editor.chars.map(() => mark),
  cursor: editor.cursor,
});
