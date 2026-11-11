//! The thread usage footer: one dim line under the conversation saying what the thread has used, the
//! same line the web chat shows (`formatThreadUsageFooter` in
//! apps/web/src/components/chat/threadUsageText.ts). The cache rate and the per-model costs come
//! from the server's `thread.usageSummary`; the context part comes from the thread's own latest
//! `context-window.updated` activity, so it needs no request.
//!
//! The summary is asked for when a thread opens and again when a turn settles, never while a turn
//! runs (the numbers would be half a turn old). A server from before the method answers with a
//! failure; the line is then simply left out, with nothing said about it.
//!
//! `footer` and `context` are pure; the rest fetches, holds the answer and draws it.

use crate::app::{Active, App, Msg};
use crate::i18n::{Lang, lang, tr_in_lang};
use crate::panels_common::{fill, flat};
use crate::text::truncate;
use crate::thread::Thread;
use ratatui::text::{Line, Span};
use serde_json::{Value, json};

/// The one-shot request the line is made from.
pub const SUMMARY_RPC: &str = "thread.usageSummary";

/// What the server said one model cost in a thread.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Cost {
    /// The provider reported what it billed.
    Reported(f64),
    /// Priced from API list prices.
    Estimated(f64),
    /// No price for this model: the line says so in words.
    #[default]
    Unknown,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Model {
    pub model: String,
    pub cost: Cost,
}

/// The part of `thread.usageSummary` the line reads.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Summary {
    /// `ok`, or `too-large` when the thread is bigger than the server will total up.
    pub status: String,
    /// The share of input tokens that came from the cache, 0..1; `None` when nothing reported it.
    pub cache_rate: Option<f64>,
    pub models: Vec<Model>,
}

impl Summary {
    fn usable(&self) -> bool {
        self.status == "ok"
    }
}

/// The answer as the line reads it; `None` for anything that is not an object with a status.
pub fn parse(value: &Value) -> Option<Summary> {
    if !value.is_object() {
        return None;
    }
    Some(Summary {
        status: value["status"].as_str().unwrap_or("ok").to_string(),
        cache_rate: value["totals"]["cacheRate"]
            .as_f64()
            .filter(|rate| rate.is_finite()),
        models: value["models"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|row| Model {
                model: flat(row["model"].as_str().unwrap_or_default()),
                cost: parse_cost(&row["cost"]),
            })
            .collect(),
    })
}

fn parse_cost(cost: &Value) -> Cost {
    let usd = cost["usd"].as_f64().filter(|usd| usd.is_finite());
    match (cost["kind"].as_str(), usd) {
        (Some("reported"), Some(usd)) => Cost::Reported(usd),
        (Some("estimated"), Some(usd)) => Cost::Estimated(usd),
        _ => Cost::Unknown,
    }
}

/// The thread's latest usable `context-window.updated`: the tokens in use and the window size when
/// the report named one. The same rule as `thread::resolvable_context_window` and the web app's
/// `deriveLatestContextWindowSnapshot`.
pub fn context(thread: &Thread) -> Option<(f64, Option<f64>)> {
    let report = thread.activities.iter().rev().find(|a| {
        a.kind == "context-window.updated"
            && a.payload["usedTokens"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0.0)
    })?;
    let used = report.payload["usedTokens"].as_f64()?;
    let max = report.payload["maxTokens"]
        .as_f64()
        .filter(|m| m.is_finite() && *m > 0.0);
    Some((used, max))
}

/// The line, as the web chat has it: cache rate, context, then one part per model, joined by ` · `.
/// Korean or English comes from the caller so the tests do not depend on the running language.
pub fn footer(summary: Option<&Summary>, context: Option<(f64, Option<f64>)>, ko: bool) -> String {
    let usable = summary.filter(|s| s.usable());
    let mut parts: Vec<String> = Vec::new();
    if let Some(rate) = usable.and_then(|s| s.cache_rate) {
        parts.push(fill(
            tr_in_lang("usage.cache", ko),
            &[("rate", cache_percent(rate))],
        ));
    }
    if let Some((used, max)) = context {
        parts.push(fill(
            tr_in_lang("usage.context", ko),
            &[("usage", context_usage(used, max))],
        ));
    }
    for row in usable.map(|s| s.models.as_slice()).unwrap_or_default() {
        parts.push(format!("{} {}", row.model, cost_text(row.cost, ko)));
    }
    parts.join(" · ")
}

