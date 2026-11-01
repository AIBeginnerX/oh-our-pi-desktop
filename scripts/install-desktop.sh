#!/bin/sh
# OOP Desktop, not the upstream CLI. No Node or build tools required.
# curl -fsSL https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-desktop.sh | sh
# OOP_VERSION pins a stable version; OOP_RELEASE_BASE_URL supplies a release mirror.
# OOP_INSTALL_DIR overrides ~/Applications (macOS) or ~/.local (Linux). On macOS an existing
# /Applications/OOP.app is updated in place instead of adding a second copy; a location the
# current user cannot change is replaced only after the macOS administrator approval dialog.
# On macOS the app also carries the terminal app; this script adds an "oop" command for it in
# OOP_BIN_DIR (default ~/.local/bin), unless an "oop" that is not ours is already there.
set -eu

fail() { printf 'OOP install: %s\n' "$1" >&2; exit 1; }
repo="AIBeginnerX/oh-our-pi-desktop"
base="${OOP_RELEASE_BASE_URL:-https://github.com/$repo/releases/download}"
command -v curl >/dev/null 2>&1 || fail "curl is required."
case "$(uname -s)" in
  Darwin) platform=mac; extension=dmg ;;
  Linux) platform=linux; extension=AppImage ;;
  *) fail "Use install-desktop.ps1 on Windows. This installer supports macOS and Linux." ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail "Unsupported CPU architecture: $(uname -m)" ;;
esac
asset_arch="$arch"
if [ "$platform" = linux ] && [ "$arch" = x64 ]; then asset_arch=x86_64; fi

version="${OOP_VERSION:-}"
if [ -z "$version" ]; then
  release="$(curl -fsSL --connect-timeout 20 --max-time 60 -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")"
  version="${release##*/}"
  version="${version#v}"
fi
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "OOP_VERSION must be a stable version such as 0.0.106."
# Releases before 0.0.110 named their files OoP.
asset_prefix=OOP
IFS=. read -r major minor patch <<EOF
$version
EOF
if [ "$major" -eq 0 ] && [ "$minor" -eq 0 ] && [ "$patch" -lt 110 ]; then asset_prefix=OoP; fi
asset="$asset_prefix-$version-$asset_arch.$extension"

# Decide where the app goes and whether macOS must approve it before anything is downloaded.
install_dir=
needs_admin=false
if [ "$platform" = mac ]; then
  if [ -n "${OOP_INSTALL_DIR:-}" ]; then
    install_dir="$OOP_INSTALL_DIR"
  elif [ -e /Applications/OOP.app ] && [ ! -e "$HOME/Applications/OOP.app" ]; then
    install_dir=/Applications
  else
    install_dir="$HOME/Applications"
  fi
  if [ -d "$install_dir" ]; then
    if [ ! -w "$install_dir" ] || { [ -e "$install_dir/OOP.app" ] && [ ! -w "$install_dir/OOP.app" ]; }; then
      needs_admin=true
    fi
  elif ! mkdir -p "$install_dir" 2>/dev/null; then
    needs_admin=true
  fi
  if "$needs_admin"; then
    command -v osascript >/dev/null 2>&1 ||
      fail "$install_dir needs administrator approval, but the macOS approval dialog is unavailable. Set OOP_INSTALL_DIR to a folder you own."
    printf '%s is managed by an administrator; macOS will ask for approval before replacing OOP.app.\n' "$install_dir"
  fi
  if [ "$install_dir" != /Applications ] && [ -e /Applications/OOP.app ]; then
    printf 'Note: /Applications/OOP.app also exists; remove one copy to avoid opening an outdated app.\n'
  fi
fi

