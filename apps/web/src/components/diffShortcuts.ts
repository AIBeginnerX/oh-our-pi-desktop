import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { resolveShortcutCommand, type ShortcutEventLike } from "../keybindings";

export type DiffShortcutCommand = "diff.nextFile" | "diff.previousFile" | "diff.toggleViewed";

const DIFF_SHORTCUT_COMMANDS: ReadonlySet<string> = new Set([
  "diff.nextFile",
  "diff.previousFile",
  "diff.toggleViewed",
]);

/**
 * Resolves a keypress inside the diff panel to one of its review shortcuts. These are plain
 * letters and brackets, so they never fire while the reader is typing (a comment box, the base
 * branch search) or has a menu open. `target` is the innermost element the event came from;
 * a listener on the panel only sees the shadow host for events inside the diff viewer.
 */
export function resolveDiffShortcut(
  event: ShortcutEventLike,
  target: EventTarget | null,
  keybindings: ResolvedKeybindingsConfig,
): DiffShortcutCommand | null {
  if (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      target.closest('[data-slot="menu-popup"], [data-slot="combobox-popup"]'))
  ) {
    return null;
  }

  const command = resolveShortcutCommand(event, keybindings, {
    context: { diffFocus: true },
  });
  return command !== null && DIFF_SHORTCUT_COMMANDS.has(command)
    ? (command as DiffShortcutCommand)
    : null;
}
