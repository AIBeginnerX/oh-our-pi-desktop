//! `oop-rs`: the OOP terminal app in Rust (vertical slice). See the report for what is and is not
//! ported; the TypeScript app in apps/oop-tui stays the shipped one.

mod agents_panel;
mod app;
mod checkpoints;
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
mod config_fold;
mod crew;
mod crew_text;
mod diff_report;
#[cfg(test)]
mod fixtures;
mod flow;
mod http;
mod i18n;
mod input;
mod link;
mod lists;
mod markdown;
mod notes;
mod panels_common;
mod pet;
mod screen;
mod selection;
mod server;
mod server_settings;
mod settings;
mod settings_write;
mod side;
mod sidebar;
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
mod workflow_panel;

use app::{App, LinkStatus, Msg};
use ratatui::crossterm::event;
use std::io::Write;
use std::time::Duration;
use tokio::sync::mpsc::unbounded_channel;

/// The OOP release this binary belongs to: `OOP_VERSION` or the root `OOP_RELEASE.json` at build
/// time (see build.rs), so `--version` agrees with the TypeScript terminal and the desktop app.
fn version() -> String {
    env!("OOP_RS_VERSION").to_string()
}

const HELP: &str = "oop-rs - the OOP terminal app

Usage
  oop-rs                         open the terminal app (connects to the OOP app on this computer,
                                 or starts a server of its own)
  oop-rs --continue              resume the latest thread of the project in this folder
  oop-rs \"prompt\"                open a new thread in this folder's project and send that message
  oop-rs status                  connect once and print the server, providers, projects, threads
  oop-rs pair <token> --server <address>
                                 trade a pairing token for a saved login on another computer
  oop-rs config | doctor | stop | update | provider ...
                                 run by the TypeScript terminal: OOP_TS_ENTRY is its file, run by
                                 the node in OOP_TS_NODE (a path; default: node on PATH);
                                 OOP_TS_NODE_ELECTRON=1 when that path is an Electron binary

Options
  -c, --continue                 resume the latest thread
      --server <address>         use this server address (e.g. http://127.0.0.1:3773)
      --home <folder>            use this OOP home folder (default: ~/.oop-desktop)
      --mode <mode>              runtime mode for a new thread:
                                 approval-required | auto-accept-edits | auto | full-access
      --                         everything after is the prompt
  -h, --help                     show this help
  -v, --version                  show the version

OOP_MOUSE=off turns the mouse off (wheel scrolling and drag-to-copy); /mouse does it while running.";

const RUNTIME_MODES: [&str; 4] = [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
];
/// The words that start a command of their own; any other first word begins a message.
const HANDOFF_WORDS: [&str; 5] = ["config", "doctor", "stop", "update", "provider"];

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
        token: String,
        server: String,
    },
    /// A command the TypeScript terminal runs; `oop-rs` hands the whole command line to it.
    Handoff(Vec<String>),
    Error(String),
}

fn parse_args(args: &[String]) -> Command {
    let (mut home, mut server, mut mode) = (None, None, None);
    let mut continue_last = false;
    let mut positional: Vec<String> = Vec::new();
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
        match name {
            "-h" | "--help" => return Command::Help,
            "-v" | "--version" => return Command::Version,
            "-c" | "--continue" => continue_last = true,
            "--server" => match value() {
                Some(v) => server = Some(v),
                None => return Command::Error("--server needs an address".into()),
            },
            "--home" => match value() {
                Some(v) => home = Some(v),
                None => return Command::Error("--home needs a folder".into()),
            },
            "--mode" => match value().filter(|v| RUNTIME_MODES.contains(&v.as_str())) {
                Some(v) => mode = Some(v),
                None => {
                    return Command::Error(format!("--mode takes {}", RUNTIME_MODES.join(" | ")));
                }
            },
            // Options of `provider add|remove`, which the TypeScript terminal reads itself.
            "-y" | "--yes" | "--dry-run" | "--id" | "--name" | "--set" | "--env" | "--secret"
                if positional.first().is_some_and(|w| w == "provider") =>
            {
                if !matches!(name, "-y" | "--yes" | "--dry-run") {
                    let _ = value();
                }
            }
            other if other.starts_with('-') && other.len() > 1 => {
                return Command::Error(format!("unknown option {other}"));
            }
            _ => positional.push(arg.clone()),
        }
    }
    let Some(first) = positional.first().cloned() else {
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
    let command = !message_first;
    if command && HANDOFF_WORDS.contains(&first.as_str()) {
        return Command::Handoff(args.to_vec());
    }
    if command && first == "status" && positional.len() == 1 {
        return Command::Status { home, server };
    }
    if command && first == "pair" {
        let token = positional[1..].join("");
        return match (token.is_empty(), server) {
            (true, _) => Command::Error("pair needs a token".into()),
            (false, Some(server)) => Command::Pair { token, server },
            (false, None) => Command::Error("pair needs --server <address>".into()),
        };
    }
    let prompt = positional.join(" ").trim().to_string();
    if prompt.is_empty() {
        return Command::Error("the prompt is empty".into());
    }
    // A lone word that looks like a command name is most likely a mistyped command, not a message.
    if !message_first
        && positional.len() == 1
        && prompt
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
        && prompt
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Command::Error(format!("unknown command {prompt}; see --help"));
    }
    Command::Run {
        home,
        server,
        launch: app::Launch {
            continue_last,
            mode,
            prompt: Some(prompt),
        },
    }
}

