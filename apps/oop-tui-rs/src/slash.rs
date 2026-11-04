//! The slash commands the composer offers while a message starts with `/`: their names and one-line
//! descriptions, and how a typed word narrows the list. Running them is `app.rs` / `cmd.rs`; the
//! list only names what they accept. A command added there is added here, one row.

use crate::panels_common::s;

pub struct Command {
    pub name: &'static str,
    /// Other names `run_slash` accepts for it; typing one still finds the command.
    pub aliases: &'static [&'static str],
    /// What may follow the name, as the list shows it (`[on|off]`).
    pub arg: Option<&'static str>,
    /// The command is no use without it: Enter completes the name instead of running it.
    pub required: bool,
    pub(crate) en: &'static str,
    pub(crate) ko: &'static str,
}

impl Command {
    pub fn description(&self) -> &'static str {
        s(self.en, self.ko)
    }

    /// The text that completes it in the composer: `/name`, and a space when an argument follows.
    pub fn completion(&self) -> String {
        format!(
            "/{}{}",
            self.name,
            if self.arg.is_some() { " " } else { "" }
        )
    }

    /// `/name [arg]` as one row of the list shows it.
    pub fn usage(&self) -> String {
        match self.arg {
            Some(arg) => format!("/{} {arg}", self.name),
            None => format!("/{}", self.name),
        }
    }
}

const fn cmd(
    name: &'static str,
    aliases: &'static [&'static str],
    arg: Option<&'static str>,
    en: &'static str,
    ko: &'static str,
) -> Command {
    Command {
        name,
        aliases,
        arg,
        required: false,
        en,
        ko,
    }
}

/// In the order of `/help`.
pub const COMMANDS: &[Command] = &[
    cmd(
        "model",
        &["models"],
        Some("[name]"),
        "Choose the model",
        "모델 선택",
    ),
    cmd(
        "mode",
        &[],
        Some("[mode]"),
        "Set how much the agent may do without asking",
        "묻지 않고 실행할 범위 설정",
    ),
    cmd(
        "effort",
        &[],
        Some("[level]"),
        "Set the reasoning effort",
        "추론 강도 설정",
    ),
    cmd(
        "plan",
        &[],
        None,
        "Plan first, without changing files",
        "파일을 바꾸지 않고 계획부터",
    ),
    cmd(
        "default",
        &[],
        None,
        "Back to the normal mode",
        "일반 모드로 돌아가기",
    ),
    cmd(
        "implement",
        &[],
        None,
        "Build the proposed plan",
        "제안된 계획 구현",
    ),
    cmd(
        "goal",
        &[],
        Some("[text|clear|max n]"),
        "Set or view the thread goal",
        "스레드 목표 설정·확인",
    ),
    cmd(
        "crew",
        &[],
        Some("[on|off|back]"),
        "Choose who does what",
        "역할별 에이전트 구성",
    ),
    cmd(
        "provider",
        &[],
        Some("[list|add|remove]"),
        "Manage providers",
        "프로바이더 관리",
    ),
    cmd(
        "dag-workflow",
        &["workflow"],
        Some("[on|off|n]"),
        "Show the workflow in the side panel",
        "오른쪽 패널에 워크플로 표시",
    ),
    cmd(
        "dag-agents",
        &["agents"],
        Some("[on|off]"),
        "Show the agents in the side panel",
        "오른쪽 패널에 에이전트 표시",
    ),
    cmd(
        "savvy",
        &[],
        Some("[on|off]"),
        "Show live progress in the side panel",
        "오른쪽 패널에 실시간 진행 표시",
    ),
    cmd(
        "files",
        &[],
        Some("[on|off]"),
        "Show the files touched in the side panel",
        "오른쪽 패널에 작업 파일 표시",
    ),
    cmd(
        "replay",
        &[],
        None,
        "Step through the last finished turn",
        "마지막으로 끝난 작업을 단계별로 보기",
    ),
    cmd("new", &[], None, "Start a new thread", "새 스레드 시작"),
    cmd("threads", &["t"], None, "Pick a thread", "스레드 고르기"),
    cmd(
        "projects",
        &["p"],
        None,
        "Pick a project",
        "프로젝트 고르기",
    ),
    cmd("stats", &[], None, "Usage statistics", "사용 통계"),
    cmd(
        "tasks",
        &[],
        Some("[on|off]"),
        "Show or hide the task list",
        "작업 목록 표시/숨김",
    ),
    cmd(
        "sidebar",
        &[],
        Some("[on|off]"),
        "Show or hide the thread list (Ctrl-B)",
        "스레드 목록 표시/숨김 (Ctrl-B)",
    ),
    cmd(
        "panel",
        &[],
        Some("[on|off]"),
        "Show or hide the right panel (Ctrl-G)",
        "오른쪽 패널 표시/숨김 (Ctrl-G)",
    ),
    cmd(
        "mouse",
        &[],
        Some("[on|off]"),
        "Mouse wheel and drag on or off",
        "마우스 휠·드래그 켜기/끄기",
    ),
    cmd(
        "pet",
        &[],
        Some("[on|off]"),
        "Show or hide the pet",
        "마스코트 표시/숨김",
    ),
    cmd(
        "history",
        &[],
        Some("[count]"),
        "Recent turns of this thread",
        "이 스레드의 최근 턴",
    ),
    cmd(
        "diff",
        &[],
        Some("[turn] [file]"),
        "File changes of a turn",
        "턴의 파일 변경",
    ),
    cmd(
        "undo",
        &[],
        None,
        "Rewind to before the last turn",
        "마지막 턴 이전으로 되돌리기",
    ),
    cmd(
        "theme",
        &[],
        Some("[name]"),
        "Pick a colour theme",
        "색상 테마 고르기",
    ),
    cmd(
        "update",
        &[],
        None,
        "Check for a new version",
        "새 버전 확인",
    ),
    cmd("help", &[], None, "List the commands", "명령 목록"),
    cmd("exit", &["quit"], None, "Leave oop", "oop 종료"),
];

