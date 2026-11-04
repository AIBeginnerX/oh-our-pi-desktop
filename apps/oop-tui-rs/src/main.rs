//! `oop-rs`: the OOP terminal app in Rust (vertical slice). See the report for what is and is not
//! ported; the TypeScript app in apps/oop-tui stays the shipped one.

mod agents_panel;
mod app;
mod chart;
mod checkpoints;
mod cli_config;
mod cli_doctor;
mod cli_stop;
mod cli_text;
mod cli_update;
mod clipboard;
mod cmd;
mod cmd_crew;
mod cmd_goal;
mod cmd_history;
mod cmd_implement;
mod cmd_misc;
mod cmd_provider;
mod cmd_stats;
mod commands;
mod composer;
mod config_fold;
mod crew;
mod crew_text;
mod diff_report;
mod files_panel;
#[cfg(test)]
mod fixtures;
mod flow;
mod flowgraph;
mod folder;
mod http;
mod i18n;
mod input;
mod link;
mod lists;
mod markdown;
mod notes;
mod notify;
mod panels_common;
mod panes;
mod paste;
mod pet;
mod provider_args;
mod provider_cmd;
mod provider_plan;
mod provider_spec;
mod provider_text;
mod provider_wizard;
mod replay;
mod savvy_panel;
mod screen;
mod selection;
mod server;
mod server_settings;
mod settings;
mod settings_write;
mod side;
mod sidebar;
mod slash;
mod state;
mod stats_view;
mod tasks_pane;
mod terminal;
mod text;
mod theme;
mod thread;
mod transcript;
mod ui;
mod update;
mod wire;
mod work_scope;
mod workflow_panel;

use app::{App, LinkStatus, Msg};
use ratatui::crossterm::event;
use std::io::Write;
use std::time::Duration;
use tokio::sync::mpsc::unbounded_channel;

/// The window title (OSC 0), written when it changes. The title the shell had is pushed on the
/// terminal's title stack before the first is set and popped on the way out; a terminal without a
/// title stack ignores both and keeps the last title. A terminal with no colour, or one that says
/// it is `dumb`, did not ask for a title and would show it as stray text, so it gets none.
struct WindowTitle {
    enabled: bool,
    last: Option<String>,
}

impl WindowTitle {
    const PUSH: &'static str = "\x1b[22;0t";
    const POP: &'static str = "\x1b[23;0t";

    fn new(colored: bool, term: Option<&str>) -> Self {
        WindowTitle {
            enabled: colored && term != Some("dumb"),
            last: None,
        }
    }

    fn sync(&mut self, title: String, out: &mut impl Write) {
        if !self.enabled || self.last.as_ref() == Some(&title) {
            return;
        }
        if self.last.is_none() {
            let _ = out.write_all(Self::PUSH.as_bytes());
        }
        let _ = out.write_all(
            format!("\x1b]0;{}\x07", text::sanitize(&title).replace('\n', " ")).as_bytes(),
        );
        let _ = out.flush();
        self.last = Some(title);
    }

    /// A terminal without a title stack ignores the pop, so the title is blanked first.
    fn restore(&mut self, out: &mut impl Write) {
        if self.last.take().is_some() {
            let _ = out.write_all(format!("\x1b]0;\x07{}", Self::POP).as_bytes());
            let _ = out.flush();
        }
    }
}

/// The OOP release this binary belongs to: `OOP_VERSION` or the root `OOP_RELEASE.json` at build
/// time (see build.rs), so `--version` agrees with the TypeScript terminal and the desktop app.
fn version() -> String {
    env!("OOP_RS_VERSION").to_string()
}

const RUNTIME_MODES: [&str; 4] = [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
];
/// The words that start a command of their own; any other first word begins a message.
const COMMAND_WORDS: [&str; 6] = ["pair", "config", "doctor", "stop", "update", "provider"];

