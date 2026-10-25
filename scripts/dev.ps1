param(
    [ValidateSet('check', 'test', 'clippy', 'build', 'test-db', 'all')]
    [string]$Mode = 'all'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

if ($env:MCE_MINGW_BIN) {
    if (-not (Test-Path -LiteralPath $env:MCE_MINGW_BIN -PathType Container)) {
        throw "MCE_MINGW_BIN does not exist: $env:MCE_MINGW_BIN"
    }
    $env:PATH = "$($env:MCE_MINGW_BIN)$([IO.Path]::PathSeparator)$env:PATH"
}

if ($env:MCE_CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR = $env:MCE_CARGO_TARGET_DIR
}

switch ($Mode) {
    'check' {
        cargo check --locked
        exit $LASTEXITCODE
    }
    'test' {
        cargo test --locked --all-targets
        exit $LASTEXITCODE
    }
    'clippy' {
        cargo clippy --locked --all-targets -- -D warnings
        exit $LASTEXITCODE
    }
    'build' {
        cargo build --locked
        exit $LASTEXITCODE
    }
    'test-db' {
        if (-not $env:TEST_DATABASE_URL) {
            Write-Error 'Set TEST_DATABASE_URL to a dedicated PostgreSQL 17 test database first.'
            exit 78
        }
        cargo test --locked --all-targets -- --ignored
        exit $LASTEXITCODE
    }
    'all' {
        & (Join-Path $PSScriptRoot 'check.ps1')
        exit $LASTEXITCODE
    }
}
