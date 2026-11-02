//! 키 입력 -> PTY 바이트 변환 (xterm + kitty keyboard 일부).
//!
//! winit `KeyEvent`는 직접 만들 수 없으므로 필요한 값만 `KeyInput`으로 뽑아 순수 함수로 처리한다.

use alacritty_terminal::term::TermMode;
use winit::keyboard::{Key, ModifiersState, NamedKey};

pub struct KeyInput<'a> {
    /// 수정자가 적용된 논리 키.
    pub logical: &'a Key,
    /// 수정자 없는(Shift 제외) 키. Option/Ctrl 조합의 기준 문자를 얻는 데 쓴다.
    pub base: Option<&'a Key>,
    /// 이 키가 만든 텍스트 (IME 제외).
    pub text: Option<&'a str>,
    pub mods: ModifiersState,
}

fn mod_param(mods: ModifiersState) -> u8 {
    1 + u8::from(mods.shift_key()) + 2 * u8::from(mods.alt_key()) + 4 * u8::from(mods.control_key())
}

fn has_mods(mods: ModifiersState) -> bool {
    mods.shift_key() || mods.alt_key() || mods.control_key()
}

fn csi_u(code: u32, mods: ModifiersState) -> Vec<u8> {
    if has_mods(mods) {
        format!("\x1b[{};{}u", code, mod_param(mods)).into_bytes()
    } else {
        format!("\x1b[{code}u").into_bytes()
    }
}

fn cursor_key(final_byte: char, mods: ModifiersState, app_cursor: bool) -> Vec<u8> {
    if has_mods(mods) {
        format!("\x1b[1;{}{}", mod_param(mods), final_byte).into_bytes()
    } else if app_cursor {
        format!("\x1bO{final_byte}").into_bytes()
    } else {
        format!("\x1b[{final_byte}").into_bytes()
    }
}

fn tilde_key(n: u8, mods: ModifiersState) -> Vec<u8> {
    if has_mods(mods) {
        format!("\x1b[{};{}~", n, mod_param(mods)).into_bytes()
    } else {
        format!("\x1b[{n}~").into_bytes()
    }
}

fn function_key(n: u8, mods: ModifiersState) -> Option<Vec<u8>> {
    let ss3 = |c: char| -> Vec<u8> {
        if has_mods(mods) {
            format!("\x1b[1;{}{}", mod_param(mods), c).into_bytes()
        } else {
            format!("\x1bO{c}").into_bytes()
        }
    };
    Some(match n {
        1 => ss3('P'),
        2 => ss3('Q'),
        3 => ss3('R'),
        4 => ss3('S'),
        5 => tilde_key(15, mods),
        6 => tilde_key(17, mods),
        7 => tilde_key(18, mods),
        8 => tilde_key(19, mods),
        9 => tilde_key(20, mods),
        10 => tilde_key(21, mods),
        11 => tilde_key(23, mods),
        12 => tilde_key(24, mods),
        _ => return None,
    })
}

/// Ctrl+문자 -> 제어 문자. 해당 없으면 None.
fn ctrl_byte(c: char) -> Option<u8> {
    match c {
        'a'..='z' => Some(c as u8 - b'a' + 1),
        'A'..='Z' => Some(c as u8 - b'A' + 1),
        '@' | ' ' | '2' => Some(0),
        '[' | '3' => Some(0x1b),
        '\\' | '4' => Some(0x1c),
        ']' | '5' => Some(0x1d),
        '^' | '6' => Some(0x1e),
        '_' | '/' | '7' => Some(0x1f),
        '8' | '?' => Some(0x7f),
        _ => None,
    }
}

fn first_char(key: &Key) -> Option<char> {
    match key {
        Key::Character(s) => s.chars().next(),
        _ => None,
    }
}

