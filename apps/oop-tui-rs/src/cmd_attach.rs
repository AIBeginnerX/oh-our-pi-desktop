//! Local files owned by each conversation draft; signed HTTP uploads precede a turn.
use crate::app::{Active, App, Modal, Msg, Pick};
use crate::panels_common::s;
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf};

#[derive(Clone)]
pub struct File {
    path: PathBuf,
    metadata: Value,
}
#[derive(Default)]
pub struct State {
    pending: HashMap<String, Vec<File>>,
    busy: bool,
    pub ready: Vec<Value>,
}
fn key(app: &App) -> String {
    match &app.active {
        Active::Thread(id) => format!("thread:{id}"),
        Active::Draft(id) => format!("draft:{id}"),
        Active::None => String::new(),
    }
}
pub fn line(app: &App) -> Option<String> {
    let files = app.attachments.pending.get(&key(app))?;
    (!files.is_empty()).then(|| {
        format!(
            "📎 {} · {}",
            files.len(),
            files
                .iter()
                .map(|f| f.metadata["name"].as_str().unwrap_or("file"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    })
}
/// Where `/attach` looks on this computer: `~/…` is the home folder, an absolute path is itself,
/// and a relative one starts at the project folder when that is here, else at the folder `oop`
/// runs in (a remote project's folder is on the other computer).
fn resolve(app: &App, argument: &str) -> PathBuf {
    if let Some(rest) = argument
        .strip_prefix("~/")
        .or_else(|| argument.strip_prefix("~\\"))
    {
        return crate::server::user_home().join(rest);
    }
    let path = PathBuf::from(argument);
    if path.is_absolute() {
        return path;
    }
    let project = PathBuf::from(app.workdir());
    let base = if project.is_dir() {
        project
    } else {
        std::env::current_dir().unwrap_or_default()
    };
    base.join(path)
}
fn validate(app: &App, argument: &str) -> Result<File, String> {
    let path = resolve(app, argument)
        .canonicalize()
        .map_err(|_| s("Attachment does not exist.", "첨부 파일이 없습니다."))?;
    let meta = path.metadata().map_err(|_| "Cannot read attachment.")?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .trim();
    let mime = match path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "txt" | "log" | "md" => "text/plain",
        _ => "application/octet-stream",
    };
    let image = mime.starts_with("image/");
    if !meta.is_file()
        || meta.len() == 0
        || meta.len() > (if image { 10 } else { 50 }) * 1024 * 1024
        || name.is_empty()
        || name.chars().count() > 255
    {
        return Err(s("Invalid attachment: use a nonempty file, at most 10 MiB for images or 50 MiB for files (name up to 255 characters).", "빈 파일은 첨부할 수 없습니다. 이미지 10 MiB·파일 50 MiB·이름 255자 이내여야 합니다.").into());
    }
    let metadata = json!({"type": if image {"image"} else {"file"}, "name": name, "mimeType": mime, "sizeBytes": meta.len()});
    Ok(File { path, metadata })
}
pub fn run(app: &mut App, argument: &str) {
    if app.attachments.busy {
        app.notice = Some(s("Attachment upload in progress.", "첨부 업로드 중입니다.").into());
        return;
    }
    let k = key(app);
    if k.is_empty() {
        app.notice = Some(s("Pick a project first.", "프로젝트를 먼저 선택하세요.").into());
        return;
    }
    if argument.is_empty() {
        if line(app).is_none() {
            app.notice = Some(
                s(
                    "No attachments. Usage: /attach <path>",
                    "첨부 파일이 없습니다. 사용법: /attach <경로>",
                )
                .into(),
            );
            return;
        }
        let files = app.attachments.pending.entry(k).or_default();
        let mut items: Vec<String> = files
            .iter()
            .map(|f| {
                format!(
                    "{} {}",
                    s("Remove", "제거"),
                    f.metadata["name"].as_str().unwrap_or("file")
                )
            })
            .collect();
        items.push(s("Clear all attachments", "첨부 모두 제거").into());
        app.modal = Some(Modal::Pick(Pick {
            id: "attach",
            title: s("Attachments", "첨부 파일").into(),
            cursor: 0,
            items,
            data: vec![],
            typed: None,
        }));
        return;
    }
    match validate(app, argument) {
        Err(e) => app.notice = Some(e),
        Ok(file) => {
            let files = app.attachments.pending.entry(k).or_default();
            let images: u64 = files
                .iter()
                .filter(|f| f.metadata["type"] == "image")
                .map(|f| f.metadata["sizeBytes"].as_u64().unwrap_or(0))
                .sum();
            if files.len() >= 100
                || images
                    + if file.metadata["type"] == "image" {
                        file.metadata["sizeBytes"].as_u64().unwrap_or(0)
                    } else {
                        0
                    }
                    > 80 * 1024 * 1024
            {
                app.notice = Some(
                    s(
                        "Limit: 100 attachments and 80 MiB of images.",
                        "최대 100개·이미지 합계 80 MiB입니다.",
                    )
                    .into(),
                );
            } else {
                files.push(file);
                app.notice = line(app);
            }
        }
    }
}
pub fn picked(app: &mut App, _: &Pick, index: usize) {
    if app.attachments.busy {
        return;
    }
    if let Some(files) = app.attachments.pending.get_mut(&key(app)) {
        if index < files.len() {
            files.remove(index);
        } else {
            files.clear();
        }
    }
}
pub fn before_send(app: &mut App, text: &str) -> bool {
    if !app.attachments.ready.is_empty() {
        return false;
    }
    if app.attachments.busy {
        return true;
    }
    let k = key(app);
    let Some(files) = app
        .attachments
        .pending
        .get(&k)
        .filter(|f| !f.is_empty())
        .cloned()
    else {
        return false;
    };
    let (Some(rpc), Some(origin), Some(bearer)) =
        (app.rpc.clone(), app.origin.clone(), app.bearer.clone())
    else {
        app.notice = Some(
            s(
                "Attachments need a connected HTTP server.",
                "첨부하려면 HTTP 서버에 연결해야 합니다.",
            )
            .into(),
        );
        return true;
    };
    let prefix = app
        .remote
        .as_ref()
        .map(|r| crate::gateway::environment_prefix(&r.environment_id))
        .unwrap_or_default();
    app.attachments.busy = true;
    app.notice = Some(s("Uploading attachments…", "첨부 업로드 중…").into());
    let tx = app.sender();
    let text = text.to_string();
    tokio::spawn(async move {
        let result = upload(&rpc, &origin, &bearer, &prefix, files).await;
        let _ = tx.send(Msg::Ext(Box::new(move |app| {
            app.attachments.busy = false;
            match result {
                Ok(ready)
                    if key(app) == k
                        && app.origin.as_deref() == Some(origin.as_str())
                        && app.bearer.as_deref() == Some(bearer.as_str())
                        && app
                            .remote
                            .as_ref()
                            .map(|r| crate::gateway::environment_prefix(&r.environment_id))
                            .unwrap_or_default()
                            == prefix =>
                {
                    app.attachments.ready = ready;
                    if app.send(&text) {
                        app.attachments.pending.remove(&k);
                        if app.input.text().trim() == text {
                            app.input.take(true);
                        }
                    }
                    app.attachments.ready.clear();
                }
                Ok(_) => {
                    app.notice = Some(
                        s(
                            "Draft changed; return to the original draft and send again.",
                            "초안이 바뀌었습니다. 원래 초안으로 돌아가 다시 전송하세요.",
                        )
                        .into(),
                    )
                }
                Err(reason) => {
                    app.notice = Some(format!(
                        "{} {reason}",
                        s(
                            "Attachment upload failed; draft and files kept:",
                            "첨부 업로드 실패·초안과 파일 유지:"
                        )
                    ))
                }
            }
        })));
    });
    true
}
async fn upload(
    rpc: &crate::wire::Rpc,
    origin: &str,
    bearer: &str,
    prefix: &str,
    files: Vec<File>,
) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for file in files {
        let bytes = std::fs::read(&file.path).map_err(|_| "Cannot read attachment")?;
        if bytes.len() as u64 != file.metadata["sizeBytes"].as_u64().unwrap_or(0) {
            return Err("Attachment changed".into());
        }
        let answer = rpc
            .call("attachments.createUploadUrl", file.metadata.clone())
            .await
            .map_err(|_| "Could not create attachment upload URL")?;
        let path = answer["relativeUrl"].as_str().ok_or("Missing upload URL")?;
        if !path.starts_with("/api/attachments/upload/") || path.contains(['\r', '\n']) {
            return Err("Unsupported upload URL".into());
        }
        let id = answer["attachmentId"]
            .as_str()
            .ok_or("Missing attachment id")?;
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("Invalid attachment id".into());
        }
        let response = crate::http::request(
            "POST",
            origin,
            &format!("{prefix}{path}"),
            &[("Authorization", format!("Bearer {bearer}"))],
            Some((file.metadata["mimeType"].as_str().unwrap(), bytes)),
            std::time::Duration::from_secs(120),
        )
        .await
        .map_err(
            |_| "HTTP upload unavailable; check local/SSH forward or relay/gateway connection",
        )?;
        if !(200..300).contains(&response.status) {
            return Err(format!("Upload rejected ({})", response.status));
        }
        let mut metadata = file.metadata;
        metadata["id"] = json!(id);
        out.push(metadata);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd_history::testkit::{connected, serve};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn attach_validate_list_remove_clear_and_isolate() {
        let (port, _) = serve(|_, _| None).await;
        let (mut app, _) = connected(port, json!({"id":"t1","messages":[]}), false).await;
        let root = std::env::temp_dir().join(crate::text::new_id());
        std::fs::create_dir_all(&root).unwrap();
        app.cwd = root.to_string_lossy().into();
        app.conv.thread.worktree_path = Some(app.cwd.clone());
        run(&mut app, "missing.txt");
        assert!(app.notice.is_some());
        assert!(line(&app).is_none());
        std::fs::write(root.join("log.txt"), "abc").unwrap();
        run(&mut app, "log.txt");
        assert!(
            line(&app).is_some(),
            "{:?} workdir={}",
            app.notice,
            app.workdir()
        );
        assert!(line(&app).unwrap().contains("log.txt"));
        app.active = Active::Thread("other".into());
        assert!(line(&app).is_none());
        app.active = Active::Thread("t1".into());
        run(&mut app, "");
        let Some(Modal::Pick(pick)) = app.modal.take() else {
            panic!("picker")
        };
        picked(&mut app, &pick, 0);
        assert!(line(&app).is_none());
        run(&mut app, "log.txt");
        run(&mut app, "log.txt");
        picked(&mut app, &pick, 2);
        assert!(line(&app).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn attach_takes_a_file_outside_the_project_and_a_remote_project() {
        let (port, _) = serve(|_, _| None).await;
        let (mut app, _) = connected(port, json!({"id":"t1","messages":[]}), false).await;
        // A remote project: its folder does not exist on this computer.
        app.cwd = "/nonexistent/remote/project".into();
        app.conv.thread.worktree_path = Some(app.cwd.clone());
        run(&mut app, "");
        assert!(app.modal.is_none(), "nothing to remove, so no picker");
        assert!(app.notice.as_deref().is_some_and(|n| n.contains("/attach")));
        let elsewhere = std::env::temp_dir().join(crate::text::new_id());
        std::fs::create_dir_all(&elsewhere).unwrap();
        let shot = elsewhere.join("shot.png");
        std::fs::write(&shot, "png").unwrap();
        run(&mut app, &shot.to_string_lossy());
        assert!(
            line(&app).is_some_and(|l| l.contains("shot.png")),
            "{:?}",
            app.notice
        );
        std::fs::remove_dir_all(elsewhere).unwrap();
    }

    async fn transfer(success: bool) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let http = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut seen = Vec::new();
            let mut buf = [0; 4096];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0);
                seen.extend_from_slice(&buf[..n]);
                if let Some(i) = seen.windows(4).position(|x| x == b"\r\n\r\n")
                    && seen.len() >= i + 7
                {
                    break;
                }
            }
            assert!(seen.starts_with(b"POST /api/attachments/upload/signed HTTP/1.1"));
            assert!(seen.ends_with(b"abc"));
            let response = if success {
                b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".as_slice()
            } else {
                b"HTTP/1.1 500 Error\r\nContent-Length: 0\r\n\r\n".as_slice()
            };
            socket.write_all(response).await.unwrap();
        });
        let (port, seen) = serve(|tag, _| match tag {
            "attachments.createUploadUrl" => Some(Ok(json!({"attachmentId":"upload-1","relativeUrl":"/api/attachments/upload/signed","expiresAt":1767226200000u64}))),
            "orchestration.dispatchCommand" => Some(Ok(json!({}))),
            _ => None,
        }).await;
        let (mut app, mut rx) = connected(port, json!({"id":"t1","messages":[]}), false).await;
        let root = std::env::temp_dir().join(crate::text::new_id());
        std::fs::create_dir_all(&root).unwrap();
        app.cwd = root.to_string_lossy().into();
        app.conv.thread.worktree_path = Some(app.cwd.clone());
        app.origin = Some(origin);
        std::fs::write(root.join("log.txt"), "abc").unwrap();
        run(&mut app, "log.txt");
        for ch in "hello".chars() {
            app.input.insert(ch);
        }
        assert!(!app.send("hello"));
        while app.attachments.busy {
            app.handle(rx.recv().await.unwrap());
        }
        http.await.unwrap();
        if success {
            assert!(line(&app).is_none());
            assert!(app.input.text().is_empty());
            // Drain the dispatch receipt, proving the server received the command.
            loop {
                if seen
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(tag, _)| tag == "orchestration.dispatchCommand")
                {
                    break;
                }
                app.handle(rx.recv().await.unwrap());
            }
            let records = seen.lock().unwrap();
            let (_, payload) = records
                .iter()
                .find(|(tag, _)| tag == "orchestration.dispatchCommand")
                .unwrap();
            assert_eq!(payload["message"]["attachments"][0]["id"], "upload-1");
        } else {
            assert_eq!(app.input.text(), "hello");
            assert!(line(&app).is_some());
            assert!(
                !seen
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(tag, _)| tag == "orchestration.dispatchCommand")
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn attach_send_uploads_and_clears() {
        transfer(true).await;
    }
    #[tokio::test]
    async fn attach_failure_keeps_draft_and_sends_nothing() {
        transfer(false).await;
    }
}
