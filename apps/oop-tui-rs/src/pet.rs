//! The header's pet: Mocha, a warm coffee mug. Every colour she wears is a token of the active
//! theme (`fixtures/pet/mocha.json` says which token paints which pixel), so `/theme` recolours her
//! at once and she reads on a light theme as well as a dark one; the model that answers does not
//! change her colour. She steams when idle, brews while the model thinks, bounces while text
//! arrives, stirs a spoon for a tool, jumps when the model is switched, sleeps when you are away and
//! trembles at an error.
//!
//! Everything here is pure: the mood from what the app is doing, the frame a mood shows at a given
//! time, and how a frame is drawn. The app owns the clock. The pictures, the ink of each pixel kind
//! and the timing are the data of `fixtures/pet/mocha.json`: exported once from the TypeScript
//! terminal's renderer (since removed) and kept by hand here, with the cells that renderer drew as
//! its golden part; the tests compare every cell with what that file records.
//!
//! A picture is 14 by 10 pixels, packed two to a cell: 14 cells by 5 rows. Where the terminal has a
//! background colour (256 colours or more) a cell is one `▀` with two colours; without one (16
//! colours, no colour, ASCII) it is one colour and the pixels give its shape. The colours come from
//! the theme as the terminal's level folded it (`Theme::for_level`): 256 colours are the palette's
//! nearest cells, 16 colours the `ansi` theme's names, no colour nothing at all. She does not walk:
//! a mug stays on her coaster, and a bounce, a jump or a shake is drawn into the frames.

use crate::theme::Theme;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PetState {
    Idle,
    /// The model's text is arriving.
    Working,
    Thinking,
    Tool,
    Waiting,
    Success,
    Error,
    Resting,
    Greeting,
    /// The active model changed.
    Switching,
}

impl PetState {
    /// The name the data files use.
    pub fn key(self) -> &'static str {
        match self {
            PetState::Idle => "idle",
            PetState::Working => "working",
            PetState::Thinking => "thinking",
            PetState::Tool => "tool",
            PetState::Waiting => "waiting",
            PetState::Success => "success",
            PetState::Error => "error",
            PetState::Resting => "resting",
            PetState::Greeting => "greeting",
            PetState::Switching => "switching",
        }
    }
}

/// Cells of the full pet: 14 pixels wide, 10 tall, two pixels to a cell.
pub const PET_WIDTH: usize = 14;
#[cfg(test)]
pub const PET_HEIGHT: usize = 5;
/// The strip beside the header's notes: a gap before her and a free column next to the divider.
pub const PET_TRACK_WIDTH: usize = PET_WIDTH + 2;
/// The most cells a working pet may travel inside a wider strip than her own. The header grants as
/// many as it has to spare (`ui.rs`); the strip she is given is the only limit she knows.
pub const ROAM_MAX: usize = 12;
/// Cells of the one-line pet used by the compact header, and of its strip.
pub const PET_MINI_WIDTH: usize = 7;
pub const PET_MINI_TRACK_WIDTH: usize = PET_MINI_WIDTH + 2;

/// Quiet this long, and an idle pet falls asleep.
pub const REST_AFTER_MS: i64 = 90_000;
/// How long the greeting at startup, the happy look after a finished turn and a model switch last.
pub const GREETING_MS: i64 = 4_000;
pub const SUCCESS_MS: i64 = 4_000;
pub const SWITCH_MS: i64 = 1_000;

// ---- mood --------------------------------------------------------------------------------

/// What the thread is doing, reduced to what decides the pet's mood.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Not on a conversation (the lists).
    None,
    Idle,
    Working,
    /// An approval or a question waits for the user.
    Waiting,
    Error,
}

/// The model on screen: `scope` is the thread it belongs to, so opening another thread is no switch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Model {
    pub scope: String,
    pub key: String,
}

#[derive(Clone, Debug)]
pub struct Observation {
    pub phase: Phase,
    /// A tool of the running turn has not finished.
    pub tool: bool,
    /// The assistant's text is arriving.
    pub streaming: bool,
    /// The link to the server is up (or coming up).
    pub online: bool,
    /// The model the next message goes to; `None` where there is none to tell.
    pub model: Option<Model>,
}

/// What the pet remembers between observations.
#[derive(Clone, Debug)]
pub struct Memory {
    started_at: i64,
    active_at: i64,
    was_working: bool,
    finished_at: Option<i64>,
    model: Option<Model>,
    switched_at: Option<i64>,
}

impl Memory {
    pub fn new(now: i64) -> Self {
        Memory {
            started_at: now,
            active_at: now,
            was_working: false,
            finished_at: None,
            model: None,
            switched_at: None,
        }
    }

    /// Folds one observation in: remembers when a turn ended, when anything last happened and when
    /// the model changed in place.
    pub fn observe(&mut self, o: &Observation, now: i64) {
        let working = o.phase == Phase::Working;
        let busy = working || o.phase == Phase::Waiting;
        let finished = self.was_working && !working && o.phase == Phase::Idle;
        if finished {
            self.finished_at = Some(now);
        }
        if busy || finished || o.phase == Phase::Error {
            self.active_at = now;
        }
        self.was_working = working;
        if let Some(seen) = &o.model {
            // The first model, or another thread's, is no switch; the same thread's changing is.
            if let Some(model) = &self.model
                && model.scope == seen.scope
                && model.key != seen.key
            {
                self.switched_at = Some(now);
                self.active_at = now;
            }
            self.model = Some(seen.clone());
        }
    }

    /// A key was pressed or the terminal came back: a sleeping pet wakes.
    pub fn touch(&mut self, now: i64) {
        self.active_at = now;
    }

