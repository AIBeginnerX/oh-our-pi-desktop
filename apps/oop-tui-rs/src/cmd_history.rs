//! `/diff`, `/undo` and `/history`: the thread operations that read or rewind what the server
//! holds. Ported from apps/oop-tui/src/app/controller.ts (runDiffCommand, runUndoCommand, sendUndo,
//! noteRewind, runHistoryCommand) and undoFlow.ts.
//!
//! The TypeScript terminal writes their output into the scrollback. This screen draws the whole
//! thread itself, so a report is a note under the conversation (`notes.rs`), and `/history` loads
//! the older turns into the thread (the way scrolling to the top does) and scrolls there.

use crate::app::{Active, App, Modal, Msg, Pick};
use crate::checkpoints::{self, Restore, UndoPlan};
use crate::commands::{self, Ctx};
use crate::notes::Tone;
use crate::panels_common::{fill, flat, s};
use crate::text::{iso_now, parse_iso_ms};
use crate::thread::{Role, Thread};
use serde_json::{Value, json};
use std::collections::HashSet;

/// Messages `/history` loads when no number is given.
pub const HISTORY_DEFAULT: usize = 30;
/// Most messages one `/history` loads; a bigger ask is cut to this, not refused.
pub const HISTORY_MAX: usize = 200;
/// A request that has not been answered by now is no longer waited for.
const PENDING_LIMIT_MS: i64 = 60_000;
const FAILURE_KIND: &str = "checkpoint.revert.failed";
const TURN_DIFF_RPC: &str = "orchestration.getTurnDiff";
const FULL_DIFF_RPC: &str = "orchestration.getFullThreadDiff";

/// What the three commands keep between key presses; `App` holds one.
#[derive(Default)]
pub struct State {
    /// The one undo this client has sent and is waiting on.
    undo: Option<Pending>,
    /// The plan the open `/undo` list was made for.
    offer: Option<UndoPlan>,
    /// The thread's turn count as of the last sync, to notice a rewind made elsewhere.
    turn_count: Option<u64>,
    history: Option<HistoryJob>,
    diff_busy: bool,
}

struct Pending {
    thread_id: String,
    plan: UndoPlan,
    restore_files: bool,
    started_at: i64,
    /// Failures already in the thread when it was sent: they are not this request's answer.
    known_failures: HashSet<String>,
    /// The thread is not on screen: its answer cannot be read, so the minute does not run.
    away: bool,
}

struct HistoryJob {
    thread_id: String,
    /// Visible messages when the command began, the count to reach and the count at the last page.
    start: usize,
    target: usize,
    last: usize,
}

fn now_ms() -> i64 {
    parse_iso_ms(&iso_now()).unwrap_or(0)
}

/// The thread on screen as the server holds it: none for a draft or before its first snapshot.
fn server_thread(app: &App) -> Option<&Thread> {
    let id = app.thread_id()?;
    (app.conv.loaded && app.conv.thread_id == id).then_some(&app.conv.thread)
}

fn visible_messages(app: &App) -> usize {
    app.conv
        .thread
        .messages
        .iter()
        .filter(|m| m.role != Role::Reasoning)
        .count()
}

fn is_connection_error(reason: &str) -> bool {
    reason.starts_with("the connection")
}

// --- hooks `app.rs` calls --------------------------------------------------------------------

/// Whether an undo of the thread on screen is on its way: no turn starts, and the queue stays
/// where it is, until the server has answered. One never answered stops counting after a minute.
pub fn undo_active(app: &App) -> bool {
    let (Some(pending), Some(id)) = (&app.threadops.undo, app.thread_id()) else {
        return false;
    };
    pending.thread_id == id && (pending.away || now_ms() - pending.started_at < PENDING_LIMIT_MS)
}

/// The refusal `App::send` gives while an undo is on its way.
pub fn sending_blocked(app: &App) -> Option<String> {
    undo_active(app).then(|| {
        s(
            "Undo is in progress. You can send once it finishes.",
            "되돌리는 중입니다. 끝난 뒤에 보낼 수 있습니다.",
        )
        .to_string()
    })
}

/// The thread was left (another thread, a draft): an undo under way is read when it is back.
pub fn on_leave(app: &mut App) {
    let current = app.thread_id();
    if let (Some(pending), Some(id)) = (app.threadops.undo.as_mut(), current)
        && pending.thread_id == id
    {
        pending.away = true;
    }
    app.threadops.turn_count = None;
    app.threadops.history = None;
    app.threadops.offer = None;
}

enum Outcome {
    Done { plan: UndoPlan, restore_files: bool },
    Failed { restore_files: bool },
}

/// Reads the thread for the answer to the undo that was sent; once it is found the request is over.
fn observe(state: &mut State, thread: &Thread) -> Option<Outcome> {
    let pending = state.undo.as_ref()?;
    if pending.thread_id != thread.id {
        return None;
    }
    let failed = thread
        .activities
        .iter()
        .any(|a| a.kind == FAILURE_KIND && !pending.known_failures.contains(&a.id));
    let restore_files = pending.restore_files;
    if failed {
        state.undo = None;
        return Some(Outcome::Failed { restore_files });
    }
    if checkpoints::turn_count_of(thread) <= pending.plan.target {
        let plan = pending.plan.clone();
        state.undo = None;
        return Some(Outcome::Done {
            plan,
            restore_files,
        });
    }
    None
}

