//! 文档数据模型。
//!
//! 对应 PostgreSQL 中的 `documents` 表。定义全量行实体与摘要行实体。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 数据库 `documents` 表完整行实体。
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow, Serialize, Deserialize)]
pub struct Document {
    /// 文档唯一主键 UUID。
    pub id: Uuid,
    /// 文档所属用户的 UUID（外键关联 users.id）。
    pub owner_id: Uuid,
    /// 文档标题（已去首尾空白，1–255 个 Unicode 标量值）。
    pub title: String,
    /// Markdown 正文内容（最大 262,144 字节）。
    pub content: String,
    /// 乐观锁版本号（初建为 1，每次更新原子自增 1）。
    pub version: i32,
    /// 创建时间（UTC）。
    pub created_at: DateTime<Utc>,
    /// 最后更新时间（UTC）。
    pub updated_at: DateTime<Utc>,
}

/// 文档列表摘要实体。
///
/// 排除正文（`content`）字段，用于轻量化列表查询与分页展示。
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow, Serialize, Deserialize)]
pub struct DocumentSummary {
    /// 文档唯一主键 UUID。
    pub id: Uuid,
    /// 文档所属用户的 UUID。
    pub owner_id: Uuid,
    /// 文档标题。
    pub title: String,
    /// 当前版本号。
    pub version: i32,
    /// 创建时间（UTC）。
    pub created_at: DateTime<Utc>,
    /// 最后更新时间（UTC）。
    pub updated_at: DateTime<Utc>,
}
