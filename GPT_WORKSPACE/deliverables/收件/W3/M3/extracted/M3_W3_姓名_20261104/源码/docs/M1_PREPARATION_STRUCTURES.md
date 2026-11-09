# M1 阶段 4/5 结构与接口预备设计书

| 项 | 值 |
| --- | --- |
| 文档状态 | **设计预备稿**（Staging & Preparation） |
| 编写日期 | 2026-10-23 |
| 责任方 | M1（项目负责人 / 架构与集成） |
| 涉及阶段 | **阶段 4**（文档 CRUD 与乐观锁）、**阶段 5**（自动保存同步状态机与系统集成） |
| 涉及模块 | `src/models/`、`src/auth/extractor.rs`、`src/dto/`、`src/repositories/document_repo.rs`、`src/services/`、`src/routes/documents.rs`、`frontend/js/sync.js` |
| 相关契约 | [`API.md`](API.md)、[`DATABASE.md`](DATABASE.md)、[`SYNC.md`](SYNC.md)、[`INTERFACES.md`](INTERFACES.md)、[`ARCHITECTURE.md`](ARCHITECTURE.md)、[`PROJECT_SPEC.md`](PROJECT_SPEC.md) |

---

## 0. 为什么需要这份预备文档

在本项目六人协作流程中：
- **M1** 负责工程骨架、仓储层、HTTP 路由、身份接线、`sync.js` 自动保存状态机、CI/E2E 及最终集成；
- **M2** 负责基础表结构与迁移脚本（已由 M1 落地为 `0001_init.sql` 并经真实 PostgreSQL 17 实测）；
- **M3** 负责 Argon2id 密码哈希与 JWT 逻辑（已由 M1 审定并迁入 `src/auth/`）；
- **M4** 负责文档输入校验练习（待交件，后续产出将对接至文档服务层）；
- **M5** 负责前端 UI 与编辑器渲染（阶段 5 对接）；
- **M6** 负责前端 API client 与本地草稿（`drafts.js` 已由 M1 按 C1–C9 契约重写就绪）。

为了使阶段 4（后端文档完整生命周期）与阶段 5（前端自动保存状态机）能够**无缝对接、一次成型**，避免因接口缺失、类型不一致或并发语义含糊导致二次返工，本文档预先冻结 M1 在后续阶段中要用到的全部核心数据结构、函数签名、数据库原子 SQL 与状态机模型。

---

## 1. 架构分层全貌（六层映射）

```
[前端界面]  editor.js (M5)  ⇄  sync.js 状态机 (M1)  ⇄  drafts.js 本地草稿 (M6/M1)
                                      │
                                      ▼  HTTP /api/v1/documents
[第 1 层]  中间件 & 提取器 : RequestIdLayer + AuthenticatedUser (FromRequest)
                                      │
[第 2 层]  路由层 (routes) : routes/documents.rs + routes/mod.rs (JsonConfig 2MiB)
                                      │  反序列化 DTO / 错误单点抛出 AppError
[第 3 层]  服务层 (services) : services/document_service.rs (纯业务校验、冲突判断)
                                      │
[第 4 层]  仓储层 (repos)   : repositories/document_repo.rs (唯一写 SQL / 原子乐观锁)
                                      │
[第 5 层]  模型层 (models)  : models/document.rs + models/user.rs (sqlx::FromRow)
                                      │
[第 6 层]  持久层 (database): PostgreSQL 17 (documents 表 / 复合索引 / CHECK 兜底)
```

---

## 2. 后端核心类型定义

### 2.1 模型层（`src/models/`）

模型层是数据库行在 Rust 内存中的直接映射，继承 `sqlx::FromRow`。模型层**不含 HTTP 或业务验证逻辑**。

