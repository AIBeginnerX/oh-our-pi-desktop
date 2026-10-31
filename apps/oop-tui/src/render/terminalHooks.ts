import { sanitizeForTerminal } from "../text/width.ts";

const BEL = "\u0007";
/** Push the window and icon titles onto the terminal's title stack, and pop them back. */
const PUSH_TITLE = "\u001b[22;0t";
const POP_TITLE = "\u001b[23;0t";

/**
 * The window title (OSC 0) and the bell, written through `write`. A terminal with no colour, or one
 * that says it is `dumb`, did not ask for the title, and would show it as stray text, so it is not
 * sent; the bell is held back only on a `dumb` terminal. The title is cleaned again here: nothing but
 * printable text reaches the escape sequence. The title the shell had is pushed on the terminal's
 * stack before the first one is set and popped by `restoreTitle`; a terminal without a title stack
 * ignores both, and then keeps the last title as it is.
 */
export const createTerminalHooks = (
  write: (text: string) => void,
  terminal: { readonly colorLevel: number; readonly term: string | undefined },
) => {
  const dumb = terminal.term === "dumb";
  let pushed = false;
  return {
    setTitle: (title: string): void => {
      if (terminal.colorLevel === 0 || dumb) return;
      if (!pushed) write(PUSH_TITLE);
      pushed = true;
      write(`\u001b]0;${sanitizeForTerminal(title).replace(/\n/gu, " ")}${BEL}`);
    },
    restoreTitle: (): void => {
      if (!pushed) return;
      pushed = false;
      // A terminal without a title stack ignores the pop, so the title is blanked first.
      write(`\u001b]0;${BEL}${POP_TITLE}`);
    },
    bell: (): void => {
      if (!dumb) write(BEL);
    },
  };
};
