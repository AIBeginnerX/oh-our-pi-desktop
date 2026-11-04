//! Which turn `/diff` shows and `/undo` would undo, read from the thread's checkpoints: ported from
//! the former TypeScript terminal. Pure functions over the folded thread, so the rules (a
//! newest turn without a checkpoint is explained, not skipped) are tested without a server.

use crate::panels_common::{fill, s};
use crate::text::{parse_iso_ms, sanitize};
use crate::thread::{Checkpoint, Role, Thread};

/// A turn that ended less than this long ago may still be having its checkpoint made: the server
/// captures it a moment after the turn, in the background.
const CHECKPOINT_GRACE_MS: i64 = 30_000;
/// What the agent reads in front of a prompt when ultrathink is picked; the desktop app takes it off too.
const ULTRATHINK_PREFIX: &str = "Ultrathink:\n";
const PROMPT_PREVIEW_COLUMNS: usize = 60;

/// Why a thread has no turn to show or to undo.
#[derive(Debug, Clone, PartialEq)]
pub enum Gap {
    NoTurn,
    None,
    Processing,
    CaptureFailed(Option<String>),
    Unusable { turn: u64, status: String },
    NoSuchTurn { turn: u64, first: u64, last: u64 },
}

pub fn gap_text(gap: &Gap) -> String {
    match gap {
        Gap::NoTurn => s("No turn has finished yet.", "아직 끝난 턴이 없습니다.").into(),
        Gap::None => s(
            "This thread has no checkpoints. Checkpoints are created when a turn ends in a git repository, so conversations in a non-git folder have none.",
            "이 스레드에는 체크포인트가 없습니다. 체크포인트는 git 저장소에서 턴이 끝날 때 만들어지므로, git 이 아닌 폴더에서 한 대화에는 없습니다.",
        )
        .into(),
        Gap::Processing => s(
            "The checkpoint for the turn that just ended is still being created. Try again in a moment.",
            "방금 끝난 턴의 체크포인트를 만드는 중입니다. 잠시 뒤 다시 시도하세요.",
        )
        .into(),
        Gap::CaptureFailed(detail) => format!(
            "{}{}",
            s(
                "Could not create a checkpoint for the last turn",
                "마지막 턴의 체크포인트를 만들지 못했습니다"
            ),
            detail.as_ref().map_or(String::new(), |d| format!(": {d}"))
        ),
        Gap::Unusable { turn, status } => fill(
            s(
                "The checkpoint for turn {turn} cannot be used (status: {status}).",
                "턴 {turn} 의 체크포인트를 쓸 수 없습니다 (상태: {status}).",
            ),
            &[("turn", turn.to_string()), ("status", status.clone())],
        ),
        Gap::NoSuchTurn { turn, first, last } if first == last => fill(
            s(
                "There is no checkpoint for turn {turn}. The only turn that has one is {last}.",
                "턴 {turn} 의 체크포인트가 없습니다. 있는 턴은 {last} 뿐입니다.",
            ),
            &[("turn", turn.to_string()), ("last", last.to_string())],
        ),
        Gap::NoSuchTurn { turn, first, last } => fill(
            s(
                "There is no checkpoint for turn {turn}. Turns {first}-{last} have one.",
                "턴 {turn} 의 체크포인트가 없습니다. 있는 턴은 {first}~{last} 입니다.",
            ),
            &[
                ("turn", turn.to_string()),
                ("first", first.to_string()),
                ("last", last.to_string()),
            ],
        ),
    }
}

fn first_line(value: &serde_json::Value) -> Option<String> {
    let text = sanitize(value.as_str()?);
    let line = text.lines().next()?.trim().to_string();
    (!line.is_empty()).then_some(line)
}

/// Why the newest turn has no checkpoint when it should: still being made, failed (the server
/// records that as an activity), or never made, as in a folder that is not a repository.
fn missing_latest(thread: &Thread, turn_id: &str, completed_at: Option<&str>, now: i64) -> Gap {
    if let Some(failure) =
        thread.activities.iter().rev().find(|a| {
            a.kind == "checkpoint.capture.failed" && a.turn_id.as_deref() == Some(turn_id)
        })
    {
        return Gap::CaptureFailed(first_line(&failure.payload["detail"]));
    }
    let ended = completed_at.and_then(parse_iso_ms);
    // A turn that ended just now, or (clocks differ) seems to end ahead of us, is still being captured.
    if ended.is_some_and(|ended| now - ended < CHECKPOINT_GRACE_MS) {
        return Gap::Processing;
    }
    if thread.checkpoints.is_empty() {
        Gap::None
    } else {
        Gap::CaptureFailed(None)
    }
}

