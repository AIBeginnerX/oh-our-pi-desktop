# Run with: pwsh -NoProfile -File scripts/install-terminal.tests.ps1   (Windows only: it unpacks a real zip with tar.exe)
# Real PowerShell parser, hashing, unpacking and filesystem; HTTP and running node.exe are boundary fixtures.
$ErrorActionPreference = "Stop"
$installer = Get-Content (Join-Path $PSScriptRoot "install-terminal.ps1") -Raw
$parseErrors = $null
$tokens = $null
[Management.Automation.Language.Parser]::ParseInput($installer, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
$script = [ScriptBlock]::Create($installer)
$oldOS = $env:OS
$oldArch = $env:PROCESSOR_ARCHITECTURE
$oldWowArch = $env:PROCESSOR_ARCHITEW6432
$oldVersion = $env:OOP_VERSION
$oldBase = $env:OOP_RELEASE_BASE_URL
$oldBinDir = $env:OOP_BIN_DIR
$oldInstallDir = $env:OOP_INSTALL_DIR
$oldLocalAppData = $env:LOCALAPPDATA
$oldSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
$root = Join-Path ([IO.Path]::GetTempPath()) ("oop-terminal-powershell-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $root | Out-Null
# Everything is written outside any real profile, whatever this machine has installed.
$env:LOCALAPPDATA = Join-Path $root "local"
$env:OOP_BIN_DIR = Join-Path $root "bin with spaces"
$env:OOP_INSTALL_DIR = Join-Path $root "install with spaces\app"
$stage = Join-Path $root "stage"
$content = Join-Path $stage "oop-terminal"
New-Item -ItemType Directory -Path (Join-Path $content "apps\server\dist") -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $content "node.exe"), "fixture runtime")
[IO.File]::WriteAllText((Join-Path $content "oop.mjs"), "// fixture terminal app")
[IO.File]::WriteAllText((Join-Path $content "apps\server\dist\bin.mjs"), "// fixture server")
[IO.File]::WriteAllText((Join-Path $content "new-in-this-version.txt"), "new")
$fixture = Join-Path $root "fixture.zip"
& (Join-Path $env:SystemRoot "System32\tar.exe") -a -c -f $fixture -C $stage oop-terminal
if ($LASTEXITCODE -ne 0) { throw "Could not build the fixture archive." }
$digest = (Get-FileHash $fixture -Algorithm SHA256).Hash.ToLowerInvariant()
$script:downloads = @()
$script:badHash = $false
$script:downloadFailure = $false
$script:printedVersion = "1.2.3"
$script:nodeExit = 0

