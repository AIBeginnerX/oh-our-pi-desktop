//! OOP 라벤더 다크 테마. `apps/oop-tui/src/render/theme.ts` 의 `oop` 토큰에서 가져왔다.

use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, Rgb};

pub const fn rgb(hex: u32) -> Rgb {
    Rgb {
        r: (hex >> 16) as u8,
        g: (hex >> 8) as u8,
        b: hex as u8,
    }
}

/// 터미널 배경: userBg(#1e2433)/codeBg(#1a1f2c) 보다 한 단계 어두운 남보라.
pub const BACKGROUND: Rgb = rgb(0x12141f);
/// onBg 토큰
pub const FOREGROUND: Rgb = rgb(0xe5e7eb);
/// brand 토큰 (라벤더)
pub const BRAND: Rgb = rgb(0xa78bfa);
pub const BRAND_DIM: Rgb = rgb(0x7253b9);
/// border 토큰
pub const BORDER: Rgb = rgb(0x3a4256);
pub const SELECTION_BG: Rgb = rgb(0x3b2f66);
pub const SELECTION_FG: Rgb = rgb(0xf5f3ff);
pub const PREEDIT_BG: Rgb = rgb(0x2a2346);

/// ANSI 0..16. oop 토큰 (error/success/warning/info/tool/accent) 에 맞춘 값.
const ANSI: [u32; 16] = [
    0x1e2433, 0xf87171, 0x4ade80, 0xfbbf24, 0x60a5fa, 0xc084fc, 0x38bdf8, 0xcbd5e1, // normal
    0x6b7489, 0xfca5a5, 0x86efac, 0xfcd34d, 0x93c5fd, 0xd8b4fe, 0x7dd3fc, 0xf8fafc, // bright
];

/// 기본 팔레트 (0..=255 인덱스).
pub fn indexed(i: usize) -> Rgb {
    match i {
        0..=15 => rgb(ANSI[i]),
        16..=231 => {
            let n = i - 16;
            let level = |v: usize| if v == 0 { 0 } else { (55 + 40 * v) as u8 };
            Rgb {
                r: level(n / 36),
                g: level((n / 6) % 6),
                b: level(n % 6),
            }
        }
        232..=255 => {
            let v = (8 + 10 * (i - 232)) as u8;
            Rgb { r: v, g: v, b: v }
        }
        _ => BACKGROUND,
    }
}

/// OSC 4/10/11 질의에 답할 때 쓰는 인덱스(alacritty 규약: 256 fg, 257 bg, 258 cursor).
pub fn default_for_index(i: usize) -> Rgb {
    match i {
        256 => FOREGROUND,
        257 => BACKGROUND,
        258 => BRAND,
        259..=266 => dim(indexed(i - 259)),
        267 => FOREGROUND,
        268 => dim(FOREGROUND),
        _ => indexed(i),
    }
}

fn dim(c: Rgb) -> Rgb {
    mix(c, BACKGROUND, 0.34)
}

/// `a`에서 `b`쪽으로 t만큼 섞는다.
pub fn mix(a: Rgb, b: Rgb, t: f32) -> Rgb {
    let m = |x: u8, y: u8| {
        (x as f32 + (y as f32 - x as f32) * t)
            .round()
            .clamp(0.0, 255.0) as u8
    };
    Rgb {
        r: m(a.r, b.r),
        g: m(a.g, b.g),
        b: m(a.b, b.b),
    }
}

/// 셀 색상을 실제 RGB로. 프로그램이 OSC로 바꾼 값(`colors`)이 우선한다.
pub fn resolve(color: Color, colors: &Colors, dimmed: bool) -> Rgb {
    let rgb = match color {
        Color::Spec(c) => c,
        Color::Indexed(i) => colors[i as usize].unwrap_or_else(|| indexed(i as usize)),
        Color::Named(n) => {
            let idx = n as usize;
            let base = colors[idx].unwrap_or_else(|| default_for_index(idx));
            if dimmed && idx < 16 {
                return dim(base);
            }
            base
        }
    };
    if dimmed && !matches!(color, Color::Named(_)) {
        dim(rgb)
    } else {
        rgb
    }
}

pub fn to_f32(c: Rgb) -> [f32; 4] {
    [
        c.r as f32 / 255.0,
        c.g as f32 / 255.0,
        c.b as f32 / 255.0,
        1.0,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::vte::ansi::NamedColor;

    #[test]
    fn brand_matches_oop_token() {
        assert_eq!(
            BRAND,
            Rgb {
                r: 0xa7,
                g: 0x8b,
                b: 0xfa
            }
        );
        assert_eq!(rgb(0x7253b9), BRAND_DIM);
    }

    #[test]
    fn cube_and_grayscale_are_standard_xterm() {
        assert_eq!(indexed(16), Rgb { r: 0, g: 0, b: 0 });
        assert_eq!(
            indexed(231),
            Rgb {
                r: 255,
                g: 255,
                b: 255
            }
        );
        assert_eq!(indexed(196), Rgb { r: 255, g: 0, b: 0 });
        assert_eq!(indexed(232), Rgb { r: 8, g: 8, b: 8 });
        assert_eq!(
            indexed(255),
            Rgb {
                r: 238,
                g: 238,
                b: 238
            }
        );
    }

    #[test]
    fn spec_colors_pass_through_and_dim_blends_toward_background() {
        let colors = Colors::default();
        let c = Rgb {
            r: 200,
            g: 100,
            b: 50,
        };
        assert_eq!(resolve(Color::Spec(c), &colors, false), c);
        let d = resolve(Color::Spec(c), &colors, true);
        assert!(d.r < c.r && d.r > BACKGROUND.r);
    }

    #[test]
    fn named_defaults_resolve() {
        let colors = Colors::default();
        assert_eq!(
            resolve(Color::Named(NamedColor::Foreground), &colors, false),
            FOREGROUND
        );
        assert_eq!(
            resolve(Color::Named(NamedColor::Background), &colors, false),
            BACKGROUND
        );
        assert_eq!(
            resolve(Color::Named(NamedColor::Red), &colors, false),
            indexed(1)
        );
        assert_eq!(
            resolve(Color::Named(NamedColor::BrightCyan), &colors, false),
            indexed(14)
        );
    }

    #[test]
    fn osc_override_beats_default() {
        let mut colors = Colors::default();
        colors[257] = Some(Rgb { r: 1, g: 2, b: 3 });
        assert_eq!(
            resolve(Color::Named(NamedColor::Background), &colors, false),
            Rgb { r: 1, g: 2, b: 3 }
        );
    }
}
