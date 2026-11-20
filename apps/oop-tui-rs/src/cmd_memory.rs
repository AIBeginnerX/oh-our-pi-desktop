//! `/memory`: the memory suggestions and tidy-ups waiting for the open project, dreaming ones too,
//! from `projectMemory.listProposals` / `projectMemory.listTidy`, and the decisions on them.
//! `/memory analyse` runs the work analyser; `opened` mentions waiting ones once per project per hour.

use crate::app::{App, Modal, Msg, Pick};
use crate::panels_common::{fill, flat, s};
use serde_json::{Value, json};

fn cap(app: &App, key: &str) -> bool {
    app.config["environment"]["capabilities"]["projectMemory"][key] == true
}

fn unsupported(app: &mut App) {
    app.notice = Some(
        s(
            "This server does not offer memory suggestions.",
            "이 서버는 메모리 제안을 지원하지 않습니다.",
        )
        .into(),
    );
}

fn context(app: &mut App) -> Option<(crate::wire::Rpc, String)> {
    let Some(rpc) = app.rpc.clone() else {
        app.notice = Some(
            s(
                "Memory suggestions are available once the server is connected.",
                "서버와 연결된 뒤에 사용할 수 있습니다.",
            )
            .into(),
        );
        return None;
    };
    let Some(project) = crate::lists::current_project(app) else {
        app.notice = Some(s("Open a project first.", "먼저 프로젝트를 여세요.").into());
        return None;
    };
    Some((rpc, project))
}

struct MemorySuggestions {
    waiting: Vec<Value>,
    approved: Vec<String>,
    analysis_health: Value,
}

async fn fetch(
    rpc: &crate::wire::Rpc,
    project: &str,
    proposals: bool,
    tidy: bool,
    mode: &str,
) -> Result<MemorySuggestions, String> {
    let ask = |enabled, method| async move {
        if enabled {
            rpc.call(method, json!({"projectId":project})).await
        } else {
            Ok(json!({"items":[]}))
        }
    };
    let (p, t) = tokio::join!(
        ask(proposals, "projectMemory.listProposals"),
        ask(tidy, "projectMemory.listTidy")
    );
    let proposals = p?;
    let analysis_health = proposals["analysisHealth"].clone();
    let mut items = Vec::new();
    for answer in [proposals, t?] {
        items.extend(answer["items"].as_array().cloned().unwrap_or_default());
    }
    let mut waiting = Vec::new();
    let mut approved = Vec::new();
    for item in items {
        let eligible = item["proposalId"].is_string()
            && !item["tidyId"].is_string()
            && text(&item, "projectId") == project
            && (item["analysis"]["target"] == "memory"
                || (mode == "all" && item["analysis"].is_null()));
        if matches!(mode, "analyser" | "all")
            && eligible
            && rpc
                .call(
                    "projectMemory.approveProposal",
                    json!({"projectId":project,"proposalId":item["proposalId"]}),
                )
                .await
                .is_ok()
        {
            approved.push(text(&item, "title").to_string());
        } else {
            waiting.push(item);
        }
    }
    Ok(MemorySuggestions {
        waiting,
        approved,
        analysis_health,
    })
}

fn approved_note(app: &mut App, titles: &[String]) {
    if !titles.is_empty() {
        app.note(
            crate::notes::Tone::Info,
            s("Auto-approved memories", "자동 승인한 메모리"),
            titles.to_vec(),
        );
    }
}

fn approved_notice(count: usize) -> String {
    fill(
        s(
            "Auto-approved {a} memory suggestions",
            "메모리 제안 {a}개를 자동 승인했습니다",
        ),
        &[("a", count.to_string())],
    )
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default()
}

/// Shown while the work analyser waits for room in the review queue.
fn queue_full() -> &'static str {
    s(
        "Review queue is full. Analysis continues after you review a suggestion.",
        "검토 대기열이 가득 찼습니다. 제안을 검토하면 분석을 이어갑니다.",
    )
}

fn analysis_status(app: &App, health: &Value) -> Option<String> {
    let enabled = app.config["settings"]["projectMemoryAnalyser"] == true;
    let off = s("Work analyser is off.", "작업 분석기가 꺼져 있습니다.");
    let stamp = text(health, "lastAttemptAt");
    if stamp.is_empty() {
        return cap(app, "analyser").then(|| {
            if enabled {
                s(
                    "Work analyser has not run for this project yet.",
                    "이 프로젝트에서 작업 분석기를 아직 실행하지 않았습니다.",
                )
            } else {
                off
            }
            .into()
        });
    }
    let date = if stamp.ends_with('Z') && crate::text::parse_iso_ms(stamp).is_some() {
        format!("{} UTC", stamp[..16].replace('T', " "))
    } else {
        flat(stamp)
    };
    let run = fill(
        s(
            "Last analysis {date} · {threads} threads, {signals} with signals",
            "마지막 분석 {date} · 스레드 {threads}개, 신호 {signals}개",
        ),
        &[
            ("date", date),
            (
                "threads",
                health["threadsRead"].as_u64().unwrap_or(0).to_string(),
            ),
            (
                "signals",
                health["threadsWithSignals"]
                    .as_u64()
                    .unwrap_or(0)
                    .to_string(),
            ),
        ],
    );
    let reason = if cap(app, "analyser") && !enabled {
        off
    } else {
        match text(health, "outcome") {
            "no-signals" => s("No new work signals.", "새 작업 신호가 없습니다."),
            "no-candidates" => s(
                "No new suggestions met the requirements.",
                "근거가 충분한 새 제안이 없었습니다.",
            ),
            "queue-full" => queue_full(),
            "failed" => s("Last analysis failed.", "마지막 분석에 실패했습니다."),
            _ => "",
        }
    };
    Some(if reason.is_empty() {
        run
    } else {
        format!("{reason} {run}")
    })
}

fn list_error(error: &str) -> String {
    format!(
        "{} {}",
        s(
            "Could not list memory suggestions:",
            "메모리 제안 목록을 가져오지 못했습니다:"
        ),
        flat(error)
    )
}

