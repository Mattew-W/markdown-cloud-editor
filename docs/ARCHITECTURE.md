# 系统架构

| 项 | 值 |
| --- | --- |
| 文档状态 | **已冻结**（Frozen） |
| 冻结日期 | 2026-10-20 |
| 架构风格 | 单 crate 分层解耦 + 独立静态前端 |
| 责任方 | M1（负责人） |
| 相关文档 | [`API.md`](API.md)、[`DATABASE.md`](DATABASE.md)、[`SYNC.md`](SYNC.md)、[`INTERFACES.md`](INTERFACES.md)、[`PROJECT_SPEC.md`](PROJECT_SPEC.md) |

---

## 1. 架构总览

### 1.1 核心决策

| 决策 | 内容 | 理由 |
| --- | --- | --- |
| **一个仓库** | 后端 + 前端 + 文档 + 迁移同仓 | 契约变更与代码变更在同一 PR 内可验证 |
| **一个 Rust crate** | 无 workspace | 首版一个 crate。引入 workspace 会使 CI 的 `cargo` 命令与工作目录失配 |
| **独立静态前端** | `frontend/` 不由后端托管 | 前后端分离部署；前端可用 Node 工具链独立测试 |
| **分层而非分层文件夹** | 层间**只能向下调用**，跨层调用是 bug | 见 §2 |
| **错误单点翻译** | 只有 `src/error.rs` 把领域错误翻译成 HTTP 响应 | 见 §2.2 |

### 1.2 请求全貌

```
浏览器 (静态前端)
    │
    │  HTTP /api/v1/...
    ▼
[第 2 层] 路由层 (routes)
    │  参数提取、DTO 反序列化、鉴权
    ▼
[第 3 层] 服务层 (services)
    │  业务规则编排、输入校验、事务边界
    ▼
[第 4 层] 仓储层 (repositories)
    │  参数化 SQL，唯一接触 SQL 的地方
    ▼
[第 5 层] PostgreSQL 17
```

---

## 2. 六层解耦架构

### 2.1 层次职责

| # | 层 | 模块 | 职责 | **禁止** |
| --- | --- | --- | --- | --- |
| 1 | **配置与横切** | `config`、`middleware`、`state`、`error` | 环境变量校验、request_id 追踪、共享状态、错误类型定义 | 业务逻辑 |
| 2 | **路由层** | `routes`（`health` / `auth` / `documents`） | 路由注册、请求提取、调用服务层、把结果转成响应 | 写 SQL、写业务规则、直接构造 `HttpResponse` |
| 3 | **服务层** | `services`（`auth_service`、`document_service`） | 业务规则、输入校验、事务编排 | 直接写 SQL 字符串、构造 HTTP 响应 |
| 4 | **仓储层** | `repositories`（`user_repo`、`document_repo`） | **唯一写 SQL 的地方**，参数化查询、连接池使用 | 业务规则、HTTP 相关概念 |
| 5 | **模型层** | `models`（`user`、`document`） | 数据库行的 Rust 映射（`FromRow`） | 行为逻辑 |
| 6 | **存储层** | PostgreSQL 17 | 约束兜底、原子更新、索引 | — |

> **"唯一写 SQL 的地方"是硬约束。** 一旦服务层里出现 SQL 字符串，SQL 就散落在多处，审查无法覆盖，且必然出现风格与参数化程度不一致的写法。

### 2.2 错误处理的单点约束

> **全项目只有 `src/error.rs` 把领域错误翻译成 HTTP 响应。业务代码一律返回 `AppError`，不直接构造 `HttpResponse`。**

`src/lib.rs:15` 明确写有这条约束。理由（`src/error.rs:2-8` 的模块文档）：

| 收益 | 说明 |
| --- | --- |
| 错误码字面量唯一且稳定 | 9 个 `ErrorCode` 变体是前后端契约 |
| 响应体结构恒定 | `{ "error": { code, message, details, request_id } }` |
| 内部细节不外泄 | SQL、凭据、堆栈只进日志 |

**跨层错误转换规则**：

| 层 | 错误类型 | 允许的转换 |
| --- | --- | --- |
| 仓储层 | `sqlx::Error` | `sqlx::Error` → `AppError::ServiceUnavailable`（连接类）/ `AppError::Internal`（其余） |
| 服务层 | `AppError` | 只做**补充上下文**（如 `AppError::bad_request(format!("title 长度 {n} 超过 255"))`），**不新增变体** |
| 路由层 | `AppError` | 原样上抛，或由 `ResponseError` 自动翻译 |

