//! ```chart and ```mermaid blocks of an assistant reply, drawn with block and braille characters.
//!
//! The contract is the desktop app's: `parse` reads the same JSON as
//! packages/client-runtime/src/visualBlocks.ts (the same aliases, caps and leniency), and every kind
//! the web draws has a terminal rendering here. `render` is a pure function of (spec, width,
//! progress 0..1, theme, symbols): the same inputs give the same lines, and the number of lines
//! depends on the spec and the width only, never on the progress, so the conversation does not shift
//! under the scroll position while a chart is being revealed.
//!
//! What lives here beyond drawing is the small registry `block` goes through: a parse cache and a
//! cache of the finished frame, both keyed by content (and width), and the clock of the reveal. A
//! block is revealed once, in `DURATION`; `animating` is true only while that is running, so the
//! event loop repaints at a faster pace for under a second and then not at all.
//!
//! Colour: series use the theme's brand, accent, success, warning, error and tool colours (the
//! web's six report colours are the same roles), so the 256-colour and 16-colour folds of the theme
//! apply as they do everywhere else. Nothing here sets a background, so the terminal's own shows.
//! With no colour at all (NO_COLOR) the series are told apart by fill pattern where it matters.
//! Only numbers in the spec are shown, apart from the axis ticks, which are round bounds of the
//! spec's range, and the sums and shares that the spec's numbers make.

use crate::flowgraph;
use crate::text::{char_width, truncate, width};
use crate::theme::{Symbols, Theme};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// How long a block takes to reveal.
pub const DURATION: Duration = Duration::from_millis(800);
/// Past `DURATION` plus this, a block whose last frame was never drawn is no longer waited for.
const GRACE: Duration = Duration::from_millis(1000);
/// Narrowest block that is drawn; below this the reply shows the plain code block.
const MIN_WIDTH: usize = 20;
/// Widest block; a wider pane leaves the right side empty rather than stretching a chart thin.
const MAX_WIDTH: usize = 120;
/// Rows of the plot area of a bar or line chart.
const PLOT_ROWS: usize = 10;

const MAX_LABELS: usize = 40;
const MAX_SERIES: usize = 6;
const MAX_WIDE_SERIES: usize = 12;
const MAX_ITEMS: usize = 12;
const MAX_CALENDAR_DAYS: usize = 371;

// --- the spec -------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Bar,
    Hbar,
    Line,
    Area,
    Step,
    Sparkline,
    Slope,
    Bump,
    Calendar,
    Stream,
    Pie,
    Donut,
    Stats,
    Progress,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Series {
    pub name: String,
    /// NaN is a missing value.
    pub data: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ItemValue {
    Number(f64),
    Text(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub label: String,
    pub value: ItemValue,
    pub max: Option<f64>,
    pub delta: Option<f64>,
    pub hint: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub kind: Kind,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub unit: Option<String>,
    pub stacked: bool,
    pub labels: Vec<String>,
    pub series: Vec<Series>,
    pub items: Vec<Item>,
    /// `(day number since 1970-01-01, value)`, sorted, calendar charts only.
    pub days: Vec<(i64, f64)>,
}

fn kind_of(alias: &str) -> Option<Kind> {
    Some(match alias {
        "bar" | "bars" | "column" | "columns" => Kind::Bar,
        "hbar" | "barh" | "horizontal" | "horizontal-bar" | "horizontalbar" => Kind::Hbar,
        "line" | "lines" => Kind::Line,
        "area" | "stacked-area" | "stackedarea" | "area-stacked" => Kind::Area,
        "step" | "steps" | "step-line" | "stepline" | "line-step" => Kind::Step,
        "sparkline" | "sparklines" | "spark" => Kind::Sparkline,
        "slope" | "slopegraph" | "slope-graph" | "slope-chart" => Kind::Slope,
        "bump" | "bumpchart" | "bump-chart" | "rank" | "ranks" => Kind::Bump,
        "calendar" | "heatmap" | "calendar-heatmap" | "calendarheatmap" | "contributions" => {
            Kind::Calendar
        }
        "stream" | "streamgraph" | "stream-graph" | "themeriver" => Kind::Stream,
        "pie" => Kind::Pie,
        "donut" | "doughnut" | "ring" => Kind::Donut,
        "stats" | "stat" | "kpi" | "kpis" | "metrics" => Kind::Stats,
        "progress" | "gauge" | "bullet" => Kind::Progress,
        _ => return None,
    })
}

/// The first of `keys` that is present and not null, like a chain of `??`.
fn pick<'a>(object: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .filter_map(|k| object.get(*k))
        .find(|v| !v.is_null())
}

fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => n.as_f64().filter(|x| x.is_finite()).map(|x| x.to_string()),
        _ => None,
    }
}

/// Numbers as models write them: 12, "12", "1,234.5", "45%".
pub fn to_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|x| x.is_finite()),
        Value::String(s) => {
            let cleaned = s.replace(',', "");
            let cleaned = cleaned.trim_end_matches('%').trim();
            if cleaned.is_empty() {
                return None;
            }
            cleaned.parse::<f64>().ok().filter(|x| x.is_finite())
        }
        _ => None,
    }
}

fn numbers(value: Option<&Value>) -> Vec<f64> {
    match value {
        Some(Value::Array(a)) => a.iter().map(|v| to_number(v).unwrap_or(f64::NAN)).collect(),
        _ => Vec::new(),
    }
}

fn read_items(value: Option<&Value>) -> Vec<Item> {
    let Some(Value::Array(entries)) = value else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let o = entry.as_object()?;
            let label = text_of(pick(o, &["label", "name", "title"])?)?;
            let raw = pick(o, &["value", "amount", "count"])?;
            // "99.98%" stays text: as a number its percent sign would be lost.
            let percent = matches!(raw, Value::String(s) if s.trim_end().ends_with('%'));
            let value = match to_number(raw) {
                Some(n) if !percent => ItemValue::Number(n),
                _ => ItemValue::Text(text_of(raw)?),
            };
            Some(Item {
                label,
                value,
                max: pick(o, &["max", "target", "total"]).and_then(to_number),
                delta: pick(o, &["delta", "change", "diff"]).and_then(to_number),
                hint: pick(o, &["hint", "note", "description"]).and_then(text_of),
            })
        })
        .take(MAX_ITEMS)
        .collect()
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let shifted = (5 * doy + 2) / 153;
    let month = if shifted < 10 {
        shifted + 3
    } else {
        shifted - 9
    };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, doy - (153 * shifted + 2) / 5 + 1)
}

/// The day number of a YYYY-MM-DD string, if it is a real date.
fn parse_iso_day(value: &str) -> Option<i64> {
    let b = value.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let s = value.get(r)?;
        s.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| s.parse().ok())?
    };
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let days = days_from_civil(y, m, d);
    (civil_from_days(days) == (y, m, d)).then_some(days)
}

fn read_calendar_days(value: Option<&Value>) -> Vec<(i64, f64)> {
    let mut entries: Vec<(Option<&str>, Option<f64>)> = Vec::new();
    match value {
        Some(Value::Array(a)) => {
            for entry in a {
                match entry {
                    Value::Array(pair) => entries.push((
                        pair.first().and_then(Value::as_str),
                        pair.get(1).and_then(to_number),
                    )),
                    Value::Object(o) => entries.push((
                        pick(o, &["date", "day", "x", "label"]).and_then(Value::as_str),
                        pick(o, &["value", "count", "y", "amount"]).and_then(to_number),
                    )),
                    _ => {}
                }
            }
        }
        Some(Value::Object(o)) => {
            for (k, v) in o {
                entries.push((Some(k.as_str()), to_number(v)));
            }
        }
        _ => {}
    }
    let mut by_day: std::collections::BTreeMap<i64, f64> = std::collections::BTreeMap::new();
    for (date, amount) in entries {
        if let (Some(date), Some(amount)) = (date, amount)
            && let Some(day) = parse_iso_day(date.trim())
        {
            by_day.insert(day, amount);
        }
    }
    let all: Vec<(i64, f64)> = by_day.into_iter().collect();
    let skip = all.len().saturating_sub(MAX_CALENDAR_DAYS);
    all[skip..].to_vec()
}

fn series_cap(kind: Kind) -> usize {
    match kind {
        Kind::Pie | Kind::Donut => 1,
        Kind::Sparkline | Kind::Slope | Kind::Bump => MAX_WIDE_SERIES,
        _ => MAX_SERIES,
    }
}