fn dreamed(v: &Value) -> bool {
    v["dreamed"] == true || v["analysis"]["dreamed"] == true
}

fn label(v: &Value) -> String {
    let title;
    let kind = if v["tidyId"].is_string() {
        title = v["memories"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|m| text(m, "title"))
            .collect::<Vec<_>>()
            .join(" + ");
        match text(v, "action") {
            "merge" => s("Merge", "합치기"),
            "update" => s("Update", "고치기"),
            _ => s("Delete", "지우기"),
        }
    } else {
        title = text(v, "title").to_string();
        match text(&v["analysis"], "target") {
            "memory" => s("From work", "작업 분석"),
            "skill" => s("Procedure", "절차"),
            _ => s("Agent", "에이전트"),
        }
    };
    format!(
        "{}{kind} · {}",
        if dreamed(v) {
            s("Dreaming · ", "드리밍 · ")
        } else {
            ""
        },
        flat(&title)
    )
}

fn show(app: &mut App, items: Vec<Value>, empty_notice: bool) {
    if items.is_empty() {
        if empty_notice {
            app.notice = Some(
                s(
                    "No memory suggestions are waiting.",
                    "기다리는 메모리 제안이 없습니다.",
                )
                .into(),
            );
        }
        return;
    }
    app.modal = Some(Modal::Pick(Pick {
        id: "memory",
        title: s(
            "Memory suggestions · Enter opens",
            "메모리 제안 · Enter로 열기",
        )
        .into(),
        cursor: 0,
        items: items.iter().map(label).collect(),
        data: items.iter().map(Value::to_string).collect(),
        typed: None,
    }));
}

fn list(app: &mut App, empty_notice: bool) {
    let Some((rpc, project)) = context(app) else {
        return;
    };
    let (p, t) = (cap(app, "proposals"), cap(app, "tidy"));
    if !p && !t {
        unsupported(app);
        return;
    }
    let mode = app.settings.memory_auto_approve.clone();
    let tx = app.sender();
    tokio::spawn(async move {
        let result = fetch(&rpc, &project, p, t, &mode).await;
        let _ = tx.send(Msg::Ext(Box::new(move |app| {
            if crate::lists::current_project(app).as_deref() != Some(&project) {
                return;
            }
            match result {
                Ok(result) => {
                    approved_note(app, &result.approved);
                    let status = if empty_notice {
                        analysis_status(app, &result.analysis_health).or_else(|| {
                            (!result.approved.is_empty())
                                .then(|| approved_notice(result.approved.len()))
                        })
                    } else {
                        None
                    };
                    let show_empty = empty_notice && status.is_none();
                    if let Some(status) = status {
                        app.notice = Some(status);
                    }
                    show(app, result.waiting, show_empty);
                }
                Err(error) => app.notice = Some(list_error(&error)),
            }
        })));
    });
}

fn needs_review(memory: &Value) -> bool {
    let outcomes = &memory["outcomes"];
    let bad = outcomes["bad"].as_u64().unwrap_or(0);
    bad >= 3 && bad > outcomes["good"].as_u64().unwrap_or(0)
}

fn saved_label(memory: &Value) -> String {
    let title = flat(text(memory, "title"));
    let outcomes = &memory["outcomes"];
    let held = memory["held"] == true;
    let mark = if held {
        s(" · Held", " · 보류")
    } else if needs_review(memory) {
        s(" · Review", " · 검토")
    } else {
        ""
    };
    if let Some(sent) = outcomes["sent"].as_u64() {
        return fill(
            s(
                "{title} · Sent {sent} · {good} good · {bad} bad · {unknown} unknown{mark}",
                "{title} · 전송 {sent} · 성공 {good} · 실패 {bad} · 미확인 {unknown}{mark}",
            ),
            &[
                ("title", title),
                ("sent", sent.to_string()),
                ("good", outcomes["good"].as_u64().unwrap_or(0).to_string()),
                ("bad", outcomes["bad"].as_u64().unwrap_or(0).to_string()),
                (
                    "unknown",
                    outcomes["unknown"].as_u64().unwrap_or(0).to_string(),
                ),
                ("mark", mark.into()),
            ],
        );
    }
    let preview = flat(text(memory, "body").lines().next().unwrap_or_default());
    format!("{title}{mark} · {}", crate::text::truncate(&preview, 80))
}

fn saved(app: &mut App) {
    if !cap(app, "manage") {
        unsupported(app);
        return;
    }
    let Some((rpc, project)) = context(app) else {
        return;
    };
    let tx = app.sender();
    tokio::spawn(async move {
        let result = rpc
            .call(
                "projectMemory.list",
                json!({"projectId":project,"includeBody":true,"limit":100}),
            )
            .await;
        let _ = tx.send(Msg::Ext(Box::new(move |app| {
            if crate::lists::current_project(app).as_deref() != Some(&project) {
                return;
            }
            match result {
                Ok(v) => {
                    let items = v["items"].as_array().cloned().unwrap_or_default();
                    if items.is_empty() {
                        app.notice =
                            Some(s("No saved memories.", "저장된 메모리가 없습니다.").into());
                        return;
                    }
                    app.modal = Some(Modal::Pick(Pick {
                        id: "memory-saved",
                        title: if items
                            .iter()
                            .any(|item| item["outcomes"]["bad"].as_u64().unwrap_or(0) > 0)
                        {
                            s(
                                "Saved memories · A bad outcome does not prove the memory caused it.",
                                "저장된 메모리 · 결과가 나빴더라도 메모리가 원인이었다는 증거는 아닙니다.",
                            )
                        } else {
                            s("Saved memories", "저장된 메모리")
                        }
                        .into(),
                        cursor: 0,
                        items: items.iter().map(saved_label).collect(),
                        data: items.iter().map(Value::to_string).collect(),
                        typed: None,
                    }));
                }
                Err(e) => memory_error(app, e),
            }
        })));
    });
}

fn memory_error(app: &mut App, error: String) {
    app.note(
        crate::notes::Tone::Info,
        s("Memory operation failed", "메모리 작업 실패"),
        vec![flat(&error)],
    );
}

