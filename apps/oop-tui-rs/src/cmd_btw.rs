//! `/btw` asks a side question about the thread on screen.

use crate::app::{App, Msg};
use crate::i18n::tr;
use crate::notes::Tone;
use serde_json::{Value, json};

const SIDE_QUESTION_RPC: &str = "thread.sideQuestion";
const MAX_QUESTION_LENGTH: usize = 2_000;

pub(crate) fn question_target(app: &App, question: &str) -> Result<String, (Tone, &'static str)> {
    if question.is_empty() {
        return Err((Tone::Info, "btw.usage"));
    }
    let id = app
        .thread_id()
        .filter(|id| app.conv.loaded && !app.conv.deleted && app.conv.thread_id == *id)
        .ok_or((Tone::Info, "btw.openThread"))?;
    // The server's string length is measured in UTF-16 code units.
    if question.encode_utf16().count() > MAX_QUESTION_LENGTH {
        return Err((Tone::Warning, "btw.tooLong"));
    }
    Ok(id)
}

pub fn run(app: &mut App, argument: &str) {
    let question = argument.trim();
    let id = match question_target(app, question) {
        Ok(id) => id,
        Err((tone, message)) => {
            app.say(tone, tr(message));
            return;
        }
    };
    let Some(rpc) = app.rpc.clone() else {
        app.say(Tone::Warning, tr("btw.unavailable"));
        return;
    };
    app.say(Tone::Info, tr("btw.gettingAnswer"));
    let epoch = app.thread_view_epoch;
    let payload = json!({"threadId": id, "question": question});
    let tx = app.sender();
    tokio::spawn(async move {
        // The server allows three minutes for the answer.
        let result = rpc
            .call_with_timeout(
                SIDE_QUESTION_RPC,
                payload,
                Some(std::time::Duration::from_secs(200)),
            )
            .await;
        let _ = tx.send(Msg::Ext(Box::new(move |app| {
            if app.thread_view_epoch == epoch && app.thread_id().as_deref() == Some(id.as_str()) {
                show_result(app, result);
            }
        })));
    });
}

fn show_result(app: &mut App, result: Result<Value, String>) {
    let answer = result
        .as_ref()
        .ok()
        .filter(|value| value["status"] == "answered")
        .and_then(|value| value["answer"].as_str())
        .filter(|answer| !answer.trim().is_empty());
    match answer {
        Some(answer) => app.note(Tone::Done, tr("btw.answer"), vec![answer.to_string()]),
        None => app.say(Tone::Warning, tr("btw.unavailable")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Active;
    use crate::cmd_history::testkit::{connected, next, serve, two_turns};
    use crate::{notes, slash};

    fn app() -> App {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        App::new("0.0.0", "/tmp", "/tmp", tx)
    }

    fn submit(app: &mut App, text: &str) {
        app.input.set(text);
        app.submit();
        assert!(app.input.is_empty());
    }

    fn displayed(app: &App) -> String {
        notes::lines(app, 120)
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn empty_questions_show_usage_and_btw_completes_with_a_space() {
        let mut app = app();
        for command in ["/btw", "/btw   "] {
            app.notes.clear();
            submit(&mut app, command);
            assert!(displayed(&app).contains(tr("btw.usage")));
        }
        assert_eq!(
            slash::matches(slash::COMMANDS, "BT")[0].completion(),
            "/btw "
        );
        assert!(!app.input.history_back());
    }

    #[test]
    fn only_an_existing_thread_can_ask_and_overlong_questions_are_rejected() {
        let mut app = app();
        submit(&mut app, "/btw question");
        assert!(displayed(&app).contains(tr("btw.openThread")));
        app.start_draft("p1");
        app.notes.clear();
        submit(&mut app, "/btw question");
        assert!(displayed(&app).contains(tr("btw.openThread")));

        app.active = Active::Thread("t1".into());
        app.conv = crate::state::Conversation::new("t1");
        app.conv.loaded = true;
        app.notes.clear();
        submit(&mut app, &format!("/btw {}", "🙂".repeat(1_001)));
        let shown = displayed(&app);
        assert!(shown.contains(tr("btw.tooLong")));
        assert!(!shown.contains(tr("btw.gettingAnswer")));
    }

    #[tokio::test(start_paused = true)]
    async fn side_question_accepts_an_answer_after_ninety_seconds() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp", "/tmp", tx);
        app.active = Active::Thread("t1".into());
        app.conv = crate::state::Conversation::new("t1");
        app.conv.loaded = true;
        let (rpc, peer) = crate::wire::fake_socket().await;
        app.rpc = Some(rpc.clone());
        run(&mut app, "Why?");
        crate::wire::delayed_reply(
            &rpc,
            peer,
            SIDE_QUESTION_RPC,
            json!({"status": "answered", "answer": "delayed answer"}),
        )
        .await;
        app.handle(rx.recv().await.unwrap());
        assert!(displayed(&app).contains("delayed answer"));
    }

    #[tokio::test]
    async fn a_busy_thread_sends_only_the_side_question_and_renders_the_local_answer() {
        let (port, seen) = serve(|tag, _| {
            (tag == "thread.sideQuestion")
                .then(|| Ok(json!({"status": "answered", "answer": "First line\nSecond line"})))
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(Value::Null), false).await;
        app.conv.thread.session.as_mut().unwrap().status = "running".into();
        assert!(app.conv.busy());
        let message_count = app.conv.thread.messages.len();
        submit(&mut app, "/BTW   Why this change?  ");
        assert!(displayed(&app).contains(tr("btw.gettingAnswer")));
        app.input.set("A draft typed while waiting");
        next(&mut app, &mut rx).await;

        let shown = displayed(&app);
        for text in [tr("btw.answer"), "First line", "Second line"] {
            assert!(shown.contains(text), "{shown}");
        }
        assert_eq!(app.input.text(), "A draft typed while waiting");
        assert_eq!(app.conv.thread.messages.len(), message_count);
        assert!(app.queue.is_empty());
        let sent = seen.lock().unwrap();
        let commands: Vec<_> = sent
            .iter()
            .filter(|(tag, _)| !tag.contains("subscribe"))
            .collect();
        assert_eq!(
            commands,
            [&(
                "thread.sideQuestion".into(),
                json!({"threadId": "t1", "question": "Why this change?"})
            )]
        );
    }

    #[tokio::test]
    async fn unavailable_results_and_rpc_errors_show_the_same_local_line() {
        for result in [
            Ok(json!({"status": "unavailable"})),
            Err("raw RPC error".into()),
        ] {
            let (port, _) =
                serve(move |tag, _| (tag == "thread.sideQuestion").then(|| result.clone())).await;
            let (mut app, mut rx) = connected(port, two_turns(Value::Null), false).await;
            submit(&mut app, "/btw question");
            next(&mut app, &mut rx).await;
            let shown = displayed(&app);
            assert!(shown.contains(tr("btw.unavailable")));
            assert!(!shown.contains("raw RPC error"));
        }
    }

    #[tokio::test]
    async fn switching_threads_drops_the_answer_even_on_return() {
        let (port, _) = serve(|tag, _| {
            (tag == "thread.sideQuestion")
                .then(|| Ok(json!({"status": "answered", "answer": "Stale answer"})))
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(Value::Null), false).await;
        submit(&mut app, "/btw question");
        app.open_thread("t2");
        app.open_thread("t1");
        next(&mut app, &mut rx).await;
        assert!(app.notes.is_empty());
    }
}
