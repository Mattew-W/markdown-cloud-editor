//! HTTP 路由注册。
//!
//! 路由分两层：
//!
//! - `/health` —— 不带版本前缀的运维探针
//! - `/api/v1` —— 业务 API，统一挂载请求体大小限制
//!
//! 阶段 1（W1）只注册健康检查；认证与文档路由分别在阶段 3、4 加入。

use actix_web::{ResponseError, web};

pub mod auth;
pub mod health;

/// API 版本前缀。
pub const API_PREFIX: &str = "/api/v1";

/// 注册全部路由。
///
/// 不 panic。路由重复注册等配置错误由 `actix-web` 在启动时以错误返回。
pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.route("/health", web::get().to(health::health)).service(
        web::scope(API_PREFIX)
            .app_data(
                web::JsonConfig::default()
                    // 规范：JSON 请求体上限 2 MiB
                    .limit(crate::config::MAX_JSON_BODY_BYTES)
                    // 超限时返回 413 而非 actix 默认的 400
                    .error_handler(|err, _req| {
                        let e = match err {
                            actix_web::error::JsonPayloadError::Overflow { .. } => {
                                crate::error::AppError::PayloadTooLarge
                            }
                            actix_web::error::JsonPayloadError::ContentType => {
                                crate::error::AppError::bad_request(
                                    "Content-Type 必须为 application/json",
                                )
                            }
                            other => crate::error::AppError::bad_request(other.to_string()),
                        };
                        let response = e.error_response();
                        actix_web::error::InternalError::from_response(e, response).into()
                    }),
            )
            // 阶段 4 在此注册 documents 路由
            .service(
                web::scope("/auth")
                    // 认证接口请求体远小于通用上限（用户名 32 + 密码 128 字节），
                    // 用更严格的 4 KiB 挡住无意义的超大 body。
                    .app_data(auth::json_config())
                    .route("/register", web::post().to(auth::register))
                    .route("/login", web::post().to(auth::login)),
            ),
    );
}
