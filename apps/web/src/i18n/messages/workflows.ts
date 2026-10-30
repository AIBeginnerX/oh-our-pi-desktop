import type { MessageCatalog } from "./types";

/** The Agents and Workflows panels. */
export const WORKFLOWS_MESSAGES: MessageCatalog = {
  // Who: the actors a flow draws.
  "Main agent": {
    ko: "메인 에이전트",
    ja: "メインエージェント",
    "zh-CN": "主智能体",
    es: "Agente principal",
  },
  Worker: { ko: "워커", ja: "ワーカー", "zh-CN": "执行者", es: "Trabajador" },
  Expert: { ko: "전문가", ja: "エキスパート", "zh-CN": "专家", es: "Experto" },
  Auditor: { ko: "감사자", ja: "監査役", "zh-CN": "审核员", es: "Auditor" },
  "Crew member": {
    ko: "크루 멤버",
    ja: "クルーメンバー",
    "zh-CN": "团队成员",
    es: "Miembro del equipo",
  },
  Subagent: { ko: "서브에이전트", ja: "サブエージェント", "zh-CN": "子智能体", es: "Subagente" },
  Workflow: { ko: "워크플로", ja: "ワークフロー", "zh-CN": "工作流", es: "Flujo de trabajo" },

  // What the main agent did, by category.
  "Read 1 file": {
    ko: "파일 1개 읽음",
    ja: "ファイル1件を読み込み",
    "zh-CN": "读取了 1 个文件",
    es: "Leyó 1 archivo",
  },
  "Read {count} files": {
    ko: "파일 {count}개 읽음",
    ja: "ファイル{count}件を読み込み",
    "zh-CN": "读取了 {count} 个文件",
    es: "Leyó {count} archivos",
  },
  "Edited 1 file": {
    ko: "파일 1개 수정",
    ja: "ファイル1件を編集",
    "zh-CN": "编辑了 1 个文件",
    es: "Editó 1 archivo",
  },
  "Edited {count} files": {
    ko: "파일 {count}개 수정",
    ja: "ファイル{count}件を編集",
    "zh-CN": "编辑了 {count} 个文件",
    es: "Editó {count} archivos",
  },
  "Ran 1 command": {
    ko: "명령 1회 실행",
    ja: "コマンドを1回実行",
    "zh-CN": "运行了 1 条命令",
    es: "Ejecutó 1 comando",
  },
  "Ran {count} commands": {
    ko: "명령 {count}회 실행",
    ja: "コマンドを{count}回実行",
    "zh-CN": "运行了 {count} 条命令",
    es: "Ejecutó {count} comandos",
  },
  "Searched once": { ko: "1회 검색", ja: "1回検索", "zh-CN": "搜索了 1 次", es: "Buscó una vez" },
  "Searched {count} times": {
    ko: "{count}회 검색",
    ja: "{count}回検索",
    "zh-CN": "搜索了 {count} 次",
    es: "Buscó {count} veces",
  },
  "Searched the web once": {
    ko: "웹 1회 검색",
    ja: "Webを1回検索",
    "zh-CN": "联网搜索了 1 次",
    es: "Buscó en la web una vez",
  },
  "Searched the web {count} times": {
    ko: "웹 {count}회 검색",
    ja: "Webを{count}回検索",
    "zh-CN": "联网搜索了 {count} 次",
    es: "Buscó en la web {count} veces",
  },
  "Used 1 other tool": {
    ko: "기타 도구 1회 사용",
    ja: "その他のツールを1回使用",
    "zh-CN": "使用了 1 次其他工具",
    es: "Usó 1 otra herramienta",
  },
  "Used {count} other tools": {
    ko: "기타 도구 {count}회 사용",
    ja: "その他のツールを{count}回使用",
    "zh-CN": "使用了 {count} 次其他工具",
    es: "Usó {count} otras herramientas",
  },

  // What it does right now.
  "Reading files…": {
    ko: "파일을 읽는 중…",
    ja: "ファイルを読み込み中…",
    "zh-CN": "正在读取文件…",
    es: "Leyendo archivos…",
  },
  "Editing files…": {
    ko: "파일을 수정하는 중…",
    ja: "ファイルを編集中…",
    "zh-CN": "正在编辑文件…",
    es: "Editando archivos…",
  },
  "Running a command…": {
    ko: "명령을 실행하는 중…",
    ja: "コマンドを実行中…",
    "zh-CN": "正在运行命令…",
    es: "Ejecutando un comando…",
  },
  "Searching…": { ko: "검색하는 중…", ja: "検索中…", "zh-CN": "正在搜索…", es: "Buscando…" },
  "Searching the web…": {
    ko: "웹을 검색하는 중…",
    ja: "Webを検索中…",
    "zh-CN": "正在联网搜索…",
    es: "Buscando en la web…",
  },
  "Using a tool…": {
    ko: "도구를 사용하는 중…",
    ja: "ツールを使用中…",
    "zh-CN": "正在使用工具…",
    es: "Usando una herramienta…",
  },
  "Thinking…": { ko: "생각하는 중…", ja: "考え中…", "zh-CN": "思考中…", es: "Pensando…" },
  "Handed 1 task to the crew": {
    ko: "crew에 작업 1개를 맡김",
    ja: "クルーにタスクを1件任せた",
    "zh-CN": "将 1 项任务交给了团队",
    es: "Encargó 1 tarea al equipo",
  },
  "Handed {count} tasks to the crew": {
    ko: "crew에 작업 {count}개를 맡김",
    ja: "クルーにタスクを{count}件任せた",
    "zh-CN": "将 {count} 项任务交给了团队",
    es: "Encargó {count} tareas al equipo",
  },
  "Waiting for the team…": {
    ko: "팀의 작업을 기다리는 중…",
    ja: "チームの作業を待機中…",
    "zh-CN": "正在等待团队…",
    es: "Esperando al equipo…",
  },

  // Where it stands.
  Blocked: { ko: "막힘", ja: "ブロック", "zh-CN": "受阻", es: "Bloqueado" },
  Partial: { ko: "일부 완료", ja: "一部完了", "zh-CN": "部分完成", es: "Parcial" },
  Stopped: { ko: "중지됨", ja: "停止", "zh-CN": "已停止", es: "Detenido" },
  Waiting: { ko: "대기 중", ja: "待機中", "zh-CN": "等待中", es: "En espera" },
  Paused: { ko: "일시정지", ja: "一時停止", "zh-CN": "已暂停", es: "En pausa" },
  "Not started": { ko: "시작 전", ja: "未開始", "zh-CN": "未开始", es: "Sin empezar" },
  Skipped: { ko: "건너뜀", ja: "スキップ", "zh-CN": "已跳过", es: "Omitido" },
  "Turn ended before this step reported completion": {
    ko: "이 단계가 완료를 보고하기 전에 턴이 끝났습니다",
    ja: "このステップが完了を報告する前にターンが終了しました",
    "zh-CN": "此步骤尚未报告完成，本轮就已结束",
    es: "El turno terminó antes de que este paso informara su finalización",
  },
  reported: { ko: "보고됨", ja: "報告済み", "zh-CN": "已报告", es: "informado" },
  tested: { ko: "테스트됨", ja: "テスト済み", "zh-CN": "已测试", es: "probado" },
  audited: { ko: "감사됨", ja: "監査済み", "zh-CN": "已审核", es: "auditado" },

  // Counts, names, and columns.
  "{count} done": {
    ko: "{count}개 완료",
    ja: "{count}件完了",
    "zh-CN": "{count} 个已完成",
    es: "{count} listos",
  },
  "{count} failed": {
    ko: "{count}개 실패",
    ja: "{count}件失敗",
    "zh-CN": "{count} 个失败",
    es: "{count} con error",
  },
  "{count} stopped": {
    ko: "{count}개 중지",
    ja: "{count}件停止",
    "zh-CN": "{count} 个已停止",
    es: "{count} detenidos",
  },
  "{count} running": {
    ko: "{count}개 실행 중",
    ja: "{count}件実行中",
    "zh-CN": "{count} 个运行中",
    es: "{count} en curso",
  },
  "{count} active": {
    ko: "{count}개 진행 중",
    ja: "{count}件進行中",
    "zh-CN": "{count} 个进行中",
    es: "{count} activos",
  },
  "Turn {number}": {
    ko: "턴 {number}",
    ja: "ターン {number}",
    "zh-CN": "第 {number} 轮",
    es: "Turno {number}",
  },
  "Turn {number} · Crew": {
    ko: "턴 {number} · 크루",
    ja: "ターン {number} · クルー",
    "zh-CN": "第 {number} 轮 · 团队",
    es: "Turno {number} · Equipo",
  },
  "Delegated work": {
    ko: "위임된 작업",
    ja: "委任された作業",
    "zh-CN": "委派的工作",
    es: "Trabajo delegado",
  },
  Review: { ko: "검토", ja: "レビュー", "zh-CN": "审核", es: "Revisión" },
  Audit: { ko: "감사", ja: "監査", "zh-CN": "审计", es: "Auditoría" },
  Brain: { ko: "브레인", ja: "ブレイン", "zh-CN": "大脑", es: "Cerebro" },
  Next: { ko: "다음", ja: "次", "zh-CN": "下一步", es: "Siguiente" },
  Other: { ko: "기타", ja: "その他", "zh-CN": "其他", es: "Otros" },
  "Step {number}": {
    ko: "단계 {number}",
    ja: "ステップ {number}",
    "zh-CN": "步骤 {number}",
    es: "Paso {number}",
  },
  "Wave {number}": {
    ko: "웨이브 {number}",
    ja: "ウェーブ {number}",
    "zh-CN": "批次 {number}",
    es: "Tanda {number}",
  },
  "{amount} tok": {
    ko: "{amount} 토큰",
    ja: "{amount} トークン",
    "zh-CN": "{amount} 令牌",
    es: "{amount} tok",
  },
  "{amount} tok by crew": {
    ko: "크루 {amount} 토큰",
    ja: "クルー {amount} トークン",
    "zh-CN": "团队 {amount} 令牌",
    es: "{amount} tok del equipo",
  },
  "{cost} + unpriced": {
    ko: "{cost} + 가격 미확인",
    ja: "{cost} + 価格不明",
    "zh-CN": "{cost} + 未计价",
    es: "{cost} + sin precio",
  },

  // Flow chips and header.
  "Earlier ({count})": {
    ko: "이전 ({count})",
    ja: "以前 ({count})",
    "zh-CN": "更早 ({count})",
    es: "Anteriores ({count})",
  },
  "Follow live": {
    ko: "실시간 따라가기",
    ja: "ライブに追従",
    "zh-CN": "跟随实时",
    es: "Seguir en vivo",
  },
  "Show steps": { ko: "단계 보기", ja: "ステップを表示", "zh-CN": "显示步骤", es: "Mostrar pasos" },
  "Hide steps": {
    ko: "단계 숨기기",
    ja: "ステップを隠す",
    "zh-CN": "隐藏步骤",
    es: "Ocultar pasos",
  },
  "{count} older steps hidden": {
    ko: "이전 단계 {count}개 숨김",
    ja: "古いステップ{count}件を非表示",
    "zh-CN": "已隐藏 {count} 个较早的步骤",
    es: "{count} pasos anteriores ocultos",
  },
  "just now": { ko: "방금", ja: "たった今", "zh-CN": "刚刚", es: "ahora mismo" },
  ago: { ko: "전", ja: "前", "zh-CN": "前", es: "hace" },
  "No work to draw yet": {
    ko: "아직 표시할 작업이 없습니다",
    ja: "表示する作業はまだありません",
    "zh-CN": "还没有可绘制的工作",
    es: "Aún no hay trabajo que mostrar",
  },
  "When the agent calls tools, starts subagents, or runs a workflow in this thread, each step shows up here live.":
    {
      ko: "이 스레드에서 에이전트가 도구를 호출하거나 서브에이전트나 워크플로를 실행하면 각 단계가 여기에 실시간으로 표시됩니다.",
      ja: "このスレッドでエージェントがツールを呼び出したり、サブエージェントやワークフローを実行したりすると、各ステップがここにリアルタイムで表示されます。",
      "zh-CN":
        "当智能体在此会话中调用工具、启动子智能体或运行工作流时，每个步骤都会实时显示在这里。",
      es: "Cuando el agente llame a herramientas, inicie subagentes o ejecute un flujo de trabajo en este hilo, cada paso aparecerá aquí en vivo.",
    },

  // Details and activity.
  Details: { ko: "상세", ja: "詳細", "zh-CN": "详情", es: "Detalles" },
  "Select a card on the board.": {
    ko: "보드에서 카드를 선택하세요.",
    ja: "ボードでカードを選択してください。",
    "zh-CN": "请在看板上选择一张卡片。",
    es: "Selecciona una tarjeta del tablero.",
  },
  Activity: { ko: "활동", ja: "アクティビティ", "zh-CN": "活动", es: "Actividad" },
  "Nothing has started yet.": {
    ko: "아직 시작된 작업이 없습니다.",
    ja: "まだ開始された作業はありません。",
    "zh-CN": "尚未开始任何工作。",
    es: "Aún no ha empezado nada.",
  },
  "Show all ({count})": {
    ko: "모두 보기 ({count})",
    ja: "すべて表示 ({count})",
    "zh-CN": "显示全部 ({count})",
    es: "Mostrar todo ({count})",
  },
  "Show fewer": { ko: "줄여서 보기", ja: "表示を減らす", "zh-CN": "收起", es: "Mostrar menos" },
  "{name} started": {
    ko: "{name} 시작",
    ja: "{name} が開始",
    "zh-CN": "{name} 已开始",
    es: "{name} empezó",
  },
  "{name}: {state}": {
    ko: "{name}: {state}",
    ja: "{name}: {state}",
    "zh-CN": "{name}: {state}",
    es: "{name}: {state}",
  },
  Step: { ko: "단계", ja: "ステップ", "zh-CN": "步骤", es: "Paso" },
  Agent: { ko: "에이전트", ja: "エージェント", "zh-CN": "智能体", es: "Agente" },
  Task: { ko: "작업", ja: "タスク", "zh-CN": "任务", es: "Tarea" },
  "Work so far": {
    ko: "지금까지 한 일",
    ja: "これまでの作業",
    "zh-CN": "目前的工作",
    es: "Trabajo hasta ahora",
  },
  State: { ko: "상태", ja: "状態", "zh-CN": "状态", es: "Estado" },
  Elapsed: { ko: "경과 시간", ja: "経過時間", "zh-CN": "已用时间", es: "Transcurrido" },
  Tokens: { ko: "토큰", ja: "トークン", "zh-CN": "令牌", es: "Tokens" },
  Cost: { ko: "비용", ja: "コスト", "zh-CN": "费用", es: "Costo" },
  Evidence: { ko: "근거", ja: "根拠", "zh-CN": "依据", es: "Evidencia" },
  "Tool calls": {
    ko: "도구 호출",
    ja: "ツール呼び出し",
    "zh-CN": "工具调用",
    es: "Llamadas a herramientas",
  },
  Detail: { ko: "세부 내용", ja: "詳細内容", "zh-CN": "细节", es: "Detalle" },
  Now: { ko: "현재", ja: "現在", "zh-CN": "当前", es: "Ahora" },
  Error: { ko: "오류", ja: "エラー", "zh-CN": "错误", es: "Error" },

  // Crew task actions.
  Stop: { ko: "중지", ja: "停止", "zh-CN": "停止", es: "Detener" },
  Open: { ko: "열기", ja: "開く", "zh-CN": "打开", es: "Abrir" },
  "Stop this task?": {
    ko: "이 작업을 중지할까요?",
    ja: "このタスクを停止しますか?",
    "zh-CN": "要停止此任务吗?",
    es: "¿Detener esta tarea?",
  },
  "It stops where it is. You can retry it afterwards.": {
    ko: "지금 상태에서 멈춥니다. 나중에 다시 시도할 수 있습니다.",
    ja: "現在の状態で停止します。後から再試行できます。",
    "zh-CN": "任务会在当前进度停止，之后可以重试。",
    es: "Se detiene donde está. Después puedes reintentarla.",
  },

  // Agents panel.
  "Finished the turn": {
    ko: "턴을 마쳤습니다",
    ja: "ターンを完了しました",
    "zh-CN": "本轮已完成",
    es: "Terminó el turno",
  },
};
