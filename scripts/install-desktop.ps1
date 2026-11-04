# OOP Desktop, not the upstream CLI. Windows PowerShell 5.1+.
# irm https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-desktop.ps1 | iex
# OOP_VERSION pins a stable version; OOP_RELEASE_BASE_URL supplies a release mirror.
# The app also carries the terminal app; this script adds an "oop" command for it in OOP_BIN_DIR
# (default %LOCALAPPDATA%\oop-terminal), unless an "oop" that is not ours is already there. The
# command runs the app's Rust terminal client (resources\oop\oop-rs.exe).
& {
    $ErrorActionPreference = "Stop"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    if ($env:OS -ne "Windows_NT") { throw "This installer requires Windows." }
    $repo = "AIBeginnerX/oh-our-pi-desktop"
    $base = if ($env:OOP_RELEASE_BASE_URL) { $env:OOP_RELEASE_BASE_URL.TrimEnd("/") } else { "https://github.com/$repo/releases/download" }
    $machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = switch ($machine) {
        "AMD64" { "x64" }
        "ARM64" { "arm64" }
        default { throw "Unsupported CPU architecture: $machine" }
    }
    $version = $env:OOP_VERSION
    if (-not $version) {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "oop-desktop-installer" } -TimeoutSec 60
        $version = $release.tag_name -replace "^v", ""
    }
    if ($version -notmatch "^\d+\.\d+\.\d+$") { throw "OOP_VERSION must be a stable version such as 0.0.106." }
    # Releases before 0.0.110 named their files OoP.
    $assetPrefix = if ([version]$version -lt [version]"0.0.110") { "OoP" } else { "OOP" }
    $asset = "$assetPrefix-$version-$arch.exe"
    $launcherMark = "oop-desktop-terminal-launcher"
    # The per-user installer records the app as DisplayIcon ("<install dir>\OOP.exe",0) under the
    # Uninstall key; the default per-user folder is the fallback.
    function Find-OopApp {
        $executable = $null
        try {
            $entry = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -like "OOP*" } | Select-Object -First 1
            if ($entry -and $entry.DisplayIcon) { $executable = ([string]$entry.DisplayIcon) -replace '^"|"?,\d+$|"$', "" }
        } catch { }
        if (-not $executable -and $env:LOCALAPPDATA) { $executable = Join-Path $env:LOCALAPPDATA "Programs\OOP\OOP.exe" }
        if ($executable -and (Test-Path -LiteralPath $executable -PathType Leaf)) { return $executable }
        return $null
    }
    # True for a launcher this script or install-terminal.ps1 wrote, or the oop.cmd that the
    # repository's own source installer wrote before the Rust client (it runs a sibling oop.mjs
    # with node), which is replaced.
    function Test-OurOopCommand([string]$path) {
        $text = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
        if (-not $text) { return $false }
        return $text.Contains("rem $launcherMark") -or $text.Contains("rem oop-terminal-launcher") -or ($text.Contains('node "%~dp0oop.mjs" %*'))
    }
    # The path as a batch file may spell it, or $null when that would need a non-ASCII character.
    # In a batch file % is doubled, except where a variable is meant.
    function ConvertTo-CmdPath([string]$path) {
        $ascii = '^[\x20-\x7E]*$'
        foreach ($name in @("LOCALAPPDATA", "ProgramFiles")) {
            $root = [Environment]::GetEnvironmentVariable($name)
            if ($root -and $path.StartsWith($root.TrimEnd("\") + "\", [StringComparison]::OrdinalIgnoreCase)) {
                $rest = $path.Substring($root.TrimEnd("\").Length)
                if ($rest -match $ascii) { return "%$name%" + $rest.Replace("%", "%%") }
            }
        }
        if ($path -match $ascii) { return $path.Replace("%", "%%") }
        return $null
    }
    function Install-TerminalCommand {
        try {
            $executable = Find-OopApp
            # Apps older than the terminal app have nothing to run.
            if (-not $executable) { return }
            $bundle = Join-Path (Split-Path -Parent $executable) "resources\oop\oop-rs.exe"
            if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) { return }
            $binDir = if ($env:OOP_BIN_DIR) { $env:OOP_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "oop-terminal" }
            $target = Join-Path $binDir "oop.cmd"
            if ((Test-Path -LiteralPath $target) -and -not (Test-OurOopCommand $target)) {
                Write-Host "Note: $target already exists and was not made by OOP, so it was left alone. The terminal client is $bundle."
                return
            }
            # cmd.exe reads a batch file in whatever code page the console has, so the file holds only
            # ASCII. A path under %LOCALAPPDATA% or %ProgramFiles% is written with that variable, which
            # keeps a non-ASCII user folder out of the file; any other non-ASCII path gets no command.
            $exe = ConvertTo-CmdPath $executable
            $rustClient = ConvertTo-CmdPath $bundle
            if (-not $exe -or -not $rustClient) {
                Write-Host "Note: OOP is installed at a path with non-ASCII characters outside %LOCALAPPDATA% and %ProgramFiles%, so the `"oop`" command was not created. The terminal client is $bundle."
                return
            }
            $lines = @(
                "@echo off",
                "rem $launcherMark (written by OOP Desktop install-desktop.ps1; safe to delete)",
                "setlocal",
                "if not exist `"$exe`" (",
                "  echo oop: OOP was not found. Install or update OOP Desktop. 1>&2",
                "  exit /b 9009",
                ")",
                "set OOP_IN_DESKTOP_APP=1",
                "`\"$rustClient`\" %*",
                "exit /b %ERRORLEVEL%"
            )
            New-Item -ItemType Directory -Force -Path $binDir | Out-Null
            $temp = Join-Path $binDir (".oop." + [Guid]::NewGuid().ToString("N") + ".tmp")
            Set-Content -LiteralPath $temp -Value $lines -Encoding Ascii
            Move-Item -LiteralPath $temp -Destination $target -Force
            Write-Host "Installed the terminal command $target."
            $onPath = ($env:Path -split ";") | Where-Object { $_.TrimEnd("\") -ieq $binDir.TrimEnd("\") }
            if (-not $onPath) { Write-Host "Note: $binDir is not on PATH. Add it to your user PATH to run `"oop`" from anywhere." }
        } catch {
            Write-Host "Note: the `"oop`" terminal command could not be set up ($($_.Exception.Message)); OOP itself is installed."
        }
    }
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("oop-install-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temp | Out-Null
    try {
        Write-Host "Downloading OOP $version for Windows-$arch..."
        $installer = Join-Path $temp $asset
        Invoke-WebRequest -Uri "$base/v$version/$asset" -OutFile $installer -UseBasicParsing -TimeoutSec 1800
        $checksum = Join-Path $temp "$asset.sha256"
        Invoke-WebRequest -Uri "$base/v$version/$asset.sha256" -OutFile $checksum -UseBasicParsing -TimeoutSec 60
        $expected = ((Get-Content $checksum -TotalCount 1) -split "\s+")[0].ToLowerInvariant()
        if ($expected -notmatch "^[0-9a-f]{64}$") { throw "Invalid SHA-256 file; nothing was installed." }
        $actual = (Get-FileHash -Path $installer -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { throw "SHA-256 mismatch; nothing was installed." }
        # electron-builder's assisted NSIS installer supports silent, per-user installation.
        $process = Start-Process -FilePath $installer -ArgumentList "/S", "/currentuser" -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "OOP setup failed with exit code $($process.ExitCode)." }
        Write-Host "Installed OOP $version. Open OOP from the Start menu."
        Install-TerminalCommand
    }
    finally {
        Remove-Item -LiteralPath $temp -Recurse -Force
    }
}