enum Command {
    Help,
    Version,
    Run {
        home: Option<String>,
        server: Option<String>,
        launch: app::Launch,
    },
    Status {
        home: Option<String>,
        server: Option<String>,
    },
    Pair {
        target: String,
        server: Option<String>,
        home: Option<String>,
    },
    Config(cli_config::ConfigAction),
    Doctor {
        home: Option<String>,
    },
    Stop {
        home: Option<String>,
    },
    Update {
        server: Option<String>,
        home: Option<String>,
    },
    Provider {
        request: provider_args::ProviderRequest,
        server: Option<String>,
        home: Option<String>,
    },
    Error(String),
}

fn parse_args(args: &[String]) -> Command {
    use cli_text::{t, tf};
    let (mut home, mut server, mut mode) = (None, None, None);
    let mut continue_last = false;
    let mut positional: Vec<String> = Vec::new();
    let mut provider_flags: Vec<provider_args::RawFlag> = Vec::new();
    // After `--` every word is taken as it is, dashes included. `--` before any word makes the
    // whole line a message (`oop -- stop`); after a command's name it only protects the words
    // behind it.
    let mut literal = false;
    let mut message_first = false;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        index += 1;
        if literal {
            positional.push(arg.clone());
            continue;
        }
        if arg == "--" {
            literal = true;
            message_first = positional.is_empty();
            continue;
        }
        let (name, inline) = match arg.split_once('=') {
            Some((n, v)) if arg.starts_with("--") => (n, Some(v.to_string())),
            _ => (arg.as_str(), None),
        };
        let mut value = || -> Option<String> {
            if inline.is_some() {
                return inline.clone();
            }
            let next = args.get(index).filter(|v| !v.starts_with('-'))?;
            index += 1;
            Some(next.clone())
        };
        let switch = |name: &str| provider_args::RawFlag {
            name: name.to_string(),
            value: None,
        };
        match name {
            "-h" | "--help" => return Command::Help,
            "-v" | "--version" => return Command::Version,
            "-c" | "--continue" => continue_last = true,
            "--server" => match value() {
                Some(v) => server = Some(v),
                None => return Command::Error(t("cli.err.serverNeedsAddress").into()),
            },
            "--home" => match value() {
                Some(v) => home = Some(v),
                None => return Command::Error(t("cli.err.homeNeedsPath").into()),
            },
            "--mode" => match value().filter(|v| RUNTIME_MODES.contains(&v.as_str())) {
                Some(v) => mode = Some(v),
                None => {
                    return Command::Error(tf(
                        "cli.err.modeValues",
                        &[("modes", RUNTIME_MODES.join(" | "))],
                    ));
                }
            },
            "-y" | "--yes" => provider_flags.push(switch("--yes")),
            "--dry-run" => provider_flags.push(switch("--dry-run")),
            "--id" | "--name" | "--set" | "--env" | "--secret" => match value() {
                Some(v) => provider_flags.push(provider_args::RawFlag {
                    name: name.to_string(),
                    value: Some(v),
                }),
                None => {
                    return Command::Error(tf("cli.err.needsValue", &[("name", name.to_string())]));
                }
            },
            other if other.starts_with('-') && other.len() > 1 => {
                return Command::Error(tf(
                    "cli.err.unknownOption",
                    &[(
                        "name",
                        provider_args::echo_word(arg).unwrap_or_else(|| other.to_string()),
                    )],
                ));
            }
            _ => positional.push(arg.clone()),
        }
    }
    let command = positional.first().cloned();
    if let Some(flag) = provider_flags.first()
        && command.as_deref() != Some("provider")
    {
        return Command::Error(tf("cli.err.unknownOption", &[("name", flag.name.clone())]));
    }
    let Some(command) = command else {
        return Command::Run {
            home,
            server,
            launch: app::Launch {
                continue_last,
                mode,
                prompt: None,
            },
        };
    };
    let rest = &positional[1..];
    if !message_first && command == "status" && rest.is_empty() {
        return Command::Status { home, server };
    }
    if message_first || !COMMAND_WORDS.contains(&command.as_str()) {
        let prompt = positional.join(" ").trim().to_string();
        if prompt.is_empty() {
            return Command::Error(t("cli.err.emptyPrompt").into());
        }
        // A lone word that looks like a command name is most likely a mistyped command, not a
        // message.
        let wordlike = prompt
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
            && prompt
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !message_first && positional.len() == 1 && wordlike {
            return Command::Error(tf(
                "cli.err.unknownCommand",
                &[(
                    "word",
                    provider_args::echo_word(&prompt).unwrap_or_else(|| prompt.clone()),
                )],
            ));
        }
        return Command::Run {
            home,
            server,
            launch: app::Launch {
                continue_last,
                mode,
                prompt: Some(prompt),
            },
        };
    }
    match command.as_str() {
        "pair" => {
            let target = rest.join("").trim().to_string();
            if target.is_empty() {
                return Command::Error(t("cli.err.pairNeedsTarget").into());
            }
            Command::Pair {
                target,
                server,
                home,
            }
        }
        "config" => {
            use cli_config::ConfigAction;
            let word = |at: usize| rest.get(at).cloned();
            let action = match (rest.len(), word(0).as_deref()) {
                (0, _) => Some(ConfigAction::List),
                (1, Some("path")) => Some(ConfigAction::Path),
                (2, Some("get")) => Some(ConfigAction::Get(rest[1].clone())),
                (3, Some("set")) => Some(ConfigAction::Set(rest[1].clone(), rest[2].clone())),
                _ => None,
            };
            match action {
                Some(action) => Command::Config(action),
                None => Command::Error(t("cli.err.usageConfig").into()),
            }
        }
        "doctor" if rest.is_empty() => Command::Doctor { home },
        "doctor" => Command::Error(t("cli.err.usageDoctor").into()),
        "stop" if rest.is_empty() => Command::Stop { home },
        "stop" => Command::Error(t("cli.err.usageStop").into()),
        "update" if rest.is_empty() => Command::Update { server, home },
        "update" => Command::Error(t("cli.err.usageUpdate").into()),
        _ => {
            match provider_args::resolve_request(rest, &provider_flags, provider_args::Origin::Cli)
            {
                Ok(request) => Command::Provider {
                    request,
                    server,
                    home,
                },
                Err(message) => Command::Error(message),
            }
        }
    }
}

