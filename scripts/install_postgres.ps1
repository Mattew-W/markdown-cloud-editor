# PostgreSQL 17 静默安装脚本（装到 D 盘）
#
# 依据规范 §03（数据库固定 PostgreSQL 17 系列）与 §11（本地与 CI 一致）。
# 幂等：已安装则直接退出。
#
# 用法：
#   pwsh -NoProfile -File scripts\install_postgres.ps1
#   pwsh -NoProfile -File scripts\install_postgres.ps1 -SuperPassword "你的密码"

param(
    # 超级用户密码。留空则随机生成并打印（仅本机开发用）。
    [string]$SuperPassword = '',

    # 安装前缀（装到 D 盘）
    [string]$Prefix = 'D:\PostgreSQL\17',

    # 数据目录
    [string]$DataDir = 'D:\PostgreSQL\17\data',

    # 端口
    [int]$Port = 5432,

    # Windows 服务名
    [string]$ServiceName = 'postgresql-x64-17',

    # 安装包路径
    [string]$Installer = 'D:\installers\postgresql-17.11-5-windows-x64.exe'
)

$ErrorActionPreference = 'Stop'

# ---------- 0. 前置检查 ----------
$psql = Join-Path $Prefix 'bin\psql.exe'
if (Test-Path $psql) {
    Write-Host "PostgreSQL 已安装在 $Prefix，跳过安装。" -ForegroundColor Green
    & $psql --version
    exit 0
}

if (-not (Test-Path $Installer)) {
    Write-Host "找不到安装包：$Installer" -ForegroundColor Red
    Write-Host "请先下载 PostgreSQL 17.11 Windows x64 安装包到该路径。" -ForegroundColor Yellow
    exit 1
}

# 目标盘剩余空间检查（安装 + 初始化约需 1.5 GB）
$drive = (Split-Path $Prefix -Qualifier).TrimEnd(':')
$freeGB = [math]::Round((Get-PSDrive $drive).Free / 1GB, 1)
Write-Host "$drive 盘剩余 $freeGB GB"
if ($freeGB -lt 3) {
    Write-Host "空间不足，至少需要 3 GB。" -ForegroundColor Red
    exit 1
}

# ---------- 1. 生成密码 ----------
if ([string]::IsNullOrWhiteSpace($SuperPassword)) {
    # 本机开发用：生成 24 字节随机 base64，不打印明文，只提示重新生成的方式。
    $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)
    $SuperPassword = [Convert]::ToBase64String($bytes).Replace('+','A').Replace('/','B').Replace('=','')
    Write-Host "未提供密码，已自动生成 24 字节随机密码。" -ForegroundColor Yellow
    Write-Host "该密码只写入本机 .env，不会提交到仓库。" -ForegroundColor Yellow
}

# ---------- 2. 静默安装 ----------
# EDB 安装包是 BitRock InstallBuilder，参数为：
#   --mode unattended            静默模式
#   --prefix                     安装目录
#   --datadir                    数据目录
#   --superpassword              超级用户密码
#   --serverport                 端口
#   --servicename                服务名
#   --disable-components         跳过 Stack Builder 界面
$args = @(
    '--mode', 'unattended',
    '--prefix', $Prefix,
    '--datadir', $DataDir,
    '--superpassword', $SuperPassword,
    '--serverport', $Port,
    '--servicename', $ServiceName,
    '--disable-components', 'stackbuilder'
)

Write-Host "开始安装 PostgreSQL 17 到 $Prefix ..." -ForegroundColor Cyan
Write-Host "这会写入 Windows 服务注册项，约需 2–4 分钟。" -ForegroundColor Yellow

$proc = Start-Process -FilePath $Installer -ArgumentList $args -Wait -PassThru
Write-Host "安装程序退出码：$($proc.ExitCode)"

if ($proc.ExitCode -ne 0) {
    Write-Host "安装失败。退出码 $($proc.ExitCode)" -ForegroundColor Red
    Write-Host "可改用图形界面手动安装：" -ForegroundColor Yellow
    Write-Host "  $Installer" -ForegroundColor Yellow
    Write-Host "目标目录填 $Prefix，数据目录填 $DataDir" -ForegroundColor Yellow
    exit $proc.ExitCode
}

# ---------- 3. 验证 ----------
if (-not (Test-Path $psql)) {
    Write-Host "安装程序已退出，但未找到 $psql。请检查安装是否真的完成。" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "安装完成：" -ForegroundColor Green
& $psql --version
Write-Host "安装目录：$Prefix"
Write-Host "数据目录：$DataDir"
Write-Host "服务名：  $ServiceName"
Write-Host "端口：    $Port"

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "服务状态：$($svc.Status)"
} else {
    Write-Host "警告：未找到服务 $ServiceName，可用 pg_ctl 手动启动。" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "下一步：把密码写入项目 .env 的 DATABASE_URL（该文件不会提交）。" -ForegroundColor Cyan
exit 0
