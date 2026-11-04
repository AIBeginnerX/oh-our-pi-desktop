//! `oop stop`: ends the terminal's own server, and only that. The desktop app's server is the app's
//! to run (it ends with the app), and nothing is signalled to a process that does not check out as
//! this user's server on its announced port: the announcement is a file, and a pid can be reused.

use crate::cli_text::{t, tf};
use crate::server::{self, Discovery};
use std::path::Path;
use std::time::Duration;

/// How long the server gets to end after it is asked; it finishes writing its data first.
const STOP_WAIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(200);

/// What the command touches outside itself, so a test can stand in for the machine.
#[allow(async_fn_in_trait)]
pub trait Ports {
    /// Looks for the server on this computer. It must not start anything.
    async fn discover(&self) -> Discovery;
    /// The command line of the process when it is this user's and listens on the announced port.
    async fn inspect(&self, pid: u32, port: u16) -> Option<String>;
    fn terminate(&self, pid: u32);
    fn is_alive(&self, pid: u32) -> bool;
    /// Waits `by`; a test advances its own clock instead.
    async fn sleep(&self, by: Duration);
    fn out(&self, line: &str);
    fn err(&self, line: &str);
}

/// The real machine.
pub struct System<'a> {
    pub home: &'a Path,
}

impl Ports for System<'_> {
    async fn discover(&self) -> Discovery {
        server::discover_announced(self.home).await
    }
    async fn inspect(&self, pid: u32, port: u16) -> Option<String> {
        server::inspect(pid, port).await.map(|(_, command)| command)
    }
    fn terminate(&self, pid: u32) {
        server::terminate(pid);
    }
    fn is_alive(&self, pid: u32) -> bool {
        server::process_alive(pid)
    }
    async fn sleep(&self, by: Duration) {
        tokio::time::sleep(by).await;
    }
    fn out(&self, line: &str) {
        println!("{line}");
    }
    fn err(&self, line: &str) {
        eprintln!("{line}");
    }
}

