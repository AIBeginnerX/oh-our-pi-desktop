/**
 * The native application menu's languages. The strings mirror the Electron defaults in English
 * so a label override never changes what a role does, and `{app}` is replaced with the running
 * app's name at build time.
 */
export type MenuLanguage = "en" | "ko" | "ja" | "zh-CN" | "es";

export interface MenuLabels {
  readonly about: string;
  readonly checkForUpdates: string;
  readonly settings: string;
  readonly services: string;
  readonly hide: string;
  readonly hideOthers: string;
  readonly showAll: string;
  readonly quit: string;
  readonly file: string;
  readonly close: string;
  readonly edit: string;
  readonly undo: string;
  readonly redo: string;
  readonly cut: string;
  readonly copy: string;
  readonly paste: string;
  readonly pasteAsText: string;
  readonly remove: string;
  readonly selectAll: string;
  readonly speech: string;
  readonly startSpeaking: string;
  readonly stopSpeaking: string;
  readonly view: string;
  readonly reload: string;
  readonly forceReload: string;
  readonly toggleDevTools: string;
  readonly actualSize: string;
  readonly zoomIn: string;
  readonly zoomOut: string;
  readonly toggleFullScreen: string;
  readonly window: string;
  readonly minimize: string;
  readonly zoom: string;
  readonly bringAllToFront: string;
  readonly help: string;
}