# The command line "oop" for the terminal app inside OOP.app. The launcher runs the app's own
# runtime as plain Node (ELECTRON_RUN_AS_NODE applies to that one process only) and looks for the
# app again at every start, so moving or updating OOP.app does not break it.
launcher_mark='oop-desktop-terminal-launcher'
sh_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# True when the file is a launcher this script wrote or install-terminal.sh wrote, or the "oop" the
# repository's own terminal installer builds (a node bundle that starts with an env-node shebang and
# names oop-tui).
is_our_oop() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  grep -q "^# $launcher_mark" "$1" 2>/dev/null && return 0
  grep -q '^# oop-terminal-launcher' "$1" 2>/dev/null && return 0
  [ "$(head -n 1 "$1" 2>/dev/null)" = '#!/usr/bin/env node' ] && grep -q 'oop-tui' "$1" 2>/dev/null
}
install_terminal_command() {
  app="$1/OOP.app"
  bin_dir="${OOP_BIN_DIR:-$HOME/.local/bin}"
  target="$bin_dir/oop"
  # Apps older than the terminal app have nothing to run.
  [ -f "$app/Contents/Resources/oop/oop.mjs" ] && [ -x "$app/Contents/MacOS/OOP" ] || return 0
  if [ -e "$target" ] || [ -L "$target" ]; then
    if ! is_our_oop "$target"; then
      printf 'Note: %s already exists and was not made by OOP, so it was left alone. The terminal app is at %s/Contents/Resources/oop/oop.mjs.\n' "$target" "$app"
      return 0
    fi
  fi
  mkdir -p "$bin_dir" || return 1
  launcher_tmp="$(mktemp "$bin_dir/.oop.XXXXXX")" || return 1
  {
    printf '#!/bin/sh\n# %s (written by OOP Desktop install-desktop.sh; safe to delete)\n' "$launcher_mark"
    printf 'for app in %s "$HOME/Applications/OOP.app" /Applications/OOP.app; do\n' "$(sh_quote "$app")"
    cat <<'BODY'
  if [ -x "$app/Contents/MacOS/OOP" ] && [ -f "$app/Contents/Resources/oop/oop.mjs" ]; then
    exec env ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/OOP" "$app/Contents/Resources/oop/oop.mjs" "$@"
  fi
done
echo "oop: OOP.app was not found, or it is too old to include the terminal app. Install or update OOP Desktop." >&2
exit 127
BODY
  } > "$launcher_tmp" || { rm -f "$launcher_tmp"; return 1; }
  chmod 755 "$launcher_tmp" && mv -f "$launcher_tmp" "$target" || { rm -f "$launcher_tmp"; return 1; }
  printf 'Installed the terminal command %s.\n' "$target"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) printf 'Note: %s is not on PATH. Add it to your shell profile to run "oop" from anywhere.\n' "$bin_dir" ;;
  esac
}