```rust
// src/models/document.rs
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// documents 表完整实体行
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow, Serialize, Deserialize)]
pub struct Document {
    /// 文档唯一主键 UUID
    pub id: Uuid,
    /// 所属用户 ID（外键引用 users.id）
    pub owner_id: Uuid,
    /// 文档标题（1-255 Unicode 标量值）
    pub title: String,
    /// Markdown 原文字符串（<= 262,144 字节）
    pub content: String,
    /// 乐观锁版本号（每次更新 +1）
    pub version: i32,
    /// 创建时间（UTC）
    pub created_at: DateTime<Utc>,
    /// 最后更新时间（UTC）
    pub updated_at: DateTime<Utc>,
}

/// 文档列表摘要（排除庞大的 content 正文字段，降低网络与内存开销）
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow, Serialize, Deserialize)]
pub struct DocumentSummary {
    /// 文档唯一主键 UUID
    pub id: Uuid,
    /// 所属用户 ID
    pub owner_id: Uuid,
    /// 文档标题
    pub title: String,
    /// 当前版本号
    pub version: i32,
    /// 创建时间
    pub created_at: DateTime<Utc>,
    /// 最后更新时间
    pub updated_at: DateTime<Utc>,
}
```

```rust
// src/models/user.rs
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// users 表实体行
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow, Serialize, Deserialize)]
pub struct User {
    /// 用户唯一主键 UUID
    pub id: Uuid,
    /// 归一化后的用户名（小写、去空）
    pub username: String,
    /// Argon2id PHC 格式哈希串（严禁暴露给前端）
    pub password_hash: String,
    /// 注册时间（UTC）
    pub created_at: DateTime<Utc>,
}
```

---

### 2.2 身份提取器（`src/auth/extractor.rs`）

符合 Actix-web 规范的 `FromRequest` 提取器，将 `Authorization: Bearer <token>` 解析为强类型当前用户上下文。

```rust
// src/auth/extractor.rs
use std::future::{Ready, ready};
use actix_web::{FromRequest, HttpRequest, dev::Payload, web};
use uuid::Uuid;
use crate::auth::token::decode_token;
use crate::config::Config;
use crate::error::AppError;

/// 已通过 JWT 鉴权的当前用户上下文
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedUser {
    /// 从 claims.sub 解析出的用户 UUID
    pub id: Uuid,
    /// 从 claims.username 解析出的用户名
    pub username: String,
}

impl FromRequest for AuthenticatedUser {
    type Error = AppError;
    type Future = Ready<Result<Self, Self::Error>>;

    fn from_request(req: &HttpRequest, _payload: &mut Payload) -> Self::Future {
        let auth_header = req
            .headers()
            .get(actix_web::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok());

        let Some(header) = auth_header else {
            return ready(Err(AppError::Unauthorized));
        };

        let token = header
            .strip_prefix("Bearer ")
            .or_else(|| header.strip_prefix("bearer "))
            .map(str::trim);

        let Some(token) = token.filter(|t| !t.is_empty()) else {
            return ready(Err(AppError::Unauthorized));
        };

        let Some(config) = req.app_data::<web::Data<Config>>() else {
            return ready(Err(AppError::internal(anyhow::anyhow!("缺少全局 Config 数据注入"))));
        };

        match decode_token(token, config.jwt_secret()) {
            Ok(claims) => {
                let Ok(user_id) = claims.sub.parse::<Uuid>() else {
                    return ready(Err(AppError::Unauthorized));
                };
                ready(Ok(AuthenticatedUser {
                    id: user_id,
                    username: claims.preferred_username,
                }))
            }
            Err(_) => ready(Err(AppError::Unauthorized)),
        }
    }
}
```

---

### 2.3 数据传输对象（`src/dto/documents.rs`）

严格对接 [`API.md`](API.md) §3.3–§3.6 契约，字段全部采用 `snake_case`，时间输出为 RFC 3339 格式。

