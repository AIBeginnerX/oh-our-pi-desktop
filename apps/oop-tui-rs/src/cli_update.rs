//! `oop update`: says which version is current, looks up the newest release, and either says there
//! is nothing to do or lists what the newer releases brought and how to get them. It installs
//! nothing. Without a running app the terminal app's own version is the current one.

use crate::cli_text::{t, tf};
use crate::server;
use crate::update::{self, LatestRelease};
use std::path::{Path, PathBuf};

/// What the command touches outside itself, so a test can stand in for the machine.
#[allow(async_fn_in_trait)]
pub trait Ports {
    /// Version of the desktop app when one is running; `None` when none answers. Starts nothing.
    async fn app_version(&self) -> Option<String>;
    /// The newest release, looked up again; `None` when it cannot be reached.
    async fn check(&self) -> Option<LatestRelease>;
    fn env(&self, key: &str) -> Option<String>;
    fn out(&self, line: &str);
    fn err(&self, line: &str);
}

/// Returns 0 once the verdict is out, 1 when the release could not be looked up.
pub async fn run(terminal_version: &str, ports: &impl Ports) -> i32 {
    let app = ports.app_version().await;
    let current = app.clone().unwrap_or_else(|| terminal_version.to_string());
    ports.out(&tf("cli.update.current", &[("version", current.clone())]));
    ports.out(t("cli.update.checking"));
    let Some(info) = ports.check().await else {
        ports.err(t("cli.update.checkFailed"));
        return 1;
    };
    let report = update::report_now(&current, &info);
    if report.newer {
        ports.out(&tf(
            "cli.update.available",
            &[("current", current), ("latest", report.latest.clone())],
        ));
        let (shown, omitted) = update::listed(&report);
        for release in shown {
            ports.out(&format!("  {}", update::release_title(release)));
            for highlight in release.highlights.iter().take(update::LISTED_HIGHLIGHTS) {
                ports.out(&format!("    - {highlight}"));
            }
        }
        if omitted > 0 {
            ports.out(&tf("cli.update.more", &[("count", omitted.to_string())]));
        }
        let env = |key: &str| ports.env(key);
        ports.out(&update::update_how_to(
            update::runs_from_terminal_install(env),
            cfg!(windows),
        ));
    } else {
        ports.out(&tf("cli.update.upToDate", &[("version", current)]));
    }
    if let Some(app) = app.filter(|app| update::terminal_is_behind(terminal_version, Some(app))) {
        let env = |key: &str| ports.env(key);
        ports.out(&update::terminal_behind_text(
            terminal_version,
            &app,
            update::runs_in_desktop_app(env),
            update::runs_from_terminal_install(|key| ports.env(key)),
        ));
    }
    0
}

/// The real machine: the app is looked for at `--server`, else where the announcement says.
pub struct System<'a> {
    pub server: Option<&'a str>,
    pub home: &'a Path,
    pub config_dir: PathBuf,
}

