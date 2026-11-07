//! Drawing. Reads `App`, writes a ratatui frame. Layout: three full-height columns over one status
//! line. On the left the thread list, on the right the panel (Workflow, Agents, Savvy, Files), and
//! in the middle, top to bottom in three tiers, the pinned header (the OOP wordmark with its info
//! box, the state, Mocha, a tip) over a rule; the conversation; and, under a second rule, the
//! composer (or the approval or question the agent waits on). Either side column can be closed
//! (`panes.rs`) and the middle takes its width. The status line runs under all three. Pickers
//! (`/model`, `/mode`, `/effort`) open over the conversation, and a full-body screen (`/stats`,
//! `/crew`) takes the whole width under the header while it is up.

use crate::app::{Active, App, AuthKind, Focus, LinkStatus, Modal, Row};
use crate::i18n::tr;
use crate::pet;
use crate::sidebar::{Nav, Section, Status};
use crate::text::{char_width, sanitize, truncate, width, wrap};
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};

/// The OOP wordmark (four rows).
pub const WORDMARK: [&str; 4] = [
    " ▄██▄   ▄██▄   ████▄ ",
    "██  ██ ██  ██  ██  ██",
    "██  ██ ██  ██  ████▀ ",
    " ▀██▀   ▀██▀   ██    ",
];
const LOGO_WIDTH: u16 = 21;
/// Rows of the full header: the wordmark with the info box beside it (seven rows), a tip and a
/// rule; with no room for the box, the wordmark's four rows, the folder line, a tip and a rule.
const HEADER_BOX_ROWS: u16 = 9;
const HEADER_PLAIN_ROWS: u16 = 7;
/// Columns left of the info box: the wordmark and the gap after it.
const BOX_X: usize = LOGO_WIDTH as usize + 2;
/// The box shows its labels from this width, and values alone from `BOX_COMPACT_MIN`; narrower, it
/// is not drawn and the facts go back beside the wordmark.
const BOX_FULL_MIN: usize = 34;
const BOX_COMPACT_MIN: usize = 18;
/// Wider than this the box would only be empty space, and Mocha stands next to it.
const BOX_MAX: usize = 76;
/// The least room the plain header's notes keep beside the wordmark before Mocha gives way.
const PLAIN_NOTES_MIN: usize = 14;
const HEADER_FULL_MIN_COLUMNS: u16 = 40;
const HEADER_FULL_MIN_ROWS: u16 = 30;
/// The list gives way below this width, as the TypeScript terminal's does.
pub const SIDEBAR_MIN_COLUMNS: u16 = 60;
/// From this width the list and the panel are both on screen; below it they share one slot.
const WIDE_COLUMNS: u16 = 120;
/// The panel needs this many columns in all to be worth opening.
pub const PANEL_MIN_COLUMNS: u16 = 90;
const COMPOSER_MAX_ROWS: usize = 6;
/// The rule above the input is drawn when the main column has this many rows.
const RULE_MIN_ROWS: u16 = 8;
const PANEL_MAX_ROWS: u16 = 14;
/// The status line names a closed side pane only when it has this many columns to spare.
const CLOSED_HINT_MIN_COLUMNS: usize = 50;

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

/// The header's form for a column `width` cells wide in a terminal `rows` tall, and its height.
fn header_for(app: &App, width: u16, rows: u16) -> (Header, u16) {
    let kind = header_kind(app, Rect::new(0, 0, width, rows));
    let height = match kind {
        Header::Full if full_header(app, width).form == BoxForm::Hidden => HEADER_PLAIN_ROWS,
        Header::Full => HEADER_BOX_ROWS,
        _ => 1,
    };
    (kind, height)
}