/// Reads one chart spec as the web does; `None` for anything it cannot draw.
pub fn parse(source: &str) -> Option<Spec> {
    let root: Value = serde_json::from_str(source.trim()).ok()?;
    let raw = root.as_object()?;
    let alias = match pick(raw, &["type", "kind", "chart"]) {
        None => "bar".to_string(),
        Some(Value::String(s)) => s.to_lowercase(),
        Some(other) => other.to_string().to_lowercase(),
    };
    let kind = kind_of(&alias)?;
    let title = raw.get("title").and_then(text_of);
    let subtitle = pick(raw, &["subtitle", "description", "caption"]).and_then(text_of);
    let unit = pick(raw, &["unit", "units", "suffix"]).and_then(text_of);
    let stacked = raw.get("stacked") == Some(&Value::Bool(true))
        || matches!(
            alias.as_str(),
            "stacked-area" | "stackedarea" | "area-stacked"
        );
    let base = |labels, series, items, days| Spec {
        kind,
        title: title.clone(),
        subtitle: subtitle.clone(),
        unit: unit.clone(),
        stacked,
        labels,
        series,
        items,
        days,
    };

    if matches!(kind, Kind::Stats | Kind::Progress) {
        let items = read_items(pick(raw, &["items", "metrics", "data", "values"]));
        return (!items.is_empty()).then(|| base(vec![], vec![], items, vec![]));
    }
    if kind == Kind::Calendar {
        let days = read_calendar_days(pick(raw, &["days", "data", "values"]));
        return (!days.is_empty()).then(|| base(vec![], vec![], vec![], days));
    }

    // Object rows ({label, value}) are the most common shape for one series.
    let rows: Option<&Vec<Value>> = match raw.get("data") {
        Some(Value::Array(a)) if a.iter().all(Value::is_object) => Some(a),
        _ => None,
    };
    let declared_labels = pick(raw, &["labels", "categories", "x"]);
    let mut labels: Vec<String> = match declared_labels {
        Some(Value::Array(a)) => a.iter().map(|l| text_of(l).unwrap_or_default()).collect(),
        _ => rows
            .map(|rows| {
                rows.iter()
                    .map(|r| {
                        r.as_object()
                            .and_then(|o| pick(o, &["label", "name", "x"]))
                            .and_then(text_of)
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .unwrap_or_default(),
    };
    let fallback_name = title.clone().unwrap_or_else(|| "Value".to_string());
    let declared = match pick(raw, &["series", "datasets"]) {
        Some(Value::Array(a)) => Some(a),
        _ => None,
    };
    let mut series: Vec<Series> = if let Some(declared) = declared {
        declared
            .iter()
            .enumerate()
            .filter_map(|(i, entry)| {
                let o = entry.as_object()?;
                Some(Series {
                    name: pick(o, &["name", "label"])
                        .and_then(text_of)
                        .unwrap_or_else(|| format!("Series {}", i + 1)),
                    data: numbers(pick(o, &["data", "values"])),
                })
            })
            .collect()
    } else if let Some(rows) = rows {
        vec![Series {
            name: fallback_name,
            data: rows
                .iter()
                .map(|r| {
                    r.as_object()
                        .and_then(|o| pick(o, &["value", "y"]))
                        .and_then(to_number)
                        .unwrap_or(f64::NAN)
                })
                .collect(),
        }]
    } else if let Some(values @ Value::Array(_)) = pick(raw, &["data", "values"]) {
        vec![Series {
            name: fallback_name,
            data: numbers(Some(values)),
        }]
    } else {
        Vec::new()
    };
    if labels.is_empty() {
        let longest = series.iter().map(|s| s.data.len()).max().unwrap_or(0);
        labels = (1..=longest).map(|i| i.to_string()).collect();
    }
    labels.truncate(MAX_LABELS);
    series.truncate(series_cap(kind));
    for s in &mut series {
        s.data.truncate(labels.len());
    }
    series.retain(|s| s.data.iter().any(|v| v.is_finite()));
    if series.is_empty() || labels.is_empty() || (kind == Kind::Slope && labels.len() < 2) {
        return None;
    }
    Some(base(labels, series, vec![], vec![]))
}

// --- numbers ---------------------------------------------------------------------------------

fn trim_float(x: f64, decimals: usize) -> String {
    let mut s = format!("{x:.decimals$}");
    if s.contains('.') {
        s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    }
    if s == "-0" {
        s = "0".into();
    }
    s
}

/// 1234 -> "1234", 12345 -> "12.3K", 0.456 -> "0.46".
pub fn compact(value: f64) -> String {
    let abs = value.abs();
    let scaled = |divisor: f64, suffix: &str| format!("{}{suffix}", trim_float(value / divisor, 1));
    if abs >= 1e12 {
        scaled(1e12, "T")
    } else if abs >= 1e9 {
        scaled(1e9, "B")
    } else if abs >= 1e6 {
        scaled(1e6, "M")
    } else if abs >= 1e4 {
        scaled(1e3, "K")
    } else {
        trim_float(value, if abs >= 100.0 { 0 } else { 2 })
    }
}

fn with_unit(value: f64, unit: Option<&str>) -> String {
    match unit {
        Some(u) => format!("{} {u}", compact(value)),
        None => compact(value),
    }
}

/// Round axis bounds that include zero, about `count` steps.
pub fn nice_scale(min: f64, max: f64, count: f64) -> (f64, f64, Vec<f64>) {
    let lo = min.min(0.0);
    let hi = max.max(0.0);
    if hi == lo {
        return (lo, lo + 1.0, vec![lo, lo + 1.0]);
    }
    let raw = (hi - lo) / count;
    let magnitude = 10f64.powf(raw.log10().floor());
    let normalized = raw / magnitude;
    let step = magnitude
        * if normalized <= 1.0 {
            1.0
        } else if normalized <= 2.0 {
            2.0
        } else if normalized <= 2.5 {
            2.5
        } else if normalized <= 5.0 {
            5.0
        } else {
            10.0
        };
    let nice_min = (lo / step).floor() * step;
    let nice_max = (hi / step).ceil() * step;
    let mut ticks = Vec::new();
    let mut tick = nice_min;
    while tick <= nice_max + step / 2.0 && ticks.len() < 64 {
        ticks.push((tick * 1e9).round() / 1e9);
        tick += step;
    }
    (nice_min, nice_max, ticks)
}

pub(crate) fn ease(t: f64) -> f64 {
    1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(3)
}

/// 0 before `start`, 1 after `end`, linear between.
fn phase(p: f64, start: f64, end: f64) -> f64 {
    ((p - start) / (end - start)).clamp(0.0, 1.0)
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

// --- cells -----------------------------------------------------------------------------------

/// A rectangle of styled cells to draw into. A wide character takes its cell and a `'\0'` after it.
pub(crate) struct Grid {
    w: usize,
    rows: Vec<Vec<(char, Style)>>,
}

impl Grid {
    pub(crate) fn new(w: usize, h: usize) -> Grid {
        Grid {
            w,
            rows: vec![vec![(' ', Style::new()); w]; h],
        }
    }

    pub(crate) fn put(&mut self, row: usize, col: usize, ch: char, style: Style) {
        let Some(line) = self.rows.get_mut(row) else {
            return;
        };
        let cw = char_width(ch).max(1);
        if col + cw > line.len() {
            return;
        }
        // Overwriting half of a wide character blanks the other half.
        if line[col].0 == '\0' && col > 0 {
            line[col - 1].0 = ' ';
        }
        if char_width(line[col].0) == 2 && col + 1 < line.len() {
            line[col + 1].0 = ' ';
        }
        line[col] = (ch, style);
        if cw == 2 {
            if char_width(line[col + 1].0) == 2 && col + 2 < line.len() {
                line[col + 2].0 = ' ';
            }
            line[col + 1] = ('\0', style);
        }
    }

    /// Writes `text` from `col`, cut at the right edge; returns the cells used.
    pub(crate) fn text(&mut self, row: usize, col: usize, text: &str, style: Style) -> usize {
        let mut at = col;
        for ch in text.chars() {
            let cw = char_width(ch);
            if cw == 0 {
                continue;
            }
            if at + cw > self.w {
                break;
            }
            self.put(row, at, ch, style);
            at += cw;
        }
        at - col
    }

    /// Writes `text` so it ends just before `end`.
    pub(crate) fn text_right(&mut self, row: usize, end: usize, text: &str, style: Style) {
        let w = width(text);
        self.text(row, end.saturating_sub(w), text, style);
    }

    pub(crate) fn text_center(&mut self, row: usize, center: usize, text: &str, style: Style) {
        let w = width(text);
        let start = center.saturating_sub(w / 2).min(self.w.saturating_sub(w));
        self.text(row, start, text, style);
    }

    pub(crate) fn fill(&mut self, row: usize, from: usize, to: usize, ch: char, style: Style) {
        for col in from..to.min(self.w) {
            self.put(row, col, ch, style);
        }
    }

    pub(crate) fn into_lines(self) -> Vec<Line<'static>> {
        self.rows
            .into_iter()
            .map(|mut row| {
                while row
                    .last()
                    .is_some_and(|(c, s)| (*c == ' ' || *c == '\0') && *s == Style::new())
                {
                    row.pop();
                }
                let mut spans: Vec<Span<'static>> = Vec::new();
                let mut run = String::new();
                let mut style = Style::new();
                for (c, s) in row {
                    if c == '\0' {
                        continue;
                    }
                    if !run.is_empty() && s != style {
                        spans.push(Span::styled(std::mem::take(&mut run), style));
                    }
                    style = s;
                    run.push(c);
                }
                if !run.is_empty() {
                    spans.push(Span::styled(run, style));
                }
                Line::from(spans)
            })
            .collect()
    }
}

/// The braille dots of a plot: 2 across and 4 down per cell, each cell coloured by the series that
/// last touched it.
pub(crate) struct Dots {
    cols: usize,
    rows: usize,
    mask: Vec<u8>,
    owner: Vec<u8>,
}

impl Dots {
    pub(crate) fn new(cols: usize, rows: usize) -> Dots {
        Dots {
            cols,
            rows,
            mask: vec![0; cols * rows],
            owner: vec![0; cols * rows],
        }
    }

    pub(crate) fn dot_w(&self) -> i64 {
        (self.cols * 2) as i64
    }

    pub(crate) fn dot_h(&self) -> i64 {
        (self.rows * 4) as i64
    }

    pub(crate) fn set(&mut self, x: i64, y: i64, owner: usize) {
        if x < 0 || y < 0 || x >= self.dot_w() || y >= self.dot_h() {
            return;
        }
        let (cx, cy) = (x as usize / 2, y as usize / 4);
        let bit = match (x % 2, y % 4) {
            (0, 3) => 0x40,
            (1, 3) => 0x80,
            (0, r) => 1u8 << r,
            (_, r) => 1u8 << (r + 3),
        };
        let i = cy * self.cols + cx;
        self.mask[i] |= bit;
        self.owner[i] = owner as u8;
    }

    /// A Bresenham line; dots right of `x_limit` are not drawn (the reveal front).
    pub(crate) fn line(&mut self, a: (i64, i64), b: (i64, i64), owner: usize, x_limit: f64) {
        let (mut x, mut y) = a;
        let dx = (b.0 - a.0).abs();
        let dy = -(b.1 - a.1).abs();
        let sx = if a.0 < b.0 { 1 } else { -1 };
        let sy = if a.1 < b.1 { 1 } else { -1 };
        let mut err = dx + dy;
        loop {
            if (x as f64) <= x_limit {
                self.set(x, y, owner);
            }
            if (x, y) == b {
                break;
            }
            let e2 = 2 * err;
            if e2 >= dy {
                err += dy;
                x += sx;
            }
            if e2 <= dx {
                err += dx;
                y += sy;
            }
        }
    }

    pub(crate) fn blit(&self, grid: &mut Grid, row: usize, col: usize, env: &Env) {
        for cy in 0..self.rows {
            for cx in 0..self.cols {
                let i = cy * self.cols + cx;
                if self.mask[i] == 0 {
                    continue;
                }
                let ch = if env.ascii {
                    '*'
                } else {
                    char::from_u32(0x2800 + u32::from(self.mask[i])).unwrap_or('*')
                };
                grid.put(
                    row + cy,
                    col + cx,
                    ch,
                    Style::new().fg(env.color(usize::from(self.owner[i]))),
                );
            }
        }
    }
}

// --- drawing environment ----------------------------------------------------------------------

pub(crate) struct Env<'a> {
    pub w: usize,
    pub p: f64,
    pub th: &'a Theme,
    pub ascii: bool,
}

const PATTERNS: [char; 6] = ['█', '▓', '▒', '░', '▚', '▞'];

impl Env<'_> {
    /// Series colour: the web's six report colours are these six roles of the theme.
    pub(crate) fn color(&self, i: usize) -> Color {
        let t = self.th;
        [t.brand, t.accent, t.success, t.warning, t.error, t.tool][i % 6]
    }

    pub(crate) fn ink(&self, i: usize) -> Style {
        Style::new().fg(self.color(i))
    }

    pub(crate) fn dim(&self) -> Style {
        self.th.dim_style()
    }

    pub(crate) fn muted(&self) -> Style {
        self.th.muted_style()
    }

    pub(crate) fn bold() -> Style {
        Style::new().add_modifier(Modifier::BOLD)
    }

    /// No colour at all: the six series cannot be told apart by hue.
    pub(crate) fn mono(&self) -> bool {
        self.th.brand == self.th.accent
    }

    /// The glyph of a full cell of series `i`.
    pub(crate) fn full(&self, i: usize) -> char {
        if self.ascii {
            '#'
        } else if self.mono() {
            PATTERNS[i % 6]
        } else {
            '█'
        }
    }

    pub(crate) fn rule(&self) -> char {
        if self.ascii { '-' } else { '─' }
    }

    pub(crate) fn vbar(&self) -> char {
        if self.ascii { '|' } else { '│' }
    }

    pub(crate) fn dot(&self) -> char {
        if self.ascii { 'o' } else { '●' }
    }

    /// A colour between two theme colours (RGB), or the nearer one where it cannot be mixed.
    pub(crate) fn mix(a: Color, b: Color, t: f64) -> Color {
        match (a, b) {
            (Color::Rgb(r1, g1, b1), Color::Rgb(r2, g2, b2)) => {
                let m = |x: u8, y: u8| lerp(f64::from(x), f64::from(y), t).round() as u8;
                Color::Rgb(m(r1, r2), m(g1, g2), m(b1, b2))
            }
            _ => {
                if t < 0.5 {
                    a
                } else {
                    b
                }
            }
        }
    }
}

const LOWER: [char; 7] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇'];
const LEFT: [char; 7] = ['▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/// `cells` cells of a horizontal bar of `len` cells (fractional), filled with eighth blocks.
fn hbar_cells(len: f64, cells: usize, env: &Env, owner: usize) -> Vec<char> {
    let len = len.clamp(0.0, cells as f64);
    let eighths = (len * 8.0).round() as usize;
    let (full, rest) = (eighths / 8, eighths % 8);
    (0..cells)
        .map(|i| {
            if i < full {
                env.full(owner)
            } else if i == full && rest > 0 && !env.ascii {
                LEFT[rest - 1]
            } else if i == full && rest >= 4 && env.ascii {
                '#'
            } else {
                ' '
            }
        })
        .collect()
}

// --- headers and legend ------------------------------------------------------------------------

fn header(spec: &Spec, env: &Env, with_legend: bool) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    let w = env.w;
    let mut head: Vec<Span<'static>> = Vec::new();
    if let Some(title) = &spec.title {
        head.push(Span::styled(truncate(title, w), Env::bold()));
    }
    if let Some(unit) = &spec.unit
        && !matches!(spec.kind, Kind::Stats | Kind::Progress)
    {
        let used: usize = head.iter().map(|s| width(&s.content)).sum();
        let text = if used == 0 {
            format!("({unit})")
        } else {
            format!("  ({unit})")
        };
        if used + width(&text) <= w {
            head.push(Span::styled(text, env.dim()));
        }
    }
    if !head.is_empty() {
        out.push(Line::from(head));
    }
    if let Some(sub) = &spec.subtitle {
        out.push(Line::from(Span::styled(truncate(sub, w), env.muted())));
    }
    if with_legend && spec.series.len() > 1 {
        out.extend(legend(
            &spec
                .series
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            env,
        ));
    }
    out
}

/// `■ name  ■ name` wrapped to the width.
fn legend(names: &[&str], env: &Env) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut used = 0;
    for (i, name) in names.iter().enumerate() {
        let name = truncate(name, env.w.saturating_sub(3).max(1));
        let item = width(&name) + 2;
        let gap = if used == 0 { 0 } else { 2 };
        if used > 0 && used + gap + item > env.w {
            lines.push(Line::from(std::mem::take(&mut spans)));
            used = 0;
        }
        if used > 0 {
            spans.push(Span::raw("  "));
            used += 2;
        }
        spans.push(Span::styled(format!("{} ", env.full(i)), env.ink(i)));
        spans.push(Span::styled(name, env.muted()));
        used += item;
    }
    if !spans.is_empty() {
        lines.push(Line::from(spans));
    }
    lines
}

// --- the public entry for one spec --------------------------------------------------------------

/// The lines of `spec` `w` cells wide at `progress` (0 = just appeared, 1 = finished). `None` when
/// the width is too narrow to draw anything readable.
pub fn render(
    spec: &Spec,
    w: usize,
    progress: f64,
    th: &Theme,
    sym: &Symbols,
) -> Option<Vec<Line<'static>>> {
    if w < MIN_WIDTH {
        return None;
    }
    let env = Env {
        w: w.min(MAX_WIDTH),
        p: progress.clamp(0.0, 1.0),
        th,
        ascii: sym.rule == "-",
    };
    let legend_in_header = !matches!(
        spec.kind,
        Kind::Pie | Kind::Donut | Kind::Sparkline | Kind::Slope | Kind::Bump | Kind::Stats
    );
    let mut out = header(spec, &env, legend_in_header);
    let body = match spec.kind {
        Kind::Bar => bars(spec, &env),
        Kind::Hbar => hbars(spec, &env, false),
        Kind::Line | Kind::Area | Kind::Step => plot(spec, &env),
        Kind::Stream => stream(spec, &env),
        Kind::Sparkline => sparklines(spec, &env),
        Kind::Slope => slope(spec, &env),
        Kind::Bump => bump(spec, &env),
        Kind::Calendar => calendar(spec, &env),
        Kind::Pie | Kind::Donut => ring(spec, &env),
        Kind::Stats => stats(spec, &env),
        Kind::Progress => progress_list(spec, &env),
    };
    out.extend(body);
    Some(out)
}

