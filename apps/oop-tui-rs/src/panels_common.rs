//! What the Workflow and Agents panels share: the glyph tables (with their ASCII twins), the
//! panel's words in English and Korean, the tab bar, and the small layout helpers (clip, pad,
//! pack, scroll window). Ported from the former TypeScript terminal's workflow panel (`panelHead`, `windowOf`,
//! `packFacts`, the word tables) and its crew board and spinner formatting.

use crate::flow::{Cat, CrewPhase, CrewTask, Doing, Evidence, NodeState, Proof, Role, ToolCount};
use crate::i18n::{Lang, lang};
use crate::text::{char_width, sanitize, truncate, width, wrap};
use crate::theme::{Symbols, Theme};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

/// The words of a panel string in the language of the app.
pub fn s(en: &'static str, ko: &'static str) -> &'static str {
    if lang() == Lang::Ko { ko } else { en }
}

/// Fills `{name}` holes of a template.
pub fn fill(template: &str, pairs: &[(&str, String)]) -> String {
    pairs
        .iter()
        .fold(template.to_string(), |text, (name, value)| {
            text.replace(&format!("{{{name}}}"), value)
        })
}

/// Cleaned text on one line.
pub fn flat(value: &str) -> String {
    sanitize(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---- glyphs -------------------------------------------------------------------------------------

/// Every mark the panels draw, each one cell wide.
pub struct Glyphs {
    /// Pending, blocked, running, paused, completed, failed, cancelled.
    pub flow: [&'static str; 7],
    pub corners: [&'static str; 4],
    pub horizontal: &'static str,
    pub vertical: &'static str,
    /// A taken or live link, a link not yet taken, its arrowhead, the chevron between phases.
    pub link: [&'static str; 4],
    /// Top, middle and bottom of the bar down the left of a card.
    pub rail: [&'static str; 3],
    pub full: &'static str,
    pub rule: &'static str,
    /// The filled and the empty cell of a status bar, and its two ends.
    pub block: [&'static str; 2],
    /// The cell of a bar for an item that is claimed but not yet verified.
    pub claimed: &'static str,
    pub ends: [&'static str; 2],
    pub check: &'static str,
    pub brand: &'static str,
    pub separator: &'static str,
    pub prompt: &'static str,
    pub bullet: &'static str,
}

const UNICODE: Glyphs = Glyphs {
    flow: ["○", "◌", "◐", "‖", "✓", "✗", "■"],
    corners: ["╭", "╮", "╰", "╯"],
    horizontal: "─",
    vertical: "│",
    link: ["│", "┆", "▼", "›"],
    rail: ["┌", "│", "└"],
    full: "━",
    rule: "─",
    block: ["█", "░"],
    claimed: "▒",
    ends: ["▕", "▏"],
    check: "✓",
    brand: "◆",
    separator: "│",
    prompt: "❯",
    bullet: "●",
};

const ASCII: Glyphs = Glyphs {
    flow: [".", "?", "~", "=", "+", "x", "-"],
    corners: ["+", "+", "+", "+"],
    horizontal: "-",
    vertical: "|",
    link: ["|", ":", "v", ">"],
    rail: ["+", "|", "+"],
    full: "=",
    rule: "-",
    block: ["#", "-"],
    claimed: "=",
    ends: ["[", "]"],
    check: "+",
    brand: "*",
    separator: "|",
    prompt: ">",
    bullet: "*",
};

/// What a panel draws with: the theme, the glyphs for the symbol set, and the animation state.
pub struct Ctx<'a> {
    pub th: &'a Theme,
    pub g: &'static Glyphs,
    pub spinner: [&'static str; 4],
    pub ascii: bool,
    pub tick: usize,
    pub animations: bool,
}

impl<'a> Ctx<'a> {
    pub fn new(th: &'a Theme, sym: &Symbols, tick: usize, animations: bool) -> Self {
        let ascii = sym.rule == "-";
        Ctx {
            th,
            g: if ascii { &ASCII } else { &UNICODE },
            spinner: sym.spinner,
            ascii,
            tick,
            animations,
        }
    }

    pub fn text(&self) -> Style {
        Style::default()
    }
    pub fn bold(&self) -> Style {
        Style::default().add_modifier(Modifier::BOLD)
    }
    pub fn dim(&self) -> Style {
        fg(self.th.dim)
    }
    pub fn accent(&self) -> Style {
        fg(self.th.accent)
    }
    pub fn success(&self) -> Style {
        fg(self.th.success)
    }
    pub fn error(&self) -> Style {
        fg(self.th.error)
    }
    pub fn warning(&self) -> Style {
        fg(self.th.warning)
    }
    pub fn muted(&self) -> Style {
        fg(self.th.muted)
    }

    /// The colour of a state: success, error, accent while it runs, warning while it waits,
    /// muted for a quiet exit (a query's "no", never a failure).
    pub fn tone(&self, state: NodeState) -> Style {
        match state {
            NodeState::Completed => self.success(),
            NodeState::Failed => self.error(),
            NodeState::Quiet => self.muted(),
            NodeState::Running => self.accent(),
            NodeState::Blocked | NodeState::Paused => self.warning(),
            _ => self.dim(),
        }
    }

    /// The mark of a state; a running one turns with the tick while animations are on.
    pub fn mark(&self, state: NodeState) -> &'static str {
        let index = match state {
            NodeState::Quiet | NodeState::Pending => 0,
            NodeState::Blocked => 1,
            NodeState::Running => {
                return if self.animations {
                    self.spinner[self.tick % self.spinner.len()]
                } else {
                    self.g.flow[2]
                };
            }
            NodeState::Paused => 3,
            NodeState::Completed => 4,
            NodeState::Failed => 5,
            NodeState::Cancelled => 6,
        };
        self.g.flow[index]
    }
}

pub fn fg(color: Color) -> Style {
    Style::default().fg(color)
}

// ---- rows ---------------------------------------------------------------------------------------

/// A line before it is a `Line`: styled pieces of text.
pub type Row = Vec<Span<'static>>;

pub fn sp(text: impl Into<String>, style: Style) -> Span<'static> {
    Span::styled(text.into(), style)
}

pub fn row_width(row: &Row) -> usize {
    row.iter().map(|span| width(&span.content)).sum()
}

/// Cuts a row to `max` cells, ending in an ellipsis when something was cut.
pub fn clip(row: Row, max: usize) -> Row {
    if row_width(&row) <= max {
        return row;
    }
    let mut out: Row = Vec::new();
    let mut used = 0;
    let room = max.saturating_sub(1);
    let mut last_style = Style::default();
    'spans: for span in row {
        last_style = span.style;
        let mut kept = String::new();
        for ch in span.content.chars() {
            let w = char_width(ch);
            if used + w > room {
                if !kept.is_empty() {
                    out.push(Span::styled(kept, span.style));
                }
                break 'spans;
            }
            kept.push(ch);
            used += w;
        }
        out.push(Span::styled(kept, span.style));
    }
    if max > 0 {
        out.push(Span::styled("…", last_style));
    }
    out
}

/// Pads a row with spaces on the right to `to` cells.
pub fn pad(mut row: Row, to: usize) -> Row {
    let used = row_width(&row);
    if used < to {
        row.push(sp(" ".repeat(to - used), Style::default()));
    }
    row
}

pub fn margin(mut row: Row) -> Row {
    row.insert(0, sp(" ", Style::default()));
    row
}

/// Plain text to a row of one style, cut to `max` cells.
pub fn cut(text: &str, style: Style, max: usize) -> Row {
    vec![sp(truncate(text, max), style)]
}

/// The facts in as few lines of `max` cells as they fit, none split across two.
pub fn pack_facts(facts: &[String], max: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for fact in facts {
        let joined = if line.is_empty() {
            fact.clone()
        } else {
            format!("{line} · {fact}")
        };
        if !line.is_empty() && width(&joined) > max {
            lines.push(std::mem::replace(&mut line, fact.clone()));
        } else {
            line = joined;
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// Styled pieces joined by a dim ` · `, packed into lines of `max` cells without splitting one.
pub fn pack_pieces(ctx: &Ctx, pieces: Vec<(String, Style)>, max: usize) -> Vec<Row> {
    let mut lines: Vec<Row> = Vec::new();
    let mut line: Row = Vec::new();
    for (text, style) in pieces {
        let mut joined = line.clone();
        if !joined.is_empty() {
            joined.push(sp(" · ", ctx.dim()));
        }
        joined.push(sp(text.clone(), style));
        if !line.is_empty() && row_width(&joined) > max {
            lines.push(std::mem::replace(&mut line, vec![sp(text, style)]));
        } else {
            line = joined;
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// Wrapped plain text, every line in one style.
pub fn wrapped(text: &str, style: Style, max: usize) -> Vec<Row> {
    wrap(text, max)
        .into_iter()
        .map(|l| vec![sp(l, style)])
        .collect()
}

/// A body that does not fit is shown from just above `focus`, with a row at either end saying how
/// many lines lie beyond. It can be moved by what the wheel scrolled: `scroll` is how many
/// lines the user moved the window from where `focus` puts it. The result is held inside the body
/// and written back, so the wheel cannot run past either end.
pub fn window_scrolled(
    ctx: &Ctx,
    lines: Vec<Row>,
    focus: usize,
    rows: usize,
    scroll: Option<&std::cell::Cell<i32>>,
) -> Vec<Row> {
    if lines.len() <= rows {
        if let Some(scroll) = scroll {
            scroll.set(0);
        }
        return lines;
    }
    if rows < 3 {
        return lines.into_iter().skip(focus).take(rows).collect();
    }
    let auto = focus.saturating_sub(1).min(lines.len() - rows);
    let start = match scroll {
        Some(scroll) => {
            let wanted =
                (auto as i64 + i64::from(scroll.get())).clamp(0, (lines.len() - rows) as i64);
            scroll.set((wanted - auto as i64) as i32);
            wanted as usize
        }
        None => auto,
    };
    let end = start + rows;
    let total = lines.len();
    let mut shown: Vec<Row> = lines.into_iter().skip(start).take(rows).collect();
    if start > 0 {
        shown[0] = vec![sp(
            fill(
                s("↑ {count} lines above", "↑ 위에 {count}줄"),
                &[("count", start.to_string())],
            ),
            ctx.dim(),
        )];
    }
    if end < total {
        let last = shown.len() - 1;
        shown[last] = vec![sp(
            fill(
                s("↓ {count} lines below", "↓ 아래에 {count}줄"),
                &[("count", (total - end).to_string())],
            ),
            ctx.dim(),
        )];
    }
    shown
}

pub fn finish(ctx: &Ctx, rows: Vec<Row>, max_width: usize, height: usize) -> Vec<Line<'static>> {
    rows.into_iter()
        .take(height)
        .map(|row| {
            let row = clip(row, max_width);
            let spans: Vec<Span<'static>> = if ctx.ascii {
                row.into_iter()
                    .map(|span| {
                        let content: String = span
                            .content
                            .chars()
                            .map(|c| match c {
                                '·' => '-',
                                '…' => '~',
                                '↑' => '^',
                                '↓' => 'v',
                                other => other,
                            })
                            .collect();
                        Span::styled(content, span.style)
                    })
                    .collect()
            } else {
                row
            };
            Line::from(spans)
        })
        .collect()
}

// ---- the tab bar and the notes ------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum View {
    Workflow,
    Agents,
    Savvy,
    Files,
}

impl View {
    /// The tabs in the order the bar shows them.
    pub const ALL: [View; 4] = [View::Workflow, View::Agents, View::Savvy, View::Files];

    pub fn title(self) -> &'static str {
        match self {
            View::Workflow => "Workflow",
            View::Agents => "Agents",
            View::Savvy => "Savvy",
            View::Files => "Files",
        }
    }
}

const TAB_GAP: usize = 3;

/// Which tab a click `offset` cells into the tab bar (after the margin) lands on; the gaps between
/// the titles are no tab.
pub fn tab_at(offset: usize) -> Option<View> {
    let mut start = 0;
    for view in View::ALL {
        let end = start + width(view.title());
        if offset >= start && offset < end {
            return Some(view);
        }
        start = end + TAB_GAP;
    }
    None
}

/// What every view of the panel starts with: the tab bar (the view shown lit and underlined) and
/// a rule under it, inside a one-cell margin. `room` is the width left for text.
pub fn head(ctx: &Ctx, view: View, room: usize) -> Vec<Row> {
    let gap = format!(" {} ", ctx.g.separator);
    let mut bar: Row = Vec::new();
    let (mut before, mut lit) = (0, 0);
    for (i, tab) in View::ALL.iter().enumerate() {
        let title = tab.title();
        if i > 0 {
            bar.push(sp(gap.clone(), ctx.dim()));
        }
        if *tab == view {
            lit = width(title);
        } else if lit == 0 {
            before += width(title) + width(&gap);
        }
        bar.push(sp(
            title,
            if *tab == view {
                ctx.accent().add_modifier(Modifier::BOLD)
            } else {
                ctx.dim()
            },
        ));
    }
    let rule = vec![
        sp(ctx.g.rule.repeat(before), ctx.dim()),
        sp(ctx.g.full.repeat(lit), ctx.accent()),
        sp(
            ctx.g.rule.repeat(room.saturating_sub(before + lit)),
            ctx.dim(),
        ),
    ];
    vec![margin(clip(bar, room)), margin(rule)]
}

/// A sentence in the margin.
pub fn say(ctx: &Ctx, text: &str, room: usize) -> Vec<Row> {
    wrapped(text, ctx.dim(), room)
        .into_iter()
        .map(margin)
        .collect()
}

/// The empty state: a mark, a title and a few words, centred in the panel.
pub fn empty_state(ctx: &Ctx, title: &str, text: &str, room: usize) -> Vec<Row> {
    let centred = |content: String, style: Style| {
        let lead = room.saturating_sub(width(&content)) / 2;
        margin(vec![sp(" ".repeat(lead) + &content, style)])
    };
    let mut rows = vec![
        vec![],
        centred(ctx.g.brand.to_string(), ctx.dim()),
        centred(truncate(title, room), ctx.bold()),
    ];
    for line in wrap(text, room.saturating_sub(4).min(34)) {
        rows.push(centred(line, ctx.dim()));
    }
    rows
}

// ---- words --------------------------------------------------------------------------------------

pub fn role_word(role: Role) -> &'static str {
    match role {
        Role::Main => s("Main agent", "메인 에이전트"),
        Role::Worker => "Worker",
        Role::Expert => "Expert",
        Role::Auditor => "Auditor",
        Role::Crew => s("Crew member", "Crew 멤버"),
        Role::Subagent => s("Subagent", "서브에이전트"),
        Role::Workflow => s("Workflow", "워크플로"),
    }
}

pub fn state_word(state: NodeState) -> &'static str {
    match state {
        NodeState::Pending => s("Not started", "시작 전"),
        NodeState::Blocked => s("Waiting", "대기 중"),
        NodeState::Running => s("Working", "작업 중"),
        NodeState::Paused => s("Paused", "일시 중지"),
        NodeState::Completed => s("Done", "완료"),
        NodeState::Failed => s("Failed", "실패"),
        NodeState::Cancelled => s("Stopped", "중단됨"),
        // An exit code, not a verdict; left untranslated like the numbers beside it.
        NodeState::Quiet => "exit 1",
    }
}

pub fn doing_word(doing: Doing) -> &'static str {
    match doing {
        Doing::Tool(Cat::Read) => s("Reading files…", "파일 읽는 중…"),
        Doing::Tool(Cat::Edit) => s("Editing files…", "파일 수정 중…"),
        Doing::Tool(Cat::Run) => s("Running commands…", "명령 실행 중…"),
        Doing::Tool(Cat::Search) => s("Searching…", "검색 중…"),
        Doing::Tool(Cat::Web) => s("Searching the web…", "웹 검색 중…"),
        Doing::Tool(Cat::Other) => s("Using tools…", "도구 사용 중…"),
        Doing::Thinking => s("Thinking…", "생각하는 중…"),
        Doing::Waiting => s("Waiting for the team…", "팀 작업을 기다리는 중…"),
    }
}

pub fn tool_word((category, count): ToolCount) -> String {
    let template = match category {
        Cat::Read => s("{count} files read", "파일 {count}개 읽음"),
        Cat::Edit => s("{count} files edited", "파일 {count}개 수정"),
        Cat::Run => s("{count} commands run", "명령 {count}번 실행"),
        Cat::Search => s("{count} searches", "검색 {count}번"),
        Cat::Web => s("{count} web searches", "웹 검색 {count}번"),
        Cat::Other => s("{count} other tool calls", "기타 도구 {count}번"),
    };
    fill(template, &[("count", count.to_string())])
}

pub fn count_word(kind: &str, count: usize) -> String {
    let template = match kind {
        "completed" => s("{count} done", "완료 {count}"),
        "failed" => s("{count} failed", "실패 {count}"),
        "stopped" => s("{count} stopped", "중단 {count}"),
        _ => s("{count} running", "진행 {count}"),
    };
    fill(template, &[("count", count.to_string())])
}

pub fn evidence_word(evidence: Evidence) -> &'static str {
    match evidence {
        Evidence::Reported => s("Reported only", "보고만 있음"),
        Evidence::Tested => s("Tests passed", "테스트 통과"),
        Evidence::Audited => s("Audit approved", "감사 승인"),
    }
}

/// Whether the server could verify a finished task, in one word.
pub fn proof_word(proof: Proof) -> &'static str {
    match proof {
        Proof::Verified => s("verified", "검증됨"),
        Proof::NotVerified => s("not verified", "미검증"),
        Proof::Inconclusive => s("unproven", "미증명"),
    }
}

pub fn phase_word(task: &CrewTask) -> &'static str {
    match task.phase {
        CrewPhase::Running => s("In progress", "진행 중"),
        CrewPhase::Completed => s("Done", "완료"),
        CrewPhase::Partial => s("Partly done", "일부 완료"),
        CrewPhase::Blocked => s("Blocked", "차단됨"),
        CrewPhase::Failed => s("Failed", "실패"),
        CrewPhase::Stopped if task.unreported => s("Stopped · no report", "중단됨 · 보고 없음"),
        CrewPhase::Stopped => s("Stopped", "중단됨"),
    }
}

pub fn tokens_word(tokens: u64) -> String {
    fill(
        s("{count} tokens", "{count} 토큰"),
        &[("count", format_tokens(tokens))],
    )
}

pub fn wait_word(waiting: crate::flow::Waiting) -> &'static str {
    match waiting {
        crate::flow::Waiting::Approval => s("waiting for approval", "승인 대기"),
        crate::flow::Waiting::Input => s("waiting for answer", "질문 대기"),
    }
}

