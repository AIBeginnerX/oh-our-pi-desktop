//! What `/diff` writes under the conversation: a heading with the turn's totals, the files it
//! touched and the diff under them, drawn like the TypeScript terminal's (apps/oop-tui/src/render/
//! diffReport.ts and diff.ts): line numbers once a hunk header is seen, the added and removed
//! lines on a tinted background, and the changed words of a lone removed/added pair marked.

use crate::panels_common::{fill, s};
use crate::text::{char_width, sanitize, truncate, width};
use crate::theme::{Symbols, Theme};
use crate::thread::CheckpointFile;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

/// Diff lines the whole turn shows.
pub const OVERVIEW_LINES: usize = 300;
/// Diff lines one file shows when it is asked for by name.
pub const FILE_LINES: usize = 2000;
/// A diff line longer than this is cut: a minified file would otherwise wrap into thousands of rows.
const LINE_COLUMNS: usize = 400;
/// Files named under the heading before the rest are counted.
const FILES_LISTED: usize = 20;
/// Columns the rail takes in front of a row.
const RAIL_COLUMNS: usize = 3;
/// Word comparison is quadratic, so a longer pair of lines is left with whole-line colour only.
const WORD_DIFF_TOKEN_LIMIT: usize = 200;
const WORD_DIFF_CHARACTER_LIMIT: usize = 2000;

/// A `diff --git` section: its header line (empty for text before the first one) and its lines.
struct Section {
    header: String,
    lines: Vec<String>,
}

/// Splits a unified diff at its `diff --git` lines, one section per file.
fn sections(diff: &str) -> Vec<Section> {
    let mut out: Vec<Section> = Vec::new();
    for line in diff.split('\n') {
        if line.starts_with("diff --git ") {
            out.push(Section {
                header: line.to_string(),
                lines: vec![line.to_string()],
            });
        } else if let Some(last) = out.last_mut() {
            last.lines.push(line.to_string());
        } else if !line.is_empty() {
            out.push(Section {
                header: String::new(),
                lines: vec![line.to_string()],
            });
        }
    }
    // The diff ends with a line feed, which is not a line of the last file.
    if let Some(last) = out.last_mut()
        && last.lines.last().is_some_and(|l| l.is_empty())
    {
        last.lines.pop();
    }
    out
}