pub fn draw(frame: &mut Frame, app: &App) {
    let area = frame.area();
    app.width.set(area.width);
    // Only a drawn list draws the usage panel; anything else leaves nothing for the tick to watch.
    *app.usage_drawn.borrow_mut() = None;
    app.term_size.set((area.width, area.height));
    let [columns, status] =
        Layout::vertical([Constraint::Min(3), Constraint::Length(1)]).areas(area);
    if let Some(screen) = &app.screen {
        // A screen takes the whole width: the side columns are not drawn, and a click must not
        // land on where they were.
        let (kind, rows) = header_for(app, columns.width, area.height);
        let [header, body] =
            Layout::vertical([Constraint::Length(rows), Constraint::Min(3)]).areas(columns);
        app.side_rect.set(Rect::default());
        *app.list_hits.borrow_mut() = (Rect::default(), Vec::new());
        draw_header(frame, header, app, &kind);
        screen.draw(frame, body, app);
        draw_status(frame, status, app);
        return;
    }
    let (list, side, centre) = split_columns(app, columns);
    app.side_rect.set(side.unwrap_or_default());
    *app.list_hits.borrow_mut() = (list.unwrap_or_default(), Vec::new());
    if let Some(list) = list {
        draw_list(frame, list, app);
    }
    if let Some(side) = side {
        crate::side::draw(frame, side, app);
    }
    // The header and its rule belong to the middle column alone.
    let (header_kind, header_rows) = header_for(app, centre.width, area.height);
    let [header, main] =
        Layout::vertical([Constraint::Length(header_rows), Constraint::Min(3)]).areas(centre);
    draw_header(frame, header, app, &header_kind);
    // The third tier, the input and what is under it, starts under a rule across the main column.
    let rule = u16::from(main.height >= RULE_MIN_ROWS);
    let below = Rect::new(main.x, main.y, main.width, main.height - rule);
    let bottom = bottom_height(app, below);
    let tasks = crate::tasks_pane::rows_for(app, area, below);
    let [conversation, tasks_area, rule_area, bottom_area] = Layout::vertical([
        Constraint::Min(2),
        Constraint::Length(tasks),
        Constraint::Length(rule),
        Constraint::Length(bottom),
    ])
    .areas(main);
    if crate::replay::is_open(app) {
        crate::replay::draw(frame, conversation, app);
    } else {
        draw_conversation(frame, conversation, app);
    }
    if rule > 0 {
        let line = app.sym.rule.repeat(usize::from(rule_area.width));
        frame.render_widget(
            Paragraph::new(Span::styled(line, app.theme.dim_style())),
            rule_area,
        );
    }
    if tasks > 0 {
        crate::tasks_pane::draw(frame, tasks_area, app);
    }
    if app.approval().is_some() && app.focus == Focus::Composer {
        draw_approval(frame, bottom_area, app);
    } else if app.pending_input().is_some() && app.focus == Focus::Composer {
        draw_question(frame, bottom_area, app);
    } else {
        draw_composer(frame, bottom_area, app);
        crate::savvy_panel::draw_input_bar(frame, bottom_area, app);
        crate::composer::draw_list(frame, conversation, bottom_area, app);
    }
    if let Some(modal) = &app.modal {
        draw_modal(frame, conversation, app, modal);
    }
    draw_status(frame, status, app);
}

/// The three columns of `columns`: the thread list on the left, the middle (header, conversation,
/// composer), the panel on the right. A side column that is closed, has nothing to show or has no
/// room is `None` and the middle takes its width. From `WIDE_COLUMNS` up both side columns fit;
/// below it they share one slot, the list while it has the keys and the panel otherwise.
fn split_columns(app: &App, columns: Rect) -> (Option<Rect>, Option<Rect>, Rect) {
    let w = columns.width;
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
    let [list, middle, side] = Layout::horizontal([
        Constraint::Length(list_w),
        Constraint::Min(10),
        Constraint::Length(side_w),
    ])
    .areas(columns);
    (list_on.then_some(list), panel_on.then_some(side), middle)
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
    let roles = crew_roles(app, words);
    if roles.is_empty() {
        return roles;
    }
    let mut out = vec![Span::styled(
        format!("{} ", tr("header.crew")),
        app.theme.dim_style(),
    )];
    out.extend(roles);
    out
}