tmp="$(mktemp -d "${TMPDIR:-/tmp}/oop-install.XXXXXX")"
mounted=false
cleanup() {
  if "$mounted"; then hdiutil detach "$tmp/mount" -quiet || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Downloading OOP %s for %s-%s...\n' "$version" "$platform" "$arch"
curl -fSL --connect-timeout 20 --max-time 1800 "$base/v$version/$asset" -o "$tmp/$asset" ||
  fail "No downloadable $asset. This release may be source-only; see the repository's Releases page."
curl -fsSL --connect-timeout 20 --max-time 60 "$base/v$version/$asset.sha256" -o "$tmp/checksum" ||
  fail "The release has no checksum for $asset; nothing was installed."
expected="$(awk 'NR == 1 { print tolower($1) }' "$tmp/checksum")"
printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' || fail "Invalid SHA-256 file."
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
else
  fail "sha256sum or shasum is required."
fi
[ "$actual" = "$expected" ] || fail "SHA-256 mismatch; nothing was installed."

if [ "$platform" = mac ]; then
  mkdir -p "$tmp/mount"
  hdiutil attach "$tmp/$asset" -mountpoint "$tmp/mount" -nobrowse -readonly -quiet
  mounted=true
  [ -d "$tmp/mount/$asset_prefix.app" ] || fail "The disk image does not contain $asset_prefix.app."
  # One replacement routine for both paths: copy into a fresh directory first (never merge new
  # files into an older bundle), swap, and put the previous app back if anything fails.
  cat > "$tmp/replace.sh" <<'REPLACE'
#!/bin/sh
set -eu
src="$1"
dir="$2"
mkdir -p "$dir"
staged="$(mktemp -d "$dir/.oop-install.XXXXXX")"
restore() {
  if [ -e "$staged/previous.app" ] && [ ! -e "$dir/OOP.app" ]; then
    mv "$staged/previous.app" "$dir/OOP.app"
  fi
  rm -rf "$staged"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ditto "$src" "$staged/OOP.app" || { echo "Could not copy OOP.app; the existing app was not changed." >&2; exit 1; }
# An administrator replacement keeps the owner the previous app had.
if [ "$(id -u)" = 0 ] && [ -e "$dir/OOP.app" ]; then
  chown -R "$(stat -f '%u:%g' "$dir/OOP.app")" "$staged/OOP.app"
fi
if [ -e "$dir/OOP.app" ]; then mv "$dir/OOP.app" "$staged/previous.app"; fi
mv "$staged/OOP.app" "$dir/OOP.app"
REPLACE
  if "$needs_admin"; then
    # The password goes only to the macOS authorization dialog; this script never sees it.
    osascript \
      -e 'on run argv' \
      -e 'do shell script "/bin/sh " & quoted form of item 1 of argv & " " & quoted form of item 2 of argv & " " & quoted form of item 3 of argv with administrator privileges' \
      -e 'end run' \
      "$tmp/replace.sh" "$tmp/mount/$asset_prefix.app" "$install_dir" ||
      fail "Administrator approval was not given or the replacement failed; the existing app was not changed."
  else
    sh "$tmp/replace.sh" "$tmp/mount/$asset_prefix.app" "$install_dir" ||
      fail "Could not install OOP.app; the existing app was not changed."
  fi
  printf 'Installed %s/OOP.app. Open it from Finder.\n' "$install_dir"
  install_terminal_command "$install_dir" ||
    printf 'Note: the "oop" terminal command could not be set up; OOP.app itself is installed.\n'
  printf 'This unsigned/notarization-free build may require Privacy & Security > Open Anyway.\n'
else
  prefix="${OOP_INSTALL_DIR:-$HOME/.local}"
  mkdir -p "$prefix/bin" "$prefix/share/oop-desktop" "$prefix/share/applications"
  chmod 755 "$tmp/$asset"
  rm -f "$prefix/share/oop-desktop/OoP.AppImage"
  mv "$tmp/$asset" "$prefix/share/oop-desktop/OOP.AppImage"
  cat > "$prefix/bin/oop-desktop" <<'LAUNCHER'
#!/bin/sh
export APPIMAGE_EXTRACT_AND_RUN=1
bin="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$bin/../share/oop-desktop/OOP.AppImage" "$@"
LAUNCHER
  chmod 755 "$prefix/bin/oop-desktop"
  launcher="$(printf '%s' "$prefix/bin/oop-desktop" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/\$/\\$/g; s/%/%%/g')"
  printf '[Desktop Entry]\nType=Application\nName=OOP\nExec="%s" %%U\nTerminal=false\nCategories=Development;\nMimeType=x-scheme-handler/t3code;x-scheme-handler/t3code-dev;\n' "$launcher" > "$prefix/share/applications/oop-desktop.desktop"
  printf 'Installed %s/bin/oop-desktop and the OOP application menu entry.\n' "$prefix"
  case ":$PATH:" in
    *":$prefix/bin:"*) printf 'Run oop-desktop to start.\n' ;;
    *) printf 'Start with "%s/bin/oop-desktop", or add "%s/bin" to PATH.\n' "$prefix" "$prefix" ;;
  esac
fi
