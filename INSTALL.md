# OOP Desktop installation

The commands below install the desktop app from a GitHub release. Release
v0.0.106 and earlier source-only releases lack binaries. This installation
route works with v0.0.107 and later releases that list the matching installer
and `.sha256` file under **Assets**. A source-only release fails without
changing an existing installation.

## Install

macOS (Apple Silicon):

```sh
curl -fsSL https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-desktop.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-desktop.ps1 | iex
```

Linux (x64):

```sh
curl -fsSL https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-desktop.sh | sh
```

The installers need no Node.js, pnpm, git, or compiler. They verify the
downloaded asset's SHA-256 before installing. They do not bypass macOS
quarantine or Windows SmartScreen.

## Install locations

- macOS: `~/Applications/OOP.app`. If `/Applications/OOP.app` already exists
  and `~/Applications/OOP.app` does not, that copy is updated in place instead
  of installing a second app. Set `OOP_INSTALL_DIR` to override this location.
  When the current user cannot replace the target (for example an
  administrator-owned `/Applications/OOP.app`), the installer checks this before
  downloading and replaces the app only after the macOS administrator approval
  dialog; it never reads or stores the password. If approval is declined, the
  existing app is left unchanged. Remove this app to uninstall.
- Windows: silent per-user NSIS installation with a Start menu entry. To
  uninstall, use Windows Settings → Apps → Installed apps and uninstall OOP.
- Linux: `~/.local/bin/oop-desktop`, the AppImage at
  `~/.local/share/oop-desktop/OOP.AppImage`, and a desktop menu entry. The
  AppImage is extracted and run directly, avoiding a FUSE requirement. Remove
  the launcher, `~/.local/share/oop-desktop`, and menu entry to uninstall.

On macOS and Windows the installers also add an `oop` command: OOP in a terminal,
which runs the terminal app bundled inside OOP and needs no Node.js. On macOS the
command starts the native Rust client (`oop-rs`) bundled in the app and falls back to
the TypeScript terminal when it is missing; `OOP_TUI=ts oop` forces the TypeScript one.
The macOS installer also puts `OOP Terminal.app` (the native terminal window with
splits) next to `OOP.app`. The Windows build is TypeScript only for now. It goes to
`~/.local/bin/oop` on macOS and `%LOCALAPPDATA%\oop-terminal\oop.cmd` on Windows
(`OOP_BIN_DIR` overrides the folder). An existing `oop` that OOP did not create is
never overwritten, and `PATH` is never edited: if `oop` is not found, add that
folder to your `PATH`. On Windows, an app installed in a folder whose name has
non-ASCII characters outside `%LOCALAPPDATA%` and `%ProgramFiles%` gets no command.
Releases without the bundled terminal app get no command,
and the Linux AppImage does not include it. To use `oop` without the desktop app,
see [Terminal app only](#terminal-app-only-no-desktop-app). See
[`docs/user/terminal-app.md`](docs/user/terminal-app.md).

Linux needs GTK and NSS runtime libraries and the Electron sandbox runtime
dependencies. The Linux GUI and real Windows NSIS installation have not been
verified.

## Terminal app only (no desktop app)

To use `oop` without installing the desktop app:

macOS (Apple Silicon) and Linux (x64 or arm64, glibc):

```sh
curl -fsSL https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-terminal.sh | sh
```

Windows PowerShell (x64):

```powershell
irm https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-terminal.ps1 | iex
```

This installs the terminal app (the native `oop-rs` client where the release has
one, with the TypeScript terminal as fallback), the server it starts in the
background, and a private copy of Node.js, all in your user folder. It needs no Node.js, pnpm, git,
or compiler, and it checks the SHA-256 of the download before installing.
Releases before the first one that lists `OOP-terminal-…` files under **Assets**
have no terminal archives; the installer then stops without changing anything.

- Locations: macOS and Linux use `~/.local/share/oop-terminal` and the command
  `~/.local/bin/oop`; Windows uses `%LOCALAPPDATA%\oop-terminal\app` and
  `%LOCALAPPDATA%\oop-terminal\oop.cmd`. `OOP_INSTALL_DIR` sets the first
  folder, `OOP_BIN_DIR` the command's folder, `OOP_VERSION` pins a version, and
  `OOP_RELEASE_BASE_URL` points at a release mirror.
- An existing `oop` that OOP did not create is never overwritten, and an
  existing install folder that this installer did not make is never replaced;
  the installer stops before downloading. `PATH` is never edited: when the
  folder is not on `PATH`, the installer prints the line to add.
- `OOP_TUI=ts oop` runs the TypeScript terminal for one run instead of `oop-rs`.
  A release whose archive has no `oop-rs` gets the TypeScript terminal alone;
  Windows archives are TypeScript only today.
- Intel Macs, Windows on ARM, 32-bit systems, and musl Linux (for example
  Alpine) are not supported and stop with a message. Linux needs glibc and
  `libatomic1`.
- Reinstall and update: run the same command again, then run `oop stop` so the
  new background server starts. On Windows, run `oop stop` first if the old
  server is running, because Windows will not replace files in use. `oop update`
  only reports a newer release and installs nothing.
- Uninstall: run `oop stop`, then delete the install folder and the command
  (`rm -rf ~/.local/share/oop-terminal ~/.local/bin/oop`, or on Windows
  `Remove-Item -Recurse -Force "$env:LOCALAPPDATA\oop-terminal"`). Your data in
  `~/.oop-desktop` is not touched.
- Next step: install and sign in to a provider CLI (for example Claude Code or
  Codex); the installer does not do that. Then run `oop` in a project folder, and
  `oop provider` to see which providers are ready.
- With the desktop app installed too, both use the data folder `~/.oop-desktop`.
  The installer that ran last decides which copy of `oop` the command starts.

Status: only the macOS path has been tried by hand. The release workflow builds
every archive on a runner of its own platform (macOS arm64, Linux x64, Linux
arm64, Windows x64), installs it with these scripts, runs `oop --version` and
the bundled server, and attaches the archives only if all four pass. The Linux
and Windows installers have not been tried by hand on real machines. A failure
in the terminal archives never holds back the desktop installers.

## Update and provider setup

Installed copies on macOS and Windows (0.0.111 and later) update themselves: OOP checks this
repository's GitHub releases, downloads a newer version in the background, verifies its SHA-256,
and installs it when you choose to restart. On Linux, or from an older version, quit OOP and
rerun the same install command. User data is preserved.
Provider CLIs and their logins are separate: install and sign in to a provider
before starting an agent. The desktop binary installer does not install or
authenticate provider CLIs.

## Release asset names

A compatible release must include the appropriate platform asset and a
matching `.sha256` checksum file:

- `OOP-X.Y.Z-arm64.dmg`
- `OOP-X.Y.Z-x64.exe`
- `OOP-X.Y.Z-x86_64.AppImage`

The terminal-only installers use their own assets, each with a `.sha256` file:

- `OOP-terminal-X.Y.Z-macos-arm64.tar.gz`
- `OOP-terminal-X.Y.Z-linux-x64.tar.gz`
- `OOP-terminal-X.Y.Z-linux-arm64.tar.gz`
- `OOP-terminal-X.Y.Z-windows-x64.zip`

Set `OOP_VERSION` to pin the release version. On macOS, `OOP_INSTALL_DIR`
overrides the default `~/Applications` location. On Linux, it overrides the
default `~/.local` prefix, including the launcher, AppImage directory, and menu
entry.

## Build from source instead

The Node.js, pnpm, git, and platform-specific build-tool requirements in the
README apply only to source builds. See the README's “Install / build from
source” section for those instructions.
