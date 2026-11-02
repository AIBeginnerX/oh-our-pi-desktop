//! Selecting text of the conversation with the mouse, in cells: a row of the conversation is a
//! styled line, a column is a terminal cell, and a Korean syllable takes two of them (a wide glyph
//! is whole if any half of it is in). Positions are in the conversation's own rows, not the screen's,
//! so a selection stays on its text while the conversation scrolls. The text taken is what the rows
//! say, never what frames them: a bubble's border and padding, a bullet, trailing blanks are not in
//! it (`RowMeta`), and wrapped rows of one line are joined back into it.

use crate::text::{Join, char_width};
use crate::transcript::RowMeta;
use ratatui::text::Line;

/// A cell of the conversation: `row` counts from its first line, `col` from its left edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Pos {
    pub row: usize,
    pub col: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    /// Pressed outside the conversation: ignored until the button is up.
    Ignored,
    Pressed,
    Dragging,
}

/// How a press ended.
#[derive(Debug, PartialEq, Eq)]
pub enum End {
    None,
    /// The button came up where it went down: nothing is selected or copied.
    Click,
    Select,
}

/// The life of one press, and the selection it leaves on screen.
#[derive(Debug)]
pub struct Selection {
    phase: Phase,
    anchor: Option<Pos>,
    head: Option<Pos>,
    /// The selection a finished drag leaves highlighted until a key is pressed.
    shown: bool,
}

impl Default for Selection {
    fn default() -> Self {
        Selection {
            phase: Phase::Idle,
            anchor: None,
            head: None,
            shown: false,
        }
    }
}

impl Selection {
    /// `at` is where the button went down, or `None` for a press outside the conversation.
    pub fn press(&mut self, at: Option<Pos>) {
        self.shown = false;
        self.phase = if at.is_some() {
            Phase::Pressed
        } else {
            Phase::Ignored
        };
        self.anchor = at;
        self.head = at;
    }

    /// The pointer moved with the button down; true when the selection changed.
    pub fn drag(&mut self, at: Pos) -> bool {
        if !matches!(self.phase, Phase::Pressed | Phase::Dragging) {
            return false;
        }
        if self.head == Some(at) && self.phase == Phase::Dragging {
            return false;
        }
        if self.phase == Phase::Pressed && self.anchor == Some(at) {
            return false;
        }
        self.phase = Phase::Dragging;
        self.head = Some(at);
        true
    }

    /// The button came up.
    pub fn release(&mut self) -> End {
        let phase = self.phase;
        self.phase = Phase::Idle;
        match phase {
            Phase::Pressed => {
                self.anchor = None;
                self.head = None;
                End::Click
            }
            Phase::Dragging if self.anchor != self.head => {
                self.shown = true;
                End::Select
            }
            Phase::Dragging => {
                self.anchor = None;
                self.head = None;
                End::Click
            }
            _ => End::None,
        }
    }

    pub fn clear(&mut self) {
        *self = Selection::default();
    }

    /// Something is highlighted or a drag is under way.
    pub fn active(&self) -> bool {
        self.shown || self.phase == Phase::Dragging
    }

    /// The selected cells from the first to the last, both included.
    pub fn range(&self) -> Option<(Pos, Pos)> {
        if !self.active() {
            return None;
        }
        let (a, b) = (self.anchor?, self.head?);
        Some(if a <= b { (a, b) } else { (b, a) })
    }
}

/// The glyphs of a line with the cells each takes: `(first column, column after, text)`. A
/// zero-width mark goes with the glyph before it.
fn glyphs(line: &Line) -> Vec<(usize, usize, String)> {
    let mut out: Vec<(usize, usize, String)> = Vec::new();
    let mut col = 0;
    for ch in line.spans.iter().flat_map(|s| s.content.chars()) {
        let w = char_width(ch);
        match out.last_mut() {
            Some(last) if w == 0 => last.2.push(ch),
            _ => {
                out.push((col, col + w, ch.to_string()));
                col += w;
            }
        }
    }
    out
}

/// The plain text of the cells `[from, to)` of a line.
pub fn cells_text(line: &Line, from: usize, to: usize) -> String {
    glyphs(line)
        .into_iter()
        .filter(|(start, end, _)| *start < to && *end > from)
        .map(|(_, _, text)| text)
        .collect()
}

/// The cells `[from, to)` widened to whole glyphs, as far as the line has any; `None` if empty.
pub fn snap(line: &Line, from: usize, to: usize) -> Option<(usize, usize)> {
    let mut hit = glyphs(line)
        .into_iter()
        .filter(|(start, end, _)| *start < to && *end > from && end > start);
    let first = hit.next()?;
    let last = hit.next_back().unwrap_or_else(|| first.clone());
    Some((first.0, last.1))
}

