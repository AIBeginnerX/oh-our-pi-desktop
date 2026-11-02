import { defineMessages } from "./define.ts";

/** The pinned header (logo, live status, Mocha) and the `/pet` command. */
export const header = defineMessages(
  {
    "render.header.state.idle": "Idle",
    "render.header.state.working": "Working",
    "render.header.state.waiting": "Needs you",
    "render.header.state.error": "Error",
    "render.header.state.offline": "Offline",
    "render.header.state.none": "Ready",
    "render.region.panelClosed": "Right panel closed: {reason}",
    "render.header.noThread": "No thread open",
    "render.header.noModel": "No model",
    "render.header.thread": "Thread ",
    "render.header.folder": "Folder ",
    "render.header.crew": "Crew ",
    "session.c.petOn": "Mocha is on.",
    "session.c.petOff": "Mocha is off.",
    "session.c.petUsage": "Usage: /pet [on|off]",
    "session.c.petNoHeader":
      "Mocha lives in the header, which needs the banner and the side-by-side layout.",
    "session.c.help.pet":
      "/pet shows or hides Mocha, the coffee mug in the header (typed again it toggles) • her coffee takes the colour of the provider that answers • she steams when idle, brews while the model thinks, bounces as text arrives, and sleeps when you are away • she holds still with animations off or while the terminal is unfocused • the choice is remembered (oop config set pet true|false)",
    "session.slash.pet.note": "Show or hide Mocha in the header",
    "session.slash.pet.usage": "[on|off]",
  },
  {
    "render.header.state.idle": "대기 중",
    "render.header.state.working": "작업 중",
    "render.header.state.waiting": "응답 필요",
    "render.header.state.error": "오류",
    "render.header.state.offline": "연결 끊김",
    "render.header.state.none": "준비됨",
    "render.region.panelClosed": "오른쪽 창을 닫았습니다: {reason}",
    "render.header.noThread": "열린 스레드 없음",
    "render.header.noModel": "모델 없음",
    "render.header.thread": "스레드 ",
    "render.header.folder": "폴더 ",
    "render.header.crew": "크루 ",
    "session.c.petOn": "모카를 켰습니다.",
    "session.c.petOff": "모카를 껐습니다.",
    "session.c.petUsage": "사용법: /pet [on|off]",
    "session.c.petNoHeader": "모카는 헤더에 있으므로 배너와 나란히 보기 화면이 필요합니다.",
    "session.c.help.pet":
      "/pet 으로 헤더의 커피잔 모카를 보이거나 숨깁니다 (다시 치면 전환) • 커피 색은 답하는 제공자에 따라 바뀝니다 • 대기 중엔 김이 오르고, 생각할 땐 끓고, 글이 올 땐 들썩이고, 자리를 비우면 잠듭니다 • 애니메이션이 꺼져 있거나 터미널이 포커스를 잃으면 가만히 있습니다 • 선택은 기억됩니다 (oop config set pet true|false)",
    "session.slash.pet.note": "헤더의 모카 보이기·숨기기",
    "session.slash.pet.usage": "[on|off]",
  },
);
