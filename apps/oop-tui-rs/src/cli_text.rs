//! The words of the shell commands (`oop --help`, `config`, `doctor`, `stop`, `update`) and their
//! usage errors, English and Korean side by side. Originally generated from the removed TypeScript
//! terminal's i18n tables (cli, doctor and settings); the generator is gone, so this file is now
//! the source and is edited directly. Keys keep their old names.

use crate::i18n::{Lang, lang};
use crate::panels_common::fill;

/// The text of `key` in the app language.
pub fn t(key: &str) -> &'static str {
    lookup(key, lang() == Lang::Ko)
}

/// `t(key)` with its `{name}` holes filled.
pub fn tf(key: &str, pairs: &[(&str, String)]) -> String {
    fill(t(key), pairs)
}

/// The text of `key` in one language, for tests and for text that is not in the app language.
pub fn lookup(key: &str, ko: bool) -> &'static str {
    let pick = |en: &'static str, kr: &'static str| if ko { kr } else { en };
    match key {
        "cli.help" => pick(
            "oop - the OOP terminal coding assistant\n\nUsage\n  oop                        Pick a project and thread, then chat (connects to the OOP app on this\n                             computer automatically; if the app is closed, the terminal starts its\n                             own server so you can work without it)\n  oop --continue             Resume the latest thread of the project in this folder\n  oop \"prompt\"               Open a new thread in this folder's project and send that message right away\n                             (with --continue it goes to the latest thread instead. If the folder has no\n                             project you pick one. Standard input is not read)\n  oop pair <link or token>   Connect to a server on another computer (not needed on this one)\n  oop status                 Connect once and print the server, providers, projects and threads\n  oop config                 Show settings\n  oop config get <key>       Show one setting\n  oop config set <key> <value>  Change a setting (theme, symbols, animations, banner, statusLine, notify, sidebar, workflow, pet, language)\n  oop config path            Show where the settings file is\n  oop doctor                 Check terminal colors, symbols, settings, server and credentials (does not start the app)\n  oop stop                   Stop the server the terminal started (never the one the app uses)\n  oop update                 Check for a new release and show what changed and how to update (installs nothing)\n  oop provider [list]        List providers and their status\n  oop provider add [kind]    Add a provider (without a kind you choose on screen)\n  oop provider remove <id>   Remove a provider (shows the impact first and asks you to confirm with yes)\n\nOptions\n  -c, --continue             Resume the latest thread\n      --server <address>     Use this server address (e.g. http://127.0.0.1:3773)\n      --home <folder>        Use this OOP home folder (default: ~/.oop-desktop)\n      --mode <mode>          Runtime mode for a new thread:\n                             approval-required | auto-accept-edits | auto | full-access\n      --                     At the very start, without a command name: everything after is the prompt (for a one-word prompt or one starting with -: oop -- stop)\n  -h, --help                 Show this help\n  -v, --version              Show the version\n\nProvider options (only for oop provider add / remove)\n      --id <id>              ID of the new provider (starts with a letter; letters, digits, - and _)\n      --name <name>          Display name\n      --set <key>=<value>    Per-kind setting (e.g. --set binaryPath=/usr/local/bin/opencode)\n      --env <name>=<value>   Environment variable (name secret values with --secret)\n      --secret <name>=@VAR   Read a secret from environment variable VAR (=- reads standard input). Values never go on the command line\n                             Fields like an API key are passed the same way: --set apiKey=@VAR\n  -y, --yes                  Run without asking for confirmation\n      --dry-run              Only show what would be sent or removed, then exit (secrets are masked)\n  Kinds: codex claudeAgent cursor grok opencode antigravity minimax zcode, presets zai | preset:minimax\n\nThe environment variables OOP_THEME, OOP_ANIMATIONS=0 and OOP_SYMBOLS=ascii take priority over the settings file.\nLanguage: oop config set language en|ko. Without it the interface is English, whatever the system locale is.\nIn a chat, /theme picks a color theme, /stats shows tool usage, /update checks for a new release, and /help lists commands and keys.\n\nThreads are shared with the desktop app. You can create a pairing link in the app's connection settings.\nA server started by the terminal keeps running after you close oop (stop it with oop stop). When you open\nthe app it takes the server over and oop reconnects by itself; a turn in progress is interrupted.\n",
            "oop - OOP 터미널 코딩 어시스턴트\n\n사용법\n  oop                        프로젝트와 스레드를 고르고 대화합니다 (이 컴퓨터의 OOP 앱에 자동 연결.\n                             앱이 꺼져 있으면 터미널이 서버를 직접 띄워 앱 없이 씁니다)\n  oop --continue             지금 폴더 프로젝트의 가장 최근 스레드를 이어갑니다\n  oop \"프롬프트\"             지금 폴더 프로젝트에 새 스레드를 열고 그 메시지를 바로 보냅니다\n                             (--continue 와 함께 쓰면 가장 최근 스레드로 보냅니다. 폴더에 프로젝트가\n                             없으면 프로젝트를 고르게 합니다. 표준입력은 읽지 않습니다)\n  oop pair <링크 또는 토큰>   다른 컴퓨터의 서버에 연결합니다 (이 컴퓨터는 필요 없음)\n  oop status                 한 번 연결해 서버·Provider·프로젝트·스레드를 출력합니다\n  oop config                 설정 보기\n  oop config get <키>        설정 값 하나 보기\n  oop config set <키> <값>   설정 바꾸기 (theme, symbols, animations, banner, statusLine, notify, sidebar, workflow, pet, language)\n  oop config path            설정 파일 위치\n  oop doctor                 터미널 색·심볼·설정·서버·자격증명 파일을 점검합니다 (앱을 띄우지 않음)\n  oop stop                   터미널이 띄운 서버를 멈춥니다 (앱이 쓰는 서버는 멈추지 않음)\n  oop update                 새 릴리스가 있는지 확인하고 핵심 변경과 업데이트 방법을 보여 줍니다 (설치는 하지 않음)\n  oop provider [list]        Provider 목록과 상태\n  oop provider add [종류]    Provider 추가 (종류 없이 실행하면 화면에서 고릅니다)\n  oop provider remove <id>   Provider 삭제 (영향을 먼저 보여 주고 yes 를 확인합니다)\n\n옵션\n  -c, --continue             가장 최근 스레드 이어가기\n      --server <주소>        서버 주소를 직접 지정 (예: http://127.0.0.1:3773)\n      --home <폴더>          OOP 홈 폴더 지정 (기본: ~/.oop-desktop)\n      --mode <모드>          새 스레드의 실행 모드:\n                             approval-required | auto-accept-edits | auto | full-access\n      --                     명령 이름 없이 맨 앞에 쓰면 이후는 모두 프롬프트 (한 단어나 -로 시작하는 프롬프트: oop -- stop)\n  -h, --help                 도움말\n  -v, --version              버전\n\nProvider 옵션 (oop provider add / remove 에서만)\n      --id <id>              새 Provider 의 ID (영문자로 시작, 영문자·숫자·-·_)\n      --name <이름>          표시 이름\n      --set <키>=<값>        종류별 설정 (예: --set binaryPath=/usr/local/bin/opencode)\n      --env <이름>=<값>      환경 변수 (비밀값 이름은 --secret 으로)\n      --secret <이름>=@VAR   비밀값을 환경 변수 VAR 에서 (=- 는 표준입력). 명령줄에는 값을 쓰지 않습니다\n                             API 키 같은 칸은 --set apiKey=@VAR 처럼 같은 방식으로 넘깁니다\n  -y, --yes                  확인 없이 실행\n      --dry-run              보내거나 지울 내용만 보여 주고 끝냅니다 (비밀값은 가려서)\n  종류: codex claudeAgent cursor grok opencode antigravity minimax zcode, 프리셋 zai | preset:minimax\n\n환경 변수 OOP_THEME, OOP_ANIMATIONS=0, OOP_SYMBOLS=ascii 는 설정 파일보다 우선합니다.\n언어: oop config set language en|ko. 설정하지 않으면 시스템 로캘과 상관없이 영어입니다.\n채팅 안에서는 /theme 으로 색 테마를 고르고, /stats 로 도구 사용 통계를, /update 로 새 릴리스를, /help 로 명령과 키를 봅니다.\n\n스레드는 데스크톱 앱과 공유됩니다. 페어링 링크는 앱의 연결 설정에서 만들 수 있습니다.\n터미널이 띄운 서버는 oop 을 닫아도 계속 실행됩니다 (oop stop 으로 멈춤). 앱을 켜면 앱이 서버를\n이어받고 oop 이 알아서 다시 연결합니다. 이때 진행 중인 턴은 끊깁니다.\n",
        ),
        "cli.err.serverNeedsAddress" => pick(
            "--server needs an address.",
            "--server 에는 주소가 필요합니다.",
        ),
        "cli.err.homeNeedsPath" => pick(
            "--home needs a folder path.",
            "--home 에는 폴더 경로가 필요합니다.",
        ),
        "cli.err.modeValues" => pick(
            "--mode must be one of {modes}.",
            "--mode 는 {modes} 중 하나여야 합니다.",
        ),
        "cli.err.needsValue" => pick("{name} needs a value.", "{name} 에는 값이 필요합니다."),
        "cli.err.unknownOption" => pick("Unknown option: {name}", "알 수 없는 옵션: {name}"),
        "cli.err.emptyPrompt" => pick("The prompt is empty.", "프롬프트가 비어 있습니다."),
        "cli.err.unknownCommand" => pick(
            "Unknown command: {word} (to send a one-word message, use oop -- {word})",
            "알 수 없는 명령: {word} (한 단어짜리 메시지는 oop -- {word} 로 보냅니다)",
        ),
        "cli.err.pairNeedsTarget" => pick(
            "oop pair needs a pairing link or token.",
            "oop pair 에는 페어링 링크 또는 토큰이 필요합니다.",
        ),
        "cli.err.usageConfig" => pick(
            "Usage: oop config [get <key> | set <key> <value> | path]",
            "사용법: oop config [get <키> | set <키> <값> | path]",
        ),
        "cli.err.usageDoctor" => pick("Usage: oop doctor", "사용법: oop doctor"),
        "cli.err.usageStop" => pick("Usage: oop stop", "사용법: oop stop"),
        "cli.err.usageUpdate" => pick("Usage: oop update", "사용법: oop update"),
        "cli.stop.none" => pick(
            "No OOP server is running.",
            "실행 중인 OOP 서버가 없습니다.",
        ),
        "cli.stop.unreachable" => pick(
            "The OOP server is not responding, so nothing could be checked. Nothing was stopped.",
            "OOP 서버가 응답하지 않아 확인할 수 없습니다. 아무것도 멈추지 않았습니다.",
        ),
        "cli.stop.appServer" => pick(
            "The current server belongs to the OOP app. It stops when the app quits, so it was not stopped here.",
            "지금 서버는 OOP 앱이 쓰는 서버입니다. 앱을 종료하면 함께 멈추므로 여기서는 멈추지 않았습니다.",
        ),
        "cli.stop.unverified" => pick(
            "Did not stop the server (pid {pid}): could not confirm it is this user's OOP server listening on {origin}.",
            "서버(pid {pid})가 이 사용자의 OOP 서버이고 {origin} 에서 리슨 중인지 확인하지 못해 멈추지 않았습니다.",
        ),
        "cli.stop.stopping" => pick(
            "Stopping the terminal-only server. A turn in progress will be interrupted.",
            "터미널 단독 서버를 멈춥니다. 진행 중인 턴이 있으면 끊깁니다.",
        ),
        "cli.stop.stillRunning" => pick(
            "The server (pid {pid}) has not exited yet. Check again in a moment.",
            "서버(pid {pid})가 아직 끝나지 않았습니다. 잠시 뒤 다시 확인하세요.",
        ),
        "cli.stop.done" => pick(
            "Stopped. If an oop window is still open it restarts the server after 5 seconds, so close it first.",
            "멈췄습니다. 열려 있는 oop 창이 있으면 5초 뒤 서버를 다시 띄우니, 먼저 창을 닫으세요.",
        ),
        "cli.update.current" => pick("Current version: {version}", "현재 버전: {version}"),
        "cli.update.checking" => pick("Checking for updates…", "업데이트 확인 중…"),
        "cli.update.checkFailed" => pick(
            "Could not check for updates. Check your network connection.",
            "업데이트를 확인하지 못했습니다. 네트워크 연결을 확인하세요.",
        ),
        "cli.update.upToDate" => pick(
            "You are up to date ({version}).",
            "이미 최신입니다 ({version}).",
        ),
        "cli.update.available" => pick(
            "Update available: {current} → {latest}",
            "업데이트 있음: {current} → {latest}",
        ),
        "cli.update.more" => pick("  and {count} more releases", "  외 {count}개 릴리스"),
        "doctor.color.0" => pick("none", "없음"),
        "doctor.color.1" => pick("16 colors", "16색"),
        "doctor.color.2" => pick("256 colors", "256색"),
        "doctor.color.3" => pick("true color", "트루컬러"),
        "doctor.reason.notTty" => pick("not a terminal", "터미널이 아님"),
        "doctor.reason.default" => pick("default", "기본값"),
        "doctor.color" => pick("Color: {name} ({reason})", "색: {name} ({reason})"),
        "doctor.symbols" => pick("Symbols: {kind} ({setting})", "심볼: {kind} ({setting})"),
        "doctor.theme" => pick("Theme: {name}", "테마: {name}"),
        "doctor.settings.unreadable" => pick(
            "Cannot read the settings file, using defaults: {file}",
            "설정 파일을 읽을 수 없어 기본값을 씁니다: {file}",
        ),
        "doctor.settings.none" => pick(
            "No settings file (using defaults)",
            "설정 파일 없음 (기본값 사용)",
        ),
        "doctor.settings.ok" => pick("Settings file is fine: {file}", "설정 파일 정상: {file}"),
        "doctor.server.found" => pick(
            "OOP server on this computer: running (port {port}) — {kind}",
            "이 컴퓨터의 OOP 서버: 있음 (포트 {port}) — {kind}",
        ),
        "doctor.server.standalone" => pick("terminal-only server", "터미널 단독 서버"),
        "doctor.server.app" => pick("server used by the app", "앱이 쓰는 서버"),
        "doctor.server.none" => pick(
            "OOP server on this computer: none{detail}",
            "이 컴퓨터의 OOP 서버: 없음{detail}",
        ),
        "doctor.credentials.none" => pick(
            "No credentials file — 'oop' connects automatically on this computer; use 'oop pair' for other computers",
            "자격증명 파일 없음 — 이 컴퓨터는 'oop' 이 자동 연결하고, 다른 컴퓨터는 'oop pair' 로 연결합니다",
        ),
        "doctor.credentials.wide" => pick(
            "The credentials file permissions are too open ({mode}): tighten them with chmod 600",
            "자격증명 파일 권한이 넓습니다 ({mode}): chmod 600 으로 줄이세요",
        ),
        "doctor.credentials.ok" => pick(
            "Credentials file present (contents not read)",
            "자격증명 파일 있음 (내용은 읽지 않음)",
        ),
        "doctor.standalone.ok" => pick(
            "Standalone terminal mode: available ({script})",
            "터미널 단독 실행: 가능 ({script})",
        ),
        "doctor.standalone.noApp" => pick(
            "Standalone terminal mode: unavailable — the installed OOP app was not found (the connection drops when the app closes)",
            "터미널 단독 실행: 불가 — 설치된 OOP 앱을 찾지 못했습니다 (앱이 꺼지면 연결이 끊어집니다)",
        ),
        "doctor.standalone.unsupported" => pick(
            "Standalone terminal mode: not supported on this operating system (the connection drops when the app closes)",
            "터미널 단독 실행: 이 운영체제에서는 지원하지 않습니다 (앱이 꺼지면 연결이 끊어집니다)",
        ),
        "doctor.section.terminal" => pick("Terminal", "터미널"),
        "doctor.section.settings" => pick("Settings", "설정"),
        "doctor.section.connection" => pick("Connection", "연결"),
        "doctor.title" => pick("Terminal check", "터미널 점검"),
        "doctor.passed" => pick(
            "{passed}/{total} checks passed",
            "{passed}/{total} 점검 통과",
        ),
        "doctor.attention" => pick("{count} need attention", "{count}건 확인 필요"),
        "settings.expected.theme" => pick("a theme name", "테마 이름"),
        "settings.default" => pick("(default)", "(기본)"),
        "settings.fromEnv" => pick(" (environment variable)", " (환경 변수)"),
        "settings.err.unknownKey" => pick(
            "Unknown setting: {key} ({keys})",
            "알 수 없는 설정: {key} ({keys})",
        ),
        "settings.err.badValue" => pick(
            "{key} only accepts {expected}.",
            "{key} 에는 {expected} 만 쓸 수 있습니다.",
        ),
        "settings.err.unknownTheme" => pick(
            "Unknown theme: {value} ({themes})",
            "알 수 없는 테마: {value} ({themes})",
        ),
        "settings.warn.envWins" => pick(
            "An environment variable takes priority, so this value does not apply right now.",
            "환경 변수가 우선하므로 이 값은 지금 적용되지 않습니다.",
        ),
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::lookup;

    const KEYS: [&str; 61] = [
        "cli.help",
        "cli.err.serverNeedsAddress",
        "cli.err.homeNeedsPath",
        "cli.err.modeValues",
        "cli.err.needsValue",
        "cli.err.unknownOption",
        "cli.err.emptyPrompt",
        "cli.err.unknownCommand",
        "cli.err.pairNeedsTarget",
        "cli.err.usageConfig",
        "cli.err.usageDoctor",
        "cli.err.usageStop",
        "cli.err.usageUpdate",
        "cli.stop.none",
        "cli.stop.unreachable",
        "cli.stop.appServer",
        "cli.stop.unverified",
        "cli.stop.stopping",
        "cli.stop.stillRunning",
        "cli.stop.done",
        "cli.update.current",
        "cli.update.checking",
        "cli.update.checkFailed",
        "cli.update.upToDate",
        "cli.update.available",
        "cli.update.more",
        "doctor.color.0",
        "doctor.color.1",
        "doctor.color.2",
        "doctor.color.3",
        "doctor.reason.notTty",
        "doctor.reason.default",
        "doctor.color",
        "doctor.symbols",
        "doctor.theme",
        "doctor.settings.unreadable",
        "doctor.settings.none",
        "doctor.settings.ok",
        "doctor.server.found",
        "doctor.server.standalone",
        "doctor.server.app",
        "doctor.server.none",
        "doctor.credentials.none",
        "doctor.credentials.wide",
        "doctor.credentials.ok",
        "doctor.standalone.ok",
        "doctor.standalone.noApp",
        "doctor.standalone.unsupported",
        "doctor.section.terminal",
        "doctor.section.settings",
        "doctor.section.connection",
        "doctor.title",
        "doctor.passed",
        "doctor.attention",
        "settings.expected.theme",
        "settings.default",
        "settings.fromEnv",
        "settings.err.unknownKey",
        "settings.err.badValue",
        "settings.err.unknownTheme",
        "settings.warn.envWins",
    ];

    #[test]
    fn every_english_text_has_a_korean_one_and_the_same_holes() {
        let holes = |text: &str| {
            let mut found: Vec<String> = text
                .split('{')
                .skip(1)
                .filter_map(|rest| rest.split_once('}').map(|(name, _)| name.to_string()))
                .collect();
            found.sort();
            found
        };
        for key in KEYS {
            let (en, ko) = (lookup(key, false), lookup(key, true));
            assert!(!en.is_empty() && !ko.is_empty(), "{key}");
            assert_eq!(holes(en), holes(ko), "{key}");
        }
    }

    #[test]
    fn the_help_lists_every_command_in_both_languages() {
        for ko in [false, true] {
            let help = lookup("cli.help", ko);
            for word in [
                "pair", "status", "config", "doctor", "stop", "update", "provider",
            ] {
                assert!(help.contains(&format!("oop {word}")), "{word} (ko={ko})");
            }
        }
    }
}
