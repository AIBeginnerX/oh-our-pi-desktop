//! Drawing. Reads `App`, writes a ratatui frame. Layout, top to bottom: the pinned header (the OOP
//! wordmark, status, thread and folder, a rule), then the thread list on the left with the
//! conversation and the composer (or the approval or question the agent waits on) on the right,
//! then one status line. Pickers (`/model`, `/mode`, `/effort`) open over the conversation.

use crate::app::{Active, App, Focus, LinkStatus, Modal, Row};
use crate::i18n::tr;
use crate::sidebar::{Nav, Section, Status};
use crate::text::{char_width, sanitize, truncate, width, wrap};
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};

/// The wordmark of apps/oop-tui/src/render/banner.ts, byte for byte. A test reads that file and
/// fails if this copy drifts.
pub const WORDMARK: [&str; 4] = [
    " ▄██▄   ▄██▄   ████▄ ",
    "██  ██ ██  ██  ██  ██",
    "██  ██ ██  ██  ████▀ ",
    " ▀██▀   ▀██▀   ██    ",
];
const LOGO_WIDTH: u16 = 21;
const HEADER_FULL_ROWS: u16 = 7;
const HEADER_FULL_MIN_COLUMNS: u16 = 40;
const HEADER_FULL_MIN_ROWS: u16 = 30;
/// The list gives way below this width, as the TypeScript terminal's does.
const SIDEBAR_MIN_COLUMNS: u16 = 60;
const COMPOSER_MAX_ROWS: usize = 6;
const PANEL_MAX_ROWS: u16 = 14;

enum Header {
    Full,
    Compact,
    Minimal,
}

fn header_kind(app: &App, area: Rect) -> Header {
    let fits = area.width >= HEADER_FULL_MIN_COLUMNS && area.height >= HEADER_FULL_MIN_ROWS;
    match app.settings.status_line.as_str() {
        "minimal" => Header::Minimal,
        "compact" => Header::Compact,
        _ if app.settings.banner && fits => Header::Full,
        _ => Header::Compact,
    }
}

pub fn draw(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let header_kind = header_kind(app, area);
    let header_rows = if matches!(header_kind, Header::Full) {
        HEADER_FULL_ROWS
    } else {
        1
    };
    let [header, body, status] = Layout::vertical([
        Constraint::Length(header_rows),
        Constraint::Min(3),
        Constraint::Length(1),
    ])
    .areas(area);
    draw_header(frame, header, app, &header_kind);
    let main = if app.settings.sidebar && area.width >= SIDEBAR_MIN_COLUMNS {
        let list_width = (area.width / 4).clamp(24, 38).min(area.width / 2);
        let [list, main] =
            Layout::horizontal([Constraint::Length(list_width), Constraint::Min(10)]).areas(body);
        draw_list(frame, list, app);
        main
    } else {
        body
    };
    let bottom = bottom_height(app, main);
    let [conversation, bottom_area] =
        Layout::vertical([Constraint::Min(2), Constraint::Length(bottom)]).areas(main);
    draw_conversation(frame, conversation, app);
    if app.approval().is_some() && app.focus == Focus::Composer {
        draw_approval(frame, bottom_area, app);
    } else if app.pending_input().is_some() && app.focus == Focus::Composer {
        draw_question(frame, bottom_area, app);
    } else {
        draw_composer(frame, bottom_area, app);
    }
    if let Some(modal) = &app.modal {
        draw_modal(frame, conversation, app, modal);
    }
    draw_status(frame, status, app);
}

fn state_style(app: &App, key: &str) -> Style {
    let t = &app.theme;
    Style::new().fg(match key {
        "state.working" | "state.connecting" => t.brand,
        "state.waiting" => t.warning,
        "state.error" | "state.offline" => t.error,
        _ => t.success,
    })
}

fn home_relative(path: &str, home: &str) -> String {
    match path.strip_prefix(home) {
        Some("") if !home.is_empty() => "~".into(),
        Some(rest) if rest.starts_with('/') && !home.is_empty() => format!("~{rest}"),
        _ => path.to_string(),
    }
}

fn mode_label(app: &App) -> String {
    let mode = tr(&format!("mode.{}", app.runtime_mode()));
    let mode = if mode.is_empty() {
        app.runtime_mode()
    } else {
        mode.to_string()
    };
    if app.interaction_mode() == "plan" {
        format!("{mode} · plan")
    } else {
        mode
    }
}

fn model_label(app: &App) -> String {
    let model = app.model_display();
    if model.is_empty() {
        return tr("header.noModel").to_string();
    }
    match app.effort_display() {
        Some(effort) => format!("{} · {}", sanitize(&model), sanitize(&effort)),
        None => sanitize(&model),
    }
}

