//! 文档相关 DTO (严格对齐 API.md §03)

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 创建文档请求
#[derive(Debug, Clone, Deserialize)]
pub struct CreateDocumentRequest {
    /// 标题 (可选，未指定时默认为"未命名文档"，显式空串报错 400)
    pub title: Option<String>,
    /// 内容 (可选，最大 262144 字节)
    pub content: Option<String>,
}

/// 更新文档请求 (带乐观锁)
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateDocumentRequest {
    /// 标题 (必填)
    pub title: String,
    /// 正文 (必填，最大 262144 字节)
    pub content: String,
    /// 期望的当前版本号 (必填，乐观并发控制)
    pub expected_version: i32,
}

/// 删除文档查询参数
#[derive(Debug, Clone, Deserialize)]
pub struct DeleteDocumentQuery {
    /// 期望版本号 (乐观并发控制)
    pub expected_version: i32,
}

/// 文档列表分页查询参数
#[derive(Debug, Clone, Deserialize)]
pub struct DocumentListQuery {
    /// 分页大小 (默认 20，范围 1..=100)
    pub limit: Option<i64>,
    /// 偏移量 (默认 0，>= 0)
    pub offset: Option<i64>,
}

/// 单篇文档完整响应 (含正文)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentResponse {
    /// 文档 ID
    pub id: Uuid,
    /// 标题
    pub title: String,
    /// 正文
    pub content: String,
    /// 版本号
    pub version: i32,
    /// 创建时间
    pub created_at: DateTime<Utc>,
    /// 更新时间
    pub updated_at: DateTime<Utc>,
}

/// 文档更新成功响应 (不回传正文以节约带宽，对齐 API.md §3.5)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateDocumentResponse {
    /// 文档 ID
    pub id: Uuid,
    /// 新版本号
    pub version: i32,
    /// 更新时间
    pub updated_at: DateTime<Utc>,
}

/// 列表条目摘要 (不含正文，对齐 API.md §3.3)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSummaryResponse {
    /// 文档 ID
    pub id: Uuid,
    /// 标题
    pub title: String,
    /// 版本号
    pub version: i32,
    /// 创建时间
    pub created_at: DateTime<Utc>,
    /// 更新时间
    pub updated_at: DateTime<Utc>,
}

/// 分页文档列表响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentListResponse {
    /// 文档摘要列表
    pub documents: Vec<DocumentSummaryResponse>,
    /// 当前分页上限
    pub limit: i64,
    /// 当前分页偏移
    pub offset: i64,
    /// 结果总数
    pub total: i64,
}
