//! The colours. One built-in theme, `lavender`: the tokens of the TypeScript terminal's default
//! `oop` theme (apps/oop-tui/src/render/theme.ts), whose brand colour is the lavender `#a78bfa` and
//! which has no magenta in it. `settings.json` may name it `lavender` or `oop`; any other name falls
//! back to it with a warning (custom theme files are not read by this build).

use ratatui::style::{Color, Style};

#[derive(Debug, Clone, Copy)]
pub struct Theme {
    pub brand: Color,
    pub brand_dim: Color,
    pub accent: Color,
    pub muted: Color,
    pub dim: Color,
    pub border: Color,
    pub success: Color,
    pub warning: Color,
    pub error: Color,
    pub tool: Color,
    pub keyword: Color,
    pub string: Color,
    pub number: Color,
    pub user_fg: Color,
    pub user_bg: Color,
    pub code_bg: Color,
    pub gradient: [Color; 4],
}

const fn hex(rgb: u32) -> Color {
    Color::Rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
}

pub const LAVENDER: Theme = Theme {
    brand: hex(0xa78bfa),
    brand_dim: hex(0x7253b9),
    accent: hex(0x38bdf8),
    muted: hex(0x9aa3b5),
    dim: hex(0x6b7489),
    border: hex(0x3a4256),
    success: hex(0x4ade80),
    warning: hex(0xfbbf24),
    error: hex(0xf87171),
    tool: hex(0xc084fc),
    keyword: hex(0xc084fc),
    string: hex(0x86efac),
    number: hex(0xfbbf24),
    user_fg: hex(0xfcd34d),
    user_bg: hex(0x1e2433),
    code_bg: hex(0x1a1f2c),
    gradient: [hex(0x7253b9), hex(0xa78bfa), hex(0x38bdf8), hex(0x34d399)],
};

/// 16-colour names only (the TypeScript terminal's `ansi` theme), so it looks the same on every
/// terminal; the one used when the terminal has 16 colours.
const ANSI: Theme = Theme {
    brand: Color::LightMagenta,
    brand_dim: Color::Magenta,
    accent: Color::Cyan,
    muted: Color::DarkGray,
    dim: Color::DarkGray,
    border: Color::DarkGray,
    success: Color::Green,
    warning: Color::Yellow,
    error: Color::Red,
    tool: Color::Magenta,
    keyword: Color::Magenta,
    string: Color::Green,
    number: Color::Yellow,
    user_fg: Color::Cyan,
    user_bg: Color::Reset,
    code_bg: Color::Reset,
    gradient: [
        Color::Magenta,
        Color::LightMagenta,
        Color::Cyan,
        Color::LightCyan,
    ],
};

/// Every colour left to the terminal: NO_COLOR. Bold, reverse and the shapes still tell things apart.
const MONO: Theme = Theme {
    brand: Color::Reset,
    brand_dim: Color::Reset,
    accent: Color::Reset,
    muted: Color::Reset,
    dim: Color::Reset,
    border: Color::Reset,
    success: Color::Reset,
    warning: Color::Reset,
    error: Color::Reset,
    tool: Color::Reset,
    keyword: Color::Reset,
    string: Color::Reset,
    number: Color::Reset,
    user_fg: Color::Reset,
    user_bg: Color::Reset,
    code_bg: Color::Reset,
    gradient: [Color::Reset; 4],
};

/// How many colours the terminal takes: 0 none, 1 sixteen, 2 256, 3 truecolor. The same rules, in
/// the same order, as `detectColorLevel` of the TypeScript terminal.
pub fn color_level(env: impl Fn(&str) -> Option<String>, is_tty: bool) -> u8 {
    let set = |name: &str| env(name).filter(|v| !v.is_empty());
    if let Some(forced) = env("FORCE_COLOR") {
        match forced.trim() {
            "0" => return 0,
            "1" => return 1,
            "2" => return 2,
            "3" => return 3,
            _ => {}
        }
    }
    if set("NO_COLOR").is_some() || env("TERM").as_deref() == Some("dumb") || !is_tty {
        return 0;
    }
    let colorterm = set("COLORTERM").map(|v| v.to_lowercase());
    if matches!(colorterm.as_deref(), Some("truecolor" | "24bit")) || set("WT_SESSION").is_some() {
        return 3;
    }
    if set("TERM").is_some_and(|t| t.contains("-256color")) {
        return 2;
    }
    1
}

