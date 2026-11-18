//! 文档相关的数据传输对象（DTO）。
//!
//! 严格对接 `API.md` §3.3–§3.6 契约。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::document::{Document, DocumentSummary};

/// 格式化时间戳为 RFC 3339 UTC 字符串（秒精度，以 `Z` 结尾）。
#[must_use]
pub fn format_timestamp(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ==================== 请求 DTO ====================

/// `GET /api/v1/documents` 分页查询参数。
#[derive(Debug, Clone, Deserialize)]
pub struct ListDocumentsQuery {
    /// 每页返回记录数。默认 20，合法范围 1..=100。
    pub limit: Option<i64>,
    /// 分页偏移量。默认 0，必须 >= 0。
    pub offset: Option<i64>,
}

/// `POST /api/v1/documents` 创建文档请求体。
#[derive(Debug, Clone, Deserialize)]
pub struct CreateDocumentRequest {
    /// 文档标题。
    ///
    /// 省略时由服务端默认为 `"未命名文档"`；若显式提供，去首尾空白后长度必须在 1..=255 字符内。
    pub title: Option<String>,
    /// Markdown 正文内容。
    ///
    /// 省略时默认为空字符串；最大 262,144 字节。
    pub content: Option<String>,
}

/// `PUT /api/v1/documents/{id}` 更新文档请求体。
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateDocumentRequest {
    /// 新文档标题。必填，去首尾空白后为 1..=255 个 Unicode 标量值。
    pub title: String,
    /// 新 Markdown 正文内容。必填，最大 262,144 字节。
    pub content: String,
    /// 客户端持有的期望版本号（用于乐观锁校验）。必填，必须 >= 1。
    pub expected_version: i32,
}

/// `DELETE /api/v1/documents/{id}` 删除文档查询参数。
#[derive(Debug, Clone, Deserialize)]
pub struct DeleteDocumentQuery {
    /// 期望删除的版本号。必填，必须 >= 1。
    pub expected_version: i32,
}

// ==================== 响应 DTO ====================

/// 单篇文档详情响应体（包含完整正文）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentResponse {
    /// 文档唯一主键 UUID。
    pub id: Uuid,
    /// 文档标题。
    pub title: String,
    /// Markdown 正文。
    pub content: String,
    /// 当前版本号。
    pub version: i32,
    /// 创建时间（RFC 3339 UTC）。
    pub created_at: String,
    /// 最后更新时间（RFC 3339 UTC）。
    pub updated_at: String,
}

impl From<Document> for DocumentResponse {
    fn from(doc: Document) -> Self {
        Self {
            id: doc.id,
            title: doc.title,
            content: doc.content,
            version: doc.version,
            created_at: format_timestamp(doc.created_at),
            updated_at: format_timestamp(doc.updated_at),
        }
    }
}

/// 文档列表摘要响应体（不包含正文字段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSummaryResponse {
    /// 文档唯一主键 UUID。
    pub id: Uuid,
    /// 文档标题。
    pub title: String,
    /// 当前版本号。
    pub version: i32,
    /// 创建时间（RFC 3339 UTC）。
    pub created_at: String,
    /// 最后更新时间（RFC 3339 UTC）。
    pub updated_at: String,
}

impl From<DocumentSummary> for DocumentSummaryResponse {
    fn from(summary: DocumentSummary) -> Self {
        Self {
            id: summary.id,
            title: summary.title,
            version: summary.version,
            created_at: format_timestamp(summary.created_at),
            updated_at: format_timestamp(summary.updated_at),
        }
    }
}

/// 文档列表包装响应体。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentListResponse {
    /// 文档摘要列表。
    pub documents: Vec<DocumentSummaryResponse>,
    /// 每页数量限制。
    pub limit: i64,
    /// 偏移量。
    pub offset: i64,
    /// 该用户所拥有的文档总数。
    pub total: i64,
}

/// 更新文档成功时的响应体（不回传正文）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateDocumentResponse {
    /// 文档唯一主键 UUID。
    pub id: Uuid,
    /// 更新后的新版本号（原版本 + 1）。
    pub version: i32,
    /// 更新时间戳（RFC 3339 UTC）。
    pub updated_at: String,
}
