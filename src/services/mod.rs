//! 业务服务层。
//!
//! 负责业务规则编排、输入合法性检验与事务边界控制。
//! 路由层只能向下调用服务层，服务层调用仓储层执行持久化。
//!
//! 模块划分（规范 §07 与 `docs/ARCHITECTURE.md`）：
//! - [`auth_service`]：用户注册、登录验证、Argon2 阻塞调度与 JWT 签发
//! - [`document_service`]：文档增删改查业务校验、CAS 乐观锁冲突识别

pub mod auth_service;
pub mod document_service;

pub use auth_service::{dummy_hash, login, map_password_error, register};
pub use document_service::{
    DEFAULT_TITLE, MAX_TITLE_CHARS, create_document, delete_document, get_document, list_documents,
    normalize_create_title, update_document, validate_content, validate_expected_version,
    validate_pagination, validate_title,
};
