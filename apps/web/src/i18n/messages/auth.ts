import type { MessageCatalog } from "./types";

/** Standalone auth and outside-agent sign-in pages. */
export const AUTH_MESSAGES: MessageCatalog = {
  "Agent sign-in": {
    ko: "에이전트 로그인",
    ja: "エージェントのサインイン",
    "zh-CN": "智能体登录",
    es: "Inicio de sesión de agente",
  },
  "Read only": {
    ko: "읽기 전용",
    ja: "読み取り専用",
    "zh-CN": "只读",
    es: "Solo lectura",
  },
  "Read projects and threads. Cannot start, message or change anything.": {
    ko: "프로젝트와 스레드를 읽을 수 있습니다. 스레드를 시작하거나 메시지를 보내거나 변경할 수는 없습니다.",
    ja: "プロジェクトとスレッドを閲覧できます。開始、メッセージ送信、変更はできません。",
    "zh-CN": "可读取项目和线程，无法启动、发送消息或更改任何内容。",
    es: "Lee proyectos e hilos. No puede iniciar, enviar mensajes ni cambiar nada.",
  },
  "Could not reach this environment. Try again.": {
    ko: "이 환경에 연결할 수 없습니다. 다시 시도해 주세요.",
    ja: "この環境に接続できませんでした。もう一度お試しください。",
    "zh-CN": "无法连接到此环境，请重试。",
    es: "No se pudo conectar con este entorno. Inténtalo de nuevo.",
  },
  "The sign-in could not continue.": {
    ko: "로그인을 계속할 수 없습니다.",
    ja: "サインインを続行できませんでした。",
    "zh-CN": "无法继续登录。",
    es: "No se pudo continuar con el inicio de sesión.",
  },
  "Checking the sign-in request": {
    ko: "로그인 요청 확인 중",
    ja: "サインインリクエストを確認中",
    "zh-CN": "正在检查登录请求",
    es: "Comprobando la solicitud de inicio de sesión",
  },
  "One moment while this environment verifies the agent's request.": {
    ko: "이 환경에서 에이전트의 요청을 확인하는 동안 잠시 기다려 주세요.",
    ja: "この環境がエージェントのリクエストを確認するまでしばらくお待ちください。",
    "zh-CN": "请稍候，此环境正在验证该智能体的请求。",
    es: "Espera un momento mientras este entorno verifica la solicitud del agente.",
  },
  "This sign-in cannot continue": {
    ko: "이 로그인을 계속할 수 없습니다",
    ja: "このサインインは続行できません",
    "zh-CN": "无法继续此登录",
    es: "Este inicio de sesión no puede continuar",
  },
  "Close this page and start the sign-in again from your agent.": {
    ko: "이 페이지를 닫고 에이전트에서 로그인을 다시 시작하세요.",
    ja: "このページを閉じ、エージェントからサインインをやり直してください。",
    "zh-CN": "请关闭此页面，并从你的智能体重新开始登录。",
    es: "Cierra esta página y vuelve a iniciar sesión desde tu agente.",
  },
  "Connect {clientName}": {
    ko: "{clientName} 연결",
    ja: "{clientName} を接続",
    "zh-CN": "连接 {clientName}",
    es: "Conectar {clientName}",
  },
  "This agent wants to use the threads in every project on {host}.": {
    ko: "이 에이전트가 {host}의 모든 프로젝트에 있는 스레드를 사용하려고 합니다.",
    ja: "このエージェントは {host} 上のすべてのプロジェクトのスレッドを使用しようとしています。",
    "zh-CN": "此智能体想要使用 {host} 上所有项目中的线程。",
    es: "Este agente quiere usar los hilos de todos los proyectos en {host}.",
  },
  "The name is chosen by the agent. Approval returns to {host} on the computer that opened this page. Only approve a sign-in you just started.":
    {
      ko: "이름은 에이전트가 직접 정한 것입니다. 승인하면 이 페이지를 연 컴퓨터의 {host}(으)로 돌아갑니다. 방금 직접 시작한 로그인만 승인하세요.",
      ja: "名前はエージェント側が指定したものです。承認すると、このページを開いたコンピューターの {host} に戻ります。今自分で開始したサインインのみ承認してください。",
      "zh-CN":
        "名称由智能体自行设定。批准后将返回打开此页面的电脑上的 {host}。仅批准你刚刚发起的登录。",
      es: "El nombre lo elige el agente. La aprobación vuelve a {host} en el equipo que abrió esta página. Aprueba solo un inicio de sesión que acabes de iniciar.",
    },
  "The name is chosen by the agent. Approval gives access to whoever runs {host}. Only approve a sign-in you just started there.":
    {
      ko: "이름은 에이전트가 직접 정한 것입니다. 승인하면 {host}을(를) 운영하는 주체에게 접근 권한이 부여됩니다. 그곳에서 방금 직접 시작한 로그인만 승인하세요.",
      ja: "名前はエージェント側が指定したものです。承認すると {host} の運営者にアクセス権が付与されます。そこで今自分で開始したサインインのみ承認してください。",
      "zh-CN":
        "名称由智能体自行设定。批准后会将访问权限授予运行 {host} 的服务方。仅批准你刚刚在那里发起的登录。",
      es: "El nombre lo elige el agente. La aprobación da acceso a quien opere {host}. Aprueba solo un inicio de sesión que acabes de iniciar allí.",
    },
  "What it may do": {
    ko: "허용할 작업",
    ja: "許可する操作",
    "zh-CN": "允许的操作",
    es: "Qué puede hacer",
  },
  "Beyond read only, it can start and message threads, answer their approval requests and questions, and stop their running turns. None of them can run with more than the mode you pick.":
    {
      ko: "읽기 전용 이상을 선택하면 스레드를 시작하고 메시지를 보낼 수 있고, 그 스레드의 승인 요청과 질문에 답하며 실행 중인 턴을 중지할 수도 있습니다. 어떤 스레드도 여기서 고른 모드보다 높은 권한으로 실행될 수 없습니다.",
      ja: "読み取り専用以外ではスレッドの開始・メッセージ送信ができ、そのスレッドの承認リクエストや質問に答え、実行中のターンを停止することもできます。どのスレッドもここで選んだモードを超える権限では実行されません。",
      "zh-CN":
        "除只读外，它还可以启动线程和发送消息，回答这些线程的批准请求和提问，并停止其中正在运行的轮次。任何线程的运行权限都不会超过你选择的模式。",
      es: "Más allá de solo lectura, puede iniciar hilos y enviar mensajes, responder sus solicitudes de aprobación y preguntas, y detener sus turnos en ejecución. Ninguno podrá ejecutarse con más permisos que el modo que elijas.",
    },
  "Pairing code": {
    ko: "페어링 코드",
    ja: "ペアリングコード",
    "zh-CN": "配对码",
    es: "Código de emparejamiento",
  },
  "Paste a one-time pairing code": {
    ko: "일회용 페어링 코드를 붙여 넣으세요",
    ja: "ワンタイムペアリングコードを貼り付け",
    "zh-CN": "粘贴一次性配对码",
    es: "Pega un código de emparejamiento de un solo uso",
  },
  "Create one in Settings → Connections, or run {command} on this machine.": {
    ko: "설정 → 연결에서 만들거나 이 컴퓨터에서 {command}를 실행하세요.",
    ja: "設定 → 接続で作成するか、このマシンで {command} を実行してください。",
    "zh-CN": "在“设置 → 连接”中创建，或在此电脑上运行 {command}。",
    es: "Crea uno en Configuración → Conexiones o ejecuta {command} en este equipo.",
  },
  Approve: {
    ko: "승인",
    ja: "承認",
    "zh-CN": "批准",
    es: "Aprobar",
  },
  "Approving…": {
    ko: "승인 중…",
    ja: "承認中…",
    "zh-CN": "正在批准…",
    es: "Aprobando…",
  },
  Deny: {
    ko: "거부",
    ja: "拒否",
    "zh-CN": "拒绝",
    es: "Denegar",
  },
  "Denying…": {
    ko: "거부 중…",
    ja: "拒否中…",
    "zh-CN": "正在拒绝…",
    es: "Denegando…",
  },
};
