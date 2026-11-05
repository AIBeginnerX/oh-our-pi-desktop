//! The slice's UI strings in English and Korean. The terminal is English unless `settings.json` says
//! `"language": "ko"` (`oop config set language ko`): the system locale (LC_ALL, LC_MESSAGES, LANG)
//! is never read, the same as the former TypeScript app, which kept ~2,400
//! lines of such tables; here every string is an English and a Korean one side by side.

use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    En,
    Ko,
}

static LANG: OnceLock<Lang> = OnceLock::new();

/// The language `settings.json` asks for (`en` or `ko`); English for none or any other value.
pub fn resolve(setting: Option<&str>) -> Lang {
    match setting {
        Some("ko") => Lang::Ko,
        _ => Lang::En,
    }
}

pub fn lang() -> Lang {
    *LANG.get_or_init(|| resolve(None))
}

/// Fixes the language from the `language` setting before the first string is read. A no-op once a
/// string was read.
pub fn init(setting: Option<&str>) {
    let _ = LANG.set(resolve(setting));
}

/// The product's one line, as the window title and the header box say it. Not translated.
pub const TAGLINE: &str = "One desktop for every coding agent";

/// Tips the header rotates through; the last is for OOP Terminal's own window only.
const TIPS: usize = 18;

/// How many tips there are to show: the last one names OOP Terminal's split keys, which only it has.
pub fn tip_count(in_oop_terminal: bool) -> usize {
    if in_oop_terminal { TIPS } else { TIPS - 1 }
}

