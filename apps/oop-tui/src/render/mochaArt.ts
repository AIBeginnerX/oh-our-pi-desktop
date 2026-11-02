/**
 * Mocha's pixel art: the grids, the palette and the timing of every state, as plain data with no
 * imports. The Rust app draws the very same frames: `apps/oop-tui-rs/scripts/export-fixtures.mjs`
 * writes this module to `fixtures/pet/mocha.json`, which `src/pet.rs` loads, and both clients test
 * their drawing against what that file holds. Change a pixel here, run the script, commit both.
 *
 * A frame is 10 rows of 14 pixels; the half-block renderer packs two rows into one
 * terminal row (5 rows by 14 cells). The one-line form is 2 rows of 7 pixels
 * (one row of 7 cells).
 *
 *   .  nothing          B  cup          H  cup shade, handle     E  eye
 *   C  cheek            c  bright cheek K  coaster               L  coffee
 *   S  steam            l  coffee, new  s  steam, new            Y  spark, bang
 *   R  heart            Z  sleep z      M  smoke                 T  spoon
 *   o  bubble
 *
 * Coffee and steam take the colour of the active provider. `L` and `S` are the colour the pet had
 * before a model switch and `l` and `s` the new one, so a switch frame can paint the change as a
 * wave across the cup; every other frame has only `L` and `S`, both in the current colour.
 */

export const MOCHA_STATES = [
  "idle",
  "working",
  "thinking",
  "tool",
  "waiting",
  "success",
  "error",
  "resting",
  "greeting",
  "switching",
] as const;

export type PetState = (typeof MOCHA_STATES)[number];

/** Which colour the coffee and steam are in. */
export type PetTone = "claude" | "openai" | "local" | "default";

export const MOCHA_WIDTH = 14;
export const MOCHA_HEIGHT = 10;
export const MOCHA_MINI_WIDTH = 7;
export const MOCHA_MINI_HEIGHT = 2;

/** Truecolor of every pixel kind that does not depend on the provider. */
export const MOCHA_PALETTE: Readonly<Record<string, string>> = {
  B: "#F4EFE6",
  H: "#D8CFC2",
  E: "#2B2625",
  C: "#E07A5F",
  c: "#F4A28C",
  K: "#8C5A3C",
  Y: "#F2C94C",
  R: "#E8607A",
  Z: "#9FB4D8",
  M: "#6B6460",
  T: "#B8B2A7",
  o: "#FBF6EC",
};

/** The coffee by provider; the steam is this colour lifted `MOCHA_STEAM_LIFT` of the way to white. */
export const MOCHA_LIQUID: Readonly<Record<PetTone, string>> = {
  claude: "#D97757",
  openai: "#10A37F",
  local: "#7C3AED",
  default: "#6F4E37",
};
export const MOCHA_STEAM_LIFT = 0.28;

/**
 * The 16 colours (0-15) the flat renderer uses where there is no background to pack two pixels
 * into one cell: by pixel kind, and for the coffee and steam by provider.
 */
export const MOCHA_ANSI16: Readonly<Record<string, number>> = {
  B: 15,
  H: 7,
  C: 1,
  c: 9,
  K: 3,
  Y: 11,
  R: 9,
  Z: 14,
  M: 8,
  T: 7,
  o: 15,
};
export const MOCHA_ANSI16_TONE: Readonly<Record<PetTone, number>> = {
  claude: 9,
  openai: 2,
  local: 5,
  default: 3,
};

export interface MochaState {
  /** Pictures of 10 rows of 14 pixels. */
  readonly frames: ReadonlyArray<ReadonlyArray<string>>;
  /** The one-line form, a picture of 2 rows of 7 pixels for each frame above. */
  readonly mini: ReadonlyArray<ReadonlyArray<string>>;
  /** `[frame, milliseconds]`: how long each frame stays, in order, then round again. */
  readonly script: ReadonlyArray<readonly [number, number]>;
}