/// The crew's roles with the model each runs, without the `Crew` label; empty with the crew off.
fn crew_roles(app: &App, words: bool) -> Vec<Span<'static>> {
    let t = &app.theme;
    let own = app.own_crew();
    let current = app.current_model();
    let brain = current
        .as_ref()
        .and_then(|m| Some((m["instanceId"].as_str()?, m["model"].as_str()?)));
    let Some(roles) =
        crate::crew::roles_of(&app.config, own.as_ref(), brain, app.active != Active::None)
    else {
        return Vec::new();
    };
    let dot = if app.settings.ascii { "|" } else { "·" };
    let mut out = Vec::new();
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
/// whether she is in her one-line form. The compact header always shows her so, in a strip at its
/// end. The full header gives her the five-row strip beside the box while the box keeps its labels
/// and she fits; otherwise `mini` is set with a width of 0 and she walks the rule at its foot,
/// which takes none of the box's room.
struct PetStrip {
    width: usize,
    mini: bool,
    /// Cells of `width` beyond her own strip, which she paces while a turn runs.
    roam: usize,
}

fn pet_strip(app: &App, columns: u16, full: bool, notes_min: usize) -> PetStrip {
    let columns = usize::from(columns);
    let avail = if full {
        columns.saturating_sub(BOX_X + notes_min)
    } else {
        columns.saturating_sub(24)
    };
    if !app.settings.pet {
        return PetStrip {
            width: 0,
            mini: !full,
            roam: 0,
        };
    }
    if full {
        // Beside the box she is taken only while it keeps its labels and she has her whole walk;
        // with less she would pace less than on the rule.
        if notes_min >= BOX_FULL_MIN && avail >= pet::PET_TRACK_WIDTH + pet::ROAM_MAX {
            return PetStrip {
                width: pet::PET_TRACK_WIDTH + pet::ROAM_MAX,
                mini: false,
                roam: pet::ROAM_MAX,
            };
        }
        return PetStrip {
            width: 0,
            mini: true,
            roam: 0,
        };
    }
    PetStrip {
        width: if avail >= pet::PET_MINI_TRACK_WIDTH {
            pet::PET_MINI_TRACK_WIDTH
        } else {
            0
        },
        mini: true,
        roam: 0,
    }
}

/// The state and picture Mocha is drawn in; remembers them so the app repaints only on a change.
fn pet_view(app: &App) -> (pet::PetState, usize, pet::Draw) {
    let state = app.pet_state();
    let frame = app.pet_frame(state);
    app.pet_shown.set(Some((state, frame)));
    let draw = pet::Draw {
        level: app.misc.level,
        ascii: app.settings.ascii,
    };
    (state, frame, draw)
}

/// Which form the info box beside the wordmark takes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum BoxForm {
    /// Labels and values.
    Full,
    /// Values alone.
    Compact,
    /// No box; the facts go back beside the wordmark.
    Hidden,
}

struct FullHeader {
    pet: PetStrip,
    form: BoxForm,
    /// Cells of the rows beside the pet's strip: the wordmark's column and the box.
    lead: usize,
    box_width: usize,
}

/// How the full header is laid out at this width. The box has the room before Mocha does: she
/// shrinks to her one-line form, then goes, before the box loses its labels; she keeps what is
/// left once the box is down to its values alone; and only when even that box would not fit does
/// it go and the pet get the room the plain header gave her.
fn full_header(app: &App, columns: u16) -> FullHeader {
    let width = usize::from(columns);
    let lead_of = |pet: &PetStrip| {
        if pet.width == 0 {
            width.saturating_sub(1)
        } else {
            width.saturating_sub(pet.width)
        }
    };
    for notes_min in [BOX_FULL_MIN, BOX_COMPACT_MIN] {
        let pet = pet_strip(app, columns, true, notes_min);
        let box_width = lead_of(&pet).saturating_sub(BOX_X);
        if box_width >= notes_min {
            let box_width = box_width.min(BOX_MAX);
            return FullHeader {
                lead: BOX_X + box_width,
                pet,
                form: if box_width >= BOX_FULL_MIN {
                    BoxForm::Full
                } else {
                    BoxForm::Compact
                },
                box_width,
            };
        }
    }
    let pet = pet_strip(app, columns, true, PLAIN_NOTES_MIN);
    FullHeader {
        lead: lead_of(&pet),
        pet,
        form: BoxForm::Hidden,
        box_width: 0,
    }
}

