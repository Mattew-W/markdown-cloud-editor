# Gemini Markdown Cloud Editor (课程独立版本)

> **项目标识**：`gemini-3.8-flash-version/`  
> **面向规范**：PoPL (35-380) 课程 Project 10 (Web-based Markdown Cloud Editor)  
> **核心栈**：Rust 2024 / Actix-web 4 / SQLx 0.8 / PostgreSQL 17 / 原生 JavaScript (ES Modules)

---

## 1. 项目简介与实现范围

本项目是为 35-380 PoPL 课程 Project 10 独立构建的 Web 端 Markdown 云同步编辑器。项目聚焦于实现高可靠的前后端分离云笔记系统，后端采用 Rust Actix-web 提供安全、低延迟的 REST API，使用 SQLx 进行持久化；前端采用纯原生 HTML/CSS/JavaScript 构建双栏实时编辑与渲染界面。

### 1.1 课程必做功能与扩展功能边界划分

| 功能模块 | 归属类别 | 老师 Project 10 原始要求 | 本项目实现说明 |
| :--- | :--- | :--- | :--- |
| **Rust HTTP 后端** | **课程必做项** | 采用 Actix-web 或 Rocket 搭建后端服务 | 采用 Actix-web 4，基于分层架构解耦路由、服务与仓储 |
| **文档 CRUD REST API** | **课程必做项** | 提供文档创建、读取、更新、删除接口 | 遵循 RESTful 规范，提供完整的 `/api/v1/documents` 系列接口 |
| **用户身份认证** | **课程必做项** | 基于 JWT 的无状态安全认证 | Argon2id 密码哈希 + HS256 JWT 令牌鉴权 + Extractor 租户提取 |
| **PostgreSQL 持久化** | **课程必做项** | 通过 `sqlx` 将文档内容持久化到 PostgreSQL | 官方验收模式，通过真实 PostgreSQL 17 全生命周期验证 |
| **双栏编辑与实时预览** | **课程必做项** | 左侧编辑正文，右侧实时渲染 Markdown 预览 | 原生 textarea + Marked.js 解析 + DOMPurify 安全过滤 |
| **无感自动保存** | **课程必做项** | 每隔几秒自动保存，不丢失用户编辑焦点 | 防抖 1.5s / 最长等待 5s 调度器，状态机驱动，不触碰焦点 |
| **代码文档 (Rustdoc)** | **课程必做项** | 完整的代码注释与 Rustdoc 文档 | `cargo doc --no-deps` 成功构建，覆盖全模块公开符号 |
| **Git 持续提交记录** | **课程必做项** | 有意义且持续的提交记录 | 具有阶段性里程碑规范 commit 记录 |
| **并发冲突解决 (CAS)** | **工程规范加固** | 规范要求防止并发丢失更新 | 单条原子 CAS 更新（检查 version），冲突返回 409 |
| **离线会话草稿** | **工程规范加固** | 防止网络瞬断导致内容丢失 | 基于 LocalStorage 的会话草稿与三重核对安全清理 |
| **Gemini AI 伴写** | *可选扩展项* | *非 Project 10 必做项* | 续写、润色、摘要提取、图表与公式生成（在线/离线双模） |
| **KaTeX / Mermaid** | *可选扩展项* | *非 Project 10 必做项* | 前端数学公式与流程图实时可视化渲染 |

---

## 2. 环境要求

在运行与验证本项目前，请确保环境中已具备以下工具：

1. **Rust 工具链**：
   - Rust 1.80+ (推荐 1.85+，支持 Rust 2024 Edition)
   - Cargo 包管理器
2. **PostgreSQL 数据库 (课程验收标准环境)**：
   - PostgreSQL 14+ (本项目在 Windows 本地真实的 PostgreSQL 17.x 上完整验证)
   - 具备创建数据库和 Schema 的访问权限
3. **Node.js (前端自动化测试)**：
   - Node.js v18.0.0+ (内置 `node:test` 测试运行器，无需安装任何 npm 构建依赖)
4. **现代 Web 浏览器**：
   - 支持 ES Modules、Fetch API、AbortController 与 LocalStorage (Chrome 90+、Firefox 90+、Edge 90+ 或 Safari 15+)

---

## 3. 完整启动步骤

