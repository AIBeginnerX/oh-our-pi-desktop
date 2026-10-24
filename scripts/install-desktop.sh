#!/bin/sh
# OoP Desktop, not the upstream T3 Code CLI. No Node or build tools required.
# curl -fsSL https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-desktop.sh | sh
# OOP_VERSION pins a stable version; OOP_RELEASE_BASE_URL supplies a release mirror.
# OOP_INSTALL_DIR overrides ~/Applications (macOS) or ~/.local (Linux).
set -eu

fail() { printf 'OoP install: %s\n' "$1" >&2; exit 1; }
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
asset="OoP-$version-$asset_arch.$extension"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/oop-install.XXXXXX")"
mounted=false
staged=
install_dir=
cleanup() {
  if "$mounted"; then hdiutil detach "$tmp/mount" -quiet || true; fi
  if [ -n "$staged" ] && [ -d "$staged" ]; then
    if [ -e "$staged/previous.app" ] && [ ! -e "$install_dir/OoP.app" ]; then
      mv "$staged/previous.app" "$install_dir/OoP.app"
    fi
    rm -rf "$staged"
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Downloading OoP %s for %s-%s...\n' "$version" "$platform" "$arch"
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
  install_dir="${OOP_INSTALL_DIR:-$HOME/Applications}"
  mkdir -p "$install_dir" "$tmp/mount"
  hdiutil attach "$tmp/$asset" -mountpoint "$tmp/mount" -nobrowse -readonly -quiet
  mounted=true
  [ -d "$tmp/mount/OoP.app" ] || fail "The disk image does not contain OoP.app."
  # Copy into a new directory first; never merge new files into an older app bundle.
  staged="$(mktemp -d "$install_dir/.oop-install.XXXXXX")"
  if ! ditto "$tmp/mount/OoP.app" "$staged/OoP.app"; then
    rm -rf "$staged"
    fail "Could not copy OoP.app; the existing app was not changed."
  fi
  if [ -e "$install_dir/OoP.app" ]; then
    mv "$install_dir/OoP.app" "$staged/previous.app"
  fi
  if ! mv "$staged/OoP.app" "$install_dir/OoP.app"; then
    if [ -e "$staged/previous.app" ]; then mv "$staged/previous.app" "$install_dir/OoP.app"; fi
    rm -rf "$staged"
    fail "Could not install OoP.app."
  fi
  rm -rf "$staged"
  printf 'Installed %s/OoP.app. Open it from Finder.\n' "$install_dir"
  printf 'This unsigned/notarization-free build may require Privacy & Security > Open Anyway.\n'
else
  prefix="${OOP_INSTALL_DIR:-$HOME/.local}"
  mkdir -p "$prefix/bin" "$prefix/share/oop-desktop" "$prefix/share/applications"
  chmod 755 "$tmp/$asset"
  mv "$tmp/$asset" "$prefix/share/oop-desktop/OoP.AppImage"
  cat > "$prefix/bin/oop-desktop" <<'LAUNCHER'
#!/bin/sh
export APPIMAGE_EXTRACT_AND_RUN=1
bin="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$bin/../share/oop-desktop/OoP.AppImage" "$@"
LAUNCHER
  chmod 755 "$prefix/bin/oop-desktop"
  launcher="$(printf '%s' "$prefix/bin/oop-desktop" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/\$/\\$/g; s/%/%%/g')"
  printf '[Desktop Entry]\nType=Application\nName=OoP\nExec="%s" %%U\nTerminal=false\nCategories=Development;\nMimeType=x-scheme-handler/t3code;x-scheme-handler/t3code-dev;\n' "$launcher" > "$prefix/share/applications/oop-desktop.desktop"
  printf 'Installed %s/bin/oop-desktop and the OoP application menu entry.\n' "$prefix"
  case ":$PATH:" in
    *":$prefix/bin:"*) printf 'Run oop-desktop to start.\n' ;;
    *) printf 'Start with "%s/bin/oop-desktop", or add "%s/bin" to PATH.\n' "$prefix" "$prefix" ;;
  esac
fi
