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
  "This turn has been quiet for a while": {
    ko: "이 턴이 한동안 조용합니다",
    ja: "このターンはしばらく応答がありません",
    "zh-CN": "这一轮已经安静了一段时间",
    es: "Este turno lleva un rato en silencio",
  },
  "No activity for {minutes} minutes. The agent may still be working.": {
    ko: "{minutes}분 동안 활동이 없습니다. 에이전트가 아직 작업 중일 수 있습니다.",
    ja: "{minutes}分間動きがありません。エージェントはまだ作業中の可能性があります。",
    "zh-CN": "已有 {minutes} 分钟没有活动。智能体可能仍在工作。",
    es: "Sin actividad durante {minutes} minutos. Es posible que el agente siga trabajando.",
  },
  "Dismiss quiet turn notice": {
    ko: "조용한 턴 알림 닫기",
    ja: "応答なしの通知を閉じる",
    "zh-CN": "关闭无响应提示",
    es: "Descartar el aviso de turno en silencio",
  },
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