/// The nearest cell of the 6x6x6 colour cube or the grey ramp for an RGB colour.
pub(crate) fn indexed(r: u8, g: u8, b: u8) -> u8 {
    let cube = |v: u8| -> u8 {
        match v {
            0..=47 => 0,
            48..=114 => 1,
            v => (v - 35) / 40,
        }
    };
    let (cr, cg, cb) = (cube(r), cube(g), cube(b));
    if cr == cg && cg == cb {
        let grey = (u16::from(r) + u16::from(g) + u16::from(b)) / 3;
        if grey > 8 && grey < 238 {
            return 232 + ((grey - 8) / 10).min(23) as u8;
        }
    }
    16 + 36 * cr + 6 * cg + cb
}

impl Theme {
    /// The theme as the terminal's colour level shows it: as is for truecolor, folded into the
    /// 256-colour palette, the 16-colour theme, or no colour at all.
    pub fn for_level(self, level: u8) -> Theme {
        let fold = |c: Color| match c {
            Color::Rgb(r, g, b) => Color::Indexed(indexed(r, g, b)),
            other => other,
        };
        match level {
            0 => MONO,
            1 => ANSI,
            2 => Theme {
                brand: fold(self.brand),
                brand_dim: fold(self.brand_dim),
                accent: fold(self.accent),
                muted: fold(self.muted),
                dim: fold(self.dim),
                border: fold(self.border),
                success: fold(self.success),
                warning: fold(self.warning),
                error: fold(self.error),
                tool: fold(self.tool),
                keyword: fold(self.keyword),
                string: fold(self.string),
                number: fold(self.number),
                user_fg: fold(self.user_fg),
                user_bg: fold(self.user_bg),
                code_bg: fold(self.code_bg),
                gradient: self.gradient.map(fold),
            },
            _ => self,
        }
    }

    /// Whether `user_bg` paints behind text: not at 16 colours or with no colour.
    pub fn fills_user(&self) -> bool {
        self.user_bg != Color::Reset
    }
}

/// The built-in themes, in the order `/theme` lists them (the TypeScript terminal's
/// `BUILTIN_THEME_NAMES`). `oop` is `LAVENDER`.
pub const BUILTIN_NAMES: [&str; 6] = ["oop", "oop-light", "aurora", "sunset", "colorblind", "ansi"];

const OOP_LIGHT: Theme = Theme {
    brand: hex(0x7253b9),
    brand_dim: hex(0x9d7fd6),
    accent: hex(0x0284c7),
    muted: hex(0x5b6478),
    dim: hex(0x8a93a6),
    border: hex(0xc3c9d6),
    success: hex(0x15803d),
    warning: hex(0xb45309),
    error: hex(0xb91c1c),
    tool: hex(0x7e22ce),
    keyword: hex(0x7e22ce),
    string: hex(0x15803d),
    number: hex(0xb45309),
    user_fg: hex(0x92400e),
    user_bg: hex(0xeef0f6),
    code_bg: hex(0xf1f3f8),
    gradient: [hex(0x7253b9), hex(0x5b6fd6), hex(0x0284c7), hex(0x059669)],
};