// --- axes ---------------------------------------------------------------------------------------

fn finite(data: &[f64]) -> impl Iterator<Item = f64> + '_ {
    data.iter().copied().filter(|v| v.is_finite())
}

/// Labels along the x axis at `centers` (cell columns), thinned so none touch.
fn x_labels(grid: &mut Grid, row: usize, labels: &[String], centers: &[usize], env: &Env) {
    let widest = labels.iter().map(|l| width(l)).max().unwrap_or(1);
    let spacing = if centers.len() > 1 {
        centers
            .windows(2)
            .map(|p| p[1].saturating_sub(p[0]))
            .min()
            .unwrap_or(1)
            .max(1)
    } else {
        widest + 1
    };
    let stride = (widest + 1).div_ceil(spacing).max(1);
    for (i, (label, center)) in labels.iter().zip(centers).enumerate() {
        if i % stride != 0 {
            continue;
        }
        let room = (spacing * stride).saturating_sub(1).max(1);
        let text = truncate(label, room);
        grid.text_center(row, *center, &text, env.muted());
    }
}

// --- bar --------------------------------------------------------------------------------------

/// Which cell glyph covers the eighths `[lo, hi)` of the cell holding `[8j, 8j + 8)` above the
/// baseline.
fn up_glyph(lo: f64, hi: f64, j: usize) -> Option<char> {
    let c0 = 8.0 * j as f64;
    let c1 = c0 + 8.0;
    let covered = (hi.min(c1) - lo.max(c0)).max(0.0).round() as usize;
    if covered == 0 {
        None
    } else if covered >= 8 {
        Some('█')
    } else if lo <= c0 + 0.5 {
        Some(LOWER[covered - 1])
    } else if hi >= c1 - 0.5 {
        Some(if covered >= 4 { '▀' } else { '▔' })
    } else if covered >= 4 {
        Some('█')
    } else {
        None
    }
}

/// The same below the baseline, where only whole and half cells can be drawn without a background.
fn down_glyph(lo: f64, hi: f64, j: usize) -> Option<char> {
    let c0 = 8.0 * j as f64;
    let c1 = c0 + 8.0;
    let covered = (hi.min(c1) - lo.max(c0)).max(0.0).round() as usize;
    match covered {
        0 => None,
        1..=2 => Some('▔'),
        3..=5 => Some('▀'),
        _ => Some('█'),
    }
}

fn bars(spec: &Spec, env: &Env) -> Vec<Line<'static>> {
    let n = spec.labels.len();
    let s = spec.series.len();
    let stacked = spec.stacked && s > 1;
    let value_at = |series: &Series, g: usize| series.data.get(g).copied().unwrap_or(f64::NAN);
    let extremes: Vec<f64> = if stacked {
        (0..n)
            .flat_map(|g| {
                let (mut pos, mut neg) = (0.0, 0.0);
                for series in &spec.series {
                    let v = value_at(series, g);
                    if v.is_finite() {
                        if v >= 0.0 {
                            pos += v;
                        } else {
                            neg += v;
                        }
                    }
                }
                [pos, neg]
            })
            .collect()
    } else {
        spec.series.iter().flat_map(|x| finite(&x.data)).collect()
    };
    let min = extremes.iter().copied().fold(f64::INFINITY, f64::min);
    let max = extremes.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let (smin, smax, ticks) = nice_scale(min, max, 4.0);
    let tick_w = ticks.iter().map(|t| width(&compact(*t))).max().unwrap_or(1);
    let left = tick_w + 2;
    let per_group = if stacked { 1 } else { s };
    let band = env.w.saturating_sub(left) / n.max(1);
    if band < per_group + 1 {
        // No room for a column each: the same data as rows.
        return hbars(spec, env, true);
    }
    let plot_w = band * n;
    let bar_w = ((band - 1) / per_group).clamp(1, 6);

    // Value labels over single-series bars when every one fits its band.
    let labels_over = !stacked && s == 1;
    let texts_full: Vec<String> = spec.series[0]
        .data
        .iter()
        .map(|v| with_unit(*v, spec.unit.as_deref()))
        .collect();
    let texts_short: Vec<String> = spec.series[0].data.iter().map(|v| compact(*v)).collect();
    let fits = |texts: &[String], data: &[f64]| {
        data.iter()
            .zip(texts)
            .filter(|(v, _)| v.is_finite())
            .all(|(_, t)| width(t) <= band)
    };
    let value_texts: Option<Vec<String>> = if !labels_over {
        None
    } else if fits(&texts_full, &spec.series[0].data) {
        Some(texts_full)
    } else if fits(&texts_short, &spec.series[0].data) {
        Some(texts_short)
    } else {
        None
    };

    let rows_total = PLOT_ROWS;
    let rows_up = if smin >= 0.0 {
        rows_total
    } else if smax <= 0.0 {
        0
    } else {
        ((rows_total as f64 * smax / (smax - smin)).round() as usize).clamp(1, rows_total - 1)
    };
    let rows_dn = rows_total - rows_up;
    let head = usize::from(value_texts.is_some());
    let base_row = head + rows_up;
    let label_row = base_row + 1 + rows_dn;
    let mut grid = Grid::new(env.w, label_row + 1);

    // The y axis.
    let axis = left - 1;
    let dim = env.dim();
    for r in head..=base_row + rows_dn {
        grid.put(r, axis, env.vbar(), dim);
    }
    let mut used = HashSet::new();
    for tick in &ticks {
        let row = if *tick == 0.0 {
            base_row
        } else if *tick > 0.0 && smax > 0.0 {
            let y = rows_up as f64 * (1.0 - tick / smax);
            head + (y.ceil() as usize)
                .saturating_sub(1)
                .min(rows_up.saturating_sub(1))
        } else if smin < 0.0 {
            let y = rows_dn as f64 * (tick / smin);
            base_row + (y.ceil() as usize).clamp(1, rows_dn.max(1))
        } else {
            continue;
        };
        if rows_up == 0 && *tick > 0.0 || !used.insert(row) {
            continue;
        }
        grid.text_right(row, tick_w, &compact(*tick), env.muted());
        grid.put(
            row,
            axis,
            if row == base_row {
                if env.ascii { '+' } else { '┼' }
            } else if env.ascii {
                '+'
            } else {
                '┤'
            },
            dim,
        );
    }
    grid.fill(base_row, left, left + plot_w, env.rule(), dim);

    // The bars.
    let mut centers = Vec::new();
    for g in 0..n {
        let band_start = left + g * band;
        let start = band_start + (band - bar_w * per_group) / 2;
        centers.push(band_start + band / 2);
        let (mut pos_sum, mut neg_sum) = (0.0f64, 0.0f64);
        for (k, series) in spec.series.iter().enumerate() {
            let v = value_at(series, g);
            if !v.is_finite() {
                continue;
            }
            let idx = g * s + k;
            let delay = (idx as f64 * 0.02).min(0.4);
            let grow = ease(phase(env.p, delay, delay + 0.6));
            let (from, to) = if stacked {
                let base = if v >= 0.0 { pos_sum } else { neg_sum };
                if v >= 0.0 {
                    pos_sum += v;
                } else {
                    neg_sum += v;
                }
                (base, base + v)
            } else {
                (0.0, v)
            };
            let col = start + if stacked { 0 } else { k * bar_w };
            let (lo_v, hi_v) = (from.min(to), from.max(to));
            if hi_v > 0.0 && smax > 0.0 {
                let scale = rows_up as f64 * 8.0 / smax;
                let lo = lo_v.max(0.0) * scale * grow;
                let mut hi = hi_v * scale * grow;
                if grow > 0.5 {
                    hi = hi.max(lo + 1.0);
                }
                for j in 0..rows_up {
                    if let Some(mut ch) = up_glyph(lo, hi, j) {
                        if ch == '█' || env.ascii {
                            ch = env.full(k);
                        }
                        let row = head + rows_up - 1 - j;
                        for c in 0..bar_w {
                            grid.put(row, col + c, ch, env.ink(k));
                        }
                    }
                }
            }
            if lo_v < 0.0 && smin < 0.0 {
                let scale = rows_dn as f64 * 8.0 / -smin;
                let lo = (-hi_v.min(0.0)) * scale * grow;
                let mut hi = (-lo_v) * scale * grow;
                if grow > 0.5 {
                    hi = hi.max(lo + 1.0);
                }
                for j in 0..rows_dn {
                    if let Some(mut ch) = down_glyph(lo, hi, j) {
                        if ch == '█' || env.ascii {
                            ch = env.full(k);
                        }
                        for c in 0..bar_w {
                            grid.put(base_row + 1 + j, col + c, ch, env.ink(k));
                        }
                    }
                }
            }
            if let (Some(texts), true) = (&value_texts, env.p >= 0.8)
                && v >= 0.0
                && smax > 0.0
            {
                let eighths = v * rows_up as f64 * 8.0 / smax;
                let j_top = ((eighths.max(1.0) - 1.0) / 8.0).floor() as usize;
                let row = (rows_up - 1 - j_top.min(rows_up - 1)) + head;
                if row >= 1 {
                    grid.text_center(row - 1, band_start + band / 2, &texts[g], Style::new());
                }
            }
        }
    }
    x_labels(&mut grid, label_row, &spec.labels, &centers, env);
    grid.into_lines()
}

// --- hbar -----------------------------------------------------------------------------------------

/// Rows of label, bar and value. `all_series` lists every series (the vertical bar chart's fallback
/// when there is no room for columns); otherwise only the first, as the web does.
fn hbars(spec: &Spec, env: &Env, all_series: bool) -> Vec<Line<'static>> {
    let used_series: Vec<(usize, &Series)> = spec
        .series
        .iter()
        .enumerate()
        .take(if all_series { spec.series.len() } else { 1 })
        .collect();
    let max = used_series
        .iter()
        .flat_map(|(_, s)| finite(&s.data))
        .fold(0.0f64, f64::max);
    let max = if max > 0.0 { max } else { 1.0 };
    struct Row {
        label: String,
        value: f64,
        series: usize,
        first: bool,
    }
    let mut rows: Vec<Row> = Vec::new();
    for (g, label) in spec.labels.iter().enumerate() {
        let mut first = true;
        for (k, series) in &used_series {
            let v = series.data.get(g).copied().unwrap_or(f64::NAN);
            if v.is_finite() {
                rows.push(Row {
                    label: label.clone(),
                    value: v,
                    series: *k,
                    first,
                });
                first = false;
            }
        }
    }
    let widest_label = rows.iter().map(|r| width(&r.label)).max().unwrap_or(1);
    let label_w = widest_label.min(env.w * 32 / 100).max(3);
    let texts: Vec<String> = rows
        .iter()
        .map(|r| with_unit(r.value, spec.unit.as_deref()))
        .collect();
    let value_w = texts.iter().map(|t| width(t)).max().unwrap_or(1);
    let track = env.w.saturating_sub(label_w + value_w + 2).max(4);
    let mut grid = Grid::new(env.w, rows.len());
    for (i, row) in rows.iter().enumerate() {
        if row.first {
            let label = truncate(&row.label, label_w);
            grid.text_right(i, label_w, &label, env.muted());
        }
        let owner = if all_series {
            row.series
        } else {
            usize::from(i != 0)
        };
        let delay = (i as f64 * 0.06).min(0.4);
        let grow = ease(phase(env.p, delay, delay + 0.6));
        let len = row.value.max(0.0) / max * track as f64 * grow;
        let len = if grow > 0.5 { len.max(0.125) } else { len };
        let dim = env.dim();
        let track_ch = if env.ascii { '.' } else { '░' };
        grid.fill(i, label_w + 1, label_w + 1 + track, track_ch, dim);
        for (c, ch) in hbar_cells(len, track, env, owner).into_iter().enumerate() {
            if ch != ' ' {
                grid.put(i, label_w + 1 + c, ch, env.ink(owner));
            }
        }
        if env.p >= 0.5 {
            grid.text_right(i, env.w, &texts[i], Style::new());
        }
    }
    grid.into_lines()
}

