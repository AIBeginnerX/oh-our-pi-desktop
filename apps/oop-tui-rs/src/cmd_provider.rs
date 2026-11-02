//! `/provider [list|add|remove ...]`. The TypeScript terminal has a wizard screen for this
//! (providerScreen.ts, providerFlow.ts, providerWizard.ts: ~2,700 lines of forms over the server's
//! settings and a spec table of every provider kind). The same three operations exist as the
//! `oop provider list|add|remove` command, which asks its questions on the plain terminal. So the
//! slash command hands the terminal over: the screen is given back, the TypeScript command runs
//! with the words typed after `/provider`, and when it ends the screen is drawn again and the
//! server's configuration is read once more. That needs the TypeScript terminal to be present
//! (`OOP_TS_ENTRY`, see `main.rs`); without it a clear message says so.

use crate::app::{App, CONFIG_RPC, Msg};
use crate::panels_common::s;
use serde_json::json;

/// The command line to hand over: `provider` and the words after the slash command, plus the
/// server and home this session was started with, so both talk to the same server.
pub fn handoff_args(argument: &str, server: Option<&str>, home: Option<&str>) -> Vec<String> {
    let mut args = vec!["provider".to_string()];
    args.extend(argument.split_whitespace().map(str::to_string));
    if let Some(server) = server {
        args.push("--server".into());
        args.push(server.into());
    }
    if let Some(home) = home {
        args.push("--home".into());
        args.push(home.into());
    }
    args
}

pub fn run(app: &mut App, argument: &str) {
    if std::env::var_os("OOP_TS_ENTRY").is_none_or(|v| v.is_empty()) {
        app.notice = Some(
            s(
                "/provider is run by the TypeScript terminal: set OOP_TS_ENTRY to its file (the installed oop command does), or use oop provider in a shell.",
                "/provider 는 TypeScript 터미널이 실행합니다. OOP_TS_ENTRY 에 그 파일을 지정하거나(설치된 oop 명령은 이미 지정되어 있습니다) 셸에서 oop provider 를 쓰세요.",
            )
            .to_string(),
        );
        return;
    }
    let args = handoff_args(
        argument,
        app.handoff_server.as_deref(),
        app.handoff_home.as_deref(),
    );
    app.pending_handoff = Some(args);
}

/// The TypeScript command has ended and the screen is back: read the server's configuration again,
/// since providers may have been added or removed.
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

    #[test]
    fn the_words_after_the_command_and_the_session_go_to_the_typescript_command() {
        assert_eq!(handoff_args("", None, None), ["provider"]);
        assert_eq!(
            handoff_args("add  codex --dry-run", Some("http://h:1"), Some("/x")),
            [
                "provider",
                "add",
                "codex",
                "--dry-run",
                "--server",
                "http://h:1",
                "--home",
                "/x"
            ]
        );
    }
}
