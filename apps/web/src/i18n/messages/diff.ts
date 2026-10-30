import type { MessageCatalog } from "./types";

/** The Diff panel and terminal. */
export const DIFF_MESSAGES: MessageCatalog = {
  "1 file": { ko: "파일 1개", ja: "1 ファイル", "zh-CN": "1 个文件", es: "1 archivo" },
  "{count} files": {
    ko: "파일 {count}개",
    ja: "{count} ファイル",
    "zh-CN": "{count} 个文件",
    es: "{count} archivos",
  },
  "Mark {path} as viewed": {
    ko: "{path}을(를) 확인함으로 표시",
    ja: "{path} を確認済みにする",
    "zh-CN": "将 {path} 标记为已查看",
    es: "Marcar {path} como visto",
  },
  "Next turn": { ko: "다음 턴", ja: "次のターン", "zh-CN": "下一轮", es: "Turno siguiente" },
  "Previous turn": {
    ko: "이전 턴",
    ja: "前のターン",
    "zh-CN": "上一轮",
    es: "Turno anterior",
  },
  "Process running": {
    ko: "프로세스 실행 중",
    ja: "プロセス実行中",
    "zh-CN": "进程运行中",
    es: "Proceso en ejecución",
  },
  Viewed: { ko: "확인함", ja: "確認済み", "zh-CN": "已查看", es: "Visto" },
  "Whitespace hidden": {
    ko: "공백 변경 숨김",
    ja: "空白の変更を非表示",
    "zh-CN": "已隐藏空白变更",
    es: "Espacios ocultos",
  },
  "Whitespace-only changes are not shown. Use the whitespace toggle to show them.": {
    ko: "공백만 바뀐 변경은 표시되지 않습니다. 공백 토글로 표시할 수 있습니다.",
    ja: "空白のみの変更は表示されません。空白の切り替えで表示できます。",
    "zh-CN": "仅空白的变更不会显示。使用空白开关可显示它们。",
    es: "No se muestran los cambios que solo afectan a espacios. Usa el interruptor de espacios para verlos.",
  },
};
