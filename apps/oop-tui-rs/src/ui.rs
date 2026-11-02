//! Drawing. Reads `App`, writes a ratatui frame. Layout, top to bottom: the pinned header (the OOP
//! wordmark, status, thread and folder, a rule), then the thread list on the left with the
//! conversation and the composer (or the approval or question the agent waits on) on the right,
//! then one status line. Pickers (`/model`, `/mode`, `/effort`) open over the conversation.

use crate::app::{Active, App, Focus, LinkStatus, Modal, Row};
use crate::i18n::tr;
use crate::pet;
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
pub const SIDEBAR_MIN_COLUMNS: u16 = 60;
/// From this width the list and the panel are both on screen; below it they share one slot.
const WIDE_COLUMNS: u16 = 120;
/// The panel needs this many columns in all to be worth opening.
const PANEL_MIN_COLUMNS: u16 = 90;
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
    app.width.set(area.width);
    app.term_size.set((area.width, area.height));
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
    if let Some(screen) = &app.screen {
        screen.draw(frame, body, app);
        draw_status(frame, status, app);
        return;
    }
    let (list, side, main) = split_body(app, body);
    app.side_rect.set(side.unwrap_or_default());
    *app.list_hits.borrow_mut() = (list.unwrap_or_default(), Vec::new());
    if let Some(list) = list {
        draw_list(frame, list, app);
    }
    if let Some(side) = side {
        crate::side::draw(frame, side, app);
    }
    let bottom = bottom_height(app, main);
    let tasks = crate::tasks_pane::rows_for(app, area, main);
    let [conversation, tasks_area, bottom_area] = Layout::vertical([
        Constraint::Min(2),
        Constraint::Length(tasks),
        Constraint::Length(bottom),
    ])
    .areas(main);
    draw_conversation(frame, conversation, app);
    if tasks > 0 {
        crate::tasks_pane::draw(frame, tasks_area, app);
    }
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

