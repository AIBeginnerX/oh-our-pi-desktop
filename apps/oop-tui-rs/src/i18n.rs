//! The slice's few UI strings in English and Korean. The language is picked the way the
//! TypeScript app does it: the first set one of LC_ALL, LC_MESSAGES, LANG decides, `ko...` is
//! Korean. The full app has ~2,400 lines of such tables (apps/oop-tui/src/i18n).

use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    En,
    Ko,
}

static LANG: OnceLock<Lang> = OnceLock::new();

pub fn detect(env: impl Fn(&str) -> Option<String>) -> Lang {
    for name in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Some(value) = env(name)
            .map(|v| v.trim().to_lowercase())
            .filter(|v| !v.is_empty())
        {
            return if value.starts_with("ko") {
                Lang::Ko
            } else {
                Lang::En
            };
        }
    }
    Lang::En
}

pub fn lang() -> Lang {
    *LANG.get_or_init(|| detect(|name| std::env::var(name).ok()))
}

/// Fixes the language from `settings.json` (`en` or `ko`) before the first string is read; with
/// none set the locale decides. A no-op once a string was read.
pub fn init(setting: Option<&str>) {
    let chosen = match setting {
        Some("ko") => Some(Lang::Ko),
        Some("en") => Some(Lang::En),
        _ => None,
    };
    if let Some(lang) = chosen {
        let _ = LANG.set(lang);
    }
}

pub fn tr(key: &str) -> &'static str {
    lookup(key, lang() == Lang::Ko)
}

