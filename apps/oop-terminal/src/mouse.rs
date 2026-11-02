//! 마우스 리포트 인코딩 (X10 / SGR 1006, 버튼 드래그 1002, 전체 모션 1003).

use alacritty_terminal::term::TermMode;
use winit::keyboard::ModifiersState;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Middle,
    Right,
    WheelUp,
    WheelDown,
    /// 버튼 없이 움직임 (1003)
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Press,
    Release,
    Motion,
}

#[derive(Clone, Copy, Debug)]
pub struct Report {
    pub button: Button,
    pub kind: Kind,
    /// 0 기준 셀 좌표
    pub col: usize,
    pub row: usize,
    pub mods: ModifiersState,
}

pub fn reporting(mode: TermMode) -> bool {
    mode.intersects(TermMode::MOUSE_MODE)
}

pub fn encode(report: &Report, mode: TermMode) -> Option<Vec<u8>> {
    if !reporting(mode) {
        return None;
    }
    let sgr = mode.contains(TermMode::SGR_MOUSE);
    let mut code: u32 = match report.button {
        Button::Left => 0,
        Button::Middle => 1,
        Button::Right => 2,
        Button::WheelUp => 64,
        Button::WheelDown => 65,
        Button::None => 3,
    };
    match report.kind {
        Kind::Press => {
            if matches!(report.button, Button::None) {
                return None;
            }
        }
        Kind::Release => {
            if matches!(
                report.button,
                Button::WheelUp | Button::WheelDown | Button::None
            ) {
                return None;
            }
            if !sgr {
                code = 3;
            }
        }
        Kind::Motion => {
            let held = !matches!(report.button, Button::None);
            if held && !mode.intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION) {
                return None;
            }
            if !held && !mode.contains(TermMode::MOUSE_MOTION) {
                return None;
            }
            code += 32;
        }
    }
    if report.mods.shift_key() {
        code += 4;
    }
    if report.mods.alt_key() {
        code += 8;
    }
    if report.mods.control_key() {
        code += 16;
    }
    let (x, y) = (report.col + 1, report.row + 1);
    if sgr {
        let fin = if report.kind == Kind::Release {
            'm'
        } else {
            'M'
        };
        return Some(format!("\x1b[<{code};{x};{y}{fin}").into_bytes());
    }
    // 레거시 X10: 좌표는 +32, 223 초과는 표현 불가
    if x > 223 || y > 223 {
        return None;
    }
    Some(vec![
        0x1b,
        b'[',
        b'M',
        (code + 32) as u8,
        (x + 32) as u8,
        (y + 32) as u8,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    const SGR_DRAG: TermMode = TermMode::MOUSE_REPORT_CLICK
        .union(TermMode::MOUSE_DRAG)
        .union(TermMode::SGR_MOUSE);

    fn rep(button: Button, kind: Kind, col: usize, row: usize, mods: ModifiersState) -> Report {
        Report {
            button,
            kind,
            col,
            row,
            mods,
        }
    }

    #[test]
    fn nothing_when_no_mouse_mode() {
        let r = rep(Button::Left, Kind::Press, 0, 0, ModifiersState::empty());
        assert_eq!(encode(&r, TermMode::NONE), None);
    }

    #[test]
    fn sgr_press_and_release() {
        let m = ModifiersState::empty();
        assert_eq!(
            encode(&rep(Button::Left, Kind::Press, 9, 4, m), SGR_DRAG),
            Some(b"\x1b[<0;10;5M".to_vec())
        );
        assert_eq!(
            encode(&rep(Button::Left, Kind::Release, 9, 4, m), SGR_DRAG),
            Some(b"\x1b[<0;10;5m".to_vec())
        );
        assert_eq!(
            encode(&rep(Button::Right, Kind::Press, 0, 0, m), SGR_DRAG),
            Some(b"\x1b[<2;1;1M".to_vec())
        );
    }

    #[test]
    fn sgr_drag_reports_motion_with_button_held() {
        let m = ModifiersState::empty();
        assert_eq!(
            encode(&rep(Button::Left, Kind::Motion, 11, 2, m), SGR_DRAG),
            Some(b"\x1b[<32;12;3M".to_vec())
        );
        // 버튼 없는 모션은 1003에서만
        assert_eq!(
            encode(&rep(Button::None, Kind::Motion, 1, 1, m), SGR_DRAG),
            None
        );
        let any = SGR_DRAG | TermMode::MOUSE_MOTION;
        assert_eq!(
            encode(&rep(Button::None, Kind::Motion, 1, 1, m), any),
            Some(b"\x1b[<35;2;2M".to_vec())
        );
    }

    #[test]
    fn click_only_mode_ignores_drag() {
        let click = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        let r = rep(Button::Left, Kind::Motion, 1, 1, ModifiersState::empty());
        assert_eq!(encode(&r, click), None);
    }

    #[test]
    fn wheel_and_modifiers() {
        let up = rep(Button::WheelUp, Kind::Press, 0, 0, ModifiersState::empty());
        assert_eq!(encode(&up, SGR_DRAG), Some(b"\x1b[<64;1;1M".to_vec()));
        let down = rep(
            Button::WheelDown,
            Kind::Press,
            0,
            0,
            ModifiersState::CONTROL | ModifiersState::ALT,
        );
        assert_eq!(encode(&down, SGR_DRAG), Some(b"\x1b[<89;1;1M".to_vec()));
        assert_eq!(
            encode(
                &rep(
                    Button::WheelUp,
                    Kind::Release,
                    0,
                    0,
                    ModifiersState::empty()
                ),
                SGR_DRAG
            ),
            None
        );
    }

    #[test]
    fn legacy_x10_encoding_and_range_limit() {
        let legacy = TermMode::MOUSE_REPORT_CLICK;
        let m = ModifiersState::empty();
        assert_eq!(
            encode(&rep(Button::Left, Kind::Press, 0, 0, m), legacy),
            Some(vec![0x1b, b'[', b'M', 32, 33, 33])
        );
        assert_eq!(
            encode(&rep(Button::Left, Kind::Release, 0, 0, m), legacy),
            Some(vec![0x1b, b'[', b'M', 35, 33, 33])
        );
        assert_eq!(
            encode(&rep(Button::Left, Kind::Press, 300, 0, m), legacy),
            None
        );
        // SGR은 큰 좌표도 가능
        assert!(encode(&rep(Button::Left, Kind::Press, 300, 0, m), SGR_DRAG).is_some());
    }
}
