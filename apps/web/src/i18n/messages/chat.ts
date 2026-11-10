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
  "Your message will be delivered when the background agents finish. Stop ends them too.": {
    ko: "메시지는 백그라운드 에이전트가 끝나면 전달됩니다. 중지하면 에이전트도 함께 종료됩니다.",
    ja: "メッセージはバックグラウンドエージェントの完了後に送信されます。停止するとエージェントも終了します。",
    "zh-CN": "消息将在后台智能体完成后送达。停止会同时结束它们。",
    es: "Tu mensaje se entregará cuando terminen los agentes en segundo plano. Detener también los termina.",
  },
  "Stop background agents too?": {
    ko: "백그라운드 에이전트도 중지할까요?",
    ja: "バックグラウンドエージェントも停止しますか?",
    "zh-CN": "要同时停止后台智能体吗?",
    es: "¿Detener también los agentes en segundo plano?",
  },
  "1 background agent is still running. Stopping ends it and its work. Queued messages return to the composer.":
    {
      ko: "백그라운드 에이전트 1개가 아직 실행 중입니다. 중지하면 에이전트와 작업이 종료됩니다. 대기 중인 메시지는 입력창으로 돌아옵니다.",
      ja: "バックグラウンドエージェントが1件まだ実行中です。停止するとエージェントとその作業が終了します。キュー内のメッセージは入力欄に戻ります。",
      "zh-CN": "仍有 1 个后台智能体在运行。停止会结束它及其工作。排队的消息将回到输入框。",
      es: "Aún hay 1 agente en segundo plano en ejecución. Detener lo termina junto con su trabajo. Los mensajes en cola vuelven al cuadro de texto.",
    },
  "{count} background agents are still running. Stopping ends them and their work. Queued messages return to the composer.":
    {
      ko: "백그라운드 에이전트 {count}개가 아직 실행 중입니다. 중지하면 에이전트와 작업이 종료됩니다. 대기 중인 메시지는 입력창으로 돌아옵니다.",
      ja: "バックグラウンドエージェントが{count}件まだ実行中です。停止するとエージェントとその作業が終了します。キュー内のメッセージは入力欄に戻ります。",
      "zh-CN": "仍有 {count} 个后台智能体在运行。停止会结束它们及其工作。排队的消息将回到输入框。",
      es: "Aún hay {count} agentes en segundo plano en ejecución. Detener los termina junto con su trabajo. Los mensajes en cola vuelven al cuadro de texto.",
    },
  "Keep running": {
    ko: "계속 실행",
    ja: "実行を続ける",
    "zh-CN": "继续运行",
    es: "Seguir ejecutando",
  },
  "Stop all": { ko: "모두 중지", ja: "すべて停止", "zh-CN": "全部停止", es: "Detener todo" },
  Total: { ko: "합계", ja: "合計", "zh-CN": "总计", es: "Total" },
  Less: { ko: "적음", ja: "少", "zh-CN": "少", es: "Menos" },
  More: { ko: "많음", ja: "多", "zh-CN": "多", es: "Más" },
  "no data": { ko: "데이터 없음", ja: "データなし", "zh-CN": "无数据", es: "sin datos" },
  "All values are 0": {
    ko: "모든 값이 0입니다",
    ja: "すべての値が 0 です",
    "zh-CN": "所有值均为 0",
    es: "Todos los valores son 0",
  },
};