// --- line, area, step ---------------------------------------------------------------------------------

/// Cell column of the `i`th of `n` points across `cols` columns.
fn point_col(i: usize, n: usize, cols: usize) -> usize {
    if n <= 1 {
        cols / 2
    } else {
        i * (cols - 1) / (n - 1)
    }
}

/// Dot column of the `i`th of `n` points across a canvas `dots` dots wide.
fn point_x(i: usize, n: usize, dots: i64) -> f64 {
    if n <= 1 {
        (dots - 1) as f64 / 2.0
    } else {
        i as f64 * (dots - 1) as f64 / (n - 1) as f64
    }
}

/// The value of a series at fractional index `t`, interpolated between neighbours.
fn sample(data: &[f64], t: f64) -> f64 {
    let lo = t.floor().max(0.0) as usize;
    let hi = (lo + 1).min(data.len().saturating_sub(1));
    let a = data.get(lo).copied().unwrap_or(0.0);
    let b = data.get(hi).copied().unwrap_or(a);
    lerp(a, b, t - lo as f64)
}

/// Bands stacked on `base`: `lower` and `upper` per series, missing and negative counting as 0.
/// "silhouette" centres each column's total on 0.
fn stack(series: &[Series], n: usize, silhouette: bool) -> Vec<(Vec<f64>, Vec<f64>)> {
    let value = |s: &Series, i: usize| {
        let v = s.data.get(i).copied().unwrap_or(0.0);
        if v.is_finite() && v > 0.0 { v } else { 0.0 }
    };
    let mut running: Vec<f64> = (0..n)
        .map(|i| {
            if silhouette {
                -series.iter().map(|s| value(s, i)).sum::<f64>() / 2.0
            } else {
                0.0
            }
        })
        .collect();
    series
        .iter()
        .map(|s| {
            let lower = running.clone();
            let upper: Vec<f64> = lower
                .iter()
                .enumerate()
                .map(|(i, base)| base + value(s, i))
                .collect();
            running.clone_from(&upper);
            (lower, upper)
        })
        .collect()
}

fn plot(spec: &Spec, env: &Env) -> Vec<Line<'static>> {
    let n = spec.labels.len();
    let stacked_area = spec.kind == Kind::Area && spec.stacked && spec.series.len() > 1;
    let bands = if stacked_area {
        stack(&spec.series, n, false)
    } else {
        Vec::new()
    };
    let (min, max) = if stacked_area {
        (
            0.0,
            bands
                .iter()
                .flat_map(|(_, u)| u.iter().copied())
                .fold(0.0f64, f64::max),
        )
    } else {
        let all: Vec<f64> = spec.series.iter().flat_map(|s| finite(&s.data)).collect();
        (
            all.iter().copied().fold(f64::INFINITY, f64::min),
            all.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        )
    };
    let (smin, smax, ticks) = nice_scale(min, max, 4.0);
    let tick_w = ticks.iter().map(|t| width(&compact(*t))).max().unwrap_or(1);
    let left = tick_w + 2;
    let plot_w = env.w.saturating_sub(left + 1).max(4);
    let mut dots = Dots::new(plot_w, PLOT_ROWS);
    let (dw, dh) = (dots.dot_w(), dots.dot_h());
    let y_of = |v: f64| (smax - v) / (smax - smin) * (dh - 1) as f64;
    let zero_y = y_of(0.0);

    let mut markers: Vec<(usize, usize, usize)> = Vec::new();
    if stacked_area {
        let reveal = ease(phase(env.p, 0.0, 0.85)) * (dw - 1) as f64;
        for (k, (lower, upper)) in bands.iter().enumerate() {
            for x in 0..dw {
                if x as f64 > reveal {
                    break;
                }
                let t = x as f64 / (dw - 1) as f64 * (n.saturating_sub(1)) as f64;
                let (top, bottom) = (
                    y_of(sample(upper, t)).round() as i64,
                    y_of(sample(lower, t)).round() as i64,
                );
                for y in top..=bottom {
                    if y == top || (x + y) % 2 == 0 {
                        dots.set(x, y, k);
                    }
                }
            }
        }
    } else {
        for (k, series) in spec.series.iter().enumerate() {
            let delay = (k as f64 * 0.08).min(0.3);
            let reveal = ease(phase(env.p, delay, delay + 0.7)) * (dw - 1) as f64;
            let pts: Vec<Option<(f64, f64)>> = (0..n)
                .map(|i| {
                    let v = series.data.get(i).copied().unwrap_or(f64::NAN);
                    v.is_finite().then(|| (point_x(i, n, dw), y_of(v)))
                })
                .collect();
            if spec.kind == Kind::Area {
                for x in 0..dw {
                    if x as f64 > reveal {
                        break;
                    }
                    let t = if n <= 1 {
                        0.0
                    } else {
                        x as f64 / (dw - 1) as f64 * (n - 1) as f64
                    };
                    let (i0, i1) = (t.floor() as usize, (t.ceil() as usize).min(n - 1));
                    if let (Some(Some(a)), Some(Some(b))) = (pts.get(i0), pts.get(i1)) {
                        let top = lerp(a.1, b.1, t - i0 as f64).round() as i64;
                        let (from, to) = (
                            top.min(zero_y.round() as i64),
                            top.max(zero_y.round() as i64),
                        );
                        for y in from..=to {
                            if (x + y) % 2 == 0 {
                                dots.set(x, y, k);
                            }
                        }
                    }
                }
            }
            for i in 0..n.saturating_sub(1) {
                if let (Some(a), Some(b)) = (pts[i], pts[i + 1]) {
                    let (a, b) = (
                        (a.0.round() as i64, a.1.round() as i64),
                        (b.0.round() as i64, b.1.round() as i64),
                    );
                    if spec.kind == Kind::Step {
                        dots.line(a, (b.0, a.1), k, reveal);
                        dots.line((b.0, a.1), b, k, reveal);
                    } else {
                        dots.line(a, b, k, reveal);
                    }
                }
            }
            if n <= plot_w / 3 {
                for p in pts.iter() {
                    if let Some((x, y)) = p
                        && *x <= reveal
                    {
                        markers.push((k, (*y as usize) / 4, (*x as usize) / 2));
                    }
                }
            }
            if n == 1
                && let Some(Some((x, y))) = pts.first()
            {
                dots.set(x.round() as i64, y.round() as i64, k);
            }
        }
    }

    let label_row = PLOT_ROWS + 1;
    let mut grid = Grid::new(env.w, label_row + 1);
    let dim = env.dim();
    let axis = left - 1;
    for r in 0..PLOT_ROWS {
        grid.put(r, axis, env.vbar(), dim);
    }
    let grid_ch = if env.ascii { '.' } else { '┈' };
    let mut used = HashSet::new();
    for tick in &ticks {
        let y = PLOT_ROWS as f64 * (smax - tick) / (smax - smin);
        let row = (y.ceil() as usize).saturating_sub(1).min(PLOT_ROWS - 1);
        if !used.insert(row) {
            continue;
        }
        grid.fill(
            row,
            left,
            left + plot_w,
            if *tick == 0.0 { env.rule() } else { grid_ch },
            dim,
        );
        grid.text_right(row, tick_w, &compact(*tick), env.muted());
        grid.put(row, axis, if env.ascii { '+' } else { '┤' }, dim);
    }
    grid.put(PLOT_ROWS, axis, if env.ascii { '+' } else { '└' }, dim);
    grid.fill(PLOT_ROWS, left, left + plot_w, env.rule(), dim);
    // Braille over blanks only: a blank grid cell takes the dots, the grid line shows between them.
    dots.blit(&mut grid, 0, left, env);
    for (k, row, col) in markers {
        grid.put(row.min(PLOT_ROWS - 1), left + col, env.dot(), env.ink(k));
    }
    let centers: Vec<usize> = (0..n).map(|i| left + point_col(i, n, plot_w)).collect();
    x_labels(&mut grid, label_row, &spec.labels, &centers, env);
    grid.into_lines()
}

fn stream(spec: &Spec, env: &Env) -> Vec<Line<'static>> {
    let n = spec.labels.len();
    let bands = stack(&spec.series, n, true);
    let lo = bands
        .iter()
        .flat_map(|(l, _)| l.iter().copied())
        .fold(f64::INFINITY, f64::min);
    let hi = bands
        .iter()
        .flat_map(|(_, u)| u.iter().copied())
        .fold(f64::NEG_INFINITY, f64::max);
    let (lo, hi) = if hi > lo {
        (lo, hi)
    } else {
        (lo - 1.0, lo + 1.0)
    };
    let plot_w = env.w.saturating_sub(1).max(4);
    let mut dots = Dots::new(plot_w, PLOT_ROWS);
    let (dw, dh) = (dots.dot_w(), dots.dot_h());
    let reveal = ease(phase(env.p, 0.0, 0.85)) * (dw - 1) as f64;
    for (k, (lower, upper)) in bands.iter().enumerate() {
        for x in 0..dw {
            if x as f64 > reveal {
                break;
            }
            let t = x as f64 / (dw - 1) as f64 * n.saturating_sub(1) as f64;
            let y_of = |v: f64| ((hi - v) / (hi - lo) * (dh - 1) as f64).round() as i64;
            let (top, bottom) = (y_of(sample(upper, t)), y_of(sample(lower, t)));
            for y in top..=bottom.max(top) {
                dots.set(x, y, k);
            }
        }
    }
    let mut grid = Grid::new(env.w, PLOT_ROWS + 1);
    dots.blit(&mut grid, 0, 0, env);
    let centers: Vec<usize> = (0..n).map(|i| point_col(i, n, plot_w)).collect();
    x_labels(&mut grid, PLOT_ROWS, &spec.labels, &centers, env);
    grid.into_lines()
}

// --- sparkline ------------------------------------------------------------------------------------------

fn change_text(first: f64, last: f64, ascii: bool) -> (Option<bool>, String) {
    let diff = last - first;
    if diff == 0.0 {
        return (None, "= 0%".to_string());
    }
    let amount = if first == 0.0 {
        compact(diff.abs())
    } else {
        format!("{:.1}%", diff.abs() / first.abs() * 100.0)
    };
    (
        Some(diff > 0.0),
        format!("{} {amount}", arrow(diff > 0.0, ascii)),
    )
}

fn arrow(up: bool, ascii: bool) -> &'static str {
    match (up, ascii) {
        (true, false) => "▲",
        (false, false) => "▼",
        (true, true) => "^",
        (false, true) => "v",
    }
}

fn change_style(up: Option<bool>, env: &Env) -> Style {
    match up {
        Some(true) => Style::new().fg(env.th.success),
        Some(false) => Style::new().fg(env.th.error),
        None => env.muted(),
    }
}