/// The thread changed: an undo that has its answer is reported, and so is a thread that has fewer
/// turns than at the last sync (the server rewound it, here or from another client).
pub fn on_thread(app: &mut App) {
    if !app.conv.loaded {
        return;
    }
    let now = now_ms();
    let id = app.conv.thread_id.clone();
    if let Some(pending) = app.threadops.undo.as_mut() {
        if pending.thread_id == id && pending.away {
            pending.away = false;
            pending.started_at = now;
        } else if !pending.away && now - pending.started_at >= PENDING_LIMIT_MS {
            app.threadops.undo = None;
        }
    }
    let count = checkpoints::turn_count_of(&app.conv.thread);
    let before = app.threadops.turn_count.replace(count);
    let outcome = observe(&mut app.threadops, &app.conv.thread);
    if let Some(Outcome::Failed { restore_files }) = &outcome {
        let text = if *restore_files {
            s(
                "Could not undo (the reason is in the server message above). The conversation is unchanged. Check the files with /diff; to undo only the conversation, choose \"conversation only\" in /undo.",
                "되돌리지 못했습니다 (이유는 위의 서버 메시지). 대화는 그대로입니다. 파일 상태는 /diff 로 확인하고, 대화만 되돌리려면 /undo 에서 \"대화만\"을 고르세요.",
            )
        } else {
            s(
                "Could not undo (the reason is in the server message above). The conversation is unchanged.",
                "되돌리지 못했습니다 (이유는 위의 서버 메시지). 대화는 그대로입니다.",
            )
        };
        app.say(Tone::Error, text);
        return;
    }
    let mine = match outcome {
        Some(Outcome::Done {
            plan,
            restore_files,
        }) => Some((plan, restore_files)),
        _ => None,
    };
    if mine.is_none() && !before.is_some_and(|b| count < b) {
        return;
    }
    let from = mine
        .as_ref()
        .map(|(plan, _)| plan.turn)
        .or(before)
        .unwrap_or(count);
    let mut body = vec![
        s(
            "The questions and answers shown above after that point are no longer in this conversation.",
            "위에 보이는 그 뒤의 질문과 답변은 더 이상 이 대화에 없습니다.",
        )
        .to_string(),
    ];
    if let Some((plan, restore_files)) = mine {
        body.push(if restore_files {
            let state = if plan.target == 0 {
                s("before the thread started", "스레드를 시작하기 전").to_string()
            } else {
                fill(
                    s("the end of turn {target}", "턴 {target} 이 끝난"),
                    &[("target", plan.target.to_string())],
                )
            };
            fill(
                s(
                    "Files: restored to the state at {state}.",
                    "파일: {state} 상태로 복원했습니다.",
                ),
                &[("state", state)],
            )
        } else {
            s("Files: left as they were.", "파일: 그대로 두었습니다.").to_string()
        });
        // What waited in the queue may rest on the turn that is gone: it goes back to the composer
        // too, behind the question that was asked before it, to be read before anything is sent.
        let queued: Vec<String> = app.queue.drain(..).collect();
        let mut typed = app.input.take(false);
        if !queued.is_empty() {
            let mut parts = queued.clone();
            if !typed.is_empty() {
                parts.push(typed);
            }
            typed = parts.join("\n\n");
        }
        if let Some(prompt) = plan.prompt {
            typed = if typed.trim().is_empty() {
                prompt
            } else {
                format!("{prompt}\n\n{typed}")
            };
            body.push(
                s(
                    "Your question is back in the input box. Edit it and send it again.",
                    "질문을 입력창에 되돌려 놓았습니다. 고쳐서 다시 보내세요.",
                )
                .to_string(),
            );
        }
        app.input.paste(&typed);
        if !queued.is_empty() {
            body.push(fill(
                s(
                    "{queued} queued message(s) are back in the input box too.",
                    "대기 중이던 메시지 {queued}건도 입력창으로 돌아왔습니다.",
                ),
                &[("queued", queued.len().to_string())],
            ));
        }
    }
    let title = fill(
        s(
            "Undone from turn {from} · the conversation now ends at turn {now}",
            "턴 {from}부터 되돌림 · 대화는 턴 {now}까지 남았습니다",
        ),
        &[("from", from.to_string()), ("now", count.to_string())],
    );
    app.note(Tone::Warning, &title, body);
}

// --- /undo ----------------------------------------------------------------------------------

/// What the confirmation offers, in the order it lists them: the first is the safe one.
fn undo_choices(plan: &UndoPlan) -> Vec<&'static str> {
    if plan.restore == Restore::Possible {
        vec!["cancel", "files", "conversation"]
    } else {
        vec!["cancel", "conversation"]
    }
}

fn undo_items(plan: &UndoPlan) -> Vec<String> {
    undo_choices(plan)
        .into_iter()
        .map(|choice| {
            let (label, note) = match choice {
                "cancel" => (
                    s("Cancel", "취소").to_string(),
                    s("Changes nothing", "아무것도 바꾸지 않습니다").to_string(),
                ),
                "files" => (
                    s("Undo files and conversation", "파일과 대화 되돌리기").to_string(),
                    fill(
                        s("Back to the end of turn {target}", "턴 {target} 끝 상태로"),
                        &[("target", plan.target.to_string())],
                    ),
                ),
                _ => (
                    if plan.restore == Restore::Possible {
                        s("Undo conversation only", "대화만 되돌리기")
                    } else {
                        s("Undo conversation", "대화 되돌리기")
                    }
                    .to_string(),
                    s("Leaves your files as they are", "파일은 그대로 둡니다").to_string(),
                ),
            };
            format!("{label}  —  {note}")
        })
        .collect()
}

/// What the confirmation says before anything is deleted: which turn goes, what happens to the
/// conversation and to the files, and that there is no way back. The first row is its heading.
fn undo_summary(plan: &UndoPlan, queued: usize) -> Vec<String> {
    let (count, additions, deletions) = plan.files;
    let counts = fill(
        s(
            "{count} files (+{additions} -{deletions})",
            "파일 {count}개 (+{additions} -{deletions})",
        ),
        &[
            ("count", count.to_string()),
            ("additions", additions.to_string()),
            ("deletions", deletions.to_string()),
        ],
    );
    let turn = plan.turn.to_string();
    let mut rows = vec![match &plan.prompt {
        None => fill(s("Turn {turn}", "턴 {turn}"), &[("turn", turn.clone())]),
        Some(prompt) => fill(
            s("Turn {turn}: {prompt}", "턴 {turn}: {prompt}"),
            &[
                ("turn", turn.clone()),
                ("prompt", checkpoints::prompt_preview(prompt)),
            ],
        ),
    }];
    rows.push(format!(
        "{}{}",
        s(
            "Conversation: this turn's question and answer will be removed from the conversation.",
            "대화: 이 턴의 질문과 답변이 대화에서 지워집니다.",
        ),
        if plan.prompt.is_some() {
            s(
                " The question returns to the input box.",
                " 질문은 입력창으로 돌아옵니다.",
            )
        } else {
            ""
        }
    ));
    if queued > 0 {
        rows.push(fill(
            s(
                "{queued} queued message(s) return to the input box (they may assume the removed turn, so they are not sent automatically).",
                "대기 중인 메시지 {queued}건은 입력창으로 돌아옵니다 (지워진 턴을 전제로 했을 수 있어 자동으로 보내지 않습니다).",
            ),
            &[("queued", queued.to_string())],
        ));
    }
    rows.push(match plan.restore {
        Restore::Possible => {
            let state = if plan.target == 0 {
                s("before this thread started", "이 스레드를 시작하기 전").to_string()
            } else {
                fill(
                    s("the end of turn {target}", "턴 {target} 이 끝난"),
                    &[("target", plan.target.to_string())],
                )
            };
            fill(
                s(
                    "Files: choosing \"Undo files and conversation\" restores the whole folder, including {counts}, to the state at {state}, and discards any edits you made by hand since. Choosing \"conversation only\" leaves your files as they are.",
                    "파일: \"파일과 대화\"를 고르면 {counts} 를 포함해 폴더 전체가 {state} 상태로 돌아가고, 그 사이 직접 고친 내용도 사라집니다. \"대화만\"을 고르면 파일은 그대로입니다.",
                ),
                &[("counts", counts), ("state", state)],
            )
        }
        Restore::SharedFolder => fill(
            s(
                "Files: left as they are. This thread shares the project folder with other threads, so restoring files is not supported (the desktop app works the same way). View the {counts} this turn changed with /diff {turn} and revert them yourself.",
                "파일: 그대로 둡니다. 이 스레드는 프로젝트 폴더를 다른 스레드와 함께 쓰므로 파일 복원은 지원되지 않습니다 (데스크톱 앱도 같습니다). 이 턴이 바꾼 {counts} 는 /diff {turn} 으로 보고 직접 되돌리세요.",
            ),
            &[("counts", counts), ("turn", turn)],
        ),
        Restore::CheckpointUnusable => s(
            "Files: left as they are. No checkpoint is available to go back to.",
            "파일: 그대로 둡니다. 되돌아갈 체크포인트를 쓸 수 없습니다.",
        )
        .to_string(),
    });
    rows.push(
        s(
            "Undoing an undo is not possible, even in the desktop app.",
            "되돌린 것을 다시 되돌리는 기능은 데스크톱 앱에도 없습니다.",
        )
        .to_string(),
    );
    rows
}

