# M2 W5 limited-concurrency rounds runner (M2-W5-03).
# Runs a fixed number of rounds; each round starts one writer and one reader
# psql process concurrently against the same isolated schema, then verifies
# row counts, SQLSTATEs, final version/content and timing sample.
#
#   .\run_w5_rounds.ps1 -Database mce_w5_practice -Rounds 20
#
# Use pgpass/PGPASSWORD for credentials; do not put secrets in this file.

param(
    [Parameter(Mandatory = $true)]
    [string]$Database,

    [int]$Rounds = 20,

    [string]$Psql = 'psql',

    [string]$Schema = '',

    [string]$LogDir = '',

    [int]$RoundTimeoutSeconds = 60
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

if ($Rounds -lt 1 -or $Rounds -gt 200) {
    Write-Host "ERROR: Rounds must be 1..200, got $Rounds"
    exit 2
}

if ([string]::IsNullOrWhiteSpace($Schema)) {
    $Schema = "t_w5_r_${stamp}_$PID"
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

$prefix = "w5_rounds_${stamp}_$PID"
$setupLog = Join-Path $LogDir "$prefix.setup.log"
$verifyLog = Join-Path $LogDir "$prefix.verify.log"
$csvFile = Join-Path $LogDir "$prefix.rounds.csv"
$setupScript = Join-Path $scriptDir 'run_rounds_setup.sql'
$writerScript = Join-Path $scriptDir 'round_writer.sql'
$readerScript = Join-Path $scriptDir 'round_reader.sql'
$verifyScript = Join-Path $scriptDir 'rounds_verify.sql'

$exitCode = 0
$failedRound = 0
$residual = ''

try {
    Write-Host "W5 rounds: setup schema $Schema"
    & $psqlExe -X -w -v ON_ERROR_STOP=1 -d $Database -v "w5_schema=$Schema" -L $setupLog -f $setupScript
    if ($LASTEXITCODE -ne 0) { throw "setup psql exited with $LASTEXITCODE (log: $setupLog)" }

    "round,writer_exit,reader_exit,writer_log,reader_log" | Out-File -LiteralPath $csvFile -Encoding utf8

    for ($i = 1; $i -le $Rounds; $i++) {
        $wOut = Join-Path $LogDir ("{0}.round{1:000}.writer.stdout.txt" -f $prefix, $i)
        $wErr = Join-Path $LogDir ("{0}.round{1:000}.writer.stderr.txt" -f $prefix, $i)
        $rOut = Join-Path $LogDir ("{0}.round{1:000}.reader.stdout.txt" -f $prefix, $i)
        $rErr = Join-Path $LogDir ("{0}.round{1:000}.reader.stderr.txt" -f $prefix, $i)

        $jobW = Start-Job -ScriptBlock {
            param($psql, $db, $schema, $script, $round, $out, $err)
            & $psql -X -w -v ON_ERROR_STOP=1 -d $db -v "w5_schema=$schema" -v "round_no=$round" `
                -f $script 1> $out 2> $err
            return $LASTEXITCODE
        } -ArgumentList $psqlExe, $Database, $Schema, $writerScript, $i, $wOut, $wErr

        $jobR = Start-Job -ScriptBlock {
            param($psql, $db, $schema, $script, $round, $out, $err)
            & $psql -X -w -v ON_ERROR_STOP=1 -d $db -v "w5_schema=$schema" -v "round_no=$round" `
                -f $script 1> $out 2> $err
            return $LASTEXITCODE
        } -ArgumentList $psqlExe, $Database, $Schema, $readerScript, $i, $rOut, $rErr

        Wait-Job -Job @($jobW, $jobR) -Timeout $RoundTimeoutSeconds | Out-Null
        $pending = @($jobW, $jobR) | Where-Object { $_.State -ne 'Completed' }
        if ($pending.Count -gt 0) {
            $pending | Stop-Job -ErrorAction SilentlyContinue
            throw "round $i did not complete within $RoundTimeoutSeconds seconds"
        }

        $rw = Receive-Job -Job $jobW -ErrorAction SilentlyContinue
        $rr = Receive-Job -Job $jobR -ErrorAction SilentlyContinue
        $rcW = if ($null -eq $rw) { 1 } else { [int](@($rw)[-1]) }
        $rcR = if ($null -eq $rr) { 1 } else { [int](@($rr)[-1]) }

        Remove-Job -Job $jobW -Force -ErrorAction SilentlyContinue
        Remove-Job -Job $jobR -Force -ErrorAction SilentlyContinue

        "$i,$rcW,$rcR,$wOut,$rOut" | Out-File -LiteralPath $csvFile -Append -Encoding utf8

        if ($rcW -ne 0 -or $rcR -ne 0) {
            $failedRound = $i
            throw "round $i failed: writer=$rcW reader=$rcR (logs: $wOut / $rOut)"
        }
    }

    Write-Host "W5 rounds: verify"
    & $psqlExe -X -w -v ON_ERROR_STOP=1 -d $Database -v "w5_schema=$Schema" -L $verifyLog -f $verifyScript
    if ($LASTEXITCODE -ne 0) { throw "verify psql exited with $LASTEXITCODE (log: $verifyLog)" }
}
catch {
    Write-Host "ERROR: $_"
    if ($failedRound -gt 0) { Write-Host "W5 rounds: first failed round = $failedRound" }
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
}

Write-Host "W5 rounds schema: $Schema"
Write-Host "W5 rounds requested: $Rounds"
Write-Host "W5 rounds csv: $csvFile"
Write-Host "W5 rounds verify log: $verifyLog"
Write-Host "W5 rounds residual schema: $residual"
Write-Host "W5 rounds exit code: $exitCode"

if ($exitCode -eq 0 -and $residual -ne '0') { exit 1 }
exit $exitCode
