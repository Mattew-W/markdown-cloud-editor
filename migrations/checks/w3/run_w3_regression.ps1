# M2 W3 isolated regression runner.
# Creates a unique temporary schema, applies the frozen migration, runs the
# selected regression entry, and always drops the schema in a finally block.
#
# Examples:
#   .\run_w3_regression.ps1 -Database mce_practice
#   .\run_w3_regression.ps1 -Database mce_practice -Entry run_w3_negative_control.sql
#
# The database must be an empty practice database. Do not point this at a
# production database or one containing real user data.

param(
    [Parameter(Mandatory = $true)]
    [string]$Database,

    [string]$Entry = 'run_w3_regression.sql',

    [string]$Psql = 'psql',

    [string]$Schema = '',

    [string]$LogFile = ''
)

$ErrorActionPreference = 'Stop'

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..\..')).Path
$entryPath = Join-Path $scriptDir $Entry

if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
    Write-Host "ERROR: Entry file not found: $entryPath"
    exit 2
}

$psqlCmd = Get-Command $Psql -ErrorAction SilentlyContinue
if (-not $psqlCmd) {
    Write-Host "ERROR: psql not found: $Psql. Add PostgreSQL bin to PATH or pass -Psql <path>."
    exit 127
}
$psqlExe = $psqlCmd.Source
if (-not $psqlExe) { $psqlExe = $psqlCmd.Path }

if ([string]::IsNullOrWhiteSpace($Schema)) {
    $Schema = "t_w3_${stamp}_$PID"
}
if ($Schema -notmatch '^[a-z0-9_]{1,50}$') {
    Write-Host "ERROR: Schema contains invalid characters: $Schema"
    exit 2
}

if ([string]::IsNullOrWhiteSpace($LogFile)) {
    $logDir = Join-Path $repoRoot 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir | Out-Null
    }
    $LogFile = Join-Path $logDir ("w3_regression_{0}_{1}.log" -f $stamp, $PID)
} else {
    $logDir = Split-Path -Parent $LogFile
    if ($logDir -and -not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir | Out-Null
    }
}

$psqlArgs = @(
    '-X',
    '-v', 'ON_ERROR_STOP=1',
    '-d', $Database,
    '-v', "w3_schema=$Schema",
    '-L', $LogFile,
    '-f', $entryPath
)

$exitCode = 0
try {
    & $psqlExe @psqlArgs
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }
}
catch {
    Write-Host "ERROR: $_"
    $exitCode = 1
}
finally {
    try {
        $cleanup = 'DROP SCHEMA IF EXISTS "' + $Schema + '" CASCADE;'
        & $psqlExe -X -v ON_ERROR_STOP=1 -d $Database -c $cleanup | Out-Null
    }
    catch {
        Write-Warning "Could not drop schema $Schema : $_"
    }
}

Write-Host "W3 schema: $Schema"
Write-Host "W3 log: $LogFile"
Write-Host "W3 exit code: $exitCode"
exit $exitCode
