//! The message being typed: several lines, a cursor, paste, and the history of what was sent.
//! Positions are in characters (the screen width is worked out from the text when drawing, so wide
//! characters place the cursor correctly). Up and down move between the lines of the message; at
//! the first or last line they walk the history instead.

use crate::text::char_width;

pub const HISTORY_MAX: usize = 100;

#[derive(Default, Debug)]
pub struct Input {
    chars: Vec<char>,
    cursor: usize,
    history: Vec<String>,
    /// Where in `history` the text on screen came from; `None` while typing something new.
    recall: Option<usize>,
    /// What was being typed when the history walk began.
    stash: String,
}

impl Input {
    pub fn text(&self) -> String {
        self.chars.iter().collect()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.chars.is_empty()
    }

    #[cfg(test)]
    pub fn cursor(&self) -> usize {
        self.cursor
    }

    #[cfg(test)]
    pub fn history(&self) -> &[String] {
        &self.history
    }

    #[cfg(test)]
    pub fn set(&mut self, text: &str) {
        self.chars = text.chars().collect();
        self.cursor = self.chars.len();
    }

    pub fn insert(&mut self, ch: char) {
        self.recall = None;
        self.chars.insert(self.cursor, ch);
        self.cursor += 1;
    }

    pub fn newline(&mut self) {
        self.insert('\n');
    }

    /// Pasted text goes in whole: line ends become `\n`, tabs become spaces and other control
    /// characters (an escape sequence in a clipboard) are dropped.
    pub fn paste(&mut self, text: &str) {
        let cleaned = crate::text::sanitize(&text.replace("\r\n", "\n").replace('\r', "\n"));
        for ch in cleaned.chars() {
            self.insert(ch);
        }
    }

    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            self.recall = None;
            self.cursor -= 1;
            self.chars.remove(self.cursor);
        }
    }

    pub fn delete(&mut self) {
        if self.cursor < self.chars.len() {
            self.recall = None;
            self.chars.remove(self.cursor);
        }
    }

    pub fn left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn right(&mut self) {
        self.cursor = (self.cursor + 1).min(self.chars.len());
    }

    fn line_start(&self, at: usize) -> usize {
        self.chars[..at]
            .iter()
            .rposition(|c| *c == '\n')
            .map_or(0, |i| i + 1)
    }

    fn line_end(&self, at: usize) -> usize {
        self.chars[at..]
            .iter()
            .position(|c| *c == '\n')
            .map_or(self.chars.len(), |i| at + i)
    }

    pub fn home(&mut self) {
        self.cursor = self.line_start(self.cursor);
    }

    pub fn end(&mut self) {
        self.cursor = self.line_end(self.cursor);
    }

    /// Deletes from the start of the line to the cursor (Ctrl-U).
    pub fn kill_to_start(&mut self) {
        let from = self.line_start(self.cursor);
        self.chars.drain(from..self.cursor);
        self.cursor = from;
        self.recall = None;
    }

    /// Deletes from the cursor to the end of the line (Ctrl-K).
    pub fn kill_to_end(&mut self) {
        let to = self.line_end(self.cursor);
        self.chars.drain(self.cursor..to);
        self.recall = None;
    }

    /// Deletes the word before the cursor (Ctrl-W).
    pub fn kill_word(&mut self) {
        let mut from = self.cursor;
        while from > 0 && self.chars[from - 1].is_whitespace() && self.chars[from - 1] != '\n' {
            from -= 1;
        }
        while from > 0 && !self.chars[from - 1].is_whitespace() {
            from -= 1;
        }
        self.chars.drain(from..self.cursor);
        self.cursor = from;
        self.recall = None;
    }

    /// Moves to the line above, keeping the column; false when this is the first line.
    pub fn up(&mut self) -> bool {
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
    pub fn down(&mut self) -> bool {
        let end = self.line_end(self.cursor);
        if end >= self.chars.len() {
            return false;
        }
        let column = self.cursor - self.line_start(self.cursor);
        let next = end + 1;
        self.cursor = next + column.min(self.line_end(next) - next);
        true
    }

    /// Clears the message and returns it; `remember` puts it in the history.
    pub fn take(&mut self, remember: bool) -> String {
        let text = self.text();
        self.chars.clear();
        self.cursor = 0;
        self.recall = None;
        self.stash.clear();
        if remember && !text.trim().is_empty() && self.history.last() != Some(&text) {
            self.history.push(text.clone());
            if self.history.len() > HISTORY_MAX {
                self.history.remove(0);
            }
        }
        text
    }

    /// An older message from the history (Up on the first line).
    pub fn history_back(&mut self) -> bool {
        let at = match self.recall {
            None if self.history.is_empty() => return false,
            None => {
                self.stash = self.text();
                self.history.len() - 1
            }
            Some(0) => return false,
            Some(i) => i - 1,
        };
        self.recall = Some(at);
        self.chars = self.history[at].chars().collect();
        self.cursor = self.chars.len();
        true
    }

    /// A newer message, or what was being typed before the walk (Down on the last line).
    pub fn history_forward(&mut self) -> bool {
        let Some(at) = self.recall else {
            return false;
        };
        if at + 1 < self.history.len() {
            self.recall = Some(at + 1);
            self.chars = self.history[at + 1].chars().collect();
        } else {
            self.recall = None;
            self.chars = std::mem::take(&mut self.stash).chars().collect();
        }
        self.cursor = self.chars.len();
        true
    }

    /// The message cut into rows of at most `w` cells, and the cursor's `(column, row)` among them.
    /// A row is cut where it is full (the composer shows what is typed; it does not reflow words).
    pub fn layout(&self, w: usize) -> (Vec<String>, (usize, usize)) {
        let w = w.max(2);
        let mut rows: Vec<String> = vec![String::new()];
        let (mut used, mut cursor) = (0usize, (0usize, 0usize));
        for (i, ch) in self.chars.iter().enumerate() {
            if i == self.cursor {
                cursor = (used, rows.len() - 1);
            }
            if *ch == '\n' {
                rows.push(String::new());
                used = 0;
                continue;
            }
            let cells = char_width(*ch);
            if used + cells > w {
                rows.push(String::new());
                used = 0;
                if i == self.cursor {
                    cursor = (0, rows.len() - 1);
                }
            }
            rows.last_mut().unwrap().push(*ch);
            used += cells;
        }
        if self.cursor >= self.chars.len() {
            if used >= w {
                rows.push(String::new());
                used = 0;
            }
            cursor = (used, rows.len() - 1);
        }
        (rows, cursor)
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

    #[test]
    fn lines_edit_and_move_with_the_cursor() {
        let mut input = typed("ab\n안녕x");
        assert_eq!(input.cursor(), 6);
        assert!(input.up());
        assert_eq!(input.cursor(), 2, "column clamps to the shorter line");
        assert!(!input.up());
        assert!(input.down());
        input.home();
        input.delete();
        assert_eq!(input.text(), "ab\n녕x");
        input.end();
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
        input.up();
        input.home();
        input.right();
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
        input.up();
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
}
