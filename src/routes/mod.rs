//! HTTP 路由注册。
//!
//! 路由分两层：
//!
//! - `/health` —— 不带版本前缀的运维探针
//! - `/api/v1` —— 业务 API，统一挂载请求体大小限制
//!
//! 阶段 1（W1）注册健康检查；阶段 3 加入认证；阶段 4（W3）加入文档路由。

use actix_web::{ResponseError, web};

pub mod auth;
pub mod documents;
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
                            // 注意：actix-web 的 `JsonPayloadError` 有**两个**溢出变体：
                            //   - `OverflowKnownLength { length, limit }`：请求带 `Content-Length` 时触发
                            //   - `Overflow { limit }`：分块传输（无 Content-Length）时触发
                            // 浏览器与常规 HTTP 客户端都会带 Content-Length，因此实际命中
                            // 前者。原实现只匹配 `Overflow`，`OverflowKnownLength` 落到下面
                            // 的 `other` 分支被映射成 400 BAD_REQUEST（M6 W6 实测 F-01）。
                            actix_web::error::JsonPayloadError::OverflowKnownLength { .. }
                            | actix_web::error::JsonPayloadError::Overflow { .. } => {
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
            .service(
                web::scope("/auth")
                    // 认证接口请求体远小于通用上限（用户名 32 + 密码 128 字节），
                    // 用更严格的 4 KiB 挡住无意义的超大 body。
                    .app_data(auth::json_config())
                    .route("/register", web::post().to(auth::register))
                    .route("/login", web::post().to(auth::login)),
            )
            // 文档路由。`{id}` 为 UUID。
            //
            // 非法 UUID 原本由 actix 的 Path 提取器拒绝，但默认返回
            // **404 + `text/plain`**（`UUID parsing failed: …`）——
            // 既破坏「错误响应均为 JSON」的约定，又与「资源不存在 404」混淆
            // （M6 W6 实测 F-02，API.md §1 要求 400 JSON `BAD_REQUEST`）。
            //
            // 这里把路径参数解析失败统一映射为 400 JSON：
            // 「资源不存在」仍由 handler 里的 `AppError::NotFound` 返回 404，
            // 二者语义清晰分离。
            .app_data(web::PathConfig::default().error_handler(|err, _req| {
                let e = crate::error::AppError::bad_request(format!("路径参数无效：{err}"));
                let response = e.error_response();
                actix_web::error::InternalError::from_response(e, response).into()
            }))
            .service(
                web::scope("/documents")
                    .route("", web::get().to(documents::list_documents))
                    .route("", web::post().to(documents::create_document))
                    .route("/{id}", web::get().to(documents::get_document))
                    .route("/{id}", web::put().to(documents::update_document))
                    .route("/{id}", web::delete().to(documents::delete_document)),
            ),
    );
}
