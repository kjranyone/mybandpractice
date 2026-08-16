#Requires -Version 7
<#
.SYNOPSIS
  Build the Android app (songs NOT bundled) and sync songs to the device
  via adb. Songs land in the app's external files dir:
    /storage/emulated/0/Android/data/<pkg>/files/songs/

.EXAMPLE
  ./bin/sync.ps1                # build APK, install, push songs
  ./bin/sync.ps1 -Serial XYZ    # choose a specific device
  ./bin/sync.ps1 -AppOnly       # app update only (keep songs on device)
  ./bin/sync.ps1 -SongsOnly     # re-push songs only (no rebuild)
#>
param(
  [string]$Serial = "",
  [switch]$AppOnly,
  [switch]$SongsOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$Web = Join-Path $Root "web"
$Android = Join-Path $Web "android"
$Songs = Join-Path $Root "songs"
$Pkg = "com.donoy.mybandpractice"
$DeviceSongsDir = "/storage/emulated/0/Android/data/$Pkg/files/songs"

# --- locate adb -------------------------------------------------------------
$adbExe = (Get-Command adb -ErrorAction SilentlyContinue)?.Source
if (-not $adbExe) {
  $sdk = $env:ANDROID_HOME
  if (-not $sdk) {
    $candidate = Join-Path $env:LOCALAPPDATA "Android/Sdk"
    if (Test-Path $candidate) { $sdk = $candidate }
  }
  $adbExe = if ($sdk) { Join-Path $sdk "platform-tools/adb.exe" } else { $null }
  if (-not ($adbExe -and (Test-Path $adbExe))) {
    throw "adb not found. Install Android platform-tools or set ANDROID_HOME."
  }
}

# --- device selection -------------------------------------------------------
$devices = @(& $adbExe devices | Select-Object -Skip 1 | Where-Object { $_ -match "device$" })
if ($devices.Count -eq 0) { throw "No adb device connected. Enable USB debugging on the tablet." }
$target = if ($Serial) { $Serial } elseif ($devices.Count -eq 1) { ($devices[0] -split "\s+")[0] } else {
  throw "Multiple devices connected. Specify one with -Serial:`n$($devices -join "`n")"
}
Write-Host "==> target device: $target" -ForegroundColor Cyan

function Install-App {
  Push-Location $Web
  try {
    Write-Host "==> building web ..." -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "vite build failed" }

    Write-Host "==> cap sync android ..." -ForegroundColor Cyan
    npx cap sync android
    if ($LASTEXITCODE -ne 0) { throw "cap sync failed" }

    if (-not $env:JAVA_HOME) {
      $javaHome = (& java -XshowSettings:properties -version 2>&1 |
        Select-String 'java\.home\s*=\s*(.+)').Matches[0].Groups[1].Value
      if ($javaHome) { $env:JAVA_HOME = $javaHome.Trim() }
    }

    Write-Host "==> gradlew assembleDebug ..." -ForegroundColor Cyan
    Push-Location $Android
    try {
      .\gradlew.bat assembleDebug --console=plain
      if ($LASTEXITCODE -ne 0) { throw "gradle build failed" }
    } finally { Pop-Location }

    $apkDir = Join-Path $Android "app/build/outputs/apk/debug"
    $apk = Get-ChildItem $apkDir -Filter *.apk |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $apk) { throw "no apk found in $apkDir" }

    Write-Host "==> installing $($apk.Name) ($([math]::Round($apk.Length / 1MB, 1)) MB) ..." -ForegroundColor Cyan
    & $adbExe -s $target install -r $apk.FullName
    if ($LASTEXITCODE -ne 0) { throw "adb install failed" }
  } finally { Pop-Location }
}

function Sync-Songs {
  if (-not (Test-Path $Songs)) { throw "songs dir not found: $Songs" }
  Write-Host "==> pushing songs/ -> $DeviceSongsDir ..." -ForegroundColor Cyan
  & $adbExe -s $target shell "mkdir -p $DeviceSongsDir"
  & $adbExe -s $target push "$Songs/." $DeviceSongsDir
  if ($LASTEXITCODE -ne 0) { throw "adb push failed" }
}

if (-not $SongsOnly) { Install-App }
if (-not $AppOnly) { Sync-Songs }

Write-Host "`nDone. Launch 'My Band Practice' on the tablet." -ForegroundColor Green
