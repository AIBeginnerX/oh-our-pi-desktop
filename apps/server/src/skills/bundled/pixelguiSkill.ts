/**
 * The PixelGUI skill OOP ships (https://pixelgui.com). Kept as a module rather than a loose
 * SKILL.md so the bundled server always carries it; installing writes exactly these bytes.
 */
export const PIXELGUI_SKILL_MARKDOWN = `---
name: pixelgui
description: Create or integrate terminal GUI applications with Pixel (@zenbu-labs/pixel). Use when building interactive React interfaces rendered in a compatible graphics terminal; not for pixel art, image pixels, or Meta Pixel.
---

# Pixel 터미널 GUI 만들기

사용자가 터미널 안에서 실행되는 그래픽 사용자 인터페이스를 만들거나 기존 앱에
Pixel을 통합해 달라고 할 때 이 지침을 따른다. 일반 CLI, 픽셀 아트, 이미지 처리,
Meta Pixel 분석 도구 요청에는 적용하지 않는다.

## 시작 전 공식 문서 확인

공식 참고 위치:

- 제품 및 사용 안내: \`https://pixelgui.com\`
- 공식 저장소와 Pixel 소스: \`https://github.com/zenbu-labs/terminal-browser/tree/main/pixel\`

작업할 때 현재 버전의 \`AGENT-DOCS.md\`, 저장소의 \`examples/\` 및 실제 예제 코드,
패키지 메타데이터를 먼저 확인한다. 패키지 버전, API, 플랫폼 지원, 실행 스크립트를
기억이나 오래된 설명만으로 추측하지 않는다. 설치된 버전의 문서와
\`package.json\`에서 exports, peerDependencies, scripts, engines, install 동작을
확인한 뒤 해당 버전에 맞춰 구현한다. 네트워크 제한이 있으면 확인할 수 없다고
밝히고, 확인되지 않은 API를 만들어 쓰지 않는다.

문서 예제를 현재 설치본과 대조한다. 저장소의 고정 커밋이나 예전 예제에 나온
버전은 현재 배포 최신 버전의 증거가 아니다.

### 이 스킬 작성 시점에 확인한 사실 (2026-10-25, npm \`@zenbu-labs/pixel\` 0.2.9)

아래는 그 시점 패키지 내용을 직접 읽어 확인한 값이다. 버전이 바뀌었으면 다시 확인한다.

- 라이선스 MIT, \`react\` peer \`^18.3.1\`, 의존성 \`react-reconciler\`, 실행 파일 \`pixel\`.
- 주요 export: \`createRoot\`, \`Box\`, \`Text\`, \`Input\`, \`Image\`, \`Markdown\`, \`Link\`,
  \`WebView\`, \`DevTools\`, \`useRect\`, \`makeTheme\`. 하위 경로 \`./terminal\`, \`./ssh\`,
  \`./electron\`, \`./preload\`도 있다.
- postinstall은 수정된 Electron(\`config.electron\`, 확인 시점 44.2.0)을
  \`github.com/zenbu-labs/terminal-browser\`(대체: \`zenbu-labs/pixel\`) 릴리스에서 받는다.
  같은 릴리스의 \`SHASUMS256.txt\`로 SHA-256을 대조하지만, 체크섬도 같은 출처에서 오므로
  독립 서명 검증은 아니다. 받은 zip은 \`$XDG_CACHE_HOME/pixel\`(기본 \`~/.cache/pixel\`)에 남는다.
- postinstall은 받은 Electron을 OS 임시 폴더에 풀고 \`node_modules\` 안으로 rename한다.
  프로젝트가 임시 폴더와 다른 볼륨(외장 디스크 등)에 있으면 \`EXDEV: cross-device link not
  permitted\`로 설치가 실패한다(2026-10-25 macOS에서 재현). 이때는 같은 볼륨의 폴더를
  \`TMPDIR\`로 지정해 다시 설치한다.
- 지원 플랫폼: \`darwin-arm64\`, \`darwin-x64\`, \`linux-x64\`, \`linux-arm64\`. 그 밖에서는
  postinstall이 실패한다.
- Linux에서 비특권 user namespace가 제한된 배포판(예: 최근 Ubuntu)은 첫 실행 때
  \`/etc/apparmor.d\`에 프로필을 쓰려 한다. 이는 관리자 권한이 필요한 시스템 변경이므로
  사용자 동의 없이 \`sudo\`로 진행하지 않고, \`PIXEL_SKIP_APPARMOR\`로 우회하지도 않는다.

## 지원 환경과 터미널

Pixel은 macOS와 Linux를 대상으로 한다. Windows에서는 네이티브 Windows 대신
WSL 환경을 사용한다. 실행 호스트에는 Pixel이 요구하는 그래픽 터미널 기능을
지원하는 호환 터미널이 필요하다. 일반 텍스트 전용 터미널만으로 동작한다고
가정하지 말고, 현재 공식 문서에서 지원 요건을 확인한다.

OOP 내장 터미널의 Pixel 호환성은 별도로 실제 검증하기 전까지 미확인이다.
OOP 안에서 실행된다는 이유만으로 그래픽 출력이 지원된다고 주장하거나
성공 조건으로 취급하지 않는다. 호환 터미널에서 독립 실행 검증을 수행한다.

## 프로젝트 설정과 설치

새 사용자 프로젝트는 공식 스캐폴더를 우선 사용한다.

\`\`\`sh
npm create @zenbu-labs/pixel@latest
\`\`\`

명령이 생성한 안내를 따르고, 질문에 필요한 이름과 옵션만 입력한다.
기존 사용자 프로젝트에 통합할 때는 먼저 package manager와 기존 React 버전을
확인한다. 필요한 최소 의존성은 현재 문서 및 메타데이터와 대조하며, React
peer 요구가 \`^18.3.1\`인 버전에서는 사용자 프로젝트가 React 18 호환 버전을
사용하도록 맞춘다. 앱 전체 또는 OOP core의 React 버전을 무단으로 낮추거나
Pixel을 OOP core 의존성으로 추가하지 않는다.

\`\`\`sh
npm install @zenbu-labs/pixel react@18
\`\`\`

위 명령은 React 18 peer 요구가 확인된 설치본에 대한 예시다. 기존 프로젝트
의존성이나 패키지 관리 정책에 맞춰 적용하고 lockfile을 함께 관리한다.

Pixel 패키지의 postinstall은 수정된 Electron 런타임을 다운로드한다. 설치 전
대상 버전의 스크립트, 다운로드 출처와 프로젝트 정책을 확인하고, 필요한 설치
행위와 영향을 사용자에게 알린다. 권한이나 설정을 넓히기 전에 필요한 범위를
설명한다. pnpm의 빌드 승인 또는 Bun의 \`trustedDependencies\`를 전역·광범위하게
풀지 않는다. 다음을 기본 명령이나 자동 설정에 넣지 않는다.

- 샌드박스나 런타임 보안 기능을 비활성화하는 설정
- 검증되지 않은 패키지에 대한 광범위한 trust 승인
- \`PIXEL_SKIP_GRAPHICS_CHECK\`

그래픽 검사를 우회하지 말고 호환 터미널에서 실행한다. 우회가 사용자의 요청으로
별도 논의되는 경우에도 기본 안전 설정을 몰래 바꾸지 않는다.

## 앱 구조와 실행

공식 \`AGENT-DOCS.md\`와 현재 설치본의 예제를 기준으로 UI를 작성한다. React 앱은
Pixel의 공식 \`createRoot()\` 진입 API와 컴포넌트를 사용한다. \`createRoot()\`는
Pixel 전용 런타임 밖에서 호출하면 오류가 발생한다. 브라우저나 일반 Node 실행으로
Pixel 앱이 렌더링된다고 가정하지 않는다.

화면은 목적에 따라 네이티브 UI와 \`WebView\` 중 선택한다.

- 터미널 안에서 직접 그리는 간단하고 인터랙티브한 UI에는 공식 React \`Box\`,
  \`Text\`, \`Input\` 등 현재 지원 컴포넌트를 사용한다.
- 기존 웹 콘텐츠를 보여줘야 할 때는 \`WebView\`를 고려하고, 가능한 범위에서
  적절한 네이티브 UI와 역할을 나눈다.
- API와 컴포넌트 동작은 현재 버전의 문서 및 예제로 검증한다.

\`WebView\`에 외부 네트워크 URL을 표시하면 해당 주소와 네트워크 연결이 발생할
가능성을 사용자에게 알린다. URL, 콘텐츠, 인증 경계와 필요한 데이터 접근을
검토하고, 외부 페이지에 자격 증명을 내장하거나 URL·코드에 토큰, 쿠키,
비밀번호를 넣지 않는다. 저장소나 로그에 비밀을 남기지 않는다.

실행 대상은 소스 파일이 아니라 빌드된 JavaScript entry 또는 그 디렉터리다.
런타임 호출 형태는 다음과 같다.

\`\`\`sh
pixel <built JS entry|dir> [-- args]
\`\`\`

프로젝트별 개발·빌드 명령을 만들어 내지 않는다. 생성된 프로젝트의
\`package.json\` scripts와 설정을 읽고, 존재하는 명령만 안내한다. 디렉터리 실행
지원과 argument 전달 세부사항은 현재 문서로 확인한다.

## 검증과 문제 조사

구현 뒤 아래를 순서대로 확인한다.

1. 현재 프로젝트의 실제 scripts를 확인하고 타입 검사와 프로덕션 빌드를 실행한다.
2. 생성·빌드된 JavaScript entry를 식별하고, 호환 그래픽 터미널에서 Pixel 런타임으로
   실행한다.
3. 실제 터미널 화면에서 레이아웃, 텍스트, 입력, 상호작용, 리사이즈 등 앱에
   해당하는 동작을 직접 확인한다.
4. 종료 동작이 정상인지 확인하고, 실패가 있으면 stderr 및 개발 도구로 조사한다.
5. 개발 모드에서 제공되는 DevTools와 profiler export가 필요할 때 렌더링 성능을
   확인한다. 실제 문서에 있는 기능만 사용한다.

stderr 로그 위치는 \`\${XDG_STATE_HOME:-~/.local/state}/pixel/logs/<앱 폴더 이름>.stderr.log\`다.
먼저 사용자 환경에서 \`XDG_STATE_HOME\`과 실행한 앱 폴더 이름을 확인한 뒤 올바른 파일을
조사한다. 경로가 없거나 로그가 비어 있다는 이유만으로 화면 렌더링을 성공으로
판정하지 않는다. 로그, 타입 검사, 빌드, profiler 결과만으로 픽셀이 올바르게
표시됐다고 주장할 수 없다. 호환 터미널의 실제 화면과 사용자 상호작용을 확인하지
못했다면 그 검증이 미완료라고 보고한다.

마지막으로 변경 범위, 실행한 검사와 실제 화면 검증 결과를 구분해 설명한다.
설치나 실행을 하지 않았다면 하지 않았다고 명시하고, OOP 내장 터미널 지원 여부를
검증하지 않았다면 지원한다고 표현하지 않는다.
`;