const AURORA: Theme = Theme {
    brand: hex(0x5eead4),
    brand_dim: hex(0x0d9488),
    accent: hex(0xa3e635),
    muted: hex(0x94a8a4),
    dim: hex(0x64776f),
    border: hex(0x2f4a45),
    success: hex(0x4ade80),
    warning: hex(0xfacc15),
    error: hex(0xfb7185),
    tool: hex(0x34d399),
    keyword: hex(0x5eead4),
    string: hex(0xbef264),
    number: hex(0xfacc15),
    user_fg: hex(0xf9a8d4),
    user_bg: hex(0x16282a),
    code_bg: hex(0x12211f),
    gradient: [hex(0x0d9488), hex(0x5eead4), hex(0xa3e635), hex(0x86efac)],
};

const SUNSET: Theme = Theme {
    brand: hex(0xfb923c),
    brand_dim: hex(0xc2410c),
    accent: hex(0xf472b6),
    muted: hex(0xb8a79a),
    dim: hex(0x85766a),
    border: hex(0x4a3a38),
    success: hex(0xa3e635),
    warning: hex(0xfde047),
    error: hex(0xfb7185),
    tool: hex(0xf472b6),
    keyword: hex(0xf472b6),
    string: hex(0xfdba74),
    number: hex(0xfde047),
    user_fg: hex(0x7dd3fc),
    user_bg: hex(0x2b2124),
    code_bg: hex(0x241b1f),
    gradient: [hex(0xf97316), hex(0xfb7185), hex(0xe879f9), hex(0xa78bfa)],
};

/// Added lines are blue and removed lines orange; nothing depends on telling red from green.
const COLORBLIND: Theme = Theme {
    brand: hex(0x56b4e9),
    brand_dim: hex(0x0072b2),
    accent: hex(0xcc79a7),
    success: hex(0x56b4e9),
    warning: hex(0xf0e442),
    error: hex(0xe69f00),
    tool: hex(0xcc79a7),
    keyword: hex(0xcc79a7),
    string: hex(0x56b4e9),
    number: hex(0xf0e442),
    user_fg: hex(0xf0e442),
    gradient: [hex(0x0072b2), hex(0x56b4e9), hex(0xcc79a7), hex(0xf0e442)],
    ..LAVENDER
};

/// A built-in theme by name. `lavender` is the old name of `oop` in this build.
pub fn builtin(name: &str) -> Option<Theme> {
    Some(match name {
        "oop" | "lavender" => LAVENDER,
        "oop-light" => OOP_LIGHT,
        "aurora" => AURORA,
        "sunset" => SUNSET,
        "colorblind" => COLORBLIND,
        "ansi" => ANSI,
        _ => return None,
    })
}

/// Whether the terminal says its background is light: only `COLORFGBG` ("fg;bg") is read, a missing
/// or odd value is "no" (`hasLightBackground` of the TypeScript terminal).
fn light_background(env: &impl Fn(&str) -> Option<String>) -> bool {
    let Some(value) = env("COLORFGBG") else {
        return false;
    };
    let last = value.rsplit(';').next().unwrap_or("");
    if last.is_empty() || last.len() > 2 || !last.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let index: u8 = last.parse().unwrap_or(0);
    index == 7 || (9..=15).contains(&index)
}

/// The theme used when none was chosen: `ansi` on 16 colours, `oop-light` on a terminal that says
/// its background is light, else `oop`.
pub fn default_name(level: u8, env: impl Fn(&str) -> Option<String>) -> &'static str {
    if level == 1 {
        "ansi"
    } else if light_background(&env) {
        "oop-light"
    } else {
        "oop"
    }
}

/// A theme as loaded: the colours, and what was wrong with the file it came from.
#[derive(Debug)]
pub struct Loaded {
    pub theme: Theme,
    pub warnings: Vec<String>,
}

/// Every token name a theme file may set; the ones this build draws nothing with are accepted all
/// the same, as the TypeScript terminal's files carry them.
const SCALAR_TOKENS: [&str; 29] = [
    "brand",
    "brandDim",
    "accent",
    "text",
    "onBg",
    "userFg",
    "muted",
    "dim",
    "border",
    "success",
    "warning",
    "error",
    "info",
    "tool",
    "thinking",
    "keyword",
    "string",
    "comment",
    "number",
    "ctxOk",
    "ctxWarn",
    "ctxHigh",
    "ctxCritical",
    "userBg",
    "codeBg",
    "diffAddBg",
    "diffAddWord",
    "diffRemoveBg",
    "diffRemoveWord",
];