/// `text` cut from the left to `max` cells, with an ellipsis in front of what is left.
fn truncate_left(text: &str, max: usize) -> String {
    if width(text) <= max {
        return text.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut kept = Vec::new();
    let mut used = 1;
    for ch in text.chars().rev() {
        let w = char_width(ch);
        if used + w > max {
            break;
        }
        used += w;
        kept.push(ch);
    }
    kept.push('…');
    kept.iter().rev().collect()
}

/// The auth row's value: how the provider is signed in, or that this is not known.
fn auth_spans(app: &App) -> Vec<Span<'static>> {
    let dim = app.theme.dim_style();
    match app.auth_kind() {
        AuthKind::ApiKey => vec![Span::raw(tr("auth.apiKey"))],
        AuthKind::Subscription(plan) => {
            let mut out = vec![Span::raw(tr("auth.subscription"))];
            if let Some(plan) = plan {
                out.push(Span::styled(
                    format!(" {} {}", dot_of(app), sanitize(&plan).replace('\n', " ")),
                    dim,
                ));
            }
            out
        }
        AuthKind::SignedOut => vec![Span::styled(
            tr("auth.signedOut"),
            Style::new().fg(app.theme.warning),
        )],
        AuthKind::Other(label) => vec![Span::raw(sanitize(&label).replace('\n', " "))],
        AuthKind::Unknown => vec![Span::styled(tr("auth.unknown"), dim)],
    }
}

fn dot_of(app: &App) -> &'static str {
    if app.settings.ascii { "|" } else { "·" }
}

/// The box beside the wordmark, `BOX_ROWS` rows of `box_width` cells: the product and version on
/// the top edge, then the provider, model, sign-in, work folder and crew, a muted label and a
/// plain value each.
fn info_box(app: &App, box_width: usize, form: BoxForm) -> Vec<Vec<Span<'static>>> {
    let t = &app.theme;
    let edge = Style::new().fg(t.border);
    let [top_left, top_right, bottom_left, bottom_right] = app.sym.corners;
    let inner = box_width.saturating_sub(4);
    let labeled = form == BoxForm::Full;
    let name = if labeled {
        format!("{} v{}", tr("header.title"), app.version)
    } else {
        format!("OOP v{}", app.version)
    };
    let mut title = vec![Span::styled(
        name,
        Style::new().fg(t.brand).add_modifier(Modifier::BOLD),
    )];
    if labeled {
        title.push(Span::styled(format!(" {} ", dot_of(app)), t.dim_style()));
        title.push(Span::styled(crate::i18n::TAGLINE, t.muted_style()));
    }
    let title = clip_spans(title, box_width.saturating_sub(6));
    let fill = box_width.saturating_sub(spans_width(&title) + 5);
    let mut top = vec![Span::styled(format!("{top_left}{} ", app.sym.rule), edge)];
    top.extend(title);
    top.push(Span::styled(
        format!(" {}{top_right}", app.sym.rule.repeat(fill)),
        edge,
    ));

    let provider = app.provider_name().map_or_else(
        || vec![Span::styled(tr("header.noProvider"), t.dim_style())],
        |name| vec![Span::raw(sanitize(&name).replace('\n', " "))],
    );
    let model = if app.model_display().is_empty() {
        vec![Span::styled(tr("header.noModel"), t.dim_style())]
    } else {
        vec![Span::raw(model_label(app))]
    };
    let rows = [
        ("header.provider", provider),
        ("header.model", model),
        ("header.auth", auth_spans(app)),
        ("header.folder", Vec::new()),
        ("header.crew", Vec::new()),
    ];
    let label_width = rows
        .iter()
        .map(|(key, _)| width(tr(key)))
        .max()
        .unwrap_or(0);
    let room = if labeled {
        inner.saturating_sub(label_width + 2)
    } else {
        inner
    };
    let folder = vec![Span::raw(truncate_left(
        &home_relative(&sanitize(&app.workdir()).replace('\n', " "), &app.home),
        room,
    ))];
    let crew = {
        let words = crew_roles(app, true);
        if !labeled {
            // No label column to say what the row is: the crew names itself.
            if words.is_empty() {
                vec![Span::styled(
                    format!("{} {}", tr("header.crew"), tr("header.crewOff")),
                    t.dim_style(),
                )]
            } else {
                crew_spans(app, false)
            }
        } else if words.is_empty() {
            vec![Span::styled(tr("header.crewOff"), t.dim_style())]
        } else if spans_width(&words) <= room {
            words
        } else {
            crew_roles(app, false)
        }
    };
    let mut out = vec![top];
    for (key, value) in rows {
        let value = match key {
            "header.folder" => folder.clone(),
            "header.crew" => crew.clone(),
            _ => value,
        };
        let mut row = vec![Span::styled(format!("{} ", app.sym.bar), edge)];
        let mut cell = Vec::new();
        if labeled {
            cell.push(Span::styled(
                format!("{}{}  ", tr(key), " ".repeat(label_width - width(tr(key)))),
                t.muted_style(),
            ));
        }
        cell.extend(value);
        row.extend(pad_spans(clip_spans(cell, inner), inner));
        row.push(Span::styled(format!(" {}", app.sym.bar), edge));
        out.push(row);
    }
    out.push(vec![Span::styled(
        format!(
            "{bottom_left}{}{bottom_right}",
            app.sym.rule.repeat(box_width.saturating_sub(2))
        ),
        edge,
    )]);
    out
}