fn saved_pick(
    app: &mut App,
    id: &'static str,
    title: String,
    item: &Value,
    actions: &[(&str, &str)],
) {
    app.modal = Some(Modal::Pick(Pick {
        id,
        title,
        cursor: 0,
        items: actions.iter().map(|(_, label)| label.to_string()).collect(),
        data: actions
            .iter()
            .map(|(action, _)| json!({"decision":action,"item":item}).to_string())
            .collect(),
        typed: None,
    }));
}

fn saved_picked(app: &mut App, pick: &Pick, v: Value) {
    if !cap(app, "manage") {
        unsupported(app);
        return;
    }
    if pick.id == "memory-saved" {
        let mut actions = vec![("edit", s("Edit", "편집")), ("delete", s("Delete", "삭제"))];
        if v["held"] == true {
            actions.push(("resume", s("Resume memory", "메모리 전송 재개")));
        } else if needs_review(&v) {
            actions.push(("hold", s("Hold memory", "메모리 전송 보류")));
        }
        actions.push(("cancel", s("Cancel", "취소")));
        saved_pick(
            app,
            "memory-saved-action",
            flat(text(&v, "title")),
            &v,
            &actions,
        );
        return;
    }
    let action = text(&v, "decision");
    if action == "cancel" {
        return;
    }
    let item = &v["item"];
    if action == "delete" {
        saved_pick(
            app,
            "memory-saved-confirm",
            fill(
                s("Delete \"{title}\"?", "\"{title}\" 삭제?"),
                &[("title", flat(text(item, "title")))],
            ),
            item,
            &[("yes", s("Yes", "예")), ("cancel", s("No", "아니요"))],
        );
        return;
    }
    let Some((rpc, project)) = context(app) else {
        return;
    };
    if text(item, "projectId") != project {
        return;
    }
    let mut payload = json!({"projectId":project,"memoryId":item["memoryId"]});
    let edit = action == "edit";
    let change_hold = matches!(action, "hold" | "resume");
    if change_hold {
        payload["held"] = json!(action == "hold");
    }
    if !edit {
        payload["expectedVersion"] = item["version"].clone();
    }
    let tx = app.sender();
    tokio::spawn(async move {
        let result = rpc
            .call(
                if edit {
                    "projectMemory.get"
                } else if change_hold {
                    "projectMemory.update"
                } else {
                    "projectMemory.delete"
                },
                payload,
            )
            .await;
        let _ = tx.send(Msg::Ext(Box::new(move |app| {
            if crate::lists::current_project(app).as_deref() != Some(&project) {
                return;
            }
            match result {
                Ok(v) if edit => {
                    if app.memory_edit.is_some() {
                        return;
                    }
                    let draft = app.input.stash_draft();
                    app.input.set(&format!(
                        "{}\n{}",
                        text(&v["memory"], "title"),
                        text(&v["memory"], "body")
                    ));
                    app.memory_edit = Some(Edit {
                        id: crate::text::new_id(),
                        memory: v["memory"].clone(),
                        draft,
                        saving: false,
                    });
                    app.focus = crate::app::Focus::Composer;
                }
                Ok(_) if change_hold => saved(app),
                Ok(_) => app.notice = Some(s("Memory deleted.", "메모리를 삭제했습니다.").into()),
                Err(e) => memory_error(app, e),
            }
        })));
    });
}

/// A saved memory open in the composer; `draft` is what the box held before, put back when the
/// edit ends. `id` ties a save's answer to the edit that sent it, so a late answer never ends a
/// newer edit.
pub(crate) struct Edit {
    id: String,
    memory: Value,
    draft: Option<crate::input::Saved>,
    saving: bool,
}

/// Esc: ends the edit unless its save is on the way.
pub(crate) fn cancel_edit(app: &mut App) {
    if app.memory_edit.as_ref().is_some_and(|e| e.saving) {
        return;
    }
    leave_edit(app);
}

/// Ends any edit and puts the earlier draft back, so leaving the thread stashes that draft and
/// never the memory text, and Enter in the next thread sends a message instead of saving. A save
/// still on the way only reports its outcome.
pub(crate) fn leave_edit(app: &mut App) {
    if let Some(edit) = app.memory_edit.take() {
        match edit.draft {
            Some(saved) => app.input.restore(saved),
            None => {
                app.input.take(false);
            }
        }
    }
}

pub(crate) fn save_edit(app: &mut App) {
    let Some(edit) = app.memory_edit.as_ref() else {
        return;
    };
    if edit.saving {
        return;
    }
    let text = app.input.text();
    let (title, body) = text.split_once('\n').unwrap_or((&text, ""));
    if title.trim().is_empty() || body.trim().is_empty() {
        app.notice = Some(
            s(
                "Title and body must not be empty.",
                "제목과 본문을 입력하세요.",
            )
            .into(),
        );
        return;
    }
    if !cap(app, "manage") {
        unsupported(app);
        return;
    }
    let Some(rpc) = app.rpc.clone() else {
        return;
    };
    let payload = json!({"projectId":edit.memory["projectId"],"memoryId":edit.memory["memoryId"],"expectedVersion":edit.memory["version"],"title":title.trim(),"body":body.trim()});
    let id = edit.id.clone();
    app.memory_edit.as_mut().unwrap().saving = true;
    let tx = app.sender();
    tokio::spawn(async move {
        let result = rpc.call("projectMemory.update", payload).await;
        let _ = tx.send(Msg::Ext(Box::new(move |app| {
            let current = app.memory_edit.as_ref().is_some_and(|e| e.id == id);
            match result {
                Ok(_) => {
                    if current {
                        leave_edit(app);
                    }
                    app.notice = Some(s("Memory saved.", "메모리를 저장했습니다.").into());
                }
                Err(e) => {
                    if current {
                        app.memory_edit.as_mut().unwrap().saving = false;
                    }
                    memory_error(app, e);
                }
            }
        })));
    });
}

