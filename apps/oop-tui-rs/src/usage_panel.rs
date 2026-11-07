//! The provider usage panel at the bottom of the left pane: for every usable provider that reports
//! quota windows, a horizontal gauge per window (`label ██████░░░░ 62%`, filled = used). A provider
//! with a single window is one line, its name in place of the label; with several it gets a header
//! line first. The server publishes only percentages and reset times (no tokens or money).
//! `rows` is pure; `draw` is the only part that touches the screen.

use crate::app::App;
use crate::i18n::{Lang, lang, tr};
use crate::text::{parse_iso_ms, sanitize, truncate, width};
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use serde_json::Value;

/// The panel is left out when the left pane is shorter than this.
const MIN_PANE_ROWS: u16 = 12;
const USED_WARNING: f64 = 70.0;
const USED_ERROR: f64 = 90.0;
/// A bar is never narrower than this (the line drops it and shows `label NN%` instead), never wider
/// than `MAX_BAR`, and the reset time is added only when the bar still keeps `MIN_BAR_WITH_RESET`.
const MIN_BAR: usize = 6;
const MAX_BAR: usize = 20;
const MIN_BAR_WITH_RESET: usize = 10;

/// How a row is painted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Header,
    Normal,
    Warning,
    Error,
    Dim,
}

/// Where the bar sits in a row's text (byte offsets): `start..fill` is the used part, painted with
/// the row's `kind`, `fill..end` the empty part, dim. Text before `start` is painted as `lead`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bar {
    pub start: usize,
    pub fill: usize,
    pub end: usize,
    pub lead: Kind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub text: String,
    pub kind: Kind,
    pub bar: Option<Bar>,
}

impl Row {
    fn plain(text: String, kind: Kind) -> Row {
        Row {
            text,
            kind,
            bar: None,
        }
    }
}

/// `2h 13m`, `3d 4h`, `12m` (the web app's `formatDuration`), or "now" once the reset has passed.
fn until(resets_at: i64, now: i64, ko: bool) -> String {
    if resets_at <= now {
        return if ko { "지금" } else { "now" }.into();
    }
    let minutes = (resets_at - now) / 60_000;
    let (days, hours, mins) = (minutes / 1440, minutes % 1440 / 60, minutes % 60);
    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {mins}m")
    } else {
        format!("{mins}m")
    }
}

/// `until` cut to its largest unit: `2h`, `3d`, `12m`.
fn until_short(resets_at: i64, now: i64, ko: bool) -> String {
    let full = until(resets_at, now, ko);
    full.split(' ').next().unwrap_or_default().to_string()
}

/// `width` cells of bar for `used` percent: whole blocks, one eighth-block for the part cell, then
/// light shade. Any non-zero use shows at least one eighth. Returns the bar and the byte length of
/// its used part.
fn bar_glyphs(used: f64, width: usize) -> (String, usize) {
    const PART: [char; 7] = ['▏', '▎', '▍', '▌', '▋', '▊', '▉'];
    let mut eighths = (used / 100.0 * (width * 8) as f64).round() as usize;
    if used > 0.0 {
        eighths = eighths.max(1);
    }
    let eighths = eighths.min(width * 8);
    let (full, part) = (eighths / 8, eighths % 8);
    let mut bar = "█".repeat(full);
    if part > 0 {
        bar.push(PART[part - 1]);
    }
    let fill = bar.len();
    let cells = full + usize::from(part > 0);
    bar.push_str(&"░".repeat(width - cells));
    (bar, fill)
}

struct Win {
    label: String,
    used_raw: f64,
    used: f64,
    reset: Option<i64>,
}

fn parse_window(window: &Value) -> Option<Win> {
    let used_raw = window["usedPercent"].as_f64()?.clamp(0.0, 100.0);
    Some(Win {
        label: sanitize(window["label"].as_str()?).replace('\n', " "),
        used_raw,
        used: used_raw.round(),
        reset: window["resetsAt"].as_str().and_then(parse_iso_ms),
    })
}

