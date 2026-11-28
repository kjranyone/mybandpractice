<#
.SYNOPSIS
  Developer launcher for the v2 clients: run the Windows client, or deploy the
  Android app and the song library to a connected device.

.DESCRIPTION
  Without task arguments the script shows a menu; Enter runs the Windows client
  as before. Arguments pick a task directly. When the standard input is not a
  terminal (agents, pipelines) the menu is skipped and the Windows client runs.

  The library folder given with -Library or picked in the menu is remembered in
  %LOCALAPPDATA%\MyBandPractice\dev.library.txt and used by every task. Answer
  "auto" in the library prompt to forget it and use the repository's songs again.

.EXAMPLE
  .\dev.ps1
  Show the menu.

.EXAMPLE
  .\dev.ps1 -Release
  Run the release build of the Windows client without the menu.

.EXAMPLE
  .\dev.ps1 -Library "C:\Music\songs"
  Run the Windows client with that library and remember it.

.EXAMPLE
  .\dev.ps1 -Android
  Deploy to Android without the menu: ask what to deploy and pick the device.

.EXAMPLE
  .\dev.ps1 -Android Both -Serial X
  Install the app and sync the songs without asking (-Mode Both means the same).
  More options (song selection, -Prune, -SkipNative, -DryRun):
  client-v2\deploy-android.ps1
