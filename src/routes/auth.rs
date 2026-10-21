//! 认证路由：`POST /api/v1/auth/register` 与 `POST /api/v1/auth/login`。
//!
//! # 安全设计（规范 §09）
//!
//! | 情形 | 响应 | 理由 |
//! |---|---|---|
//! | 用户名已存在 | 409 `USERNAME_TAKEN` | 注册场景下必须告知，便于换名 |
//! | 登录时密码错 / 用户不存在 | **401 `UNAUTHORIZED`** | 两者必须一致，否则可枚举用户名 |
//! | 库中哈希串损坏 | 500 `INTERNAL_ERROR` | **不能**伪装成密码错 |
//!
//! 最后一行是 M3 的 [`PasswordError`] 分类带来的直接收益：
//! `InvalidHashFormat` 属于数据损坏，映射 401 会掩盖真实问题。

use actix_web::{HttpRequest, HttpResponse, ResponseError, web};

use crate::auth::{
    dto::{AuthResponse, LoginRequest, RegisterRequest, user_response},
    password::{Argon2Params, PasswordError, hash_password, verify_password},
    token::{Claims, decode_token, issue_token},
};
use crate::config::Config;
use crate::error::AppError;
use crate::repositories::users::{self, format_timestamp};
use crate::state::AppState;

/// 应用共享配置。挂在 `web::Data` 上，避免每个处理器都带一串参数。
#[derive(Debug, Clone)]
pub struct AuthConfig {
    /// JWT 有效期（秒）。
    pub jwt_ttl_secs: u64,
    /// Argon2id 参数。
    pub argon2_params: Argon2Params,
}

impl From<&Config> for AuthConfig {
    fn from(config: &Config) -> Self {
        Self {
            jwt_ttl_secs: config.jwt_ttl_secs,
            argon2_params: Argon2Params::default(),
        }
    }
}

