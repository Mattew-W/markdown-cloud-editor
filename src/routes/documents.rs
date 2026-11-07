//! 文档路由：`/api/v1/documents` 与 `/api/v1/documents/{id}`。
//!
//! # 契约要点（规范 §06，对应 `docs/API.md` §§2–5）
//!
//! | 方法 | 路径 | 成功码 | 关键约束 |
//! |---|---|---|---|
//! | GET | `/api/v1/documents` | 200 | 分页 + 稳定排序；**摘要不含正文** |
//! | POST | `/api/v1/documents` | 201 | **省略** `title` 才用默认标题；显式空标题 → 400 |
//! | GET | `/api/v1/documents/{id}` | 200 | 含正文；越权与不存在统一 404 |
//! | PUT | `/api/v1/documents/{id}` | 200 | `title`/`content`/`expected_version` **全必填**；成功只回 `id`/`version`/`updated_at` |
//! | DELETE | `/api/v1/documents/{id}` | 204 | `expected_version` 走**查询参数**；**无响应体** |
//!
//! ## 为什么更新与删除必须原子
//!
//! 自动保存是高频写入。若「先 SELECT 读版本、再执行不带版本条件的 UPDATE」，
//! 两个会话的写入会互相覆盖，且**没有任何错误**——这是静默丢数据。
//! 故服务层（`services::document_service`）一律走带 `owner_id` + `version`
//! 条件的单条 SQL，受影响行数为 0 时再分流为 409 或 404。
//!
//! ## 为什么越权与不存在都是 404
//!
//! 若越权返回 403，响应差异会泄露「该文档确实存在，只是不属于你」。
//! 统一 404 让攻击者无法区分二者。权限隔离在**数据访问层**即已物理完成
//! （所有 SQL 都带 `WHERE owner_id = $`），路由层只做语义映射。
//!
//! 本模块**不写 SQL**，只做：身份提取 → 调用服务层 → 映射响应体。
//!
//! # 错误映射
//!
//! 本模块的处理器只返回 `Result<HttpResponse, AppError>`，
//! 错误码与状态码的对应由 `error` 模块统一翻译，各处理器不自行构造错误响应。
//! 具体错误来源：
//!
//! | 情形 | 错误变体 | 状态码 |
//! |---|---|---|
//! | 分页参数越界、缺必填字段 | `AppError::BadRequest` | 400 |
//! | 标题空白或超长 | `AppError::BadRequest` | 400 |
//! | 正文超 262144 字节 | `AppError::PayloadTooLarge` | 413 |
//! | 凭据缺失或无效 | `AppError::Unauthorized` | 401 |
//! | 文档不存在或不属于本人 | `AppError::NotFound` | 404 |
//! | 版本已被他人推高 | `AppError::VersionConflict` | 409 |
//! | 数据库故障 | `AppError::Internal` | 500 |

use actix_web::{HttpResponse, web};
use uuid::Uuid;

use crate::auth::extractor::AuthenticatedUser;
use crate::dto::documents::{
    CreateDocumentRequest, DeleteDocumentQuery, DocumentListResponse, DocumentResponse,
    DocumentSummaryResponse, ListDocumentsQuery, UpdateDocumentRequest, UpdateDocumentResponse,
};
use crate::state::AppState;

/// `GET /api/v1/documents` —— 分页列出当前用户的文档。
///
/// 查询参数：`limit`（默认 20，范围 1..=100）、`offset`（默认 0，≥ 0）。
///
/// 排序为 `updated_at DESC, id DESC`，保证分页稳定。
/// 响应**不含正文**——列表只用于展示摘要。
///
/// # Errors
///
/// - 分页参数越界 → `AppError::BadRequest`（400）
/// - 数据库故障 → `AppError::Internal`（500）
pub async fn list_documents(
    state: web::Data<AppState>,
    user: AuthenticatedUser,
    query: web::Query<ListDocumentsQuery>,
) -> Result<HttpResponse, crate::error::AppError> {
    let (items, limit, offset, total) = crate::services::document_service::list_documents(
        &state.db,
        user.id,
        query.limit,
        query.offset,
    )
    .await?;

    let body = DocumentListResponse {
        documents: items
            .into_iter()
            .map(DocumentSummaryResponse::from)
            .collect(),
        limit,
        offset,
        total,
    };

    Ok(HttpResponse::Ok().json(body))
}

