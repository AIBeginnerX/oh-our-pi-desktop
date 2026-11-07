//! Markdown to styled terminal lines, for the assistant's replies and plans. Line oriented, as chat
//! text is: every source line is its own paragraph (a model's single newline is meant), blocks are
//! fenced code, headings, rules, quotes, lists and tables, and inline text has `code`, **bold**,
//! *italic*, ~~strike~~ and [links](url). A fence still open at the end of the text (a reply that is
//! mid-stream) renders as a code block so far. Wide characters are measured by cell and wrapped
//! mid-word where there are no spaces to break at.

use crate::chart;
use crate::text::{char_width, sanitize, width};
use crate::theme::{Symbols, Theme};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

type Styled = Vec<(char, Style)>;

pub fn render(text: &str, w: usize, th: &Theme, sym: &Symbols) -> Vec<Line<'static>> {
    render_streaming(text, w, th, sym, false)
}

/// `render`, for a reply that may still be written: while `streaming`, a ```chart or ```mermaid
/// fence that has not closed is one placeholder row (its half-written JSON is not drawn and does not
/// flicker), and it becomes the figure when the closing fence arrives. A closed one that cannot be
/// drawn (invalid JSON, unknown type) stays the plain code block.
pub fn render_streaming(
    text: &str,
    w: usize,
    th: &Theme,
    sym: &Symbols,
    streaming: bool,
) -> Vec<Line<'static>> {
    render_marked(text, w, th, sym, streaming, None)
}

/// Where a reply's fenced blocks sit among those of the answer `/copy` reads: this text's first
/// block is number `first` (from 1) of `total`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mark {
    pub first: usize,
    pub total: usize,
}

/// `render_streaming`, with each code block's header carrying what `/copy` calls it: `[n]` when the
/// answer has several blocks, a `/copy` hint when it has one.
pub fn render_marked(
    text: &str,
    w: usize,
    th: &Theme,
    sym: &Symbols,
    streaming: bool,
    mark: Option<Mark>,
) -> Vec<Line<'static>> {
    let w = w.max(8);
    let mut number = mark.map_or(0, |m| m.first.saturating_sub(1));
    let ascii = sym.rule == "-";
    let text = sanitize(text);
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();
        if let Some(fence) = fence_of(trimmed) {
            let indent = line.len() - trimmed.len();
            let lang = trimmed[fence.len()..].trim().to_string();
            let mut code: Vec<&str> = Vec::new();
            i += 1;
            while i < lines.len() && !closes_fence(lines[i].trim_start(), fence) {
                code.push(strip_indent(lines[i], indent));
                i += 1;
            }
            let closed = i < lines.len();
            i += 1; // the closing fence (or past the end for an open one)
            number += 1;
            let word = lang.split_whitespace().next().unwrap_or("");
            if chart::is_visual(word) {
                if !closed && streaming {
                    out.extend(chart::placeholder(word, th, sym));
                    continue;
                }
                if let Some(figure) = chart::block(word, &code.join("\n"), w, th, sym) {
                    out.extend(figure);
                    continue;
                }
            }
            let tag = mark.map(|m| {
                if m.total > 1 {
                    format!("[{number}]")
                } else {
                    "/copy".to_string()
                }
            });
            out.extend(code_block(&lang, tag.as_deref(), &code, w, th));
            continue;
        }
        if is_table_row(trimmed) && i + 1 < lines.len() && is_table_rule(lines[i + 1].trim()) {
            let rule = lines[i + 1].trim();
            let mut rows: Vec<&str> = vec![trimmed];
            i += 2;
            while i < lines.len() && is_table_row(lines[i].trim_start()) {
                rows.push(lines[i].trim_start());
                i += 1;
            }
            out.extend(table(&rows, rule, w, th, ascii));
            continue;
        }
        out.extend(block_line(line, w, th, ascii));
        i += 1;
    }
    out
}

/// The text of every fenced block, exactly as written: no fence lines, no indent the fence itself
/// had, no wrapping. An unclosed fence (a reply mid-stream) gives what it has so far. The count and
/// order are those `render_marked` numbers.
pub fn code_blocks(text: &str) -> Vec<String> {
    scan(text).0
}

/// The `code` spans outside fenced blocks, as written between their backticks.
pub fn inline_code(text: &str) -> Vec<String> {
    let mut spans = Vec::new();
    for line in scan(text).1 {
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] != '`' {
                i += 1;
                continue;
            }
            let ticks = chars[i..].iter().take_while(|x| **x == '`').count();
            match find_run(&chars, i + ticks, '`', ticks) {
                Some(end) => {
                    let body: String = chars[i + ticks..end].iter().collect();
                    if !body.trim().is_empty() {
                        spans.push(body.trim().to_string());
                    }
                    i = end + ticks;
                }
                None => i += ticks,
            }
        }
    }
    spans
}

