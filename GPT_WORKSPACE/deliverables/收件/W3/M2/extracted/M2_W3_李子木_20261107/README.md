# Markdown Cloud Editor

Rust、PostgreSQL 与原生网页前端组成的云同步 Markdown 编辑器课程项目。

## 当前状态

仓库已包含 Rust API 基线、用户注册与登录、Argon2id 密码哈希、JWT 认证、PostgreSQL 迁移，以及前端本地草稿模块。文档 CRUD API、乐观锁写入、云端自动同步和完整编辑器界面仍在开发中；本仓库目前不是可直接部署的完整产品。

| 已实现 | 进行中 |
|---|---|
| Actix Web 服务与健康检查 | documents CRUD API |
| 注册、登录与身份认证 | 版本冲突与并发保存 |
| PostgreSQL 初始化迁移与约束验证 | 自动保存状态机与云端同步 |
| 前端草稿存储模块及单元测试 | 完整编辑器 UI 和端到端验收 |

具体接口约束和实现进度以 [API 契约](docs/API.md)、[数据库契约](docs/DATABASE.md) 和 [项目规范](docs/PROJECT_SPEC.md) 为准。

## 快速开始

### 环境要求

- Cargo.toml 指定的 Rust 工具链
- PostgreSQL 17
- Node.js（运行前端模块检查）

### 启动 API

1. 复制 .env.example 为 .env。
2. 设置 DATABASE_URL，并将 JWT_SECRET 换成至少 32 字节的随机值。
3. 创建本地数据库并按 [PostgreSQL 开发说明](docs/LOCAL_POSTGRES.md) 应用迁移。
4. 在仓库根目录启动：

        cargo run --locked

默认地址为 http://127.0.0.1:8080。

### 本地检查

    cargo fmt --check
    cargo clippy --locked --all-targets -- -D warnings
    cargo test --locked --all-targets
    cargo doc --locked --no-deps
    node --test frontend/js/tests/drafts.test.js

数据库集成测试需要专用的 PostgreSQL 17 测试库和 TEST_DATABASE_URL：

    cargo test --locked --all-targets -- --ignored

## W1 归档状态

M1–M6 的 W1 归档索引在 [课程交件目录](GPT_WORKSPACE/deliverables/收件/W1/README.md)。目前已明确归档阶段汇报、收件件、审核结果和返工参考；新增公开副本中的个人身份信息和本机路径已脱敏。M1 汇报是历史快照，M2 收件时 SQL 未执行，M4 审核指出必做练习尚未完成，不能据此误读为六个模块均已通过。

## 主要目录

| 路径 | 内容 |
|---|---|
| src/ | Rust API、认证、错误处理、仓储与路由 |
| frontend/js/ | 前端草稿模块及单元测试 |
| migrations/ | PostgreSQL schema 与验证脚本 |
| tests/ | API 和数据库集成测试 |
| docs/ | 项目定义、接口契约、架构和开发环境说明 |
| GPT_WORKSPACE/deliverables/ | 课程任务、收件、审核与返工归档 |

## 协作方式

从最新 main 创建 feature/、fix/ 或 docs/ 分支，通过 Pull Request 合并；不要直接推送到 main。详细要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

# M2 W3 — 迁移与约束的可复现回归

> 本节由 M2 新增；上面的 baseline README 内容保持不变。

## 基线

- 基线：包内 `baseline/`，Git main 提交 `42e9e7fce4a76f41e69ee33f6f208383e8e04f44` 的快照。
- W2 已交的 `migrations/checks/{fixtures.sql,verify_constraints.sql,run_checks.sql}` 保留原样，未修改。
- W2 的 11 例由 M1 在 PostgreSQL 17.11 实测通过；**这不是本人执行**。W3 不复用 W2 夹具，也不把 M1 的实测写成本人结果。
- W3 的代码/测试新增内容只在 `migrations/checks/w3/`；另新增 W3 文档、日志和差异文件。
  `migrations/0001_init.sql`、`migrations/checks/` 下原有 W2 脚本、`src/`、`frontend/`、`tests/` 均未改动。

## 新增文件

| 文件 | 用途 |
| --- | --- |
| `migrations/checks/w3/regression.sql` | 隔离 schema 内的断言式 W3 回归；自行 `BEGIN/ROLLBACK` |
| `migrations/checks/w3/run_w3_regression.sql` | psql 入口：创建临时 schema、加载冻结迁移、执行回归、删除 schema |
| `migrations/checks/w3/run_w3_regression.ps1` | 推荐入口：生成唯一 `t_w3_*` schema，失败时也清理 |
| `migrations/checks/w3/negative_control/regression_wrong_expected.sql` | 故意把不存在 owner 的预期码改成 `23505` 的副本 |
| `migrations/checks/w3/negative_control/run_w3_negative_control.sql` | 负向对照入口 |
| `migrations/checks/w3/negative_control/DIFF.txt` | 负向副本与主脚本的差异，只有预期码两行 |
| `W3_CHANGES.diff` | 本工作副本相对 baseline 的完整差异 |
| `W3_FILES.txt` | 新增/修改文件清单与 SHA256 |
| `检查记录.md` | 环境检查、静态检查、11 例复述、W3 逐项输入/预期/实际/断言 |
| `交付说明.txt` | 身份、AI 工具、完成/未完成、本人与 AI 分工 |
| `logs/00_environment.txt` | 本机环境检查的真实原始记录；SQL 未执行 |

## W3 回归用例（最低要求）