/// 키 입력을 PTY로 보낼 바이트로 바꾼다. `None`이면 보낼 것이 없다.
/// Cmd(Super)가 눌린 입력은 앱 단축키 몫이므로 None을 돌려준다.
pub fn encode_key(input: &KeyInput, mode: TermMode) -> Option<Vec<u8>> {
    let mods = input.mods;
    if mods.super_key() {
        return None;
    }
    let app_cursor = mode.contains(TermMode::APP_CURSOR);
    let disambiguate = mode.contains(TermMode::DISAMBIGUATE_ESC_CODES);
    let all_as_esc = mode.contains(TermMode::REPORT_ALL_KEYS_AS_ESC);

    if let Key::Named(named) = input.logical {
        if let Some(bytes) = encode_named(named, mods, app_cursor, disambiguate || all_as_esc) {
            return Some(bytes);
        }
        // Space는 Named로 오고, 일반 문자 경로에서 처리한다.
        if !matches!(named, NamedKey::Space) {
            return None;
        }
    }

    // 문자 키
    let space = matches!(input.logical, Key::Named(NamedKey::Space));
    let shown: Option<char> = if space {
        Some(' ')
    } else {
        first_char(input.logical)
    };
    let base_char = input.base.and_then(first_char).or(shown);
    let ctrl = mods.control_key();
    let alt = mods.alt_key();

    if ctrl || alt {
        let mut ch = base_char?;
        if mods.shift_key() && ch.is_ascii_lowercase() {
            ch = ch.to_ascii_uppercase();
        }
        if disambiguate || all_as_esc {
            // kitty: 수정자가 붙은 문자 키는 CSI u (코드는 소문자 기준)
            return Some(csi_u(ch.to_lowercase().next().unwrap_or(ch) as u32, mods));
        }
        let mut out = Vec::new();
        if alt {
            out.push(0x1b);
        }
        if ctrl {
            out.push(ctrl_byte(ch)?);
        } else {
            let mut buf = [0u8; 4];
            out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
        }
        return Some(out);
    }

    let text = input
        .text
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .or_else(|| shown.map(String::from))?;
    if all_as_esc {
        let ch = text.chars().next()?;
        return Some(csi_u(ch.to_lowercase().next().unwrap_or(ch) as u32, mods));
    }
    // 제어 문자(예: winit가 Enter에 "\r"를 줌)는 그대로 통과
    Some(text.into_bytes())
}

fn encode_named(
    named: &NamedKey,
    mods: ModifiersState,
    app_cursor: bool,
    kitty: bool,
) -> Option<Vec<u8>> {
    use NamedKey::*;
    let alt = mods.alt_key();
    let ctrl = mods.control_key();
    let shift = mods.shift_key();
    Some(match named {
        ArrowUp => cursor_key('A', mods, app_cursor),
        ArrowDown => cursor_key('B', mods, app_cursor),
        ArrowRight => cursor_key('C', mods, app_cursor),
        ArrowLeft => cursor_key('D', mods, app_cursor),
        Home => cursor_key('H', mods, app_cursor),
        End => cursor_key('F', mods, app_cursor),
        Insert => tilde_key(2, mods),
        Delete => tilde_key(3, mods),
        PageUp => tilde_key(5, mods),
        PageDown => tilde_key(6, mods),
        F1 => function_key(1, mods)?,
        F2 => function_key(2, mods)?,
        F3 => function_key(3, mods)?,
        F4 => function_key(4, mods)?,
        F5 => function_key(5, mods)?,
        F6 => function_key(6, mods)?,
        F7 => function_key(7, mods)?,
        F8 => function_key(8, mods)?,
        F9 => function_key(9, mods)?,
        F10 => function_key(10, mods)?,
        F11 => function_key(11, mods)?,
        F12 => function_key(12, mods)?,
        Enter => {
            if kitty && has_mods(mods) {
                csi_u(13, mods)
            } else if alt {
                b"\x1b\r".to_vec()
            } else {
                b"\r".to_vec()
            }
        }
        Tab => {
            if kitty && (ctrl || alt) {
                csi_u(9, mods)
            } else if shift {
                b"\x1b[Z".to_vec()
            } else if alt {
                b"\x1b\t".to_vec()
            } else {
                b"\t".to_vec()
            }
        }
        Backspace => {
            if kitty && has_mods(mods) && !(shift && !ctrl && !alt) {
                csi_u(127, mods)
            } else if ctrl {
                vec![0x08]
            } else if alt {
                vec![0x1b, 0x7f]
            } else {
                vec![0x7f]
            }
        }
        Escape => {
            if kitty {
                csi_u(27, mods)
            } else if alt {
                vec![0x1b, 0x1b]
            } else {
                vec![0x1b]
            }
        }
        Space => return None,
        _ => return None,
    })
}

