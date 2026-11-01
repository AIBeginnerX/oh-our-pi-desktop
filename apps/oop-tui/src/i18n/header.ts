import { defineMessages } from "./define.ts";

/** The pinned header (logo, live status, pet) and the `/pet` command. */
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
    "render.header.server": "Server ",
    "session.c.petOn": "The pet is on.",
    "session.c.petOff": "The pet is off.",
    "session.c.petUsage": "Usage: /pet [on|off]",
    "session.c.petNoHeader":
      "The pet lives in the header, which needs the banner and the side-by-side layout.",
    "session.c.help.pet":
      "/pet shows or hides the pet in the header (typed again it toggles) • it moves only while a turn runs and sleeps when you are away • it stands still with animations off or while the terminal is unfocused • the choice is remembered (oop config set pet true|false)",
    "session.slash.pet.note": "Show or hide the pet in the header",
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
    "render.header.server": "서버 ",
    "session.c.petOn": "펫을 켰습니다.",
    "session.c.petOff": "펫을 껐습니다.",
    "session.c.petUsage": "사용법: /pet [on|off]",
    "session.c.petNoHeader": "펫은 헤더에 있으므로 배너와 나란히 보기 화면이 필요합니다.",
    "session.c.help.pet":
      "/pet 으로 헤더의 펫을 보이거나 숨깁니다 (다시 치면 전환) • 턴이 진행되는 동안에만 움직이고 자리를 비우면 잠듭니다 • 애니메이션이 꺼져 있거나 터미널이 포커스를 잃으면 가만히 서 있습니다 • 선택은 기억됩니다 (oop config set pet true|false)",
    "session.slash.pet.note": "헤더의 펫 보이기·숨기기",
    "session.slash.pet.usage": "[on|off]",
  },
);