/// `/undo`: rewinds the thread to before its last turn, as the desktop app's "Edit from here" does
/// for the last message. Nothing is sent until the list it opens is answered, and its first choice
/// is to cancel. It is refused while a turn runs, since the server rewinds only a thread at rest.
pub fn undo(app: &mut App) {
    let now = now_ms();
    let Some(thread) = server_thread(app) else {
        app.notice = Some(
            s(
                "This thread has not started yet. There is no conversation to undo.",
                "아직 시작하지 않은 스레드입니다. 되돌릴 대화가 없습니다.",
            )
            .into(),
        );
        return;
    };
    if undo_active(app) {
        app.notice = Some(
            s(
                "Undo is in progress. Try again once it finishes.",
                "되돌리는 중입니다. 끝난 뒤에 다시 시도하세요.",
            )
            .into(),
        );
        return;
    }
    if app.rpc.is_none() {
        app.notice = Some(
            s(
                "You can undo once the server is connected.",
                "서버와 연결된 뒤에 되돌릴 수 있습니다.",
            )
            .into(),
        );
        return;
    }
    if app.conv.busy() || app.awaiting.is_some() {
        app.notice = Some(
            s(
                "You cannot undo while work is running. Press Esc to interrupt, then run /undo again.",
                "작업 중에는 되돌릴 수 없습니다. Esc로 중단한 뒤 다시 /undo 하세요.",
            )
            .into(),
        );
        return;
    }
    let provider_id = thread
        .session
        .as_ref()
        .and_then(|session| session.provider_instance_id.clone())
        .or_else(|| {
            thread.model_selection["instanceId"]
                .as_str()
                .map(str::to_string)
        });
    let provider = app.config["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["instanceId"].as_str() == provider_id.as_deref());
    if let Some(provider) = provider
        && provider["supportsConversationRollback"] == Value::Bool(false)
    {
        let name = flat(
            provider["displayName"]
                .as_str()
                .or(provider["instanceId"].as_str())
                .unwrap_or_default(),
        );
        let text = fill(
            s(
                "{name} does not support undoing a conversation. Continue in a new thread (/new).",
                "{name} 는 대화 되돌리기를 지원하지 않습니다. 새 스레드(/new)에서 이어가세요.",
            ),
            &[("name", name)],
        );
        app.say(Tone::Warning, &text);
        return;
    }
    let plan = match checkpoints::undo_plan(thread, now) {
        Ok(plan) => plan,
        Err(gap) => {
            let text = checkpoints::gap_text(&gap);
            app.say(Tone::Warning, &text);
            return;
        }
    };
    // A list has no room for a paragraph, so what the choice deletes is said above it, in the
    // conversation; it stays there if the list is cancelled.
    let mut rows = undo_summary(&plan, app.queue.len());
    let heading = rows.remove(0);
    app.note(Tone::Warning, &heading, rows);
    let items = undo_items(&plan);
    let data = undo_choices(&plan).into_iter().map(String::from).collect();
    app.threadops.offer = Some(plan);
    app.modal = Some(Modal::Pick(Pick {
        id: "undo",
        title: s("Undo the last turn", "마지막 턴 되돌리기").to_string(),
        items,
        cursor: 0,
        data,
    }));
}

/// The list was answered: the plan is read again from the thread, since it may have moved on, and sent.
pub fn undo_picked(app: &mut App, pick: &Pick, index: usize) {
    let offered = app.threadops.offer.take();
    let restore_files = match pick.data.get(index).map(String::as_str) {
        Some("files") => true,
        Some("conversation") => false,
        _ => return,
    };
    let changed = || {
        s(
            "The conversation changed, so the undo was cancelled. Run /undo again.",
            "대화가 바뀌어 취소했습니다. 다시 /undo 하세요.",
        )
        .to_string()
    };
    let now = now_ms();
    let again = server_thread(app).and_then(|t| checkpoints::undo_plan(t, now).ok());
    let (Some(plan), Some(again)) = (offered, again) else {
        app.notice = Some(changed());
        return;
    };
    // What the choice was offered for must still hold: a folder restore the thread lost is not
    // carried out.
    if again.turn != plan.turn
        || again.restore != plan.restore
        || app.conv.busy()
        || app.awaiting.is_some()
        || undo_active(app)
        || app.rpc.is_none()
    {
        app.notice = Some(changed());
        return;
    }
    let (Some(id), Some(rpc)) = (app.thread_id(), app.rpc.clone()) else {
        return;
    };
    let known_failures = app
        .conv
        .thread
        .activities
        .iter()
        .filter(|a| a.kind == FAILURE_KIND)
        .map(|a| a.id.clone())
        .collect();
    app.threadops.undo = Some(Pending {
        thread_id: id.clone(),
        plan: again.clone(),
        restore_files,
        started_at: now,
        known_failures,
        away: false,
    });
    app.say(Tone::Info, s("Undoing…", "되돌리는 중…"));
    let command = commands::revert(&Ctx::fresh(), &id, again.target, restore_files);
    #[cfg(test)]
    app.log.push(command.clone());
    let tx = app.sender();
    tokio::spawn(async move {
        let result = rpc.call(crate::app::DISPATCH_RPC, command).await;
        let _ = tx.send(Msg::Ext(Box::new(move |app| undo_sent(app, &id, result))));
    });
}

/// The server answered the request itself (not yet the undo, which is read from the thread).
fn undo_sent(app: &mut App, thread_id: &str, result: Result<Value, String>) {
    let Err(reason) = result else { return };
    if app
        .threadops
        .undo
        .as_ref()
        .is_some_and(|p| p.thread_id == thread_id)
    {
        app.threadops.undo = None;
    }
    app.notice = Some(format!(
        "{}: {}",
        s("Could not request the undo", "되돌리기 요청 실패"),
        flat(&reason)
    ));
    if is_connection_error(&reason) {
        app.say(
            Tone::Warning,
            s(
                "It is not certain the request reached the server. Check the files with /diff and reopen the conversation to check its state.",
                "서버에 닿았는지 확실하지 않습니다. /diff 로 파일을, 대화를 다시 열어 상태를 확인하세요.",
            ),
        );
    }
}

// --- /diff ----------------------------------------------------------------------------------

/// A reply being written would end up above the report, which is written under the conversation.
fn reply_running(app: &App, command: &str) -> Option<String> {
    app.conv.busy().then(|| {
        fill(
            s(
                "A reply is in progress. Use {command} once it finishes.",
                "답변이 진행 중입니다. 끝난 뒤에 {command} 를 쓰세요.",
            ),
            &[("command", command.to_string())],
        )
    })
}

fn diff_busy() -> &'static str {
    s("The diff is still loading.", "diff 를 불러오는 중입니다.")
}

