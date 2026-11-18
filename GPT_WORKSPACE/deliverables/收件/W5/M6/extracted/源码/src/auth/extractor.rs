//! 身份提取器：从 HTTP 请求中提取已认证用户。
//!
//! 实现 Actix-web 的 [`FromRequest`] 特征。路由处理器中可直接声明
//! `user: AuthenticatedUser` 参数，统一鉴权与提取 `owner_id`。

use std::future::{Ready, ready};

use actix_web::dev::Payload;
use actix_web::{FromRequest, HttpRequest, web};
use uuid::Uuid;

use crate::auth::token::decode_token;
use crate::config::Config;
use crate::error::AppError;

/// 已通过 JWT 验签的当前用户身份上下文。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedUser {
    /// 用户的唯一标识 UUID（来自 JWT 的 `sub` 声明）。
    pub id: Uuid,
    /// 用户的用户名（来自 JWT 的 `username` 声明）。
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

        // 支持 "Bearer " 与 "bearer " 前缀（RFC 7235）。
        let token = header
            .strip_prefix("Bearer ")
            .or_else(|| header.strip_prefix("bearer "))
            .map(str::trim);

        let Some(token) = token.filter(|t| !t.is_empty()) else {
            return ready(Err(AppError::Unauthorized));
        };

        let Some(config) = req.app_data::<web::Data<Config>>() else {
            return ready(Err(AppError::internal(anyhow::anyhow!(
                "未在应用状态中找到全局 Config"
            ))));
        };

        match decode_token(token, config.jwt_secret()) {
            Ok(claims) => {
                let Ok(user_id) = claims.sub.parse::<Uuid>() else {
                    return ready(Err(AppError::Unauthorized));
                };
                ready(Ok(Self {
                    id: user_id,
                    username: claims.username,
                }))
            }
            Err(_) => ready(Err(AppError::Unauthorized)),
        }
    }
}
