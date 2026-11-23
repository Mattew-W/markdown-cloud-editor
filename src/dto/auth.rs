//! 认证数据传输对象（DTO）。
//!
//! 包含用户注册、登录请求与鉴权响应的输入输出结构体。
//! 严格符合项目规范 §06 与 `docs/API.md` 契约。

pub use crate::auth::dto::{
    AuthResponse, LoginRequest, RegisterRequest, UserResponse, parse_document_id, user_response,
};