/// The checkpoints of turns that are over, oldest first; a turn that is still running has no final one.
fn settled(thread: &Thread) -> Vec<&Checkpoint> {
    let running = thread
        .latest_turn
        .as_ref()
        .filter(|t| t.state == "running")
        .map(|t| t.turn_id.as_str());
    let mut out: Vec<&Checkpoint> = thread
        .checkpoints
        .iter()
        .filter(|c| c.checkpoint_turn_count.is_some() && Some(c.turn_id.as_str()) != running)
        .collect();
    out.sort_by_key(|c| c.checkpoint_turn_count);
    out
}

fn usable(checkpoint: &Checkpoint) -> Result<&Checkpoint, Gap> {
    if checkpoint.status == "ready" {
        Ok(checkpoint)
    } else {
        Err(Gap::Unusable {
            turn: checkpoint.checkpoint_turn_count.unwrap_or(0),
            status: checkpoint.status.clone(),
        })
    }
}

/// The turn `/diff` shows: the one asked for, else the last. The last one must be the thread's
/// newest turn, so a newest turn without a checkpoint is explained instead of quietly showing an
/// older one.
pub fn diff_turn(thread: &Thread, requested: Option<u64>, now: i64) -> Result<&Checkpoint, Gap> {
    let checkpoints = settled(thread);
    if let Some(turn) = requested {
        let Some(found) = checkpoints
            .iter()
            .find(|c| c.checkpoint_turn_count == Some(turn))
        else {
            return Err(match (checkpoints.first(), checkpoints.last()) {
                (Some(first), Some(last)) => Gap::NoSuchTurn {
                    turn,
                    first: first.checkpoint_turn_count.unwrap_or(0),
                    last: last.checkpoint_turn_count.unwrap_or(0),
                },
                _ if thread.latest_turn.is_none() => Gap::NoTurn,
                _ => Gap::None,
            });
        };
        return usable(found).map_err(|gap| match gap {
            Gap::Unusable { status, .. } => Gap::Unusable { turn, status },
            other => other,
        });
    }
    let newest = thread.latest_turn.as_ref();
    if newest.is_none() && checkpoints.is_empty() {
        return Err(Gap::NoTurn);
    }
    if let Some(newest) = newest
        && newest.state != "running"
        && !checkpoints.iter().any(|c| c.turn_id == newest.turn_id)
    {
        return Err(missing_latest(
            thread,
            &newest.turn_id,
            newest.completed_at.as_deref(),
            now,
        ));
    }
    // The only turn is still running when there is none.
    let last = checkpoints.last().ok_or(Gap::NoTurn)?;
    usable(last)
}

/// `/diff [turn] [file]`: a number first picks the turn, and the rest of the words name one file.
#[derive(Debug, PartialEq)]
pub struct DiffRequest {
    pub turn: Option<u64>,
    pub file: Option<String>,
}

