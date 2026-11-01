//! Entering and leaving the terminal. `ratatui::init` takes raw mode and the alternate screen and
//! installs a panic hook that restores them, but `ratatui::restore` knows nothing of the two modes
//! this app adds: mouse reporting (the wheel scrolls the conversation) and bracketed paste. Left on,
//! the shell would print `^[[<64;10;5M` for every wheel tick after the program ends. So they are
//! turned off on every way out: the normal exit (`Drop`), a panic (the hook below, which runs
//! before the abort of a release build) and a signal (the main loop leaves through `Drop` too).

use ratatui::DefaultTerminal;
use ratatui::crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
};
use ratatui::crossterm::execute;
use std::io::{Write, stdout};

pub struct Guard;

impl Guard {
    pub fn enter() -> (Guard, DefaultTerminal) {
        let terminal = ratatui::init();
        let _ = execute!(stdout(), EnableMouseCapture, EnableBracketedPaste);
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let _ = release_modes(&mut stdout());
            previous(info);
        }));
        (Guard, terminal)
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        let _ = release_modes(&mut stdout());
        ratatui::restore();
    }
}

/// Turns the two modes off; written to any `Write` so a test can read the bytes.
pub fn release_modes(out: &mut impl Write) -> std::io::Result<()> {
    execute!(out, DisableMouseCapture, DisableBracketedPaste)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaving_turns_off_mouse_reporting_and_bracketed_paste() {
        let mut bytes = Vec::new();
        release_modes(&mut bytes).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        for off in ["?1000l", "?1002l", "?1003l", "?1006l", "?2004l"] {
            assert!(text.contains(off), "missing {off} in {text:?}");
        }
    }
}
