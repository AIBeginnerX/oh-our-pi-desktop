//! The `notify` setting: the terminal bell when a turn finishes or the agent waits for an approval
//! or an answer, so a user in another window hears that it needs them. The rules are the TypeScript
//! terminal's (`syncThread` and `ringForRequest` in its controller): this only decides, the main
//! loop writes the bell.

use std::collections::HashSet;

/// What one update of the open thread looks like to the notifier.
pub struct Update<'a> {
    pub thread_id: &'a str,
    /// The agent is working (a turn runs or a message is still streaming).
    pub busy: bool,
    /// `approval:<id>` for the first open approval, else `input:<id>` for the first open question.
    pub pending_key: Option<String>,
    /// A queued message follows the turn at once, so nobody has to come back.
    pub queue_goes_on: bool,
    pub notify: bool,
}

#[derive(Default)]
pub struct Notifier {
    thread: Option<String>,
    was_busy: bool,
    /// Requests already rung for (or already waiting when the thread was opened).
    rung: HashSet<String>,
    /// The thread whose turn the user asked to stop.
    stop_requested: Option<String>,
}

impl Notifier {
    /// The user pressed Esc on this thread: its turn ending is not worth a bell.
    pub fn stop_requested(&mut self, thread_id: &str) {
        self.stop_requested = Some(thread_id.to_string());
    }

    /// True when the bell should ring for this update.
    pub fn observe(&mut self, update: &Update) -> bool {
        let first = self.thread.as_deref() != Some(update.thread_id);
        if first {
            self.thread = Some(update.thread_id.to_string());
            self.was_busy = update.busy;
        }
        let turn_ended = !first && self.was_busy && !update.busy;
        self.was_busy = update.busy;
        let mut ring = turn_ended
            && update.notify
            && self.stop_requested.as_deref() != Some(update.thread_id)
            && !update.queue_goes_on;
        if !update.busy && self.stop_requested.as_deref() == Some(update.thread_id) {
            self.stop_requested = None;
        }
        // A request already waiting when the thread was opened is not rung for: the user opened
        // it to look. The same request never rings twice.
        if let Some(key) = &update.pending_key
            && self.rung.insert(key.clone())
            && !first
            && update.notify
        {
            ring = true;
        }
        ring
    }
}

/// BEL, held back only on a `dumb` terminal.
pub fn bell_bytes(term: Option<&str>) -> &'static str {
    if term == Some("dumb") { "" } else { "\x07" }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update<'a>(busy: bool, key: Option<&str>) -> Update<'a> {
        Update {
            thread_id: "t1",
            busy,
            pending_key: key.map(str::to_string),
            queue_goes_on: false,
            notify: true,
        }
    }

    #[test]
    fn a_turn_that_ends_rings_once_and_opening_a_thread_does_not() {
        let mut n = Notifier::default();
        assert!(!n.observe(&update(true, None)), "opening a running thread");
        assert!(!n.observe(&update(true, None)));
        assert!(n.observe(&update(false, None)), "the turn ended");
        assert!(!n.observe(&update(false, None)), "idle again is not an end");
    }

    #[test]
    fn nothing_rings_when_notify_is_off() {
        let mut n = Notifier::default();
        n.observe(&update(true, None));
        let mut ended = update(false, None);
        ended.notify = false;
        assert!(!n.observe(&ended));
        let mut ask = update(false, Some("approval:a"));
        ask.notify = false;
        assert!(!n.observe(&ask));
    }

    #[test]
    fn a_stopped_turn_and_a_turn_followed_by_a_queued_message_stay_quiet() {
        let mut n = Notifier::default();
        n.observe(&update(true, None));
        n.stop_requested("t1");
        assert!(!n.observe(&update(false, None)));
        // the stop is spent: the next turn rings again
        n.observe(&update(true, None));
        assert!(n.observe(&update(false, None)));
        n.observe(&update(true, None));
        let mut queued = update(false, None);
        queued.queue_goes_on = true;
        assert!(!n.observe(&queued));
    }

    #[test]
    fn a_request_rings_once_and_one_already_waiting_at_open_never() {
        let mut n = Notifier::default();
        assert!(
            !n.observe(&update(false, Some("approval:old"))),
            "waiting when opened"
        );
        assert!(!n.observe(&update(false, Some("approval:old"))));
        assert!(n.observe(&update(false, Some("approval:new"))));
        assert!(
            !n.observe(&update(false, Some("approval:new"))),
            "never twice"
        );
        assert!(n.observe(&update(false, Some("input:q"))), "a question too");
    }

    #[test]
    fn the_bell_is_held_back_on_a_dumb_terminal_only() {
        assert_eq!(bell_bytes(Some("dumb")), "");
        assert_eq!(bell_bytes(Some("xterm")), "\x07");
        assert_eq!(bell_bytes(None), "\x07");
    }
}
