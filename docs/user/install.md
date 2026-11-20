# Install OOP

OOP runs coding agents on your computer and lets you control them from its
desktop, web, or a phone browser. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch OOP and configure providers afterwards.

## Terminal app

The terminal app runs the same threads in your own terminal window and starts its
own background server, so the desktop app is not needed.

macOS (Apple Silicon) and Linux (x64 or arm64):

```sh
curl -fsSL https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-terminal.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-terminal.ps1 | iex
```

The installer checks the download's SHA-256 and installs everything in your user
folder: the files in `~/.local/share/oop-terminal` and the `oop` command in
`~/.local/bin` on macOS and Linux, or `%LOCALAPPDATA%\oop-terminal` on Windows.
It does not edit your `PATH`; if the shell cannot find `oop`, the installer prints
the line to add.

| Task                                 | Command        |
| ------------------------------------ | -------------- |
| Pick a project and thread, then chat | `oop`          |
| Check the terminal and your setup    | `oop doctor`   |
| See which providers are ready        | `oop provider` |
| See whether a newer release exists   | `oop update`   |
| Stop the server the terminal started | `oop stop`     |

[The terminal app](./terminal-app.md) covers the window itself. To update, run the
same install command again, then `oop stop` so the new server starts. To remove it,
run `oop stop` and delete the folder and the command:
`rm -rf ~/.local/share/oop-terminal ~/.local/bin/oop`, or on Windows
`Remove-Item -Recurse -Force "$env:LOCALAPPDATA\oop-terminal"`. Your data in
`~/.oop-desktop` stays.

On macOS and Windows the desktop app carries the same terminal app. If both are
installed and this one is older, the desktop app points `oop` at its own copy when
it starts, so `oop` always matches the desktop version. The terminal app's files
are then unused and can be deleted (`~/.local/share/oop-terminal`, or
`%LOCALAPPDATA%\oop-terminal\app` on Windows). If this one is newer, the desktop
app's update check offers that release.

## Desktop app

macOS (Apple Silicon):

```sh
curl -fsSL https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-desktop.sh | sh
```

On Windows (x64), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-desktop.ps1 | iex
```

Linux (x64), which needs the GTK and NSS runtime libraries:

```sh
curl -fsSL https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-desktop.sh | sh
```

The installers check the download's SHA-256 before installing. They do not bypass
macOS quarantine or Windows SmartScreen, and the app is unsigned, so your system
may warn you the first time you open it.

The app goes to `~/Applications/OOP.app` on macOS, a per-user install with a Start
menu entry on Windows, and `~/.local/bin/oop-desktop` with a menu entry on Linux.
macOS and Windows also add the `oop` command for the bundled terminal app; see
[Terminal app](#terminal-app) if it is not found. macOS and Windows update the app
themselves; on Linux, quit OOP and run the install command again. Your data is
kept.

[INSTALL.md](https://github.com/AIBeginnerX/oh-our-pi-desktop/blob/main/INSTALL.md)
has the install locations, the release assets, and what each installer needs.

### Unsupported platforms

There are no builds for Intel Macs, Windows on ARM, 32-bit systems, or musl Linux
such as Alpine; the installers stop with a message. To run OOP on an Intel Mac,
build it from source from
[this repository](https://github.com/AIBeginnerX/oh-our-pi-desktop), whose README
covers the build.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. OOP installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
oop server app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `oop server app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile web

A phone opens the relay mobile web, not a native app: scan the QR code from the
desktop's phone dialog and the phone browser opens the full web app. Follow
[remote access](./remote-access.md) to link it through OOP Connect or a pairing URL.

### Use other devices from your phone

The phone can also open the other devices your desktop has added, such as a Linux
server it reaches over SSH, and continue their threads. They appear next to the
desktop in the thread list and the environment picker, marked "via" your desktop.
The desktop forwards them, so the phone never needs to reach those machines itself.

Each device must be shared from the desktop first: open **Settings → Connections**
and switch on **Available on phone** for it. A device that is off, or whose saved sign-in
no longer works, shows that state on the phone. Turn the switch off to stop sharing it.
The phone checks the list when it opens or returns to the foreground, so reload
the page after sharing a new device.

The React Native app (`apps/mobile`) is no longer the supported phone surface and
gets no new features; the mobile web above is. Push notifications and background
updates belong to the React Native app only.

If the native app crashes during launch, open Settings → Diagnostics on the next
launch that succeeds. It lists startup crashes from the last 7 days with the error
and component stack that store crash reports leave out. Copy the report and paste
it into a GitHub issue. Error messages can quote values from the app, so read it
over before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from OOP's provider settings.                                                                                             |

When an enabled provider's CLI is missing and `npm` is on the server's `PATH`, its
provider card shows **Install**, which installs the CLI with npm and checks that it is
found. Without npm, install Node.js first or use the provider's own installer.

The desktop app also announces what still needs finishing: a provider to install or
sign in to, and an update folder it cannot reach. Turn these off in **Settings →
General → Setup notifications**.

Provider CLIs must be on the server's `PATH`. If OOP cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

OOP warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when OOP can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Click the update icon on the
provider's row, or **Update now** in its details. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, OOP does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating OOP](./updating.md): update the app and connected servers.
