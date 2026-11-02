//! The Workflow panel: the thread's flows (one per turn, one per provider workflow) drawn as the
//! desktop board does, waves from top to bottom with a card for each agent and a connector between
//! waves. A port of apps/oop-tui/src/app/workflowPanel.ts as a pure function from the read model
//! to lines. The flow shown is the one pinned with `/dag-workflow N|next|prev` or else the live one.
//! Left out: the switch/close hint row under the tabs (the caller owns the keys).

use crate::flow::{
    FlowInput, Graph, GraphKind, Node, NodeState, Role, flows, focus_pinned, model_label,
    node_elapsed_ms,
};
use crate::panels_common::*;
use crate::theme::{Symbols, Theme};
use ratatui::style::Style;
use ratatui::text::Line;
use std::collections::BTreeMap;

/// The workflow panel as lines for a pane `width` x `height` cells.
pub fn lines(
    input: &FlowInput,
    width: usize,
    height: usize,
    th: &Theme,
    sym: &Symbols,
) -> Vec<Line<'static>> {
    let ctx = Ctx::new(th, sym, input.tick, input.animations);
    let room = width.saturating_sub(2).max(8);
    let mut out = head(&ctx, View::Workflow, room);
    if input.loading {
        out.extend(say(
            &ctx,
            s("Loading the workflow…", "작업 흐름을 불러오는 중…"),
            room,
        ));
        return finish(&ctx, out, width, height);
    }
    if !input.online {
        out.push(margin(clip(
            vec![sp(
                s(
                    "Disconnected · showing what arrived last",
                    "연결 끊김 · 마지막으로 받은 내용",
                ),
                ctx.warning(),
            )],
            room,
        )));
    }
    let graphs = flows(input.thread, input.lead_model.as_deref());
    let Some(focused) = focus_pinned(&graphs, input.pinned.as_deref()) else {
        out.extend(empty_state(
            &ctx,
            s("No work to draw yet", "그릴 작업이 아직 없습니다"),
            s(
                "Steps appear here once an agent uses a tool or starts a subagent or workflow.",
                "에이전트가 도구를 쓰거나 서브에이전트·workflow 를 시작하면 단계가 여기에 나타납니다.",
            ),
            room,
        ));
        return finish(&ctx, out, width, height);
    };
    let flow = &graphs[focused];

    if graphs.len() > 1 {
        let limit = height.saturating_sub(10).clamp(1, 4);
        let mut shown: Vec<usize> = (0..graphs.len().min(limit)).collect();
        if focused >= limit {
            shown.push(focused);
        }
        let earlier = graphs.len() - shown.len();
        out.push(margin(clip(
            vec![sp(
                fill(
                    s("{count} flows", "흐름 {count}개"),
                    &[("count", graphs.len().to_string())],
                ),
                ctx.dim(),
            )],
            room,
        )));
        for at in shown {
            let chip = &graphs[at];
            let picked = at == focused;
            let counts = Counts::of(chip);
            let mut row: Row = vec![
                sp(if picked { ctx.g.prompt } else { " " }, ctx.accent()),
                sp(format!(" {} ", at + 1), ctx.text()),
                sp(ctx.mark(chip.status), ctx.tone(chip.status)),
                sp(
                    format!(" {}", flow_name(chip)),
                    if picked { ctx.bold() } else { ctx.text() },
                ),
            ];
            if counts.total > 0 {
                row.push(sp(
                    format!(" {}/{}", counts.completed, counts.total),
                    ctx.dim(),
                ));
            }
            if counts.failed > 0 {
                row.push(sp(
                    format!(" {}", count_word("failed", counts.failed)),
                    ctx.error(),
                ));
            }
            out.push(margin(clip(row, room)));
        }
        if earlier > 0 {
            out.push(margin(vec![sp(
                fill(
                    s("{count} earlier", "이전 {count}개"),
                    &[("count", earlier.to_string())],
                ),
                ctx.dim(),
            )]));
        }
    }

    let counts = Counts::of(flow);
    let mut title: Row = vec![
        sp(ctx.mark(flow.status), ctx.tone(flow.status)),
        sp(format!(" {}", flow_name(flow)), ctx.bold()),
        sp(format!("  {}", state_word(flow.status)), ctx.dim()),
    ];
    if flow.kind == GraphKind::Workflow {
        title.push(sp(format!(" · {}", role_word(Role::Workflow)), ctx.dim()));
    }
    out.push(margin(clip(title, room)));
    if counts.total > 0 {
        out.push(margin(clip(vec![sp(counts.words(), ctx.dim())], room)));
        let mut bar = progress_bar(&ctx, &counts, room.saturating_sub(8).clamp(4, 24));
        bar.push(sp(
            format!(
                " {}/{}",
                counts.completed + counts.failed + counts.stopped,
                counts.total
            ),
            ctx.dim(),
        ));
        out.push(margin(bar));
    }
    out.push(vec![]);
    let (body, focus) = wave_block(&ctx, flow, input.now_ms, room - 1);
    let body: Vec<Row> = body.into_iter().map(margin).collect();
    let free = height.saturating_sub(out.len());
    out.extend(window_scrolled(&ctx, body, focus, free, input.scroll));
    finish(&ctx, out, width, height)
}

