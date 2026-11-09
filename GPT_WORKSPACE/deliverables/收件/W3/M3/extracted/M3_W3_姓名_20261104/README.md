# M3 W3 交件 — `auth/password.rs` / `auth/token.rs` 边界与错误分类回归

| 项 | 值 |
| --- | --- |
| 基线 | main 提交 `42e9e7fce4a76f41e69ee33f6f208383e8e04f44`（包内 `baseline/` 快照） |
| 本人职责范围 | `src/auth/password.rs`、`src/auth/token.rs` 的认证纯逻辑与单元测试 |
| 实际改动文件 | `src/auth/password.rs`、`src/auth/token.rs`（仅此两个，见 `差异/`） |
| 交件日期 | 2026-11-04 |
| 依据 | `docs/INTERFACES.md` §1.2/§1.3、`docs/API.md` §7、`src/config.rs`（TTL/密钥约束） |

## 目录结构

```
M3_W3_姓名_20261104/
├── 源码/          完整可构建工程（= 基线 + 本次改动），已剔除 target/、.cargo/、.git/、.env
│   ├── src/auth/password.rs    改动文件 1
│   ├── src/auth/token.rs       改动文件 2
│   ├── tests/                  基线集成测试（auth_db.rs、health_api.rs，需真实 PostgreSQL）
│   └── docs/                   基线文档（INTERFACES.md、API.md 等，未改）
├── 差异/
│   ├── password_rs.diff        对基线的逐行差异
│   └── token_rs.diff
├── 日志/                       每条命令的真实输出，文件末尾带 exit_code 行
├── README.md                   本文件
├── 检查记录.md                 逐项「动作 / 输出 / 断言」+ 覆盖矩阵 + 未执行清单
└── 交付说明.txt                身份、完成情况、本人操作与 AI 操作的分工
```

## 如何运行

前置：Rust 1.99（`Cargo.toml` 的 `rust-version = "1.99"`、edition 2024）。本次在 Windows 11 + `x86_64-pc-windows-msvc` 实跑。

```powershell
cd 源码
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

三条命令本次实测均为 exit 0（见 `日志/01_fmt_check.txt`、`日志/02_cargo_test_all.txt`、`日志/04_clippy.txt`）。

不需要数据库的部分全部实跑：86 个单元测试 + `health_api.rs` 中 6 个。需要真实 PostgreSQL 的 9 个用例在基线里已标 `#[ignore]`，本机无数据库，未执行——原因与复现步骤见 `检查记录.md` 的「未执行清单」。

如需跑数据库用例：

```powershell
$env:TEST_DATABASE_URL = "postgres://用户名:口令@127.0.0.1:5432/测试库名"
cd 源码
cargo test --locked -- --ignored
```

## 依赖

`Cargo.toml` / `Cargo.lock` 未改动，**没有新增任何 crate**。新增用例只用了工程已有依赖：

- `jsonwebtoken` 9、`chrono` 0.4、`serde`/`serde_json` —— token 用例构造「签名正确但字段缺失 / 算法不同」的载荷；
- `base64` 0.22（基线 `[dev-dependencies]` 已有）—— 基线自带的伪造 token 用例使用；
- `argon2` 0.5（运行期依赖）—— password 用例构造 `argon2i` / `argon2d` / `v16` 的真实哈希作对照。

运行期依赖（未变）：`actix-web` 4.11、`sqlx` 0.8、`argon2` 0.5、`jsonwebtoken` 9、`rand_core` 0.6、`chrono` 0.4、`thiserror` 2 等，详见 `源码/Cargo.toml`。

## 网络与环境说明（影响复现，不是代码问题）

- 本机访问 crates.io 官方索引持续超时，验证时在工程内临时放了 `rsproxy` 稀疏镜像的 `.cargo/config.toml`。**该文件未随包交付**，避免改变你方的取源方式；`Cargo.lock` 与源码不受影响。
- 交付前已在「无 `.cargo/`、无 `target/`」的状态下重新跑了一遍全量测试并通过（`日志/07_清理后重建验证.txt`），说明这个包不依赖那台机器的构建缓存或镜像配置也能自举。
- 若你方直连 crates.io 也超时，在 `源码/.cargo/config.toml` 写入：

```toml
[source.crates-io]
replace-with = "rsproxy-sparse"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
```

## 本次改了什么（摘要，细节见 `差异/` 与 `检查记录.md`）

1. **新增 14 条单元测试**（token 10 条、password 4 条），全部断言具体错误变体，不只断言「失败」。
2. **最小修复 1（token）**：`decode_token` 对 `sub` 的判空由 `is_empty()` 改为 `trim().is_empty()`。纯空白 `sub` 之前能验签通过，下游按 `sub` 查用户会查不到。
3. **最小修复 2（password）**：`verify_password` 在交给 argon2 之前，先读 PHC 串里的 `m`/`t`/`p` 并检查上限（1 GiB / 64 次 / 并行 8），越界返回 `IncompatibleParams`。修复前，一条 `m=4294967295` 的损坏哈希会触发 4.4 TB 分配并把进程直接打死（实测 `0xC0000409`），连错误都返回不了。

公开签名、`TokenError`/`PasswordError` 变体、JWT 算法与 `iss`/`aud` 常量均未改动；route / extractor / service / 数据库 / 前端一律未碰。

## 未做（详见 `检查记录.md` 未执行清单）

- 依赖真实 PostgreSQL 的 9 个用例：本机无数据库，未执行。
- `--release` 模式、Linux/macOS 平台：未执行。
- 未向 GitHub 发 PR、未覆盖主项目（按任务要求交给 M1 审核）。