```rust
// src/dto/documents.rs
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ==================== 请求 DTO ====================

/// `GET /api/v1/documents` 分页查询参数
#[derive(Debug, Clone, Deserialize)]
pub struct ListDocumentsQuery {
    /// 每页数量，默认 20，合法范围 1..=100
    pub limit: Option<i64>,
    /// 偏移量，默认 0，必须 >= 0
    pub offset: Option<i64>,
}

/// `POST /api/v1/documents` 创建文档请求体
#[derive(Debug, Clone, Deserialize)]
pub struct CreateDocumentRequest {
    /// 标题。省略时默认为 "未命名文档"；若显式提供，去空后必须为 1..=255 字符，显式空串报 400
    pub title: Option<String>,
    /// 正文内容。省略时默认为空串；最大 262,144 字节
    pub content: Option<String>,
}

/// `PUT /api/v1/documents/{id}` 更新文档请求体
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateDocumentRequest {
    /// 标题。必填，去空后必须为 1..=255 字符
    pub title: String,
    /// 正文内容。必填，最大 262,144 字节
    pub content: String,
    /// 乐观锁期望版本号。必填，1..=2,147,483,647
    pub expected_version: i32,
}

/// `DELETE /api/v1/documents/{id}` 删除文档查询参数（走 Query）
#[derive(Debug, Clone, Deserialize)]
pub struct DeleteDocumentQuery {
    /// 期望版本号。必填，>= 1
    pub expected_version: i32,
}

// ==================== 响应 DTO ====================

/// 单篇文档详情响应体（含完整正文）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentResponse {
    pub id: Uuid,
    pub title: String,
    pub content: String,
    pub version: i32,
    pub created_at: String, // RFC 3339 UTC 字符串
    pub updated_at: String,
}

/// 列表项摘要响应体（不含正文）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSummaryResponse {
    pub id: Uuid,
    pub title: String,
    pub version: i32,
    pub created_at: String,
    pub updated_at: String,
}

/// 文档列表响应包装体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentListResponse {
    pub documents: Vec<DocumentSummaryResponse>,
    pub limit: i64,
    pub offset: i64,
    pub total: i64,
}

/// 文档更新响应体（不回传正文）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateDocumentResponse {
    pub id: Uuid,
    pub version: i32,
    pub updated_at: String,
}
```

---

### 2.4 仓储层：原子更新与分流（`src/repositories/document_repo.rs`）

仓储层是**全工程唯一允许编写 SQL 的位置**。所有查询必须在 SQL 中显式包含 `WHERE owner_id = $`，确保不同用户之间绝对物理隔离。

#### 乐观锁更新原子语义与两阶段分流

```rust
// src/repositories/document_repo.rs

/// 更新操作结果分流
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateDocOutcome {
    /// 更新成功，版本已递增
    Updated { version: i32, updated_at: chrono::DateTime<chrono::Utc> },
    /// 文档存在且属于本人，但版本已被其它会话推进（409 VERSION_CONFLICT）
    Conflict { server_version: i32 },
    /// 文档不存在或不属于当前用户（统一 404 NOT_FOUND）
    NotFound,
}

/// 删除操作结果分流
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteDocOutcome {
    /// 删除成功（204 NO_CONTENT）
    Deleted,
    /// 版本冲突（409 VERSION_CONFLICT）
    Conflict { server_version: i32 },
    /// 不存在或不属于本人（404 NOT_FOUND）
    NotFound,
}
```

#### SQL 规范与实现模式

1. **原子更新 SQL**：
   ```sql
   UPDATE documents
      SET title = $1,
          content = $2,
          version = version + 1,
          updated_at = CURRENT_TIMESTAMP
    WHERE id = $3 AND owner_id = $4 AND version = $5
   RETURNING version, updated_at;
   ```
2. **零行判定分流（Zero-row Bifurcation）**：
   若原子 `UPDATE` 返回 0 行，说明条件 `id AND owner_id AND version` 未能同时满足。此时立即执行一次轻量只读探测：
   ```sql
   SELECT version FROM documents WHERE id = $1 AND owner_id = $2;
   ```
   - 若查到记录，说明文档存在且属于该用户，但 `version != expected_version`，确认为**版本并发冲突**，返回 `Conflict { server_version: row.version }`；
   - 若未查到记录，说明该文档不存在，或属于其他用户（被 `owner_id` 过滤掉），返回 `NotFound`。调用层将其转换为标准 `404 NOT_FOUND`，**绝不返回 403**（防止泄露他人文档存在性）。

