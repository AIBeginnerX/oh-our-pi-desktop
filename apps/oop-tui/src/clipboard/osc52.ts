/**
 * OSC 52: the escape sequence that asks the terminal to put text on the system clipboard. It reaches
 * the clipboard of the machine the terminal runs on, so it is also the one way over SSH. Terminals
 * that do not take it (macOS Terminal.app) ignore it, which is why a local session also runs the
 * platform's own tool; see `clipboard.ts`.
 */

/** Most base64 characters sent. xterm's own limit is of this order, and tmux and others cut below it. */
export const OSC52_MAX_BASE64 = 100_000;

const ESC = "\u001b";
const BEL = "\u0007";

/** The sequence for `text`, or null when its base64 form is longer than `maxBase64`. */
export const osc52Sequence = (
  text: string,
  options: { readonly tmux?: boolean; readonly maxBase64?: number } = {},
): string | null => {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  if (base64.length > (options.maxBase64 ?? OSC52_MAX_BASE64)) return null;
  const sequence = `${ESC}]52;c;${base64}${BEL}`;
  // tmux hands a sequence on to the terminal only inside its DCS passthrough, with every ESC doubled.
  // It needs `allow-passthrough` in tmux.conf; without it the wrapper is dropped, which does no harm.
  return options.tmux === true
    ? `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${ESC}\\`
    : sequence;
};
