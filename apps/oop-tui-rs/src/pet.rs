//! The header's pet: Mocha, a warm coffee mug. Her coffee and steam take the colour of the provider
//! that answers (Claude, OpenAI, a local model, or plain coffee brown); she steams when idle, brews
//! while the model thinks, bounces while text arrives, stirs a spoon for a tool, jumps and changes
//! colour when the model is switched, sleeps when you are away and trembles at an error.
//!
//! Everything here is pure: the mood from what the app is doing, the frame a mood shows at a given
//! time, and how a frame is drawn. The app owns the clock. The pictures, the palette and the timing
//! are the data of `fixtures/pet/mocha.json`, which `apps/oop-tui/src/render/mochaArt.ts` is the
//! source of (`scripts/export-fixtures.mjs` writes it), so this terminal and the TypeScript one draw
//! the same frames; the tests compare every cell with what that file records.
//!
//! A picture is 14 by 10 pixels, packed two to a cell: 14 cells by 5 rows. Where the terminal has a
//! background colour (256 colours or more) a cell is one `▀` with two colours; without one (16
//! colours, no colour, ASCII) it is one colour and the pixels give its shape. She does not walk: a
//! mug stays on her coaster, and a bounce, a jump or a shake is drawn into the frames.

use crate::theme;
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

/// Which colour the coffee and steam are in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Claude,
    Openai,
    Local,
    Default,
}

impl Tone {
    fn key(self) -> &'static str {
        match self {
            Tone::Claude => "claude",
            Tone::Openai => "openai",
            Tone::Local => "local",
            Tone::Default => "default",
        }
    }
}

/// Cells of the full pet: 14 pixels wide, 10 tall, two pixels to a cell.
pub const PET_WIDTH: usize = 14;
#[cfg(test)]
pub const PET_HEIGHT: usize = 5;
/// The strip beside the header's notes: a gap before her and a free column next to the divider.
pub const PET_TRACK_WIDTH: usize = PET_WIDTH + 2;
/// Cells of the one-line pet used by the compact header, and of its strip.
pub const PET_MINI_WIDTH: usize = 7;
pub const PET_MINI_TRACK_WIDTH: usize = PET_MINI_WIDTH + 2;

/// Quiet this long, and an idle pet falls asleep.
pub const REST_AFTER_MS: i64 = 90_000;
/// How long the greeting at startup, the happy look after a finished turn and a model switch last.
pub const GREETING_MS: i64 = 4_000;
pub const SUCCESS_MS: i64 = 4_000;
pub const SWITCH_MS: i64 = 1_000;

// ---- which colour ------------------------------------------------------------------------

const LOCAL_NAMES: [&str; 8] = [
    "localai",
    "local",
    "ollama",
    "lmstudio",
    "lm-studio",
    "llama.cpp",
    "llama-cpp",
    "llamacpp",
];

/// A local runtime's name standing as a word: not inside a longer run of letters.
fn local_hint(text: &str) -> bool {
    let text = text.to_lowercase();
    LOCAL_NAMES.iter().any(|name| {
        text.match_indices(name).any(|(at, _)| {
            let before = text[..at].chars().next_back();
            let after = text[at + name.len()..].chars().next();
            !before.is_some_and(|c| c.is_ascii_lowercase())
                && !after.is_some_and(|c| c.is_ascii_lowercase())
        })
    })
}

