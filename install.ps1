<#
.SYNOPSIS
  Installs TalkSketch for the current user.

.DESCRIPTION
  Downloads the latest TalkSketch installer from api.talksketch.work, verifies its
  SHA-256 against the published sidecar, removes the Mark-of-the-Web, and runs the
  per-user installer silently. No administrator rights are required.

  This is the same binary the website's Download button serves. The script only
  automates what a manual install does: download, unblock, run.

.EXAMPLE
  irm https://talksketch.work/install.ps1 | iex

.EXAMPLE
  # Review before running, then install without launching the app:
  irm https://talksketch.work/install.ps1 -OutFile install.ps1
  .\install.ps1 -NoLaunch
#>
[CmdletBinding()]
param(
  [switch]$NoLaunch,
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$base = 'https://api.talksketch.work/download/latest'
$name = 'TalkSketch-Setup.exe'
$url = "$base/$name"
$installer = Join-Path ([IO.Path]::GetTempPath()) $name

# Windows 10 ships with TLS 1.0/1.1 defaults in some builds.
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  # older runtimes already default to something usable
}

Write-Host ''
Write-Host '  TalkSketch installer' -ForegroundColor Cyan
Write-Host "  $url"
Write-Host ''

Write-Host '  [1/3] Downloading...' -ForegroundColor DarkGray
try {
  Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
} catch {
  throw "Download failed: $($_.Exception.Message)"
}

$sizeMb = [math]::Round((Get-Item $installer).Length / 1MB, 1)
Write-Host "        $sizeMb MB"

if (-not $SkipVerify) {
  $expected = $null
  try {
    $sidecar = (Invoke-WebRequest -Uri "$url.sha256" -UseBasicParsing -ErrorAction Stop).Content
    $expected = ($sidecar -split '\s+')[0]
  } catch {
    Write-Warning 'Checksum sidecar unavailable; skipping verification.'
  }
  if ($expected) {
    Write-Host '  [2/3] Verifying checksum...' -ForegroundColor DarkGray
    $actual = (Get-FileHash -Path $installer -Algorithm SHA256).Hash
    if ($expected.ToUpperInvariant() -ne $actual.ToUpperInvariant()) {
      Remove-Item $installer -Force -ErrorAction SilentlyContinue
      throw "Checksum mismatch. Expected $expected, got $actual. Nothing was installed."
    }
    Write-Host '        OK'
  }
}

# Removes the zone marker that makes SmartScreen show "Windows protected your PC".
Unblock-File -Path $installer

Write-Host '  [3/3] Installing...' -ForegroundColor DarkGray
$process = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru -Wait
if ($process.ExitCode -ne 0) {
  throw "Installer exited with code $($process.ExitCode). Nothing was installed."
}
Remove-Item $installer -Force -ErrorAction SilentlyContinue

$exe = Join-Path $env:LOCALAPPDATA 'Programs\TalkSketch\TalkSketch.exe'
if (-not (Test-Path $exe)) {
  throw "Installer finished but $exe is missing. Check %LOCALAPPDATA%\Programs\TalkSketch."
}

Write-Host ''
Write-Host "  Installed: $exe" -ForegroundColor Green
if ($NoLaunch) {
  Write-Host '  Start TalkSketch from the Start menu.' -ForegroundColor DarkGray
} else {
  Start-Process -FilePath $exe
  Write-Host '  Launching TalkSketch...' -ForegroundColor DarkGray
}
Write-Host ''