    /// The mood. A running turn beats everything; then the quiet states.
    pub fn state(&self, o: &Observation, now: i64) -> PetState {
        if !o.online {
            return PetState::Error;
        }
        match o.phase {
            Phase::Working if o.tool => return PetState::Tool,
            Phase::Working if o.streaming => return PetState::Working,
            Phase::Working => return PetState::Thinking,
            Phase::Waiting => return PetState::Waiting,
            Phase::Error => return PetState::Error,
            Phase::Idle | Phase::None => {}
        }
        if self.switched_at.is_some_and(|at| now - at < SWITCH_MS) {
            return PetState::Switching;
        }
        if now - self.started_at < GREETING_MS && self.finished_at.is_none() {
            return PetState::Greeting;
        }
        if self.finished_at.is_some_and(|at| now - at < SUCCESS_MS) {
            return PetState::Success;
        }
        if now - self.active_at >= REST_AFTER_MS {
            return PetState::Resting;
        }
        PetState::Idle
    }

    /// Which frame `state` shows at `now`: a switch plays once from the moment of the change, every
    /// other state loops by the clock alone.
    pub fn frame(&self, state: PetState, now: i64) -> usize {
        let since = if state == PetState::Switching {
            self.switched_at.unwrap_or(0)
        } else {
            0
        };
        clock(state, now - since)
    }
}

// ---- the data ----------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Art {
    /// The theme token (`brand`, `brandDim`, ...) every pixel kind is painted in.
    inks: HashMap<String, String>,
    states: HashMap<String, StateArt>,
}

#[derive(Deserialize)]
struct StateArt {
    frames: Vec<Vec<String>>,
    mini: Vec<Vec<String>>,
    script: Vec<(usize, i64)>,
}

fn art() -> &'static Art {
    static ART: OnceLock<Art> = OnceLock::new();
    ART.get_or_init(|| {
        serde_json::from_str(include_str!("../fixtures/pet/mocha.json"))
            .expect("fixtures/pet/mocha.json holds Mocha's art")
    })
}

fn state_art(state: PetState) -> &'static StateArt {
    art().states.get(state.key()).expect("every state has art")
}

/// How many pictures a state has.
#[cfg(test)]
pub fn frame_count(state: PetState) -> usize {
    state_art(state).frames.len()
}

/// The pixel rows of one picture (`PET_HEIGHT * 2` rows of `PET_WIDTH` pixels).
pub fn pixels(state: PetState, frame: usize) -> &'static [String] {
    let list = &state_art(state).frames;
    &list[frame % list.len()]
}

/// The pixel rows of one one-line picture (two rows of `PET_MINI_WIDTH` pixels).
pub fn mini_pixels(state: PetState, frame: usize) -> &'static [String] {
    let list = &state_art(state).mini;
    &list[frame % list.len()]
}

/// Which frame the state shows at `ms` of its own time: the script's segments in order, then round
/// again.
fn clock(state: PetState, ms: i64) -> usize {
    let script = &state_art(state).script;
    let cycle: i64 = script.iter().map(|(_, ms)| ms).sum();
    let into = ms.rem_euclid(cycle);
    let mut end = 0;
    for (frame, len) in script {
        end += len;
        if into < end {
            return *frame;
        }
    }
    0
}

/// How long a working pet stays on one cell while she paces her strip, or `None` where she stays
/// put. The app wakes every 250 ms while a turn runs, so the quickest pace is one cell a tick; the
/// slower ones are the quieter moods (a tool is a steadier walk, thinking a slow pace).
fn pace_ms(state: PetState) -> Option<i64> {
    match state {
        PetState::Working => Some(250),
        PetState::Tool => Some(330),
        PetState::Thinking => Some(500),
        _ => None,
    }
}

/// How many cells right of the strip's left edge she stands at `now`, in `0..=roam`: while a turn
/// runs she walks to one end and back, and in every other mood she stays where she is, so an idle
/// header never moves. `roam` is what the strip has to spare, worked out from the width she is
/// drawn in.
pub fn offset(state: PetState, now: i64, roam: usize) -> usize {
    let Some(pace) = pace_ms(state) else {
        return 0;
    };
    if roam == 0 {
        return 0;
    }
    let round = 2 * roam;
    let at = usize::try_from(now.div_euclid(pace).rem_euclid(round as i64)).unwrap_or(0);
    if at <= roam { at } else { round - at }
}

/// Milliseconds until the frame changes; the app wakes no sooner.
#[cfg(test)]
fn script(state: PetState) -> &'static [(usize, i64)] {
    &state_art(state).script
}

// ---- drawing -----------------------------------------------------------------------------

/// A colour of a cell, at the terminal's own level.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ink {
    /// The terminal's own.
    None,
    Rgb(u8, u8, u8),
    /// A slot of the 256-colour palette.
    Indexed(u8),
    /// One of the 16 colours.
    Ansi(u8),
}

impl Ink {
    /// `-`, `#RRGGBB`, `i<n>` or `a<n>`: how the fixture writes a colour.
    #[cfg(test)]
    pub fn encode(self) -> String {
        match self {
            Ink::None => "-".into(),
            Ink::Rgb(r, g, b) => format!("#{r:02X}{g:02X}{b:02X}"),
            Ink::Indexed(n) => format!("i{n}"),
            Ink::Ansi(n) => format!("a{n}"),
        }
    }

