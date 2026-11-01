# OOP terminal app ("oop") without the desktop app. Windows PowerShell 5.1+. No Node.js, pnpm or git required.
# irm https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-terminal.ps1 | iex
# Windows x64 only. OOP_VERSION pins a stable version; OOP_RELEASE_BASE_URL supplies a release mirror.
# OOP_INSTALL_DIR is the folder the terminal app is unpacked into (default %LOCALAPPDATA%\oop-terminal\app);
# OOP_BIN_DIR is where oop.cmd goes (default %LOCALAPPDATA%\oop-terminal). PATH is never edited.
# Running it again reinstalls (replaces the unpacked folder). An "oop" that OOP did not create is
# never overwritten. To uninstall: oop stop; Remove-Item -Recurse -Force "$env:LOCALAPPDATA\oop-terminal"
& {
    $ErrorActionPreference = "Stop"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    if ($env:OS -ne "Windows_NT") { throw "This installer requires Windows." }
    $repo = "AIBeginnerX/oh-our-pi-desktop"
    $base = if ($env:OOP_RELEASE_BASE_URL) { $env:OOP_RELEASE_BASE_URL.TrimEnd("/") } else { "https://github.com/$repo/releases/download" }
    $machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = switch ($machine) {
        "AMD64" { "x64" }
        "ARM64" { throw "Windows on ARM is not supported. The terminal app is built for Windows x64 only." }
        default { throw "Unsupported CPU architecture: $machine. Supported: Windows x64." }
    }
    $version = $env:OOP_VERSION
    if (-not $version) {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "oop-terminal-installer" } -TimeoutSec 60
        $version = $release.tag_name -replace "^v", ""
    }
    if ($version -notmatch "^\d+\.\d+\.\d+$") { throw "OOP_VERSION must be a stable version such as 0.0.132." }
    $asset = "OOP-terminal-$version-windows-$arch.zip"
    $launcherMark = "oop-terminal-launcher"
    $installMark = ".oop-terminal-install"
    $binDir = if ($env:OOP_BIN_DIR) { $env:OOP_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "oop-terminal" }
    $root = if ($env:OOP_INSTALL_DIR) { $env:OOP_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "oop-terminal\app" }
    $target = Join-Path $binDir "oop.cmd"
    # True for a launcher this script or install-desktop.ps1 wrote, or the oop.cmd that the
    # repository's own terminal installer writes (it runs a sibling oop.mjs with node).
    function Test-OurOopCommand([string]$path) {
        $text = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
        if (-not $text) { return $false }
        return $text.Contains("rem $launcherMark") -or $text.Contains("rem oop-desktop-terminal-launcher") -or ($text.Contains('node "%~dp0oop.mjs" %*'))
    }
    # The path as a batch file may spell it, or $null when that would need a non-ASCII character.
    # cmd.exe reads a batch file in the console's code page, so the file holds only ASCII. A path
    # under %LOCALAPPDATA% or %ProgramFiles% is written with that variable, which keeps a non-ASCII
    # user folder out of the file. In a batch file % is doubled, except where a variable is meant.
    function ConvertTo-CmdPath([string]$path) {
        $ascii = '^[\x20-\x7E]*$'
        foreach ($name in @("LOCALAPPDATA", "ProgramFiles")) {
            $variable = [Environment]::GetEnvironmentVariable($name)
            if ($variable -and $path.StartsWith($variable.TrimEnd("\") + "\", [StringComparison]::OrdinalIgnoreCase)) {
                $rest = $path.Substring($variable.TrimEnd("\").Length)
                if ($rest -match $ascii) { return "%$name%" + $rest.Replace("%", "%%") }
            }
        }
        if ($path -match $ascii) { return $path.Replace("%", "%%") }
        return $null
    }

    # Refuse before downloading anything when the install would touch something that is not ours.
    $cmdRoot = ConvertTo-CmdPath $root
    if (-not $cmdRoot) { throw "$root has non-ASCII characters outside %LOCALAPPDATA% and %ProgramFiles%, so the oop command cannot name it. Set OOP_INSTALL_DIR to another folder." }
    if ((Test-Path -LiteralPath $target) -and -not (Test-OurOopCommand $target)) {
        throw "$target already exists and was not made by OOP, so nothing was installed. Move it away or set OOP_BIN_DIR to another folder."
    }
    if (Test-Path -LiteralPath $root) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "$root exists and is not an OOP terminal install folder. Set OOP_INSTALL_DIR to another folder." }
        if (-not (Test-Path -LiteralPath (Join-Path $root $installMark)) -and @(Get-ChildItem -LiteralPath $root -Force).Count -gt 0) {
            throw "$root is not empty and was not made by this installer, so nothing was installed. Set OOP_INSTALL_DIR to another folder."
        }
    }

    $temp = Join-Path ([IO.Path]::GetTempPath()) ("oop-terminal-install-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temp | Out-Null
    $staging = $null
    try {
        Write-Host "Downloading the OOP terminal app $version for Windows-$arch..."
        $archive = Join-Path $temp $asset
        try {
            Invoke-WebRequest -Uri "$base/v$version/$asset" -OutFile $archive -UseBasicParsing -TimeoutSec 1800
        } catch {
            throw "No downloadable $asset. This release may not include the terminal app; see the repository's Releases page. ($($_.Exception.Message))"
        }
        $checksum = Join-Path $temp "$asset.sha256"
        try {
            Invoke-WebRequest -Uri "$base/v$version/$asset.sha256" -OutFile $checksum -UseBasicParsing -TimeoutSec 60
        } catch {
            throw "The release has no checksum for $asset; nothing was installed."
        }
        $expected = ((Get-Content $checksum -TotalCount 1) -split "\s+")[0].ToLowerInvariant()
        if ($expected -notmatch "^[0-9a-f]{64}$") { throw "Invalid SHA-256 file; nothing was installed." }
        $actual = (Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { throw "SHA-256 mismatch; nothing was installed." }

        # Unpack beside the final folder, so the swap below is a rename on one drive.
        $parent = Split-Path -Parent $root
        New-Item -ItemType Directory -Force -Path $parent, $binDir | Out-Null
        $staging = Join-Path $parent (".oop-terminal-new." + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $staging | Out-Null
        # tar.exe ships with Windows 10 1803 and later and reads zip; Expand-Archive is far slower on a tree this size.
        & (Join-Path $env:SystemRoot "System32\tar.exe") -xf $archive -C $staging
        if ($LASTEXITCODE -ne 0) { throw "Could not unpack $asset; nothing was installed." }
        $new = Join-Path $staging "oop-terminal"
        foreach ($required in @("node.exe", "oop.mjs", "apps\server\dist\bin.mjs")) {
            if (-not (Test-Path -LiteralPath (Join-Path $new $required) -PathType Leaf)) { throw "$asset is not a complete terminal app; nothing was installed." }
        }
        # Run it once where it stands, so a missing system component shows up now and not at the first "oop".
        $versionFile = Join-Path $temp "version.txt"
        $check = Start-Process -FilePath (Join-Path $new "node.exe") -ArgumentList "`"$(Join-Path $new 'oop.mjs')`"", "--version" -RedirectStandardOutput $versionFile -Wait -PassThru -NoNewWindow
        if ($check.ExitCode -ne 0) { throw "The downloaded terminal app does not run on this computer (exit code $($check.ExitCode)); nothing was installed." }
        $printed = (Get-Content -LiteralPath $versionFile | Select-Object -Last 1)
        if ($printed -ne $version) { throw "The downloaded terminal app reports `"$printed`", not $version; nothing was installed." }
        Set-Content -LiteralPath (Join-Path $new $installMark) -Value $version -Encoding Ascii

        # Replace the old folder in two renames and put it back if the second one fails.
        $previous = Join-Path $staging "previous"
        if (Test-Path -LiteralPath $root) {
            try { Move-Item -LiteralPath $root -Destination $previous }
            catch { throw "Could not replace $root; nothing was changed. A background OOP server from the previous install may still be running: run `"oop stop`" and try again. ($($_.Exception.Message))" }
        }
        try { Move-Item -LiteralPath $new -Destination $root }
        catch {
            if (Test-Path -LiteralPath $previous) { Move-Item -LiteralPath $previous -Destination $root }
            throw "Could not install into $root. ($($_.Exception.Message))"
        }

        # The command. oop.cmd points the terminal at the server that came with it (OOP_DAEMON_ENTRY),
        # which is how "oop" starts a background server when no desktop app is running.
        $lines = @(
            "@echo off",
            "rem $launcherMark (written by install-terminal.ps1; safe to delete)",
            "setlocal",
            "if not exist `"$cmdRoot\node.exe`" (",
            "  echo oop: the OOP terminal app was not found. Run the install command again. 1>&2",
            "  exit /b 9009",
            ")",
            "if not defined OOP_DAEMON_ENTRY set `"OOP_DAEMON_ENTRY=$cmdRoot\apps\server\dist\bin.mjs`"",
            "set `"OOP_TERMINAL_INSTALL=1`"",
            "`"$cmdRoot\node.exe`" `"$cmdRoot\oop.mjs`" %*",
            "exit /b %ERRORLEVEL%"
        )
        $commandTemp = Join-Path $binDir (".oop." + [Guid]::NewGuid().ToString("N") + ".tmp")
        Set-Content -LiteralPath $commandTemp -Value $lines -Encoding Ascii
        Move-Item -LiteralPath $commandTemp -Destination $target -Force
        Write-Host "Installed OOP terminal app $version in $root and the command $target."
        $onPath = ($env:Path -split ";") | Where-Object { $_.TrimEnd("\") -ieq $binDir.TrimEnd("\") }
        if (-not $onPath) {
            Write-Host ""
            Write-Host "$binDir is not on PATH yet. Add it to your user PATH with this command, then open a new terminal:"
            Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$binDir', 'User')"
        }
        Write-Host ""
        Write-Host "Next:"
        Write-Host "  1. Sign in to a provider CLI first (for example Claude Code or Codex). OOP does not sign in for you."
        Write-Host "  2. In a project folder, run: oop    (oop provider shows which providers are ready)"
        Write-Host "Update: run this install command again, then `"oop stop`" so the new background server starts."
        Write-Host "Uninstall: oop stop; Remove-Item -Recurse -Force '$root', '$target'"
    }
    finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
        if ($staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
