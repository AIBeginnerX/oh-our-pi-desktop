//! 앱 단축키 -> 동작 매핑. 플랫폼별 표를 순수 함수로 둬서 테스트한다.
//!
//! macOS: Cmd 기반. 그 밖: Ctrl+Shift 기반 (터미널 앱이 Ctrl 단독 키를 쓰므로).

use crate::layout::Dir;
use winit::keyboard::{Key, ModifiersState, NamedKey};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneKind {
    /// 기본 프로그램(oop)
    Oop,
    /// 일반 로그인 셸
    Shell,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Split(Dir, PaneKind),
    ClosePane,
    ToggleZoom,
    FocusNext,
    FocusPrev,
    /// 방향으로 가장 가까운 pane 으로 포커스 이동
    FocusDir(Dir),
    Copy,
    Paste,
    NewWindow,
    Quit,
    FontBigger,
    FontSmaller,
    FontReset,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Other,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::Mac
        } else {
            Platform::Other
        }
    }
}

fn dir_of(named: &NamedKey) -> Option<Dir> {
    match named {
        NamedKey::ArrowLeft => Some(Dir::Left),
        NamedKey::ArrowRight => Some(Dir::Right),
        NamedKey::ArrowUp => Some(Dir::Up),
        NamedKey::ArrowDown => Some(Dir::Down),
        _ => None,
    }
}

/// Shift가 눌린 상태의 기호를 기준 키로 되돌린다 (`{` -> `[`).
fn unshift(c: char) -> char {
    match c {
        '{' => '[',
        '}' => ']',
        '+' => '=',
        '_' => '-',
        _ => c.to_ascii_lowercase(),
    }
}

