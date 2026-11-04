//! The message being typed: several lines, a cursor, a selection, paste, and the history of what was
//! sent. Positions are in atoms: a typed character is one, and so is a long paste, which is kept
//! whole behind a one-line chip (`[Pasted 143 lines]`). The cursor, Backspace, Delete and the
//! selection all work on atoms, so a chip is one unit to every one of them, and `text()` (what is
//! sent) puts the full pasted text back. The screen width is worked out from the atoms when
//! drawing, so wide characters place the cursor correctly. Up and down move between the lines of
//! the message; at the first or last line they walk the history instead.

use crate::paste;
use crate::text::{char_width, width};

pub const HISTORY_MAX: usize = 100;

#[derive(Clone, Debug, PartialEq)]
pub enum Atom {
    Ch(char),
    /// A long paste: `text` is what is sent, `label` what the composer shows.
    Paste {
        text: String,
        label: String,
    },
}

impl Atom {
    fn cells(&self) -> usize {
        match self {
            Atom::Ch(ch) => char_width(*ch),
            Atom::Paste { label, .. } => width(label),
        }
    }

    fn push_full(&self, out: &mut String) {
        match self {
            Atom::Ch(ch) => out.push(*ch),
            Atom::Paste { text, .. } => out.push_str(text),
        }
    }
}

fn full_text(atoms: &[Atom]) -> String {
    let mut out = String::new();
    atoms.iter().for_each(|a| a.push_full(&mut out));
    out
}

