import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { parseColor } from "./color.ts";
import {
  applyOverrides,
  BACKGROUND_TOKENS,
  BUILTIN_THEME_NAMES,
  BUILTIN_THEMES,
  createTheme,
  defaultThemeName,
  FOREGROUND_TOKENS,
  isSafeThemeName,
  listThemeNames,
  loadTheme,
  type Theme,
} from "./theme.ts";
import { stripAnsi } from "../text/width.ts";

const built = (name: keyof typeof BUILTIN_THEMES, level: 0 | 1 | 2 | 3): Theme =>
  createTheme(name, BUILTIN_THEMES[name], level);

describe("built-in themes", () => {
  it("are the six that were promised, each with every token a valid colour", () => {
    expect(BUILTIN_THEME_NAMES).toEqual([
      "oop",
      "oop-light",
      "aurora",
      "sunset",
      "colorblind",
      "ansi",
    ]);
    for (const name of BUILTIN_THEME_NAMES) {
      const tokens = BUILTIN_THEMES[name];
      for (const token of [...FOREGROUND_TOKENS, ...BACKGROUND_TOKENS]) {
        expect(parseColor(tokens[token]), `${name}.${token}`).not.toBeNull();
      }
      expect(tokens.gradient.length, `${name}.gradient`).toBeGreaterThanOrEqual(2);
      expect(tokens.agents, `${name}.agents`).toHaveLength(8);
      for (const spec of [...tokens.gradient, ...tokens.agents]) {
        expect(parseColor(spec), `${name} list`).not.toBeNull();
      }
    }
  });

  it("ansi writes only the 16 colours at every level", () => {
    for (const level of [1, 2, 3] as const) {
      const theme = built("ansi", level);
      const samples = [
        ...FOREGROUND_TOKENS.map((token) => theme[token]("x")),
        ...BACKGROUND_TOKENS.map((token) => theme.bg(token, "x")),
        theme.gradient("hello"),
        ...[0, 1, 2, 3, 4, 5, 6, 7].map((index) => theme.agent(index)("x")),
      ].join("");
      expect(samples).not.toContain("\u001b[38;");
      expect(samples).not.toContain("\u001b[48;");
    }
  });

  it("colorblind marks additions blue and removals orange", () => {
    const { diffAddBg, diffRemoveBg } = BUILTIN_THEMES.colorblind;
    const channels = (spec: string | number) => {
      const color = parseColor(spec);
      return color?.kind === "rgb" ? color : { r: 0, g: 0, b: 0 };
    };
    expect(channels(diffAddBg).b).toBeGreaterThan(channels(diffAddBg).r);
    expect(channels(diffAddBg).b).toBeGreaterThan(channels(diffAddBg).g);
    expect(channels(diffRemoveBg).r).toBeGreaterThan(channels(diffRemoveBg).b);
  });
});

describe("a theme's paints", () => {
  it("write the colour for the terminal's level and close it again", () => {
    expect(built("oop", 3).brand("hi")).toBe("\u001b[38;2;167;139;250mhi\u001b[39m");
    expect(built("oop", 2).brand("hi")).toBe("\u001b[38;5;141mhi\u001b[39m");
    expect(built("oop", 1).brand("hi")).toBe("\u001b[94mhi\u001b[39m");
  });

  it("return their input untouched when colour is off", () => {
    const theme = built("oop", 0);
    expect(theme.enabled).toBe(false);
    expect(theme.brand("hi")).toBe("hi");
    expect(theme.error.bold("hi")).toBe("hi");
    expect(theme.bg("diffAddBg", "hi", "success")).toBe("hi");
    expect(theme.gradient("hi")).toBe("hi");
    expect(theme.agent(3)("hi")).toBe("hi");
  });

  it("combine with bold and dim", () => {
    const theme = built("oop", 3);
    expect(theme.error.bold("x")).toBe("\u001b[38;2;248;113;113;1mx\u001b[39;22m");
    expect(theme.muted.dim.bold("x")).toBe("\u001b[38;2;154;163;181;2;1mx\u001b[39;22m");
    expect(theme.text.bold("x")).toBe("\u001b[1mx\u001b[22m");
    expect(theme.text("x")).toBe("x");
  });

  it("do not change the paint they were made from", () => {
    const theme = built("oop", 3);
    theme.brand.bold("x");
    expect(theme.brand("x")).toBe("\u001b[38;2;167;139;250mx\u001b[39m");
  });

  it("cycle the sub-agent colours", () => {
    const theme = built("oop", 3);
    expect(theme.agent(0)("x")).not.toBe(theme.agent(1)("x"));
    expect(theme.agent(8)("x")).toBe(theme.agent(0)("x"));
    expect(theme.agent(-1)("x")).toBe(theme.agent(7)("x"));
  });
});

