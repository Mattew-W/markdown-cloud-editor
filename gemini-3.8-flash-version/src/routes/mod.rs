//! 路由汇总配置模块 (严格限定 8 个 MVP 端点 + Gemini AI 增强插件)

pub mod ai;
pub mod auth;
pub mod documents;
pub mod health;

use crate::error::{AppError, ErrorCode, ErrorResponseBody};
use actix_web::web::{JsonConfig, PathConfig, QueryConfig};
use actix_web::{HttpRequest, HttpResponse, ResponseError, web};

/// 配置全局 API 路由与输入反序列化错误处理器
pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    // 限制 JSON 请求体最大为 2 MiB (API.md §4 与 §5)
    let json_config = JsonConfig::default()
        .limit(2 * 1024 * 1024)
        .error_handler(|err, _req| {
            let request_id = uuid::Uuid::new_v4().to_string();
            let is_payload_overflow = err.to_string().contains("overflow")
                || err.to_string().contains("Payload too large")
                || err.to_string().contains("limit");

            if is_payload_overflow {
                actix_web::error::InternalError::from_response(
                    err,
                    HttpResponse::PayloadTooLarge().json(ErrorResponseBody {
                        error: crate::error::ErrorDetails {
                            code: ErrorCode::PayloadTooLarge,
                            message: "Request payload exceeds 2 MiB limit".to_string(),
                            details: None,
                            request_id,
                        },
                    }),
                )
                .into()
            } else {
                actix_web::error::InternalError::from_response(
                    err,
                    HttpResponse::BadRequest().json(ErrorResponseBody {
                        error: crate::error::ErrorDetails {
                            code: ErrorCode::BadRequest,
                            message: "Malformed JSON payload".to_string(),
                            details: None,
                            request_id,
                        },
                    }),
                )
                .into()
            }
        });

    let query_config = QueryConfig::default().error_handler(|err, _req| {
        let request_id = uuid::Uuid::new_v4().to_string();
        actix_web::error::InternalError::from_response(
            err,
            HttpResponse::BadRequest().json(ErrorResponseBody {
                error: crate::error::ErrorDetails {
                    code: ErrorCode::BadRequest,
                    message: "Invalid query parameters".to_string(),
                    details: None,
                    request_id,
                },
            }),
        )
        .into()
    });

    let path_config = PathConfig::default().error_handler(|err, _req| {
        let request_id = uuid::Uuid::new_v4().to_string();
        actix_web::error::InternalError::from_response(
            err,
            HttpResponse::BadRequest().json(ErrorResponseBody {
                error: crate::error::ErrorDetails {
                    code: ErrorCode::BadRequest,
                    message: "Invalid path parameters".to_string(),
                    details: None,
                    request_id,
                },
            }),
        )
        .into()
    });

    cfg.app_data(json_config)
        .app_data(query_config)
        .app_data(path_config)
        // 1. 运维探针 (不带 /api/v1 前缀)
        .service(health::health_check)
        // 2. 核心 API 前缀 /api/v1
        .service(
            web::scope("/api/v1")
                // 认证 (2 个端点: register, login)
                .service(
                    web::scope("/auth")
                        .service(auth::register)
                        .service(auth::login),
                )
                // 文档 (5 个端点: list, create, get, update, delete)
                .service(
                    web::scope("/documents")
                        .service(documents::list_documents)
                        .service(documents::create_document)
                        .service(documents::get_document)
                        .service(documents::update_document)
                        .service(documents::delete_document),
                )
                // Gemini 3.8 Flash 协同扩展插件 (解耦路由)
                .service(
                    web::scope("/ai")
                        .service(ai::complete)
                        .service(ai::polish)
                        .service(ai::summarize)
                        .service(ai::diagram)
                        .service(ai::math)
                        .service(ai::chat),
                ),
        )
        // 404 结构化兜底
        .default_service(web::to(|_req: HttpRequest| async {
            let err = AppError::NotFound("Route not found".to_string());
            err.error_response()
        }));
}