### 步骤 1：准备环境配置文件

在 `gemini-3.8-flash-version/` 根目录下，基于 `.env.example` 复制生成 `.env` 文件：

```bash
cd gemini-3.8-flash-version
copy .env.example .env
```

### 步骤 2：配置 JWT 鉴权密钥 (必选)

程序移除了默认硬编码密钥。**`JWT_SECRET` 必须明确配置且长度不能少于 32 字节**。若未配置或长度不足，服务启动时将直接拦截退出并给出明确错误。

在 `.env` 中设置：
```env
JWT_SECRET=your_custom_secure_random_key_entropy_at_least_32_bytes_long
```

### 步骤 3：准备数据库并执行配置

#### 方案 A：PostgreSQL 模式 (课程验收模式，强力推荐)

1. 在本地或服务器 PostgreSQL 中创建空数据库：
   ```sql
   CREATE DATABASE mce_test;
   ```
2. 在 `.env` 中配置 `DATABASE_URL`：
   ```env
   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/mce_test
   ```
3. 服务启动时，后端会自动检测并执行 `migrations/postgres/0001_init.sql`，自动建表与建索引。

#### 方案 B：SQLite 模式 (可选本地开发模式)

若临时没有 PostgreSQL 服务，可配置为 SQLite 嵌入式文件模式：
```env
DATABASE_URL=sqlite://gemini_editor.db?mode=rwc
```

### 步骤 4：编译并启动服务

```bash
cargo run
```

当看到控制台输出如下日志时，说明服务已完全就绪：
```text
🚀 正在启动 Gemini Markdown Cloud Editor...
📦 数据库模式: Postgres
🔄 正在执行数据库迁移与契约验证...
✅ 数据库迁移成功！
🌐 服务已就绪，正在监听: http://127.0.0.1:8080
```

### 步骤 5：访问前端系统

打开现代浏览器，访问：
**`http://127.0.0.1:8080`**

---

## 4. 数据库模式说明

- **PostgreSQL 模式**：**课程验收使用的唯一基准模式**。所有生产约束、外键级联、复合排序索引均基于 PostgreSQL 语法实现。
- **SQLite 模式**：仅作为免装数据库的本地开发测试便利模式，不能代替课程 PostgreSQL 最终验收。

### 数据库实体结构 (PostgreSQL Schema)

```sql
-- 用户表 (认证与租户主键)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(64) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 文档表 (CRUD 与原子版本控制)
CREATE TABLE IF NOT EXISTS documents (
    id VARCHAR(64) PRIMARY KEY,
    owner_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 租户隔离排序索引
CREATE INDEX IF NOT EXISTS idx_documents_owner_updated 
ON documents(owner_id, updated_at DESC);
```

### 乐观并发控制 (CAS) 契约

更新与删除操作均执行单条原子 SQL：
```sql
UPDATE documents 
SET title = $1, content = $2, version = version + 1, updated_at = CURRENT_TIMESTAMP
WHERE id = $3 AND owner_id = $4 AND version = $5
RETURNING id, title, content, version, created_at, updated_at;
```
如果返回行数为 0，系统区分是文档不存在/无权限（返回 404）还是版本已变动（返回 409 `VERSION_CONFLICT` 并附带服务端最新 `server_version`）。

---

## 5. 使用说明

### 5.1 注册与登录
- 支持用户注册与登录。密码要求最小长度 8 个字符。
- 服务端使用 **Argon2id** 进行哈希加密。
- 登录成功后前端将 JWT 令牌安全写入 `sessionStorage` 与 `localStorage`，后续 API 请求自动注入 `Authorization: Bearer <token>`。

### 5.2 文档创建与查看 (CRUD)
- 点击顶部「+ 新建」按钮创建新文档，默认版本号为 1。
- 左侧边栏展示当前用户拥有的文档列表，点击可切换文档。
- 跨用户隔离：尝试通过 URL 伪造 ID 访问他人文档一律返回 `404 Not Found`，绝不泄露文档存在性。

### 5.3 双栏实时编辑与安全预览
- 左侧为编辑文本框（textarea），右侧为实时 HTML 渲染面板。
- 前端集成 Marked.js 语法解析器，并严格通过 **DOMPurify** 执行 XSS 过滤清洗，杜绝恶意脚本注入。
- 支持 GFM 表格、代码语法高亮、LaTeX/KaTeX 公式以及 Mermaid 流程图。

