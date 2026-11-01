//! Proves the terminal is restored when the program panics: enters what `oop-rs` does (raw mode,
//! alternate screen, mouse reporting, bracketed paste, through the same `Guard` logic), then panics.
//! Run it in a terminal and check the shell is usable afterwards, and that moving the wheel
//! prints nothing:
//!   cargo run --example panic_restore; stty -a | grep -o -E '[-]?(icanon|echo)'
use ratatui::crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
};
use ratatui::crossterm::execute;
use std::io::stdout;

fn main() {
    let _terminal = ratatui::init();
    let _ = execute!(stdout(), EnableMouseCapture, EnableBracketedPaste);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = execute!(stdout(), DisableMouseCapture, DisableBracketedPaste);
        previous(info);
    }));
    println!("entered the alternate screen with mouse and paste on; panicking");
    panic!("deliberate panic to check terminal restore");
}