const ANSI_NAMES: [(&str, Color); 16] = [
    ("black", Color::Black),
    ("red", Color::Red),
    ("green", Color::Green),
    ("yellow", Color::Yellow),
    ("blue", Color::Blue),
    ("magenta", Color::Magenta),
    ("cyan", Color::Cyan),
    ("white", Color::Gray),
    ("brightBlack", Color::DarkGray),
    ("brightRed", Color::LightRed),
    ("brightGreen", Color::LightGreen),
    ("brightYellow", Color::LightYellow),
    ("brightBlue", Color::LightBlue),
    ("brightMagenta", Color::LightMagenta),
    ("brightCyan", Color::LightCyan),
    ("brightWhite", Color::White),
];

/// `#rrggbb`, an integer 0-255 (256-colour palette), a 16-colour name, or "default"; else `None`.
pub fn parse_color(value: &serde_json::Value) -> Option<Color> {
    if let Some(number) = value.as_u64() {
        return u8::try_from(number).ok().map(Color::Indexed);
    }
    let text = value.as_str()?;
    if text == "default" {
        return Some(Color::Reset);
    }
    if let Some(hex_digits) = text.strip_prefix('#')
        && hex_digits.len() == 6
        && hex_digits.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return u32::from_str_radix(hex_digits, 16).ok().map(hex);
    }
    ANSI_NAMES
        .iter()
        .find(|(name, _)| *name == text)
        .map(|(_, color)| *color)
}

/// A theme name becomes a file name; refuse what could leave the themes folder.
pub fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 64
        && !name.starts_with('.')
        && !name
            .chars()
            .any(|c| c == '/' || c == '\\' || c == ':' || c.is_control())
}

fn describe_value(value: &serde_json::Value) -> String {
    let text = serde_json::to_string(value).unwrap_or_else(|_| value.to_string());
    if text.chars().count() > 40 {
        format!("{}…", text.chars().take(39).collect::<String>())
    } else {
        text
    }
}

/// `base` with every valid override applied; unknown keys and invalid values are skipped and
/// reported (`applyOverrides`).
fn apply_overrides(mut base: Theme, overrides: &serde_json::Value) -> (Theme, Vec<String>) {
    use crate::panels_common::{fill, s};
    let mut warnings = Vec::new();
    let Some(object) = overrides.as_object() else {
        return (
            base,
            vec![
                s(
                    "\"overrides\" must be an object, so it was ignored.",
                    "\"overrides\" 는 객체여야 해서 무시했습니다.",
                )
                .to_string(),
            ],
        );
    };
    for (key, value) in object {
        if SCALAR_TOKENS.contains(&key.as_str()) {
            let Some(color) = parse_color(value) else {
                warnings.push(fill(
                    s(
                        "\"{key}\" value {value} is not a valid colour, so it was ignored.",
                        "\"{key}\" 의 값 {value} 이(가) 올바른 색이 아니어서 무시했습니다.",
                    ),
                    &[("key", key.clone()), ("value", describe_value(value))],
                ));
                continue;
            };
            match key.as_str() {
                "brand" => base.brand = color,
                "brandDim" => base.brand_dim = color,
                "accent" => base.accent = color,
                "muted" => base.muted = color,
                "dim" => base.dim = color,
                "border" => base.border = color,
                "success" => base.success = color,
                "warning" => base.warning = color,
                "error" => base.error = color,
                "tool" => base.tool = color,
                "keyword" => base.keyword = color,
                "string" => base.string = color,
                "number" => base.number = color,
                "userFg" => base.user_fg = color,
                "userBg" => base.user_bg = color,
                "codeBg" => base.code_bg = color,
                // Valid tokens this build draws nothing with.
                _ => {}
            }
        } else if key == "gradient" || key == "agents" {
            let colors: Option<Vec<Color>> = value
                .as_array()
                .filter(|list| !list.is_empty())
                .and_then(|list| list.iter().map(parse_color).collect());
            match colors {
                None => warnings.push(fill(
                    s(
                        "\"{key}\" is not a list of valid colours, so it was ignored.",
                        "\"{key}\" 는 올바른 색의 목록이 아니어서 무시했습니다.",
                    ),
                    &[("key", key.clone())],
                )),
                Some(colors) if key == "gradient" => {
                    // The logo gradient has four stops here; a longer or shorter list is resampled.
                    let last = colors.len() - 1;
                    base.gradient = std::array::from_fn(|i| colors[(2 * i * last + 3) / 6]);
                }
                Some(_) => {}
            }
        } else {
            warnings.push(fill(
                s(
                    "Ignored unknown key \"{key}\".",
                    "알 수 없는 키 \"{key}\" 를 무시했습니다.",
                ),
                &[("key", key.clone())],
            ));
        }
    }
    (base, warnings)
}