fn sparklines(spec: &Spec, env: &Env) -> Vec<Line<'static>> {
    struct Row<'a> {
        series: &'a Series,
        last: Option<f64>,
        change: Option<(Option<bool>, String)>,
    }
    let rows: Vec<Row> = spec
        .series
        .iter()
        .map(|series| {
            let pts: Vec<f64> = finite(&series.data).collect();
            Row {
                series,
                last: pts.last().copied(),
                change: (pts.len() > 1).then(|| change_text(pts[0], pts[pts.len() - 1], env.ascii)),
            }
        })
        .collect();
    let value_text = |r: &Row| {
        r.last
            .map(|v| with_unit(v, spec.unit.as_deref()))
            .unwrap_or_default()
    };
    let value_w = rows
        .iter()
        .map(|r| width(&value_text(r)))
        .max()
        .unwrap_or(0);
    let change_w = rows
        .iter()
        .filter_map(|r| r.change.as_ref().map(|c| width(&c.1)))
        .max()
        .unwrap_or(0);
    let widest_name = rows
        .iter()
        .map(|r| width(&r.series.name))
        .max()
        .unwrap_or(1);
    let name_w = widest_name.min(env.w * 28 / 100).max(4);
    let spark_w = env.w.saturating_sub(name_w + value_w + change_w + 3).max(8);
    let mut grid = Grid::new(env.w, rows.len());
    for (i, row) in rows.iter().enumerate() {
        let delay = (i as f64 * 0.07).min(0.4);
        let f = ease(phase(env.p, delay, delay + 0.6));
        grid.text(i, 0, &truncate(&row.series.name, name_w), Style::new());
        let finite_idx: Vec<(usize, f64)> = row
            .series
            .data
            .iter()
            .enumerate()
            .filter(|(_, v)| v.is_finite())
            .map(|(i, v)| (i, *v))
            .collect();
        let lo = finite_idx.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
        let hi = finite_idx
            .iter()
            .map(|p| p.1)
            .fold(f64::NEG_INFINITY, f64::max);
        let count = row.series.data.len();
        let visible = (spark_w as f64 * f).ceil() as usize;
        for c in 0..spark_w.min(visible) {
            let t = if spark_w <= 1 {
                0.0
            } else {
                c as f64 / (spark_w - 1) as f64 * (count.saturating_sub(1)) as f64
            };
            // The nearest known value on each side, interpolated; a gap stays blank.
            let (i0, i1) = (t.floor() as usize, (t.ceil() as usize).min(count - 1));
            let (a, b) = (row.series.data[i0], row.series.data[i1]);
            if !a.is_finite() || !b.is_finite() {
                continue;
            }
            let v = lerp(a, b, t - i0 as f64);
            let level = if hi > lo { (v - lo) / (hi - lo) } else { 0.5 };
            let ch = if env.ascii {
                ['_', '.', '-', '~', '=', '+', '*', '#'][(level * 7.0).round() as usize]
            } else {
                ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'][(level * 7.0).round() as usize]
            };
            grid.put(i, name_w + 1 + c, ch, env.ink(i));
        }
        let shown = env.p >= 0.5 || f >= 0.99;
        if shown {
            grid.text_right(
                i,
                name_w + 1 + spark_w + 1 + value_w,
                &value_text(row),
                Style::new(),
            );
            if let Some((up, text)) = &row.change {
                grid.text_right(i, env.w, text, change_style(*up, env));
            }
        }
    }
    grid.into_lines()
}

// --- slope and bump ---------------------------------------------------------------------------------------

/// Distinct rows in `0..rows` as close as possible to `desired`, in the order of `desired`.
fn spread(desired: &[usize], rows: usize) -> Vec<usize> {
    let mut order: Vec<usize> = (0..desired.len()).collect();
    order.sort_by_key(|i| desired[*i]);
    let mut out = vec![0usize; desired.len()];
    let mut prev: Option<usize> = None;
    for i in &order {
        let at = desired[*i].min(rows.saturating_sub(1));
        let at = prev.map_or(at, |p| at.max(p + 1));
        out[*i] = at;
        prev = Some(at);
    }
    let mut limit = rows.saturating_sub(1);
    for i in order.iter().rev() {
        if out[*i] > limit {
            out[*i] = limit;
        }
        limit = out[*i].saturating_sub(1);
    }
    out
}

fn slope(spec: &Spec, env: &Env) -> Vec<Line<'static>> {
    let last = spec.labels.len() - 1;
    struct Row {
        name: String,
        from: f64,
        to: f64,
        index: usize,
    }
    let rows: Vec<Row> = spec
        .series
        .iter()
        .enumerate()
        .filter_map(|(index, s)| {
            let from = s.data.first().copied()?;
            let to = s.data.get(last).copied()?;
            (from.is_finite() && to.is_finite()).then(|| Row {
                name: s.name.clone(),
                from,
                to,
                index,
            })
        })
        .collect();
    if rows.is_empty() {
        return Vec::new();
    }
    let from_text: Vec<String> = rows
        .iter()
        .map(|r| with_unit(r.from, spec.unit.as_deref()))
        .collect();
    let to_text: Vec<String> = rows
        .iter()
        .map(|r| with_unit(r.to, spec.unit.as_deref()))
        .collect();
    let left = from_text.iter().map(|t| width(t)).max().unwrap_or(1) + 2;
    let right_want = rows
        .iter()
        .zip(&to_text)
        .map(|(r, t)| width(t) + 2 + width(&r.name))
        .max()
        .unwrap_or(1)
        + 2;
    let right = right_want.min(env.w * 45 / 100).max(8);
    let cols = env.w.saturating_sub(left + right).max(6);
    let height = (rows.len() * 2 + 1).clamp(7, 25).max(rows.len());
    let mut dots = Dots::new(cols, height);
    let (dw, dh) = (dots.dot_w(), dots.dot_h());
    let all: Vec<f64> = rows.iter().flat_map(|r| [r.from, r.to]).collect();
    let lo = all.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = all.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let y_of = |v: f64| {
        if hi > lo {
            (hi - v) / (hi - lo) * (dh - 1) as f64
        } else {
            (dh - 1) as f64 / 2.0
        }
    };
    let cell_of = |v: f64| ((y_of(v) / 4.0) as usize).min(height - 1);
    let from_rows = spread(
        &rows.iter().map(|r| cell_of(r.from)).collect::<Vec<_>>(),
        height,
    );
    let to_rows = spread(
        &rows.iter().map(|r| cell_of(r.to)).collect::<Vec<_>>(),
        height,
    );
    let mut grid = Grid::new(env.w, height + 1);
    let (x_from, x_to) = (left, left + cols);
    grid.text_right(0, x_from, &truncate(&spec.labels[0], left), Env::bold());
    grid.text(
        0,
        x_to + 1,
        &truncate(&spec.labels[last], right.saturating_sub(1)),
        Env::bold(),
    );
    let dim = env.dim();
    for r in 1..=height {
        grid.put(r, x_from, env.vbar(), dim);
        grid.put(r, x_to, env.vbar(), dim);
    }
    for (pos, row) in rows.iter().enumerate() {
        let delay = (pos as f64 * 0.08).min(0.3);
        let reveal = ease(phase(env.p, delay, delay + 0.6)) * (dw - 1) as f64;
        dots.line(
            (0, y_of(row.from).round() as i64),
            (dw - 1, y_of(row.to).round() as i64),
            row.index,
            reveal,
        );
    }
    // The dots sit between the two axes.
    dots.blit(&mut grid, 1, x_from + 1, env);
    for (pos, row) in rows.iter().enumerate() {
        let delay = (pos as f64 * 0.08).min(0.3);
        if env.p < delay + 0.55 {
            continue;
        }
        let ink = env.ink(row.index);
        grid.put(1 + cell_of(row.from), x_from, env.dot(), ink);
        grid.put(1 + cell_of(row.to), x_to, env.dot(), ink);
        grid.text_right(
            1 + from_rows[pos],
            x_from - 1,
            &from_text[pos],
            Style::new(),
        );
        let name_room = right.saturating_sub(width(&to_text[pos]) + 3).max(1);
        let mut at = x_to + 2;
        at += grid.text(1 + to_rows[pos], at, &to_text[pos], Style::new());
        grid.text(
            1 + to_rows[pos],
            at + 2,
            &truncate(&row.name, name_room),
            env.muted(),
        );
    }
    grid.into_lines()
}

fn bump(spec: &Spec, env: &Env) -> Vec<Line<'static>> {
    let n = spec.labels.len();
    struct Row {
        name: String,
        points: Vec<(usize, f64)>,
    }
    let rows: Vec<(usize, Row)> = spec
        .series
        .iter()
        .enumerate()
        .map(|(i, s)| {
            (
                i,
                Row {
                    name: s.name.clone(),
                    points: s
                        .data
                        .iter()
                        .enumerate()
                        .filter(|(_, v)| v.is_finite())
                        .map(|(i, v)| (i, *v))
                        .collect(),
                },
            )
        })
        .filter(|(_, r)| !r.points.is_empty())
        .collect();
    let max_rank = rows
        .iter()
        .flat_map(|(_, r)| r.points.iter().map(|p| p.1))
        .fold(2.0f64, f64::max)
        .min(24.0);
    let name_w = rows
        .iter()
        .map(|(_, r)| width(&r.name))
        .max()
        .unwrap_or(1)
        .min(env.w * 26 / 100)
        .max(3);
    let side = name_w + 2;
    let cols = env.w.saturating_sub(side * 2).max(6);
    let height = ((max_rank as usize - 1) * 2 + 1).max(3);
    let mut dots = Dots::new(cols, height);
    let dw = dots.dot_w();
    // A rank sits on the middle of its cell row.
    let y_of = |rank: f64| ((rank - 1.0) * 8.0 + 1.5).round() as i64;
    let cell_row = |rank: f64| (((rank - 1.0).round() as usize) * 2).min(height - 1);
    let mut grid = Grid::new(env.w, height + 1);
    let mut markers = Vec::new();
    let mut lefts = Vec::new();
    let mut rights = Vec::new();
    for (pos, (k, row)) in rows.iter().enumerate() {
        let delay = (pos as f64 * 0.06).min(0.3);
        let reveal = ease(phase(env.p, delay, delay + 0.65)) * (dw - 1) as f64;
        for pair in row.points.windows(2) {
            if pair[1].0 != pair[0].0 + 1 {
                continue;
            }
            dots.line(
                (point_x(pair[0].0, n, dw).round() as i64, y_of(pair[0].1)),
                (point_x(pair[1].0, n, dw).round() as i64, y_of(pair[1].1)),
                *k,
                reveal,
            );
        }
        for (i, rank) in &row.points {
            if point_x(*i, n, dw) <= reveal {
                markers.push((*k, cell_row(*rank), point_col(*i, n, cols)));
            }
        }
        let first = row.points[0];
        let last = row.points[row.points.len() - 1];
        lefts.push((
            *k,
            cell_row(first.1),
            row.name.clone(),
            env.p >= delay + 0.1,
        ));
        rights.push((*k, cell_row(last.1), row.name.clone(), env.p >= delay + 0.5));
    }
    dots.blit(&mut grid, 0, side, env);
    for (k, row, col) in markers {
        grid.put(row, side + col, env.dot(), env.ink(k));
    }
    let want_l: Vec<usize> = lefts.iter().map(|l| l.1).collect();
    let want_r: Vec<usize> = rights.iter().map(|l| l.1).collect();
    let row_l = spread(&want_l, height);
    let row_r = spread(&want_r, height);
    for (i, (k, _, name, shown)) in lefts.iter().enumerate() {
        if *shown {
            grid.text_right(row_l[i], side - 1, &truncate(name, name_w), env.ink(*k));
        }
    }
    for (i, (k, _, name, shown)) in rights.iter().enumerate() {
        if *shown {
            grid.text(
                row_r[i],
                side + cols + 1,
                &truncate(name, name_w),
                env.ink(*k),
            );
        }
    }
    let centers: Vec<usize> = (0..n).map(|i| side + point_col(i, n, cols)).collect();
    x_labels(&mut grid, height, &spec.labels, &centers, env);
    grid.into_lines()
}

// --- calendar -------------------------------------------------------------------------------------------

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn weekday_of(day: i64) -> usize {
    // 1970-01-01 was a Thursday; Sunday is 0.
    ((day + 4).rem_euclid(7)) as usize
}