fn atoms_of(text: &str) -> Vec<Atom> {
    text.chars().map(Atom::Ch).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Move {
    Left,
    Right,
    Home,
    End,
    Up,
    Down,
}

/// One cell group of a drawn row: an atom, where it starts in the row and how wide it is.
#[derive(Clone, Debug)]
pub struct Cell {
    pub text: String,
    pub col: usize,
    pub width: usize,
    pub chip: bool,
}

/// A row of the composer as drawn. `start` is the index of its first atom; `end` the index after
/// its last (a line end that closes the row is counted, though it shows nothing).
#[derive(Clone, Debug)]
pub struct Row {
    pub start: usize,
    pub end: usize,
    pub cells: Vec<Cell>,
}

impl Row {
    pub fn text(&self) -> String {
        self.cells.iter().map(|c| c.text.as_str()).collect()
    }
}

/// Where a character sits in a word, for a double click.
#[derive(PartialEq)]
enum Class {
    Space,
    Word,
    Other,
}

fn class(ch: char) -> Class {
    if ch.is_whitespace() {
        Class::Space
    } else if ch.is_alphanumeric() || ch == '_' {
        Class::Word
    } else {
        Class::Other
    }
}

#[derive(Default, Debug)]
pub struct Input {
    atoms: Vec<Atom>,
    cursor: usize,
    /// The other end of the selection; the cursor is the end that moves.
    anchor: Option<usize>,
    history: Vec<Vec<Atom>>,
    /// Where in `history` the text on screen came from; `None` while typing something new.
    recall: Option<usize>,
    /// What was being typed when the history walk began.
    stash: Vec<Atom>,
}

/// A message left half-typed: its atoms (chips included), the cursor and the selection.
#[derive(Debug, PartialEq)]
pub struct Saved {
    atoms: Vec<Atom>,
    cursor: usize,
    anchor: Option<usize>,
}

impl Input {
    /// Takes the message out as it stands, to be put back later with `restore`; `None` when there
    /// is nothing typed. The history is not part of it: it belongs to the box, not to a thread.
    pub fn stash_draft(&mut self) -> Option<Saved> {
        let saved = Saved {
            atoms: std::mem::take(&mut self.atoms),
            cursor: self.cursor,
            anchor: self.anchor,
        };
        self.cursor = 0;
        self.anchor = None;
        self.recall = None;
        self.stash.clear();
        (!saved.atoms.is_empty()).then_some(saved)
    }

    /// Puts a stashed message back, cursor and selection as they were.
    pub fn restore(&mut self, saved: Saved) {
        self.cursor = saved.cursor.min(saved.atoms.len());
        self.anchor = saved.anchor.filter(|a| *a <= saved.atoms.len());
        self.atoms = saved.atoms;
        self.recall = None;
        self.stash.clear();
    }

    /// The message as it is sent: every chip stands for its whole text.
    pub fn text(&self) -> String {
        full_text(&self.atoms)
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.atoms.is_empty()
    }

    #[cfg(test)]
    pub fn cursor(&self) -> usize {
        self.cursor
    }

    #[cfg(test)]
    pub fn history(&self) -> Vec<String> {
        self.history.iter().map(|h| full_text(h)).collect()
    }

    /// Replaces the whole message with plain text, the cursor at its end.
    pub fn set(&mut self, text: &str) {
        self.atoms = atoms_of(text);
        self.cursor = self.atoms.len();
        self.anchor = None;
        self.recall = None;
    }

    /// The word typed after a leading `/` while the message is still that one word (no space, no
    /// line end, no chip): what the command list filters by. `None` for anything else.
    pub fn slash_query(&self) -> Option<String> {
        let rest = self.atoms.strip_prefix(&[Atom::Ch('/')])?;
        let mut word = String::new();
        for atom in rest {
            match atom {
                Atom::Ch(ch) if !ch.is_whitespace() => word.push(*ch),
                _ => return None,
            }
        }
        Some(word)
    }

    /// The first thing in the message is a typed `/`, not the start of a pasted text.
    pub fn starts_with_slash(&self) -> bool {
        self.atoms.first() == Some(&Atom::Ch('/'))
    }

    // --- selection --------------------------------------------------------------------------

    /// The selected atoms as `[from, to)`.
    pub fn selection(&self) -> Option<(usize, usize)> {
        let anchor = self.anchor.filter(|a| *a != self.cursor)?;
        Some((anchor.min(self.cursor), anchor.max(self.cursor)))
    }

    #[cfg(test)]
    pub fn has_selection(&self) -> bool {
        self.selection().is_some()
    }

    /// The selected text, chips in full.
    pub fn selected_text(&self) -> Option<String> {
        let (from, to) = self.selection()?;
        Some(full_text(&self.atoms[from..to]))
    }

    pub fn select_all(&mut self) {
        self.anchor = Some(0);
        self.cursor = self.atoms.len();
    }

    /// Removes the selection; false when there was none.
    pub fn delete_selection(&mut self) -> bool {
        let Some((from, to)) = self.selection() else {
            self.anchor = None;
            return false;
        };
        self.atoms.drain(from..to);
        self.cursor = from;
        self.anchor = None;
        self.recall = None;
        true
    }

    // --- editing ----------------------------------------------------------------------------

    fn put(&mut self, atom: Atom) {
        self.recall = None;
        self.atoms.insert(self.cursor, atom);
        self.cursor += 1;
    }

    /// Typing replaces the selection.
    pub fn insert(&mut self, ch: char) {
        self.delete_selection();
        self.put(Atom::Ch(ch));
    }

    pub fn newline(&mut self) {
        self.insert('\n');
    }

    /// Pasted text goes in whole, over the selection: line ends become `\n`, tabs become spaces and
    /// other control characters (an escape sequence in a clipboard) are dropped. A long paste
    /// becomes one chip.
    pub fn paste(&mut self, text: &str) {
        let cleaned = crate::text::sanitize(&text.replace("\r\n", "\n").replace('\r', "\n"));
        if cleaned.is_empty() {
            return;
        }
        self.delete_selection();
        if paste::is_long(&cleaned) {
            let label = paste::label(&cleaned);
            self.put(Atom::Paste {
                text: cleaned,
                label,
            });
        } else {
            cleaned.chars().for_each(|ch| self.put(Atom::Ch(ch)));
        }
    }

    pub fn backspace(&mut self) {
        if self.delete_selection() {
            return;
        }
        if self.cursor > 0 {
            self.recall = None;
            self.cursor -= 1;
            self.atoms.remove(self.cursor);
        }
    }

    pub fn delete(&mut self) {
        if self.delete_selection() {
            return;
        }
        if self.cursor < self.atoms.len() {
            self.recall = None;
            self.atoms.remove(self.cursor);
        }
    }

    // --- moving -----------------------------------------------------------------------------

    fn is_newline(&self, at: usize) -> bool {
        self.atoms.get(at) == Some(&Atom::Ch('\n'))
    }

    fn line_start(&self, at: usize) -> usize {
        self.atoms[..at]
            .iter()
            .rposition(|a| *a == Atom::Ch('\n'))
            .map_or(0, |i| i + 1)
    }

    fn line_end(&self, at: usize) -> usize {
        (at..self.atoms.len())
            .find(|i| self.is_newline(*i))
            .unwrap_or(self.atoms.len())
    }

    /// Moves to the line above, keeping the column; false when this is the first line.
    fn step_up(&mut self) -> bool {
        let start = self.line_start(self.cursor);
        if start == 0 {
            return false;
        }
        let column = self.cursor - start;
        let previous = self.line_start(start - 1);
        self.cursor = previous + column.min(start - 1 - previous);
        true
    }

    /// Moves to the line below, keeping the column; false when this is the last line.
    fn step_down(&mut self) -> bool {
        let end = self.line_end(self.cursor);
        if end >= self.atoms.len() {
            return false;
        }
        let column = self.cursor - self.line_start(self.cursor);
        let next = end + 1;
        self.cursor = next + column.min(self.line_end(next) - next);
        true
    }

    /// Moves the cursor; with `select` the selection grows from where it stood, without it the
    /// selection is dropped (Left and Right then go to its near edge). False when there was no
    /// line to move to: Up on the first line, Down on the last, which the caller turns into a walk
    /// through the history. With `select` they reach the start or the end of the message instead.
    pub fn mv(&mut self, to: Move, select: bool) -> bool {
        if select {
            self.anchor.get_or_insert(self.cursor);
        } else {
            let selected = self.selection();
            self.anchor = None;
            match (to, selected) {
                (Move::Left, Some((from, _))) => {
                    self.cursor = from;
                    return true;
                }
                (Move::Right, Some((_, end))) => {
                    self.cursor = end;
                    return true;
                }
                _ => {}
            }
        }
        match to {
            Move::Left => self.cursor = self.cursor.saturating_sub(1),
            Move::Right => self.cursor = (self.cursor + 1).min(self.atoms.len()),
            Move::Home => self.cursor = self.line_start(self.cursor),
            Move::End => self.cursor = self.line_end(self.cursor),
            Move::Up if !self.step_up() => {
                if !select {
                    return false;
                }
                self.cursor = 0;
            }
            Move::Down if !self.step_down() => {
                if !select {
                    return false;
                }
                self.cursor = self.atoms.len();
            }
            Move::Up | Move::Down => {}
        }
        true
    }

    pub fn left(&mut self) {
        self.mv(Move::Left, false);
    }

    pub fn right(&mut self) {
        self.mv(Move::Right, false);
    }

    pub fn home(&mut self) {
        self.mv(Move::Home, false);
    }

    pub fn end(&mut self) {
        self.mv(Move::End, false);
    }

    /// Deletes from the start of the line to the cursor (Ctrl-U).
    pub fn kill_to_start(&mut self) {
        self.anchor = None;
        let from = self.line_start(self.cursor);
        self.atoms.drain(from..self.cursor);
        self.cursor = from;
        self.recall = None;
    }

    /// Deletes from the cursor to the end of the line (Ctrl-K).
    pub fn kill_to_end(&mut self) {
        self.anchor = None;
        let to = self.line_end(self.cursor);
        self.atoms.drain(self.cursor..to);
        self.recall = None;
    }

    /// Deletes the word before the cursor (Ctrl-W).
    pub fn kill_word(&mut self) {
        if self.delete_selection() {
            return;
        }
        let blank = |a: &Atom| matches!(a, Atom::Ch(c) if c.is_whitespace());
        let mut from = self.cursor;
        while from > 0 && blank(&self.atoms[from - 1]) && !self.is_newline(from - 1) {
            from -= 1;
        }
        while from > 0 && !blank(&self.atoms[from - 1]) {
            from -= 1;
        }
        self.atoms.drain(from..self.cursor);
        self.cursor = from;
        self.recall = None;
    }

    // --- history ----------------------------------------------------------------------------

    /// Clears the message and returns it; `remember` puts it in the history, chips and all.
    pub fn take(&mut self, remember: bool) -> String {
        let atoms = std::mem::take(&mut self.atoms);
        let text = full_text(&atoms);
        self.cursor = 0;
        self.anchor = None;
        self.recall = None;
        self.stash.clear();
        if remember
            && !text.trim().is_empty()
            && self.history.last().map(|h| full_text(h)).as_ref() != Some(&text)
        {
            self.history.push(atoms);
            if self.history.len() > HISTORY_MAX {
                self.history.remove(0);
            }
        }
        text
    }

    fn show(&mut self, atoms: Vec<Atom>) {
        self.atoms = atoms;
        self.cursor = self.atoms.len();
        self.anchor = None;
    }

    /// An older message from the history (Up on the first line).
    pub fn history_back(&mut self) -> bool {
        let at = match self.recall {
            None if self.history.is_empty() => return false,
            None => {
                self.stash = self.atoms.clone();
                self.history.len() - 1
            }
            Some(0) => return false,
            Some(i) => i - 1,
        };
        self.recall = Some(at);
        self.show(self.history[at].clone());
        true
    }

    /// A newer message, or what was being typed before the walk (Down on the last line).
    pub fn history_forward(&mut self) -> bool {
        let Some(at) = self.recall else {
            return false;
        };
        if at + 1 < self.history.len() {
            self.recall = Some(at + 1);
            self.show(self.history[at + 1].clone());
        } else {
            self.recall = None;
            let stash = std::mem::take(&mut self.stash);
            self.show(stash);
        }
        true
    }

    // --- the screen -------------------------------------------------------------------------

    /// The message cut into rows of at most `w` cells, and the cursor's `(column, row)` among them.
    /// A row is cut where it is full (the composer shows what is typed; it does not reflow words);
    /// a chip is not cut, it moves to the next row if it does not fit.
    pub fn rows(&self, w: usize) -> (Vec<Row>, (usize, usize)) {
        let w = w.max(2);
        let new_row = |start| Row {
            start,
            end: start,
            cells: Vec::new(),
        };
        let mut rows = vec![new_row(0)];
        let (mut used, mut cursor) = (0usize, (0usize, 0usize));
        for (i, atom) in self.atoms.iter().enumerate() {
            if i == self.cursor {
                cursor = (used, rows.len() - 1);
            }
            if *atom == Atom::Ch('\n') {
                rows.last_mut().unwrap().end = i + 1;
                rows.push(new_row(i + 1));
                used = 0;
                continue;
            }
            let cells = atom.cells();
            if used > 0 && used + cells > w {
                rows.push(new_row(i));
                used = 0;
                if i == self.cursor {
                    cursor = (0, rows.len() - 1);
                }
            }
            let row = rows.last_mut().unwrap();
            row.cells.push(Cell {
                text: match atom {
                    Atom::Ch(ch) => ch.to_string(),
                    Atom::Paste { label, .. } => label.clone(),
                },
                col: used,
                width: cells,
                chip: matches!(atom, Atom::Paste { .. }),
            });
            row.end = i + 1;
            used += cells;
        }
        if self.cursor >= self.atoms.len() {
            if used >= w {
                rows.push(new_row(self.atoms.len()));
                used = 0;
            }
            cursor = (used, rows.len() - 1);
        }
        (rows, cursor)
    }

    /// The rows as text, for a plain look at what is drawn.
    pub fn layout(&self, w: usize) -> (Vec<String>, (usize, usize)) {
        let (rows, cursor) = self.rows(w);
        (rows.iter().map(Row::text).collect(), cursor)
    }

    /// The atom boundary a pointer at `(col, row)` of the drawn rows is nearest to: a click on
    /// a cell puts the cursor before it, and on the right cell of a wide character after it. Past
    /// the end of a row it is the row's end; past the last row, the end of the message.
    pub fn index_at(&self, w: usize, row: usize, col: usize) -> usize {
        let (rows, _) = self.rows(w);
        let Some(found) = rows.get(row) else {
            return self.atoms.len();
        };
        let pointer = 2 * col + 1;
        for (k, cell) in found.cells.iter().enumerate() {
            if pointer <= 2 * cell.col + cell.width {
                return found.start + k;
            }
        }
        found.start + found.cells.len()
    }

    /// Puts the cursor at `index`, dropping the selection (a click).
    pub fn place(&mut self, index: usize) {
        self.cursor = index.min(self.atoms.len());
        self.anchor = None;
    }

    /// Extends the selection from where the press began to `index` (a drag).
    pub fn extend_to(&mut self, from: usize, index: usize) {
        self.anchor = Some(from.min(self.atoms.len()));
        self.cursor = index.min(self.atoms.len());
    }

    /// Selects the word around `index` (a double click): a run of letters and digits, of other
    /// symbols or of blanks; a chip is selected whole. Nothing in an empty message.
    pub fn select_word_at(&mut self, index: usize) {
        if self.atoms.is_empty() {
            return;
        }
        let at = index.min(self.atoms.len() - 1);
        let (mut from, mut to) = (at, at + 1);
        if let Atom::Ch(first) = self.atoms[at] {
            let same = |atom: &Atom| matches!(atom, Atom::Ch(c) if *c != '\n' && class(*c) == class(first));
            while from > 0 && same(&self.atoms[from - 1]) {
                from -= 1;
            }
            while to < self.atoms.len() && same(&self.atoms[to]) {
                to += 1;
            }
        }
        self.anchor = Some(from);
        self.cursor = to;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn typed(text: &str) -> Input {
        let mut input = Input::default();
        input.paste(text);
        input
    }

    fn long(lines: usize) -> String {
        (1..=lines)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn lines_edit_and_move_with_the_cursor() {
        let mut input = typed("ab\n안녕x");
        assert_eq!(input.cursor(), 6);
        assert!(input.mv(Move::Up, false));
        assert_eq!(input.cursor(), 2, "column clamps to the shorter line");
        assert!(!input.mv(Move::Up, false));
        assert!(input.mv(Move::Down, false));
        input.mv(Move::Home, false);
        input.delete();
        assert_eq!(input.text(), "ab\n녕x");
        input.mv(Move::End, false);
        input.backspace();
        assert_eq!(input.text(), "ab\n녕");
    }

    #[test]
    fn paste_normalises_line_ends_and_drops_escapes() {
        let input = typed("a\r\nb\rc\u{1b}[31m\td");
        assert_eq!(input.text(), "a\nb\nc[31m    d");
    }

    #[test]
    fn kill_commands_work_on_the_current_line() {
        let mut input = typed("one two\nthree four");
        input.kill_word();
        assert_eq!(input.text(), "one two\nthree ");
        input.kill_to_start();
        assert_eq!(input.text(), "one two\n");
        input.mv(Move::Up, false);
        input.mv(Move::Home, false);
        input.mv(Move::Right, false);
        input.kill_to_end();
        assert_eq!(input.text(), "o\n");
    }

    #[test]
    fn history_walks_back_and_returns_to_the_unsent_text() {
        let mut input = Input::default();
        for word in ["first", "second", "second", "third"] {
            input.set(word);
            input.take(true);
        }
        assert_eq!(input.history(), ["first", "second", "third"]);
        input.set("draft");
        assert!(input.history_back());
        assert_eq!(input.text(), "third");
        assert!(input.history_back() && input.history_back());
        assert_eq!(input.text(), "first");
        assert!(!input.history_back());
        assert!(input.history_forward() && input.history_forward() && input.history_forward());
        assert_eq!(input.text(), "draft");
        assert!(!input.history_forward());
    }

    #[test]
    fn history_is_capped() {
        let mut input = Input::default();
        for i in 0..HISTORY_MAX + 5 {
            input.set(&format!("m{i}"));
            input.take(true);
        }
        assert_eq!(input.history().len(), HISTORY_MAX);
        assert_eq!(input.history()[0], "m5");
    }

    #[test]
    fn layout_wraps_by_cells_and_places_the_cursor() {
        let mut input = typed("안녕하세요\nab");
        let (rows, cursor) = input.layout(6);
        assert_eq!(rows, ["안녕하", "세요", "ab"]);
        assert_eq!(cursor, (2, 2));
        input.mv(Move::Up, false);
        let (_, cursor) = input.layout(6);
        assert_eq!(
            cursor,
            (4, 0),
            "up keeps the column in characters: before the third syllable"
        );
        let (rows, cursor) = typed("abcd").layout(4);
        assert_eq!(
            (rows.len(), cursor),
            (2, (0, 1)),
            "a full row leaves the cursor on a new one"
        );
    }

    #[test]
    fn a_long_paste_is_one_chip_that_is_sent_whole() {
        let big = long(143);
        let mut input = typed("see ");
        input.paste(&big);
        input.insert('!');
        let (rows, cursor) = input.layout(40);
        assert_eq!(rows, ["see [Pasted 143 lines]!"]);
        assert_eq!(cursor, (23, 0));
        assert_eq!(
            input.text(),
            format!("see {big}!"),
            "the full text is what is sent"
        );
        assert_eq!(
            input.cursor(),
            6,
            "4 letters + the chip + the `!`: the chip is one unit"
        );
    }

    #[test]
    fn a_chip_is_removed_whole_and_several_may_coexist() {
        let (a, b) = (long(20), "x".repeat(2500));
        let mut input = Input::default();
        input.paste(&a);
        input.insert(' ');
        input.paste(&b);
        assert_eq!(
            input.layout(60).0,
            ["[Pasted 20 lines] [Pasted 2,500 chars]"]
        );
        input.backspace();
        assert_eq!(
            input.text(),
            format!("{a} "),
            "one Backspace takes the whole second chip"
        );
        input.mv(Move::Home, false);
        input.delete();
        assert_eq!(input.text(), " ", "one Delete takes the whole first chip");
        input.mv(Move::Right, false);
        assert_eq!(input.cursor(), 1);
    }

    #[test]
    fn short_pastes_stay_text_and_the_limits_are_lines_and_characters() {
        assert_eq!(typed(&long(10)).layout(80).0.len(), 10);
        assert_eq!(typed(&long(11)).layout(80).0, ["[Pasted 11 lines]"]);
        assert_eq!(typed(&"a".repeat(2000)).layout(3000).0[0].len(), 2000);
        assert_eq!(
            typed(&"a".repeat(2001)).layout(3000).0,
            ["[Pasted 2,001 chars]"]
        );
    }

    #[test]
    fn a_chip_that_does_not_fit_moves_to_the_next_row_and_never_leaves_an_empty_one() {
        let mut input = typed("abc");
        input.paste(&long(12));
        let (rows, cursor) = input.layout(18);
        assert_eq!(rows, ["abc", "[Pasted 12 lines]"]);
        assert_eq!(cursor.1, 1);
        let only = typed(&long(12)).layout(5);
        assert_eq!(
            only.0[0], "[Pasted 12 lines]",
            "a chip wider than the row gets a row of its own"
        );
    }

    #[test]
    fn history_recall_brings_the_chip_back_and_sends_the_same_text() {
        let big = long(30);
        let mut input = typed("x ");
        input.paste(&big);
        let sent = input.take(true);
        assert_eq!(sent, format!("x {big}"));
        assert!(input.history_back());
        assert_eq!(input.layout(60).0, ["x [Pasted 30 lines]"]);
        assert_eq!(
            input.take(false),
            sent,
            "the recalled message is not corrupted"
        );
        input.set("draft");
        input.history_back();
        input.history_forward();
        assert_eq!(input.text(), "draft");
    }

    #[test]
    fn a_stashed_message_comes_back_whole_and_the_history_stays() {
        let mut input = typed("abc");
        input.take(true);
        input.set("draft");
        input.paste(&long(30));
        input.mv(Move::Left, true);
        let (text, cursor, selected) = (input.text(), input.cursor(), input.selected_text());
        let saved = input.stash_draft().expect("something was typed");
        assert!(input.is_empty() && input.stash_draft().is_none());
        assert_eq!(input.history(), ["abc"], "the history belongs to the box");
        input.restore(saved);
        assert_eq!(
            (input.text(), input.cursor(), input.selected_text()),
            (text, cursor, selected)
        );
    }

    #[test]
    fn shift_moves_select_and_plain_moves_collapse() {
        let mut input = typed("hello world");
        input.mv(Move::Left, true);
        input.mv(Move::Left, true);
        assert_eq!(input.selected_text().as_deref(), Some("ld"));
        input.mv(Move::Home, true);
        assert_eq!(
            input.selected_text().as_deref(),
            Some("hello world"),
            "the anchor stays where the selection began"
        );
    }

    #[test]
    fn plain_left_and_right_go_to_the_edge_of_the_selection() {
        let mut input = typed("abcdef");
        input.mv(Move::Left, true);
        input.mv(Move::Left, true);
        input.mv(Move::Left, false);
        assert_eq!((input.cursor(), input.has_selection()), (4, false));
        input.select_all();
        input.mv(Move::Right, false);
        assert_eq!(input.cursor(), 6);
        input.select_all();
        input.mv(Move::Left, false);
        assert_eq!(input.cursor(), 0);
    }

    #[test]
    fn typing_pasting_and_deleting_replace_the_selection() {
        let mut input = typed("hello world");
        input.select_all();
        input.insert('x');
        assert_eq!(input.text(), "x");
        input.set("hello world");
        input.mv(Move::Home, false);
        input.mv(Move::Right, false);
        for _ in 0..4 {
            input.mv(Move::Right, true);
        }
        input.paste("EY");
        assert_eq!(input.text(), "hEY world");
        input.select_all();
        input.backspace();
        assert!(input.is_empty());
        input.set("ab");
        input.select_all();
        input.delete();
        assert!(input.is_empty() && !input.has_selection());
        // a long paste replaces too, and the chip is selected as one unit
        input.set("old");
        input.select_all();
        input.paste(&long(15));
        assert_eq!(input.layout(40).0, ["[Pasted 15 lines]"]);
        input.select_all();
        assert_eq!(input.selected_text().unwrap(), long(15));
    }

    #[test]
    fn up_and_down_with_shift_select_to_the_ends_instead_of_walking_the_history() {
        let mut input = typed("one\ntwo");
        assert!(input.mv(Move::Up, true));
        assert!(
            input.mv(Move::Up, true),
            "on the first line it selects to the start"
        );
        assert_eq!(input.selected_text().as_deref(), Some("one\ntwo"));
        let mut input = typed("one\ntwo");
        assert!(!input.mv(Move::Down, false), "the caller walks the history");
    }

    #[test]
    fn a_double_click_selects_a_word_a_run_of_symbols_or_a_chip() {
        let mut input = typed("foo_bar  --baz 안녕x");
        input.select_word_at(1);
        assert_eq!(input.selected_text().as_deref(), Some("foo_bar"));
        input.select_word_at(8);
        assert_eq!(input.selected_text().as_deref(), Some("  "));
        input.select_word_at(10);
        assert_eq!(input.selected_text().as_deref(), Some("--"));
        input.select_word_at(16);
        assert_eq!(input.selected_text().as_deref(), Some("안녕x"));
        let mut input = typed("a ");
        input.paste(&long(12));
        input.select_word_at(2);
        assert_eq!(input.selected_text().unwrap(), long(12));
    }

    #[test]
    fn a_click_lands_on_the_cell_even_with_wide_characters_and_wrapped_rows() {
        // "안녕하세요" wraps at 6 cells into "안녕하" and "세요"; then "ab" on a line of its own
        let input = typed("안녕하세요\nab");
        // the left cell of a syllable is before it, the right cell is after it
        assert_eq!(input.index_at(6, 0, 0), 0);
        assert_eq!(input.index_at(6, 0, 1), 1);
        assert_eq!(input.index_at(6, 0, 2), 1);
        assert_eq!(input.index_at(6, 0, 3), 2);
        assert_eq!(
            input.index_at(6, 0, 5),
            3,
            "right half of the third syllable"
        );
        assert_eq!(
            input.index_at(6, 1, 0),
            3,
            "second row starts at the fourth character"
        );
        assert_eq!(
            input.index_at(6, 1, 3),
            5,
            "past the end of the row: its end"
        );
        assert_eq!(input.index_at(6, 2, 0), 6);
        assert_eq!(input.index_at(6, 2, 1), 7);
        assert_eq!(input.index_at(6, 9, 0), 8, "below the last row: the end");
        // narrow characters: the cell clicked is the one the cursor goes before
        let ascii = typed("abc");
        assert_eq!(
            (
                ascii.index_at(10, 0, 0),
                ascii.index_at(10, 0, 2),
                ascii.index_at(10, 0, 9)
            ),
            (0, 2, 3)
        );
    }

    #[test]
    fn dragging_and_placing_use_the_press_point_as_the_anchor() {
        let mut input = typed("hello");
        input.place(1);
        input.extend_to(1, 4);
        assert_eq!(input.selected_text().as_deref(), Some("ell"));
        input.extend_to(1, 0);
        assert_eq!(input.selected_text().as_deref(), Some("h"));
        input.place(2);
        assert!(!input.has_selection());
    }

    #[test]
    fn the_command_word_is_found_only_while_the_message_is_that_one_word() {
        let mut input = Input::default();
        assert_eq!(input.slash_query(), None);
        input.set("/mo");
        assert_eq!(input.slash_query().as_deref(), Some("mo"));
        input.set("/");
        assert_eq!(input.slash_query().as_deref(), Some(""));
        input.set("/mode high");
        assert_eq!(input.slash_query(), None);
        input.set("hi /mo");
        assert_eq!(input.slash_query(), None);
        let mut chip = Input::default();
        chip.paste(&long(12));
        assert_eq!(chip.slash_query(), None);
        assert!(!chip.starts_with_slash());
    }
}
