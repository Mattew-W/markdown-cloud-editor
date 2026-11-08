//! 健康探针路由 (严格对齐 API.md §02 与 §04)

use crate::state::AppState;
use actix_web::{HttpResponse, Responder, get, web};

/// GET /health 探针
#[get("/health")]
pub async fn health_check(state: web::Data<AppState>) -> impl Responder {
    match state.db.ping().await {
        Ok(_) => HttpResponse::Ok().json(serde_json::json!({
            "status": "healthy",
            "version": env!("CARGO_PKG_VERSION"),
            "database": match state.config.database_kind {
                crate::config::DatabaseKind::Sqlite => "sqlite",
                crate::config::DatabaseKind::Postgres => "postgres",
            },
            "gemini_mode": if state.config.gemini_api_key.is_some() { "live" } else { "simulation" }
        })),
        Err(e) => HttpResponse::ServiceUnavailable().json(serde_json::json!({
            "status": "unhealthy",
            "error": e.to_string()
        })),
    }
}
