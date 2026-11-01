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
    user_fg: hex(0xe5e7eb),
    user_bg: hex(0x1e2433),
    code_bg: hex(0x1a1f2c),
    gradient: [hex(0x7253b9), hex(0xa78bfa), hex(0x38bdf8), hex(0x34d399)],
};

/// The theme a `settings.json` name selects, and a warning when the name is not one this build has.
pub fn by_name(name: Option<&str>) -> (Theme, Option<String>) {
    match name {
        None | Some("lavender" | "oop") => (LAVENDER, None),
        Some(other) => (
            LAVENDER,
            Some(format!(
                "theme \"{other}\" is not available in oop-rs; using lavender"
            )),
        ),
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
    fn the_brand_is_lavender_not_magenta() {
        assert_eq!(LAVENDER.brand, Color::Rgb(0xa7, 0x8b, 0xfa));
        assert!(by_name(Some("oop")).1.is_none());
        assert!(by_name(Some("nope")).1.is_some());
    }
}
