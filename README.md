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