/// The colour for the model that answers, decided per provider adapter: Claude's is terracotta and
/// Codex's emerald; a driver or instance named for a local runtime (Ollama, LM Studio, llama.cpp) is
/// violet, and so is an OpenCode model served by one (`ollama/llama3`). Cursor, Grok, Antigravity and
/// every other OpenCode model keep the default coffee brown: their models are not one vendor's.
pub fn tone_of(driver: Option<&str>, instance_id: &str, model: &str) -> Tone {
    let kind = driver.unwrap_or_default().to_lowercase();
    if kind == "claudeagent" || kind == "claude" {
        return Tone::Claude;
    }
    if kind == "codex" {
        return Tone::Openai;
    }
    if local_hint(&kind) || (kind.is_empty() && local_hint(instance_id)) {
        return Tone::Local;
    }
    if kind == "opencode" && local_hint(model.split('/').next().unwrap_or_default()) {
        return Tone::Local;
    }
    Tone::Default
}

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
    pub tone: Tone,
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
    /// The colour the coffee was in before the last switch.
    from: Tone,
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
            from: Tone::Default,
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
            match &self.model {
                // The first model, or another thread's: she takes its colour without a show.
                Some(model) if model.scope == seen.scope => {
                    if model.key != seen.key {
                        self.from = model.tone;
                        self.switched_at = Some(now);
                        self.active_at = now;
                    }
                }
                _ => self.from = seen.tone,
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

    /// The colours `state` is drawn in: the coffee's own, and in a switch the one it is leaving.
    pub fn look(&self, state: PetState) -> Look {
        let tone = self.model.as_ref().map_or(Tone::Default, |m| m.tone);
        Look {
            tone,
            from: if state == PetState::Switching {
                self.from
            } else {
                tone
            },
        }
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

/// The colours a state is drawn in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Look {
    pub tone: Tone,
    /// `L` and `S` pixels use this colour and `l` and `s` use `tone`: a switch is a wave from one to
    /// the other. Equal to `tone` in every state but a switch.
    pub from: Tone,
}

// ---- the data ----------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Art {
    palette: HashMap<String, String>,
    liquid: HashMap<String, String>,
    steam_lift: f64,
    ansi16: HashMap<String, u8>,
    ansi16_tone: HashMap<String, u8>,
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

type Rgb = (u8, u8, u8);

fn parse_hex(hex: &str) -> Rgb {
    let packed = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0);
    ((packed >> 16) as u8, (packed >> 8) as u8, packed as u8)
}

/// The steam: the coffee's colour lifted toward white, so it still shows on a dark background.
fn lifted((r, g, b): Rgb) -> Rgb {
    let lift = art().steam_lift;
    let up = |v: u8| {
        let v = f64::from(v);
        (v + (255.0 - v) * lift).round() as u8
    };
    (up(r), up(g), up(b))
}

fn liquid(tone: Tone) -> Rgb {
    parse_hex(&art().liquid[tone.key()])
}

/// The truecolor of a pixel; `None` for nothing. `L S` are the old colour of a switch, `l s` the new.
fn pixel_rgb(ch: char, tone: Tone, from: Tone) -> Option<Rgb> {
    match ch {
        '.' => None,
        'L' => Some(liquid(from)),
        'l' => Some(liquid(tone)),
        'S' => Some(lifted(liquid(from))),
        's' => Some(lifted(liquid(tone))),
        other => art()
            .palette
            .get(other.encode_utf8(&mut [0; 4]) as &str)
            .map(|hex| parse_hex(hex)),
    }
}

/// The ink of a truecolor at a colour level (3 and 2 here; the 16 colours have their own table).
fn ink_of((r, g, b): Rgb, level: u8) -> Ink {
    match level {
        3 => Ink::Rgb(r, g, b),
        2 => Ink::Indexed(theme::indexed(r, g, b)),
        _ => Ink::None,
    }
}

/// A pixel's ink in the flat renderer at 16 colours: its own table entry, the coffee's by provider.
fn ansi16_of(ch: char, tone: Tone, from: Tone) -> Ink {
    let art = art();
    let index = match ch {
        'L' | 'S' => art.ansi16_tone.get(from.key()),
        'l' | 's' => art.ansi16_tone.get(tone.key()),
        other => art.ansi16.get(other.encode_utf8(&mut [0; 4]) as &str),
    };
    index.map_or(Ink::None, |n| Ink::Ansi(*n))
}

