//! The thread list as the desktop sidebar builds it: a port of `buildSidebar`
//! (from the former TypeScript terminal) with the sort helpers of
//! packages/client-runtime/src/state/threadSort.ts and the snooze rules of threadSettled.ts.
//!
//! Archived threads and crew tasks leave the list (a crew task is counted under its lead unless it
//! waits for the user); the rest fall in the pinned, active, snoozed and settled sections. Snoozed
//! and settled are shelves that start closed, and the thread on screen stays visible on a closed
//! shelf. A row says which project it is in. `now` is a parameter so the order is testable.

use crate::state::{ProjectShell, ThreadShell};
use crate::text::parse_iso_ms;
use std::cmp::{Ordering, Reverse};
use std::collections::HashMap;

/// The settled shelf shows this many rows when opened, and this many more each time it is asked.
pub const SETTLED_INITIAL: usize = 10;
pub const SETTLED_PAGE: usize = 25;

/// What the reader changed in the list: which shelves are open and how much of the settled one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub snoozed_open: bool,
    pub settled_open: bool,
    pub settled_shown: usize,
}

impl Default for View {
    fn default() -> Self {
        View {
            snoozed_open: false,
            settled_open: false,
            settled_shown: SETTLED_INITIAL,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Pinned,
    Active,
    Snoozed,
    Settled,
}

/// The status a row shows, in the desktop's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Approval,
    Input,
    Working,
    Monitoring,
    Failed,
    Woke,
    Unread,
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadRow {
    pub id: String,
    pub project: Option<String>,
    pub title: String,
    pub status: Status,
    pub since: String,
    pub pinned: bool,
    pub current: bool,
    /// Crew tasks folded under this thread.
    pub crew: usize,
    pub section: Section,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Nav {
    /// "New thread"; `current` while a draft is on screen.
    New {
        current: bool,
    },
    /// A header between the pinned and the active block.
    Header(Section),
    Shelf {
        section: Section,
        count: usize,
        open: bool,
    },
    Thread(ThreadRow),
    More {
        section: Section,
        count: usize,
    },
}

pub struct Input<'a> {
    pub threads: &'a [ThreadShell],
    pub projects: &'a [ProjectShell],
    /// The thread on screen; `None` for a draft.
    pub current_id: Option<&'a str>,
    pub draft: bool,
    pub now_ms: i64,
    /// When each thread was last on screen: a wake or an answer after it is unseen.
    pub visited: &'a HashMap<String, i64>,
    pub view: &'a View,
}

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;

fn ms(stamp: &str) -> Option<i64> {
    parse_iso_ms(stamp)
}

fn ms_opt(stamp: &Option<String>) -> Option<i64> {
    stamp.as_deref().and_then(ms)
}

/// The desktop sidebar's compact age: `now` under a minute, then `5m`, `3h`, `2d`.
pub fn compact_age(stamp: Option<&str>, now_ms: i64) -> String {
    let Some(then) = stamp.and_then(ms) else {
        return String::new();
    };
    let minutes = (now_ms - then).max(0) / MINUTE;
    if minutes < 1 {
        return "now".into();
    }
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 24 {
        format!("{hours}h")
    } else {
        format!("{}d", hours / 24)
    }
}

/// How long a working thread has been at it (`3m`, `1h 5m`); empty under a minute.
fn working_for(thread: &ThreadShell, now_ms: i64) -> String {
    let session_at = thread.session.as_ref().map(|s| s.updated_at.as_str());
    let from: Vec<Option<&str>> = match &thread.latest_turn {
        Some(turn) if turn.completed_at.is_none() => vec![
            turn.started_at.as_deref(),
            Some(turn.requested_at.as_str()),
            session_at,
        ],
        _ => vec![session_at],
    };
    let Some(started) = from.into_iter().flatten().find_map(ms) else {
        return String::new();
    };
    let minutes = (now_ms - started).max(0) / MINUTE;
    match minutes {
        0 => String::new(),
        1..=59 => format!("{minutes}m"),
        _ => format!("{}h {}m", minutes / 60, minutes % 60),
    }
}

/// A snoozed thread raises its hand when something outranks the snooze: the agent is blocked on
/// the user, the session failed after the snooze, or a run completed after it.
fn raised_hand(thread: &ThreadShell) -> bool {
    if thread.has_pending_approvals || thread.has_pending_user_input {
        return true;
    }
    let snoozed_at = ms_opt(&thread.snoozed_at);
    if let Some(session) = &thread.session
        && session.status == "error"
        && (thread.snoozed_at.is_none()
            || ms(&session.updated_at)
                .zip(snoozed_at)
                .is_some_and(|(a, b)| a > b))
    {
        return true;
    }
    if let (Some(at), Some(turn)) = (snoozed_at, &thread.latest_turn)
        && turn.state == "completed"
        && ms_opt(&turn.completed_at).is_some_and(|c| c > at)
    {
        return true;
    }
    false
}

fn effective_snoozed(thread: &ThreadShell, now_ms: i64) -> bool {
    match ms_opt(&thread.snoozed_until) {
        Some(wake) if wake > now_ms => !raised_hand(thread),
        _ => false,
    }
}

/// When a previously snoozed thread woke, or `None` if it never snoozed or still is.
fn woke_at(thread: &ThreadShell, now_ms: i64) -> Option<i64> {
    let wake = ms_opt(&thread.snoozed_until)?;
    if raised_hand(thread) {
        if let (Some(at), Some(turn)) = (ms_opt(&thread.snoozed_at), &thread.latest_turn)
            && turn.state == "completed"
            && let Some(done) = ms_opt(&turn.completed_at)
            && done > at
        {
            return Some(done);
        }
        return thread
            .session
            .as_ref()
            .and_then(|s| ms(&s.updated_at))
            .or_else(|| ms_opt(&thread.snoozed_at));
    }
    (wake <= now_ms).then_some(wake)
}

fn wake_label(until: &str, now_ms: i64) -> String {
    let Some(wake) = ms(until) else {
        return "now".into();
    };
    let remaining = wake - now_ms;
    if remaining <= 0 {
        "now".into()
    } else if remaining < HOUR {
        format!("{}m", ((remaining + MINUTE - 1) / MINUTE).max(1))
    } else if remaining < DAY {
        format!("{}h", (remaining + HOUR - 1) / HOUR)
    } else {
        format!("{}d", (remaining + DAY - 1) / DAY)
    }
}

/// The stamp a settled row sorts and labels by: `settledAt` when stamped, else the latest message
/// or turn stamp, then `updatedAt`.
fn settled_stamp(thread: &ThreadShell) -> Option<String> {
    if let Some(at) = thread.settled_at.as_deref().filter(|a| ms(a).is_some()) {
        return Some(at.to_string());
    }
    let turn = thread.latest_turn.as_ref();
    let candidates = [
        thread.latest_user_message_at.clone(),
        turn.map(|t| t.requested_at.clone()),
        turn.and_then(|t| t.started_at.clone()),
        turn.and_then(|t| t.completed_at.clone()),
    ];
    let mut best: Option<(i64, String)> = None;
    for candidate in candidates.into_iter().flatten() {
        if let Some(value) = ms(&candidate)
            && best.as_ref().is_none_or(|(b, _)| value > *b)
        {
            best = Some((value, candidate));
        }
    }
    best.map(|(_, s)| s)
        .or_else(|| ms(&thread.updated_at).map(|_| thread.updated_at.clone()))
}

fn sort_settled(threads: &mut [&ThreadShell]) {
    threads.sort_by_cached_key(|t| {
        (
            Reverse(settled_stamp(t).and_then(|s| ms(&s)).unwrap_or(0)),
            t.id.clone(),
        )
    });
}

/// Arranged keys first (string order), then keyless threads newest-created first.
pub(crate) fn sort_pinned(threads: &mut [&ThreadShell]) {
    threads.sort_by(|a, b| match (&a.pin_order_key, &b.pin_order_key) {
        (Some(x), Some(y)) => x.cmp(y).then_with(|| a.id.cmp(&b.id)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => ms(&b.created_at)
            .unwrap_or(0)
            .cmp(&ms(&a.created_at).unwrap_or(0))
            .then_with(|| a.id.cmp(&b.id)),
    });
}

/// New and reopened threads lead the active list; arranged threads follow their saved keys.
fn sort_active(threads: &mut [&ThreadShell]) {
    let anchor = |t: &ThreadShell| {
        ms(&t.created_at)
            .unwrap_or(0)
            .max(ms_opt(&t.unsettled_at).unwrap_or(0))
    };
    threads.sort_by(|a, b| {
        let order = match (&a.active_order_key, &b.active_order_key) {
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => x.cmp(y),
            (None, None) => anchor(b).cmp(&anchor(a)),
        };
        order.then_with(|| a.id.cmp(&b.id))
    });
}

/// Threads the user is actively waiting on: working, an approval request, or an
/// input request. Same set the web sidebar lifts; failed/monitoring stay put.
fn is_in_progress(thread: &ThreadShell) -> bool {
    thread.has_pending_approvals
        || thread.has_pending_user_input
        || matches!(
            thread.session.as_ref().map(|s| s.status.as_str()),
            Some("running" | "starting")
        )
        || thread.background_liveness.as_deref() == Some("working")
}

/// Stable partition: in-progress threads lead the active list and everyone
/// else keeps the `sort_active` order below them. `sort_by_key` is stable, so
/// rows only rise past idle rows — never shuffled within a group.
fn lift_in_progress(threads: &mut [&ThreadShell]) {
    threads.sort_by_key(|t| !is_in_progress(t));
}

fn is_crew_title(title: &str) -> bool {
    ["Worker", "Expert", "Auditor"]
        .iter()
        .any(|role| title.starts_with(&format!("Crew {role} · ")))
}

pub(crate) fn is_crew_sub_thread(thread: &ThreadShell) -> bool {
    thread.parent_thread_id.is_some() || is_crew_title(&thread.title)
}

fn status_of(thread: &ThreadShell, woke: bool, unread: bool) -> Status {
    if thread.has_pending_approvals {
        return Status::Approval;
    }
    if thread.has_pending_user_input {
        return Status::Input;
    }
    match thread.session.as_ref().map(|s| s.status.as_str()) {
        Some("running" | "starting") => return Status::Working,
        Some("error") => return Status::Failed,
        _ => {}
    }
    match thread.background_liveness.as_deref() {
        Some("working") => return Status::Working,
        Some("monitoring") => return Status::Monitoring,
        _ => {}
    }
    if woke {
        Status::Woke
    } else if unread {
        Status::Unread
    } else {
        Status::Ready
    }
}

pub fn build(input: &Input) -> Vec<Nav> {
    let now = input.now_ms;
    let names: HashMap<&str, &str> = input
        .projects
        .iter()
        .map(|p| (p.id.as_str(), p.title.as_str()))
        .collect();
    let live: Vec<&ThreadShell> = input
        .threads
        .iter()
        .filter(|t| t.archived_at.is_none())
        .collect();
    let listed: std::collections::HashSet<&str> = live.iter().map(|t| t.id.as_str()).collect();
    let mut folded: HashMap<&str, usize> = HashMap::new();
    let mut top: Vec<&ThreadShell> = Vec::new();
    for thread in live {
        let waiting = thread.has_pending_approvals || thread.has_pending_user_input;
        if !is_crew_sub_thread(thread) || waiting {
            top.push(thread);
        } else if let Some(parent) = thread
            .parent_thread_id
            .as_deref()
            .filter(|p| listed.contains(p))
        {
            *folded.entry(parent).or_default() += 1;
        }
    }

    let (mut pinned, mut active, mut snoozed, mut settled) = (vec![], vec![], vec![], vec![]);
    for thread in top {
        if effective_snoozed(thread, now) {
            snoozed.push(thread);
        } else if thread.settled_override.as_deref() == Some("settled") {
            settled.push(thread);
        } else if thread.pinned_at.is_some() {
            pinned.push(thread);
        } else {
            active.push(thread);
        }
    }
    snoozed.sort_by_key(|t| ms_opt(&t.snoozed_until).unwrap_or(0));

    let row = |thread: &ThreadShell, section: Section| -> Nav {
        let current = input.current_id == Some(thread.id.as_str());
        let seen = input.visited.get(&thread.id).copied().unwrap_or(now);
        let woke_ms = if section == Section::Settled {
            None
        } else {
            woke_at(thread, now)
        };
        let woke = !current && woke_ms.is_some_and(|w| w > seen);
        let unread = !current
            && thread.latest_turn.as_ref().is_some_and(|t| {
                t.state == "completed" && ms_opt(&t.completed_at).is_some_and(|c| c > seen)
            });
        let status = status_of(thread, woke, unread);
        let since = if status == Status::Working {
            working_for(thread, now)
        } else if section == Section::Snoozed && thread.snoozed_until.is_some() {
            wake_label(thread.snoozed_until.as_deref().unwrap_or_default(), now)
        } else if section == Section::Settled {
            compact_age(settled_stamp(thread).as_deref(), now)
        } else {
            compact_age(
                thread
                    .latest_user_message_at
                    .as_deref()
                    .or(Some(thread.updated_at.as_str())),
                now,
            )
        };
        let waiting_crew = is_crew_sub_thread(thread)
            && (thread.has_pending_approvals || thread.has_pending_user_input);
        Nav::Thread(ThreadRow {
            id: thread.id.clone(),
            project: names.get(thread.project_id.as_str()).map(|n| n.to_string()),
            title: if waiting_crew {
                format!(
                    "crew {}",
                    thread.title.strip_prefix("Crew ").unwrap_or(&thread.title)
                )
            } else {
                thread.title.clone()
            },
            status,
            since,
            pinned: thread.pinned_at.is_some(),
            current,
            crew: folded.get(thread.id.as_str()).copied().unwrap_or(0),
            section,
        })
    };

    let mut items = vec![Nav::New {
        current: input.draft,
    }];
    sort_pinned(&mut pinned);
    sort_active(&mut active);
    lift_in_progress(&mut active);
    if !pinned.is_empty() {
        items.push(Nav::Header(Section::Pinned));
        items.extend(pinned.iter().map(|t| row(t, Section::Pinned)));
        if !active.is_empty() {
            items.push(Nav::Header(Section::Active));
        }
    }
    items.extend(active.iter().map(|t| row(t, Section::Active)));

    let mut shelf = |section: Section, all: &[&ThreadShell], open: bool, limit: usize| {
        if all.is_empty() {
            return;
        }
        items.push(Nav::Shelf {
            section,
            count: all.len(),
            open,
        });
        let shown: Vec<&&ThreadShell> = if open {
            all.iter().take(limit).collect()
        } else {
            all.iter()
                .filter(|t| input.current_id == Some(t.id.as_str()))
                .collect()
        };
        let shown_count = shown.len();
        items.extend(shown.into_iter().map(|t| row(t, section)));
        if open && all.len() > shown_count {
            items.push(Nav::More {
                section,
                count: all.len() - shown_count,
            });
        }
    };
    shelf(
        Section::Snoozed,
        &snoozed,
        input.view.snoozed_open,
        usize::MAX,
    );
    sort_settled(&mut settled);
    shelf(
        Section::Settled,
        &settled,
        input.view.settled_open,
        input.view.settled_shown,
    );
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thread::Session;

    const NOW: i64 = 1_767_225_600_000; // 2026-01-01T00:00:00Z

    fn thread(id: &str, f: impl FnOnce(&mut ThreadShell)) -> ThreadShell {
        let mut t = ThreadShell {
            id: id.into(),
            project_id: "p".into(),
            title: id.into(),
            created_at: "2025-12-31T00:00:00.000Z".into(),
            updated_at: "2025-12-31T23:00:00.000Z".into(),
            ..Default::default()
        };
        f(&mut t);
        t
    }

    fn ids(items: &[Nav]) -> Vec<String> {
        items
            .iter()
            .map(|n| match n {
                Nav::New { .. } => "new".into(),
                Nav::Header(s) => format!("header:{s:?}"),
                Nav::Shelf {
                    section,
                    count,
                    open,
                } => format!("shelf:{section:?}:{count}:{open}"),
                Nav::Thread(r) => r.id.clone(),
                Nav::More { count, .. } => format!("more:{count}"),
            })
            .collect()
    }

    fn build_for(threads: &[ThreadShell], view: &View, current: Option<&str>) -> Vec<Nav> {
        let projects = vec![ProjectShell {
            id: "p".into(),
            title: "demo".into(),
            ..Default::default()
        }];
        let visited = HashMap::new();
        build(&Input {
            threads,
            projects: &projects,
            current_id: current,
            draft: false,
            now_ms: NOW,
            visited: &visited,
            view,
        })
    }

    #[test]
    fn settled_rows_sort_newest_stamp_first_then_id_for_ties() {
        let threads = [
            thread("b-tie", |t| {
                t.settled_at = Some("2025-12-30T08:00:00.000Z".into());
            }),
            thread("old", |t| {
                t.settled_at = Some("2025-12-28T00:00:00.000Z".into());
            }),
            thread("a-tie", |t| {
                t.settled_at = Some("2025-12-30T08:00:00.000Z".into());
            }),
            thread("new", |t| {
                t.settled_at = Some("2025-12-31T00:00:00.000Z".into());
            }),
        ];
        let mut refs: Vec<&ThreadShell> = threads.iter().collect();
        sort_settled(&mut refs);
        let got: Vec<&str> = refs.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(got, ["new", "a-tie", "b-tie", "old"]);
    }

    #[test]
    fn sections_follow_the_desktop_order_and_shelves_start_closed() {
        let threads = vec![
            thread("a-old", |_| {}),
            thread("a-new", |t| {
                t.created_at = "2025-12-31T12:00:00.000Z".into()
            }),
            thread("pin", |t| {
                t.pinned_at = Some("2025-12-30T00:00:00.000Z".into())
            }),
            thread("snz", |t| {
                t.snoozed_until = Some("2026-01-01T03:00:00.000Z".into())
            }),
            thread("done", |t| {
                t.settled_override = Some("settled".into());
                t.settled_at = Some("2025-12-29T00:00:00.000Z".into());
            }),
            thread("gone", |t| {
                t.archived_at = Some("2025-12-01T00:00:00.000Z".into())
            }),
        ];
        let items = build_for(&threads, &View::default(), None);
        assert_eq!(
            ids(&items),
            vec![
                "new",
                "header:Pinned",
                "pin",
                "header:Active",
                "a-new",
                "a-old",
                "shelf:Snoozed:1:false",
                "shelf:Settled:1:false",
            ]
        );
        let open = View {
            snoozed_open: true,
            settled_open: true,
            ..Default::default()
        };
        let items = build_for(&threads, &open, None);
        assert!(ids(&items).ends_with(&[
            "shelf:Snoozed:1:true".into(),
            "snz".into(),
            "shelf:Settled:1:true".into(),
            "done".into()
        ]));
        let Nav::Thread(snoozed) = &items[items.len() - 3] else {
            panic!()
        };
        assert_eq!(snoozed.since, "3h");
        assert_eq!(snoozed.project.as_deref(), Some("demo"));
    }

    #[test]
    fn the_open_thread_stays_visible_on_a_closed_shelf() {
        let threads = vec![thread("done", |t| {
            t.settled_override = Some("settled".into())
        })];
        let items = build_for(&threads, &View::default(), Some("done"));
        assert_eq!(ids(&items), vec!["new", "shelf:Settled:1:false", "done"]);
    }

    #[test]
    fn crew_tasks_fold_under_their_lead_unless_they_wait_for_the_user() {
        let threads = vec![
            thread("lead", |_| {}),
            thread("w1", |t| {
                t.title = "Crew Worker · fix".into();
                t.parent_thread_id = Some("lead".into());
            }),
            thread("w2", |t| {
                t.title = "Crew Worker · ask".into();
                t.parent_thread_id = Some("lead".into());
                t.has_pending_approvals = true;
            }),
        ];
        let items = build_for(&threads, &View::default(), None);
        // The waiting worker surfaces as its own row and, being in progress,
        // rises above the idle lead.
        assert_eq!(ids(&items), vec!["new", "w2", "lead"]);
        let Nav::Thread(lead) = &items[2] else {
            panic!()
        };
        assert_eq!(lead.crew, 1);
        let Nav::Thread(waiting) = &items[1] else {
            panic!()
        };
        assert_eq!(
            (waiting.title.as_str(), waiting.status),
            ("crew Worker · ask", Status::Approval)
        );
    }

    #[test]
    fn the_active_list_lifts_in_progress_threads_and_keeps_the_rest_in_place() {
        let threads = vec![
            thread("ready-new", |t| {
                t.created_at = "2025-12-31T12:00:00.000Z".into()
            }),
            thread("working", |t| {
                t.session = Some(Session {
                    status: "running".into(),
                    ..Default::default()
                });
            }),
            thread("ready-old", |_| {}),
            thread("input", |t| t.has_pending_user_input = true),
            thread("approval", |t| t.has_pending_approvals = true),
            thread("failed", |t| {
                t.session = Some(Session {
                    status: "error".into(),
                    last_error: Some("boom".into()),
                    ..Default::default()
                });
            }),
            thread("monitoring", |t| {
                t.background_liveness = Some("monitoring".into())
            }),
        ];
        let items = build_for(&threads, &View::default(), None);
        // sort_active order is ready-new, approval, failed, input, monitoring,
        // ready-old, working (newest anchor first, then id). The lift moves
        // only the working/approval/input rows to the top; the rest keeps
        // that order.
        assert_eq!(
            ids(&items),
            vec![
                "new",
                "approval",
                "input",
                "working",
                "ready-new",
                "failed",
                "monitoring",
                "ready-old",
            ]
        );
    }

    #[test]
    fn a_snooze_ends_when_the_agent_needs_the_user_and_settled_ones_page() {
        let waiting = thread("w", |t| {
            t.snoozed_until = Some("2026-01-02T00:00:00.000Z".into());
            t.has_pending_user_input = true;
        });
        assert!(!effective_snoozed(&waiting, NOW));
        let many: Vec<ThreadShell> = (0..12)
            .map(|i| {
                thread(&format!("s{i:02}"), |t| {
                    t.settled_override = Some("settled".into())
                })
            })
            .collect();
        let open = View {
            settled_open: true,
            ..Default::default()
        };
        let items = build_for(&many, &open, None);
        assert_eq!(items.len(), 1 + 1 + SETTLED_INITIAL + 1);
        assert_eq!(ids(&items).last().unwrap(), "more:2");
    }

    #[test]
    fn ages_are_compact() {
        assert_eq!(compact_age(Some("2025-12-31T23:59:30.000Z"), NOW), "now");
        assert_eq!(compact_age(Some("2025-12-31T23:55:00.000Z"), NOW), "5m");
        assert_eq!(compact_age(Some("2025-12-31T21:00:00.000Z"), NOW), "3h");
        assert_eq!(compact_age(Some("2025-12-29T00:00:00.000Z"), NOW), "3d");
        assert_eq!(compact_age(None, NOW), "");
        assert_eq!(wake_label("2026-01-01T00:20:00.000Z", NOW), "20m");
    }
}
