//! ```mermaid flowcharts (`graph TD` / `graph LR`, also `flowchart`) as boxes and arrows.
//!
//! `parse` reads what the desktop app reads (packages/client-runtime/src/visualBlocks.ts: node
//! shapes, `&` groups, edge styles and labels, chains, `%%` comments; subgraphs, styles and clicks
//! are skipped). `render` lays the graph out in ranks, longest path first, draws boxes with the
//! rank's colour and routes every edge with box-drawing lines that merge where they meet. Long
//! edges pass through placeholder items in the ranks they cross, so they never run through a box.
//! Edges that point back (cycles) and self loops are listed under the drawing.
//!
//! A graph that does not fit the width even with narrow boxes is shown as an indented list, so
//! nothing breaks and no node is lost. The row count depends on the graph and the width only, not
//! on the reveal progress.

use crate::chart::{Env, Grid};
use crate::text::{char_width, truncate, width};
use crate::theme::{Symbols, Theme};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use std::collections::{HashMap, HashSet};

const MAX_NODES: usize = 60;
const MAX_EDGES: usize = 120;
const MAX_LINES: usize = 3;
/// Rows beyond which a drawing is a list instead.
const MAX_HEIGHT: usize = 70;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Rect,
    Round,
    Stadium,
    Diamond,
    Circle,
    Hexagon,
    Cylinder,
    Subroutine,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineStyle {
    Solid,
    Dashed,
    Thick,
}

#[derive(Clone, Debug)]
pub struct Node {
    pub label: String,
    pub shape: Shape,
}

#[derive(Clone, Debug)]
pub struct Edge {
    pub from: usize,
    pub to: usize,
    pub label: Option<String>,
    pub style: LineStyle,
    pub arrow: bool,
}

#[derive(Clone, Debug)]
pub struct Flow {
    pub left_right: bool,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

// --- parsing -------------------------------------------------------------------------------------

const SHAPES: [(&str, &str, Shape); 9] = [
    ("([", "])", Shape::Stadium),
    ("[[", "]]", Shape::Subroutine),
    ("[(", ")]", Shape::Cylinder),
    ("((", "))", Shape::Circle),
    ("{{", "}}", Shape::Hexagon),
    ("[", "]", Shape::Rect),
    ("(", ")", Shape::Round),
    ("{", "}", Shape::Diamond),
    (">", "]", Shape::Rect),
];

const IGNORED: [&str; 10] = [
    "subgraph",
    "end",
    "classDef",
    "class",
    "style",
    "linkStyle",
    "click",
    "direction",
    "accTitle",
    "accDescr",
];

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Quotes off, `<br/>` as a line break, runs of space collapsed.
fn clean_label(value: &str) -> String {
    let mut s = value.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s = &s[1..s.len() - 1];
    }
    let mut text = String::new();
    let mut rest = s;
    while let Some(i) = rest.to_ascii_lowercase().find("<br") {
        text.push_str(&rest[..i]);
        let after = &rest[i + 3..];
        match after.find('>') {
            Some(j) if after[..j].trim().is_empty() || after[..j].trim() == "/" => {
                text.push('\n');
                rest = &after[j + 1..];
            }
            _ => {
                text.push_str("<br");
                rest = after;
            }
        }
    }
    text.push_str(rest);
    text.split('\n')
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

struct Parser {
    nodes: Vec<Node>,
    index: HashMap<String, usize>,
    edges: Vec<Edge>,
}

impl Parser {
    fn read_node<'a>(&mut self, cur: &'a str) -> Option<(usize, &'a str)> {
        let cur = cur.trim_start();
        let id_len = cur.find(|c: char| !is_word(c)).unwrap_or(cur.len());
        if id_len == 0 {
            return None;
        }
        let id = &cur[..id_len];
        let mut rest = &cur[id_len..];
        let mut label: Option<String> = None;
        let mut shape = Shape::Rect;
        for (open, close, kind) in SHAPES {
            let Some(body) = rest.strip_prefix(open) else {
                continue;
            };
            let from = match body.strip_prefix('"') {
                Some(quoted) => quoted.find('"').map_or(0, |i| i + 2),
                None => 0,
            };
            let end = body[from..].find(close)? + from;
            label = Some(clean_label(&body[..end]));
            shape = kind;
            rest = &body[end + close.len()..];
            break;
        }
        if let Some(after) = rest.strip_prefix(":::") {
            let n = after
                .find(|c: char| !(is_word(c) || c == '-'))
                .unwrap_or(after.len());
            rest = &after[n..];
        }
        let at = match self.index.get(id) {
            Some(at) => {
                if let Some(label) = label {
                    self.nodes[*at].label = if label.is_empty() {
                        id.to_string()
                    } else {
                        label
                    };
                    self.nodes[*at].shape = shape;
                }
                *at
            }
            None => {
                if self.nodes.len() >= MAX_NODES {
                    return None;
                }
                self.nodes.push(Node {
                    label: label
                        .filter(|l| !l.is_empty())
                        .unwrap_or_else(|| id.to_string()),
                    shape,
                });
                self.index.insert(id.to_string(), self.nodes.len() - 1);
                self.nodes.len() - 1
            }
        };
        Some((at, rest))
    }

    fn read_group<'a>(&mut self, cur: &'a str) -> Option<(Vec<usize>, &'a str)> {
        let (first, mut rest) = self.read_node(cur)?;
        let mut group = vec![first];
        while let Some(after) = rest.trim_start().strip_prefix('&') {
            match self.read_node(after) {
                Some((next, r)) => {
                    group.push(next);
                    rest = r;
                }
                None => {
                    rest = after;
                    break;
                }
            }
        }
        Some((group, rest))
    }
}

