//! Markdown 云同步编辑器 —— 后端 crate。
//!
//! # 分层（规范 §07 六层解耦）
//!
//! | 模块 | 职责 |
//! |---|---|
//! | [`config`] | 环境变量读取与启动期安全校验 |
//! | [`error`] | 统一错误类型与 HTTP 响应映射 |
//! | [`middleware`] | 请求追踪 ID |
//! | [`state`] | 共享状态（数据库连接池） |
//! | [`auth`] | 密码哈希（**M3**）、JWT 签发与身份提取器 |
//! | [`dto`] | 数据传输对象（请求入参校验与响应模型） |
//! | [`models`] | 数据库行实体映射（`sqlx::FromRow`） |
//! | [`services`] | 业务规则编排与输入校验（**M4 对接**） |
//! | [`repositories`] | 数据访问，路由与服务层不得直接写 SQL |
//! | [`routes`] | HTTP 路由 |
//!
//! # 设计约束
//!
//! - 除 [`error::AppError`] 外不构造 `HttpResponse`，保证错误结构统一。
//! - 对用户输入与外部故障**不使用** `unwrap` / `expect`。
//! - 公开项一律带 Rustdoc（CI 以 `RUSTDOCFLAGS=-D warnings` 检查）。
#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::pedantic)]
// clippy::pedantic 与 thread_local! 宏的 missing_const_for_thread_local 冲突：
// 后者要求 const 初始化块，但该块在宏展开前对 clippy 不可见，导致无法同时满足。
// thread_local 本身不是性能热点，此处显式豁免该条 pedantic lint。
#![allow(clippy::missing_const_for_thread_local)]
#![allow(clippy::module_name_repetitions)]
// doc_markdown 要求文档中提及的"标识符"加反引号，但本项目文档正文为中文，
// 它会把中文词（如「数据库」「哈希」）误判为未加反引号的标识符，产生大量噪音。
// 规范 §03 要求标识符本身用英文并已加反引号，故豁免此条。
#![allow(clippy::doc_markdown)]

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

pub use config::{Config, ConfigError};
pub use error::{AppError, ErrorCode};
pub use state::AppState;

use actix_web::http::StatusCode;
use actix_web::{HttpResponse, ResponseError, web};

/// 组装 HTTP 应用。
///
/// 路由配置、中间件与 404 兜底集中在此，供 `main` 与集成测试共用——
/// 测试必须走与生产**完全相同**的组装路径，否则测的不是真实行为。
pub fn configure_app(cfg: &mut web::ServiceConfig) {
    cfg.configure(routes::configure)
        // 未匹配任何路由时返回结构化错误体，而非 actix 默认的空 404。
        // 这样前端拿到的所有错误形状一致（含 request_id）。
        .default_service(web::to(not_found));
}

/// 404 兜底处理器。
async fn not_found() -> HttpResponse {
    AppError::NotFound.error_response()
}

/// 未匹配路由时的响应状态，供测试断言。
pub const NOT_FOUND_STATUS: StatusCode = StatusCode::NOT_FOUND;