/// `/memory` lists, `/memory analyse` runs the analyser; anything else prints the usage line.
pub fn run(app: &mut App, argument: &str) {
    match argument.trim() {
        "" => list(app, true),
        "saved" => saved(app),
        "analyse" => analyse(app),
        arg if arg == "auto" || arg.starts_with("auto ") => {
            auto(app, arg.strip_prefix("auto").unwrap().trim())
        }
        _ => {
            app.notice = Some(
                s(
                    "Usage: /memory · /memory saved · /memory analyse · /memory auto on|off|all",
                    "사용법: /memory · /memory saved · /memory analyse · /memory auto on|off|all",
                )
                .into(),
            )
        }
    }
}

fn mode_words(mode: &str) -> &'static str {
    match mode {
        "analyser" => s("on (work analyser·Dreaming)", "켬 (작업 분석·드리밍 제안)"),
        "all" => s("all suggestions", "모든 메모리 제안"),
        _ => s("off", "끔"),
    }
}

fn auto(app: &mut App, value: &str) {
    // `on` is the easy word for the safe level, which is stored as `analyser`.
    let mode = match value {
        "on" | "analyser" => "analyser",
        "off" | "all" => value,
        _ => {
            app.notice = Some(fill(
                s(
                    "Auto-approve: {mode} · /memory auto on|off|all",
                    "자동 승인: {mode} · /memory auto on|off|all",
                ),
                &[("mode", mode_words(&app.settings.memory_auto_approve).into())],
            ));
            return;
        }
    };
    app.settings.memory_auto_approve = mode.into();
    let saved = crate::settings_write::write_setting(
        &crate::cmd_misc::config_dir(app).join("settings.json"),
        "memoryAutoApprove",
        json!(mode),
    );
    let said = fill(
        s(
            "Auto-approve: {mode} — from the next /memory or project open",
            "자동 승인: {mode} — 다음 /memory 또는 프로젝트 열기부터",
        ),
        &[("mode", mode_words(mode).into())],
    );
    app.notice = Some(match saved {
        Ok(()) => said,
        Err(error) => format!("{said} ({error})"),
    });
}

/// A picked row: `memory-action` decides, anything else opens the note with the item's actions.
pub fn picked(app: &mut App, pick: &Pick, index: usize) {
    let Some(raw) = pick.data.get(index) else {
        return;
    };
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    if pick.id.starts_with("memory-saved") {
        saved_picked(app, pick, v);
        return;
    }
    if pick.id == "memory-action" {
        let action = text(&v, "decision");
        if action == "back" {
            list(app, true);
            return;
        }
        decide(app, &v["item"], action);
        return;
    }
    let tidy = v["tidyId"].is_string();
    let mut body = Vec::new();
    if !tidy {
        body.push(text(&v, "body").into());
    }
    body.push(format!("{} {}", s("Why:", "이유:"), text(&v, "reason")));
    let memories = if tidy {
        &v["memories"]
    } else {
        &v["analysis"]["related"]
    };
    for (i, m) in memories.as_array().into_iter().flatten().enumerate() {
        body.push(format!(
            "{}{} {}",
            if tidy {
                ""
            } else {
                s("Similar existing memory: ", "비슷한 기존 메모리: ")
            },
            text(m, "title"),
            if tidy && i == 0 && v["action"] == "merge" {
                s("(kept)", "(남김)")
            } else {
                ""
            }
        ));
        body.push(text(m, "body").into());
    }
    if tidy && v["action"] != "delete" {
        body.push(format!(
            "{} {}",
            s("Suggested:", "제안:"),
            text(&v, "title")
        ));
        body.push(text(&v, "body").into());
    }
    let title = if text(&v, "title").is_empty() {
        label(&v)
    } else {
        text(&v, "title").to_string()
    };
    app.note(crate::notes::Tone::Info, &title, body);
    let mut actions = Vec::new();
    if tidy {
        actions.push(("apply", s("Apply", "적용")));
    } else {
        actions.push(("approve", s("Approve", "승인")));
    }
    actions.push((
        "dismiss",
        if !tidy && v["analysis"].is_null() {
            s("Reject", "거절")
        } else {
            s("Dismiss", "무시")
        },
    ));
    actions.push(("back", s("Back", "뒤로")));
    app.modal = Some(Modal::Pick(Pick {
        id: "memory-action",
        title,
        cursor: 0,
        items: actions.iter().map(|(_, label)| label.to_string()).collect(),
        data: actions
            .iter()
            .map(|(a, _)| json!({"decision":a,"item":v}).to_string())
            .collect(),
        typed: None,
    }));
}

fn decide(app: &mut App, item: &Value, action: &str) {
    let Some((rpc, project)) = context(app) else {
        return;
    };
    if text(item, "projectId") != project {
        return;
    }
    let tidy = item["tidyId"].is_string();
    let (method, word) = match (tidy, action) {
        (true, "apply") => ("projectMemory.applyTidy", s("Applied.", "적용했습니다.")),
        (true, _) => (
            "projectMemory.dismissTidy",
            s("Dismissed.", "무시했습니다."),
        ),
        (false, "approve") => (
            "projectMemory.approveProposal",
            s("Approved.", "승인했습니다."),
        ),
        (false, _) => (
            "projectMemory.rejectProposal",
            s("Rejected.", "거절했습니다."),
        ),
    };
    let key = if tidy { "tidyId" } else { "proposalId" };
    let payload = json!({"projectId":project,key:item[key]});
    let tx = app.sender();
    tokio::spawn(async move {
        let result = rpc.call(method, payload).await;
        let _ = tx.send(Msg::Ext(Box::new(move |app| {
            if crate::lists::current_project(app).as_deref() != Some(&project) {
                return;
            }
            app.notice = Some(match result {
                Ok(_) => word.into(),
                Err(e) => format!(
                    "{} {}",
                    s(
                        "Could not save the decision:",
                        "결정을 저장하지 못했습니다:"
                    ),
                    flat(&e)
                ),
            });
            list(app, false);
        })));
    });
}

