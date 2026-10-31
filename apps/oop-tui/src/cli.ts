import type { RuntimeMode } from "@t3tools/contracts";

import {
  echoWord,
  resolveProviderRequest,
  type ProviderRequest,
  type RawFlag,
} from "./app/providerArgs.ts";
import type { ConfigAction } from "./settings.ts";

export type CliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | {
      readonly kind: "pair";
      readonly target: string;
      readonly server: string | null;
      readonly home: string | null;
    }
  | {
      readonly kind: "run";
      readonly continueLast: boolean;
      readonly server: string | null;
      readonly home: string | null;
      readonly runtimeMode: RuntimeMode | null;
      /** The message from `oop "..."`, sent as soon as the conversation is open. */
      readonly prompt: string | null;
    }
  | { readonly kind: "config"; readonly config: ConfigAction }
  | { readonly kind: "doctor"; readonly home: string | null }
  | { readonly kind: "stop"; readonly home: string | null }
  | {
      readonly kind: "update";
      readonly server: string | null;
      readonly home: string | null;
    }
  | {
      readonly kind: "provider";
      readonly request: ProviderRequest;
      readonly server: string | null;
      readonly home: string | null;
    }
  | { readonly kind: "error"; readonly message: string };

/** The words that start a command of their own; any other first word is the start of a message. */
const COMMAND_WORDS = new Set(["pair", "config", "doctor", "stop", "update", "provider"]);

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

export const HELP_TEXT = `oop - OOP 터미널 코딩 어시스턴트

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
  oop config set <키> <값>   설정 바꾸기 (theme, symbols, animations, banner, statusLine, notify)
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
채팅 안에서는 /theme 으로 색 테마를 고르고, /stats 로 도구 사용 통계를, /update 로 새 릴리스를, /help 로 명령과 키를 봅니다.

스레드는 데스크톱 앱과 공유됩니다. 페어링 링크는 앱의 연결 설정에서 만들 수 있습니다.
터미널이 띄운 서버는 oop 을 닫아도 계속 실행됩니다 (oop stop 으로 멈춤). 앱을 켜면 앱이 서버를
이어받고 oop 이 알아서 다시 연결합니다. 이때 진행 중인 턴은 끊깁니다.
`;

export const parseArgs = (argv: ReadonlyArray<string>): CliCommand => {
  let continueLast = false;
  let server: string | null = null;
  let home: string | null = null;
  let runtimeMode: RuntimeMode | null = null;
  const positional: string[] = [];
  const providerFlags: RawFlag[] = [];
  // After `--` every word is taken as it is, dashes included. `--` before any word makes the
  // whole line a message (`oop -- stop`); after a command's name it only protects the words behind it.
  let literal = false;
  let messageFirst = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (literal) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      messageFirst = positional.length === 0;
      continue;
    }
    const inline =
      arg.startsWith("--") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : null;
    const name = inline !== null ? arg.slice(0, arg.indexOf("=")) : arg;
    const value = (): string | null => {
      if (inline !== null) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) return null;
      index += 1;
      return next;
    };
    switch (name) {
      case "-h":
      case "--help":
        return { kind: "help" };
      case "-v":
      case "--version":
        return { kind: "version" };
      case "-c":
      case "--continue":
        continueLast = true;
        break;
      case "--server": {
        const next = value();
        if (next === null) return { kind: "error", message: "--server 에는 주소가 필요합니다." };
        server = next;
        break;
      }
      case "--home": {
        const next = value();
        if (next === null) return { kind: "error", message: "--home 에는 폴더 경로가 필요합니다." };
        home = next;
        break;
      }
      case "--mode": {
        const next = value();
        const mode = RUNTIME_MODES.find((candidate) => candidate === next);
        if (mode === undefined) {
          return {
            kind: "error",
            message: `--mode 는 ${RUNTIME_MODES.join(" | ")} 중 하나여야 합니다.`,
          };
        }
        runtimeMode = mode;
        break;
      }
      case "-y":
      case "--yes":
        providerFlags.push({ name: "--yes", value: null });
        break;
      case "--dry-run":
        providerFlags.push({ name: "--dry-run", value: null });
        break;
      case "--id":
      case "--name":
      case "--set":
      case "--env":
      case "--secret": {
        const next = value();
        if (next === null) return { kind: "error", message: `${name} 에는 값이 필요합니다.` };
        providerFlags.push({ name, value: next });
        break;
      }
      default:
        if (arg.startsWith("-") && arg.length > 1) {
          return { kind: "error", message: `알 수 없는 옵션: ${echoWord(arg)}` };
        }
        positional.push(arg);
    }
  }

  const [command, ...rest] = positional;
  if (providerFlags.length > 0 && command !== "provider") {
    return { kind: "error", message: `알 수 없는 옵션: ${providerFlags[0]?.name}` };
  }
  if (command === undefined) {
    return { kind: "run", continueLast, server, home, runtimeMode, prompt: null };
  }
  if (messageFirst || !COMMAND_WORDS.has(command)) {
    const prompt = positional.join(" ").trim();
    if (prompt === "") return { kind: "error", message: "프롬프트가 비어 있습니다." };
    // A lone word that looks like a command name is most likely a mistyped command, not a message.
    if (!messageFirst && positional.length === 1 && /^[A-Za-z][\w-]*$/u.test(prompt)) {
      return {
        kind: "error",
        message: `알 수 없는 명령: ${echoWord(prompt)} (한 단어짜리 메시지는 oop -- ${echoWord(prompt)} 로 보냅니다)`,
      };
    }
    return { kind: "run", continueLast, server, home, runtimeMode, prompt };
  }
  if (command === "pair") {
    const target = rest.join("").trim();
    if (target === "")
      return { kind: "error", message: "oop pair 에는 페어링 링크 또는 토큰이 필요합니다." };
    return { kind: "pair", target, server, home };
  }
  if (command === "config") {
    const [action, key, value, ...extra] = rest;
    if (extra.length === 0) {
      if (action === undefined) return { kind: "config", config: { action: "list" } };
      if (action === "path" && key === undefined) {
        return { kind: "config", config: { action: "path" } };
      }
      if (action === "get" && key !== undefined && value === undefined) {
        return { kind: "config", config: { action: "get", key } };
      }
      if (action === "set" && key !== undefined && value !== undefined) {
        return { kind: "config", config: { action: "set", key, value } };
      }
    }
    return {
      kind: "error",
      message: "사용법: oop config [get <키> | set <키> <값> | path]",
    };
  }
  if (command === "doctor") {
    return rest.length === 0
      ? { kind: "doctor", home }
      : { kind: "error", message: "사용법: oop doctor" };
  }
  if (command === "stop") {
    return rest.length === 0
      ? { kind: "stop", home }
      : { kind: "error", message: "사용법: oop stop" };
  }
  if (command === "update") {
    return rest.length === 0
      ? { kind: "update", server, home }
      : { kind: "error", message: "사용법: oop update" };
  }
  // The last command word: `provider`.
  const request = resolveProviderRequest(rest, providerFlags, "cli");
  return request.ok
    ? { kind: "provider", request: request.value, server, home }
    : { kind: "error", message: request.message };
};
