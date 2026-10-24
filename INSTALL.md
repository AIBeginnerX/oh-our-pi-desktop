# OoP Desktop installation

The commands below install the desktop app from a GitHub release. Release
v0.0.105 and earlier source-only releases lack binaries. This installation
route works with v0.0.106 and later releases that list the matching installer
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

- macOS: `~/Applications/OoP.app`. Set `OOP_INSTALL_DIR` to override this
  location. Remove this app to uninstall.
- Windows: silent per-user NSIS installation with a Start menu entry. To
  uninstall, use Windows Settings → Apps → Installed apps and uninstall OoP.
- Linux: `~/.local/bin/oop-desktop`, the AppImage at
  `~/.local/share/oop-desktop/OoP.AppImage`, and a desktop menu entry. The
  AppImage is extracted and run directly, avoiding a FUSE requirement. Remove
  the launcher, `~/.local/share/oop-desktop`, and menu entry to uninstall.

Linux needs GTK and NSS runtime libraries and the Electron sandbox runtime
dependencies. The Linux GUI and real Windows NSIS installation have not been
verified.

## Update and provider setup

Quit OoP, then rerun the same install command to update. User data is preserved.
Provider CLIs and their logins are separate: install and sign in to a provider
before starting an agent. The desktop binary installer does not install or
authenticate provider CLIs.

## Release asset names

A compatible release must include the appropriate platform asset and a
matching `.sha256` checksum file:

- `OoP-X.Y.Z-arm64.dmg`
- `OoP-X.Y.Z-x64.exe`
- `OoP-X.Y.Z-x86_64.AppImage`

Set `OOP_VERSION` to pin the release version. On macOS, `OOP_INSTALL_DIR`
overrides the default `~/Applications` location. On Linux, it overrides the
default `~/.local` prefix, including the launcher, AppImage directory, and menu
entry.

## Build from source instead

The Node.js, pnpm, git, and platform-specific build-tool requirements in the
README apply only to source builds. See the README's “Install / build from
source” section for those instructions.
