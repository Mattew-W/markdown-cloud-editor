//! 数据访问仓储层统一导出

pub mod document_repo;
pub mod user_repo;

pub use document_repo::{DeleteResult, DocumentRepo, UpdateResult};
pub use user_repo::UserRepo;