fn context_usage(used: f64, max: Option<f64>) -> String {
    let mut usage = context_tokens(used);
    if let Some(max) = max {
        usage.push_str(&format!(" / {}", context_tokens(max)));
        usage.push_str(&format!(" ({:.0}%)", (used / max * 100.0).min(100.0)));
    }
    usage
}

/// `950`, `1.2k`, `118k`, `1.5m`: the web app's `formatContextWindowTokens`.
fn context_tokens(value: f64) -> String {
    let value = value.round();
    if value < 1_000.0 {
        format!("{value:.0}")
    } else if value < 10_000.0 {
        let text = format!("{:.1}", value / 1_000.0);
        format!("{}k", text.strip_suffix(".0").unwrap_or(&text))
    } else if value < 1_000_000.0 {
        format!("{}k", (value / 1_000.0).round())
    } else {
        let text = format!("{:.1}", value / 1_000_000.0);
        format!("{}m", text.strip_suffix(".0").unwrap_or(&text))
    }
}

/// `97.8%`: the web app's `formatPercent` with one decimal.
fn cache_percent(share: f64) -> String {
    let percent = share * 100.0;
    if percent > 0.0 && percent < 0.1 {
        return "<0.1%".to_string();
    }
    format!("{percent:.1}%")
}

fn cost_text(cost: Cost, ko: bool) -> String {
    match cost {
        Cost::Reported(usd) => format!("${usd:.2}"),
        Cost::Estimated(usd) => format!("≈${usd:.2}"),
        Cost::Unknown => tr_in_lang("usage.costUnknown", ko).to_string(),
    }
}

fn audit_text(model: Option<&str>, ko: bool) -> String {
    let text = tr_in_lang("usage.audit", ko);
    match model.filter(|m| !m.is_empty()) {
        Some(model) => format!("{text} · {}", flat(model)),
        None => text.to_string(),
    }
}

/// What the footer keeps between requests; `App` holds one.
#[derive(Default)]
pub struct State {
    /// The thread the summary belongs to: another thread's is not shown.
    thread_id: String,
    summary: Option<Summary>,
    /// A turn was running at the last look, to notice it settling.
    running: bool,
    /// The open thread's running audit and its model, kept from the last update so drawing does
    /// not fold the activities again.
    audit: Option<Option<String>>,
}

/// The thread on screen just changed (opened, or its stream restarted): the line is asked for again
/// and an answer for another thread is dropped.
pub fn opened(app: &mut App, id: &str) {
    if app.usage.thread_id != id {
        app.usage.summary = None;
    }
    app.usage.thread_id = id.to_string();
    app.usage.running = app.conv.busy();
    app.usage.audit = crate::flow::running_crew_audit(&app.conv.thread.activities);
    request(app);
}

/// One update of the open thread: a turn that just settled asks for the numbers again.
pub fn on_thread(app: &mut App) {
    if app.thread_id().as_deref() != Some(app.usage.thread_id.as_str()) {
        return;
    }
    let running = app.conv.busy();
    let audit = crate::flow::running_crew_audit(&app.conv.thread.activities);
    let settled = (app.usage.running || app.usage.audit.is_some()) && !running && audit.is_none();
    app.usage.audit = audit;
    app.usage.running = running;
    if settled {
        request(app);
    }
}

fn request(app: &mut App) {
    let (Some(id), Some(rpc)) = (app.thread_id(), app.rpc.clone()) else {
        return;
    };
    // A command that connects once runs outside a runtime: there is no thread to wait on.
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    let tx = app.sender();
    tokio::spawn(async move {
        let result = rpc.call(SUMMARY_RPC, json!({"threadId": id})).await;
        let _ = tx.send(Msg::Ext(Box::new(move |app: &mut App| {
            answered(app, &id, result)
        })));
    });
}

fn answered(app: &mut App, id: &str, result: Result<Value, String>) {
    // The user may have moved on while the server was working.
    if app.usage.thread_id != id {
        return;
    }
    // A server that does not know the method, or any other failure, says nothing: no line, no notice.
    app.usage.summary = result.ok().and_then(|value| parse(&value));
}

/// Puts a server answer on screen without a request, for the drawing tests.
#[cfg(test)]
pub fn show(app: &mut App, value: &Value) {
    app.usage.thread_id = app.thread_id().unwrap_or_default();
    app.usage.summary = parse(value);
}

