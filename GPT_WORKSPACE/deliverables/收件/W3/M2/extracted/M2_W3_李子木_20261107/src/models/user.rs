//! 用户数据模型。
//!
//! 对应 PostgreSQL 中的 `users` 表实体映射。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 数据库 `users` 表实体行。
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow, Serialize, Deserialize)]
pub struct User {
    /// 用户唯一主键 UUID。
    pub id: Uuid,
    /// 归一化后的用户名（小写、去空白）。
    pub username: String,
    /// Argon2id PHC 格式哈希串（严禁暴露给前端客户端）。
    pub password_hash: String,
    /// 注册创建时间（UTC）。
    pub created_at: DateTime<Utc>,
}
