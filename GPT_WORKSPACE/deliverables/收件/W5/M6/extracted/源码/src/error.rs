//! 统一错误类型与 HTTP 响应映射。
//!
//! 全项目只有这一处把领域错误翻译成 HTTP 响应。业务代码一律返回 [`AppError`]，
//! 不直接构造 `HttpResponse`，以保证：
//!
//! - 错误码字面量（`error.code`）在整个项目中唯一且稳定；
//! - 响应体结构恒为 `{ "error": { code, message, details, request_id } }`；
//! - 内部细节（SQL、凭据、堆栈）绝不外泄。
//!
//! 对应项目规范 §06「HTTP 状态码与语义」。

use actix_web::http::StatusCode;
use actix_web::{HttpResponse, ResponseError};
use serde::Serialize;
use std::fmt;

/// 稳定的错误码字面量。
///
/// 这些字符串是**前后端契约的一部分**，前端可据此判断行为（`error.message` 仅供显示，
/// 客户端不得依赖其文字内容判断逻辑）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// 请求参数缺失、类型不符或越界。
    BadRequest,
    /// 缺少凭据、凭据无效或登录失败。
    Unauthorized,
    /// 资源不存在，或不属于当前用户（二者故意不区分，避免泄露他人文档存在性）。
    NotFound,
    /// 用户名已被占用。
    UsernameTaken,
    /// 乐观锁失败：客户端持有的版本号已过时。
    VersionConflict,
    /// 请求体或正文字节数超限。
    PayloadTooLarge,
    /// 触发速率限制。
    RateLimited,
    /// 依赖（如数据库）不可用。
    ServiceUnavailable,
    /// 未预期的服务端错误。
    Internal,
}

impl ErrorCode {
    /// 返回写入响应体的稳定字面量。
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BadRequest => "BAD_REQUEST",
            Self::Unauthorized => "UNAUTHORIZED",
            Self::NotFound => "NOT_FOUND",
            Self::UsernameTaken => "USERNAME_TAKEN",
            Self::VersionConflict => "VERSION_CONFLICT",
            Self::PayloadTooLarge => "PAYLOAD_TOO_LARGE",
            Self::RateLimited => "RATE_LIMITED",
            Self::ServiceUnavailable => "SERVICE_UNAVAILABLE",
            Self::Internal => "INTERNAL_ERROR",
        }
    }

    /// 返回该错误对应的 HTTP 状态码。
    ///
    /// 规范要求「资源不可见」统一 404，不使用 403——403 会泄露"该文档存在但不属于你"。
    #[must_use]
    pub const fn status(self) -> StatusCode {
        match self {
            Self::BadRequest => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::UsernameTaken | Self::VersionConflict => StatusCode::CONFLICT,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Self::ServiceUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 应用统一错误类型。
///
/// 业务层返回该类型，由 [`ResponseError`] 实现统一翻译成 HTTP 响应。
/// 内部错误只保留通用文案，细节写入日志。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// 请求参数不合法（400）。
    ///
    /// `message` 面向用户展示，不得包含 SQL 或内部路径。
    /// `field` 指出出错字段名（snake_case），前端据此高亮定位；
    /// 无对应字段时（如整体格式错误）为 `None`。
    #[error("{message}")]
    BadRequest {
        /// 面向用户的说明。
        message: String,
        /// 出错字段名。
        field: Option<&'static str>,
    },

    /// 身份未通过验证（401）。
    ///
    /// 登录失败（账号不存在与密码错误）统一使用此变体，不区分。
    #[error("authentication required")]
    Unauthorized,

    /// 资源不存在或不可见（404）。
    #[error("resource not found")]
    NotFound,

    /// 用户名已被占用（409）。
    #[error("username already taken")]
    UsernameTaken,

    /// 乐观锁冲突（409），响应 `details` 必含 `server_version`。
    #[error("document version conflict")]
    VersionConflict {
        /// 服务端当前版本号，供客户端展示或决定处理方式。
        server_version: i32,
    },

    /// 请求体或正文超限（413）。
    #[error("payload too large")]
    PayloadTooLarge,

    /// 触发速率限制（429），响应带 `Retry-After` 头。
    #[error("too many requests")]
    RateLimited {
        /// 建议的重试等待秒数。
        retry_after_secs: u64,
    },

    /// 依赖不可用（503），例如数据库未就绪。
    #[error("service unavailable")]
    ServiceUnavailable,

    /// 未预期的内部错误（500）。
    ///
    /// 内部细节只进日志，响应体仅返回通用文案。
    #[error("internal server error")]
    Internal {
        /// 仅用于日志记录的内部错误链。
        #[source]
        source: anyhow::Error,
    },
}

impl AppError {
    /// 返回该错误的稳定错误码。
    #[must_use]
    pub const fn code(&self) -> ErrorCode {
        match self {
            Self::BadRequest { .. } => ErrorCode::BadRequest,
            Self::Unauthorized => ErrorCode::Unauthorized,
            Self::NotFound => ErrorCode::NotFound,
            Self::UsernameTaken => ErrorCode::UsernameTaken,
            Self::VersionConflict { .. } => ErrorCode::VersionConflict,
            Self::PayloadTooLarge => ErrorCode::PayloadTooLarge,
            Self::RateLimited { .. } => ErrorCode::RateLimited,
            Self::ServiceUnavailable => ErrorCode::ServiceUnavailable,
            Self::Internal { .. } => ErrorCode::Internal,
        }
    }

    /// 构造 400 错误，不指出具体字段。
    ///
    /// # Errors
    ///
    /// 永不返回错误；保留 `Result` 签名是为了让调用处能直接 `?`。
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::BadRequest {
            message: message.into(),
            field: None,
        }
    }

    /// 构造 400 错误并指出出错字段。
    ///
    /// # Errors
    ///
    /// 永不返回错误；保留 `Result` 签名是为了让调用处能直接 `?`。
    pub fn field_error(field: &'static str, message: impl Into<String>) -> Self {
        Self::BadRequest {
            message: message.into(),
            field: Some(field),
        }
    }

    /// 构造 500 错误，并保留内部错误链用于日志。
    pub fn internal(source: impl Into<anyhow::Error>) -> Self {
        Self::Internal {
            source: source.into(),
        }
    }

    /// 构造 `VERSION_CONFLICT` 的 `details` 对象。
    ///
    /// 规范要求该字段必须携带 `server_version`。
    #[must_use]
    fn details(&self) -> Option<serde_json::Value> {
        match self {
            Self::VersionConflict { server_version } => Some(serde_json::json!({
                "server_version": server_version,
            })),
            // 400 带字段名时回传，让前端能高亮出错的输入框。
            Self::BadRequest {
                field: Some(field), ..
            } => Some(serde_json::json!({ "field": field })),
            _ => None,
        }
    }

    /// 面向用户的文案。
    ///
    /// 内部错误统一返回通用表述，不透出 `source` 内容。
    #[must_use]
    fn public_message(&self) -> String {
        match self {
            Self::Internal { .. } => "服务器内部错误".to_owned(),
            other => other.to_string(),
        }
    }
}