/// The commands a typed word (without its `/`) leads to, best first: the word is a command's name
/// or alias; the start of a name; the start of an alias; somewhere in a name. Within a kind the
/// table's order stands. Nothing typed lists them all.
pub fn matches<'a>(table: &'a [Command], word: &str) -> Vec<&'a Command> {
    let word = word.to_lowercase();
    let rank = |c: &Command| -> Option<u8> {
        if word.is_empty() {
            return Some(0);
        }
        if c.name == word || c.aliases.contains(&word.as_str()) {
            Some(0)
        } else if c.name.starts_with(&word) {
            Some(1)
        } else if c.aliases.iter().any(|a| a.starts_with(&word)) {
            Some(2)
        } else if c.name.contains(&word) {
            Some(3)
        } else {
            None
        }
    };
    let mut found: Vec<(u8, &Command)> = table
        .iter()
        .filter_map(|c| rank(c).map(|r| (r, c)))
        .collect();
    found.sort_by_key(|(r, _)| *r);
    found.into_iter().map(|(_, c)| c).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(word: &str) -> Vec<&'static str> {
        matches(COMMANDS, word).iter().map(|c| c.name).collect()
    }

    #[test]
    fn nothing_typed_lists_every_command_in_order() {
        assert_eq!(names("").len(), COMMANDS.len());
        assert_eq!(names("")[0], "model");
    }

    #[test]
    fn a_word_narrows_by_name_start_alias_and_inner_text() {
        assert_eq!(names("mo"), ["model", "mode", "mouse"]);
        assert_eq!(
            names("MODE"),
            ["mode", "model"],
            "an exact name leads, case ignored"
        );
        assert_eq!(names("t")[0], "threads", "an exact alias leads");
        assert!(names("t").contains(&"tasks") && names("t").contains(&"theme"));
        assert_eq!(names("quit"), ["exit"]);
        assert!(names("work").contains(&"dag-workflow"), "inside a name");
        assert!(names("zzz").is_empty());
    }

    #[test]
    fn every_command_the_app_runs_is_in_the_list() {
        let source = format!("{}{}", include_str!("app.rs"), include_str!("cmd.rs"));
        for c in COMMANDS {
            assert!(
                source.contains(&format!("\"{}\"", c.name)),
                "/{} is not run by app.rs or cmd.rs",
                c.name
            );
            for alias in c.aliases {
                assert!(source.contains(&format!("\"{alias}\"")), "alias {alias}");
            }
        }
    }

    #[test]
    fn the_panel_and_replay_commands_are_listed() {
        for name in ["savvy", "files", "replay"] {
            assert!(COMMANDS.iter().any(|c| c.name == name), "/{name}");
        }
    }

    #[test]
    fn completion_adds_a_space_only_where_an_argument_follows() {
        let by = |n: &str| COMMANDS.iter().find(|c| c.name == n).unwrap();
        assert_eq!(by("mode").completion(), "/mode ");
        assert_eq!(by("exit").completion(), "/exit");
        assert_eq!(by("tasks").usage(), "/tasks [on|off]");
        assert_eq!(by("new").usage(), "/new");
    }

    #[test]
    fn the_korean_descriptions_differ_from_the_english_ones() {
        for c in COMMANDS {
            assert_ne!(c.en, c.ko, "{}", c.name);
            assert!(
                c.ko.chars()
                    .any(|ch| ('\u{ac00}'..='\u{d7a3}').contains(&ch))
            );
        }
    }
}