/// `POST /api/v1/documents` —— 创建新文档。
///
/// `title` **省略**时服务端默认 `"未命名文档"`；
/// **显式传入**空白标题 → 400（不是默认，这是刻意的区分）。
///
/// # Errors
///
/// - 标题空白或超长 → `AppError::BadRequest`（400）
/// - 正文超 262144 字节 → `AppError::PayloadTooLarge`（413）
/// - 数据库故障 → `AppError::Internal`（500）
pub async fn create_document(
    state: web::Data<AppState>,
    user: AuthenticatedUser,
    body: web::Json<CreateDocumentRequest>,
) -> Result<HttpResponse, crate::error::AppError> {
    let doc = crate::services::document_service::create_document(
        &state.db,
        user.id,
        body.title.as_deref(),
        body.content.as_deref(),
    )
    .await?;

    Ok(HttpResponse::Created().json(DocumentResponse::from(doc)))
}

/// `GET /api/v1/documents/{id}` —— 获取单篇文档详情（含正文）。
///
/// # Errors
///
/// - 文档不存在**或**不属于当前用户 → `AppError::NotFound`（404，二者不可区分）
/// - 数据库故障 → `AppError::Internal`（500）
pub async fn get_document(
    state: web::Data<AppState>,
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, crate::error::AppError> {
    let id = path.into_inner();
    let doc = crate::services::document_service::get_document(&state.db, id, user.id).await?;

    Ok(HttpResponse::Ok().json(DocumentResponse::from(doc)))
}

/// `PUT /api/v1/documents/{id}` —— 更新文档（乐观锁）。
///
/// 请求体三字段**全部必填**：`title`、`content`、`expected_version`。
/// 成功只返回 `id` / `version` / `updated_at`，**不回传正文**
/// ——正文可能很大，且调用方通常已持有本地副本。
///
/// 语义是**整体替换**，不是 PATCH：未提供的字段不会被保留。
///
/// # Errors
///
/// - 缺字段或字段非法 → `AppError::BadRequest`（400）
/// - 正文超限 → `AppError::PayloadTooLarge`（413）
/// - 版本已被他人推高 → `AppError::VersionConflict`（409，带 `server_version`）
/// - 文档不存在**或**不属于当前用户 → `AppError::NotFound`（404）
pub async fn update_document(
    state: web::Data<AppState>,
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    body: web::Json<UpdateDocumentRequest>,
) -> Result<HttpResponse, crate::error::AppError> {
    let id = path.into_inner();
    let (version, updated_at) = crate::services::document_service::update_document(
        &state.db,
        id,
        user.id,
        &body.title,
        &body.content,
        body.expected_version,
    )
    .await?;

    let response = UpdateDocumentResponse {
        id,
        version,
        updated_at: crate::dto::documents::format_timestamp(updated_at),
    };

    Ok(HttpResponse::Ok().json(response))
}

/// `DELETE /api/v1/documents/{id}` —— 删除文档（乐观锁）。
///
/// `expected_version` 走**查询参数**而非请求体——删除没有请求体。
///
/// 成功返回 **204 且无响应体**。
///
/// # Errors
///
/// - 缺少 `expected_version` → `AppError::BadRequest`（400）
/// - 版本不匹配 → `AppError::VersionConflict`（409，带 `server_version`）
/// - 文档不存在**或**不属于当前用户 → `AppError::NotFound`（404）
pub async fn delete_document(
    state: web::Data<AppState>,
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    query: web::Query<DeleteDocumentQuery>,
) -> Result<HttpResponse, crate::error::AppError> {
    let id = path.into_inner();
    crate::services::document_service::delete_document(
        &state.db,
        id,
        user.id,
        query.expected_version,
    )
    .await?;

    Ok(HttpResponse::NoContent().finish())
}
