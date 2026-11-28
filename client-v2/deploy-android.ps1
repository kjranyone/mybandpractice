<#
.SYNOPSIS
  Deploy the v2 Android client to a connected device over adb: build and install
  the app (debug, or release with -Build Release), and copy the song library into
  the app's storage.

.DESCRIPTION
  The app reads files/songs and files/setlists from its internal storage, so the
  library is pushed to /data/local/tmp first and copied into place with run-as,
  which only reaches a debug build. When the device has the release build
  (-Build Release), the script puts the debug build on for the copy and the
  release build back on afterwards. The songs and the markers stay through
  either install.

  Songs need stem chunks (stems/chunks/chunks.json). Whole-file stems stay on the
  PC when chunks exist. Each synced song is replaced, but the device's
  practice.json (markers, stanza tags) is kept, like the in-app Sync does.
  Songs and setlists that exist only on the device are kept unless -Prune is set.

.EXAMPLE
  ./client-v2/deploy-android.ps1
  Ask what to deploy and, with several devices connected, which one.

.EXAMPLE
  ./client-v2/deploy-android.ps1 -Mode Songs -Library C:\lib\mybandpractice\songs
  Sync the songs and setlists of that library without asking.

.EXAMPLE
  ./client-v2/deploy-android.ps1 -Mode Both -Build Release
  Install the release build, with the songs synced on the way.

.EXAMPLE
  ./client-v2/deploy-android.ps1 -Mode Both -Serial X -SkipNative -Prune
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  # Folder holding the song folders (songs/), or a single song folder.
  [Parameter(Position = 0)]
  [string]$Library,

  # What to deploy. Ask when omitted, unless there is no terminal to ask.
  [ValidateSet("App", "Songs", "Both")]
  [string]$Mode,

  # Which build to install. Release is not debuggable, and Android compiles it
  # ahead of time: it is the one to play along with. Songs can be synced with
  # either build on the device.
  [ValidateSet("Debug", "Release")]
  [string]$Build = "Debug",

  # Device to use. Only needed when several devices are connected.
  [string]$Serial,

  # Only these songs (slugs). Default: every song with stem chunks.
  [string[]]$Songs,

  # Also remove songs and setlists that exist only on the device.
  [switch]$Prune,

  # Skip client-v2/build-android.ps1 (native core and Kotlin bindings).
  [switch]$SkipNative,

  # Leave the app closed after deploying instead of starting it.
  [switch]$NoLaunch,

  # Show what would be deployed and change nothing.
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$ClientRoot = $PSScriptRoot
$AndroidProject = Join-Path $ClientRoot "android"
$Package = "com.donoy.mybandpractice.v2"
$Activity = "$Package/.MainActivity"
$Stage = "/data/local/tmp/mbp-v2-deploy"
$AudioExtensions = @(".flac", ".mp3", ".wav", ".ogg", ".opus", ".m4a")
$JunkNames = @("Thumbs.db", "desktop.ini", ".DS_Store")
$SafeName = "^[A-Za-z0-9][A-Za-z0-9._-]*$"
$Interactive = -not [Console]::IsInputRedirected -and [Environment]::UserInteractive

# Runs on the device as the app. Replaces each staged song, but moves its
# practice.json over so that markers made on the device survive.
$FinishScriptText = @'
set -e
mkdir -p files
cd files
STAGE="__STAGE__"
mkdir -p songs
rm -rf songs/.practice-keep
mkdir -p songs/.practice-keep
for src in "$STAGE"/songs/*; do
  [ -d "$src" ] || continue
  slug="${src##*/}"
  keep=no
  if [ -f "songs/$slug/practice.json" ]; then
    mv "songs/$slug/practice.json" "songs/.practice-keep/$slug.json"
    keep=yes
  fi
  rm -rf "songs/$slug"
  cp -r "$src" "songs/$slug"
  if [ "$keep" = yes ]; then
    mv "songs/.practice-keep/$slug.json" "songs/$slug/practice.json"
  fi
