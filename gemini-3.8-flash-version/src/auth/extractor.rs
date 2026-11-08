//! Actix-web 用户认证提取器 (FromRequest)

use crate::auth::token::verify_token;
use crate::error::AppError;
use crate::state::AppState;
use actix_web::dev::Payload;
use actix_web::{FromRequest, HttpRequest, web};
use std::future::{Future, ready};
use std::pin::Pin;
use uuid::Uuid;

/// 已通过 JWT 校验的认证用户主体
#[derive(Debug, Clone)]
pub struct AuthenticatedUser {
    /// 用户唯一 ID
    pub user_id: Uuid,
    /// 用户名
    pub username: String,
}

impl FromRequest for AuthenticatedUser {
    type Error = AppError;
    type Future = Pin<Box<dyn Future<Output = Result<Self, Self::Error>>>>;

    fn from_request(req: &HttpRequest, _payload: &mut Payload) -> Self::Future {
        let auth_header = req.headers().get("Authorization");
        let app_state = req.app_data::<web::Data<AppState>>();

        let result = (|| -> Result<Self, AppError> {
            let Some(state) = app_state else {
                return Err(AppError::Internal(anyhow::anyhow!("App state missing")));
            };

            let Some(header_val) = auth_header else {
                return Err(AppError::Unauthorized(
                    "Missing Authorization header".to_string(),
                ));
            };

            let Ok(header_str) = header_val.to_str() else {
                return Err(AppError::Unauthorized(
                    "Invalid Authorization header format".to_string(),
                ));
            };

            let token = if let Some(stripped) = header_str.strip_prefix("Bearer ") {
                stripped.trim()
            } else {
                return Err(AppError::Unauthorized(
                    "Authorization scheme must be Bearer".to_string(),
                ));
            };

            let claims = verify_token(token, &state.config.jwt_secret)?;
            let user_id = Uuid::parse_str(&claims.sub).map_err(|_| {
                AppError::Unauthorized("Invalid user UUID format in token claims".to_string())
            })?;

            Ok(Self {
                user_id,
                username: claims.username,
            })
        })();

        Box::pin(ready(result))
    }
}
