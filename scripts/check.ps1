# 阶段 1 四条必检命令的真实执行脚本
#
# 关键：必须在管道**之前**捕获 $LASTEXITCODE。
# `cargo build 2>&1 | Out-File log` 之后再读 $LASTEXITCODE 拿到的是
# Out-File 的退出码（恒为 0），会把失败误报成通过。
#
# 用法：pwsh -NoProfile -File scripts/check.ps1

$ErrorActionPreference = 'Continue'

# MinGW-w64（WinLibs）——提供 as.exe / dlltool.exe，rustup 自带的 rust-mingw 组件缺 as.exe
$winlibs = 'C:\Users\huang\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.MCF.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin'
if (Test-Path $winlibs) { $env:PATH = "$winlibs;$env:PATH" }

Set-Location 'D:\WORKbuddy1\RUST'
$results = @()

function Invoke-Check {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "--- $Name ---"
    $log = "D:\rustbuild\check-$($Name -replace '[^a-zA-Z0-9]','_').log"
    & $Action 2>&1 | Out-File -LiteralPath $log -Encoding utf8
    $code = $LASTEXITCODE
    Write-Host "  退出码: $code   日志: $log"
    $script:results += [pscustomobject]@{ 检查项 = $Name; 退出码 = $code }
    return $code
}

Invoke-Check 'cargo-fmt'      { cargo fmt --check } | Out-Null
Invoke-Check 'cargo-clippy'   { cargo clippy --locked --all-targets -- -D warnings } | Out-Null
Invoke-Check 'cargo-test'     { cargo test --locked --all-targets } | Out-Null

$env:RUSTDOCFLAGS = '-D warnings'
Invoke-Check 'cargo-doc'      { cargo doc --locked --no-deps } | Out-Null

Write-Host ''
Write-Host '================ 汇总 ================'
$results | Format-Table -AutoSize
$failed = @($results | Where-Object { $_.退出码 -ne 0 })
if ($failed.Count -eq 0) {
    Write-Host '全部通过'
    exit 0
} else {
    Write-Host "失败 $($failed.Count) 项"
    exit 1
}