3. **分页与稳定排序 SQL**：
   ```sql
   SELECT id, owner_id, title, version, created_at, updated_at
     FROM documents
    WHERE owner_id = $1
    ORDER BY updated_at DESC, id DESC
    LIMIT $2 OFFSET $3;
   ```
   按 `(updated_at DESC, id DESC)` 排序，利用复合索引 `documents_owner_updated_idx`，保证分页切换无跳行。

---

### 2.5 服务层输入校验纯规则（`src/services/document_service.rs`）

对接 M4 业务逻辑规范，将校验规则收束为纯函数与无副作用检验：

| 字段 | 校验规则 | 错误映射 |
|---|---|---|
| **`title`** | 1. `trim()` 移除所有 Unicode 空白（涵盖 `\u{3000}`、`\u{00A0}` 等）；<br>2. 字符数判定：`trimmed.chars().count()` 在 `1..=255` 之间。 | 为空或 >255 返回 `AppError::field_error("title", ...)` (400) |
| **`content`** | 1. 允许空串；<br>2. 字节数判定：`content.len() <= 262,144`（256 KiB）。 | 超过 256 KiB 返回 `AppError::PayloadTooLarge` (413) |
| **`expected_version`** | 必须 `>= 1`。 | `< 1` 返回 `AppError::field_error("expected_version", ...)` (400) |
| **`limit` / `offset`** | `limit` 范围 `1..=100`；`offset >= 0`。 | 超界返回 `AppError::bad_request(...)` (400) |

---

## 3. 前端自动保存状态机接口设计（`frontend/js/sync.js`）

在阶段 5，M1 将在 `frontend/js/sync.js` 中构建核心保存协调器（`SyncCoordinator`），其与 `editor.js`（M5）和 `drafts.js`（M6）的协作拓扑如下：

```
 用户按键/修改标题
       │
       ▼
 sync.onInput({ title, content }) ──▶ local_revision++ ──▶ 状态变 dirty
       │                                                         │
       ├─▶ 约 250ms 写入 drafts.js (本地草稿备份，不改变 dirty 状态)
       │
       ▼
 调度计时器（防抖 1.5s / max-wait 5s）
       │
       ▼ 满足触发条件？
  有在途请求？─── 是 ──▶ 记录 pendingSnapshot（合并请求，不重复发）
       │ 否
       ▼
 发起 PUT /api/v1/documents/{id}（状态变 saving）
       │
   ┌───┴────────────────────────────┐
   ▼ 200 OK                         ▼ 409 Conflict
 更新 acked_revision               进入 conflict 状态
 若 acked_revision >= local_revision   停止自动重试，弹窗提示用户核对
   状态变 synced
 若在途期间有新输入 (pendingSnapshot)
   立即带最新快照再次发起保存
```

### 3.1 状态机 7 种状态

| 状态 | 含义 | 允许的转换目标 |
|---|---|---|
| `synced` | 当前修改已全部获云端确认（已同步） | `dirty` |
| `dirty` | 存在未保存修改 | `saving` |
| `saving` | 保存请求在途中 | `synced`、`dirty`、`retry_wait`、`auth_required`、`conflict`、`invalid` |
| `retry_wait` | 网络故障或 5xx，等待退避重试 | `saving`、`dirty`、`auth_required` |
| `auth_required`| 401 凭据失效，暂停自动重试 | `dirty`、`saving`（重新登录后） |
| `conflict` | 409 版本冲突，暂停自动重试 | `dirty`、`saving`（用户处理冲突后） |
| `invalid` | 400/413 内容不合规，暂停保存 | `dirty`（用户修改内容后） |