export const MOCHA: Readonly<Record<PetState, MochaState>> = {
  idle: {
    frames: [
      [
        "....S..S......",
        ".....S..S.....",
        "....S..S......",
        "..BLLLLLLB....",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..BEBBBBEH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "....S..S......",
        "...S..S.......",
        "....S..S......",
        "..BLLLLLLB....",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..BEBBBBEH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "....S..S......",
        "...S..S.......",
        "....S..S......",
        "..BLLLLLLB....",
        "..BBBBBBBH....",
        "..BBBBBBBHHH..",
        "..BEEBBEEH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
    ],
    mini: [
      ["LLLLL.S", "BEBEBH."],
      ["LLLLL..", "BEBEBHS"],
      ["LLLLL..", "BHBHBHS"],
    ],
    script: [
      [0, 1600],
      [1, 1700],
      [2, 200],
    ],
  },
  working: {
    frames: [
      [
        "....S..S......",
        ".....S..S...Y.",
        "....S..S...YYY",
        "..BLLLLLLB..Y.",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..EBEBBEBE.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "...S..S.......",
        "Y...S..S......",
        "..BLLLLLLB....",
        "..BBBBBBBH....",
        "..BEBBBBEHHHY.",
        "..EBEBBEBE.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        "..............",
        ".KKKKKKKKKK...",
      ],
      [
        "....S..S......",
        ".Y...S..S.....",
        "YYY.S..S......",
        ".YBLLLLLLB....",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..EBEBBEBE.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "...S..S.....Y.",
        "....S..S......",
        "..BLLLLLLB....",
        "Y.BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..EBEBBEBE.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        "..............",
        ".KKKKKKKKKK...",
      ],
    ],
    mini: [
      ["LLLLL.Y", "CEBECH."],
      ["LLLLL..", "CEBECHY"],
      ["LLLLL.Y", "CEBECH."],
      ["LLLLL..", "CEBECHY"],
    ],
    script: [
      [0, 250],
      [1, 250],
      [2, 250],
      [3, 250],
    ],
  },
  thinking: {
    frames: [
      [
        "...SS..SS.....",
        "..SS....SS....",
        "...SS..SS.....",
        "..BLLoLLLB....",
        "..BEBBBBEH....",
        "..BEBBBBEHHH..",
        "..BBBBBBBH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "..SS....SS....",
        "...SS..SS.....",
        "...SS.oSS.....",
        "..BLLLLLLB....",
        "..BBBBBBBH....",
        "..BBEBBBBEHH..",
        "..BBEBBBBE.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "...SS..SS.....",
        "..SS.o..SS....",
        "...SS..SS.....",
        "..BLLLoLLB....",
        "..BEBBBBEH....",
        "..BEBBBBEHHH..",
        "..BBBBBBBH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "..SS..o.SS....",
        "...SS..SS.....",
        "...SSo.SS.....",
        "..BLLLLLLB....",
        "..BBBBBBBH....",
        "..EBBBBEBHHH..",
        "..EBBBBEBH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
    ],
    mini: [
      ["LLLLL..", "BEBEBHo"],
      ["LLLLL.o", "BEBEBH."],
      ["LLLLL..", "BEBEBHo"],
      ["LLLLL.o", "BEBEBH."],
    ],
    script: [
      [0, 330],
      [1, 330],
      [2, 330],
      [3, 330],
    ],
  },
  tool: {
    frames: [
      [
        "..T...........",
        "...T..........",
        "....T.........",
        "..BLLTLLLB....",
        "..BBBBBBBH....",
        "..BEEBBEEHHH..",
        "..BBBBBBBH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        ".....T........",
        ".....T........",
        ".....T........",
        "..BLLTLLLB....",
        "..BBBBBBBH....",
        "..BEEBBEEHHH..",
        "..BBBBBBBH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "........T.....",
        ".......T......",
        "......T.......",
        "..BLLTLLLB....",
        "..BBBBBBBH....",
        "..BEEBBEEHHH..",
        "..BBBBBBBH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        ".....T........",
        ".....T........",
        ".....T........",
        "..BLLTLLLB....",
        "..BBBBBBBH....",
        "..BEEBBEEHHH..",
        "..BBBBBBBH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
    ],
    mini: [
      ["LTLLL..", "BEBEBH."],
      ["LLTLL..", "BEBEBH."],
      ["LLLTL..", "BEBEBH."],
      ["LLTLL..", "BEBEBH."],
    ],
    script: [
      [0, 300],
      [1, 300],
      [2, 300],
      [3, 300],
    ],
  },
  waiting: {
    frames: [
      [
        "....S..S....Y.",
        ".....S..S...Y.",
        "....S..S......",
        "..BLLLLLLB..Y.",
        "..BEBBBBEH....",
        "..BEBBBBEHHH..",
        "..BEBBBBEH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "....S..S......",
        "...S..S.......",
        "....S..S......",
        "..BLLLLLLB....",
        "..BEBBBBEH....",
        "..BEBBBBEHHH..",
        "..BEBBBBEH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
    ],
    mini: [
      ["LLLLL.Y", "BEBEBHY"],
      ["LLLLL..", "BEBEBHY"],
    ],
    script: [
      [0, 1000],
      [1, 1000],
    ],
  },
  success: {
    frames: [
      [
        "....S..S...R.R",
        ".....S..S..RRR",
        "Y...S..S....R.",
        "..BLLLLLLB....",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..EBEBBEBE.H..",
        "..ccBBBBccHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        ".Y.S..S....R.R",
        "Y.Y.S..S...RRR",
        ".YBLLLLLLB..R.",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..EBEBBEBE.H..",
        "..ccBBBBccHH..",
        "...HHHHHH.....",
        "..............",
        ".KKKKKKKKKK...",
      ],
      [
        "....S..S...R.R",
        ".....S..S..RRR",
        "....S..S....R.",
        ".YBLLLLLLB....",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..EBEBBEBE.H..",
        "..ccBBBBccHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "Y..S..S....R.R",
        ".Y..S..S...RRR",
        "Y.BLLLLLLB..R.",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..EBEBBEBE.H..",
        "..ccBBBBccHH..",
        "...HHHHHH.....",
        "..............",
        ".KKKKKKKKKK...",
      ],
    ],
    mini: [
      ["LLLLL.R", "cEBEcH."],
      ["LLLLL.R", "cEBEcH."],
      ["LLLLL..", "cEBEcHR"],
      ["LLLLL.R", "cEBEcH."],
    ],
    script: [
      [0, 400],
      [1, 400],
      [2, 400],
      [3, 400],
    ],
  },
  error: {
    frames: [
      [
        "...M..........",
        "L...M.........",
        "...M..........",
        "L..BLLLLLLB...",
        "...EBEBBEBE...",
        "...BEBBBBEHHH.",
        "...EBEBBEBE.H.",
        "...CCBBBBCCHH.",
        "....HHHHHH....",
        ".KKKKKKKKKK...",
      ],
      [
        ".....M........",
        "....M.........",
        ".....M.......L",
        ".BLLLLLLB.....",
        ".EBEBBEBE....L",
        ".BEBBBBEHHH...",
        ".EBEBBEBE.H...",
        ".CCBBBBCCHH...",
        "..HHHHHH......",
        ".KKKKKKKKKK...",
      ],
      [
        "....M.........",
        "...M..........",
        "L...M.........",
        "...BLLLLLLB...",
        "L..EBEBBEBE...",
        "...BEBBBBEHHH.",
        "...EBEBBEBE.H.",
        "...CCBBBBCCHH.",
        "....HHHHHH....",
        ".KKKKKKKKKK...",
      ],
      [
        "....M........L",
        ".....M........",
        "....M.........",
        ".BLLLLLLB....L",
        ".EBEBBEBE.....",
        ".BEBBBBEHHH...",
        ".EBEBBEBE.H...",
        ".CCBBBBCCHH...",
        "..HHHHHH......",
        ".KKKKKKKKKK...",
      ],
    ],
    mini: [
      ["LLLLL.M", "BEBEBH."],
      ["LLLLL..", "BEBEBHM"],
      ["LLLLL.M", "BEBEBH."],
      ["LLLLL..", "BEBEBHM"],
    ],
    script: [
      [0, 500],
      [1, 500],
      [2, 500],
      [3, 500],
    ],
  },
  resting: {
    frames: [
      [
        "..............",
        "..............",
        "..............",
        "..BLLLLLLB...Z",
        "..BBBBBBBH..Z.",
        "..BBBBBBBHHH..",
        "..BEEBBEEH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "...........ZZZ",
        ".............Z",
        "............Z.",
        "..BLLLLLLB.ZZZ",
        "..BBBBBBBH....",
        "..BBBBBBBHHH..",
        "..BEEBBEEH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "...........ZZZ",
        ".............Z",
        "............Z.",
        "..BLLLLLLB.ZZZ",
        "..BBBBBBBH...Z",
        "..BBBBBBBHHHZ.",
        "..BEEBBEEH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
    ],
    mini: [
      ["LLLLL..", "BHBHBHZ"],
      ["LLLLL.Z", "BHBHBH."],
      ["LLLLL.Z", "BHBHBHZ"],
    ],
    script: [
      [0, 4000],
      [1, 4000],
      [2, 4000],
    ],
  },
  greeting: {
    frames: [
      [
        ".....S...S....",
        "..S.S.S.S.....",
        "...S...S......",
        "..BLLLLLLB....",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..BEBBBBEH.H..",
        "..ccBBBBccHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "....S...S.....",
        "...S.S.S.S....",
        "..S...S.......",
        "..BLLLLLLB....",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..EBEBBEBE.H..",
        "..ccBBBBccHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "...S...S......",
        "..S.S.S.S.....",
        ".....S...S....",
        "..BLLLLLLB....",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..BEBBBBEH.H..",
        "..ccBBBBccHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "..S...S.......",
        "...S.S.S.S....",
        "....S...S.....",
        "..BLLLLLLB....",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..EBEBBEBE.H..",
        "..ccBBBBccHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
    ],
    mini: [
      ["LLLLL.S", "BEBEBH."],
      ["LLLLL..", "cEBEcHS"],
      ["LLLLL.S", "BEBEBH."],
      ["LLLLL..", "cEBEcHS"],
    ],
    script: [
      [0, 400],
      [1, 400],
      [2, 400],
      [3, 400],
    ],
  },
  switching: {
    frames: [
      [
        "....S..S......",
        ".....S..S.....",
        "....S..S......",
        "..BlLLLLLB....",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..BEBBBBEH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
      [
        "...s..S.......",
        "....s..S......",
        "..BlllLLLB....",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..EBEBBEBE.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        "..............",
        ".KKKKKKKKKK...",
      ],
      [
        ".....s..s.....",
        "....s..s......",
        "..BllllllB....",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..EBEBBEBE.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        "..............",
        ".KKKKKKKKKK...",
      ],
      [
        "....s..s......",
        "...s..s.......",
        "....s..s......",
        "..BllllllB....",
        "..BBBBBBBH....",
        "..BEBBBBEHHH..",
        "..BEBBBBEH.H..",
        "..CCBBBBCCHH..",
        "...HHHHHH.....",
        ".KKKKKKKKKK...",
      ],
    ],
    mini: [
      ["llLLL.Y", "BEBEBH."],
      ["lllLL..", "CEBECHY"],
      ["llllL.Y", "CEBECH."],
      ["lllll..", "BEBEBHY"],
    ],
    script: [
      [0, 250],
      [1, 250],
      [2, 250],
      [3, 250],
    ],
  },
};

/** Providers and the colour each gets: `[driver, instanceId, model, tone]`. The Rust tests read the same rows. */
export const MOCHA_TONE_CASES: ReadonlyArray<readonly [string | null, string, string, PetTone]> = [
  ["claudeAgent", "claude", "claude-sonnet-5-5", "claude"],
  ["claudeAgent", "claude_work", "claude-opus-5-5", "claude"],
  ["codex", "codex", "gpt-5.5", "openai"],
  ["codex", "codex_personal", "gpt-5.6-sol", "openai"],
  ["ollama", "ollama", "llama3.3", "local"],
  ["ollama", "my-box", "qwen3", "local"],
  ["opencode", "opencode", "ollama/llama3.3", "local"],
  ["opencode", "opencode", "lmstudio/qwen3-coder", "local"],
  ["opencode", "opencode", "anthropic/claude-sonnet-5-5", "default"],
  ["opencode", "opencode", "openai/gpt-5.5", "default"],
  ["cursor", "cursor", "gpt-5.5", "default"],
  ["cursor", "cursor", "claude-sonnet-5-5", "default"],
  ["grok", "grok", "grok-4", "default"],
  ["antigravity", "antigravity", "gemini-3", "default"],
  [null, "local", "tiny", "local"],
  [null, "mystery", "m", "default"],
];
