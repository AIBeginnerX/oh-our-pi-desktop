# Contributing

Thanks for your interest in OOP.

## Release mirror

This repository is a **release mirror**: the real development happens in the maintainer's tree, and each OOP version is published here as a single commit. Pull requests are reviewed here, and if accepted they are re-applied upstream in that tree, so they will not appear as your commits in the public history.

## Issues

Issues are welcome: bugs, unclear docs, platform reports (especially Windows and Intel Mac).

Please include the OOP version (`OOP_RELEASE.json`), OS and CPU, the provider involved, and steps to reproduce.

**Never include secrets** in issues, screenshots or logs: no API keys, tokens, pairing URLs, authorization codes, `.env` contents or personal paths. Redact them first. For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead.

## Pull requests

- One concern per PR, with a short description of the problem and the fix.
- Keep changes small and focused. Test the behavior you touched.
- Do not include generated files, build output or secrets.

## Code style

Follow the upstream [AGENTS.md](AGENTS.md): keep it simple, prefer inferred types over annotations, avoid `any`, and match the surrounding code.
