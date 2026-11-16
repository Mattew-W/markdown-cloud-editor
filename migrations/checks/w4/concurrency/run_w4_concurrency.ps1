# M2 W4 two-session CAS concurrency runner.
# Creates a unique schema, applies the frozen migration, starts two independent
# psql processes (A/B), waits for their barriers and CAS updates, then verifies
# the result. The exact schema is always dropped in a finally block.
#
# The database must be an isolated practice database. Use pgpass/PGPASSWORD for
# credentials; do not put secrets in this script or the repository.

param(
    [Parameter(Mandatory = $true)]
    [string]$Database,

    [string]$Psql = 'psql',

    [string]$Schema = '',

    [string]$LogDir = '',

    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..\..\..')).Path
$psqlCmd = Get-Command $Psql -ErrorAction SilentlyContinue
if (-not $psqlCmd) {
    Write-Host "ERROR: psql not found: $Psql. Add PostgreSQL bin to PATH or pass -Psql <path>."
    exit 127
}
$psqlExe = $psqlCmd.Source
if (-not $psqlExe) { $psqlExe = $psqlCmd.Path }

if ([string]::IsNullOrWhiteSpace($Schema)) {
    $Schema = "t_w4_conc_${stamp}_$PID"
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
$prefix = "w4_concurrency_${stamp}_$PID"
$setupLog = Join-Path $LogDir "$prefix.setup.log"
$outA = Join-Path $LogDir "$prefix.A.stdout.txt"
$errA = Join-Path $LogDir "$prefix.A.stderr.txt"
$outB = Join-Path $LogDir "$prefix.B.stdout.txt"
$errB = Join-Path $LogDir "$prefix.B.stderr.txt"
$verifyLog = Join-Path $LogDir "$prefix.verify.log"

$setupScript = Join-Path $scriptDir 'run_setup.sql'
$sessionA = Join-Path $scriptDir 'session_a.sql'
$sessionB = Join-Path $scriptDir 'session_b.sql'
$verifyScript = Join-Path $scriptDir 'verify.sql'

$jobA = $null
$jobB = $null
$exitCode = 0

try {
    Write-Host "W4 concurrency: setup schema $Schema"
    & $psqlExe -X -w -v ON_ERROR_STOP=1 -d $Database -v "w4_schema=$Schema" -L $setupLog -f $setupScript
    $setupRc = $LASTEXITCODE
    if ($setupRc -ne 0) {
        throw "setup psql exited with $setupRc (log: $setupLog)"
    }

    $jobA = Start-Job -ScriptBlock {
        param($psql, $database, $schema, $script, $stdoutPath, $stderrPath)
        & $psql -X -w -v ON_ERROR_STOP=1 -d $database -v "w4_schema=$schema" `
            -f $script 1> $stdoutPath 2> $stderrPath
        return $LASTEXITCODE
    } -ArgumentList $psqlExe, $Database, $Schema, $sessionA, $outA, $errA

    $jobB = Start-Job -ScriptBlock {
        param($psql, $database, $schema, $script, $stdoutPath, $stderrPath)
        & $psql -X -w -v ON_ERROR_STOP=1 -d $database -v "w4_schema=$schema" `
            -f $script 1> $stdoutPath 2> $stderrPath
        return $LASTEXITCODE
    } -ArgumentList $psqlExe, $Database, $Schema, $sessionB, $outB, $errB

    $jobs = @($jobA, $jobB)
    Wait-Job -Job $jobs -Timeout $TimeoutSeconds | Out-Null

    $pending = @($jobs | Where-Object { $_.State -ne 'Completed' })
    if ($pending.Count -gt 0) {
        $pending | Stop-Job -ErrorAction SilentlyContinue
        throw "one or both psql sessions did not complete within $TimeoutSeconds seconds"
    }

    $rcA = 1
    $rcB = 1
    $resultA = Receive-Job -Job $jobA -ErrorAction SilentlyContinue
    $resultB = Receive-Job -Job $jobB -ErrorAction SilentlyContinue
    if ($null -ne $resultA) { $rcA = [int](@($resultA)[-1]) }
    if ($null -ne $resultB) { $rcB = [int](@($resultB)[-1]) }

    Write-Host "W4 concurrency: session A exit=$rcA, session B exit=$rcB"
    if ($rcA -ne 0 -or $rcB -ne 0) {
        throw "session failure: A=$rcA B=$rcB (logs: $outA / $errA / $outB / $errB)"
    }

    Write-Host "W4 concurrency: verify"
    & $psqlExe -X -w -v ON_ERROR_STOP=1 -d $Database -v "w4_schema=$Schema" -L $verifyLog -f $verifyScript
    $verifyRc = $LASTEXITCODE
    if ($verifyRc -ne 0) {
        throw "verification psql exited with $verifyRc (log: $verifyLog)"
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
    foreach ($job in @($jobA, $jobB)) {
        if ($job) { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
    }
}

Write-Host "W4 concurrency schema: $Schema"
Write-Host "W4 concurrency logs: $LogDir\$prefix.*"
Write-Host "W4 concurrency exit code: $exitCode"
exit $exitCode