/// How the TypeScript terminal is started for a handed-off command.
#[derive(Debug, PartialEq, Eq)]
struct HandoffPlan {
    program: std::ffi::OsString,
    args: Vec<std::ffi::OsString>,
    /// Variables to set in the child, in addition to the ones it inherits.
    envs: Vec<(&'static str, &'static str)>,
}

/// The node rule: a `.js`/`.mjs`/`.cjs` entry runs under `node_override` (the path in
/// `OOP_TS_NODE`, when set and not empty), else under `node` from `PATH`. With `electron_as_node`
/// (`OOP_TS_NODE_ELECTRON=1` exactly) the program is an Electron binary acting as node, so the
/// child gets `ELECTRON_RUN_AS_NODE=1`. Any other entry (a packaged executable) is run as it is.
fn handoff_plan(
    entry: &std::path::Path,
    args: &[String],
    node_override: Option<std::ffi::OsString>,
    electron_as_node: bool,
) -> HandoffPlan {
    let script = matches!(
        entry.extension().and_then(|e| e.to_str()),
        Some("js" | "mjs" | "cjs")
    );
    if !script {
        return HandoffPlan {
            program: entry.as_os_str().to_owned(),
            args: args.iter().map(Into::into).collect(),
            envs: Vec::new(),
        };
    }
    let program = node_override
        .filter(|node| !node.is_empty())
        .unwrap_or_else(|| "node".into());
    let mut all: Vec<std::ffi::OsString> = vec![entry.as_os_str().to_owned()];
    all.extend(args.iter().map(Into::into));
    HandoffPlan {
        program,
        args: all,
        envs: if electron_as_node {
            vec![("ELECTRON_RUN_AS_NODE", "1")]
        } else {
            Vec::new()
        },
    }
}

/// Runs the TypeScript terminal for a command `oop-rs` does not carry: `OOP_TS_ENTRY` names its
/// file (the packager sets it), and `OOP_TS_NODE` / `OOP_TS_NODE_ELECTRON` say which node runs it
/// (see `handoff_plan`). On Unix this replaces the process, so the exit code and the terminal are
/// the TypeScript app's.
fn ts_command(args: &[String]) -> Result<(std::process::Command, String), String> {
    let Some(entry) = std::env::var_os("OOP_TS_ENTRY").filter(|v| !v.is_empty()) else {
        return Err(format!(
            "`{}` is run by the TypeScript terminal; set OOP_TS_ENTRY to its file \
             (and OOP_TS_NODE to the node that runs it, unless `node` is on PATH)",
            args.first().map_or("", String::as_str)
        ));
    };
    let path = std::path::PathBuf::from(&entry);
    let plan = handoff_plan(
        &path,
        args,
        std::env::var_os("OOP_TS_NODE"),
        std::env::var("OOP_TS_NODE_ELECTRON").is_ok_and(|v| v == "1"),
    );
    let mut command = std::process::Command::new(&plan.program);
    command.args(&plan.args).envs(plan.envs.iter().copied());
    Ok((command, plan.program.to_string_lossy().into_owned()))
}

fn hand_off(args: &[String]) -> i32 {
    let (mut command, program) = match ts_command(args) {
        Ok(found) => found,
        Err(message) => {
            eprintln!("oop-rs: {message}");
            return 2;
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        eprintln!("oop-rs: cannot run {program}: {error}");
        1
    }
    #[cfg(not(unix))]
    {
        match command.status() {
            Ok(status) => status.code().unwrap_or(1),
            Err(error) => {
                eprintln!("oop-rs: cannot run {program}: {error}");
                1
            }
        }
    }
}

/// Runs a TypeScript command in the foreground while the screen is given back (`/provider`):
/// the terminal is released, the command gets it, and Enter brings the screen back so its output
/// can be read first. The reason when it could not be run or did not succeed.
async fn run_ts_in_foreground(
    guard: &mut terminal::Guard,
    args: &[String],
) -> (ratatui::DefaultTerminal, Option<String>) {
    use std::sync::atomic::Ordering;
    let command = ts_command(args);
    // The key reader may be inside a poll: let it see the flag before the command reads the keys.
    terminal::INPUT_PAUSED.store(true, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(260)).await;
    guard.suspend();
    let outcome = tokio::task::block_in_place(|| match command {
        Err(message) => Err(message),
        Ok((mut command, program)) => match command.status() {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!("{program}: {status}")),
            Err(error) => Err(format!("cannot run {program}: {error}")),
        },
    });
    println!(
        "\n{}",
        panels_common::s(
            "Press Enter to go back to OOP.",
            "Enter 를 누르면 OOP 로 돌아갑니다."
        )
    );
    let _ = std::io::stdin().read_line(&mut String::new());
    let terminal = guard.resume();
    terminal::INPUT_PAUSED.store(false, Ordering::SeqCst);
    (terminal, outcome.err())
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
        Command::Handoff(args) => hand_off(&args),
        Command::Status { home, server } => match status(home, server).await {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("oop-rs: {error}");
                1
            }
        },
        Command::Run {
            home,
            server,
            launch,
        } => match run(home, server, launch).await {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("oop-rs: {error}");
                1
            }
        },
    };
    std::process::exit(code);
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