fn draw_header(frame: &mut Frame, area: Rect, app: &App, kind: &Header) {
    let t = &app.theme;
    let dim = t.dim_style();
    let state_key = app.state_key();
    let state = Span::styled(
        format!("{} {}", app.sym.bullet, tr(state_key)),
        state_style(app, state_key),
    );
    let thread = match (&app.active, app.conv.title()) {
        (Active::Thread(_), title) if !title.is_empty() => sanitize(title).replace('\n', " "),
        _ => tr("header.noThread").to_string(),
    };
    let title = Span::styled(
        format!("OOP v{}", app.version),
        Style::new().fg(t.brand).add_modifier(Modifier::BOLD),
    );
    let model = Span::styled(model_label(app), t.muted_style());
    match kind {
        Header::Minimal => {
            let line = Line::from(vec![title, Span::styled(" · ", dim), state]);
            frame.render_widget(Paragraph::new(line), area);
            return;
        }
        Header::Compact => {
            let line = Line::from(vec![
                title,
                Span::styled(" · ", dim),
                state,
                Span::styled(" · ", dim),
                model,
                Span::styled(" · ", dim),
                Span::styled(thread, dim),
            ]);
            frame.render_widget(Paragraph::new(line), area);
            return;
        }
        Header::Full => {}
    }
    let wide = usize::from(area.width.saturating_sub(1));
    let notes = [
        Some(title),
        Some(state),
        Some(model),
        Some(Span::styled(mode_label(app), dim)),
    ];
    let mut lines: Vec<Line> = WORDMARK
        .iter()
        .zip(t.gradient)
        .zip(notes)
        .map(|((row, color), note)| {
            let mut spans = vec![Span::styled(*row, Style::new().fg(color)), Span::raw("  ")];
            spans.extend(note);
            Line::from(spans)
        })
        .collect();
    debug_assert_eq!(WORDMARK[0].chars().count(), usize::from(LOGO_WIDTH));
    let folder = home_relative(&sanitize(&app.cwd), &app.home);
    let mut where_ = vec![
        Span::styled(tr("header.folder"), dim),
        Span::raw(truncate(&folder, wide / 2)),
    ];
    if let Some(server) = &app.server {
        where_.push(Span::styled("  ·  ", dim));
        where_.push(Span::styled(tr("header.server"), dim));
        where_.push(Span::raw(sanitize(server)));
    }
    lines.push(Line::from(vec![
        Span::styled(tr("header.thread"), dim),
        Span::styled(truncate(&thread, wide.saturating_sub(10)), dim),
    ]));
    lines.push(Line::from(where_));
    lines.push(Line::from(Span::styled(app.sym.rule.repeat(wide), dim)));
    frame.render_widget(Paragraph::new(lines), area);
}

/// The glyph and colour of a thread's status in the list.
fn status_mark(app: &App, status: Status) -> (String, ratatui::style::Color) {
    let t = &app.theme;
    let spin = || {
        let frame = if app.settings.animations {
            app.tick % app.sym.spinner.len()
        } else {
            0
        };
        app.sym.spinner[frame].to_string()
    };
    match status {
        Status::Working => (spin(), t.brand),
        Status::Approval | Status::Input => (app.sym.warning.to_string(), t.warning),
        Status::Failed => (app.sym.cross.to_string(), t.error),
        Status::Monitoring => (app.sym.bullet.to_string(), t.tool),
        Status::Woke => (
            (if app.settings.ascii { "^" } else { "↑" }).to_string(),
            t.success,
        ),
        Status::Unread => (app.sym.busy.to_string(), t.accent),
        Status::Ready => (app.sym.idle.to_string(), t.dim),
    }
}

fn section_title(section: Section) -> &'static str {
    tr(match section {
        Section::Pinned => "list.pinned",
        Section::Active => "list.active",
        Section::Snoozed => "list.snoozed",
        Section::Settled => "list.settled",
    })
}

