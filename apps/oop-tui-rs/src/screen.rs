//! A full-body screen that replaces the conversation while it is open (`/stats`, `/crew`,
//! `/provider`): it draws in the body under the header, takes every key and the wheel, and closes
//! itself. The app holds at most one.

use crate::app::App;
use ratatui::Frame;
use ratatui::crossterm::event::KeyEvent;
use ratatui::layout::Rect;

pub trait Screen {
    fn draw(&self, frame: &mut Frame, area: Rect, app: &App);
    /// True when the screen is done and should close. It may open another one through `app.screen`.
    fn key(&mut self, key: KeyEvent, app: &mut App) -> bool;
    fn wheel(&mut self, _up: bool) {}
    /// The status line while the screen is up.
    fn hint(&self) -> String;
}