fn analyse(app: &mut App) {
    let Some((rpc, project)) = context(app) else {
        return;
    };
    if !cap(app, "analyser") {
        unsupported(app);
        return;
    }
    app.notice = Some(s("Analysing…", "분석하는 중…").into());
    let tx = app.sender();
    tokio::spawn(async move {
        let result = rpc
            .call("projectMemory.analyse", json!({"projectId":project}))
            .await;
        let _ = tx.send(Msg::Ext(Box::new(move |app| {
            if crate::lists::current_project(app).as_deref() != Some(&project) {
                return;
            }
            app.notice = Some(match result {
                Ok(v) if v["queueFull"] == true => queue_full().into(),
                Ok(v) => {
                    let n = v["threadsAnalysed"].as_u64().unwrap_or(0);
                    let m = v["memoriesProposed"].as_u64().unwrap_or(0);
                    let k = v["tidiesSuggested"].as_u64().unwrap_or(0);
                    fill(
                        s(
                            "Analysed {n} threads · {m} memory suggestions · {k} tidy-ups",
                            "스레드 {n}개 분석 · 메모리 제안 {m}개 · 정리 제안 {k}개",
                        ),
                        &[
                            ("n", n.to_string()),
                            ("m", m.to_string()),
                            ("k", k.to_string()),
                        ],
                    )
                }
                Err(e) => format!(
                    "{} {}",
                    s("Could not analyse:", "분석하지 못했습니다:"),
                    flat(&e)
                ),
            });
        })));
    });
}

