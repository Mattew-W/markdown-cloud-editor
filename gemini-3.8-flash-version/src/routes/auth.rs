//! 认证路由 (/api/v1/auth)

use crate::dto::{LoginRequest, RegisterRequest};
use crate::error::AppError;
use crate::middleware::RateLimiter;
use crate::services::AuthService;
use crate::state::AppState;
use actix_web::{HttpRequest, HttpResponse, post, web};
use std::net::IpAddr;

/// 客户端 IP 解析辅助
fn extract_ip(req: &HttpRequest) -> IpAddr {
    req.connection_info()
        .realip_remote_addr()
        .and_then(|addr| addr.split(':').next())
        .and_then(|ip_str| ip_str.parse::<IpAddr>().ok())
        .unwrap_or_else(|| "127.0.0.1".parse().unwrap())
}

/// POST /api/v1/auth/register
#[post("/register")]
pub async fn register(
    state: web::Data<AppState>,
    limiter: web::Data<RateLimiter>,
    req: HttpRequest,
    payload: web::Json<RegisterRequest>,
) -> Result<HttpResponse, AppError> {
    let client_ip = extract_ip(&req);
    if let Some(retry_after) = limiter.check(client_ip) {
        return Err(AppError::RateLimited(retry_after));
    }

    let auth_resp = AuthService::register(&state, payload.into_inner()).await?;
    Ok(HttpResponse::Created().json(auth_resp))
}

/// POST /api/v1/auth/login
#[post("/login")]
pub async fn login(
    state: web::Data<AppState>,
    limiter: web::Data<RateLimiter>,
    req: HttpRequest,
    payload: web::Json<LoginRequest>,
) -> Result<HttpResponse, AppError> {
    let client_ip = extract_ip(&req);
    if let Some(retry_after) = limiter.check(client_ip) {
        return Err(AppError::RateLimited(retry_after));
    }

    let auth_resp = AuthService::login(&state, payload.into_inner()).await?;
    Ok(HttpResponse::Ok().json(auth_resp))
}