/// 붙여넣기 텍스트를 PTY 바이트로. 브래킷 붙여넣기가 켜져 있으면 감싼다.
pub fn encode_paste(text: &str, bracketed: bool) -> Vec<u8> {
    if bracketed {
        // 종료 시퀀스를 심어 브래킷을 탈출하는 붙여넣기 방지
        let clean = text.replace("\x1b[201~", "").replace("\x1b[200~", "");
        let mut out = b"\x1b[200~".to_vec();
        out.extend_from_slice(clean.as_bytes());
        out.extend_from_slice(b"\x1b[201~");
        out
    } else {
        text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use winit::keyboard::SmolStr;

    fn ch(s: &str) -> Key {
        Key::Character(SmolStr::new(s))
    }

    fn enc(
        logical: Key,
        base: Option<Key>,
        text: Option<&str>,
        mods: ModifiersState,
        mode: TermMode,
    ) -> Option<Vec<u8>> {
        encode_key(
            &KeyInput {
                logical: &logical,
                base: base.as_ref(),
                text,
                mods,
            },
            mode,
        )
    }

    fn plain(key: Key, mods: ModifiersState) -> Option<Vec<u8>> {
        let text = if let Key::Character(s) = &key {
            Some(s.to_string())
        } else {
            None
        };
        enc(key, None, text.as_deref(), mods, TermMode::NONE)
    }

    const NONE: ModifiersState = ModifiersState::empty();

    #[test]
    fn plain_text_and_korean_pass_through() {
        assert_eq!(plain(ch("a"), NONE), Some(b"a".to_vec()));
        assert_eq!(plain(ch("한"), NONE), Some("한".as_bytes().to_vec()));
    }

    #[test]
    fn enter_tab_backspace_escape() {
        assert_eq!(
            plain(Key::Named(NamedKey::Enter), NONE),
            Some(b"\r".to_vec())
        );
        assert_eq!(plain(Key::Named(NamedKey::Tab), NONE), Some(b"\t".to_vec()));
        assert_eq!(
            plain(Key::Named(NamedKey::Tab), ModifiersState::SHIFT),
            Some(b"\x1b[Z".to_vec())
        );
        assert_eq!(
            plain(Key::Named(NamedKey::Backspace), NONE),
            Some(vec![0x7f])
        );
        assert_eq!(
            plain(Key::Named(NamedKey::Backspace), ModifiersState::ALT),
            Some(vec![0x1b, 0x7f])
        );
        assert_eq!(plain(Key::Named(NamedKey::Escape), NONE), Some(vec![0x1b]));
        assert_eq!(
            plain(Key::Named(NamedKey::Space), NONE),
            Some(b" ".to_vec())
        );
    }

    #[test]
    fn arrows_respect_application_cursor_mode() {
        let up = Key::Named(NamedKey::ArrowUp);
        assert_eq!(
            enc(up.clone(), None, None, NONE, TermMode::NONE),
            Some(b"\x1b[A".to_vec())
        );
        assert_eq!(
            enc(up.clone(), None, None, NONE, TermMode::APP_CURSOR),
            Some(b"\x1bOA".to_vec())
        );
        // 수정자가 있으면 항상 CSI 1;m
        assert_eq!(
            enc(
                up,
                None,
                None,
                ModifiersState::CONTROL,
                TermMode::APP_CURSOR
            ),
            Some(b"\x1b[1;5A".to_vec())
        );
    }

    #[test]
    fn modified_navigation_keys() {
        assert_eq!(
            plain(Key::Named(NamedKey::ArrowRight), ModifiersState::ALT),
            Some(b"\x1b[1;3C".to_vec())
        );
        assert_eq!(
            plain(
                Key::Named(NamedKey::ArrowLeft),
                ModifiersState::SHIFT | ModifiersState::CONTROL
            ),
            Some(b"\x1b[1;6D".to_vec())
        );
        assert_eq!(
            plain(Key::Named(NamedKey::Delete), NONE),
            Some(b"\x1b[3~".to_vec())
        );
        assert_eq!(
            plain(Key::Named(NamedKey::PageUp), NONE),
            Some(b"\x1b[5~".to_vec())
        );
        assert_eq!(
            plain(Key::Named(NamedKey::Home), NONE),
            Some(b"\x1b[H".to_vec())
        );
    }

    #[test]
    fn function_keys() {
        assert_eq!(
            plain(Key::Named(NamedKey::F1), NONE),
            Some(b"\x1bOP".to_vec())
        );
        assert_eq!(
            plain(Key::Named(NamedKey::F5), NONE),
            Some(b"\x1b[15~".to_vec())
        );
        assert_eq!(
            plain(Key::Named(NamedKey::F12), ModifiersState::SHIFT),
            Some(b"\x1b[24;2~".to_vec())
        );
    }

    #[test]
    fn ctrl_letters_map_to_control_codes() {
        assert_eq!(plain(ch("c"), ModifiersState::CONTROL), Some(vec![3]));
        assert_eq!(
            plain(ch("A"), ModifiersState::CONTROL | ModifiersState::SHIFT),
            Some(vec![1])
        );
        assert_eq!(plain(ch("["), ModifiersState::CONTROL), Some(vec![0x1b]));
        assert_eq!(plain(ch("/"), ModifiersState::CONTROL), Some(vec![0x1f]));
        assert_eq!(
            plain(Key::Named(NamedKey::Space), ModifiersState::CONTROL),
            Some(vec![0])
        );
        assert_eq!(plain(ch("1"), ModifiersState::CONTROL), None);
    }

    #[test]
    fn option_is_alt_and_uses_unmodified_key() {
        // macOS: Option+f는 text가 "ƒ" 이지만 터미널에서는 ESC f 여야 한다.
        let out = enc(
            ch("ƒ"),
            Some(ch("f")),
            Some("ƒ"),
            ModifiersState::ALT,
            TermMode::NONE,
        );
        assert_eq!(out, Some(b"\x1bf".to_vec()));
        let out = enc(
            ch("Ƒ"),
            Some(ch("f")),
            Some("Ƒ"),
            ModifiersState::ALT | ModifiersState::SHIFT,
            TermMode::NONE,
        );
        assert_eq!(out, Some(b"\x1bF".to_vec()));
        let out = enc(
            ch("c"),
            Some(ch("c")),
            None,
            ModifiersState::ALT | ModifiersState::CONTROL,
            TermMode::NONE,
        );
        assert_eq!(out, Some(vec![0x1b, 3]));
    }

    #[test]
    fn super_key_is_left_to_app_shortcuts() {
        assert_eq!(plain(ch("c"), ModifiersState::SUPER), None);
        assert_eq!(
            plain(Key::Named(NamedKey::ArrowLeft), ModifiersState::SUPER),
            None
        );
    }

    #[test]
    fn kitty_disambiguate_reports_modified_keys_as_csi_u() {
        let m = TermMode::DISAMBIGUATE_ESC_CODES;
        let enter = Key::Named(NamedKey::Enter);
        assert_eq!(
            enc(enter.clone(), None, None, ModifiersState::SHIFT, m),
            Some(b"\x1b[13;2u".to_vec())
        );
        assert_eq!(enc(enter, None, None, NONE, m), Some(b"\r".to_vec()));
        assert_eq!(
            enc(Key::Named(NamedKey::Escape), None, None, NONE, m),
            Some(b"\x1b[27u".to_vec())
        );
        assert_eq!(
            enc(
                ch("c"),
                Some(ch("c")),
                Some("c"),
                ModifiersState::CONTROL,
                m
            ),
            Some(b"\x1b[99;5u".to_vec())
        );
        // 수정자 없는 글자는 그대로 텍스트
        assert_eq!(enc(ch("a"), None, Some("a"), NONE, m), Some(b"a".to_vec()));
        // legacy 모드에서는 Shift+Enter가 그냥 CR
        assert_eq!(
            enc(
                Key::Named(NamedKey::Enter),
                None,
                None,
                ModifiersState::SHIFT,
                TermMode::NONE
            ),
            Some(b"\r".to_vec())
        );
    }

    #[test]
    fn paste_bracketed_wraps_and_strips_escape_attempts() {
        assert_eq!(encode_paste("hi", true), b"\x1b[200~hi\x1b[201~".to_vec());
        assert_eq!(
            encode_paste("a\x1b[201~b", true),
            b"\x1b[200~ab\x1b[201~".to_vec()
        );
        assert_eq!(encode_paste("a\r\nb\nc", false), b"a\rb\rc".to_vec());
    }
}
