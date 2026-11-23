//! Keyboard and pointer input, picker navigation, scrolling, and clipboard actions.

use super::{
    App, CopyJob, Focus, KeyCode, KeyEvent, KeyModifiers, Modal, MouseEventKind, QuestionState,
    Row, Side, WHEEL_LINES, json,
};
use crate::clipboard;
use crate::commands::{self, Ctx};
use crate::input::Move;
use crate::selection::{self, End, Pos};
use crate::sidebar::{Nav, SETTLED_PAGE, Section};
use ratatui::crossterm::event::{MouseButton, MouseEvent};
use ratatui::layout::Rect;
use serde_json::Value;

impl App {
    fn flip_side(&mut self) {
        self.side_view = self.side_view.next();
    }

    /// A click on a title of the panel's tab bar shows that view.
    fn click_side_tab(&mut self, column: u16, row: u16) {
        let rect = self.side_rect.get();
        // The bar is the panel's first row, inside the border on the left and a one-cell margin.
        if row != rect.y {
            return;
        }
        let offset = usize::from(column.saturating_sub(rect.x + 2));
        if column >= rect.x + 2
            && let Some(view) = crate::panels_common::tab_at(offset)
        {
            self.side_view = Side::of(view);
            self.panel_scroll.set(0);
        }
    }

    // --- mouse, selection and copying -------------------------------------------------------

    /// The conversation row and cell under a pointer; `None` outside the conversation or over the
    /// blank rows above a short one. With `clamp`, a pointer past an edge counts as that edge.
    fn pos_at(&self, x: u16, y: u16, clamp: bool) -> Option<Pos> {
        let g = self.geo.get();
        let a = g.area;
        if a.width == 0 || a.height == 0 {
            return None;
        }
        let inside = x >= a.x && x < a.right() && y >= a.y && y < a.bottom();
        if !inside && !clamp {
            return None;
        }
        let x = x.clamp(a.x, a.right() - 1);
        let y = y.clamp(a.y, a.bottom() - 1);
        let line = usize::from(y - a.y);
        let row = if line < g.pad {
            if !clamp {
                return None;
            }
            g.start
        } else {
            g.start + line - g.pad
        };
        if g.rows == 0 {
            return None;
        }
        Some(Pos {
            row: row.min(g.rows - 1),
            col: usize::from(x - a.x),
        })
    }

    pub(super) fn on_mouse(&mut self, m: MouseEvent) {
        self.on_mouse_at(m, std::time::Instant::now());
    }

