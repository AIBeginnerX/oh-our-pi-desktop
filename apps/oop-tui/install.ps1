# oop 터미널 클라이언트를 빌드해 %LOCALAPPDATA%\oop-terminal 에 설치합니다 (install.sh 의 Windows 판).
# 번들 파일 하나에 의존성이 모두 들어 있으므로, 설치 뒤에는 이 저장소 없이도 동작합니다. Node.js 만 있으면 됩니다.
# 설치 위치는 OOP_BIN_DIR 로 바꿀 수 있습니다. Programs\oop 는 쓰지 않습니다: Windows 는 대소문자를 구분하지 않아
# 데스크톱 앱 폴더 Programs\OOP 와 같은 폴더가 되고, 앱을 업데이트할 때 함께 지워집니다.
# 실행 정책 때문에 막히면: powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$binDir = if ($env:OOP_BIN_DIR) { $env:OOP_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'oop-terminal' }

Set-Location $here
$vp = Join-Path $here '..\..\node_modules\.bin\vp.cmd'
if (-not (Test-Path -LiteralPath $vp)) {
  [Console]::Error.WriteLine("의존성이 없습니다. 저장소 최상위에서 'pnpm install --frozen-lockfile' 을 먼저 실행하세요.")
  exit 1
}
& $vp pack
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path -LiteralPath 'dist\oop.mjs')) {
  [Console]::Error.WriteLine('빌드 결과(dist\oop.mjs)를 찾지 못했습니다.')
  exit 1
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
# 설치 도중 실행 중인 oop 가 깨지지 않도록 임시 파일에 쓴 뒤 바꿔치기합니다.
$tmp = Join-Path $binDir ".oop.$PID.mjs"
Copy-Item -LiteralPath 'dist\oop.mjs' -Destination $tmp
Move-Item -Force -LiteralPath $tmp -Destination (Join-Path $binDir 'oop.mjs')
# oop.cmd 는 같은 폴더의 oop.mjs 를 node 로 실행합니다. cmd.exe 는 현재 폴더를 먼저 뒤지므로, node.exe 가 든
# 저장소에서 oop 을 실행해도 그 파일이 실행되지 않게 NoDefaultCurrentDirectoryInExePath 를 켭니다.
$cmd = "@echo off`r`nsetlocal`r`nset NoDefaultCurrentDirectoryInExePath=1`r`nnode `"%~dp0oop.mjs`" %*`r`n"
Set-Content -Encoding ascii -NoNewline -Path (Join-Path $binDir 'oop.cmd') -Value $cmd

Write-Host "설치했습니다: $(Join-Path $binDir 'oop.cmd')"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '참고: node 를 찾지 못했습니다. oop 은 Node.js 가 있어야 실행됩니다.'
}
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = ($userPath -split ';') + ($env:Path -split ';') |
  Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') }
if (-not $onPath) {
  Write-Host "참고: $binDir 가 PATH 에 없습니다. 사용자 환경 변수 Path 에 추가하세요."
}