/// A built-in theme, or `<config dir>/themes/<name>.json` shaped
/// `{ "base": "oop", "overrides": { "brand": "#ff00aa" } }`. A built-in name always means the
/// built-in. A missing `base` is `oop`; an unknown one is reported and `oop` used (`loadTheme`).
pub fn load(name: &str, config_dir: &std::path::Path) -> Result<Loaded, String> {
    use crate::panels_common::{fill, s};
    if let Some(theme) = builtin(name).filter(|_| name != "lavender") {
        return Ok(Loaded {
            theme,
            warnings: Vec::new(),
        });
    }
    if name == "lavender" {
        return Ok(Loaded {
            theme: LAVENDER,
            warnings: Vec::new(),
        });
    }
    if !is_safe_name(name) {
        return Err(fill(
            s(
                "Invalid theme name: {name}",
                "테마 이름이 올바르지 않습니다: {name}",
            ),
            &[("name", name.to_string())],
        ));
    }
    let file = config_dir.join("themes").join(format!("{name}.json"));
    let text = std::fs::read_to_string(&file).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            fill(
                s("Theme not found: {name}", "테마를 찾을 수 없습니다: {name}"),
                &[("name", name.to_string())],
            )
        } else {
            fill(
                s(
                    "Cannot read the theme file: {file}",
                    "테마 파일을 읽을 수 없습니다: {file}",
                ),
                &[("file", file.display().to_string())],
            )
        }
    })?;
    let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|_| {
        fill(
            s(
                "The theme file is not valid JSON: {file}",
                "테마 파일이 올바른 JSON이 아닙니다: {file}",
            ),
            &[("file", file.display().to_string())],
        )
    })?;
    let Some(object) = parsed.as_object() else {
        return Err(fill(
            s(
                "The theme file must be an object: {file}",
                "테마 파일은 객체여야 합니다: {file}",
            ),
            &[("file", file.display().to_string())],
        ));
    };
    let mut warnings: Vec<String> = object
        .keys()
        .filter(|key| *key != "base" && *key != "overrides")
        .map(|key| {
            fill(
                s(
                    "Ignored unknown key \"{key}\".",
                    "알 수 없는 키 \"{key}\" 를 무시했습니다.",
                ),
                &[("key", key.clone())],
            )
        })
        .collect();
    let mut base = LAVENDER;
    if let Some(value) = object.get("base") {
        match value
            .as_str()
            .filter(|n| BUILTIN_NAMES.contains(n))
            .and_then(builtin)
        {
            Some(theme) => base = theme,
            None => warnings.push(fill(
                s(
                    "\"base\" {value} is not a built-in theme, so oop is used.",
                    "\"base\" {value} 는 내장 테마가 아니어서 oop 을 씁니다.",
                ),
                &[("value", describe_value(value))],
            )),
        }
    }
    let theme = match object.get("overrides") {
        None => base,
        Some(overrides) => {
            let (theme, more) = apply_overrides(base, overrides);
            warnings.extend(more);
            theme
        }
    };
    Ok(Loaded {
        theme,
        warnings: warnings
            .into_iter()
            .map(|w| format!("{name}.json: {w}"))
            .collect(),
    })
}

