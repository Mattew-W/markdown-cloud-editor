# 架构设计与系统规范 (Architecture Design)

> **版本**：1.0.0 (Gemini 3.8 Flash Edition)  
> **核心原则**：六层解耦、原子并发、绝对隔离、双引擎就绪、原生 AI 协同

---

## 1. 系统总体架构图

```mermaid
flowchart TD
    subgraph Client["前端客户端 (Browser SPA)"]
        UI["用户界面 (HTML/CSS)"]
        Sync["同步状态机 (SyncEngine)"]
        Editor["安全编辑器 (SafeMarkdownRenderer)"]
        Copilot["Gemini 3.8 Flash 交互控制器"]
        API_JS["统一网络出口 (ApiClient)"]
        Drafts[("本地离线草稿 (LocalStorage)")]

        UI <--> Editor
        UI <--> Copilot
        Editor --> Sync
        Sync <--> Drafts
        Sync --> API_JS
        Copilot --> API_JS
    end

    subgraph Server["后端服务 (Rust / Actix-Web)"]
        Route["HTTP 路由层 (Routes)"]
        MW["中间件 (RequestID / RateLimiter)"]
        AuthEx["JWT 身份提取器 (AuthenticatedUser)"]
        Service["业务编排层 (Services)"]
        Repo["数据仓储层 (Repositories)"]
        
        MW --> Route
        Route --> AuthEx
        AuthEx --> Service
        Service --> Repo
    end

    subgraph External["外部服务与数据存储"]
        DB[("数据库 (PostgreSQL 17 / SQLite)")]
        GeminiCloud["Google Gemini 3.8 Flash API"]
    end

    API_JS -->|REST API / Bearer JWT| MW
    Repo -->|SQLx (Pool / Transaction)| DB
    Service -.->|HTTPS / API Key| GeminiCloud
```

---

## 2. 后端六层 Clean Architecture

为确保高内聚、低耦合，严禁跨层调用与循环依赖：

| 模块 | 职责定位 | 核心依赖与设计约束 |
|---|---|---|
| **1. `config`** | 环境变量读取与严格强校验 | 启动期必须校验 `JWT_SECRET` 熵值（≥ 32 字节），自动推导数据库引擎类型 |
| **2. `error`** | 全局统一错误与 HTTP 响应映射 | 统一构建 `{ error: { code, message, details, request_id } }`，除此类型外禁止随意构造 `HttpResponse` |
| **3. `auth`** | 密码哈希、JWT 颁发与提取器 | Argon2id 密码哈希，内置预计算虚拟哈希消除时序信道；HS256 校验 `iss`、`aud`、`exp`、`sub` |
| **4. `dto` / `models`** | 数据传输契约与数据库实体 | 严格区分对外暴露结构与内部持久化实体，保证数据安全性与序列化一致性 |
| **5. `repositories`** | 数据库底层 SQL 执行与原子锁 | 路由与服务层严禁直接编写 SQL；所有更新与删除必须带 `owner_id` 与 `version` |
| **6. `services`** | 业务逻辑编排与外部 API 调度 | 负责标题 Unicode 标量计数（1..255）、正文（≤ 256KiB）大小校验、Gemini 提示词拼装 |
| **7. `routes`** | HTTP 接口暴露与参数反序列化 | 限制 JSON 请求体 ≤ 2 MiB；参数格式错误统一拦截并转译为标准规范格式 |

---

## 3. 核心并发控制：原子乐观锁 (Optimistic Concurrency Control)

为了满足云同步编辑器在多端、多会话并发编辑时的绝对安全性，系统实施了严格的单条原子 SQL 更新策略：

### 3.1 为什么禁止“先读后写”？
传统模式下若采用：
```sql
-- 错误模式：存在严重竞态条件
SELECT version FROM documents WHERE id = ?;
-- 若此时另一个会话更新了数据库...
UPDATE documents SET content = ? WHERE id = ?; -- 静默覆盖他人内容！
```
这会导致严重的**丢失更新 (Lost Update)**。

