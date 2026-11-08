//! 用户实体模型

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 用户实体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    /// 用户唯一标识
    pub id: Uuid,
    /// 用户名 (小写规范化)
    pub username: String,
    /// 密码哈希 (Argon2id)
    #[serde(skip_serializing)]
    pub password_hash: String,
    /// 创建时间
    pub created_at: DateTime<Utc>,
}