/// Resolves when the process is asked to end: SIGTERM or SIGHUP on Unix, a console close, logoff
/// or Ctrl+Break on Windows (raw mode delivers Ctrl+C as a key). Never resolves if the handlers
/// cannot be installed; the keys still quit.
async fn termination() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let (Ok(mut term), Ok(mut hangup)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::hangup()),
        ) {
            tokio::select! {
                _ = term.recv() => return,
                _ = hangup.recv() => return,
            }
        }
    }
    #[cfg(windows)]
    {
        use tokio::signal::windows::{ctrl_break, ctrl_close, ctrl_shutdown};
        if let (Ok(mut close), Ok(mut shutdown), Ok(mut brk)) =
            (ctrl_close(), ctrl_shutdown(), ctrl_break())
        {
            tokio::select! {
                _ = close.recv() => return,
                _ = shutdown.recv() => return,
                _ = brk.recv() => return,
            }
        }
    }
    std::future::pending::<()>().await;
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // The language comes first: even a usage error is printed in it.
    i18n::init(settings::startup_language(&settings::settings_path()).as_deref());
    let code = match parse_args(&args) {
        Command::Help => {
            print!("{}", cli_text::t("cli.help"));
            0
        }
        Command::Version => {
            println!("{}", version());
            0
        }
        Command::Error(message) => {
            eprint!("{message}\n\n{}", cli_text::t("cli.help"));
            2
        }
        Command::Pair {
            target,
            server,
            home,
        } => {
            let (home, _) = server::server_home(home.as_deref());
            match server::pair::pair_command(&target, server.as_deref(), &home).await {
                Ok(label) => {
                    println!("{}", server::pair::paired_message(&label));
                    0
                }
                Err(message) => {
                    eprintln!("{message}");
                    1
                }
            }
        }
        Command::Config(action) => config(&action),
        Command::Doctor { home } => doctor(home).await,
        Command::Stop { home } => {
            let (home, _) = server::server_home(home.as_deref());
            cli_stop::run(&cli_stop::System { home: &home }).await
        }
        Command::Update { server, home } => {
            let (home, _) = server::server_home(home.as_deref());
            let ports = cli_update::System {
                server: server.as_deref(),
                home: &home,
                config_dir: server::config_dir(),
            };
            cli_update::run(&version(), &ports).await
        }
        Command::Provider {
            request,
            server,
            home,
        } => provider_cmd::run_cli(request, server, home).await,
        Command::Status { home, server } => match status(home, server).await {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("oop: {error}");
                1
            }
        },
        Command::Run {
            home,
            server,
            launch,
        } => {
            use std::io::IsTerminal;
            if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
                eprintln!(
                    "{}",
                    panels_common::s(
                        "oop only runs in an interactive terminal (standard input/output is not a terminal).",
                        "oop 은 대화형 터미널에서만 실행됩니다. (표준 입출력이 터미널이 아닙니다.)"
                    )
                );
                std::process::exit(2);
            }
            match run(home, server, launch).await {
                Ok(()) => 0,
                Err(error) => {
                    eprintln!("oop: {error}");
                    1
                }
            }
        }
    };
    std::process::exit(code);
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// `oop config`: the settings file in the config directory, the environment as it is.
fn config(action: &cli_config::ConfigAction) -> i32 {
    cli_config::run(
        action,
        &mut cli_config::Io {
            config_dir: server::config_dir(),
            env: &env_var,
            windows: cfg!(windows),
            out: &mut |line| println!("{line}"),
            err: &mut |line| eprintln!("{line}"),
        },
    )
}