/// Text of an operator that starts with a label (`-- text -->`): where the closing run starts.
fn find_closing(text: &str, ch: char) -> Option<(usize, usize, bool)> {
    let bytes: Vec<(usize, char)> = text.char_indices().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].1 == ch {
            let run = bytes[i..].iter().take_while(|(_, c)| *c == ch).count();
            let after = bytes.get(i + run).map(|(_, c)| *c);
            if run >= 2 && after == Some('>') {
                return Some((bytes[i].0, bytes[i + run].0 + 1, true));
            }
            if run >= 3 {
                let end = bytes.get(i + run).map_or(text.len(), |(b, _)| *b);
                return Some((bytes[i].0, end, false));
            }
            i += run;
        } else {
            i += 1;
        }
    }
    None
}

/// One edge operator with its optional `|label|`: `(style, arrow, label, rest)`.
fn read_edge(cur: &str) -> Option<(LineStyle, bool, Option<String>, &str)> {
    let s = cur.trim_start();
    let s = s.strip_prefix('<').unwrap_or(s);
    let first = s.chars().next()?;
    let (style, arrow, rest): (LineStyle, bool, &str);
    match first {
        '~' => {
            let n = s.chars().take_while(|c| *c == '~').count();
            if n < 3 {
                return None;
            }
            (style, arrow, rest) = (LineStyle::Solid, false, &s[n..]);
        }
        '-' | '=' if s[1..].starts_with('.') && first == '-' => {
            // -.-> / -.-
            let dots = s[1..].chars().take_while(|c| *c == '.').count();
            let after = &s[1 + dots..];
            if let Some(a) = after.strip_prefix("->") {
                (style, arrow, rest) = (LineStyle::Dashed, true, a);
            } else if let Some(a) = after.strip_prefix('-') {
                (style, arrow, rest) = (LineStyle::Dashed, false, a);
            } else if s[1 + dots..].is_empty() {
                return None;
            } else if s.chars().nth(2).is_some_and(char::is_whitespace) {
                // -. text .->
                let body = &s[2..];
                let close = body.find(".-")?;
                let run = body[close + 1..].chars().take_while(|c| *c == '-').count();
                let tail = &body[close + 1 + run..];
                let (arrow_end, tail) = tail.strip_prefix('>').map_or((false, tail), |t| (true, t));
                let label = clean_label(&body[..close]);
                return Some((
                    LineStyle::Dashed,
                    arrow_end,
                    (!label.is_empty()).then_some(label),
                    tail,
                ));
            } else {
                return None;
            }
        }
        '-' | '=' => {
            let n = s.chars().take_while(|c| *c == first).count();
            let thick = first == '=';
            let line = if thick {
                LineStyle::Thick
            } else {
                LineStyle::Solid
            };
            let after = &s[n..];
            if n >= 2 && after.starts_with('>') {
                (style, arrow, rest) = (line, true, &after[1..]);
            } else if n >= 3 {
                (style, arrow, rest) = (line, false, after);
            } else if n == 2
                && !thick
                && matches!(after.chars().next(), Some('o' | 'x'))
                && after[1..].chars().next().is_none_or(|c| !is_word(c))
            {
                (style, arrow, rest) = (line, false, &after[1..]);
            } else if n == 2 && after.chars().next().is_some_and(char::is_whitespace) {
                // -- text -->
                let (at, end, arrow_end) = find_closing(after, first)?;
                let label = clean_label(&after[..at]);
                return Some((
                    line,
                    arrow_end,
                    (!label.is_empty()).then_some(label),
                    &after[end..],
                ));
            } else {
                return None;
            }
        }
        _ => return None,
    }
    // An optional |label| right after the operator.
    let tail = rest.trim_start();
    if let Some(body) = tail.strip_prefix('|')
        && let Some(end) = body.find('|')
    {
        let label = clean_label(&body[..end]);
        return Some((
            style,
            arrow,
            (!label.is_empty()).then_some(label),
            &body[end + 1..],
        ));
    }
    Some((style, arrow, None, rest))
}