/// Something runs, so the clock matters.
pub fn is_live(input: &FlowInput) -> bool {
    !input.loading
        && flows(input.thread, input.lead_model.as_deref())
            .iter()
            .any(|flow| {
                flow.nodes
                    .iter()
                    .any(|node| node.state == NodeState::Running)
            })
}

// ---- the head of a flow ---------------------------------------------------------------------------

/// A flow's own members: its agents, without the main agent.
struct Counts {
    total: usize,
    completed: usize,
    failed: usize,
    stopped: usize,
    running: usize,
}

impl Counts {
    fn of(flow: &Graph) -> Counts {
        let members = || {
            flow.nodes
                .iter()
                .filter(|n| n.role != Role::Main)
                .map(|n| n.state)
        };
        let of = |state| members().filter(|s| *s == state).count();
        Counts {
            total: members().count(),
            completed: of(NodeState::Completed),
            failed: of(NodeState::Failed),
            stopped: of(NodeState::Cancelled),
            running: of(NodeState::Running),
        }
    }

    fn words(&self) -> String {
        [
            ("completed", self.completed),
            ("failed", self.failed),
            ("stopped", self.stopped),
            ("running", self.running),
        ]
        .iter()
        .filter(|(_, n)| *n > 0)
        .map(|(kind, n)| count_word(kind, *n))
        .collect::<Vec<_>>()
        .join(" · ")
    }
}

fn flow_name(flow: &Graph) -> String {
    match flow.turn_index {
        None => flat(&flow.name),
        Some(index) => {
            let turn = fill(
                s("Turn {index}", "턴 {index}"),
                &[("index", index.to_string())],
            );
            if flow.kind == GraphKind::Crew {
                format!("{turn} · Crew")
            } else {
                turn
            }
        }
    }
}

fn progress_bar(ctx: &Ctx, counts: &Counts, bar_width: usize) -> Row {
    let cells = |n: usize| (n * bar_width + counts.total.max(1) / 2) / counts.total.max(1);
    let done = cells(counts.completed).min(bar_width);
    let failed = cells(counts.failed).min(bar_width - done);
    let stopped = cells(counts.stopped).min(bar_width - done - failed);
    let rest = bar_width - done - failed - stopped;
    vec![
        sp(ctx.g.full.repeat(done), ctx.success()),
        sp(ctx.g.full.repeat(failed), ctx.error()),
        sp(ctx.g.full.repeat(stopped), ctx.dim()),
        sp(ctx.g.rule.repeat(rest), ctx.dim()),
    ]
}

// ---- the waves ------------------------------------------------------------------------------------