// ---- numbers ------------------------------------------------------------------------------------

/// `12s`, `1m 05s`, `1h 02m`.
pub fn format_elapsed(milliseconds: i64) -> String {
    let seconds = (milliseconds / 1000).max(0);
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m {:02}s", seconds % 60);
    }
    format!("{}h {:02}m", minutes / 60, minutes % 60)
}

pub fn format_tokens(count: u64) -> String {
    if count < 1000 {
        return count.to_string();
    }
    let text = format!("{:.1}", count as f64 / 1000.0);
    format!("{}k", text.strip_suffix(".0").unwrap_or(&text))
}

pub fn format_cost(usd: f64) -> String {
    if usd > 0.0 && usd < 0.01 {
        "<$0.01".to_string()
    } else {
        format!("${usd:.2}")
    }
}

/// One line over the crew board: how many tasks, in what state, and what they used.
pub fn board_summary(board: &crate::flow::CrewBoard) -> String {
    let turn = if board.current {
        s("This turn", "이번 턴")
    } else {
        s("Earlier turn", "이전 턴")
    };
    let mut parts = vec![fill(
        s("{turn} · Tasks {count}", "{turn} · 작업 {count}개"),
        &[
            ("turn", turn.to_string()),
            ("count", board.tasks.len().to_string()),
        ],
    )];
    if board.running > 0 {
        parts.push(fill(
            s("{count} running", "진행 {count}"),
            &[("count", board.running.to_string())],
        ));
    }
    if board.settled > 0 {
        parts.push(fill(
            s("{count} finished", "끝남 {count}"),
            &[("count", board.settled.to_string())],
        ));
    }
    if let Some((tokens, cost)) = board.usage {
        parts.push(format!(
            "{}{}",
            tokens_word(tokens),
            cost.map_or(String::new(), |c| format!(" · {}", format_cost(c)))
        ));
    }
    parts.join(" · ")
}

