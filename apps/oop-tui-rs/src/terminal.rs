//! Entering and leaving the terminal. `ratatui::init` takes raw mode and the alternate screen and
//! installs a panic hook that restores them, but `ratatui::restore` knows nothing of the two modes
//! this app adds: mouse reporting (the wheel scrolls the conversation) and bracketed paste. Left on,
//! the shell would print `^[[<64;10;5M` for every wheel tick after the program ends. So they are
//! turned off on every way out: the normal exit (`Drop`), a panic (the hook below, which runs
//! before the abort of a release build) and a signal (the main loop leaves through `Drop` too).

use ratatui::DefaultTerminal;
use ratatui::crossterm::event::{DisableBracketedPaste, EnableBracketedPaste};
use ratatui::crossterm::execute;
use std::io::{Write, stdout};

/// Mouse reporting in SGR form (1006) for the wheel and for selecting text in the conversation.
/// 1000 reports presses, releases and the wheel; 1002 adds motion while a button is held, which a drag
/// needs (hover alone is never reported, unlike 1003, which would flood the app with every move).
/// 1002 is set after 1000, so a terminal that does not know it keeps the wheel and only loses the
/// drag. While it is on the terminal no longer selects text by itself: most terminals select again
/// with Shift (or Option on macOS) held.
pub const MOUSE_ON: &str = "\x1b[?1000h\x1b[?1006h\x1b[?1002h";
/// Off again, in the reverse order, and 1003 and 1015 too in case a crashed run left them on.
pub const MOUSE_OFF: &str = "\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1000l";
/// Alternate scroll mode would turn the wheel into arrow keys on the alternate screen and walk the
/// composer's history. It is switched off while the app runs; leaving, it is switched on and then
/// restored from the saved value (a terminal that knows the mode but cannot save it ignores the
/// restore, and it must not stay off after the app is gone).
const ALT_SCROLL_SAVE_OFF: &str = "\x1b[?1007s\x1b[?1007l";
const ALT_SCROLL_RESTORE: &str = "\x1b[?1007h\x1b[?1007r";

/// Set while another program has the terminal (`/provider`): the key reader leaves the input to it.
pub static INPUT_PAUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub struct Guard {
    mouse: bool,
}

impl Guard {
    pub fn enter(mouse: bool) -> (Guard, DefaultTerminal) {
        let terminal = ratatui::init();
        let _ = execute!(stdout(), EnableBracketedPaste);
        let _ = write_str(&mut stdout(), ALT_SCROLL_SAVE_OFF);
        if mouse {
            let _ = write_str(&mut stdout(), MOUSE_ON);
        }
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let _ = release_modes(&mut stdout());
            previous(info);
        }));
        (Guard { mouse }, terminal)
    }

    /// Gives the terminal back for a program that wants it: the modes off, the alternate screen left.
    pub fn suspend(&mut self) {
        let _ = release_modes(&mut stdout());
        ratatui::restore();
    }

    /// Takes the terminal again after `suspend`, with the modes as they were.
    pub fn resume(&mut self) -> DefaultTerminal {
        let terminal = ratatui::init();
        let _ = execute!(stdout(), EnableBracketedPaste);
        let _ = write_str(&mut stdout(), ALT_SCROLL_SAVE_OFF);
        if self.mouse {
            let _ = write_str(&mut stdout(), MOUSE_ON);
        }
        terminal
    }

    /// `/mouse`: wheel and drag reporting on, or off so the terminal selects text by itself again.
    pub fn set_mouse(&mut self, on: bool) {
        if on != self.mouse {
            let _ = write_str(&mut stdout(), if on { MOUSE_ON } else { MOUSE_OFF });
            self.mouse = on;
        }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        let _ = release_modes(&mut stdout());
        ratatui::restore();
    }
}

fn write_str(out: &mut impl Write, text: &str) -> std::io::Result<()> {
    out.write_all(text.as_bytes())?;
    out.flush()
}

/// Turns the modes the app added off; written to any `Write` so a test can read the bytes. Always
/// writes the mouse-off sequence, whether or not the mouse was on: it does no harm.
pub fn release_modes(out: &mut impl Write) -> std::io::Result<()> {
    write_str(out, MOUSE_OFF)?;
    write_str(out, ALT_SCROLL_RESTORE)?;
    execute!(out, DisableBracketedPaste)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaving_turns_off_mouse_reporting_and_bracketed_paste() {
        let mut bytes = Vec::new();
        release_modes(&mut bytes).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        for off in ["?1000l", "?1002l", "?1003l", "?1006l", "?2004l", "?1007r"] {
            assert!(text.contains(off), "missing {off} in {text:?}");
        }
    }

    #[test]
    fn the_drag_mode_is_button_drag_only_and_turned_on_after_the_wheel_mode() {
        let one = MOUSE_ON.find("?1000h").unwrap();
        let two = MOUSE_ON.find("?1002h").unwrap();
        assert!(one < two && MOUSE_ON.contains("?1006h") && !MOUSE_ON.contains("?1003h"));
    }
}