/// The fenced blocks, and the lines that are not in one.
fn scan(text: &str) -> (Vec<String>, Vec<&str>) {
    let lines: Vec<&str> = text.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    let (mut blocks, mut rest) = (Vec::new(), Vec::new());
    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim_start();
        if let Some(fence) = fence_of(trimmed) {
            let indent = lines[i].len() - trimmed.len();
            let mut code: Vec<&str> = Vec::new();
            i += 1;
            while i < lines.len() && !closes_fence(lines[i].trim_start(), fence) {
                code.push(strip_indent(lines[i], indent));
                i += 1;
            }
            i += 1;
            blocks.push(code.join("\n"));
        } else {
            rest.push(lines[i]);
            i += 1;
        }
    }
    (blocks, rest)
}

fn fence_of(trimmed: &str) -> Option<&'static str> {
    if trimmed.starts_with("```") {
        Some("```")
    } else if trimmed.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}

fn closes_fence(trimmed: &str, fence: &str) -> bool {
    trimmed.starts_with(fence)
        && trimmed
            .trim_start_matches(fence.chars().next().unwrap())
            .trim()
            .is_empty()
}

fn strip_indent(line: &str, indent: usize) -> &str {
    let spaces = line.len() - line.trim_start_matches(' ').len();
    &line[spaces.min(indent)..]
}

fn is_table_row(trimmed: &str) -> bool {
    trimmed.starts_with('|') && trimmed.matches('|').count() >= 2
}

fn is_table_rule(trimmed: &str) -> bool {
    is_table_row(trimmed)
        && trimmed.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
        && trimmed.contains('-')
}

// --- blocks ---------------------------------------------------------------------------------

fn block_line(line: &str, w: usize, th: &Theme, ascii: bool) -> Vec<Line<'static>> {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    let base = Style::new();
    if trimmed.is_empty() {
        return vec![Line::default()];
    }
    if is_rule(trimmed) {
        return vec![Line::from(Span::styled(
            (if ascii { "-" } else { "─" }).repeat(w.min(60)),
            th.dim_style(),
        ))];
    }
    if let Some((level, rest)) = heading(trimmed) {
        let style = Style::new()
            .fg(th.brand)
            .add_modifier(Modifier::BOLD)
            .add_modifier(if level == 1 {
                Modifier::UNDERLINED
            } else {
                Modifier::empty()
            });
        return wrap_prefixed(&inline(rest, style, th), w, vec![], vec![]);
    }
    if let Some(rest) = trimmed.strip_prefix('>') {
        let bar = vec![Span::styled(
            if ascii { "| " } else { "▎ " },
            Style::new().fg(th.brand_dim),
        )];
        let content = inline(
            rest.trim_start(),
            Style::new().fg(th.muted).add_modifier(Modifier::ITALIC),
            th,
        );
        return wrap_prefixed(&content, w, bar.clone(), bar);
    }
    if let Some((marker, rest)) = list_item(trimmed, ascii) {
        let pad = " ".repeat(indent.min(w / 2));
        let first = vec![
            Span::raw(pad.clone()),
            Span::styled(format!("{marker} "), Style::new().fg(th.brand)),
        ];
        let rest_pad = " ".repeat(pad.len() + width(&marker) + 1);
        return wrap_prefixed(&inline(rest, base, th), w, first, vec![Span::raw(rest_pad)]);
    }
    wrap_prefixed(&inline(line.trim_end(), base, th), w, vec![], vec![])
}

fn is_rule(trimmed: &str) -> bool {
    let chars: Vec<char> = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    chars.len() >= 3 && matches!(chars[0], '-' | '*' | '_') && chars.iter().all(|c| *c == chars[0])
}

fn heading(trimmed: &str) -> Option<(usize, &str)> {
    let level = trimmed.chars().take_while(|c| *c == '#').count();
    let rest = &trimmed[level..];
    ((1..=6).contains(&level) && rest.starts_with(' ')).then(|| (level, rest.trim()))
}

/// `("•" or "*", rest)` for `- x`, `* x`, `+ x`; `("1.", rest)` for `1. x`.
fn list_item(trimmed: &str, ascii: bool) -> Option<(String, &str)> {
    let mut chars = trimmed.chars();
    let first = chars.next()?;
    if matches!(first, '-' | '*' | '+') && trimmed[1..].starts_with(' ') {
        let rest = trimmed[1..].trim_start();
        // A task box keeps its brackets as text.
        return Some((if ascii { "*" } else { "•" }.to_string(), rest));
    }
    let digits = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
    if (1..=9).contains(&digits) {
        let after = &trimmed[digits..];
        if (after.starts_with(". ") || after.starts_with(") ")) && after.len() > 2 {
            return Some((format!("{}.", &trimmed[..digits]), after[2..].trim_start()));
        }
    }
    None
}

