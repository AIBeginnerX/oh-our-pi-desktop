//! One dim line covering the request and each model's cost, cache and context.
//! Server model usage takes precedence over the thread context fallback, which never stands in
//! for a request: the thread's latest context may predate it.
//! Older scope-less summaries remain unlabelled; fetching and drawing stay outside pure formatting.

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
    /// The turns this model was measured over. `Some(0)` is a crew model the server lists without
    /// any usage behind it, and `None` a row from a server that does not say: both read as reported.
    pub turns: Option<u64>,
    pub cost: Cost,
    pub cache_rate: Option<f64>,
    pub context: Option<(f64, Option<f64>)>,
}

/// The part of `thread.usageSummary` the line reads.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Summary {
    /// `ok`, or `too-large` when the thread is bigger than the server will total up.
    pub status: String,
    /// `Some("turn")` for a scoped response. Older servers may omit the scope.
    pub scope: Option<String>,
    /// The server confirms that a turn-scoped response covers the whole request.
    pub request_aggregated: bool,
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
        scope: value["scope"].as_str().map(str::to_string),
        request_aggregated: value["requestAggregated"].as_bool() == Some(true),
        models: value["models"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|row| Model {
                model: flat(row["model"].as_str().unwrap_or_default()),
                turns: row["turns"].as_u64(),
                cost: parse_cost(&row["cost"]),
                cache_rate: row["cacheRate"].as_f64().filter(|n| n.is_finite()),
                context: row["context"]["usedTokens"]
                    .as_f64()
                    .filter(|n| n.is_finite() && *n >= 0.0)
                    .map(|used| {
                        (
                            used,
                            row["context"]["maxTokens"]
                                .as_f64()
                                .filter(|n| n.is_finite() && *n > 0.0),
                        )
                    }),
            })
            .collect(),
    })
}

