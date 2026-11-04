//! `oop doctor`: one note on the rail for each group of checks, then the count that passed. It
//! checks the colour level, symbols, theme, settings file, server and credentials file, and starts
//! nothing, reads no credential and prints no address. A check too long for the box is folded
//! under its own mark, not cut: what the doctor says is the whole point of it.

use crate::cli_text::{t, tf};
use crate::server::Discovery;
use crate::{settings, text, theme};
use std::path::{Path, PathBuf};

/// The widest a terminal is taken to be when the output is not one.
pub const DEFAULT_COLUMNS: usize = 80;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Os {
    Mac,
    Windows,
    Other,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Other
        }
    }
}

pub struct Deps<'a> {
    /// Holds `settings.json`, `credentials.json` and the user's themes.
    pub config_dir: PathBuf,
    pub env: &'a dyn Fn(&str) -> Option<String>,
    pub os: Os,
    pub is_tty: bool,
    /// Width of the terminal the lines go to.
    pub columns: usize,
    /// Whether this terminal can start the server of the installed app by itself: the script it
    /// would run, or `None` when there is none. `None` outside leaves the check out.
    pub standalone: Option<Option<String>>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Verdict {
    Ok,
    Warn,
    Fail,
}

struct Check {
    verdict: Verdict,
    text: String,
}

struct Section {
    title: String,
    checks: Vec<Check>,
}

fn check(verdict: Verdict, text: impl Into<String>) -> Check {
    Check {
        verdict,
        text: text.into(),
    }
}

/// Which variable decided the colour level, in the order `theme::color_level` looks at them.
fn color_reason(env: &dyn Fn(&str) -> Option<String>, is_tty: bool) -> String {
    let set = |name: &str| env(name).filter(|v| !v.is_empty());
    if env("FORCE_COLOR").is_some_and(|v| matches!(v.trim(), "0" | "1" | "2" | "3")) {
        return "FORCE_COLOR".into();
    }
    if set("NO_COLOR").is_some() {
        return "NO_COLOR".into();
    }
    if env("TERM").as_deref() == Some("dumb") {
        return "TERM=dumb".into();
    }
    if !is_tty {
        return t("doctor.reason.notTty").into();
    }
    if set("COLORTERM").is_some_and(|v| matches!(v.to_lowercase().as_str(), "truecolor" | "24bit"))
    {
        return "COLORTERM".into();
    }
    if set("WT_SESSION").is_some() {
        return "Windows Terminal".into();
    }
    if set("TERM").is_some_and(|v| v.contains("-256color")) {
        return "TERM".into();
    }
    t("doctor.reason.default").into()
}

fn port_of(origin: &str) -> String {
    crate::server::parse_port(origin).map_or_else(|| "?".into(), |port| port.to_string())
}