/// Column titles the shared code builds in English; a workflow's own phase titles pass through.
fn wave_title(title: Option<&String>, index: usize) -> String {
    let wave = || {
        fill(
            s("Wave {index}", "웨이브 {index}"),
            &[("index", (index + 1).to_string())],
        )
    };
    let Some(title) = title.filter(|t| !t.is_empty()) else {
        return wave();
    };
    match title.as_str() {
        "Main agent" => role_word(Role::Main).to_string(),
        "Delegated work" => s("Delegated work", "위임된 작업").to_string(),
        "Review" => s("Review", "검토").to_string(),
        "Next" => s("Next", "다음").to_string(),
        other => {
            let numbered = |prefix: &str| {
                other
                    .strip_prefix(prefix)
                    .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            };
            if let Some(n) = numbered("Step ") {
                fill(
                    s("Step {index}", "단계 {index}"),
                    &[("index", n.to_string())],
                )
            } else if let Some(n) = numbered("Wave ") {
                fill(
                    s("Wave {index}", "웨이브 {index}"),
                    &[("index", n.to_string())],
                )
            } else {
                flat(other)
            }
        }
    }
}

fn node_name(node: &Node) -> String {
    let task = node.task.as_deref().map(flat).unwrap_or_default();
    [role_word(node.role).to_string(), task]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Where a node stands; a crew task that stopped partway says how.
fn node_state_word(node: &Node) -> &'static str {
    if node.state == NodeState::Failed {
        match node.outcome.as_deref() {
            Some("blocked") => return s("Blocked", "차단됨"),
            Some("partial") => return s("Partly done", "일부 완료"),
            _ => {}
        }
    }
    state_word(node.state)
}

/// The desktop board's rule: a card is dim until its step has begun.
fn has_begun(node: &Node) -> bool {
    matches!(
        node.state,
        NodeState::Running | NodeState::Completed | NodeState::Failed | NodeState::Paused
    ) || node.started_at.is_some()
}

/// What a card says the agent does or did: the main agent's work, or the task it was given.
fn card_body(node: &Node) -> String {
    match &node.main {
        Some(work) => {
            let mut parts: Vec<String> = Vec::new();
            if let Some(n) = work.delegated {
                parts.push(fill(
                    s(
                        "Delegated {count} tasks to Crew",
                        "Crew 에 작업 {count}개 위임",
                    ),
                    &[("count", n.to_string())],
                ));
            }
            parts.extend(work.tools.iter().map(|tool| tool_word(*tool)));
            parts.join(" · ")
        }
        None => flat(
            node.task
                .as_deref()
                .or(node.progress.as_deref())
                .unwrap_or(""),
        ),
    }
}