/// Compact provider model name, preserving non-Claude version conventions.
pub fn short_model(model: &str) -> String {
    let model = model.rsplit(['/', '\\']).next().unwrap_or(model);
    let model = model.strip_prefix("claude-").unwrap_or(model);
    let mut model = model;
    if let Some((base, date)) = model.rsplit_once('-')
        && date.len() == 8
        && date.bytes().all(|b| b.is_ascii_digit())
    {
        model = base;
    }
    model = model.strip_suffix("-latest").unwrap_or(model);
    let (base, suffix) = match model.find('[') {
        Some(at) if model.ends_with(']') => (&model[..at], &model[at..]),
        _ => (model, ""),
    };
    if let Some((prefix, minor)) = base.rsplit_once('-')
        && let Some((name, major)) = prefix.rsplit_once('-')
    {
        let version = |s: &str| (1..=2).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
        if version(major) && version(minor) {
            return format!("{name}-{major}.{minor}{suffix}");
        }
    }
    model.to_string()
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

/// Request scope, fallback context, then each model's usage.
pub fn footer(summary: Option<&Summary>, context: Option<(f64, Option<f64>)>, ko: bool) -> String {
    let usable = summary.filter(|s| s.usable());
    let rows = usable.map(|s| s.models.as_slice()).unwrap_or_default();
    let mut parts = Vec::new();
    let request = usable.and_then(|s| s.scope.as_deref()) == Some("turn");
    if request && usable.is_some_and(|s| s.request_aggregated) {
        parts.push(tr_in_lang("usage.thisRequest", ko).to_string());
    }
    if !request
        && !rows.iter().any(|row| row.context.is_some())
        && let Some((used, max)) = context
    {
        parts.push(format!("ctx {}", context_usage(used, max)));
    }
    for row in rows {
        let mut pieces = vec![short_model(&row.model)];
        if row.turns == Some(0) {
            pieces.push(tr_in_lang("usage.notReported", ko).to_string());
        } else {
            pieces.push(cost_text(row.cost, ko));
            if let Some(rate) = row.cache_rate {
                pieces.push(fill(
                    tr_in_lang("usage.cache", ko),
                    &[("rate", cache_percent(rate))],
                ));
            }
        }
        // A crew model with no usage measured still shows the context it reported.
        if let Some((used, max)) = row.context {
            pieces.push(format!("ctx {}", context_usage(used, max)));
        }
        parts.push(pieces.join(" "));
    }
    parts.join(" · ")
}

fn context_usage(used: f64, max: Option<f64>) -> String {
    let mut usage = context_tokens(used);
    if let Some(max) = max {
        usage.push_str(&format!("/{}", context_tokens(max)));
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

/// `92%`: the web app's `formatPercent` with no decimals.
fn cache_percent(share: f64) -> String {
    let percent = share * 100.0;
    if percent > 0.0 && percent < 1.0 {
        return "<1%".to_string();
    }
    format!("{percent:.0}%")
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
    usage_receipts: usize,
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
    let receipts = app
        .conv
        .thread
        .activities
        .iter()
        .filter(|activity| activity.kind == "task.completed" || activity.kind == "owned-usage")
        .count();
    let changed = receipts != app.usage.usage_receipts;
    app.usage.usage_receipts = receipts;
    if settled || (changed && !running && app.usage.audit.is_none()) {
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
    // The line is the latest turn's usage, so the request names the turn. An
    // older server ignores the field and answers for the whole thread, whose
    // scope-less answer the line leaves unlabelled.
    let turn = app
        .conv
        .thread
        .latest_turn
        .as_ref()
        .map(|turn| turn.turn_id.clone());
    let tx = app.sender();
    tokio::spawn(async move {
        let payload = match turn {
            Some(turn) => json!({"threadId": id, "turnId": turn}),
            None => json!({"threadId": id}),
        };
        let result = rpc.call(SUMMARY_RPC, payload).await;
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
    fn request_label_matches_web() {
        let mut response = json!({"status":"ok", "scope":"turn", "models":[], "futureField": 1});
        for (confirmation, expected) in [
            (None, ""),
            (Some(json!(false)), ""),
            (Some(json!("true")), ""),
            (Some(json!(true)), "This request"),
        ] {
            if let Some(confirmation) = confirmation {
                response["requestAggregated"] = confirmation;
            }
            let summary = parse(&response).unwrap();
            assert_eq!(footer(Some(&summary), None, false), expected, "{response}");
        }
    }

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

    #[tokio::test]
    async fn worker_completion_after_lead_settled_refreshes_models_once() {
        let (port, seen) =
            serve(|tag, _| {
                (tag == SUMMARY_RPC).then(|| Ok(json!({
            "status": "ok", "models": [{"model":"gpt-6.1-sol", "cost":{"kind":"unknown"}}]
        })))
            })
            .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({})), false).await;
        opened(&mut app, "t1");
        next(&mut app, &mut rx).await;
        let before = seen.lock().unwrap().len();
        app.conv.thread.activities.push(Activity {
            kind: "task.completed".into(),
            payload: json!({"crewRole":"worker", "taskId":"worker", "threadId":"child"}),
            ..Default::default()
        });
        on_thread(&mut app);
        next(&mut app, &mut rx).await;
        assert_eq!(seen.lock().unwrap().len(), before + 1);
        assert!(
            app.usage
                .summary
                .as_ref()
                .unwrap()
                .models
                .iter()
                .any(|row| row.model == "gpt-6.1-sol")
        );
        on_thread(&mut app);
        assert_eq!(seen.lock().unwrap().len(), before + 1);
    }

    #[test]
    fn short_model_cases() {
        for (input, expected) in [
            ("provider/claude-opus-5-5", "opus-5.5"),
            ("provider\\claude-sonnet-4-6[1m]", "sonnet-4.6[1m]"),
            ("claude-haiku-5-5-20260101", "haiku-5.5"),
            ("claude-opus-5-5-latest", "opus-5.5"),
            ("gpt-6.2-sol", "gpt-6.2-sol"),
            ("gpt-6-astra", "gpt-6-astra"),
            ("deepseek-v41-flash-1017", "deepseek-v41-flash-1017"),
            ("model-123-4", "model-123-4"),
            ("model-1-23", "model-1.23"),
        ] {
            assert_eq!(short_model(input), expected);
        }
    }

    #[test]
    fn lead_and_two_crew_rows() {
        let summary = parse(&json!({"status":"ok", "scope":"turn","requestAggregated":true, "totals":{"cacheRate":0.1},
            "models":[
                {"model":"claude-opus-5-5","turns":1,"cost":{"kind":"estimated","usd":4.12},
                 "cacheRate":0.92,"context":{"usedTokens":182000,"maxTokens":1000000}},
                {"model":"gpt-6.2-sol","turns":2,"cost":{"kind":"estimated","usd":0.4},
                 "cacheRate":0.85,"context":{"usedTokens":64000,"maxTokens":400000}},
                {"model":"gpt-6.2-astra","turns":0,"cost":{"kind":"reported","usd":3},"cacheRate":0.5}
            ]})).unwrap();
        assert_eq!(summary.models[0].cache_rate, Some(0.92));
        assert_eq!(summary.models[0].context, Some((182000.0, Some(1000000.0))));
        assert_eq!(
            footer(Some(&summary), Some((1.0, None)), false),
            "This request · opus-5.5 ≈$4.12 cache 92% ctx 182k/1m · gpt-6.2-sol ≈$0.40 cache 85% ctx 64k/400k · gpt-6.2-astra Usage not reported"
        );
        assert!(
            footer(Some(&summary), None, true).starts_with("이번 요청 · opus-5.5 ≈$4.12 캐시 92%")
        );
        let unreported = parse(
            &json!({"status":"ok", "scope":"turn","requestAggregated":true, "models":[
                {"model":"gpt-6.2-astra","turns":0,"context":{"usedTokens":2000,"maxTokens":10000}}
            ]}),
        )
        .unwrap();
        assert_eq!(
            footer(Some(&unreported), None, false),
            "This request · gpt-6.2-astra Usage not reported ctx 2k/10k"
        );
    }

    #[test]
    fn context_fallback_and_no_label_without_scope() {
        let mut summary = parse(
            &json!({"status":"ok","scope":"turn","requestAggregated":true,"models":[
                {"model":"opus","cost":{"kind":"reported","usd":4.12}}
            ]}),
        )
        .unwrap();
        // The thread's latest context may come from an earlier request.
        assert_eq!(
            footer(Some(&summary), Some((118000.0, Some(200000.0))), false),
            "This request · opus $4.12"
        );
        summary.scope = None;
        assert_eq!(footer(Some(&summary), None, false), "opus $4.12");
        assert_eq!(
            footer(Some(&summary), Some((118000.0, Some(200000.0))), false),
            "ctx 118k/200k · opus $4.12"
        );
        assert_eq!(footer(None, Some((1500000.0, None)), false), "ctx 1.5m");
        assert_eq!(footer(None, None, true), "");
    }

    #[test]
    fn validates_context_and_preserves_cost_cache_formats() {
        let summary = parse(&json!({"models":[
            {"model":"a","context":{"usedTokens":-1,"maxTokens":100}},
            {"model":"b","context":{"usedTokens":0,"maxTokens":null}},
            {"model":"c","context":{"usedTokens":1200,"maxTokens":-1}}
        ]}))
        .unwrap();
        assert_eq!(summary.models[0].context, None);
        assert_eq!(summary.models[1].context, Some((0.0, None)));
        assert_eq!(summary.models[2].context, Some((1200.0, None)));
        assert_eq!(cost_text(Cost::Unknown, false), "Cost unknown");
        assert_eq!(cost_text(Cost::Estimated(0.3), false), "≈$0.30");
        assert_eq!(cache_percent(0.0001), "<1%");
        assert!(parse(&Value::Null).is_none());
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
        // Each request names the turn it is about: the thread's latest at open,
        // then the one that just settled.
        let turns: Vec<Value> = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(tag, _)| tag == SUMMARY_RPC)
            .map(|(_, payload)| payload["turnId"].clone())
            .collect();
        assert_eq!(turns, [json!("turn-2"), json!("turn-3")]);
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
            .position(|row| row.contains("ctx 118k/200k"))
            .unwrap_or_else(|| panic!("{rows:#?}"));
        assert!(!rows[at].contains("cache"), "{}", rows[at]);
        assert!(rows[at].contains("opus-5.5 $4.12"), "{}", rows[at]);
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
