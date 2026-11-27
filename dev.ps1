[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$Library,

    [switch]$Release
)

$ErrorActionPreference = 'Stop'
$manifest = Join-Path $PSScriptRoot 'client-v2/Cargo.toml'
$cargoArguments = @('run', '--locked', '--manifest-path', $manifest, '-p', 'mbp-windows')
if ($Release) {
    $cargoArguments += '--release'
}
if ($PSBoundParameters.ContainsKey('Library')) {
    $libraryPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Library)
    $cargoArguments += @('--', $libraryPath)
}

Push-Location -LiteralPath $PSScriptRoot
try {
    & cargo @cargoArguments
    $launchExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}

exit $launchExitCode
