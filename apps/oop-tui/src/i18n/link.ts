import { defineMessages } from "./define.ts";

export const link = defineMessages(
  {
    "link.daemonEntryMissing":
      "The file {variable} points to does not exist, so no server was started.",
    "link.autoPairNoToken":
      "Automatic connection failed: the running OOP server did not give out a connection token.",
    "link.autoPairFailed": "Automatic connection failed: {reason}",
    "link.paired": "Connected: {label}\nNow start with 'oop'.",
    "link.cannotConnect": "Cannot connect to the server.",
    "link.needsTty":
      "oop only runs in an interactive terminal (standard input/output is not a terminal).",
    "link.serverRefused": "The server refused the connection{detail}",
    "link.serverUnreachable":
      "Could not connect to the server. Check that the OOP app or the terminal server is running.",
    "link.notConnected": "Not connected to the server.",
    "link.configEnded": "The server ended the settings subscription.",
    "link.listEnded": "The server ended the list subscription.",
    "link.threadOpenFailed": "Could not open the thread.",
    "link.threadEnded": "The server ended the thread subscription.",
    "link.connectionLost": "The connection was lost.",
    "link.credentialsDamaged":
      "The credentials file is damaged ({reason}): {filePath}\nCheck or delete the file, then reconnect with 'oop pair <link>'.",
    "link.reason.notJson": "not JSON",
    "link.reason.wrongFormat": "unexpected format",
    "link.discovery.missing":
      "No running OOP server was found. Open the desktop app or pass --server with an address.",
    "link.discovery.unreadable":
      "Could not read the server runtime info. Pass --server with an address.",
    "link.discovery.stale": "The last OOP server that ran has already exited.",
    "link.discovery.unreachable": "The OOP server is not responding. Try again in a moment.",
    "link.daemon.noPort": "Could not find a free port.",
    "link.daemon.spawnFailed": "Could not launch the server program.",
    "link.daemon.exited": "The server exited with code {code}.",
    "link.daemon.noCode": "none",
    "link.unknownError": "Unknown error",
    "link.connectionClosed": "The connection was closed.",
    "link.plainHttp":
      "Warning: connecting to {host} over unencrypted http. Your token and conversation are visible on the network.",
    "link.notPaired":
      "Not connected to {label} yet.\nCreate a pairing link in the desktop app, then run 'oop pair <link>' once.",
    "link.otherServer":
      "{origin} is not the server you saved when pairing ({elsewhere}), so the saved token was not sent.\nTo use the saved server run 'oop --server {elsewhere}'; to use this one, run 'oop pair <link>' with a pairing link made on it.",
    "link.pair.empty": "Enter a pairing link or token.",
    "link.pair.tokenOnly":
      "A token alone does not say which server to use. Use the full pairing link or pass --server with an address.",
    "link.pair.failed": "Pairing failed: {message}",
    "link.pair.authentication":
      "{failure}\nA link works once and expires soon. Create a new link and try again.",
    "link.pair.unsupported": "{failure}\nProtocol mismatch: update the app or oop.",
    "link.pair.configuration":
      "{failure}\nThis link's permissions cannot connect oop, and the link is already used up. Create a new link that is not read-only and try again.",
    "link.resolve.unverified":
      "The token was not sent: could not confirm that the server at {origin} (pid {pid}) is this user's process and listening on that port.\nIf you trust it, pass it directly with 'oop --server <address>'.",
    "link.resolve.noAnswer": "No OOP server is answering at {origin}.",
    "link.resolve.startingApp": "Starting the OOP app…",
    "link.reason.unverified": "Server check failed, token not sent",
    "link.reason.otherServer": "Different server, token not sent",
    "link.reason.appClosed": "OOP app is closed — reconnects when it opens",
    "link.reason.startingSoon": "No server — starting one shortly",
    "link.reason.startFailed": "Server failed to start — open the app",
    "link.reason.appUpdating": "App is updating — reconnects automatically",
    "link.reason.startSlow": "Server is slow to start — still checking",
    "link.notice.startingServer":
      "Starting the OOP server… (terminal only, no app. If you open the app it takes the server over and a turn in progress is interrupted)",
    "link.err.appUpdating":
      "The OOP app may be installing an update, so no server was started. Opening the app picks up right away; otherwise you can try again in up to 15 minutes.",
    "link.err.serverSlow":
      "The standalone terminal server did not start in time. Run 'oop' again in a moment.",
  },
  {
    "link.daemonEntryMissing": "{variable} 가 가리키는 파일이 없어 서버를 띄우지 않습니다.",
    "link.autoPairNoToken": "자동 연결 실패: 실행 중인 OOP 서버에서 연결 토큰을 받지 못했습니다.",
    "link.autoPairFailed": "자동 연결 실패: {reason}",
    "link.paired": "연결되었습니다: {label}\n이제 'oop' 으로 시작하세요.",
    "link.cannotConnect": "서버에 연결할 수 없습니다.",
    "link.needsTty": "oop 은 대화형 터미널에서만 실행됩니다. (표준 입출력이 터미널이 아닙니다.)",
    "link.serverRefused": "서버가 연결을 거부했습니다{detail}",
    "link.serverUnreachable":
      "서버에 연결하지 못했습니다. OOP 앱이나 터미널 서버가 실행 중인지 확인하세요.",
    "link.notConnected": "서버와 연결되어 있지 않습니다.",
    "link.configEnded": "서버가 설정 구독을 종료했습니다.",
    "link.listEnded": "서버가 목록 구독을 종료했습니다.",
    "link.threadOpenFailed": "스레드를 열 수 없습니다.",
    "link.threadEnded": "서버가 스레드 구독을 종료했습니다.",
    "link.connectionLost": "연결이 끊어졌습니다.",
    "link.credentialsDamaged":
      "자격증명 파일이 손상되었습니다 ({reason}): {filePath}\n파일을 확인하거나 지운 뒤 'oop pair <링크>' 로 다시 연결하세요.",
    "link.reason.notJson": "JSON이 아님",
    "link.reason.wrongFormat": "형식이 다름",
    "link.discovery.missing":
      "실행 중인 OOP 서버를 찾지 못했습니다. 데스크톱 앱을 켜거나 --server 주소를 지정하세요.",
    "link.discovery.unreadable": "서버 실행 정보를 읽을 수 없습니다. --server 주소를 지정하세요.",
    "link.discovery.stale": "마지막으로 실행된 OOP 서버가 이미 종료되었습니다.",
    "link.discovery.unreachable": "OOP 서버가 응답하지 않습니다. 잠시 후 다시 시도하세요.",
    "link.daemon.noPort": "빈 포트를 찾지 못했습니다.",
    "link.daemon.spawnFailed": "서버 프로그램을 실행하지 못했습니다.",
    "link.daemon.exited": "서버가 코드 {code} 으로 끝났습니다.",
    "link.daemon.noCode": "없음",
    "link.unknownError": "알 수 없는 오류",
    "link.connectionClosed": "연결이 닫혔습니다.",
    "link.plainHttp":
      "주의: {host} 에 암호화 없는 http 로 연결합니다. 토큰과 대화 내용이 네트워크에 그대로 보입니다.",
    "link.notPaired":
      "{label} 와(과) 아직 연결되지 않았습니다.\n데스크톱 앱에서 페어링 링크를 만든 뒤 'oop pair <링크>' 를 한 번 실행하세요.",
    "link.otherServer":
      "{origin} 은(는) 연결할 때 저장한 서버({elsewhere})가 아니므로 저장된 토큰을 보내지 않습니다.\n저장한 서버를 쓰려면 'oop --server {elsewhere}' 를, 이 서버를 쓰려면 이 서버에서 만든 페어링 링크로 'oop pair <링크>' 를 실행하세요.",
    "link.pair.empty": "페어링 링크 또는 토큰을 입력하세요.",
    "link.pair.tokenOnly":
      "토큰만으로는 서버를 알 수 없습니다. 페어링 링크 전체를 쓰거나 --server 주소를 지정하세요.",
    "link.pair.failed": "페어링에 실패했습니다: {message}",
    "link.pair.authentication":
      "{failure}\n링크는 한 번만 쓸 수 있고 곧 만료됩니다. 새 링크를 만들어 다시 시도하세요.",
    "link.pair.unsupported": "{failure}\n프로토콜 불일치: 앱이나 oop 을 업데이트하세요.",
    "link.pair.configuration":
      "{failure}\n이 링크의 권한으로는 oop 을 연결할 수 없고 링크는 이미 쓰였습니다. 읽기 전용이 아닌 새 링크를 만들어 다시 시도하세요.",
    "link.resolve.unverified":
      "토큰을 보내지 않았습니다: {origin} 의 서버(pid {pid})가 이 사용자의 프로세스이고 그 포트에서 리슨 중인지 확인하지 못했습니다.\n믿을 수 있는 서버라면 'oop --server <주소>' 로 직접 지정하세요.",
    "link.resolve.noAnswer": "{origin} 에서 OOP 서버가 응답하지 않습니다.",
    "link.resolve.startingApp": "OOP 앱을 시작하는 중입니다…",
    "link.reason.unverified": "서버 확인 실패, 토큰 보내지 않음",
    "link.reason.otherServer": "다른 서버라서 토큰 보내지 않음",
    "link.reason.appClosed": "OOP 앱 꺼짐 — 켜면 자동 재연결",
    "link.reason.startingSoon": "서버 없음 — 곧 자동으로 띄웁니다",
    "link.reason.startFailed": "서버 시작 실패 — 앱을 켜세요",
    "link.reason.appUpdating": "앱 업데이트 중 — 자동 재연결",
    "link.reason.startSlow": "서버 시작이 느림 — 계속 확인",
    "link.notice.startingServer":
      "OOP 서버를 시작하는 중입니다… (앱 없이 터미널만 씁니다. 앱을 켜면 앱이 서버를 이어받고, 진행 중인 턴은 끊깁니다)",
    "link.err.appUpdating":
      "OOP 앱이 업데이트를 설치하는 중일 수 있어 서버를 띄우지 않았습니다. 앱을 켜면 바로 이어지고, 아니면 최대 15분 뒤 다시 시도할 수 있습니다.",
    "link.err.serverSlow":
      "터미널 단독 서버가 제때 시작되지 않았습니다. 잠시 뒤 'oop' 을 다시 실행하세요.",
  },
);