fn code_block(
    lang: &str,
    tag: Option<&str>,
    code: &[&str],
    w: usize,
    th: &Theme,
) -> Vec<Line<'static>> {
    let plate = Style::new().bg(th.code_bg);
    let mut out = Vec::new();
    if !lang.is_empty() || tag.is_some() {
        let label = if lang.is_empty() {
            String::new()
        } else {
            format!(" {lang}")
        };
        // The tag sits at the right edge, when there is room for it beside the language.
        let tag = tag
            .filter(|t| width(&label) + width(t) + 2 <= w)
            .map_or(String::new(), |t| format!("{t} "));
        let fill = " ".repeat(w.saturating_sub(width(&label) + width(&tag)));
        out.push(Line::from(Span::styled(
            format!("{label}{fill}{tag}"),
            plate.fg(th.dim).add_modifier(Modifier::ITALIC),
        )));
    }
    let room = w.saturating_sub(2).max(1);
    for source in code {
        let styled = highlight(source, lang, plate, th);
        for row in hard_wrap(&styled, room) {
            let used: usize = row.iter().map(|(c, _)| char_width(*c)).sum();
            let mut spans = vec![Span::styled(" ", plate)];
            spans.extend(group(&row));
            spans.push(Span::styled(" ".repeat(w.saturating_sub(used + 1)), plate));
            out.push(Line::from(spans));
        }
    }
    out
}

/// A light, language-agnostic highlighter: comments, strings, numbers and common keywords.
fn highlight(line: &str, lang: &str, plate: Style, th: &Theme) -> Styled {
    const KEYWORDS: &[&str] = &[
        "fn",
        "let",
        "mut",
        "pub",
        "use",
        "mod",
        "struct",
        "enum",
        "impl",
        "trait",
        "match",
        "if",
        "else",
        "for",
        "while",
        "loop",
        "return",
        "const",
        "static",
        "async",
        "await",
        "move",
        "function",
        "var",
        "class",
        "import",
        "export",
        "from",
        "def",
        "self",
        "this",
        "true",
        "false",
        "null",
        "None",
        "nil",
        "type",
        "interface",
        "new",
        "in",
        "as",
        "try",
        "catch",
        "throw",
        "yield",
        "package",
        "func",
        "go",
        "defer",
        "switch",
        "case",
        "break",
        "continue",
    ];
    let comment_start = if matches!(
        lang,
        "py" | "python" | "sh" | "bash" | "zsh" | "yaml" | "yml" | "toml" | "rb" | "ruby" | ""
    ) {
        ["#", "//"]
    } else {
        ["//", "#"]
    };
    let chars: Vec<char> = line.chars().collect();
    let mut out: Styled = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let rest: String = chars[i..].iter().take(2).collect();
        let c = chars[i];
        if comment_start.iter().any(|m| rest.starts_with(m))
            && !(rest.starts_with('#')
                && matches!(lang, "rust" | "rs" | "js" | "ts" | "c" | "cpp")
                && !line.trim_start().starts_with('#'))
        {
            out.extend(
                chars[i..]
                    .iter()
                    .map(|c| (*c, plate.fg(th.dim).add_modifier(Modifier::ITALIC))),
            );
            break;
        }
        if c == '"' || c == '\'' || c == '`' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != c {
                j += if chars[j] == '\\' { 2 } else { 1 };
            }
            let end = (j + 1).min(chars.len());
            // A lone apostrophe (a lifetime, a contraction) is not a string.
            if j < chars.len() || c != '\'' {
                out.extend(chars[i..end].iter().map(|ch| (*ch, plate.fg(th.string))));
                i = end;
                continue;
            }
        }
        if c.is_ascii_digit() && (i == 0 || !chars[i - 1].is_alphanumeric()) {
            let mut j = i;
            while j < chars.len()
                && (chars[j].is_ascii_alphanumeric() || chars[j] == '.' || chars[j] == '_')
            {
                j += 1;
            }
            out.extend(chars[i..j].iter().map(|ch| (*ch, plate.fg(th.number))));
            i = j;
            continue;
        }
        if c.is_alphabetic() || c == '_' {
            let mut j = i;
            while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            let word: String = chars[i..j].iter().collect();
            let style = if KEYWORDS.contains(&word.as_str()) {
                plate.fg(th.keyword)
            } else {
                plate.fg(th.user_fg)
            };
            out.extend(chars[i..j].iter().map(|ch| (*ch, style)));
            i = j;
            continue;
        }
        out.push((c, plate.fg(th.user_fg)));
        i += 1;
    }
    out
}