fn pad(text: &str, to: usize) -> String {
    format!("{text}{}", " ".repeat(to.saturating_sub(width(text))))
}

/// One gauge line fitted to `w` cells: ` label bar NN% [reset]`. `label_w` and `pct_w` are the
/// provider's widest label and percentage so the bars of its windows line up. The label is cut to
/// keep a bar of `MIN_BAR`; with no room for that the line is just ` label  NN%`.
#[allow(clippy::too_many_arguments)]
fn gauge(
    label: &str,
    lead: Kind,
    win: &Win,
    label_w: usize,
    pct_w: usize,
    now: i64,
    w: usize,
    ko: bool,
) -> Row {
    let kind = if win.used_raw >= USED_ERROR {
        Kind::Error
    } else if win.used_raw >= USED_WARNING {
        Kind::Warning
    } else {
        Kind::Normal
    };
    let pct = format!("{}%", win.used);
    // Indent, spaces around the bar, and the percentage take everything but label and bar.
    let fixed = 3 + pct_w;
    let label_room = w.saturating_sub(fixed + MIN_BAR);
    let label_w = label_w.min(label_room);
    if label_w < width(label).min(3) {
        let room = w.saturating_sub(3 + width(&pct));
        let text = format!(" {}  {pct}", truncate(label, room));
        let text = if width(&text) > w {
            truncate(&pct, w)
        } else {
            text
        };
        return Row::plain(text, kind);
    }
    let mut bar_w = w - fixed - label_w;
    let reset = win.reset.map(|at| until_short(at, now, ko));
    let reset = reset.filter(|r| bar_w >= MIN_BAR_WITH_RESET + 1 + width(r));
    if let Some(r) = &reset {
        bar_w -= 1 + width(r);
    }
    let bar_w = bar_w.min(MAX_BAR);
    let (bar, filled) = bar_glyphs(win.used, bar_w);
    let mut text = format!(" {} ", pad(&truncate(label, label_w), label_w));
    let start = text.len();
    text.push_str(&bar);
    let (fill, end) = (start + filled, text.len());
    text.push_str(&format!(" {pct:>pct_w$}"));
    let text = match reset {
        Some(r) => format!("{text} {r}"),
        None => text,
    };
    Row {
        text,
        kind,
        bar: Some(Bar {
            start,
            fill,
            end,
            lead,
        }),
    }
}