/// The tip line: the label and the tip the clock has come to. Remembers which, so the app repaints
/// for a tip only when the next one is another.
fn tip_line(app: &App, wide: usize) -> Vec<Span<'static>> {
    let index = app.tip_index();
    app.tip_shown.set(Some(index));
    let label = format!("{} ", tr("header.tip"));
    let room = wide.saturating_sub(width(&label));
    vec![
        Span::styled(label, app.theme.dim_style()),
        Span::styled(
            truncate(crate::i18n::tip(index, app.in_oop_terminal), room),
            app.theme.muted_style(),
        ),
    ]
}

/// The rule at the header's foot, `wide` cells, with Mocha's one-line form on it. She walks up to
/// `ROAM_MAX` cells along it while a turn runs, which is room the box beside the wordmark does not
/// lose; the strip she walks in is as wide idle as working.
fn rule_with_pet(
    app: &App,
    wide: usize,
    state: pet::PetState,
    frame_no: usize,
    draw: pet::Draw,
) -> Line<'static> {
    let dim = app.theme.dim_style();
    let roam = (wide - pet::PET_MINI_TRACK_WIDTH).min(pet::ROAM_MAX);
    let track = pet::PET_MINI_TRACK_WIDTH + roam;
    let at = app.pet_offset(state, roam);
    let mut spans: Vec<Span<'static>> = pet::mini(state, frame_no, &app.theme, track, at, draw)
        .spans
        .into_iter()
        .map(|span| {
            // The strip's blank cells are rule again, so she stands on the line, not in a gap.
            if span.content.chars().all(|c| c == ' ') {
                Span::styled(app.sym.rule.repeat(span.content.chars().count()), dim)
            } else {
                span
            }
        })
        .collect();
    spans.push(Span::styled(app.sym.rule.repeat(wide - track), dim));
    Line::from(spans)
}