#>
[CmdletBinding()]
param(
    # A library folder, or after -Android what to deploy: App, Songs or Both.
    [Parameter(Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$Argument,

    # Song library folder used by every task. Remembered for the next run.
    [ValidateNotNullOrEmpty()]
    [string]$Library,

    [switch]$Release,

    # Run the Windows client without showing the menu.
    [switch]$Run,

    # Deploy to a connected Android device without showing the menu. Ask what
    # to deploy unless App, Songs or Both is given.
    [switch]$Android,

    # What to deploy: App, Songs or Both. Implies -Android.
    [ValidateSet('App', 'Songs', 'Both')]
    [string]$Mode,

    # Device to deploy to. Only needed when several devices are connected.
    [string]$Serial,

    # Show the menu even when the standard input is not a terminal.
    [switch]$Menu
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$deployScript = Join-Path $repo 'client-v2/deploy-android.ps1'
$defaultLibrary = Join-Path $repo 'songs'
$stateFile = Join-Path (Join-Path $env:LOCALAPPDATA 'MyBandPractice') 'dev.library.txt'
$interactive = (-not [Console]::IsInputRedirected -and [Environment]::UserInteractive) -or $Menu

function Resolve-InputPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    $expanded = $Path.Trim().Trim('"').Trim("'")
    $expanded = [Environment]::ExpandEnvironmentVariables($expanded)
    try { return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($expanded) } catch { return $null }
}

function Get-SavedLibrary {
    if (Test-Path -LiteralPath $stateFile -PathType Leaf) {
        $saved = [IO.File]::ReadAllText($stateFile).Trim()
        if ($saved) { return $saved }
    }
    return $null
}

function Save-Library([string]$Path) {
    $directory = Split-Path -Parent $stateFile
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    [IO.File]::WriteAllText($stateFile, $Path)
}

# "-Android Both" lands in the positional parameter: take it as the mode.
# The parameter variables themselves are left alone: an empty value would trip
# their validation.
$modeArgument = $Mode
$libraryArgument = $Library
if ($Android -and $Argument -in @('App', 'Songs', 'Both')) {
    if ($modeArgument) { throw 'Give the mode once: -Android <mode> or -Mode <mode>.' }
    $modeArgument = $Argument
} elseif ($Argument) {
    if ($libraryArgument) { throw 'Give the library folder once.' }
    $libraryArgument = $Argument
}

# The library every task uses: the argument, else the remembered one, else nothing
# (the Windows client then looks for a songs folder by itself).
if ($libraryArgument) {
    $script:libraryPath = Resolve-InputPath $libraryArgument
    if (-not $script:libraryPath) { throw "Invalid library path: $libraryArgument" }
    if (Test-Path -LiteralPath $script:libraryPath -PathType Container) { Save-Library $script:libraryPath }
} else {
    $script:libraryPath = Get-SavedLibrary
}

function Read-Input([string]$Prompt) {
    # Read-Host returns nothing once the input is closed (a pipe or file with -Menu).
    $answer = Read-Host $Prompt
    if ($null -eq $answer) { return $null }
    return "$answer".Trim()
}

function Start-WindowsClient([switch]$ReleaseBuild) {
    $manifest = Join-Path $repo 'client-v2/Cargo.toml'
    $cargoArguments = @('run', '--locked', '--manifest-path', $manifest, '-p', 'mbp-windows')
    if ($ReleaseBuild) { $cargoArguments += '--release' }
    if ($script:libraryPath) { $cargoArguments += @('--', $script:libraryPath) }
    Push-Location -LiteralPath $repo
    try {
        # Out-Host keeps the client's output off the function's return value
        & cargo @cargoArguments | Out-Host
        return $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

function Start-Android([string]$TaskMode) {
    if (-not (Test-Path -LiteralPath $deployScript -PathType Leaf)) { throw "Deploy script not found: $deployScript" }
    $deployArguments = @{}
    if ($TaskMode) { $deployArguments['Mode'] = $TaskMode }
    if ($Serial) { $deployArguments['Serial'] = $Serial }
    if ($script:libraryPath) { $deployArguments['Library'] = $script:libraryPath }
    & $deployScript @deployArguments | Out-Host
    return $LASTEXITCODE
}

function Show-FolderPicker {
    try {
        Add-Type -AssemblyName System.Windows.Forms
    } catch {
        Write-Host 'The folder picker is unavailable here. Type the path instead.' -ForegroundColor Yellow
        return $null
    }
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Select the songs library folder'
    if ($script:libraryPath -and (Test-Path -LiteralPath $script:libraryPath -PathType Container)) { $dialog.SelectedPath = $script:libraryPath }
    # a topmost owner keeps the dialog in front of the terminal
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
    try {
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { return $dialog.SelectedPath }
        return $null
    } finally {
        $dialog.Dispose()
        $owner.Dispose()
    }
}

function Read-Library {
    Write-Host ''
    Write-Host 'Songs library. Enter keeps the current one, ? opens a folder picker,'
    Write-Host "auto uses $defaultLibrary"
    while ($true) {
        if ($script:libraryPath) {
            $answer = Read-Input "Library folder [$script:libraryPath]"
        } else {
            $answer = Read-Input 'Library folder [auto]'
        }
        if ($null -eq $answer -or $answer -eq '') { return }
        if ($answer -ieq 'auto') {
            if (Test-Path -LiteralPath $stateFile) { Remove-Item -LiteralPath $stateFile -Force }
            $script:libraryPath = $null
            return
        }
        if ($answer -eq '?') {
            $answer = Show-FolderPicker
            if (-not $answer) { continue }
        }
        $path = Resolve-InputPath $answer
        if ($path -and (Test-Path -LiteralPath $path -PathType Container)) {
            $script:libraryPath = $path
            Save-Library $path
            return
        }
        Write-Host "Folder not found: $answer" -ForegroundColor Yellow
    }
}

function Show-Menu {
    $libraryText = "$defaultLibrary (repository default)"
    if ($script:libraryPath) {
        $libraryText = $script:libraryPath
        if (-not (Test-Path -LiteralPath $script:libraryPath -PathType Container)) { $libraryText += ' (not found)' }
    }
    Write-Host ''
    Write-Host 'My Band Practice' -ForegroundColor Cyan
    Write-Host "  Library: $libraryText"
    Write-Host ''
    Write-Host '  [1] Run the Windows client (debug)'
    Write-Host '  [2] Run the Windows client (release)'
    Write-Host '  [3] Android: install app + sync songs'
    Write-Host '  [4] Android: install app'
    Write-Host '  [5] Android: sync songs'
    Write-Host '  [6] Change library folder'
    Write-Host '  [0] Exit'
}

function Invoke-MenuAndroid([string]$TaskMode) {
    $found = $false
    if ($script:libraryPath) { $found = Test-Path -LiteralPath $script:libraryPath -PathType Container }
    if ($TaskMode -ne 'App' -and -not $found) { Read-Library }
    return (Start-Android $TaskMode)
}

function Invoke-MenuTask([scriptblock]$Task) {
    try {
        $code = & $Task
        if ($code -and $code -ne 0) { $script:failed = $true }
    } catch {
        $script:failed = $true
        Write-Host ''
        Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    }
}

if ($Android -or $modeArgument -or $Serial) {
    if ($Run -or $Release) { throw '-Android cannot be combined with -Run or -Release.' }
    exit (Start-Android $modeArgument)
}
if ($Run -or $Release -or $libraryArgument -or -not $interactive) {
    exit (Start-WindowsClient -ReleaseBuild:$Release)
}

$script:failed = $false
:menu while ($true) {
    Show-Menu
    $choice = Read-Input 'Choice [0-6, Enter=1]'
    if ($null -eq $choice) { break menu }
    if ($choice -eq '') { $choice = '1' }
    switch ($choice) {
        '1' { Invoke-MenuTask { Start-WindowsClient } }
        '2' { Invoke-MenuTask { Start-WindowsClient -ReleaseBuild } }
        '3' { Invoke-MenuTask { Invoke-MenuAndroid 'Both' } }
        '4' { Invoke-MenuTask { Invoke-MenuAndroid 'App' } }
        '5' { Invoke-MenuTask { Invoke-MenuAndroid 'Songs' } }
        '6' { Invoke-MenuTask { Read-Library } }
        '0' { break menu }
        default { Write-Host 'Enter 0-6.' -ForegroundColor Yellow }
    }
}
if ($script:failed) { exit 1 }
exit 0