### 5.4 自动保存与焦点保持
- 编辑器采用增量监听机制，用户打字时：
  1. 立即在内存中递增 `localRevision`。
  2. 写入以 `{userId}:{docId}:{sessionId}` 为唯一键的 LocalStorage 本地备份。
  3. 启动 1.5 秒防抖（debounce）与 5.0 秒最大等待（maxWait）调度器。
- 自动保存通过后台异步 Fetch 发出，保存期间编辑器 textarea 不做重新渲染，**绝不丢失用户编辑焦点与光标位置**。
- 请求在途上限严格限制为 1 个，避免乱序并发覆盖。

### 5.5 版本冲突处理 (Conflict Resolution)
当在多个浏览器标签页或多客户端并发修改同一文档时，后提交的请求将收到 HTTP 409 冲突响应。前端将弹出冲突裁决模态框，提供两条明确路径：
- **「用本地覆盖」**：采纳服务端最新的版本号，保留本地未保存内容重新发起 CAS 提交，成功后递增至新版本。
- **「重新拉取云端」**：放弃本地未保存内容，拉取服务端最新正本重置编辑器，清空脏标记。

### 5.6 草稿恢复 (Draft Recovery)
若用户在断网或未保存状态下意外刷新页面或重启浏览器：
- 重新打开该文档时，`classifyRestore` 算法自动比对本地离线草稿与云端正本。
- 若本地存在未提交且基于有效基线的编辑，系统弹出草稿恢复提示：
  - **「恢复」**：以云端正本为同步基线，将草稿内容作为未确认本地修改注入编辑器，标记为 `dirty` 并调度自动保存。
  - **「放弃」**：立即从存储中彻底删除旧草稿，保留云端正本内容。

---

## 6. 项目结构与技术设计概述

### 6.1 项目目录结构

```text
gemini-3.8-flash-version/
├── Cargo.toml                # Rust 项目清单与依赖定义
├── package.json              # 前端 Node.js 测试套件清单
├── .env.example              # 运行环境变量模板
├── src/                      # Rust 核心后端 (分层解耦架构)
│   ├── main.rs               # 应用入口、静态文件托管、服务生命周期
│   ├── lib.rs                # 库模块导出与应用组装
│   ├── config.rs             # 配置解析与 JWT 强度强制校验
│   ├── error.rs              # 统一结构化错误与 HTTP 状态码映射
│   ├── state.rs              # AppState 与 DbPool (Postgres/Sqlite) 抽象
│   ├── auth/                 # 认证层 (Argon2id 哈希、JWT 编解码、AuthUser 提取器)
│   ├── models/               # 数据模型 (User, Document, DocumentSummary)
│   ├── dto/                  # 请求/响应传输对象 (Auth, Document, AI)
│   ├── repositories/         # 数据库仓储实现 (UserRepo, DocumentRepo CAS 原子 SQL)
│   ├── services/             # 业务服务层 (AuthService, DocumentService, GeminiService)
│   ├── routes/               # HTTP 路由处理函数 (auth, documents, ai, health)
│   └── middleware/           # 限流滑动窗口中间件
├── migrations/               # 数据库迁移脚本
│   ├── postgres/0001_init.sql# PostgreSQL 官方迁移脚本
│   └── sqlite/0001_init.sql  # SQLite 备用迁移脚本
├── static/                   # 纯原生前端
│   ├── index.html            # 双栏工作台主界面
│   ├── css/app.css           # 布局与响应式样式
│   ├── vendor/               # 依赖 (marked.min.js, purify.min.js)
│   └── js/
│       ├── api.js            # 核心网络客户端 (统一处理 JWT、401、409、429)
│       ├── editor.js         # 安全 Markdown 解析与 DOMPurify 过滤
│       ├── drafts.js         # 离线草稿存储与三重核对安全清理
│       ├── sync.js           # 7 状态机驱动、在途控制与退避重试
│       ├── copilot.js        # Gemini AI 交互控制
│       └── app.js            # 应用总控与事件装配
└── tests/                    # 测试套件
    ├── common/mod.rs         # 集成测试辅助夹具
    ├── auth_tests.rs         # 认证、密码长度、弱密钥防御与 JWT 测试 (7 项)
    ├── document_tests.rs     # 文档 CRUD、CAS 乐观锁、租户隔离与大载荷测试 (6 项)
    ├── postgres_tests.rs     # 真实 PostgreSQL 17 生产环境与重启持久化测试 (2 项)
    ├── rate_limit_tests.rs   # 认证限流测试 (1 项)
    ├── ai_api_tests.rs       # AI 接口契约与离线仿真测试 (6 项)
    └── frontend/             # 前端自动化测试套件
        ├── setup.js          # 测试环境 Mock (localStorage, sessionStorage)
        ├── drafts.test.js    # 草稿隔离、三核对删除与恢复分类测试 (3 项)
        ├── sync_engine.test.js # 状态机、会话隔离、备份异常与覆盖测试 (6 项)
        └── workflow.test.js  # E2E 完整链路、冲突双分支、草稿双分支与状态码测试 (4 项)
```

