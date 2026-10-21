# 开发用命令速查（分层）
#
# 核心原则：**日常不要跑 cargo build**。
#   cargo check 只做类型分析，不生成机器码，比 build 快约 5 倍。
#   cargo build 只在真正要产出 exe 时才需要。
#
# 本机实测耗时（增量，改一行文件后）：
#   cargo check    1.9s
#   cargo clippy   3.8s
#   cargo build   10.6s
#   cargo test    19.5s

$ErrorActionPreference = 'Continue'

# MinGW-w64（WinLibs）—— 提供 as.exe / dlltool.exe。
# rustup 自带的 rust-mingw 组件缺 as.exe，会导致 windows-sys 编译失败。
$winlibs = 'C:\Users\huang\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.MCF.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin'
if (Test-Path $winlibs) { $env:PATH = "$winlibs;$env:PATH" }

Set-Location 'D:\WORKbuddy1\RUST'

# 环境变量：Git 的 safe.directory 限制（仅本会话有效，不改全局配置）
$env:GIT_CONFIG_COUNT = 1
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = 'D:/WORKbuddy1/RUST'

# 警告：不要用 New-Item -Force 或 touch 去"改文件时间戳"，
# 那会**清空文件内容**。PowerShell 的 New-Item -Force 会覆盖已有文件。
# 要模拟改动就直接跑命令，或用 (Get-Item x).LastWriteTime = Get-Date。

# ---------------- 日常：这两个就够了 ----------------

if ($args -contains 'check') {
    Write-Host '=== cargo check：类型与借用检查（日常主力）===' -ForegroundColor Cyan
    cargo check
    exit $LASTEXITCODE
}

if ($args -contains 'test') {
    Write-Host '=== cargo test：跑测试 ===' -ForegroundColor Cyan
    # --all-targets 必须带：否则 lib 里的单测会被静默跳过，退出码仍是 0
    cargo test --locked --all-targets
    exit $LASTEXITCODE
}

if ($args -contains 'clippy') {
    Write-Host '=== cargo clippy：静态缺陷 ===' -ForegroundColor Cyan
    cargo clippy --locked --all-targets -- -D warnings
    exit $LASTEXITCODE
}

if ($args -contains 'build') {
    Write-Host '=== cargo build：产出 exe（日常不需要）===' -ForegroundColor Yellow
    cargo build
    exit $LASTEXITCODE
}

if ($args -contains 'test-db') {
    Write-Host '=== 需要真实数据库的测试 ===' -ForegroundColor Yellow
    # 规范 §12：最终验收必须连接真实后端和数据库，mock 不可替代。
    # 因此 TEST_DATABASE_URL 缺失时**直接失败**，不静默跳过。
    if (-not $env:TEST_DATABASE_URL) {
        Write-Host 'TEST_DATABASE_URL 未设置。' -ForegroundColor Red
        Write-Host '该类用例按规范 §11/§12 标记为明确失败，不会静默跳过。' -ForegroundColor Red
        Write-Host '设置方法见 docs/LOCAL_POSTGRES.md 第五节。' -ForegroundColor Red
        exit 78
    }
    cargo test --locked --all-targets -- --ignored
    exit $LASTEXITCODE
}

# ---------------- 提交前：规范 §11 四条全跑 ----------------

if ($args -contains 'all' -or $args.Count -eq 0) {
    Write-Host '=== 规范 §11 四条必检（提交前跑这个）===' -ForegroundColor Cyan
    & "$PSScriptRoot\check.ps1"
    exit $LASTEXITCODE
}

Write-Host '未知参数。可用：check | test | clippy | build | test-db | all'
exit 2
