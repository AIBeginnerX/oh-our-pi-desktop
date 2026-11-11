//! Starting a new thread begins with the folder it works in. Every way to a new thread (the "New
//! thread" row of the list and of `/threads`, `n` in the list, `/new`) opens this list instead of
//! starting a draft at once: the known projects, the current one first so Enter alone keeps things
//! as they were, and a last row to type the path of another folder, which the server is told to
//! add as a project (the same `project.create` the list's "add this folder" uses). It is a plain
//! `Modal::Pick`; the keys and the mouse are the picker's. Esc closes it and nothing has changed.

use crate::app::{App, Modal, Pick};
use crate::i18n::tr;
use crate::panels_common::s;
use crate::text::sanitize;
use std::path::{Path, PathBuf};

/// What `cmd::picked` knows this list by.
pub const ID: &str = "folder";

/// The last row: how another folder is asked for, with what has been typed so far.
fn other_label(typed: &str) -> String {
    if typed.is_empty() {
        s(
            "Another folder… (type its path)",
            "다른 폴더… (경로를 입력하세요)",
        )
        .to_string()
    } else {
        format!("{} {typed}", s("Another folder:", "다른 폴더:"))
    }
}

/// `path` with the home folder as `~`.
fn tidy(path: &str, home: &str) -> String {
    match path.strip_prefix(home) {
        Some(rest) if !home.is_empty() && (rest.is_empty() || rest.starts_with('/')) => {
            format!("~{rest}")
        }
        _ => path.to_string(),
    }
}

/// Opens the folder list for a new thread: `first` (else the project in use) leads it. Before the
/// projects are known there is nothing to choose from.
pub fn open(app: &mut App, first: Option<String>) {
    if !app.shell.loaded {
        app.notice = Some(tr("notice.pickFirst").into());
        return;
    }
    let current = crate::lists::current_project(app);
    let first = first.or_else(|| current.clone());
    let mut projects: Vec<_> = app.shell.projects.iter().collect();
    // A stable sort moves the leading project up and keeps the rest in the server's order.
    projects.sort_by_key(|p| first.as_deref() != Some(p.id.as_str()));
    let mut items: Vec<String> = projects
        .iter()
        .map(|p| {
            let here = if current.as_deref() == Some(p.id.as_str()) {
                format!(" · {}", s("current", "현재"))
            } else {
                String::new()
            };
            format!("{} · {}{here}", p.title, tidy(&p.workspace_root, &app.home))
        })
        .collect();
    let mut data: Vec<String> = projects.iter().map(|p| p.id.clone()).collect();
    items.push(other_label(""));
    data.push(String::new());
    app.modal = Some(Modal::Pick(Pick {
        id: ID,
        title: s("New thread — choose a folder", "새 스레드 — 폴더 선택").to_string(),
        items,
        cursor: 0,
        data,
        typed: Some(String::new()),
    }));
}

/// Keeps the last row in step with what was typed, and the pointer on it.
fn refresh(pick: &mut Pick) {
    let typed = pick.typed.clone().unwrap_or_default();
    if let Some(last) = pick.items.last_mut() {
        *last = other_label(&sanitize(&typed));
    }
    pick.cursor = pick.items.len().saturating_sub(1);
}

/// A character typed in the list goes to the path.
pub fn type_char(pick: &mut Pick, ch: char) {
    if let Some(typed) = pick.typed.as_mut() {
        typed.push(ch);
        refresh(pick);
    }
}

pub fn backspace(pick: &mut Pick) {
    if let Some(typed) = pick.typed.as_mut() {
        typed.pop();
        refresh(pick);
    }
}

/// Enter on the last row with no path typed has nothing to do yet: the list stays open.
pub fn waits_for_path(pick: &Pick, index: usize) -> bool {
    pick.id == ID
        && pick.data.get(index).is_some_and(String::is_empty)
        && pick.typed.as_deref().is_none_or(|t| t.trim().is_empty())
}

/// A row was chosen: a project starts a draft in it; the last row adds the typed folder.
pub fn picked(app: &mut App, pick: &Pick, index: usize) {
    match pick.data.get(index).filter(|id| !id.is_empty()) {
        Some(id) => app.start_draft(id),
        None => add_path(app, pick.typed.as_deref().unwrap_or_default()),
    }
}

/// The folder a typed path means: `~` is home, a relative path starts from the working folder.
fn resolve(typed: &str, home: &str, cwd: &str) -> PathBuf {
    let typed = typed.trim();
    let path = match typed.strip_prefix('~') {
        Some("") => PathBuf::from(home),
        Some(rest) if rest.starts_with('/') => Path::new(home).join(rest.trim_start_matches('/')),
        _ => PathBuf::from(typed),
    };
    if path.is_absolute() {
        path
    } else {
        Path::new(cwd).join(path)
    }
}

fn add_path(app: &mut App, typed: &str) {
    // On another computer the folder is checked on this one, so a path of theirs would be
    // refused and one of ours would be believed: the project list is the way there.
    if app.remote.is_some() {
        app.notice = Some(
            s(
                "On another computer, choose one of its projects. Folders of this computer cannot be added from here.",
                "다른 컴퓨터에서는 그 컴퓨터의 프로젝트를 고르세요. 이 컴퓨터의 폴더는 여기서 추가할 수 없습니다.",
            )
            .to_string(),
        );
        return;
    }
    let path = resolve(typed, &app.home, &app.cwd);
    if !path.is_dir() {
        app.notice = Some(format!(
            "{} {}",
            s("Not a folder:", "폴더가 아닙니다:"),
            sanitize(&path.to_string_lossy())
        ));
        return;
    }
    let path = path.to_string_lossy().into_owned();
    match app.project_in(&path) {
        Some(id) => app.start_draft(&id),
        None => app.add_project(&path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_read_from_home_and_the_working_folder() {
        assert_eq!(resolve("~", "/h", "/w"), PathBuf::from("/h"));
        assert_eq!(resolve(" ~/code ", "/h", "/w"), PathBuf::from("/h/code"));
        assert_eq!(resolve("/a/b", "/h", "/w"), PathBuf::from("/a/b"));
        assert_eq!(resolve("x/y", "/h", "/w"), PathBuf::from("/w/x/y"));
    }

    #[test]
    fn home_is_shown_as_a_tilde_only_on_a_folder_boundary() {
        assert_eq!(tidy("/h/code", "/h"), "~/code");
        assert_eq!(tidy("/h", "/h"), "~");
        assert_eq!(tidy("/hx/code", "/h"), "/hx/code");
        assert_eq!(tidy("/a", ""), "/a");
    }
}