impl Ports for System<'_> {
    async fn app_version(&self) -> Option<String> {
        let origin = match self.server {
            Some(address) if address.contains("://") => address.to_string(),
            Some(address) => format!("http://{address}"),
            None => match server::discover_announced(self.home).await {
                server::Discovery::Found(found) => found.origin,
                _ => return None,
            },
        };
        let version = server::probe_version(&origin).await?;
        let version = version.trim();
        update::is_release_version(version).then(|| version.to_string())
    }
    async fn check(&self) -> Option<LatestRelease> {
        update::lookup(
            &update::Urls::default(),
            Some(&update::cache_path(&self.config_dir)),
            crate::lists::now_ms(),
            true,
            update::FETCH_TIMEOUT,
        )
        .await
    }
    fn env(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
    fn out(&self, line: &str) {
        println!("{line}");
    }
    fn err(&self, line: &str) {
        eprintln!("{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::{Highlight, ReleaseNote};
    use std::cell::{Cell, RefCell};

    fn note(version: &str, date: &str, highlights: &[(&str, &str)]) -> ReleaseNote {
        ReleaseNote {
            version: version.into(),
            date: date.into(),
            highlights: highlights
                .iter()
                .map(|(en, ko)| Highlight {
                    en: en.to_string(),
                    ko: Some(ko.to_string()),
                })
                .collect(),
        }
    }

    fn info() -> LatestRelease {
        LatestRelease {
            latest: "0.0.130".into(),
            releases: vec![
                note("0.0.130", "2026-11-03", &[("A", "가"), ("B", "나")]),
                note("0.0.129", "", &[("C", "다")]),
                note("0.0.128", "2026-11-01", &[("D", "라")]),
                note("0.0.127", "2026-10-31", &[("E", "마")]),
            ],
        }
    }

    struct Fake {
        app: Option<String>,
        release: Option<LatestRelease>,
        checks: Cell<u32>,
        terminal_install: bool,
        out: RefCell<Vec<String>>,
        err: RefCell<Vec<String>>,
    }

    fn fake(app: Option<&str>, release: Option<LatestRelease>) -> Fake {
        Fake {
            app: app.map(str::to_string),
            release,
            checks: Cell::new(0),
            terminal_install: false,
            out: RefCell::new(Vec::new()),
            err: RefCell::new(Vec::new()),
        }
    }

    impl Ports for Fake {
        async fn app_version(&self) -> Option<String> {
            self.app.clone()
        }
        async fn check(&self) -> Option<LatestRelease> {
            self.checks.set(self.checks.get() + 1);
            self.release.clone()
        }
        fn env(&self, key: &str) -> Option<String> {
            (self.terminal_install && key == "OOP_TERMINAL_INSTALL").then(|| "1".to_string())
        }
        fn out(&self, line: &str) {
            self.out.borrow_mut().push(line.into());
        }
        fn err(&self, line: &str) {
            self.err.borrow_mut().push(line.into());
        }
    }

    #[tokio::test]
    async fn says_the_version_that_it_is_checking_and_that_the_app_is_already_the_newest() {
        let ports = fake(
            Some("0.0.127"),
            Some(LatestRelease {
                latest: "0.0.127".into(),
                releases: vec![],
            }),
        );
        assert_eq!(run("0.0.127", &ports).await, 0);
        assert_eq!(
            *ports.out.borrow(),
            [
                "Current version: 0.0.127",
                "Checking for updates…",
                "You are up to date (0.0.127)."
            ]
        );
        assert!(ports.err.borrow().is_empty());
    }

    #[tokio::test]
    async fn lists_each_newer_release_with_its_highlights_then_how_to_update() {
        let ports = fake(Some("0.0.127"), Some(info()));
        assert_eq!(run("0.0.127", &ports).await, 0);
        let out = ports.out.borrow();
        assert_eq!(
            out[..3],
            [
                "Current version: 0.0.127",
                "Checking for updates…",
                "Update available: 0.0.127 → 0.0.130"
            ]
        );
        assert_eq!(
            out[3..out.len() - 1],
            [
                "  0.0.130 (2026-11-03)",
                "    - A",
                "    - B",
                "  0.0.129",
                "    - C",
                "  0.0.128 (2026-11-01)",
                "    - D",
            ]
        );
        assert!(out.last().unwrap().starts_with("How to update: "));
        assert_eq!(ports.checks.get(), 1, "the release is looked up again once");
    }

    #[tokio::test]
    async fn a_terminal_only_install_is_told_to_run_the_installer() {
        let mut ports = fake(None, Some(info()));
        ports.terminal_install = true;
        run("0.0.127", &ports).await;
        let last = ports.out.borrow().last().unwrap().clone();
        assert!(
            last.starts_with("How to update: run ") && last.contains("install-terminal"),
            "{last}"
        );
    }

    #[tokio::test]
    async fn measures_from_the_terminal_apps_own_version_when_no_app_is_running() {
        let ports = fake(None, Some(info()));
        run("0.0.128", &ports).await;
        let out = ports.out.borrow();
        assert_eq!(out[0], "Current version: 0.0.128");
        assert_eq!(out[2], "Update available: 0.0.128 → 0.0.130");
        assert!(!out.join("\n").contains("Terminal app"));
    }

    #[tokio::test]
    async fn measures_from_the_apps_version_and_says_when_the_terminal_app_is_older() {
        let ports = fake(Some("0.0.129"), Some(info()));
        run("0.0.120", &ports).await;
        {
            let out = ports.out.borrow();
            assert_eq!(out[0], "Current version: 0.0.129");
            assert_eq!(out[2], "Update available: 0.0.129 → 0.0.130");
            assert!(
                out.last().unwrap().starts_with(
                    "Terminal app 0.0.120 is older than the app 0.0.129 — reinstall with: "
                ),
                "{:?}",
                out.last()
            );
        }
        let current = fake(Some("0.0.130"), Some(info()));
        run("0.0.120", &current).await;
        let out = current.out.borrow();
        assert!(out.contains(&"You are up to date (0.0.130).".to_string()));
        assert!(out.last().unwrap().starts_with("Terminal app 0.0.120"));
    }

    #[tokio::test]
    async fn leaves_out_the_releases_past_ten_with_a_count() {
        let many = LatestRelease {
            latest: "0.0.150".into(),
            releases: (0..24)
                .map(|i| note(&format!("0.0.{}", 150 - i), "", &[("x", "엑스")]))
                .collect(),
        };
        let ports = fake(Some("0.0.127"), Some(many));
        run("0.0.127", &ports).await;
        let out = ports.out.borrow();
        let titles = out.iter().filter(|line| line.starts_with("  0.0.")).count();
        assert_eq!(titles, 10);
        assert!(
            out.contains(&"  and 13 more releases".to_string()),
            "{out:?}"
        );
    }

    #[tokio::test]
    async fn fails_with_a_message_and_exit_1_when_the_release_cannot_be_looked_up() {
        let ports = fake(Some("0.0.127"), None);
        assert_eq!(run("0.0.127", &ports).await, 1);
        assert_eq!(
            *ports.out.borrow(),
            ["Current version: 0.0.127", "Checking for updates…"]
        );
        assert_eq!(
            *ports.err.borrow(),
            ["Could not check for updates. Check your network connection."]
        );
    }
}