#[derive(Clone, Copy)]
enum Align {
    Left,
    Center,
    Right,
}

fn split_row(row: &str) -> Vec<&str> {
    row.trim()
        .trim_matches('|')
        .split('|')
        .map(str::trim)
        .collect()
}

/// A table as a box: aligned columns (the delimiter row's colons set left, centre or right), rules
/// between the header and the body, cells wrapped inside their column, every width a display width
/// so Korean text lines up. A table too wide even for narrow columns is shown as plain rows.
fn table(rows: &[&str], rule: &str, w: usize, th: &Theme, ascii: bool) -> Vec<Line<'static>> {
    let aligns: Vec<Align> = split_row(rule)
        .iter()
        .map(|c| match (c.starts_with(':'), c.ends_with(':')) {
            (true, true) => Align::Center,
            (false, true) => Align::Right,
            _ => Align::Left,
        })
        .collect();
    let cells: Vec<Vec<Styled>> = rows
        .iter()
        .enumerate()
        .map(|(r, row)| {
            let base = if r == 0 {
                Style::new().add_modifier(Modifier::BOLD)
            } else {
                Style::new()
            };
            split_row(row)
                .into_iter()
                .map(|c| inline(c, base, th))
                .collect()
        })
        .collect();
    let columns = cells.iter().map(Vec::len).max().unwrap_or(0);
    let cell_width = |cell: &Styled| cell.iter().map(|(c, _)| char_width(*c)).sum::<usize>();
    let mut widths = vec![1usize; columns];
    for row in &cells {
        for (c, cell) in row.iter().enumerate() {
            widths[c] = widths[c].max(cell_width(cell));
        }
    }
    // Shrink the widest columns until the box fits; their cells wrap.
    let overhead = 3 * columns + 1;
    while widths.iter().sum::<usize>() + overhead > w && widths.iter().any(|x| *x > 2) {
        let widest = (0..columns).max_by_key(|c| widths[*c]).unwrap_or(0);
        widths[widest] -= 1;
    }
    if widths.iter().sum::<usize>() + overhead > w {
        return rows
            .iter()
            .flat_map(|row| {
                let text = split_row(row).join(" │ ");
                wrap_prefixed(&inline(&text, Style::new(), th), w, vec![], vec![])
            })
            .collect();
    }
    // corners (tl, tr, bl, br), tees (top, left, bottom), cross, right tee.
    let (v, h, corners, tees, cross, right) = if ascii {
        ("|", "-", ["+"; 4], ["+"; 3], "+", "+")
    } else {
        ("│", "─", ["┌", "┐", "└", "┘"], ["┬", "├", "┴"], "┼", "┤")
    };
    let edge = |left: &str, mid: &str, right: &str| {
        let parts: Vec<String> = widths.iter().map(|x| h.repeat(x + 2)).collect();
        Line::from(Span::styled(
            format!("{left}{}{right}", parts.join(mid)),
            th.dim_style(),
        ))
    };
    let side = Span::styled(v, th.dim_style());
    let mut out = vec![edge(corners[0], tees[0], corners[1])];
    for (r, row) in cells.iter().enumerate() {
        let wrapped: Vec<Vec<Styled>> = (0..columns)
            .map(|c| wrap_styled(row.get(c).unwrap_or(&Vec::new()), widths[c]))
            .collect();
        let height = wrapped.iter().map(Vec::len).max().unwrap_or(1);
        for k in 0..height {
            let mut spans = vec![side.clone(), Span::raw(" ")];
            for (c, cell) in wrapped.iter().enumerate() {
                if c > 0 {
                    spans.push(Span::raw(" "));
                    spans.push(side.clone());
                    spans.push(Span::raw(" "));
                }
                let line = cell.get(k).cloned().unwrap_or_default();
                let pad = widths[c].saturating_sub(cell_width(&line));
                let (before, after) = match aligns.get(c).copied().unwrap_or(Align::Left) {
                    Align::Left => (0, pad),
                    Align::Right => (pad, 0),
                    Align::Center => (pad / 2, pad - pad / 2),
                };
                spans.push(Span::raw(" ".repeat(before)));
                spans.extend(group(&line));
                spans.push(Span::raw(" ".repeat(after)));
            }
            spans.push(Span::raw(" "));
            spans.push(side.clone());
            out.push(Line::from(spans));
        }
        if r == 0 && cells.len() > 1 {
            out.push(edge(tees[1], cross, right));
        }
    }
    out.push(edge(corners[2], tees[2], corners[3]));
    out
}

// --- inline ---------------------------------------------------------------------------------

