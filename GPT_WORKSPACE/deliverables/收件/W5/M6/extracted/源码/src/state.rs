//! 共享应用状态。
//!
//! 目前只持有数据库连接池。后续若加入速率限制器、模板引擎等全局资源，
//! 一并放入 [`AppState`]，通过 `web::Data<AppState>` 注入各处理器。

use sqlx::PgPool;

/// 全局共享状态。
#[derive(Clone, Debug)]
pub struct AppState {
    /// PostgreSQL 连接池。克隆代价低（内部为 `Arc`）。
    pub db: PgPool,
}

impl AppState {
    /// 以给定连接池构造状态。
    #[must_use]
    pub const fn new(db: PgPool) -> Self {
        Self { db }
    }
}