/// `oop doctor`: checks only; it never starts the app, a server, or a pairing.
async fn doctor(home: Option<String>) -> i32 {
    use std::io::IsTerminal;
    let (home, _) = server::server_home(home.as_deref());
    let deps = cli_doctor::Deps {
        config_dir: server::config_dir(),
        env: &env_var,
        os: cli_doctor::Os::current(),
        is_tty: std::io::stdout().is_terminal(),
        columns: ratatui::crossterm::terminal::size()
            .map(|(columns, _)| usize::from(columns))
            .ok()
            .filter(|columns| *columns > 0)
            .unwrap_or(cli_doctor::DEFAULT_COLUMNS),
        standalone: Some(server::standalone_script()),
    };
    cli_doctor::run(&deps, &home).await
}

/// Puts a selection on the clipboard: OSC 52 straight to the terminal, then the platform's tool in
/// the background (nothing over SSH). The outcome comes back as a message for the notice.
fn copy(job: app::CopyJob, tx: tokio::sync::mpsc::UnboundedSender<Msg>) {
    let sent = job.osc52.is_some();
    if let Some(sequence) = &job.osc52 {
        let mut out = std::io::stdout();
        let _ = out.write_all(sequence.as_bytes());
        let _ = out.flush();
    }
    tokio::spawn(async move {
        let tool = clipboard::run_tools(&job.plan, &job.text, clipboard::TOOL_TIMEOUT).await;
        let _ = tx.send(Msg::Copied(clipboard::Outcome {
            chars: job.text.chars().count(),
            osc52_sent: sent,
            tool,
            too_large: !sent,
        }));
    });
}

/// Reads the system clipboard for a paste the user asked for; the text comes back as a message.
fn read_clipboard(tools: Vec<clipboard::Tool>, tx: tokio::sync::mpsc::UnboundedSender<Msg>) {
    tokio::spawn(async move {
        let result = clipboard::read_tools(&tools, clipboard::TOOL_TIMEOUT).await;
        let _ = tx.send(Msg::Clip(result));
    });
}

