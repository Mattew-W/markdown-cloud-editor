//! 应用共享状态模块

use crate::config::Config;
use crate::error::AppError;
use sqlx::{PgPool, SqlitePool};
use std::sync::Arc;

/// 统一数据库连接池抽象
#[derive(Clone)]
pub enum DbPool {
    /// 嵌入式 SQLite 连接池
    Sqlite(SqlitePool),
    /// 生产 PostgreSQL 连接池
    Postgres(PgPool),
}

impl DbPool {
    /// 检查数据库探针健康状况
    pub async fn ping(&self) -> Result<(), AppError> {
        match self {
            Self::Sqlite(pool) => {
                sqlx::query("SELECT 1").execute(pool).await.map_err(|e| {
                    AppError::ServiceUnavailable(format!("SQLite ping failed: {e}"))
                })?;
            }
            Self::Postgres(pool) => {
                sqlx::query("SELECT 1").execute(pool).await.map_err(|e| {
                    AppError::ServiceUnavailable(format!("PostgreSQL ping failed: {e}"))
                })?;
            }
        }
        Ok(())
    }
}

/// 全局共享状态
#[derive(Clone)]
pub struct AppState {
    /// 配置引用
    pub config: Arc<Config>,
    /// 数据库连接池
    pub db: DbPool,
    /// HTTP 客户端 (用于访问 Gemini API)
    pub http_client: reqwest::Client,
}

impl AppState {
    /// 构造新状态
    pub fn new(config: Config, db: DbPool) -> Self {
        let http_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default();

        Self {
            config: Arc::new(config),
            db,
            http_client,
        }
    }
}
