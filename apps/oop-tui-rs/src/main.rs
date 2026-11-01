//! `oop-rs`: the OOP terminal app in Rust (vertical slice). See the report for what is and is not
//! ported; the TypeScript app in apps/oop-tui stays the shipped one.

mod app;
mod commands;
#[cfg(test)]
mod fixtures;
mod http;
mod i18n;
mod input;
mod link;
mod markdown;
mod server;
mod settings;
mod sidebar;
mod state;
mod terminal;
mod text;
mod theme;
mod thread;
mod transcript;
mod ui;
mod wire;

use app::{App, LinkStatus, Msg};
use ratatui::crossterm::event;
use std::time::Duration;
use tokio::sync::mpsc::unbounded_channel;

/// The release the terminal belongs to: the same root file the TypeScript build inlines, so
/// `--version` of both agree.
const RELEASE: &str = include_str!("../../../OOP_RELEASE.json");

fn version() -> String {
    serde_json::from_str::<serde_json::Value>(RELEASE)
        .ok()
        .and_then(|v| v["version"].as_str().map(str::to_string))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

const HELP: &str = "oop-rs - the OOP terminal app (Rust vertical slice)

Usage:
  oop-rs [--home <dir>]                  open the terminal app
  oop-rs status [--home <dir>]           connect once and print the server, providers, projects, threads
  oop-rs pair <token> --server <url>     trade a pairing token for a saved login
  oop-rs --version | --help

--home (or OOP_HOME) points at an isolated OOP home instead of ~/.oop-desktop.";

enum Command {
    Help,
    Version,
    Run { home: Option<String> },
    Status { home: Option<String> },
    Pair { token: String, server: String },
    Error(String),
}

fn parse_args(args: &[String]) -> Command {
    let mut home = None;
    let mut server = None;
    let mut positional = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-h" | "--help" => return Command::Help,
            "-v" | "--version" => return Command::Version,
            "--home" | "--server" => {
                let Some(value) = iter.next().filter(|v| !v.starts_with('-')) else {
                    return Command::Error(format!("{arg} needs a value"));
                };
                if arg == "--home" {
                    home = Some(value.clone())
                } else {
                    server = Some(value.clone())
                }
            }
            other if other.starts_with('-') => {
                return Command::Error(format!("unknown option {other}"));
            }
            other => positional.push(other.to_string()),
        }
    }
    match positional.as_slice() {
        [] => Command::Run { home },
        [word] if word == "status" => Command::Status { home },
        [word, token] if word == "pair" => match server {
            Some(server) => Command::Pair {
                token: token.clone(),
                server,
            },
            None => Command::Error("pair needs --server <url>".into()),
        },
        _ => Command::Error("unknown command; see --help".into()),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match parse_args(&args) {
        Command::Help => {
            println!("{HELP}");
            0
        }
        Command::Version => {
            println!("{}", version());
            0
        }
        Command::Error(message) => {
            eprintln!("oop-rs: {message}");
            2
        }
        Command::Pair { token, server } => match server::pair_manually(&server, &token).await {
            Ok(found) => {
                println!("Paired with {} at {}.", found.label, found.origin);
                0
            }
            Err(error) => {
                eprintln!("oop-rs: {error}");
                1
            }
        },
        Command::Status { home } => match status(home).await {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("oop-rs: {error}");
                1
            }
        },
        Command::Run { home } => match run(home).await {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("oop-rs: {error}");
                1
            }
        },
    };
    std::process::exit(code);
}