/// One agent as the desktop board's card: a frame (accent while it runs, red once it failed), the
/// state mark and the role with the evidence at the right, the model, what it does, and a status
/// line in the colour of its state with the time, tokens and cost.
fn card(ctx: &Ctx, node: &Node, upstream: &[&Node], width: usize, now_ms: i64) -> Vec<Row> {
    let inner = width.saturating_sub(4).max(4);
    let tone = ctx.tone(node.state);
    let frame = match node.state {
        NodeState::Running => ctx.accent(),
        NodeState::Failed => ctx.error(),
        _ => ctx.dim(),
    };
    let mut rows: Vec<Row> = Vec::new();

    let evidence = node
        .evidence
        .map_or(String::new(), |e| format!(" [{}]", evidence_word(e)));
    let title_style = if has_begun(node) {
        ctx.bold()
    } else {
        ctx.dim().add_modifier(ratatui::style::Modifier::BOLD)
    };
    let mut title = clip(
        vec![
            sp(ctx.mark(node.state), tone),
            sp(" ", ctx.text()),
            sp(role_word(node.role), title_style),
        ],
        inner.saturating_sub(evidence.chars().count()).max(2),
    );
    if !evidence.is_empty() {
        title.push(sp(evidence, ctx.dim()));
    }
    rows.push(title);

    if let Some(model) = node.model.as_deref().map(|m| flat(&model_label(m, None)))
        && !model.is_empty()
    {
        rows.push(vec![sp(model, ctx.dim())]);
    }

    let body = card_body(node);
    if !body.is_empty() {
        let mut lines = wrap_rows(&body, inner);
        // An agent's task gets two lines, as on the desktop.
        if lines.len() > 2 {
            lines.truncate(2);
            let last = lines.pop().unwrap_or_default();
            lines.push(format!("{last}…"));
        }
        rows.extend(lines.into_iter().map(|l| cut(&l, ctx.text(), inner)));
    }

    let doing = node
        .main
        .as_ref()
        .and_then(|work| work.doing)
        .filter(|_| node.state == NodeState::Running)
        .map(|d| doing_word(d).to_string());
    let mut facts = vec![doing.unwrap_or_else(|| node_state_word(node).to_string())];
    if let Some(elapsed) = node_elapsed_ms(node, now_ms) {
        facts.push(format_elapsed(elapsed));
    }
    if let Some(tokens) = node.tokens {
        facts.push(tokens_word(tokens));
    }
    if let Some(cost) = node.cost {
        facts.push(format_cost(cost));
    }
    rows.extend(
        pack_facts(&facts, inner)
            .into_iter()
            .map(|l| vec![sp(l, tone)]),
    );

    if !upstream.is_empty() {
        let names: Vec<String> = upstream.iter().take(3).map(|n| node_name(n)).collect();
        let more = if upstream.len() > 3 {
            fill(
                s(" and {count} more", " 외 {count}"),
                &[("count", (upstream.len() - 3).to_string())],
            )
        } else {
            String::new()
        };
        let text = fill(
            s("After: {names}{more}", "선행: {names}{more}"),
            &[("names", names.join(", ")), ("more", more)],
        );
        rows.extend(wrapped(&text, ctx.dim(), inner));
    }
    if let Some(error) = node.error.as_deref() {
        let text = fill(s("Error: {text}", "오류: {text}"), &[("text", flat(error))]);
        rows.extend(wrapped(&text, ctx.error(), inner));
    }

    let [tl, tr, bl, br] = ctx.g.corners;
    let edge = ctx.g.horizontal.repeat(width - 2);
    let side = |style: Style| sp(ctx.g.vertical, style);
    let mut card: Vec<Row> = vec![vec![sp(format!("{tl}{edge}{tr}"), frame)]];
    for row in rows {
        let mut line = vec![side(frame), sp(" ", ctx.text())];
        line.extend(pad(clip(row, inner), inner));
        line.extend([sp(" ", ctx.text()), side(frame)]);
        card.push(line);
    }
    card.push(vec![sp(format!("{bl}{edge}{br}"), frame)]);
    card
}