    fn color(self) -> Option<Color> {
        match self {
            Ink::None => None,
            Ink::Rgb(r, g, b) => Some(Color::Rgb(r, g, b)),
            Ink::Indexed(n) => Some(Color::Indexed(n)),
            Ink::Ansi(n) => Some(match n {
                0 => Color::Black,
                1 => Color::Red,
                2 => Color::Green,
                3 => Color::Yellow,
                4 => Color::Blue,
                5 => Color::Magenta,
                6 => Color::Cyan,
                7 => Color::Gray,
                8 => Color::DarkGray,
                9 => Color::LightRed,
                10 => Color::LightGreen,
                11 => Color::LightYellow,
                12 => Color::LightBlue,
                13 => Color::LightMagenta,
                14 => Color::LightCyan,
                _ => Color::White,
            }),
        }
    }
}

/// One cell of the drawing: a glyph, its foreground and the background it is packed over.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub glyph: char,
    pub fg: Ink,
    pub bg: Ink,
}

impl Cell {
    const EMPTY: Cell = Cell {
        glyph: ' ',
        fg: Ink::None,
        bg: Ink::None,
    };

    /// `glyph fg bg`, as the fixture writes a cell.
    #[cfg(test)]
    pub fn encode(&self) -> String {
        format!("{} {} {}", self.glyph, self.fg.encode(), self.bg.encode())
    }
}

/// How the terminal can show the pet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Draw {
    /// 0 no colour, 1 sixteen, 2 256, 3 truecolor.
    pub level: u8,
    pub ascii: bool,
}

/// The ink a theme colour is drawn in: the colour as the theme (already folded to the terminal's
/// level) holds it, with the 16 names as their slots.
fn ink_of(color: Color) -> Ink {
    match color {
        Color::Rgb(r, g, b) => Ink::Rgb(r, g, b),
        Color::Indexed(n) => Ink::Indexed(n),
        Color::Black => Ink::Ansi(0),
        Color::Red => Ink::Ansi(1),
        Color::Green => Ink::Ansi(2),
        Color::Yellow => Ink::Ansi(3),
        Color::Blue => Ink::Ansi(4),
        Color::Magenta => Ink::Ansi(5),
        Color::Cyan => Ink::Ansi(6),
        Color::Gray => Ink::Ansi(7),
        Color::DarkGray => Ink::Ansi(8),
        Color::LightRed => Ink::Ansi(9),
        Color::LightGreen => Ink::Ansi(10),
        Color::LightYellow => Ink::Ansi(11),
        Color::LightBlue => Ink::Ansi(12),
        Color::LightMagenta => Ink::Ansi(13),
        Color::LightCyan => Ink::Ansi(14),
        Color::White => Ink::Ansi(15),
        Color::Reset => Ink::None,
    }
}

/// A theme token by the name the art data uses.
fn token(theme: &Theme, name: &str) -> Color {
    match name {
        "brand" => theme.brand,
        "brandDim" => theme.brand_dim,
        "accent" => theme.accent,
        "muted" => theme.muted,
        "dim" => theme.dim,
        "border" => theme.border,
        "warning" => theme.warning,
        "error" => theme.error,
        "tool" => theme.tool,
        other => panic!("fixtures/pet/mocha.json names a theme token this build lacks: {other}"),
    }
}

/// The ink of a pixel: the theme's token for its kind. `Ink::None` for a theme (the monochrome one)
/// that paints nothing.
pub fn pixel_ink(ch: char, theme: &Theme) -> Ink {
    art()
        .inks
        .get(ch.encode_utf8(&mut [0; 4]) as &str)
        .map_or(Ink::None, |name| ink_of(token(theme, name)))
}

/// Glyphs for the ASCII form, by pixel: both pixels of a cell, the upper one, the lower one.
fn ascii_glyphs(ch: char) -> [char; 3] {
    match ch {
        'L' => ['=', '"', '_'],
        'S' => [':', '\'', '.'],
        'Y' => ['*'; 3],
        'R' => ['v'; 3],
        'Z' => ['z'; 3],
        'M' => ['~'; 3],
        'T' => ['|'; 3],
        'o' => ['o'; 3],
        _ => ['#', '"', '_'],
    }
}

/// In the flat renderer a cell of two different pixels shows the one that matters most.
fn weight(ch: char) -> u8 {
    match ch {
        'K' => 2,
        'B' | 'H' => 1,
        _ => 3,
    }
}

