//! Gemini 3.8 Flash 完整项目版本 —— 后端核心库
//!
//! # 架构亮点
//! - **六层分层解耦**：遵循 Clean Architecture，分层清晰，绝无循环依赖。
//! - **双数据库引擎**：开箱即用 SQLite（零环境依赖立即运行）与生产级 PostgreSQL（对齐 35-380 规范）。
//! - **原子乐观并发**：更新与删除操作走单条原子 SQL，杜绝丢失更新。
//! - **防时序攻击**：针对用户不存在分支注入预计算虚拟 Argon2id 哈希，彻底消除用户名枚举。
//! - **Gemini 3.8 Flash 原生集成**：内置 AI 自动补全、Markdown 润色、摘要提取、Mermaid 图表推导与文档对话。

pub mod auth;
pub mod config;
pub mod dto;
pub mod error;
pub mod middleware;
pub mod models;
pub mod repositories;
pub mod routes;
pub mod services;
pub mod state;

pub use config::{Config, ConfigError, DatabaseKind};
pub use error::{AppError, ErrorCode, ErrorResponseBody};
pub use state::{AppState, DbPool};

use actix_web::web;

/// 配置应用服务 (供 main.rs 与集成测试共用)
pub fn configure_app(cfg: &mut web::ServiceConfig) {
    routes::configure_routes(cfg);
}

/// 执行数据库迁移初始化
pub async fn run_migrations(db: &DbPool) -> Result<(), anyhow::Error> {
    match db {
        DbPool::Sqlite(pool) => {
            let sql = include_str!("../migrations/sqlite/0001_init.sql");
            for statement in sql.split(';') {
                let stmt = statement.trim();
                if !stmt.is_empty() {
                    sqlx::query(stmt).execute(pool).await?;
                }
            }
        }
        DbPool::Postgres(pool) => {
            let sql = include_str!("../migrations/postgres/0001_init.sql");
            for statement in sql.split(';') {
                let stmt = statement.trim();
                if !stmt.is_empty() {
                    sqlx::query(stmt).execute(pool).await?;
                }
            }
        }
    }
    Ok(())
}