/// Mentions what waits, once per project per hour, unless a notice is already up.
pub fn opened(app: &mut App) {
    let (p, t) = (cap(app, "proposals"), cap(app, "tidy"));
    if !p && !t {
        return;
    }
    let (Some(project), Some(rpc)) = (crate::lists::current_project(app), app.rpc.clone()) else {
        return;
    };
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    let now = crate::app::now_ms();
    if app
        .memory_asked
        .get(&project)
        .is_some_and(|last| now - last < 3_600_000)
    {
        return;
    }
    app.memory_asked.insert(project.clone(), now);
    let mode = app.settings.memory_auto_approve.clone();
    let tx = app.sender();
    tokio::spawn(async move {
        let result = fetch(&rpc, &project, p, t, &mode).await;
        let _ = tx.send(Msg::Ext(Box::new(move |app| {
            if crate::lists::current_project(app).as_deref() != Some(&project) {
                return;
            }
            let MemorySuggestions {
                waiting: items,
                approved: titles,
                ..
            } = match result {
                Ok(result) => result,
                Err(error) => {
                    let message = list_error(&error);
                    if app.notice.is_none() {
                        app.notice = Some(message);
                    } else {
                        app.note(crate::notes::Tone::Warning, &message, Vec::new());
                    }
                    return;
                }
            };
            approved_note(app, &titles);
            if app.notice.is_some() {
                return;
            }
            if items.is_empty() {
                if !titles.is_empty() {
                    app.notice = Some(approved_notice(titles.len()));
                }
                return;
            }
            let p = items.iter().filter(|v| v["proposalId"].is_string()).count();
            let t = items.len() - p;
            let d = items.iter().filter(|v| dreamed(v)).count();
            let mut parts = Vec::new();
            if p > 0 {
                parts.push(fill(
                    s("{p} memory suggestions", "메모리 제안 {p}개"),
                    &[("p", p.to_string())],
                ));
            }
            if t > 0 {
                parts.push(fill(
                    s("{t} tidy-ups", "정리 제안 {t}개"),
                    &[("t", t.to_string())],
                ));
            }
            let dreaming = if d == 0 {
                String::new()
            } else {
                fill(
                    s(" ({d} from dreaming)", " (드리밍 {d}개)"),
                    &[("d", d.to_string())],
                )
            };
            let waiting = fill(
                s(
                    "{parts} waiting{dreaming} — /memory",
                    "{parts}가 기다립니다{dreaming} — /memory",
                ),
                &[("parts", parts.join(" · ")), ("dreaming", dreaming)],
            );
            app.notice = Some(if titles.is_empty() {
                waiting
            } else {
                fill(
                    s("Auto-approved {a} · ", "자동 승인 {a}개 · "),
                    &[("a", titles.len().to_string())],
                ) + &waiting
            });
        })));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd_history::testkit::{connected, next, serve, two_turns};

    fn saved_fixture() -> Value {
        serde_json::from_str(include_str!("../fixtures/memory/list.json")).unwrap()
    }

    #[tokio::test]
    async fn saved_memory_shows_outcomes_and_can_hold_and_resume() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let held = AtomicBool::new(false);
        let (port, _) = serve(move |tag, payload| match tag {
            "projectMemory.list" => {
                let mut page = saved_fixture();
                page["items"][0]["outcomes"] = json!({"sent":6,"good":2,"bad":3,"unknown":1});
                page["items"][0]["held"] = json!(held.load(Ordering::Relaxed));
                Some(Ok(page))
            }
            "projectMemory.update" => {
                let held = !held.fetch_xor(true, Ordering::Relaxed);
                assert_eq!(*payload, json!({
                    "projectId":"project-1","memoryId":"memory-1","expectedVersion":2,"held":held
                }));
                Some(Ok(Value::Null))
            }
            _ => None,
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({"projectId":"p1"})), false).await;
        app.active = crate::app::Active::Draft("project-1".into());
        app.config["environment"] = json!({"capabilities":{"projectMemory":{"manage":true}}});
        run(&mut app, "saved");
        next(&mut app, &mut rx).await;
        let p = pick(&app);
        assert_eq!(
            p.items[0],
            s(
                "Saved title · Sent 6 · 2 good · 3 bad · 1 unknown · Review",
                "Saved title · 전송 6 · 성공 2 · 실패 3 · 미확인 1 · 검토",
            )
        );
        assert_eq!(
            p.title,
            s(
                "Saved memories · A bad outcome does not prove the memory caused it.",
                "저장된 메모리 · 결과가 나빴더라도 메모리가 원인이었다는 증거는 아닙니다.",
            )
        );

        for (action, mark) in [
            (
                s("Hold memory", "메모리 전송 보류"),
                s(" · Held", " · 보류"),
            ),
            (
                s("Resume memory", "메모리 전송 재개"),
                s(" · Review", " · 검토"),
            ),
        ] {
            let p = pick(&app);
            crate::cmd::picked(&mut app, &p, 0);
            let p = pick(&app);
            assert_eq!(p.items[2], action);
            crate::cmd::picked(&mut app, &p, 2);
            next(&mut app, &mut rx).await;
            next(&mut app, &mut rx).await;
            assert!(pick(&app).items[0].ends_with(mark));
        }
    }

    #[tokio::test]
    async fn saved_memory_delete_and_cancel() {
        for confirm in [false, true] {
            let (port, seen) = serve(|tag, payload| match tag {
                "projectMemory.list" => {
                    assert_eq!(
                        *payload,
                        json!({"projectId":"project-1","includeBody":true,"limit":100})
                    );
                    Some(Ok(saved_fixture()))
                }
                "projectMemory.delete" => {
                    assert_eq!(
                        *payload,
                        serde_json::from_str::<Value>(include_str!(
                            "../fixtures/memory/delete-request.json"
                        ))
                        .unwrap()
                    );
                    Some(Ok(Value::Null))
                }
                _ => None,
            })
            .await;
            let (mut app, mut rx) =
                connected(port, two_turns(json!({"projectId":"p1"})), false).await;
            app.active = crate::app::Active::Draft("project-1".into());
            app.config["environment"] = json!({"capabilities":{"projectMemory":{"manage":true}}});
            run(&mut app, "saved");
            next(&mut app, &mut rx).await;
            let p = pick(&app);
            crate::cmd::picked(&mut app, &p, 0);
            let p = pick(&app);
            crate::cmd::picked(&mut app, &p, 1);
            let p = pick(&app);
            crate::cmd::picked(&mut app, &p, usize::from(!confirm));
            if confirm {
                next(&mut app, &mut rx).await;
            }
            assert_eq!(
                seen.lock()
                    .unwrap()
                    .iter()
                    .filter(|(t, _)| t == "projectMemory.delete")
                    .count(),
                usize::from(confirm)
            );
        }
    }

    #[tokio::test]
    async fn saved_memory_edit_save_cancel_and_failure() {
        use ratatui::crossterm::event::{KeyCode, KeyEvent};
        for mode in ["save", "cancel", "fail"] {
            let (port, seen) = serve(move |tag, payload| match tag {
                "projectMemory.list" => Some(Ok(saved_fixture())),
                "projectMemory.get" => Some(Ok(json!({"memory":saved_fixture()["items"][0]}))),
                "projectMemory.update" => {
                    assert_eq!(
                        *payload,
                        serde_json::from_str::<Value>(include_str!(
                            "../fixtures/memory/update-request.json"
                        ))
                        .unwrap()
                    );
                    Some(if mode == "fail" {
                        Err("version conflict".into())
                    } else {
                        Ok(json!({}))
                    })
                }
                _ => None,
            })
            .await;
            let (mut app, mut rx) =
                connected(port, two_turns(json!({"projectId":"p1"})), false).await;
            app.active = crate::app::Active::Draft("project-1".into());
            app.config["environment"] = json!({"capabilities":{"projectMemory":{"manage":true}}});
            app.input.set("old draft");
            run(&mut app, "saved");
            next(&mut app, &mut rx).await;
            let p = pick(&app);
            crate::cmd::picked(&mut app, &p, 0);
            let p = pick(&app);
            app.modal = None;
            crate::cmd::picked(&mut app, &p, 0);
            next(&mut app, &mut rx).await;
            assert_eq!(app.input.text(), "Saved title\nSaved body");
            app.input.set("New title\nNew body");
            if mode == "cancel" {
                assert!(crate::composer::key(&mut app, KeyEvent::from(KeyCode::Esc)));
            } else {
                app.submit();
                next(&mut app, &mut rx).await;
            }
            assert_eq!(
                app.input.text(),
                if mode == "fail" {
                    "New title\nNew body"
                } else {
                    "old draft"
                }
            );
            assert_eq!(app.memory_edit.is_some(), mode == "fail");
            assert_eq!(
                seen.lock()
                    .unwrap()
                    .iter()
                    .filter(|(t, _)| t == "projectMemory.update")
                    .count(),
                usize::from(mode != "cancel")
            );
            if mode == "fail" {
                assert!(!app.notes.is_empty());
            }
        }
    }

    #[tokio::test]
    async fn leaving_the_draft_ends_a_memory_edit_and_keeps_its_draft() {
        let (port, seen) = serve(|tag, _| match tag {
            "projectMemory.list" => Some(Ok(saved_fixture())),
            "projectMemory.get" => Some(Ok(json!({"memory":saved_fixture()["items"][0]}))),
            _ => None,
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({"projectId":"p1"})), false).await;
        app.active = crate::app::Active::Draft("project-1".into());
        app.config["environment"] = json!({"capabilities":{"projectMemory":{"manage":true}}});
        app.input.set("old draft");
        run(&mut app, "saved");
        next(&mut app, &mut rx).await;
        let p = pick(&app);
        crate::cmd::picked(&mut app, &p, 0);
        let p = pick(&app);
        app.modal = None;
        crate::cmd::picked(&mut app, &p, 0);
        next(&mut app, &mut rx).await;
        assert!(app.memory_edit.is_some());

        app.start_draft("project-2");
        assert!(app.memory_edit.is_none(), "the edit does not follow");
        assert_eq!(app.input.text(), "", "the other draft is empty");
        app.input.set("a message");
        app.start_draft("project-1");
        assert_eq!(app.input.text(), "old draft", "its own draft came back");
        assert!(
            !seen
                .lock()
                .unwrap()
                .iter()
                .any(|(t, _)| t == "projectMemory.update"),
            "nothing was saved as the memory"
        );
    }

    #[tokio::test]
    async fn a_late_save_answer_leaves_a_newer_edit_alone() {
        let (port, seen) = serve(|tag, _| match tag {
            "projectMemory.list" => Some(Ok(saved_fixture())),
            "projectMemory.get" => Some(Ok(json!({"memory":saved_fixture()["items"][0]}))),
            "projectMemory.update" => Some(Ok(json!({}))),
            _ => None,
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({"projectId":"p1"})), false).await;
        app.active = crate::app::Active::Draft("project-1".into());
        app.config["environment"] = json!({"capabilities":{"projectMemory":{"manage":true}}});
        run(&mut app, "saved");
        next(&mut app, &mut rx).await;
        let p = pick(&app);
        crate::cmd::picked(&mut app, &p, 0);
        let p = pick(&app);
        app.modal = None;
        crate::cmd::picked(&mut app, &p, 0);
        next(&mut app, &mut rx).await;

        // Memory A is saving when the user leaves, then starts editing memory B elsewhere.
        app.input.set("A title\nA body");
        app.submit();
        app.start_draft("project-2");
        app.memory_edit = Some(Edit {
            id: crate::text::new_id(),
            memory: saved_fixture()["items"][0].clone(),
            draft: None,
            saving: false,
        });
        app.input.set("B title\nB changes");

        next(&mut app, &mut rx).await; // A's answer arrives late
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|(t, _)| t == "projectMemory.update"),
            "A was saved"
        );
        assert!(app.memory_edit.is_some(), "B is still being edited");
        assert_eq!(app.input.text(), "B title\nB changes", "B's text is kept");
    }

    fn proposals() -> Value {
        serde_json::from_str(include_str!("../fixtures/memory/proposals.json")).unwrap()
    }

    fn tidies() -> Value {
        serde_json::from_str(include_str!("../fixtures/memory/tidies.json")).unwrap()
    }

    fn caps(app: &mut App) {
        app.config["environment"] = json!({"capabilities":{"projectMemory":{"proposals":true,"tidy":true,"analyser":true}}});
    }

    fn pick(app: &App) -> Pick {
        let Some(Modal::Pick(p)) = app.modal.clone() else {
            panic!("expected picker")
        };
        p
    }

    #[test]
    fn auto_command_persists_and_invalid_keeps_current_mode() {
        let dir = std::env::temp_dir().join(format!("oop-memory-auto-{}", crate::text::new_id()));
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp", "/tmp", tx);
        app.misc.config_dir = Some(dir.clone());
        run(&mut app, "auto all");
        assert_eq!(app.settings.memory_auto_approve, "all");
        assert_eq!(
            crate::settings::read_file(&dir.join("settings.json"))
                .settings
                .memory_auto_approve,
            "all"
        );
        assert!(app.notice.as_deref().unwrap().contains("from the next"));
        run(&mut app, "auto invalid");
        assert_eq!(app.settings.memory_auto_approve, "all");
        assert!(
            app.notice
                .as_deref()
                .unwrap()
                .contains("/memory auto on|off|all")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn auto_on_stores_the_safe_analyser_mode() {
        let dir =
            std::env::temp_dir().join(format!("oop-memory-auto-on-{}", crate::text::new_id()));
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp", "/tmp", tx);
        app.misc.config_dir = Some(dir.clone());
        run(&mut app, "auto on");
        assert_eq!(app.settings.memory_auto_approve, "analyser");
        assert_eq!(
            crate::settings::read_file(&dir.join("settings.json"))
                .settings
                .memory_auto_approve,
            "analyser"
        );
        assert!(
            app.notice
                .as_deref()
                .unwrap()
                .contains("on (work analyser·Dreaming)")
        );
        run(&mut app, "auto analyser");
        assert_eq!(app.settings.memory_auto_approve, "analyser");
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(saved["memoryAutoApprove"], "analyser");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn command_and_fixture_labels() {
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp", "/tmp", tx);
        caps(&mut app);
        assert!(crate::slash::COMMANDS.iter().any(|c| c.name == "memory"));
        assert!(crate::cmd::run(&mut app, "memory", "bad"));
        assert!(app.notice.as_deref().unwrap().contains("/memory analyse"));
        let p = proposals();
        let t = tidies();
        assert!(label(&p["items"][0]).starts_with("Agent · "));
        assert!(label(&p["items"][1]).starts_with("Dreaming · From work · "));
        assert!(label(&p["items"][2]).starts_with("Procedure · "));
        assert!(label(&t["items"][0]).starts_with("Dreaming · Merge · "));
        assert!(label(&t["items"][1]).starts_with("Delete · "));
        show(&mut app, p["items"].as_array().unwrap().clone(), true);
        assert_eq!(
            serde_json::from_str::<Value>(&pick(&app).data[2]).unwrap()["proposalId"],
            "proposal-skill"
        );
    }

    #[tokio::test]
    async fn approve_skill_and_apply_merge_then_list_again() {
        let (port, seen) = serve(|tag, payload| match tag {
            "projectMemory.listProposals" => Some(Ok(proposals())),
            "projectMemory.listTidy" => Some(Ok(tidies())),
            "projectMemory.approveProposal" => {
                assert_eq!(
                    *payload,
                    json!({"projectId":"project-1","proposalId":"proposal-skill"})
                );
                Some(Ok(json!({})))
            }
            "projectMemory.applyTidy" => {
                assert_eq!(
                    *payload,
                    json!({"projectId":"project-1","tidyId":"tidy-merge"})
                );
                Some(Ok(json!({})))
            }
            _ => None,
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({"projectId":"p1"})), false).await;
        caps(&mut app);
        // The fixture project is the active draft, so decisions retain the server's ids.
        app.active = crate::app::Active::Draft("project-1".into());
        run(&mut app, "");
        next(&mut app, &mut rx).await;
        let list = pick(&app);
        assert_eq!(list.items.len(), 5);
        picked(&mut app, &list, 2);
        let action = pick(&app);
        assert_eq!(action.items, ["Approve", "Dismiss", "Back"]);
        picked(&mut app, &action, 0);
        next(&mut app, &mut rx).await;
        next(&mut app, &mut rx).await;
        let list = pick(&app);
        picked(&mut app, &list, 3);
        assert_eq!(
            serde_json::from_str::<Value>(&pick(&app).data[0]).unwrap()["item"]["tidyId"],
            "tidy-merge"
        );
        let action = pick(&app);
        picked(&mut app, &action, 0);
        next(&mut app, &mut rx).await;
        next(&mut app, &mut rx).await;
        assert_eq!(pick(&app).id, "memory");
        let seen = seen.lock().unwrap();
        assert_eq!(
            seen.iter()
                .filter(|(tag, _)| tag == "projectMemory.approveProposal")
                .count(),
            1
        );
        assert_eq!(
            seen.iter()
                .filter(|(tag, _)| tag == "projectMemory.applyTidy")
                .count(),
            1
        );
        assert_eq!(
            seen.iter()
                .filter(|(tag, _)| tag == "projectMemory.listTidy")
                .count(),
            3
        );
    }

    #[tokio::test]
    async fn opened_counts_and_hourly_guard_and_missing_capability() {
        let (port, seen) = serve(|tag, _| match tag {
            "projectMemory.listProposals" => Some(Ok(proposals())),
            "projectMemory.listTidy" => Some(Ok(tidies())),
            _ => None,
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({"projectId":"p1"})), false).await;
        app.config["environment"] = json!({});
        opened(&mut app);
        assert!(app.memory_asked.is_empty());
        assert!(
            !seen
                .lock()
                .unwrap()
                .iter()
                .any(|(t, _)| t.starts_with("projectMemory."))
        );
        caps(&mut app);
        opened(&mut app);
        next(&mut app, &mut rx).await;
        assert_eq!(
            app.notice.as_deref(),
            Some("3 memory suggestions · 2 tidy-ups waiting (2 from dreaming) — /memory")
        );
        let before = seen.lock().unwrap().len();
        opened(&mut app);
        assert_eq!(seen.lock().unwrap().len(), before);
        assert_eq!(app.memory_asked.len(), 1);
    }

    #[tokio::test]
    async fn automatic_modes_preserve_manual_items_and_failures() {
        for (mode, fail, expected) in [
            ("off", false, 0),
            ("analyser", false, 1),
            ("all", false, 2),
            ("all", true, 0),
        ] {
            let (port, seen) = serve(move |tag, _| match tag {
                "projectMemory.listProposals" => Some(Ok(proposals())),
                "projectMemory.listTidy" => Some(Ok(tidies())),
                "projectMemory.approveProposal" => Some(if fail {
                    Err("already decided".into())
                } else {
                    Ok(json!({}))
                }),
                _ => None,
            })
            .await;
            let (mut app, mut rx) =
                connected(port, two_turns(json!({"projectId":"p1"})), false).await;
            caps(&mut app);
            app.active = crate::app::Active::Draft("project-1".into());
            app.settings.memory_auto_approve = mode.into();
            opened(&mut app);
            next(&mut app, &mut rx).await;
            assert!(
                app.notice
                    .as_deref()
                    .unwrap()
                    .contains("2 tidy-ups waiting")
            );
            if expected > 0 {
                assert!(
                    app.notice
                        .as_deref()
                        .unwrap()
                        .starts_with(&format!("Auto-approved {expected} · "))
                );
                let crate::notes::Note::Text { title, body, .. } = app.notes.last().unwrap() else {
                    panic!("note")
                };
                assert_eq!(title, "Auto-approved memories");
                assert_eq!(body.len(), expected);
                assert!(body.contains(&"Fixtures follow contract changes".into()));
            }
            let approvals: Vec<_> = seen
                .lock()
                .unwrap()
                .iter()
                .filter(|(tag, _)| tag == "projectMemory.approveProposal")
                .map(|(_, payload)| payload["proposalId"].clone())
                .collect();
            assert_eq!(approvals.len(), if fail { 2 } else { expected });
            assert!(!approvals.contains(&json!("proposal-skill")));
            if mode == "analyser" {
                assert_eq!(approvals, [json!("proposal-dreamed")]);
            }
            run(&mut app, "");
            next(&mut app, &mut rx).await;
            assert_eq!(pick(&app).items.len(), 5 - expected);
        }
    }

    #[tokio::test]
    async fn memory_lists_health_even_when_there_are_no_suggestions() {
        let (port, _) = serve(|tag, _| match tag {
            "projectMemory.listProposals" => Some(Ok(json!({
                "items": [],
                "analysisHealth": {
                    "outcome": "queue-full",
                    "lastAttemptAt": "2026-10-09T08:10:00.000Z",
                    "threadsRead": 10,
                    "threadsWithSignals": 2
                }
            }))),
            "projectMemory.listTidy" => Some(Ok(json!({"items": []}))),
            _ => None,
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({"projectId":"p1"})), false).await;
        caps(&mut app);
        app.config["settings"]["projectMemoryAnalyser"] = json!(true);
        run(&mut app, "");
        next(&mut app, &mut rx).await;
        assert_eq!(
            app.notice.as_deref(),
            Some(
                "Review queue is full. Analysis continues after you review a suggestion. Last analysis 2026-10-09 08:10 UTC · 10 threads, 2 with signals"
            )
        );
    }

    #[tokio::test]
    async fn opened_reports_a_memory_suggestions_fetch_failure() {
        let (port, _) = serve(|tag, _| match tag {
            "projectMemory.listProposals" => Some(Err("Unavailable".into())),
            "projectMemory.listTidy" => Some(Ok(json!({"items": []}))),
            _ => None,
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({"projectId":"p1"})), false).await;
        caps(&mut app);
        app.notice = None;
        opened(&mut app);
        next(&mut app, &mut rx).await;
        assert!(
            app.notice
                .as_deref()
                .unwrap()
                .contains("Could not list memory suggestions")
        );
        assert!(app.notice.as_deref().unwrap().contains("Unavailable"));
    }

    #[tokio::test]
    async fn analyser_counts() {
        let (port, _) = serve(|tag, _| {
            (tag == "projectMemory.analyse").then(|| {
                Ok(serde_json::from_str(include_str!("../fixtures/memory/analyse.json")).unwrap())
            })
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({"projectId":"p1"})), false).await;
        caps(&mut app);
        run(&mut app, "analyse");
        next(&mut app, &mut rx).await;
        assert_eq!(
            app.notice.as_deref(),
            Some("Analysed 4 threads · 2 memory suggestions · 1 tidy-ups")
        );
    }
}