/// Renders lines to plain text, for tests.
#[cfg(test)]
pub fn plain(lines: &[Line<'static>]) -> Vec<String> {
    lines
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|s| s.content.as_ref())
                .collect::<String>()
        })
        .collect()
}

/// Hand-built threads for the panel tests: activities as the server sends them.
#[cfg(test)]
pub mod scenes {
    use crate::flow::{FlowInput, Waiting};
    use crate::state::ThreadShell;
    use crate::text::parse_iso_ms;
    use crate::thread::Thread;
    use serde_json::{Value, json};

    /// A moment of the scene, `sec` seconds after 00:00:00.
    pub fn ts(sec: i64) -> String {
        format!("2026-01-01T00:{:02}:{:02}.000Z", sec / 60, sec % 60)
    }

    pub fn ms(sec: i64) -> i64 {
        parse_iso_ms(&ts(sec)).unwrap_or(0)
    }

    pub fn act(kind: &str, sec: i64, payload: Value) -> Value {
        json!({
            "id": format!("a-{kind}-{sec}"), "tone": "info", "kind": kind, "summary": kind,
            "payload": payload, "turnId": "t1", "createdAt": ts(sec),
        })
    }

    /// A tool call of the lead that has `status` at `sec`.
    pub fn tool(sec: i64, id: &str, name: &str, status: &str) -> Value {
        let kind = if status == "completed" {
            "tool.completed"
        } else {
            "tool.updated"
        };
        act(
            kind,
            sec,
            json!({"toolCallId": id, "status": status, "data": {"toolName": name}}),
        )
    }