done
rm -rf songs/.practice-keep
if [ -d "$STAGE/setlists" ]; then
  mkdir -p setlists
  for f in "$STAGE"/setlists/*.json; do
    [ -f "$f" ] && cp "$f" setlists/
  done
fi
echo "songs on the device: $(ls songs | wc -l)"
'@

# Runs an external command and returns @{ Code; Lines }. With the error action
# set to Stop, Windows PowerShell 5.1 turns each stderr line of a captured
# native command into a terminating error, so the preference is relaxed here.
# -Live streams the output to the console instead of capturing it.
function Invoke-Tool {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [switch]$AllowFailure,
    [switch]$Live
  )
  $ErrorActionPreference = "Continue"
  $lines = @()
  if ($Live) {
    & $FilePath @Arguments
    $code = $LASTEXITCODE
  } else {
    $lines = @(& $FilePath @Arguments 2>&1 | ForEach-Object { "$_".TrimEnd() } | Where-Object { $_ -ne "" })
    $code = $LASTEXITCODE
  }
  if ($code -ne 0 -and -not $AllowFailure) {
    $detail = ($lines -join "`n").Trim()
    throw "'$(Split-Path -Leaf $FilePath) $($Arguments -join ' ') failed (exit $code). $detail"
  }
  return @{ Code = $code; Lines = $lines }
}

function Invoke-Adb {
  param([string[]]$Arguments = @(), [switch]$AllowFailure, [switch]$Live)
  $all = @("-s", $script:Device.Serial) + $Arguments
  return Invoke-Tool -FilePath $script:Adb -Arguments $all -AllowFailure:$AllowFailure -Live:$Live
}

# Runs a command as the app, inside its data directory.
function Invoke-RunAs {
  param([string[]]$Arguments = @(), [switch]$AllowFailure)
  return Invoke-Adb (@("shell", "run-as", $Package) + $Arguments) -AllowFailure:$AllowFailure
}

# --- locate adb & android sdk -----------------------------------------------

function Find-AndroidSdk {
  $candidates = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA "Android\Sdk"))
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) { return $candidate }
  }
  return $null
}

function Find-Adb {
  $command = Get-Command adb -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $sdk = Find-AndroidSdk
  if ($sdk) {
    $candidate = Join-Path $sdk "platform-tools\adb.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  throw "adb not found. Install the Android platform-tools or set ANDROID_HOME."
}

# --- device selection -------------------------------------------------------

function Get-DeviceModel {
  param([string]$DeviceSerial)
  $result = Invoke-Tool -FilePath $script:Adb -Arguments @("-s", $DeviceSerial, "shell", "getprop", "ro.product.model") -AllowFailure
  $model = ($result.Lines -join "").Trim()
  if (-not $model) { $model = "Android device" }
  return $model
}

function Select-Device {
  $listing = Invoke-Tool -FilePath $script:Adb -Arguments @("devices")
  $devices = @(
    foreach ($line in $listing.Lines) {
      if ($line -match "^(\S+)\s+(device|offline|unauthorized|recovery|sideload)\b") {
        [pscustomobject]@{ Serial = $Matches[1]; State = $Matches[2] }
      }
    }
  )
  $ready = @($devices | Where-Object { $_.State -eq "device" })
  if ($ready.Count -eq 0) {
    $hint = "Connect it over USB with USB debugging enabled."
    if ($devices.Count -gt 0) {
      $states = ($devices | ForEach-Object { "$($_.Serial) ($($_.State))" }) -join ", "
      $hint = "Unlock the device and accept the USB debugging prompt: $states"
    }
    throw "No Android device is ready. $hint"
  }

  $chosen = $null
  if ($Serial) {
    $chosen = @($ready | Where-Object { $_.Serial -eq $Serial }) | Select-Object -First 1
    if (-not $chosen) { throw "Device $Serial is not connected. Ready: $($ready.Serial -join ", ")" }
  } elseif ($ready.Count -eq 1) {
    $chosen = $ready[0]
  } elseif (-not $Interactive) {
    throw "Several devices are connected ($($ready.Serial -join ", ")). Pass -Serial."
  } else {
    Write-Host "Connected devices:" -ForegroundColor Cyan
    for ($i = 0; $i -lt $ready.Count; $i++) {
      Write-Host ("  [{0}] {1} ({2})" -f ($i + 1), (Get-DeviceModel $ready[$i].Serial), $ready[$i].Serial)
    }
    while (-not $chosen) {
      $answer = Read-Host "Device [1-$($ready.Count)]"
      if ($null -eq $answer) { throw "Cancelled." }
      $answer = "$answer".Trim()
      if ($answer -match "^\d+$" -and [int]$answer -ge 1 -and [int]$answer -le $ready.Count) {
        $chosen = $ready[[int]$answer - 1]
      }
    }
  }
  return $chosen
}

function Test-AppAccess {
  $installed = Invoke-Adb @("shell", "pm", "path", $Package) -AllowFailure
  if ($installed.Code -ne 0) {
    throw "$Package is not installed on the device. Install it first (-Mode App)."
  }
  $access = Invoke-RunAs @("id") -AllowFailure
  if ($access.Code -ne 0) {
    throw "Cannot write the app's private storage ($($access.Lines -join " ")). adb only can for a debug build: deploy the app with -Mode App."
  }
}

function Test-AppRunning {
  return (Invoke-Adb @("shell", "pidof", $Package) -AllowFailure).Code -eq 0
}

function Get-DeviceListing {
  param([string]$Directory)
  $result = Invoke-RunAs @("ls", $Directory) -AllowFailure
  return @($result.Lines | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

# --- library ----------------------------------------------------------------

function ConvertTo-FullPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  $expanded = $Path.Trim().Trim('"').Trim("'")
  $expanded = [Environment]::ExpandEnvironmentVariables($expanded)
  try { return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($expanded) } catch { return $null }
}

function Resolve-LibraryPath {
  param([string]$Path)
  $candidates = @($Path)
  if (-not $Path) { $candidates = @(Join-Path (Split-Path -Parent $ClientRoot) "songs") }
  foreach ($candidate in $candidates) {
    $full = ConvertTo-FullPath $candidate
    if ($full -and (Test-Path -LiteralPath $full -PathType Container)) { return $full }
  }
  throw "Library folder not found: $($candidates -join ", "). Pass -Library <songs folder>."
}

# songs/<slug>/stems/chunks, or chunks.json directly inside the song folder.
function Get-ChunksDirectory {
  param([string]$SongDirectory)
  $nested = Join-Path $SongDirectory "stems\chunks"
  if (Test-Path -LiteralPath (Join-Path $nested "chunks.json") -PathType Leaf) { return $nested }
  if (Test-Path -LiteralPath (Join-Path $SongDirectory "chunks.json") -PathType Leaf) { return $SongDirectory }
  return $null
}

# What adb push needs for one song: whole folders and loose files.
function Get-SongItems {
  param($Song, [string]$Chunks)
  $directories = @()
  $files = @()
  if ($Chunks -eq $Song.FullName) {
    # chunks.json sits in the song folder: push the folder as it is
    $directories += @{ Local = $Song.FullName; Remote = "" }
  } else {
    $directories += @{ Local = $Chunks; Remote = "stems/chunks" }
    foreach ($entry in (Get-ChildItem -LiteralPath $Song.FullName -Force)) {
      $name = $entry.Name
      if ($name.StartsWith(".") -or $JunkNames -contains $name -or $name.EndsWith(".part", [StringComparison]::OrdinalIgnoreCase)) { continue }
      if ($entry.PSIsContainer) {
        if ($name -ne "stems") { $directories += @{ Local = $entry.FullName; Remote = $name } }
      } else {
        # whole-file stems next to the main mix are superseded by the chunks
        $isStem = ($AudioExtensions -contains $entry.Extension.ToLowerInvariant()) -and ($entry.BaseName -ne $Song.Name)
        if (-not $isStem) { $files += $entry }
      }
    }
  }
  [long]$bytes = 0
  foreach ($file in $files) { $bytes += $file.Length }
  foreach ($directory in $directories) {
    # files dropped on the device before the copy, see Sync-Songs
    $kept = @(Get-ChildItem -LiteralPath $directory.Local -Recurse -File -Force |
      Where-Object { -not $_.Name.EndsWith(".part", [StringComparison]::OrdinalIgnoreCase) -and $JunkNames -notcontains $_.Name })
    foreach ($file in $kept) { $bytes += $file.Length }
  }
  return @{ Directories = $directories; Files = $files; Bytes = $bytes }
}

function Get-LibrarySongs {
  param([string]$Library)
  $directories = @()
  if (Get-ChunksDirectory $Library) {
    $directories = @(Get-Item -LiteralPath $Library)
  } else {
    $directories = @(Get-ChildItem -LiteralPath $Library -Directory -Force | Where-Object { -not $_.Name.StartsWith(".") })
  }
  foreach ($directory in $directories) {
    $chunks = Get-ChunksDirectory $directory.FullName
    $items = $null
    if ($chunks) { $items = Get-SongItems -Song $directory -Chunks $chunks }
    [pscustomobject]@{
      Slug = $directory.Name
      Directory = $directory.FullName
      Chunks = $chunks
      Items = $items
      Safe = $directory.Name -match $SafeName
    }
  }
}

function Get-SetlistsDirectory {
  param([string]$Root)
  if (-not $Root) { return $null }
  if ((Split-Path -Leaf $Root) -ieq "songs") { return Join-Path (Split-Path -Parent $Root) "setlists" }
  return Join-Path $Root "setlists"
}

# Reads the PC side only: which songs and setlists would be synced.
function Get-SongPlan {
  param([string]$Library)
  $root = $Library
  if (Get-ChunksDirectory $Library) { $root = Split-Path -Parent $Library }

  $all = @(Get-LibrarySongs $Library)
  if ($all.Count -eq 0) { throw "No song folders found in $Library." }
  $playable = @($all | Where-Object { $_.Chunks -and $_.Safe })
  $skipped = @($all | Where-Object { -not $_.Chunks -or -not $_.Safe } | ForEach-Object { $_.Slug })
  if ($playable.Count -eq 0) {
    throw "None of the $($all.Count) songs in $Library has stem chunks (stems/chunks/chunks.json). Run 'uv run python bin/make-stem-chunks.py' first."
  }
  if ($skipped.Count -gt 0) {
    Write-Host "==> skipped $($skipped.Count) song(s) without stem chunks or with unusable folder names: $($skipped -join ", ")" -ForegroundColor Yellow
  }

  $selected = $playable
  if ($Songs) {
    $wanted = @($Songs | ForEach-Object { $_ -split "[,;\s]+" } | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() })
    $known = @($playable | ForEach-Object { $_.Slug.ToLowerInvariant() })
    $unknown = @($wanted | Where-Object { $known -notcontains $_ })
    if ($unknown.Count -gt 0) { throw "Not in the library (or without chunks): $($unknown -join ", ")" }
    $selected = @($playable | Where-Object { $wanted -contains $_.Slug.ToLowerInvariant() })
  }

  $setlists = @()
  $setlistsDirectory = Get-SetlistsDirectory $root
  if ($setlistsDirectory -and (Test-Path -LiteralPath $setlistsDirectory -PathType Container)) {
    $setlists = @(Get-ChildItem -LiteralPath $setlistsDirectory -File -Filter "*.json" | Where-Object { -not $_.Name.StartsWith(".") })
  }

  [long]$bytes = 0
  foreach ($song in $selected) { $bytes += $song.Items.Bytes }
  return @{
    Library = $Library
    Songs = $selected
    Setlists = $setlists
    Bytes = $bytes
    LibrarySlugs = @($all | ForEach-Object { $_.Slug })
    ExtraSongs = @()
    ExtraSetlists = @()
    Prune = [bool]$Prune
  }
}

# Adds the device side to the plan: what is there that the library does not have.
function Complete-SongPlan {
  param($Plan, [switch]$Optional)
  if ($Optional) {
    $installed = Invoke-Adb @("shell", "pm", "path", $Package) -AllowFailure
    $access = Invoke-RunAs @("id") -AllowFailure
    if ($installed.Code -ne 0 -or $access.Code -ne 0) { return $Plan }
  } else {
    Test-AppAccess
  }

  $deviceSongs = @(Get-DeviceListing "files/songs")
  $deviceSetlists = @(Get-DeviceListing "files/setlists")
  $setlistNames = @($Plan.Setlists | ForEach-Object { $_.Name })
  $Plan.ExtraSongs = @($deviceSongs | Where-Object { $Plan.LibrarySlugs -notcontains $_ })
  $Plan.ExtraSetlists = @($deviceSetlists | Where-Object { $_ -like "*.json" -and $setlistNames -notcontains $_ })
  return $Plan
}

function Read-YesNo {
  param([string]$Prompt, [bool]$Default = $true)
  if (-not $Interactive) { return $Default }
  $suffix = if ($Default) { "[Y/n]" } else { "[y/N]" }
  while ($true) {
    $answer = "$(Read-Host "$Prompt $suffix")".Trim().ToLowerInvariant()
    if ($answer -eq "") { return $Default }
    if ($answer -in @("y", "yes")) { return $true }
    if ($answer -in @("n", "no")) { return $false }
  }
}

function Read-SongSelection {
  param($Plan)
  Write-Host "Songs in the library:" -ForegroundColor Cyan
  for ($i = 0; $i -lt $Plan.Songs.Count; $i++) {
    Write-Host ("  [{0,2}] {1,-44} {2,8:N1} MB" -f ($i + 1), $Plan.Songs[$i].Slug, ($Plan.Songs[$i].Items.Bytes / 1MB))
  }
  while ($true) {
    $answer = "$(Read-Host "Songs to sync (numbers or slugs, e.g. 1,3-5; empty cancels)")".Trim()
    if ($answer -eq "") { return @() }
    $picked = @{}
    $unknown = @()
    foreach ($token in ($answer -split "[,;\s]+" | Where-Object { $_ })) {
      $index = -1
      if ($token -match "^(\d+)-(\d+)$") {
        $from = [int]$Matches[1]
        $to = [int]$Matches[2]
        if ($from -ge 1 -and $to -le $Plan.Songs.Count -and $from -le $to) {
          for ($n = $from; $n -le $to; $n++) { $picked[$n - 1] = $true }
        } else { $unknown += $token }
      } elseif ($token -match "^\d+$") {
        $index = [int]$token - 1
        if ($index -lt 0 -or $index -ge $Plan.Songs.Count) { $unknown += $token; $index = -1 }
      } else {
        for ($i = 0; $i -lt $Plan.Songs.Count; $i++) {
          if ($Plan.Songs[$i].Slug -ieq $token) { $index = $i; break }
        }
        if ($index -lt 0) { $unknown += $token }
      }
      if ($index -ge 0) { $picked[$index] = $true }
    }
    if ($unknown.Count -gt 0) {
      Write-Host "Unknown: $($unknown -join ", ")" -ForegroundColor Yellow
      continue
    }
    $result = @()
    foreach ($index in ($picked.Keys | Sort-Object)) { $result += $Plan.Songs[$index] }
    return $result
  }
}

function Confirm-SongPlan {
  param($Plan)
  if ($Interactive -and -not $Songs) {
    $text = "$($Plan.Songs.Count) song(s), {0:N0} MB" -f ($Plan.Bytes / 1MB)
    if ($Plan.Setlists.Count -gt 0) { $text += " + $($Plan.Setlists.Count) setlist(s)" }
    if (-not (Read-YesNo "Sync $text to $script:Model (n picks the songs)" $true)) {
      $Plan.Songs = @(Read-SongSelection $Plan)
      if ($Plan.Songs.Count -eq 0) { return $null }
      [long]$bytes = 0
      foreach ($song in $Plan.Songs) { $bytes += $song.Items.Bytes }
      $Plan.Bytes = $bytes
    }
  }
  if ($Plan.ExtraSongs.Count -gt 0 -or $Plan.ExtraSetlists.Count -gt 0) {
    if ($Interactive) {
      if (-not $Plan.Prune) {
        Write-Host ""
        Write-Host "Only on the device, not in this library:" -ForegroundColor Yellow
        if ($Plan.ExtraSongs.Count -gt 0) { Write-Host "  songs:    $($Plan.ExtraSongs -join ", ")" }
        if ($Plan.ExtraSetlists.Count -gt 0) { Write-Host "  setlists: $($Plan.ExtraSetlists -join ", ")" }
        $Plan.Prune = Read-YesNo "Remove them from the device" $false
      }
    } elseif (-not $Plan.Prune) {
      Write-Host "==> keeping $($Plan.ExtraSongs.Count) song(s) and $($Plan.ExtraSetlists.Count) setlist(s) that are only on the device (-Prune removes them)" -ForegroundColor Yellow
    }
  }
  return $Plan
}

function Show-Plan {
  param([string]$Task, $Plan)
  Write-Host ""
  Write-Host "Dry run: nothing was changed." -ForegroundColor Yellow
  if ($Task -ne "Songs") {
    Write-Host "  app   : native core, gradlew assemble$Build, install on $script:Model"
  }
  if ($Plan) {
    foreach ($song in $Plan.Songs) {
      Write-Host ("  song  : {0,-44} {1,8:N1} MB" -f $song.Slug, ($song.Items.Bytes / 1MB))
    }
    foreach ($setlist in $Plan.Setlists) { Write-Host "  list  : $($setlist.Name)" }
    foreach ($slug in $Plan.ExtraSongs) {
      if ($Plan.Prune) { Write-Host "  remove: songs/$slug" -ForegroundColor Yellow } else { Write-Host "  keep  : songs/$slug (only on the device)" }
    }
    foreach ($name in $Plan.ExtraSetlists) {
      if ($Plan.Prune) { Write-Host "  remove: setlists/$name" -ForegroundColor Yellow } else { Write-Host "  keep  : setlists/$name (only on the device)" }
    }
  }
  Write-Host ""
}

function Remove-DeviceOnly {
  param($Plan)
  $songs = @($Plan.ExtraSongs | Where-Object { $_ -match $SafeName })
  $setlists = @($Plan.ExtraSetlists | Where-Object { $_ -match $SafeName })
  $kept = @(@($Plan.ExtraSongs) + @($Plan.ExtraSetlists) | Where-Object { $_ -notmatch $SafeName })
  if ($kept.Count -gt 0) {
    Write-Host "==> not removed, unusable names: $($kept -join ", ")" -ForegroundColor Yellow
  }
  if ($songs.Count -gt 0) {
    $paths = [string[]]@($songs | ForEach-Object { "files/songs/$_" })
    Invoke-RunAs (@("rm", "-rf") + $paths) | Out-Null
  }
  if ($setlists.Count -gt 0) {
    $paths = [string[]]@($setlists | ForEach-Object { "files/setlists/$_" })
    Invoke-RunAs (@("rm", "-f") + $paths) | Out-Null
  }
  if ($songs.Count -gt 0 -or $setlists.Count -gt 0) {
    Write-Host "==> removed $($songs.Count) song(s) and $($setlists.Count) setlist(s) that are only on the device" -ForegroundColor Yellow
  }
}

# --- deploy -----------------------------------------------------------------

function Select-Mode {
  if (-not $Interactive) {
    throw "No terminal to ask what to deploy. Pass -Mode App, Songs or Both."
  }
  $modes = @(
    @{ Value = "Both"; Label = "both  : install app + sync songs and setlists" },
    @{ Value = "App"; Label = "app   : build and install the $Build APK" },
    @{ Value = "Songs"; Label = "songs : sync songs and setlists only" }
  )
  Write-Host "Deploy to $($script:Model):" -ForegroundColor Cyan
  for ($i = 0; $i -lt $modes.Count; $i++) {
    Write-Host ("  [{0}] {1}" -f ($i + 1), $modes[$i].Label)
  }
  while ($true) {
    $answer = Read-Host "Choice [1-3, Enter=1]"
    if ($null -eq $answer) { throw "Cancelled." }
    $answer = "$answer".Trim()
    if ($answer -eq "") { return "Both" }
    if ($answer -match "^[123]$") { return $modes[[int]$answer - 1].Value }
    Write-Host "Invalid input. Enter 1-3." -ForegroundColor Yellow
  }
}

function Ensure-JavaHome {
  if (-not ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME "bin\java.exe") -PathType Leaf))) {
    $found = $null
    $java = Get-Command java -ErrorAction SilentlyContinue
    if ($java) {
      $settings = Invoke-Tool -FilePath $java.Source -Arguments @("-XshowSettings:properties", "-version") -AllowFailure
      foreach ($line in $settings.Lines) {
        if ($line -match "java\.home\s*=\s*(.+)") { $found = $Matches[1].Trim(); break }
      }
    }
    if (-not $found) {
      $candidates = @(
        (Join-Path $env:ProgramFiles "Android\Android Studio\jbr"),
        (Join-Path $env:ProgramFiles "Android\Android Studio\jre")
      )
      foreach ($base in @((Join-Path $env:ProgramFiles "Java"), (Join-Path $env:ProgramFiles "Eclipse Adoptium"))) {
        if (Test-Path -LiteralPath $base -PathType Container) {
          $candidates += @(Get-ChildItem -LiteralPath $base -Directory | Select-Object -ExpandProperty FullName)
        }
      }
      foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate "bin\java.exe") -PathType Leaf) { $found = $candidate; break }
      }
    }
    if (-not $found) {
      throw "JAVA_HOME is not set and no Java JDK was found. Install Android Studio or a JDK 17+, or set JAVA_HOME."
    }
    $env:JAVA_HOME = $found
  }
}

function Initialize-Native {
  $builder = Join-Path $ClientRoot "build-android.ps1"
  $nativeLibrary = Join-Path $AndroidProject "app\src\main\jniLibs\arm64-v8a\libmbp_ffi.so"
  if ($SkipNative -and (Test-Path -LiteralPath $nativeLibrary -PathType Leaf)) {
    Write-Host "==> keeping the native core (-SkipNative)"
  } else {
    if (-not (Test-Path -LiteralPath $builder -PathType Leaf)) { throw "Build script not found: $builder" }
    Write-Host "==> building the native core and Kotlin bindings (build-android.ps1) ..." -ForegroundColor Cyan
    & $builder | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "The native build failed (exit $LASTEXITCODE)." }
  }
  if (-not (Test-Path -LiteralPath $nativeLibrary -PathType Leaf)) {
    throw "Native library missing after the build: $nativeLibrary"
  }

  Ensure-JavaHome
  $sdk = Find-AndroidSdk
  if ($sdk) { $env:ANDROID_HOME = $sdk; $env:ANDROID_SDK_ROOT = $sdk }
}

# Builds the debug or the release APK; returns its path.
function Build-Apk {
  param([ValidateSet("Debug", "Release")][string]$Variant)
  $lower = $Variant.ToLowerInvariant()
  $task = "assemble$Variant"
  $apk = Join-Path $AndroidProject "app\build\outputs\apk\$lower\app-$lower.apk"
  Write-Host "==> gradlew $task ..." -ForegroundColor Cyan
  Push-Location -LiteralPath $AndroidProject
  try {
    $result = Invoke-Tool -FilePath (Join-Path $AndroidProject "gradlew.bat") -Arguments @($task, "--console=plain") -Live -AllowFailure
  } finally {
    Pop-Location
  }
  if ($result.Code -ne 0) { throw "The Gradle build failed (exit $($result.Code))." }
  if (-not (Test-Path -LiteralPath $apk -PathType Leaf)) { throw "APK not found: $apk" }
  return $apk
}

# Installs an APK over what is on the device. Both builds carry the debug key, so the
# songs and the markers survive either way.
function Install-Apk {
  param([string]$Apk)
  $size = [math]::Round((Get-Item -LiteralPath $Apk).Length / 1MB, 1)
  Write-Host "==> installing the app ($size MB) ..." -ForegroundColor Cyan
  $install = Invoke-Adb @("install", "-r", "-d", $Apk) -AllowFailure
  $text = $install.Lines -join " "
  if ($install.Code -ne 0 -and $text -match "INSTALL_FAILED_UPDATE_INCOMPATIBLE") {
    if (-not $Interactive) {
      throw "The installed app is signed with another key. Uninstall it first (adb uninstall $Package deletes its songs and markers), then deploy again."
    }
    Write-Host "The installed app was signed with a different key." -ForegroundColor Yellow
    if (-not (Read-YesNo "Uninstall it and install this build? Songs and markers stored in the app are deleted" $false)) {
      throw "Install cancelled."
    }
    Invoke-Adb @("uninstall", $Package) | Out-Null
    $install = Invoke-Adb @("install", "-r", "-d", $Apk) -AllowFailure
    $text = $install.Lines -join " "
    if ($install.Code -eq 0) {
      Write-Host "==> app installed. Its data was wiped, so the songs need a sync." -ForegroundColor Yellow
    }
  }
  if ($install.Code -ne 0) { throw "adb install failed: $text" }
  Write-Host "==> app installed" -ForegroundColor Green
}

# Android installs a release build as bytecode and compiles it in the background over the
# days that follow. Doing it now is where the speed of that build comes from. A debug
# build stays bytecode by design: Android only verifies those.
function Compile-App {
  Write-Host "==> compiling the installed app ahead of time ..." -ForegroundColor Cyan
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $result = Invoke-Adb @("shell", "cmd", "package", "compile", "-m", "speed", $Package) -AllowFailure
  $seconds = [int]$clock.Elapsed.TotalSeconds
  $text = $result.Lines -join " "
  if ($result.Code -eq 0 -and $text -match "Success") {
    Write-Host ("==> compiled in {0:N0}s" -f $seconds) -ForegroundColor Green
  } else {
    Write-Host "==> not compiled ($text). The app starts as bytecode and warms up while it runs." -ForegroundColor Yellow
  }
}

# adb can only write the storage of a debug build. To copy songs into a release install,
# the debug build stands in while the files move, and the release build goes back on
# afterwards. Neither install touches the songs and the markers.
# Returns the build to put back, or nothing when the device has a debug build.
function Enter-SyncBuild {
  $installed = (Invoke-Adb @("shell", "pm", "path", $Package) -AllowFailure).Code -eq 0
  if (-not $installed -or (Invoke-RunAs @("id") -AllowFailure).Code -eq 0) { return $null }
  Write-Host "==> the device has the release build, which adb cannot write to: the debug build stands in for the sync" -ForegroundColor Yellow
  Initialize-Native
  Install-Apk (Build-Apk "Debug")
  return "Release"
}

function Exit-SyncBuild {
  param([string]$Restore)
  if (-not $Restore) { return }
  Write-Host "==> putting the $Restore build back on the device ..." -ForegroundColor Cyan
  Install-Apk (Build-Apk $Restore)
}

function Sync-Songs {
  param($Plan)
  $wasRunning = Test-AppRunning
  if ($wasRunning) {
    Write-Host "==> stopping the app on the device (its files are replaced)" -ForegroundColor Cyan
    Invoke-Adb @("shell", "am", "force-stop", $Package) | Out-Null
  }
  $finishFile = Join-Path ([IO.Path]::GetTempPath()) "mbp-deploy-finish-$PID.sh"
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try {
    Invoke-Adb @("shell", "rm -rf $Stage && mkdir -p $Stage/songs") | Out-Null
    $count = $Plan.Songs.Count
    $index = 0
    foreach ($song in $Plan.Songs) {
      $index++
      Write-Host ("==> [{0}/{1}] {2}  {3:N1} MB" -f $index, $count, $song.Slug, ($song.Items.Bytes / 1MB))
      $remote = "$Stage/songs/$($song.Slug)"
      # adb push puts a folder inside an existing destination, but copies its
      # contents into a destination it has to create: create the parents first.
      $create = @($remote)
      foreach ($directory in $song.Items.Directories) {
        if ($directory.Remote) {
          $parent = Split-Path -Parent $directory.Remote
          if ($parent) { $create += "$remote/$parent" }
        }
      }
      Invoke-Adb (@("shell", "mkdir -p " + (($create | ForEach-Object { "'$_'" }) -join " "))) | Out-Null
      foreach ($directory in $song.Items.Directories) {
        if ($directory.Remote -eq "") {
          $destination = "$Stage/songs/"
        } else {
          $parent = Split-Path -Parent $directory.Remote
          $destination = if ($parent) { "$remote/$parent/" } else { "$remote/" }
        }
        Invoke-Adb (@("push", $directory.Local, $destination)) | Out-Null
      }
      if ($song.Items.Files.Count -gt 0) {
        $paths = [string[]]@($song.Items.Files | ForEach-Object { $_.FullName })
        Invoke-Adb (@("push") + $paths + @("$remote/")) | Out-Null
      }
    }
    if ($Plan.Setlists.Count -gt 0) {
      Write-Host "==> pushing $($Plan.Setlists.Count) setlist(s) ..." -ForegroundColor Cyan
      Invoke-Adb @("shell", "mkdir -p $Stage/setlists") | Out-Null
      $paths = [string[]]@($Plan.Setlists | ForEach-Object { $_.FullName })
      Invoke-Adb (@("push") + $paths + @("$Stage/setlists/")) | Out-Null
    }

    # folders are pushed as they are: drop leftovers of interrupted transfers
    Invoke-Adb @("shell", "find $Stage \( -name '*.part' -o -name Thumbs.db -o -name desktop.ini -o -name .DS_Store \) -delete") | Out-Null

    Write-Host "==> moving the songs into the app ..." -ForegroundColor Cyan
    [IO.File]::WriteAllText($finishFile, ($FinishScriptText.Replace("__STAGE__", $Stage) -replace "`r`n", "`n"))
    Invoke-Adb @("push", $finishFile, "$Stage/finish.sh") | Out-Null
    $result = Invoke-RunAs @("sh", "$Stage/finish.sh")
    foreach ($line in $result.Lines) { Write-Host "    $line" }
    if ($Plan.Prune) { Remove-DeviceOnly $Plan }

    $listing = @(Get-DeviceListing "files/songs")
    $missing = @($Plan.Songs | Where-Object { $listing -notcontains $_.Slug } | ForEach-Object { $_.Slug })
    if ($missing.Count -gt 0) { throw "Not found on the device after the sync: $($missing -join ", ")" }
    Write-Host ("==> {0} song(s) synced in {1:N0}s" -f $count, $clock.Elapsed.TotalSeconds) -ForegroundColor Green
  } finally {
    if (Test-Path -LiteralPath $finishFile) { Remove-Item -LiteralPath $finishFile -Force }
    Invoke-Adb @("shell", "rm -rf $Stage") -AllowFailure | Out-Null
    if ($wasRunning -and -not $NoLaunch) {
      Invoke-Adb @("shell", "am", "start", "-n", $Activity) -AllowFailure | Out-Null
    }
  }
}

function Invoke-Deploy {
  $script:Adb = Find-Adb
  $script:Device = Select-Device
  $script:Model = Get-DeviceModel $script:Device.Serial
  Write-Host "==> target device: $script:Model ($($script:Device.Serial))" -ForegroundColor Cyan

  $task = $Mode
  if (-not $task) { $task = Select-Mode }

  # Read the library before touching the device, so a wrong path fails early.
  $plan = $null
  if ($task -ne "App") { $plan = Get-SongPlan (Resolve-LibraryPath $Library) }
  if ($DryRun) {
    if ($plan) { $plan = Complete-SongPlan $plan -Optional }
    Show-Plan $task $plan
    return
  }

  $wasRunning = Test-AppRunning
  $installed = $false
  if ($task -ne "Songs") {
    Initialize-Native
    Install-Apk (Build-Apk $Build)
    $installed = $true
  }
  $restore = $null
  if ($plan) {
    $restore = Enter-SyncBuild
    try {
      $plan = Confirm-SongPlan (Complete-SongPlan $plan)
      if ($plan) { Sync-Songs $plan }
    } finally {
      Exit-SyncBuild $restore
    }
  }
  # the build that ends up on the device
  $final = if ($restore) { $restore } elseif ($installed) { $Build } else { $null }
  if ($final -eq "Release") { Compile-App }
  if (-not $NoLaunch -and ($installed -or ($restore -and $wasRunning))) {
    Invoke-Adb @("shell", "am", "start", "-n", $Activity) | Out-Null
    Write-Host "==> app started on the device"
  }
  Write-Host ""
  Write-Host "Done." -ForegroundColor Green
}

try {
  Invoke-Deploy
} catch {
  Write-Host ""
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
exit 0