/// Reads the language setting first, as `run` does: a one-shot command's messages are translated
/// too.
async fn status(home: Option<String>, address: Option<String>) -> Result<(), String> {
    i18n::init(
        settings::read_settings(&settings::settings_path())
            .0
            .language
            .as_deref(),
    );
    let (home, isolated) = server::server_home(home.as_deref());
    let session = link::connect_once(
        &home,
        isolated,
        address.as_deref(),
        &version(),
        |what: &str| eprintln!("{what}"),
    )
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

async fn run(
    home_flag: Option<String>,
    address: Option<String>,
    launch: app::Launch,
) -> Result<(), String> {
    let (home, isolated) = server::server_home(home_flag.as_deref());
    let cwd = std::env::current_dir()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let user_home = server::user_home().to_string_lossy().into_owned();
    let (tx, mut rx) = unbounded_channel::<Msg>();
    let (mut settings, warnings) = settings::read_settings(&settings::settings_path());
    // The language is fixed before the first string is looked up.
    i18n::init(settings.language.as_deref());
    settings::resolve_env(
        &mut settings,
        &|name| std::env::var(name).ok(),
        cfg!(windows),
    );
    let mut app = App::new(&version(), &cwd, &user_home, tx.clone());
    app.configure(settings, warnings);
    app.theme = app.theme.for_level(app.misc.level);
    app.misc.startup_check = true;
    app.launch = Some(launch);
    app.provider_server = address.clone();
    app.provider_home = home_flag.clone();

    // The guard takes raw mode, the alternate screen, mouse reporting and bracketed paste, and
    // gives all four back on drop or panic. Everything below leaves through it.
    let (mut guard, mut terminal) = terminal::Guard::enter(app.mouse);

    let keys = tx.clone();
    std::thread::spawn(move || {
        loop {
            if terminal::INPUT_PAUSED.load(std::sync::atomic::Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
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
    tokio::spawn(link::supervise(
        home,
        isolated,
        address,
        version(),
        tx.clone(),
    ));

    let ended = termination();
    tokio::pin!(ended);
    let mut ticker = tokio::time::interval(Duration::from_millis(250));
    let mut title = WindowTitle::new(app.misc.level > 0, std::env::var("TERM").ok().as_deref());
    app.in_oop_terminal = std::env::var("TERM_PROGRAM").is_ok_and(|v| v == "OOP Terminal");
    // Runs only while a chart or diagram is being revealed (under a second), never otherwise.
    let mut reveal = tokio::time::interval(Duration::from_millis(60));
    reveal.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut dirty = true;
    let result = loop {
        chart::set_animations(app.settings.animations);
        if dirty {
            if let Err(error) = terminal.draw(|frame| ui::draw(frame, &app)) {
                break Err(error.to_string());
            }
            dirty = false;
        }
        title.sync(app.window_title(), &mut std::io::stdout());
        tokio::select! {
            Some(msg) = rx.recv() => {
                app.handle(msg);
                // Take everything that is already waiting before drawing once.
                while let Ok(more) = rx.try_recv() {
                    app.handle(more);
                }
                guard.set_mouse(app.mouse);
                if let Some(job) = app.take_copy() {
                    copy(job, tx.clone());
                }
                if let Some(tools) = composer::take_paste_request(&mut app) {
                    read_clipboard(tools, tx.clone());
                }
                if let Some((request, server, home)) = cmd_provider::take_request(&mut app) {
                    let (back, failure) =
                        cmd_provider::run_in_foreground(&mut guard, request, server, home).await;
                    terminal = back;
                    let _ = terminal.clear();
                    match failure {
                        Some(why) => app.notice = Some(why),
                        None => cmd_provider::after_return(&mut app),
                    }
                }
                if std::mem::take(&mut app.bell_pending) {
                    let mut out = std::io::stdout();
                    let _ = out.write_all(
                        notify::bell_bytes(std::env::var("TERM").ok().as_deref()).as_bytes(),
                    );
                    let _ = out.flush();
                }
                if std::mem::take(&mut app.suspend_requested) {
                    terminal = terminal::suspend_process(&mut guard).await;
                }
                dirty = true;
            }
            _ = ticker.tick() => dirty = app.on_tick(),
            // The conversation's lines are cached by revision; a reveal frame is a new revision.
            _ = reveal.tick(), if chart::animating() => {
                app.conv.revision += 1;
                dirty = true;
            }
            _ = &mut ended => app.quit = true,
        }
        if app.quit {
            break Ok(());
        }
    };
    title.restore(&mut std::io::stdout());
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
        // Without OOP_VERSION the build reads the root release file, as the TypeScript app does.
        let release = include_str!("../../../OOP_RELEASE.json");
        let release: serde_json::Value = serde_json::from_str(release).unwrap();
        if option_env!("OOP_VERSION").is_none() {
            assert_eq!(version(), release["version"].as_str().unwrap());
        }
        assert!(version().split('.').count() == 3);
    }

    #[test]
    fn the_title_is_pushed_once_set_on_change_and_popped_on_the_way_out() {
        let text = |bytes: &[u8]| String::from_utf8(bytes.to_vec()).unwrap();
        let mut out = Vec::new();
        let mut title = WindowTitle::new(true, Some("xterm-256color"));
        title.sync("OOP — tagline".into(), &mut out);
        assert_eq!(text(&out), "\x1b[22;0t\x1b]0;OOP — tagline\x07");
        out.clear();
        title.sync("OOP — tagline".into(), &mut out);
        assert!(out.is_empty(), "the same title is not sent again");
        title.sync("◆ OOP — tagline".into(), &mut out);
        assert_eq!(text(&out), "\x1b]0;◆ OOP — tagline\x07");
        out.clear();
        title.restore(&mut out);
        assert_eq!(text(&out), "\x1b]0;\x07\x1b[23;0t");
        out.clear();
        title.restore(&mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn a_terminal_with_no_colour_or_a_dumb_one_gets_no_title() {
        for (colored, term) in [(false, Some("xterm")), (true, Some("dumb"))] {
            let mut out = Vec::new();
            let mut title = WindowTitle::new(colored, term);
            title.sync("OOP".into(), &mut out);
            title.restore(&mut out);
            assert!(out.is_empty());
        }
    }

    #[test]
    fn arguments_parse() {
        assert!(matches!(
            parse_args(&args(&[])),
            Command::Run {
                home: None,
                server: None,
                ..
            }
        ));
        assert!(matches!(
            parse_args(&args(&["--home", "/x", "status"])),
            Command::Status { home: Some(_), .. }
        ));
        assert!(matches!(
            parse_args(&args(&["pair", "T", "--server", "http://h:1"])),
            Command::Pair {
                server: Some(_),
                ..
            }
        ));
        assert!(matches!(
            parse_args(&args(&["pair", "T"])),
            Command::Pair { server: None, .. }
        ));
        assert!(matches!(parse_args(&args(&["pair"])), Command::Error(_)));
        assert!(matches!(parse_args(&args(&["--bogus"])), Command::Error(_)));
        assert!(matches!(parse_args(&args(&["-v"])), Command::Version));
    }

    #[test]
    fn the_options_of_the_typescript_terminal_are_taken() {
        let Command::Run { server, launch, .. } = parse_args(&args(&[
            "-c",
            "--mode=auto",
            "--server",
            "127.0.0.1:9",
            "fix",
            "the",
            "build",
        ])) else {
            panic!("not a run");
        };
        assert_eq!(server.as_deref(), Some("127.0.0.1:9"));
        assert!(launch.continue_last);
        assert_eq!(launch.mode.as_deref(), Some("auto"));
        assert_eq!(launch.prompt.as_deref(), Some("fix the build"));
        assert!(matches!(
            parse_args(&args(&["--mode", "yolo"])),
            Command::Error(_)
        ));
        // after `--` even a command word is a message
        let Command::Run { launch, .. } = parse_args(&args(&["--", "stop"])) else {
            panic!("not a run");
        };
        assert_eq!(launch.prompt.as_deref(), Some("stop"));
        // a lone word like a command name is a typo, not a message
        assert!(matches!(parse_args(&args(&["staus"])), Command::Error(_)));
    }

    #[test]
    fn the_shell_commands_are_read_with_their_words() {
        use cli_config::ConfigAction as C;
        let config = |words: &[&str]| match parse_args(&args(words)) {
            Command::Config(action) => Some(action),
            _ => None,
        };
        assert_eq!(config(&["config"]), Some(C::List));
        assert_eq!(config(&["config", "path"]), Some(C::Path));
        assert_eq!(
            config(&["config", "get", "pet"]),
            Some(C::Get("pet".into()))
        );
        assert_eq!(
            config(&["config", "set", "pet", "off"]),
            Some(C::Set("pet".into(), "off".into()))
        );
        for words in [
            &["config", "get"][..],
            &["config", "set", "pet"],
            &["config", "path", "x"],
            &["config", "nope"],
            &["doctor", "x"],
            &["stop", "x"],
            &["update", "x"],
        ] {
            assert!(
                matches!(parse_args(&args(words)), Command::Error(_)),
                "{words:?}"
            );
        }
        assert!(matches!(
            parse_args(&args(&["doctor", "--home", "/h"])),
            Command::Doctor { home: Some(_) }
        ));
        assert!(matches!(
            parse_args(&args(&["stop"])),
            Command::Stop { home: None }
        ));
        assert!(matches!(
            parse_args(&args(&["update", "--server", "h:1"])),
            Command::Update {
                server: Some(_),
                ..
            }
        ));
    }

    #[test]
    fn provider_words_and_flags_become_a_request_and_flags_belong_to_it_alone() {
        use provider_args::ProviderRequest;
        assert!(matches!(
            parse_args(&args(&["provider"])),
            Command::Provider {
                request: ProviderRequest::List,
                ..
            }
        ));
        let Command::Provider {
            request, server, ..
        } = parse_args(&args(&[
            "provider", "add", "codex", "--id", "x", "--yes", "--server", "h:1",
        ]))
        else {
            panic!("not provider");
        };
        let ProviderRequest::Add { target, options } = request else {
            panic!("not add");
        };
        assert!(target.is_some() && options.yes);
        assert_eq!(options.id.as_deref(), Some("x"));
        assert_eq!(server.as_deref(), Some("h:1"));
        // a provider flag on another command is not taken
        assert!(matches!(
            parse_args(&args(&["stop", "--yes"])),
            Command::Error(_)
        ));
        assert!(matches!(parse_args(&args(&["--yes"])), Command::Error(_)));
        assert!(matches!(
            parse_args(&args(&["provider", "add", "--id"])),
            Command::Error(_)
        ));
    }

    #[test]
    fn a_usage_error_is_said_in_the_words_of_the_cli() {
        let Command::Error(message) = parse_args(&args(&["staus"])) else {
            panic!("not an error");
        };
        assert_eq!(
            message,
            "Unknown command: staus (to send a one-word message, use oop -- staus)"
        );
        let Command::Error(message) = parse_args(&args(&["--mode", "yolo"])) else {
            panic!("not an error");
        };
        assert_eq!(
            message,
            "--mode must be one of approval-required | auto-accept-edits | auto | full-access."
        );
        let Command::Error(message) = parse_args(&args(&["--server"])) else {
            panic!("not an error");
        };
        assert_eq!(message, "--server needs an address.");
        let Command::Error(message) = parse_args(&args(&["--bogus"])) else {
            panic!("not an error");
        };
        assert_eq!(message, "Unknown option: --bogus");
    }
}