fn one_line(value: &str) -> String {
    text::sanitize(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The permission bits of a file; `None` when it is not there.
fn mode_of(path: &Path) -> Option<u32> {
    let meta = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Some(meta.permissions().mode())
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        Some(0o600)
    }
}

/// The checks, as data. Nothing here prints, starts the app, or reads a credential.
fn collect(deps: &Deps, found: &Discovery) -> (Vec<Section>, bool) {
    let env = deps.env;
    let windows = deps.os == Os::Windows;
    let level = theme::color_level(env, deps.is_tty);
    let settings_file = crate::cli_config::settings_file(&deps.config_dir);
    let read = settings::read_file(&settings_file);
    let mut resolved = read.settings.clone();
    settings::resolve_env(&mut resolved, &env, windows);
    let (_, theme_name, theme_warnings) =
        theme::startup(resolved.theme.as_deref(), level, env, &deps.config_dir);

    let mut terminal = vec![
        check(
            Verdict::Ok,
            tf(
                "doctor.color",
                &[
                    ("name", t(&format!("doctor.color.{level}")).to_string()),
                    ("reason", color_reason(env, deps.is_tty)),
                ],
            ),
        ),
        check(
            Verdict::Ok,
            tf(
                "doctor.symbols",
                &[
                    (
                        "kind",
                        if resolved.ascii { "ascii" } else { "unicode" }.into(),
                    ),
                    ("setting", resolved.symbols.clone()),
                ],
            ),
        ),
        check(Verdict::Ok, tf("doctor.theme", &[("name", theme_name)])),
    ];
    terminal.extend(
        theme_warnings
            .iter()
            .map(|warning| check(Verdict::Warn, one_line(warning))),
    );

    let mut settings_checks = Vec::new();
    let file_text = settings_file.display().to_string();
    if read.damaged {
        settings_checks.push(check(
            Verdict::Fail,
            read.warnings
                .first()
                .cloned()
                .unwrap_or_else(|| tf("doctor.settings.unreadable", &[("file", file_text)])),
        ));
    } else if !settings_file.exists() {
        settings_checks.push(check(Verdict::Ok, t("doctor.settings.none")));
    } else {
        settings_checks.push(check(
            Verdict::Ok,
            tf("doctor.settings.ok", &[("file", file_text)]),
        ));
    }
    if !read.damaged {
        settings_checks.extend(
            read.warnings
                .iter()
                .map(|warning| check(Verdict::Warn, one_line(warning))),
        );
    }

    let server = match found {
        Discovery::Found(server) => check(
            Verdict::Ok,
            tf(
                "doctor.server.found",
                &[
                    ("port", port_of(&server.origin)),
                    (
                        "kind",
                        t(if server.daemon {
                            "doctor.server.standalone"
                        } else {
                            "doctor.server.app"
                        })
                        .into(),
                    ),
                ],
            ),
        ),
        other => {
            let detail = one_line(other.detail());
            check(
                Verdict::Warn,
                tf(
                    "doctor.server.none",
                    &[(
                        "detail",
                        if detail.is_empty() {
                            String::new()
                        } else {
                            format!(" — {detail}")
                        },
                    )],
                ),
            )
        }
    };

    let credentials = match mode_of(&deps.config_dir.join("credentials.json")) {
        None => check(Verdict::Warn, t("doctor.credentials.none")),
        Some(mode) if !windows && mode & 0o077 != 0 => check(
            Verdict::Fail,
            tf(
                "doctor.credentials.wide",
                &[("mode", format!("{:o}", mode & 0o777))],
            ),
        ),
        Some(_) => check(Verdict::Ok, t("doctor.credentials.ok")),
    };

    let standalone = deps.standalone.as_ref().map(|script| match script {
        Some(script) => check(
            Verdict::Ok,
            tf("doctor.standalone.ok", &[("script", script.clone())]),
        ),
        None if deps.os != Os::Other => check(Verdict::Warn, t("doctor.standalone.noApp")),
        None => check(Verdict::Ok, t("doctor.standalone.unsupported")),
    });

    let mut connection = vec![server];
    connection.extend(standalone);
    connection.push(credentials);
    (
        vec![
            Section {
                title: t("doctor.section.terminal").into(),
                checks: terminal,
            },
            Section {
                title: t("doctor.section.settings").into(),
                checks: settings_checks,
            },
            Section {
                title: t("doctor.section.connection").into(),
                checks: connection,
            },
        ],
        resolved.ascii,
    )
}

/// The marks of the rail, in unicode or ASCII.
struct Marks {
    start: &'static str,
    bar: &'static str,
    end: &'static str,
    tee: &'static str,
    done: &'static str,
    check: &'static str,
    cross: &'static str,
    warning: &'static str,
    horizontal: &'static str,
    top_right: &'static str,
    bottom_right: &'static str,
}

const UNICODE: Marks = Marks {
    start: "┌",
    bar: "│",
    end: "└",
    tee: "├",
    done: "◇",
    check: "✓",
    cross: "✗",
    warning: "▲",
    horizontal: "─",
    top_right: "╮",
    bottom_right: "╯",
};

const ASCII: Marks = Marks {
    start: "+",
    bar: "|",
    end: "+",
    tee: "+",
    done: "o",
    check: "+",
    cross: "x",
    warning: "!",
    horizontal: "-",
    top_right: "+",
    bottom_right: "+",
};

/// The `ansi` theme's colours: 16-colour codes, or nothing at all when the terminal takes none.
#[derive(Clone, Copy)]
struct Paint {
    on: bool,
}

impl Paint {
    fn wrap(self, open: &str, close: &str, text: &str) -> String {
        if self.on {
            format!("\u{1b}[{open}m{text}\u{1b}[{close}m")
        } else {
            text.to_string()
        }
    }
    fn success(self, text: &str) -> String {
        self.wrap("32", "39", text)
    }
    fn warning(self, text: &str) -> String {
        self.wrap("33", "39", text)
    }
    fn error(self, text: &str) -> String {
        self.wrap("31", "39", text)
    }
    fn dim(self, text: &str) -> String {
        self.wrap("90", "39", text)
    }
    fn bold(self, text: &str) -> String {
        self.wrap("1", "22", text)
    }
    fn chip(self, text: &str) -> String {
        self.wrap("7", "27", &self.wrap("95", "39", &self.bold(text)))
    }
}

/// `text` without its colour codes, to measure what is on screen.
fn strip_paint(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for next in chars.by_ref() {
                if next == 'm' {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// A row of a note: the painted text and the room it takes on screen.
struct Row {
    styled: String,
    width: usize,
}

/// The lines `oop doctor` prints, and its exit code: 1 when a check failed, else 0.
pub fn render(deps: &Deps, found: &Discovery) -> (Vec<String>, i32) {
    let (sections, ascii) = collect(deps, found);
    let level = theme::color_level(deps.env, deps.is_tty);
    let paint = Paint { on: level > 0 };
    let marks = if ascii { &ASCII } else { &UNICODE };
    let width = deps.columns.max(20);
    // The room inside a note: its frame takes the rail, the padding and the right edge.
    let room = width - 6;

    let mut lines = Vec::new();
    let chip = if paint.on && !ascii {
        paint.chip(" oop doctor ")
    } else {
        "oop doctor".to_string()
    };
    // What does not fit beside the name is cut, so no line is wider than the terminal.
    let lead = text::width(marks.start) + 2 + text::width(&strip_paint(&chip)) + 2;
    let subtitle = text::truncate(t("doctor.title"), width.saturating_sub(lead));
    lines.push(format!(
        "{}  {chip}  {}",
        paint.dim(marks.start),
        paint.dim(&subtitle)
    ));
    let gap = || paint.dim(marks.bar);
    for section in &sections {
        lines.push(gap());
        let mut body = Vec::new();
        for item in &section.checks {
            let mark = match item.verdict {
                Verdict::Ok => paint.success(marks.check),
                Verdict::Warn => paint.warning(marks.warning),
                Verdict::Fail => paint.error(marks.cross),
            };
            let rows = text::wrap(&one_line(&item.text), room.saturating_sub(2).max(1));
            for (index, row) in rows.into_iter().enumerate() {
                let lead = if index == 0 {
                    format!("{mark} ")
                } else {
                    "  ".to_string()
                };
                body.push(Row {
                    width: 2 + text::width(&row),
                    styled: format!("{lead}{row}"),
                });
            }
        }
        note(&mut lines, paint, marks, &section.title, &body, width);
    }
    let all: Vec<&Check> = sections.iter().flat_map(|s| &s.checks).collect();
    let failed = all.iter().filter(|c| c.verdict == Verdict::Fail).count();
    let attention = failed + all.iter().filter(|c| c.verdict == Verdict::Warn).count();
    lines.push(gap());
    let verdict = if attention == 0 {
        paint.success(&format!(
            "{} {}",
            tf(
                "doctor.passed",
                &[
                    ("passed", (all.len() - attention).to_string()),
                    ("total", all.len().to_string()),
                ]
            ),
            marks.check
        ))
    } else {
        let text = format!(
            "{} {}",
            tf("doctor.attention", &[("count", attention.to_string())]),
            marks.warning
        );
        if failed > 0 {
            paint.error(&text)
        } else {
            paint.warning(&text)
        }
    };
    lines.push(format!("{}  {verdict}", paint.dim(marks.end)));
    (lines, i32::from(failed > 0))
}

/// A boxed note hanging off the rail: the title row joins the box to the rail, and so does its
/// last row. The box is as wide as the widest row, up to `width`, and every row of it, corners
/// included, ends in the same column.
fn note(
    lines: &mut Vec<String>,
    paint: Paint,
    marks: &Marks,
    title: &str,
    body: &[Row],
    width: usize,
) {
    let widest = body
        .iter()
        .map(|row| row.width)
        .chain([text::width(title)])
        .max()
        .unwrap_or(0);
    // `len` is the width of the box between the rail and the right edge, padding included.
    let len = (width.saturating_sub(4)).min(widest + 2).max(6);
    let cut = text::truncate(title, len - 3);
    let side = paint.dim(marks.bar);
    let row = |styled: &str, shown: usize| {
        format!(
            "{side}  {styled}{}  {side}",
            " ".repeat((len - 2).saturating_sub(shown))
        )
    };
    lines.push(format!(
        "{}  {} {}",
        paint.success(marks.done),
        paint.bold(&cut),
        paint.dim(&format!(
            "{}{}",
            marks
                .horizontal
                .repeat((len - text::width(&cut) - 1).max(1)),
            marks.top_right
        ))
    ));
    lines.push(row("", 0));
    for item in body {
        lines.push(row(&item.styled, item.width));
    }
    lines.push(row("", 0));
    lines.push(paint.dim(&format!(
        "{}{}{}",
        marks.tee,
        marks.horizontal.repeat(len + 2),
        marks.bottom_right
    )));
}

/// What `oop doctor` looks at on the real machine, then prints it.
pub async fn run(deps: &Deps<'_>, home: &Path) -> i32 {
    let found = crate::server::discover_announced(home).await;
    let (lines, code) = render(deps, &found);
    for line in lines {
        println!("{line}");
    }
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::Found;

    #[cfg(unix)]
    const SECRET: &str = "not-a-real-value";

    fn root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oop-rs-doctor-{}-{name}", text::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn server(daemon: bool) -> Discovery {
        Discovery::Found(Found {
            pid: 1,
            origin: "http://127.0.0.1:3773".into(),
            environment_id: "env".into(),
            label: "local".into(),
            daemon,
        })
    }

    #[derive(Clone)]
    struct Setup {
        env: Vec<(&'static str, &'static str)>,
        is_tty: bool,
        os: Os,
        columns: usize,
        standalone: Option<Option<String>>,
    }

    impl Default for Setup {
        fn default() -> Setup {
            Setup {
                env: vec![("LANG", "en_US.UTF-8"), ("COLORTERM", "truecolor")],
                is_tty: true,
                os: Os::Mac,
                columns: 200,
                standalone: None,
            }
        }
    }

    struct Ran {
        code: i32,
        lines: Vec<String>,
        plain: String,
    }

    fn strip(line: &str) -> String {
        strip_paint(line)
    }

    fn run_with(dir: &Path, setup: &Setup, found: &Discovery) -> Ran {
        let env = setup.env.clone();
        let lookup = move |key: &str| {
            env.iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.to_string())
        };
        let (lines, code) = render(
            &Deps {
                config_dir: dir.to_path_buf(),
                env: &lookup,
                os: setup.os,
                is_tty: setup.is_tty,
                columns: setup.columns,
                standalone: setup.standalone.clone(),
            },
            found,
        );
        let plain = lines
            .iter()
            .map(|l| strip(l))
            .collect::<Vec<_>>()
            .join("\n");
        Ran { code, lines, plain }
    }

    fn run(dir: &Path) -> Ran {
        run_with(dir, &Setup::default(), &server(false))
    }

    fn last(ran: &Ran) -> &str {
        ran.plain.trim_end().lines().last().unwrap()
    }

    #[cfg(unix)]
    fn write_credentials(dir: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        let file = dir.join("credentials.json");
        std::fs::write(&file, format!(r#"{{"token": "{SECRET}"}}"#)).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn prints_a_tree_with_the_colour_symbols_theme_settings_server_and_credential_checks() {
        let dir = root("tree");
        write_credentials(&dir, 0o600);
        let ran = run(&dir);
        assert_eq!(ran.code, 0);
        let plain = &ran.plain;
        let first = plain.lines().next().unwrap();
        assert!(
            first.starts_with("┌ ")
                && first.contains(" oop doctor ")
                && first.ends_with("  Terminal check"),
            "{first}"
        );
        for expected in [
            "◇  Terminal ",
            "◇  Settings ",
            "◇  Connection ",
            "│  ✓ Color: true color (COLORTERM)",
            "│  ✓ Symbols: unicode",
            "│  ✓ Theme:",
            "│  ✓ No settings file (using defaults)",
            "│  ✓ OOP server on this computer: running (port 3773)",
            "│  ✓ Credentials file present (contents not read)",
        ] {
            assert!(plain.contains(expected), "{expected}\n{plain}");
        }
        assert_eq!(last(&ran), "└  6/6 checks passed ✓");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn says_whose_the_server_is_the_apps_the_terminals_own_or_none() {
        let dir = root("whose");
        let setup = Setup::default();
        assert!(
            run_with(&dir, &setup, &server(false))
                .plain
                .contains("running (port 3773) — server used by the app")
        );
        assert!(
            run_with(&dir, &setup, &server(true))
                .plain
                .contains("running (port 3773) — terminal-only server")
        );
        assert!(
            run_with(&dir, &setup, &Discovery::Missing("x".into()))
                .plain
                .contains("OOP server on this computer: none — x")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn says_whether_the_terminal_can_start_the_server_by_itself() {
        let dir = root("standalone");
        let mut setup = Setup {
            standalone: Some(Some("/Applications/OOP.app/x/bin.mjs".into())),
            ..Setup::default()
        };
        let can = run_with(&dir, &setup, &server(false));
        assert!(
            can.plain.contains(
                "✓ Standalone terminal mode: available (/Applications/OOP.app/x/bin.mjs)"
            ),
            "{}",
            can.plain
        );
        setup.standalone = Some(None);
        let cannot = run_with(&dir, &setup, &server(false));
        assert!(cannot.plain.contains(
            "▲ Standalone terminal mode: unavailable — the installed OOP app was not found"
        ));
        setup.os = Os::Other;
        let other = run_with(&dir, &setup, &server(false));
        assert!(
            other
                .plain
                .contains("✓ Standalone terminal mode: not supported on this operating system")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn never_prints_the_credentials_contents_or_the_server_address() {
        let dir = root("secret");
        write_credentials(&dir, 0o600);
        let ran = run(&dir);
        let text = ran.lines.join("\n");
        assert!(!text.contains(SECRET) && !text.contains("127.0.0.1"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn exits_1_when_the_credential_file_is_readable_by_others_and_says_how_to_fix_it() {
        let dir = root("wide");
        write_credentials(&dir, 0o644);
        let ran = run(&dir);
        assert_eq!(ran.code, 1);
        assert!(
            ran.plain
                .contains("✗ The credentials file permissions are too open (644)")
        );
        assert!(ran.plain.contains("chmod 600"));
        assert_eq!(last(&ran), "└  1 need attention ▲");
        assert!(!ran.plain.contains(SECRET));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn does_not_judge_unix_permission_bits_on_windows() {
        let dir = root("windows");
        write_credentials(&dir, 0o644);
        let setup = Setup {
            os: Os::Windows,
            ..Setup::default()
        };
        assert_eq!(run_with(&dir, &setup, &server(false)).code, 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn warns_without_failing_when_there_is_no_server_or_no_credential_file() {
        let dir = root("none");
        let ran = run_with(
            &dir,
            &Setup::default(),
            &Discovery::Missing("server-runtime.json missing".into()),
        );
        assert_eq!(ran.code, 0);
        assert!(
            ran.plain
                .contains("▲ OOP server on this computer: none — server-runtime.json missing")
        );
        assert!(ran.plain.contains("▲ No credentials file"));
        assert_eq!(last(&ran), "└  2 need attention ▲");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fails_on_a_settings_file_it_cannot_read_and_leaves_the_file_as_it_was() {
        let dir = root("damaged");
        let file = dir.join("settings.json");
        std::fs::write(&file, "{ not json").unwrap();
        let ran = run(&dir);
        assert_eq!(ran.code, 1);
        assert!(ran.plain.contains('✗'));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ not json");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn explains_why_colour_is_off_and_prints_no_escape_codes_then() {
        let dir = root("no-color");
        let setup = Setup {
            env: vec![("NO_COLOR", "1"), ("LANG", "en_US.UTF-8")],
            ..Setup::default()
        };
        let ran = run_with(&dir, &setup, &server(false));
        assert!(ran.plain.contains("Color: none (NO_COLOR)"));
        assert!(ran.lines.iter().all(|line| *line == strip(line)));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn is_plain_without_a_terminal() {
        let dir = root("pipe");
        let setup = Setup {
            is_tty: false,
            env: vec![("LANG", "en_US.UTF-8")],
            ..Setup::default()
        };
        let ran = run_with(&dir, &setup, &server(false));
        assert!(ran.plain.contains("Color: none (not a terminal)"));
        assert!(ran.lines.iter().all(|line| !line.contains('\u{1b}')));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn draws_the_tree_in_ascii_under_the_ascii_preset() {
        let dir = root("ascii");
        let setup = Setup {
            env: vec![("LANG", "C"), ("COLORTERM", "truecolor")],
            ..Setup::default()
        };
        let ran = run_with(&dir, &setup, &server(false));
        assert!(ran.plain.contains("Symbols: ascii"));
        assert!(
            !ran.plain.chars().any(|c| "┌◇│└✓✗▲".contains(c)),
            "{}",
            ran.plain
        );
        assert!(ran.plain.contains("+  oop doctor"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn keeps_every_line_inside_the_terminal_and_every_note_box_one_width_at_any_width() {
        let dir = root("widths");
        write_credentials(&dir, 0o644);
        let detail = "서버 실행 기록이 없습니다 ".repeat(6);
        let envs: [Vec<(&'static str, &'static str)>; 3] = [
            vec![("LANG", "en_US.UTF-8"), ("COLORTERM", "truecolor")],
            vec![("NO_COLOR", "1"), ("LANG", "en_US.UTF-8")],
            vec![("LANG", "C")],
        ];
        for columns in [30, 40, 80, 120] {
            for env in &envs {
                let setup = Setup {
                    columns,
                    env: env.clone(),
                    ..Setup::default()
                };
                let ran = run_with(&dir, &setup, &Discovery::Missing(detail.clone()));
                for line in &ran.lines {
                    assert!(
                        text::width(&strip(line)) <= columns,
                        "@ {columns}: {}",
                        strip(line)
                    );
                }
                let mut open: Vec<usize> = Vec::new();
                for row in ran.lines.iter().map(|l| strip(l)) {
                    let width = text::width(&row);
                    if row.starts_with("◇  ") || row.starts_with("o  ") {
                        open = vec![width];
                    } else if !open.is_empty() && (row.starts_with('|') || row.starts_with('│')) {
                        open.push(width);
                    } else if !open.is_empty() && (row.starts_with('+') || row.starts_with('├')) {
                        open.push(width);
                        assert!(open.iter().all(|w| *w == open[0]), "@ {columns}: {open:?}");
                        open.clear();
                    }
                }
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn counts_the_checks_that_need_a_look_and_says_so_in_the_warning_colour() {
        let dir = root("count");
        let ran = run(&dir);
        assert_eq!(last(&ran), "└  1 need attention ▲");
        let end = ran.lines.last().unwrap();
        assert!(end.contains("\u{1b}[33m"), "{end:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
