#!/bin/sh
# OOP terminal app ("oop") without the desktop app. No Node.js, pnpm or git required.
# curl -fsSL https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-terminal.sh | sh
# macOS (Apple Silicon) and Linux (x64, arm64; glibc). Windows: install-terminal.ps1.
# OOP_VERSION pins a stable version; OOP_RELEASE_BASE_URL supplies a release mirror.
# OOP_INSTALL_DIR is the folder the terminal app is unpacked into (default ~/.local/share/oop-terminal);
# OOP_BIN_DIR is where the "oop" command goes (default ~/.local/bin). PATH is never edited.
# Running it again reinstalls (replaces the unpacked folder). An "oop" that OOP did not create is
# never overwritten. To uninstall: oop stop; rm -rf ~/.local/share/oop-terminal ~/.local/bin/oop
set -eu

fail() { printf 'OOP terminal install: %s\n' "$1" >&2; exit 1; }
repo="AIBeginnerX/oh-our-pi-desktop"
base="${OOP_RELEASE_BASE_URL:-https://github.com/$repo/releases/download}"
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."
case "$(uname -s)" in
  Darwin) platform=macos ;;
  Linux) platform=linux ;;
  *) fail "Use install-terminal.ps1 on Windows. This installer supports macOS and Linux." ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail "Unsupported CPU architecture: $(uname -m). Supported: Apple Silicon Mac, Linux x64 and arm64." ;;
esac
if [ "$platform" = macos ] && [ "$arch" != arm64 ]; then
  fail "Intel Macs are not supported. The terminal app is built for Apple Silicon only."
fi
if [ "$platform" = linux ] && { ldd --version 2>&1 || true; } | grep -qi musl; then
  fail "This Linux uses musl libc (for example Alpine). Only glibc distributions are supported."
fi

version="${OOP_VERSION:-}"
if [ -z "$version" ]; then
  release="$(curl -fsSL --connect-timeout 20 --max-time 60 -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")"
  version="${release##*/}"
  version="${version#v}"
fi
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "OOP_VERSION must be a stable version such as 0.0.132."
asset="OOP-terminal-$version-$platform-$arch.tar.gz"

root="${OOP_INSTALL_DIR:-$HOME/.local/share/oop-terminal}"
bin_dir="${OOP_BIN_DIR:-$HOME/.local/bin}"
target="$bin_dir/oop"
install_mark='.oop-terminal-install'
launcher_mark='oop-terminal-launcher'
sh_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# True for a launcher written by this script or by install-desktop.sh, or the "oop" the repository's
# own source installer builds (a node bundle that starts with an env-node shebang and names oop-tui).
is_our_oop() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  grep -q "^# $launcher_mark" "$1" 2>/dev/null && return 0
  grep -q '^# oop-desktop-terminal-launcher' "$1" 2>/dev/null && return 0
  [ "$(head -n 1 "$1" 2>/dev/null)" = '#!/usr/bin/env node' ] && grep -q 'oop-tui' "$1" 2>/dev/null
}

# Refuse before downloading anything when the install would touch something that is not ours.
if [ -e "$target" ] || [ -L "$target" ]; then
  is_our_oop "$target" ||
    fail "$target already exists and was not made by OOP, so nothing was installed. Move it away or set OOP_BIN_DIR to another folder."
