; OoP Windows installer welcome page (electron-builder assisted installer, UTF-8 with BOM).
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "OoP 설치"
  !define MUI_WELCOMEPAGE_TEXT "이 PC에 OoP를 설치합니다.$\r$\n$\r$\n설치가 끝나고 OoP를 처음 열면 안내가 이어집니다.$\r$\n  1. 업데이트 폴더(NAS 공유 폴더) 연결$\r$\n  2. Claude Code, Codex 같은 에이전트 로그인$\r$\n  3. 프로젝트 가져오기$\r$\n$\r$\n대화·프로젝트·설정은 PC마다 따로 저장되므로 이 PC는 빈 상태로 시작합니다.$\r$\n$\r$\n업데이트할 때도 이 설치 프로그램이 열리며, 기존 대화와 설정은 그대로 유지됩니다."
  !insertmacro MUI_PAGE_WELCOME
!macroend