fn draw_list(frame: &mut Frame, area: Rect, app: &App) {
    let t = &app.theme;
    let block = Block::default()
        .borders(Borders::RIGHT)
        .border_style(Style::new().fg(t.border));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let w = usize::from(inner.width);
    let rows = app.rows();
    let multiple_projects = app.shell.projects.len() > 1;
    // Each row is one or two lines; remember where the selected one is so it stays on screen.
    let mut lines: Vec<Line> = vec![Line::from(Span::styled(
        format!(" {}", tr("list.projects")),
        t.dim_style(),
    ))];
    if !app.shell.loaded {
        lines.push(Line::from(Span::styled(
            format!(" {}", tr("list.loading")),
            t.dim_style(),
        )));
    }
    let (mut selected_first, mut selected_last) = (0, 0);
    for (index, row) in rows.iter().enumerate() {
        let selected = index == app.selected && app.focus == Focus::List;
        let first = lines.len();
        let mut line_style = Style::new();
        let mut second: Option<String> = None;
        let text = match row {
            Row::AddFolder => {
                line_style = line_style.fg(t.success);
                format!(" {}", tr("list.addFolder"))
            }
            Row::Item(Nav::New { current }) => {
                line_style = line_style.fg(if *current { t.brand } else { t.success });
                if *current {
                    line_style = line_style.add_modifier(Modifier::BOLD)
                }
                format!(" {}", tr("list.new"))
            }
            Row::Item(Nav::Header(section)) => {
                line_style = line_style.fg(t.dim).add_modifier(Modifier::BOLD);
                format!(" {}", section_title(*section))
            }
            Row::Item(Nav::Shelf {
                section,
                count,
                open,
            }) => {
                line_style = line_style.fg(t.muted);
                let mark = match (open, app.settings.ascii) {
                    (true, true) => "v",
                    (true, false) => "▾",
                    (false, _) => app.sym.open,
                };
                format!(" {mark} {} ({count})", section_title(*section))
            }
            Row::Item(Nav::More { count, .. }) => {
                line_style = line_style.fg(t.dim);
                format!("   + {count} {}", tr("list.more"))
            }
            Row::Item(Nav::Thread(thread)) => {
                let (mark, color) = status_mark(app, thread.status);
                let marker = if thread.current { app.sym.open } else { " " };
                let pin = if thread.pinned { "*" } else { "" };
                let title = sanitize(&thread.title).replace('\n', " ");
                let right = if thread.since.is_empty() {
                    String::new()
                } else {
                    format!(" {}", thread.since)
                };
                let room = w.saturating_sub(width(&right) + 5 + pin.len());
                let left = format!("{marker} {mark} {pin}{}", truncate(&title, room));
                let gap = " ".repeat(w.saturating_sub(width(&left) + width(&right)));
                line_style = Style::new().fg(if thread.current { t.user_fg } else { color });
                let mut detail = Vec::new();
                if multiple_projects && let Some(project) = &thread.project {
                    detail.push(sanitize(project));
                }
                if thread.crew > 0 {
                    detail.push(format!("{} {}", thread.crew, tr("list.crew")));
                }
                if !detail.is_empty() {
                    second = Some(format!(
                        "      {}",
                        truncate(&detail.join(" · "), w.saturating_sub(6))
                    ));
                }
                format!("{left}{gap}{right}")
            }
        };
        let text = truncate(&text, w);
        let text = if selected {
            format!("{text}{}", " ".repeat(w.saturating_sub(width(&text))))
        } else {
            text
        };
        let style = if selected {
            line_style.add_modifier(Modifier::REVERSED)
        } else {
            line_style
        };
        lines.push(Line::from(Span::styled(text, style)));
        if let Some(detail) = second {
            lines.push(Line::from(Span::styled(detail, t.dim_style())));
        }
        if index == app.selected {
            (selected_first, selected_last) = (first, lines.len());
        }
    }
    let height = usize::from(inner.height);
    let skip = selected_last.saturating_sub(height).min(selected_first);
    let visible: Vec<Line> = lines.into_iter().skip(skip).take(height).collect();
    frame.render_widget(Paragraph::new(visible), inner);
}

/// The lines under the transcript that change with the clock or the session, not the thread.
fn live_lines(app: &App, w: usize) -> Vec<Line<'static>> {
    let t = &app.theme;
    let mut out = Vec::new();
    if app.conv.session().is_some_and(|s| s.status == "error")
        && let Some(error) = app.conv.session().and_then(|s| s.last_error.as_deref())
    {
        for (i, line) in wrap(&sanitize(error), w.saturating_sub(3))
            .into_iter()
            .enumerate()
        {
            let lead = if i == 0 {
                format!("{}  ", app.sym.cross)
            } else {
                "   ".into()
            };
            out.push(Line::from(Span::styled(
                format!("{lead}{line}"),
                Style::new().fg(t.error).add_modifier(Modifier::BOLD),
            )));
        }
    } else if app.conv.busy() && !app.streaming_tail() {
        let frame = if app.settings.animations {
            app.tick % app.sym.spinner.len()
        } else {
            0
        };
        out.push(Line::from(Span::styled(
            format!("  {} {}", app.sym.spinner[frame], tr("conv.working")),
            t.dim_style(),
        )));
    }
    out
}

fn placeholder(app: &App) -> Option<&'static str> {
    match &app.active {
        Active::None => Some("conv.pick"),
        Active::Draft(_) if app.conv.thread.messages.is_empty() => Some("conv.draft"),
        Active::Thread(_) if !app.conv.loaded => Some("conv.loading"),
        _ => None,
    }
}

fn draw_conversation(frame: &mut Frame, area: Rect, app: &App) {
    let w = usize::from(area.width);
    let h = usize::from(area.height);
    app.page.set(h.saturating_sub(2).max(1));
    let base = if placeholder(app).is_some() {
        Default::default()
    } else {
        app.transcript(w)
    };
    let mut tail: Vec<Line<'static>> = match placeholder(app) {
        Some(key) => vec![Line::from(Span::styled(
            format!(" {}", tr(key)),
            app.theme.dim_style(),
        ))],
        None => live_lines(app, w),
    };
    if !base.is_empty() && !tail.is_empty() {
        tail.insert(0, Line::default());
    }
    let total = base.len() + tail.len();
    let max = total.saturating_sub(h);
    // Keep what the reader is looking at where it is while lines are added above or below it.
    let (before, before_width) = app.total.get();
    let mut scroll = app.scroll.get();
    if scroll > 0 && before_width == w && total > before {
        scroll += total - before;
    }
    let scroll = scroll.min(max);
    app.scroll.set(scroll);
    app.scroll_max.set(max);
    app.total.set((total, w));

    let end = total - scroll;
    let start = end.saturating_sub(h);
    let at = |i: usize| -> Line<'static> {
        if i < base.len() {
            base[i].clone()
        } else {
            tail[i - base.len()].clone()
        }
    };
    // Short conversations sit at the bottom, next to the composer, like a chat.
    let pad = h.saturating_sub(end - start);
    let mut shown: Vec<Line> = vec![Line::default(); pad];
    shown.extend((start..end).map(at));
    frame.render_widget(Paragraph::new(shown), area);

    let t = &app.theme;
    let mut hint = |row: u16, text: String| {
        let cells = width(&text) as u16 + 2;
        if cells < area.width {
            let rect = Rect::new(area.right() - cells, area.y + row, cells, 1);
            frame.render_widget(Clear, rect);
            frame.render_widget(
                Paragraph::new(Line::from(Span::styled(format!(" {text} "), t.dim_style()))),
                rect,
            );
        }
    };
    if scroll > 0 {
        hint(area.height.saturating_sub(1), tr("conv.jump").to_string());
    }
    if scroll >= max && (app.conv.has_more || app.conv.loading_older) && total > h {
        hint(
            0,
            tr(if app.conv.loading_older {
                "conv.older"
            } else {
                "conv.hasOlder"
            })
            .to_string(),
        );
    }
}