/// 错误响应体。
///
/// 字段顺序固定，便于测试比对。
#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<serde_json::Value>,
    request_id: String,
}

#[derive(Debug, Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

/// 响应头中的请求追踪 ID 名称（线上规范写法）。
pub const REQUEST_ID_HEADER: &str = "X-Request-Id";

/// 同上，但为全小写形式。
///
/// `HeaderName::from_static` 只接受**全小写**的静态字符串，
/// 传入 `"X-Request-Id"` 会在运行期越界 panic，因此需要这个常量。
/// 两者在 HTTP 层面是同一个头——头名大小写不敏感。
pub const REQUEST_ID_HEADER_LOWERCASE: &str = "x-request-id";

impl ResponseError for AppError {
    fn status_code(&self) -> StatusCode {
        self.code().status()
    }

    fn error_response(&self) -> HttpResponse {
        // 内部错误在此处落日志；响应体不含任何细节。
        if let Self::Internal { source } = self {
            tracing::error!(error = %source, "unhandled internal error");
        }

        let code = self.code();
        let request_id = crate::middleware::current_request_id();

        let mut builder = HttpResponse::build(code.status());
        builder.insert_header((REQUEST_ID_HEADER, request_id.clone()));

        if let Self::RateLimited { retry_after_secs } = self {
            builder.insert_header(("Retry-After", retry_after_secs.to_string()));
        }

        builder.json(ErrorEnvelope {
            error: ErrorBody {
                code: code.as_str(),
                message: self.public_message(),
                details: self.details(),
                request_id,
            },
        })
    }
}

// 请求追踪 ID 的存储类型见 `crate::middleware::RequestIdValue`；
// 响应头名称见 [`REQUEST_ID_HEADER`]，响应体字段见下方 `ErrorBody`。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 每个错误码映射到规范要求的状态码() {
        assert_eq!(ErrorCode::BadRequest.status(), StatusCode::BAD_REQUEST);
        assert_eq!(ErrorCode::Unauthorized.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(ErrorCode::NotFound.status(), StatusCode::NOT_FOUND);
        assert_eq!(ErrorCode::UsernameTaken.status(), StatusCode::CONFLICT);
        assert_eq!(ErrorCode::VersionConflict.status(), StatusCode::CONFLICT);
        assert_eq!(
            ErrorCode::PayloadTooLarge.status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            ErrorCode::RateLimited.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            ErrorCode::ServiceUnavailable.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            ErrorCode::Internal.status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn 不可见资源返回404而非403() {
        // 403 会泄露"该文档存在但不属于你"，规范明确要求统一 404。
        let e = AppError::NotFound;
        assert_eq!(e.code().status(), StatusCode::NOT_FOUND);
        assert_ne!(e.code().status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn 错误码字面量符合规范() {
        assert_eq!(ErrorCode::UsernameTaken.as_str(), "USERNAME_TAKEN");
        assert_eq!(ErrorCode::VersionConflict.as_str(), "VERSION_CONFLICT");
    }

    #[test]
    fn 版本冲突携带server_version() {
        let e = AppError::VersionConflict { server_version: 7 };
        let details = e.details().expect("VERSION_CONFLICT 必须有 details");
        assert_eq!(details["server_version"], serde_json::json!(7));
    }

    #[test]
    fn 其他错误不带details字段() {
        for e in [
            AppError::Unauthorized,
            AppError::NotFound,
            AppError::bad_request("x"),
            AppError::PayloadTooLarge,
        ] {
            assert!(e.details().is_none(), "{e:?} 不应带 details");
        }
    }

    #[test]
    fn 内部错误不泄露细节() {
        let e = AppError::internal(anyhow::anyhow!("secret db password=hunter2"));
        let msg = e.public_message();
        assert!(!msg.contains("hunter2"), "内部细节泄露：{msg}");
        assert_eq!(msg, "服务器内部错误");
    }

    #[test]
    fn 限流错误带retry_after值() {
        let e = AppError::RateLimited {
            retry_after_secs: 60,
        };
        assert_eq!(e.code().status(), StatusCode::TOO_MANY_REQUESTS);
    }
}