/// Reads a `graph` / `flowchart`; `None` for other mermaid diagrams and for source with no nodes.
pub fn parse(source: &str) -> Option<Flow> {
    let lines: Vec<String> = source
        .split(['\n', ';'])
        .map(|l| l.split("%%").next().unwrap_or("").trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let head = lines.first()?;
    let lower = head.to_ascii_lowercase();
    let keyword = ["flowchart", "graph"]
        .into_iter()
        .find(|k| lower.starts_with(k) && !head[k.len()..].starts_with(is_word))?;
    let mut rest = head[keyword.len()..].trim_start();
    let mut left_right = false;
    for dir in ["TB", "TD", "BT", "RL", "LR"] {
        if rest.len() >= 2 && rest[..2].eq_ignore_ascii_case(dir) && !rest[2..].starts_with(is_word)
        {
            left_right = matches!(dir, "RL" | "LR");
            rest = rest[2..].trim_start();
            break;
        }
    }
    let mut p = Parser {
        nodes: Vec::new(),
        index: HashMap::new(),
        edges: Vec::new(),
    };
    let statements = std::iter::once(rest.to_string())
        .chain(lines[1..].iter().cloned())
        .filter(|l| !l.is_empty());
    for line in statements {
        let word_end = line.find(|c: char| !is_word(c)).unwrap_or(line.len());
        if IGNORED.contains(&&line[..word_end]) {
            continue;
        }
        let mut cursor: &str = &line;
        let Some((mut prev, after)) = p.read_group(cursor) else {
            continue;
        };
        cursor = after;
        while let Some((style, arrow, label, after)) = read_edge(cursor) {
            let Some((next, after)) = p.read_group(after) else {
                break;
            };
            for from in &prev {
                for to in &next {
                    if p.edges.len() < MAX_EDGES {
                        p.edges.push(Edge {
                            from: *from,
                            to: *to,
                            label: label.clone(),
                            style,
                            arrow,
                        });
                    }
                }
            }
            prev = next;
            cursor = after;
        }
    }
    (!p.nodes.is_empty()).then_some(Flow {
        left_right,
        nodes: p.nodes,
        edges: p.edges,
    })
}

// --- layout --------------------------------------------------------------------------------------

/// Display-width wrap of one label into at most `MAX_LINES` lines of `max` cells.
fn wrap_label(label: &str, max: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for source in label.split('\n') {
        let mut line = String::new();
        let push_word = |line: &mut String, lines: &mut Vec<String>, word: &str| {
            let mut word = word.to_string();
            loop {
                let sep = usize::from(!line.is_empty());
                if width(line) + sep + width(&word) <= max {
                    if sep == 1 {
                        line.push(' ');
                    }
                    line.push_str(&word);
                    return;
                }
                if !line.is_empty() {
                    lines.push(std::mem::take(line));
                    continue;
                }
                // A word longer than the box breaks by characters.
                let mut head = String::new();
                let mut used = 0;
                let mut tail = String::new();
                for c in word.chars() {
                    let cw = char_width(c);
                    if tail.is_empty() && used + cw <= max {
                        head.push(c);
                        used += cw;
                    } else {
                        tail.push(c);
                    }
                }
                if head.is_empty() {
                    head = tail.chars().next().map(String::from).unwrap_or_default();
                    tail = tail.chars().skip(1).collect();
                }
                lines.push(head);
                if tail.is_empty() {
                    return;
                }
                word = tail;
            }
        };
        for word in source.split(' ') {
            push_word(&mut line, &mut lines, word);
        }
        if !line.is_empty() {
            lines.push(line);
        }
    }
    if lines.len() > MAX_LINES {
        lines.truncate(MAX_LINES);
        let last = lines.pop().unwrap_or_default();
        lines.push(truncate(&format!("{last}…"), max));
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

struct Item {
    /// The node, or `None` for a placeholder that a long edge passes through.
    node: Option<usize>,
    rank: usize,
    /// Size across the ranks (`cs`) and along them (`ms`), in cells.
    cs: usize,
    ms: usize,
    /// Position: `c` across, `m` along.
    c: usize,
    m: usize,
    text: Vec<String>,
}

struct Segment {
    edge: usize,
    from: usize,
    to: usize,
}

struct Layout {
    items: Vec<Item>,
    /// Item indices per rank.
    ranks: Vec<Vec<usize>>,
    rank_m: Vec<usize>,
    rank_ms: Vec<usize>,
    gaps: Vec<usize>,
    segments: Vec<Segment>,
    /// Edges drawn nowhere because they point back or to themselves.
    back: Vec<usize>,
    left_right: bool,
    cross: usize,
    main: usize,
}

fn layout(flow: &Flow, max_text: usize, room: usize) -> Option<Layout> {
    let n = flow.nodes.len();
    // Back edges by depth-first search; the rest decide the ranks.
    let mut state = vec![0u8; n];
    let mut back_edge = vec![false; flow.edges.len()];
    let mut order = Vec::new();
    fn visit(u: usize, flow: &Flow, state: &mut [u8], back: &mut [bool], order: &mut Vec<usize>) {
        state[u] = 1;
        for (i, e) in flow.edges.iter().enumerate().filter(|(_, e)| e.from == u) {
            if e.to == u || state[e.to] == 1 {
                back[i] = true;
            } else if state[e.to] == 0 {
                visit(e.to, flow, state, back, order);
            }
        }
        state[u] = 2;
        order.push(u);
    }
    for u in 0..n {
        if state[u] == 0 {
            visit(u, flow, &mut state, &mut back_edge, &mut order);
        }
    }
    let mut rank = vec![0usize; n];
    for u in order.iter().rev() {
        for (i, e) in flow.edges.iter().enumerate().filter(|(_, e)| e.from == *u) {
            if !back_edge[i] {
                rank[e.to] = rank[e.to].max(rank[*u] + 1);
            }
        }
    }
    let rank_count = rank.iter().copied().max().unwrap_or(0) + 1;

    // Items: the nodes, and a placeholder in each rank a long edge crosses.
    let left_right = flow.left_right;
    let mut items: Vec<Item> = Vec::new();
    let mut node_item = vec![0usize; n];
    for (u, node) in flow.nodes.iter().enumerate() {
        let text = wrap_label(&node.label, max_text);
        let inner = text.iter().map(|l| width(l)).max().unwrap_or(0);
        let (w, h) = (inner + 4, text.len() + 2);
        node_item[u] = items.len();
        items.push(Item {
            node: Some(u),
            rank: rank[u],
            cs: if left_right { h } else { w },
            ms: if left_right { w } else { h },
            c: 0,
            m: 0,
            text,
        });
    }
    let mut segments = Vec::new();
    let mut back = Vec::new();
    for (i, e) in flow.edges.iter().enumerate() {
        if back_edge[i] {
            back.push(i);
            continue;
        }
        let mut prev = node_item[e.from];
        for r in rank[e.from] + 1..rank[e.to] {
            let dummy = items.len();
            items.push(Item {
                node: None,
                rank: r,
                cs: 1,
                ms: 1,
                c: 0,
                m: 0,
                text: Vec::new(),
            });
            segments.push(Segment {
                edge: i,
                from: prev,
                to: dummy,
            });
            prev = dummy;
        }
        segments.push(Segment {
            edge: i,
            from: prev,
            to: node_item[e.to],
        });
    }

    // Order within ranks: insertion order, then a few barycentre sweeps.
    let mut ranks: Vec<Vec<usize>> = vec![Vec::new(); rank_count];
    for (i, item) in items.iter().enumerate() {
        ranks[item.rank].push(i);
    }
    let mut position = vec![0.0f64; items.len()];
    let refresh = |ranks: &[Vec<usize>], position: &mut [f64]| {
        for r in ranks {
            for (i, it) in r.iter().enumerate() {
                position[*it] = i as f64;
            }
        }
    };
    refresh(&ranks, &mut position);
    for sweep in 0..4 {
        let down = sweep % 2 == 0;
        let range: Vec<usize> = if down {
            (1..rank_count).collect()
        } else {
            (0..rank_count.saturating_sub(1)).rev().collect()
        };
        for r in range {
            let mut keyed: Vec<(f64, usize)> = ranks[r]
                .iter()
                .map(|it| {
                    let near: Vec<f64> = segments
                        .iter()
                        .filter_map(|s| {
                            if down && s.to == *it {
                                Some(position[s.from])
                            } else if !down && s.from == *it {
                                Some(position[s.to])
                            } else {
                                None
                            }
                        })
                        .collect();
                    let key = if near.is_empty() {
                        position[*it]
                    } else {
                        near.iter().sum::<f64>() / near.len() as f64
                    };
                    (key, *it)
                })
                .collect();
            keyed.sort_by(|a, b| a.0.total_cmp(&b.0));
            ranks[r] = keyed.into_iter().map(|(_, i)| i).collect();
            refresh(&ranks, &mut position);
        }
    }

    // Gaps between ranks: wide enough for an edge label, narrow otherwise.
    let labelled = |r: usize| {
        segments
            .iter()
            .filter(|s| items[s.from].rank == r)
            .filter_map(|s| flow.edges[s.edge].label.as_ref())
            .map(|l| width(l).min(18))
            .max()
    };
    let gaps: Vec<usize> = (0..rank_count.saturating_sub(1))
        .map(|r| match (labelled(r), left_right) {
            (Some(l), true) => l + 5,
            (None, true) => 5,
            (Some(_), false) => 4,
            (None, false) => 3,
        })
        .collect();
    let item_gap = if left_right { 1 } else { 3 };
    let rank_extent: Vec<usize> = ranks
        .iter()
        .map(|r| {
            r.iter().map(|i| items[*i].cs).sum::<usize>() + item_gap * r.len().saturating_sub(1)
        })
        .collect();
    let cross = rank_extent.iter().copied().max().unwrap_or(1);
    let rank_ms: Vec<usize> = ranks
        .iter()
        .map(|r| r.iter().map(|i| items[*i].ms).max().unwrap_or(1))
        .collect();
    let mut rank_m = Vec::new();
    let mut at = 0;
    for (r, size) in rank_ms.iter().enumerate() {
        rank_m.push(at);
        at += size + gaps.get(r).copied().unwrap_or(0);
    }
    let main = at;
    let (width_cells, height_cells) = if left_right {
        (main, cross)
    } else {
        (cross, main)
    };
    if width_cells > room || height_cells > MAX_HEIGHT {
        return None;
    }
    for (r, list) in ranks.iter().enumerate() {
        let mut c = (cross - rank_extent[r]) / 2;
        for i in list {
            items[*i].c = c;
            items[*i].m = rank_m[r];
            c += items[*i].cs + item_gap;
        }
    }
    Some(Layout {
        items,
        ranks,
        rank_m,
        rank_ms,
        gaps,
        segments,
        back,
        left_right,
        cross,
        main,
    })
}

// --- drawing ---------------------------------------------------------------------------------------

const UP: u8 = 1;
const DOWN: u8 = 2;
const LEFT: u8 = 4;
const RIGHT: u8 = 8;

fn junction(mask: u8, style: LineStyle, ascii: bool) -> char {
    if ascii {
        return match mask {
            1..=3 => '|',
            4 | 8 | 12 => '-',
            _ => '+',
        };
    }
    const LIGHT: [char; 16] = [
        ' ', '│', '│', '│', '─', '╯', '╮', '┤', '─', '╰', '╭', '├', '─', '┴', '┬', '┼',
    ];
    const HEAVY: [char; 16] = [
        ' ', '┃', '┃', '┃', '━', '┛', '┓', '┫', '━', '┗', '┏', '┣', '━', '┻', '┳', '╋',
    ];
    let ch = if style == LineStyle::Thick {
        HEAVY[usize::from(mask & 15)]
    } else {
        LIGHT[usize::from(mask & 15)]
    };
    match (style, ch) {
        (LineStyle::Dashed, '│') => '┆',
        (LineStyle::Dashed, '─') => '┄',
        _ => ch,
    }
}

/// A box around `text`; the shape shows in the corners and sides.
fn draw_box(
    grid: &mut Grid,
    (x, y, w): (usize, usize, usize),
    text: &[String],
    shape: Shape,
    edge: Style,
    env: &Env,
) {
    let h = text.len() + 2;
    let (tl, tr, bl, br, side_l, side_r) = if env.ascii {
        let (l, r) = match shape {
            Shape::Diamond | Shape::Hexagon => ('<', '>'),
            Shape::Round | Shape::Stadium | Shape::Circle => ('(', ')'),
            _ => ('|', '|'),
        };
        ('+', '+', '+', '+', l, r)
    } else {
        match shape {
            Shape::Rect => ('┌', '┐', '└', '┘', '│', '│'),
            Shape::Round => ('╭', '╮', '╰', '╯', '│', '│'),
            Shape::Stadium | Shape::Circle => ('╭', '╮', '╰', '╯', '(', ')'),
            Shape::Diamond => ('╱', '╲', '╲', '╱', '<', '>'),
            Shape::Hexagon => ('╱', '╲', '╲', '╱', '│', '│'),
            Shape::Cylinder => ('╭', '╮', '╰', '╯', '║', '║'),
            Shape::Subroutine => ('┌', '┐', '└', '┘', '║', '║'),
        }
    };
    let rule = env.rule();
    grid.put(y, x, tl, edge);
    grid.fill(y, x + 1, x + w - 1, rule, edge);
    grid.put(y, x + w - 1, tr, edge);
    grid.put(y + h - 1, x, bl, edge);
    grid.fill(y + h - 1, x + 1, x + w - 1, rule, edge);
    grid.put(y + h - 1, x + w - 1, br, edge);
    for (i, line) in text.iter().enumerate() {
        grid.put(y + 1 + i, x, side_l, edge);
        grid.put(y + 1 + i, x + w - 1, side_r, edge);
        let inner = w - 4;
        let pad = inner.saturating_sub(width(line)) / 2;
        grid.text(y + 1 + i, x + 2 + pad, line, Style::new());
    }
}

#[derive(Clone, Copy)]
struct Cell {
    mask: u8,
    color: usize,
    style: LineStyle,
}

fn draw(flow: &Flow, l: &Layout, env: &Env) -> Vec<Line<'static>> {
    let (w, h) = if l.left_right {
        (l.main, l.cross)
    } else {
        (l.cross, l.main)
    };
    let xy = |c: usize, m: usize| if l.left_right { (m, c) } else { (c, m) };
    let ranks = l.ranks.len();
    let arrow = if env.ascii { "->" } else { "→" };
    let node_start = |r: usize| (r as f64 / ranks.max(1) as f64) * 0.55;
    let edge_window = |r: usize| (node_start(r) + 0.08, node_start(r) + 0.4);

    // Edge cells in drawing order, with the reveal window of the rank gap each belongs to.
    struct Run {
        cells: Vec<(usize, usize)>,
        color: usize,
        style: LineStyle,
        arrow: Option<(usize, usize)>,
        window: (f64, f64),
        edge: usize,
        first: bool,
        mid: usize,
        out_c: usize,
        in_c: usize,
        out_m: usize,
    }
    let mut runs: Vec<Run> = Vec::new();
    for s in &l.segments {
        let (a, b) = (&l.items[s.from], &l.items[s.to]);
        let e = &flow.edges[s.edge];
        let src_c = a.c + a.cs / 2;
        let dst_c = b.c + b.cs / 2;
        let out_m = if a.node.is_some() {
            a.m + a.ms
        } else {
            l.rank_m[a.rank] + l.rank_ms[a.rank]
        };
        let in_m = l.rank_m[b.rank] - 1;
        let band_end = l.rank_m[a.rank] + l.rank_ms[a.rank];
        let gap = l.gaps[a.rank];
        let labelled = e.label.is_some() || l.gaps[a.rank] > if l.left_right { 5 } else { 3 };
        let mid = if l.left_right && labelled {
            band_end + gap.saturating_sub(3)
        } else {
            band_end + (gap - 1) / 2
        };
        let mut cells = Vec::new();
        for m in out_m..=mid {
            cells.push((src_c, m));
        }
        let (lo, hi) = (src_c.min(dst_c), src_c.max(dst_c));
        if src_c < dst_c {
            for c in lo + 1..=hi {
                cells.push((c, mid));
            }
        } else {
            for c in (lo..hi).rev() {
                cells.push((c, mid));
            }
        }
        for m in mid + 1..=in_m {
            cells.push((dst_c, m));
        }
        let real_target = b.node.is_some();
        runs.push(Run {
            cells,
            color: rank_of_edge_source(flow, l, s),
            style: e.style,
            arrow: (real_target && e.arrow).then_some((dst_c, in_m)),
            window: edge_window(a.rank),
            edge: s.edge,
            first: a.node.is_some(),
            mid,
            out_c: src_c,
            in_c: dst_c,
            out_m,
        });
    }

    // Occupied cells: boxes, pass-through lines and every edge, for placing labels.
    let mut occupied: HashSet<(usize, usize)> = HashSet::new();
    for it in &l.items {
        if it.node.is_some() {
            let (x, y) = xy(it.c, it.m);
            let (bw, bh) = if l.left_right {
                (it.ms, it.cs)
            } else {
                (it.cs, it.ms)
            };
            for dy in 0..bh {
                for dx in 0..bw {
                    occupied.insert((x + dx, y + dy));
                }
            }
        } else {
            for m in l.rank_m[it.rank]..l.rank_m[it.rank] + l.rank_ms[it.rank] {
                occupied.insert(xy(it.c, m));
            }
        }
    }
    for run in &runs {
        for (c, m) in &run.cells {
            occupied.insert(xy(*c, *m));
        }
        if let Some((c, m)) = run.arrow {
            occupied.insert(xy(c, m));
        }
    }
    let mut labels: Vec<(usize, usize, String, usize, usize)> = Vec::new();
    let mut footnotes: Vec<String> = Vec::new();
    for run in runs.iter().filter(|r| r.first) {
        let Some(text) = flow.edges[run.edge].label.as_ref() else {
            continue;
        };
        let text = truncate(&text.replace('\n', " "), 18);
        let len = width(&text);
        let candidates: Vec<(usize, usize)> = if l.left_right {
            vec![
                (run.out_m + 1, run.out_c.saturating_sub(1)),
                (run.out_m + 1, run.out_c + 1),
            ]
        } else {
            vec![
                (run.in_c + 2, run.mid + 1),
                (run.in_c.saturating_sub(len + 1), run.mid + 1),
                (run.out_c + 2, run.out_m),
            ]
        };
        let placed = candidates.into_iter().find(|(x, y)| {
            *x + len <= w && *y < h && (0..len).all(|k| !occupied.contains(&(x + k, *y)))
        });
        if let Some((x, y)) = placed {
            for k in 0..len {
                occupied.insert((x + k, y));
            }
            labels.push((x, y, text, run.window.1 as usize, run.edge));
        } else {
            let e = &flow.edges[run.edge];
            footnotes.push(format!(
                "{} {arrow} {}: {}",
                flow.nodes[e.from].label.replace('\n', " "),
                flow.nodes[e.to].label.replace('\n', " "),
                e.label.as_deref().unwrap_or("").replace('\n', " "),
            ));
        }
    }

    // Draw at the current progress.
    let mut grid = Grid::new(env.w.max(w), h);
    for it in &l.items {
        let Some(u) = it.node else {
            continue;
        };
        if env.p < node_start(it.rank) {
            continue;
        }
        let (x, y) = xy(it.c, it.m);
        let bw = if l.left_right { it.ms } else { it.cs };
        draw_box(
            &mut grid,
            (x, y, bw),
            &it.text,
            flow.nodes[u].shape,
            env.ink(it.rank),
            env,
        );
    }
    let mut cells: HashMap<(usize, usize), Cell> = HashMap::new();
    let link = |cells: &mut HashMap<(usize, usize), Cell>,
                a: (usize, usize),
                b: (usize, usize),
                color: usize,
                style: LineStyle| {
        let (ax, ay) = xy(a.0, a.1);
        let (bx, by) = xy(b.0, b.1);
        let (da, db) = if bx > ax {
            (RIGHT, LEFT)
        } else if bx < ax {
            (LEFT, RIGHT)
        } else if by > ay {
            (DOWN, UP)
        } else {
            (UP, DOWN)
        };
        for (pos, bit) in [((ax, ay), da), ((bx, by), db)] {
            let cell = cells.entry(pos).or_insert(Cell {
                mask: 0,
                color,
                style,
            });
            cell.mask |= bit;
            cell.color = color;
            cell.style = style;
        }
    };
    for it in l.items.iter().filter(|i| i.node.is_none()) {
        if env.p < node_start(it.rank.saturating_sub(1)) + 0.08 {
            continue;
        }
        let color = it.rank;
        let range = l.rank_m[it.rank]..l.rank_m[it.rank] + l.rank_ms[it.rank];
        for m in range.start..range.end.saturating_sub(1) {
            link(
                &mut cells,
                (it.c, m),
                (it.c, m + 1),
                color,
                LineStyle::Solid,
            );
        }
    }
    for run in &runs {
        let f = (env.p - run.window.0) / (run.window.1 - run.window.0);
        if f <= 0.0 {
            continue;
        }
        let shown = ((f.min(1.0) * run.cells.len() as f64).ceil() as usize).min(run.cells.len());
        for pair in run.cells[..shown].windows(2) {
            link(&mut cells, pair[0], pair[1], run.color, run.style);
        }
        if shown == 1 {
            let (c, m) = run.cells[0];
            let (x, y) = xy(c, m);
            cells.entry((x, y)).or_insert(Cell {
                mask: if l.left_right { LEFT } else { UP },
                color: run.color,
                style: run.style,
            });
        }
    }
    for ((x, y), cell) in &cells {
        let ch = junction(cell.mask, cell.style, env.ascii);
        grid.put(*y, *x, ch, env.ink(cell.color));
    }
    for run in &runs {
        if let Some((c, m)) = run.arrow
            && env.p >= run.window.1 - 0.01
        {
            let (x, y) = xy(c, m);
            let head = match (l.left_right, env.ascii) {
                (true, true) => '>',
                (true, false) => '▶',
                (false, true) => 'v',
                (false, false) => '▼',
            };
            grid.put(y, x, head, env.ink(run.color));
        }
    }
    for (x, y, text, _, edge) in &labels {
        let done = runs
            .iter()
            .find(|r| r.edge == *edge && r.first)
            .map_or(0.0, |r| r.window.1);
        if env.p >= done - 0.05 {
            grid.text(*y, *x, text, env.muted());
        }
    }
    let mut lines = grid.into_lines();
    // What could not be drawn: labels that found no free cells, and edges that point back.
    let loop_mark = if env.ascii { "<-" } else { "↺" };
    let mut notes = footnotes;
    for i in &l.back {
        let e = &flow.edges[*i];
        let label = e
            .label
            .as_ref()
            .map(|t| format!(": {t}"))
            .unwrap_or_default();
        notes.push(format!(
            "{loop_mark} {} {arrow} {}{}",
            flow.nodes[e.from].label.replace('\n', " "),
            flow.nodes[e.to].label.replace('\n', " "),
            label.replace('\n', " ")
        ));
    }
    for note in notes {
        lines.push(Line::from(Span::styled(
            truncate(&note, env.w),
            env.muted(),
        )));
    }
    lines
}

/// The colour index of an edge: the rank of the real node it leaves.
fn rank_of_edge_source(flow: &Flow, l: &Layout, s: &Segment) -> usize {
    l.items
        .iter()
        .find(|i| i.node == Some(flow.edges[s.edge].from))
        .map_or(0, |i| i.rank)
}

// --- the list ----------------------------------------------------------------------------------------------

/// An indented list from the roots, for a graph that does not fit.
fn list_view(flow: &Flow, env: &Env) -> Vec<Line<'static>> {
    let n = flow.nodes.len();
    let mut has_parent = vec![false; n];
    for e in &flow.edges {
        if e.from != e.to {
            has_parent[e.to] = true;
        }
    }
    let mut roots: Vec<usize> = (0..n).filter(|u| !has_parent[*u]).collect();
    if roots.is_empty() {
        roots.push(0);
    }
    let mut seen = vec![false; n];
    let mut rows: Vec<(String, Option<String>, usize, bool)> = Vec::new();
    #[allow(clippy::too_many_arguments)]
    fn walk(
        u: usize,
        flow: &Flow,
        prefix: &str,
        last: bool,
        root: bool,
        label: Option<&str>,
        depth: usize,
        seen: &mut [bool],
        rows: &mut Vec<(String, Option<String>, usize, bool)>,
        ascii: bool,
    ) {
        let branch = if root {
            ""
        } else if ascii {
            if last { "`- " } else { "|- " }
        } else if last {
            "└─ "
        } else {
            "├─ "
        };
        let name = flow.nodes[u].label.replace('\n', " / ");
        let again = seen[u];
        seen[u] = true;
        rows.push((
            format!("{prefix}{branch}"),
            label.map(String::from),
            depth,
            again,
        ));
        let last_row = rows.len() - 1;
        rows[last_row].0.push_str(&if again {
            format!("{} {name}", if ascii { "<-" } else { "↺" })
        } else {
            name
        });
        if again {
            return;
        }
        let kids: Vec<&Edge> = flow
            .edges
            .iter()
            .filter(|e| e.from == u && e.to != u)
            .collect();
        let child_prefix = format!(
            "{prefix}{}",
            if root {
                ""
            } else if ascii {
                if last { "   " } else { "|  " }
            } else if last {
                "   "
            } else {
                "│  "
            }
        );
        for (i, e) in kids.iter().enumerate() {
            walk(
                e.to,
                flow,
                &child_prefix,
                i + 1 == kids.len(),
                false,
                e.label.as_deref(),
                depth + 1,
                seen,
                rows,
                ascii,
            );
        }
    }
    for root in &roots {
        walk(
            *root, flow, "", true, true, None, 0, &mut seen, &mut rows, env.ascii,
        );
    }
    for u in 0..n {
        if !seen[u] {
            walk(
                u, flow, "", true, true, None, 0, &mut seen, &mut rows, env.ascii,
            );
        }
    }
    let total = rows.len();
    let shown = ((total as f64 * crate::chart::ease(env.p / 0.8)).ceil() as usize).min(total);
    let mut out = vec![Line::from(Span::styled(
        truncate("list view: the diagram is wider than the screen", env.w),
        env.dim(),
    ))];
    for (i, (text, label, depth, _)) in rows.into_iter().enumerate() {
        if i >= shown {
            out.push(Line::default());
            continue;
        }
        let mut spans = vec![Span::styled(text.clone(), env.ink(depth))];
        if let Some(label) = label {
            spans.insert(
                1,
                Span::styled(format!("[{}] ", label.replace('\n', " ")), env.muted()),
            );
        }
        let mut line = Line::from(spans);
        let used: usize = line.spans.iter().map(|s| width(&s.content)).sum();
        if used > env.w {
            line = Line::from(Span::styled(truncate(&text, env.w), env.ink(depth)));
        }
        out.push(line);
    }
    out
}

/// The lines of `flow` `w` cells wide at `progress`.
pub fn render(
    flow: &Flow,
    w: usize,
    progress: f64,
    th: &Theme,
    sym: &Symbols,
) -> Option<Vec<Line<'static>>> {
    let env = Env {
        w,
        p: progress.clamp(0.0, 1.0),
        th,
        ascii: sym.rule == "-",
    };
    for max_text in [24, 16, 10] {
        if let Some(l) = layout(flow, max_text, w) {
            return Some(draw(flow, &l, &env));
        }
    }
    Some(list_view(flow, &env))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ASCII, LAVENDER, UNICODE};

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

    fn draw(src: &str, w: usize, p: f64) -> Vec<Line<'static>> {
        render(&parse(src).unwrap(), w, p, &LAVENDER, &UNICODE).unwrap()
    }

    const TD: &str = "graph TD\n A[Start] --> B{Valid?}\n B -->|yes| C[Save]\n B -->|no| D[Reject]\n C --> E([Done])\n D --> E\n E -.-> A";
    const LR: &str = "graph LR\n A[Prompt] --> B[Plan] --> C[Run tools]\n C -- ok --> D[Answer]\n C --> E[Retry]\n A --> D";

    #[test]
    fn it_reads_the_web_dialect() {
        let flow = parse(
            "flowchart LR %% a comment\n  subgraph one\n  A[\"Hello <br/> world\"] ==> B((Hub))\n  end\n  B -- text --> C{{Hex}} & D[(Db)]\n  classDef x fill:#f00\n  C --- E[[Sub]]\n  E -.- F>Flag]",
        )
        .unwrap();
        assert!(flow.left_right);
        let labels: Vec<&str> = flow.nodes.iter().map(|n| n.label.as_str()).collect();
        assert_eq!(labels, ["Hello\nworld", "Hub", "Hex", "Db", "Sub", "Flag"]);
        assert_eq!(flow.nodes[1].shape, Shape::Circle);
        assert_eq!(flow.nodes[2].shape, Shape::Hexagon);
        assert_eq!(flow.nodes[3].shape, Shape::Cylinder);
        assert_eq!(flow.nodes[4].shape, Shape::Subroutine);
        let e = &flow.edges;
        assert_eq!(e.len(), 5);
        assert_eq!((e[0].style, e[0].arrow), (LineStyle::Thick, true));
        assert_eq!(e[1].label.as_deref(), Some("text"));
        assert_eq!((e[1].from, e[1].to, e[2].to), (1, 2, 3));
        assert!(!e[3].arrow);
        assert_eq!((e[4].style, e[4].arrow), (LineStyle::Dashed, false));
    }

    #[test]
    fn only_graphs_are_read() {
        assert!(parse("sequenceDiagram\nA->>B: hi").is_none());
        assert!(parse("graph TD").is_none());
        assert!(parse("graphite TD\nA-->B").is_none());
        assert!(parse("graph\nA-->B").is_some());
        assert!(!parse("graph TD\nA-->B").unwrap().left_right);
    }

    #[test]
    fn a_top_down_graph_is_boxes_and_arrows() {
        let rows = plain(&draw(TD, 100, 1.0));
        let text = rows.join("\n");
        for v in [
            "Start", "Valid?", "Save", "Reject", "Done", "▼", "yes", "no",
        ] {
            assert!(text.contains(v), "{v} in\n{text}");
        }
        // The back edge is not drawn through the boxes; it is listed.
        assert_eq!(rows.last().unwrap(), "↺ Done → Start");
        let y = |name: &str| rows.iter().position(|r| r.contains(name)).unwrap();
        assert!(y("Start") < y("Valid?") && y("Valid?") < y("Save") && y("Save") < y("Done"));
        assert_eq!(y("Save"), y("Reject"));
    }

    #[test]
    fn a_left_right_graph_runs_across_with_long_edges_around_boxes() {
        let rows = plain(&draw(LR, 100, 1.0));
        let text = rows.join("\n");
        for v in ["Prompt", "Plan", "Run tools", "Answer", "Retry", "▶", "ok"] {
            assert!(text.contains(v), "{v} in\n{text}");
        }
        let x = |name: &str| {
            rows.iter()
                .find_map(|r| r.find(name).map(|b| width(&r[..b])))
                .unwrap()
        };
        assert!(
            x("Prompt") < x("Plan") && x("Plan") < x("Run tools") && x("Run tools") < x("Answer")
        );
    }

    #[test]
    fn the_height_never_changes_during_the_reveal_and_nothing_is_wider_than_the_room() {
        for src in [TD, LR] {
            for w in [30, 60, 100] {
                let rows = draw(src, w, 1.0).len();
                for p in [0.0, 0.2, 0.4, 0.6, 0.8, 1.0] {
                    let frame = draw(src, w, p);
                    assert_eq!(frame.len(), rows, "{w} columns, progress {p}");
                    assert!(frame.iter().all(|l| cells(l) <= w), "{:?}", plain(&frame));
                }
            }
        }
        let start = plain(&draw(TD, 100, 0.0)).join("\n");
        assert!(start.contains("Start") && !start.contains("Reject"));
    }

    #[test]
    fn too_wide_degrades_to_an_indented_list() {
        let src = "graph LR\n A1[One long node label here] --> B1[Another long node label] --> C1[Third long label] --> D1[Fourth long label] --> E1[Fifth long label] --> F1[Sixth] --> G1[Seventh]";
        let rows = plain(&draw(src, 100, 1.0));
        assert!(rows[0].starts_with("list view"));
        assert_eq!(rows[1], "One long node label here");
        assert_eq!(rows[2], "└─ Another long node label");
        assert!(rows.last().unwrap().contains("Seventh"));
        let h = rows.len();
        assert_eq!(draw(src, 100, 0.0).len(), h);
        assert!(
            draw(src, 100, 0.0)
                .iter()
                .skip(2)
                .all(|l| l.spans.is_empty())
        );
        // The same graph in a wide room is a drawing.
        assert!(!plain(&draw(src, 230, 1.0))[0].starts_with("list view"));
    }

    #[test]
    fn korean_labels_and_cycles_do_not_break_the_boxes() {
        let src =
            "graph TD\n A[요청 받기] --> B[처리 중입니다 잠시만요] --> C[끝]\n C --> A\n B --> B";
        let rows = plain(&draw(src, 60, 1.0));
        let line = rows.iter().find(|r| r.contains("요청 받기")).unwrap();
        let top = rows.iter().find(|r| r.contains('┌')).unwrap();
        assert!(width(line) >= width(top.trim_end()));
        assert!(
            rows.iter().filter(|r| r.starts_with('↺')).count() == 2,
            "{rows:?}"
        );
    }

    #[test]
    fn ascii_symbols_draw_only_ascii() {
        for src in [TD, LR] {
            let rows = plain(&render(&parse(src).unwrap(), 100, 1.0, &LAVENDER, &ASCII).unwrap());
            assert!(rows.iter().all(|r| r.is_ascii()), "{rows:?}");
        }
        let list = "graph LR\n A1[One long node label here] --> B1[Another long node label] --> C1[Third long label] --> D1[Fourth long label] --> E1[Fifth long label] --> F1[Sixth] --> G1[Seventh]";
        let rows = plain(&render(&parse(list).unwrap(), 100, 1.0, &LAVENDER, &ASCII).unwrap());
        assert!(rows.iter().all(|r| r.is_ascii()), "{rows:?}");
    }

    #[test]
    #[ignore]
    fn samples_print() {
        for src in [TD, LR] {
            for row in plain(&draw(src, 100, 1.0)) {
                println!("{row}");
            }
            println!();
        }
    }
}