fn calendar(spec: &Spec, env: &Env) -> Vec<Line<'static>> {
    let first = spec.days[0].0;
    let last = spec.days[spec.days.len() - 1].0;
    let by_day: HashMap<i64, f64> = spec.days.iter().copied().collect();
    let max = spec.days.iter().map(|d| d.1).fold(0.0f64, f64::max);
    let total: f64 = spec.days.iter().map(|d| d.1).sum();
    let week_start = first - weekday_of(first) as i64;
    let weeks = ((last - week_start) / 7 + 1) as usize;
    let label_w = 4;
    let cell_w = if label_w + weeks * 2 <= env.w { 2 } else { 1 };
    let fit = (env.w.saturating_sub(label_w) / cell_w).max(1);
    let skip = weeks.saturating_sub(fit);
    let shown = weeks - skip;
    let mut grid = Grid::new(env.w, 9);
    // Month names over the week each starts in.
    let mut next_free = 0;
    for day in first..=last {
        let (_, month, dom) = civil_from_days(day);
        if day != first && dom != 1 {
            continue;
        }
        let week = ((day - week_start) / 7) as usize;
        if week < skip {
            continue;
        }
        let col = label_w + (week - skip) * cell_w;
        if col >= next_free && col + 3 <= env.w {
            grid.text(0, col, MONTHS[(month - 1) as usize], env.muted());
            next_free = col + 4;
        }
    }
    for (row, name) in [(2, "Mon"), (4, "Wed"), (6, "Fri")] {
        grid.text(row, 0, name, env.muted());
    }
    let reveal = ease(phase(env.p, 0.0, 0.85)) * shown as f64;
    for day in first..=last {
        let week = ((day - week_start) / 7) as usize;
        if week < skip || ((week - skip) as f64) >= reveal {
            continue;
        }
        let level = match by_day.get(&day) {
            Some(v) if *v > 0.0 && max > 0.0 => ((v / max * 4.0).ceil() as usize).clamp(1, 4),
            _ => 0,
        };
        let (glyph, ink) = heat(level, env);
        let col = label_w + (week - skip) * cell_w;
        for c in 0..cell_w {
            grid.put(1 + weekday_of(day), col + c, glyph, ink);
        }
    }
    let mut summary = format!("{} total", with_unit(total, spec.unit.as_deref()));
    let sep = if env.ascii { " | " } else { " · " };
    summary.push_str(&format!("{sep}max {}", compact(max)));
    if skip > 0 {
        summary.push_str(&format!("{sep}last {shown} of {weeks} weeks shown"));
    }
    grid.text(8, 0, &truncate(&summary, env.w), env.muted());
    let mut lines = grid.into_lines();
    // Less to more, right-aligned on the summary row.
    let mut spans = lines.pop().map(|l| l.spans).unwrap_or_default();
    let used: usize = spans.iter().map(|s| width(&s.content)).sum();
    let key_w = 6 + 5 + 5;
    if used + 3 + key_w <= env.w {
        spans.push(Span::raw(" ".repeat(env.w - used - key_w)));
        spans.push(Span::styled("less ", env.dim()));
        for level in 0..5 {
            let (g, ink) = heat(level, env);
            spans.push(Span::styled(g.to_string(), ink));
        }
        spans.push(Span::styled(" more", env.dim()));
    }
    lines.push(Line::from(spans));
    lines
}

/// Glyph and colour of a heat level 0..=4: shade glyphs so it reads without colour too.
fn heat(level: usize, env: &Env) -> (char, Style) {
    let glyph = if env.ascii {
        ['.', ':', '+', '*', '#'][level]
    } else {
        ['·', '░', '▒', '▓', '█'][level]
    };
    let t = &env.th;
    let color = match (t.border, t.brand) {
        (a @ Color::Rgb(..), b @ Color::Rgb(..)) => {
            Env::mix(a, b, [0.0, 0.3, 0.55, 0.8, 1.0][level])
        }
        _ => match level {
            0 => t.dim,
            1 | 2 => t.brand_dim,
            _ => t.brand,
        },
    };
    (glyph, Style::new().fg(color))
}

// --- pie and donut ---------------------------------------------------------------------------------------

/// A circle reads badly in a cell grid (cells are about twice as tall as wide), so pie and donut are
/// one proportional strip, two rows high, with a legend that gives each share.
fn ring(spec: &Spec, env: &Env) -> Vec<Line<'static>> {
    struct Slice {
        label: String,
        value: f64,
    }
    let series = &spec.series[0];
    let slices: Vec<Slice> = spec
        .labels
        .iter()
        .enumerate()
        .filter_map(|(i, label)| {
            let v = series.data.get(i).copied().unwrap_or(0.0);
            (v.is_finite() && v > 0.0).then(|| Slice {
                label: label.clone(),
                value: v,
            })
        })
        .collect();
    if slices.is_empty() {
        return vec![Line::from(Span::styled("no data", env.dim()))];
    }
    let total: f64 = slices.iter().map(|s| s.value).sum();
    let strip = env.w;
    // The slice that owns each cell is the one holding its centre.
    let mut owner = Vec::with_capacity(strip);
    let mut edge = 0.0;
    let mut starts = Vec::new();
    for s in &slices {
        starts.push(edge);
        edge += s.value / total;
    }
    for c in 0..strip {
        let centre = (c as f64 + 0.5) / strip as f64;
        owner.push(starts.iter().rposition(|s| centre >= *s).unwrap_or(0));
    }
    let revealed = (strip as f64 * ease(phase(env.p, 0.0, 0.7))).ceil() as usize;
    let rows = slices.len() + 3 + usize::from(spec.kind == Kind::Donut);
    let mut grid = Grid::new(env.w, rows);
    for r in 0..2 {
        for (c, o) in owner.iter().enumerate().take(revealed) {
            grid.put(r, c, env.full(*o), env.ink(*o));
        }
    }
    let texts: Vec<String> = slices
        .iter()
        .map(|s| with_unit(s.value, spec.unit.as_deref()))
        .collect();
    let pcts: Vec<String> = slices
        .iter()
        .map(|s| format!("{:.1}%", s.value / total * 100.0))
        .collect();
    let value_w = texts.iter().map(|t| width(t)).max().unwrap_or(1);
    let pct_w = pcts.iter().map(|t| width(t)).max().unwrap_or(1);
    let label_room = env.w.saturating_sub(value_w + pct_w + 6).max(4);
    for (i, s) in slices.iter().enumerate() {
        if env.p < 0.15 + i as f64 * 0.06 {
            continue;
        }
        let row = 3 + i;
        grid.put(row, 0, env.full(i), env.ink(i));
        grid.text(row, 2, &truncate(&s.label, label_room), Style::new());
        grid.text_right(row, env.w - pct_w - 2, &texts[i], env.muted());
        grid.text_right(row, env.w, &pcts[i], Env::bold());
    }
    if spec.kind == Kind::Donut && env.p >= 0.5 {
        let row = 3 + slices.len();
        let total_text = format!(
            "{} {}",
            if env.ascii { "sum" } else { "Σ" },
            with_unit(total, spec.unit.as_deref())
        );
        grid.text(row, 2, &total_text, Env::bold());
    }
    grid.into_lines()
}

// --- stats -----------------------------------------------------------------------------------------------

/// `1,234.5` from the digits: `grouped` puts commas every three integer digits.
fn format_number(value: f64, decimals: usize, grouped: bool) -> String {
    let s = format!("{:.*}", decimals, value.abs());
    let (int, frac) = s
        .split_once('.')
        .map_or((s.as_str(), None), |(a, b)| (a, Some(b)));
    let int = if grouped {
        let digits: Vec<char> = int.chars().collect();
        let mut out = String::new();
        for (i, c) in digits.iter().enumerate() {
            if i > 0 && (digits.len() - i).is_multiple_of(3) {
                out.push(',');
            }
            out.push(*c);
        }
        out
    } else {
        int.to_string()
    };
    let sign = if value < 0.0 && s.chars().any(|c| c.is_ascii_digit() && c != '0') {
        "-"
    } else {
        ""
    };
    match frac {
        Some(f) => format!("{sign}{int}.{f}"),
        None => format!("{sign}{int}"),
    }
}

/// An item's value as shown at reveal `t`: a number inside the text counts up, the text around it
/// ("$4.5B", "12.3조") stays.
fn counted(item: &Item, unit: Option<&str>, t: f64) -> String {
    let (source, numeric) = match &item.value {
        ItemValue::Number(n) => (n.to_string(), true),
        ItemValue::Text(s) => (s.clone(), false),
    };
    let chars: Vec<char> = source.chars().collect();
    let start = (0..chars.len()).find(|i| {
        chars[*i].is_ascii_digit()
            || (chars[*i] == '-' && chars.get(i + 1).is_some_and(char::is_ascii_digit))
    });
    let suffix_unit = if numeric {
        unit.map(|u| format!(" {u}")).unwrap_or_default()
    } else {
        String::new()
    };
    let Some(start) = start else {
        return source;
    };
    let mut end = start + 1;
    while end < chars.len() && (chars[end].is_ascii_digit() || chars[end] == ',') {
        end += 1;
    }
    if chars.get(end) == Some(&'.') && chars.get(end + 1).is_some_and(char::is_ascii_digit) {
        end += 1;
        while end < chars.len() && chars[end].is_ascii_digit() {
            end += 1;
        }
    }
    let number: String = chars[start..end].iter().collect();
    let Ok(target) = number.replace(',', "").parse::<f64>() else {
        return source;
    };
    let decimals = number.split_once('.').map_or(0, |(_, f)| f.len());
    let grouped = number.contains(',') || (numeric && target >= 1e4);
    let shown = target * ease(t);
    let prefix: String = chars[..start].iter().collect();
    let rest: String = chars[end..].iter().collect();
    format!(
        "{prefix}{}{rest}{suffix_unit}",
        format_number(shown, decimals, grouped)
    )
}

fn stats(spec: &Spec, env: &Env) -> Vec<Line<'static>> {
    let n = spec.items.len();
    let min_card = 20;
    let columns = ((env.w + 1) / (min_card + 1)).clamp(1, n);
    let card_w = ((env.w + 1) / columns - 1).min(34);
    let card_rows = n.div_ceil(columns);
    let mut grid = Grid::new(env.w, card_rows * 5);
    let [tl, tr, bl, br] = if env.ascii {
        ['+', '+', '+', '+']
    } else {
        ['╭', '╮', '╰', '╯']
    };
    let inner = card_w.saturating_sub(4).max(1);
    for (i, item) in spec.items.iter().enumerate() {
        let (r, c) = (i / columns * 5, i % columns * (card_w + 1));
        let delay = (i as f64 * 0.07).min(0.4);
        if env.p < delay {
            continue;
        }
        let edge = env.ink(i);
        let dim = Style::new().fg(env.th.border);
        grid.put(r, c, tl, edge);
        grid.fill(r, c + 1, c + card_w - 1, env.rule(), edge);
        grid.put(r, c + card_w - 1, tr, edge);
        for row in 1..4 {
            grid.put(r + row, c, env.vbar(), dim);
            grid.put(r + row, c + card_w - 1, env.vbar(), dim);
        }
        grid.put(r + 4, c, bl, dim);
        grid.fill(r + 4, c + 1, c + card_w - 1, env.rule(), dim);
        grid.put(r + 4, c + card_w - 1, br, dim);
        grid.text(r + 1, c + 2, &truncate(&item.label, inner), env.muted());
        let t = phase(env.p, delay, delay + 0.6);
        let value = counted(item, spec.unit.as_deref(), t);
        grid.text(r + 2, c + 2, &truncate(&value, inner), Env::bold());
        let mut at = c + 2;
        if let Some(delta) = item.delta {
            let up = delta >= 0.0;
            let pill = format!("{} {}%", arrow(up, env.ascii), compact(delta.abs()));
            let style = Style::new().fg(if up { env.th.success } else { env.th.error });
            at += grid.text(r + 3, at, &truncate(&pill, inner), style) + 1;
        }
        if let Some(hint) = &item.hint {
            let room = (c + 2 + inner).saturating_sub(at);
            if room > 1 {
                grid.text(r + 3, at, &truncate(hint, room), env.muted());
            }
        }
    }
    grid.into_lines()
}

// --- progress ---------------------------------------------------------------------------------------------

fn parse_float_prefix(s: &str) -> Option<f64> {
    let s = s.trim();
    let end = s
        .char_indices()
        .find(|(i, c)| !(c.is_ascii_digit() || *c == '.' || (*i == 0 && (*c == '-' || *c == '+'))))
        .map_or(s.len(), |(i, _)| i);
    s[..end].parse().ok()
}

fn progress_list(spec: &Spec, env: &Env) -> Vec<Line<'static>> {
    let mut grid = Grid::new(env.w, spec.items.len() * 2);
    for (i, item) in spec.items.iter().enumerate() {
        let value = match &item.value {
            ItemValue::Number(n) => *n,
            ItemValue::Text(s) => parse_float_prefix(s).unwrap_or(f64::NAN),
        };
        let max = item.max.unwrap_or(100.0);
        let percent = if value.is_finite() && max != 0.0 {
            (value / max * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };
        let text = if item.max.is_none() {
            format!("{percent:.0}%")
        } else {
            format!(
                "{} / {}{}",
                compact(if value.is_finite() { value } else { 0.0 }),
                compact(max),
                spec.unit
                    .as_deref()
                    .map(|u| format!(" {u}"))
                    .unwrap_or_default()
            )
        };
        let vw = width(&text);
        let delay = (i as f64 * 0.09).min(0.4);
        let grow = ease(phase(env.p, delay, delay + 0.6));
        let row = i * 2;
        grid.text(
            row,
            0,
            &truncate(&item.label, env.w.saturating_sub(vw + 2).max(1)),
            Style::new(),
        );
        if env.p >= 0.3 {
            grid.text_right(row, env.w, &text, env.muted());
        }
        let track = if env.ascii { '.' } else { '░' };
        grid.fill(row + 1, 0, env.w, track, env.dim());
        for (c, ch) in hbar_cells(percent / 100.0 * env.w as f64 * grow, env.w, env, i)
            .into_iter()
            .enumerate()
        {
            if ch != ' ' {
                grid.put(row + 1, c, ch, env.ink(i));
            }
        }
    }
    grid.into_lines()
}

