//! 认证相关 DTO

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 用户注册请求
#[derive(Debug, Clone, Deserialize)]
pub struct RegisterRequest {
    /// 用户名
    pub username: String,
    /// 原始密码
    pub password: String,
}

/// 用户登录请求
#[derive(Debug, Clone, Deserialize)]
pub struct LoginRequest {
    /// 用户名
    pub username: String,
    /// 原始密码
    pub password: String,
}

/// 用户对外安全信息 (不含 password_hash)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSummary {
    /// 用户 ID
    pub id: Uuid,
    /// 用户名
    pub username: String,
    /// 注册时间 (UTC)
    pub created_at: DateTime<Utc>,
}

/// 认证成功响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    /// JWT Bearer 令牌
    pub token: String,
    /// 令牌有效期 (秒)
    pub expires_in: i64,
    /// 用户信息
    pub user: UserSummary,
}
