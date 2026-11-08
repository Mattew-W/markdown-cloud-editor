//! 文档实体模型 (严格对齐 PROJECT_SPEC.md §2.3 范围)

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 文档实体 (严格 7 字段)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    /// 文档 ID
    pub id: Uuid,
    /// 文档所有者 ID
    pub owner_id: Uuid,
    /// 文档标题 (1-255 标量字符)
    pub title: String,
    /// 文档 Markdown 正文 (最大 256KiB)
    pub content: String,
    /// 乐观锁版本号 (从 1 起始单调自增)
    pub version: i32,
    /// 创建时间 (UTC)
    pub created_at: DateTime<Utc>,
    /// 最后更新时间 (UTC)
    pub updated_at: DateTime<Utc>,
}

/// 文档列表摘要条目 (不含正文，对齐 API.md §3.3)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSummary {
    /// 文档 ID
    pub id: Uuid,
    /// 文档标题
    pub title: String,
    /// 乐观锁版本号
    pub version: i32,
    /// 创建时间
    pub created_at: DateTime<Utc>,
    /// 更新时间
    pub updated_at: DateTime<Utc>,
}
