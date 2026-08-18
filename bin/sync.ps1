#Requires -Version 7
<#
.SYNOPSIS
  Build the Android app (songs NOT bundled) and sync songs to the device
  via adb. Songs land in the app's external files dir:
    /storage/emulated/0/Android/data/<pkg>/files/songs/

.EXAMPLE
  ./bin/sync.ps1                # interactive: pick app / songs / both
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

# --- locate adb & android sdk -----------------------------------------------
$sdk = $env:ANDROID_HOME
if (-not ($sdk -and (Test-Path $sdk))) {
  $candidate = Join-Path $env:LOCALAPPDATA "Android/Sdk"
  if (Test-Path $candidate) { $sdk = $candidate }
}

if ($sdk) {
  $env:ANDROID_HOME = $sdk
  $env:ANDROID_SDK_ROOT = $sdk
  $localProps = Join-Path $Android "local.properties"
  if (-not (Test-Path $localProps)) {
    $sdkDirFormatted = $sdk -replace '\\', '/'
    Set-Content -Path $localProps -Value "sdk.dir=$sdkDirFormatted"
  }
}

$adbExe = (Get-Command adb -ErrorAction SilentlyContinue)?.Source
if (-not $adbExe) {
  $adbExe = if ($sdk) { Join-Path $sdk "platform-tools/adb.exe" } else { $null }
  if (-not ($adbExe -and (Test-Path $adbExe))) {
    throw "adb not found. Install Android platform-tools or set ANDROID_HOME."
  }
}

# --- locate java / JAVA_HOME ------------------------------------------------
function Ensure-JavaHome {
  if (-not ($env:JAVA_HOME -and (Test-Path $env:JAVA_HOME))) {
    $foundJava = $null
    $javaCmd = Get-Command java -ErrorAction SilentlyContinue
    if ($javaCmd) {
      try {
        $output = & java -XshowSettings:properties -version 2>&1
        $match = $output | Select-String 'java\.home\s*=\s*(.+)'
        if ($match -and $match.Matches.Count -gt 0) {
          $foundJava = $match.Matches[0].Groups[1].Value.Trim()
        }
      } catch {}
    }
    if (-not ($foundJava -and (Test-Path $foundJava))) {
      $candidates = @(
        "C:\Program Files\Android\Android Studio\jbr",
        "C:\Program Files\Android\Android Studio\jre",
        "$env:LOCALAPPDATA\Android\Sdk\jbr"
      )
      $javaDirs = Get-ChildItem "C:\Program Files\Java", "C:\Program Files\Eclipse Adoptium" -ErrorAction SilentlyContinue |
        Where-Object { $_.PSIsContainer } | Select-Object -ExpandProperty FullName
      if ($javaDirs) { $candidates += $javaDirs }
      foreach ($cand in $candidates) {
        if ($cand -and (Test-Path (Join-Path $cand "bin\java.exe"))) {
          $foundJava = $cand
          break
        }
      }
    }
    if ($foundJava) {
      $env:JAVA_HOME = $foundJava
    } else {
      throw "JAVA_HOME is not set and Java executable was not found. Please install Android Studio or Java JDK, or set JAVA_HOME."
    }
  }

  $javaBin = Join-Path $env:JAVA_HOME "bin"
  if ($env:PATH -notlike "*$javaBin*") {
    $env:PATH = "$javaBin;$env:PATH"
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

    Ensure-JavaHome

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
  
  # Remove existing pushed contents so adb push doesn't fail on fchown/permissions
  & $adbExe -s $target shell "rm -rf '$DeviceSongsDir' '$DeviceSetlistsDir'"
  & $adbExe -s $target shell "mkdir -p $DeviceSongsDir"
  
  Get-ChildItem -Path $Songs -Recurse -Directory | ForEach-Object {
    $rel = $_.FullName.Substring($Songs.Length).Replace('\', '/')
    & $adbExe -s $target shell "mkdir -p '$DeviceSongsDir$rel'"
  }
  & $adbExe -s $target push "$Songs/." $DeviceSongsDir
  if ($LASTEXITCODE -ne 0) { throw "adb push failed" }

  $Setlists = Join-Path $Root "setlists"
  $DeviceSetlistsDir = "/storage/emulated/0/Android/data/$Pkg/files/setlists"
  Write-Host "==> pushing setlists/ -> $DeviceSetlistsDir ..." -ForegroundColor Cyan
  & $adbExe -s $target shell "mkdir -p $DeviceSetlistsDir"
  if (Test-Path $Setlists) {
    Get-ChildItem -Path $Setlists -Recurse -Directory | ForEach-Object {
      $rel = $_.FullName.Substring($Setlists.Length).Replace('\', '/')
      & $adbExe -s $target shell "mkdir -p '$DeviceSetlistsDir$rel'"
    }
    & $adbExe -s $target push "$Setlists/." $DeviceSetlistsDir
    if ($LASTEXITCODE -ne 0) { throw "adb push failed" }
  }

  Write-Host "==> setting permissions on $DeviceSongsDir ..." -ForegroundColor Cyan
  & $adbExe -s $target shell "chmod -R 777 '$DeviceSongsDir' '$DeviceSetlistsDir' 2>/dev/null || true"
}

function Select-Mode {
  $modes = @(
    @{ App = $true;  Songs = $true;  Label = "both  : app install + songs/setlists sync" },
    @{ App = $true;  Songs = $false; Label = "app   : build & install APK only" },
    @{ App = $false; Songs = $true;  Label = "songs : push songs/ + setlists/ only" }
  )
  Write-Host "Select sync mode:" -ForegroundColor Cyan
  for ($i = 0; $i -lt $modes.Count; $i++) {
    Write-Host ("  [{0}] {1}" -f ($i + 1), $modes[$i].Label)
  }
  while ($true) {
    $answer = (Read-Host "Choice [1-3, Enter=1]").Trim()
    if ($answer -eq "") { return $modes[0] }
    if ($answer -match '^[123]$') { return $modes[[int]$answer - 1] }
    Write-Host "Invalid input. Enter 1-3." -ForegroundColor Yellow
  }
}

if ($AppOnly) {
  $mode = @{ App = $true;  Songs = $false }
} elseif ($SongsOnly) {
  $mode = @{ App = $false; Songs = $true }
} else {
  $mode = Select-Mode
}

if ($mode.App) { Install-App }
if ($mode.Songs) { Sync-Songs }

Write-Host "`nDone. Launch 'My Band Practice' on the tablet." -ForegroundColor Green