> **服务层不得新增 `AppError` 变体。** 新增变体会新增错误码字面量，直接违反 [`API.md`](API.md) §1.5 的冻结。

### 2.3 横切关注点

| 关注点 | 实现 | 覆盖范围 |
| --- | --- | --- |
| **request_id** | `middleware::RequestIdLayer` | **全部响应**（2xx/4xx/5xx），写入 `X-Request-Id` |
| **请求体上限** | `routes::configure` 的 `JsonConfig` | `/api/v1` 作用域，2 MiB，超限 413 |
| **日志** | `tracing` + `EnvFilter` | 全局，`RUST_LOG` 未设置时默认 `info` |
| **敏感信息** | `Config` 手写 `Debug` 实现 | `jwt_secret` 与 `database_url` **一律 `<redacted>`** |

---

## 3. 前端模块边界

### 3.1 模块职责

| 模块 | 责任方 | 职责 | **禁止** |
| --- | --- | --- | --- |
| `app.js` | M1 | **只做协调**，组装各模块 | 集中承载所有业务逻辑 |
| `api.js` | M6 | **唯一**做网络访问的地方 | 业务判断 |
| `auth.js` | M1 | 登录/注册表单与状态 | 直接 `fetch` |
| `documents.js` | M1 | 文档列表 | 直接 `fetch` |
| `editor.js` | M5 | textarea 与安全预览渲染 | 触发保存、保存状态管理 |
| `sync.js` | **M1** | **自动保存状态机**（`docs/SYNC.md`） | **直接重绘编辑器或文档列表** |
| `drafts.js` | M6 | **统一管理本地草稿** | **读写任何 DOM 节点** |

### 3.2 三条防"副本"规则

> 规则原文（`docs/ARCHITECTURE.md` §3 对应规范 §05:217）：
> **"公共模块通过明确导出函数协作，禁止多个文件同时维护彼此不一致的 `currentDocument` 或 `token` 副本。"**

| # | 规则 | 违反后果 |
| --- | --- | --- |
| 1 | **`token` 只在 `api.js` 一处维护** | 多份副本会不同步，表现为"有时登录态丢失" |
| 2 | **`currentDocument` 只在 `sync.js` 一处维护** | 多份副本会导致保存打到错误的文档（验收项 T06 失败） |
| 3 | **`localStorage` 只由 `drafts.js` 访问** | 两份语义不同的草稿逻辑 → 数据互相覆盖 |

> **第 3 条的历史教训**：M6 W1 的文件名叫 `drafts.js`，但实现不是规范的草稿模块。若直接复制进主项目，`sync.js` 调用不了它，M1 只能另写一份真正的草稿逻辑 → 仓库出现**两份语义不同的 `drafts.js`**。**文件同名 + 职责不符 = 这类问题的温床。**

### 3.3 前端状态所有权

| 状态 | 唯一所有者 | 其他模块如何访问 |
| --- | --- | --- |
| `token` | `api.js` | 调用 `api.js` 的函数，不直接读 `sessionStorage` |
| `currentDocument` | `sync.js` | 事件回调传入 |
| `local_revision` / `acked_revision` | `sync.js` | 不对外暴露 |
| 本地草稿 | `drafts.js` | 调用 §2.3（`INTERFACES.md`）的七个 export |
| 预览 HTML | `editor.js` | 不外传 |

### 3.4 安全渲染入口（唯一）

**任何用户 Markdown 产生的 HTML，都必须经过同一入口：**

```js
const html = DOMPurify.sanitize(marked.parse(text));
```

| 规则 | 说明 |
| --- | --- |
| **两步不可省略** | `marked` 解析 → `DOMPurify` 净化 |
| **Markdown 原文入库** | 数据库存原文，不存渲染后的 HTML |
| **标题与错误消息用 `textContent`** | **禁止** `innerHTML` |
| **第三方库固定版本本地托管** | `frontend/vendor/`，不使用未固定版本的 CDN |
| **保留版本、来源与许可证** | 见 `frontend/vendor/` 内的清单 |

> **XSS 防护不是可选项。** token 存在 `sessionStorage`，而 `sessionStorage` **可被同源脚本读取**。XSS 一旦成功即等于凭据泄露。验收项 **T12「脚本未执行，标题按文本显示」** 直接测这一点。