/// Returns 0 when no server is left running, else 1.
pub async fn run(ports: &impl Ports) -> i32 {
    let found = match ports.discover().await {
        Discovery::Missing(_) | Discovery::Stale(_) => {
            ports.out(t("cli.stop.none"));
            return 0;
        }
        Discovery::Unreachable(_) => {
            ports.err(t("cli.stop.unreachable"));
            return 1;
        }
        Discovery::Found(found) => found,
    };
    if !found.daemon {
        ports.out(t("cli.stop.appServer"));
        return 1;
    }
    let port = server::parse_port(&found.origin).unwrap_or(0);
    let verified = ports
        .inspect(found.pid, port)
        .await
        .is_some_and(|command| server::parse_server_script(&command).is_some());
    if !verified {
        ports.err(&tf(
            "cli.stop.unverified",
            &[
                ("pid", found.pid.to_string()),
                ("origin", found.origin.clone()),
            ],
        ));
        return 1;
    }
    ports.out(t("cli.stop.stopping"));
    ports.terminate(found.pid);
    let mut waited = Duration::ZERO;
    while ports.is_alive(found.pid) {
        if waited >= STOP_WAIT {
            ports.err(&tf(
                "cli.stop.stillRunning",
                &[("pid", found.pid.to_string())],
            ));
            return 1;
        }
        ports.sleep(POLL).await;
        waited += POLL;
    }
    ports.out(t("cli.stop.done"));
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::Found;
    use std::cell::{Cell, RefCell};

    const SERVER_COMMAND: &str = "/Applications/OOP.app/Contents/MacOS/OOP /Applications/OOP.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs serve --daemon";

    fn found(daemon: bool) -> Discovery {
        Discovery::Found(Found {
            pid: 4242,
            origin: "http://127.0.0.1:3773".into(),
            environment_id: "env-1".into(),
            label: "내 Mac".into(),
            daemon,
        })
    }

    struct Fake {
        discovered: RefCell<Option<Discovery>>,
        command: Option<String>,
        /// The server is gone once this much time has been slept; `None` is gone at once.
        ends_after: Option<Duration>,
        clock: Cell<Duration>,
        alive: Cell<bool>,
        signalled: RefCell<Vec<u32>>,
        inspected: RefCell<Vec<(u32, u16)>>,
        out: RefCell<Vec<String>>,
        err: RefCell<Vec<String>>,
    }

    impl Fake {
        fn new(discovered: Discovery) -> Fake {
            Fake {
                discovered: RefCell::new(Some(discovered)),
                command: Some(SERVER_COMMAND.into()),
                ends_after: None,
                clock: Cell::new(Duration::ZERO),
                alive: Cell::new(true),
                signalled: RefCell::new(Vec::new()),
                inspected: RefCell::new(Vec::new()),
                out: RefCell::new(Vec::new()),
                err: RefCell::new(Vec::new()),
            }
        }
        fn said(&self) -> String {
            self.out.borrow().join("\n")
        }
        fn complained(&self) -> String {
            self.err.borrow().join("\n")
        }
    }

    impl Ports for Fake {
        async fn discover(&self) -> Discovery {
            self.discovered.borrow_mut().take().unwrap()
        }
        async fn inspect(&self, pid: u32, port: u16) -> Option<String> {
            self.inspected.borrow_mut().push((pid, port));
            self.command.clone()
        }
        fn terminate(&self, pid: u32) {
            self.signalled.borrow_mut().push(pid);
            if self.ends_after.is_none() {
                self.alive.set(false);
            }
        }
        fn is_alive(&self, _: u32) -> bool {
            self.alive.get()
        }
        async fn sleep(&self, by: Duration) {
            self.clock.set(self.clock.get() + by);
            if self.ends_after.is_some_and(|end| self.clock.get() >= end) {
                self.alive.set(false);
            }
        }
        fn out(&self, line: &str) {
            self.out.borrow_mut().push(line.into());
        }
        fn err(&self, line: &str) {
            self.err.borrow_mut().push(line.into());
        }
    }

    #[tokio::test]
    async fn stops_the_terminals_own_server_after_checking_the_process_and_warns_about_turns() {
        let fake = Fake::new(found(true));
        assert_eq!(run(&fake).await, 0);
        assert_eq!(*fake.inspected.borrow(), [(4242, 3773)]);
        assert_eq!(*fake.signalled.borrow(), [4242]);
        assert!(
            fake.said()
                .contains("A turn in progress will be interrupted")
        );
        assert!(fake.said().contains("Stopped."));
    }

    #[tokio::test]
    async fn waits_until_the_server_has_gone() {
        let mut fake = Fake::new(found(true));
        fake.ends_after = Some(Duration::from_secs(1));
        assert_eq!(run(&fake).await, 0);
        assert!(fake.said().contains("Stopped."));
        assert_eq!(fake.clock.get(), Duration::from_secs(1));
    }

    #[tokio::test]
    async fn does_not_stop_the_apps_server_and_says_whose_it_is() {
        let fake = Fake::new(found(false));
        assert_eq!(run(&fake).await, 1);
        assert!(fake.signalled.borrow().is_empty());
        assert!(fake.inspected.borrow().is_empty());
        assert!(fake.said().contains("belongs to the OOP app"));
    }

    #[tokio::test]
    async fn says_there_is_no_server_when_there_is_none_and_signals_nothing() {
        for discovered in [Discovery::Missing("x".into()), Discovery::Stale("x".into())] {
            let fake = Fake::new(discovered);
            assert_eq!(run(&fake).await, 0);
            assert!(fake.said().contains("No OOP server is running."));
            assert!(fake.signalled.borrow().is_empty());
        }
    }

    #[tokio::test]
    async fn signals_nothing_to_a_server_that_does_not_answer() {
        let fake = Fake::new(Discovery::Unreachable("x".into()));
        assert_eq!(run(&fake).await, 1);
        assert!(fake.signalled.borrow().is_empty());
        assert!(fake.complained().contains("not responding"));
    }

    #[tokio::test]
    async fn signals_nothing_to_a_pid_that_does_not_check_out_on_that_port() {
        let mut fake = Fake::new(found(true));
        fake.command = None;
        assert_eq!(run(&fake).await, 1);
        assert!(fake.signalled.borrow().is_empty());
        assert!(fake.complained().contains("could not confirm"));
        assert!(fake.complained().contains("pid 4242"));
    }

    #[tokio::test]
    async fn signals_nothing_to_a_process_that_is_not_running_the_oop_server_script() {
        let mut fake = Fake::new(found(true));
        fake.command = Some("/usr/bin/sleep 1000".into());
        assert_eq!(run(&fake).await, 1);
        assert!(fake.signalled.borrow().is_empty());
    }

    #[tokio::test]
    async fn reports_a_server_that_is_still_running_after_the_wait() {
        let mut fake = Fake::new(found(true));
        fake.ends_after = Some(Duration::from_secs(60));
        assert_eq!(run(&fake).await, 1);
        assert!(fake.complained().contains("has not exited yet"));
        assert_eq!(fake.clock.get(), STOP_WAIT);
    }
}