fn wrap_rows(text: &str, max: usize) -> Vec<String> {
    crate::text::wrap(text, max)
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Link {
    Idle,
    Done,
    Failed,
    Active,
}

/// How the link into a wave looks: a live edge over a failed one over a finished one.
fn link_tone(from: &[&Node], to: &[&Node], edges: &[(String, String)]) -> Link {
    edges
        .iter()
        .filter_map(|(a, b)| {
            let a = from.iter().find(|n| n.id == *a)?;
            let b = to.iter().find(|n| n.id == *b)?;
            Some(if b.state == NodeState::Running {
                Link::Active
            } else if a.state == NodeState::Failed {
                Link::Failed
            } else if a.state == NodeState::Completed {
                Link::Done
            } else {
                Link::Idle
            })
        })
        .max_by_key(|link| match link {
            Link::Active => 3,
            Link::Failed => 2,
            Link::Done => 1,
            Link::Idle => 0,
        })
        .unwrap_or(Link::Idle)
}

/// The two rows between waves: a line and an arrowhead, solid when taken or live, dashed otherwise.
fn connector(ctx: &Ctx, tone: Link) -> Vec<Row> {
    let style = match tone {
        Link::Active => ctx.accent(),
        Link::Done => ctx.success(),
        Link::Failed => ctx.error(),
        Link::Idle => ctx.dim(),
    };
    let line = if matches!(tone, Link::Idle | Link::Failed) {
        ctx.g.link[1]
    } else {
        ctx.g.link[0]
    };
    vec![
        vec![sp("  ", ctx.text()), sp(line, style)],
        vec![sp("  ", ctx.text()), sp(ctx.g.link[2], style)],
    ]
}

/// The flow as the desktop board draws it, waves from top to bottom: a heading with the counts, a
/// card for each agent, and a connector between one wave and the next in the colour of its edges.
/// Returns the lines and the one to keep in view when the body has to scroll.
fn wave_block(ctx: &Ctx, flow: &Graph, now_ms: i64, room: usize) -> (Vec<Row>, usize) {
    let mut columns: BTreeMap<usize, Vec<&Node>> = BTreeMap::new();
    for node in &flow.nodes {
        columns.entry(node.wave).or_default().push(node);
    }
    let order: Vec<usize> = columns.keys().copied().collect();
    let current = order
        .iter()
        .copied()
        .find(|wave| columns[wave].iter().any(|n| !n.state.settled()))
        .or_else(|| order.last().copied());
    let mut lines: Vec<Row> = Vec::new();
    let mut focus = 0;
    for (position, wave) in order.iter().enumerate() {
        let nodes = &columns[wave];
        if position > 0 {
            let tone = link_tone(&columns[&order[position - 1]], nodes, &flow.edges);
            lines.extend(connector(ctx, tone));
        }
        if Some(*wave) == current {
            focus = lines.len();
        }
        // A single column needs no heading, as on the desktop board.
        if order.len() > 1 {
            let settled = nodes.iter().filter(|n| n.state.settled()).count();
            let failed = nodes
                .iter()
                .filter(|n| n.state == NodeState::Failed)
                .count();
            let running = nodes
                .iter()
                .filter(|n| n.state == NodeState::Running)
                .count();
            let style = if Some(*wave) == current {
                ctx.accent().add_modifier(ratatui::style::Modifier::BOLD)
            } else {
                ctx.bold()
            };
            let title = wave_title(flow.wave_titles.get(*wave), *wave);
            let mut heading: Row = vec![
                sp(format!("{}. {}", position + 1, title), style),
                sp(format!(" {}/{}", settled, nodes.len()), ctx.dim()),
            ];
            let mut extra = |text: String, style: Style| {
                heading.push(sp(" · ", ctx.dim()));
                heading.push(sp(text, style));
            };
            if nodes.len() > 1 {
                extra(
                    fill(
                        s("{count} in parallel", "병렬 {count}"),
                        &[("count", nodes.len().to_string())],
                    ),
                    ctx.dim(),
                );
            }
            if failed > 0 {
                extra(count_word("failed", failed), ctx.error());
            }
            if running > 0 {
                extra(count_word("running", running), ctx.accent());
            }
            lines.push(clip(heading, room));
        }
        for node in nodes {
            let upstream: Vec<&Node> = flow
                .edges
                .iter()
                .filter(|(_, to)| *to == node.id)
                .filter_map(|(from, _)| flow.nodes.iter().find(|n| n.id == *from))
                .collect();
            lines.extend(card(ctx, node, &upstream, room, now_ms));
        }
    }
    (lines, focus)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::panels_common::scenes::{self, input};
    use crate::theme::{ASCII, LAVENDER, UNICODE};
    use crate::thread::Thread;

    fn render(thread: &Thread, now: i64, width: usize, height: usize) -> Vec<String> {
        plain(&lines(
            &input(thread, &[], now),
            width,
            height,
            &LAVENDER,
            &UNICODE,
        ))
    }

    fn has(text: &[String], needle: &str) -> bool {
        text.iter().any(|line| line.contains(needle))
    }

    #[test]
    fn lead_only_is_one_card_without_a_heading() {
        let text = render(&scenes::lead_only(), 30, 60, 40);
        assert!(has(&text, "Turn 1"));
        assert!(has(&text, "Main agent"));
        assert!(has(&text, "2 files read"));
        assert!(has(&text, "opus-5"));
        // One column needs no wave heading and no member counts.
        assert!(!has(&text, "1. "));
        assert!(!has(&text, "done"));
    }

    #[test]
    fn two_parallel_crew_tasks_share_a_wave_below_the_lead() {
        let text = render(&scenes::parallel(), 45, 60, 50);
        assert!(has(&text, "1. Main agent 0/1"));
        assert!(has(
            &text,
            "2. Delegated work 0/2 · 2 in parallel · 2 running"
        ));
        assert!(has(&text, "Delegated 2 tasks to Crew"));
        assert!(has(&text, "Expert"));
        assert!(has(&text, "Worker"));
        assert!(has(&text, "Build the parser"));
        assert!(has(&text, "After: Main agent"));
        // The connector between the waves is a solid line and an arrowhead.
        let at = text
            .iter()
            .position(|l| l.contains("2. Delegated work"))
            .expect("heading");
        assert!(text[at - 2].trim() == "│" && text[at - 1].trim() == "▼");
        assert!(has(&text, "2 running"));
    }

    #[test]
    fn a_failed_task_is_red_and_says_why() {
        let thread = scenes::failed();
        let lines = lines(&input(&thread, &[], 45), 60, 50, &LAVENDER, &UNICODE);
        let text = plain(&lines);
        assert!(has(&text, "1 failed"));
        assert!(has(&text, "Failed · 25s · 1.2k tokens"));
        assert!(has(&text, "1 failed · 1 running"));
        let mark = lines
            .iter()
            .flat_map(|l| l.spans.iter())
            .find(|s| s.content.contains('✗'))
            .expect("failed mark");
        assert_eq!(mark.style.fg, Some(LAVENDER.error));
    }

    #[test]
    fn a_finished_workflow_lists_its_phases_and_counts() {
        let text = render(&scenes::workflow(true), 60, 60, 50);
        assert!(has(&text, "Release check  Done · Workflow"));
        assert!(has(&text, "4 done"));
        assert!(has(&text, "4/4"));
        assert!(has(&text, "1. Collect") || has(&text, "1. Wave 1"));
        assert!(has(&text, "2 in parallel"));
        assert!(!has(&text, "running"));
    }

    #[test]
    fn a_running_workflow_is_one_of_several_flows() {
        let text = render(&scenes::workflow(false), 45, 60, 50);
        assert!(has(&text, "2 flows"));
        assert!(has(&text, "❯ 1 ◐ Release check 2/4"));
        assert!(has(&text, "2 done · 2 running"));
    }

    #[test]
    fn a_pinned_flow_is_shown_instead_of_the_live_one() {
        let thread = scenes::workflow(false);
        let mut pinned = input(&thread, &[], 45);
        pinned.pinned = Some("turn:t1".into());
        let text = plain(&lines(&pinned, 60, 50, &LAVENDER, &UNICODE));
        assert!(has(&text, "❯ 2 "), "{text:?}");
        assert!(!has(&text, "❯ 1 "));
        // A pin that is no longer a flow of the thread falls back to the live one.
        pinned.pinned = Some("turn:gone".into());
        let text = plain(&lines(&pinned, 60, 50, &LAVENDER, &UNICODE));
        assert!(has(&text, "❯ 1 "));
    }

    #[test]
    fn offline_the_panel_says_it_shows_what_arrived_last() {
        let thread = scenes::lead_only();
        let mut offline = input(&thread, &[], 30);
        offline.online = false;
        let text = plain(&lines(&offline, 60, 40, &LAVENDER, &UNICODE));
        assert!(has(&text, "Disconnected · showing what arrived last"));
        let online = render(&thread, 30, 60, 40);
        assert!(!has(&online, "Disconnected"));
    }

    #[test]
    fn the_wheel_moves_a_long_body_and_stops_at_both_ends() {
        let thread = scenes::parallel();
        let scroll = std::cell::Cell::new(0);
        let mut scrolled = input(&thread, &[], 45);
        scrolled.scroll = Some(&scroll);
        let top = plain(&lines(&scrolled, 60, 12, &LAVENDER, &UNICODE));
        scroll.set(1000);
        let bottom = plain(&lines(&scrolled, 60, 12, &LAVENDER, &UNICODE));
        assert_ne!(top, bottom, "the body moved");
        assert!(has(&bottom, "lines above"));
        assert!(!has(&bottom, "lines below"), "{bottom:?}");
        let moved = scroll.get();
        assert!(
            moved > 0 && moved < 1000,
            "clamped and written back: {moved}"
        );
        scroll.set(-1000);
        let back = plain(&lines(&scrolled, 60, 12, &LAVENDER, &UNICODE));
        assert!(!has(&back, "lines above"), "{back:?}");
    }

    #[test]
    fn empty_and_loading_threads_say_so() {
        let empty = Thread::default();
        let text = render(&empty, 0, 60, 20);
        assert!(has(&text, "No work to draw yet"));
        assert!(has(&text, "Steps appear here"));
        let mut waiting = input(&empty, &[], 0);
        waiting.loading = true;
        let text = plain(&lines(&waiting, 60, 20, &LAVENDER, &UNICODE));
        assert!(has(&text, "Loading the workflow…"));
        assert!(!has(&text, "No work to draw yet"));
        assert!(!is_live(&waiting));
    }

    #[test]
    fn the_clock_runs_only_while_something_works() {
        let running = scenes::parallel();
        assert!(is_live(&input(&running, &[], 45)));
        let done = scenes::workflow(true);
        assert!(!is_live(&input(&done, &[], 60)));
        assert!(!is_live(&input(&Thread::default(), &[], 0)));
        // Elapsed time follows the clock handed in.
        assert!(has(&render(&running, 45, 60, 50), "44s"));
        assert!(has(&render(&running, 105, 60, 50), "1m 44s"));
    }

    #[test]
    fn a_running_mark_turns_with_the_tick_when_animations_are_on() {
        let thread = scenes::lead_only();
        let mut a = input(&thread, &[], 30);
        a.animations = true;
        let mut b = a.clone();
        b.tick = 1;
        let first = plain(&lines(&a, 60, 40, &LAVENDER, &UNICODE));
        let second = plain(&lines(&b, 60, 40, &LAVENDER, &UNICODE));
        assert!(first.iter().any(|l| l.contains('◒')));
        assert!(second.iter().any(|l| l.contains('◐')) && !second.iter().any(|l| l.contains('◒')));
    }

    #[test]
    fn nothing_is_wider_than_the_pane_in_either_symbol_set() {
        let scenes = [
            scenes::lead_only(),
            scenes::parallel(),
            scenes::failed(),
            scenes::workflow(true),
            scenes::workflow(false),
            scenes::korean(),
            Thread::default(),
        ];
        for thread in &scenes {
            for (width, height) in [(12, 6), (20, 10), (33, 25), (60, 20), (100, 60)] {
                for sym in [&UNICODE, &ASCII] {
                    let lines = lines(&input(thread, &[], 45), width, height, &LAVENDER, sym);
                    assert!(lines.len() <= height);
                    for line in &lines {
                        let text: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
                        assert!(
                            crate::text::width(&text) <= width,
                            "{width}x{height}: {text:?}"
                        );
                        if sym.rule == "-" {
                            // Only the thread's own words may stay wide; every mark is plain.
                            let marks = "─━│┆╭╮╰╯▼›┌└◆○◌◐◒◓◑‖✓✗■●·…↑↓";
                            assert!(!text.chars().any(|c| marks.contains(c)), "{text:?}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn snapshot_60x20() {
        let text = render(&scenes::parallel(), 45, 60, 20);
        let expected = [
            " Workflow │ Agents",
            " ━━━━━━━━──────────────────────────────────────────────────",
            " ◐ Turn 1 · Crew  Working",
            " 2 running",
            " ──────────────────────── 0/2",
            "",
            " 1. Main agent 0/1 · 1 running",
            " ╭───────────────────────────────────────────────────────╮",
            " │ ◐ Main agent                                          │",
            " │ opus-5                                                │",
            " │ Delegated 2 tasks to Crew · 2 files read              │",
            " │ Waiting for the team… · 44s                           │",
            " ╰───────────────────────────────────────────────────────╯",
            "   │",
            "   ▼",
            " 2. Delegated work 0/2 · 2 in parallel · 2 running",
            " ╭───────────────────────────────────────────────────────╮",
            " │ ◐ Expert                                              │",
            " │ sonnet-5                                              │",
            "↓ 10 lines below",
        ];
        assert_eq!(text, expected);
    }
}
