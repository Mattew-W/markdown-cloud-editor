# M2 W4 main SQL regression runner.
# Creates a unique temporary schema, runs the selected psql entry, captures
# stdout/stderr and the native exit code, and always drops that exact schema.
#
# Examples:
#   .\run_w4_regression.ps1 -Database mce_w4_practice
#   .\run_w4_regression.ps1 -Database mce_w4_practice -Entry negative_control\run_w4_negative_control.sql
#
# The database must be an isolated practice database. Use pgpass/PGPASSWORD for
# credentials; do not put secrets in this script or the repository.

param(
    [Parameter(Mandatory = $true)]
    [string]$Database,

    [string]$Entry = 'run_w4_regression.sql',

    [string]$Psql = 'psql',

    [string]$Schema = '',

    [string]$LogDir = '',

    [int]$TimeoutSeconds = 120
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
    $Schema = "t_w4_${stamp}_$PID"
}
if ($Schema -notmatch '^[a-z0-9_]{1,50}$') {
    Write-Host "ERROR: Schema contains invalid characters: $Schema"
    exit 2
}

if ([string]::IsNullOrWhiteSpace($LogDir)) {
    $LogDir = Join-Path $repoRoot 'logs'
}
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
}
$prefix = "w4_regression_${stamp}_$PID"
$outFile = Join-Path $LogDir "$prefix.stdout.txt"
$errFile = Join-Path $LogDir "$prefix.stderr.txt"

$job = $null
$exitCode = 0
try {
    $job = Start-Job -ScriptBlock {
        param($psql, $database, $schema, $script, $stdoutPath, $stderrPath)
        & $psql -X -w -v ON_ERROR_STOP=1 -d $database -v "w4_schema=$schema" `
            -f $script 1> $stdoutPath 2> $stderrPath
        return $LASTEXITCODE
    } -ArgumentList $psqlExe, $Database, $Schema, $entryPath, $outFile, $errFile

    $finished = Wait-Job -Job $job -Timeout $TimeoutSeconds
    if (-not $finished) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Write-Host "ERROR: psql job timed out after $TimeoutSeconds seconds."
        $exitCode = 1
    }
    else {
        $result = Receive-Job -Job $job -ErrorAction SilentlyContinue
        if ($null -eq $result) {
            $exitCode = 1
        }
        else {
            $exitCode = [int](@($result)[-1])
        }
    }
}
catch {
    Write-Host "ERROR: $_"
    $exitCode = 1
}
finally {
    try {
        $cleanup = 'DROP SCHEMA IF EXISTS "' + $Schema + '" CASCADE;'
        & $psqlExe -X -w -v ON_ERROR_STOP=1 -d $Database -c $cleanup | Out-Null
    }
    catch {
        Write-Warning "Could not drop schema $Schema : $_"
    }
    if ($job) {
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "W4 schema: $Schema"
Write-Host "W4 stdout: $outFile"
Write-Host "W4 stderr: $errFile"
Write-Host "W4 exit code: $exitCode"
exit $exitCode
