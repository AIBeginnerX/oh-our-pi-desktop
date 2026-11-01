import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { setLanguage } from "./i18n/index.ts";

import { hostPlatform } from "./host.ts";
import type { PathEnv } from "./link/paths.ts";
import { BUILTIN_THEMES, createTheme } from "./render/theme.ts";
import {
  createThemeSwitcher,
  loadStartupTheme,
  readSettings,
  resolveSettings,
  runConfigCommand,
  type ConfigAction,
  settingsFilePath,
  writeSetting,
} from "./settings.ts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-settings-"));
  file = NodePath.join(dir, "settings.json");
});
afterEach(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

const paths = (env: NodeJS.ProcessEnv = {}): PathEnv => ({
  env: { OOP_CONFIG_DIR: dir, ...env },
  platform: "darwin",
  home: "/nowhere",
});

const readFile = () => NodeFS.readFileSync(file, "utf8");

describe("settingsFilePath", () => {
  it("sits in the config folder next to the credentials", () => {
    expect(settingsFilePath(paths())).toBe(NodePath.join(dir, "settings.json"));
    expect(settingsFilePath({ env: {}, platform: "darwin", home: "/Users/kim" })).toBe(
      "/Users/kim/.config/oop-tui/settings.json",
    );
  });
});

describe("workflow and pet settings", () => {
  it("are on by default and read only booleans from the file", () => {
    expect(resolveSettings({}, {}).settings).toMatchObject({ workflow: true, pet: true });
    NodeFS.writeFileSync(file, JSON.stringify({ workflow: false, pet: false }));
    expect(readSettings(file).values).toEqual({ workflow: false, pet: false });
    NodeFS.writeFileSync(file, JSON.stringify({ workflow: "no", pet: 1 }));
    const read = readSettings(file);
    expect(read.values).toEqual({});
    expect(read.warnings).toHaveLength(2);
  });
});

describe("sidebar setting", () => {
  it("is on by default, takes true or false, and warns about anything else", () => {
    NodeFS.writeFileSync(file, JSON.stringify({ sidebar: true }));
    expect(readSettings(file).values).toEqual({ sidebar: true });
    NodeFS.writeFileSync(file, JSON.stringify({ sidebar: "yes" }));
    const read = readSettings(file);
    expect(read.values).toEqual({});
    expect(read.warnings).toHaveLength(1);
    expect(resolveSettings({}, {}).settings.sidebar).toBe(true);
  });
});

describe("readSettings", () => {
  it("has nothing to say about a missing file", () => {
    expect(readSettings(file)).toEqual({ values: {}, warnings: [], damaged: false });
  });

  it("reads every key it knows and ignores the ones it does not", () => {
    NodeFS.writeFileSync(
      file,
      JSON.stringify({
        theme: "aurora",
        symbols: "ascii",
        animations: false,
        banner: false,
        statusLine: "compact",
        notify: true,
        future: { x: 1 },
      }),
    );
    expect(readSettings(file)).toEqual({
      values: {
        theme: "aurora",
        symbols: "ascii",
        animations: false,
        banner: false,
        statusLine: "compact",
        notify: true,
      },
      warnings: [],
      damaged: false,
    });
  });

  it("drops a bad value with one warning and keeps the good ones", () => {
    NodeFS.writeFileSync(
      file,
      JSON.stringify({ theme: "../evil", symbols: "emoji", animations: "yes", banner: false }),
    );
    const read = readSettings(file);
    expect(read.values).toEqual({ banner: false });
    expect(read.warnings).toHaveLength(3);
    expect(read.damaged).toBe(false);
  });

  it("starts from defaults with one warning on a damaged file, and leaves the file alone", () => {
    for (const content of ["{ nope", "[1]", "null", ""]) {
      NodeFS.writeFileSync(file, content);
      const read = readSettings(file);
      expect(read.values, content).toEqual({});
      expect(read.damaged, content).toBe(true);
      expect(read.warnings, content).toHaveLength(1);
      expect(readFile()).toBe(content);
    }
  });
});

describe("resolveSettings", () => {
  it("fills defaults", () => {
    expect(resolveSettings({}, {})).toEqual({
      settings: {
        theme: null,
        symbols: "auto",
        animations: true,
        banner: true,
        statusLine: "auto",
        notify: true,
        language: null,
        sidebar: true,
        workflow: true,
        pet: true,
      },
      fromEnv: [],
    });
  });

  it("lets OOP_THEME, OOP_ANIMATIONS and OOP_SYMBOLS beat the file", () => {
    const resolved = resolveSettings(
      { theme: "oop", symbols: "unicode", animations: true },
      { OOP_THEME: "sunset", OOP_ANIMATIONS: "0", OOP_SYMBOLS: "ASCII" },
    );
    expect(resolved.settings).toMatchObject({
      theme: "sunset",
      symbols: "ascii",
      animations: false,
    });
    expect(resolved.fromEnv).toEqual(["theme", "animations", "symbols"]);
  });

  it("ignores variables that say nothing usable", () => {
    const resolved = resolveSettings(
      { theme: "oop", animations: false },
      { OOP_THEME: "../x", OOP_ANIMATIONS: "maybe", OOP_SYMBOLS: "emoji" },
    );
    expect(resolved.settings).toMatchObject({ theme: "oop", animations: false, symbols: "auto" });
    expect(resolved.fromEnv).toEqual([]);
    expect(resolveSettings({}, { OOP_THEME: "", OOP_ANIMATIONS: "1" }).settings.animations).toBe(
      true,
    );
  });
});

describe("writeSetting", () => {
  it("creates the file and keeps every other key, known or not", () => {
    NodeFS.writeFileSync(file, JSON.stringify({ banner: false, other: { deep: [1, 2] } }));
    expect(writeSetting(file, "theme", "aurora")).toEqual({ ok: true });
    expect(JSON.parse(readFile())).toEqual({
      banner: false,
      other: { deep: [1, 2] },
      theme: "aurora",
    });
    expect(writeSetting(file, "theme", "sunset")).toEqual({ ok: true });
    expect(JSON.parse(readFile())).toMatchObject({ banner: false, theme: "sunset" });
    expect(NodeFS.readdirSync(dir)).toEqual(["settings.json"]);
  });

  it("makes a missing config folder private, and leaves an existing one's permissions alone", () => {
    const fresh = NodePath.join(dir, "new", "cfg", "settings.json");
    expect(writeSetting(fresh, "banner", false)).toEqual({ ok: true });
    expect(JSON.parse(NodeFS.readFileSync(fresh, "utf8"))).toEqual({ banner: false });
    if (hostPlatform() !== "win32") {
      expect(NodeFS.statSync(NodePath.dirname(fresh)).mode & 0o777).toBe(0o700);
      NodeFS.chmodSync(dir, 0o750);
      writeSetting(file, "banner", true);
      expect(NodeFS.statSync(dir).mode & 0o777).toBe(0o750);
    }
  });

  it.skipIf(hostPlatform() === "win32")(
    "writes through a symlinked settings file, and keeps the mode it had",
    () => {
      const dotfiles = NodePath.join(dir, "dotfiles");
      NodeFS.mkdirSync(dotfiles);
      const real = NodePath.join(dotfiles, "settings.json");
      NodeFS.writeFileSync(real, JSON.stringify({ banner: false }), { mode: 0o600 });
      NodeFS.chmodSync(real, 0o600);
      NodeFS.symlinkSync(real, file);
      expect(writeSetting(file, "theme", "aurora")).toEqual({ ok: true });
      expect(NodeFS.lstatSync(file).isSymbolicLink()).toBe(true);
      expect(JSON.parse(NodeFS.readFileSync(real, "utf8"))).toEqual({
        banner: false,
        theme: "aurora",
      });
      expect(NodeFS.statSync(real).mode & 0o777).toBe(0o600);
      expect(NodeFS.readdirSync(dotfiles)).toEqual(["settings.json"]);
    },
  );

  it.skipIf(hostPlatform() === "win32")("writes through a dangling symlink", () => {
    const dotfiles = NodePath.join(dir, "dotfiles");
    NodeFS.mkdirSync(dotfiles);
    const real = NodePath.join(dotfiles, "settings.json");
    NodeFS.symlinkSync(real, file);
    expect(writeSetting(file, "theme", "aurora")).toEqual({ ok: true });
    expect(NodeFS.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(JSON.parse(NodeFS.readFileSync(real, "utf8"))).toEqual({ theme: "aurora" });
  });

  it("refuses to touch a damaged file", () => {
    NodeFS.writeFileSync(file, "{ nope");
    const result = writeSetting(file, "theme", "oop");
    expect(result.ok).toBe(false);
    expect(readFile()).toBe("{ nope");
    expect(NodeFS.readdirSync(dir)).toEqual(["settings.json"]);
  });
});

describe("loadStartupTheme", () => {
  it("uses the named theme, else the default for the colour level", () => {
    expect(loadStartupTheme({ theme: "aurora", level: 3, configDir: dir }).theme.name).toBe(
      "aurora",
    );
    expect(loadStartupTheme({ theme: null, level: 3, configDir: dir }).theme.name).toBe("oop");
    expect(loadStartupTheme({ theme: null, level: 1, configDir: dir }).theme.name).toBe("ansi");
  });

  it("starts light on a light terminal unless a theme was chosen", () => {
    const env = { COLORFGBG: "0;15" };
    expect(loadStartupTheme({ theme: null, level: 3, configDir: dir, env }).theme.name).toBe(
      "oop-light",
    );
    expect(loadStartupTheme({ theme: "aurora", level: 3, configDir: dir, env }).theme.name).toBe(
      "aurora",
    );
  });

  it("falls back with a warning when the theme cannot be loaded", () => {
    const started = loadStartupTheme({ theme: "gone", level: 3, configDir: dir });
    expect(started.theme.name).toBe("oop");
    expect(started.warnings).toHaveLength(1);
  });
});

describe("createThemeSwitcher", () => {
  const make = (env: NodeJS.ProcessEnv = {}) =>
    createThemeSwitcher({
      initial: createTheme("oop", BUILTIN_THEMES.oop, 3),
      level: 3,
      configDir: dir,
      settingsFile: file,
      env,
    });

  it("switches at once and saves the choice, keeping other keys", () => {
    NodeFS.writeFileSync(file, JSON.stringify({ banner: false }));
    const themes = make();
    expect(themes.current().name).toBe("oop");
    expect(themes.select("aurora")).toEqual({ ok: true, message: "테마: aurora", notes: [] });
    expect(themes.current().name).toBe("aurora");
    expect(JSON.parse(readFile())).toEqual({ banner: false, theme: "aurora" });
  });

  it("explains an unknown name in one line and changes nothing", () => {
    const themes = make();
    const result = themes.select("nope");
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("\n");
    expect(themes.current().name).toBe("oop");
    expect(NodeFS.existsSync(file)).toBe(false);
  });

  it("refuses a name with a path in it", () => {
    NodeFS.mkdirSync(NodePath.join(dir, "themes"));
    NodeFS.writeFileSync(NodePath.join(dir, "secret.json"), "{}");
    const themes = make();
    expect(themes.select("../secret").ok).toBe(false);
    expect(themes.current().name).toBe("oop");
  });

  it("still switches for this session when settings.json is damaged, and says it was not saved", () => {
    NodeFS.writeFileSync(file, "{ nope");
    const themes = make();
    const result = themes.select("sunset");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("손상");
    expect(result.notes).toHaveLength(1);
    expect(themes.current().name).toBe("sunset");
    expect(readFile()).toBe("{ nope");
  });

  it("says when OOP_THEME will win next time", () => {
    const result = make({ OOP_THEME: "ansi" }).select("sunset");
    expect(result.message).toContain("OOP_THEME");
  });

  it("lists the built-ins and the user's themes", () => {
    NodeFS.mkdirSync(NodePath.join(dir, "themes"));
    NodeFS.writeFileSync(NodePath.join(dir, "themes", "mine.json"), "{}");
    expect(make().names()).toContain("mine");
    expect(make().names()).toContain("colorblind");
  });
});

describe("runConfigCommand", () => {
  const run = (command: ConfigAction, env: NodeJS.ProcessEnv = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runConfigCommand(command, {
      paths: paths(env),
      out: (line) => void out.push(line),
      err: (line) => void err.push(line),
    });
    return { code, out, err };
  };

  it("sets and gets the workflow and pet settings", () => {
    expect(run({ action: "set", key: "pet", value: "off" }).out).toEqual(["pet = false"]);
    expect(run({ action: "set", key: "workflow", value: "off" }).out).toEqual(["workflow = false"]);
    expect(run({ action: "get", key: "pet" }).out).toEqual(["false"]);
    expect(run({ action: "set", key: "pet", value: "maybe" }).code).toBe(2);
  });

  it("prints the settings file path", () => {
    expect(run({ action: "path" })).toEqual({ code: 0, out: [file], err: [] });
  });

  it("lists every setting with its effective value and where an override came from", () => {
    NodeFS.writeFileSync(file, JSON.stringify({ banner: false }));
    const { code, out } = run({ action: "list" }, { OOP_ANIMATIONS: "0" });
    expect(code).toBe(0);
    expect(out).toEqual([
      "theme = (기본)",
      "symbols = auto",
      "animations = false (환경 변수)",
      "banner = false",
      "statusLine = auto",
      "notify = true",
      "sidebar = true",
      "workflow = true",
      "pet = true",
      "language = (기본)",
    ]);
  });

  it("gets one value", () => {
    NodeFS.writeFileSync(file, JSON.stringify({ theme: "aurora" }));
    expect(run({ action: "get", key: "theme" }).out).toEqual(["aurora"]);
    expect(run({ action: "get", key: "theme" }, { OOP_THEME: "sunset" }).out).toEqual([
      "sunset (환경 변수)",
    ]);
    expect(run({ action: "get", key: "wat" })).toMatchObject({ code: 2 });
  });

  it("sets a value and keeps the other keys of the file", () => {
    NodeFS.writeFileSync(file, JSON.stringify({ banner: false, custom: 7 }));
    expect(run({ action: "set", key: "theme", value: "colorblind" })).toEqual({
      code: 0,
      out: ["theme = colorblind"],
      err: [],
    });
    expect(run({ action: "set", key: "animations", value: "off" }).code).toBe(0);
    expect(run({ action: "set", key: "statusLine", value: "compact" }).code).toBe(0);
    expect(JSON.parse(readFile())).toEqual({
      banner: false,
      custom: 7,
      theme: "colorblind",
      animations: false,
      statusLine: "compact",
    });
  });

  it("accepts a user theme by name and rejects unknown ones and paths", () => {
    NodeFS.mkdirSync(NodePath.join(dir, "themes"));
    NodeFS.writeFileSync(NodePath.join(dir, "themes", "mine.json"), "{}");
    expect(run({ action: "set", key: "theme", value: "mine" }).code).toBe(0);
    const unknown = run({ action: "set", key: "theme", value: "nope" });
    const path = run({ action: "set", key: "theme", value: "../mine" });
    expect(unknown.code).toBe(2);
    expect(path.code).toBe(2);
    expect(JSON.parse(readFile())).toEqual({ theme: "mine" });
  });

  it("rejects values a key cannot take, without writing", () => {
    expect(run({ action: "set", key: "symbols", value: "emoji" }).code).toBe(2);
    expect(run({ action: "set", key: "banner", value: "maybe" }).code).toBe(2);
    expect(run({ action: "set", key: "nope", value: "x" }).code).toBe(2);
    expect(NodeFS.existsSync(file)).toBe(false);
  });

  it("warns that an environment variable still wins after a set", () => {
    const { code, err } = run(
      { action: "set", key: "theme", value: "aurora" },
      { OOP_THEME: "ansi" },
    );
    expect(code).toBe(0);
    expect(err.join("\n")).toContain("환경 변수");
  });

  it("will not write to a damaged file and leaves it as it was", () => {
    NodeFS.writeFileSync(file, "{ nope");
    const { code, err } = run({ action: "set", key: "theme", value: "oop" });
    expect(code).toBe(1);
    expect(err.length).toBeGreaterThan(0);
    expect(readFile()).toBe("{ nope");
    // Reading it still works, on defaults, with the warning.
    const listed = run({ action: "get", key: "banner" });
    expect(listed.out).toEqual(["true"]);
    expect(listed.err).toHaveLength(1);
  });
});

describe("language setting", () => {
  afterEach(() => setLanguage("ko"));

  it("accepts en and ko and ignores anything else with a warning", () => {
    NodeFS.writeFileSync(file, JSON.stringify({ language: "en" }));
    expect(readSettings(file).values.language).toBe("en");
    NodeFS.writeFileSync(file, JSON.stringify({ language: "fr" }));
    const read = readSettings(file);
    expect(read.values.language).toBeUndefined();
    expect(read.warnings[0]).toContain("language");
  });

  it("sets and lists language, in English when the language is English", () => {
    setLanguage("en");
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      paths: paths(),
      out: (l: string) => void out.push(l),
      err: (l: string) => void err.push(l),
    };
    expect(runConfigCommand({ action: "set", key: "language", value: "en" }, io)).toBe(0);
    expect(JSON.parse(readFile()).language).toBe("en");
    expect(runConfigCommand({ action: "set", key: "language", value: "fr" }, io)).toBe(2);
    expect(err).toEqual(["language only accepts en | ko."]);
    out.length = 0;
    expect(runConfigCommand({ action: "list" }, io)).toBe(0);
    expect(out[0]).toBe("theme = (default)");
    expect(out.at(-1)).toBe("language = en");
  });
});
