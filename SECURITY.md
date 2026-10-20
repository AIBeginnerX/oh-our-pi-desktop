# Security Policy

## Reporting a vulnerability

Please report security problems **privately**:

1. Open <https://github.com/AIBeginnerX/oh-our-pi-desktop/security/advisories>.
2. Click **Report a vulnerability** and describe the issue, the affected version (see `OOP_RELEASE.json`) and steps to reproduce.

Please do not open a public issue for a vulnerability. Never post API keys, tokens, pairing URLs or authorization codes publicly. If you hit one by accident, revoke it first.

## In scope

- Code in this repository (server, web, desktop, update and build scripts).
- Pairing, authentication and remote-access handling.
- Secret storage and leakage into logs or the UI.
- The local-folder updater (package verification and staging).

Out of scope: bugs in the provider CLIs themselves (Codex, Claude Code, Cursor, and so on), issues that need an already-compromised machine, and problems in upstream T3 Code services (`t3.codes`, T3 Connect, upstream installers). Report those to the respective project.

## Things to know

- **Builds are ad hoc signed.** They have no Developer ID and are not notarized. Your OS will show a first-run warning.
- **Secrets:** provider API keys are stored on the server side, on your own machine. The Antigravity Gemini API key is stored in plain text in settings.
- The updater checks a SHA-256 hash, which detects corruption but does not prove who wrote the package. Only use update folders you trust.
- Agents run with your account's permissions. Use **Supervised** mode for untrusted repositories.

## 한국어 요약

보안 취약점은 공개 이슈 대신 GitHub의 **Report a vulnerability**(비공개 보안 권고)로 `AIBeginnerX/oh-our-pi-desktop`에 제보해 주세요. API 키, 페어링 URL, 인증 코드는 절대 공개된 곳에 올리지 마세요. 이 포크의 빌드는 ad hoc 서명이며 공증(notarization)되지 않았습니다.