export const MENU_LANGUAGES: Record<MenuLanguage, MenuLabels> = {
  en: {
    about: "About {app}",
    checkForUpdates: "Check for Updates...",
    settings: "Settings...",
    services: "Services",
    hide: "Hide {app}",
    hideOthers: "Hide Others",
    showAll: "Show All",
    quit: "Quit {app}",
    file: "File",
    close: "Close Window",
    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    pasteAsText: "Paste as Text",
    remove: "Delete",
    selectAll: "Select All",
    speech: "Speech",
    startSpeaking: "Start Speaking",
    stopSpeaking: "Stop Speaking",
    view: "View",
    reload: "Reload",
    forceReload: "Force Reload",
    toggleDevTools: "Toggle Developer Tools",
    actualSize: "Actual Size",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    toggleFullScreen: "Toggle Full Screen",
    window: "Window",
    minimize: "Minimize",
    zoom: "Zoom",
    bringAllToFront: "Bring All to Front",
    help: "Help",
  },
  ko: {
    about: "{app} 정보",
    checkForUpdates: "업데이트 확인...",
    settings: "설정...",
    services: "서비스",
    hide: "{app} 숨기기",
    hideOthers: "다른 앱 숨기기",
    showAll: "모두 보기",
    quit: "{app} 종료",
    file: "파일",
    close: "닫기",
    edit: "편집",
    undo: "실행 취소",
    redo: "다시 실행",
    cut: "잘라내기",
    copy: "복사",
    paste: "붙여넣기",
    pasteAsText: "텍스트로 붙여넣기",
    remove: "삭제",
    selectAll: "모두 선택",
    speech: "음성",
    startSpeaking: "읽기 시작",
    stopSpeaking: "읽기 중지",
    view: "보기",
    reload: "다시 로드",
    forceReload: "강제로 다시 로드",
    toggleDevTools: "개발자 도구 전환",
    actualSize: "실제 크기",
    zoomIn: "확대",
    zoomOut: "축소",
    toggleFullScreen: "전체 화면 전환",
    window: "윈도우",
    minimize: "최소화",
    zoom: "확대/축소",
    bringAllToFront: "모두 앞으로 가져오기",
    help: "도움말",
  },
  ja: {
    about: "{app} について",
    checkForUpdates: "アップデートを確認...",
    settings: "設定...",
    services: "サービス",
    hide: "{app} を隠す",
    hideOthers: "ほかを隠す",
    showAll: "すべて表示",
    quit: "{app} を終了",
    file: "ファイル",
    close: "閉じる",
    edit: "編集",
    undo: "取り消す",
    redo: "やり直す",
    cut: "切り取り",
    copy: "コピー",
    paste: "貼り付け",
    pasteAsText: "テキストとして貼り付け",
    remove: "削除",
    selectAll: "すべて選択",
    speech: "スピーチ",
    startSpeaking: "読み上げを開始",
    stopSpeaking: "読み上げを停止",
    view: "表示",
    reload: "再読み込み",
    forceReload: "強制的に再読み込み",
    toggleDevTools: "開発者ツールの切り替え",
    actualSize: "実際のサイズ",
    zoomIn: "拡大",
    zoomOut: "縮小",
    toggleFullScreen: "フルスクリーンを切り替え",
    window: "ウィンドウ",
    minimize: "最小化",
    zoom: "ズーム",
    bringAllToFront: "すべてを手前に移動",
    help: "ヘルプ",
  },
  "zh-CN": {
    about: "关于 {app}",
    checkForUpdates: "检查更新...",
    settings: "设置...",
    services: "服务",
    hide: "隐藏 {app}",
    hideOthers: "隐藏其他",
    showAll: "显示全部",
    quit: "退出 {app}",
    file: "文件",
    close: "关闭",
    edit: "编辑",
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    pasteAsText: "粘贴为纯文本",
    remove: "删除",
    selectAll: "全选",
    speech: "语音",
    startSpeaking: "开始朗读",
    stopSpeaking: "停止朗读",
    view: "查看",
    reload: "重新加载",
    forceReload: "强制重新加载",
    toggleDevTools: "切换开发者工具",
    actualSize: "实际大小",
    zoomIn: "放大",
    zoomOut: "缩小",
    toggleFullScreen: "切换全屏显示",
    window: "窗口",
    minimize: "最小化",
    zoom: "缩放",
    bringAllToFront: "前置全部窗口",
    help: "帮助",
  },
  es: {
    about: "Acerca de {app}",
    checkForUpdates: "Buscar actualizaciones...",
    settings: "Ajustes...",
    services: "Servicios",
    hide: "Ocultar {app}",
    hideOthers: "Ocultar otros",
    showAll: "Mostrar todo",
    quit: "Salir de {app}",
    file: "Archivo",
    close: "Cerrar",
    edit: "Editar",
    undo: "Deshacer",
    redo: "Rehacer",
    cut: "Cortar",
    copy: "Copiar",
    paste: "Pegar",
    pasteAsText: "Pegar como texto",
    remove: "Eliminar",
    selectAll: "Seleccionar todo",
    speech: "Voz",
    startSpeaking: "Empezar a hablar",
    stopSpeaking: "Dejar de hablar",
    view: "Ver",
    reload: "Recargar",
    forceReload: "Forzar recarga",
    toggleDevTools: "Alternar herramientas de desarrollador",
    actualSize: "Tamaño real",
    zoomIn: "Acercar",
    zoomOut: "Alejar",
    toggleFullScreen: "Alternar pantalla completa",
    window: "Ventana",
    minimize: "Minimizar",
    zoom: "Zoom",
    bringAllToFront: "Traer todo al frente",
    help: "Ayuda",
  },
};

/**
 * Resolves the menu's language from the setting and the OS locale (`system` follows it). Only the
 * languages the menu ships are resolved; every other locale keeps the English menu, and any
 * Chinese variant resolves to Simplified Chinese because that is the only Chinese translation.
 */
export function resolveMenuLanguage(
  setting: "system" | MenuLanguage,
  systemLocale: string,
): MenuLanguage {
  if (setting !== "system") return setting;
  const primary = systemLocale.split("-")[0]?.toLowerCase() ?? "";
  switch (primary) {
    case "ko":
      return "ko";
    case "ja":
      return "ja";
    case "zh":
      return "zh-CN";
    case "es":
      return "es";
    default:
      return "en";
  }
}

/** Replaces the `{app}` placeholder in the labels that name the application. */
export function menuLabel(labels: MenuLabels, key: "about" | "hide" | "quit", appName: string) {
  return labels[key].replace("{app}", appName);
}