/// Styled characters of one line of source with its inline markup resolved.
fn inline(text: &str, base: Style, th: &Theme) -> Styled {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Styled = Vec::new();
    let mut i = 0;
    let word_before = |i: usize| i > 0 && chars[i - 1].is_alphanumeric();
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() && chars[i + 1].is_ascii_punctuation() {
            out.push((chars[i + 1], base));
            i += 2;
            continue;
        }
        if c == '`' {
            let ticks = chars[i..].iter().take_while(|x| **x == '`').count();
            if let Some(end) = find_run(&chars, i + ticks, '`', ticks) {
                let style = base.fg(th.accent).bg(th.code_bg);
                let body: String = chars[i + ticks..end].iter().collect();
                out.extend(body.trim().chars().map(|ch| (ch, style)));
                i = end + ticks;
                continue;
            }
        }
        if (c == '*' || c == '_')
            && i + 1 < chars.len()
            && chars[i + 1] == c
            && !word_before_if(c, &chars, i)
            && let Some(end) = find_pair(&chars, i + 2, c, 2)
        {
            let inner = inline(
                &chars[i + 2..end].iter().collect::<String>(),
                base.add_modifier(Modifier::BOLD),
                th,
            );
            out.extend(inner);
            i = end + 2;
            continue;
        }
        if c == '~'
            && i + 1 < chars.len()
            && chars[i + 1] == '~'
            && let Some(end) = find_pair(&chars, i + 2, '~', 2)
        {
            let inner = inline(
                &chars[i + 2..end].iter().collect::<String>(),
                base.add_modifier(Modifier::CROSSED_OUT),
                th,
            );
            out.extend(inner);
            i = end + 2;
            continue;
        }
        if (c == '*' || c == '_')
            && i + 1 < chars.len()
            && !chars[i + 1].is_whitespace()
            && !chars[i + 1].eq(&c)
            && !(c == '_' && word_before(i))
            && let Some(end) = find_pair(&chars, i + 1, c, 1)
        {
            let inner = inline(
                &chars[i + 1..end].iter().collect::<String>(),
                base.add_modifier(Modifier::ITALIC),
                th,
            );
            out.extend(inner);
            i = end + 1;
            continue;
        }
        if c == '['
            && let Some((label, url, next)) = link_at(&chars, i)
        {
            let style = base.fg(th.accent).add_modifier(Modifier::UNDERLINED);
            out.extend(label.chars().map(|ch| (ch, style)));
            if !url.is_empty() && url != label {
                out.extend(format!(" ({url})").chars().map(|ch| (ch, th.dim_style())));
            }
            i = next;
            continue;
        }
        out.push((c, base));
        i += 1;
    }
    out
}

fn word_before_if(c: char, chars: &[char], i: usize) -> bool {
    c == '_' && i > 0 && chars[i - 1].is_alphanumeric()
}

/// Index of a run of exactly `len` of `ch` at or after `from`.
fn find_run(chars: &[char], from: usize, ch: char, len: usize) -> Option<usize> {
    let mut i = from;
    while i < chars.len() {
        if chars[i] == ch {
            let run = chars[i..].iter().take_while(|x| **x == ch).count();
            if run == len {
                return Some(i);
            }
            i += run;
        } else {
            i += 1;
        }
    }
    None
}