### 3.2 协调器导出的完整对象契约

```javascript
// frontend/js/sync.js
export function createSyncCoordinator({
  userId,
  docId,
  initialVersion,
  initialTitle,
  initialContent,
  apiClient,      // M6 提供的 API client (含 putDocument 等)
  draftStorage,   // M6 提供的 drafts.js 存储适配器
  onStatusChange, // 状态变更回调：(state, meta) => void
  onConflict,     // 冲突回调：({ serverVersion, cloudData }) => void
}) {
  return {
    onInput({ title, content }), // 编辑器输入触发
    saveNow(),                   // Ctrl+S 手动立即保存
    destroy(),                   // 离开文档时清理定时器与状态
    getState(),                  // 获取当前状态
    getBaseVersion(),            // 获取当前 base_version
  };
}
```

---

## 4. 验收矩阵（T01–T15）硬约束对照表

预备结构对项目权威验收矩阵的支撑关系：

| 编号 | 场景 | 通过标准 | 结构与逻辑保证机制 |
|---|---|---|---|
| **T01** | 注册登录与过期 token | 401，失效 token 被拒绝 | `AuthenticatedUser` 提取器内 `decode_token` 校验 `exp` |
| **T02** | 跨账号读取更新删除 | **全部 404**，原版本不变 | `document_repo` 的每条 SQL 均带 `WHERE owner_id = $`；零行判定分流统归 404 |
| **T03** | CRUD 与服务重启 | 完整生命周期正确 | `DocumentRepository` 五个端点落地 PostgreSQL 17 |
| **T04** | 相同版本并发更新 | **仅一次成功，其余 409** | 单条原子 `UPDATE ... WHERE version = expected_version`，零行探测判定为 `Conflict` |
| **T05** | 保存中继续输入 | 确认只覆盖发送快照，后续字符继续保存 | `SyncCoordinator` 的 `inFlightSnapshot` + `pendingSnapshot` 合并机制 |
| **T06** | A 文档切换到 B | 旧响应不污染新文档 | 切换文档必销毁旧协调器并新建 `edit_session_id` |
| **T07** | 已落库但响应丢失 | 能核对结果，不误报未保存 | 核对机制（GET 详情对比版本与哈希） |
| **T08** | 离线与恢复 | 草稿可恢复，未确认前不报已同步 | `drafts.js` 写入仅作为本地备份，不影响 `synced` / `dirty` 判定 |
| **T09** | 多窗口与删除冲突 | 草稿隔离，旧版本删除被拒绝 | 草稿键带 `sessionId`；`delete_atomic` 带版本原子检验 |
| **T10** | 本地存储失败 | 提示本地备份失败并允许下载 | `drafts.js` 拦截 `QuotaExceededError` / `SecurityError` 并安全降级 |
| **T11** | 401 409 413 429 5xx | 进入约定状态，避免无限重试 | `sync.js` 状态机根据 HTTP 状态码进入对应挂起状态 |
| **T12** | XSS 与恶意标题 | 脚本不执行，标题纯文本 | 前端 `textContent` 渲染标题，DOMPurify 净化 Markdown |
| **T13** | 焦点和中文输入 | 自动保存不重建编辑节点 | `sync.js` 保存成功仅推进内部版本指针，**严禁向编辑框写回内容** |
| **T14** | 输入和分页边界 | 空标题、超限正文、非法 UUID 正确报错 | `document_service` 纯函数严格执行 Unicode 字符数与 UTF-8 字节数校验 |
| **T15** | 完整演示 | 全流程可重复完成 | 上述结构严丝合缝组装后的端到端验证 |

---

## 5. 版本与归档记录

| 版本 | 日期 | 变更内容 | 记录人 |
| --- | --- | --- | --- |
| 1.0 | 2026-10-23 | 初始设计预备稿。完成模型层、提取器、DTO、仓储层乐观锁、服务层校验及前端状态机结构全貌梳理。 | M1 |