// --- the block, cached and timed ----------------------------------------------------------------------------

enum Parsed {
    Chart(Spec),
    Flow(flowgraph::Flow),
    Invalid,
}

/// Content and width keyed caches and the clock of each block's reveal.
#[derive(Default)]
struct Registry {
    parsed: HashMap<u64, Rc<Parsed>>,
    starts: HashMap<u64, Instant>,
    settled: HashSet<u64>,
    frames: HashMap<(u64, usize, u64), Rc<Vec<Line<'static>>>>,
}

/// Caps so a long session cannot grow the caches without bound; past them everything is rebuilt.
const MAX_CACHED: usize = 400;

thread_local! {
    static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default());
}

#[cfg(test)]
thread_local! {
    /// How many times a block's source was parsed, for the cache tests.
    static PARSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

static ANIMATIONS: AtomicBool = AtomicBool::new(true);

/// Whether blocks reveal at all; off, they appear finished (`settings.json` `animations`).
pub fn set_animations(on: bool) {
    ANIMATIONS.store(on, Ordering::Relaxed);
}

/// Whether a reveal is under way: the event loop repaints faster only while this holds.
pub fn animating() -> bool {
    animating_at(Instant::now())
}

fn animating_at(now: Instant) -> bool {
    ANIMATIONS.load(Ordering::Relaxed)
        && REGISTRY.with(|r| {
            let r = r.borrow();
            r.starts.iter().any(|(k, t)| {
                !r.settled.contains(k) && now.saturating_duration_since(*t) < DURATION + GRACE
            })
        })
}

/// Whether a fence language is drawn by this module.
pub fn is_visual(lang: &str) -> bool {
    matches!(
        lang.trim().to_ascii_lowercase().as_str(),
        "chart" | "mermaid"
    )
}

fn key_of(lang: &str, source: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    lang.hash(&mut h);
    source.trim().hash(&mut h);
    h.finish()
}

/// The theme and symbols as far as drawing depends on them.
fn style_key(th: &Theme, ascii: bool) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    format!(
        "{:?}{:?}{:?}{:?}{:?}{:?}{:?}{:?}{:?}{ascii}",
        th.brand,
        th.brand_dim,
        th.accent,
        th.success,
        th.warning,
        th.error,
        th.tool,
        th.border,
        th.dim
    )
    .hash(&mut h);
    h.finish()
}

/// A line standing in for a fence that has not closed yet. One row, whatever the text so far.
pub fn placeholder(lang: &str, th: &Theme, sym: &Symbols) -> Vec<Line<'static>> {
    let mark = if sym.rule == "-" { "| " } else { "▎ " };
    vec![Line::from(vec![
        Span::styled(mark, Style::new().fg(th.brand_dim)),
        Span::styled(
            format!(
                "{} {}",
                lang.trim(),
                if sym.rule == "-" { "..." } else { "…" }
            ),
            th.dim_style(),
        ),
    ])]
}

/// The lines of one closed ```chart or ```mermaid fence, or `None` when it cannot be drawn (invalid
/// JSON, an unknown chart type, a diagram this does not read, a width too narrow): the caller then
/// shows the plain code block. The first time a block is seen its reveal starts; the finished frame
/// is cached by content and width, so scrolling back to it costs a lookup.
pub fn block(
    lang: &str,
    source: &str,
    w: usize,
    th: &Theme,
    sym: &Symbols,
) -> Option<Vec<Line<'static>>> {
    block_at(
        lang,
        source,
        w,
        th,
        sym,
        Instant::now(),
        ANIMATIONS.load(Ordering::Relaxed),
    )
}

