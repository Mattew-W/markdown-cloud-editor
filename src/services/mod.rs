//! 业务服务层。
//!
//! 负责业务规则编排、输入合法性检验与事务边界控制。
//! 路由层只能向下调用服务层，服务层调用仓储层执行持久化。

pub mod document_service;

pub use document_service::{
    DEFAULT_TITLE, MAX_TITLE_CHARS, create_document, delete_document, get_document, list_documents,
    normalize_create_title, update_document, validate_content, validate_expected_version,
    validate_pagination, validate_title,
};
