//! Closing and reopening the two side columns: the thread list on the left (`settings.sidebar`,
//! `/sidebar`) and the panel on the right (`side_open`, `/panel`). Each has a key that flips it, a
//! slash command that sets it, and a hint on the status line while it is closed. Closing keeps what
//! the pane had (the panel's view and scroll), so opening it again restores it; the middle column
//! takes the width of whatever is closed (`ui::split_columns`).

use crate::app::{Active, App, Focus};
use crate::i18n::tr;
use crate::panels_common::fill;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// The keys: Ctrl-B for the list and Ctrl-G for the panel, with F2 and F3 beside them for keyboards
/// where the Ctrl keys are taken (tmux keeps Ctrl-B). None of them is bound elsewhere in the
/// terminal, in the message box or in the TypeScript terminal.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pane {
    List,
    Panel,
}

pub fn pane_of(key: KeyEvent) -> Option<Pane> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL)
        && !key
            .modifiers
            .intersects(KeyModifiers::ALT | KeyModifiers::SUPER);
    match key.code {
        KeyCode::Char(c) if ctrl && c.eq_ignore_ascii_case(&'b') => Some(Pane::List),
        KeyCode::Char(c) if ctrl && c.eq_ignore_ascii_case(&'g') => Some(Pane::Panel),
        KeyCode::F(2) if key.modifiers.is_empty() => Some(Pane::List),
        KeyCode::F(3) if key.modifiers.is_empty() => Some(Pane::Panel),
        _ => None,
    }
}

impl App {
    /// A pane key: flips that pane. True when the key was one.
    pub(crate) fn pane_key(&mut self, key: KeyEvent) -> bool {
        match pane_of(key) {
            Some(Pane::List) => self.set_list(None),
            Some(Pane::Panel) => self.set_panel(None),
            None => return false,
        }
        true
    }

    /// Opens (`Some(true)`), closes or, with `None`, flips the thread list. The keys leave a list
    /// that is gone: focus goes to the message box.
    pub(crate) fn set_list(&mut self, open: Option<bool>) {
        let open = open.unwrap_or(!self.settings.sidebar);
        self.settings.sidebar = open;
        if !self.list_shown() && self.focus == Focus::List {
            self.focus = Focus::Composer;
        }
        self.notice = Some(if !open {
            tr("notice.listOff").into()
        } else if self.list_shown() {
            tr("notice.listOn").into()
        } else {
            too_narrow(crate::ui::SIDEBAR_MIN_COLUMNS)
        });
    }

    /// Opens, closes or flips the right panel; it comes back showing the view it had.
    pub(crate) fn set_panel(&mut self, open: Option<bool>) {
        let open = open.unwrap_or(!self.side_open);
        self.side_open = open;
        self.notice = Some(if open {
            self.panel_on_notice()
        } else {
            tr("notice.panelOff").into()
        });
    }

    /// Whether the panel has room: a thread is open and the window is wide enough (the width is
    /// not known before the first drawing, and is then assumed to fit).
    pub(crate) fn panel_fits(&self) -> bool {
        self.active != Active::None
            && (self.width.get() == 0 || self.width.get() >= crate::ui::PANEL_MIN_COLUMNS)
    }

    /// What is said when the panel is asked to open: that it is, or why it cannot be seen yet.
    pub(crate) fn panel_on_notice(&self) -> String {
        if self.active == Active::None {
            tr("notice.panelWait").into()
        } else if !self.panel_fits() {
            too_narrow(crate::ui::PANEL_MIN_COLUMNS)
        } else {
            tr("notice.panelOn").into()
        }
    }

    /// What the status line says about the side panes that are shut, so the way back is on screen.
    pub(crate) fn closed_panes_hint(&self) -> Option<String> {
        let mut parts = Vec::new();
        if !self.settings.sidebar {
            parts.push(tr("pane.openList"));
        }
        if !self.side_open {
            parts.push(tr("pane.openPanel"));
        }
        (!parts.is_empty()).then(|| parts.join(" · "))
    }
}

fn too_narrow(min: u16) -> String {
    fill(tr("notice.paneNarrow"), &[("min", min.to_string())])
}