/// A quoted git path with its escapes undone: `"b/\355\225\234.ts"` is `b/한.ts`. The escapes are
/// per byte, so the bytes are rejoined and decoded together.
pub fn unquote_git_path(token: &str) -> String {
    let body = token
        .strip_prefix('"')
        .and_then(|t| t.strip_suffix('"'))
        .unwrap_or(token);
    if !body.contains('\\') {
        return body.to_string();
    }
    let mut bytes: Vec<u8> = Vec::new();
    let raw = body.as_bytes();
    let mut at = 0;
    while at < raw.len() {
        if raw[at] != b'\\' {
            bytes.push(raw[at]);
            at += 1;
            continue;
        }
        let Some(&escaped) = raw.get(at + 1) else {
            bytes.push(b'\\');
            break;
        };
        let named = match escaped {
            b'a' => Some(7),
            b'b' => Some(8),
            b't' => Some(9),
            b'n' => Some(10),
            b'v' => Some(11),
            b'f' => Some(12),
            b'r' => Some(13),
            b'"' => Some(b'"'),
            b'\\' => Some(b'\\'),
            _ => None,
        };
        if let Some(byte) = named {
            bytes.push(byte);
            at += 2;
        } else if raw.len() >= at + 4
            && raw[at + 1..at + 4]
                .iter()
                .all(|b| (b'0'..=b'7').contains(b))
        {
            let value = raw[at + 1..at + 4]
                .iter()
                .fold(0u32, |n, b| n * 8 + u32::from(b - b'0'));
            bytes.push(value as u8);
            at += 4;
        } else {
            bytes.push(escaped);
            at += 2;
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The new-side path of a `diff --git` line when git quoted it (as it does for any name outside
/// ASCII); `None` when the new side is not quoted, which the plain ` b/<path>` ending covers.
fn quoted_header_path(header: &str) -> Option<String> {
    if !header.ends_with('"') {
        return None;
    }
    let bytes = header.as_bytes();
    let mut at = bytes.len().checked_sub(2)?;
    loop {
        if bytes[at] == b'"' {
            // A quote the name escapes belongs to the name: an odd run of backslashes before it.
            let mut slashes = 0;
            while at > slashes && bytes[at - 1 - slashes] == b'\\' {
                slashes += 1;
            }
            if slashes % 2 == 0 {
                let name = unquote_git_path(&header[at..]);
                return name.strip_prefix("b/").map(str::to_string);
            }
        }
        at = at.checked_sub(1)?;
    }
}

fn section_is_file(section: &Section, path: &str) -> bool {
    section.header.ends_with(&format!(" b/{path}"))
        || quoted_header_path(&section.header).as_deref() == Some(path)
}

fn shortened(line: &str) -> String {
    if line.chars().count() <= LINE_COLUMNS {
        line.to_string()
    } else {
        format!("{}…", line.chars().take(LINE_COLUMNS).collect::<String>())
    }
}

/// Composes decomposed Hangul (what macOS writes into file names) into syllables, so a name typed
/// in a terminal compares equal to one the file system spelled apart. Other text is left alone.
pub fn compose_hangul(text: &str) -> String {
    const S_BASE: u32 = 0xAC00;
    const L_BASE: u32 = 0x1100;
    const V_BASE: u32 = 0x1161;
    const T_BASE: u32 = 0x11A7;
    const V_COUNT: u32 = 21;
    const T_COUNT: u32 = 28;
    let mut out = String::with_capacity(text.len());
    let mut last: Option<u32> = None;
    for ch in text.chars() {
        let c = ch as u32;
        if let Some(prev) = last {
            if (L_BASE..L_BASE + 19).contains(&prev) && (V_BASE..V_BASE + V_COUNT).contains(&c) {
                last = Some(S_BASE + ((prev - L_BASE) * V_COUNT + (c - V_BASE)) * T_COUNT);
                continue;
            }
            if (S_BASE..S_BASE + 11172).contains(&prev)
                && (prev - S_BASE).is_multiple_of(T_COUNT)
                && (T_BASE + 1..T_BASE + T_COUNT).contains(&c)
            {
                last = Some(prev + (c - T_BASE));
                continue;
            }
            out.push(char::from_u32(prev).unwrap_or('\u{fffd}'));
        }
        last = Some(c);
    }
    if let Some(prev) = last {
        out.push(char::from_u32(prev).unwrap_or('\u{fffd}'));
    }
    out
}

/// The files a name could mean: the path itself, else those ending in it.
pub fn match_files<'a>(files: &'a [CheckpointFile], name: &str) -> Vec<&'a CheckpointFile> {
    let wanted = compose_hangul(name.strip_prefix("./").unwrap_or(name));
    let exact: Vec<_> = files
        .iter()
        .filter(|f| compose_hangul(&f.path) == wanted)
        .collect();
    if !exact.is_empty() {
        return exact;
    }
    files
        .iter()
        .filter(|f| compose_hangul(&f.path).ends_with(&format!("/{wanted}")))
        .collect()
}

pub fn totals<'a>(files: impl IntoIterator<Item = &'a CheckpointFile>) -> (u64, u64, u64) {
    files.into_iter().fold((0, 0, 0), |(n, a, d), f| {
        (n + 1, a + f.additions, d + f.deletions)
    })
}

/// The tinted backgrounds of added and removed lines (the TypeScript default theme's), folded for
/// the terminal's colour depth; `None` where the terminal paints no background.
#[derive(Clone, Copy)]
struct Tints {
    add_bg: Color,
    add_word: Color,
    remove_bg: Color,
    remove_word: Color,
}

fn tints(theme: &Theme) -> Option<Tints> {
    let hex = |rgb: u32| {
        let (r, g, b) = ((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8);
        match theme.user_bg {
            Color::Rgb(..) => Color::Rgb(r, g, b),
            Color::Indexed(_) => Color::Indexed(crate::theme::indexed(r, g, b)),
            _ => Color::Reset,
        }
    };
    if !theme.fills_user() {
        return None;
    }
    Some(Tints {
        add_bg: hex(0x12331f),
        add_word: hex(0x1f6b3a),
        remove_bg: hex(0x3d1620),
        remove_word: hex(0x8a2c3f),
    })
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Add,
    Remove,
    Context,
}

struct DLine {
    kind: Kind,
    number: Option<u64>,
    text: String,
}

#[derive(Clone)]
struct Part {
    text: String,
    changed: bool,
}

fn merge_parts(tokens: Vec<Part>) -> Vec<Part> {
    let mut merged: Vec<Part> = Vec::new();
    for token in tokens {
        match merged.last_mut() {
            Some(last) if last.changed == token.changed => last.text.push_str(&token.text),
            _ => merged.push(token),
        }
    }
    merged
}

/// Whitespace runs, word runs and single other characters.
fn tokenize(text: &str) -> Vec<String> {
    let class = |c: char| {
        if c.is_whitespace() {
            1
        } else if c.is_alphanumeric() || c == '_' {
            2
        } else {
            0
        }
    };
    let mut out: Vec<String> = Vec::new();
    let mut run_class = 0;
    for ch in text.chars() {
        let k = class(ch);
        match out.last_mut() {
            Some(last) if k != 0 && k == run_class => last.push(ch),
            _ => out.push(ch.to_string()),
        }
        run_class = k;
    }
    out
}

/// Splits a removed and an added line into runs the same on both sides and runs that differ. `None`
/// when the lines share no word at all (the line colour already says it) or are too long to compare.
fn changed_words(before: &str, after: &str) -> Option<(Vec<Part>, Vec<Part>)> {
    if before.chars().count() > WORD_DIFF_CHARACTER_LIMIT
        || after.chars().count() > WORD_DIFF_CHARACTER_LIMIT
    {
        return None;
    }
    let left = tokenize(before);
    let right = tokenize(after);
    if left.len() > WORD_DIFF_TOKEN_LIMIT || right.len() > WORD_DIFF_TOKEN_LIMIT {
        return None;
    }
    let columns = right.len() + 1;
    let mut table = vec![0u16; (left.len() + 1) * columns];
    for row in (0..left.len()).rev() {
        for column in (0..right.len()).rev() {
            table[row * columns + column] = if left[row] == right[column] {
                table[(row + 1) * columns + column + 1] + 1
            } else {
                table[(row + 1) * columns + column].max(table[row * columns + column + 1])
            };
        }
    }
    let mut left_parts: Vec<Part> = left
        .iter()
        .map(|t| Part {
            text: t.clone(),
            changed: true,
        })
        .collect();
    let mut right_parts: Vec<Part> = right
        .iter()
        .map(|t| Part {
            text: t.clone(),
            changed: true,
        })
        .collect();
    let (mut row, mut column) = (0, 0);
    let mut shares_word = false;
    while row < left.len() && column < right.len() {
        if left[row] == right[column] {
            left_parts[row].changed = false;
            right_parts[column].changed = false;
            if !left[row].trim().is_empty() {
                shares_word = true;
            }
            row += 1;
            column += 1;
        } else if table[(row + 1) * columns + column] >= table[row * columns + column + 1] {
            row += 1;
        } else {
            column += 1;
        }
    }
    shares_word.then(|| (merge_parts(left_parts), merge_parts(right_parts)))
}

/// Cuts pieces at exactly `limit` columns: code and diff lines keep their columns, so there is no
/// break-at-space heuristic. Each row is its pieces and their width.
fn wrap_parts(parts: &[Part], limit: usize) -> Vec<(Vec<Part>, usize)> {
    let limit = limit.max(1);
    let mut rows: Vec<(Vec<Part>, usize)> = Vec::new();
    let mut row: Vec<Part> = Vec::new();
    let mut used = 0;
    for part in parts {
        let mut text = String::new();
        for ch in part.text.chars() {
            let columns = char_width(ch);
            if used + columns > limit && used > 0 {
                if !text.is_empty() {
                    row.push(Part {
                        text: std::mem::take(&mut text),
                        changed: part.changed,
                    });
                }
                rows.push((std::mem::take(&mut row), used));
                used = 0;
            }
            text.push(ch);
            used += columns;
        }
        if !text.is_empty() {
            row.push(Part {
                text,
                changed: part.changed,
            });
        }
    }
    rows.push((row, used));
    rows
}

/// Draws a unified diff one source line at a time. A run of removed lines followed by added ones is
/// held back until it ends, because a single removed and added pair has its changed words marked.
struct Stream<'a> {
    theme: &'a Theme,
    tints: Option<Tints>,
    width: usize,
    max_lines: usize,
    removes: Vec<DLine>,
    adds: Vec<DLine>,
    old_number: u64,
    new_number: u64,
    old_left: u64,
    new_left: u64,
    number_width: usize,
    shown: usize,
    hidden: usize,
}

/// `@@ -a[,b] +c[,d] @@` as (a, b, c, d).
fn parse_hunk(line: &str) -> Option<(u64, Option<u64>, u64, Option<u64>)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let pair = |text: &str| -> Option<(u64, Option<u64>)> {
        match text.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, Some(b.parse().ok()?))),
            None => Some((text.parse().ok()?, None)),
        }
    };
    let (a, b) = pair(old)?;
    let (c, d) = pair(new)?;
    Some((a, b, c, d))
}