/// Rows the bottom area takes: the panel the agent waits on, or the composer.
fn bottom_height(app: &App, main: Rect) -> u16 {
    let w = usize::from(main.width.saturating_sub(2));
    if app.focus == Focus::Composer {
        if let Some(pending) = app.approval() {
            let detail = wrap(&sanitize(&pending.detail), w).len().min(3);
            let rows = 1 + detail + app.approval_options(&pending).len();
            return (rows as u16 + 2)
                .min(PANEL_MAX_ROWS)
                .min(main.height.saturating_sub(2));
        }
        if let Some(input) = app.pending_input() {
            let index = app
                .question
                .index
                .min(input.questions.len().saturating_sub(1));
            let q = &input.questions[index];
            let text = wrap(&sanitize(&q.question), w).len().min(4);
            let rows = 1 + text + q.options.len() + 1;
            return (rows as u16 + 2)
                .min(PANEL_MAX_ROWS)
                .min(main.height.saturating_sub(2));
        }
    }
    let (rows, _) = app.input.layout(usize::from(main.width.saturating_sub(5)));
    (rows.len().clamp(1, COMPOSER_MAX_ROWS) as u16 + 2).min(main.height.saturating_sub(2).max(3))
}

fn draw_composer(frame: &mut Frame, area: Rect, app: &App) {
    let t = &app.theme;
    let focused = app.focus == Focus::Composer;
    let border = Style::new().fg(if focused { t.brand } else { t.border });
    let mut title = tr("composer.title").to_string();
    if !app.queue.is_empty() {
        title = format!("{}· {} {} ", title, app.queue.len(), tr("composer.queued"));
    }
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(border)
        .title(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let room = usize::from(inner.width).saturating_sub(3);
    let (rows, (col, row)) = app.input.layout(room.max(2));
    let visible = usize::from(inner.height).max(1);
    // Show the rows that end at the cursor's, so the cursor is always on screen.
    let first = (row + 1).saturating_sub(visible);
    let lines: Vec<Line> = rows
        .iter()
        .enumerate()
        .skip(first)
        .take(visible)
        .map(|(i, text)| {
            let lead = if i == 0 {
                format!("{} ", app.sym.prompt)
            } else {
                "  ".into()
            };
            Line::from(vec![
                Span::styled(lead, Style::new().fg(t.brand)),
                Span::raw(sanitize(text)),
            ])
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), inner);
    if focused && app.modal.is_none() {
        frame.set_cursor_position(Position::new(
            inner.x + 2 + col as u16,
            inner.y + (row - first) as u16,
        ));
    }
}

fn panel_block<'a>(app: &App, title: &'a str) -> Block<'a> {
    Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().fg(app.theme.warning))
        .title(format!(" {title} "))
}

fn option_line<'a>(app: &App, selected: bool, text: String) -> Line<'a> {
    let t = &app.theme;
    let style = if selected {
        Style::new().fg(t.brand).add_modifier(Modifier::BOLD)
    } else {
        Style::new()
    };
    let mark = if selected { app.sym.prompt } else { " " };
    Line::from(Span::styled(format!("{mark} {text}"), style))
}

fn draw_approval(frame: &mut Frame, area: Rect, app: &App) {
    let Some(pending) = app.approval() else {
        return;
    };
    let t = &app.theme;
    let block = panel_block(app, tr("panel.approval"));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let w = usize::from(inner.width);
    let mut lines = vec![Line::from(Span::styled(
        sanitize(&pending.kind),
        Style::new().fg(t.warning).add_modifier(Modifier::BOLD),
    ))];
    lines.extend(
        wrap(&sanitize(&pending.detail), w)
            .into_iter()
            .take(3)
            .map(|l| Line::from(Span::styled(l, t.muted_style()))),
    );
    for (i, (_, label)) in app.approval_options(&pending).iter().enumerate() {
        lines.push(option_line(
            app,
            i == app.approval_cursor,
            format!("{}. {}", i + 1, sanitize(label)),
        ));
    }
    frame.render_widget(Paragraph::new(lines), inner);
}