describe("backgrounds", () => {
  it("fill behind the text where the terminal has 256 colours or more", () => {
    expect(built("oop", 3).bg("diffAddBg", "+ line")).toBe(
      "\u001b[38;2;229;231;235;48;2;18;51;31m+ line\u001b[39;49m",
    );
    expect(built("oop", 2).supportsBackground).toBe(true);
    const filled = built("oop", 2).bg("diffAddBg", "+ line");
    expect(filled.startsWith("\u001b[38;5;")).toBe(true);
    expect(filled).toContain(";48;5;");
    expect(filled.endsWith("m+ line\u001b[39;49m")).toBe(true);
  });

  it("paint their own foreground, so the terminal's never decides what can be read", () => {
    const luminance = (spec: string | number) => {
      const color = parseColor(spec);
      if (color?.kind !== "rgb") return null;
      const [r, g, b] = [color.r, color.g, color.b].map((channel) => {
        const unit = channel / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const name of BUILTIN_THEME_NAMES) {
      if (name === "ansi") continue;
      const tokens = BUILTIN_THEMES[name];
      const text = luminance(tokens.onBg) as number;
      for (const token of BACKGROUND_TOKENS) {
        const fill = luminance(tokens[token]) as number;
        const ratio = (Math.max(text, fill) + 0.05) / (Math.min(text, fill) + 0.05);
        expect(ratio, `${name}.onBg on ${token}`).toBeGreaterThan(4.5);
      }
    }
  });

  it("give the fill's foreground back after a paint inside the text closes", () => {
    const theme = built("oop", 3);
    const filled = theme.bg("codeBg", `${theme.brand("a")}b`);
    const onBg = "\u001b[38;2;229;231;235m";
    expect(filled).toContain(`\u001b[39m${onBg}b`);
    expect(filled.startsWith(`\u001b[38;2;229;231;235;48;2;`)).toBe(true);
  });

  it("are not used on 16 colours: the fallback foreground, else plain", () => {
    const theme = built("oop", 1);
    expect(theme.supportsBackground).toBe(false);
    expect(theme.bg("diffAddBg", "+ line", "success")).toBe(theme.success("+ line"));
    expect(theme.bg("diffRemoveBg", "- line", "error")).toBe(theme.error("- line"));
    expect(theme.bg("codeBg", "code")).toBe("code");
  });

  it("write nothing for a theme that leaves a background at the terminal's own", () => {
    expect(built("ansi", 3).bg("userBg", "hi")).toBe("hi");
  });
});

describe("gradient", () => {
  it("blends on truecolor, is flat on 16 colours, and is plain with no colour", () => {
    expect(built("oop", 3).gradient("OOP")).toMatch(/38;2;114;83;185m/u);
    expect(built("oop", 3).gradient("OOP")).toMatch(/38;2;\d+;\d+;\d+mP/u);
    expect(built("oop", 1).gradient("OOP").endsWith("mOOP\u001b[39m")).toBe(true);
    expect(stripAnsi(built("oop", 3).gradient("OOP"))).toBe("OOP");
    expect(built("oop", 0).gradient("OOP")).toBe("OOP");
  });
});

describe("applyOverrides", () => {
  it("replaces valid tokens and keeps the rest of the base", () => {
    const { tokens, warnings } = applyOverrides(BUILTIN_THEMES.oop, {
      brand: "#ff00aa",
      accent: 208,
      error: "brightRed",
      gradient: ["#000000", "#ffffff"],
    });
    expect(warnings).toEqual([]);
    expect(tokens.brand).toBe("#ff00aa");
    expect(tokens.accent).toBe(208);
    expect(tokens.error).toBe("brightRed");
    expect(tokens.gradient).toEqual(["#000000", "#ffffff"]);
    expect(tokens.success).toBe(BUILTIN_THEMES.oop.success);
  });

  it("skips unknown keys and bad values, saying so once each", () => {
    const { tokens, warnings } = applyOverrides(BUILTIN_THEMES.oop, {
      brand: "magenta-ish",
      sparkle: "#ffffff",
      accent: 999,
      agents: [],
      gradient: ["#000000", "nope"],
      dim: "#6b7489",
    });
    expect(tokens.brand).toBe(BUILTIN_THEMES.oop.brand);
    expect(tokens.accent).toBe(BUILTIN_THEMES.oop.accent);
    expect(tokens.agents).toEqual(BUILTIN_THEMES.oop.agents);
    expect(tokens.gradient).toEqual(BUILTIN_THEMES.oop.gradient);
    expect(warnings).toHaveLength(5);
    expect(warnings.join("\n")).toContain("sparkle");
    expect(warnings.join("\n")).toContain("brand");
  });

  it("refuses overrides that are not an object", () => {
    for (const bad of [[], "x", 3, null]) {
      const { tokens, warnings } = applyOverrides(BUILTIN_THEMES.oop, bad);
      expect(tokens).toBe(BUILTIN_THEMES.oop);
      expect(warnings).toHaveLength(1);
    }
  });
});

describe("isSafeThemeName", () => {
  it("rejects anything that could leave the themes folder", () => {
    for (const name of [
      "../x",
      "a/b",
      "a\\b",
      "..",
      ".hidden",
      "",
      "C:evil",
      "a\u0000b",
      "x".repeat(65),
    ]) {
      expect(isSafeThemeName(name), name).toBe(false);
    }
    for (const name of ["night", "my-theme_2", "달밤", "a.b"]) {
      expect(isSafeThemeName(name), name).toBe(true);
    }
  });
});

describe("defaultThemeName", () => {
  it("is ansi on 16 colours and oop otherwise", () => {
    expect(defaultThemeName(1)).toBe("ansi");
    expect(defaultThemeName(0)).toBe("oop");
    expect(defaultThemeName(2)).toBe("oop");
    expect(defaultThemeName(3)).toBe("oop");
  });

  it("is oop-light when COLORFGBG says the background is light", () => {
    const named = (COLORFGBG: string) => defaultThemeName(3, { COLORFGBG });
    expect(named("0;15")).toBe("oop-light");
    expect(named("0;default;15")).toBe("oop-light");
    expect(named("0;7")).toBe("oop-light");
    expect(named("15;0")).toBe("oop");
    expect(named("15;8")).toBe("oop");
    expect(named("default;default")).toBe("oop");
    expect(named("garbage")).toBe("oop");
    expect(named("")).toBe("oop");
    expect(defaultThemeName(3, {})).toBe("oop");
    expect(defaultThemeName(1, { COLORFGBG: "0;15" })).toBe("ansi");
  });
});

describe("user themes on disk", () => {
  let configDir: string;
  beforeEach(() => {
    configDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-theme-"));
    NodeFS.mkdirSync(NodePath.join(configDir, "themes"));
  });
  afterEach(() => NodeFS.rmSync(configDir, { recursive: true, force: true }));
  const write = (name: string, content: string) =>
    NodeFS.writeFileSync(NodePath.join(configDir, "themes", `${name}.json`), content);

  it("load a built-in without touching the disk", () => {
    const loaded = loadTheme({ name: "aurora", level: 3, configDir: "/does/not/exist" });
    expect(loaded.ok && loaded.theme.name).toBe("aurora");
    expect(loaded.ok && loaded.warnings).toEqual([]);
  });

  it("merge their overrides over the base, defaulting the base to oop", () => {
    write("pink", JSON.stringify({ overrides: { brand: "#ff00aa" } }));
    write("dusk", JSON.stringify({ base: "sunset", overrides: { brand: "#112233" } }));
    const pink = loadTheme({ name: "pink", level: 3, configDir });
    expect(pink.ok && pink.theme.brand("x")).toBe("\u001b[38;2;255;0;170mx\u001b[39m");
    expect(pink.ok && pink.theme.success("x")).toBe(built("oop", 3).success("x"));
    const dusk = loadTheme({ name: "dusk", level: 3, configDir });
    expect(dusk.ok && dusk.theme.accent("x")).toBe(built("sunset", 3).accent("x"));
    expect(dusk.ok && dusk.theme.brand("x")).toBe("\u001b[38;2;17;34;51mx\u001b[39m");
  });

  it("report what they ignore and still load", () => {
    write(
      "messy",
      JSON.stringify({ base: "nowhere", extra: 1, overrides: { brand: "blue-ish", nope: "#fff" } }),
    );
    const loaded = loadTheme({ name: "messy", level: 3, configDir });
    expect(loaded.ok).toBe(true);
    const warnings = loaded.ok ? loaded.warnings : [];
    expect(warnings).toHaveLength(4);
    expect(warnings.every((warning) => warning.startsWith("messy.json: "))).toBe(true);
    expect(loaded.ok && loaded.theme.brand("x")).toBe(built("oop", 3).brand("x"));
  });

  it("fail with a reason when the file is missing or not a theme", () => {
    write("broken", "{ not json");
    write("list", "[1,2]");
    expect(loadTheme({ name: "absent", level: 3, configDir })).toMatchObject({ ok: false });
    expect(loadTheme({ name: "broken", level: 3, configDir })).toMatchObject({ ok: false });
    expect(loadTheme({ name: "list", level: 3, configDir })).toMatchObject({ ok: false });
  });

  it("refuse a name that carries a path, without reading outside the themes folder", () => {
    NodeFS.writeFileSync(
      NodePath.join(configDir, "secret.json"),
      JSON.stringify({ overrides: {} }),
    );
    for (const name of ["../secret", "..\\secret", "sub/secret", "/etc/passwd"]) {
      expect(loadTheme({ name, level: 3, configDir }), name).toMatchObject({ ok: false });
    }
  });

  it("list the built-ins first, then the user's by name, ignoring unsafe or shadowing files", () => {
    write("zebra", "{}");
    write("alpha", "{}");
    write("oop", "{}");
    write(".hidden", "{}");
    NodeFS.writeFileSync(NodePath.join(configDir, "themes", "notes.txt"), "x");
    expect(listThemeNames(configDir)).toEqual([...BUILTIN_THEME_NAMES, "alpha", "zebra"]);
    expect(listThemeNames("/does/not/exist")).toEqual([...BUILTIN_THEME_NAMES]);
  });
});