---

## 4. 数据流

### 4.1 读路径（`GET /api/v1/documents/{id}`）

```
1. 浏览器            api.js 发 GET，附带 Authorization: Bearer <token>
2. 中间件            RequestIdLayer 生成 UUID，写入 X-Request-Id 响应头
3. 路由层            routes/documents.rs
                      ├─ 解析路径参数 id → 非法 UUID 则 400 BAD_REQUEST
                      ├─ extractor 验证 JWT → 失败则 401 UNAUTHORIZED
                      └─ 从 token 的 sub 取出 owner_id（请求体无法指定）
4. 服务层            services/document_service.rs
                      ├─ 调仓储层取文档
                      └─ 不做额外规则（所有权判定在 SQL 的 WHERE owner_id = $ 中）
5. 仓储层            repositories/document_repo.rs
                      └─ SELECT ... FROM documents WHERE id = $1 AND owner_id = $2
6. 数据库            0 行 → 仓储层返回 None
7. 服务层            None → AppError::NotFound
8. 路由层            AppError → ResponseError 自动翻译成 404
                      {"error":{"code":"NOT_FOUND","message":"resource not found",
                       "request_id":"..."}}
9. 浏览器            api.js 按 error.code 判断，不解析 message 文字
```

### 4.2 写路径（`PUT /api/v1/documents/{id}`）

```
1. 浏览器            sync.js 发 PUT，body = {title, content, expected_version}
2. 路由层            ├─ 验证 JWT → owner_id
                      ├─ 反序列化 DTO
                      ├─ JsonConfig 检查请求体 ≤ 2 MiB → 超限 413
                      └─ 校验 title / expected_version → 违规 400
3. 服务层            document_service
                      ├─ 校验 title：trim 后 1–255 个 Unicode 标量值
                      └─ 调仓储层更新
4. 仓储层            单条原子 SQL：
                      UPDATE documents
                      SET title=$1, content=$2, version=version+1,
                          updated_at=CURRENT_TIMESTAMP
                      WHERE id=$3 AND owner_id=$4 AND version=$5
                      RETURNING id, title, content, version, created_at, updated_at
5. 数据库            条件不匹配 → 0 行（并发或冲突）
6. 服务层            0 行 → 判定查询区分两种原因：
                      ├─ 文档存在但 version 不符 → AppError::VersionConflict{server_version}
                      └─ 文档不存在或非本人    → AppError::NotFound
7. 路由层            翻译成 409（含 details.server_version）或 404
8. 浏览器            sync.js：
                      ├─ 200 → 推进 acked_revision 与 base_version（不覆盖编辑框）
                      ├─ 409 → 进 conflict，暂停自动写入
                      └─ 404 → 按 SYNC.md §6.2 分支 ④ 处理
```

### 4.3 认证流（`POST /api/v1/auth/login`）

```
1. 浏览器            api.js 发 POST {username, password}
2. 路由层            JsonConfig → 限流检查（同 IP 60 秒内最多 5 次）→ 超限 429 + Retry-After
3. 服务层            auth_service
                      ├─ username 归一化：trim → 转小写
                      ├─ 调仓储层按 username 查 users
                      ├─ 查无此用户 → 执行一次虚拟 hash_password（降低时序差异）
                      │                然后统一返回 401
                      └─ 查到此用户 → 交给受限阻塞任务池执行 verify_password
4. 阻塞任务池        argon2::verify_password（不阻塞 HTTP 工作线程）
5. 服务层            Ok  → 签发 JWT（HS256，TTL 3600s，声明 exp/sub/iss/aud）
                      Err → 见 INTERFACES.md §1.3 的错误映射表
6. 路由层            201/200 + {token, expires_in, user}
                      user 只含 id / username / created_at，**无 password_hash**
7. 浏览器            token 存入 sessionStorage
```

### 4.4 健康检查流（`GET /health`）

```
1. 中间件            生成 request_id
2. 路由层            health::health
3. 仓储层            执行 SELECT 1（真实探测，不看进程存活）
4. 数据库            成功 → 200 {"status":"ok","database":"up"}
                      失败 → 503 {"status":"degraded","database":"down"}
5. 日志              失败时 tracing::error!，**不返回连接串或数据库错误原文**
```