### 6.2 RESTful API 列表

| 方法 | 路径 | 鉴权要求 | 说明 | 正常状态码 | 异常状态码 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/auth/register` | 无 | 注册新用户 | 201 Created | 400, 409 |
| `POST` | `/api/v1/auth/login` | 无 | 用户登录换取 JWT | 200 OK | 401 |
| `GET` | `/api/v1/documents` | Bearer Token | 获取当前用户的文档列表 | 200 OK | 401 |
| `POST` | `/api/v1/documents` | Bearer Token | 创建新文档 | 201 Created | 400, 401, 413 |
| `GET` | `/api/v1/documents/{id}` | Bearer Token | 获取单篇文档正文与版本 | 200 OK | 401, 404 |
| `PUT` | `/api/v1/documents/{id}` | Bearer Token | CAS 乐观锁更新文档 | 200 OK | 400, 401, 404, 409, 413 |
| `DELETE` | `/api/v1/documents/{id}` | Bearer Token | CAS 乐观锁删除文档 | 204 No Content | 401, 404, 409 |
| `POST` | `/api/v1/ai/complete` | Bearer Token | 文本智能续写 (可选扩展) | 200 OK | 401, 503 |
| `POST` | `/api/v1/ai/polish` | Bearer Token | Markdown 润色 (可选扩展) | 200 OK | 401, 503 |
| `POST` | `/api/v1/ai/summarize`| Bearer Token | 提取要点摘要 (可选扩展) | 200 OK | 401, 503 |
| `POST` | `/api/v1/ai/diagram`  | Bearer Token | 生成 Mermaid 图表 (可选扩展)| 200 OK | 401, 503 |
| `POST` | `/api/v1/ai/math`     | Bearer Token | 生成 KaTeX 公式 (可选扩展) | 200 OK | 401, 503 |
| `POST` | `/api/v1/ai/chat`     | Bearer Token | 伴写问答交互 (可选扩展) | 200 OK | 401, 503 |
| `GET` | `/api/v1/health`      | 无 | 健康检查探针 | 200 OK | - |

---

## 7. 测试方法与实际结果

所有测试均在 Windows 本地实际运行并通过，无虚假构造数据。

### 7.1 后端 Rust 自动化测试套件

执行命令：
```bash
cargo test
```

**实际运行结果**：共 **22 项测试全部通过 (22 passed, 0 failed)**。

```text
running 7 tests
test test_config_jwt_secret_validation ... ok
test test_jwt_tampered_or_invalid_signature_returns_401 ... ok
test test_jwt_expired_token_returns_401 ... ok
test test_password_length_validation_rules ... ok
test test_register_and_login_success ... ok
test test_register_duplicate_username_fails_with_409 ... ok
test test_login_failure_returns_identical_401 ... ok
test result: ok. 7 passed; 0 failed

running 6 tests
test test_unicode_whitespace_title_rejected ... ok
test test_delete_document_with_optimistic_locking ... ok
test test_optimistic_locking_prevents_lost_updates ... ok
test test_create_and_get_document ... ok
test test_payload_too_large_boundary ... ok
test test_tenant_isolation_unauthorized_returns_404 ... ok
test result: ok. 6 passed; 0 failed

