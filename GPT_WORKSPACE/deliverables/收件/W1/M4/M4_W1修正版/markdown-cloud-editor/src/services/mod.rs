//! 文档业务服务层：输入校验、乐观锁编排与错误语义映射。
//!
//! 数据访问经 [`crate::services::document_service::DocumentRepository`] 抽象注入，
//! 本层不编写 SQL、不构造 HTTP 响应。

pub mod document_service;
