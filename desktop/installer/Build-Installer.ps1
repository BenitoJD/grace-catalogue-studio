param(
    [string]$AppVersion,
    [string]$OutputDirectory = 'release',
    [string]$PayloadDirectory = 'release\win-unpacked'
)

$ErrorActionPreference = 'Stop'
$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $desktopRoot '..')).Path

if (-not $AppVersion) {
    $package = Get-Content (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json
    $AppVersion = $package.version
}

$payloadPath = [System.IO.Path]::GetFullPath((Join-Path $desktopRoot $PayloadDirectory))
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $desktopRoot $OutputDirectory))
if (-not (Test-Path (Join-Path $payloadPath 'Jacob Design Studio.exe'))) {
    throw "The Windows payload was not found at $payloadPath. Run 'npm run build:win:payload' first."
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

$compiler = Get-Command 'makensis.exe' -ErrorAction SilentlyContinue
$compilerPath = if ($compiler) { $compiler.Source } else { $null }
if (-not $compilerPath) {
    foreach ($candidate in @(
        'C:\Program Files (x86)\NSIS\makensis.exe',
        'C:\Program Files\NSIS\makensis.exe'
    )) {
        if (Test-Path $candidate) {
            $compilerPath = $candidate
            break
        }
    }
}
if (-not $compilerPath) {
    throw 'NSIS makensis.exe was not found. Install NSIS 3.x before building the installer.'
}

$iconPath = Join-Path $desktopRoot 'build\icon.ico'
$arguments = @(
    "/DAPP_VERSION=$AppVersion",
    "/DPAYLOAD_DIR=$payloadPath",
    "/DOUTPUT_DIR=$outputPath",
    "/DICON_PATH=$iconPath",
    (Join-Path $PSScriptRoot 'JacobStudio.nsi')
)
& $compilerPath @arguments
if ($LASTEXITCODE -ne 0) {
    throw "NSIS failed to build the installer (exit code $LASTEXITCODE)."
}

$setup = Join-Path $outputPath "JacobStudio-Setup-$AppVersion.exe"
if (-not (Test-Path $setup)) {
    throw "NSIS reported success but the installer is missing at $setup."
}
Write-Host "Built $setup"
