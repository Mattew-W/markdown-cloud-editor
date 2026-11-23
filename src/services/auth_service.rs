//! 认证业务服务层。
//!
//! 依据项目规范 §07 与 `docs/ARCHITECTURE.md` 六层解耦架构：
//! - 路由层只负责 HTTP 协议交互与限流检查；
//! - 业务规则、密码哈希阻塞卸载、虚拟哈希防时序攻击、JWT 颁发收敛在本服务层；
//! - 数据持久化调用 [`crate::repositories::users`]。

use std::sync::OnceLock;

use sqlx::PgPool;

use crate::auth::dto::{AuthResponse, LoginRequest, RegisterRequest, user_response};
use crate::auth::password::{
    Argon2Params, PasswordError, VerifyLimits, hash_password, verify_password_with_limits,
};
use crate::auth::token::issue_token;
use crate::error::AppError;
use crate::repositories::users::{self, format_timestamp};
use crate::routes::auth::blocking;

/// 用于时序对齐的假密码明文。
///
/// 任何固定字符串都可以，关键是它必须与真实路径消耗同样一次 Argon2 运算。
const DUMMY_PLAINTEXT: &str = "DUMMY-PASSWORD-FOR-TIMING-EQUALIZATION";

/// 预计算的虚拟哈希，仅用于让"用户不存在"分支与"密码错误"分支耗时一致。
///
/// 必须满足三点，否则时序对齐失效：
/// - 在请求路径之外算一次（用 [`OnceLock`]），不能在分支里现算；
/// - 参数与生产完全一致，故登录时直接使用 `argon2_params` 计算；
/// - 分支里只做一次密码校验，与真实路径的次数相同。
#[must_use]
pub fn dummy_hash(params: &Argon2Params) -> &'static str {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE.get_or_init(|| {
        hash_password(DUMMY_PLAINTEXT, params).unwrap_or_else(|_| {
            String::from(
                "$argon2id$v=19$m=19456,t=2,p=1$c29tZS1maXhlZHVyZA$\
                 ZHVtbXk2YmJiNWNjMmQ4YzExOTRkNGRjNzk0OTFiOTU0ZjdmNTZjMTdlNGE0",
            )
        })
    })
}

/// 将 [`PasswordError`] 映射为标准 [`AppError`]。
///
/// 规范 §09 明确要求：
/// - 密码错误映射为 401 UNAUTHORIZED；
/// - 哈希串损坏、参数不兼容等数据损坏或系统错误映射为 500 INTERNAL_ERROR；
/// - 严禁将哈希串损坏误报为 401（否则运维无法排查数据损坏故障）。
#[must_use]
pub fn map_password_error(err: PasswordError) -> AppError {
    match err {
        PasswordError::PasswordMismatch => AppError::Unauthorized,
        PasswordError::InvalidHashFormat(msg) => {
            tracing::error!(reason = %msg, "数据库存储的密码哈希格式损坏");
            AppError::internal(anyhow::anyhow!("password hash corrupt in database"))
        }
        PasswordError::IncompatibleParams(msg) => {
            tracing::error!(reason = %msg, "哈希参数与当前系统不兼容");
            AppError::internal(anyhow::anyhow!("incompatible password hash parameters"))
        }
        PasswordError::HashingFailed(msg) => {
            tracing::error!(reason = %msg, "Argon2 计算执行失败");
            AppError::internal(anyhow::anyhow!("argon2 execution failed"))
        }
        PasswordError::InvalidParams(msg) => {
            tracing::error!(reason = %msg, "Argon2 计算参数非法");
            AppError::internal(anyhow::anyhow!("invalid argon2 parameters"))
        }
    }
}

/// 注册新用户业务逻辑。
///
/// 1. 校验入参格式（用户名小写且合规，密码 12..128 字节）；
/// 2. 调度受限阻塞线程池计算 Argon2id 哈希（防卡住 HTTP 事件循环）；
/// 3. 调用仓储层插入用户（唯一冲突映射为 409 USERNAME_TAKEN）；
/// 4. 签发 HS256 JWT 并组装标准响应。
///
/// # Errors
///
/// - 参数校验失败返回 400；
/// - 用户名已存在返回 409；
/// - 阻塞线程池或数据库故障返回 500。
pub async fn register(
    db: &PgPool,
    jwt_secret: &str,
    jwt_ttl_secs: u64,
    argon2_params: &Argon2Params,
    req: &RegisterRequest,
) -> Result<AuthResponse, AppError> {
    let (username, password) = req.validate()?;

    let owned_password = password.to_owned();
    let params = *argon2_params;
    let hash = blocking::run(move || hash_password(&owned_password, &params))
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!("blocking pool failed: {e}")))?
        .map_err(AppError::internal)?;

    let user = users::insert_user(db, &username, &hash).await?;

    let (token, _expires_at) = issue_token(
        &user.id.to_string(),
        &user.username,
        jwt_secret,
        jwt_ttl_secs,
    )
    .map_err(AppError::internal)?;

    Ok(AuthResponse {
        token,
        expires_in: jwt_ttl_secs,
        user: user_response(user.id, &user.username, &format_timestamp(user.created_at)),
    })
}

/// 用户登录业务逻辑。
///
/// 1. 校验入参格式；
/// 2. 查询用户；
/// 3. 若用户不存在，执行一次虚拟哈希验证（防时序信道探测用户名）并返回 401；
/// 4. 若用户存在，调度受限阻塞线程池验证密码；
/// 5. 密码匹配后签发 HS256 JWT 并组装标准响应。
///
/// # Errors
///
/// - 入参校验失败返回 400；
/// - 凭据不匹配返回 401；
/// - 数据库或内部哈希损坏返回 500。
pub async fn login(
    db: &PgPool,
    jwt_secret: &str,
    jwt_ttl_secs: u64,
    argon2_params: &Argon2Params,
    verify_limits: &VerifyLimits,
    req: &LoginRequest,
) -> Result<AuthResponse, AppError> {
    let (username, password) = req.validate()?;

    let user = users::find_by_username(db, &username).await?;

    let Some(user) = user else {
        let dummy = dummy_hash(argon2_params);
        let (pwd, hash) = (password.to_owned(), dummy.to_owned());
        let limits = *verify_limits;
        let _ = blocking::run(move || verify_password_with_limits(&pwd, &hash, &limits)).await;
        return Err(AppError::Unauthorized);
    };

    let hash_to_verify = user.password_hash.clone();
    let pwd = password.to_owned();
    let limits = *verify_limits;
    let outcome =
        blocking::run(move || verify_password_with_limits(&pwd, &hash_to_verify, &limits)).await;

    match outcome.map_err(|e| AppError::internal(anyhow::anyhow!("blocking pool failed: {e}")))? {
        Ok(()) => {}
        Err(e) => return Err(map_password_error(e)),
    }

    let (token, _expires_at) = issue_token(
        &user.id.to_string(),
        &user.username,
        jwt_secret,
        jwt_ttl_secs,
    )
    .map_err(AppError::internal)?;

    Ok(AuthResponse {
        token,
        expires_in: jwt_ttl_secs,
        user: user_response(user.id, &user.username, &format_timestamp(user.created_at)),
    })
}
