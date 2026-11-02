#!/usr/bin/env bash
# OOP Terminal.app 번들을 만든다.
#   scripts/bundle-macos.sh              -> target/release/OOP Terminal.app
#   PROFILE=debug scripts/bundle-macos.sh -> target/debug/OOP Terminal.app (자동 조종 훅 포함)
#   OOP_RS_BIN=/path/to/oop-rs ...        -> 번들 Contents/Resources 에 oop-rs 를 복사
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
PROFILE="${PROFILE:-release}"
APP_NAME="OOP Terminal"
BUNDLE_ID="com.oop.terminal"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -1)"
ICON_SRC="$REPO/assets/oop/oop-macos-1024.png"

cd "$ROOT"
if [ "$PROFILE" = release ]; then
  cargo build --release
else
  cargo build
fi

APP="$ROOT/target/$PROFILE/$APP_NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/target/$PROFILE/oop-terminal" "$APP/Contents/MacOS/oop-terminal"

# 아이콘: 저장소의 OOP 아이콘 PNG -> icns
if [ -f "$ICON_SRC" ]; then
  SET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$ICON_SRC" --out "$SET/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2))
    sips -z "$d" "$d" "$ICON_SRC" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$(dirname "$SET")"
else
  echo "경고: 아이콘 원본이 없어 아이콘 없이 만듭니다: $ICON_SRC" >&2
fi

# 기본 실행 프로그램(oop-rs)을 같이 넣고 싶을 때
if [ -n "${OOP_RS_BIN:-}" ]; then
  cp "$OOP_RS_BIN" "$APP/Contents/Resources/oop-rs"
  chmod +x "$APP/Contents/Resources/oop-rs"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>oop-terminal</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Folder</string>
      <key>CFBundleTypeRole</key><string>Shell</string>
      <key>LSItemContentTypes</key><array><string>public.folder</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST

# 배포용 서명이 아니라 이 Mac 에서 실행 가능하게 하는 ad-hoc 서명
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
codesign --verify --deep "$APP" && echo "서명 확인 OK (ad-hoc)"
echo "$APP"