pub fn parse_diff_args(args: &[&str]) -> Result<DiffRequest, String> {
    let numbered = args
        .first()
        .is_some_and(|a| !a.is_empty() && a.bytes().all(|b| b.is_ascii_digit()));
    let turn = if numbered {
        let n: u64 = args[0].parse().unwrap_or(0);
        if n < 1 {
            return Err(s(
                "The turn number must be 1 or higher. Example: /diff 2",
                "턴 번호는 1 이상의 숫자입니다. 예: /diff 2",
            )
            .into());
        }
        Some(n)
    } else {
        None
    };
    let words = if numbered { &args[1..] } else { args };
    let file = words.join(" ").trim().to_string();
    Ok(DiffRequest {
        turn,
        file: (!file.is_empty()).then_some(file),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restore {
    Possible,
    SharedFolder,
    CheckpointUnusable,
}

/// What `/undo` would undo and what it would touch, read from the thread as it is now.
#[derive(Debug, Clone, PartialEq)]
pub struct UndoPlan {
    /// The turn that goes: its checkpoint's turn count.
    pub turn: u64,
    /// Turn count the thread is rewound to.
    pub target: u64,
    pub files: (u64, u64, u64),
    /// The message that started the turn; it goes back to the composer.
    pub prompt: Option<String>,
    pub restore: Restore,
}

/// The text of the message that started the turn behind `checkpoint`: the last user message before its reply.
fn prompt_of(thread: &Thread, checkpoint: &Checkpoint) -> Option<String> {
    let messages: Vec<_> = thread
        .messages
        .iter()
        .filter(|m| m.role != Role::Reasoning)
        .collect();
    let reply_at = checkpoint
        .assistant_message_id
        .as_ref()
        .and_then(|id| messages.iter().position(|m| &m.id == id));
    let before: Vec<_> = match reply_at {
        Some(at) => messages[..at].to_vec(),
        None => messages
            .iter()
            .filter(|m| m.created_at <= checkpoint.completed_at)
            .copied()
            .collect(),
    };
    let user = before.iter().rev().find(|m| m.role == Role::User)?;
    let text = user
        .text
        .strip_prefix(ULTRATHINK_PREFIX)
        .unwrap_or(&user.text)
        .trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// One line of the prompt for the confirmation, cut at `PROMPT_PREVIEW_COLUMNS` characters.
pub fn prompt_preview(prompt: &str) -> String {
    let line = sanitize(prompt)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= PROMPT_PREVIEW_COLUMNS {
        line
    } else {
        format!(
            "{}…",
            chars[..PROMPT_PREVIEW_COLUMNS - 1]
                .iter()
                .collect::<String>()
        )
    }
}

/// The last turn as `/undo` would undo it: the thread is rewound to the checkpoint before that
/// turn. Only the newest turn can be undone, and only when it has a checkpoint.
pub fn undo_plan(thread: &Thread, now: i64) -> Result<UndoPlan, Gap> {
    let checkpoint = diff_turn(thread, None, now)?;
    let turn = checkpoint.checkpoint_turn_count.unwrap_or(0);
    let target = turn.saturating_sub(1);
    let before = (target != 0)
        .then(|| {
            thread
                .checkpoints
                .iter()
                .find(|c| c.checkpoint_turn_count == Some(target))
        })
        .flatten();
    // Turn zero is the state before the first turn, which the server keeps as its own baseline.
    let baseline_usable = target == 0 || before.is_some_and(|c| c.status == "ready");
    let files = checkpoint.files.iter().fold((0, 0, 0), |(n, a, d), f| {
        (n + 1, a + f.additions, d + f.deletions)
    });
    Ok(UndoPlan {
        turn,
        target,
        files,
        prompt: prompt_of(thread, checkpoint),
        restore: if thread.worktree_path.is_none() {
            Restore::SharedFolder
        } else if baseline_usable {
            Restore::Possible
        } else {
            Restore::CheckpointUnusable
        },
    })
}

/// The turn count the thread has now: its newest checkpoint's.
pub fn turn_count_of(thread: &Thread) -> u64 {
    thread
        .checkpoints
        .iter()
        .filter_map(|c| c.checkpoint_turn_count)
        .max()
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thread::{CheckpointFile, LatestTurn, Message};
    use serde_json::json;

    fn checkpoint(turn: &str, count: u64, status: &str) -> Checkpoint {
        Checkpoint {
            turn_id: turn.into(),
            checkpoint_turn_count: Some(count),
            status: status.into(),
            assistant_message_id: Some(format!("a{count}")),
            completed_at: format!("2026-01-01T00:00:{count:02}.000Z"),
            files: vec![CheckpointFile {
                path: "src/a.rs".into(),
                kind: "modified".into(),
                additions: 3,
                deletions: 1,
            }],
        }
    }

    fn message(id: &str, role: Role, text: &str, at: u64) -> Message {
        Message {
            id: id.into(),
            role,
            text: text.into(),
            created_at: format!("2026-01-01T00:00:{at:02}.000Z"),
            ..Default::default()
        }
    }

    fn thread(count: u64) -> Thread {
        let mut t = Thread::default();
        for n in 1..=count {
            t.checkpoints.push(checkpoint(&format!("t{n}"), n, "ready"));
            t.messages.push(message(
                &format!("u{n}"),
                Role::User,
                &format!("ask {n}"),
                n * 2,
            ));
            t.messages
                .push(message(&format!("a{n}"), Role::Assistant, "ok", n * 2 + 1));
        }
        t.latest_turn = Some(LatestTurn {
            turn_id: format!("t{count}"),
            state: "completed".into(),
            completed_at: Some("2026-01-01T00:01:00.000Z".into()),
            ..Default::default()
        });
        t.worktree_path = Some("/w".into());
        t
    }

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn the_last_or_the_asked_turn_is_found_and_gaps_are_explained() {
        let t = thread(3);
        assert_eq!(
            diff_turn(&t, None, NOW).unwrap().checkpoint_turn_count,
            Some(3)
        );
        assert_eq!(
            diff_turn(&t, Some(2), NOW).unwrap().checkpoint_turn_count,
            Some(2)
        );
        assert_eq!(
            diff_turn(&t, Some(9), NOW).unwrap_err(),
            Gap::NoSuchTurn {
                turn: 9,
                first: 1,
                last: 3
            }
        );
        assert_eq!(
            diff_turn(&Thread::default(), None, NOW).unwrap_err(),
            Gap::NoTurn
        );
        // a newest turn without a checkpoint is not replaced by an older one
        let mut t = thread(2);
        t.latest_turn = Some(LatestTurn {
            turn_id: "t3".into(),
            state: "completed".into(),
            completed_at: Some("2026-01-01T00:01:00.000Z".into()),
            ..Default::default()
        });
        assert_eq!(
            diff_turn(&t, None, NOW).unwrap_err(),
            Gap::CaptureFailed(None)
        );
        let just_now = parse_iso_ms("2026-01-01T00:01:00.000Z").unwrap() + 5_000;
        assert_eq!(diff_turn(&t, None, just_now).unwrap_err(), Gap::Processing);
        t.activities.push(crate::thread::Activity {
            kind: "checkpoint.capture.failed".into(),
            turn_id: Some("t3".into()),
            payload: json!({"detail": "not a git repository\nmore"}),
            ..Default::default()
        });
        assert_eq!(
            diff_turn(&t, None, NOW).unwrap_err(),
            Gap::CaptureFailed(Some("not a git repository".into()))
        );
        // no checkpoints at all: the folder is not a repository
        let mut bare = thread(1);
        bare.checkpoints.clear();
        assert_eq!(diff_turn(&bare, None, NOW).unwrap_err(), Gap::None);
        // a checkpoint that is not ready
        let mut t = thread(2);
        t.checkpoints[1].status = "error".into();
        assert_eq!(
            diff_turn(&t, None, NOW).unwrap_err(),
            Gap::Unusable {
                turn: 2,
                status: "error".into()
            }
        );
    }

    #[test]
    fn a_running_turn_has_no_final_checkpoint() {
        let mut t = thread(2);
        t.latest_turn = Some(LatestTurn {
            turn_id: "t2".into(),
            state: "running".into(),
            ..Default::default()
        });
        assert_eq!(
            diff_turn(&t, None, NOW).unwrap().checkpoint_turn_count,
            Some(1)
        );
    }

    #[test]
    fn diff_arguments_read_a_turn_then_a_file_name() {
        let args = |w: &[&str]| parse_diff_args(w).unwrap();
        assert_eq!(
            args(&[]),
            DiffRequest {
                turn: None,
                file: None
            }
        );
        assert_eq!(
            args(&["2"]),
            DiffRequest {
                turn: Some(2),
                file: None
            }
        );
        assert_eq!(
            args(&["2", "my", "file.rs"]),
            DiffRequest {
                turn: Some(2),
                file: Some("my file.rs".into())
            }
        );
        assert_eq!(
            args(&["src/a.rs"]),
            DiffRequest {
                turn: None,
                file: Some("src/a.rs".into())
            }
        );
        assert!(parse_diff_args(&["0"]).is_err());
    }

    #[test]
    fn the_undo_plan_names_the_turn_the_prompt_and_what_can_be_restored() {
        let t = thread(3);
        let plan = undo_plan(&t, NOW).unwrap();
        assert_eq!((plan.turn, plan.target), (3, 2));
        assert_eq!(plan.files, (1, 3, 1));
        assert_eq!(plan.prompt.as_deref(), Some("ask 3"));
        assert_eq!(plan.restore, Restore::Possible);
        let mut shared = thread(3);
        shared.worktree_path = None;
        assert_eq!(
            undo_plan(&shared, NOW).unwrap().restore,
            Restore::SharedFolder
        );
        let mut bad = thread(3);
        bad.checkpoints[1].status = "missing".into();
        assert_eq!(
            undo_plan(&bad, NOW).unwrap().restore,
            Restore::CheckpointUnusable
        );
        // the first turn goes back to the baseline, which always exists
        assert_eq!(
            undo_plan(&thread(1), NOW).unwrap().restore,
            Restore::Possible
        );
        assert_eq!(undo_plan(&thread(1), NOW).unwrap().target, 0);
        // the ultrathink prefix is not part of the question
        let mut t = thread(1);
        t.messages[0].text = "Ultrathink:\nthink hard".into();
        assert_eq!(
            undo_plan(&t, NOW).unwrap().prompt.as_deref(),
            Some("think hard")
        );
    }

    #[test]
    fn the_preview_is_one_line_of_sixty_characters() {
        assert_eq!(prompt_preview("a\n  b\tc"), "a b c");
        let long = "가".repeat(80);
        let preview = prompt_preview(&long);
        assert_eq!(preview.chars().count(), 60);
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn the_turn_count_is_the_newest_checkpoints() {
        assert_eq!(turn_count_of(&thread(4)), 4);
        assert_eq!(turn_count_of(&Thread::default()), 0);
    }

    #[test]
    fn gaps_read_in_both_languages() {
        assert!(gap_text(&Gap::NoTurn).len() > 4);
        let text = gap_text(&Gap::NoSuchTurn {
            turn: 5,
            first: 1,
            last: 3,
        });
        assert!(text.contains('5') && text.contains("1") && text.contains('3'));
    }
}