> **健康检查走的是独立路径**，返回 `{status, database}` 形状而非统一错误信封。CI 健康检查脚本按此解析。

### 4.5 自动保存流（写路径 + 状态机）

详见 [`SYNC.md`](SYNC.md)。要点：

```
用户输入 → sync.js 的 onInput → local_revision += 1 → 状态 dirty
         → 防抖 1.5s / max-wait 5s / Ctrl+S
         → 无在途请求？发 PUT（带发送中快照）
         → 有在途请求？记待保存标记，等当前请求完成后发最新快照
         → 200 → acked_revision = 快照.revision；base_version = 响应.version
         → 只有 acked_revision >= local_revision 才显示"已同步"
         → 无论成功与否 → drafts.js 约 250ms 合并写本地草稿
            【注意：草稿写入成功不改变 synced/dirty 判定】
```

---

## 5. 启动流程

`src/main.rs` 的启动顺序（**任一步失败即退出，不降级运行**）：

| 步骤 | 内容 | 失败行为 |
| --- | --- | --- |
| 0 | 初始化 `tracing`（`RUST_LOG` 未设置时默认 `info`） | — |
| 1 | `Config::from_env()` —— 读 `.env`（缺失不算错）并校验 | **`eprintln!` + 退出码 78** |
| 2 | `PgPoolOptions::connect()` + 立即 `SELECT 1` 探测 | **`eprintln!` + 退出码 78** |
| 3 | `AppState::new(pool)` → 挂 `RequestIdLayer` → `routes::configure` | `bind()` 失败返回 `io::Error` |
| 4 | （阶段 2 起）执行数据库迁移 | **退出码 78** |

### 5.1 配置闸门的三道校验

`src/config.rs:222-241`，任一不满足即**拒绝启动**：

| # | 规则 | `ConfigError` 变体 |
| --- | --- | --- |
| 1 | `JWT_SECRET` ≥ 32 字节 | `JwtSecretTooShort` |
| 2 | 不含 16 个占位标记之一（大小写不敏感） | `JwtSecretPlaceholder` |
| 3 | 不同字符种类 ≥ 10 | `JwtSecretLowEntropy` |

**退出码 78 = `EX_CONFIG`**（sysexits.h），便于脚本区分"配置问题"与"运行崩溃"。

> **`.env` 缺失不算错误**是有意设计：CI 与生产通常用真实环境变量注入。

### 5.2 配置常量

| 常量 | 值 | 位置 |
| --- | --- | --- |
| `MIN_JWT_SECRET_BYTES` | `32` | `src/config.rs:12` |
| `DEFAULT_JWT_TTL_SECS` | `3600` | `src/config.rs:15` |
| `MAX_JSON_BODY_BYTES` | `2 * 1024 * 1024` | `src/config.rs:18` |
| `MAX_CONTENT_BYTES` | `256 * 1024` | `src/config.rs:21` |
| `AUTH_RATE_LIMIT_MAX_ATTEMPTS` | `5` | `src/config.rs:24` |
| `AUTH_RATE_LIMIT_WINDOW_SECS` | `60` | `src/config.rs:27` |
| `DEFAULT_BIND_ADDR` | `"127.0.0.1:8080"` | `src/config.rs:30` |
| `API_PREFIX` | `"/api/v1"` | `src/routes/mod.rs:15` |
| `REQUEST_ID_HEADER` | `"X-Request-Id"` | `src/error.rs:221` |
| `REQUEST_ID_UNKNOWN` | `"unknown"` | `src/middleware.rs:38` |
| `EXIT_CONFIG_ERROR` | `78` | `src/main.rs:21` |

---

## 6. 目录结构

### 6.1 目标结构

