//! 认证业务层 (严格对齐 API 规范 §05 输入校验与防时序攻击)

use crate::auth::{create_token, hash_password, verify_dummy, verify_password};
use crate::dto::{AuthResponse, LoginRequest, RegisterRequest, UserSummary};
use crate::error::AppError;
use crate::repositories::UserRepo;
use crate::state::AppState;
use uuid::Uuid;

/// 认证服务
pub struct AuthService;

impl AuthService {
    /// 校验并标准化用户名
    pub fn normalize_username(raw: &str) -> Result<String, AppError> {
        let trimmed = raw.trim().to_lowercase();
        if trimmed.len() < 3 || trimmed.len() > 32 {
            return Err(AppError::BadRequest(
                "Username length must be between 3 and 32 characters".to_string(),
            ));
        }

        let is_valid = trimmed
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');

        if !is_valid {
            return Err(AppError::BadRequest(
                "Username can only contain alphanumeric characters, underscores, and hyphens"
                    .to_string(),
            ));
        }

        Ok(trimmed)
    }

    /// 校验明文密码 (按 UTF-8 字节数计 12..=128，绝不去首尾空白)
    pub fn validate_password(password: &str) -> Result<(), AppError> {
        let byte_len = password.len();
        if !(12..=128).contains(&byte_len) {
            return Err(AppError::BadRequest(format!(
                "Password must be between 12 and 128 UTF-8 bytes, got {byte_len} bytes"
            )));
        }
        Ok(())
    }

    /// 用户注册并签发 JWT
    pub async fn register(
        state: &AppState,
        req: RegisterRequest,
    ) -> Result<AuthResponse, AppError> {
        let username = Self::normalize_username(&req.username)?;
        Self::validate_password(&req.password)?;

        let password_hash = hash_password(&req.password)?;
        let user_id = Uuid::new_v4();

        let user = UserRepo::create_user(&state.db, user_id, &username, &password_hash).await?;

        let token = create_token(
            user.id,
            &user.username,
            &state.config.jwt_secret,
            state.config.jwt_ttl_secs,
        )?;

        Ok(AuthResponse {
            token,
            expires_in: state.config.jwt_ttl_secs,
            user: UserSummary {
                id: user.id,
                username: user.username,
                created_at: user.created_at,
            },
        })
    }

    /// 用户登录并签发 JWT (恒定运算时间防御)
    pub async fn login(state: &AppState, req: LoginRequest) -> Result<AuthResponse, AppError> {
        let username = req.username.trim().to_lowercase();

        let maybe_user = UserRepo::find_by_username(&state.db, &username).await?;

        match maybe_user {
            Some(user) => {
                if !verify_password(&req.password, &user.password_hash) {
                    return Err(AppError::Unauthorized(
                        "Invalid username or password".to_string(),
                    ));
                }

                let token = create_token(
                    user.id,
                    &user.username,
                    &state.config.jwt_secret,
                    state.config.jwt_ttl_secs,
                )?;

                Ok(AuthResponse {
                    token,
                    expires_in: state.config.jwt_ttl_secs,
                    user: UserSummary {
                        id: user.id,
                        username: user.username,
                        created_at: user.created_at,
                    },
                })
            }
            None => {
                // 用户不存在时执行恰好一次虚拟 Argon2 校验，消耗相同 CPU 周期
                verify_dummy(&req.password);
                Err(AppError::Unauthorized(
                    "Invalid username or password".to_string(),
                ))
            }
        }
    }
}