fn block_at(
    lang: &str,
    source: &str,
    w: usize,
    th: &Theme,
    sym: &Symbols,
    now: Instant,
    animate: bool,
) -> Option<Vec<Line<'static>>> {
    let lang = lang.trim().to_ascii_lowercase();
    let key = key_of(&lang, source);
    let style = style_key(th, sym.rule == "-");
    REGISTRY.with(|cell| {
        let mut r = cell.borrow_mut();
        if r.parsed.len() > MAX_CACHED || r.frames.len() > MAX_CACHED {
            r.parsed.clear();
            r.frames.clear();
        }
        let parsed = r
            .parsed
            .entry(key)
            .or_insert_with(|| {
                #[cfg(test)]
                PARSES.with(|n| n.set(n.get() + 1));
                Rc::new(match lang.as_str() {
                    "chart" => parse(source).map_or(Parsed::Invalid, Parsed::Chart),
                    _ => flowgraph::parse(source).map_or(Parsed::Invalid, Parsed::Flow),
                })
            })
            .clone();
        if matches!(*parsed, Parsed::Invalid) || w < MIN_WIDTH {
            return None;
        }
        let progress = if animate {
            let start = *r.starts.entry(key).or_insert(now);
            (now.saturating_duration_since(start).as_secs_f64() / DURATION.as_secs_f64()).min(1.0)
        } else {
            1.0
        };
        let draw = |p: f64| match &*parsed {
            Parsed::Chart(spec) => render(spec, w, p, th, sym),
            Parsed::Flow(flow) => flowgraph::render(flow, w.min(MAX_WIDTH), p, th, sym),
            Parsed::Invalid => None,
        };
        if progress < 1.0 {
            return draw(progress);
        }
        r.settled.insert(key);
        let frame_key = (key, w, style);
        if let Some(done) = r.frames.get(&frame_key) {
            return Some((**done).clone());
        }
        let lines = draw(1.0)?;
        r.frames.insert(frame_key, Rc::new(lines.clone()));
        Some(lines)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ASCII, LAVENDER, UNICODE};

    pub(crate) fn plain(lines: &[Line]) -> Vec<String> {
        lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect()
    }

    fn cells(line: &Line) -> usize {
        line.spans.iter().map(|s| width(&s.content)).sum()
    }

    fn draw(src: &str, w: usize, p: f64) -> Vec<Line<'static>> {
        render(&parse(src).expect("parses"), w, p, &LAVENDER, &UNICODE).expect("draws")
    }

    const BAR: &str = r#"{"type":"bar","title":"Weekly requests","unit":"req","labels":["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],"series":[{"name":"API","data":[120,180,150,210,260,90,60]}]}"#;
    const MULTI: &str = r#"{"type":"bar","title":"Latency","unit":"ms","labels":["Q1","Q2","Q3","Q4"],"series":[{"name":"p50","data":[40,45,38,50]},{"name":"p99","data":[-20,150,110,170]}]}"#;
    const STACKED: &str = r#"{"type":"bar","stacked":true,"labels":["a","b","c"],"series":[{"name":"x","data":[3,5,6]},{"name":"y","data":[2,3,5]}]}"#;
    const LINE: &str = r#"{"type":"line","title":"Users","labels":["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug"],"series":[{"name":"web","data":[10,25,30,28,45,60,58,80]},{"name":"mobile","data":[5,12,20,35,30,50,70,75]}]}"#;
    const STATS: &str = r#"{"type":"stats","items":[{"label":"Revenue","value":"$4.5B","delta":12.3,"hint":"vs last Q"},{"label":"Users","value":128400,"delta":-2.1},{"label":"Latency p95","value":182,"hint":"ms"},{"label":"Uptime","value":"99.98%"}]}"#;

    fn samples() -> Vec<(&'static str, &'static str)> {
        vec![
            ("bar", BAR),
            ("multi", MULTI),
            ("stacked", STACKED),
            ("line", LINE),
            ("stats", STATS),
            (
                "hbar",
                r#"{"type":"hbar","title":"Top files","unit":"edits","labels":["src/app.rs","src/ui.rs","한글 파일.rs"],"series":[{"name":"n","data":[48,31,9]}]}"#,
            ),
            (
                "area",
                r#"{"type":"area","stacked":true,"title":"Traffic","labels":["a","b","c","d","e","f"],"series":[{"name":"web","data":[3,5,6,8,7,9]},{"name":"api","data":[2,3,5,4,6,7]}]}"#,
            ),
            (
                "area1",
                r#"{"type":"area","labels":["a","b","c"],"series":[{"name":"web","data":[3,-5,6]}]}"#,
            ),
            (
                "step",
                r#"{"type":"step","labels":["a","b","c","d","e"],"series":[{"name":"plan","data":[1,1,3,3,2]}]}"#,
            ),
            (
                "stream",
                r#"{"type":"stream","labels":["a","b","c","d","e","f"],"series":[{"name":"x","data":[3,5,6,8,7,9]},{"name":"y","data":[2,3,5,4,6,7]}]}"#,
            ),
            (
                "spark",
                r#"{"type":"sparkline","unit":"ms","labels":["1","2","3","4","5","6","7","8"],"series":[{"name":"api","data":[10,12,9,14,20,18,25,22]},{"name":"db","data":[5,5,6,4,4,3,3,2]},{"name":"flat","data":[1,1,1,1,1,1,1,1]}]}"#,
            ),
            (
                "slope",
                r#"{"type":"slope","unit":"%","labels":["2025","2026"],"series":[{"name":"Alpha","data":[10,40]},{"name":"Beta","data":[30,35]},{"name":"Gamma","data":[50,20]}]}"#,
            ),
            (
                "bump",
                r#"{"type":"bump","labels":["Q1","Q2","Q3","Q4"],"series":[{"name":"Alpha","data":[1,2,1,3]},{"name":"Beta","data":[2,1,2,1]},{"name":"Gamma","data":[3,3,3,2]}]}"#,
            ),
            (
                "cal",
                r#"{"type":"calendar","unit":"commits","days":[{"date":"2026-09-01","value":3},{"date":"2026-09-03","value":9},{"date":"2026-09-10","value":1},{"date":"2026-10-30","value":8}]}"#,
            ),
            (
                "pie",
                r#"{"type":"pie","unit":"GB","labels":["Code","Docs","Media"],"series":[{"name":"s","data":[60,15,25]}]}"#,
            ),
            (
                "donut",
                r#"{"type":"donut","unit":"GB","labels":["Code","Docs","Media"],"series":[{"name":"s","data":[60,15,25]}]}"#,
            ),
            (
                "progress",
                r#"{"type":"progress","items":[{"label":"Build","value":72},{"label":"Tests","value":340,"max":400},{"label":"Docs","value":"45%"}]}"#,
            ),
        ]
    }

    /// Prints the final frame of every sample at 100 columns:
    /// `cargo test samples_print -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn samples_print() {
        for (name, src) in samples() {
            println!("--- {name}");
            for row in plain(&draw(src, 100, 1.0)) {
                println!("{row}");
            }
        }
    }

    #[test]
    fn the_web_contract_parses_leniently() {
        let spec = parse(r#"{"type":"column","labels":["a","b"],"series":[{"name":"x","data":["1,200","45%"]}]}"#)
            .unwrap();
        assert_eq!(spec.kind, Kind::Bar);
        assert_eq!(spec.series[0].data, vec![1200.0, 45.0]);
        // Rows of {label, value} are one series named after the title.
        let rows = parse(
            r#"{"type":"pie","title":"Share","data":[{"label":"A","value":3},{"name":"B","y":1}]}"#,
        )
        .unwrap();
        assert_eq!(rows.labels, vec!["A", "B"]);
        assert_eq!(rows.series[0].name, "Share");
        assert_eq!(rows.series[0].data[0], 3.0);
        // No type means bar; labels default to 1..n.
        let bare = parse(r#"{"data":[3,4,5]}"#).unwrap();
        assert_eq!((bare.kind, bare.labels.len()), (Kind::Bar, 3));
        assert!(
            parse(r#"{"type":"stacked-area","labels":["a"],"series":[{"name":"x","data":[1]}]}"#)
                .unwrap()
                .stacked
        );
        let capped = parse(&format!(
            r#"{{"type":"line","labels":[{}],"series":[{}]}}"#,
            (0..50)
                .map(|i| format!("\"{i}\""))
                .collect::<Vec<_>>()
                .join(","),
            (0..9)
                .map(|i| format!(r#"{{"name":"s{i}","data":[1,2]}}"#))
                .collect::<Vec<_>>()
                .join(",")
        ))
        .unwrap();
        assert_eq!((capped.labels.len(), capped.series.len()), (40, 6));
    }

    #[test]
    fn what_cannot_be_drawn_does_not_parse() {
        for bad in [
            "",
            "not json",
            "[1,2]",
            r#"{"type":"radar","data":[1]}"#,
            r#"{"type":"bar"}"#,
            r#"{"type":"bar","labels":["a"],"series":[{"name":"x","data":["n/a"]}]}"#,
            r#"{"type":"slope","labels":["a"],"series":[{"name":"x","data":[1]}]}"#,
            r#"{"type":"stats","items":[]}"#,
            r#"{"type":"calendar","days":[{"date":"2026-02-30","value":1}]}"#,
        ] {
            assert!(parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn calendar_days_read_from_objects_pairs_and_maps() {
        let a = parse(
            r#"{"type":"calendar","days":[{"date":"2026-10-02","value":2},["2026-10-01",1]]}"#,
        )
        .unwrap();
        let b = parse(r#"{"type":"heatmap","data":{"2026-10-01":1,"2026-10-02":"2"}}"#).unwrap();
        assert_eq!(a.days, b.days);
        assert_eq!(a.days.len(), 2);
        assert!(a.days[0].0 < a.days[1].0);
    }

    #[test]
    fn numbers_are_formatted_as_the_web_does() {
        assert_eq!(compact(1234.0), "1234");
        assert_eq!(compact(12345.0), "12.3K");
        assert_eq!(compact(0.456), "0.46");
        assert_eq!(compact(2_500_000.0), "2.5M");
        assert_eq!(compact(-0.0), "0");
        let (min, max, ticks) = nice_scale(0.0, 260.0, 4.0);
        assert_eq!((min, max), (0.0, 300.0));
        assert_eq!(ticks, vec![0.0, 100.0, 200.0, 300.0]);
    }

    #[test]
    fn every_kind_keeps_its_height_and_width_through_the_whole_reveal() {
        for (name, src) in samples() {
            for w in [24, 40, 80, 100, 130] {
                let rows = draw(src, w, 1.0);
                let height = rows.len();
                for p in [0.0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0] {
                    let frame = draw(src, w, p);
                    assert_eq!(frame.len(), height, "{name} at {w} columns, progress {p}");
                    assert!(
                        frame.iter().all(|l| cells(l) <= w.min(MAX_WIDTH)),
                        "{name} at {w}: {:?}",
                        plain(&frame)
                    );
                }
            }
        }
    }

    #[test]
    fn a_reveal_starts_empty_and_ends_complete() {
        let blank = plain(&draw(BAR, 100, 0.0));
        assert!(blank.iter().all(|r| !r.contains('█')), "{blank:?}");
        let half = plain(&draw(BAR, 100, 0.4));
        let full = plain(&draw(BAR, 100, 1.0));
        let blocks = |rows: &[String]| rows.iter().map(|r| r.matches('█').count()).sum::<usize>();
        assert!(blocks(&half) > 0 && blocks(&half) < blocks(&full));
        // Lines draw left to right: fewer braille dots part way through.
        let dots = |rows: &[String]| {
            rows.iter()
                .flat_map(|r| r.chars())
                .filter(|c| ('\u{2801}'..='\u{28ff}').contains(c))
                .count()
        };
        let line_half = plain(&draw(LINE, 100, 0.4));
        let line_full = plain(&draw(LINE, 100, 1.0));
        assert!(dots(&line_half) > 0 && dots(&line_half) < dots(&line_full));
    }

    #[test]
    fn a_bar_chart_shows_the_specs_numbers_and_its_axis() {
        let rows = plain(&draw(BAR, 100, 1.0));
        assert_eq!(rows[0], "Weekly requests  (req)");
        let text = rows.join("\n");
        for v in ["120 req", "260 req", "60 req"] {
            assert!(text.contains(v), "{v} in\n{text}");
        }
        assert!(text.contains("300 ┤") && text.contains("  0 ┼"));
        assert!(rows.last().unwrap().contains("Mon") && rows.last().unwrap().contains("Sun"));
    }

    #[test]
    fn negative_bars_hang_below_the_baseline_and_stacks_add_up() {
        let rows = plain(&draw(MULTI, 100, 1.0));
        let base = rows.iter().position(|r| r.contains('┼')).unwrap();
        assert!(
            rows[base + 1..]
                .iter()
                .any(|r| r.contains('█') || r.contains('▀'))
        );
        let stacked = plain(&draw(STACKED, 60, 1.0));
        // Totals 5, 8 and 11 make the axis reach 12 or more.
        assert!(
            stacked
                .iter()
                .any(|r| r.trim_start().starts_with("12") || r.trim_start().starts_with("15")),
            "{stacked:?}"
        );
    }

    #[test]
    fn stats_count_up_to_the_value_with_its_text_around_it() {
        let early = plain(&draw(STATS, 100, 0.2)).join("\n");
        assert!(
            early.contains("Revenue") && !early.contains("128,400") && !early.contains("$4.5B"),
            "{early}"
        );
        let done = plain(&draw(STATS, 100, 1.0)).join("\n");
        for v in [
            "$4.5B",
            "128,400",
            "99.98%",
            "▲ 12.3%",
            "▼ 2.1%",
            "vs last Q",
        ] {
            assert!(done.contains(v), "{v} in\n{done}");
        }
        assert_eq!(draw(STATS, 100, 1.0).len(), 5);
        assert_eq!(
            draw(STATS, 30, 1.0).len(),
            20,
            "one card per row when narrow"
        );
    }

    #[test]
    fn pie_and_donut_are_a_proportional_strip_with_shares() {
        let rows = plain(&draw(
            samples().iter().find(|s| s.0 == "donut").unwrap().1,
            80,
            1.0,
        ));
        let text = rows.join("\n");
        for v in ["60.0%", "15.0%", "25.0%", "Σ 100 GB"] {
            assert!(text.contains(v), "{v} in\n{text}");
        }
        // 60% of 80 cells.
        assert_eq!(rows[1].chars().filter(|c| *c == '█').count(), 80);
    }

    #[test]
    fn calendar_progress_and_hbar_read_their_spec() {
        let cal = plain(&draw(
            samples().iter().find(|s| s.0 == "cal").unwrap().1,
            100,
            1.0,
        ))
        .join("\n");
        assert!(
            cal.contains("Sep")
                && cal.contains("Oct")
                && cal.contains("Mon")
                && cal.contains("21 commits total"),
            "{cal}"
        );
        let progress = plain(&draw(
            samples().iter().find(|s| s.0 == "progress").unwrap().1,
            60,
            1.0,
        ))
        .join("\n");
        assert!(
            progress.contains("72%") && progress.contains("340 / 400") && progress.contains("45%")
        );
        let hbar = plain(&draw(
            samples().iter().find(|s| s.0 == "hbar").unwrap().1,
            60,
            1.0,
        ));
        assert!(
            hbar.iter()
                .any(|r| r.contains("한글 파일.rs") && r.contains("9 edits")),
            "{hbar:?}"
        );
        // Korean labels end in one column: every bar starts in the same place.
        let first_cell = |r: &str| width(&r[..r.find(['█', '░']).unwrap()]);
        let bars: Vec<&String> = hbar.iter().filter(|r| r.contains(['█', '░'])).collect();
        assert_eq!(bars.len(), 3);
        assert!(bars.iter().all(|r| first_cell(r) == first_cell(bars[0])));
    }

    #[test]
    fn series_use_the_themes_palette_and_fold_with_it() {
        let colors = |th: &Theme| -> HashSet<String> {
            render(&parse(MULTI).unwrap(), 80, 1.0, th, &UNICODE)
                .unwrap()
                .iter()
                .flat_map(|l| l.spans.iter())
                .filter_map(|s| s.style.fg)
                .map(|c| format!("{c:?}"))
                .collect()
        };
        let truecolor = colors(&LAVENDER);
        assert!(truecolor.iter().any(|c| c.starts_with("Rgb")));
        let ink = |th: &Theme, i| {
            Env {
                w: 1,
                p: 1.0,
                th,
                ascii: false,
            }
            .color(i)
        };
        assert_eq!(ink(&LAVENDER, 0), LAVENDER.brand);
        assert_ne!(ink(&LAVENDER, 0), ink(&LAVENDER, 1));
        let folded = LAVENDER.for_level(2);
        assert!(matches!(ink(&folded, 0), Color::Indexed(_)));
        assert!(colors(&folded).iter().all(|c| !c.starts_with("Rgb")));
        // Sixteen colours use the ANSI theme's names; none uses a background.
        let ansi = LAVENDER.for_level(1);
        assert!(
            colors(&ansi)
                .iter()
                .all(|c| !c.starts_with("Rgb") && !c.starts_with("Indexed"))
        );
        let mono = LAVENDER.for_level(0);
        assert_eq!(ink(&mono, 0), Color::Reset);
        let lines = render(&parse(MULTI).unwrap(), 80, 1.0, &mono, &UNICODE).unwrap();
        let text = plain(&lines).join("\n");
        assert!(
            text.contains('█') && text.contains('▓'),
            "series told apart by pattern:\n{text}"
        );
        for th in [&LAVENDER, &folded, &ansi, &mono] {
            for (_, src) in samples() {
                let lines = render(&parse(src).unwrap(), 100, 1.0, th, &UNICODE).unwrap();
                assert!(
                    lines
                        .iter()
                        .flat_map(|l| l.spans.iter())
                        .all(|s| s.style.bg.is_none()),
                    "no backgrounds"
                );
            }
        }
    }

    #[test]
    fn ascii_symbols_draw_only_ascii() {
        for (name, src) in samples() {
            if name == "hbar" {
                continue; // its Korean label is the spec's own text
            }
            let lines = render(&parse(src).unwrap(), 100, 1.0, &LAVENDER, &ASCII).unwrap();
            let rows = plain(&lines);
            assert!(rows.iter().all(|r| r.is_ascii()), "{name}: {rows:?}");
        }
    }

    #[test]
    fn too_narrow_is_not_drawn() {
        let spec = parse(BAR).unwrap();
        assert!(render(&spec, 12, 1.0, &LAVENDER, &UNICODE).is_none());
    }

    // --- the block registry ---------------------------------------------------------------------

    fn at(t0: Instant, ms: u64) -> Instant {
        t0 + Duration::from_millis(ms)
    }

    #[test]
    fn a_block_is_revealed_once_then_served_from_the_cache() {
        let t0 = Instant::now();
        let w = 100;
        let go = |ms: u64, w: usize| {
            block_at("chart", BAR, w, &LAVENDER, &UNICODE, at(t0, ms), true).unwrap()
        };
        let first = go(0, w);
        assert!(plain(&first).iter().all(|r| !r.contains('█')));
        assert!(animating_at(at(t0, 100)));
        let mid = go(400, w);
        assert_eq!(first.len(), mid.len(), "the height does not move");
        assert_ne!(plain(&first), plain(&mid));
        let done = go(900, w);
        assert!(plain(&done).iter().any(|r| r.contains('█')));
        assert!(
            !animating_at(at(t0, 950)),
            "no timer once the last frame is drawn"
        );
        // Scrolling back much later: the same lines, no replay, nothing parsed again.
        let parses = PARSES.with(std::cell::Cell::get);
        for ms in [5_000, 60_000] {
            assert_eq!(plain(&go(ms, w)), plain(&done));
        }
        assert_eq!(PARSES.with(std::cell::Cell::get), parses);
        assert_eq!(parses, 1, "one parse for all the frames");
        // A resize draws the finished chart at the new width; it does not start over.
        let narrow = go(61_000, 60);
        assert!(narrow.iter().all(|l| cells(l) <= 60));
        assert!(plain(&narrow).iter().any(|r| r.contains('█')));
        assert!(!animating_at(at(t0, 61_100)));
    }

    #[test]
    fn a_reveal_whose_last_frame_never_came_is_not_waited_for_forever() {
        let t0 = Instant::now();
        block_at("chart", STATS, 80, &LAVENDER, &UNICODE, at(t0, 0), true).unwrap();
        assert!(animating_at(at(t0, 700)));
        assert!(!animating_at(at(t0, 2_000)));
    }

    #[test]
    fn without_animations_a_block_appears_finished() {
        let t0 = Instant::now();
        let lines = block_at("chart", BAR, 100, &LAVENDER, &UNICODE, t0, false).unwrap();
        assert_eq!(plain(&lines), plain(&draw(BAR, 100, 1.0)));
        assert!(!animating_at(t0));
    }

    #[test]
    fn invalid_blocks_return_none_so_the_code_block_shows() {
        let t0 = Instant::now();
        assert!(block_at("chart", "{not json", 80, &LAVENDER, &UNICODE, t0, true).is_none());
        assert!(
            block_at(
                "mermaid",
                "sequenceDiagram\nA->>B: hi",
                80,
                &LAVENDER,
                &UNICODE,
                t0,
                true
            )
            .is_none()
        );
        assert!(block_at("chart", BAR, 10, &LAVENDER, &UNICODE, t0, true).is_none());
        assert!(is_visual("Chart") && is_visual("mermaid") && !is_visual("rust"));
    }

    #[test]
    fn the_placeholder_is_one_plain_row() {
        let rows = plain(&placeholder("chart", &LAVENDER, &UNICODE));
        assert_eq!(rows, vec!["▎ chart …"]);
        assert!(plain(&placeholder("mermaid", &LAVENDER, &ASCII))[0].is_ascii());
    }
}