### 3.2 本架构的原子 CAS 实现
在 `DocumentRepo::update_document_atomic` 中，严格执行：
```sql
UPDATE documents
SET title = $1, content = $2, version = version + 1, updated_at = $3
WHERE id = $4 AND owner_id = $5 AND version = $6;
```
- 若 `rows_affected == 1`：证明当前会话的版本匹配，版本原子递增为 `version + 1`，完成原子单记录更新。
- 若 `rows_affected == 0`：系统进一步执行查询：
  - 若记录不存在或 `owner_id` 不符，返回 `NotFound` (统一 404)。
  - 若记录存在且 `version != expected_version`，提取服务端最新的 `server_version`，向客户端返回 HTTP 409 `VERSION_CONFLICT`。

---

## 4. 双数据库引擎架构 (Dual-Engine Database)

为了兼顾**课程本地零依赖快速演示 (无需启动 Docker / PostgreSQL)** 与 **生产级部署要求**，后端通过 `DbPool` 枚举抽象实现了双引擎支持：

```rust
#[derive(Clone)]
pub enum DbPool {
    Sqlite(SqlitePool),
    Postgres(PgPool),
}
```

1. **SQLite 模式**：
   - 使用文件模式或内存模式（`:memory:` 供集成测试）。
   - UUID 采用 TEXT 存储，时间戳采用 RFC 3339 字符串，彻底消除跨平台差异。
2. **PostgreSQL 模式**：
   - 采用原生 `UUID` 类型与 `TIMESTAMPTZ`。
   - 带有 `gen_random_uuid()` 默认值与格式正则表达式检查约束（`chk_username_format`、`chk_content_size`）。

---

## 5. 安全设计与时序攻击防御

### 5.1 虚拟哈希防御时序枚举
当恶意攻击者尝试探测系统存在的用户名时，若在用户不存在时立即返回 401，耗时仅几微秒；而用户存在、密码错误时需耗费 Argon2 昂贵的哈希计算（约 100ms），攻击者即可通过响应时延遍历用户名。

本架构在 `AuthService::login` 中：
```rust
None => {
    // 注入预计算虚拟 Argon2id 哈希，运算周期完全对齐
    verify_dummy(&req.password);
    Err(AppError::Unauthorized("Invalid username or password".to_string()))
}
```
两者耗时完全一致，时序侧信道被物理抹除。

### 5.2 越权与多租户隔离
根据 API 规范 §01：
> “不存在或不属于本人，统一返回 404，且不泄露标题/版本/正文”。

无论是读取、更新还是删除，SQL 永远强制注入 `owner_id = current_user_id`。如果用户试图操作他人文档，系统统一返回 404，攻击者甚至无法刺探出该文档 ID 是否在数据库中真实存在。

---

## 6. 前端同步状态机与本地离线保护 (M1 `sync.js` + M6 `drafts.js`)

前端 `SyncEngine` 严格实现《docs/SYNC.md》规定的 **7 种标准状态**，采用 1.5s 防抖与 5.0s 最大等待，严格保证在飞请求限制为 1：
- `synced`：已与服务端完全同步，无未保存更改。
- `dirty`：检测到用户编辑，已触发本地草稿即时写入（零时延保护），等待防抖计时器。文案严格遵循禁令：“已在本地备份”，严禁展示“已同步”。
- `saving`：正在向云端发起 HTTP PUT 请求，带 10s `AbortController` 超时。
- `retry_wait`：遭遇临时网络故障或 5xx 异常，进入退避等待重试（保留本地草稿）。
- `auth_required`：遇到 401 认证失效，保留草稿并引导用户重新登录。
- `conflict`：服务端返回 409 `VERSION_CONFLICT`，进入冲突保护，供用户决策。
- `invalid`：标题非法或超长（400/413），阻断自动重试，等待用户修正。

### 6.1 草稿存储安全与跨用户隔离 (`drafts.js`)
- **Key 命名格式**：`markdown-editor:draft:{userId}:{docId}:{sessionId}`
- **会话生命周期**：每次打开/新建文档生成唯一 `sessionId`；云端保存成功后仅当 `(sessionId, localRevision, content)` 完全三元组匹配才执行安全清理，防止清空新输入。

---

## 7. XSS 安全防护与富文本渲染
编辑器预览区严格遵循《docs/ARCHITECTURE.md §3.4》安全防护链条：
```javascript
const rawHtml = window.marked.parse(markdownText);
const safeHtml = window.DOMPurify.sanitize(rawHtml);
previewElement.innerHTML = safeHtml;
```
本地 vendor 目录内嵌经过 SRI 与内容审计的 `marked.min.js` 与 `purify.min.js`，彻底杜绝 CDN 供应链劫持与存储型 XSS 漏洞。