```
markdown-cloud-editor/
├── Cargo.toml
├── Cargo.lock
├── rust-toolchain.toml              # 固定具体版本号，不用 stable
├── .env.example                     # 只有占位样例，无真实密钥
├── .gitignore
├── .gitattributes                   # frontend/vendor/** linguist-vendored=true
├── README.md
├── CONTRIBUTING.md
├── compose.yaml                     # 开发数据库
│
├── src/
│   ├── main.rs                      # 启动入口，四步流程，退出码 78
│   ├── lib.rs                       # 库根，configure_app 供测试复用
│   ├── config.rs                    # 环境变量 + 启动期安全校验
│   ├── error.rs                     # AppError / ErrorCode，HTTP 映射
│   ├── middleware.rs                # RequestIdLayer
│   ├── state.rs                     # AppState（PgPool）
│   ├── auth/                        # [阶段 3]
│   │   ├── mod.rs
│   │   ├── jwt.rs                   # HS256 签发与验签
│   │   ├── password.rs              # Argon2id（签名见 INTERFACES.md §1）
│   │   └── extractor.rs             # FromRequest -> owner_id
│   ├── routes/                      # [health 已实现]
│   │   ├── mod.rs                   # API_PREFIX + JsonConfig
│   │   ├── health.rs                # 真实 SELECT 1 探测
│   │   ├── auth.rs                  # [阶段 3]
│   │   └── documents.rs             # [阶段 4]
│   ├── dto/                         # [阶段 3/4] 请求与响应 DTO
│   │   ├── auth.rs
│   │   └── documents.rs
│   ├── models/                      # [阶段 2] FromRow 映射
│   │   ├── user.rs
│   │   └── document.rs
│   ├── services/                    # [阶段 3/4] 业务规则
│   │   ├── auth_service.rs
│   │   └── document_service.rs
│   └── repositories/                # [阶段 3/4] 唯一写 SQL 的地方
│       ├── user_repo.rs
│       └── document_repo.rs
│
├── migrations/
│   └── 0001_init.sql                # [阶段 2] 当前未落地
│
├── tests/                           # [阶段 4] 集成测试
│   ├── common/                      # 共用 fixture
│   ├── auth_api.rs
│   ├── document_api.rs
│   └── sync_conflicts.rs
│
├── frontend/                        # [阶段 5] 整个目录当前不存在
│   ├── index.html
│   ├── package.json                 # M5 提供
│   ├── package-lock.json
│   ├── css/
│   │   └── style.css
│   ├── js/
│   │   ├── app.js                   # M1，只协调
│   │   ├── api.js                   # M6，唯一网络出口
│   │   ├── auth.js                  # M1
│   │   ├── documents.js             # M1
│   │   ├── editor.js                # M5，安全预览
│   │   ├── sync.js                  # M1，自动保存状态机
│   │   └── drafts.js                # M6，纯逻辑草稿层（零 DOM）
│   ├── vendor/                      # marked、DOMPurify、许可证与版本清单
│   │   ├── marked.min.js
│   │   ├── purify.min.js
│   │   └── VERSIONS.md
│   └── tests/
│       ├── unit/                    # Node 内置测试运行器
│       └── e2e/                     # Playwright
│
├── docs/
│   ├── API.md                       # 端点、状态码、错误码、字段约束
│   ├── DATABASE.md                  # 表结构、索引、原子更新、迁移
│   ├── SYNC.md                      # 自动保存、草稿、文案禁令
│   ├── INTERFACES.md                # M3/M6 冻结签名、C1–C9
│   ├── ARCHITECTURE.md              # 本文
│   ├── PROJECT_SPEC.md              # MVP 范围、非目标、验收矩阵
│   ├── SECURITY.md                  # [阶段 5]
│   ├── TESTING.md                   # [阶段 5]
│   ├── CODE_REVIEW.md
│   └── DECISIONS.md                 # 破坏性变更记录
│
└── .github/
    ├── PULL_REQUEST_TEMPLATE.md
    └── workflows/
        └── ci.yml                   # Rust checks / Frontend checks
```

### 6.2 目录创建状态（截至 2026-10-20）

| 路径 | 状态 |
| --- | --- |
| `src/` | **已存在**，8 个 `.rs` 文件 |
| `src/auth/`、`src/dto/`、`src/models/`、`src/services/`、`src/repositories/` | **不存在** |
| `src/routes/` | **已存在**，仅 `mod.rs` + `health.rs` |
| `migrations/` | **不存在** |
| `tests/` | **不存在** |
| `frontend/` | **不存在** |
| `docs/` | **已创建**（本文档组） |
| `.github/` | **不存在** |
| `rust-toolchain.toml`、`.env.example`、`compose.yaml` | **不存在** |

> 目录按功能 PR 逐步建立，**不要求首次提交就填满**。上方标注"不存在"是真实状态，不是规划遗漏。

### 6.3 `src/routes/` 的两段式前缀

```
/health          ← 不带版本前缀的运维探针
/api/v1/...      ← 业务 API，统一挂 2 MiB JsonConfig
```

