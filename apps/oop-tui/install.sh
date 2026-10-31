#!/usr/bin/env sh
# oop 터미널 클라이언트를 빌드해 ~/.local/bin/oop 로 설치합니다.
# 번들 파일 하나에 의존성이 모두 들어 있으므로, 설치 뒤에는 이 저장소 없이도 동작합니다.
# 설치 위치는 OOP_BIN_DIR 로 바꿀 수 있습니다.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
bin_dir=${OOP_BIN_DIR:-"$HOME/.local/bin"}

cd "$here"
vp=../../node_modules/.bin/vp
if [ ! -x "$vp" ]; then
  echo "의존성이 없습니다. 저장소 최상위에서 'pnpm install --frozen-lockfile' 을 먼저 실행하세요." >&2
  exit 1
fi
"$vp" pack

if [ ! -f dist/oop.mjs ]; then
  echo "빌드 결과(dist/oop.mjs)를 찾지 못했습니다." >&2
  exit 1
fi

mkdir -p "$bin_dir"
# 설치 도중 실행 중인 oop 가 깨지지 않도록 임시 파일에 쓴 뒤 바꿔치기합니다.
tmp="$bin_dir/.oop.$$"
cp dist/oop.mjs "$tmp"
chmod 0755 "$tmp"
mv -f "$tmp" "$bin_dir/oop"
# 이전 이름으로 설치된 파일은 남기지 않습니다.
rm -f "$bin_dir/oop-tui"

echo "설치했습니다: $bin_dir/oop"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "참고: $bin_dir 가 PATH 에 없습니다. 셸 설정에 추가하세요." ;;
esac