fn draw_header(frame: &mut Frame, area: Rect, app: &App, kind: &Header) {
    let t = &app.theme;
    let dim = t.dim_style();
    let state_key = app.state_key();
    let state = Span::styled(
        format!("{} {}", app.sym.bullet, tr(state_key)),
        state_style(app, state_key),
    );
    let title = Span::styled(
        format!("OOP v{}", app.version),
        Style::new().fg(t.brand).add_modifier(Modifier::BOLD),
    );
    let model = Span::styled(model_label(app), t.muted_style());
    let columns = usize::from(area.width);
    if !matches!(kind, Header::Full) {
        app.tip_shown.set(None);
    }
    match kind {
        Header::Minimal => {
            let line = Line::from(vec![title, Span::styled(" · ", dim), state]);
            frame.render_widget(Paragraph::new(line), area);
            return;
        }
        Header::Compact => {
            let track = pet_strip(app, area.width, false, 0).width;
            let room = columns.saturating_sub(track + 1);
            let sep = Span::styled(if app.settings.ascii { " | " } else { " · " }, dim);
            let mut facts = vec![title, sep.clone(), state, sep.clone(), model];
            // The crew is cut last; with less than a few cells it is left out whole rather than
            // shown as a stub.
            let crew = crew_spans(app, false);
            let crew_room = room
                .saturating_sub(spans_width(&facts))
                .saturating_sub(width(&sep.content));
            if !crew.is_empty() && crew_room >= 14 {
                facts.push(sep);
                facts.extend(clip_spans(crew, crew_room));
            }
            let mut spans = pad_spans(clip_spans(facts, room), room);
            if track > 0 {
                let (pet_state, frame_no, draw) = pet_view(app);
                spans.extend(pet::mini(pet_state, frame_no, &app.theme, track, 0, draw).spans);
            }
            frame.render_widget(Paragraph::new(Line::from(spans)), area);
            return;
        }
        Header::Full => {}
    }
    let wide = columns.saturating_sub(1);
    let FullHeader {
        pet: strip,
        form,
        lead: lead_width,
        box_width,
    } = full_header(app, area.width);
    let track = strip.width;
    debug_assert_eq!(WORDMARK[0].chars().count(), usize::from(LOGO_WIDTH));
    let pet_rows = if track == 0 {
        Vec::new()
    } else {
        let (pet_state, frame_no, draw) = pet_view(app);
        let at = app.pet_offset(pet_state, strip.roam);
        pet::lines(pet_state, frame_no, &app.theme, track, at, draw)
    };
    let rule = if strip.mini && wide >= pet::PET_MINI_TRACK_WIDTH {
        let (pet_state, frame_no, draw) = pet_view(app);
        rule_with_pet(app, wide, pet_state, frame_no, draw)
    } else {
        Line::from(Span::styled(app.sym.rule.repeat(wide), dim))
    };
    // A row of the header with the pet's row beside it, when she has one there.
    let with_pet = |row: usize, spans: Vec<Span<'static>>| {
        let mut spans = pad_spans(clip_spans(spans, lead_width), lead_width);
        if let Some(pet_row) = pet_rows.get(row) {
            spans.extend(pet_row.spans.clone());
        }
        Line::from(spans)
    };
    let art_of = |i: usize| {
        let art = if app.settings.ascii {
            WORDMARK[i].replace(['▄', '▀', '█'], "#")
        } else {
            WORDMARK[i].to_string()
        };
        Span::styled(art, Style::new().fg(t.gradient[i]))
    };
    let mut lines: Vec<Line> = Vec::new();
    if form == BoxForm::Hidden {
        let notes = [
            Some(title),
            Some(state),
            Some(model),
            Some(Span::styled(mode_label(app), dim)),
        ];
        for (i, note) in notes.into_iter().enumerate() {
            let mut spans = vec![art_of(i), Span::raw("  ")];
            spans.extend(note);
            lines.push(with_pet(i, spans));
        }
        let folder = home_relative(&sanitize(&app.workdir()), &app.home);
        let folder_spans = vec![
            Span::styled(format!("{} ", tr("header.folder")), dim),
            Span::raw(folder),
        ];
        // The folder row shares the strip with the pet's fifth row; its text stops before it.
        let room = if pet_rows.len() > WORDMARK.len() {
            lead_width
        } else {
            wide
        };
        let folder_row = if crew_spans(app, false).is_empty() {
            clip_spans(folder_spans, room)
        } else {
            crew_beside(app, folder_spans, room)
        };
        lines.push(with_pet(WORDMARK.len(), folder_row));
    } else {
        let boxed = info_box(app, box_width, form);
        for (i, box_row) in boxed.into_iter().enumerate() {
            let mut left = match i {
                0..=3 => vec![art_of(i), Span::raw("  ")],
                4 => vec![state.clone()],
                5 => vec![Span::styled(mode_label(app), dim)],
                _ => Vec::new(),
            };
            left = pad_spans(clip_spans(left, BOX_X), BOX_X);
            left.extend(box_row);
            lines.push(with_pet(i, left));
        }
    }
    lines.push(Line::from(tip_line(app, wide)));
    lines.push(rule);
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
    // The usage panel takes the foot; everything below (rows, scrolling, clicks) is the top part.
    let area = crate::usage_panel::draw(frame, area, app);
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
    // After a finished turn the last line is the `[Replay]` button; it is not part of the transcript.
    let replay_button = crate::replay::button_visible(app);
    if replay_button {
        if !tail.is_empty() {
            tail.push(Line::default());
        }
        tail.push(crate::replay::button_line(app));
    }
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
    crate::replay::place_button(app, area, pad, (total.saturating_sub(1), start, end));
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
    crate::composer::draw_input(frame, inner, app);
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
    let mut hits = Vec::new();
    for (i, item) in items.iter().enumerate().skip(first).take(room) {
        hits.push((inner.y + lines.len() as u16, i));
        lines.push(option_line(
            app,
            i == cursor,
            truncate(item, usize::from(inner.width).saturating_sub(2)),
        ));
    }
    *app.modal_hits.borrow_mut() = (rect, hits);
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
    } else if crate::replay::is_open(app) {
        crate::replay::hint()
    } else if app.modal.is_some() {
        tr(match &app.modal {
            Some(Modal::Models { .. }) => "hint.modelPicker",
            Some(Modal::Pick(pick)) if pick.typed.is_some() => "hint.folderPicker",
            _ => "hint.picker",
        })
    } else if app.focus == Focus::Composer && app.approval().is_some() {
        tr("hint.approval")
    } else if app.focus == Focus::Composer && app.pending_input().is_some() {
        tr("hint.question")
    } else if app.focus == Focus::List {
        tr("hint.list")
    } else if app.conv.busy() {
        tr("hint.working")
    } else if let Some(hint) = crate::cmd_continue::hint(app) {
        hint
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
    // On the right, kept whole while the left text gives way: the thread's goal, and before it the
    // way back to a side pane that is closed.
    let goal = crate::cmd_goal::goal_bar(app).map(|bar| format!(" {} ", sanitize(&bar)));
    let goal_room = goal.as_ref().map_or(0, |bar| width(bar) + 1);
    let closed = app
        .closed_panes_hint()
        .map(|hint| format!(" {hint} "))
        .filter(|hint| usize::from(area.width) >= CLOSED_HINT_MIN_COLUMNS + width(hint));
    let closed_room = closed.as_ref().map_or(0, |hint| width(hint) + 1);
    let line = Line::from(Span::styled(
        format!(
            " {}",
            truncate(
                &sanitize(&text).replace('\n', " "),
                usize::from(area.width).saturating_sub(2 + goal_room + closed_room)
            )
        ),
        style,
    ));
    frame.render_widget(Paragraph::new(line), area);
    let mut right = area.right();
    let mut put = |text: String, style: Style| {
        let room = u16::try_from(width(&text))
            .unwrap_or(u16::MAX)
            .min(right - area.x);
        right -= room;
        let rect = Rect::new(right, area.y, room, area.height.min(1));
        frame.render_widget(Paragraph::new(Span::styled(text, style)), rect);
    };
    if let Some(bar) = goal {
        put(bar, Style::new().fg(t.brand));
    }
    if let Some(hint) = closed {
        put(hint, t.dim_style());
    }
}

#[allow(dead_code)]
fn cells(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

#[cfg(test)]
#[path = "ui_tests.rs"]
mod tests;
