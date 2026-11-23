# M2 W5 regression runner (M2-W5-01 / M2-W5-04).
# Creates a unique temporary schema, runs a psql entry, captures stdout/stderr
# and the native exit code, always drops that exact schema, then reports:
#   * residual schemas matching this run
#   * residual t_w5_* schemas in the database
#   * lingering sessions with this run's application_name
#
# Examples:
#   .\run_w5_regression.ps1 -Database mce_w5_practice
#   .\run_w5_regression.ps1 -Database mce_w5_practice `
#       -Entry negative_control\run_w5_negative_control.sql -ExpectFailure
#
# The database must be an isolated practice database. Use pgpass/PGPASSWORD for
# credentials; do not put secrets in this script or the repository.

param(
    [Parameter(Mandatory = $true)]
    [string]$Database,

    [string]$Entry = 'run_w5_regression.sql',

    [string]$Psql = 'psql',

    [string]$Schema = '',

    [string]$LogDir = '',

    [int]$TimeoutSeconds = 180,

    [switch]$ExpectFailure
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
    $Schema = "t_w5_${stamp}_$PID"
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

$prefix = "w5_regression_${stamp}_$PID"
$outFile = Join-Path $LogDir "$prefix.stdout.txt"
$errFile = Join-Path $LogDir "$prefix.stderr.txt"
$appName = "mce_w5_${stamp}_$PID"

function Invoke-PsqlScalar {
    param([string]$Sql, [string]$AppName)
    $oldApp = $env:PGAPPNAME
    $oldEap = $ErrorActionPreference
    $env:PGAPPNAME = $AppName
    $ErrorActionPreference = 'Continue'
    try {
        $value = & $psqlExe -X -w -t -A -v ON_ERROR_STOP=1 -d $Database -c $Sql 2>$null
        if ($null -eq $value) { return '' }
        return (@($value) -join "`n").Trim()
    }
    finally {
        $env:PGAPPNAME = $oldApp
        $ErrorActionPreference = $oldEap
    }
}

$beforeResidual = ''
$afterResidual = ''
$afterExact = ''
$lingering = ''
$job = $null
$exitCode = 0

try {
    $beforeResidual = Invoke-PsqlScalar `
        "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 't\_w5\_%';" `
        "$appName`_probe"

    $job = Start-Job -ScriptBlock {
        param($psql, $database, $schema, $script, $stdoutPath, $stderrPath, $appName)
        $env:PGAPPNAME = $appName
        & $psql -X -w -v ON_ERROR_STOP=1 -d $database -v "w5_schema=$schema" `
            -f $script 1> $stdoutPath 2> $stderrPath
        return $LASTEXITCODE
    } -ArgumentList $psqlExe, $Database, $Schema, $entryPath, $outFile, $errFile, $appName

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

    try {
        $afterExact = Invoke-PsqlScalar `
            "SELECT count(*) FROM pg_namespace WHERE nspname = '$Schema';" `
            "$appName`_probe"
        $afterResidual = Invoke-PsqlScalar `
            "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 't\_w5\_%';" `
            "$appName`_probe"
        $lingering = Invoke-PsqlScalar `
            "SELECT count(*) FROM pg_stat_activity WHERE application_name = '$appName';" `
            "$appName`_probe"
    }
    catch {
        Write-Warning "Residual checks failed: $_"
    }

    if ($job) {
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
}

$outcome = 'FAIL'
if ($ExpectFailure) {
    $expectedFailureDetected = $exitCode -eq 3 -and
        (Select-String -LiteralPath $errFile -SimpleMatch 'W5 CHECK FAILED [username duplicate]: expected 23514, got 23505' -Quiet)
    if ($expectedFailureDetected -and $afterExact -eq '0' -and $lingering -eq '0') {
        $outcome = 'PASS (expected failure detected, cleaned up)'
    }
}
else {
    if ($exitCode -eq 0 -and $afterExact -eq '0' -and $lingering -eq '0') { $outcome = 'PASS' }
}

Write-Host "W5 entry: $Entry"
Write-Host "W5 schema: $Schema"
Write-Host "W5 stdout: $outFile"
Write-Host "W5 stderr: $errFile"
Write-Host "W5 exit code: $exitCode"
Write-Host "W5 residual t_w5_* before: $beforeResidual"
Write-Host "W5 residual this schema after: $afterExact"
Write-Host "W5 residual t_w5_* after: $afterResidual"
Write-Host "W5 lingering sessions (app=$appName): $lingering"
Write-Host "W5 outcome: $outcome"

if ($ExpectFailure) {
    if (-not $expectedFailureDetected -or $afterExact -ne '0' -or $lingering -ne '0') { exit 1 }
    exit 0
}

if ($exitCode -ne 0) { exit $exitCode }
if ($afterExact -ne '0' -or $lingering -ne '0') { exit 1 }
exit 0