async fn status(home: Option<String>, address: Option<String>) -> Result<(), String> {
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
    let (settings, warnings) = settings::read_settings(&settings::settings_path());
    // The language is fixed before the first string is looked up.
    i18n::init(settings.language.as_deref());
    let mut app = App::new(&version(), &cwd, &user_home, tx.clone());
    app.configure(settings, warnings);
    app.theme = app.theme.for_level(app.misc.level);
    app.misc.startup_check = true;
    app.launch = Some(launch);
    app.handoff_server = address.clone();
    app.handoff_home = home_flag.clone();

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
                guard.set_mouse(app.mouse);
                if let Some(job) = app.take_copy() {
                    copy(job, tx.clone());
                }
                if let Some(args) = app.pending_handoff.take() {
                    let (back, failure) = run_ts_in_foreground(&mut guard, &args).await;
                    terminal = back;
                    let _ = terminal.clear();
                    match failure {
                        Some(why) => app.notice = Some(why),
                        None => cmd_provider::after_return(&mut app),
                    }
                }
                dirty = true;
            }
            _ = ticker.tick() => dirty = app.on_tick(),
            _ = &mut ended => app.quit = true,
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
        // Without OOP_VERSION the build reads the root release file, as the TypeScript app does.
        let release = include_str!("../../../OOP_RELEASE.json");
        let release: serde_json::Value = serde_json::from_str(release).unwrap();
        if option_env!("OOP_VERSION").is_none() {
            assert_eq!(version(), release["version"].as_str().unwrap());
        }
        assert!(version().split('.').count() == 3);
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
            Command::Pair { .. }
        ));
        assert!(matches!(
            parse_args(&args(&["pair", "T"])),
            Command::Error(_)
        ));
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
    fn the_commands_oop_rs_does_not_carry_go_to_the_typescript_terminal() {
        for words in [
            &["doctor"][..],
            &["config", "set", "pet", "off"],
            &["stop"],
            &["update"],
            &["provider", "add", "--id", "x", "--yes"],
        ] {
            assert!(
                matches!(parse_args(&args(words)), Command::Handoff(all) if all == args(words)),
                "{words:?}"
            );
        }
    }

    #[test]
    fn a_script_entry_runs_under_the_node_the_rule_names() {
        let words = args(&["doctor", "--json"]);
        let entry = std::path::Path::new("/opt/oop/oop-tui.mjs");
        let all = |plan: &HandoffPlan| -> Vec<String> {
            plan.args
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        };
        // nothing set: `node` from PATH, no Electron variable
        let plain = handoff_plan(entry, &words, None, false);
        assert_eq!(plain.program, "node");
        assert_eq!(all(&plain), ["/opt/oop/oop-tui.mjs", "doctor", "--json"]);
        assert!(plain.envs.is_empty());
        // an empty OOP_TS_NODE counts as unset
        assert_eq!(
            handoff_plan(entry, &words, Some("".into()), false).program,
            "node"
        );
        // OOP_TS_NODE names the program; without the flag no Electron variable is set
        let bundled = handoff_plan(entry, &words, Some("/opt/oop/node".into()), false);
        assert_eq!(bundled.program, "/opt/oop/node");
        assert!(bundled.envs.is_empty());
        // Electron acting as node
        let electron = handoff_plan(entry, &words, Some("/Apps/OOP".into()), true);
        assert_eq!(electron.program, "/Apps/OOP");
        assert_eq!(electron.envs, [("ELECTRON_RUN_AS_NODE", "1")]);
        // a packaged executable is run as it is, whatever the node rule says
        let exe = handoff_plan(
            std::path::Path::new("/opt/oop/oop-ts"),
            &words,
            Some("/opt/oop/node".into()),
            true,
        );
        assert_eq!(exe.program, "/opt/oop/oop-ts");
        assert_eq!(all(&exe), ["doctor", "--json"]);
        assert!(exe.envs.is_empty());
    }
}