/// Built-in themes, then the user's, each name once.
pub fn list_names(config_dir: &std::path::Path) -> Vec<String> {
    let mut custom: Vec<String> = std::fs::read_dir(config_dir.join("themes"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let file = entry.file_name().to_string_lossy().into_owned();
            file.strip_suffix(".json").map(str::to_string)
        })
        .filter(|name| is_safe_name(name) && !BUILTIN_NAMES.contains(&name.as_str()))
        .collect();
    custom.sort();
    BUILTIN_NAMES
        .iter()
        .map(|n| n.to_string())
        .chain(custom)
        .collect()
}

/// The theme to start with: the name from `settings.json` (`OOP_THEME` beats it), else the default
/// for the terminal. One that cannot be loaded is reported and the default used instead
/// (`loadStartupTheme`). The colour level is folded in later by `for_level`.
pub fn startup(
    name: Option<&str>,
    level: u8,
    env: impl Fn(&str) -> Option<String>,
    config_dir: &std::path::Path,
) -> (Theme, String, Vec<String>) {
    use crate::panels_common::{fill, s};
    let fallback = default_name(level, &env);
    let from_env = env("OOP_THEME")
        .map(|v| v.trim().to_string())
        .filter(|v| is_safe_name(v));
    let wanted = from_env.as_deref().or(name).unwrap_or(fallback);
    match load(wanted, config_dir) {
        Ok(loaded) => (loaded.theme, wanted.to_string(), loaded.warnings),
        Err(error) => {
            let theme = load(fallback, config_dir).map_or(LAVENDER, |l| l.theme);
            (
                theme,
                fallback.to_string(),
                vec![fill(
                    s(
                        "{error} (starting with {fallback})",
                        "{error} ({fallback} 로 시작합니다)",
                    ),
                    &[("error", error), ("fallback", fallback.to_string())],
                )],
            )
        }
    }
}

