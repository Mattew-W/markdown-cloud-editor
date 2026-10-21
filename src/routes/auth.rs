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
//!
//! # 时序与线程模型（两处都必须处理，只改一处仍会漏信号）
//!
//! 1. **用户名枚举的时序信号**：用户不存在时若"现算一次哈希、再校验一次"，
//!    成本约为真实路径的两倍，反而**制造出**本该消除的差异。
//!    故用 `dummy_hash()` 在进程启动后预计算一次，两种分支都只做**恰好一次**校验。
//! 2. **阻塞工作线程**：Argon2id 是内存硬度运算，同步执行会卡住 Actix worker，
//!    使该 worker 上的无关请求无法推进。处理器写成 `async` 并不能卸载这段计算，
//!    必须显式交给 `blocking::run` 受限线程池。

use std::sync::OnceLock;

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

/// 用于把 Argon2 运算移出 Actix 工作线程的受限阻塞池。
///
/// 容量取 4：足以吸收正常并发的认证请求，又不会在攻击者
/// 用大量注册请求压测时无限占用线程。
///
/// 本池在 `main.rs` 启动时通过 `app_data` 注册；
/// actix-web 的 `web::block` 会**优先**使用已注册的池，
/// 未注册时才退回默认池。因此本模块只管调用 `web::block`。
pub mod blocking {
    /// 线程池容量上限。
    ///
    /// 需为 `pub`：`main.rs` 属独立的 bin crate，无法访问 lib 内的
    /// `pub(crate)` 项。启动时据此建池并注册给 `web::block`。
    pub const MAX_THREADS: usize = 4;

    /// 在受限线程池中执行一段阻塞运算。
    ///
    /// 把 `web::block` 收口到此处，是为了让「所有 Argon2 运算都离开
    /// Actix 工作线程」这一约束在一个地方可查、可测。
    ///
    /// actix 的 `BlockingError` 是私有类型，无法在签名中直接出现，
    /// 故错误统一擦除为 [`String`]——调用方一律按基础设施故障处理，
    /// 原文不外泄给客户端（规范 §09：不得回显内部细节）。
    ///
    /// # Errors
    ///
    /// 线程池无法派发任务（已关闭或过载）时返回错误描述字符串。
    /// 这是基础设施故障，调用方应映射为 500 而非用户错误。
    pub async fn run<T, F>(f: F) -> Result<T, String>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        actix_web::web::block(f).await.map_err(|e| e.to_string())
    }
}

/// 用于时序对齐的假密码明文。
///
/// 任何**固定**字符串都可以，关键是它必须与真实路径消耗**同样一次** Argon2 运算。
const DUMMY_PLAINTEXT: &str = "DUMMY-PASSWORD-FOR-TIMING-EQUALIZATION";

/// 预计算的虚拟哈希，仅用于让"用户不存在"分支与"密码错误"分支耗时一致。
///
/// 必须满足三点，否则时序对齐失效：
/// - 在**请求路径之外**算一次（用 [`OnceLock`]），不能在分支里现算；
/// - 参数与生产完全一致，故登录时直接使用 `auth_config.argon2_params` 计算；
/// - 分支里只做一次 [`verify_password`]，与真实路径的次数相同。
fn dummy_hash(params: &Argon2Params) -> &'static str {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE.get_or_init(|| {
        hash_password(DUMMY_PLAINTEXT, params)
            // 预计算失败属启动期异常；退回一个格式合法的 PHC 串，
            // 保证 verify_password 会执行完整运算而不是提前返回。
            .unwrap_or_else(|_| {
                String::from(
                    "$argon2id$v=19$m=19456,t=2,p=1$c29tZS1maXhlZHVyZA$\
                 ZHVtbXk2YmJiNWNjMmQ4YzExOTRkNGRjNzk0OTFiOTU0ZjdmNTZjMTdlNGE0",
                )
            })
    })
}

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
    //
    // Argon2id 是内存硬度运算，同步执行会卡住 Actix worker，
    // 使该 worker 上分配到的无关请求无法推进。处理器写成 async 并不会自动卸载它，
    // 因此显式交给受限线程池（见模块头部「阻塞工作线程」说明）。
    //
    // `password` 是借用 `body` 的 `&str`，而阻塞闭包要求 `'static`，
    // 故先复制成 `String` 再移入闭包。
    let owned_password = password.to_owned();
    let params = auth_config.argon2_params;
    let hash = blocking::run(move || hash_password(&owned_password, &params))
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!("blocking pool failed: {e}")))?
        .map_err(AppError::internal)?;

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

    // **关键**：用户不存在与密码错误返回完全相同的 401，且消耗相近的时间。
    //
    // 反例警示：早期写法在用户不存在时先 `hash_password` 再 `verify_password`，
    // 那是**两次** Argon2 运算，耗时约为真实路径的两倍——
    // 响应体一致并不够，时序差异本身就成了用户名枚举信道。
    //
    // 正确做法：虚拟哈希在进程启动后预计算一次（见 `dummy_hash`），
    // 两个分支都只做**恰好一次** `verify_password`。
    let Some(user) = user else {
        let dummy = dummy_hash(&auth_config.argon2_params);
        // 密码与哈希串都移入阻塞线程，避免卡住 worker。
        let (pwd, hash) = (password.to_owned(), dummy.to_owned());
        let _ = blocking::run(move || verify_password(&pwd, &hash)).await;
        return Err(AppError::Unauthorized);
    };

    // 同样移出工作线程：Argon2 是内存硬度运算，同步执行会阻塞同 worker 的无关请求。
    let hash_to_verify = user.password_hash.clone();
    let pwd = password.to_owned();
    let outcome = blocking::run(move || verify_password(&pwd, &hash_to_verify)).await;

    match outcome.map_err(|e| AppError::internal(anyhow::anyhow!("blocking pool failed: {e}")))? {
        Ok(()) => {}
        Err(e) => return Err(map_password_error(e)),
    }

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
