import { defineMessages } from "./define.ts";

export const settings = defineMessages(
  {
    "settings.expected.theme": "a theme name",
    "settings.reason.unreadable": "cannot be read",
    "settings.reason.notJson": "not JSON",
    "settings.reason.notObject": "not an object",
    "settings.warn.damaged":
      "Ignoring the settings file and starting with defaults ({reason}): {file}",
    "settings.warn.invalidValue":
      "Ignored an invalid value for {key} in settings.json ({expected}).",
    "settings.err.damaged":
      "The settings file is damaged, so it was left untouched ({reason}): {file}",
    "settings.err.saveFailed": "Could not save the setting: {message}",
    "settings.warn.themeFallback": "{error} (starting with {fallback})",
    "settings.theme.listHint": "{error} — run /theme to see the list.",
    "settings.theme.envWins": "OOP_THEME takes priority, so this will not apply next time",
    "settings.theme.selected": "Theme: {name}",
    "settings.theme.selectedNotes": "Theme: {name} ({notes})",
    "settings.default": "(default)",
    "settings.fromEnv": " (environment variable)",
    "settings.err.unknownKey": "Unknown setting: {key} ({keys})",
    "settings.err.badValue": "{key} only accepts {expected}.",
    "settings.err.unknownTheme": "Unknown theme: {value} ({themes})",
    "settings.warn.envWins":
      "An environment variable takes priority, so this value does not apply right now.",
  },
  {
    "settings.expected.theme": "테마 이름",
    "settings.reason.unreadable": "읽을 수 없음",
    "settings.reason.notJson": "JSON이 아님",
    "settings.reason.notObject": "객체가 아님",
    "settings.warn.damaged": "설정 파일을 쓰지 않고 기본값으로 시작합니다 ({reason}): {file}",
    "settings.warn.invalidValue":
      "settings.json 의 {key} 값이 올바르지 않아 무시했습니다 ({expected}).",
    "settings.err.damaged": "설정 파일이 손상되어 건드리지 않았습니다 ({reason}): {file}",
    "settings.err.saveFailed": "설정을 저장하지 못했습니다: {message}",
    "settings.warn.themeFallback": "{error} ({fallback} 로 시작합니다)",
    "settings.theme.listHint": "{error} — /theme 로 목록을 확인하세요.",
    "settings.theme.envWins": "OOP_THEME 이 우선하므로 다음 실행에는 적용되지 않습니다",
    "settings.theme.selected": "테마: {name}",
    "settings.theme.selectedNotes": "테마: {name} ({notes})",
    "settings.default": "(기본)",
    "settings.fromEnv": " (환경 변수)",
    "settings.err.unknownKey": "알 수 없는 설정: {key} ({keys})",
    "settings.err.badValue": "{key} 에는 {expected} 만 쓸 수 있습니다.",
    "settings.err.unknownTheme": "알 수 없는 테마: {value} ({themes})",
    "settings.warn.envWins": "환경 변수가 우선하므로 이 값은 지금 적용되지 않습니다.",
  },
);
