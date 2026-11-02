//! Text helpers: display width, sanitising, truncation and wrapping that understand wide
//! (CJK, emoji) characters, plus the two small things the wire needs (an ISO clock and ids).

use std::time::{SystemTime, UNIX_EPOCH};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

pub fn width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

pub fn char_width(ch: char) -> usize {
    UnicodeWidthChar::width(ch).unwrap_or(0)
}

/// Replaces terminal control characters (an ESC in a model's reply could steer the terminal) with
/// nothing; keeps newlines and turns tabs into spaces.
pub fn sanitize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\n' => out.push('\n'),
            '\t' => out.push_str("    "),
            '\r' => {}
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Cuts to at most `max` cells, ending in an ellipsis when something was cut.
pub fn truncate(text: &str, max: usize) -> String {
    if width(text) <= max {
        return text.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let w = char_width(ch);
        if used + w > max - 1 {
            break;
        }
        out.push(ch);
        used += w;
    }
    out.push('…');
    out
}

/// How a wrapped row relates to the one before it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Join {
    /// A line of its own.
    #[default]
    New,
    /// The same line, cut mid-word (or between Korean syllables): joined with nothing.
    Cont,
    /// The same line, cut at a space the wrap dropped: joined with one space.
    ContSpace,
}

/// Breaks text into lines of at most `max` cells: at spaces when there is one, else mid-word (the
/// only option for Korean/Japanese/Chinese, which have no spaces to break at inside a clause).
pub fn wrap(text: &str, max: usize) -> Vec<String> {
    wrap_flow(text, max)
        .into_iter()
        .map(|(row, _)| row)
        .collect()
}

/// `wrap`, with how each row joins the one before it, so a selection of wrapped text copies as the
/// lines the writer typed.
pub fn wrap_flow(text: &str, max: usize) -> Vec<(String, Join)> {
    let max = max.max(1);
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let chars: Vec<char> = paragraph.chars().collect();
        if chars.is_empty() {
            lines.push((String::new(), Join::New));
            continue;
        }
        let mut start = 0;
        let mut join = Join::New;
        while start < chars.len() {
            let mut used = 0;
            let mut i = start;
            let mut space = None;
            while i < chars.len() {
                let w = char_width(chars[i]);
                if used + w > max && i > start {
                    break;
                }
                if chars[i] == ' ' {
                    space = Some(i);
                }
                used += w;
                i += 1;
            }
            if i >= chars.len() {
                lines.push((chars[start..].iter().collect(), join));
                break;
            }
            if chars[i] == ' ' {
                lines.push((chars[start..i].iter().collect(), join));
                start = i + 1;
                join = Join::ContSpace;
            } else if let Some(s) = space.filter(|s| *s > start) {
                lines.push((chars[start..s].iter().collect(), join));
                start = s + 1;
                join = Join::ContSpace;
            } else {
                lines.push((chars[start..i].iter().collect(), join));
                start = i;
                join = Join::Cont;
            }
        }
    }
    lines
}

/// `2026-11-01T14:46:07.760Z`, the form the server's IsoDateTime fields use.
pub fn iso_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        now.subsec_millis()
    )
}

/// Days since 1970-01-01 to a calendar date (Howard Hinnant's algorithm).
pub(crate) fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// Milliseconds since the epoch of an ISO stamp (`2026-01-01T00:00:00.000Z`, a fraction or an
/// offset-free `Z` optional); `None` for anything else.
pub fn parse_iso_ms(stamp: &str) -> Option<i64> {
    let b = stamp.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = stamp.get(from..from + len)?;
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse().ok())?
    };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b' ') {
        return None;
    }
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (hour, minute, second) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let millis = match stamp.get(19..) {
        Some(rest) if rest.starts_with('.') => {
            let digits: String = rest[1..]
                .chars()
                .take_while(char::is_ascii_digit)
                .take(3)
                .collect();
            format!("{digits:0<3}").parse::<i64>().ok()?
        }
        _ => 0,
    };
    Some(
        ((days_from_civil(year, month, day) * 24 + hour) * 60 + minute) * 60_000
            + second * 1000
            + millis,
    )
}

/// Days since 1970-01-01 of a calendar date (the inverse of `civil_from_days`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_characters_count_two_cells() {
        assert_eq!(width("안녕"), 4);
        assert_eq!(width("ab"), 2);
    }

    #[test]
    fn wrap_never_exceeds_the_width_with_korean() {
        let lines = wrap("안녕하세요 세계 입니다 반갑습니다", 8);
        assert!(lines.iter().all(|l| width(l) <= 8), "{lines:?}");
        assert_eq!(
            lines.concat().replace(' ', ""),
            "안녕하세요세계입니다반갑습니다"
        );
    }

    #[test]
    fn wrap_breaks_at_spaces_and_keeps_blank_lines() {
        assert_eq!(wrap("hello world foo", 11), vec!["hello world", "foo"]);
        assert_eq!(wrap("a\n\nb", 5), vec!["a", "", "b"]);
    }

    #[test]
    fn wrap_splits_a_word_longer_than_the_line() {
        assert_eq!(wrap("abcdefgh", 3), vec!["abc", "def", "gh"]);
    }

    #[test]
    fn truncate_keeps_to_the_cell_budget() {
        let cut = truncate("안녕하세요", 7);
        assert!(width(&cut) <= 7 && cut.ends_with('…'), "{cut}");
        assert_eq!(truncate("abc", 3), "abc");
    }

    #[test]
    fn sanitize_drops_escape_sequences_bytes() {
        assert_eq!(sanitize("a\u{1b}[31mb\tc\r\n"), "a[31mb    c\n");
    }

    #[test]
    fn iso_clock_has_the_server_shape() {
        let now = iso_now();
        assert_eq!(now.len(), 24, "{now}");
        assert!(now.ends_with('Z') && now.as_bytes()[10] == b'T');
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_089), (2025, 1, 1));
    }

    #[test]
    fn iso_stamps_parse_back_to_milliseconds() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_iso_ms("2025-01-01T00:00:01.5Z"),
            Some(20_089 * 86_400_000 + 1500)
        );
        assert_eq!(parse_iso_ms("nope"), None);
        let now = iso_now();
        let ms = parse_iso_ms(&now).unwrap();
        assert!(
            (ms - SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64)
                .abs()
                < 5000
        );
    }
}
