# 本地 PostgreSQL 17 环境说明
#
# 依据：项目规范 §03（数据库固定 PostgreSQL 17 系列）、
#       §11（本地与 CI 一致，不得借用开发者数据库）、
#       §12（最终验收必须连接真实后端和数据库）。
#
# 本机安装位置：D:\PostgreSQL\17
# 数据目录：    D:\PostgreSQL\17\data
# 服务名：      postgresql-x64-17
# 端口：        5432
#
# 【本文件不含任何密码】。实际连接串写入项目根目录的 .env（已被 .gitignore 排除）。

## 一、安装方式

用 PostgreSQL 官方 Windows 安装包（EDB 提供）静默安装：

```powershell
D:\installers\postgresql-17.11-5-windows-x64.exe `
    --mode unattended `
    --prefix "D:\PostgreSQL\17" `
    --datadir "D:\PostgreSQL\17\data" `
    --superpassword "<见 .env>" `
    --serverport 5432 `
    --servicename "postgresql-x64-17"
```

版本 **17.11** 对应规范要求的「17 系列当前受支持的补丁版本」。

## 二、为何必须装（不可用 mock 代替）

规范三处明确要求：

| 出处 | 原文 |
|---|---|
| §03 技术选型表 | 数据库 = **PostgreSQL 17 系列**，要求「本地与 CI 一致」 |
| §11 CI | 「缺少 Cargo.toml、**测试服务不可用**或必需脚本未配置应明确失败，不报告为通过」 |
| §12 验收 | 「前端可按契约 mock 并行开发，但**最终验收必须连接真实后端和数据库**」 |

因此 `migrations/0001_init.sql` 必须在真实 PG 上执行过，
`tests/health_api.rs` 中标记 `#[ignore]` 的健康检查 200 用例才能真正运行。

## 三、日常操作

### 启动 / 停止服务

```powershell
# 启动（服务已注册，通常开机自启）
Start-Service postgresql-x64-17

# 停止
Stop-Service postgresql-x64-17

# 查看状态
Get-Service postgresql-x64-17
```

若未注册为服务，用 `pg_ctl`：

```powershell
& "D:\PostgreSQL\17\bin\pg_ctl.exe" -D "D:\PostgreSQL\17\data" start
& "D:\PostgreSQL\17\bin\pg_ctl.exe" -D "D:\PostgreSQL\17\data" stop
```

### psql 需手动加 PATH

安装程序默认把 `bin` 加进系统 PATH，但**当前会话**可能未刷新。
本会话内可直接用绝对路径：

```powershell
& "D:\PostgreSQL\17\bin\psql.exe" -U postgres -c "SELECT version();"
```

### 连接串格式

```
postgres://postgres:<密码>@127.0.0.1:5432/mce
```

写入项目根目录 `.env` 的 `DATABASE_URL`。**该文件不会被提交。**

## 四、迁移执行

迁移文件位于 `migrations/0001_init.sql`。用 psql 执行：

```powershell
& "D:\PostgreSQL\17\bin\psql.exe" -U postgres -c "CREATE DATABASE mce;"
& "D:\PostgreSQL\17\bin\psql.exe" -U postgres -d mce -f "D:\WORKbuddy1\RUST\migrations\0001_init.sql"
```

> 注：`sqlx migrate run` 亦可，但需把文件改名为 `20260101000000_init.sql`
> 形式（sqlx 使用时间戳命名）。本项目规范 §07 要求**递增编号**制
> （`0001_init.sql`），故默认用 psql 手工执行以保持命名一致。

## 五、测试数据库

规范 §11 要求「SQLx 的准备、迁移和测试指向同一测试 schema；并行任务隔离数据」。

集成测试通过 `TEST_DATABASE_URL` 指定独立库：

```
postgres://postgres:<密码>@127.0.0.1:5432/mce_test
```

运行需真实数据库的用例：

```powershell
$env:TEST_DATABASE_URL = "postgres://postgres:<密码>@127.0.0.1:5432/mce_test"
cargo test --locked --all-targets -- --ignored
```

## 六、版本一致性

| 环境 | 版本 | 方式 |
|---|---|---|
| 本机 | PostgreSQL 17.11（Windows 原生） | `D:\PostgreSQL\17` |
| CI | `postgres:17` 服务容器 | GitHub Actions |

两者同为 17 系列。若将来怀疑行为差异，以本机为准排查，
但**规范要求版本一致**，升级任一方都要开 PR 说明。

## 七、卸载（如需）

```powershell
# 用官方卸载程序，勿直接删目录（会留下服务注册项）
& "D:\PostgreSQL\17\uninstall-postgresql.exe"
```