fn draw_question(frame: &mut Frame, area: Rect, app: &App) {
    let Some(input) = app.pending_input() else {
        return;
    };
    let t = &app.theme;
    let index = app.question.index.min(input.questions.len() - 1);
    let q = &input.questions[index];
    let title = format!(
        "{} {}/{}",
        tr("panel.question"),
        index + 1,
        input.questions.len()
    );
    let block = panel_block(app, &title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let w = usize::from(inner.width);
    let mut lines = Vec::new();
    if !q.header.is_empty() {
        lines.push(Line::from(Span::styled(
            sanitize(&q.header),
            Style::new().fg(t.warning).add_modifier(Modifier::BOLD),
        )));
    }
    lines.extend(
        wrap(&sanitize(&q.question), w)
            .into_iter()
            .take(4)
            .map(Line::from),
    );
    for (i, (label, description)) in q.options.iter().enumerate() {
        let picked = app.question.picked.get(i).copied().unwrap_or(false);
        let mark = if q.multi_select {
            if picked { "[x] " } else { "[ ] " }
        } else {
            ""
        };
        let extra = if description.is_empty() {
            String::new()
        } else {
            format!(" - {}", sanitize(description))
        };
        lines.push(option_line(
            app,
            i == app.question.cursor,
            truncate(
                &format!("{mark}{}{extra}", sanitize(label)),
                w.saturating_sub(2),
            ),
        ));
    }
    let own = q.options.len();
    lines.push(option_line(
        app,
        app.question.cursor == own,
        format!("{}{}", tr("panel.other"), sanitize(&app.question.text)),
    ));
    frame.render_widget(Paragraph::new(lines), inner);
}

fn draw_modal(frame: &mut Frame, area: Rect, app: &App, modal: &Modal) {
    let t = &app.theme;
    let (title, items, cursor): (&str, Vec<String>, usize) = match modal {
        Modal::Models { filter, cursor } => (
            tr("picker.model"),
            app.filtered_models(filter)
                .into_iter()
                .map(|m| {
                    format!(
                        "{}  {}  {}",
                        sanitize(&m.provider),
                        sanitize(&m.name),
                        sanitize(&m.slug)
                    )
                })
                .collect(),
            *cursor,
        ),
        Modal::Mode { cursor } => (
            tr("picker.mode"),
            crate::commands::RUNTIME_MODES
                .iter()
                .map(|(value, ..)| {
                    let here = if *value == app.runtime_mode() {
                        " ✓"
                    } else {
                        ""
                    };
                    format!("{}{here}", tr(&format!("mode.{value}")))
                })
                .collect(),
            *cursor,
        ),
        Modal::Effort { cursor } => (
            tr("picker.effort"),
            app.effort_choices()
                .map(|c| c.choices.into_iter().map(|(_, label)| label).collect())
                .unwrap_or_default(),
            *cursor,
        ),
    };
    let filter = match modal {
        Modal::Models { filter, .. } => format!(
            "{}{}",
            app.sym.prompt,
            if filter.is_empty() {
                String::new()
            } else {
                format!(" {}", sanitize(filter))
            }
        ),
        _ => String::new(),
    };
    let rows = (items.len().max(1)
        + usize::from(!filter.is_empty() || matches!(modal, Modal::Models { .. })))
    .min(usize::from(area.height.saturating_sub(2)));
    let w = area.width.min(70).max(20.min(area.width));
    let h = (rows as u16 + 2).min(area.height);
    let rect = Rect::new(
        area.x + area.width.saturating_sub(w) / 2,
        area.y + area.height.saturating_sub(h) / 2,
        w,
        h,
    );
    frame.render_widget(Clear, rect);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().fg(t.brand))
        .title(format!(" {title} "));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let mut lines: Vec<Line> = Vec::new();
    if matches!(modal, Modal::Models { .. }) {
        lines.push(Line::from(Span::styled(filter, Style::new().fg(t.brand))));
    }
    if items.is_empty() {
        lines.push(Line::from(Span::styled(tr("picker.none"), t.dim_style())));
    }
    let room = usize::from(inner.height).saturating_sub(lines.len());
    let first = (cursor + 1).saturating_sub(room.max(1));
    for (i, item) in items.iter().enumerate().skip(first).take(room) {
        lines.push(option_line(
            app,
            i == cursor,
            truncate(item, usize::from(inner.width).saturating_sub(2)),
        ));
    }
    frame.render_widget(Paragraph::new(lines), inner);
    if let Modal::Models { filter, .. } = modal {
        let x = inner.x + 2 + width(filter) as u16 + u16::from(!filter.is_empty());
        frame.set_cursor_position(Position::new(
            x.min(inner.right().saturating_sub(1)),
            inner.y,
        ));
    }
}

