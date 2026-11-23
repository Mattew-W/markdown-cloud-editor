//! 认证路由与端点处理。
//!
//! 提供两个公开端点（无需身份验证）：
//!
//! - `POST /api/v1/auth/register` —— 用户注册
//! - `POST /api/v1/auth/login` —— 用户登录
//!
//! # 架构约束（规范 §07 六层解耦）
//!
//! 路由层不直接操作数据库，不执行密码哈希计算；所有认证业务逻辑
//! 委派至业务服务层 [`crate::services::auth_service`]。
//! 本模块负责请求体提取、限流拦截与 HTTP 状态码映射。

use std::net::{IpAddr, Ipv4Addr};

use actix_web::{HttpRequest, HttpResponse, ResponseError, web};

use crate::auth::{
    dto::{LoginRequest, RegisterRequest},
    password::{Argon2Params, PasswordError, VerifyLimits},
    token::{Claims, decode_token},
};
use crate::config::Config;
use crate::error::AppError;
use crate::middleware::RateLimiter;
use crate::services::auth_service;
use crate::state::AppState;

/// 用于把 Argon2 运算移出 Actix 工作线程的受限阻塞池。
///
/// 容量取 4：足以吸收正常并发的认证请求，又不会在攻击者
/// 用大量注册请求压测时无限占用线程。
pub mod blocking {
    /// 线程池容量上限。
    pub const MAX_THREADS: usize = 4;

    /// 在受限线程池中执行一段阻塞运算。
    ///
    /// # Errors
    ///
    /// 线程池无法派发任务时返回错误描述字符串。
    pub async fn run<T, F>(f: F) -> Result<T, String>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        actix_web::web::block(f).await.map_err(|e| e.to_string())
    }
}

/// 应用共享配置。挂在 `web::Data` 上，避免每个处理器都带一串参数。
#[derive(Debug, Clone)]
pub struct AuthConfig {
    /// JWT 有效期（秒）。
    pub jwt_ttl_secs: u64,
    /// Argon2id 参数。
    pub argon2_params: Argon2Params,
    /// 校验历史哈希时的参数上限（DoS 闸门）。
    ///
    /// 由 M3 W3 引入：损坏记录里的 `m` / `t` / `p` 可能极大，
    /// 交给 argon2 会申请巨额内存并直接中止进程。上限可经此注入，
    /// 避免调重 Argon2 参数时漏改闸门。
    pub verify_limits: VerifyLimits,
}

impl From<&Config> for AuthConfig {
    fn from(config: &Config) -> Self {
        Self {
            jwt_ttl_secs: config.jwt_ttl_secs,
            argon2_params: Argon2Params::default(),
            verify_limits: VerifyLimits::default(),
        }
    }
}

impl Default for AuthConfig {
    /// 测试与本地开发的默认配置。
    ///
    /// 集成测试用 `AuthConfig { jwt_ttl_secs: 3600, ..Default::default() }`
    /// 构造实例——将来新增配置项时不必再逐个修改测试。
    fn default() -> Self {
        Self {
            jwt_ttl_secs: 3600,
            argon2_params: Argon2Params::default(),
            verify_limits: VerifyLimits::default(),
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

fn client_ip(req: &HttpRequest, trusted_proxy_ip: Option<IpAddr>) -> IpAddr {
    let Some(peer) = req.peer_addr() else {
        return IpAddr::V4(Ipv4Addr::LOCALHOST);
    };
    let peer_ip = peer.ip().to_canonical();
    if trusted_proxy_ip != Some(peer_ip) {
        return peer_ip;
    }

    let mut values = req.headers().get_all("x-real-ip");
    let forwarded_ip = values
        .next()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<IpAddr>().ok());
    if let (Some(ip), None) = (forwarded_ip, values.next()) {
        return ip.to_canonical();
    }
    peer_ip
}

fn check_auth_rate_limit(
    req: &HttpRequest,
    config: &Config,
    limiter: Option<&RateLimiter>,
) -> Result<(), AppError> {
    if let Some(retry_after_secs) =
        limiter.and_then(|l| l.check(client_ip(req, config.trusted_proxy_ip)))
    {
        return Err(AppError::RateLimited { retry_after_secs });
    }
    Ok(())
}

/// `POST /api/v1/auth/register` —— 注册新用户。
///
/// 成功返回 201 与 token（规范 §06：注册与登录响应结构相同）。
///
/// # Errors
///
/// 用户名或密码不合规 → 400；用户名已存在 → 409；数据库故障 → 500。
pub async fn register(
    req: HttpRequest,
    state: web::Data<AppState>,
    config: web::Data<Config>,
    auth_config: web::Data<AuthConfig>,
    limiter: Option<web::Data<RateLimiter>>,
    body: web::Json<RegisterRequest>,
) -> Result<HttpResponse, AppError> {
    check_auth_rate_limit(&req, &config, limiter.as_ref().map(web::Data::get_ref))?;

    let response = auth_service::register(
        &state.db,
        config.jwt_secret(),
        auth_config.jwt_ttl_secs,
        &auth_config.argon2_params,
        &body,
    )
    .await?;

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
    req: HttpRequest,
    state: web::Data<AppState>,
    config: web::Data<Config>,
    auth_config: web::Data<AuthConfig>,
    limiter: Option<web::Data<RateLimiter>>,
    body: web::Json<LoginRequest>,
) -> Result<HttpResponse, AppError> {
    check_auth_rate_limit(&req, &config, limiter.as_ref().map(web::Data::get_ref))?;

    let response = auth_service::login(
        &state.db,
        config.jwt_secret(),
        auth_config.jwt_ttl_secs,
        &auth_config.argon2_params,
        &auth_config.verify_limits,
        &body,
    )
    .await?;

    Ok(HttpResponse::Ok().json(response))
}

/// 把 M3 的密码错误映射成本项目的错误类型。
#[must_use]
pub fn map_password_error(err: PasswordError) -> AppError {
    auth_service::map_password_error(err)
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
    use actix_web::test::TestRequest;

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

    #[test]
    fn 只信任指定直连代理且各源地址独立限流() {
        let proxy = "127.0.0.1:80".parse::<std::net::SocketAddr>().unwrap();
        let first_client = "192.0.2.1".parse::<IpAddr>().unwrap();
        let second_client = "2001:db8::1".parse::<IpAddr>().unwrap();
        let request = |client: IpAddr| {
            TestRequest::default()
                .peer_addr(proxy)
                .insert_header(("x-real-ip", client.to_string()))
                .to_http_request()
        };
        assert_eq!(client_ip(&request(first_client), None), proxy.ip());
        assert_eq!(
            client_ip(&request(first_client), Some(second_client)),
            proxy.ip()
        );

        let limiter = RateLimiter::new(1, 60);
        let trust = Some(proxy.ip());
        assert!(
            limiter
                .check(client_ip(&request(first_client), trust))
                .is_none()
        );
        assert!(
            limiter
                .check(client_ip(&request(first_client), trust))
                .is_some()
        );
        assert!(
            limiter
                .check(client_ip(&request(second_client), trust))
                .is_none()
        );

        let ambiguous = TestRequest::default()
            .peer_addr(proxy)
            .append_header(("x-real-ip", first_client.to_string()))
            .append_header(("x-real-ip", second_client.to_string()))
            .to_http_request();
        assert_eq!(client_ip(&ambiguous, trust), proxy.ip());
    }
}
