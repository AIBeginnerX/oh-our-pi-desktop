//! Entering and leaving the terminal. `ratatui::init` takes raw mode and the alternate screen and
//! installs a panic hook that restores them, but `ratatui::restore` knows nothing of the two modes
//! this app adds: mouse reporting (the wheel scrolls the conversation) and bracketed paste. Left on,
//! the shell would print `^[[<64;10;5M` for every wheel tick after the program ends. So they are
//! turned off on every way out: the normal exit (`Drop`), a panic (the hook below, which runs
//! before the abort of a release build) and a signal (the main loop leaves through `Drop` too).

use ratatui::DefaultTerminal;
use ratatui::crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste, KeyboardEnhancementFlags,
    PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use ratatui::crossterm::execute;
use std::io::{Write, stdout};
use std::sync::atomic::{AtomicBool, Ordering};

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

/// The kitty keyboard protocol is on (pushed by `enter`), so leaving has to pop it.
static KITTY_KEYS: AtomicBool = AtomicBool::new(false);

/// Asks the terminal to report modified keys unambiguously (kitty keyboard protocol, level 1), so
/// Cmd (Super) chords such as Cmd-C reach the app. It is asked only where the terminal says it
/// understands it (crossterm's query; the answer comes with the device attributes every terminal
/// gives, so a terminal that lacks the protocol is not waited on), always in OOP Terminal (whose
/// window is known to; it is not asked there), and never with `OOP_KITTY_KEYS=off` or on a `dumb`
/// terminal. Plain typing is unchanged by level 1: only keys with modifiers and Esc are reported
/// in the longer form, which crossterm reads.
fn enable_kitty_keys() {
    let off = std::env::var("OOP_KITTY_KEYS").is_ok_and(|v| v.eq_ignore_ascii_case("off"));
    let dumb = std::env::var("TERM").is_ok_and(|v| v == "dumb");
    let oop_terminal = std::env::var("TERM_PROGRAM").is_ok_and(|v| v == "OOP Terminal");
    if off || dumb {
        return;
    }
    let supported = oop_terminal
        || ratatui::crossterm::terminal::supports_keyboard_enhancement().unwrap_or(false);
    if supported
        && execute!(
            stdout(),
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
        )
        .is_ok()
    {
        KITTY_KEYS.store(true, Ordering::SeqCst);
    }
}

pub struct Guard {
    mouse: bool,
}

impl Guard {
    pub fn enter(mouse: bool) -> (Guard, DefaultTerminal) {
        let terminal = ratatui::init();
        let _ = execute!(stdout(), EnableBracketedPaste);
        enable_kitty_keys();
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
        if KITTY_KEYS.load(Ordering::SeqCst) {
            let _ = execute!(
                stdout(),
                PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
            );
        }
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

/// Ctrl-Z: gives the terminal back, stops the process (SIGTSTP) and, once the shell continues it
/// (SIGCONT), takes the terminal again and returns it cleared, ready to be redrawn at whatever
/// size the window has by now. The key reader is paused around it, as for a foreground command.
/// Windows has no job control: nothing is stopped there.
pub async fn suspend_process(guard: &mut Guard) -> DefaultTerminal {
    INPUT_PAUSED.store(true, Ordering::SeqCst);
    // The key reader may be inside a poll: let it see the flag before the shell takes the keys.
    tokio::time::sleep(std::time::Duration::from_millis(260)).await;
    guard.suspend();
    #[cfg(unix)]
    // SAFETY: raising a signal on this process; the default action stops it until SIGCONT.
    unsafe {
        libc::raise(libc::SIGTSTP);
    }
    let mut terminal = guard.resume();
    let _ = terminal.clear();
    INPUT_PAUSED.store(false, Ordering::SeqCst);
    terminal
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
    release(out, KITTY_KEYS.load(Ordering::SeqCst))
}

fn release(out: &mut impl Write, kitty: bool) -> std::io::Result<()> {
    write_str(out, MOUSE_OFF)?;
    write_str(out, ALT_SCROLL_RESTORE)?;
    if kitty {
        execute!(out, PopKeyboardEnhancementFlags)?;
    }
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
    fn the_keyboard_protocol_is_popped_only_when_it_was_pushed() {
        let bytes = |kitty| {
            let mut out = Vec::new();
            release(&mut out, kitty).unwrap();
            String::from_utf8(out).unwrap()
        };
        assert!(bytes(true).contains("\x1b[<1u"));
        assert!(!bytes(false).contains("\x1b[<"));
    }

    #[test]
    fn the_drag_mode_is_button_drag_only_and_turned_on_after_the_wheel_mode() {
        let one = MOUSE_ON.find("?1000h").unwrap();
        let two = MOUSE_ON.find("?1002h").unwrap();
        assert!(one < two && MOUSE_ON.contains("?1006h") && !MOUSE_ON.contains("?1003h"));
    }
}