fn diff_loading() -> &'static str {
    s("Loading diff…", "diff 불러오는 중…")
}

/// `/diff [turn] [file]`: what the last turn (or the numbered one) changed, as the desktop app's
/// diff panel reads it from the turn's checkpoint. It is written under the conversation, with a
/// count of files, and stops after a few hundred lines; one file can be asked for whole.
pub fn diff(app: &mut App, argument: &str) {
    let words: Vec<&str> = argument.split_whitespace().collect();
    let request = match checkpoints::parse_diff_args(&words) {
        Ok(request) => request,
        Err(message) => {
            app.notice = Some(message);
            return;
        }
    };
    let Some(thread) = server_thread(app) else {
        app.notice = Some(
            s(
                "This thread has not started yet. A diff needs a conversation.",
                "아직 시작하지 않은 스레드입니다. 대화가 있어야 diff 를 볼 수 있습니다.",
            )
            .into(),
        );
        return;
    };
    if let Some(refusal) = reply_running(app, "/diff") {
        app.notice = Some(refusal);
        return;
    }
    if app.threadops.diff_busy {
        app.notice = Some(diff_busy().into());
        return;
    }
    let Some(rpc) = app.rpc.clone() else {
        app.notice = Some(
            s(
                "You can view this once the server is connected.",
                "서버와 연결된 뒤에 볼 수 있습니다.",
            )
            .into(),
        );
        return;
    };
    let checkpoint = match checkpoints::diff_turn(thread, request.turn, now_ms()) {
        Ok(checkpoint) => checkpoint,
        Err(gap) => {
            let text = checkpoints::gap_text(&gap);
            app.say(Tone::Warning, &text);
            return;
        }
    };
    let turn = checkpoint.checkpoint_turn_count.unwrap_or(0);
    let files = checkpoint.files.clone();
    let mut file = None;
    if let Some(name) = &request.file {
        let matches = crate::diff_report::match_files(&files, name);
        if matches.is_empty() {
            let text = fill(
                s(
                    "Turn {turn} did not change a file matching \"{file}\". See the list with /diff {turn}.",
                    "턴 {turn} 에서 바뀐 파일 중에 \"{file}\" 가 없습니다. /diff {turn} 으로 목록을 보세요.",
                ),
                &[("turn", turn.to_string()), ("file", flat(name))],
            );
            app.say(Tone::Warning, &text);
            return;
        }
        if matches.len() > 1 {
            let names = matches
                .iter()
                .take(5)
                .map(|f| flat(&f.path))
                .collect::<Vec<_>>()
                .join(", ");
            let text = fill(
                s(
                    "Several files match \"{file}\": {names}. Use a longer path.",
                    "\"{file}\" 에 해당하는 파일이 여럿입니다: {names}. 경로를 더 길게 쓰세요.",
                ),
                &[
                    ("file", flat(name)),
                    (
                        "names",
                        format!("{names}{}", if matches.len() > 5 { " …" } else { "" }),
                    ),
                ],
            );
            app.say(Tone::Warning, &text);
            return;
        }
        file = Some(matches[0].path.clone());
    }
    let Some(id) = app.thread_id() else { return };
    app.threadops.diff_busy = true;
    app.notice = Some(diff_loading().into());
    let (call, payload) = if turn <= 1 {
        (FULL_DIFF_RPC, json!({"threadId": id, "toTurnCount": turn}))
    } else {
        (
            TURN_DIFF_RPC,
            json!({"threadId": id, "fromTurnCount": turn - 1, "toTurnCount": turn}),
        )
    };
    #[cfg(test)]
    app.log
        .push(json!({"rpc": call, "payload": payload.clone()}));
    let tx = app.sender();
    tokio::spawn(async move {
        let result = rpc.call(call, payload).await;
        let job = DiffJob {
            thread_id: id,
            turn,
            files,
            file,
        };
        let _ = tx.send(Msg::Ext(Box::new(move |app| show_diff(app, job, result))));
    });
}

struct DiffJob {
    thread_id: String,
    turn: u64,
    files: Vec<crate::thread::CheckpointFile>,
    file: Option<String>,
}

fn show_diff(app: &mut App, job: DiffJob, result: Result<Value, String>) {
    app.threadops.diff_busy = false;
    // The user may have moved to another thread while the server was working.
    if app.thread_id().as_deref() != Some(job.thread_id.as_str()) {
        return;
    }
    // The loading line, and the "still loading" a second ask left over it, are over.
    if app.notice.as_deref() == Some(diff_loading()) || app.notice.as_deref() == Some(diff_busy()) {
        app.notice = None;
    }
    match result {
        Err(reason) => {
            let mut text = fill(
                s(
                    "Could not load the diff: {detail}",
                    "diff 를 불러오지 못했습니다: {detail}",
                ),
                &[("detail", flat(&reason))],
            );
            if is_connection_error(&reason) {
                text.push_str(s(
                    " · Check your connection and try again",
                    " · 연결을 확인하고 다시 시도하세요",
                ));
            }
            app.say(Tone::Error, &text);
        }
        Ok(answer) => {
            // A reply began while the server was working: the report would end up in the middle of it.
            if let Some(refusal) = reply_running(app, "/diff") {
                app.notice = Some(refusal);
                return;
            }
            let columns = match app.geo.get().area.width {
                0 => usize::from(app.width.get()),
                n => usize::from(n),
            };
            let lines = crate::diff_report::report(
                &app.theme,
                &app.sym,
                if columns == 0 { 80 } else { columns },
                job.turn,
                &job.files,
                answer["diff"].as_str().unwrap_or_default(),
                job.file.as_deref(),
            );
            app.add_note(crate::notes::Note::Rows { lines });
        }
    }
}

