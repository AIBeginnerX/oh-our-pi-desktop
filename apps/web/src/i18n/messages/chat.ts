import type { MessageCatalog } from "./types";

/** The conversation timeline and composer. */
export const CHAT_MESSAGES: MessageCatalog = {
  "{count} failed": {
    ko: "{count}개 실패",
    ja: "{count}件失敗",
    "zh-CN": "{count} 个失败",
    es: "{count} con error",
  },
  "Restoring checkpoint…": {
    ko: "체크포인트 복원 중…",
    ja: "チェックポイントを復元中…",
    "zh-CN": "正在恢复检查点…",
    es: "Restaurando punto de control…",
  },
  "Expand ({count} lines)": {
    ko: "펼치기 ({count}줄)",
    ja: "展開 ({count}行)",
    "zh-CN": "展开（{count} 行）",
    es: "Expandir ({count} líneas)",
  },
  Collapse: { ko: "접기", ja: "折りたたむ", "zh-CN": "收起", es: "Contraer" },
  "Needs your input": {
    ko: "입력이 필요합니다",
    ja: "入力が必要です",
    "zh-CN": "需要你的输入",
    es: "Necesita tu respuesta",
  },
  "Your message will be queued while the agent works": {
    ko: "에이전트가 작업하는 동안 메시지는 대기열에 추가됩니다",
    ja: "エージェントの作業中、メッセージはキューに追加されます",
    "zh-CN": "智能体工作期间，消息将加入队列",
    es: "Tu mensaje se pondrá en cola mientras el agente trabaja",
  },
  "Your message will be queued while the agent works ({shortcut} sends the next one now)": {
    ko: "에이전트가 작업하는 동안 메시지는 대기열에 추가됩니다 ({shortcut}: 다음 메시지 바로 보내기)",
    ja: "エージェントの作業中、メッセージはキューに追加されます ({shortcut}: 次のメッセージを今すぐ送信)",
    "zh-CN": "智能体工作期间，消息将加入队列（{shortcut} 立即发送下一条）",
    es: "Tu mensaje se pondrá en cola mientras el agente trabaja ({shortcut} envía el siguiente ahora)",
  },
  Total: { ko: "합계", ja: "合計", "zh-CN": "总计", es: "Total" },
  Less: { ko: "적음", ja: "少", "zh-CN": "少", es: "Menos" },
  More: { ko: "많음", ja: "多", "zh-CN": "多", es: "Más" },
  "no data": { ko: "데이터 없음", ja: "データなし", "zh-CN": "无数据", es: "sin datos" },
};