    /// A crew task activity (`task.started`, `task.progress`, `task.completed`).
    pub fn crew(kind: &str, sec: i64, id: &str, role: &str, extra: Value) -> Value {
        let mut payload = json!({
            "taskId": id, "crewRole": role, "agentKind": "agent", "threadId": format!("th-{id}"), "model": "claude-sonnet-5",
        });
        for (key, value) in extra.as_object().into_iter().flatten() {
            payload[key] = value.clone();
        }
        act(kind, sec, payload)
    }

    pub fn thread(activities: Vec<Value>, running: bool) -> Thread {
        let done = if running { Value::Null } else { json!(ts(90)) };
        let session = if running { "running" } else { "ready" };
        serde_json::from_value(json!({
            "id": "lead", "projectId": "p1", "title": "Lead", "activities": activities,
            "latestTurn": {
                "turnId": "t1", "state": if running { "running" } else { "completed" },
                "requestedAt": ts(0), "startedAt": ts(1), "completedAt": done,
            },
            "session": {"status": session, "activeTurnId": if running { json!("t1") } else { Value::Null }},
        }))
        .expect("scene thread")
    }

    pub fn shell(id: &str, title: &str, approvals: bool) -> ThreadShell {
        serde_json::from_value(json!({
            "id": id, "projectId": "p1", "title": title, "parentThreadId": "lead",
            "hasPendingApprovals": approvals, "hasPendingUserInput": false,
        }))
        .expect("scene shell")
    }