| 前缀 | 挂载内容 |
| --- | --- |
| `/health` | 直接注册路由，不受 JsonConfig 约束（无请求体） |
| `/api/v1` | `web::scope(API_PREFIX)` + `JsonConfig::default().limit(2 MiB)` + 413 映射 |

---

## 7. 技术选型

### 7.1 后端依赖（`Cargo.toml` 实际内容）

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| `actix-web` | `4.11` | HTTP 服务 |
| `sqlx` | `0.8`（`default-features = false`） | features: `runtime-tokio-rustls`, `postgres`, `uuid`, `chrono`, `macros`, `migrate` |
| `argon2` | `0.5` | 密码哈希 |
| `jsonwebtoken` | `9` | JWT 签发与验签 |
| `serde` | `1`（`derive`） | 序列化 |
| `serde_json` | `1` | JSON |
| `uuid` | `1`（`v4`, `serde`） | 资源标识 |
| `chrono` | `0.4`（`serde`） | UTC 时间 |
| `thiserror` | `2` | 错误派生 |
| `tracing` | `0.1` | 结构化日志 |
| `tracing-subscriber` | `0.3`（`env-filter`） | 日志订阅器 |
| `dotenvy` | `0.15` | `.env` 加载 |
| `actix-rt` | `2` | **dev-dependency**，集成测试运行时 |

**SQLx 关闭了 `default-features`**，显式选择 Tokio 运行时 + rustls TLS。

> **`macros` feature 已启用但不使用 `query!` 宏。** 运行时 `query` / `query_as` + 参数绑定，故**无需 `cargo sqlx prepare`**（`Cargo.toml:21` 注释明确说明）。

### 7.2 版本锁定

| 项 | 值 |
| --- | --- |
| Rust | **1.99**，edition **2024**（`Cargo.toml:4-5`） |
| 库名 | `markdown_cloud_editor`（下划线） |
| 二进制名 | `markdown-cloud-editor`（连字符） |
| 发布配置 | `publish = false`，`opt-level = 3`，`lto = "thin"` |

**依赖版本用范围约束（`"4.11"`），精确版本由 `Cargo.lock` 固定。** CI 所有命令带 `--locked`。

### 7.3 crate 级 lint 配置

`src/lib.rs:18-21`：

```rust
#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::pedantic)]
#![allow(clippy::module_name_repetitions)]
```

| 属性 | 效果 |
| --- | --- |
| `forbid(unsafe_code)` | **禁止任何 `unsafe`**（`forbid` 不可放宽） |
| `warn(missing_docs)` | 公开项必须有文档。CI 用 `RUSTDOCFLAGS=-D warnings` 提升为**错误** |
| `warn(clippy::pedantic)` | 启用 Clippy 的 pedantic 组。CI 用 `-D warnings` 提升为**错误** |
| `allow(module_name_repetitions)` | 唯一放宽项。`user_repo`、`UserRepository` 之类命名必然重复模块名 |

### 7.4 编码约束

| 约束 | 说明 |
| --- | --- |
| **对用户输入与外部故障不用 `unwrap` / `expect`** | `src/lib.rs:16`。唯一允许的 `unwrap` 是测试代码与已知不变的内部不变量 |
| **公开项补 Rustdoc** | 描述**行为、错误与边界**，不是复述函数名 |
| **中文文档 + 英文标识符** | 沟通文档中文；API 字段、代码标识符、错误码、目录用英文 |
| **`lib.rs` 提供 `configure_app`** | `src/lib.rs:40-42`。**测试必须走与生产完全相同的组装路径**，否则测的不是真实行为 |

### 7.5 前端依赖

| 库 | 版本 | 托管方式 |
| --- | --- | --- |
| marked | **12.x**（固定补丁） | `frontend/vendor/`，**不使用 CDN** |
| DOMPurify | **3.3.x**（固定补丁） | `frontend/vendor/`，**不使用 CDN** |

> 第三方库必须**固定版本并本地托管**，记录来源与许可证。**不使用未固定版本的 CDN 链接**——那意味着供应商可以在不通知的情况下改变行为，或在演示时因网络问题直接失效。

**`.gitattributes` 必须如实标记**：

```gitattributes
frontend/vendor/** linguist-vendored=true
```

**不得**把自己编写的 JavaScript、CSS 或测试标记成第三方代码来提高 Rust 展示比例。

---

## 8. CI 架构

### 8.1 必需检查与状态名

