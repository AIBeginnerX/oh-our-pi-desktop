import { defineMessages } from "./define.ts";

export const cli = defineMessages(
  {
    "cli.help": `oop - the OOP terminal coding assistant

Usage
  oop                        Pick a project and thread, then chat (connects to the OOP app on this
                             computer automatically; if the app is closed, the terminal starts its
                             own server so you can work without it)
  oop --continue             Resume the latest thread of the project in this folder
  oop "prompt"               Open a new thread in this folder's project and send that message right away
                             (with --continue it goes to the latest thread instead. If the folder has no
                             project you pick one. Standard input is not read)
  oop pair <link or token>   Connect to a server on another computer (not needed on this one)
  oop config                 Show settings
  oop config get <key>       Show one setting
  oop config set <key> <value>  Change a setting (theme, symbols, animations, banner, statusLine, notify, language)
  oop config path            Show where the settings file is
  oop doctor                 Check terminal colors, symbols, settings, server and credentials (does not start the app)
  oop stop                   Stop the server the terminal started (never the one the app uses)
  oop update                 Check for a new release and show what changed and how to update (installs nothing)
  oop provider [list]        List providers and their status
  oop provider add [kind]    Add a provider (without a kind you choose on screen)
  oop provider remove <id>   Remove a provider (shows the impact first and asks you to confirm with yes)

Options
  -c, --continue             Resume the latest thread
      --server <address>     Use this server address (e.g. http://127.0.0.1:3773)
      --home <folder>        Use this OOP home folder (default: ~/.oop-desktop)
      --mode <mode>          Runtime mode for a new thread:
                             approval-required | auto-accept-edits | auto | full-access
      --                     At the very start, without a command name: everything after is the prompt (for a one-word prompt or one starting with -: oop -- stop)
  -h, --help                 Show this help
  -v, --version              Show the version

Provider options (only for oop provider add / remove)
      --id <id>              ID of the new provider (starts with a letter; letters, digits, - and _)
      --name <name>          Display name
      --set <key>=<value>    Per-kind setting (e.g. --set binaryPath=/usr/local/bin/opencode)
      --env <name>=<value>   Environment variable (name secret values with --secret)
      --secret <name>=@VAR   Read a secret from environment variable VAR (=- reads standard input). Values never go on the command line
                             Fields like an API key are passed the same way: --set apiKey=@VAR
  -y, --yes                  Run without asking for confirmation
      --dry-run              Only show what would be sent or removed, then exit (secrets are masked)
  Kinds: codex claudeAgent cursor grok opencode antigravity minimax zcode, presets zai | preset:minimax

The environment variables OOP_THEME, OOP_ANIMATIONS=0 and OOP_SYMBOLS=ascii take priority over the settings file.
Language: oop config set language en|ko. Without it, LC_ALL, LC_MESSAGES or LANG decide (ko... is Korean, anything else English).
In a chat, /theme picks a color theme, /stats shows tool usage, /update checks for a new release, and /help lists commands and keys.

Threads are shared with the desktop app. You can create a pairing link in the app's connection settings.
A server started by the terminal keeps running after you close oop (stop it with oop stop). When you open
the app it takes the server over and oop reconnects by itself; a turn in progress is interrupted.
`,
    "cli.err.serverNeedsAddress": "--server needs an address.",
    "cli.err.homeNeedsPath": "--home needs a folder path.",
    "cli.err.modeValues": "--mode must be one of {modes}.",
    "cli.err.needsValue": "{name} needs a value.",
    "cli.err.unknownOption": "Unknown option: {name}",
    "cli.err.emptyPrompt": "The prompt is empty.",
    "cli.err.unknownCommand":
      "Unknown command: {word} (to send a one-word message, use oop -- {word})",
    "cli.err.pairNeedsTarget": "oop pair needs a pairing link or token.",
    "cli.err.usageConfig": "Usage: oop config [get <key> | set <key> <value> | path]",
    "cli.err.usageDoctor": "Usage: oop doctor",
    "cli.err.usageStop": "Usage: oop stop",
    "cli.err.usageUpdate": "Usage: oop update",
    "cli.stop.none": "No OOP server is running.",
    "cli.stop.unreachable":
      "The OOP server is not responding, so nothing could be checked. Nothing was stopped.",
    "cli.stop.appServer":
      "The current server belongs to the OOP app. It stops when the app quits, so it was not stopped here.",
    "cli.stop.unverified":
      "Did not stop the server (pid {pid}): could not confirm it is this user's OOP server listening on {origin}.",
    "cli.stop.stopping":
      "Stopping the terminal-only server. A turn in progress will be interrupted.",
    "cli.stop.stillRunning": "The server (pid {pid}) has not exited yet. Check again in a moment.",
    "cli.stop.done":
      "Stopped. If an oop window is still open it restarts the server after 5 seconds, so close it first.",
    "cli.update.howTo":
      "How to update: app menu 'Check for Updates...' → 'Prepare Update' → 'Open Installer'",
    "cli.update.tooLarge": "Response too large",
    "cli.update.timeout": "Timed out",
    "cli.update.cancelled": "Cancelled",
    "cli.update.noVersion": "Could not read the version",
    "cli.update.behind": "Terminal app {terminal} is older than the app {app} — {fix}",
    "cli.update.behindInApp": "updating the app updates it too",
    "cli.update.behindReinstall": "reinstall with: {command}",
    "cli.update.current": "Current version: {version}",
    "cli.update.checking": "Checking for updates…",
    "cli.update.checkFailed": "Could not check for updates. Check your network connection.",
    "cli.update.upToDate": "You are up to date ({version}).",
    "cli.update.available": "Update available: {current} → {latest}",
    "cli.update.more": "  and {count} more releases",
  },
  {
    "cli.help": `oop - OOP 터미널 코딩 어시스턴트

사용법
  oop                        프로젝트와 스레드를 고르고 대화합니다 (이 컴퓨터의 OOP 앱에 자동 연결.
                             앱이 꺼져 있으면 터미널이 서버를 직접 띄워 앱 없이 씁니다)
  oop --continue             지금 폴더 프로젝트의 가장 최근 스레드를 이어갑니다
  oop "프롬프트"             지금 폴더 프로젝트에 새 스레드를 열고 그 메시지를 바로 보냅니다
                             (--continue 와 함께 쓰면 가장 최근 스레드로 보냅니다. 폴더에 프로젝트가
                             없으면 프로젝트를 고르게 합니다. 표준입력은 읽지 않습니다)
  oop pair <링크 또는 토큰>   다른 컴퓨터의 서버에 연결합니다 (이 컴퓨터는 필요 없음)
  oop config                 설정 보기
  oop config get <키>        설정 값 하나 보기
  oop config set <키> <값>   설정 바꾸기 (theme, symbols, animations, banner, statusLine, notify, language)
  oop config path            설정 파일 위치
  oop doctor                 터미널 색·심볼·설정·서버·자격증명 파일을 점검합니다 (앱을 띄우지 않음)
  oop stop                   터미널이 띄운 서버를 멈춥니다 (앱이 쓰는 서버는 멈추지 않음)
  oop update                 새 릴리스가 있는지 확인하고 핵심 변경과 업데이트 방법을 보여 줍니다 (설치는 하지 않음)
  oop provider [list]        Provider 목록과 상태
  oop provider add [종류]    Provider 추가 (종류 없이 실행하면 화면에서 고릅니다)
  oop provider remove <id>   Provider 삭제 (영향을 먼저 보여 주고 yes 를 확인합니다)

옵션
  -c, --continue             가장 최근 스레드 이어가기
      --server <주소>        서버 주소를 직접 지정 (예: http://127.0.0.1:3773)
      --home <폴더>          OOP 홈 폴더 지정 (기본: ~/.oop-desktop)
      --mode <모드>          새 스레드의 실행 모드:
                             approval-required | auto-accept-edits | auto | full-access
      --                     명령 이름 없이 맨 앞에 쓰면 이후는 모두 프롬프트 (한 단어나 -로 시작하는 프롬프트: oop -- stop)
  -h, --help                 도움말
  -v, --version              버전

Provider 옵션 (oop provider add / remove 에서만)
      --id <id>              새 Provider 의 ID (영문자로 시작, 영문자·숫자·-·_)
      --name <이름>          표시 이름
      --set <키>=<값>        종류별 설정 (예: --set binaryPath=/usr/local/bin/opencode)
      --env <이름>=<값>      환경 변수 (비밀값 이름은 --secret 으로)
      --secret <이름>=@VAR   비밀값을 환경 변수 VAR 에서 (=- 는 표준입력). 명령줄에는 값을 쓰지 않습니다
                             API 키 같은 칸은 --set apiKey=@VAR 처럼 같은 방식으로 넘깁니다
  -y, --yes                  확인 없이 실행
      --dry-run              보내거나 지울 내용만 보여 주고 끝냅니다 (비밀값은 가려서)
  종류: codex claudeAgent cursor grok opencode antigravity minimax zcode, 프리셋 zai | preset:minimax

환경 변수 OOP_THEME, OOP_ANIMATIONS=0, OOP_SYMBOLS=ascii 는 설정 파일보다 우선합니다.
언어: oop config set language en|ko. 설정하지 않으면 LC_ALL, LC_MESSAGES, LANG 순으로 보고 ko 로 시작하면 한국어, 아니면 영어입니다.
채팅 안에서는 /theme 으로 색 테마를 고르고, /stats 로 도구 사용 통계를, /update 로 새 릴리스를, /help 로 명령과 키를 봅니다.

스레드는 데스크톱 앱과 공유됩니다. 페어링 링크는 앱의 연결 설정에서 만들 수 있습니다.
터미널이 띄운 서버는 oop 을 닫아도 계속 실행됩니다 (oop stop 으로 멈춤). 앱을 켜면 앱이 서버를
이어받고 oop 이 알아서 다시 연결합니다. 이때 진행 중인 턴은 끊깁니다.
`,
    "cli.err.serverNeedsAddress": "--server 에는 주소가 필요합니다.",
    "cli.err.homeNeedsPath": "--home 에는 폴더 경로가 필요합니다.",
    "cli.err.modeValues": "--mode 는 {modes} 중 하나여야 합니다.",
    "cli.err.needsValue": "{name} 에는 값이 필요합니다.",
    "cli.err.unknownOption": "알 수 없는 옵션: {name}",
    "cli.err.emptyPrompt": "프롬프트가 비어 있습니다.",
    "cli.err.unknownCommand":
      "알 수 없는 명령: {word} (한 단어짜리 메시지는 oop -- {word} 로 보냅니다)",
    "cli.err.pairNeedsTarget": "oop pair 에는 페어링 링크 또는 토큰이 필요합니다.",
    "cli.err.usageConfig": "사용법: oop config [get <키> | set <키> <값> | path]",
    "cli.err.usageDoctor": "사용법: oop doctor",
    "cli.err.usageStop": "사용법: oop stop",
    "cli.err.usageUpdate": "사용법: oop update",
    "cli.stop.none": "실행 중인 OOP 서버가 없습니다.",
    "cli.stop.unreachable":
      "OOP 서버가 응답하지 않아 확인할 수 없습니다. 아무것도 멈추지 않았습니다.",
    "cli.stop.appServer":
      "지금 서버는 OOP 앱이 쓰는 서버입니다. 앱을 종료하면 함께 멈추므로 여기서는 멈추지 않았습니다.",
    "cli.stop.unverified":
      "서버(pid {pid})가 이 사용자의 OOP 서버이고 {origin} 에서 리슨 중인지 확인하지 못해 멈추지 않았습니다.",
    "cli.stop.stopping": "터미널 단독 서버를 멈춥니다. 진행 중인 턴이 있으면 끊깁니다.",
    "cli.stop.stillRunning": "서버(pid {pid})가 아직 끝나지 않았습니다. 잠시 뒤 다시 확인하세요.",
    "cli.stop.done":
      "멈췄습니다. 열려 있는 oop 창이 있으면 5초 뒤 서버를 다시 띄우니, 먼저 창을 닫으세요.",
    "cli.update.howTo":
      "업데이트 방법: 앱 메뉴 '업데이트 확인...' → '업데이트 준비' → '설치 프로그램 열기'",
    "cli.update.tooLarge": "응답이 너무 큽니다",
    "cli.update.timeout": "시간 초과",
    "cli.update.cancelled": "취소됨",
    "cli.update.noVersion": "버전을 읽을 수 없습니다",
    "cli.update.behind": "터미널 앱 {terminal} 이 앱 {app} 보다 오래되었습니다 — {fix}",
    "cli.update.behindInApp": "앱을 업데이트하면 함께 갱신됩니다",
    "cli.update.behindReinstall": "다시 설치: {command}",
    "cli.update.current": "현재 버전: {version}",
    "cli.update.checking": "업데이트 확인 중…",
    "cli.update.checkFailed": "업데이트를 확인하지 못했습니다. 네트워크 연결을 확인하세요.",
    "cli.update.upToDate": "이미 최신입니다 ({version}).",
    "cli.update.available": "업데이트 있음: {current} → {latest}",
    "cli.update.more": "  외 {count}개 릴리스",
  },
);