fi
if [ -e "$root" ] || [ -L "$root" ]; then
  if [ ! -d "$root" ] || [ -L "$root" ]; then
    fail "$root exists and is not an OOP terminal install folder. Set OOP_INSTALL_DIR to another folder."
  fi
  if [ ! -f "$root/$install_mark" ] && [ -n "$(ls -A "$root" 2>/dev/null)" ]; then
    fail "$root is not empty and was not made by this installer, so nothing was installed. Set OOP_INSTALL_DIR to another folder."
  fi
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/oop-terminal-install.XXXXXX")"
staging=
cleanup() {
  rm -rf "$tmp"
  if [ -n "$staging" ]; then rm -rf "$staging"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Downloading the OOP terminal app %s for %s-%s...\n' "$version" "$platform" "$arch"
curl -fSL --connect-timeout 20 --max-time 1800 "$base/v$version/$asset" -o "$tmp/$asset" ||
  fail "No downloadable $asset. This release may not include the terminal app; see the repository's Releases page."
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

# Unpack beside the final folder, so the swap below is a rename on one file system.
parent="$(dirname "$root")"
mkdir -p "$parent" "$bin_dir"
staging="$(mktemp -d "$parent/.oop-terminal-new.XXXXXX")"
tar -xzf "$tmp/$asset" -C "$staging" || fail "Could not unpack $asset; nothing was installed."
new="$staging/oop-terminal"
[ -x "$new/node" ] && [ -f "$new/oop.mjs" ] && [ -f "$new/apps/server/dist/bin.mjs" ] ||
  fail "$asset is not a complete terminal app; nothing was installed."
# Run it once where it stands, so a missing system library shows up now and not at the first "oop".
printed="$("$new/node" "$new/oop.mjs" --version 2>&1)" ||
  fail "The downloaded terminal app does not run on this computer ($printed). On Linux it needs glibc and libatomic1; nothing was installed."
[ "$(printf '%s\n' "$printed" | tail -n 1)" = "$version" ] ||
  fail "The downloaded terminal app reports \"$printed\", not $version; nothing was installed."
printf '%s\n' "$version" > "$new/$install_mark"

# Replace the old folder in two renames and put it back if the second one fails. A running oop keeps
# the files it already opened.
if [ -d "$root" ]; then mv "$root" "$staging/previous" || fail "Could not replace $root; nothing was changed."; fi
if ! mv "$new" "$root"; then
  if [ -d "$staging/previous" ]; then mv "$staging/previous" "$root" || true; fi
  fail "Could not install into $root."
fi

# The command. The launcher points the terminal at the server that came with it (OOP_DAEMON_ENTRY),
# which is how "oop" starts a background server when no desktop app is running.
launcher_tmp="$(mktemp "$bin_dir/.oop.XXXXXX")" || fail "Could not write into $bin_dir."
{
  printf '#!/bin/sh\n# %s (written by install-terminal.sh; safe to delete)\n' "$launcher_mark"
  printf 'root=%s\n' "$(sh_quote "$root")"
  cat <<'BODY'
if [ ! -x "$root/node" ] || [ ! -f "$root/oop.mjs" ]; then
  echo "oop: the OOP terminal app was not found in $root. Run the install command again." >&2
  exit 127
fi
OOP_DAEMON_ENTRY="${OOP_DAEMON_ENTRY:-$root/apps/server/dist/bin.mjs}"
OOP_TERMINAL_INSTALL=1
export OOP_DAEMON_ENTRY OOP_TERMINAL_INSTALL
exec "$root/node" "$root/oop.mjs" "$@"
BODY
} > "$launcher_tmp" || { rm -f "$launcher_tmp"; fail "Could not write the oop command."; }
chmod 755 "$launcher_tmp" && mv -f "$launcher_tmp" "$target" || { rm -f "$launcher_tmp"; fail "Could not install $target."; }

printf 'Installed OOP terminal app %s in %s and the command %s.\n' "$version" "$root" "$target"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    printf '\n%s is not on PATH yet. Add it for new terminals, for example:\n' "$bin_dir"
    printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc   # zsh (macOS default)\n' "$bin_dir"
    printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.bashrc  # bash\n' "$bin_dir"
    printf 'Then open a new terminal, or run "%s" directly.\n' "$target"
    ;;
esac
printf '\nNext:\n'
printf '  1. Sign in to a provider CLI first (for example Claude Code or Codex). OOP does not sign in for you.\n'
printf '  2. In a project folder, run: oop    (oop provider shows which providers are ready)\n'
printf 'Update: run this install command again, then "oop stop" so the new background server starts.\n'
printf 'Uninstall: oop stop; rm -rf %s %s\n' "$(sh_quote "$root")" "$(sh_quote "$target")"
