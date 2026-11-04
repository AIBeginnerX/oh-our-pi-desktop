//! `/provider [list|add|remove ...]`. The words are read like the shell command's (`oop provider`,
//! `provider_args::parse_provider_slash`), and the command itself is `provider_cmd::run_cli`: it
//! asks its questions on the plain terminal and, for `add` with something missing, on its own
//! screens. So the slash command hands the terminal over: the full-screen UI steps aside, the
//! command runs, Enter brings the screen back, and the server's configuration is read once more.
//! `main.rs` runs the pending request (`take_request`, `run_in_foreground`).

use crate::app::{App, CONFIG_RPC, Msg};
use crate::provider_args::{ProviderRequest, parse_provider_slash};
use crate::provider_spec::one_line;
use serde_json::json;

/// The words typed after `/provider` become a request to run in the foreground; a mistake in them
/// is said in a notice.
pub fn run(app: &mut App, argument: &str) {
    match parse_provider_slash(argument) {
        Ok(request) => app.pending_provider = Some(request),
        Err(message) => app.notice = Some(one_line(&message)),
    }
}

/// The request to run and the server and home this session was started with, so the command talks
/// to the same server; `None` when no `/provider` is pending.
pub fn take_request(app: &mut App) -> Option<(ProviderRequest, Option<String>, Option<String>)> {
    let request = app.pending_provider.take()?;
    Some((
        request,
        app.provider_server.clone(),
        app.provider_home.clone(),
    ))
}

/// Runs `request` with the screen given back: the terminal is released, the command gets it, and
/// Enter brings the screen back so its output can be read first. The terminal to draw on again,
/// and a notice when the command did not succeed (it has said why on the terminal).
pub async fn run_in_foreground(
    guard: &mut crate::terminal::Guard,
    request: ProviderRequest,
    server: Option<String>,
    home: Option<String>,
) -> (ratatui::DefaultTerminal, Option<String>) {
    use std::sync::atomic::Ordering;
    // The key reader may be inside a poll: let it see the flag before the command reads the keys.
    crate::terminal::INPUT_PAUSED.store(true, Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(260)).await;
    guard.suspend();
    let code = crate::provider_cmd::run_cli(request, server, home).await;
    println!(
        "\n{}",
        crate::panels_common::s(
            "Press Enter to go back to OOP.",
            "Enter 를 누르면 OOP 로 돌아갑니다."
        )
    );
    let _ = std::io::stdin().read_line(&mut String::new());
    let terminal = guard.resume();
    crate::terminal::INPUT_PAUSED.store(false, Ordering::SeqCst);
    let notice = (code != 0).then(|| {
        crate::panels_common::s(
            "/provider did not finish (see the terminal output above).",
            "/provider 가 끝까지 실행되지 않았습니다. (위의 터미널 출력을 확인하세요.)",
        )
        .to_string()
    });
    (terminal, notice)
}

/// The command has ended and the screen is back: read the server's configuration again, since
/// providers may have been added or removed.
pub fn after_return(app: &mut App) {
    let Some(rpc) = app.rpc.clone() else {
        return;
    };
    let tx = app.sender();
    tokio::spawn(async move {
        if let Ok(config) = rpc.call(CONFIG_RPC, json!({})).await {
            let _ = tx.send(Msg::Ext(Box::new(move |app| app.config = config)));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::App;

    fn app() -> App {
        crate::i18n::init(Some("en"));
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        App::new("0.0.0", "/tmp/oop-rs/work/demo", "/tmp", tx)
    }

    #[test]
    fn the_words_after_the_command_become_a_pending_request_with_the_session_server() {
        let mut app = app();
        app.provider_server = Some("http://h:1".into());
        app.provider_home = Some("/x".into());
        run(&mut app, "add  codex --dry-run");
        let (request, server, home) = take_request(&mut app).expect("a request is pending");
        let ProviderRequest::Add { target, options } = request else {
            panic!("not add")
        };
        assert!(target.is_some() && options.dry_run);
        assert_eq!(
            (server.as_deref(), home.as_deref()),
            (Some("http://h:1"), Some("/x"))
        );
        assert!(take_request(&mut app).is_none(), "a request runs once");
    }

    #[test]
    fn no_words_mean_list_and_remove_may_leave_out_the_id() {
        let mut app = app();
        run(&mut app, "");
        assert_eq!(take_request(&mut app).unwrap().0, ProviderRequest::List);
        run(&mut app, "remove");
        assert!(matches!(
            take_request(&mut app).unwrap().0,
            ProviderRequest::Remove { id: None, .. }
        ));
    }

    #[test]
    fn a_mistake_in_the_words_is_a_notice_and_nothing_runs() {
        let mut app = app();
        run(&mut app, "frob");
        assert!(app.pending_provider.is_none());
        let notice = app.notice.clone().unwrap();
        assert!(
            notice.contains("Unknown subcommand: frob") && !notice.contains('\n'),
            "{notice}"
        );
        app.notice = None;
        // A secret is never taken from the chat.
        run(&mut app, "add zai --secret KEY=@VAR");
        assert!(app.pending_provider.is_none() && app.notice.is_some());
    }
}