async fn status(home: Option<String>) -> Result<(), String> {
    let (home, isolated) = server::server_home(home.as_deref());
    let session = link::connect_once(&home, isolated, &version(), |what: &str| {
        eprintln!("{what}")
    })
    .await?;
    let env = &session.config["environment"];
    println!(
        "server   {} ({}) v{}",
        session.found.label,
        session.found.origin,
        env["serverVersion"].as_str().unwrap_or("?")
    );
    println!("pid      {}", session.found.pid);
    for provider in session.config["providers"].as_array().into_iter().flatten() {
        println!(
            "provider {}  enabled={} installed={} status={} auth={}",
            provider["instanceId"].as_str().unwrap_or("?"),
            provider["enabled"],
            provider["installed"],
            provider["status"].as_str().unwrap_or("?"),
            provider["auth"]["status"].as_str().unwrap_or("?"),
        );
    }
    let mut stream = session.rpc.stream(app::SHELL_RPC, serde_json::json!({}));
    let mut shell = state::Shell::default();
    while let Some(message) = stream.rx.recv().await {
        match message {
            wire::StreamMsg::Item(item) => {
                shell.apply(&item);
                if shell.loaded {
                    break;
                }
            }
            wire::StreamMsg::End(reason) => {
                return Err(reason.unwrap_or_else(|| "the shell stream ended".into()));
            }
        }
    }
    for project in &shell.projects {
        println!("project  {}  {}", project.title, project.workspace_root);
        for thread in shell.threads.iter().filter(|t| t.project_id == project.id) {
            let status = thread.session.as_ref().map_or("-", |s| s.status.as_str());
            println!("  thread {}  [{status}]  {}", thread.id, thread.title);
        }
    }
    println!(
        "{} project(s), {} thread(s)",
        shell.projects.len(),
        shell.threads.len()
    );
    Ok(())
}

async fn run(home_flag: Option<String>) -> Result<(), String> {
    let (home, isolated) = server::server_home(home_flag.as_deref());
    let cwd = std::env::current_dir()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let user_home = server::user_home().to_string_lossy().into_owned();
    let (tx, mut rx) = unbounded_channel::<Msg>();
    let (settings, warnings) = settings::read_settings(&settings::settings_path());
    // The language is fixed before the first string is looked up.
    i18n::init(settings.language.as_deref());
    let mut app = App::new(&version(), &cwd, &user_home, tx.clone());
    app.configure(settings, warnings);

    // The guard takes raw mode, the alternate screen, mouse reporting and bracketed paste, and
    // gives all four back on drop or panic. Everything below leaves through it.
    let (_guard, mut terminal) = terminal::Guard::enter();

    let keys = tx.clone();
    std::thread::spawn(move || {
        loop {
            match event::poll(Duration::from_millis(200)) {
                Ok(true) => match event::read() {
                    Ok(event) => {
                        if keys.send(Msg::Term(event)).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                },
                Ok(false) => {
                    if keys.is_closed() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    tokio::spawn(link::supervise(home, isolated, version(), tx.clone()));

    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|e| e.to_string())?;
    let mut hangup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
        .map_err(|e| e.to_string())?;
    let mut ticker = tokio::time::interval(Duration::from_millis(250));
    let mut dirty = true;
    let result = loop {
        if dirty {
            if let Err(error) = terminal.draw(|frame| ui::draw(frame, &app)) {
                break Err(error.to_string());
            }
            dirty = false;
        }
        tokio::select! {
            Some(msg) = rx.recv() => {
                app.handle(msg);
                // Take everything that is already waiting before drawing once.
                while let Ok(more) = rx.try_recv() {
                    app.handle(more);
                }
                dirty = true;
            }
            _ = ticker.tick() => dirty = app.on_tick(),
            _ = term.recv() => app.quit = true,
            _ = hangup.recv() => app.quit = true,
        }
        if app.quit {
            break Ok(());
        }
    };
    match &app.link {
        LinkStatus::Failed(why) => result.and(Err(why.clone())),
        _ => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn the_version_is_the_release_the_typescript_app_reports() {
        let release: serde_json::Value = serde_json::from_str(RELEASE).unwrap();
        assert_eq!(version(), release["version"].as_str().unwrap());
        assert!(version().split('.').count() == 3);
    }

    #[test]
    fn arguments_parse() {
        assert!(matches!(
            parse_args(&args(&[])),
            Command::Run { home: None }
        ));
        assert!(matches!(
            parse_args(&args(&["--home", "/x", "status"])),
            Command::Status { home: Some(_) }
        ));
        assert!(matches!(
            parse_args(&args(&["pair", "T", "--server", "http://h:1"])),
            Command::Pair { .. }
        ));
        assert!(matches!(
            parse_args(&args(&["pair", "T"])),
            Command::Error(_)
        ));
        assert!(matches!(parse_args(&args(&["--bogus"])), Command::Error(_)));
        assert!(matches!(parse_args(&args(&["-v"])), Command::Version));
    }
}
