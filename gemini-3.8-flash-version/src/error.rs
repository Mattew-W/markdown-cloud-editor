//! 统一错误处理模块 (对齐 API 规范 §04 与 §09)

use actix_web::http::StatusCode;
use actix_web::{HttpResponse, ResponseError};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 稳定错误码枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// 请求参数不合法
    BadRequest,
    /// 身份未认证或凭据无效
    Unauthorized,
    /// 资源不存在或无权访问（统一 404）
    NotFound,
    /// 用户名已被占用
    UsernameTaken,
    /// 乐观锁版本冲突
    VersionConflict,
    /// 载荷过大 (内容 > 256KiB 或 JSON > 2MiB)
    PayloadTooLarge,
    /// 触发限流
    RateLimited,
    /// 服务暂不可用 (如数据库失联)
    ServiceUnavailable,
    /// 服务端内部故障
    InternalError,
}

/// 统一结构化错误响应体
#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorResponseBody {
    /// 错误主体
    pub error: ErrorDetails,
}

/// 错误详细信息
#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorDetails {
    /// 机器可读错误码
    pub code: ErrorCode,
    /// 人类可读错误消息
    pub message: String,
    /// 额外详情（例如版本冲突时的 server_version）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    /// 追踪 ID
    pub request_id: String,
}

/// 应用领域错误
#[derive(Debug, Error)]
pub enum AppError {
    /// 客户端请求参数错误
    #[error("Bad Request: {0}")]
    BadRequest(String),

    /// 认证失败
    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    /// 未找到资源（或跨租户隔离）
    #[error("Not Found: {0}")]
    NotFound(String),

    /// 用户名重复
    #[error("Username already taken")]
    UsernameTaken,

    /// 乐观锁冲突
    #[error("Version conflict: current server version is {0}")]
    VersionConflict(i32),

    /// 正文载荷超限
    #[error("Payload too large: maximum allowed is 262144 bytes")]
    PayloadTooLarge,

    /// 触发频控
    #[error("Rate limit exceeded")]
    RateLimited(u64),

    /// 服务不可用
    #[error("Service unavailable: {0}")]
    ServiceUnavailable(String),

    /// 内部通用错误
    #[error("Internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    /// 获取对应的 HTTP 状态码
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::UsernameTaken => StatusCode::CONFLICT,
            Self::VersionConflict(_) => StatusCode::CONFLICT,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
            Self::ServiceUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// 获取机器可读错误码
    pub fn error_code(&self) -> ErrorCode {
        match self {
            Self::BadRequest(_) => ErrorCode::BadRequest,
            Self::Unauthorized(_) => ErrorCode::Unauthorized,
            Self::NotFound(_) => ErrorCode::NotFound,
            Self::UsernameTaken => ErrorCode::UsernameTaken,
            Self::VersionConflict(_) => ErrorCode::VersionConflict,
            Self::PayloadTooLarge => ErrorCode::PayloadTooLarge,
            Self::RateLimited(_) => ErrorCode::RateLimited,
            Self::ServiceUnavailable(_) => ErrorCode::ServiceUnavailable,
            Self::Internal(_) => ErrorCode::InternalError,
        }
    }

    /// 构建响应体 JSON
    pub fn to_response_body(&self, request_id: &str) -> ErrorResponseBody {
        let details = match self {
            Self::VersionConflict(server_version) => {
                Some(serde_json::json!({ "server_version": server_version }))
            }
            _ => None,
        };

        ErrorResponseBody {
            error: ErrorDetails {
                code: self.error_code(),
                message: self.to_string(),
                details,
                request_id: request_id.to_string(),
            },
        }
    }
}

impl ResponseError for AppError {
    fn status_code(&self) -> StatusCode {
        self.status_code()
    }

    fn error_response(&self) -> HttpResponse {
        let request_id = uuid::Uuid::new_v4().to_string();
        let mut builder = HttpResponse::build(self.status_code());
        if let Self::RateLimited(retry_after) = self {
            builder.insert_header(("Retry-After", retry_after.to_string()));
        }
        builder.json(self.to_response_body(&request_id))
    }
}
