import type { MessageCatalog } from "./types";

/** The right panel tab bar and in-app browser. */
export const PANELS_MESSAGES: MessageCatalog = {
  "Stop loading": {
    ko: "로드 중지",
    ja: "読み込みを停止",
    "zh-CN": "停止加载",
    es: "Detener carga",
  },
  "{count} working": {
    ko: "{count}개 작업 중",
    ja: "{count} 件が作業中",
    "zh-CN": "{count} 个正在工作",
    es: "{count} trabajando",
  },
  "Preview your app in a built-in browser.": {
    ko: "내장 브라우저에서 앱을 미리 봅니다.",
    ja: "内蔵ブラウザーでアプリをプレビューします。",
    "zh-CN": "在内置浏览器中预览你的应用。",
    es: "Previsualiza tu app en un navegador integrado.",
  },
  "Run commands in this project.": {
    ko: "이 프로젝트에서 명령을 실행합니다.",
    ja: "このプロジェクトでコマンドを実行します。",
    "zh-CN": "在此项目中运行命令。",
    es: "Ejecuta comandos en este proyecto.",
  },
  "Browse and open project files.": {
    ko: "프로젝트 파일을 둘러보고 엽니다.",
    ja: "プロジェクトのファイルを閲覧して開きます。",
    "zh-CN": "浏览并打开项目文件。",
    es: "Explora y abre los archivos del proyecto.",
  },
  "Review this thread's changes.": {
    ko: "이 스레드의 변경 사항을 검토합니다.",
    ja: "このスレッドの変更を確認します。",
    "zh-CN": "查看此线程的更改。",
    es: "Revisa los cambios de este hilo.",
  },
  "Open this branch's pull request.": {
    ko: "이 브랜치의 풀 리퀘스트를 엽니다.",
    ja: "このブランチのプルリクエストを開きます。",
    "zh-CN": "打开此分支的拉取请求。",
    es: "Abre el pull request de esta rama.",
  },
  "Pull requests linked to this thread.": {
    ko: "이 스레드에 연결된 풀 리퀘스트입니다.",
    ja: "このスレッドにリンクされたプルリクエストです。",
    "zh-CN": "与此线程关联的拉取请求。",
    es: "Pull requests vinculados a este hilo.",
  },
  "Who is working and on what.": {
    ko: "누가 무엇을 하고 있는지 보여줍니다.",
    ja: "誰が何に取り組んでいるかを表示します。",
    "zh-CN": "谁在做什么,一目了然。",
    es: "Quién trabaja y en qué.",
  },
  "Watch this project's workflow runs live.": {
    ko: "이 프로젝트의 워크플로 실행을 실시간으로 봅니다.",
    ja: "このプロジェクトのワークフロー実行をリアルタイムで確認します。",
    "zh-CN": "实时查看此项目的工作流运行。",
    es: "Sigue en vivo las ejecuciones de workflows de este proyecto.",
  },
  "Watch an iOS Simulator or Android Emulator.": {
    ko: "iOS 시뮬레이터나 안드로이드 에뮬레이터를 봅니다.",
    ja: "iOS シミュレーターまたは Android エミュレーターを表示します。",
    "zh-CN": "查看 iOS 模拟器或 Android 模拟器。",
    es: "Observa un simulador de iOS o un emulador de Android.",
  },
  "Only available in the desktop app.": {
    ko: "데스크톱 앱에서만 사용할 수 있습니다.",
    ja: "デスクトップアプリでのみ利用できます。",
    "zh-CN": "仅在桌面应用中可用。",
    es: "Solo disponible en la app de escritorio.",
  },
  "Available when a project is open.": {
    ko: "프로젝트를 열면 사용할 수 있습니다.",
    ja: "プロジェクトを開いている間は利用できます。",
    "zh-CN": "打开项目后可用。",
    es: "Disponible cuando hay un proyecto abierto.",
  },
  "Available for Git repositories.": {
    ko: "Git 저장소에서 사용할 수 있습니다.",
    ja: "Git リポジトリで利用できます。",
    "zh-CN": "适用于 Git 仓库。",
    es: "Disponible para repositorios Git.",
  },
  "No pull request on this branch yet.": {
    ko: "이 브랜치에는 아직 풀 리퀘스트가 없습니다.",
    ja: "このブランチにはまだプルリクエストがありません。",
    "zh-CN": "此分支还没有拉取请求。",
    es: "Esta rama aún no tiene pull request.",
  },
  "No linked pull requests available.": {
    ko: "연결된 풀 리퀘스트가 없습니다.",
    ja: "リンクされたプルリクエストはありません。",
    "zh-CN": "没有关联的拉取请求。",
    es: "No hay pull requests vinculados.",
  },
  "Available from a thread.": {
    ko: "스레드에서 사용할 수 있습니다.",
    ja: "スレッドから利用できます。",
    "zh-CN": "在线程中可用。",
    es: "Disponible desde un hilo.",
  },
  "Available from a project thread.": {
    ko: "프로젝트 스레드에서 사용할 수 있습니다.",
    ja: "プロジェクトのスレッドから利用できます。",
    "zh-CN": "在项目线程中可用。",
    es: "Disponible desde un hilo de proyecto.",
  },
  "Is the dev server running?": {
    ko: "개발 서버가 실행 중인가요?",
    ja: "開発サーバーは起動していますか?",
    "zh-CN": "开发服务器在运行吗?",
    es: "¿Está en marcha el servidor de desarrollo?",
  },
  "Nothing is answering on {host}. Start it from a terminal, then reload.": {
    ko: "{host}에서 응답이 없습니다. 터미널에서 서버를 시작한 뒤 새로고침하세요.",
    ja: "{host} から応答がありません。ターミナルでサーバーを起動してから再読み込みしてください。",
    "zh-CN": "{host} 没有响应。请在终端中启动服务器,然后重新加载。",
    es: "Nada responde en {host}. Inícialo desde una terminal y vuelve a cargar.",
  },
  "The dev server is answering again.": {
    ko: "개발 서버가 다시 응답하고 있습니다.",
    ja: "開発サーバーが再び応答しています。",
    "zh-CN": "开发服务器已恢复响应。",
    es: "El servidor de desarrollo vuelve a responder.",
  },
  "Server is back — Reload": {
    ko: "서버가 돌아왔습니다 — 새로고침",
    ja: "サーバーが復帰しました — 再読み込み",
    "zh-CN": "服务器已恢复 — 重新加载",
    es: "El servidor ha vuelto — Recargar",
  },
};