/// The marks the screen is drawn with: the TypeScript terminal's unicode set, or the ASCII set
/// `settings.json` asks for (`"symbols": "ascii"`) for terminals that cannot draw the others.
#[derive(Debug, Clone, Copy)]
pub struct Symbols {
    pub bullet: &'static str,
    pub prompt: &'static str,
    pub done: &'static str,
    pub bar: &'static str,
    pub cross: &'static str,
    pub warning: &'static str,
    pub rule: &'static str,
    /// Top-left, top-right, bottom-left, bottom-right of a rounded box.
    pub corners: [&'static str; 4],
    pub open: &'static str,
    pub idle: &'static str,
    pub busy: &'static str,
    pub spinner: [&'static str; 4],
}

pub const UNICODE: Symbols = Symbols {
    bullet: "●",
    prompt: "❯",
    done: "◇",
    bar: "│",
    cross: "✗",
    warning: "▲",
    rule: "─",
    corners: ["╭", "╮", "╰", "╯"],
    open: "▸",
    idle: "○",
    busy: "●",
    spinner: ["◒", "◐", "◓", "◑"],
};

pub const ASCII: Symbols = Symbols {
    bullet: "*",
    prompt: ">",
    done: "o",
    bar: "|",
    cross: "x",
    warning: "!",
    rule: "-",
    corners: ["+", "+", "+", "+"],
    open: ">",
    idle: "o",
    busy: "*",
    spinner: ["|", "/", "-", "\\"],
};

impl Symbols {
    pub fn pick(ascii: bool) -> Symbols {
        if ascii { ASCII } else { UNICODE }
    }
}

impl Theme {
    pub fn dim_style(&self) -> Style {
        Style::new().fg(self.dim)
    }
    pub fn muted_style(&self) -> Style {
        Style::new().fg(self.muted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_colour_level_follows_the_environment_rules() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert_eq!(color_level(env(&[("COLORTERM", "truecolor")]), true), 3);
        assert_eq!(color_level(env(&[("TERM", "xterm-256color")]), true), 2);
        assert_eq!(color_level(env(&[("TERM", "xterm")]), true), 1);
        assert_eq!(color_level(env(&[("NO_COLOR", "1")]), true), 0);
        assert_eq!(color_level(env(&[("NO_COLOR", "")]), true), 1);
        assert_eq!(color_level(env(&[("COLORTERM", "24bit")]), false), 0);
        assert_eq!(
            color_level(env(&[("FORCE_COLOR", "3"), ("NO_COLOR", "1")]), false),
            3
        );
    }

    #[test]
    fn a_theme_folds_to_the_levels_colours() {
        assert_eq!(LAVENDER.for_level(3).brand, LAVENDER.brand);
        assert!(matches!(LAVENDER.for_level(2).brand, Color::Indexed(_)));
        assert_eq!(LAVENDER.for_level(1).user_fg, Color::Cyan);
        assert_eq!(LAVENDER.for_level(0).brand, Color::Reset);
        assert!(LAVENDER.fills_user() && !LAVENDER.for_level(1).fills_user());
        assert_eq!(indexed(255, 255, 255), 231);
    }

    #[test]
    fn the_brand_is_lavender_not_magenta() {
        assert_eq!(LAVENDER.brand, Color::Rgb(0xa7, 0x8b, 0xfa));
        assert_eq!(builtin("oop").unwrap().brand, LAVENDER.brand);
        assert_eq!(builtin("lavender").unwrap().brand, LAVENDER.brand);
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("oop-rs-theme-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("themes")).unwrap();
        dir
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn the_builtin_themes_are_all_there_and_distinct() {
        for name in BUILTIN_NAMES {
            assert!(builtin(name).is_some(), "{name}");
        }
        assert!(builtin("nope").is_none());
        let brands: std::collections::HashSet<String> =
            ["oop", "oop-light", "aurora", "sunset", "colorblind"]
                .iter()
                .map(|n| format!("{:?}", builtin(n).unwrap().brand))
                .collect();
        assert!(brands.len() >= 4, "the themes differ: {brands:?}");
        assert_eq!(builtin("ansi").unwrap().brand, Color::LightMagenta);
    }

    #[test]
    fn the_default_follows_the_terminal() {
        assert_eq!(default_name(3, no_env), "oop");
        assert_eq!(default_name(1, no_env), "ansi");
        let light = |k: &str| (k == "COLORFGBG").then(|| "0;15".to_string());
        assert_eq!(default_name(3, light), "oop-light");
        let dark = |k: &str| (k == "COLORFGBG").then(|| "15;0".to_string());
        assert_eq!(default_name(3, dark), "oop");
        let odd = |k: &str| (k == "COLORFGBG").then(|| "x".to_string());
        assert_eq!(default_name(2, odd), "oop");
    }

    #[test]
    fn colours_are_read_as_the_theme_files_write_them() {
        use serde_json::json;
        assert_eq!(
            parse_color(&json!("#ff00aa")),
            Some(Color::Rgb(255, 0, 170))
        );
        assert_eq!(parse_color(&json!(141)), Some(Color::Indexed(141)));
        assert_eq!(parse_color(&json!(300)), None);
        assert_eq!(parse_color(&json!("brightRed")), Some(Color::LightRed));
        assert_eq!(parse_color(&json!("default")), Some(Color::Reset));
        assert_eq!(parse_color(&json!("#ff00a")), None);
        assert_eq!(parse_color(&json!("teal")), None);
        assert_eq!(parse_color(&json!(true)), None);
    }

    #[test]
    fn a_theme_file_is_a_base_with_overrides_and_every_fault_is_reported() {
        let dir = temp("file");
        std::fs::write(
            dir.join("themes/mine.json"),
            r##"{"base": "sunset", "overrides": {"brand": "#112233", "error": "nope", "bogus": 1, "gradient": ["#000000", "#ffffff"]}, "extra": true}"##,
        )
        .unwrap();
        let loaded = load("mine", &dir).unwrap();
        assert_eq!(loaded.theme.brand, Color::Rgb(0x11, 0x22, 0x33));
        assert_eq!(
            loaded.theme.error,
            builtin("sunset").unwrap().error,
            "a bad value keeps the base's"
        );
        assert_eq!(loaded.theme.gradient[0], Color::Rgb(0, 0, 0));
        assert_eq!(loaded.theme.gradient[3], Color::Rgb(255, 255, 255));
        assert_eq!(loaded.warnings.len(), 3, "{:?}", loaded.warnings);
        assert!(loaded.warnings.iter().all(|w| w.starts_with("mine.json: ")));
        std::fs::write(dir.join("themes/plain.json"), "{}").unwrap();
        assert_eq!(load("plain", &dir).unwrap().theme.brand, LAVENDER.brand);
        std::fs::write(dir.join("themes/odd.json"), r#"{"base": "mine"}"#).unwrap();
        assert_eq!(load("odd", &dir).unwrap().warnings.len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_theme_that_cannot_be_loaded_says_why() {
        let dir = temp("errors");
        assert!(load("missing", &dir).unwrap_err().contains("missing"));
        assert!(load("../escape", &dir).is_err());
        assert!(load(".hidden", &dir).is_err());
        std::fs::write(dir.join("themes/bad.json"), "{nope").unwrap();
        assert!(load("bad", &dir).is_err());
        std::fs::write(dir.join("themes/list.json"), "[]").unwrap();
        assert!(load("list", &dir).is_err());
        // A built-in name is the built-in even when a file of that name is there.
        std::fs::write(
            dir.join("themes/aurora.json"),
            r##"{"overrides": {"brand": "#000001"}}"##,
        )
        .unwrap();
        assert_eq!(
            load("aurora", &dir).unwrap().theme.brand,
            builtin("aurora").unwrap().brand
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_list_has_the_builtins_then_the_users_themes() {
        let dir = temp("list");
        std::fs::write(dir.join("themes/zeta.json"), "{}").unwrap();
        std::fs::write(dir.join("themes/alpha.json"), "{}").unwrap();
        std::fs::write(dir.join("themes/aurora.json"), "{}").unwrap();
        std::fs::write(dir.join("themes/notes.txt"), "").unwrap();
        let names = list_names(&dir);
        assert_eq!(names[..6], BUILTIN_NAMES);
        assert_eq!(names[6..], ["alpha", "zeta"]);
        assert_eq!(list_names(&dir.join("nowhere")).len(), 6);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_start_theme_is_the_setting_unless_the_environment_says_otherwise() {
        let dir = temp("start");
        let (theme, name, warnings) = startup(Some("aurora"), 3, no_env, &dir);
        assert_eq!((name.as_str(), warnings.len()), ("aurora", 0));
        assert_eq!(theme.brand, builtin("aurora").unwrap().brand);
        let env = |k: &str| (k == "OOP_THEME").then(|| " sunset ".to_string());
        assert_eq!(startup(Some("aurora"), 3, env, &dir).1, "sunset");
        let unsafe_env = |k: &str| (k == "OOP_THEME").then(|| "../x".to_string());
        assert_eq!(startup(Some("aurora"), 3, unsafe_env, &dir).1, "aurora");
        assert_eq!(startup(None, 1, no_env, &dir).1, "ansi");
        // A theme that cannot be loaded: the default is used and the fault is reported once.
        let (theme, name, warnings) = startup(Some("gone"), 3, no_env, &dir);
        assert_eq!((name.as_str(), warnings.len()), ("oop", 1));
        assert!(warnings[0].contains("gone") && warnings[0].contains("oop"));
        assert_eq!(theme.brand, LAVENDER.brand);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