/// The closing marker of `len` of `ch` after non-empty content, not preceded by a space.
fn find_pair(chars: &[char], from: usize, ch: char, len: usize) -> Option<usize> {
    let mut i = from;
    while i + len <= chars.len() {
        // A backslash escapes the next character, so `\*` never closes anything.
        if chars[i] == '\\' {
            i += 2;
            continue;
        }
        if (0..len).all(|k| chars[i + k] == ch)
            && i > from
            && !chars[i - 1].is_whitespace()
            && (len == 2 || chars.get(i + 1) != Some(&ch))
            && !(ch == '_' && chars.get(i + len).is_some_and(|n| n.is_alphanumeric()))
        {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn link_at(chars: &[char], i: usize) -> Option<(String, String, usize)> {
    let close = chars[i..].iter().position(|c| *c == ']')? + i;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let end = chars[close + 2..].iter().position(|c| *c == ')')? + close + 2;
    let label: String = chars[i + 1..close].iter().collect();
    let url: String = chars[close + 2..end].iter().collect();
    (!label.is_empty() && !url.contains(' ')).then_some((label, url, end + 1))
}

// --- wrapping -------------------------------------------------------------------------------

/// Cuts a line at `max` cells with no regard to words (code does not reflow).
fn hard_wrap(styled: &Styled, max: usize) -> Vec<Styled> {
    let mut rows = vec![Vec::new()];
    let mut used = 0;
    for (c, s) in styled {
        let w = char_width(*c);
        if used + w > max && used > 0 {
            rows.push(Vec::new());
            used = 0;
        }
        rows.last_mut().unwrap().push((*c, *s));
        used += w;
    }
    rows
}

/// Greedy word wrap of styled characters: at the last space when the line is full, else mid-word.
fn wrap_styled(chars: &Styled, max: usize) -> Vec<Styled> {
    let max = max.max(1);
    let mut lines: Vec<Styled> = Vec::new();
    let mut start = 0;
    if chars.is_empty() {
        return vec![Vec::new()];
    }
    while start < chars.len() {
        let mut used = 0;
        let mut i = start;
        let mut space = None;
        while i < chars.len() {
            let w = char_width(chars[i].0);
            if used + w > max && i > start {
                break;
            }
            if chars[i].0 == ' ' {
                space = Some(i);
            }
            used += w;
            i += 1;
        }
        if i >= chars.len() {
            lines.push(chars[start..].to_vec());
            break;
        }
        if chars[i].0 == ' ' {
            lines.push(chars[start..i].to_vec());
            start = i + 1;
        } else if let Some(s) = space.filter(|s| *s > start) {
            lines.push(chars[start..s].to_vec());
            start = s + 1;
        } else {
            lines.push(chars[start..i].to_vec());
            start = i;
        }
    }
    lines
}

fn group(chars: &Styled) -> Vec<Span<'static>> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut run = String::new();
    let mut style = Style::new();
    for (c, s) in chars {
        if !run.is_empty() && *s != style {
            spans.push(Span::styled(std::mem::take(&mut run), style));
        }
        style = *s;
        run.push(*c);
    }
    if !run.is_empty() {
        spans.push(Span::styled(run, style));
    }
    spans
}

fn wrap_prefixed(
    content: &Styled,
    w: usize,
    first: Vec<Span<'static>>,
    rest: Vec<Span<'static>>,
) -> Vec<Line<'static>> {
    let prefix_width =
        |spans: &[Span<'static>]| spans.iter().map(|s| width(&s.content)).sum::<usize>();
    let room = w
        .saturating_sub(prefix_width(&first).max(prefix_width(&rest)))
        .max(1);
    wrap_styled(content, room)
        .into_iter()
        .enumerate()
        .map(|(i, row)| {
            let mut spans = if i == 0 { first.clone() } else { rest.clone() };
            spans.extend(group(&row));
            Line::from(spans)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::LAVENDER;

    fn plain(lines: &[Line]) -> Vec<String> {
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

    #[test]
    fn headings_lists_quotes_and_rules() {
        let text =
            "# Title\n\n- one\n- two with `code`\n1. first\n> quoted\n---\nplain **bold** and *it*";
        let out = render(text, 40, &LAVENDER, &crate::theme::UNICODE);
        let rows = plain(&out);
        assert_eq!(rows[0], "Title");
        assert_eq!(rows[2], "• one");
        assert_eq!(rows[3], "• two with code");
        assert_eq!(rows[4], "1. first");
        assert_eq!(rows[5], "▎ quoted");
        assert!(rows[6].starts_with("──"));
        assert_eq!(rows[7], "plain bold and it");
        let bold = out[7].spans.iter().find(|s| s.content == "bold").unwrap();
        assert!(bold.style.add_modifier.contains(Modifier::BOLD));
        let code = out[3].spans.iter().find(|s| s.content == "code").unwrap();
        assert_eq!(code.style.bg, Some(LAVENDER.code_bg));
    }

    #[test]
    fn fenced_code_is_a_full_width_plate_and_an_open_fence_renders_so_far() {
        let done = render(
            "```rust\nfn main() { let x = 1; }\n```\nafter",
            30,
            &LAVENDER,
            &crate::theme::UNICODE,
        );
        let rows = plain(&done);
        assert!(rows[0].contains("rust"));
        assert!(rows[1].contains("fn main()"));
        assert_eq!(rows[2], "after");
        assert!(
            done[..2].iter().all(|l| cells(l) == 30),
            "plate spans the width"
        );
        let keyword = done[1].spans.iter().find(|s| s.content == "fn").unwrap();
        assert_eq!(keyword.style.fg, Some(LAVENDER.keyword));
        let open = render("```\nlet a = 1;", 30, &LAVENDER, &crate::theme::UNICODE);
        assert_eq!(plain(&open).len(), 1);
    }

    fn marked(text: &str, mark: Option<Mark>) -> Vec<String> {
        plain(&render_marked(
            text,
            30,
            &LAVENDER,
            &crate::theme::UNICODE,
            false,
            mark,
        ))
    }

    #[test]
    fn block_numbers_show_only_when_the_answer_has_several_blocks() {
        let text = "```sh\na\n```\n```\nb\n```";
        // the second of three blocks of the answer, then the third
        let rows = marked(text, Some(Mark { first: 2, total: 3 }));
        assert!(
            rows[0].starts_with(" sh") && rows[0].trim_end().ends_with("[2]"),
            "{rows:?}"
        );
        assert!(rows[2].trim_end().ends_with("[3]"), "{rows:?}");
        assert_eq!(rows[2].chars().count(), 30, "a header is a full plate row");
        // one block: a quiet hint, not a number
        let one = marked("```sh\na\n```", Some(Mark { first: 1, total: 1 }));
        assert!(
            one[0].trim_end().ends_with("/copy") && !one[0].contains('['),
            "{one:?}"
        );
        // not the latest answer: the plain block, with no header when it names no language
        assert_eq!(marked("```\na\n```", None).len(), 1);
    }

    #[test]
    fn code_blocks_are_taken_as_written_in_the_order_they_are_numbered() {
        let text =
            "x `a` y\n  ```sh\n  one\n    two\n\n  ```\n~~~\nthree\r\n~~~\n``b`c`` `\n```\nopen";
        assert_eq!(
            code_blocks(text),
            ["one\n  two\n", "three", "open"].map(String::from)
        );
        assert_eq!(inline_code(text), ["a", "b`c"].map(String::from));
    }

    #[test]
    fn wrapping_keeps_styles_and_never_exceeds_the_width_with_korean() {
        let out = render(
            "안녕하세요 **반갑습니다 여러분** 오늘도 좋은 하루 되세요",
            14,
            &LAVENDER,
            &crate::theme::UNICODE,
        );
        assert!(out.iter().all(|l| cells(l) <= 14), "{:?}", plain(&out));
        assert!(out.len() > 2);
        let bold_text: String = out
            .iter()
            .flat_map(|l| l.spans.iter())
            .filter(|s| s.style.add_modifier.contains(Modifier::BOLD))
            .map(|s| s.content.as_ref())
            .collect();
        assert!(bold_text.contains("반갑습니다") && bold_text.contains("여러분"));
    }

    #[test]
    fn tables_are_boxes_with_aligned_columns_and_links_show_their_target() {
        let out = render(
            "| a | bb |\n|---|---|\n| 1 | 22 |\n\nsee [docs](https://x.y/z)",
            40,
            &LAVENDER,
            &crate::theme::UNICODE,
        );
        let rows = plain(&out);
        assert_eq!(rows[0], "┌───┬────┐");
        assert_eq!(rows[1], "│ a │ bb │");
        assert_eq!(rows[2], "├───┼────┤");
        assert_eq!(rows[3], "│ 1 │ 22 │");
        assert_eq!(rows[4], "└───┴────┘");
        assert_eq!(rows[6], "see docs (https://x.y/z)");
    }

    #[test]
    fn table_columns_follow_the_delimiter_row_and_cjk_display_width() {
        let out = render(
            "| 이름 | 값 | 비고 |\n|:--|--:|:-:|\n| 가나다 | 1 | ok |\n| a | 12345 | **굵게** |",
            60,
            &LAVENDER,
            &crate::theme::UNICODE,
        );
        let rows = plain(&out);
        // Every row of the box is the same number of cells wide, Korean included.
        let w = width(&rows[0]);
        assert!(rows.iter().all(|r| width(r) == w), "{rows:?}");
        assert!(
            rows[3].contains("│ 가나다 │") && rows[4].contains("│ a      │"),
            "{rows:?}"
        );
        // Right aligned numbers, centred remark, inline markup resolved (no asterisks).
        assert!(rows[3].contains("│     1 │") && rows[4].contains("│ 12345 │"));
        assert!(!rows.iter().any(|r| r.contains("**")));
        let bold = out[4]
            .spans
            .iter()
            .any(|s| s.content.contains("굵게") && s.style.add_modifier.contains(Modifier::BOLD));
        assert!(bold);
    }

    #[test]
    fn a_wide_table_wraps_its_cells_inside_the_width() {
        let out = render(
            "| key | description |\n|---|---|\n| a | a very long description that has to wrap onto several rows |",
            30,
            &LAVENDER,
            &crate::theme::UNICODE,
        );
        let rows = plain(&out);
        assert!(out.iter().all(|l| cells(l) <= 30), "{rows:?}");
        assert!(rows.len() > 6, "{rows:?}");
        assert!(rows.join(" ").contains("several"));
        // Too narrow even for that: plain rows, nothing lost.
        let tight = plain(&render(
            "| aaa | bbb | ccc |\n|---|---|---|\n| 1 | 2 | 3 |",
            8,
            &LAVENDER,
            &crate::theme::UNICODE,
        ));
        assert!(tight.join("").contains('3'));
    }

    // --- chart and mermaid fences ------------------------------------------------------------

    const CHART: &str = "```chart\n{\"type\":\"bar\",\"labels\":[\"a\",\"b\"],\"series\":[{\"name\":\"x\",\"data\":[3,5]}]}\n```";

    #[test]
    fn a_closed_chart_fence_is_a_figure_not_a_code_plate() {
        let out = render(
            &format!("before\n{CHART}\nafter"),
            60,
            &LAVENDER,
            &crate::theme::UNICODE,
        );
        let rows = plain(&out);
        assert_eq!(rows[0], "before");
        assert_eq!(rows.last().unwrap(), "after");
        assert!(rows.iter().any(|r| r.contains("┼") && r.contains("───")));
        assert!(
            !rows.iter().any(|r| r.contains("chart") || r.contains('{')),
            "{rows:?}"
        );
        assert!(out.iter().all(|l| cells(l) <= 60));
        let flow = render(
            "```mermaid\ngraph TD\nA[Start] --> B[End]\n```",
            60,
            &LAVENDER,
            &crate::theme::UNICODE,
        );
        assert!(plain(&flow).join("\n").contains("Start"));
    }

    #[test]
    fn an_open_chart_fence_while_streaming_is_one_stable_placeholder() {
        let th = &LAVENDER;
        let sym = &crate::theme::UNICODE;
        let mut shown = Vec::new();
        // The reply arrives a few characters at a time; the chart is never half drawn.
        let full = format!("intro\n{CHART}\n");
        for cut in (full.find("```chart").unwrap() + 8..full.len() - 4).step_by(7) {
            let out = render_streaming(&full[..cut], 60, th, sym, true);
            let rows = plain(&out);
            assert_eq!(rows.len(), 2, "{rows:?}");
            assert_eq!(rows[0], "intro");
            assert!(rows[1].starts_with("▎ chart"), "{rows:?}");
            shown.push(rows);
        }
        assert!(
            shown.windows(2).all(|p| p[0] == p[1]),
            "no flicker between chunks"
        );
        let closed = plain(&render_streaming(&full, 60, th, sym, true));
        assert!(closed.len() > 4);
        // A finished message that never closed its fence shows what it has as code, or the figure.
        let unclosed = "```chart\n{\"type\":\"bar\",";
        assert_eq!(
            plain(&render_streaming(unclosed, 60, th, sym, false)).len(),
            2
        );
        assert_eq!(
            plain(&render_streaming(unclosed, 60, th, sym, true)).len(),
            1
        );
    }

    #[test]
    fn invalid_chart_json_falls_back_to_the_code_block() {
        let out = render(
            "```chart\n{not json}\n```\n```mermaid\nsequenceDiagram\nA->>B: hi\n```",
            40,
            &LAVENDER,
            &crate::theme::UNICODE,
        );
        let rows = plain(&out);
        assert!(rows[0].contains("chart") && rows[1].contains("{not json}"));
        assert!(
            rows.iter().any(|r| r.contains("mermaid"))
                && rows.iter().any(|r| r.contains("sequenceDiagram"))
        );
        assert!(
            out[1]
                .spans
                .iter()
                .all(|s| s.style.bg == Some(LAVENDER.code_bg))
        );
    }

    #[test]
    fn unterminated_markers_stay_literal_and_escapes_work() {
        let rows = plain(&render(
            "a * b and 2*3 and snake_case_name \\*not\\*",
            60,
            &LAVENDER,
            &crate::theme::UNICODE,
        ));
        assert_eq!(rows[0], "a * b and 2*3 and snake_case_name *not*");
    }

    #[test]
    fn terminal_escapes_in_a_reply_are_dropped() {
        let rows = plain(&render(
            "x\u{1b}[31my",
            20,
            &LAVENDER,
            &crate::theme::UNICODE,
        ));
        assert_eq!(rows[0], "x[31my");
    }

    #[test]
    fn ascii_mode_draws_no_non_ascii_marks() {
        let out = render(
            "- one\n> quote\n---\n| a | bb |\n|---|---|\n| 1 | 22 |",
            40,
            &LAVENDER,
            &crate::theme::ASCII,
        );
        let rows = plain(&out);
        assert!(rows.iter().all(|r| r.is_ascii()), "{rows:?}");
        assert_eq!(rows[0], "* one");
        assert_eq!(rows[1], "| quote");
        assert!(rows[2].starts_with("---"));
        assert_eq!(rows[3], "+---+----+");
        assert_eq!(rows[4], "| a | bb |");
        assert_eq!(rows[5], "+---+----+");
    }
}
