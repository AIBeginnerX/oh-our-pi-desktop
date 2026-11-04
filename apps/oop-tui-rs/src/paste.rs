//! Long pastes. A paste over `MAX_LINES` lines or `MAX_CHARS` characters is not shown in the
//! composer: it becomes a one-line chip (see `input.rs`) and is sent whole. The same size test
//! folds a long user message in the transcript to its first line and a count, so a pasted log does
//! not push the conversation off the screen. Only the view is folded: the text that is sent and
//! stored is the full one.

use crate::panels_common::{fill, s};

pub const MAX_LINES: usize = 10;
pub const MAX_CHARS: usize = 2000;

/// Lines of a text; a final line end does not start one more.
pub fn line_count(text: &str) -> usize {
    text.strip_suffix('\n').unwrap_or(text).split('\n').count()
}

pub fn is_long(text: &str) -> bool {
    line_count(text) > MAX_LINES || text.chars().count() > MAX_CHARS
}

/// 1234567 -> "1,234,567".
fn grouped(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// How much was pasted, in the words both the chip and the transcript use: lines for text of
/// several lines, characters for one long line.
fn amount(text: &str) -> (bool, String) {
    let lines = line_count(text);
    if lines > 1 {
        (true, grouped(lines))
    } else {
        (false, grouped(text.chars().count()))
    }
}

/// The chip: `[Pasted 143 lines]`, or `[Pasted 2,345 chars]` for one long line.
pub fn label(text: &str) -> String {
    let (lines, n) = amount(text);
    let template = if lines {
        s("[Pasted {n} lines]", "[붙여넣음 {n}줄]")
    } else {
        s("[Pasted {n} chars]", "[붙여넣음 {n}자]")
    };
    fill(template, &[("n", n)])
}

/// Most cells of a long first line kept in the folded view of a message.
const FIRST_LINE_CELLS: usize = 160;

/// A long message as the transcript shows it: its first non-blank line, then `… 143 lines pasted`.
/// `None` for a message that is not long.
pub fn fold(text: &str) -> Option<String> {
    if !is_long(text) {
        return None;
    }
    let first = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or_default();
    let first = crate::text::truncate(first.trim_end(), FIRST_LINE_CELLS);
    let (lines, n) = amount(text);
    let template = if lines {
        s("… {n} lines pasted", "… {n}줄 붙여넣음")
    } else {
        s("… {n} chars pasted", "… {n}자 붙여넣음")
    };
    Some(format!("{first}\n{}", fill(template, &[("n", n)])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limits_are_ten_lines_and_two_thousand_characters() {
        let lines = |n: usize| vec!["x"; n].join("\n");
        assert!(!is_long(&lines(10)) && is_long(&lines(11)));
        assert!(!is_long(&"a".repeat(2000)) && is_long(&"a".repeat(2001)));
        assert!(
            !is_long(&format!("{}\n", lines(10))),
            "a last line end is not a line"
        );
        assert!(!is_long(&"가".repeat(2000)), "characters, not bytes");
    }

    #[test]
    fn the_chip_names_lines_for_text_and_characters_for_one_long_line() {
        assert_eq!(label(&vec!["x"; 143].join("\n")), "[Pasted 143 lines]");
        assert_eq!(label(&"a".repeat(2345)), "[Pasted 2,345 chars]");
        assert_eq!(grouped(1_234_567), "1,234,567");
        assert_eq!(grouped(12), "12");
    }

    #[test]
    fn a_long_message_folds_to_its_first_line_and_a_count() {
        let long = format!("Look at this:\n{}", vec!["row"; 142].join("\n"));
        assert_eq!(
            fold(&long).unwrap(),
            "Look at this:\n… 143 lines pasted",
            "all the lines of the message are counted"
        );
        assert_eq!(fold("short\nmessage"), None);
        let one = "a".repeat(3000);
        let folded = fold(&one).unwrap();
        assert!(folded.ends_with("… 3,000 chars pasted"));
        assert!(folded.lines().next().unwrap().chars().count() <= FIRST_LINE_CELLS);
    }
}
