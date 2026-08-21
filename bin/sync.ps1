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
  [switch]$SongsOnly,
  [switch]$Both
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
    Write-Host "==> installing web dependencies (npm install) ..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

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

  # Ensure sample-aligned stem chunks exist (instant playback on device).
  # Fast no-op for songs whose stems/chunks/chunks.json is already present.
  Write-Host "==> ensuring stem chunks (bin/make-stem-chunks.py) ..." -ForegroundColor Cyan
  $chunker = Join-Path $Root "bin/make-stem-chunks.py"
  if (Test-Path $chunker) {
    python $chunker
    if ($LASTEXITCODE -ne 0) { Write-Host "chunk generation failed (continuing without)" -ForegroundColor Yellow }
  }

  $DeviceParent = "/storage/emulated/0/Android/data/$Pkg/files"
  $DeviceSetlistsDir = "/storage/emulated/0/Android/data/$Pkg/files/setlists"

  # Android 14+ exposes Android/data as a raw passthrough mount (f2fs):
  #   - adb push fails there ("remote fchown() failed / secure_mkdirs"):
  #     Operation not permitted) and deletes the partially-copied file
  #   - files created by the shell (uid 2000) cannot be read by the app
  # So: push everything to /data/local/tmp first, then cp as shell into the
  # app dir and open permissions (a+rwX) so the app uid can read/write.
  $TmpStage = "/data/local/tmp/mbp-sync"
  $TmpSongsDir = "$TmpStage/songs"
  & $adbExe -s $target shell "rm -rf '$TmpStage'; mkdir -p '$TmpStage' '$DeviceParent'"
  if ($LASTEXITCODE -ne 0) { throw "failed to prepare staging dir on device" }

  # Preserve on-device practice data (markers, stanza tags) created on the
  # tablet: pull every practice.json first and re-push it after the wipe.
  # Device-side practice data wins over the PC copy (same policy as P2P sync).
  $PracticeBackup = Join-Path $env:TEMP "mbp-practice-backup"
  if (Test-Path $PracticeBackup) { Remove-Item $PracticeBackup -Recurse -Force }
  New-Item -ItemType Directory -Force $PracticeBackup | Out-Null
  $pulled = 0
  foreach ($songDir in (Get-ChildItem $Songs -Directory)) {
    $slug = $songDir.Name
    $devPractice = "$DeviceSongsDir/$slug/practice.json"
    # adb pull fails silently-ish on missing files; test existence first
    $exists = (& $adbExe -s $target shell "test -f '$devPractice' && echo yes" | Out-String).Trim()
    if ($exists -eq "yes") {
      $dest = Join-Path $PracticeBackup "$slug.json"
      & $adbExe -s $target pull "$devPractice" "$dest" | Out-Null
      if (Test-Path $dest) { $pulled++ }
    }
  }
  if ($pulled -gt 0) { Write-Host "==> preserving $pulled on-device practice.json file(s)" -ForegroundColor Cyan }

  & $adbExe -s $target shell "rm -rf '$DeviceSongsDir' '$DeviceSetlistsDir'"

  # Push per song, skipping whole-file stems when chunks exist: chunks
  # supersede them for playback (~17MB vs ~140MB per song with FLAC stems).
  # Songs without chunks keep their whole stems (full-decode fallback).
  $WholeStemExts = @(".flac", ".mp3", ".wav", ".ogg", ".opus", ".m4a")
  foreach ($songDir in (Get-ChildItem $Songs -Directory)) {
    $hasChunks = Test-Path (Join-Path $songDir "stems/chunks/chunks.json")
    $items = Get-ChildItem $songDir
    foreach ($item in $items) {
      $skip = $false
      if ($hasChunks -and $item.Name -eq "stems" -and $item.PSIsContainer) {
        # push only the chunks/ subdir of stems/
        $chunkDir = Join-Path $item.FullName "chunks"
        if (Test-Path $chunkDir) {
          & $adbExe -s $target shell "mkdir -p '$TmpSongsDir/$($songDir.Name)/stems'"
          & $adbExe -s $target push "$chunkDir" "$TmpSongsDir/$($songDir.Name)/stems/" | Out-Null
        }
        $skip = $true
      }
      elseif ($hasChunks -and -not $item.PSIsContainer -and
        $WholeStemExts -contains $item.Extension.ToLowerInvariant() -and
        $item.Name -ne "$($songDir.Name)$($item.Extension)") {
        # whole-file stem at song root (uncommon) — also superseded
        $skip = $true
      }
      if (-not $skip) {
        & $adbExe -s $target push "$($item.FullName)" "$TmpSongsDir/$($songDir.Name)/" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "adb push failed (staging): $($item.FullName)" }
      }
    }
  }

  # Restore preserved practice data (device wins over PC copies)
  $restored = 0
  foreach ($bak in (Get-ChildItem $PracticeBackup -Filter *.json -ErrorAction SilentlyContinue)) {
    $slug = $bak.BaseName
    & $adbExe -s $target push "$($bak.FullName)" "$TmpSongsDir/$slug/practice.json" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "adb push failed (practice.json): $slug" }
    $restored++
  }
  if ($restored -gt 0) {
    Write-Host "==> restored $restored practice.json file(s) from device" -ForegroundColor Green
    # mirror into the local library so PC and device stay in sync
    foreach ($bak in (Get-ChildItem $PracticeBackup -Filter *.json)) {
      Copy-Item $bak.FullName (Join-Path $Songs "$($bak.BaseName)\practice.json") -Force
    }
  }
  Remove-Item $PracticeBackup -Recurse -Force -ErrorAction SilentlyContinue

  $Setlists = Join-Path $Root "setlists"
  if (Test-Path $Setlists) {
    Write-Host "==> pushing setlists/ -> $DeviceSetlistsDir ..." -ForegroundColor Cyan
    & $adbExe -s $target push $Setlists "$TmpStage/" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "adb push failed (staging setlists/)" }
  }

  # Move staged content into the app dir and make it app-accessible
  Write-Host "==> moving staged files into $DeviceParent ..." -ForegroundColor Cyan
  $srcs = "'$TmpSongsDir'"
  if (Test-Path $Setlists) { $srcs += " '$TmpStage/setlists'" }
  & $adbExe -s $target shell "cp -r $srcs '$DeviceParent' && chmod -R a+rwX '$DeviceParent' && rm -rf '$TmpStage'"
  if ($LASTEXITCODE -ne 0) { throw "device-side copy/chmod failed" }

  # Sanity check: every song slug must exist on the device
  $devList = (& $adbExe -s $target shell "ls '$DeviceSongsDir'" | Out-String) -split "`n" |
    ForEach-Object { $_.Trim() } | Where-Object { $_ }
  $missing = @(Get-ChildItem $Songs -Directory | Where-Object { $devList -notcontains $_.Name })
  if ($missing.Count -gt 0) {
    throw "songs missing on device after sync: $($missing.Name -join ', ')"
  }

  Write-Host "==> songs synced (chunked songs: whole stems skipped on device)" -ForegroundColor Green
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

if ($Both) {
  $mode = @{ App = $true;  Songs = $true }
} elseif ($AppOnly) {
  $mode = @{ App = $true;  Songs = $false }
} elseif ($SongsOnly) {
  $mode = @{ App = $false; Songs = $true }
} else {
  $mode = Select-Mode
}

if ($mode.App) { Install-App }
if ($mode.Songs) { Sync-Songs }

Write-Host "`nDone. Launch 'My Band Practice' on the tablet." -ForegroundColor Green