| 编号 | 输入/动作 | 预期 |
| --- | --- | --- |
| W3-1 | 两个合法 UUID 用户分别插入一篇同名标题文档 | 两行都成功，行数 2、不同 owner 数 2 |
| W3-2 | 插入 owner 为合法但不存在的 UUID `99999999-9999-4999-8999-999999999999` | SQLSTATE `23503` |
| W3-3 | 标题 255 字符 | INSERT 成功，`char_length = 255` |
| W3-4 | 标题 256 字符 | SQLSTATE `22001`（VARCHAR 长度错误，非 CHECK） |
| W3-5 | 正文 `repeat('中',87381)||'a'`（262144 UTF-8 字节） | INSERT 成功，`octet_length = 262144` |
| W3-6 | 正文 262145 字节 | SQLSTATE `23514` |
| W3-7 | `version = 0` | SQLSTATE `23514` |
| W3-8 | 前后行数 | 隔离 schema 的 `users`/`documents` 均为 0，前后一致 |
| W3-9 | 负向对照：预期码改成 `23505` | 实际 `23503` 与预期不符，脚本非零退出 |

## 运行依赖

- PostgreSQL 17 系列；`psql` 在 `PATH`。
- PowerShell 5.1+（仅推荐入口需要；也可直接用 psql）。
- 一个**独立、空的练习数据库**，编码 UTF-8；不要使用个人、共享或正式数据库。
- W3 只做 SQL；不需要 Node.js、Rust 或网络。

## 运行

在项目根目录（本工作副本）执行：

```powershell
.\migrations\checks\w3\run_w3_regression.ps1 -Database <练习库名>
```

入口会：

1. 生成唯一临时 schema（默认 `t_w3_<时间>_<PID>`）；
2. 在该 schema 上加载 `migrations/0001_init.sql`（原文件，不改）；
3. 执行 `regression.sql`；
4. 回归内部 `BEGIN/ROLLBACK`，并在回滚后检查 `users`/`documents` 均为 0；
5. 删除临时 schema（失败也会在 `finally` 中清理）；
6. 把 psql 原始输出写入 `logs/w3_regression_*.log`。

预期成功输出包含各 `PASS` 通知、`ALL W3 REGRESSION CHECKS PASSED`、
`PASS [post-rollback counts]: users=0, documents=0`、`W3 regression: DONE`，
退出码为 0。

也可以直接用 psql（失败时可能留下临时 schema，需手动清理）：

```powershell
psql -X -v ON_ERROR_STOP=1 -d <练习库名> -v w3_schema=t_w3_manual -f migrations/checks/w3/run_w3_regression.sql
```

`-Database` 可以传数据库名或 libpq 连接串；凭据放在 `pgpass`/`PGPASSWORD` 等本地
环境中，不要写进脚本、README 或仓库。

若直接 psql 失败留下 `t_w3_*` schema，可用基线已有的清理脚本：

```powershell
psql -X -v ON_ERROR_STOP=1 -d <练习库名> -f migrations/cleanup_test_schemas.sql
```

## 负向对照（证明断言不是空壳）

```powershell
.\migrations\checks\w3\run_w3_regression.ps1 -Database <练习库名> -Entry negative_control\run_w3_negative_control.sql
```

该入口加载的副本只把 W3-2 的预期码从 `23503` 改成 `23505`；实际仍得到 `23503`，
因此脚本会 `RAISE EXCEPTION` 并以非零状态退出。**非零退出是预期结果**，
不是主回归失败；不要把负向对照当作验收通过。

## 运行状态

- 本机没有 `psql`、PostgreSQL 服务或 Docker；W3 的所有 SQL 均**未执行**。
- `logs/00_environment.txt` 是真实环境检查日志，不是 SQL 执行日志。
- 没有实际 SQLSTATE、没有可重复性结论、没有行数残留的实测结论。
- 没有验证 API 层的 owner 隔离、并发保存/409、HTTP 或 Rust 服务；本 W3 只验证数据库约束。

## W2 解释纠偏

- 整数 `99999` 不是合法 UUID，不能用来测外键。对 UUID 列**赋值**时是类型不匹配
  （常见 `42804`）；用于**比较**时具体错误码取决于语句（常见 `42883`：没有
  `uuid = integer` 运算符）。字符串 `'99999'` 才会进入 UUID 输入函数并报 `22P02`。
- 只有语法合法但未插入 `users` 的 UUID（如 `99999999-9999-4999-8999-999999999999`）
  才会触发外键检查并得到 `23503`。
- 具体以实际 SQL 语句和本机输出为准；本次没有 PostgreSQL，未实测。

## 不覆盖的范围

- 数据库外键只保证 owner 存在，不保证 API 的 owner 隔离；后者必须在 repository
  查询中限定 `owner_id`，本 W3 不验证。
- 不验证乐观锁并发更新、`VERSION_CONFLICT`/409、HTTP 状态码或自动保存状态机。
- 不声称已覆盖完整 Unicode 空白；schema 的显式空白列表仍是兜底，应用层
  `char::is_whitespace()` 才是完整判定。

## 差异与完整性

- `W3_CHANGES.diff` 显示本工作副本相对 baseline 的源码/文档改动；预期只新增
  `migrations/checks/w3/`、W3 文档和本 README 的追加段。该 diff 不包含
  `W3_FILES.txt` 和 diff 自身（它们是交付时生成的索引文件）。
- `W3_FILES.txt` 列出新增/修改文件及 SHA256；可据此复核。
- 不包含 `.env`、真实密钥、`.git`、`target`、`node_modules` 或个人数据库。