// --- /history -------------------------------------------------------------------------------

/// The count in `/history <n>`: whole numbers from 1, cut to the most one command loads; none for
/// anything else.
fn parse_history_count(word: Option<&str>) -> Option<usize> {
    let Some(word) = word else {
        return Some(HISTORY_DEFAULT);
    };
    if word.is_empty() || !word.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // A number too big for usize is cut like any other big one.
    let count = word.parse::<usize>().unwrap_or(usize::MAX);
    (count >= 1).then(|| count.min(HISTORY_MAX))
}

fn history_loading() -> &'static str {
    s("Loading earlier conversation…", "이전 대화 불러오는 중…")
}

/// `/history [n]`: loads at least `n` messages before the ones on screen and shows the start of
/// them. The TypeScript terminal prints them again at the bottom of the scrollback because it cannot
/// write above it; this screen holds the whole thread, so the older turns are read into it (a page
/// at a time, as scrolling to the top does) and the view moves to the top.
pub fn history(app: &mut App, argument: &str) {
    let Some(count) = parse_history_count(argument.split_whitespace().next()) else {
        app.notice = Some(fill(
            s(
                "Usage: /history [count] (1-{max})",
                "사용법: /history [개수] (1~{max})",
            ),
            &[("max", HISTORY_MAX.to_string())],
        ));
        return;
    };
    if matches!(app.active, Active::Draft(_) | Active::None) {
        app.notice = Some(
            s(
                "This is a new thread, so there is no earlier conversation.",
                "새 스레드라 이전 대화가 없습니다.",
            )
            .into(),
        );
        return;
    }
    if server_thread(app).is_none() {
        app.notice = Some(
            s(
                "Use this after the thread has loaded.",
                "스레드를 불러온 뒤에 쓰세요.",
            )
            .into(),
        );
        return;
    }
    if app.threadops.history.is_some() {
        app.notice = Some(history_loading().into());
        return;
    }
    if !app.conv.has_more {
        app.notice = Some(
            s(
                "There is no earlier conversation.",
                "더 이전 대화가 없습니다.",
            )
            .into(),
        );
        return;
    }
    let Some(id) = app.thread_id() else { return };
    if app.rpc.is_none() || app.origin.is_none() {
        app.notice = Some(crate::i18n::tr("notice.offline").into());
        return;
    }
    let start = visible_messages(app);
    app.threadops.history = Some(HistoryJob {
        thread_id: id,
        start,
        target: start + count,
        last: start,
    });
    app.notice = Some(history_loading().into());
    app.request_older();
    if !app.conv.loading_older {
        // Nothing could be requested (no cursor): there is nothing to wait for.
        app.threadops.history = None;
        app.notice = Some(
            s(
                "There is no earlier conversation.",
                "더 이전 대화가 없습니다.",
            )
            .into(),
        );
    }
}

/// A page of older turns arrived (or failed): `/history` asks for the next one until it has enough.
pub fn on_older(app: &mut App, failure: Option<String>) {
    let Some(mut job) = app.threadops.history.take() else {
        return;
    };
    if app.thread_id().as_deref() != Some(job.thread_id.as_str()) {
        return;
    }
    if let Some(detail) = failure {
        // What was loaded stays, so the same command tries the page again.
        app.notice = Some(fill(
            s(
                "Could not load earlier conversation: {detail}",
                "이전 대화를 불러오지 못했습니다: {detail}",
            ),
            &[("detail", flat(&detail))],
        ));
        return;
    }
    let visible = visible_messages(app);
    // A page that adds nothing would be asked for again for ever.
    let grew = visible > job.last;
    let start = job.start;
    if visible < job.target && app.conv.has_more && grew {
        job.last = visible;
        app.threadops.history = Some(job);
        app.request_older();
        if app.conv.loading_older {
            return;
        }
        app.threadops.history = None;
    }
    let loaded = visible - start;
    if loaded == 0 {
        app.notice = Some(
            s(
                "There is no earlier conversation.",
                "더 이전 대화가 없습니다.",
            )
            .into(),
        );
        return;
    }
    let remaining = if app.conv.has_more {
        s(
            "Earlier messages available · /history",
            "더 이전 메시지 있음 · /history",
        )
    } else {
        s(
            "You have reached the start of the conversation",
            "대화의 처음까지 봤습니다",
        )
    };
    let counted = fill(
        s("{count} earlier message(s)", "이전 대화 {count}개"),
        &[("count", loaded.to_string())],
    );
    let here = fill(
        s(
            "Earlier conversation up to here · {remaining}",
            "여기까지 이전 대화 · {remaining}",
        ),
        &[("remaining", remaining.to_string())],
    );
    app.notice = Some(format!("{counted} · {here}"));
    // The drawing brings this back to the top line.
    app.scroll.set(usize::MAX);
}

#[cfg(test)]
pub(crate) mod testkit {
    //! An app connected to a fake server that records what it is asked and answers by tag.

