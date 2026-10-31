import type { KeyEvent } from "../input/keys.ts";
import type { RegionFrame } from "../render/liveRegion.ts";
import type { Style } from "../render/style.ts";
import type { Symbols } from "../render/symbols.ts";
import {
  providerFrame,
  providerKey,
  type ProviderContext,
  type ProviderView,
} from "./providerScreen.ts";
import type { AddDraft } from "./providerSpec.ts";

/** The terminal as the wizard needs it: somewhere to draw, and a stream of keys. */
export interface WizardTerminal {
  readonly region: {
    readonly set: (frame: RegionFrame) => void;
    readonly clear: () => void;
  };
  readonly columns: () => number;
  readonly rows: () => number;
  /** Delivers each key until the returned function is called. */
  readonly keys: (listener: (event: KeyEvent) => void) => () => void;
  /** Calls back when the terminal changes size, until the returned function is called. */
  readonly resized: (listener: () => void) => () => void;
}

/**
 * Runs the add screens of `/provider add` in the shell: the same screens, keys and checks as in the
 * chat, started at `start`. Resolves with the draft the user confirmed, or null when they left.
 * It draws after a key or a resize and at no other time, and leaves the screen clean.
 */
export const runAddWizard = (input: {
  readonly terminal: WizardTerminal;
  readonly style: Style;
  readonly symbols: Symbols;
  readonly context: ProviderContext;
  readonly start: ProviderView;
}): Promise<AddDraft | null> =>
  new Promise((resolve) => {
    const { terminal, style, symbols, context } = input;
    let view: ProviderView = input.start;
    let banner: string | null = null;
    const draw = () =>
      terminal.region.set(
        providerFrame(view, context, {
          columns: terminal.columns(),
          rows: terminal.rows(),
          style,
          symbols,
          banner,
          tone: "warning",
        }),
      );
    const finish = (draft: AddDraft | null) => {
      stopKeys();
      stopResize();
      terminal.region.clear();
      resolve(draft);
    };
    const stopKeys = terminal.keys((event) => {
      if (event.type === "ctrl" && event.letter === "c") {
        finish(null);
        return;
      }
      banner = null;
      const result = providerKey(view, context, event);
      if (result.effect.kind === "submit") {
        finish(result.effect.draft);
        return;
      }
      if (result.view === null) {
        finish(null);
        return;
      }
      view = result.view;
      banner = result.notice ?? null;
      draw();
    });
    const stopResize = terminal.resized(draw);
    draw();
  });