**必需状态名称保持稳定：`Rust checks` 与 `Frontend checks`。**

```sh
# Rust checks —— 从根目录 crate 执行
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
RUSTDOCFLAGS="-D warnings" cargo doc --locked --no-deps
```

```sh
# Frontend checks —— 在 frontend 目录执行
npm ci
npm run lint
npm run format:check
npm test
npm run test:e2e
```

### 8.2 四条禁止

| # | 禁止 | 后果 |
| --- | --- | --- |
| 1 | **不得添加总是成功的占位脚本** | 数据库根本没跑过，CI 却显示绿色——**最危险的假通过** |
| 2 | **不得借用开发者本地数据库或生产密钥** | 测试结果不可重现，且有泄密风险 |
| 3 | **不得用 `--no-verify` 或跳过签名** | 绕过 CI 与审计 |
| 4 | **不得新增必需状态而没有真实工作流** | 必须先让真实工作流产生检查，再通过规则变更登记为必需 |

**缺少 `Cargo.toml`、测试服务不可用或必需脚本未配置，应明确失败，不报告为通过。**

### 8.3 CI 数据库

| 项 | 要求 |
| --- | --- |
| 服务 | GitHub Actions **临时 PostgreSQL 服务容器** |
| 迁移 | SQLx 的准备、迁移与测试**指向同一 schema** |
| 并行 | 并行任务**隔离数据** |
| 失败语义 | **数据库不可用时 job 必须失败** |

### 8.4 语言占比口径（`PROJECT_SPEC.md` 详述）

| 语言 | 目标 | 范围 |
| --- | --- | --- |
| Rust | 60% | 55%–65% |
| JavaScript | 25% | 20%–30% |
| CSS | 7% | 5%–10% |
| HTML | 5% | 3%–7% |
| SQL | 3% | 2%–5% |

**统计口径**：自写有效代码行，**排除空行、纯注释、第三方库、生成文件、锁文件、构建产物**。含对应语言的测试。

**内嵌在 Rust 字符串中的 SQL 随所在 Rust 文件统计，不重复计数。**

---

## 9. 安全架构

### 9.1 纵深防御

| 层 | 措施 |
| --- | --- |
| **传输** | 部署在反向代理后，强制 HTTPS |
| **存储** | 密码只存 Argon2id PHC 串；**无明文、无日志** |
| **会话** | JWT 固定 HS256；≥ 32 字节高熵密钥；三道启动校验 |
| **访问** | 每个文档逐一校验 `owner_id`；**越权统一 404** |
| **XSS** | `DOMPurify.sanitize(marked.parse(text))`；标题用 `textContent` |
| **注入** | 全部 SQL 参数化；**无字符串拼接** |
| **限流** | 注册/登录同 IP 60 秒 5 次 |
| **输入** | 应用层完整校验 + 数据库约束兜底 |
| **错误** | 500 响应恒为 `"服务器内部错误"`；SQL/凭据/堆栈只进日志 |
| **配置** | `Config` 的 `Debug` 实现把 `jwt_secret` 与 `database_url` 脱敏 |

### 9.2 已知并接受的限制

| 限制 | 说明 |
| --- | --- |
| **已签发 token 退出后仍有效** | 退出只清理客户端 token。**无服务端吊销机制**，token 在到期前（最长 1 小时）仍有效。首版不实现黑名单 |
| **`sessionStorage` 可被同源脚本读取** | XSS 即凭据泄露。**因此 XSS 防护是硬要求** |
| **无刷新令牌** | 过期后重新登录 |
| **数据库端口不开放公网** | 部署约束 |
| **非正常关闭可能丢失最后一小段输入** | 250 毫秒合并窗口内的输入可能未落盘。**不得承诺绝对不丢失** |

> **这些限制必须写进 `SECURITY.md`**（阶段 5），不得只在代码注释里。

---

## 10. 部署架构

```
                 反向代理（同一域名）
                   │              │
        静态资源   │              │  /api/*
                   ▼              ▼
          frontend/ 静态文件    Actix-web 服务
                              （BIND_ADDR，默认 127.0.0.1:8080）
                                          │
                                          ▼
                              PostgreSQL 17（端口不对公网开放）
```