/// The cells of row `row` a selection from `a` to `b` covers (`b` included), cut to what the row's
/// meta lets through; `None` when the row has none.
pub fn row_cells(range: (Pos, Pos), row: usize, meta: &RowMeta) -> Option<(usize, usize)> {
    let (a, b) = range;
    if row < a.row || row > b.row || meta.from == usize::MAX {
        return None;
    }
    let from = if row == a.row { a.col } else { 0 };
    let to = if row == b.row { b.col + 1 } else { usize::MAX };
    let (from, to) = (from.max(meta.from), to.min(meta.to));
    (from < to).then_some((from, to))
}

/// The text of a selection, ready for the clipboard: no styling, no frames, no trailing blanks.
/// Rows of one line are joined into it, with the space the wrap swallowed put back; other rows are
/// lines.
pub fn text(lines: &[Line], meta: &[RowMeta], range: (Pos, Pos)) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut previous: Option<usize> = None;
    for row in range.0.row..=range.1.row.min(lines.len().saturating_sub(1)) {
        let m = meta.get(row).copied().unwrap_or_default();
        let Some((from, to)) = row_cells(range, row, &m) else {
            // A row with nothing to take that is not a frame still breaks a paragraph.
            if m.from != usize::MAX && lines.get(row).is_some_and(|l| l.width() == 0) {
                out.push(String::new());
                previous = None;
            }
            continue;
        };
        let taken = cells_text(&lines[row], from, to).trim_end().to_string();
        match (m.join, previous) {
            (Join::Cont | Join::ContSpace, Some(last)) => {
                if m.join == Join::ContSpace && !taken.is_empty() {
                    out[last].push(' ');
                }
                out[last].push_str(&taken);
            }
            _ => {
                out.push(taken);
                previous = Some(out.len() - 1);
            }
        }
    }
    out.join("\n").trim_end_matches('\n').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::text::Span;

    fn line(text: &str) -> Line<'static> {
        Line::from(Span::raw(text.to_string()))
    }

    fn pos(row: usize, col: usize) -> Pos {
        Pos { row, col }
    }

    #[test]
    fn a_press_becomes_a_click_or_a_selection() {
        let mut s = Selection::default();
        s.press(Some(pos(1, 2)));
        assert_eq!(s.release(), End::Click);
        assert!(s.range().is_none());
        s.press(Some(pos(1, 2)));
        assert!(!s.drag(pos(1, 2)), "no move, no change");
        assert!(s.drag(pos(0, 5)));
        assert_eq!(s.release(), End::Select);
        assert_eq!(s.range(), Some((pos(0, 5), pos(1, 2))));
        s.clear();
        assert!(s.range().is_none());
        s.press(None);
        assert!(!s.drag(pos(0, 0)));
        assert_eq!(s.release(), End::None);
    }

    #[test]
    fn a_wide_glyph_is_whole_if_any_half_is_in() {
        let l = line("가나다 abc");
        assert_eq!(cells_text(&l, 0, 1), "가");
        assert_eq!(cells_text(&l, 1, 3), "가나");
        assert_eq!(cells_text(&l, 7, 9), "ab");
        assert_eq!(snap(&l, 1, 3), Some((0, 4)));
        assert_eq!(snap(&l, 20, 30), None);
    }

    #[test]
    fn a_box_gives_its_text_without_the_border_and_wrapped_rows_rejoin() {
        let lines = vec![
            line("            ╭────────────╮"),
            line("            │ 안녕하세요 │"),
            line("            │ 반갑 습니다│"),
            line("            ╰────────────╯"),
        ];
        let inner = RowMeta {
            from: 14,
            to: 24,
            join: Join::New,
        };
        let meta = vec![
            RowMeta {
                from: usize::MAX,
                to: usize::MAX,
                join: Join::New,
            },
            inner,
            RowMeta {
                join: Join::ContSpace,
                ..inner
            },
            RowMeta {
                from: usize::MAX,
                to: usize::MAX,
                join: Join::New,
            },
        ];
        let all = text(&lines, &meta, (pos(0, 0), pos(3, 40)));
        assert_eq!(all, "안녕하세요 반갑 습니다");
        assert!(!all.contains('│') && !all.contains('╭'));
        // a drag that starts mid-line takes from there
        let part = text(&lines, &meta, (pos(1, 16), pos(1, 40)));
        assert_eq!(part, "녕하세요");
    }

    #[test]
    fn rows_are_lines_and_trailing_blanks_go() {
        let lines = vec![line("one   "), line(""), line("two")];
        let meta = vec![RowMeta::default(); 3];
        assert_eq!(text(&lines, &meta, (pos(0, 0), pos(2, 10))), "one\n\ntwo");
        assert_eq!(text(&lines, &meta, (pos(0, 1), pos(0, 1))), "n");
    }
}