fn draw_status(frame: &mut Frame, area: Rect, app: &App) {
    let t = &app.theme;
    let hint = if app.modal.is_some() {
        tr(if matches!(app.modal, Some(Modal::Models { .. })) {
            "hint.modelPicker"
        } else {
            "hint.picker"
        })
    } else if app.focus == Focus::Composer && app.approval().is_some() {
        tr("hint.approval")
    } else if app.focus == Focus::Composer && app.pending_input().is_some() {
        tr("hint.question")
    } else if app.focus == Focus::List {
        tr("hint.list")
    } else if app.conv.busy() {
        tr("hint.working")
    } else {
        tr("hint.composer")
    };
    let link = match &app.link {
        LinkStatus::Online => None,
        LinkStatus::Connecting => Some((tr("state.connecting").to_string(), t.warning)),
        LinkStatus::Starting(what) => Some((what.clone(), t.warning)),
        LinkStatus::Reconnecting(why) => {
            Some((format!("{} · {why}", tr("state.offline")), t.error))
        }
        LinkStatus::Failed(why) => Some((why.clone(), t.error)),
    };
    let (text, style) = match (&app.notice, link) {
        (Some(notice), _) => (notice.clone(), Style::new().fg(t.warning)),
        (None, Some((text, color))) => (text, Style::new().fg(color)),
        (None, None) => (hint.to_string(), t.dim_style()),
    };
    let line = Line::from(Span::styled(
        format!(
            " {}",
            truncate(
                &sanitize(&text).replace('\n', " "),
                usize::from(area.width).saturating_sub(2)
            )
        ),
        style,
    ));
    frame.render_widget(Paragraph::new(line), area);
}