/// The `index`th tip, counted from 0 and wrapped to the tips that exist.
pub fn tip(index: usize, in_oop_terminal: bool) -> &'static str {
    tr(&format!("tip.{}", index % tip_count(in_oop_terminal) + 1))
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
        "header.title" => pick("OOP Terminal", "OOP 터미널"),
        "header.folder" => pick("Folder", "폴더"),
        "header.provider" => pick("Provider", "프로바이더"),
        "header.model" => pick("Model", "모델"),
        "header.auth" => pick("Auth", "인증"),
        "header.crewOff" => pick("Off", "꺼짐"),
        "header.noProvider" => pick("No provider", "프로바이더 없음"),
        "header.tip" => pick("Tip", "팁"),
        "auth.apiKey" => pick("API key", "API 키"),
        "auth.subscription" => pick("Subscription", "구독"),
        "auth.unknown" => pick("Not verified", "확인 안 됨"),
        "auth.signedOut" => pick("Signed out", "로그인 안 됨"),
        "header.server" => pick("Server  ", "서버  "),
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
            "Enter send · Shift-Enter newline · Tab list · Ctrl-B/G side panes · PgUp/PgDn scroll · /model /mode /effort · Ctrl-C quit",
            "Enter 전송 · Shift-Enter 줄바꿈 · Tab 목록 · Ctrl-B/G 옆 창 · PgUp/PgDn 스크롤 · /model /mode /effort · Ctrl-C 종료",
        ),
        "hint.working" => pick(
            "Esc stop the turn · Enter queue the message · PgUp/PgDn scroll · Ctrl-B/G side panes · Ctrl-C quit",
            "Esc 작업 중단 · Enter 메시지 대기열 · PgUp/PgDn 스크롤 · Ctrl-B/G 옆 창 · Ctrl-C 종료",
        ),
        "hint.list" => pick(
            "↑/↓ move · Enter open · n new thread · Tab message · Ctrl-B hide list · q quit",
            "↑/↓ 이동 · Enter 열기 · n 새 스레드 · Tab 메시지 · Ctrl-B 목록 닫기 · q 종료",
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
        "hint.folderPicker" => pick(
            "↑/↓ or click · Enter pick · type a path for another folder · Esc cancel",
            "↑/↓ 또는 클릭 · Enter 선택 · 다른 폴더는 경로 입력 · Esc 취소",
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
        // A command that connects once exits here, so it says what to do rather than that this
        // terminal is waiting; the reconnect loop has its own wording (`link.err.appUpdating`).
        "link.appUpdating" => pick(
            "The OOP app may be installing an update, so no server was started. Opening the app picks up right away; otherwise you can try again in up to 15 minutes.",
            "OOP 앱이 업데이트를 설치하는 중일 수 있어 서버를 띄우지 않았습니다. 앱을 켜면 바로 이어지고, 아니면 최대 15분 뒤 다시 시도할 수 있습니다.",
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
        "header.crew" => pick("Crew", "크루"),
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
            "Usage: /dag-workflow [on|off], /savvy [on|off], /files [on|off]",
            "사용법: /dag-workflow [on|off], /savvy [on|off], /files [on|off]",
        ),
        "notice.panelOn" => pick("The side panel is open.", "오른쪽 패널을 열었습니다."),
        "notice.panelOff" => pick(
            "The side panel is closed (Ctrl-G or /panel opens it).",
            "오른쪽 패널을 닫았습니다 (Ctrl-G 또는 /panel 로 다시 엽니다).",
        ),
        "notice.panelWait" => pick(
            "The side panel is open; it shows once a thread is open.",
            "오른쪽 패널을 열었습니다. 스레드를 열면 나타납니다.",
        ),
        "notice.panelToggleUsage" => pick("Usage: /panel [on|off]", "사용법: /panel [on|off]"),
        "notice.listOn" => pick("The thread list is open.", "스레드 목록을 열었습니다."),
        "notice.listOff" => pick(
            "The thread list is closed (Ctrl-B or /sidebar opens it).",
            "스레드 목록을 닫았습니다 (Ctrl-B 또는 /sidebar 로 다시 엽니다).",
        ),
        "notice.paneNarrow" => pick(
            "Open, but the terminal needs {min}+ columns to show it.",
            "열었지만 표시하려면 터미널이 {min}열 이상이어야 합니다.",
        ),
        "pane.openList" => pick("Ctrl-B list", "Ctrl-B 목록"),
        "pane.openPanel" => pick("Ctrl-G panel", "Ctrl-G 패널"),
        "notice.newThread" => pick(
            "New thread. Type a message to start it.",
            "새 스레드입니다. 메시지를 입력하면 시작합니다.",
        ),
        "notice.help" => pick(
            "/model /mode /effort /plan /default /implement /goal /crew /provider /dag-workflow /savvy /files /replay /new /threads /projects /stats /tasks /sidebar /panel /mouse /pet /history /diff /undo /theme /update /help /exit · Ctrl-B list · Ctrl-G panel",
            "/model /mode /effort /plan /default /implement /goal /crew /provider /dag-workflow /savvy /files /replay /new /threads /projects /stats /tasks /sidebar /panel /mouse /pet /history /diff /undo /theme /update /help /exit · Ctrl-B 목록 · Ctrl-G 패널",
        ),
        "notice.unsupported" => pick(
            "Not in oop-rs yet: use the TypeScript terminal for it.",
            "oop-rs에는 아직 없습니다. 이 명령은 TypeScript 터미널에서 쓰세요.",
        ),
        "tip.1" => pick(
            "/model switches the model; type part of a name to search.",
            "/model 로 모델을 바꿉니다. 이름 일부를 입력하면 검색됩니다.",
        ),
        "tip.2" => pick(
            "/mode sets how much the agent may do without asking.",
            "/mode 로 에이전트가 묻지 않고 할 수 있는 범위를 정합니다.",
        ),
        "tip.3" => pick(
            "/effort changes the reasoning effort, for models that support it.",
            "/effort 로 추론 강도를 바꿉니다 (지원하는 모델만).",
        ),
        "tip.4" => pick(
            "/plan makes the agent plan before it acts; /default goes back.",
            "/plan 은 에이전트가 실행 전에 계획을 먼저 세우게 하고, /default 로 돌아갑니다.",
        ),
        "tip.5" => pick(
            "/implement carries out the plan the agent proposed.",
            "/implement 로 에이전트가 제안한 계획을 구현합니다.",
        ),
        "tip.6" => pick(
            "/crew splits work between worker, expert and auditor models.",
            "/crew 로 worker·expert·auditor 역할별 모델에 일을 나눕니다.",
        ),
        "tip.7" => pick(
            "/stats shows this thread's tool usage.",
            "/stats 로 이 스레드의 도구 사용 통계를 봅니다.",
        ),
        "tip.8" => pick(
            "Esc interrupts a running turn.",
            "작업 중에 Esc 를 누르면 진행 중인 턴을 중단합니다.",
        ),
        "tip.9" => pick(
            "Shift-Enter or Ctrl-J adds a new line; Enter sends.",
            "Shift-Enter 또는 Ctrl-J 로 줄을 바꾸고, Enter 로 전송합니다.",
        ),
        "tip.10" => pick(
            "PageUp and PageDown scroll back through the conversation.",
            "PageUp·PageDown 으로 지난 대화를 위아래로 넘깁니다.",
        ),
        "tip.11" => pick(
            "Drag over the conversation to copy its text; /mouse off lets the terminal select.",
            "대화 위를 드래그하면 글자가 복사됩니다. /mouse off 로 끄면 터미널이 직접 선택합니다.",
        ),
        "tip.12" => pick(
            "/pet shows or hides Mocha, the coffee mug in the header.",
            "/pet 으로 헤더의 커피잔 모카를 보이거나 숨깁니다.",
        ),
        "tip.13" => pick(
            "Ctrl-B hides or shows the thread list and Ctrl-G the right panel; Tab moves into the list.",
            "Ctrl-B 로 왼쪽 스레드 목록을, Ctrl-G 로 오른쪽 패널을 열고 닫고, Tab 으로 목록에 들어갑니다.",
        ),
        "tip.14" => pick(
            "/undo removes the last turn from the conversation.",
            "/undo 로 마지막 턴을 대화에서 되돌립니다.",
        ),
        "tip.15" => pick(
            "/diff shows the files and diff a turn changed.",
            "/diff 로 턴이 바꾼 파일과 diff 를 봅니다.",
        ),
        "tip.16" => pick(
            "/goal sets or shows the thread's goal.",
            "/goal 로 스레드의 목표를 정하거나 확인합니다.",
        ),
        "tip.17" => pick(
            "/dag-workflow, /savvy and /files open a panel on the right (100+ columns).",
            "/dag-workflow, /savvy, /files 로 오른쪽 패널에서 워크플로·진행·파일을 봅니다 (100열 이상).",
        ),
        "tip.18" => pick(
            "In OOP Terminal, Cmd+D splits the window to the right and Cmd+Shift+D below.",
            "OOP Terminal 에서는 Cmd+D 로 오른쪽, Cmd+Shift+D 로 아래로 창을 나눕니다.",
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
    fn the_language_is_english_unless_the_setting_says_korean() {
        assert_eq!(resolve(None), Lang::En);
        assert_eq!(resolve(Some("en")), Lang::En);
        assert_eq!(resolve(Some("ko")), Lang::Ko);
        assert_eq!(resolve(Some("fr")), Lang::En);
        // The system locale has no say: nothing in this module reads LC_ALL, LC_MESSAGES or LANG.
        let source = include_str!("i18n.rs");
        let code = &source[..source.find("#[cfg(test)]").unwrap()];
        for name in ["LC_ALL", "LC_MESSAGES", "\"LANG\"", "env::var"] {
            assert!(
                !code
                    .lines()
                    .filter(|l| !l.trim_start().starts_with("//"))
                    .any(|l| l.contains(name)),
                "{name} is read"
            );
        }
    }

    #[test]
    fn the_chrome_is_english_by_default_and_korean_with_the_setting() {
        // The header's labels, the thread list and the composer: `Crew`/`Thread` style English with
        // no config (whatever LANG says), the Korean catalog with `language: ko`.
        let chrome = [
            "header.folder",
            "header.provider",
            "header.model",
            "list.projects",
            "list.new",
            "list.crew",
            "composer.title",
            "state.waiting",
        ];
        for key in chrome {
            let en = lookup(key, resolve(None) == Lang::Ko);
            let ko = lookup(key, resolve(Some("ko")) == Lang::Ko);
            assert!(!en.chars().any(is_hangul), "{key}: {en}");
            assert!(ko.chars().any(is_hangul), "{key}: {ko}");
        }
        assert_eq!(lookup("list.projects", false), "Threads");
        assert_eq!(lookup("list.projects", true), "스레드");
    }

    fn is_hangul(c: char) -> bool {
        ('\u{ac00}'..='\u{d7a3}').contains(&c)
    }

    #[test]
    fn the_english_strings_hold_no_korean() {
        let source = include_str!("i18n.rs");
        let body = &source[source.find("fn lookup").unwrap()..source.find("#[cfg(test)]").unwrap()];
        for key in body
            .split('"')
            .skip(1)
            .step_by(2)
            .filter(|k| k.contains('.') && !k.contains(' '))
        {
            assert!(!lookup(key, false).chars().any(is_hangul), "{key}");
        }
    }
}