| 规则 | 说明 |
| --- | --- |
| **静态前端与 API 服务分离部署** | 同域名的反向代理分别转发 |
| **后端只监听回环地址** | 默认 `127.0.0.1:8080` |
| **数据库端口不对公网开放** | 演示环境保留恢复用的测试数据与备份 |
| **部署与安全配置变更也必须走 PR** | 无例外 |

---

## 11. 模块归属矩阵

| 模块 | 成员 | **交付边界**（明确禁止越界） |
| --- | --- | --- |
| 工程骨架、repositories、HTTP routes、身份接线、sync 状态机、CI/E2E、报告与最终集成 | **M1** | — |
| 数据库结构 | **M2** | migrations、models、DB fixtures、schema/migration 测试。**不写 repositories** |
| 认证安全核心 | **M3** | Argon2id/JWT 函数及单测。**不写 routes / extractor / auth service** |
| 文档业务规则 | **M4** | DTO、输入校验、document service 及单测。**不写 HTTP routes / API 集成测试** |
| 前端 UI | **M5** | 页面、编辑器、安全预览、前端工具、UI 单测。**不写 E2E** |
| 前端工具模块 | **M6** | Fetch API client、本地草稿存取及单测。**不写 sync 状态机 / E2E** |

### 11.1 M2–M6 模块边界严格不重叠

**六个窄模块边界不重叠，集成全部由 M1 负责。** 具体表现为：

| 边界 | 体现 |
| --- | --- |
| M2 不写 repositories | SQL 集中在 M1 的 repositories |
| M3 不写 routes / extractor / auth service | HTTP 层在 M1 |
| M4 不写 routes | document service 由 M1 接入路由 |
| M5 不写 E2E | E2E 由 M1 |
| M6 不写 sync 状态机 | sync.js 在 M1 |
| M6 的 drafts.js 不写 DOM | DOM 归 M5 的 editor.js |

> **越界的直接后果是返工。** M6 W1 的返工判定中，"drafts.js 直接读写 DOM 并绑定事件"就是越界导致的结构性问题之一。

---

## 12. 已知实现偏差（如实记录，不自行修正）

| # | 位置 | 现象 | 影响 |
| --- | --- | --- | --- |
| 1 | `src/middleware.rs:108` | `RequestIdService::call` 把 ID 插入 `req.extensions_mut()`，但**从不调用** `with_request_id()`（`src/middleware.rs:45`）写入线程局部 `REQUEST_ID` | HTTP 路径上 `error.request_id` 恒为占位值 `"unknown"`，而响应头 `X-Request-Id` 是真实 UUID。**二者不一致**。[`API.md`](API.md) §1.4 已记录，阶段 3 接线时修复 |
| 2 | `src/error.rs:260` | `request_id_header_value()` 定义了但无调用点 | dead code。当前靠 `#[allow(dead_code)]` 掩盖的是另一个函数，此函数可能触发 `dead_code` 警告（`-D warnings` 下会失败） |
| 3 | `src/routes/mod.rs:26` | `API_PREFIX` 作用域下**无任何路由** | `/api/v1/*` 全部 404。前端按契约开发可继续，但联调须等阶段 3/4 |

> **本文档如实记录这些偏差，不做"修正"。** 修正属于 M1 的代码职责。

---

## 13. 变更流程

本文件的架构决策属于强契约。以下变更需 `docs/DECISIONS.md` 记录 + PR 审核：

| # | 决策 | 破坏程度 |
| --- | --- | --- |
| 1 | 引入 workspace（多 crate） | **高**。CI 命令与工作目录全部失配 |
| 2 | 更换 HTTP 框架 | **高** |
| 3 | 仓储层之外允许写 SQL | **高** |
| 4 | 服务层新增 `AppError` 变体 | **高**。新增错误码字面量，破坏 [`API.md`](API.md) 契约 |
| 5 | 放宽 crate 级 lint 配置 | 中 |
| 6 | 前端模块职责重划 | 中。可能导致两份副本 |
| 7 | 依赖版本升级 | 中。须说明最低 Rust 版本、功能变化、验证结果 |
| 8 | 依赖版本混搭（如新 jsonwebtoken + 旧 argon2 示例） | **高**。见规范 §02 的明确禁止 |

### 版本记录

| 版本 | 日期 | 变更 | 记录人 |
| --- | --- | --- | --- |
| 1.0 | 2026-10-20 | 首次冻结。六层架构、前端模块边界、数据流、目录树、启动流程、CI 架构、安全架构、模块归属矩阵 | M1 |