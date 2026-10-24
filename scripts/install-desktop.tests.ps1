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
$oldSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
$root = Join-Path ([IO.Path]::GetTempPath()) ("oop-powershell-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $root | Out-Null
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
        [IO.File]::WriteAllText($OutFile, "$hash  OoP-1.2.3-x64.exe`n")
    } else {
        Copy-Item -LiteralPath $fixture -Destination $OutFile
    }
}
function Invoke-RestMethod {
    param($Uri, $Headers, $TimeoutSec)
    if ($Uri.EndsWith("/install-desktop.ps1")) { return $installer }
    return [PSCustomObject]@{ tag_name = "v1.2.3" }
}
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
    if ($script:downloads.Count -ne 2 -or -not $script:downloads[0].EndsWith("/v1.2.3/OoP-1.2.3-x64.exe")) { throw "Wrong release asset." }
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
}
finally {
    $env:OS = $oldOS
    $env:PROCESSOR_ARCHITECTURE = $oldArch
    $env:PROCESSOR_ARCHITEW6432 = $oldWowArch
    $env:OOP_VERSION = $oldVersion
    $env:OOP_RELEASE_BASE_URL = $oldBase
    [Net.ServicePointManager]::SecurityProtocol = $oldSecurityProtocol
    Remove-Item -LiteralPath $root -Recurse -Force
}