fn tail(line: &str) -> String {
    line.chars().skip(1).collect()
}

fn is_noise_header(line: &str) -> bool {
    line.strip_prefix("index ").is_some_and(|rest| {
        let hash: String = rest.chars().take_while(char::is_ascii_hexdigit).collect();
        !hash.is_empty() && rest[hash.len()..].starts_with("..")
    })
}

impl<'a> Stream<'a> {
    fn new(theme: &'a Theme, width: usize, max_lines: usize) -> Self {
        Stream {
            theme,
            tints: tints(theme),
            width,
            max_lines,
            removes: Vec::new(),
            adds: Vec::new(),
            old_number: 0,
            new_number: 0,
            old_left: 0,
            new_left: 0,
            number_width: 0,
            shown: 0,
            hidden: 0,
        }
    }

    fn push(&mut self, raw: &str) -> Vec<Line<'static>> {
        sanitize(raw)
            .split('\n')
            .flat_map(|line| self.push_line(line))
            .collect()
    }

    /// Ends the diff: a pending change is drawn, and lines past the limit are counted.
    fn finish(&mut self) -> Vec<Line<'static>> {
        let mut out = self.flush_change();
        if self.hidden > 0 {
            out.push(Line::from(Span::styled(
                fill(
                    s("... {count} more lines", "... {count}줄 더"),
                    &[("count", self.hidden.to_string())],
                ),
                self.theme.dim_style(),
            )));
            self.hidden = 0;
        }
        out
    }

    /// Whether another line fits under the limit; a line that does not is only counted.
    fn admit(&mut self) -> bool {
        if self.shown >= self.max_lines {
            self.hidden += 1;
            return false;
        }
        self.shown += 1;
        true
    }

    fn push_line(&mut self, line: &str) -> Vec<Line<'static>> {
        let in_hunk = self.old_left > 0 || self.new_left > 0;
        if line.starts_with('\\') {
            let mut out = self.flush_change();
            if self.admit() {
                out.push(self.clipped(line, self.theme.dim_style()));
            }
            return out;
        }
        if in_hunk && !line.starts_with("@@") {
            if line.starts_with('+') {
                self.new_left = self.new_left.saturating_sub(1);
                let n = self.new_number;
                self.new_number += 1;
                return self.add_line(tail(line), Some(n));
            }
            if line.starts_with('-') {
                self.old_left = self.old_left.saturating_sub(1);
                let n = self.old_number;
                self.old_number += 1;
                return self.remove_line(tail(line), Some(n));
            }
            self.old_left = self.old_left.saturating_sub(1);
            self.new_left = self.new_left.saturating_sub(1);
            self.old_number += 1;
            let n = self.new_number;
            self.new_number += 1;
            return self.context_line(tail(line), Some(n));
        }
        if let Some((old_start, old_len, new_start, new_len)) = parse_hunk(line) {
            let mut out = self.flush_change();
            self.old_number = old_start;
            self.new_number = new_start;
            self.old_left = old_len.unwrap_or(1);
            self.new_left = new_len.unwrap_or(1);
            let last = (old_start + self.old_left).max(new_start + self.new_left);
            self.number_width = self.number_width.max(last.to_string().len());
            if self.admit() {
                out.push(self.header_row(line));
            }
            return out;
        }
        let file_header = line.starts_with("+++ ") || line.starts_with("--- ");
        let bare = !line.starts_with(['+', '-', ' ']) && !line.is_empty();
        if file_header || bare {
            let mut out = self.flush_change();
            if !is_noise_header(line) && self.admit() {
                out.push(self.header_row(line));
            }
            return out;
        }
        // Outside a counted hunk: a model's bare diff, drawn without line numbers.
        if line.starts_with('+') {
            return self.add_line(tail(line), None);
        }
        if line.starts_with('-') {
            return self.remove_line(tail(line), None);
        }
        self.context_line(tail(line), None)
    }

    fn add_line(&mut self, text: String, number: Option<u64>) -> Vec<Line<'static>> {
        if self.admit() {
            self.adds.push(DLine {
                kind: Kind::Add,
                number,
                text,
            });
        }
        Vec::new()
    }

    fn remove_line(&mut self, text: String, number: Option<u64>) -> Vec<Line<'static>> {
        // A removal after additions starts the next change.
        let out = if self.adds.is_empty() {
            Vec::new()
        } else {
            self.flush_change()
        };
        if self.admit() {
            self.removes.push(DLine {
                kind: Kind::Remove,
                number,
                text,
            });
        }
        out
    }

    fn context_line(&mut self, text: String, number: Option<u64>) -> Vec<Line<'static>> {
        let mut out = self.flush_change();
        if self.admit() {
            out.extend(self.line_rows(
                &DLine {
                    kind: Kind::Context,
                    number,
                    text,
                },
                None,
            ));
        }
        out
    }

    fn flush_change(&mut self) -> Vec<Line<'static>> {
        let removes = std::mem::take(&mut self.removes);
        let adds = std::mem::take(&mut self.adds);
        let words = if removes.len() == 1 && adds.len() == 1 && self.tints.is_some() {
            changed_words(&removes[0].text, &adds[0].text)
        } else {
            None
        };
        let mut out = Vec::new();
        for line in &removes {
            out.extend(self.line_rows(line, words.as_ref().map(|w| w.0.as_slice())));
        }
        for line in &adds {
            out.extend(self.line_rows(line, words.as_ref().map(|w| w.1.as_slice())));
        }
        out
    }

    fn clipped(&self, text: &str, style: Style) -> Line<'static> {
        Line::from(Span::styled(truncate(text, self.width), style))
    }

    fn header_row(&self, line: &str) -> Line<'static> {
        self.clipped(line, self.theme.muted_style())
    }

    fn line_rows(&self, line: &DLine, words: Option<&[Part]>) -> Vec<Line<'static>> {
        let gutter = if self.number_width == 0 {
            String::new()
        } else {
            format!(
                "{:>w$} ",
                line.number.map_or(String::new(), |n| n.to_string()),
                w = self.number_width
            )
        };
        let sign = match line.kind {
            Kind::Add => "+",
            Kind::Remove => "-",
            Kind::Context => " ",
        };
        let prefix_width = gutter.len() + 2;
        let content_width = self.width.saturating_sub(prefix_width).max(4);
        let parts = match words {
            Some(words) => words.to_vec(),
            None => vec![Part {
                text: line.text.clone(),
                changed: false,
            }],
        };
        let (line_color, sign_color) = match line.kind {
            Kind::Add => (self.theme.success, self.theme.success),
            _ => (self.theme.error, self.theme.error),
        };
        wrap_parts(&parts, content_width)
            .into_iter()
            .enumerate()
            .map(|(index, (row, row_width))| {
                let head = if index == 0 {
                    gutter.clone()
                } else {
                    " ".repeat(gutter.len())
                };
                let mark = if index == 0 { sign } else { " " };
                let text: String = row.iter().map(|p| p.text.as_str()).collect();
                if line.kind == Kind::Context {
                    return Line::from(vec![
                        Span::styled(head, self.theme.dim_style()),
                        Span::raw(format!("{mark} {text}")),
                    ]);
                }
                let Some(tints) = self.tints else {
                    return Line::from(Span::styled(
                        format!("{head}{mark} {text}"),
                        Style::new().fg(line_color),
                    ));
                };
                let (line_bg, word_bg) = if line.kind == Kind::Add {
                    (tints.add_bg, tints.add_word)
                } else {
                    (tints.remove_bg, tints.remove_word)
                };
                let mut spans = vec![
                    Span::styled(head, Style::new().fg(self.theme.dim).bg(line_bg)),
                    Span::styled(format!("{mark} "), Style::new().fg(sign_color).bg(line_bg)),
                ];
                for piece in row {
                    spans.push(Span::styled(
                        piece.text,
                        Style::new().bg(if piece.changed { word_bg } else { line_bg }),
                    ));
                }
                // The fill stops at the line width, so the row never wraps in the terminal.
                let fill_width = self.width.saturating_sub(prefix_width + row_width);
                spans.push(Span::styled(
                    " ".repeat(fill_width),
                    Style::new().bg(line_bg),
                ));
                Line::from(spans)
            })
            .collect()
    }
}