/// The pixel rows (two to a cell row) drawn as cells in `theme`'s colours. Where the terminal gives a background (256
/// colours or more, Unicode symbols) two pixels of different colours are one `▀` with a foreground
/// and a background, so every pixel keeps its colour. Without one (16 colours, no colour, ASCII) a
/// cell has one colour and the pixels only decide its shape (`▀ ▄ █`, or `" _ #`): the eyes are
/// left unpainted, a hole in the cup, and where two pixels differ the more important one wins.
pub fn cells<S: AsRef<str>>(pixels: &[S], theme: &Theme, draw: Draw) -> Vec<Vec<Cell>> {
    let rich = !draw.ascii && draw.level >= 2;
    let mut out = Vec::new();
    for pair in pixels.chunks_exact(2) {
        let (upper, lower) = (pair[0].as_ref(), pair[1].as_ref());
        let row = upper
            .chars()
            .zip(lower.chars())
            .map(|(top, bottom)| {
                if rich {
                    let ink = |ch: char| (ch != '.').then(|| pixel_ink(ch, theme));
                    let (a, b) = (ink(top), ink(bottom));
                    let (fa, fb) = (a.unwrap_or(Ink::None), b.unwrap_or(Ink::None));
                    return match (a, b) {
                        (None, None) => Cell::EMPTY,
                        (Some(_), None) => Cell {
                            glyph: '▀',
                            fg: fa,
                            bg: Ink::None,
                        },
                        (None, Some(_)) => Cell {
                            glyph: '▄',
                            fg: fb,
                            bg: Ink::None,
                        },
                        (Some(_), Some(_)) if fa == fb => Cell {
                            glyph: '█',
                            fg: fa,
                            bg: Ink::None,
                        },
                        _ => Cell {
                            glyph: '▀',
                            fg: fa,
                            bg: fb,
                        },
                    };
                }
                let on_top = top != '.' && top != 'E';
                let on_bottom = bottom != '.' && bottom != 'E';
                let shown = match (on_top, on_bottom) {
                    (false, false) => return Cell::EMPTY,
                    (true, true) if weight(top) > weight(bottom) => top,
                    (true, false) => top,
                    _ => bottom,
                };
                let glyph = if draw.ascii {
                    let glyphs = ascii_glyphs(shown);
                    match (on_top, on_bottom) {
                        (true, true) => glyphs[0],
                        (true, false) => glyphs[1],
                        _ => glyphs[2],
                    }
                } else {
                    match (on_top, on_bottom) {
                        (true, true) => '█',
                        (true, false) => '▀',
                        _ => '▄',
                    }
                };
                let fg = if draw.level == 0 {
                    Ink::None
                } else {
                    pixel_ink(shown, theme)
                };
                Cell {
                    glyph,
                    fg,
                    bg: Ink::None,
                }
            })
            .collect();
        out.push(row);
    }
    out
}

/// A row of cells as spans: runs of equal colours are one span, and a gap is left unpainted.
pub fn spans_of(row: &[Cell]) -> Vec<Span<'static>> {
    let mut out: Vec<Span<'static>> = Vec::new();
    let mut run = String::new();
    let mut open: Option<(Ink, Ink)> = None;
    let mut flush = |run: &mut String, open: Option<(Ink, Ink)>| {
        if run.is_empty() {
            return;
        }
        let text = std::mem::take(run);
        out.push(match open {
            None => Span::raw(text),
            Some((fg, bg)) => {
                let mut style = Style::new();
                if let Some(color) = fg.color() {
                    style = style.fg(color);
                }
                if let Some(color) = bg.color() {
                    style = style.bg(color);
                }
                Span::styled(text, style)
            }
        });
    };
    for cell in row {
        let next = (cell.glyph != ' ').then_some((cell.fg, cell.bg));
        if next != open {
            flush(&mut run, open);
            open = next;
        }
        run.push(cell.glyph);
    }
    flush(&mut run, open);
    out
}

/// One row of the strip: `offset` cells further right than her place, never past the last free
/// column, so a row is always exactly `track` wide (or as wide as the picture, where that is more).
fn strip(row: &[Cell], track: usize, offset: usize) -> Line<'static> {
    let lead = 1 + offset.min(track.saturating_sub(2 + row.len()));
    let mut spans = vec![Span::raw(" ".repeat(lead))];
    spans.extend(spans_of(row));
    spans.push(Span::raw(
        " ".repeat(track.saturating_sub(lead + row.len())),
    ));
    Line::from(spans)
}

/// The pet as `PET_HEIGHT` lines of exactly `track` cells: a gap in front, the last column free,
/// and `offset` more cells of gap where she has walked (cut to what the strip has to spare).
pub fn lines(
    state: PetState,
    frame: usize,
    theme: &Theme,
    track: usize,
    offset: usize,
    draw: Draw,
) -> Vec<Line<'static>> {
    cells(pixels(state, frame), theme, draw)
        .iter()
        .map(|row| strip(row, track, offset))
        .collect()
}