/// Every usable provider with at least one window, as gauge rows no wider than `w`; one dim line
/// when there is nothing to show.
pub fn rows(providers: &Value, now: i64, w: usize, ko: bool) -> Vec<Row> {
    let mut out = Vec::new();
    for provider in providers.as_array().into_iter().flatten() {
        let usable = provider["enabled"].as_bool() == Some(true)
            && provider["installed"].as_bool() == Some(true)
            && provider["availability"].as_str() != Some("unavailable");
        let limits = &provider["usageLimits"];
        if !usable || !limits["unavailable"].is_null() {
            continue;
        }
        let wins: Vec<Win> = limits["windows"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(parse_window)
            .collect();
        if wins.is_empty() {
            continue;
        }
        let name = provider["displayName"]
            .as_str()
            .or_else(|| provider["instanceId"].as_str())
            .unwrap_or("?");
        let name = sanitize(name).replace('\n', " ");
        let pct_w = wins
            .iter()
            .map(|win| width(&format!("{}%", win.used)))
            .max()
            .unwrap_or(0);
        if let [only] = wins.as_slice() {
            let label_w = width(&name);
            out.push(gauge(&name, Kind::Header, only, label_w, pct_w, now, w, ko));
            continue;
        }
        out.push(Row::plain(truncate(&format!(" {name}"), w), Kind::Header));
        let label_w = wins.iter().map(|win| width(&win.label)).max().unwrap_or(0);
        for win in &wins {
            out.push(gauge(
                &win.label,
                Kind::Normal,
                win,
                label_w,
                pct_w,
                now,
                w,
                ko,
            ));
        }
    }
    if out.is_empty() {
        out.push(Row::plain(
            truncate(
                &format!(
                    " {}",
                    if ko {
                        "사용량 정보 없음"
                    } else {
                        "No usage data"
                    }
                ),
                w,
            ),
            Kind::Dim,
        ));
    }
    out
}

fn style(app: &App, kind: Kind) -> Style {
    let t = &app.theme;
    match kind {
        Kind::Header => Style::new().fg(t.muted).add_modifier(Modifier::BOLD),
        Kind::Normal => Style::new(),
        Kind::Warning => Style::new().fg(t.warning),
        Kind::Error => Style::new().fg(t.error),
        Kind::Dim => t.dim_style(),
    }
}

/// A row as spans: the used part of the bar in the row's colour, the empty part dim.
fn line<'a>(app: &App, row: &'a Row) -> Line<'a> {
    let Some(b) = row.bar else {
        return Line::from(Span::styled(row.text.as_str(), style(app, row.kind)));
    };
    Line::from(vec![
        Span::styled(&row.text[..b.start], style(app, b.lead)),
        Span::styled(&row.text[b.start..b.fill], style(app, row.kind)),
        Span::styled(&row.text[b.fill..b.end], style(app, Kind::Dim)),
        Span::raw(&row.text[b.end..]),
    ])
}

fn now_ms() -> i64 {
    parse_iso_ms(&crate::text::iso_now()).unwrap_or(0)
}

/// The rows the panel would show in a pane `pane` cells wide, or `None` when it is off or the pane
/// is too short (`height`). Shared by `draw` and the tick so both agree.
fn visible_rows(app: &App, pane: u16, height: u16) -> Option<Vec<Row>> {
    if !app.settings.usage || height < MIN_PANE_ROWS {
        return None;
    }
    let ko = lang() == Lang::Ko;
    Some(rows(
        &app.config["providers"],
        now_ms(),
        usize::from(pane.saturating_sub(1)),
        ko,
    ))
}

/// Draws the panel at the foot of `area` and returns the part above it, which is the list's.
pub fn draw(frame: &mut Frame, area: Rect, app: &App) -> Rect {
    *app.usage_drawn.borrow_mut() = None;
    let Some(mut all) = visible_rows(app, area.width, area.height) else {
        return area;
    };
    let cap = usize::from(area.height * 2 / 5).saturating_sub(1).max(1);
    all.truncate(cap);
    let panel_h = all.len() as u16 + 1;
    let [top, bottom] =
        Layout::vertical([Constraint::Min(3), Constraint::Length(panel_h)]).areas(area);
    let t = &app.theme;
    let block = Block::default()
        .borders(Borders::TOP | Borders::RIGHT)
        .border_style(Style::new().fg(t.border))
        .title(Span::styled(
            format!(" {} ", tr("list.usage")),
            t.dim_style(),
        ));
    let inner = block.inner(bottom);
    frame.render_widget(block, bottom);
    let lines: Vec<Line> = all.iter().map(|row| line(app, row)).collect();
    frame.render_widget(Paragraph::new(lines), inner);
    *app.usage_drawn.borrow_mut() = Some((
        area.width,
        area.height,
        all.into_iter().map(|r| r.text).collect(),
    ));
    top
}