/// The body's columns: the thread list on the left, the conversation, the panel on the right.
/// From `WIDE_COLUMNS` up both side columns fit; below it they share one slot, the list while it
/// has the keys and the panel otherwise.
fn split_body(app: &App, body: Rect) -> (Option<Rect>, Option<Rect>, Rect) {
    let w = body.width;
    let list_on = app.list_shown();
    let panel_on = app.side_open && app.active != Active::None && w >= PANEL_MIN_COLUMNS;
    let (list_on, panel_on) = if w >= WIDE_COLUMNS {
        (list_on, panel_on)
    } else if panel_on && !(list_on && app.focus == Focus::List) {
        (false, true)
    } else {
        (list_on, false)
    };
    let list_w = if list_on {
        (w / 4).clamp(24, 38).min(w / 2)
    } else {
        0
    };
    let side_w = if panel_on {
        (w / 3).clamp(36, 72).min(w / 2)
    } else {
        0
    };
    let [list, main, side] = Layout::horizontal([
        Constraint::Length(list_w),
        Constraint::Min(10),
        Constraint::Length(side_w),
    ])
    .areas(body);
    (list_on.then_some(list), panel_on.then_some(side), main)
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

fn spans_width(spans: &[Span]) -> usize {
    spans.iter().map(|s| width(&s.content)).sum()
}

/// `spans` cut to `max` cells, a wide glyph that does not fit dropped whole.
fn clip_spans(spans: Vec<Span<'static>>, max: usize) -> Vec<Span<'static>> {
    let mut used = 0;
    let mut out = Vec::new();
    for span in spans {
        let mut text = String::new();
        for ch in span.content.chars() {
            let w = char_width(ch);
            if used + w > max {
                break;
            }
            used += w;
            text.push(ch);
        }
        let full = text.len() == span.content.len();
        out.push(Span::styled(text, span.style));
        if !full {
            break;
        }
    }
    out
}

fn pad_spans(mut spans: Vec<Span<'static>>, to: usize) -> Vec<Span<'static>> {
    let w = spans_width(&spans);
    if w < to {
        spans.push(Span::raw(" ".repeat(to - w)));
    }
    spans
}

/// The crew as `Crew worker Haiku 5.5 · expert Opus 5.5 · …`, or a letter for each role where the
/// room is short; empty with the crew off.
fn crew_spans(app: &App, words: bool) -> Vec<Span<'static>> {
    let t = &app.theme;
    let thread = app.thread_id();
    let current = app.current_model();
    let brain = current
        .as_ref()
        .and_then(|m| Some((m["instanceId"].as_str()?, m["model"].as_str()?)));
    let Some(roles) = crate::crew::roles_of(
        &app.config,
        thread.as_deref(),
        brain,
        app.active != Active::None,
    ) else {
        return Vec::new();
    };
    let dot = if app.settings.ascii { "|" } else { "·" };
    let mut out = vec![Span::styled(tr("header.crew"), t.dim_style())];
    for (i, role) in roles.iter().enumerate() {
        if i > 0 {
            out.push(Span::styled(format!(" {dot} "), t.dim_style()));
        }
        let word = if words {
            role.role.to_string()
        } else {
            role.role.chars().take(1).collect()
        };
        out.push(Span::styled(format!("{word} "), t.muted_style()));
        match &role.model {
            Some(model) => out.push(Span::raw(sanitize(model).replace('\n', " "))),
            None => out.push(Span::styled("-", t.dim_style())),
        }
    }
    out
}

/// The folder with the crew after it on one row; the crew is what the row is for, so the folder is
/// cut to make room, and left out when it would have too little.
fn crew_beside(app: &App, folder: Vec<Span<'static>>, wide: usize) -> Vec<Span<'static>> {
    const FOLDER_MIN: usize = 20;
    let dim = app.theme.dim_style();
    let dot = if app.settings.ascii { "|" } else { "·" };
    let between = Span::styled(format!("  {dot}  "), dim);
    let gap = width(&between.content);
    let words = crew_spans(app, true);
    if spans_width(&folder) + gap + spans_width(&words) <= wide {
        let mut out = folder;
        out.push(between);
        out.extend(words);
        return out;
    }
    let letters = crew_spans(app, false);
    let room = wide.saturating_sub(gap + spans_width(&letters));
    if room < FOLDER_MIN {
        return clip_spans(letters, wide);
    }
    let mut out = clip_spans(folder, room);
    out.push(between);
    out.extend(letters);
    out
}

/// Mocha's strip beside the header: how wide it is (0 when she is off or there is no room), and
/// whether it holds her one-line form. The compact header always shows her so; the full header
/// falls back to it on the first row where the strip beside the notes is too narrow for all five.
struct PetStrip {
    width: usize,
    mini: bool,
}

fn pet_strip(app: &App, columns: u16, full: bool) -> PetStrip {
    let columns = usize::from(columns);
    let avail = if full {
        columns.saturating_sub(23 + 14)
    } else {
        columns.saturating_sub(24)
    };
    if !app.settings.pet {
        return PetStrip {
            width: 0,
            mini: !full,
        };
    }
    if full && avail >= pet::PET_TRACK_WIDTH {
        return PetStrip {
            width: pet::PET_TRACK_WIDTH,
            mini: false,
        };
    }
    PetStrip {
        width: if avail >= pet::PET_MINI_TRACK_WIDTH {
            pet::PET_MINI_TRACK_WIDTH
        } else {
            0
        },
        mini: true,
    }
}

/// The state and picture Mocha is drawn in; remembers them so the app repaints only on a change.
fn pet_view(app: &App) -> (pet::PetState, usize, pet::Look, pet::Draw) {
    let state = app.pet_state();
    let frame = app.pet_frame(state);
    let look = app.pet_look(state);
    app.pet_shown.set(Some((state, frame, look.tone)));
    let draw = pet::Draw {
        level: app.misc.level,
        ascii: app.settings.ascii,
    };
    (state, frame, look, draw)
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
    let columns = usize::from(area.width);
    match kind {
        Header::Minimal => {
            let line = Line::from(vec![title, Span::styled(" · ", dim), state]);
            frame.render_widget(Paragraph::new(line), area);
            return;
        }
        Header::Compact => {
            let track = pet_strip(app, area.width, false).width;
            let room = columns.saturating_sub(track + 1);
            let sep = Span::styled(if app.settings.ascii { " | " } else { " · " }, dim);
            let mut facts = vec![title, sep.clone(), state, sep.clone(), model];
            // The crew comes before the thread's title, which is the first to be cut; with less
            // than a few cells it is left out whole rather than shown as a stub.
            let crew = crew_spans(app, false);
            let crew_room = room
                .saturating_sub(spans_width(&facts))
                .saturating_sub(width(&sep.content));
            if !crew.is_empty() && crew_room >= 14 {
                facts.push(sep.clone());
                facts.extend(clip_spans(crew, crew_room));
            }
            facts.push(sep);
            facts.push(Span::styled(thread, dim));
            let mut spans = pad_spans(clip_spans(facts, room), room);
            if track > 0 {
                let (pet_state, frame_no, look, draw) = pet_view(app);
                spans.extend(pet::mini(pet_state, frame_no, look, track, draw).spans);
            }
            frame.render_widget(Paragraph::new(Line::from(spans)), area);
            return;
        }
        Header::Full => {}
    }
    let wide = columns.saturating_sub(1);
    let strip = pet_strip(app, area.width, true);
    let track = strip.width;
    let lead_width = if track == 0 {
        columns.saturating_sub(1)
    } else {
        columns - track
    };
    let notes = [
        Some(title),
        Some(state),
        Some(model),
        Some(Span::styled(mode_label(app), dim)),
    ];
    debug_assert_eq!(WORDMARK[0].chars().count(), usize::from(LOGO_WIDTH));
    let pet_rows = if track == 0 {
        Vec::new()
    } else {
        let (pet_state, frame_no, look, draw) = pet_view(app);
        if strip.mini {
            vec![pet::mini(pet_state, frame_no, look, track, draw)]
        } else {
            pet::lines(pet_state, frame_no, look, track, draw)
        }
    };
    let mut lines: Vec<Line> = WORDMARK
        .iter()
        .zip(t.gradient)
        .zip(notes)
        .enumerate()
        .map(|(i, ((row, color), note))| {
            let art = if app.settings.ascii {
                row.replace(['▄', '▀', '█'], "#")
            } else {
                row.to_string()
            };
            let mut spans = vec![Span::styled(art, Style::new().fg(color)), Span::raw("  ")];
            spans.extend(note);
            let mut spans = pad_spans(clip_spans(spans, lead_width), lead_width);
            if let Some(pet_row) = pet_rows.get(i) {
                spans.extend(pet_row.spans.clone());
            }
            Line::from(spans)
        })
        .collect();
    let folder = home_relative(&sanitize(&app.cwd), &app.home);
    let folder_spans = vec![Span::styled(tr("header.folder"), dim), Span::raw(folder)];
    // The thread row shares the strip with the pet's fifth row; its text stops before it.
    let thread_row = vec![
        Span::styled(tr("header.thread"), dim),
        Span::styled(thread, dim),
    ];
    let mut thread_line = if let Some(pet_row) = pet_rows.get(WORDMARK.len()) {
        let mut spans = pad_spans(clip_spans(thread_row, lead_width), lead_width);
        spans.extend(pet_row.spans.clone());
        spans
    } else {
        clip_spans(thread_row, wide)
    };
    lines.push(Line::from(std::mem::take(&mut thread_line)));
    let crew_on = !crew_spans(app, false).is_empty();
    lines.push(Line::from(if crew_on {
        crew_beside(app, folder_spans, wide)
    } else {
        clip_spans(folder_spans, wide)
    }));
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
    let mut firsts: Vec<(usize, usize)> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let selected = index == app.selected && app.focus == Focus::List;
        let first = lines.len();
        firsts.push((first, index));
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
    // Where each row stands on the screen, for a click.
    *app.list_hits.borrow_mut() = (
        area,
        firsts
            .iter()
            .filter(|(first, _)| *first >= skip && first - skip < height)
            .map(|(first, index)| (inner.y + (first - skip) as u16, *index))
            .collect(),
    );
    let visible: Vec<Line> = lines.into_iter().skip(skip).take(height).collect();
    frame.render_widget(Paragraph::new(visible), inner);
}

/// The conversation already says this error: the server records it as a `runtime.error` activity
/// and also keeps it as the session's `lastError`, so showing both would print it twice.
fn error_in_transcript(app: &App, error: &str) -> bool {
    let error = error.trim();
    let says = |value: &serde_json::Value| {
        // The server cuts the activity's copy of a long message and ends it with "...".
        value.as_str().map(str::trim).is_some_and(|text| {
            let stem = text.trim_end_matches(['.', '…']);
            !stem.is_empty() && (error.contains(stem) || stem.contains(error))
        })
    };
    app.conv.thread.activities.iter().any(|a| {
        a.kind == "runtime.error"
            && (a.summary.trim() == error
                || says(&a.payload["message"])
                || says(&a.payload["detail"]))
    })
}

/// The lines under the transcript that change with the clock or the session, not the thread.
fn live_lines(app: &App, w: usize) -> Vec<Line<'static>> {
    let t = &app.theme;
    let mut out = Vec::new();
    if app.conv.session().is_some_and(|s| s.status == "error")
        && let Some(error) = app.conv.session().and_then(|s| s.last_error.as_deref())
        && !error_in_transcript(app, error)
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
    let transcript = if placeholder(app).is_some() {
        Default::default()
    } else {
        app.transcript(w)
    };
    let base = &transcript.lines;
    let mut tail: Vec<Line<'static>> = match placeholder(app) {
        // Notes (`/update`, `/theme`, ...) still show where there is no conversation to put them under.
        Some(key) => {
            let mut lines = vec![Line::from(Span::styled(
                format!(" {}", tr(key)),
                app.theme.dim_style(),
            ))];
            lines.extend(crate::notes::lines(app, w));
            lines
        }
        None => {
            let mut lines = crate::notes::lines(app, w);
            lines.extend(live_lines(app, w));
            lines
        }
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
    app.geo.set(crate::app::Geo {
        area,
        pad,
        start,
        rows: base.len(),
    });
    highlight_selection(frame, area, app, &transcript, pad, start, end);

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

/// Paints the selected cells in reverse video. Only the text is painted: a bubble's border and
/// padding stay as they are, as they stay out of the copy.
fn highlight_selection(
    frame: &mut Frame,
    area: Rect,
    app: &App,
    transcript: &crate::transcript::Transcript,
    pad: usize,
    start: usize,
    end: usize,
) {
    let Some(range) = app.selection.range() else {
        return;
    };
    let buffer = frame.buffer_mut();
    for row in start.max(range.0.row)..end.min(range.1.row + 1).min(transcript.lines.len()) {
        let meta = transcript.meta.get(row).copied().unwrap_or_default();
        let Some((from, to)) = crate::selection::row_cells(range, row, &meta) else {
            continue;
        };
        let line = &transcript.lines[row];
        let Some((from, to)) = crate::selection::snap(line, from, to.min(line.width())) else {
            continue;
        };
        let y = area.y + (pad + row - start) as u16;
        for col in from..to.min(usize::from(area.width)) {
            buffer[(area.x + col as u16, y)]
                .modifier
                .insert(Modifier::REVERSED);
        }
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
        Modal::Pick(pick) => (
            pick.title.as_str(),
            pick.items.iter().map(|item| sanitize(item)).collect(),
            pick.cursor,
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
    let screen_hint = app.screen.as_ref().map(|screen| screen.hint());
    let hint = if let Some(hint) = &screen_hint {
        hint.as_str()
    } else if app.modal.is_some() {
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
    // The thread's goal, right-aligned, kept whole while the left text gives way.
    let goal = crate::cmd_goal::goal_bar(app).map(|bar| format!(" {} ", sanitize(&bar)));
    let goal_room = goal.as_ref().map_or(0, |bar| width(bar) + 1);
    let line = Line::from(Span::styled(
        format!(
            " {}",
            truncate(
                &sanitize(&text).replace('\n', " "),
                usize::from(area.width).saturating_sub(2 + goal_room)
            )
        ),
        style,
    ));
    frame.render_widget(Paragraph::new(line), area);
    if let Some(bar) = goal {
        let room = u16::try_from(width(&bar))
            .unwrap_or(u16::MAX)
            .min(area.width);
        let rect = Rect::new(area.right() - room, area.y, room, area.height.min(1));
        frame.render_widget(
            Paragraph::new(Span::styled(bar, Style::new().fg(t.brand))),
            rect,
        );
    }
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
        let mut app = open_conversation();
        app.side_open = false;
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
            user_end >= 138 && user.trim_end().ends_with('│'),
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
        assert!(rows[0].contains("OOP v9.9.9") && !rows[0].contains("██  ██"));
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
        for line in app.transcript(12).lines.iter() {
            let cells: usize = line.spans.iter().map(|s| width(&s.content)).sum();
            assert!(cells <= 12, "{cells} cells: {line:?}");
        }
    }

    #[test]
    fn a_note_shows_even_when_no_thread_is_open() {
        let (tx, _rx) = unbounded_channel();
        let mut app = App::new("9.9.9", "/Users/x/demo", "/Users/x", tx);
        app.say(
            crate::notes::Tone::Warning,
            "the update feed did not answer",
        );
        let rows = screen(&app, 120, 30);
        assert!(
            rows.iter()
                .any(|r| r.contains("the update feed did not answer"))
        );
        assert!(rows.iter().any(|r| r.contains(tr("conv.pick"))));
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
    fn the_error_is_said_once_when_the_activity_already_says_it() {
        let mut app = open_conversation();
        let long = "Claude could not authenticate. For subscription login, run `claude auth login` on this environment's machine.";
        app.conv.apply(
            &json!({"kind": "event", "event": {"sequence": 3, "type": "thread.session-set",
            "payload": {"session": {"status": "error", "lastError": long}}}}),
        );
        app.conv.apply(&json!({"kind": "event", "event": {"sequence": 4, "type": "thread.activity-appended", "payload": {"activity": {
            "id": "e", "tone": "error", "kind": "runtime.error", "summary": "Runtime error", "createdAt": "2026-01-01T00:00:03.000Z",
            "payload": {"message": "Claude could not authenticate. For subscription login, run `claude auth login` on this env..."}}}}}));
        let rows = screen(&app, 140, 40);
        let says = rows
            .iter()
            .filter(|r| r.contains("Claude could not"))
            .count();
        assert_eq!(says, 1, "{rows:#?}");
    }

    #[test]
    fn user_text_sits_in_a_rounded_box_and_the_header_names_no_server() {
        let mut app = open_conversation();
        app.server = Some("127.0.0.1:4873".into());
        let rows = screen(&app, 140, 40);
        assert!(rows.iter().any(|r| r.contains('╭') && r.contains('╮')));
        assert!(rows.iter().any(|r| r.contains("│ 안녕하세요 반갑습니다")));
        assert!(rows.iter().any(|r| r.contains('╰') && r.contains('╯')));
        assert!(
            !rows
                .iter()
                .any(|r| r.contains("127.0.0.1") || r.contains("4873")),
            "no address on the screen"
        );
        app.settings.ascii = true;
        app.sym = crate::theme::Symbols::pick(true);
        // another pane width, so the conversation is built again with the new symbols
        let rows = screen(&app, 150, 40);
        assert!(rows.iter().any(|r| r.contains("+--")), "{rows:#?}");
        assert!(rows.iter().any(|r| r.contains("| 안녕하세요")));
    }

    #[test]
    fn the_box_stays_with_no_colour() {
        let mut app = open_conversation();
        app.theme = app.theme.for_level(0);
        let rows = screen(&app, 140, 40);
        assert!(rows.iter().any(|r| r.contains('╭')) && rows.iter().any(|r| r.contains('╰')));
    }

    #[test]
    fn mocha_stands_in_the_header_and_the_mini_one_in_the_short_header() {
        let mut app = open_conversation();
        app.pet_clock = Some(1_000_000);
        let blocks = |row: &str| row.contains(['▀', '▄', '█']);
        // Five rows: the wordmark's four and the thread row, whose text stops before her.
        let rows = screen(&app, 140, 40);
        assert!(
            blocks(&rows[4]) && rows[4].contains("Thread"),
            "{:#?}",
            &rows[..6]
        );
        assert!(!blocks(&rows[5]) && !blocks(&rows[6]), "{:#?}", &rows[..7]);
        for row in &rows[..5] {
            assert!(row.trim_end().ends_with(['▀', '▄', '█']) || blocks(&row[row.len() - 24..]));
        }
        let rows = screen(&app, 90, 20);
        assert!(
            rows[0].contains("OOP v9.9.9") && blocks(&rows[0]),
            "{}",
            rows[0]
        );
        // no room for her five rows beside the notes: her one-line form stands on the first row
        let rows = screen(&app, 50, 40);
        assert!(blocks(&rows[0]) && !blocks(&rows[4]), "{:#?}", &rows[..5]);
        app.settings.pet = false;
        let rows = screen(&app, 140, 40);
        assert!(!blocks(&rows[4]), "{:#?}", &rows[..5]);
    }

    #[test]
    fn the_crew_line_follows_the_roles_and_is_absent_with_the_crew_off() {
        let mut app = open_conversation();
        let provider = json!({"instanceId": "codex", "driver": "codex", "displayName": "Codex", "enabled": true,
            "installed": true, "status": "ready", "auth": {"status": "authenticated"},
            "models": [{"slug": "gpt", "name": "GPT", "isDefault": true}]});
        app.config = json!({"settings": {"crew": {"enabled": true}}, "providers": [provider]});
        let rows = screen(&app, 140, 40);
        let crew = rows
            .iter()
            .find(|r| r.contains(tr("header.crew").trim()))
            .expect("crew line");
        assert!(crew.contains("worker") && crew.contains("expert") && crew.contains("auditor"));
        assert!(
            crew.contains(tr("header.folder").trim()),
            "the folder stays beside it"
        );
        // narrower: letters instead of words
        let rows = screen(&app, 60, 40);
        assert!(
            rows.iter()
                .any(|r| r.contains(tr("header.crew").trim()) && r.contains("w GPT")),
            "{rows:#?}"
        );
        app.config = json!({"settings": {"crew": {"enabled": false}}, "providers": []});
        let rows = screen(&app, 140, 40);
        assert!(!rows.iter().any(|r| r.contains(tr("header.crew").trim())));
    }

    #[test]
    fn the_panel_opens_on_the_right_and_gives_way_to_the_list_on_a_medium_screen() {
        let mut app = open_conversation();
        let rows = screen(&app, 140, 40);
        assert!(
            rows.iter()
                .any(|r| r.contains("Workflow") && r.contains("Agents"))
        );
        assert!(
            rows.iter().any(|r| r.contains(tr("list.projects"))),
            "the list stays"
        );
        // 100 columns: one side slot
        let rows = screen(&app, 100, 40);
        assert!(rows.iter().any(|r| r.contains("Workflow")));
        assert!(!rows.iter().any(|r| r.contains(tr("list.projects"))));
        press(&mut app, KeyCode::Tab);
        let rows = screen(&app, 100, 40);
        assert!(rows.iter().any(|r| r.contains(tr("list.projects"))));
        assert!(!rows.iter().any(|r| r.contains("Workflow")));
    }

    fn mouse(app: &mut App, kind: ratatui::crossterm::event::MouseEventKind, x: u16, y: u16) {
        app.handle(Msg::Term(Event::Mouse(
            ratatui::crossterm::event::MouseEvent {
                kind,
                column: x,
                row: y,
                modifiers: KeyModifiers::NONE,
            },
        )));
    }

    /// The screen cell of the first glyph of `needle` in the drawn rows.
    fn cell_of(rows: &[String], needle: &str) -> (u16, u16) {
        let y = rows.iter().position(|r| r.contains(needle)).expect("row");
        let x = width(&rows[y][..rows[y].find(needle).unwrap()]);
        (x as u16, y as u16)
    }

    #[test]
    fn dragging_over_boxed_text_copies_the_text_without_the_border() {
        use ratatui::crossterm::event::{MouseButton, MouseEventKind};
        let mut app = open_conversation();
        app.side_open = false;
        let rows = screen(&app, 140, 40);
        let (x, y) = cell_of(&rows, "안녕하세요");
        let (end_x, _) = cell_of(&rows, "반갑습니다");
        // from the box's left border to its right border: the border is not text
        let left = x - 2;
        let right = end_x + 12 + 2;
        mouse(&mut app, MouseEventKind::Down(MouseButton::Left), left, y);
        mouse(&mut app, MouseEventKind::Drag(MouseButton::Left), right, y);
        assert!(
            app.take_copy().is_none(),
            "nothing is copied while the button is down"
        );
        mouse(&mut app, MouseEventKind::Up(MouseButton::Left), right, y);
        let job = app.take_copy().expect("a copy on release");
        assert_eq!(job.text, "안녕하세요 반갑습니다");
        assert!(
            job.osc52
                .as_deref()
                .is_some_and(|s| s.starts_with("\u{1b}]52;c;") || s.starts_with("\u{1b}Ptmux;"))
        );
        // the selected cells are drawn reversed, the border is not
        let mut terminal = Terminal::new(TestBackend::new(140, 40)).unwrap();
        terminal.draw(|f| draw(f, &app)).unwrap();
        let buffer = terminal.backend().buffer();
        assert!(buffer[(x, y)].modifier.contains(Modifier::REVERSED));
        assert!(!buffer[(left, y)].modifier.contains(Modifier::REVERSED));
        // a key press puts the highlight away
        press(&mut app, KeyCode::Char('x'));
        let mut terminal = Terminal::new(TestBackend::new(140, 40)).unwrap();
        terminal.draw(|f| draw(f, &app)).unwrap();
        assert!(
            !terminal.backend().buffer()[(x, y)]
                .modifier
                .contains(Modifier::REVERSED)
        );
    }

    #[test]
    fn a_click_copies_nothing_and_a_click_on_a_list_row_opens_it() {
        use ratatui::crossterm::event::{MouseButton, MouseEventKind};
        let mut app = open_conversation();
        let rows = screen(&app, 140, 40);
        let (x, y) = cell_of(&rows, "안녕하세요");
        mouse(&mut app, MouseEventKind::Down(MouseButton::Left), x, y);
        mouse(&mut app, MouseEventKind::Up(MouseButton::Left), x, y);
        assert!(app.take_copy().is_none());
        // the list row of the thread (not the conversation)
        let (lx, ly) = cell_of(&rows[8..], "안녕 스레드");
        let ly = ly + 8;
        app.active = Active::None;
        mouse(&mut app, MouseEventKind::Down(MouseButton::Left), lx, ly);
        mouse(&mut app, MouseEventKind::Up(MouseButton::Left), lx, ly);
        assert_eq!(app.active, Active::Thread("t".into()));
    }

    #[test]
    fn wrapped_text_is_copied_as_the_line_that_was_typed() {
        use ratatui::crossterm::event::{MouseButton, MouseEventKind};
        let mut app = open_conversation();
        app.side_open = false;
        load(
            &mut app,
            json!([{"id": "u", "role": "user", "text": "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma", "streaming": false,
            "createdAt": "2026-01-01T00:00:01.000Z"}]),
        );
        let rows = screen(&app, 70, 30);
        let (x, y) = cell_of(&rows, "alpha");
        let last = rows.iter().rposition(|r| r.contains("sigma")).unwrap() as u16;
        let (ex, _) = cell_of(&rows[..], "sigma");
        mouse(&mut app, MouseEventKind::Down(MouseButton::Left), x, y);
        mouse(
            &mut app,
            MouseEventKind::Drag(MouseButton::Left),
            ex + 4,
            last,
        );
        mouse(
            &mut app,
            MouseEventKind::Up(MouseButton::Left),
            ex + 4,
            last,
        );
        let job = app.take_copy().expect("copy");
        assert_eq!(
            job.text,
            "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma"
        );
    }

    #[test]
    fn slash_commands_drive_the_panel_the_pet_the_list_and_the_mouse() {
        let mut app = open_conversation();
        let run = |app: &mut App, text: &str| {
            for ch in text.chars() {
                press(app, KeyCode::Char(ch));
            }
            press(app, KeyCode::Enter);
        };
        let rows = screen(&app, 140, 40);
        assert!(rows.iter().any(|r| r.contains("Workflow")));
        run(&mut app, "/dag-workflow");
        let rows = screen(&app, 140, 40);
        assert!(
            !rows.iter().any(|r| r.contains("Workflow  ")) || !app.side_open,
            "closed"
        );
        assert!(!app.side_open);
        run(&mut app, "/dag-agents");
        assert!(app.side_open && app.side_view == crate::app::Side::Agents);
        run(&mut app, "/dag-workflow");
        assert!(app.side_open && app.side_view == crate::app::Side::Workflow);
        run(&mut app, "/dag-workflow off");
        assert!(!app.side_open);
        run(&mut app, "/pet off");
        assert!(!app.settings.pet);
        run(&mut app, "/pet");
        assert!(app.settings.pet);
        run(&mut app, "/mouse off");
        assert!(!app.mouse);
        run(&mut app, "/mouse");
        assert!(app.mouse);
        run(&mut app, "/sidebar off");
        assert!(!app.settings.sidebar);
        run(&mut app, "/sidebar on");
        run(&mut app, "/new");
        assert!(matches!(app.active, Active::Draft(_)));
        run(&mut app, "/bogus");
        assert_eq!(app.notice.as_deref(), Some(tr("notice.unknownCommand")));
    }

    #[test]
    fn shift_tab_flips_the_panel_and_tab_still_takes_the_list() {
        let mut app = open_conversation();
        screen(&app, 140, 40);
        assert_eq!(app.side_view, crate::app::Side::Workflow);
        press(&mut app, KeyCode::BackTab);
        assert_eq!(app.side_view, crate::app::Side::Agents);
        press(&mut app, KeyCode::BackTab);
        assert_eq!(app.side_view, crate::app::Side::Workflow);
        press(&mut app, KeyCode::Tab);
        assert_eq!(app.focus, Focus::List);
        // with the list off, Tab flips the panel as well
        app.focus = Focus::Composer;
        app.settings.sidebar = false;
        screen(&app, 140, 40);
        press(&mut app, KeyCode::Tab);
        assert_eq!(app.side_view, crate::app::Side::Agents);
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
