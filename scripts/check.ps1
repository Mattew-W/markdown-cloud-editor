$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Error 'Cargo was not found. Install the Rust toolchain and ensure cargo is on PATH.'
    exit 127
}

if ($env:MCE_MINGW_BIN) {
    if (-not (Test-Path -LiteralPath $env:MCE_MINGW_BIN -PathType Container)) {
        Write-Error "MCE_MINGW_BIN does not exist: $env:MCE_MINGW_BIN"
        exit 2
    }
    $env:PATH = "$($env:MCE_MINGW_BIN)$([IO.Path]::PathSeparator)$env:PATH"
}

if ($env:MCE_CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR = $env:MCE_CARGO_TARGET_DIR
}

$results = @()

function Invoke-Check {
    param(
        [string]$Name,
        [scriptblock]$Action
    )

    Write-Host "--- $Name ---"
    & $Action
    $code = $LASTEXITCODE
    Write-Host "  exit code: $code"
    $script:results += [pscustomobject]@{ Check = $Name; ExitCode = $code }
}

Invoke-Check 'cargo fmt --check' { cargo fmt --check }
Invoke-Check 'cargo clippy' { cargo clippy --locked --all-targets -- -D warnings }
Invoke-Check 'cargo test' { cargo test --locked --all-targets }

$previousRustdocFlags = $env:RUSTDOCFLAGS
$env:RUSTDOCFLAGS = '-D warnings'
Invoke-Check 'cargo doc' { cargo doc --locked --no-deps }
$env:RUSTDOCFLAGS = $previousRustdocFlags

Write-Host ''
$results | Format-Table -AutoSize
$failed = @($results | Where-Object { $_.ExitCode -ne 0 })
if ($failed.Count -eq 0) {
    Write-Host 'All checks passed.'
    exit 0
}

Write-Host "$($failed.Count) check(s) failed."
exit 1