/// The line to draw under the conversation, or `None` when a turn is running, no thread is open, or
/// the line is empty.
pub fn line(app: &App, width: usize) -> Option<Line<'static>> {
    if !matches!(app.active, Active::Thread(_)) || !app.conv.loaded || app.conv.busy() {
        return None;
    }
    let text = match &app.usage.audit {
        Some(model) => audit_text(model.as_deref(), lang() == Lang::Ko),
        None => footer(
            app.usage.summary.as_ref(),
            context(&app.conv.thread),
            lang() == Lang::Ko,
        ),
    };
    if text.is_empty() {
        return None;
    }
    Some(Line::from(Span::styled(
        format!("  {}", truncate(&text, width.saturating_sub(2))),
        app.theme.dim_style(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd_history::testkit::{connected, next, serve, two_turns};
    use crate::thread::Activity;
    use serde_json::json;

    #[test]
    fn audit_lifecycle_replaces_usage_and_finishes() {
        let event = |kind: &str, id: &str, role: &str| Activity {
            kind: kind.into(),
            payload: json!({"crewRole": role, "taskId": id, "model": "astra"}),
            ..Default::default()
        };
        let mut activities = vec![event("task.started", "a", "auditor")];
        assert_eq!(
            crate::flow::running_crew_audit(&activities),
            Some(Some("astra".into()))
        );
        activities.push(event("task.completed", "a", "auditor"));
        assert_eq!(crate::flow::running_crew_audit(&activities), None);
        activities.push(event("task.progress", "b", "auditor"));
        assert!(crate::flow::running_crew_audit(&activities).is_some());
        assert_eq!(
            audit_text(Some("astra"), false),
            "Auditor is reviewing this answer · astra"
        );
        assert_eq!(audit_text(None, true), "감사자가 이 답변을 검토하는 중");
    }

    #[tokio::test]
    async fn audit_completion_refetches_once_after_lead_settled() {
        let (port, seen) =
            serve(|tag, _| (tag == SUMMARY_RPC).then(|| Ok(json!({"status": "ok"})))).await;
        let (mut app, mut rx) = connected(port, two_turns(json!({})), false).await;
        opened(&mut app, "t1");
        next(&mut app, &mut rx).await;
        let before = seen.lock().unwrap().len();
        app.conv.thread.activities.push(Activity {
            kind: "task.started".into(),
            payload: json!({"crewRole":"auditor", "taskId":"a"}),
            ..Default::default()
        });
        on_thread(&mut app);
        let text = line(&app, 120)
            .unwrap()
            .spans
            .iter()
            .map(|s| s.content.as_ref())
            .collect::<String>();
        assert!(text.contains("Auditor is reviewing this answer"));
        app.conv.thread.activities.push(Activity {
            kind: "task.completed".into(),
            payload: json!({"crewRole":"auditor", "taskId":"a", "status":"completed"}),
            ..Default::default()
        });
        on_thread(&mut app);
        next(&mut app, &mut rx).await;
        assert_eq!(seen.lock().unwrap().len(), before + 1);
        on_thread(&mut app);
        assert_eq!(seen.lock().unwrap().len(), before + 1);
    }

    fn summary(status: &str, cache_rate: Option<f64>) -> Summary {
        Summary {
            status: status.into(),
            cache_rate,
            models: vec![
                Model {
                    model: "claude-opus-5-5".into(),
                    cost: Cost::Reported(4.12),
                },
                Model {
                    model: "gpt-6-astra".into(),
                    cost: Cost::Estimated(0.31),
                },
                Model {
                    model: "glm-5.3".into(),
                    cost: Cost::Unknown,
                },
            ],
        }
    }

    #[test]
    fn the_line_names_the_cache_the_context_and_what_each_model_cost() {
        let summary = summary("ok", Some(0.978));
        assert_eq!(
            footer(Some(&summary), Some((118_000.0, Some(200_000.0))), true),
            "캐시 97.8% · 컨텍스트 118k / 200k (59%) · claude-opus-5-5 $4.12 · gpt-6-astra ≈$0.31 · glm-5.3 비용 알 수 없음"
        );
        assert_eq!(
            footer(Some(&summary), Some((118_000.0, Some(200_000.0))), false),
            "Cache 97.8% · Context 118k / 200k (59%) · claude-opus-5-5 $4.12 · gpt-6-astra ≈$0.31 · glm-5.3 Cost unknown"
        );
    }

    #[test]
    fn reported_estimated_and_unknown_costs_each_read_their_own_way() {
        let rows = [Cost::Reported(4.1), Cost::Estimated(0.3), Cost::Unknown];
        let text: Vec<String> = rows.iter().map(|cost| cost_text(*cost, false)).collect();
        assert_eq!(text, ["$4.10", "≈$0.30", "Cost unknown"]);
        let unknown = Summary {
            status: "ok".into(),
            cache_rate: None,
            models: vec![Model {
                model: "glm".into(),
                cost: Cost::Unknown,
            }],
        };
        assert_eq!(footer(Some(&unknown), None, true), "glm 비용 알 수 없음");
    }

    #[test]
    fn no_cache_rate_drops_the_cache_part_and_leaves_the_models() {
        let summary = summary("ok", None);
        let text = footer(Some(&summary), None, false);
        assert!(!text.contains("Cache"), "{text}");
        assert_eq!(
            text,
            "claude-opus-5-5 $4.12 · gpt-6-astra ≈$0.31 · glm-5.3 Cost unknown"
        );
    }

    #[test]
    fn no_context_drops_the_context_part() {
        let summary = summary("ok", Some(0.5));
        assert_eq!(
            footer(Some(&summary), None, true),
            "캐시 50.0% · claude-opus-5-5 $4.12 · gpt-6-astra ≈$0.31 · glm-5.3 비용 알 수 없음"
        );
        assert_eq!(footer(None, None, true), "");
    }

    #[test]
    fn a_thread_too_large_to_total_up_shows_only_its_context() {
        let summary = summary("too-large", Some(0.98));
        assert_eq!(footer(Some(&summary), None, true), "");
        assert_eq!(
            footer(Some(&summary), Some((15_000.0, Some(200_000.0))), true),
            "컨텍스트 15k / 200k (8%)"
        );
    }

    #[test]
    fn a_context_report_without_a_window_size_shows_no_share() {
        assert_eq!(footer(None, Some((950.0, None)), true), "컨텍스트 950");
        assert_eq!(
            footer(None, Some((1_500_000.0, None)), false),
            "Context 1.5m"
        );
        assert_eq!(footer(None, Some((1_200.0, None)), false), "Context 1.2k");
    }

    #[test]
    fn the_line_is_read_from_the_servers_answer() {
        let value = json!({
            "threadId": "t1", "status": "ok",
            "totals": {"inputTokens": 1000, "cacheRate": 0.3,
                "cost": {"kind": "unknown"}},
            "models": [
                {"model": "opus", "cacheRate": 0.3, "cost": {"kind": "reported", "usd": 4.12}},
                {"model": "astra", "cacheRate": null, "cost": {"kind": "estimated", "usd": 0.31}},
                {"model": "glm", "cacheRate": null}
            ]
        });
        let summary = parse(&value).unwrap();
        assert_eq!(
            (summary.status.as_str(), summary.cache_rate),
            ("ok", Some(0.3))
        );
        assert_eq!(
            footer(Some(&summary), None, true),
            "캐시 30.0% · opus $4.12 · astra ≈$0.31 · glm 비용 알 수 없음"
        );
        assert!(parse(&Value::Null).is_none());
        // A null cache rate and a missing cost both read as "nothing to say".
        let bare = parse(&json!({"status": "too-large"})).unwrap();
        assert_eq!((bare.cache_rate, bare.models.len()), (None, 0));
    }

    #[test]
    fn the_context_comes_from_the_last_usable_report_of_the_thread() {
        let report = |id: &str, used: Value, max: Value| Activity {
            id: id.into(),
            kind: "context-window.updated".into(),
            payload: json!({"usedTokens": used, "maxTokens": max}),
            ..Default::default()
        };
        let mut thread = Thread::default();
        assert_eq!(context(&thread), None);
        thread.activities = vec![
            report("a", json!(10), json!(100)),
            report("b", json!(null), json!(100)),
        ];
        assert_eq!(context(&thread), Some((10.0, Some(100.0))));
        thread
            .activities
            .push(report("c", json!(42_000), json!(null)));
        assert_eq!(context(&thread), Some((42_000.0, None)));
    }

    #[tokio::test]
    async fn a_server_without_the_method_leaves_the_line_out_and_says_nothing() {
        let (port, seen) = serve(|tag, _| {
            (tag == SUMMARY_RPC).then(|| Err("the request is not known".to_string()))
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({})), false).await;
        opened(&mut app, "t1");
        next(&mut app, &mut rx).await;
        assert!(line(&app, 120).is_none());
        assert!(app.notice.is_none(), "{:?}", app.notice);
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|(tag, _)| tag == SUMMARY_RPC),
            "the method was asked for once"
        );
    }

    #[tokio::test]
    async fn a_settled_turn_asks_again_and_the_line_shows_what_came_back() {
        let (port, seen) = serve(|tag, payload| {
            (tag == SUMMARY_RPC).then(|| {
                assert_eq!(payload["threadId"], "t1");
                Ok(json!({"threadId": "t1", "status": "ok",
                    "totals": {"cacheRate": 0.5},
                    "models": [{"model": "opus", "cost": {"kind": "reported", "usd": 4.12}}]}))
            })
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({})), false).await;
        assert!(line(&app, 120).is_none(), "nothing was asked yet");
        opened(&mut app, "t1");
        next(&mut app, &mut rx).await;
        let text = |app: &App| {
            line(app, 120)
                .map(|line| {
                    line.spans
                        .iter()
                        .map(|span| span.content.as_ref())
                        .collect::<String>()
                })
                .unwrap_or_default()
        };
        assert!(text(&app).contains("opus $4.12"), "{:?}", text(&app));

        // A turn starts: the line goes (the totals would be half a turn old) and nothing is asked.
        app.handle(crate::app::Msg::Thread {
            id: "t1".into(),
            item: json!({"kind": "event", "event": {"sequence": 6, "type": "thread.session-set",
                "occurredAt": "2026-01-01T00:00:09.000Z",
                "payload": {"session": {"status": "running", "activeTurnId": "turn-3",
                    "updatedAt": "2026-01-01T00:00:09.000Z"}}}}),
        });
        assert!(text(&app).is_empty(), "hidden while a turn runs");
        let asked = seen.lock().unwrap().len();
        // It settles: the numbers are asked for once more, not on every delta.
        app.handle(crate::app::Msg::Thread {
            id: "t1".into(),
            item: json!({"kind": "event", "event": {"sequence": 7, "type": "thread.session-set",
                "occurredAt": "2026-01-01T00:00:12.000Z",
                "payload": {"session": {"status": "ready", "activeTurnId": null,
                    "updatedAt": "2026-01-01T00:00:12.000Z"}}}}),
        });
        next(&mut app, &mut rx).await;
        assert_eq!(seen.lock().unwrap().len(), asked + 1);
        assert!(text(&app).contains("opus $4.12"), "{:?}", text(&app));
    }

    /// The drawn screen, a row per line.
    fn screen(app: &App, w: u16, h: u16) -> Vec<String> {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(w, h)).unwrap();
        terminal.draw(|frame| crate::ui::draw(frame, app)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..h)
            .map(|y| {
                (0..w)
                    .map(|x| buffer[(x, y)].symbol().to_string())
                    .collect::<String>()
            })
            .collect()
    }

    #[tokio::test]
    async fn the_line_is_drawn_under_the_conversation_and_goes_while_a_turn_runs() {
        let (port, _) = serve(|_, _| None).await;
        let (mut app, _rx) = connected(
            port,
            two_turns(json!({"activities": [{"id": "ctx", "tone": "info",
                "kind": "context-window.updated", "summary": "s",
                "payload": {"usedTokens": 118000, "maxTokens": 200000},
                "createdAt": "2026-01-01T00:00:08.000Z"}]})),
            false,
        )
        .await;
        // Both side columns closed: the middle has the room for the whole line.
        app.settings.sidebar = false;
        app.side_open = false;
        show(
            &mut app,
            &json!({"status": "ok", "totals": {"cacheRate": 0.978},
                "models": [{"model": "claude-opus-5-5", "cost": {"kind": "reported", "usd": 4.12}}]}),
        );
        let rows = screen(&app, 120, 40);
        let at = rows
            .iter()
            .position(|row| row.contains("Context 118k / 200k (59%)"))
            .unwrap_or_else(|| panic!("{rows:#?}"));
        assert!(rows[at].contains("Cache 97.8%"), "{}", rows[at]);
        assert!(rows[at].contains("claude-opus-5-5 $4.12"), "{}", rows[at]);
        // Nothing of the conversation is under it: it is the last line of the transcript.
        assert!(
            rows[at + 1..]
                .iter()
                .all(|row| !row.contains("two") && !row.contains("second question")),
            "{:#?}",
            &rows[at..]
        );
    }
}