/// Glyphs for the ASCII form, by pixel: both pixels of a cell, the upper one, the lower one.
fn ascii_glyphs(ch: char) -> [char; 3] {
    match ch {
        'L' | 'l' => ['=', '"', '_'],
        'S' | 's' => [':', '\'', '.'],
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

/// The pixel rows (two to a cell row) drawn as cells. Where the terminal gives a background (256
/// colours or more, Unicode symbols) two pixels of different colours are one `▀` with a foreground
/// and a background, so every pixel keeps its colour. Without one (16 colours, no colour, ASCII) a
/// cell has one colour and the pixels only decide its shape (`▀ ▄ █`, or `" _ #`): the eyes are
/// left unpainted, a hole in the cup, and where two pixels differ the more important one wins.
pub fn cells<S: AsRef<str>>(pixels: &[S], look: Look, draw: Draw) -> Vec<Vec<Cell>> {
    let Look { tone, from } = look;
    let rich = !draw.ascii && draw.level >= 2;
    let mut out = Vec::new();
    for pair in pixels.chunks_exact(2) {
        let (upper, lower) = (pair[0].as_ref(), pair[1].as_ref());
        let row = upper
            .chars()
            .zip(lower.chars())
            .map(|(top, bottom)| {
                if rich {
                    let a = pixel_rgb(top, tone, from);
                    let b = pixel_rgb(bottom, tone, from);
                    let ink = |rgb: Option<Rgb>| rgb.map_or(Ink::None, |c| ink_of(c, draw.level));
                    let (fa, fb) = (ink(a), ink(b));
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
                let fg = if draw.level == 1 {
                    ansi16_of(shown, tone, from)
                } else {
                    match pixel_rgb(shown, tone, from) {
                        Some(rgb) if draw.level != 0 => ink_of(rgb, draw.level),
                        _ => Ink::None,
                    }
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
fn spans_of(row: &[Cell]) -> Vec<Span<'static>> {
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

fn strip(row: &[Cell], track: usize) -> Line<'static> {
    let mut spans = vec![Span::raw(" ")];
    spans.extend(spans_of(row));
    spans.push(Span::raw(" ".repeat(track.saturating_sub(1 + row.len()))));
    Line::from(spans)
}

/// The pet as `PET_HEIGHT` lines of exactly `track` cells: a gap in front, the last column free.
pub fn lines(
    state: PetState,
    frame: usize,
    look: Look,
    track: usize,
    draw: Draw,
) -> Vec<Line<'static>> {
    cells(pixels(state, frame), look, draw)
        .iter()
        .map(|row| strip(row, track))
        .collect()
}

/// The one-line pet, `PET_MINI_WIDTH` cells in a strip of `track`: a cup with her eyes and the
/// state's mark.
pub fn mini(state: PetState, frame: usize, look: Look, track: usize, draw: Draw) -> Line<'static> {
    let rows = cells(mini_pixels(state, frame), look, draw);
    strip(rows.first().map_or(&[][..], Vec::as_slice), track)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::width;
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

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../fixtures/pet/mocha.json")).unwrap()
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

    fn model(scope: &str, key: &str, tone: Tone) -> Option<Model> {
        Some(Model {
            scope: scope.into(),
            key: key.into(),
            tone,
        })
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
        let fixture = fixture();
        let golden = &fixture["golden"];
        let look = Look {
            tone: Tone::Openai,
            from: Tone::Claude,
        };
        let modes = [
            (
                "rich",
                Draw {
                    level: 3,
                    ascii: false,
                },
            ),
            (
                "flat",
                Draw {
                    level: 0,
                    ascii: false,
                },
            ),
            (
                "ascii",
                Draw {
                    level: 0,
                    ascii: true,
                },
            ),
        ];
        for (mode, draw) in modes {
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
                        let got: Vec<String> = cells(rows, look, draw)
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
        let levels = [
            (
                "3",
                Draw {
                    level: 3,
                    ascii: false,
                },
            ),
            (
                "1",
                Draw {
                    level: 1,
                    ascii: false,
                },
            ),
            (
                "0",
                Draw {
                    level: 0,
                    ascii: false,
                },
            ),
            (
                "ascii1",
                Draw {
                    level: 1,
                    ascii: true,
                },
            ),
        ];
        for (name, draw) in levels {
            for state in ALL_STATES {
                let want = &golden["cells"][name][state.key()];
                for (which, rows) in [("full", pixels(state, 0)), ("mini", mini_pixels(state, 0))] {
                    let got: Vec<String> = cells(rows, look, draw)
                        .iter()
                        .map(|r| r.iter().map(Cell::encode).collect::<Vec<_>>().join(","))
                        .collect();
                    let want: Vec<&str> = want[which]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_str().unwrap())
                        .collect();
                    assert_eq!(got, want, "level {name} {state:?} {which}");
                }
            }
        }
    }

    #[test]
    fn the_provider_decides_the_colour_the_same_way_as_the_typescript_terminal() {
        let fixture = fixture();
        let cases = fixture["toneCases"].as_array().unwrap();
        assert!(cases.len() > 10);
        for case in cases {
            let driver = case[0].as_str();
            let want = match case[3].as_str().unwrap() {
                "claude" => Tone::Claude,
                "openai" => Tone::Openai,
                "local" => Tone::Local,
                _ => Tone::Default,
            };
            assert_eq!(
                tone_of(driver, case[1].as_str().unwrap(), case[2].as_str().unwrap()),
                want,
                "{case}"
            );
        }
    }

    #[test]
    fn the_palette_is_exact_in_truecolor_and_nearest_in_256() {
        let look = Look {
            tone: Tone::Claude,
            from: Tone::Claude,
        };
        let rows = pixels(PetState::Idle, 0);
        // the coffee is the provider's hex; a cup row over the coaster is cream on brown
        let truecolor = cells(
            rows,
            look,
            Draw {
                level: 3,
                ascii: false,
            },
        );
        assert!(
            truecolor[1]
                .iter()
                .any(|c| c.fg == Ink::Rgb(0xD9, 0x77, 0x57) || c.bg == Ink::Rgb(0xD9, 0x77, 0x57))
        );
        assert!(
            truecolor[4]
                .iter()
                .any(|c| c.fg == Ink::Rgb(0xD8, 0xCF, 0xC2) && c.bg == Ink::Rgb(0x8C, 0x5A, 0x3C))
        );
        let nearest = cells(
            rows,
            look,
            Draw {
                level: 2,
                ascii: false,
            },
        );
        assert!(
            nearest
                .iter()
                .flatten()
                .all(|c| !matches!(c.fg, Ink::Rgb(..)))
        );
        assert!(
            nearest[4]
                .iter()
                .any(|c| c.bg == Ink::Indexed(theme::indexed(0x8C, 0x5A, 0x3C)))
        );
        // each provider has its own coffee
        for (tone, hex) in [
            (Tone::Claude, (0xD9, 0x77, 0x57)),
            (Tone::Openai, (0x10, 0xA3, 0x7F)),
            (Tone::Local, (0x7C, 0x3A, 0xED)),
            (Tone::Default, (0x6F, 0x4E, 0x37)),
        ] {
            assert_eq!(liquid(tone), hex);
        }
    }

    #[test]
    fn without_a_background_the_cup_is_one_colour_a_cell_and_the_eyes_are_holes() {
        let look = Look {
            tone: Tone::Local,
            from: Tone::Local,
        };
        let flat = cells(
            pixels(PetState::Idle, 0),
            look,
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
            look,
            Draw {
                level: 0,
                ascii: false,
            },
        );
        assert!(mono.iter().flatten().all(|c| c.fg == Ink::None));
        // the coffee is violet in 16 colours
        assert!(flat.iter().flatten().any(|c| c.fg == Ink::Ansi(5)));
    }

    #[test]
    fn ascii_frames_use_only_ascii_and_read_as_a_mug() {
        let look = Look {
            tone: Tone::Default,
            from: Tone::Default,
        };
        for state in ALL_STATES {
            for i in 0..frame_count(state) {
                let draw = Draw {
                    level: 3,
                    ascii: true,
                };
                for line in lines(state, i, look, PET_TRACK_WIDTH, draw) {
                    assert!(plain(&line).is_ascii(), "{state:?}#{i}: {}", plain(&line));
                }
                assert!(plain(&mini(state, i, look, PET_MINI_TRACK_WIDTH, draw)).is_ascii());
            }
        }
        let idle: Vec<String> = lines(
            PetState::Idle,
            0,
            look,
            PET_TRACK_WIDTH,
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
        let look = Look {
            tone: Tone::Claude,
            from: Tone::Claude,
        };
        for state in ALL_STATES {
            for draw in [
                Draw {
                    level: 3,
                    ascii: false,
                },
                Draw {
                    level: 1,
                    ascii: false,
                },
                Draw {
                    level: 0,
                    ascii: true,
                },
            ] {
                let rows = lines(state, 0, look, PET_TRACK_WIDTH, draw);
                assert_eq!(rows.len(), PET_HEIGHT);
                for line in &rows {
                    assert_eq!(width(&plain(line)), PET_TRACK_WIDTH, "{state:?}");
                    assert!(plain(line).starts_with(' ') && plain(line).ends_with(' '));
                }
                let one = mini(state, 0, look, PET_MINI_TRACK_WIDTH, draw);
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
    fn a_model_switch_in_place_jumps_and_changes_colour_but_a_new_thread_does_not() {
        let mut memory = Memory::new(0);
        let on = |m| Observation {
            model: m,
            ..quiet()
        };
        let t0 = GREETING_MS + 1;
        memory.observe(&on(model("a", "codex/gpt", Tone::Openai)), t0);
        // the first model is no switch
        assert_eq!(memory.state(&quiet(), t0), PetState::Idle);
        assert_eq!(memory.look(PetState::Idle).tone, Tone::Openai);
        // another thread's model is no switch either
        memory.observe(&on(model("b", "claude/opus", Tone::Claude)), t0 + 10);
        assert_eq!(memory.state(&quiet(), t0 + 10), PetState::Idle);
        // the same thread's model changing is
        let at = t0 + 5_000;
        memory.observe(&on(model("b", "codex/gpt", Tone::Openai)), at);
        assert_eq!(memory.state(&quiet(), at + 1), PetState::Switching);
        let look = memory.look(PetState::Switching);
        assert_eq!((look.from, look.tone), (Tone::Claude, Tone::Openai));
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
    fn the_clock_cycles_through_each_script() {
        assert_eq!(clock(PetState::Working, 0), 0);
        assert_eq!(clock(PetState::Working, 300), 1);
        assert_eq!(clock(PetState::Working, 1000), 0);
        // the idle steam alternates and the blink is brief
        assert_eq!(clock(PetState::Idle, 100), 0);
        assert_eq!(clock(PetState::Idle, 1700), 1);
        assert_eq!(clock(PetState::Idle, 1600 + 1700 + 100), 2);
    }

    /// Prints the gallery of every state: `cargo test gallery -- --nocapture`.
    #[test]
    fn gallery() {
        let look = Look {
            tone: Tone::Claude,
            from: Tone::Claude,
        };
        let draw = Draw {
            level: 0,
            ascii: false,
        };
        for state in ALL_STATES {
            println!("== {}", state.key());
            let all: Vec<Vec<Vec<Cell>>> = (0..frame_count(state))
                .map(|i| cells(pixels(state, i), look, draw))
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
