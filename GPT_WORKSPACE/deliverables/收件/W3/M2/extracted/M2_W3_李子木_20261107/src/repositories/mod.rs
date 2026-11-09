//! 数据访问层。
//!
//! 规范 §07 六层解耦：路由层**不得**写 SQL，所有查询集中在本模块。
//!
//! 职责划分：
//! - [`users`]：users 表
//! - [`document_repo`]：documents 表与乐观锁原子操作
//!
//! 各子模块负责把数据库错误翻译成 [`crate::error::AppError`]，
//! 路由层只处理业务错误，不出现 SQL 错误码。

pub mod document_repo;
pub mod users;

pub use document_repo::{DeleteDocOutcome, UpdateDocOutcome};