/// The one-line pet, `PET_MINI_WIDTH` cells in a strip of `track`, `offset` cells further right
/// than her place (cut to what the strip has to spare): a cup with her eyes and the state's mark.
pub fn mini(
    state: PetState,
    frame: usize,
    theme: &Theme,
    track: usize,
    offset: usize,
    draw: Draw,
) -> Line<'static> {
    let rows = cells(mini_pixels(state, frame), theme, draw);
    strip(rows.first().map_or(&[][..], Vec::as_slice), track, offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::width;
    use crate::theme;
    use serde_json::Value;

    const ALL_STATES: [PetState; 10] = [
        PetState::Idle,
        PetState::Working,
        PetState::Thinking,
        PetState::Tool,
        PetState::Waiting,
        PetState::Success,
        PetState::Error,
        PetState::Resting,
        PetState::Greeting,
        PetState::Switching,
    ];

    /// Every built-in theme but `ansi`, whose colours are the terminal's own names.
    const RGB_THEMES: [&str; 5] = ["oop", "oop-light", "aurora", "sunset", "colorblind"];

    const RICH: Draw = Draw {
        level: 3,
        ascii: false,
    };

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../fixtures/pet/mocha.json")).unwrap()
    }

    /// A built-in theme as a terminal of `level` shows it.
    fn theme_at(name: &str, level: u8) -> Theme {
        theme::builtin(name).unwrap().for_level(level)
    }

    fn plain(line: &Line) -> String {
        line.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    fn quiet() -> Observation {
        Observation {
            phase: Phase::Idle,
            tool: false,
            streaming: false,
            online: true,
            model: None,
        }
    }

    fn model(scope: &str, key: &str) -> Option<Model> {
        Some(Model {
            scope: scope.into(),
            key: key.into(),
        })
    }

    fn rgb(ink: Ink) -> (u8, u8, u8) {
        match ink {
            Ink::Rgb(r, g, b) => (r, g, b),
            other => panic!("not a truecolor ink: {other:?}"),
        }
    }

    /// WCAG relative luminance and contrast ratio of two truecolors.
    fn contrast(a: (u8, u8, u8), b: (u8, u8, u8)) -> f64 {
        let channel = |v: u8| {
            let v = f64::from(v) / 255.0;
            if v <= 0.03928 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        let lum = |(r, g, b): (u8, u8, u8)| {
            0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
        };
        let (hi, lo) = (lum(a).max(lum(b)), lum(a).min(lum(b)));
        (hi + 0.05) / (lo + 0.05)
    }

    fn ground(theme: &Theme) -> (u8, u8, u8) {
        match theme.user_bg {
            Color::Rgb(r, g, b) => (r, g, b),
            other => panic!("a truecolor theme has a truecolor ground: {other:?}"),
        }
    }

    #[test]
    fn every_frame_is_a_fourteen_by_ten_picture_and_every_state_has_two_to_four() {
        for state in ALL_STATES {
            let n = frame_count(state);
            assert!((2..=4).contains(&n), "{state:?} has {n} frames");
            for i in 0..n {
                let rows = pixels(state, i);
                assert_eq!(rows.len(), PET_HEIGHT * 2, "{state:?}#{i}");
                assert!(rows.iter().all(|r| r.chars().count() == PET_WIDTH));
                let mini = mini_pixels(state, i);
                assert_eq!(mini.len(), 2);
                assert!(mini.iter().all(|r| r.chars().count() == PET_MINI_WIDTH));
            }
            for (frame, _) in script(state) {
                assert!(*frame < n);
            }
        }
    }

    #[test]
    fn every_pixel_kind_in_the_art_has_a_theme_token_to_be_painted_in() {
        let lavender = theme::LAVENDER;
        for state in ALL_STATES {
            for i in 0..frame_count(state) {
                for ch in pixels(state, i)
                    .iter()
                    .chain(mini_pixels(state, i))
                    .flat_map(|r| r.chars())
                {
                    if ch != '.' {
                        assert_ne!(pixel_ink(ch, &lavender), Ink::None, "{state:?}#{i}: {ch}");
                    }
                }
            }
        }
    }

    #[test]
    fn the_body_is_solid_with_no_hollow_centre() {
        // From the first row of the cup (the one with a `B` in its middle) four more rows follow,
        // and in each the six pixels from its left edge are filled, even where an eye or a cheek is
        // drawn; a frame that jumps or shakes moves the cup as one.
        for state in ALL_STATES {
            for i in 0..frame_count(state) {
                let rows = pixels(state, i);
                let first = rows
                    .iter()
                    .position(|r| r.chars().any(|c| c == 'B'))
                    .expect("a body row");
                for row in &rows[first..first + 5] {
                    let edge = row.chars().position(|c| c == 'B' || c == 'H').unwrap();
                    let middle: Vec<char> = row.chars().skip(edge).take(6).collect();
                    assert!(!middle.contains(&'.'), "{state:?}#{i}: a gap in {row:?}");
                }
            }
        }
    }

    #[test]
    fn no_frame_changes_faster_than_four_times_a_second_but_the_idle_blink() {
        for state in ALL_STATES {
            for (frame, ms) in script(state) {
                if state == PetState::Idle && *frame == 2 {
                    continue;
                }
                assert!(*ms >= 250, "{state:?}: {ms}");
            }
        }
    }

    #[test]
    fn drawing_matches_the_fixture_cell_for_cell() {
        let golden = &fixture()["golden"];
        for (mode, level, ascii) in [("rich", 3, false), ("flat", 0, false), ("ascii", 0, true)] {
            let theme = theme_at("oop", level);
            let draw = Draw { level, ascii };
            for state in ALL_STATES {
                for (key, mini) in [(mode.to_string(), false), (format!("mini-{mode}"), true)] {
                    let want = golden["glyphs"][&key][state.key()].as_array().unwrap();
                    assert_eq!(want.len(), frame_count(state), "{key} {state:?}");
                    for (i, frame) in want.iter().enumerate() {
                        let rows = if mini {
                            mini_pixels(state, i)
                        } else {
                            pixels(state, i)
                        };
                        let got: Vec<String> = cells(rows, &theme, draw)
                            .iter()
                            .map(|r| r.iter().map(|c| c.glyph).collect())
                            .collect();
                        let want: Vec<&str> = frame
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| v.as_str().unwrap())
                            .collect();
                        assert_eq!(got, want, "{key} {state:?}#{i}");
                    }
                }
            }
        }
        let cases = golden["cells"].as_object().unwrap();
        assert!(cases.len() >= 5);
        for (name, states) in cases {
            // `theme@level` or `theme@level:ascii`
            let (theme_name, rest) = name.split_once('@').unwrap();
            let (level, ascii) = match rest.split_once(':') {
                Some((level, _)) => (level, true),
                None => (rest, false),
            };
            let level: u8 = level.parse().unwrap();
            let theme = theme_at(theme_name, level);
            let draw = Draw { level, ascii };
            for state in ALL_STATES {
                let want = &states[state.key()];
                for (which, rows) in [("full", pixels(state, 0)), ("mini", mini_pixels(state, 0))] {
                    let got: Vec<String> = cells(rows, &theme, draw)
                        .iter()
                        .map(|r| r.iter().map(Cell::encode).collect::<Vec<_>>().join(","))
                        .collect();
                    let want: Vec<&str> = want[which]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_str().unwrap())
                        .collect();
                    assert_eq!(got, want, "{name} {state:?} {which}");
                }
            }
        }
    }

    #[test]
    fn every_builtin_theme_inks_each_pixel_kind_the_same_as_the_typescript_terminal() {
        let inks = fixture()["golden"]["inks"].clone();
        for name in theme::BUILTIN_NAMES {
            let theme = theme_at(name, 3);
            let want = inks[name].as_object().expect(name);
            assert!(want.len() >= 12);
            for (kind, ink) in want {
                let ch = kind.chars().next().unwrap();
                // `ansi` at truecolor holds named colours; both clients write them as `a<n>`.
                assert_eq!(
                    pixel_ink(ch, &theme).encode(),
                    ink.as_str().unwrap(),
                    "{name} {kind}"
                );
            }
        }
    }

    #[test]
    fn each_theme_gives_the_pet_its_own_body_eye_and_coffee_inks() {
        let mut bodies = Vec::new();
        for name in theme::BUILTIN_NAMES {
            let theme = theme_at(name, 3);
            let [body, eye, coffee] = ['B', 'E', 'L'].map(|ch| pixel_ink(ch, &theme));
            assert!(
                body != eye && body != coffee && eye != coffee,
                "{name}: body {body:?}, eye {eye:?}, coffee {coffee:?}"
            );
            bodies.push((name, body, coffee));
        }
        // Changing the theme recolours her: no two themes share both the body and the coffee.
        for (i, a) in bodies.iter().enumerate() {
            for b in &bodies[i + 1..] {
                assert!((a.1, a.2) != (b.1, b.2), "{} and {} look alike", a.0, b.0);
            }
        }
        // And the drawn picture follows: the same frame in two themes has different colours.
        let dark = cells(pixels(PetState::Idle, 0), &theme_at("oop", 3), RICH);
        let other = cells(pixels(PetState::Idle, 0), &theme_at("sunset", 3), RICH);
        assert_ne!(dark, other);
        assert_eq!(
            dark.iter().flatten().map(|c| c.glyph).collect::<String>(),
            other.iter().flatten().map(|c| c.glyph).collect::<String>(),
            "only the colours change, never the shape"
        );
    }

    #[test]
    fn she_is_legible_on_a_light_theme_and_on_dark_ones() {
        // Against the theme's own ground (`user_bg`, the tint its text boxes sit on): the cup and
        // the coffee stand out of it and the eyes stand out of the cup.
        for name in RGB_THEMES {
            let theme = theme_at(name, 3);
            let ground = ground(&theme);
            let [body, eye, coffee, steam, coaster] =
                ['B', 'E', 'L', 'S', 'K'].map(|ch| rgb(pixel_ink(ch, &theme)));
            assert!(contrast(body, ground) >= 3.0, "{name}: cup on its ground");
            assert!(
                contrast(coffee, ground) >= 3.0,
                "{name}: coffee on its ground"
            );
            assert!(
                contrast(steam, ground) >= 3.0,
                "{name}: steam on its ground"
            );
            assert!(
                contrast(coaster, ground) >= 3.0,
                "{name}: coaster on its ground"
            );
            assert!(contrast(eye, body) >= 3.0, "{name}: eyes on the cup");
        }
        // The light theme really is light, so the test above covered one.
        assert!(contrast(ground(&theme_at("oop-light", 3)), (255, 255, 255)) < 1.2);
    }

    #[test]
    fn the_colour_level_folds_the_pet_the_way_it_folds_the_theme() {
        let rows = pixels(PetState::Idle, 0);
        let all_inks = |level: u8, name: &str| -> Vec<Ink> {
            let draw = Draw {
                level,
                ascii: false,
            };
            cells(rows, &theme_at(name, level), draw)
                .iter()
                .flatten()
                .flat_map(|c| [c.fg, c.bg])
                .filter(|i| *i != Ink::None)
                .collect()
        };
        // 256 colours: the nearest palette cell of each token, as the theme folds it.
        let folded = all_inks(2, "oop-light");
        assert!(!folded.is_empty() && folded.iter().all(|i| matches!(i, Ink::Indexed(_))));
        let theme = theme_at("oop-light", 2);
        assert_eq!(
            pixel_ink('B', &theme),
            Ink::Indexed(theme::indexed(0x72, 0x53, 0xb9))
        );
        // 16 colours: the `ansi` theme's names, so it looks the same everywhere.
        let sixteen = all_inks(1, "oop-light");
        assert!(!sixteen.is_empty() && sixteen.iter().all(|i| matches!(i, Ink::Ansi(_))));
        assert_eq!(pixel_ink('B', &theme_at("aurora", 1)), Ink::Ansi(13));
        assert_eq!(pixel_ink('L', &theme_at("aurora", 1)), Ink::Ansi(6));
        // No colour: nothing is inked, only the shapes are left.
        assert!(all_inks(0, "oop").is_empty());
    }

    #[test]
    fn without_a_background_the_cup_is_one_colour_a_cell_and_the_eyes_are_holes() {
        let theme = theme_at("oop", 1);
        let flat = cells(
            pixels(PetState::Idle, 0),
            &theme,
            Draw {
                level: 1,
                ascii: false,
            },
        );
        // the eyes (a whole pixel column of the cup) are unpainted gaps in a row of cup
        assert!(flat[2].iter().filter(|c| c.glyph == '▀').count() >= 2);
        assert!(flat.iter().flatten().all(|c| c.bg == Ink::None));
        let mono = cells(
            pixels(PetState::Idle, 0),
            &theme_at("oop", 0),
            Draw {
                level: 0,
                ascii: false,
            },
        );
        assert!(mono.iter().flatten().all(|c| c.fg == Ink::None));
        // the coffee is the theme's accent: cyan in the 16-colour theme
        assert!(flat.iter().flatten().any(|c| c.fg == Ink::Ansi(6)));
    }

    #[test]
    fn ascii_frames_use_only_ascii_and_read_as_a_mug() {
        let theme = theme_at("oop", 3);
        for state in ALL_STATES {
            for i in 0..frame_count(state) {
                let draw = Draw {
                    level: 3,
                    ascii: true,
                };
                for line in lines(state, i, &theme, PET_TRACK_WIDTH, 0, draw) {
                    assert!(plain(&line).is_ascii(), "{state:?}#{i}: {}", plain(&line));
                }
                assert!(plain(&mini(state, i, &theme, PET_MINI_TRACK_WIDTH, 0, draw)).is_ascii());
            }
        }
        let idle: Vec<String> = lines(
            PetState::Idle,
            0,
            &theme_at("oop", 0),
            PET_TRACK_WIDTH,
            0,
            Draw {
                level: 0,
                ascii: true,
            },
        )
        .iter()
        .map(plain)
        .collect();
        assert!(idle[2..].iter().all(|r| r.contains('#')), "{idle:#?}");
    }

    #[test]
    fn drawn_rows_fill_the_strip_exactly() {
        for state in ALL_STATES {
            for (level, ascii) in [(3, false), (1, false), (0, true)] {
                let theme = theme_at("oop-light", level);
                let draw = Draw { level, ascii };
                let rows = lines(state, 0, &theme, PET_TRACK_WIDTH, 0, draw);
                assert_eq!(rows.len(), PET_HEIGHT);
                for line in &rows {
                    assert_eq!(width(&plain(line)), PET_TRACK_WIDTH, "{state:?}");
                    assert!(plain(line).starts_with(' ') && plain(line).ends_with(' '));
                }
                let one = mini(state, 0, &theme, PET_MINI_TRACK_WIDTH, 0, draw);
                assert_eq!(width(&plain(&one)), PET_MINI_TRACK_WIDTH);
            }
        }
    }

    #[test]
    fn the_mood_follows_the_thread() {
        let mut memory = Memory::new(0);
        let idle = quiet();
        assert_eq!(memory.state(&idle, 1000), PetState::Greeting);
        assert_eq!(memory.state(&idle, GREETING_MS + 1), PetState::Idle);
        let working = Observation {
            phase: Phase::Working,
            ..quiet()
        };
        memory.observe(&working, 10_000);
        assert_eq!(memory.state(&working, 10_000), PetState::Thinking);
        let streaming = Observation {
            streaming: true,
            ..working.clone()
        };
        assert_eq!(memory.state(&streaming, 10_000), PetState::Working);
        let tool = Observation {
            tool: true,
            ..working.clone()
        };
        assert_eq!(memory.state(&tool, 10_000), PetState::Tool);
        let waiting = Observation {
            phase: Phase::Waiting,
            ..quiet()
        };
        assert_eq!(memory.state(&waiting, 10_000), PetState::Waiting);
        memory.observe(&idle, 12_000);
        assert_eq!(memory.state(&idle, 12_100), PetState::Success);
        assert_eq!(memory.state(&idle, 12_000 + SUCCESS_MS), PetState::Idle);
        assert_eq!(
            memory.state(&idle, 12_000 + REST_AFTER_MS),
            PetState::Resting
        );
        memory.touch(12_000 + REST_AFTER_MS);
        assert_eq!(memory.state(&idle, 12_000 + REST_AFTER_MS), PetState::Idle);
        let offline = Observation {
            online: false,
            ..quiet()
        };
        assert_eq!(memory.state(&offline, 0), PetState::Error);
        let failed = Observation {
            phase: Phase::Error,
            ..quiet()
        };
        assert_eq!(memory.state(&failed, 0), PetState::Error);
    }

    #[test]
    fn a_model_switch_in_place_makes_her_jump_but_a_new_thread_does_not() {
        let mut memory = Memory::new(0);
        let on = |m| Observation {
            model: m,
            ..quiet()
        };
        let t0 = GREETING_MS + 1;
        memory.observe(&on(model("a", "codex/gpt")), t0);
        // the first model is no switch
        assert_eq!(memory.state(&quiet(), t0), PetState::Idle);
        // another thread's model is no switch either
        memory.observe(&on(model("b", "claude/opus")), t0 + 10);
        assert_eq!(memory.state(&quiet(), t0 + 10), PetState::Idle);
        // the same thread's model changing is
        let at = t0 + 5_000;
        memory.observe(&on(model("b", "codex/gpt")), at);
        assert_eq!(memory.state(&quiet(), at + 1), PetState::Switching);
        // it plays once from the moment of the change: the first frame first, then on to the last
        assert_eq!(memory.frame(PetState::Switching, at), 0);
        assert_eq!(
            memory.frame(PetState::Switching, at + SWITCH_MS - 1),
            frame_count(PetState::Switching) - 1
        );
        assert_eq!(memory.state(&quiet(), at + SWITCH_MS), PetState::Idle);
        // and a turn beats it
        let working = Observation {
            phase: Phase::Working,
            ..quiet()
        };
        assert_eq!(memory.state(&working, at + 1), PetState::Thinking);
    }

    #[test]
    fn a_switch_keeps_her_colours() {
        // The jump is drawn into the frames; no frame of it holds a pixel kind of its own, so the
        // colours of a switch are the colours of every other state.
        let theme = theme_at("aurora", 3);
        for i in 0..frame_count(PetState::Switching) {
            for ch in pixels(PetState::Switching, i)
                .iter()
                .flat_map(|r| r.chars())
            {
                assert!(
                    ch == '.' || art().inks.contains_key(&ch.to_string()),
                    "{ch}"
                );
            }
        }
        let jump = cells(pixels(PetState::Switching, 3), &theme, RICH);
        let idle = cells(pixels(PetState::Idle, 0), &theme, RICH);
        let inks = |rows: &Vec<Vec<Cell>>| -> Vec<Ink> {
            let mut all: Vec<Ink> = rows.iter().flatten().flat_map(|c| [c.fg, c.bg]).collect();
            all.sort_by_key(|i| i.encode());
            all.dedup();
            all
        };
        assert_eq!(inks(&jump), inks(&idle));
    }

    #[test]
    fn the_clock_cycles_through_each_script() {
        assert_eq!(clock(PetState::Working, 0), 0);
        assert_eq!(clock(PetState::Working, 300), 1);
        assert_eq!(clock(PetState::Working, 1000), 0);
        // the idle steam alternates and the blink is brief
        assert_eq!(clock(PetState::Idle, 100), 0);
        assert_eq!(clock(PetState::Idle, 1700), 1);
        assert_eq!(clock(PetState::Idle, 1600 + 1700 + 100), 2);
    }

    #[test]
    fn she_paces_her_strip_while_a_turn_runs_and_stays_put_otherwise() {
        let reach = |state: PetState, roam: usize| -> (usize, usize) {
            let seen: Vec<usize> = (0..400).map(|i| offset(state, i * 250, roam)).collect();
            (*seen.iter().min().unwrap(), *seen.iter().max().unwrap())
        };
        for state in [PetState::Working, PetState::Tool, PetState::Thinking] {
            assert_eq!(reach(state, ROAM_MAX), (0, ROAM_MAX), "{state:?}");
        }
        // The more lively moods walk faster than the quieter ones.
        let steps = |state| {
            (0..40)
                .filter(|i| offset(state, i * 250, 12) != offset(state, (i + 1) * 250, 12))
                .count()
        };
        assert!(steps(PetState::Working) > steps(PetState::Tool));
        assert!(steps(PetState::Tool) > steps(PetState::Thinking));
        // Calm moods never move, whatever the room.
        for state in ALL_STATES {
            if !matches!(
                state,
                PetState::Working | PetState::Tool | PetState::Thinking
            ) {
                assert_eq!(reach(state, ROAM_MAX), (0, 0), "{state:?}");
            }
        }
        // With no room to spare she does not move either.
        assert_eq!(reach(PetState::Working, 0), (0, 0));
        // A step is one cell at most per tick: she walks, she does not teleport.
        for now in (0..4000).step_by(250) {
            let (a, b) = (
                offset(PetState::Working, now, ROAM_MAX),
                offset(PetState::Working, now + 250, ROAM_MAX),
            );
            assert!(a.abs_diff(b) <= 1);
        }
    }

    #[test]
    fn a_wider_strip_gives_a_working_pet_more_range_and_she_never_leaves_it() {
        let theme = theme_at("oop", 0);
        let draw = Draw {
            level: 0,
            ascii: false,
        };
        let left_edge = |track: usize, roam: usize, now: i64| {
            let rows = lines(
                PetState::Working,
                0,
                &theme,
                track,
                offset(PetState::Working, now, roam),
                draw,
            );
            for row in &rows {
                assert_eq!(width(&plain(row)), track, "track {track} roam {roam}");
                assert!(plain(row).ends_with(' '));
            }
            plain(&rows[2]).chars().take_while(|c| *c == ' ').count()
        };
        let range = |track: usize, roam: usize| {
            let lefts: Vec<usize> = (0..200).map(|i| left_edge(track, roam, i * 250)).collect();
            lefts.iter().max().unwrap() - lefts.iter().min().unwrap()
        };
        let narrow = range(PET_TRACK_WIDTH, 0);
        let wide = range(PET_TRACK_WIDTH + 8, 8);
        let wider = range(PET_TRACK_WIDTH + ROAM_MAX, ROAM_MAX);
        assert_eq!(narrow, 0);
        assert!(wide > narrow && wider > wide, "{narrow} {wide} {wider}");
        // Asked for more than the strip holds, she is cut to it, and tracks narrower than her
        // own never overflow either.
        for track in [
            0,
            1,
            5,
            PET_MINI_TRACK_WIDTH,
            PET_TRACK_WIDTH,
            PET_TRACK_WIDTH + 3,
        ] {
            let rows = lines(PetState::Working, 0, &theme, track, 99, draw);
            for row in &rows {
                assert!(width(&plain(row)) <= track.max(PET_WIDTH + 1), "{track}");
            }
        }
        let rows = lines(PetState::Working, 0, &theme, PET_TRACK_WIDTH + 3, 99, draw);
        assert!(rows.iter().all(|r| width(&plain(r)) == PET_TRACK_WIDTH + 3));
    }

    /// Prints the gallery of every state: `cargo test gallery -- --nocapture`.
    #[test]
    fn gallery() {
        let theme = theme_at("oop", 0);
        let draw = Draw {
            level: 0,
            ascii: false,
        };
        for state in ALL_STATES {
            println!("== {}", state.key());
            let all: Vec<Vec<Vec<Cell>>> = (0..frame_count(state))
                .map(|i| cells(pixels(state, i), &theme, draw))
                .collect();
            for row in 0..PET_HEIGHT {
                let line: Vec<String> = all
                    .iter()
                    .map(|f| f[row].iter().map(|c| c.glyph).collect())
                    .collect();
                println!("{}", line.join(" | "));
            }
        }
    }
}