/// True when the panel on screen would read differently now (a countdown crossed a minute, or the
/// data changed under it); false while it is hidden.
pub fn changed(app: &App) -> bool {
    let drawn = app.usage_drawn.borrow();
    let Some((pane, height, shown)) = drawn.as_ref() else {
        return false;
    };
    let Some(mut now) = visible_rows(app, *pane, *height) else {
        return false;
    };
    now.truncate(shown.len());
    now.iter().map(|r| &r.text).ne(shown.iter())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000_000;

    fn at(minutes: i64) -> String {
        let secs = (NOW + minutes * 60_000) / 1000;
        let (y, mo, d) = crate::text::civil_from_days(secs.div_euclid(86_400));
        let rem = secs.rem_euclid(86_400);
        format!(
            "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
            rem / 3600,
            rem % 3600 / 60,
            rem % 60
        )
    }

    fn provider(name: &str, windows: Value) -> Value {
        json!({"instanceId": name, "displayName": name, "enabled": true, "installed": true,
            "usageLimits": {"checkedAt": at(0), "windows": windows}})
    }

    fn window(label: &str, used: f64, reset_in: i64) -> Value {
        json!({"id": label, "kind": "session", "label": label, "usedPercent": used, "resetsAt": at(reset_in)})
    }

    fn texts(rows: &[Row]) -> Vec<&str> {
        rows.iter().map(|r| r.text.as_str()).collect()
    }

    fn bar_of(text: &str) -> String {
        text.chars().filter(|c| "█▏▎▍▌▋▊▉░".contains(*c)).collect()
    }

    #[test]
    fn fills_the_bar_in_proportion_to_use() {
        assert_eq!(bar_glyphs(0.0, 10), ("░".repeat(10), 0));
        assert_eq!(bar_glyphs(100.0, 10), ("█".repeat(10), 30));
        assert_eq!(bar_glyphs(50.0, 10).0, "█████░░░░░");
        // 62% of 80 eighths is 49.6, so 50: six whole cells and two eighths.
        assert_eq!(bar_glyphs(62.0, 10).0, "██████▎░░░");
        // A trace of use still shows; rounding is to the nearest eighth.
        assert_eq!(bar_glyphs(1.0, 10).0, "▏░░░░░░░░░");
        assert_eq!(bar_glyphs(99.0, 10).0, "█████████▉");
        for used in 0..=100 {
            for w in [6, 10, 20] {
                assert_eq!(bar_glyphs(f64::from(used), w).0.chars().count(), w);
            }
        }
    }

    #[test]
    fn a_gauge_line_has_label_bar_and_used_percent() {
        let p = json!([provider(
            "Claude",
            json!([window("Session", 50.0, 133), window("Week", 5.0, 133)])
        )]);
        let r = rows(&p, NOW, 24, false);
        assert_eq!(
            texts(&r),
            [
                " Claude",
                " Session █████▌░░░░░ 50%",
                " Week    ▌░░░░░░░░░░  5%"
            ]
        );
    }

    #[test]
    fn formats_the_reset_like_the_web_app() {
        assert_eq!(until(NOW + 12 * 60_000, NOW, false), "12m");
        assert_eq!(until(NOW + 133 * 60_000, NOW, false), "2h 13m");
        assert_eq!(
            until(NOW + (3 * 1440 + 4 * 60) * 60_000, NOW, false),
            "3d 4h"
        );
        assert_eq!(until(NOW - 1, NOW, false), "now");
        assert_eq!(until(NOW, NOW, true), "지금");
    }

    #[test]
    fn the_reset_is_shown_only_when_the_bar_stays_roomy() {
        let p = json!([provider("Claude", json!([window("Session", 62.0, 133)]))]);
        let roomy = rows(&p, NOW, 40, false);
        assert!(roomy[0].text.ends_with("62% 2h"), "{}", roomy[0].text);
        assert!(bar_of(&roomy[0].text).chars().count() >= MIN_BAR_WITH_RESET);
        let tight = rows(&p, NOW, 24, false);
        assert!(tight[0].text.ends_with("62%"), "{}", tight[0].text);
        assert!(!tight[0].text.contains("2h"));
    }

    #[test]
    fn a_single_window_provider_is_one_line_and_several_get_a_header() {
        let one = json!([provider("Claude", json!([window("Session", 62.0, 5)]))]);
        let r = rows(&one, NOW, 30, false);
        assert_eq!(r.len(), 1);
        assert!(r[0].text.starts_with(" Claude "), "{}", r[0].text);
        assert_eq!(r[0].bar.map(|b| b.lead), Some(Kind::Header));
        let two = json!([provider(
            "Claude",
            json!([window("Session", 62.0, 5), window("Week", 5.0, 5)])
        )]);
        let r = rows(&two, NOW, 30, false);
        assert_eq!((r.len(), r[0].kind, r[0].bar), (3, Kind::Header, None));
    }

    #[test]
    fn the_bar_part_is_addressed_by_byte_offsets() {
        let p = json!([provider(
            "A",
            json!([window("S", 62.0, 5), window("W", 10.0, 5)])
        )]);
        for row in rows(&p, NOW, 30, false)
            .iter()
            .filter_map(|r| r.bar.map(|b| (r, b)))
        {
            let (row, b) = row;
            let used = &row.text[b.start..b.fill];
            let rest = &row.text[b.fill..b.end];
            assert!(used.chars().all(|c| c != '░'), "{used:?}");
            assert!(
                rest.chars().all(|c| c == '░' || "▏▎▍▌▋▊▉".contains(c)),
                "{rest:?}"
            );
        }
    }

    #[test]
    fn a_narrow_pane_falls_back_to_the_label_and_never_overflows() {
        let p = json!([provider(
            "한글 프로바이더 이름이 아주 긴 경우",
            json!([
                window("Session", 62.0, 133),
                window("주간 한도 아주 긴 이름", 5.0, 9000)
            ])
        )]);
        let single = json!([provider("한글 이름", json!([window("S", 100.0, 5)]))]);
        for ko in [false, true] {
            for w in [4, 8, 12, 14, 20, 24, 29, 37, 60] {
                for src in [&p, &single] {
                    for row in rows(src, NOW, w, ko) {
                        assert!(width(&row.text) <= w, "{w}: {:?}", row.text);
                    }
                }
            }
        }
        let r = rows(&p, NOW, 12, false);
        assert!(r[1].bar.is_none(), "{:?}", r[1]);
        assert!(r[1].text.ends_with("62%"), "{:?}", r[1]);
        let r = rows(&p, NOW, 29, false);
        assert!(r[1].bar.is_some() && r[2].bar.is_some());
    }

    #[test]
    fn skips_unavailable_windowless_and_disabled_providers() {
        let mut off = provider("Off", json!([window("S", 1.0, 5)]));
        off["enabled"] = json!(false);
        let mut down = provider("Down", json!([window("S", 1.0, 5)]));
        down["usageLimits"]["unavailable"] = json!({"reason": "unsupported"});
        let p = json!([
            off,
            down,
            provider("Empty", json!([])),
            provider("Ok", json!([window("S", 1.0, 5)]))
        ]);
        let r = rows(&p, NOW, 40, false);
        assert!(texts(&r)[0].starts_with(" Ok "), "{r:?}");
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn says_so_when_there_is_nothing() {
        let none = rows(&json!([]), NOW, 40, false);
        assert_eq!(texts(&none), [" No usage data"]);
        assert_eq!(none[0].kind, Kind::Dim);
        assert_eq!(
            texts(&rows(&Value::Null, NOW, 40, true)),
            [" 사용량 정보 없음"]
        );
    }

    #[test]
    fn colours_by_how_much_is_used() {
        let p = json!([provider(
            "A",
            json!([
                window("a", 69.0, 5),
                window("b", 70.0, 5),
                window("c", 89.0, 5),
                window("d", 90.0, 5)
            ])
        )]);
        let kinds: Vec<Kind> = rows(&p, NOW, 40, false)
            .iter()
            .skip(1)
            .map(|r| r.kind)
            .collect();
        assert_eq!(
            kinds,
            [Kind::Normal, Kind::Warning, Kind::Warning, Kind::Error]
        );
    }
}