fn counts_spans(theme: &Theme, additions: u64, deletions: u64) -> Vec<Span<'static>> {
    let mut out = Vec::new();
    if additions > 0 {
        out.push(Span::styled(
            format!("+{additions}"),
            Style::new().fg(theme.success),
        ));
    }
    if deletions > 0 {
        if !out.is_empty() {
            out.push(Span::raw(" "));
        }
        out.push(Span::styled(
            format!("-{deletions}"),
            Style::new().fg(theme.error),
        ));
    }
    out
}

/// What `/diff` writes: a heading with the turn's totals, the files it touched, and the diff under
/// them. The whole turn stops after `OVERVIEW_LINES` diff lines and says how to see a file in
/// full; one file asked for by name gets `FILE_LINES`.
pub fn report(
    theme: &Theme,
    sym: &Symbols,
    width_cols: usize,
    turn: u64,
    files: &[CheckpointFile],
    diff: &str,
    file: Option<&str>,
) -> Vec<Line<'static>> {
    let all = sections(diff);
    let listed: Vec<&CheckpointFile> = match file {
        None => files.iter().collect(),
        Some(name) => match_files(files, name),
    };
    let picked: Option<Vec<&Section>> = file.map(|_| {
        listed
            .iter()
            .flat_map(|f| {
                all.iter()
                    .filter(|section| section_is_file(section, &f.path))
            })
            .collect()
    });
    let shown: Vec<&Section> = picked.unwrap_or_else(|| all.iter().collect());
    let (count, additions, deletions) = totals(listed.iter().copied());
    let rail = |text: Vec<Span<'static>>| {
        let mut spans = vec![Span::styled(format!("{}  ", sym.bar), theme.dim_style())];
        spans.extend(text);
        Line::from(spans)
    };
    let gap = || Line::from(Span::styled(sym.bar.to_string(), theme.dim_style()));

    let mut rows: Vec<Line<'static>> = vec![gap()];
    let heading = match file {
        None => fill(
            s(
                "Turn {turn} changes · files: {count}",
                "턴 {turn} 변경 · 파일 {count}개",
            ),
            &[("turn", turn.to_string()), ("count", count.to_string())],
        ),
        Some(name) => fill(
            s("Turn {turn} · {path}", "턴 {turn} · {path}"),
            &[
                ("turn", turn.to_string()),
                (
                    "path",
                    sanitize(listed.first().map_or(name, |f| f.path.as_str())),
                ),
            ],
        ),
    };
    let mut head = vec![
        Span::styled(format!("{}  ", sym.done), Style::new().fg(theme.success)),
        Span::styled(heading, Style::new().add_modifier(Modifier::BOLD)),
    ];
    if additions + deletions > 0 {
        head.push(Span::raw("  "));
        head.extend(counts_spans(theme, additions, deletions));
    }
    rows.push(Line::from(head));

    if file.is_none() && !files.is_empty() {
        let room = width_cols.saturating_sub(RAIL_COLUMNS).max(8);
        let stat_of = |f: &CheckpointFile| {
            let mut text = String::new();
            if f.additions > 0 {
                text.push_str(&format!("+{}", f.additions));
            }
            if f.deletions > 0 {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(&format!("-{}", f.deletions));
            }
            text
        };
        let stat_width = files
            .iter()
            .take(FILES_LISTED)
            .map(|f| width(&stat_of(f)))
            .max()
            .unwrap_or(0);
        for f in files.iter().take(FILES_LISTED) {
            let path = truncate(
                &sanitize(&f.path),
                room.saturating_sub(stat_width + 2).max(6),
            );
            let pad = room
                .saturating_sub(stat_width + 2)
                .saturating_sub(width(&path));
            let mut spans = vec![Span::raw(path)];
            if stat_width > 0 && !stat_of(f).is_empty() {
                spans.push(Span::raw(" ".repeat(pad + 2)));
                spans.extend(counts_spans(theme, f.additions, f.deletions));
            }
            rows.push(rail(spans));
        }
        if files.len() > FILES_LISTED {
            rows.push(rail(vec![Span::styled(
                fill(
                    s("… and {count} more", "… 외 파일 {count}개"),
                    &[("count", (files.len() - FILES_LISTED).to_string())],
                ),
                theme.dim_style(),
            )]));
        }
    }

    if shown.iter().all(|section| section.lines.is_empty()) {
        let text = if file.is_some() {
            s(
                "This file is not in the diff. The server may have cut a diff that was too large.",
                "diff 에서 이 파일을 찾지 못했습니다. 서버가 너무 큰 diff 를 잘랐을 수 있습니다.",
            )
        } else if !files.is_empty() {
            s(
                "No diff to show (whitespace-only changes or a binary file).",
                "표시할 diff 가 없습니다 (공백 변경만 있거나 이진 파일입니다).",
            )
        } else {
            s(
                "No files changed in this turn.",
                "이 턴에서 바뀐 파일이 없습니다.",
            )
        };
        rows.push(rail(vec![Span::styled(text, theme.dim_style())]));
        return rows;
    }

    rows.push(gap());
    let mut left = if file.is_none() {
        OVERVIEW_LINES
    } else {
        FILE_LINES
    };
    let (mut hidden_lines, mut hidden_files) = (0usize, 0usize);
    for section in shown {
        if left == 0 {
            hidden_files += 1;
            hidden_lines += section.lines.len();
            continue;
        }
        let take = left.min(section.lines.len());
        // The limit is applied here, so the stream never has to say how many lines it left out.
        let mut stream = Stream::new(theme, width_cols, take);
        for line in &section.lines[..take] {
            rows.extend(stream.push(&shortened(line)));
        }
        rows.extend(stream.finish());
        left -= take;
        if take < section.lines.len() {
            hidden_lines += section.lines.len() - take;
            hidden_files += 1;
        }
    }
    if hidden_lines > 0 {
        rows.push(gap());
        let text = if file.is_none() {
            fill(
                s(
                    "{lines} diff lines (files: {files}) omitted. Whole file: /diff {turn} <file>",
                    "diff {lines}줄 (파일 {files}개) 는 생략했습니다. 한 파일 전체: /diff {turn} <파일>",
                ),
                &[
                    ("lines", hidden_lines.to_string()),
                    ("files", hidden_files.to_string()),
                    ("turn", turn.to_string()),
                ],
            )
        } else {
            fill(
                s(
                    "Showing only the first {shown} diff lines; {lines} omitted. See the rest in the desktop app diff view.",
                    "diff 앞 {shown}줄만 보였고 {lines}줄은 생략했습니다. 나머지는 데스크톱 앱의 diff 보기에서 확인하세요.",
                ),
                &[
                    ("shown", FILE_LINES.to_string()),
                    ("lines", hidden_lines.to_string()),
                ],
            )
        };
        rows.push(rail(vec![Span::styled(
            text,
            Style::new().fg(theme.warning),
        )]));
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::panels_common::plain;
    use crate::theme::{LAVENDER, UNICODE};

    const DIFF: &str = "diff --git a/src/a.rs b/src/a.rs\nindex 1234abc..5678def 100644\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,3 +1,3 @@\n fn main() {\n-    let x = 1;\n+    let x = 2;\n }\ndiff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1,2 @@\n one\n+two\n";

    fn files() -> Vec<CheckpointFile> {
        vec![
            CheckpointFile {
                path: "src/a.rs".into(),
                kind: "modified".into(),
                additions: 1,
                deletions: 1,
            },
            CheckpointFile {
                path: "b.txt".into(),
                kind: "modified".into(),
                additions: 1,
                deletions: 0,
            },
        ]
    }

    fn text(lines: &[Line<'static>]) -> Vec<String> {
        plain(lines)
    }

    #[test]
    fn a_turn_report_has_a_heading_the_files_and_numbered_changes() {
        let lines = report(&LAVENDER, &UNICODE, 60, 2, &files(), DIFF, None);
        let rows = text(&lines);
        let all = rows.join("\n");
        assert!(
            all.contains("Turn 2 changes") || all.contains("턴 2 변경"),
            "{all}"
        );
        assert!(all.contains("src/a.rs") && all.contains("b.txt"));
        // the noise header is dropped, the hunk header and numbered lines are kept
        assert!(!all.contains("index 1234abc"));
        assert!(all.contains("@@ -1,3 +1,3 @@"));
        assert!(
            rows.iter()
                .any(|r| r.contains("2 -    let x = 1;") || r.contains("- "))
        );
        assert!(rows.iter().all(|r| width(r) <= 60), "{rows:#?}");
    }

    #[test]
    fn a_named_file_shows_only_that_file() {
        let lines = report(&LAVENDER, &UNICODE, 60, 2, &files(), DIFF, Some("b.txt"));
        let all = text(&lines).join("\n");
        assert!(all.contains("b.txt") && all.contains("+ two"));
        assert!(!all.contains("let x"));
    }

    #[test]
    fn a_missing_file_and_an_empty_diff_are_said() {
        let none = report(&LAVENDER, &UNICODE, 60, 1, &files(), DIFF, Some("zzz"));
        assert!(
            text(&none).join("\n").contains("not in the diff")
                || text(&none).join("\n").contains("찾지 못했습니다")
        );
        let empty = report(&LAVENDER, &UNICODE, 60, 1, &[], "", None);
        assert!(!text(&empty).is_empty());
    }

    #[test]
    fn a_long_diff_stops_at_the_limit_and_says_how_to_see_more() {
        let mut diff =
            String::from("diff --git a/big b/big\n--- a/big\n+++ b/big\n@@ -0,0 +1,400 @@\n");
        for n in 0..400 {
            diff.push_str(&format!("+line {n}\n"));
        }
        let big = vec![CheckpointFile {
            path: "big".into(),
            kind: "added".into(),
            additions: 400,
            deletions: 0,
        }];
        let rows = text(&report(&LAVENDER, &UNICODE, 60, 1, &big, &diff, None));
        assert!(rows.len() < 340, "{}", rows.len());
        let all = rows.join("\n");
        assert!(
            all.contains("/diff 1 <file>") || all.contains("/diff 1 <파일>"),
            "{all}"
        );
    }

    #[test]
    fn changed_words_are_found_only_when_lines_share_a_word() {
        let (a, b) = changed_words("let x = 1;", "let x = 2;").unwrap();
        assert!(a.iter().any(|p| p.changed && p.text == "1"));
        assert!(b.iter().any(|p| p.changed && p.text == "2"));
        assert!(changed_words("alpha", "beta").is_none());
    }

    #[test]
    fn git_quoted_paths_are_unquoted_and_found_by_their_composed_name() {
        assert_eq!(unquote_git_path("\"b/\\355\\225\\234.ts\""), "b/한.ts");
        assert_eq!(
            quoted_header_path("diff --git \"a/\\355\\225\\234.ts\" \"b/\\355\\225\\234.ts\"")
                .as_deref(),
            Some("한.ts")
        );
        // decomposed Hangul (macOS) equals the composed spelling
        let decomposed = "\u{1112}\u{1161}\u{11AB}.ts";
        assert_eq!(compose_hangul(decomposed), "한.ts");
        let files = vec![CheckpointFile {
            path: decomposed.into(),
            ..Default::default()
        }];
        assert_eq!(match_files(&files, "한.ts").len(), 1);
        // by the end of the path, but not by a partial name
        let nested = vec![CheckpointFile {
            path: "src/deep/a.rs".into(),
            ..Default::default()
        }];
        assert_eq!(match_files(&nested, "a.rs").len(), 1);
        assert_eq!(match_files(&nested, "./src/deep/a.rs").len(), 1);
        assert!(match_files(&nested, "p/a.rs").is_empty());
    }
}