    /// `on_mouse` with the time of the event, which a double click is told by.
    pub(crate) fn on_mouse_at(&mut self, m: MouseEvent, now: std::time::Instant) {
        if crate::composer::mouse(self, m, now) {
            return;
        }
        if self.modal.is_some() {
            self.on_modal_mouse(m);
            return;
        }
        let at =
            |r: Rect| m.column >= r.x && m.column < r.right() && m.row >= r.y && m.row < r.bottom();
        match m.kind {
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                let up = m.kind == MouseEventKind::ScrollUp;
                if let Some(screen) = self.screen.as_mut() {
                    screen.wheel(up);
                    return;
                }
                if crate::replay::on_wheel(self, up) {
                    return;
                }
                // Over the right-hand panel the wheel moves the panel's body.
                if self.side_shown() && at(self.side_rect.get()) {
                    let step = WHEEL_LINES as i32;
                    self.panel_scroll
                        .set(self.panel_scroll.get() + if up { -step } else { step });
                    return;
                }
                // The panel follows the live work and windows itself; the wheel is the
                // conversation's.
                if up {
                    self.scroll_up(WHEEL_LINES)
                } else {
                    self.scroll_down(WHEEL_LINES)
                }
            }
            MouseEventKind::Down(MouseButton::Left) => {
                if crate::replay::on_click(self, m.column, m.row) {
                    self.selection.press(None);
                    return;
                }
                let list = self.list_hits.borrow().clone();
                if self.list_shown() && at(list.0) {
                    self.selection.press(None);
                    if let Some((_, index)) = list.1.iter().find(|(y, _)| *y == m.row) {
                        self.selected = *index;
                        self.focus = Focus::List;
                        self.activate_row();
                    }
                    return;
                }
                if self.side_shown() && at(self.side_rect.get()) {
                    self.selection.press(None);
                    self.click_side_tab(m.column, m.row);
                    return;
                }
                self.selection.press(self.pos_at(m.column, m.row, false));
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                let a = self.geo.get().area;
                if m.row < a.y {
                    self.scroll_up(1);
                } else if m.row >= a.bottom() {
                    self.scroll_down(1);
                }
                if let Some(pos) = self.pos_at(m.column, m.row, true) {
                    self.selection.drag(pos);
                }
            }
            MouseEventKind::Up(MouseButton::Left) => match self.selection.release() {
                End::Select => self.copy_selection(),
                End::Click | End::None => {}
            },
            _ => {}
        }
    }

    /// Queues `text` for the clipboard: OSC 52 and the platform's tool, as the main loop carries out.
    pub fn copy_text(&mut self, text: String) {
        self.copy_named(text, None);
    }

    /// `copy_text`, with a name for the notice to give the text.
    pub fn copy_named(&mut self, text: String, what: Option<String>) {
        let osc52 = clipboard::osc52(&text, self.clip_plan.tmux, clipboard::OSC52_MAX_BASE64);
        self.copy_job = Some(CopyJob {
            text,
            osc52,
            plan: self.clip_plan.clone(),
            what,
        });
    }

    /// Takes the selected text from the conversation and queues it for the clipboard.
    fn copy_selection(&mut self) {
        let Some(range) = self.selection.range() else {
            return;
        };
        let width = usize::from(self.geo.get().area.width);
        let (lines, meta) = self.transcript(width).rows();
        let text = selection::text(&lines, &meta, range);
        if text.is_empty() {
            self.selection.clear();
            return;
        }
        self.copy_text(text);
    }

    /// The copy the main loop has to carry out, if any.
    pub fn take_copy(&mut self) -> Option<CopyJob> {
        self.copy_job.take()
    }

    // --- scrolling --------------------------------------------------------------------------

    pub fn scroll_up(&mut self, lines: usize) {
        let next = self.scroll.get() + lines;
        self.scroll.set(next);
        if next >= self.scroll_max.get() {
            self.request_older();
        }
    }

    pub fn scroll_down(&mut self, lines: usize) {
        self.scroll.set(self.scroll.get().saturating_sub(lines));
    }

    // --- keys -------------------------------------------------------------------------------

    pub(super) fn on_key(&mut self, key: KeyEvent) {
        self.selection.clear();
        self.pet_memory.touch(self.pet_now());
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('c')) {
            crate::composer::ctrl_c(self);
            return;
        }
        #[cfg(unix)]
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('z')) {
            self.suspend_requested = true;
            return;
        }
        // The side panel's two tabs: Shift-Tab flips them, and Tab too where the list is not open
        // to take it.
        if self.side_shown()
            && self.modal.is_none()
            && (key.code == KeyCode::BackTab || (key.code == KeyCode::Tab && !self.list_shown()))
        {
            self.flip_side();
            return;
        }
        if crate::replay::on_key(self, key) {
            return;
        }
        if let Some(mut screen) = self.screen.take() {
            if !screen.key(key, self) && self.screen.is_none() {
                self.screen = Some(screen);
            }
            return;
        }
        if self.modal.is_some() {
            self.on_modal_key(key);
            return;
        }
        if self.pane_key(key) {
            return;
        }
        match self.focus {
            Focus::Composer if self.approval().is_some() => self.on_approval_key(key),
            Focus::Composer if self.pending_input().is_some() => self.on_question_key(key),
            Focus::Composer => self.on_composer_key(key),
            Focus::List => self.on_list_key(key),
        }
    }

    pub(crate) fn on_paste(&mut self, text: &str) {
        match &mut self.modal {
            Some(Modal::Models { filter, cursor }) => {
                filter.push_str(&text.replace(['\n', '\r'], " "));
                *cursor = 0;
                return;
            }
            Some(_) => return,
            None => {}
        }
        if self.pending_input().is_some() && self.focus == Focus::Composer {
            self.question
                .text
                .push_str(&text.replace(['\n', '\r'], " "));
            return;
        }
        self.focus = Focus::Composer;
        self.input.paste(text);
    }

    fn on_composer_key(&mut self, key: KeyEvent) {
        if crate::composer::key(self, key) {
            return;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let sup = key.modifiers.contains(KeyModifiers::SUPER);
        let alt = key
            .modifiers
            .intersects(KeyModifiers::ALT | KeyModifiers::SHIFT);
        match key.code {
            KeyCode::Enter if alt => self.input.newline(),
            KeyCode::Enter => self.submit(),
            KeyCode::Char('j') if ctrl => self.input.newline(),
            KeyCode::Tab
                if key.modifiers.is_empty() && crate::composer::accept_suggestion(self) => {}
            KeyCode::Tab if self.list_shown() => self.focus = Focus::List,
            KeyCode::Esc => {
                if self.conv.busy() && self.thread_id().is_some() {
                    self.interrupt();
                } else {
                    self.focus = Focus::List;
                }
            }
            KeyCode::Char('u') if ctrl => self.input.kill_to_start(),
            KeyCode::Char('k') if ctrl => self.input.kill_to_end(),
            KeyCode::Char('w') if ctrl => self.input.kill_word(),
            KeyCode::Char('e') if ctrl => self.input.end(),
            KeyCode::Char(ch) if !ctrl && !sup => self.input.insert(ch),
            KeyCode::Backspace => self.input.backspace(),
            KeyCode::Delete => self.input.delete(),
            KeyCode::Left => {
                self.input.mv(Move::Left, false);
            }
            KeyCode::Right => {
                self.input.mv(Move::Right, false);
            }
            KeyCode::Home => {
                self.input.mv(Move::Home, false);
            }
            KeyCode::End => {
                self.input.mv(Move::End, false);
            }
            KeyCode::Up => {
                if !self.input.mv(Move::Up, false) {
                    self.input.history_back();
                }
            }
            KeyCode::Down => {
                if !self.input.mv(Move::Down, false) {
                    self.input.history_forward();
                }
            }
            KeyCode::PageUp => self.scroll_up(self.page.get().max(1)),
            KeyCode::PageDown => self.scroll_down(self.page.get().max(1)),
            _ => {}
        }
    }

    fn on_list_key(&mut self, key: KeyEvent) {
        let rows = self.rows();
        let step = |from: usize, forward: bool| -> usize {
            let mut at = from;
            loop {
                let next = if forward {
                    (at + 1).min(rows.len().saturating_sub(1))
                } else {
                    at.saturating_sub(1)
                };
                if next == at || rows.get(next).is_some_and(Row::selectable) {
                    return if rows.get(next).is_some_and(Row::selectable) {
                        next
                    } else {
                        from
                    };
                }
                at = next;
            }
        };
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.selected = step(self.selected, false),
            KeyCode::Down | KeyCode::Char('j') => self.selected = step(self.selected, true),
            KeyCode::PageUp => self.scroll_up(self.page.get().max(1)),
            KeyCode::PageDown => self.scroll_down(self.page.get().max(1)),
            KeyCode::Char('q') => self.quit = true,
            // The composer is reachable with no thread open: slash commands (`/provider`, `/theme`,
            // `/projects`, ...) need no thread, and a plain message there says to pick one first.
            KeyCode::Tab | KeyCode::Esc => self.focus = Focus::Composer,
            KeyCode::Char('n') => {
                let project = match rows.get(self.selected) {
                    Some(Row::Item(Nav::Thread(row))) => {
                        self.thread_shell(&row.id).map(|t| t.project_id.clone())
                    }
                    _ => None,
                };
                self.new_thread_in(project);
            }
            KeyCode::Enter => self.activate_row(),
            _ => {}
        }
    }

    /// Opens the selected row of the list: a thread, a new thread, a shelf, "show more".
    fn activate_row(&mut self) {
        let rows = self.rows();
        match rows.get(self.selected).cloned() {
            Some(Row::AddFolder) => self.add_folder(),
            Some(Row::Item(Nav::New { .. })) => self.new_thread(),
            Some(Row::Item(Nav::Thread(row))) => self.open_thread(&row.id),
            Some(Row::Item(Nav::Shelf { section, .. })) => match section {
                Section::Snoozed => self.view.snoozed_open = !self.view.snoozed_open,
                _ => self.view.settled_open = !self.view.settled_open,
            },
            Some(Row::Item(Nav::More { .. })) => self.view.settled_shown += SETTLED_PAGE,
            _ => {}
        }
    }

    // --- approvals and questions ------------------------------------------------------------

    fn on_approval_key(&mut self, key: KeyEvent) {
        let Some(pending) = self.approval() else {
            return;
        };
        let options = self.approval_options(&pending);
        let last = options.len().saturating_sub(1);
        self.approval_cursor = self.approval_cursor.min(last);
        let pick = match key.code {
            KeyCode::Up | KeyCode::Char('k') => {
                self.approval_cursor = self.approval_cursor.saturating_sub(1);
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.approval_cursor = (self.approval_cursor + 1).min(last);
                None
            }
            KeyCode::Char(c @ '1'..='9') => {
                let index = c as usize - '1' as usize;
                (index <= last).then_some(index)
            }
            KeyCode::Enter => Some(self.approval_cursor),
            KeyCode::Tab | KeyCode::Esc => {
                self.focus = Focus::List;
                None
            }
            KeyCode::PageUp => {
                self.scroll_up(self.page.get().max(1));
                None
            }
            KeyCode::PageDown => {
                self.scroll_down(self.page.get().max(1));
                None
            }
            _ => None,
        };
        let (Some(index), Some(thread_id)) = (pick, self.thread_id()) else {
            return;
        };
        self.answered.insert(pending.request_id.clone());
        self.approval_cursor = 0;
        let command = commands::approval_respond(
            &Ctx::fresh(),
            &thread_id,
            &pending.request_id,
            &options[index].0,
        );
        self.dispatch(command, None, Some(pending.request_id));
    }

    fn on_question_key(&mut self, key: KeyEvent) {
        let Some(pending) = self.pending_input() else {
            return;
        };
        if self.question.request_id != pending.request_id {
            self.question = QuestionState {
                request_id: pending.request_id.clone(),
                ..Default::default()
            };
        }
        let index = self.question.index.min(pending.questions.len() - 1);
        let question = &pending.questions[index];
        let own = question.options.len();
        if self.question.picked.len() != own {
            self.question.picked = vec![false; own];
        }
        let state = &mut self.question;
        match key.code {
            KeyCode::Up => state.cursor = state.cursor.saturating_sub(1),
            KeyCode::Down => state.cursor = (state.cursor + 1).min(own),
            KeyCode::Tab | KeyCode::Esc => self.focus = Focus::List,
            KeyCode::PageUp => self.scroll_up(self.page.get().max(1)),
            KeyCode::PageDown => self.scroll_down(self.page.get().max(1)),
            KeyCode::Char(' ') if question.multi_select && state.cursor < own => {
                state.picked[state.cursor] = !state.picked[state.cursor];
            }
            KeyCode::Char(ch) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                state.cursor = own;
                state.text.push(ch);
            }
            KeyCode::Backspace => {
                state.text.pop();
            }
            KeyCode::Enter => {
                let label = |i: usize| question.options[i].0.clone();
                let typed = state.text.trim().to_string();
                let answer = if question.multi_select {
                    let mut chosen: Vec<String> =
                        (0..own).filter(|i| state.picked[*i]).map(label).collect();
                    if !typed.is_empty() {
                        chosen.push(typed);
                    }
                    if chosen.is_empty() && state.cursor < own {
                        chosen.push(label(state.cursor));
                    }
                    (!chosen.is_empty()).then(|| json!(chosen))
                } else if !typed.is_empty() {
                    Some(json!(typed))
                } else if state.cursor < own {
                    Some(json!(label(state.cursor)))
                } else {
                    None
                };
                let Some(answer) = answer else { return };
                state.answers.insert(question.id.clone(), answer);
                state.index += 1;
                state.cursor = 0;
                state.text.clear();
                state.picked.clear();
                if state.index >= pending.questions.len() {
                    let answers = Value::Object(std::mem::take(&mut state.answers));
                    *state = QuestionState::default();
                    let Some(thread_id) = self.thread_id() else {
                        return;
                    };
                    self.answered.insert(pending.request_id.clone());
                    let command = commands::user_input_respond(
                        &Ctx::fresh(),
                        &thread_id,
                        &pending.request_id,
                        &answers,
                    );
                    self.dispatch(command, None, Some(pending.request_id));
                }
            }
            _ => {}
        }
    }

    // --- pickers ----------------------------------------------------------------------------

    fn on_modal_key(&mut self, key: KeyEvent) {
        let Some(modal) = self.modal.clone() else {
            return;
        };
        let count = match &modal {
            Modal::Models { filter, .. } => self.filtered_models(filter).len(),
            Modal::Mode { .. } => commands::RUNTIME_MODES.len(),
            Modal::Effort { .. } => self.effort_choices().map_or(0, |c| c.choices.len()),
            Modal::Pick(pick) => pick.items.len(),
        };
        let cursor_of = |m: &Modal| match m {
            Modal::Models { cursor, .. } | Modal::Mode { cursor } | Modal::Effort { cursor } => {
                *cursor
            }
            Modal::Pick(pick) => pick.cursor,
        };
        let cursor = cursor_of(&modal).min(count.saturating_sub(1));
        let set_cursor = |app: &mut App, to: usize| match &mut app.modal {
            Some(
                Modal::Models { cursor, .. } | Modal::Mode { cursor } | Modal::Effort { cursor },
            ) => *cursor = to,
            Some(Modal::Pick(pick)) => pick.cursor = to,
            None => {}
        };
        match key.code {
            KeyCode::Esc => self.modal = None,
            KeyCode::Up => set_cursor(self, cursor.saturating_sub(1)),
            KeyCode::Down => set_cursor(self, (cursor + 1).min(count.saturating_sub(1))),
            KeyCode::Backspace => match &mut self.modal {
                Some(Modal::Models { filter, cursor }) => {
                    filter.pop();
                    *cursor = 0;
                }
                Some(Modal::Pick(pick)) => crate::folder::backspace(pick),
                _ => {}
            },
            KeyCode::Char(ch) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                match &mut self.modal {
                    Some(Modal::Models { filter, cursor }) => {
                        filter.push(ch);
                        *cursor = 0;
                    }
                    Some(Modal::Pick(pick)) => crate::folder::type_char(pick, ch),
                    _ => {}
                }
            }
            // No path typed yet: the list waits for one instead of closing.
            KeyCode::Enter if matches!(&modal, Modal::Pick(pick) if crate::folder::waits_for_path(pick, cursor)) =>
                {}
            KeyCode::Enter if count > 0 => {
                self.modal = None;
                match modal {
                    Modal::Models { filter, .. } => {
                        if let Some(model) = self.filtered_models(&filter).get(cursor).cloned() {
                            self.pick_model(&model.instance_id, &model.slug);
                        }
                    }
                    Modal::Mode { .. } => self.set_runtime_mode(commands::RUNTIME_MODES[cursor].0),
                    Modal::Effort { .. } => {
                        if let Some(control) = self.effort_choices() {
                            let value = control.choices[cursor].0.clone();
                            self.pick_effort(&control.descriptor_id, &value);
                        }
                    }
                    Modal::Pick(pick) => crate::cmd::picked(self, &pick, cursor),
                }
            }
            _ => {}
        }
    }

    /// The mouse over an open list: a click on a row picks it, the wheel moves the pointer; the
    /// rest does nothing, so a list is never answered by a click that was meant for what is behind it.
    fn on_modal_mouse(&mut self, m: MouseEvent) {
        match m.kind {
            MouseEventKind::ScrollUp => self.on_modal_key(KeyEvent::from(KeyCode::Up)),
            MouseEventKind::ScrollDown => self.on_modal_key(KeyEvent::from(KeyCode::Down)),
            MouseEventKind::Down(MouseButton::Left) => {
                let (rect, rows) = self.modal_hits.borrow().clone();
                let inside = m.column >= rect.x
                    && m.column < rect.right()
                    && m.row >= rect.y
                    && m.row < rect.bottom();
                let Some((_, index)) = rows.iter().find(|(y, _)| inside && *y == m.row) else {
                    return;
                };
                match &mut self.modal {
                    Some(
                        Modal::Models { cursor, .. }
                        | Modal::Mode { cursor }
                        | Modal::Effort { cursor },
                    ) => *cursor = *index,
                    Some(Modal::Pick(pick)) => pick.cursor = *index,
                    None => return,
                }
                self.on_modal_key(KeyEvent::from(KeyCode::Enter));
            }
            _ => {}
        }
    }
}