running 2 tests
test test_postgres_crud_and_restart_persistence ... ok
test test_postgres_multi_tenant_isolation_and_concurrency_conflict ... ok
test result: ok. 2 passed; 0 failed

running 1 test
test test_rate_limiter_blocks_on_excess_requests ... ok
test result: ok. 1 passed; 0 failed

running 6 tests
test test_ai_complete_endpoint ... ok
test test_ai_math_generation ... ok
test test_ai_summarize_endpoint ... ok
test test_ai_chat_with_document_context ... ok
test test_ai_polish_endpoint ... ok
test test_ai_diagram_generation ... ok
test result: ok. 6 passed; 0 failed
```

#### 真实 PostgreSQL 17 专项测试验证 (`tests/postgres_tests.rs`)：
- **`test_postgres_crud_and_restart_persistence`**：在真实的 PostgreSQL 17 数据库上完成用户注册、文档创建（v1）、更新（v2）；**断开原有连接池模拟服务完全重启**，使用全新的连接池重新连接同一数据库，成功读取此前持久化文档，最后以乐观锁成功删除。
- **`test_postgres_multi_tenant_isolation_and_concurrency_conflict`**：验证两个真实租户之间的物理隔离（Tenant B 越权 GET、PUT、DELETE 均严格返回 404）；验证并发更新时 Session 1 成功将版本升至 v2，持有旧版本的 Session 2 提交立即返回 409 `VERSION_CONFLICT` 并携带 `server_version: 2`；Session 2 采纳 v2 后重新提交成功升至 v3。

### 7.2 前端与端到端测试套件

执行命令：
```bash
npm test
```

**实际运行结果**：共 **13 项测试全部通过 (13 passed, 0 failed)**。

```text
> gemini-markdown-cloud-editor-tests@1.0.0 test
> node --test "tests/frontend/*.test.js"

