# M2 W5 two-session CAS runner (M2-W5-02).
# Creates a unique schema, applies the frozen migration, starts two independent
# psql processes (A/B), waits for barriers and CAS attempts, verifies loser
# attribution, then always drops that exact schema and reports residuals.
#
#   .\run_w5_concurrency.ps1 -Database mce_w5_practice
#
# Use pgpass/PGPASSWORD for credentials; do not put secrets in this file.

param(
    [Parameter(Mandatory = $true)]
    [string]$Database,

    [string]$Psql = 'psql',

    [string]$Schema = '',

    [string]$LogDir = '',

    [int]$TimeoutSeconds = 180
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
    $Schema = "t_w5_conc_${stamp}_$PID"
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

$prefix = "w5_concurrency_${stamp}_$PID"
$setupLog = Join-Path $LogDir "$prefix.setup.log"
$outA = Join-Path $LogDir "$prefix.A.stdout.txt"
$errA = Join-Path $LogDir "$prefix.A.stderr.txt"
$outB = Join-Path $LogDir "$prefix.B.stdout.txt"
$errB = Join-Path $LogDir "$prefix.B.stderr.txt"
$verifyLog = Join-Path $LogDir "$prefix.verify.log"
$appName = "mce_w5c_${stamp}_$PID"

$setupScript = Join-Path $scriptDir 'run_setup.sql'
$sessionA = Join-Path $scriptDir 'session_a.sql'
$sessionB = Join-Path $scriptDir 'session_b.sql'
$verifyScript = Join-Path $scriptDir 'verify.sql'

$jobA = $null
$jobB = $null
$exitCode = 0
$residual = ''

try {
    Write-Host "W5 concurrency: setup schema $Schema"
    $env:PGAPPNAME = "$appName`_setup"
    & $psqlExe -X -w -v ON_ERROR_STOP=1 -d $Database -v "w5_schema=$Schema" -L $setupLog -f $setupScript
    if ($LASTEXITCODE -ne 0) {
        throw "setup psql exited with $LASTEXITCODE (log: $setupLog)"
    }

    $env:PGAPPNAME = "$appName`_A"
    $jobA = Start-Job -ScriptBlock {
        param($psql, $database, $schema, $script, $stdoutPath, $stderrPath, $appName)
        $env:PGAPPNAME = $appName
        & $psql -X -w -v ON_ERROR_STOP=1 -d $database -v "w5_schema=$schema" `
            -f $script 1> $stdoutPath 2> $stderrPath
        return $LASTEXITCODE
    } -ArgumentList $psqlExe, $Database, $Schema, $sessionA, $outA, $errA, "$appName`_A"

    $env:PGAPPNAME = "$appName`_B"
    $jobB = Start-Job -ScriptBlock {
        param($psql, $database, $schema, $script, $stdoutPath, $stderrPath, $appName)
        $env:PGAPPNAME = $appName
        & $psql -X -w -v ON_ERROR_STOP=1 -d $database -v "w5_schema=$schema" `
            -f $script 1> $stdoutPath 2> $stderrPath
        return $LASTEXITCODE
    } -ArgumentList $psqlExe, $Database, $Schema, $sessionB, $outB, $errB, "$appName`_B"

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

    Write-Host "W5 concurrency: session A exit=$rcA, session B exit=$rcB"
    if ($rcA -ne 0 -or $rcB -ne 0) {
        throw "session failure: A=$rcA B=$rcB (logs: $outA / $errA / $outB / $errB)"
    }

    Write-Host "W5 concurrency: verify"
    $env:PGAPPNAME = "$appName`_verify"
    & $psqlExe -X -w -v ON_ERROR_STOP=1 -d $Database -v "w5_schema=$Schema" -L $verifyLog -f $verifyScript
    if ($LASTEXITCODE -ne 0) {
        throw "verification psql exited with $LASTEXITCODE (log: $verifyLog)"
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
        $residual = & $psqlExe -X -w -t -A -v ON_ERROR_STOP=1 -d $Database `
            -c "SELECT count(*) FROM pg_namespace WHERE nspname = '$Schema';"
        $residual = (@($residual) -join '').Trim()
    }
    catch {
        $residual = 'unknown'
    }

    foreach ($job in @($jobA, $jobB)) {
        if ($job) { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
    }
}

Write-Host "W5 concurrency schema: $Schema"
Write-Host "W5 concurrency logs: $LogDir\$prefix.*"
Write-Host "W5 concurrency residual schema: $residual"
Write-Host "W5 concurrency exit code: $exitCode"

if ($exitCode -eq 0 -and $residual -ne '0') { exit 1 }
exit $exitCode
