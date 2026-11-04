# Run with: pwsh -NoProfile -File scripts/install-desktop.tests.ps1
# Real PowerShell parser, hashing and filesystem; HTTP and NSIS launch are boundary fixtures.
$ErrorActionPreference = "Stop"
$installer = Get-Content (Join-Path $PSScriptRoot "install-desktop.ps1") -Raw
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
$oldLocalAppData = $env:LOCALAPPDATA
$oldSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
$root = Join-Path ([IO.Path]::GetTempPath()) ("oop-powershell-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $root | Out-Null
# The terminal command is written outside any real profile, whatever this machine has installed.
$env:LOCALAPPDATA = Join-Path $root "local"
$env:OOP_BIN_DIR = Join-Path $root "bin with spaces"
$fixture = Join-Path $root "setup.exe"
[IO.File]::WriteAllText($fixture, "fixture NSIS payload")
$digest = (Get-FileHash $fixture -Algorithm SHA256).Hash.ToLowerInvariant()
$script:downloads = @()
$script:launches = @()
$script:downloadPaths = @()
$script:badHash = $false
$script:downloadFailure = $false
$script:setupExit = 0

function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
    $script:downloads += $Uri
    $script:downloadPaths += $OutFile
    if ($script:downloadFailure) { throw "fixture HTTP failure" }
    if ($Uri.EndsWith(".sha256")) {
        $hash = if ($script:badHash) { "0" * 64 } else { $digest }
        [IO.File]::WriteAllText($OutFile, "$hash  OOP-1.2.3-x64.exe`n")
    } else {
        Copy-Item -LiteralPath $fixture -Destination $OutFile
    }
}
function Invoke-RestMethod {
    param($Uri, $Headers, $TimeoutSec)
    if ($Uri.EndsWith("/install-desktop.ps1")) { return $installer }
    return [PSCustomObject]@{ tag_name = "v1.2.3" }
}
# The registry is a boundary: no per-user uninstall entry unless a scenario sets one.
$script:uninstallEntries = @()
function Get-ItemProperty { $script:uninstallEntries }
function Start-Process {
    param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru)
    if (-not $Wait -or -not $PassThru) { throw "Installer must await and inspect NSIS exit." }
    if ((Get-FileHash $FilePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) { throw "Wrong installer bytes." }
    $script:launches += ,@($ArgumentList)
    return [PSCustomObject]@{ ExitCode = $script:setupExit }
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
    Invoke-RestMethod -Uri "https://fixture.invalid/install-desktop.ps1" | Invoke-Expression
    if ($script:launches.Count -ne 1 -or ($script:launches[0] -join " ") -ne "/S /currentuser") { throw "Incorrect NSIS arguments." }
    if ($script:downloads.Count -ne 2 -or -not $script:downloads[0].EndsWith("/v1.2.3/OOP-1.2.3-x64.exe")) { throw "Wrong release asset." }
    Write-Host "PASS Windows download, checksum, silent per-user launch and exit wait"

    $script:badHash = $true
    Expect-Failure { & $script }
    if ($script:launches.Count -ne 1) { throw "Checksum mismatch launched an installer." }
    Write-Host "PASS checksum mismatch blocks installer execution"
    $script:badHash = $false

    $script:downloadFailure = $true
    Expect-Failure { & $script }
    if ($script:launches.Count -ne 1) { throw "HTTP failure launched an installer." }
    Write-Host "PASS HTTP failure blocks installer execution"
    $script:downloadFailure = $false

    $script:setupExit = 7
    Expect-Failure { & $script }
    Write-Host "PASS nonzero installer exit is an error"
    $script:setupExit = 0

    $env:OOP_VERSION = $null
    & $script
    Write-Host "PASS latest release resolves to a pinned asset version"

    $before = $script:downloads.Count
    $env:OOP_VERSION = "../invalid"
    Expect-Failure { & $script }
    if ($script:downloads.Count -ne $before) { throw "Invalid version reached the network." }
    Write-Host "PASS invalid version fails before download"

    $env:OOP_VERSION = "1.2.3"
    $env:PROCESSOR_ARCHITECTURE = "x86"
    Expect-Failure { & $script }
    Write-Host "PASS unsupported CPU fails before download"
    foreach ($downloadPath in $script:downloadPaths) {
        if (Test-Path -LiteralPath $downloadPath) { throw "Installer left temporary downloads behind." }
    }
    Write-Host "PASS temporary downloads are cleaned after success and failures"

    # The terminal command.
    $env:OOP_VERSION = "1.2.3"
    $env:PROCESSOR_ARCHITECTURE = "AMD64"
    $binDir = $env:OOP_BIN_DIR
    $command = Join-Path $binDir "oop.cmd"
    $appDir = Join-Path $root "OOP app (x86)"
    $appExe = Join-Path $appDir "OOP.exe"
    $bundle = Join-Path $appDir "resources\oop\oop-rs.exe"
    New-Item -ItemType Directory -Path (Split-Path -Parent $bundle) -Force | Out-Null
    [IO.File]::WriteAllText($appExe, "fixture app")
    # Plain ASCII paths are written as they are, with any % doubled (the test folder is ASCII).
    $appExeText = $appExe.Replace("%", "%%")
    $bundleText = $bundle.Replace("%", "%%")
    $script:uninstallEntries = @([PSCustomObject]@{ DisplayName = "OOP"; DisplayIcon = "`"$appExe`",0" })

    # An app without the Rust client has nothing to run.
    & $script
    if (Test-Path -LiteralPath $command) { throw "A terminal command was written for an app without the terminal app." }
    Write-Host "PASS no terminal command for an app without the terminal app"

    [IO.File]::WriteAllText($bundle, "fixture rust client")
    & $script
    $launcher = Get-Content -LiteralPath $command -Raw
    foreach ($expected in @(
        "rem oop-desktop-terminal-launcher",
        "setlocal",
        "set OOP_IN_DESKTOP_APP=1",
        "`"$bundleText`" %*",
        "exit /b %ERRORLEVEL%"
    )) {
        if (-not $launcher.Contains($expected)) { throw "The terminal command lacks: $expected" }
    }
    foreach ($gone in @("OOP_TS_", "OOP_TUI", "oop.mjs", "ELECTRON_RUN_AS_NODE", "typescript")) {
        if ($launcher.Contains($gone)) { throw "The terminal command still mentions $gone." }
    }
    if ($launcher.IndexOf("setlocal") -gt $launcher.IndexOf("set OOP_IN_DESKTOP_APP=1")) { throw "OOP_IN_DESKTOP_APP is set outside setlocal." }
    Write-Host "PASS terminal command runs the app's Rust client, scoped to that process"

    & $script
    Write-Host "PASS reinstalling replaces our own terminal command"

    $foreign = "@echo off`r`necho someone else's oop`r`n"
    [IO.File]::WriteAllText($command, $foreign)
    & $script
    if ([IO.File]::ReadAllText($command) -ne $foreign) { throw "An oop.cmd that is not ours was overwritten." }
    Write-Host "PASS an oop that is not ours is left alone"

    # What the repository's own terminal installer writes is ours to replace.
    [IO.File]::WriteAllText($command, "@echo off`r`nsetlocal`r`nnode `"%~dp0oop.mjs`" %*`r`n")
    & $script
    if (-not (Get-Content -LiteralPath $command -Raw).Contains("rem oop-desktop-terminal-launcher")) { throw "The repository terminal command was not replaced." }
    Write-Host "PASS the repository's own terminal command is replaced"

    # What install-terminal.ps1 writes is ours to replace too.
    [IO.File]::WriteAllText($command, "@echo off`r`nrem oop-terminal-launcher (written by install-terminal.ps1; safe to delete)`r`n")
    & $script
    if (-not (Get-Content -LiteralPath $command -Raw).Contains("rem oop-desktop-terminal-launcher")) { throw "The terminal-only command was not replaced." }
    Write-Host "PASS the terminal-only command from install-terminal.ps1 is replaced"

    # cmd.exe reads a batch file in the console's code page, so a non-ASCII user folder must reach
    # it as %LOCALAPPDATA%, never as text. The characters are built here to keep this file ASCII.
    $hangul = [string][char]0xD55C + [char]0xAE00
    $userHome = Join-Path $root ("user-" + $hangul)
    $env:LOCALAPPDATA = $userHome
    $homeApp = Join-Path $userHome "Programs\OOP"
    $homeExe = Join-Path $homeApp "OOP.exe"
    New-Item -ItemType Directory -Path (Join-Path $homeApp "resources\oop") -Force | Out-Null
    [IO.File]::WriteAllText($homeExe, "fixture app")
    [IO.File]::WriteAllText((Join-Path $homeApp "resources\oop\oop-rs.exe"), "fixture rust client")
    $script:uninstallEntries = @([PSCustomObject]@{ DisplayName = "OOP"; DisplayIcon = "`"$homeExe`",0" })
    Remove-Item -LiteralPath $command -Force
    & $script
    $bytes = [IO.File]::ReadAllBytes($command)
    if (@($bytes | Where-Object { $_ -gt 127 }).Count -ne 0) { throw "The terminal command holds a non-ASCII byte." }
    $homeLauncher = [Text.Encoding]::ASCII.GetString($bytes)
    $homeExpected = '"%LOCALAPPDATA%\Programs\OOP\resources\oop\oop-rs.exe" %*'
    if (-not $homeLauncher.Contains($homeExpected)) { throw "The terminal command does not name the app through %LOCALAPPDATA%." }
    if (-not $homeLauncher.Contains('if not exist "%LOCALAPPDATA%\Programs\OOP\OOP.exe" (')) { throw "The existence check does not use %LOCALAPPDATA%." }
    Write-Host "PASS an app under a non-ASCII user folder is named through %LOCALAPPDATA%, with an ASCII-only file"

    # Outside both variables there is nothing ASCII to write, so no command is made.
    $strayApp = Join-Path $root ("app-" + $hangul)
    $strayExe = Join-Path $strayApp "OOP.exe"
    New-Item -ItemType Directory -Path (Join-Path $strayApp "resources\oop") -Force | Out-Null
    [IO.File]::WriteAllText($strayExe, "fixture app")
    [IO.File]::WriteAllText((Join-Path $strayApp "resources\oop\oop-rs.exe"), "fixture rust client")
    $script:uninstallEntries = @([PSCustomObject]@{ DisplayName = "OOP"; DisplayIcon = "`"$strayExe`",0" })
    Remove-Item -LiteralPath $command -Force
    & $script
    if (Test-Path -LiteralPath $command) { throw "A terminal command was written for a non-ASCII path outside the known folders." }
    Write-Host "PASS a non-ASCII path outside %LOCALAPPDATA% and %ProgramFiles% gets no terminal command"
}
finally {
    $env:OS = $oldOS
    $env:PROCESSOR_ARCHITECTURE = $oldArch
    $env:PROCESSOR_ARCHITEW6432 = $oldWowArch
    $env:OOP_VERSION = $oldVersion
    $env:OOP_RELEASE_BASE_URL = $oldBase
    $env:OOP_BIN_DIR = $oldBinDir
    $env:LOCALAPPDATA = $oldLocalAppData
    [Net.ServicePointManager]::SecurityProtocol = $oldSecurityProtocol
    Remove-Item -LiteralPath $root -Recurse -Force
}