fn lookup(key: &str, ko: bool) -> &'static str {
    let pick = |en: &'static str, kr: &'static str| if ko { kr } else { en };
    match key {
        "state.idle" => pick("Ready", "대기 중"),
        "state.working" => pick("Working", "작업 중"),
        "state.waiting" => pick("Waiting for you", "응답 대기"),
        "state.error" => pick("Error", "오류"),
        "state.offline" => pick("Offline", "연결 끊김"),
        "state.connecting" => pick("Connecting", "연결 중"),
        "header.thread" => pick("Thread  ", "스레드  "),
        "header.folder" => pick("Folder  ", "폴더  "),
        "header.server" => pick("Server  ", "서버  "),
        "header.noThread" => pick("no thread open", "열린 스레드 없음"),
        "header.noModel" => pick("no model", "모델 없음"),
        "header.mode" => pick("Mode  ", "모드  "),
        "list.projects" => pick("Threads", "스레드"),
        "list.new" => pick("+ New thread", "+ 새 스레드"),
        "list.addFolder" => pick("+ Add this folder", "+ 이 폴더 추가"),
        "list.loading" => pick("loading…", "불러오는 중…"),
        "list.pinned" => pick("Pinned", "고정됨"),
        "list.active" => pick("Threads", "스레드"),
        "list.snoozed" => pick("Snoozed", "스누즈"),
        "list.settled" => pick("Settled", "정리됨"),
        "list.more" => pick("more", "개 더 보기"),
        "list.crew" => pick("crew", "크루"),
        "list.empty" => pick("no threads yet", "스레드 없음"),
        "composer.title" => pick(" Message ", " 메시지 "),
        "composer.queued" => pick("queued", "대기열"),
        "conv.pick" => pick(
            "Pick a thread on the left (Tab, then Enter), or add this folder as a project.",
            "왼쪽에서 스레드를 고르거나(Tab 후 Enter) 이 폴더를 프로젝트로 추가하세요.",
        ),
        "conv.draft" => pick(
            "New thread. Type a message and press Enter to start it.",
            "새 스레드입니다. 메시지를 입력하고 Enter를 누르면 시작합니다.",
        ),
        "conv.loading" => pick("Opening thread…", "스레드를 여는 중…"),
        "conv.working" => pick("working", "작업 중"),
        "conv.older" => pick("loading older turns…", "이전 대화를 불러오는 중…"),
        "conv.hasOlder" => pick("↑ older turns: scroll up", "↑ 이전 대화: 위로 스크롤"),
        "conv.jump" => pick("↓ newer: PgDn to follow", "↓ 최신 대화: PgDn"),
        "transcript.plan" => pick("Plan", "계획"),
        "transcript.compaction" => pick("Context compacted", "컨텍스트 압축됨"),
        "hint.composer" => pick(
            "Enter send · Ctrl-J newline · Tab list · PgUp/PgDn scroll · /model /mode /effort · Ctrl-C quit",
            "Enter 전송 · Ctrl-J 줄바꿈 · Tab 목록 · PgUp/PgDn 스크롤 · /model /mode /effort · Ctrl-C 종료",
        ),
        "hint.working" => pick(
            "Esc stop the turn · Enter queue the message · PgUp/PgDn scroll · Ctrl-C quit",
            "Esc 작업 중단 · Enter 메시지 대기열 · PgUp/PgDn 스크롤 · Ctrl-C 종료",
        ),
        "hint.list" => pick(
            "↑/↓ move · Enter open · n new thread · Tab message · q quit",
            "↑/↓ 이동 · Enter 열기 · n 새 스레드 · Tab 메시지 · q 종료",
        ),
        "hint.approval" => pick(
            "↑/↓ choose · Enter confirm · 1-4 quick pick",
            "↑/↓ 선택 · Enter 확인 · 1-4 바로 선택",
        ),
        "hint.question" => pick(
            "↑/↓ choose · Space toggle · Enter confirm · type to answer in your own words",
            "↑/↓ 선택 · Space 토글 · Enter 확인 · 직접 입력도 가능",
        ),
        "hint.picker" => pick(
            "↑/↓ move · Enter pick · Esc cancel",
            "↑/↓ 이동 · Enter 선택 · Esc 취소",
        ),
        "hint.modelPicker" => pick(
            "type to filter · ↑/↓ move · Enter pick · Esc cancel",
            "입력해서 검색 · ↑/↓ 이동 · Enter 선택 · Esc 취소",
        ),
        "panel.approval" => pick("Approval needed", "승인이 필요합니다"),
        "panel.question" => pick("The agent asks", "에이전트의 질문"),
        "panel.other" => pick("your own answer: ", "직접 입력: "),
        "panel.more" => pick("more waiting", "개 더 대기 중"),
        "approval.accept" => pick("Allow once", "이번만 허용"),
        "approval.acceptForSession" => pick("Allow for this session", "이 세션에서 허용"),
        "approval.acceptAlways" => pick("Always allow", "항상 허용"),
        "approval.decline" => pick("Decline", "거절"),
        "approval.cancel" => pick("Cancel the turn", "작업 취소"),
        "picker.model" => pick("Choose a model", "모델 선택"),
        "picker.mode" => pick("Permission mode", "권한 모드"),
        "picker.effort" => pick("Reasoning effort", "추론 강도"),
        "picker.none" => pick("nothing matches", "일치하는 항목 없음"),
        "mode.approval-required" => pick("Approval required", "승인 필요"),
        "mode.auto-accept-edits" => pick("Auto-accept edits", "편집 자동 승인"),
        "mode.auto" => pick("Auto", "자동"),
        "mode.full-access" => pick("Full access", "전체 권한"),
        "notice.noProvider" => pick(
            "No provider is ready on this server. Connect one in the desktop app, then try again.",
            "이 서버에 사용할 수 있는 프로바이더가 없습니다. 데스크톱 앱에서 연결한 뒤 다시 시도하세요.",
        ),
        "notice.offline" => pick(
            "Not connected to the server.",
            "서버에 연결되어 있지 않습니다.",
        ),
        "notice.pickFirst" => pick(
            "Pick a project or thread first.",
            "먼저 프로젝트나 스레드를 고르세요.",
        ),
        "notice.unknownCommand" => pick(
            "Unknown command. Try /help.",
            "알 수 없는 명령입니다. /help를 보세요.",
        ),
        "notice.adding" => pick("Adding this folder…", "이 폴더를 추가하는 중…"),
        "notice.deleted" => pick("this thread was deleted", "이 스레드가 삭제되었습니다"),
        "notice.stopping" => pick("Stopping the turn…", "작업을 중단하는 중…"),
        "notice.nothingRunning" => pick("Nothing is running.", "실행 중인 작업이 없습니다."),
        "notice.needThread" => pick(
            "Open or start a thread first.",
            "먼저 스레드를 열거나 시작하세요.",
        ),
        "notice.model" => pick("Model", "모델"),
        "notice.mode" => pick("Mode", "모드"),
        "notice.effort" => pick("Effort", "추론 강도"),
        "notice.noEffort" => pick(
            "This model has no effort setting.",
            "이 모델에는 추론 강도 설정이 없습니다.",
        ),
        "notice.modeWords" => pick(
            "Modes: approval, edits, auto, full.",
            "모드: approval, edits, auto, full.",
        ),
        "notice.effortWords" => pick("Efforts", "추론 강도 값"),
        "notice.queued" => pick(
            "Queued; it is sent when the turn ends.",
            "대기열에 넣었습니다. 작업이 끝나면 전송됩니다.",
        ),
        "notice.planOn" => pick(
            "Plan mode: the agent plans before it acts.",
            "계획 모드: 에이전트가 실행 전에 계획합니다.",
        ),
        "notice.planOff" => pick("Back to the default mode.", "기본 모드로 돌아갑니다."),
        "notice.olderFailed" => pick(
            "Could not load older turns",
            "이전 대화를 불러오지 못했습니다",
        ),
        "notice.theme" => pick("Theme", "테마"),
        "header.crew" => pick("Crew ", "크루 "),
        "notice.mouseUsage" => pick("Usage: /mouse [on|off]", "사용법: /mouse [on|off]"),
        "notice.mouseOn" => pick(
            "Mouse wheel scrolling and drag-to-copy are on.",
            "마우스 휠 스크롤과 드래그 복사를 켰습니다.",
        ),
        "notice.mouseOff" => pick(
            "Mouse wheel scrolling and drag-to-copy are off. The terminal selects text again.",
            "마우스 휠 스크롤과 드래그 복사를 껐습니다. 터미널이 다시 글자를 직접 선택합니다.",
        ),
        "copy.done" => pick("Copied {count} characters.", "{count}자를 복사했습니다."),
        "copy.terminal" => pick(
            "Copied {count} characters through the terminal clipboard (OSC 52).",
            "{count}자를 터미널 클립보드(OSC 52)로 복사했습니다.",
        ),
        "copy.toolFailed" => pick(
            "Sent {count} characters to the terminal clipboard (OSC 52), but the clipboard tool ({tool}) did not take them ({why}); a terminal that ignores OSC 52 has not got them.",
            "{count}자를 터미널 클립보드(OSC 52)로 보냈지만 클립보드 도구({tool})가 받지 못했습니다 ({why}). OSC 52 를 무시하는 터미널에는 복사되지 않았을 수 있습니다.",
        ),
        "copy.failed" => pick("Could not copy: {why}.", "복사하지 못했습니다: {why}."),
        "copy.missing" => pick("not found", "찾을 수 없음"),
        "copy.fail" => pick("failed", "실패"),
        "copy.timeout" => pick("no answer", "응답 없음"),
        "copy.tooLarge" => pick(
            "the selection is too large for the terminal clipboard",
            "선택한 글이 터미널 클립보드로 보내기에 너무 큽니다",
        ),
        "copy.noWay" => pick(
            "this terminal has no way to take it",
            "이 터미널로는 보낼 방법이 없습니다",
        ),
        "notice.petUsage" => pick("Usage: /pet [on|off]", "사용법: /pet [on|off]"),
        "notice.petOn" => pick("Mocha is on.", "모카를 켰습니다."),
        "notice.petOff" => pick("Mocha is off.", "모카를 껐습니다."),
        "notice.sidebarUsage" => pick("Usage: /sidebar [on|off]", "사용법: /sidebar [on|off]"),
        "notice.panelUsage" => pick(
            "Usage: /dag-workflow [on|off], /agents [on|off]",
            "사용법: /dag-workflow [on|off], /agents [on|off]",
        ),
        "notice.panelOn" => pick("The side panel is open.", "오른쪽 패널을 열었습니다."),
        "notice.panelOff" => pick("The side panel is closed.", "오른쪽 패널을 닫았습니다."),
        "notice.newThread" => pick(
            "New thread. Type a message to start it.",
            "새 스레드입니다. 메시지를 입력하면 시작합니다.",
        ),
        "notice.help" => pick(
            "/model /mode /effort /plan /default /implement /goal /crew /provider /dag-workflow /dag-agents /new /threads /projects /stats /tasks /sidebar /mouse /pet /history /diff /undo /theme /update /help /exit",
            "/model /mode /effort /plan /default /implement /goal /crew /provider /dag-workflow /dag-agents /new /threads /projects /stats /tasks /sidebar /mouse /pet /history /diff /undo /theme /update /help /exit",
        ),
        "notice.unsupported" => pick(
            "Not in oop-rs yet: use the TypeScript terminal for it.",
            "oop-rs에는 아직 없습니다. 이 명령은 TypeScript 터미널에서 쓰세요.",
        ),
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_string_has_both_languages_and_the_korean_one_is_korean() {
        let source = include_str!("i18n.rs");
        let body = &source[source.find("fn lookup").unwrap()..source.find("#[cfg(test)]").unwrap()];
        let mut keys = 0;
        for key in body
            .split("\"")
            .skip(1)
            .step_by(2)
            .filter(|k| k.contains('.') && !k.contains(' '))
        {
            let (en, ko) = (lookup(key, false), lookup(key, true));
            if en.is_empty() {
                continue;
            }
            keys += 1;
            assert!(!ko.is_empty(), "{key} has no Korean");
            assert!(
                ko.chars().any(|c| ('\u{ac00}'..='\u{d7a3}').contains(&c)) || ko == en,
                "{key} is not Korean: {ko}"
            );
        }
        assert!(keys > 60, "found only {keys} keys");
    }

    #[test]
    fn language_follows_the_first_set_locale_variable() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert_eq!(detect(env(&[("LANG", "ko_KR.UTF-8")])), Lang::Ko);
        assert_eq!(
            detect(env(&[("LC_ALL", "en_US.UTF-8"), ("LANG", "ko_KR.UTF-8")])),
            Lang::En
        );
        assert_eq!(detect(env(&[])), Lang::En);
    }
}