#[allow(dead_code)]
fn cells(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Msg;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::crossterm::event::{
        Event, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers,
    };
    use serde_json::{Value, json};
    use tokio::sync::mpsc::unbounded_channel;

    fn screen(app: &App, w: u16, h: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
        terminal.draw(|f| draw(f, app)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        // A wide character fills two cells; the second holds no symbol of its own, so skip it.
        (0..h)
            .map(|y| {
                let mut row = String::new();
                let mut x = 0;
                while x < w {
                    let symbol = buffer[(x, y)].symbol();
                    row.push_str(symbol);
                    x += u16::try_from(width(symbol).max(1)).unwrap_or(1);
                }
                row
            })
            .collect()
    }

    fn press(app: &mut App, code: KeyCode) {
        app.handle(Msg::Term(Event::Key(KeyEvent {
            code,
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        })));
    }

    fn open_conversation() -> App {
        let (tx, _rx) = unbounded_channel();
        let mut app = App::new("9.9.9", "/Users/x/demo", "/Users/x", tx);
        app.last_model_path = std::env::temp_dir().join("oop-rs-ui-none/last-model.json");
        app.handle(Msg::Shell(json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 1,
            "projects": [{"id": "p", "title": "demo", "workspaceRoot": "/Users/x/demo"}],
            "threads": [{"id": "t", "projectId": "p", "title": "안녕 스레드", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}]}})));
        app.handle(Msg::Link(LinkStatus::Online));
        app.active = Active::Thread("t".into());
        app.conv = crate::state::Conversation::new("t");
        load(
            &mut app,
            json!([
            {"id": "u", "role": "user", "text": "안녕하세요 반갑습니다", "streaming": false, "createdAt": "2026-01-01T00:00:01.000Z"},
            {"id": "a", "role": "assistant", "text": "Hello there, 세계!", "streaming": false, "createdAt": "2026-01-01T00:00:02.000Z"}]),
        );
        app
    }

    fn load(app: &mut App, messages: Value) {
        app.conv.apply(&json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 2, "thread": {"title": "안녕 스레드",
            "modelSelection": {"instanceId": "codex", "model": "gpt"}, "messages": messages}}}));
    }

    #[test]
    fn the_wordmark_is_the_one_in_banner_ts() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../oop-tui/src/render/banner.ts"
        ))
        .expect("banner.ts");
        for row in WORDMARK {
            assert!(
                source.contains(&format!("\"{row}\"")),
                "wordmark row drifted from banner.ts: {row}"
            );
        }
    }

    #[test]
    fn the_header_pins_the_wordmark_and_the_list_is_on_the_left() {
        let app = open_conversation();
        let rows = screen(&app, 140, 40);
        assert!(rows[0].starts_with(WORDMARK[0]), "{}", rows[0]);
        assert!(rows[3].starts_with(WORDMARK[3]));
        assert!(rows[0].contains("OOP v9.9.9"));
        assert!(rows[2].contains("codex/gpt"), "{}", rows[2]);
        assert!(rows[6].starts_with('─'));
        assert!(rows[8].contains(tr("list.new")), "{:?}", &rows[7..11]);
        assert!(
            rows.iter()
                .any(|r| r.starts_with("▸") && r.contains("안녕 스레드")),
            "{rows:#?}"
        );
    }

    #[test]
    fn the_header_uses_the_lavender_gradient_and_no_magenta() {
        let app = open_conversation();
        let mut terminal = Terminal::new(TestBackend::new(140, 40)).unwrap();
        terminal.draw(|f| draw(f, &app)).unwrap();
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer[(1, 0)].fg, app.theme.gradient[0]);
        assert_eq!(buffer[(1, 1)].fg, app.theme.gradient[1]);
        let magenta = buffer.content().iter().any(|c| {
            matches!(
                c.fg,
                ratatui::style::Color::Magenta | ratatui::style::Color::LightMagenta
            )
        });
        assert!(!magenta);
    }

    #[test]
    fn user_text_is_right_aligned_and_assistant_text_is_left() {
        let app = open_conversation();
        let rows = screen(&app, 140, 40);
        let user = rows
            .iter()
            .find(|r| r.contains("안녕하세요 반갑습니다"))
            .expect("user line");
        let assistant = rows
            .iter()
            .find(|r| r.contains("Hello there"))
            .expect("assistant line");
        let user_end = width(user.trim_end());
        assert!(
            user_end >= 138,
            "user plate ends at the right edge: {user_end} cells"
        );
        let left = width(&user[..user.find("안녕하세요").unwrap()]);
        assert!(
            left > 70,
            "user text starts in the right half: column {left}"
        );
        let col = width(&assistant[..assistant.find("●").unwrap()]);
        assert!(
            (35..40).contains(&col),
            "assistant text starts at the pane's left edge: column {col}"
        );
    }

    #[test]
    fn user_text_has_its_own_colour() {
        let app = open_conversation();
        let mut terminal = Terminal::new(TestBackend::new(140, 40)).unwrap();
        terminal.draw(|f| draw(f, &app)).unwrap();
        let buffer = terminal.backend().buffer();
        let cell = (0..40u16)
            .flat_map(|y| (0..140u16).map(move |x| (x, y)))
            .find(|(x, y)| buffer[(*x, *y)].symbol() == "반")
            .expect("cell");
        assert_eq!(buffer[cell].fg, app.theme.user_fg);
        assert_eq!(buffer[cell].bg, app.theme.user_bg);
    }

    #[test]
    fn replies_render_markdown_with_code_plates() {
        let mut app = open_conversation();
        load(
            &mut app,
            json!([{"id": "a", "role": "assistant", "streaming": false, "createdAt": "2026-01-01T00:00:02.000Z",
            "text": "## Plan\n- **one** thing\n```rust\nfn main() {}\n```"}]),
        );
        let rows = screen(&app, 140, 40);
        assert!(
            rows.iter().any(|r| r.contains("Plan"))
                && rows.iter().any(|r| r.contains("• one thing"))
        );
        let code_row = rows
            .iter()
            .position(|r| r.contains("fn main() {}"))
            .expect("code row");
        let mut terminal = Terminal::new(TestBackend::new(140, 40)).unwrap();
        terminal.draw(|f| draw(f, &app)).unwrap();
        let buffer = terminal.backend().buffer();
        let row = &rows[code_row];
        let x = width(&row[..row.find("fn").unwrap()]) as u16;
        assert_eq!(buffer[(x, code_row as u16)].bg, app.theme.code_bg);
        assert_eq!(buffer[(x, code_row as u16)].fg, app.theme.keyword);
    }

    #[test]
    fn a_small_terminal_folds_the_header_to_one_line_and_hides_the_list() {
        let app = open_conversation();
        let rows = screen(&app, 50, 20);
        assert!(rows[0].contains("OOP v9.9.9") && !rows[0].contains('█'));
        assert!(!rows.iter().any(|r| r.contains(tr("list.new"))));
    }

    #[test]
    fn settings_choose_the_header_and_the_symbols() {
        let mut app = open_conversation();
        app.configure(
            Settings {
                banner: false,
                sidebar: false,
                ascii: true,
                ..Settings::default()
            },
            vec![],
        );
        let rows = screen(&app, 140, 40);
        assert!(rows[0].contains("OOP v9.9.9") && !rows.iter().any(|r| r.contains('█')));
        assert!(
            !rows.iter().any(|r| r.contains(tr("list.new"))),
            "the list is off"
        );
        assert!(
            rows.iter().any(|r| r.contains("* Hello there")),
            "ascii bullet"
        );
        app.configure(
            Settings {
                status_line: "minimal".into(),
                ..Settings::default()
            },
            vec![],
        );
        assert!(
            !screen(&app, 140, 40)[0].contains("codex"),
            "minimal drops the model"
        );
    }

    #[test]
    fn wide_characters_never_overflow_a_narrow_pane() {
        let app = open_conversation();
        for line in app.transcript(12).iter() {
            let cells: usize = line.spans.iter().map(|s| width(&s.content)).sum();
            assert!(cells <= 12, "{cells} cells: {line:?}");
        }
    }

    #[test]
    fn a_failed_session_shows_its_error_in_the_conversation() {
        let mut app = open_conversation();
        app.conv.apply(&json!({"kind": "event", "event": {"sequence": 3, "type": "thread.session-set",
            "payload": {"session": {"status": "error", "lastError": "Provider is not signed in"}}}}));
        let rows = screen(&app, 140, 40);
        assert!(
            rows.iter()
                .any(|r| r.contains("✗  Provider is not signed in"))
        );
        assert!(rows[1].contains(tr("state.error")));
    }

    #[test]
    fn an_approval_replaces_the_composer_with_its_choices() {
        let mut app = open_conversation();
        app.conv.apply(&json!({"kind": "event", "event": {"sequence": 3, "type": "thread.activity-appended", "payload": {"activity": {
            "id": "a", "tone": "approval", "kind": "approval.requested", "summary": "s", "createdAt": "2026-01-01T00:00:03.000Z",
            "payload": {"requestId": "r", "requestKind": "command", "detail": "rm -rf build"}}}}}));
        let rows = screen(&app, 140, 40);
        assert!(rows.iter().any(|r| r.contains(tr("panel.approval"))));
        assert!(rows.iter().any(|r| r.contains("rm -rf build")));
        assert!(
            rows.iter()
                .any(|r| r.contains("1. ") && r.contains(tr("approval.accept")))
        );
        assert!(rows.last().unwrap().contains("1-4"));
        press(&mut app, KeyCode::Down);
        let rows = screen(&app, 140, 40);
        assert!(rows.iter().any(|r| r.contains("❯ 2.")));
    }

    #[test]
    fn scrolling_back_shows_older_lines_and_says_how_to_return() {
        let mut app = open_conversation();
        let messages: Vec<Value> = (0..60)
            .map(|i| json!({"id": format!("m{i}"), "role": if i % 2 == 0 { "user" } else { "assistant" }, "text": format!("line number {i}"), "streaming": false, "createdAt": format!("2026-01-01T00:{:02}:00.000Z", i % 60)}))
            .collect();
        load(&mut app, Value::Array(messages));
        let rows = screen(&app, 140, 40);
        assert!(rows.iter().any(|r| r.contains("line number 59")));
        assert!(
            !rows
                .iter()
                .any(|r| r.contains("line number 0 ") || r.ends_with("line number 0"))
        );
        app.scroll_up(40);
        let rows = screen(&app, 140, 40);
        assert!(
            !rows.iter().any(|r| r.contains("line number 59")),
            "scrolled away from the end"
        );
        assert!(rows.iter().any(|r| r.contains(tr("conv.jump"))));
        app.scroll_down(1000);
        assert!(
            screen(&app, 140, 40)
                .iter()
                .any(|r| r.contains("line number 59")),
            "back at the end it follows again"
        );
    }

    #[test]
    fn new_lines_do_not_move_what_the_reader_scrolled_to() {
        let mut app = open_conversation();
        let many = |n: usize| -> Value {
            Value::Array((0..n).map(|i| json!({"id": format!("m{i}"), "role": "assistant", "text": format!("row {i}"), "streaming": false, "createdAt": format!("2026-01-01T00:00:{:02}.000Z", i % 60)})).collect())
        };
        load(&mut app, many(50));
        screen(&app, 140, 40);
        app.scroll_up(10);
        let before = screen(&app, 140, 40);
        let target = before.iter().find(|r| r.contains("row ")).cloned().unwrap();
        app.conv.apply(&json!({"kind": "event", "event": {"sequence": 9, "type": "thread.message-sent", "payload": {
            "messageId": "new", "role": "assistant", "text": "fresh", "streaming": false, "createdAt": "2026-01-01T00:59:00.000Z"}}}));
        let after = screen(&app, 140, 40);
        assert!(
            after.contains(&target),
            "the same rows stay on screen while the reader is scrolled up"
        );
    }

    #[test]
    fn the_list_groups_by_the_desktop_sections() {
        let mut app = open_conversation();
        app.handle(Msg::Shell(json!({"kind": "thread-upserted", "sequence": 2, "thread": {"id": "p1", "projectId": "p", "title": "pinned one", "pinnedAt": "2026-01-01T00:00:00.000Z", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}})));
        app.handle(Msg::Shell(json!({"kind": "thread-upserted", "sequence": 3, "thread": {"id": "s1", "projectId": "p", "title": "settled one", "settledOverride": "settled", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}})));
        let rows = screen(&app, 140, 40);
        // The header and the list share words ("Threads", the title), so look inside the list column.
        let list: Vec<&str> = rows
            .iter()
            .map(|r| r.split('│').next().unwrap_or(""))
            .collect();
        let at = |needle: &str| {
            list.iter()
                .rposition(|r| r.contains(needle))
                .unwrap_or_else(|| panic!("{needle} in {list:#?}"))
        };
        assert!(
            at(tr("list.pinned")) < at("pinned one")
                && at("pinned one") < at(tr("list.active"))
                && at(tr("list.active")) < at("안녕 스레드")
        );
        assert!(at("안녕 스레드") < at(tr("list.settled")));
        assert!(
            !rows.iter().any(|r| r.contains("settled one")),
            "shelves start closed"
        );
    }

    #[test]
    fn the_model_picker_opens_over_the_conversation() {
        let mut app = open_conversation();
        app.config = json!({"providers": [{"instanceId": "codex", "displayName": "Codex", "enabled": true, "installed": true, "models": [{"slug": "gpt-5", "name": "GPT-5"}, {"slug": "mini", "name": "Mini"}]}]});
        app.modal = Some(Modal::Models {
            filter: String::new(),
            cursor: 1,
        });
        let rows = screen(&app, 140, 40);
        assert!(rows.iter().any(|r| r.contains(tr("picker.model"))));
        assert!(
            rows.iter().any(|r| r.contains("❯ Codex  Mini")),
            "{rows:#?}"
        );
    }

    use crate::settings::Settings;
}
