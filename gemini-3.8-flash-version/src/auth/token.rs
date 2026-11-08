//! HS256 JWT 令牌颁发与校验

use crate::error::AppError;
use chrono::Utc;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 标准 JWT Claims 结构体
#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    /// 主体 (User UUID 字符串)
    pub sub: String,
    /// 用户名
    pub username: String,
    /// 签发方
    pub iss: String,
    /// 受众
    pub aud: String,
    /// 签发时间戳
    pub iat: i64,
    /// 过期时间戳
    pub exp: i64,
}

/// 默认签发方
pub const ISSUER: &str = "gemini-editor";
/// 默认受众
pub const AUDIENCE: &str = "gemini-client";

/// 创建 JWT 令牌
pub fn create_token(
    user_id: Uuid,
    username: &str,
    secret: &str,
    ttl_secs: i64,
) -> Result<String, AppError> {
    let now = Utc::now().timestamp();
    let claims = Claims {
        sub: user_id.to_string(),
        username: username.to_string(),
        iss: ISSUER.to_string(),
        aud: AUDIENCE.to_string(),
        iat: now,
        exp: now + ttl_secs,
    };

    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(anyhow::anyhow!("JWT encoding failed: {e}")))
}

/// 解码并验证 JWT 令牌
pub fn verify_token(token: &str, secret: &str) -> Result<Claims, AppError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[AUDIENCE]);
    validation.validate_exp = true;

    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map(|data| data.claims)
    .map_err(|_| AppError::Unauthorized("Invalid or expired authentication token".to_string()))
}