    pub fn input<'a>(
        thread: &'a Thread,
        children: &'a [ThreadShell],
        now_sec: i64,
    ) -> FlowInput<'a> {
        // The panels' words follow the app language, which is fixed once; the tests read English.
        crate::i18n::init(Some("en"));
        FlowInput {
            thread,
            children,
            lead_model: Some("claude-opus-5".to_string()),
            crew: None,
            lead_waiting: None::<Waiting>,
            lead_cost: crate::savvy_panel::lead_cost(thread),
            loading: false,
            pending: false,
            now_ms: ms(now_sec),
            tick: 0,
            animations: false,
            pinned: None,
            online: true,
            scroll: None,
        }
    }

    /// The lead reads two files and runs a command; nothing else is going on.
    pub fn lead_only() -> Thread {
        thread(
            vec![
                tool(2, "r1", "Read", "completed"),
                tool(3, "r2", "Read", "completed"),
                tool(5, "b1", "Bash", "running"),
            ],
            true,
        )
    }

    /// Two crew tasks with titles in Korean, whose cells are two wide.
    pub fn korean() -> Thread {
        thread(
            vec![
                tool(2, "r1", "Read", "completed"),
                tool(5, "d1", "crew_delegate", "running"),
                crew(
                    "task.started",
                    6,
                    "w1",
                    "worker",
                    json!({"title": "구문 분석기를 만들고 시험을 추가합니다"}),
                ),
                crew(
                    "task.started",
                    6,
                    "e1",
                    "expert",
                    json!({"title": "문법 검토"}),
                ),
            ],
            true,
        )
    }

    /// The lead reads two files, hands two tasks to the crew, and both run.
    pub fn parallel() -> Thread {
        thread(
            vec![
                tool(2, "r1", "Read", "completed"),
                tool(3, "r2", "Read", "completed"),
                tool(5, "d1", "crew_delegate", "running"),
                crew(
                    "task.started",
                    6,
                    "w1",
                    "worker",
                    json!({"title": "Build the parser"}),
                ),
                crew(
                    "task.started",
                    6,
                    "e1",
                    "expert",
                    json!({"title": "Review the grammar"}),
                ),
                crew(
                    "task.progress",
                    20,
                    "w1",
                    "worker",
                    json!({"summary": "Writing tests"}),
                ),
            ],
            true,
        )
    }

    /// One crew task failed, another is still going.
    pub fn failed() -> Thread {
        thread(
            vec![
                tool(2, "r1", "Read", "completed"),
                crew(
                    "task.started",
                    5,
                    "w1",
                    "worker",
                    json!({"title": "Fix the build"}),
                ),
                crew(
                    "task.started",
                    5,
                    "e1",
                    "expert",
                    json!({"title": "Check the types"}),
                ),
                crew(
                    "task.completed",
                    30,
                    "w1",
                    "worker",
                    json!({"status": "failed", "summary": "cargo build failed", "usage": {"inputTokens": 900, "outputTokens": 300}}),
                ),
            ],
            true,
        )
    }

    /// A workflow of two phases and four agents; `done` has them all ended, otherwise the second
    /// phase is still running.
    pub fn workflow(done: bool) -> Thread {
        workflow_in(done, !done)
    }

    /// The workflow of `workflow`, whose agents are all in when `done`, while the lead's turn is
    /// `running` or over (the lead still writes its answer after the last agent reports).
    pub fn workflow_in(done: bool, running: bool) -> Thread {
        let wf = |kind: &str, sec: i64, id: &str, extra: Value| {
            let mut payload = json!({"taskId": id, "agentKind": "agent", "title": id});
            for (key, value) in extra.as_object().into_iter().flatten() {
                payload[key] = value.clone();
            }
            act(kind, sec, payload)
        };
        let mut all = vec![wf(
            "task.started",
            2,
            "wf1",
            json!({
                "taskType": "local_workflow", "workflowName": "Release check",
                "phases": [{"index": 0, "title": "Collect"}, {"index": 1, "title": "Verify"}],
            }),
        )];
        for (n, phase, sec) in [(0, 0, 3), (1, 0, 3), (2, 1, 20), (3, 1, 20)] {
            let id = format!("wf1:wf:{n}");
            all.push(wf(
                "task.started",
                sec,
                &id,
                json!({"parentAgentId": "wf1", "agentIndex": n, "phaseIndex": phase, "title": format!("Agent {n}"), "role": "Reviewer"}),
            ));
            if done || phase == 0 {
                all.push(wf(
                    "task.completed",
                    sec + 10,
                    &id,
                    json!({"status": "completed", "summary": "ok", "title": format!("Agent {n}"), "typedUsage": {"totalTokens": 1200, "toolUses": 3}}),
                ));
            }
        }
        if done {
            all.push(wf(
                "task.completed",
                40,
                "wf1",
                json!({"status": "completed"}),
            ));
        }
        thread(all, running)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{LAVENDER, UNICODE};

    #[test]
    fn every_tab_lights_its_own_title_and_the_bar_fits_the_narrowest_panel() {
        let ctx = Ctx::new(&LAVENDER, &UNICODE, 0, false);
        for view in View::ALL {
            let rows = head(&ctx, view, 33);
            let bar: String = rows[0].iter().map(|s| s.content.as_ref()).collect();
            let rule: String = rows[1].iter().map(|s| s.content.as_ref()).collect();
            assert_eq!(bar, " Workflow │ Agents │ Savvy │ Files");
            assert_eq!(
                width(&rule),
                34,
                "the rule is as wide as the room and its margin"
            );
            let lit: Vec<_> = rows[1].iter().filter(|s| s.style == ctx.accent()).collect();
            assert_eq!(lit.len(), 1);
            assert_eq!(width(&lit[0].content), width(view.title()), "{view:?}");
        }
    }

    #[test]
    fn a_click_lands_on_the_title_under_it_and_the_gaps_are_no_tab() {
        let title_starts = [
            (0, View::Workflow),
            (11, View::Agents),
            (20, View::Savvy),
            (28, View::Files),
        ];
        for (start, view) in title_starts {
            assert_eq!(tab_at(start), Some(view));
            assert_eq!(tab_at(start + width(view.title()) - 1), Some(view));
            assert_eq!(
                tab_at(start + width(view.title())),
                None,
                "the gap after {view:?}"
            );
        }
        assert_eq!(tab_at(33), None);
        assert_eq!(tab_at(500), None);
    }
}