function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
    $script:downloads += $Uri
    if ($script:downloadFailure) { throw "fixture HTTP failure" }
    if ($Uri.EndsWith(".sha256")) {
        $hash = if ($script:badHash) { "0" * 64 } else { $digest }
        [IO.File]::WriteAllText($OutFile, "$hash  OOP-terminal-1.2.3-windows-x64.zip`n")
    } else {
        Copy-Item -LiteralPath $fixture -Destination $OutFile
    }
}
function Invoke-RestMethod {
    param($Uri, $Headers, $TimeoutSec)
    return [PSCustomObject]@{ tag_name = "v1.2.3" }
}
# The runtime is a boundary: node.exe here is a text file, so "running" it prints what a scenario says.
function Start-Process {
    param($FilePath, $ArgumentList, $RedirectStandardOutput, [switch]$Wait, [switch]$PassThru, [switch]$NoNewWindow)
    if (-not $FilePath.EndsWith("node.exe")) { throw "Unexpected program $FilePath." }
    [IO.File]::WriteAllText($RedirectStandardOutput, "$($script:printedVersion)`r`n")
    return [PSCustomObject]@{ ExitCode = $script:nodeExit }
}
function Expect-Failure {
    param([ScriptBlock]$Action)
    $failed = $false
    try { & $Action } catch { $failed = $true }
    if (-not $failed) { throw "Expected installer failure." }
}
try {
    $env:OS = "Windows_NT"
    $env:PROCESSOR_ARCHITECTURE = "AMD64"
    $env:PROCESSOR_ARCHITEW6432 = $null
    $env:OOP_VERSION = "1.2.3"
    $env:OOP_RELEASE_BASE_URL = "https://fixture.invalid/releases/download"
    $command = Join-Path $env:OOP_BIN_DIR "oop.cmd"
    & $script
    if ($script:downloads.Count -ne 2 -or -not $script:downloads[0].EndsWith("/v1.2.3/OOP-terminal-1.2.3-windows-x64.zip")) { throw "Wrong release asset." }
    foreach ($file in @("node.exe", "oop.mjs", "apps\server\dist\bin.mjs", ".oop-terminal-install")) {
        if (-not (Test-Path -LiteralPath (Join-Path $env:OOP_INSTALL_DIR $file))) { throw "$file was not installed." }
    }
    Write-Host "PASS download, checksum, unpack and install of the terminal app"

    $launcher = Get-Content -LiteralPath $command -Raw
    $rootText = $env:OOP_INSTALL_DIR.Replace("%", "%%")
    foreach ($expected in @(
        "rem oop-terminal-launcher",
        "setlocal",
        "if not defined OOP_DAEMON_ENTRY set `"OOP_DAEMON_ENTRY=$rootText\apps\server\dist\bin.mjs`"",
        "`"$rootText\node.exe`" `"$rootText\oop.mjs`" %*",
        "exit /b %ERRORLEVEL%"
    )) {
        if (-not $launcher.Contains($expected)) { throw "The terminal command lacks: $expected" }
    }
    if ($launcher.IndexOf("setlocal") -gt $launcher.IndexOf("set `"OOP_DAEMON_ENTRY=")) { throw "OOP_DAEMON_ENTRY is set outside setlocal." }
    if (@([IO.File]::ReadAllBytes($command) | Where-Object { $_ -gt 127 }).Count -ne 0) { throw "The terminal command holds a non-ASCII byte." }
    Write-Host "PASS oop.cmd runs the bundled runtime with the bundled server as OOP_DAEMON_ENTRY, scoped to that process"

    [IO.File]::WriteAllText((Join-Path $env:OOP_INSTALL_DIR "stale-from-old-version.txt"), "old")
    & $script
    if (Test-Path -LiteralPath (Join-Path $env:OOP_INSTALL_DIR "stale-from-old-version.txt")) { throw "Reinstalling kept a file of the old version." }
    if (@(Get-ChildItem -LiteralPath (Split-Path -Parent $env:OOP_INSTALL_DIR) -Force | Where-Object { $_.Name -like ".oop-terminal-new.*" }).Count -ne 0) { throw "A staging folder was left behind." }
    Write-Host "PASS reinstalling replaces the whole folder and leaves no staging folder"

    $script:badHash = $true
    Expect-Failure { & $script }
    $script:badHash = $false
    $script:downloadFailure = $true
    Expect-Failure { & $script }
    $script:downloadFailure = $false
    Write-Host "PASS checksum mismatch and HTTP failure are errors"

    $script:printedVersion = "9.9.9"
    Expect-Failure { & $script }
    $script:printedVersion = "1.2.3"
    $script:nodeExit = 3
    Expect-Failure { & $script }
    $script:nodeExit = 0
    if (-not (Test-Path -LiteralPath (Join-Path $env:OOP_INSTALL_DIR "new-in-this-version.txt"))) { throw "A failed check damaged the existing install." }
    Write-Host "PASS an app that reports another version or does not run changes nothing"

    $foreign = "@echo off`r`necho someone else's oop`r`n"
    [IO.File]::WriteAllText($command, $foreign)
    $before = $script:downloads.Count
    Expect-Failure { & $script }
    if ([IO.File]::ReadAllText($command) -ne $foreign) { throw "An oop.cmd that is not ours was overwritten." }
    if ($script:downloads.Count -ne $before) { throw "A foreign oop.cmd did not stop the install before the download." }
    Write-Host "PASS an oop that is not ours is left alone, before any download"

    [IO.File]::WriteAllText($command, "@echo off`r`nrem oop-desktop-terminal-launcher (written by OOP Desktop install-desktop.ps1; safe to delete)`r`n")
    & $script
    if (-not (Get-Content -LiteralPath $command -Raw).Contains("rem oop-terminal-launcher")) { throw "The desktop installer's command was not replaced." }
    Write-Host "PASS the command from install-desktop.ps1 is replaced"

    $other = Join-Path $root "other folder"
    New-Item -ItemType Directory -Path $other | Out-Null
    [IO.File]::WriteAllText((Join-Path $other "precious.txt"), "keep")
    $env:OOP_INSTALL_DIR = $other
    $before = $script:downloads.Count
    Expect-Failure { & $script }
    if (-not (Test-Path -LiteralPath (Join-Path $other "precious.txt")) -or $script:downloads.Count -ne $before) { throw "A folder this installer did not make was touched." }
    Write-Host "PASS a folder this installer did not make is refused before any download"

    $env:PROCESSOR_ARCHITECTURE = "ARM64"
    $before = $script:downloads.Count
    Expect-Failure { & $script }
    $env:PROCESSOR_ARCHITECTURE = "x86"
    Expect-Failure { & $script }
    if ($script:downloads.Count -ne $before) { throw "An unsupported CPU reached the network." }
    Write-Host "PASS Windows on ARM and 32-bit CPUs fail before download"
}
finally {
    $env:OS = $oldOS
    $env:PROCESSOR_ARCHITECTURE = $oldArch
    $env:PROCESSOR_ARCHITEW6432 = $oldWowArch
    $env:OOP_VERSION = $oldVersion
    $env:OOP_RELEASE_BASE_URL = $oldBase
    $env:OOP_BIN_DIR = $oldBinDir
    $env:OOP_INSTALL_DIR = $oldInstallDir
    $env:LOCALAPPDATA = $oldLocalAppData
    [Net.ServicePointManager]::SecurityProtocol = $oldSecurityProtocol
    Remove-Item -LiteralPath $root -Recurse -Force
}
