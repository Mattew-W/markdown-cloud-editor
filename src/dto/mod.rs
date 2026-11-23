//! 数据传输对象（DTO）定义层。
//!
//! 包含请求入参反序列化结构、查询参数结构以及标准化响应体定义。
//!
//! 模块划分：
//! - [`auth`]：注册、登录请求与鉴权响应模型
//! - [`documents`]：文档 CRUD 请求体、查询参数与响应模型

pub mod auth;
pub mod documents;

pub use auth::{AuthResponse, LoginRequest, RegisterRequest, UserResponse};
pub use documents::{
    CreateDocumentRequest, DeleteDocumentQuery, DocumentListResponse, DocumentResponse,
    DocumentSummaryResponse, ListDocumentsQuery, UpdateDocumentRequest, UpdateDocumentResponse,
};
