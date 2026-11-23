# Markdown Cloud Editor

这是一个基于 Rust、PostgreSQL 和原生网页前端的云同步 Markdown 编辑器课程项目。

## 阶段进度

| 版本 | 当前范围 |
|---|---|
| W3 基线 | Actix Web API、注册和登录、文档 CRUD、版本冲突检查、PostgreSQL 迁移，以及前端 API 与草稿测试 |
| W4 集成候选 | 自动保存、会话隔离、数据库回归与界面反馈的阶段快照，见 [草稿 PR #13](https://github.com/Mattew-W/markdown-cloud-editor/pull/13) |
| W5 联调 | 编辑、预览、自动保存与草稿恢复进入统一集成版本，增加真实库回归和浏览器冒烟，见 [PR #14](https://github.com/Mattew-W/markdown-cloud-editor/pull/14) |

## 本地开发

1. 准备 Rust stable、PostgreSQL 17，以及前端 `package.json` 要求的 Node.js。
2. 将 `.env.example` 复制为 `.env`，配置测试用数据库连接，并将 `JWT_SECRET` 换成至少 32 字节的随机值。
3. 按 [PostgreSQL 开发说明](docs/LOCAL_POSTGRES.md) 创建数据库并应用迁移。
4. 在仓库根目录执行 `cargo run --locked`。默认 API 地址为 `http://127.0.0.1:8080`，健康检查为 `/health`。
5. 在同一浏览器 origin 下提供 `frontend/` 的静态页面并将 `/api/` 转发到 Actix。静态页面和 API 的连接方式见 [部署架构](docs/ARCHITECTURE.md#10-部署架构)。

```text
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets
cargo doc --locked --no-deps
```

真实数据库集成测试需要独立测试库。设置 `TEST_DATABASE_URL` 后执行 `cargo test --locked --all-targets -- --ignored`。前端依次执行 `npm ci --prefix frontend` 和 `npm test --prefix frontend`。运行中的 API 可用 `node frontend/m1_06_e2e.mjs http://127.0.0.1:8080` 验证独立 HTTP 与同步链路。

## 目录入口

| 路径 | 内容 |
|---|---|
| `src/`、`tests/` | Rust 服务及 API、真实数据库集成测试 |
| `frontend/` | 浏览器端模块、静态页面与前端测试，内容随阶段版本变化 |
| `migrations/` | PostgreSQL 迁移、约束核验和阶段回归脚本 |
| `docs/` | [项目规范](docs/PROJECT_SPEC.md)、[API](docs/API.md)、[数据库](docs/DATABASE.md)、[接口](docs/INTERFACES.md)和[同步契约](docs/SYNC.md) |
| `GPT_WORKSPACE/deliverables/` | 本地任务包、每周收件和审核索引；公开仓库保留部分阶段记录 |
| `GPT_WORKSPACE/prompt-guides/` | 本地成员个性化提示词与历次复盘 |

从最新 `main` 创建工作分支，通过 Pull Request 提交。详见 [协作说明](CONTRIBUTING.md)。