pub fn map(
    platform: Platform,
    logical: &Key,
    base: Option<&Key>,
    mods: ModifiersState,
) -> Option<Action> {
    let shift = mods.shift_key();
    let alt = mods.alt_key();
    let ctrl = mods.control_key();
    let sup = mods.super_key();

    // 방향 포커스 이동: mac = Cmd+Ctrl+방향, 그 외 = Ctrl+Alt+방향
    if let Key::Named(n) = logical {
        let chord = match platform {
            Platform::Mac => sup && ctrl && !alt && !shift,
            Platform::Other => ctrl && alt && !sup && !shift,
        };
        if let (true, Some(dir)) = (chord, dir_of(n)) {
            return Some(Action::FocusDir(dir));
        }
    }

    // 주 수정자: mac = Cmd(Ctrl 불가), 그 외 = Ctrl+Shift
    let primary = match platform {
        Platform::Mac => sup && !ctrl,
        Platform::Other => ctrl && shift && !sup,
    };
    if !primary {
        return None;
    }
    // mac에서 Cmd 외에 추가로 요구되는 Shift 여부 / Other에서 Shift는 이미 주 수정자의 일부
    let extra_shift = match platform {
        Platform::Mac => shift,
        Platform::Other => false,
    };

    let ch = base.or(Some(logical)).and_then(|k| match k {
        Key::Character(s) => s.chars().next().map(unshift),
        _ => None,
    });

    if let Key::Named(n) = logical {
        if let Some(dir) = dir_of(n) {
            // mac: Cmd+Alt+방향 = oop, Cmd+Alt+Shift+방향 = 셸
            // 그 외: Ctrl+Shift+방향 = oop, Ctrl+Shift+Alt+방향 = 셸
            return match platform {
                Platform::Mac if alt => Some(Action::Split(
                    dir,
                    if extra_shift {
                        PaneKind::Shell
                    } else {
                        PaneKind::Oop
                    },
                )),
                Platform::Other => Some(Action::Split(
                    dir,
                    if alt { PaneKind::Shell } else { PaneKind::Oop },
                )),
                Platform::Mac => None,
            };
        }
        if matches!(n, NamedKey::Enter) {
            return match platform {
                Platform::Mac if extra_shift && !alt => Some(Action::ToggleZoom),
                Platform::Other if !alt => Some(Action::ToggleZoom),
                _ => None,
            };
        }
        return None;
    }

    let c = ch?;
    match (platform, c) {
        // 분할
        (Platform::Mac, 'd') if !alt => Some(Action::Split(
            if extra_shift { Dir::Down } else { Dir::Right },
            PaneKind::Oop,
        )),
        (Platform::Other, 'd') if !alt => Some(Action::Split(Dir::Right, PaneKind::Oop)),
        (Platform::Other, 'e') if !alt => Some(Action::Split(Dir::Down, PaneKind::Oop)),
        // 포커스 이동
        (Platform::Mac, '[') if alt && !extra_shift => Some(Action::FocusPrev),
        (Platform::Mac, ']') if alt && !extra_shift => Some(Action::FocusNext),
        (Platform::Other, '[') if !alt => Some(Action::FocusPrev),
        (Platform::Other, ']') if !alt => Some(Action::FocusNext),
        // 일반 편집/창 동작 (Option이 섞이면 무시)
        (_, 'w') if !alt && !extra_shift => Some(Action::ClosePane),
        (_, 'c') if !alt && !extra_shift => Some(Action::Copy),
        (_, 'v') if !alt && !extra_shift => Some(Action::Paste),
        (_, 'n') if !alt && !extra_shift => Some(Action::NewWindow),
        (_, 'q') if !alt && !extra_shift => Some(Action::Quit),
        (_, '=') if !alt => Some(Action::FontBigger),
        (_, '-') if !alt => Some(Action::FontSmaller),
        (_, '0') if !alt => Some(Action::FontReset),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use winit::keyboard::SmolStr;

    #[test]
    fn directional_focus_chords() {
        let left = Key::Named(NamedKey::ArrowLeft);
        let mac = ModifiersState::SUPER | ModifiersState::CONTROL;
        assert_eq!(
            map(Platform::Mac, &left, None, mac),
            Some(Action::FocusDir(Dir::Left))
        );
        let other = ModifiersState::CONTROL | ModifiersState::ALT;
        assert_eq!(
            map(Platform::Other, &left, None, other),
            Some(Action::FocusDir(Dir::Left))
        );
        // 분할 단축키와 겹치지 않는다
        assert_eq!(
            map(
                Platform::Mac,
                &left,
                None,
                ModifiersState::SUPER | ModifiersState::ALT
            ),
            Some(Action::Split(Dir::Left, PaneKind::Oop))
        );
    }

    fn ch(s: &str) -> Key {
        Key::Character(SmolStr::new(s))
    }
    fn named(n: NamedKey) -> Key {
        Key::Named(n)
    }

    const CMD: ModifiersState = ModifiersState::SUPER;
    const SHIFT: ModifiersState = ModifiersState::SHIFT;
    const ALT: ModifiersState = ModifiersState::ALT;
    const CS: ModifiersState = ModifiersState::CONTROL.union(ModifiersState::SHIFT);

    fn mac(logical: Key, base: Option<Key>, mods: ModifiersState) -> Option<Action> {
        map(Platform::Mac, &logical, base.as_ref(), mods)
    }
    fn other(logical: Key, base: Option<Key>, mods: ModifiersState) -> Option<Action> {
        map(Platform::Other, &logical, base.as_ref(), mods)
    }

    #[test]
    fn mac_split_right_and_down() {
        assert_eq!(
            mac(ch("d"), None, CMD),
            Some(Action::Split(Dir::Right, PaneKind::Oop))
        );
        assert_eq!(
            mac(ch("D"), Some(ch("d")), CMD | SHIFT),
            Some(Action::Split(Dir::Down, PaneKind::Oop))
        );
    }

    #[test]
    fn mac_split_by_arrow_direction() {
        for (key, dir) in [
            (NamedKey::ArrowLeft, Dir::Left),
            (NamedKey::ArrowRight, Dir::Right),
            (NamedKey::ArrowUp, Dir::Up),
            (NamedKey::ArrowDown, Dir::Down),
        ] {
            assert_eq!(
                mac(named(key), None, CMD | ALT),
                Some(Action::Split(dir, PaneKind::Oop))
            );
            assert_eq!(
                mac(named(key), None, CMD | ALT | SHIFT),
                Some(Action::Split(dir, PaneKind::Shell))
            );
        }
        assert_eq!(
            mac(named(NamedKey::ArrowLeft), None, CMD),
            None,
            "Cmd+방향키 단독은 앱이 가로채지 않는다"
        );
    }

    #[test]
    fn mac_zoom_and_focus_use_unshifted_base_key() {
        assert_eq!(
            mac(named(NamedKey::Enter), None, CMD | SHIFT),
            Some(Action::ToggleZoom)
        );
        assert_eq!(mac(named(NamedKey::Enter), None, CMD), None);
        // Option+[ 는 논리 키가 “ 로 바뀌므로 base를 봐야 한다
        assert_eq!(
            mac(ch("\u{201c}"), Some(ch("[")), CMD | ALT),
            Some(Action::FocusPrev)
        );
        assert_eq!(
            mac(ch("\u{2018}"), Some(ch("]")), CMD | ALT),
            Some(Action::FocusNext)
        );
    }

    #[test]
    fn mac_edit_and_window_shortcuts() {
        assert_eq!(mac(ch("c"), None, CMD), Some(Action::Copy));
        assert_eq!(mac(ch("v"), None, CMD), Some(Action::Paste));
        assert_eq!(mac(ch("n"), None, CMD), Some(Action::NewWindow));
        assert_eq!(mac(ch("q"), None, CMD), Some(Action::Quit));
        assert_eq!(mac(ch("w"), None, CMD), Some(Action::ClosePane));
        assert_eq!(mac(ch("="), None, CMD), Some(Action::FontBigger));
        assert_eq!(mac(ch("+"), None, CMD | SHIFT), Some(Action::FontBigger));
        assert_eq!(mac(ch("-"), None, CMD), Some(Action::FontSmaller));
        assert_eq!(mac(ch("0"), None, CMD), Some(Action::FontReset));
    }

    #[test]
    fn mac_plain_keys_and_ctrl_are_not_shortcuts() {
        assert_eq!(mac(ch("c"), None, ModifiersState::CONTROL), None);
        assert_eq!(mac(ch("d"), None, ModifiersState::empty()), None);
        assert_eq!(mac(ch("d"), None, ALT), None);
        assert_eq!(mac(ch("c"), None, CMD | ModifiersState::CONTROL), None);
    }

    #[test]
    fn other_platform_uses_ctrl_shift() {
        assert_eq!(
            other(ch("D"), None, CS),
            Some(Action::Split(Dir::Right, PaneKind::Oop))
        );
        assert_eq!(
            other(ch("E"), None, CS),
            Some(Action::Split(Dir::Down, PaneKind::Oop))
        );
        assert_eq!(
            other(named(NamedKey::ArrowUp), None, CS),
            Some(Action::Split(Dir::Up, PaneKind::Oop))
        );
        assert_eq!(
            other(named(NamedKey::ArrowUp), None, CS | ALT),
            Some(Action::Split(Dir::Up, PaneKind::Shell))
        );
        assert_eq!(
            other(named(NamedKey::Enter), None, CS),
            Some(Action::ToggleZoom)
        );
        assert_eq!(other(ch("{"), Some(ch("[")), CS), Some(Action::FocusPrev));
        assert_eq!(other(ch("}"), None, CS), Some(Action::FocusNext));
        assert_eq!(other(ch("C"), None, CS), Some(Action::Copy));
        assert_eq!(other(ch("V"), None, CS), Some(Action::Paste));
        assert_eq!(other(ch("W"), None, CS), Some(Action::ClosePane));
    }

    #[test]
    fn other_platform_leaves_plain_ctrl_to_the_program() {
        assert_eq!(other(ch("c"), None, ModifiersState::CONTROL), None);
        assert_eq!(other(ch("d"), None, ModifiersState::CONTROL), None);
        assert_eq!(other(ch("w"), None, ModifiersState::CONTROL), None);
    }
}