    use crate::app::{App, LinkStatus, Msg};
    use crate::wire::Rpc;
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};
    use tokio_tungstenite::tungstenite::Message;

    pub type Seen = Arc<Mutex<Vec<(String, Value)>>>;

    /// A server that answers `answer(tag, payload)` with a success value or a failure message; any
    /// tag it returns `None` for (the subscriptions) is left unanswered.
    pub async fn serve(
        answer: impl Fn(&str, &Value) -> Option<Result<Value, String>> + Send + 'static,
    ) -> (u16, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let m: Value = serde_json::from_str(text.as_str()).unwrap();
                if m["_tag"] != "Request" {
                    continue;
                }
                let tag = m["tag"].as_str().unwrap_or_default().to_string();
                record
                    .lock()
                    .unwrap()
                    .push((tag.clone(), m["payload"].clone()));
                let Some(result) = answer(&tag, &m["payload"]) else {
                    continue;
                };
                let exit = match result {
                    Ok(value) => json!({"_tag": "Success", "value": value}),
                    Err(message) => json!({"_tag": "Failure", "cause": [{"_tag": "Fail",
                        "error": {"_tag": "Failed", "message": message}}]}),
                };
                let reply = json!([{"_tag": "Exit", "requestId": m["id"], "exit": exit}]);
                ws.send(Message::text(reply.to_string())).await.unwrap();
            }
        });
        (port, seen)
    }

    /// An app on thread t1 with `thread` loaded, online, connected to the server on `port`.
    pub async fn connected(
        port: u16,
        thread: Value,
        has_more: bool,
    ) -> (App, UnboundedReceiver<Msg>) {
        let (tx, rx) = unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp/oop-rs/work/demo", "/tmp", tx);
        app.last_model_path = std::env::temp_dir().join("oop-rs-none-threadops/last-model.json");
        let rpc = Rpc::connect(&format!("ws://127.0.0.1:{port}/ws"))
            .await
            .unwrap();
        app.handle(Msg::Shell(json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 1,
            "projects": [{"id": "p1", "title": "demo", "workspaceRoot": "/tmp/oop-rs/work/demo"}],
            "threads": [{"id": "t1", "projectId": "p1", "title": "스레드", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}]}})));
        app.handle(Msg::Connected {
            rpc,
            config: json!({"providers": [{"instanceId": "codex", "displayName": "Codex", "enabled": true, "installed": true,
                "models": [{"slug": "gpt-5", "name": "GPT-5", "isDefault": true}]}]}),
            server: "fake".into(),
            origin: "http://127.0.0.1:1".into(),
            bearer: "b".into(),
        });
        app.link = LinkStatus::Online;
        app.active = crate::app::Active::Thread("t1".into());
        app.conv = crate::state::Conversation::new("t1");
        app.handle(Msg::Thread {
            id: "t1".into(),
            item: json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 5,
                "page": {"hasMore": has_more, "beforeCursor": if has_more { json!("c1") } else { Value::Null }},
                "thread": thread}}),
        });
        (app, rx)
    }

    /// Handles the next message the app gave itself, as the event loop would.
    pub async fn next(app: &mut App, rx: &mut UnboundedReceiver<Msg>) {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("a message in time")
            .unwrap();
        app.handle(msg);
    }

    /// The finished conversation of two turns the tests share, in the shape the server sends it.
    pub fn two_turns(extra: Value) -> Value {
        let mut thread = json!({
            "id": "t1", "title": "스레드", "runtimeMode": "approval-required", "interactionMode": "default",
            "modelSelection": {"instanceId": "codex", "model": "gpt-5"},
            "worktreePath": "/tmp/wt",
            "latestTurn": {"turnId": "turn-2", "state": "completed", "requestedAt": "2026-01-01T00:00:05.000Z",
                "startedAt": "2026-01-01T00:00:05.000Z", "completedAt": "2026-01-01T00:00:08.000Z", "assistantMessageId": "a2"},
            "session": {"status": "ready", "providerInstanceId": "codex", "updatedAt": "2026-01-01T00:00:08.000Z"},
            "messages": [
                {"id": "u1", "role": "user", "text": "first", "streaming": false, "createdAt": "2026-01-01T00:00:01.000Z", "turnId": "turn-1"},
                {"id": "a1", "role": "assistant", "text": "one", "streaming": false, "createdAt": "2026-01-01T00:00:03.000Z", "turnId": "turn-1"},
                {"id": "u2", "role": "user", "text": "second question", "streaming": false, "createdAt": "2026-01-01T00:00:05.000Z", "turnId": "turn-2"},
                {"id": "a2", "role": "assistant", "text": "two", "streaming": false, "createdAt": "2026-01-01T00:00:08.000Z", "turnId": "turn-2"}],
            "checkpoints": [
                {"turnId": "turn-1", "checkpointTurnCount": 1, "status": "ready", "assistantMessageId": "a1",
                 "completedAt": "2026-01-01T00:00:03.000Z", "files": [{"path": "a.txt", "kind": "modified", "additions": 2, "deletions": 1}]},
                {"turnId": "turn-2", "checkpointTurnCount": 2, "status": "ready", "assistantMessageId": "a2",
                 "completedAt": "2026-01-01T00:00:08.000Z", "files": [{"path": "src/b.rs", "kind": "modified", "additions": 3, "deletions": 0}]}]
        });
        if let (Some(base), Some(more)) = (thread.as_object_mut(), extra.as_object()) {
            for (key, value) in more {
                base.insert(key.clone(), value.clone());
            }
        }
        thread
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use crate::notes::Note;
    use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use serde_json::{Value, json};

    fn note_text(app: &App) -> String {
        app.notes
            .iter()
            .map(|n| match n {
                Note::Text { title, body, .. } => format!("{title}\n{}", body.join("\n")),
                Note::Rows { lines } => crate::panels_common::plain(lines).join("\n"),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_history_count_is_a_whole_number_cut_to_the_most() {
        assert_eq!(parse_history_count(None), Some(30));
        assert_eq!(parse_history_count(Some("5")), Some(5));
        assert_eq!(parse_history_count(Some("999")), Some(200));
        assert_eq!(
            parse_history_count(Some("99999999999999999999999")),
            Some(200)
        );
        for bad in ["0", "-1", "3.5", "x", ""] {
            assert_eq!(parse_history_count(Some(bad)), None, "{bad}");
        }
    }

    #[tokio::test]
    async fn undo_lists_cancel_first_and_offers_files_only_where_they_can_be_restored() {
        let (port, _) = serve(|_, _| None).await;
        let (mut app, _rx) = connected(port, two_turns(json!({})), false).await;
        undo(&mut app);
        let Some(Modal::Pick(pick)) = &app.modal else {
            panic!("a list opens: {:?}", app.notice);
        };
        assert_eq!(pick.id, "undo");
        assert_eq!(pick.data, ["cancel", "files", "conversation"]);
        assert_eq!(pick.cursor, 0);
        // what is deleted is said under the conversation
        let said = note_text(&app);
        assert!(said.contains("second question"), "{said}");
        assert!(said.contains("src/b.rs") || said.contains("3"), "{said}");

        // a shared folder (no worktree) can only undo the conversation
        let (port, _) = serve(|_, _| None).await;
        let (mut shared, _rx) =
            connected(port, two_turns(json!({"worktreePath": null})), false).await;
        undo(&mut shared);
        let Some(Modal::Pick(pick)) = &shared.modal else {
            panic!("a list opens");
        };
        assert_eq!(pick.data, ["cancel", "conversation"]);
    }

    #[tokio::test]
    async fn undo_is_refused_when_it_cannot_run() {
        let (port, _) = serve(|_, _| None).await;
        // no conversation
        let (mut app, _rx) = connected(port, two_turns(json!({})), false).await;
        app.active = Active::Draft("p1".into());
        undo(&mut app);
        assert!(app.modal.is_none() && app.notice.is_some());
        app.active = Active::Thread("t1".into());
        // a turn is running
        app.conv.thread.session.as_mut().unwrap().status = "running".into();
        undo(&mut app);
        assert_eq!(
            app.notice.as_deref(),
            Some(s(
                "You cannot undo while work is running. Press Esc to interrupt, then run /undo again.",
                "작업 중에는 되돌릴 수 없습니다. Esc로 중단한 뒤 다시 /undo 하세요."
            ))
        );
        app.conv.thread.session.as_mut().unwrap().status = "ready".into();
        // offline
        let rpc = app.rpc.take();
        undo(&mut app);
        assert!(app.modal.is_none());
        assert!(app.notice.as_deref().unwrap().len() > 4);
        app.rpc = rpc;
        // a provider that cannot roll back
        app.config["providers"][0]["supportsConversationRollback"] = json!(false);
        undo(&mut app);
        assert!(app.modal.is_none());
        assert!(note_text(&app).contains("Codex"), "{}", note_text(&app));
    }

    #[tokio::test]
    async fn cancelling_sends_nothing_and_confirming_sends_the_revert_and_waits_for_the_thread() {
        let (port, seen) = serve(|tag, _| {
            (tag == "orchestration.dispatchCommand").then(|| Ok(json!({"sequence": 9})))
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({})), false).await;
        app.queue.push_back("later".into());
        // cancel
        undo(&mut app);
        let Some(Modal::Pick(pick)) = app.modal.take() else {
            panic!()
        };
        undo_picked(&mut app, &pick, 0);
        assert!(app.log.is_empty() && app.threadops.undo.is_none());
        // files and conversation
        undo(&mut app);
        let Some(Modal::Pick(pick)) = app.modal.take() else {
            panic!()
        };
        undo_picked(&mut app, &pick, 1);
        assert_eq!(app.log.len(), 1);
        assert_eq!(app.log[0]["type"], "thread.checkpoint.revert");
        assert_eq!(app.log[0]["turnCount"], 1);
        assert!(undo_active(&app));
        assert!(sending_blocked(&app).is_some());
        // a message cannot be sent meanwhile, and the queue is not pumped
        app.focus = crate::app::Focus::Composer;
        app.input.paste("hello");
        app.handle(Msg::Term(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        ))));
        assert_eq!(app.input.text(), "hello", "the message stays in the box");
        assert_eq!(app.log.len(), 1, "nothing but the revert was sent");
        assert_eq!(
            app.notice.as_deref(),
            Some(s(
                "Undo is in progress. You can send once it finishes.",
                "되돌리는 중입니다. 끝난 뒤에 보낼 수 있습니다."
            ))
        );
        app.input.take(false);
        app.input.paste("hello");
        next(&mut app, &mut rx).await;
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|(tag, payload)| tag == "orchestration.dispatchCommand"
                    && payload["turnCount"] == 1)
        );

        // the thread changing meanwhile does not send what waits in the queue
        app.handle(Msg::Thread {
            id: "t1".into(),
            item: json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 6, "thread": two_turns(json!({}))}}),
        });
        assert_eq!(app.queue.len(), 1);
        assert_eq!(app.log.len(), 1);

        // the server rewinds: the thread loses its last turn
        let mut rewound = two_turns(json!({}));
        rewound["checkpoints"].as_array_mut().unwrap().truncate(1);
        rewound["messages"].as_array_mut().unwrap().truncate(2);
        app.handle(Msg::Thread {
            id: "t1".into(),
            item: json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 7, "thread": rewound}}),
        });
        assert!(!undo_active(&app));
        let said = note_text(&app);
        assert!(
            said.contains("second question") || app.input.text().contains("second question"),
            "{said}"
        );
        // the question and the queued message are back in the composer, question first
        let typed = app.input.text();
        assert_eq!(typed, "second question\n\nlater\n\nhello");
        assert!(app.queue.is_empty());
        assert!(said.contains(s("Files: restored", "파일: ")), "{said}");
    }

    #[tokio::test]
    async fn an_undo_the_server_refuses_is_reported_and_forgotten() {
        let (port, _) = serve(|tag, _| {
            (tag == "orchestration.dispatchCommand").then(|| Err("boom".to_string()))
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({})), false).await;
        undo(&mut app);
        let Some(Modal::Pick(pick)) = app.modal.take() else {
            panic!()
        };
        undo_picked(&mut app, &pick, 2);
        assert_eq!(app.log[0]["type"], "thread.conversation.revert");
        next(&mut app, &mut rx).await;
        assert!(app.threadops.undo.is_none());
        assert!(app.notice.as_deref().unwrap().contains("boom"));
    }

    #[tokio::test]
    async fn a_failed_revert_shows_in_the_thread_and_leaves_the_conversation() {
        let (port, _) = serve(|_, _| None).await;
        let (mut app, _rx) = connected(port, two_turns(json!({})), false).await;
        undo(&mut app);
        let Some(Modal::Pick(pick)) = app.modal.take() else {
            panic!()
        };
        undo_picked(&mut app, &pick, 1);
        let mut failed = two_turns(json!({}));
        failed["activities"] = json!([{"id": "f1", "tone": "error", "kind": "checkpoint.revert.failed",
            "summary": "x", "payload": {"detail": "dirty tree\nsecond line"}, "createdAt": "2026-01-01T00:00:09.000Z"}]);
        app.handle(Msg::Thread {
            id: "t1".into(),
            item: json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 6, "thread": failed}}),
        });
        assert!(!undo_active(&app));
        assert!(note_text(&app).contains(s("Could not undo", "되돌리지 못했습니다")));
    }

    #[tokio::test]
    async fn the_answer_is_read_when_the_thread_comes_back() {
        let (port, _) = serve(|_, _| None).await;
        let (mut app, _rx) = connected(port, two_turns(json!({})), false).await;
        undo(&mut app);
        let Some(Modal::Pick(pick)) = app.modal.take() else {
            panic!()
        };
        undo_picked(&mut app, &pick, 2);
        on_leave(&mut app);
        assert!(app.threadops.undo.as_ref().unwrap().away);
        // an old request is not dropped while away
        app.threadops.undo.as_mut().unwrap().started_at -= 10 * PENDING_LIMIT_MS;
        assert!(undo_active(&app));
        on_thread(&mut app);
        let pending = app.threadops.undo.as_ref().unwrap();
        assert!(!pending.away && now_ms() - pending.started_at < PENDING_LIMIT_MS);
    }

    #[tokio::test]
    async fn a_rewind_made_elsewhere_is_noted_without_touching_the_composer() {
        let (port, _) = serve(|_, _| None).await;
        let (mut app, _rx) = connected(port, two_turns(json!({})), false).await;
        app.input.paste("typed");
        let mut rewound = two_turns(json!({}));
        rewound["checkpoints"].as_array_mut().unwrap().truncate(1);
        app.handle(Msg::Thread {
            id: "t1".into(),
            item: json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 6, "thread": rewound}}),
        });
        assert_eq!(app.input.text(), "typed");
        assert!(note_text(&app).contains(s("Undone from turn 2", "턴 2부터 되돌림")));
    }

    #[tokio::test]
    async fn diff_reads_the_turn_between_its_checkpoints_and_writes_a_report() {
        let (port, seen) = serve(|tag, payload| {
            (tag == "orchestration.getTurnDiff").then(|| {
                assert_eq!(payload["fromTurnCount"], 1);
                assert_eq!(payload["toTurnCount"], 2);
                Ok(json!({"diff": "diff --git a/src/b.rs b/src/b.rs\n--- a/src/b.rs\n+++ b/src/b.rs\n@@ -1 +1,4 @@\n a\n+b\n+c\n+d\n"}))
            })
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({})), false).await;
        diff(&mut app, "");
        assert_eq!(app.notice.as_deref(), Some(diff_loading()));
        // a second ask while it loads is refused
        diff(&mut app, "");
        assert_eq!(app.notice.as_deref(), Some(diff_busy()));
        next(&mut app, &mut rx).await;
        assert!(app.notice.is_none());
        let said = note_text(&app);
        assert!(said.contains("src/b.rs") && said.contains("+ d"), "{said}");
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|(tag, _)| tag == "orchestration.getTurnDiff")
        );
        // and once it is over, another may begin
        assert!(!app.threadops.diff_busy);
    }

    #[tokio::test]
    async fn the_first_turn_is_read_from_the_start_of_the_thread() {
        let (port, _) = serve(|tag, payload| {
            (tag == "orchestration.getFullThreadDiff").then(|| {
                assert_eq!(payload["toTurnCount"], 1);
                assert!(payload.get("fromTurnCount").is_none());
                Ok(json!({"diff": ""}))
            })
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({})), false).await;
        diff(&mut app, "1");
        next(&mut app, &mut rx).await;
        assert!(note_text(&app).contains("a.txt"), "{}", note_text(&app));
    }

    #[tokio::test]
    async fn diff_refusals_and_failures_are_said() {
        let (port, _) = serve(|tag, _| {
            (tag == "orchestration.getTurnDiff").then(|| Err("too big".to_string()))
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({})), false).await;
        diff(&mut app, "0");
        assert!(app.notice.is_some() && !app.threadops.diff_busy);
        diff(&mut app, "9");
        assert!(note_text(&app).len() > 5);
        let before = app.notes.len();
        diff(&mut app, "2 nothere.rs");
        assert_eq!(app.notes.len(), before + 1);
        // a reply in progress
        app.conv.thread.session.as_mut().unwrap().status = "running".into();
        diff(&mut app, "");
        assert!(app.notice.as_deref().unwrap().contains("/diff"));
        app.conv.thread.session.as_mut().unwrap().status = "ready".into();
        // a server failure
        diff(&mut app, "");
        next(&mut app, &mut rx).await;
        assert!(note_text(&app).contains("too big"));
        // offline
        app.rpc = None;
        diff(&mut app, "");
        assert!(app.notice.is_some());
    }

    #[tokio::test]
    async fn history_loads_pages_until_it_has_enough_and_goes_to_the_top() {
        let (port, _) = serve(|_, _| None).await;
        let (mut app, _rx) = connected(port, two_turns(json!({})), true).await;
        assert_eq!(app.conv.thread.messages.len(), 4);
        history(&mut app, "3");
        assert!(app.conv.loading_older, "the first page was asked for");
        assert_eq!(app.notice.as_deref(), Some(history_loading()));
        // asking again meanwhile only says it is loading
        history(&mut app, "3");
        assert_eq!(app.notice.as_deref(), Some(history_loading()));
        // a page of two messages is not enough for three: another is asked for
        let page = |n: u32, more: bool| {
            json!({"snapshotSequence": 4, "page": {"hasMore": more, "beforeCursor": if more { json!(format!("c{}", n + 1)) } else { Value::Null }},
                "thread": {"messages": [
                    {"id": format!("o{n}a"), "role": "user", "text": "old q", "streaming": false, "createdAt": format!("2025-01-0{n}T00:00:01.000Z")},
                    {"id": format!("o{n}b"), "role": "assistant", "text": "old a", "streaming": false, "createdAt": format!("2025-01-0{n}T00:00:02.000Z")}]}})
        };
        app.handle(Msg::Older {
            id: "t1".into(),
            result: Ok(page(1, true)),
        });
        assert!(app.conv.loading_older, "one more page is needed");
        assert!(app.threadops.history.is_some());
        app.handle(Msg::Older {
            id: "t1".into(),
            result: Ok(page(2, false)),
        });
        assert!(app.threadops.history.is_none());
        assert_eq!(app.scroll.get(), usize::MAX);
        let text = app.notice.clone().unwrap();
        assert!(text.contains('4'), "{text}");
        assert!(text.contains(s(
            "You have reached the start of the conversation",
            "대화의 처음까지 봤습니다"
        )));
    }

    #[tokio::test]
    async fn history_says_when_there_is_nothing_to_load_or_the_page_fails() {
        let (port, _) = serve(|_, _| None).await;
        let (mut app, _rx) = connected(port, two_turns(json!({})), false).await;
        history(&mut app, "");
        assert_eq!(
            app.notice.as_deref(),
            Some(s(
                "There is no earlier conversation.",
                "더 이전 대화가 없습니다."
            ))
        );
        history(&mut app, "abc");
        assert!(app.notice.as_deref().unwrap().contains("200"));
        app.active = Active::Draft("p1".into());
        history(&mut app, "");
        assert_eq!(
            app.notice.as_deref(),
            Some(s(
                "This is a new thread, so there is no earlier conversation.",
                "새 스레드라 이전 대화가 없습니다."
            ))
        );

        let (port, _) = serve(|_, _| None).await;
        let (mut more, _rx) = connected(port, two_turns(json!({})), true).await;
        history(&mut more, "5");
        more.handle(Msg::Older {
            id: "t1".into(),
            result: Err("the server answered 500".into()),
        });
        assert!(more.threadops.history.is_none());
        assert!(more.notice.as_deref().unwrap().contains("500"));
        // an empty page ends the loop instead of asking for ever
        history(&mut more, "5");
        more.handle(Msg::Older {
            id: "t1".into(),
            result: Ok(json!({"snapshotSequence": 4, "page": {"hasMore": true, "beforeCursor": "c2"}, "thread": {"messages": []}})),
        });
        assert!(more.threadops.history.is_none());
        assert!(!more.conv.loading_older);
    }
}