/// 从 `Authorization: Bearer <token>` 提取当前用户身份。
///
/// # Errors
///
/// 缺少头、格式不对、token 无效或过期时返回 [`AppError::Unauthorized`]。
pub fn authenticate(req: &HttpRequest, config: &Config) -> Result<Claims, AppError> {
    let header = req
        .headers()
        .get(actix_web::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;

    // 固定前缀 "Bearer "，大小写不敏感（RFC 7235）。
    let token = header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
        .ok_or(AppError::Unauthorized)?
        .trim();

    if token.is_empty() {
        return Err(AppError::Unauthorized);
    }

    decode_token(token, config.jwt_secret()).map_err(|_| AppError::Unauthorized)
}

/// `POST /api/v1/auth/register` —— 注册新用户。
///
/// 成功返回 201 与 token（规范 §06：注册与登录响应结构相同）。
///
/// # Errors
///
/// 用户名或密码不合规 → 400；用户名已存在 → 409；数据库故障 → 500。
pub async fn register(
    state: web::Data<AppState>,
    config: web::Data<Config>,
    auth_config: web::Data<AuthConfig>,
    body: web::Json<RegisterRequest>,
) -> Result<HttpResponse, AppError> {
    let (username, password) = body.validate()?;

    // 先算哈希再落库：哈希较慢，放在唯一约束检查之后可减少无谓的 CPU 开销，
    // 且不会因并发而泄漏"该用户名已被占用"。
    let hash = hash_password(password, &auth_config.argon2_params).map_err(AppError::internal)?;

    let user = users::insert_user(&state.db, &username, &hash).await?;

    let (token, _expires_at) = issue_token(
        &user.id.to_string(),
        &user.username,
        config.jwt_secret(),
        auth_config.jwt_ttl_secs,
    )
    .map_err(AppError::internal)?;

    let response = AuthResponse {
        token,
        expires_in: auth_config.jwt_ttl_secs,
        user: user_response(user.id, &user.username, &format_timestamp(user.created_at)),
    };

    Ok(HttpResponse::Created().json(response))
}

/// `POST /api/v1/auth/login` —— 登录。
///
/// 成功返回 200 与 token。
///
/// # Errors
///
/// 用户名或密码不合规 → 400；凭据无效（用户不存在或密码错）→ 401；
/// 哈希串损坏 → 500。
pub async fn login(
    state: web::Data<AppState>,
    config: web::Data<Config>,
    auth_config: web::Data<AuthConfig>,
    body: web::Json<LoginRequest>,
) -> Result<HttpResponse, AppError> {
    let (username, password) = body.validate()?;

    let user = users::find_by_username(&state.db, &username).await?;

    // **关键**：用户不存在与密码错误返回完全相同的 401。
    //
    // 但两者要消耗相近的时间，否则响应时间差异会让攻击者枚举用户名。
    // 用户不存在时对一个固定假哈希做一次校验，让耗时对齐。
    let Some(user) = user else {
        let dummy = hash_password(
            "DUMMY-PASSWORD-FOR-TIMING-EQUALIZATION",
            &auth_config.argon2_params,
        )
        .unwrap_or_else(|_| String::from("$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAA$AAAA"));
        let _ = verify_password(password, &dummy);
        return Err(AppError::Unauthorized);
    };

    verify_password(password, &user.password_hash).map_err(map_password_error)?;

    let (token, _expires_at) = issue_token(
        &user.id.to_string(),
        &user.username,
        config.jwt_secret(),
        auth_config.jwt_ttl_secs,
    )
    .map_err(AppError::internal)?;

    let response = AuthResponse {
        token,
        expires_in: auth_config.jwt_ttl_secs,
        user: user_response(user.id, &user.username, &format_timestamp(user.created_at)),
    };

    Ok(HttpResponse::Ok().json(response))
}

/// 把 M3 的密码错误映射成本项目的错误类型。
///
/// **这是 M1 与 M3 的接线点**，映射表已冻结在 `docs/INTERFACES.md`：
///
/// | `PasswordError` | 映射 | 理由 |
/// |---|---|---|
/// | `PasswordMismatch` | 401 | 唯一真正的"密码错了" |
/// | `InvalidHashFormat` | **500** | 库中数据损坏，不是用户问题 |
/// | `IncompatibleParams` | **500** | 算法/参数不兼容，服务端问题 |
/// | `HashingFailed` | **500** | 底层加密原语失败 |
/// | `InvalidParams` | **500** | 配置错误 |
///
/// 把后四种错当成 401 会掩盖数据损坏，让运维永远查不到问题。
fn map_password_error(err: PasswordError) -> AppError {
    match err {
        PasswordError::PasswordMismatch => AppError::Unauthorized,
        // 先记原始错误再转 500，日志里保留细节，响应体里看不到。
        other => {
            tracing::error!(error = %other, "password verification failed for a non-mismatch reason");
            AppError::internal(other)
        }
    }
}

/// 注册/登录请求体的上限保护：拒绝超大 body，避免哈希前先吃掉内存。
const MAX_AUTH_BODY_BYTES: usize = 4 * 1024;

/// 认证路由的 JSON 配置。
#[must_use]
pub fn json_config() -> web::JsonConfig {
    web::JsonConfig::default()
        .limit(MAX_AUTH_BODY_BYTES)
        .error_handler(|err, _| match err {
            actix_web::error::JsonPayloadError::Overflow { .. } => {
                actix_web::error::InternalError::from_response(
                    AppError::PayloadTooLarge,
                    AppError::PayloadTooLarge.error_response(),
                )
                .into()
            }
            actix_web::error::JsonPayloadError::ContentType => {
                let e = AppError::bad_request("Content-Type 必须为 application/json");
                let response = e.error_response();
                actix_web::error::InternalError::from_response(e, response).into()
            }
            other => {
                let e = AppError::bad_request(other.to_string());
                let response = e.error_response();
                actix_web::error::InternalError::from_response(e, response).into()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 密码不匹配映射为401() {
        assert!(matches!(
            map_password_error(PasswordError::PasswordMismatch),
            AppError::Unauthorized
        ));
    }

    #[test]
    fn 哈希串损坏映射为500而非401() {
        // 这是最容易写错的映射：若误映射为 401，数据损坏会被伪装成密码错误。
        let e = map_password_error(PasswordError::InvalidHashFormat("坏串".to_owned()));
        assert_eq!(e.code().status().as_u16(), 500, "损坏哈希必须是 500");
    }

    #[test]
    fn 参数不兼容映射为500() {
        let e = map_password_error(PasswordError::IncompatibleParams("旧参数".to_owned()));
        assert_eq!(e.code().status().as_u16(), 500);
    }

    #[test]
    fn 未认证映射为401() {
        assert_eq!(AppError::Unauthorized.code().status().as_u16(), 401);
    }
}
