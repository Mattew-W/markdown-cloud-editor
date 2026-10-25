# PostgreSQL 17 unattended installer helper for Windows.
#
# Download the official PostgreSQL 17 installer and pass its path with -Installer.
# The default install prefix is under Program Files; override it if needed.
#
# Example:
#   pwsh -NoProfile -File scripts/install_postgres.ps1 -Installer <installer-path>
#
param(
    [string]$SuperPassword = '',
    [string]$Prefix = (Join-Path $env:ProgramFiles 'PostgreSQL\17'),
    [string]$DataDir = '',
    [int]$Port = 5432,
    [string]$ServiceName = 'postgresql-x64-17',
    [string]$Installer = (Join-Path $PSScriptRoot 'postgresql-17.11-5-windows-x64.exe')
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Join-Path $Prefix 'data'
}

$psql = Join-Path $Prefix 'bin\psql.exe'
if (Test-Path -LiteralPath $psql) {
    Write-Host "PostgreSQL is already installed at $Prefix."
    & $psql --version
    exit 0
}

if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
    Write-Error "Installer not found: $Installer. Download PostgreSQL 17 and pass its path with -Installer."
    exit 1
}

$drive = (Split-Path -Path $Prefix -Qualifier).TrimEnd(':')
if (-not $drive) {
    Write-Error 'Prefix must be on a local drive.'
    exit 2
}
$driveInfo = Get-PSDrive -Name $drive -ErrorAction Stop
$freeGB = [math]::Round($driveInfo.Free / 1GB, 1)
Write-Host "$drive drive free space: $freeGB GB"
if ($freeGB -lt 3) {
    Write-Error 'At least 3 GB of free space is required.'
    exit 1
}

if ([string]::IsNullOrWhiteSpace($SuperPassword)) {
    $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)
    $SuperPassword = [Convert]::ToBase64String($bytes).Replace('+', 'A').Replace('/', 'B').Replace('=', '')
    Write-Host 'Generated a local-only PostgreSQL password. Store it in .env; do not commit it.'
}

function ConvertTo-WindowsCommandLineArgument {
    param([Parameter(Mandatory)][string]$Value)

    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)
if ($process.ExitCode -ne 0) {
    Write-Error "Installer exited with code $($process.ExitCode)."
    exit $process.ExitCode
}

if (-not (Test-Path -LiteralPath $psql -PathType Leaf)) {
    Write-Error "Installer completed but psql was not found at $psql."
    exit 1
}

Write-Host 'Installation complete.'
& $psql --version
Write-Host "Install prefix: $Prefix"
Write-Host "Data directory: $DataDir"
Write-Host "Service name: $ServiceName"
Write-Host "Port: $Port"
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    Write-Host "Service status: $($service.Status)"
} else {
    Write-Warning "Service $ServiceName was not found. Check the name selected by the installer."
}
, '$1$1')
    return '"' + $escaped + '"'
}

$installerArgs = @(
    '--mode', 'unattended',
    '--prefix', $Prefix,
    '--datadir', $DataDir,
    '--superpassword', $SuperPassword,
    '--serverport', "$Port",
    '--servicename', $ServiceName,
    '--disable-components', 'stackbuilder'
)
$argumentLine = ($installerArgs | ForEach-Object {
    ConvertTo-WindowsCommandLineArgument -Value "$_"
}) -join ' '

Write-Host "Installing PostgreSQL 17 to $Prefix ..."
$process = Start-Process -FilePath $Installer -ArgumentList $argumentLine -Wait -PassThru
if ($process.ExitCode -ne 0) {
    Write-Error "Installer exited with code $($process.ExitCode)."
    exit $process.ExitCode
}

if (-not (Test-Path -LiteralPath $psql -PathType Leaf)) {
    Write-Error "Installer completed but psql was not found at $psql."
    exit 1
}

Write-Host 'Installation complete.'
& $psql --version
Write-Host "Install prefix: $Prefix"
Write-Host "Data directory: $DataDir"
Write-Host "Service name: $ServiceName"
Write-Host "Port: $Port"
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    Write-Host "Service status: $($service.Status)"
} else {
    Write-Warning "Service $ServiceName was not found. Check the name selected by the installer."
}
