//! The words of the provider command and its wizard, English and Korean side by side. Originally
//! generated from the removed TypeScript terminal's providers tables (the
//! `providers.args|cmd|plan|field|spec|screen|flow` keys); this file is now the source, so edit it
//! directly. Keys keep their old names.

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
        "providers.args.badForm" => pick(
            "The format of {what} is invalid",
            "{what}의 형식이 잘못됐습니다",
        ),
        "providers.args.unknownWord" => pick("Unknown {what}: {name}", "알 수 없는 {what}: {name}"),
        "providers.args.secretHint" => pick(
            "Secrets are not accepted on the command line. Pass @ENV_VAR or - (stdin).",
            "비밀값은 명령줄에 쓰지 않습니다. @환경변수 또는 -(표준입력)로 넘기세요.",
        ),
        "providers.args.unclosedQuote" => pick("Unclosed quote.", "따옴표가 닫히지 않았습니다."),
        "providers.args.noValue" => pick(
            "{name} does not take a value.",
            "{name} 에는 값이 없습니다.",
        ),
        "providers.args.needsValue" => {
            pick("{name} needs a value.", "{name} 에는 값이 필요합니다.")
        }
        "providers.args.whatOption" => pick("option", "옵션"),
        "providers.args.usageCli" => pick(
            "Usage: oop provider [list | add [kind] [options] | remove <id> [-y] [--dry-run]]",
            "사용법: oop provider [list | add [종류] [옵션] | remove <id> [-y] [--dry-run]]",
        ),
        "providers.args.usageSlash" => pick(
            "Usage: /provider [list | add [kind] [options] | remove <id> [--dry-run]]",
            "사용법: /provider [list | add [종류] [옵션] | remove <id> [--dry-run]]",
        ),
        "providers.args.shape" => pick(
            "{flag} takes the form {shape}.",
            "{flag} 는 {shape} 형식입니다.",
        ),
        "providers.args.slashYesAdd" => pick(
            "The slash command confirms on its own screen. Use -y with oop provider add.",
            "슬래시 명령은 확인 화면에서 직접 확인합니다. -y 는 oop provider add 에서 쓰세요.",
        ),
        "providers.args.shapeKeyValue" => pick("key=value", "키=값"),
        "providers.args.shapeNameValue" => pick("name=value", "이름=값"),
        "providers.args.slashNoSecret" => pick(
            "The slash command does not take secrets. Type them on the input screen, where they are masked.",
            "슬래시 명령에서는 비밀값을 받지 않습니다. 입력 화면에서 가려서 입력하세요.",
        ),
        "providers.args.shapeSecret" => {
            pick("name=@ENV_VAR or name=-", "이름=@환경변수 또는 이름=-")
        }
        "providers.args.whatKind" => pick("kind", "종류"),
        "providers.args.kindRequired" => {
            pick("A kind is required: {kinds}", "종류가 필요합니다: {kinds}")
        }
        "providers.args.slashYesRemove" => pick(
            "The slash command confirms by asking you to type yes. Use -y with oop provider remove.",
            "슬래시 명령은 화면에서 yes 를 입력해 확인합니다. -y 는 oop provider remove 에서 쓰세요.",
        ),
        "providers.args.whatSubcommand" => pick("subcommand", "하위 명령"),
        "providers.args.envEmpty" => pick(
            "{label}: environment variable {variable} is empty.",
            "{label}: 환경 변수 {variable} 가 비어 있습니다.",
        ),
        "providers.args.stdinOnce" => pick(
            "Standard input (-) can be used only once.",
            "표준입력(-)은 한 번만 쓸 수 있습니다.",
        ),
        "providers.args.stdinEmpty" => pick(
            "{label}: standard input is empty.",
            "{label}: 표준입력이 비어 있습니다.",
        ),
        "providers.args.whatSettingKey" => pick("setting key", "설정 키"),
        "providers.args.allowedKeys" => pick("Allowed keys: {keys}", "쓸 수 있는 키: {keys}"),
        "providers.args.maskedOnly" => pick(
            "Enter {label} on the input screen, where it is masked.",
            "{label} 은(는) 입력 화면에서 가려서 입력하세요.",
        ),
        "providers.args.oneOf" => pick(
            "--set {key} must be one of {options}.",
            "--set {key} 는 {options} 중 하나여야 합니다.",
        ),
        "providers.args.trueOrFalse" => pick(
            "--set {key} must be true or false.",
            "--set {key} 는 true 또는 false 여야 합니다.",
        ),
        "providers.args.envTwice" => pick(
            "Environment variable {name} is given twice.",
            "환경 변수 {name} 가 두 번 쓰였습니다.",
        ),
        "providers.args.nameFallback" => pick("name", "이름"),
        "providers.args.envNameBad" => pick(
            "The environment variable name is malformed.",
            "환경 변수 이름 형식이 잘못됐습니다.",
        ),
        "providers.args.secretNameChat" => pick(
            "{shown} looks like a secret name, and chat does not accept secrets. Add it from a terminal: oop provider add --secret {shown}=@ENV_VAR",
            "{shown} 은(는) 비밀값 이름입니다. 채팅에서는 받지 않습니다. 터미널에서 oop provider add --secret {shown}=@환경변수 로 추가하세요.",
        ),
        "providers.args.secretNameCli" => pick(
            "{shown} looks like a secret name. Pass it with --secret {shown}=@ENV_VAR",
            "{shown} 은(는) 비밀값 이름입니다. --secret {shown}=@환경변수 로 넘기세요.",
        ),
        "providers.cmd.on" => pick("on", "켜짐"),
        "providers.cmd.off" => pick("off", "꺼짐"),
        "providers.cmd.default" => pick("default", "기본"),
        "providers.cmd.colName" => pick("Name", "이름"),
        "providers.cmd.colKind" => pick("Kind", "종류"),
        "providers.cmd.colEnabled" => pick("Enabled", "사용"),
        "providers.cmd.colStatus" => pick("Status", "상태"),
        "providers.cmd.colModels" => pick("Models", "모델"),
        "providers.cmd.colDefault" => pick("Default", "기본"),
        "providers.cmd.colNote" => pick("Note", "메모"),
        "providers.cmd.none" => pick("No providers are set up.", "등록된 Provider 가 없습니다."),
        "providers.cmd.status" => pick("Status: {status}", "상태: {status}"),
        "providers.cmd.modelCount" => pick("{count} models", "모델 {count}개"),
        "providers.cmd.refreshFailed" => pick(
            "Could not refresh the status. Check again in a moment with oop provider list.",
            "상태를 새로 읽지 못했습니다. 잠시 뒤 oop provider list 로 확인하세요.",
        ),
        "providers.cmd.kindNeeded" => pick(
            "Specify a kind, for example: oop provider add opencode --id my_opencode",
            "종류를 지정하세요. 예: oop provider add opencode --id my_opencode",
        ),
        "providers.cmd.settingsReadFailed" => pick(
            "Could not read the settings: {reason}",
            "설정을 읽지 못했습니다: {reason}",
        ),
        "providers.cmd.stdinPipeOnly" => pick(
            "Standard input (-) works only when piped, for example: pbpaste | oop provider add zai --set apiKey=- -y. Use an environment variable (--set apiKey=@VAR_NAME), or run without --set and type the key on the input screen, where it is masked.",
            "표준입력(-)은 파이프로 넘길 때만 쓸 수 있습니다. 예: pbpaste | oop provider add zai --set apiKey=- -y. 환경 변수(--set apiKey=@변수명)를 쓰거나, --set 없이 실행해 입력 화면에서 가려서 입력하세요.",
        ),
        "providers.cmd.cancelled" => pick("Cancelled.", "취소했습니다."),
        "providers.cmd.dryRunAdd" => pick(
            "--dry-run: this is what would be sent. Secrets are masked.",
            "--dry-run: 아래 내용을 보냅니다. 비밀값은 가려져 있습니다.",
        ),
        "providers.cmd.confirmNeeded" => pick(
            "Confirmation needed. Run it in a terminal, or add -y.",
            "확인이 필요합니다. 터미널에서 실행하거나 -y 를 붙이세요.",
        ),
        "providers.cmd.askAdd" => pick("Add it? [y/N] ", "추가할까요? [y/N] "),
        "providers.cmd.addFailed" => pick(
            "Could not add it: {reason}",
            "추가하지 못했습니다: {reason}",
        ),
        "providers.cmd.unsure" => pick(
            "(Not sure the server received it. Check with oop provider list.)",
            "(서버에 닿았는지 확실하지 않습니다. oop provider list 로 확인하세요)",
        ),
        "providers.cmd.idTaken" => pick(
            "'{id}' is already taken as an ID.",
            "'{id}' 는 이미 있는 ID 입니다.",
        ),
        "providers.cmd.added" => pick("Added: {id} ({kind})", "추가했습니다: {id} ({kind})"),
        "providers.cmd.removeNeedsId" => pick(
            "An ID to remove is required. Usage: oop provider remove <id>",
            "삭제할 ID 가 필요합니다. 사용법: oop provider remove <id>",
        ),
        "providers.cmd.dryRunRemove" => pick(
            "--dry-run: nothing was removed.",
            "--dry-run: 삭제하지 않았습니다.",
        ),
        "providers.cmd.askRemove" => {
            pick("Type yes to remove it: ", "삭제하려면 yes 를 입력하세요: ")
        }
        "providers.cmd.removeFailed" => pick(
            "Could not remove it: {reason}",
            "삭제하지 못했습니다: {reason}",
        ),
        "providers.cmd.alreadyGone" => pick("'{id}' is already gone.", "'{id}' 는 이미 없습니다."),
        "providers.cmd.removed" => pick("Removed: {id}", "삭제했습니다: {id}"),
        "providers.flow.modelsShort" => pick("{count} models", "모델 {count}"),
        "providers.flow.noSettings" => pick(
            "The server settings have not arrived yet.",
            "서버 설정을 아직 받지 못했습니다.",
        ),
        "providers.flow.needsServer" => pick(
            "Available once you are connected to the server.",
            "서버에 연결된 뒤에 쓸 수 있습니다.",
        ),
        "providers.flow.listHint" => pick(
            "/provider add to add • /provider remove <id> to remove",
            "/provider add 추가 • /provider remove <id> 삭제",
        ),
        "providers.flow.notAdded" => pick("Not added (--dry-run)", "추가하지 않음 (--dry-run)"),
        "providers.flow.nothingRemovable" => pick(
            "No provider can be removed. Built-in instances cannot be removed.",
            "지울 수 있는 Provider 가 없습니다. 기본 인스턴스는 지울 수 없습니다.",
        ),
        "providers.flow.notRemoved" => pick("Not removed (--dry-run)", "삭제하지 않음 (--dry-run)"),
        "providers.flow.offline" => pick(
            "Disconnected from the server. Try again once you are connected.",
            "서버와 연결이 끊겨 있습니다. 연결된 뒤 다시 시도하세요.",
        ),
        "providers.flow.adding" => pick("Adding…", "추가하는 중…"),
        "providers.flow.addFailed" => pick("Add failed: {reason}", "추가 실패: {reason}"),
        "providers.flow.unsure" => pick(
            "(Not sure the server received it. Check with /provider.)",
            "(서버에 닿았는지 확실하지 않습니다. /provider 로 확인하세요)",
        ),
        "providers.flow.idRace" => pick(
            "'{id}' was just created elsewhere. Use a different ID.",
            "'{id}' 는 방금 다른 곳에서 만들어졌습니다. 다른 ID 를 쓰세요.",
        ),
        "providers.flow.added" => pick("{id} added ({kind})", "{id} 추가됨 ({kind})"),
        "providers.flow.removing" => pick("Removing…", "삭제하는 중…"),
        "providers.flow.removeFailed" => pick("Remove failed: {reason}", "삭제 실패: {reason}"),
        "providers.flow.removed" => pick("{id} removed", "{id} 삭제됨"),
        "providers.flow.staleSelections" => pick(
            "  Some selections still point at this provider's models. Switch to another model with /model.",
            "  이 Provider 의 모델을 가리키던 선택이 남아 있습니다. /model 에서 다른 모델로 바꾸세요.",
        ),
        "providers.flow.refreshFailed" => pick(
            "  Could not refresh the status. Check again in a moment with /provider.",
            "  상태를 새로 읽지 못했습니다. 잠시 뒤 /provider 로 확인하세요.",
        ),
        "providers.plan.unavailable" => pick("unavailable", "사용 불가"),
        "providers.plan.notInstalled" => pick("not installed", "미설치"),
        "providers.plan.error" => pick("error", "오류"),
        "providers.plan.warning" => pick("warning", "경고"),
        "providers.plan.ready" => pick("ready", "준비됨"),
        "providers.plan.checking" => pick("checking", "확인 중"),
        "providers.plan.builtIn" => pick(
            "'{id}' is the built-in instance of {driver} and cannot be removed. To stop using it, turn it off in the app under Settings > Providers.",
            "'{id}' 는 {driver} 의 기본 인스턴스라 지울 수 없습니다. 쓰지 않으려면 앱의 설정 > Providers 에서 끄세요.",
        ),
        "providers.plan.noSuchProvider" => pick(
            "There is no provider named '{id}'.",
            "'{id}' 라는 Provider 가 없습니다.",
        ),
        "providers.plan.badId" => pick(
            "Invalid ID. It must start with a letter and use only letters, digits, '-' and '_'.",
            "ID 형식이 잘못됐습니다. 영문자로 시작하고 영문자, 숫자, '-', '_' 만 쓸 수 있습니다.",
        ),
        "providers.plan.remove" => pick(
            "Remove: {id} ({name}, {driver})",
            "삭제: {id} ({name}, {driver})",
        ),
        "providers.plan.secrets" => pick(
            "{count} secrets stored on the server will be deleted too.",
            "서버에 저장된 비밀값 {count}개도 함께 지워집니다.",
        ),
        "providers.plan.noSecrets" => pick("No secrets are stored.", "저장된 비밀값은 없습니다."),
        "providers.plan.threadsUnknown" => pick(
            "The thread list has not arrived yet, so the impact is unknown.",
            "스레드 목록을 아직 받지 못해 영향을 알 수 없습니다.",
        ),
        "providers.plan.running" => pick("({count} running)", "(실행 중 {count}개)"),
        "providers.plan.threadsKept" => pick(
            "{count} threads using this provider's models{running} will stay as they are.",
            "이 Provider 의 모델을 쓰는 스레드 {count}개{running}는 그대로 남습니다.",
        ),
        "providers.plan.more" => pick("  … and {count} more", "  … 외 {count}개"),
        "providers.plan.noThreads" => pick(
            "No threads use this provider.",
            "이 Provider 를 쓰는 스레드는 없습니다.",
        ),
        "providers.plan.crewPins" => pick(
            "{count} Crew roles pinned to this provider's models",
            "Crew 에 이 Provider 의 모델로 고정된 역할 {count}개",
        ),
        "providers.plan.textGeneration" => pick(
            "The title and commit message model points at this provider.",
            "제목·커밋 메시지 생성 모델이 이 Provider 를 가리킵니다.",
        ),
        "providers.plan.projects" => pick(
            "{count} projects whose default model is from this provider",
            "기본 모델이 이 Provider 인 프로젝트 {count}개",
        ),
        "providers.plan.notAutomatic" => pick(
            "These selections do not change automatically. Switch to another model after removing.",
            "위 선택은 자동으로 바뀌지 않습니다. 삭제 뒤 다른 모델로 바꾸세요.",
        ),
        "providers.field.binaryPath" => pick("Executable path", "실행 파일 경로"),
        "providers.field.homePath" => pick("Home folder", "홈 폴더"),
        "providers.field.shadowHomePath" => pick("Per-account home folder", "계정별 홈 폴더"),
        "providers.field.launchArgs" => pick("Launch arguments", "실행 인자"),
        "providers.field.telemetry" => pick("Send usage statistics", "사용 통계 전송"),
        "providers.field.authMethod" => pick("Sign-in method", "로그인 방식"),
        "providers.field.apiKey" => pick("API key", "API 키"),
        "providers.field.gcpProject" => pick("GCP project", "GCP 프로젝트"),
        "providers.field.gcpLocation" => pick("GCP region", "GCP 지역"),
        "providers.field.serverUrl" => pick("Server URL", "서버 주소"),
        "providers.field.serverPassword" => pick("Server password", "서버 비밀번호"),
        "providers.field.apiEndpoint" => pick("API endpoint", "API 주소"),
        "providers.field.bridgePath" => pick("ACP bridge path", "ACP 브리지 경로"),
        "providers.field.autoCompactWindow" => {
            pick("Auto-compact threshold (tokens)", "자동 압축 기준(토큰)")
        }
        "providers.field.claudeAiConnectors" => pick("claude.ai connectors", "claude.ai 커넥터"),
        "providers.spec.service" => pick("Service", "서비스"),
        "providers.spec.model" => pick("Model", "모델"),
        "providers.spec.openCodePath" => pick("OpenCode path", "OpenCode 경로"),
        "providers.spec.idRequired" => pick("An ID is required.", "ID 가 필요합니다."),
        "providers.spec.idTooLong" => pick(
            "The ID must be {max} characters or fewer.",
            "ID 는 {max}자 이하여야 합니다.",
        ),
        "providers.spec.idShape" => pick(
            "The ID must start with a letter and use only letters, digits, '-' and '_'.",
            "ID 는 영문자로 시작하고 영문자, 숫자, '-', '_' 만 쓸 수 있습니다.",
        ),
        "providers.spec.idBuiltIn" => pick(
            "'{id}' is the ID of a built-in instance and cannot be used.",
            "'{id}' 는 기본 인스턴스의 ID 라서 쓸 수 없습니다.",
        ),
        "providers.spec.envNameRequired" => pick(
            "An environment variable name is required.",
            "환경 변수 이름이 필요합니다.",
        ),
        "providers.spec.envNameTooLong" => pick(
            "The environment variable name must be {max} characters or fewer.",
            "환경 변수 이름은 {max}자 이하여야 합니다.",
        ),
        "providers.spec.envNameShape" => pick(
            "The environment variable name is malformed. It must start with a letter or '_' and use only letters, digits and '_'.",
            "환경 변수 이름 형식이 잘못됐습니다. 영문자나 '_' 로 시작하고 영문자, 숫자, '_' 만 쓸 수 있습니다.",
        ),
        "providers.spec.fieldRequired" => {
            pick("{label} is required.", "{label} 이(가) 필요합니다.")
        }
        "providers.spec.presetFixes" => pick(
            "{name} is already set by this preset.",
            "{name} 은(는) 이 프리셋이 이미 정합니다.",
        ),
        "providers.spec.secretSet" => pick("set (masked)", "설정됨 (가려짐)"),
        "providers.spec.defaultName" => pick("(default: {name})", "(기본: {name})"),
        "providers.spec.envLabel" => pick("Environment variable {name}", "환경 변수 {name}"),
        "providers.spec.adviceOpenCode" => pick(
            "{label} runs on the OpenCode 1.14.19 or later installed on this computer.",
            "{label} 는 이 컴퓨터에 설치된 OpenCode 1.14.19 이상으로 실행됩니다.",
        ),
        "providers.spec.adviceGoogle" => pick(
            "Google sign-in needs a browser. Sign in from the OOP app under Settings > Providers.",
            "Google 로그인은 브라우저가 필요합니다. OOP 앱의 설정 > Providers 에서 로그인하세요.",
        ),
        "providers.spec.adviceLogin" => pick(
            "If a sign-in is needed, sign in with that CLI or from the OOP app under Settings > Providers.",
            "로그인이 필요하면 해당 CLI 에서 로그인하거나 OOP 앱의 설정 > Providers 에서 하세요.",
        ),
        "providers.screen.typeYesWarn" => pick(
            "Type yes to remove it. Esc cancels.",
            "삭제하려면 yes 를 입력하세요. 취소는 Esc 입니다.",
        ),
        "providers.screen.none" => pick("(none)", "(없음)"),
        "providers.screen.defaultValue" => pick("(default)", "(기본값)"),
        "providers.screen.runsOnOpenCode" => pick("Runs on OpenCode", "OpenCode 로 실행"),
        "providers.screen.pickAdd" => {
            pick("Choose a provider to add", "추가할 Provider 를 고르세요")
        }
        "providers.screen.hintPick" => pick(
            "↑/↓ move • 1-9 pick • Enter next • Esc close",
            "↑/↓ 이동 • 1-9 선택 • Enter 다음 • Esc 닫기",
        ),
        "providers.screen.optional" => pick("optional", "선택"),
        "providers.screen.needed" => pick("(required)", "(필요)"),
        "providers.screen.required" => pick("required", "필수"),
        "providers.screen.autoFromName" => pick("auto from name", "이름에서 자동"),
        "providers.screen.next" => pick("Next: review", "다음: 확인"),
        "providers.screen.nextNote" => pick("See the summary, then add", "요약을 보고 추가합니다"),
        "providers.screen.formTitle" => pick("Add {kind}", "{kind} 추가"),
        "providers.screen.hintForm" => pick(
            "↑/↓ move • Enter edit • Esc back",
            "↑/↓ 이동 • Enter 편집 • Esc 뒤로",
        ),
        "providers.screen.formNote" => pick(
            "Kind {driver} · secrets you type are never shown on screen",
            "종류 {driver} · 비밀값은 입력해도 화면에 나오지 않습니다",
        ),
        "providers.screen.current" => pick("current", "현재"),
        "providers.screen.hintChoose" => pick(
            "↑/↓ move • Enter choose • Esc back",
            "↑/↓ 이동 • Enter 선택 • Esc 뒤로",
        ),
        "providers.screen.reviewTitle" => pick("Add {kind}?", "{kind} 추가할까요?"),
        "providers.screen.add" => pick("Add", "추가"),
        "providers.screen.back" => pick("Go back", "돌아가기"),
        "providers.screen.hintReview" => pick(
            "↑/↓ move • Enter run • Esc back",
            "↑/↓ 이동 • Enter 실행 • Esc 뒤로",
        ),
        "providers.screen.pickRemove" => {
            pick("Choose a provider to remove", "삭제할 Provider 를 고르세요")
        }
        "providers.screen.hintRemove" => pick("Enter remove • Esc cancel", "Enter 삭제 • Esc 취소"),
        "providers.screen.hintId" => pick(
            "Start with a letter; letters, digits, - and _ only, up to 64 characters. Leave empty to build it from the name.",
            "영문자로 시작, 영문자·숫자·-·_ 만, 64자까지. 비우면 이름에서 만듭니다",
        ),
        "providers.screen.hintName" => pick(
            "Leave empty to use the kind's name.",
            "비우면 종류 이름을 씁니다",
        ),
        "providers.screen.hintSecret" => pick(
            "What you type is not shown. Press Enter on an empty line to keep it as is.",
            "입력한 값은 화면에 나오지 않습니다. 비우고 Enter 면 그대로 둡니다",
        ),
        "providers.screen.editTitle" => pick("Enter {label}", "{label} 입력"),
        "providers.screen.idExample" => pick("e.g. codex_work", "예: codex_work"),
        "providers.screen.hintEdit" => pick("Enter confirm • Esc cancel", "Enter 확인 • Esc 취소"),
        "link.serverRefused" => pick(
            "The server refused the connection{detail}",
            "서버가 연결을 거부했습니다{detail}",
        ),
        "link.serverUnreachable" => pick(
            "Could not connect to the server. Check that the OOP app or the terminal server is running.",
            "서버에 연결하지 못했습니다. OOP 앱이나 터미널 서버가 실행 중인지 확인하세요.",
        ),
        other => panic!("no provider text for {other}"),
    }
}
