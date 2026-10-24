# OoP Desktop, not the upstream T3 Code CLI. Windows PowerShell 5.1+.
# irm https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-desktop.ps1 | iex
# OOP_VERSION pins a stable version; OOP_RELEASE_BASE_URL supplies a release mirror.
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
    $asset = "OoP-$version-$arch.exe"
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("oop-install-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temp | Out-Null
    try {
        Write-Host "Downloading OoP $version for Windows-$arch..."
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
        if ($process.ExitCode -ne 0) { throw "OoP setup failed with exit code $($process.ExitCode)." }
        Write-Host "Installed OoP $version. Open OoP from the Start menu."
    }
    finally {
        Remove-Item -LiteralPath $temp -Recurse -Force
    }
}
