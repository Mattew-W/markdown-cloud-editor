//! 健康检查路由。
//!
//! 规范要求「服务在数据库未就绪时不能谎报健康」。因此本路由**实际执行**
//! `SELECT 1` 探测数据库，而不是只看进程是否存活：
//!
//! - 探测成功 → `200`，`{"status":"ok","database":"up"}`
//! - 探测失败 → `503`，`{"status":"degraded","database":"down"}`
//!
//! 失败时只记录日志，不把连接串或数据库错误细节返回给客户端。

use actix_web::{HttpResponse, web};

use crate::state::AppState;

/// 探测结果响应体。
#[derive(Debug, serde::Serialize)]
struct HealthBody {
    status: &'static str,
    database: &'static str,
}

/// `GET /health` —— 报告服务与数据库的可用性。
///
/// 数据库不可用时返回 `503`，绝不在数据库未就绪时报 `200`。
pub async fn health(state: web::Data<AppState>) -> HttpResponse {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await
    {
        Ok(_) => HttpResponse::Ok().json(HealthBody {
            status: "ok",
            database: "up",
        }),
        Err(e) => {
            tracing::error!(error = %e, "health check: database probe failed");
            HttpResponse::ServiceUnavailable().json(HealthBody {
                status: "degraded",
                database: "down",
            })
        }
    }
}