✔ 草稿 Key 构造、解析与唯一隔离 (0.8ms)
✔ 草稿三重核对删除保护 (会话、修订号、内容) (0.9ms)
✔ 【缺陷 4 判定】classifyRestore 正确区分采纳云端、恢复确认与版本冲突 (0.1ms)
✔ SyncEngine 拥有标准 7 个状态枚举且初始状态为 synced (0.5ms)
✔ onInput 触发编辑后转为 dirty 且草稿正常备份时显示“已在本地备份” (2.2ms)
✔ 【缺陷 7 验证】本地存储异常时明确返回失败，不虚报已在本地备份 (0.7ms)
✔ 【缺陷 3 验证】A 文档在途保存响应返回时，绝不污染已切换的 B 文档会话与版本 (0.4ms)
✔ 【缺陷 5 验证】冲突覆盖 resolveOverwrite 正确转换状态并触发提交 (0.3ms)
✔ 【缺陷 6 验证】网络故障与 429 触发带有上限的指数退避重试调度 (0.1ms)
✔ 【端到端流程】认证、文档创建、编辑自动保存、读取与删除完整链路 (3.5ms)
✔ 【冲突处理分支】验证“用本地覆盖”与“拉取云端”双分支行为 (0.3ms)
✔ 【草稿恢复分支】验证“恢复草稿”与“放弃草稿”双分支行为 (0.3ms)
✔ 【异常重试与状态指示】网络失败、500、429、401、409 差异化处理 (0.4ms)

ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
```

### 7.3 前端 JavaScript 语法校验

执行命令：
```powershell
Get-ChildItem static\js\*.js | ForEach-Object { node -c $_.FullName; Write-Host "$($_.Name): syntax OK" }
```
**结果**：`api.js`, `app.js`, `copilot.js`, `drafts.js`, `editor.js`, `sync.js` 全部语法合规，零语法报错。

### 7.4 Rustdoc 文档生成构建

执行命令：
```bash
cargo doc --no-deps
```
**结果**：成功编译并在 `target/doc/gemini_markdown_cloud_editor/index.html` 生成完整 HTML 代码文档，零 Warning。

---

## 8. AI 功能说明 (可选扩展)

Gemini 协同伴写为系统附加的辅助创作功能，不属于 Project 10 核心考核指标。

### 8.1 配置与模型参数
- 环境变量：
  - `GEMINI_API_KEY`：Google AI Studio API Key（可选）。
  - `GEMINI_MODEL`：模型标识，默认为 `gemini-2.0-flash`。

### 8.2 在线模式 vs 离线仿真模式
- **在线模式**：若在 `.env` 中配置了有效的 `GEMINI_API_KEY`，服务端向 Google 官方 REST API 发起请求获取实际生成结果。
- **离线仿真模式 (默认/回退)**：若未配置密钥或网络不通，系统自动启用内置的高保真离线仿真引擎，通过确定性规则与启发式算法完成 Markdown 续写、润色、摘要、Mermaid 流程图和 KaTeX 公式生成。
- **客观验证说明**：当前测试环境未注入付费真实的 Google 官方密钥，**在线真实请求标记为“未在线验证”**；离线高保真模式与全部 6 个 AI 路由端点已在 `tests/ai_api_tests.rs` 中完整验证通过。

---

## 9. 常见问题和已知限制

1. **服务启动报 `MissingEnv("JWT_SECRET")` 或 `WeakJwtSecret`**：
   - 产生原因：未在 `.env` 中设置 `JWT_SECRET`，或者所配密钥长度小于 32 字节。
   - 解决办法：在 `.env` 中配置至少 32 字符的随机安全字符串。
2. **PostgreSQL 模式启动失败 `Failed to connect to database`**：
   - 产生原因：PostgreSQL 服务未启动、端口不通或连接串中用户名密码错误。
   - 解决办法：确保本地 PostgreSQL 服务正在运行且对应的数据库（如 `mce_test`）已预先建立。
3. **前端状态显示 `auth_required` 并提示重新登录**：
   - 产生原因：JWT 令牌已过期（默认有效期 3600 秒）或签名已失效。
   - 解决办法：重新输入凭据登录，客户端已对 401 停止盲目重试，确保安全退出。
4. **浏览器隐身模式或配额耗尽下提示“本地备份失败”**：
   - 产生原因：浏览器禁用了 LocalStorage 或存储容量达到上限。
   - 解决办法：系统明确向用户提示备份失败，但内存数据依然保留，不会阻断云端保存。
5. **并发修改提示版本冲突 (HTTP 409)**：
   - 产生原因：其他会话已向云端提交了更新的版本。
   - 解决办法：根据模态框选择“用本地覆盖”或“重新拉取云端”，系统不会发生静默数据覆盖。

---

## 10. 课程要求完成情况

对照老师 Project 10 原始任务书要求与当前交付物状态：

| 验收项 | 原始任务要求 | 当前状态 | 证明材料与位置 |
| :--- | :--- | :---: | :--- |
| **后端框架** | Rust HTTP 后端 (Actix-web 或 Rocket) | **已完成** | Actix-web 4 (`src/main.rs`, `src/lib.rs`) |
| **文档 API** | 完整的创建、读取、更新、删除 RESTful API | **已完成** | 见 `src/routes/documents.rs`, `tests/document_tests.rs` |
| **身份认证** | 基于 JWT 的用户认证机制 | **已完成** | Argon2id + HS256 JWT (`src/auth/`, `tests/auth_tests.rs`) |
| **数据库** | 通过 sqlx 持久化到 **PostgreSQL** | **已完成** | `tests/postgres_tests.rs` 在真实 PostgreSQL 17 上验证通过 |
| **前端界面** | 双栏 HTML/CSS/JS 界面，左侧编辑右侧实时预览 | **已完成** | `static/index.html`, `static/js/editor.js` |
| **自动保存** | 每隔数秒自动保存且不丢失用户编辑焦点 | **已完成** | `static/js/sync.js`, `tests/frontend/sync_engine.test.js` |
| **代码文档** | 完整的 Rustdoc 文档 | **已完成** | `cargo doc --no-deps` 成功构建无警告 |
| **提交记录** | Git 托管，有意义且持续的提交记录 | **已完成** | `git log` 包含规范递进的工程提交历史 |
| **最终技术报告** | 覆盖设计、算法、API 设计、数据库结构等独立报告 | **暂缓** | *按照当前指令，本次任务明确暂缓交付独立报告* |
| **演讲 PPT** | 项目展示 PPT 与现场演示汇报材料 | **暂缓** | *按照当前指令，本次任务明确暂缓交付演示 PPT* |
