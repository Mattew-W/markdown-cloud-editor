//! 数据库模型层。
//!
//! 包含数据库行与 Rust 内存结构的映射（`sqlx::FromRow`）。
//! 本层为纯数据定义，不包含业务规则与 HTTP 响应处理。

pub mod document;
pub mod user;

pub use document::{Document, DocumentSummary};
pub use user::User;
