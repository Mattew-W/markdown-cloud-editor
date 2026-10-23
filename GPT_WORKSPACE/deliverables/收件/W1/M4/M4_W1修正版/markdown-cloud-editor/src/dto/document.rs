//! 文档相关的数据传输对象（DTO）与输入校验。
//!
//! 字段命名、可选性与校验规则严格对接 `docs/API.md` §3.3–§3.6 与 §5：
//! 标题按 Unicode 标量值计数（trim 后 1..=255），正文按 UTF-8 字节计数
//! （≤ 262 144），时间戳统一格式化为秒级 RFC 3339 UTC 字符串。
//!
//! 与主仓库 `src/dto/documents.rs` 的对应关系（2026-10-24 修正对齐）：
//! 响应时间戳由 `DateTime<Utc>`（serde 亚秒级可变精度）改为 `String`
//! （[`format_timestamp`] 秒级精度），更新确认响应更名为
//! [`UpdateDocumentResponse`]，并补上缺失的 [`DeleteDocumentQuery`]。

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 标题允许的最大 Unicode 标量值数量（API.md §5：1..=255）。
pub const MAX_TITLE_CHARS: usize = 255;

/// 正文允许的最大 UTF-8 字节数（256 KiB，API.md §5）。
pub const MAX_CONTENT_BYTES: usize = 262_144;

/// 创建文档时省略标题的默认回退值（API.md §3.4）。
pub const DEFAULT_TITLE: &str = "未命名文档";

/// 列表查询每页默认条数（API.md §3.3）。
pub const DEFAULT_LIMIT: i64 = 20;

/// 列表查询每页最大条数（API.md §3.3：1..=100）。
pub const MAX_LIMIT: i64 = 100;

/// 将时间戳格式化为秒级 RFC 3339 UTC 字符串（以 `Z` 结尾）。
///
/// 精度必须固定为秒：`DateTime<Utc>` 经 serde 直出会按亚秒是否为零
/// 产生可变精度（`...Z` 与 `...123Z` 混用），破坏响应体一致性与既有断言。
#[must_use]
pub fn format_timestamp(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Secs, true)
}

// ==================== 请求 DTO ====================

/// `GET /api/v1/documents` 分页查询参数。
#[derive(Debug, Clone, Deserialize)]
pub struct ListDocumentsQuery {
    /// 每页返回记录数。省略时默认 [`DEFAULT_LIMIT`]，合法范围 `1..=MAX_LIMIT`。
    pub limit: Option<i64>,
    /// 分页偏移量。省略时默认 0，必须非负。
    pub offset: Option<i64>,
}

/// `POST /api/v1/documents` 创建文档请求体。
#[derive(Debug, Clone, Deserialize)]
pub struct CreateDocumentRequest {
    /// 文档标题。省略时服务端回退为 [`DEFAULT_TITLE`]；显式提供时去首尾
    /// 空白后必须在 1..=[`MAX_TITLE_CHARS`] 个字符内，全空白视为非法。
    pub title: Option<String>,
    /// Markdown 正文。省略时默认为空串；不超过 [`MAX_CONTENT_BYTES`] 字节。
    pub content: Option<String>,
}

/// `PUT /api/v1/documents/{id}` 更新文档请求体。
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateDocumentRequest {
    /// 新标题。必填，去首尾空白后为 1..=[`MAX_TITLE_CHARS`] 个 Unicode 标量值。
    pub title: String,
    /// 新正文。必填，不超过 [`MAX_CONTENT_BYTES`] 字节。
    pub content: String,
    /// 客户端持有的期望版本号（乐观锁）。必填，取值 `1..=2147483647`。
    pub expected_version: i32,
}

/// `DELETE /api/v1/documents/{id}` 删除文档查询参数。
///
/// API.md §3.6 规定 `expected_version` 走**查询参数**，不是请求体。
#[derive(Debug, Clone, Deserialize)]
pub struct DeleteDocumentQuery {
    /// 期望删除的版本号。必填，必须 >= 1。
    pub expected_version: i32,
}

// ==================== 响应 DTO ====================

/// 单篇文档详情响应体（`GET /api/v1/documents/{id}`，含正文）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentResponse {
    /// 文档唯一主键 UUID。
    pub id: Uuid,
    /// 文档标题。
    pub title: String,
    /// Markdown 正文。
    pub content: String,
    /// 当前版本号。
    pub version: i32,
    /// 创建时间（秒级 RFC 3339 UTC）。
    pub created_at: String,
    /// 最后更新时间（秒级 RFC 3339 UTC）。
    pub updated_at: String,
}

/// 文档列表摘要响应体（`GET /api/v1/documents`，不含正文）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSummaryResponse {
    /// 文档唯一主键 UUID。
    pub id: Uuid,
    /// 文档标题。
    pub title: String,
    /// 当前版本号。
    pub version: i32,
    /// 创建时间（秒级 RFC 3339 UTC）。
    pub created_at: String,
    /// 最后更新时间（秒级 RFC 3339 UTC）。
    pub updated_at: String,
}

/// 文档列表包装响应体。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentListResponse {
    /// 文档摘要列表。
    pub documents: Vec<DocumentSummaryResponse>,
    /// 生效的每页数量。
    pub limit: i64,
    /// 生效的分页偏移量。
    pub offset: i64,
    /// 该用户所拥有的文档总数。
    pub total: i64,
}

/// 更新文档成功时的响应体（`PUT`，不回传正文）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateDocumentResponse {
    /// 文档唯一主键 UUID。
    pub id: Uuid,
    /// 更新后的新版本号（原版本 + 1）。
    pub version: i32,
    /// 更新时间（秒级 RFC 3339 UTC）。
    pub updated_at: String,
}

// ==================== 校验 ====================

/// 输入校验错误。
///
/// 由 [`crate::services::document_service::DocumentServiceError`] 的
/// `From` 实现翻译为 HTTP 语义：仅 [`ValidationError::ContentTooLarge`]
/// 映射为 413，其余均为 400。
#[derive(Debug, thiserror::Error)]
pub enum ValidationError {
    /// 标题 trim 后为空串（含全角空白等 Unicode 空白）。
    #[error("标题不能为空白字符")]
    TitleEmpty,
    /// 标题 trim 后超过 [`MAX_TITLE_CHARS`] 个 Unicode 标量值。
    #[error("标题长度不能超过255个字符")]
    TitleTooLong,
    /// 正文 UTF-8 字节数超过 [`MAX_CONTENT_BYTES`]。
    #[error("正文大小不能超过256KiB")]
    ContentTooLarge,
    /// `expected_version` 小于 1。
    #[error("期望版本必须为正整数")]
    InvalidVersion,
    /// `limit` 不在 `1..=[`MAX_LIMIT`]` 范围内。
    #[error("分页数量必须在1-100之间")]
    InvalidLimit,
    /// `offset` 为负数。
    #[error("偏移量不能为负数")]
    InvalidOffset,
}

impl CreateDocumentRequest {
    /// 校验创建请求，返回**trim 后**的标题与正文。
    ///
    /// # Errors
    ///
    /// - 显式标题 trim 后为空 → [`ValidationError::TitleEmpty`]；
    /// - 标题 trim 后超过 [`MAX_TITLE_CHARS`] 字符 → [`ValidationError::TitleTooLong`]；
    /// - 正文超过 [`MAX_CONTENT_BYTES`] 字节 → [`ValidationError::ContentTooLarge`]。
    pub fn validate(&self) -> Result<(String, String), ValidationError> {
        // 标题：有值则 trim 校验，无值用默认名（API.md §3.4）
        let title = match &self.title {
            Some(t) => {
                let trimmed = t.trim().to_string();
                if trimmed.is_empty() {
                    return Err(ValidationError::TitleEmpty);
                }
                if trimmed.chars().count() > MAX_TITLE_CHARS {
                    return Err(ValidationError::TitleTooLong);
                }
                trimmed
            }
            None => DEFAULT_TITLE.to_string(),
        };

        // 正文：默认空串，按 UTF-8 字节校验上限
        let content = self.content.clone().unwrap_or_default();
        if content.len() > MAX_CONTENT_BYTES {
            return Err(ValidationError::ContentTooLarge);
        }

        Ok((title, content))
    }
}

impl UpdateDocumentRequest {
    /// 校验更新请求，返回**trim 后**的标题。
    ///
    /// 返回值即应持久化的标题：update 路径必须与 create 路径一致地
    /// 落库 trim 后形态，否则同一份数据经两条路径入库形态不同。
    ///
    /// # Errors
    ///
    /// - 标题 trim 后为空 → [`ValidationError::TitleEmpty`]；
    /// - 标题 trim 后超长 → [`ValidationError::TitleTooLong`]；
    /// - 正文超字节 → [`ValidationError::ContentTooLarge`]；
    /// - `expected_version < 1` → [`ValidationError::InvalidVersion`]。
    pub fn validate(&self) -> Result<String, ValidationError> {
        let trimmed_title = self.title.trim();
        if trimmed_title.is_empty() {
            return Err(ValidationError::TitleEmpty);
        }
        if trimmed_title.chars().count() > MAX_TITLE_CHARS {
            return Err(ValidationError::TitleTooLong);
        }

        if self.content.len() > MAX_CONTENT_BYTES {
            return Err(ValidationError::ContentTooLarge);
        }

        if self.expected_version < 1 {
            return Err(ValidationError::InvalidVersion);
        }

        Ok(trimmed_title.to_string())
    }
}

impl ListDocumentsQuery {
    /// 校验并返回生效的分页参数 `(limit, offset)`。
    ///
    /// # Errors
    ///
    /// - `limit` 越界 → [`ValidationError::InvalidLimit`]；
    /// - `offset < 0` → [`ValidationError::InvalidOffset`]。
    pub fn validate(&self) -> Result<(i64, i64), ValidationError> {
        let limit = self.limit.unwrap_or(DEFAULT_LIMIT);
        if !(1..=MAX_LIMIT).contains(&limit) {
            return Err(ValidationError::InvalidLimit);
        }

        let offset = self.offset.unwrap_or(0);
        if offset < 0 {
            return Err(ValidationError::InvalidOffset);
        }

        Ok((limit, offset))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 创建时省略标题回退默认标题且正文可空() {
        let req = CreateDocumentRequest {
            title: None,
            content: None,
        };
        let (title, content) = req.validate().unwrap();
        assert_eq!(title, DEFAULT_TITLE);
        assert_eq!(content, "");
    }

    #[test]
    fn 创建时显式全空白标题被拒绝() {
        let req = CreateDocumentRequest {
            title: Some(" \t\u{3000} ".to_string()),
            content: None,
        };
        assert!(matches!(req.validate(), Err(ValidationError::TitleEmpty)));
    }

    #[test]
    fn 标题按字符数而非字节数计数() {
        // 255 个中文字符 = 765 字节，按字节计会误杀；按字符计必须放行
        let req = CreateDocumentRequest {
            title: Some("中".repeat(MAX_TITLE_CHARS)),
            content: None,
        };
        assert!(req.validate().is_ok());

        let req = CreateDocumentRequest {
            title: Some("中".repeat(MAX_TITLE_CHARS + 1)),
            content: None,
        };
        assert!(matches!(req.validate(), Err(ValidationError::TitleTooLong)));
    }

    #[test]
    fn 正文按字节边界校验含多字节场景() {
        // 恰好 262 144 字节：87 381 个汉字（262 143 字节）+ 1 个 ASCII
        let boundary = format!("{}{}", "中".repeat(MAX_CONTENT_BYTES / 3), "a");
        assert_eq!(boundary.len(), MAX_CONTENT_BYTES);
        let req = CreateDocumentRequest {
            title: None,
            content: Some(boundary),
        };
        assert!(req.validate().is_ok());

        let over = "a".repeat(MAX_CONTENT_BYTES + 1);
        let req = CreateDocumentRequest {
            title: None,
            content: Some(over),
        };
        assert!(matches!(
            req.validate(),
            Err(ValidationError::ContentTooLarge)
        ));
    }

    #[test]
    fn 更新校验返回trim后的标题() {
        let req = UpdateDocumentRequest {
            title: "  整理后的标题 \t".to_string(),
            content: "正文".to_string(),
            expected_version: 3,
        };
        let title = req.validate().unwrap();
        assert_eq!(title, "整理后的标题");
    }

    #[test]
    fn 更新时期望版本号非法被拒绝() {
        let req = UpdateDocumentRequest {
            title: "t".to_string(),
            content: "c".to_string(),
            expected_version: 0,
        };
        assert!(matches!(
            req.validate(),
            Err(ValidationError::InvalidVersion)
        ));
    }

    #[test]
    fn 分页默认值与越界() {
        let q = ListDocumentsQuery {
            limit: None,
            offset: None,
        };
        assert_eq!(q.validate().unwrap(), (DEFAULT_LIMIT, 0));

        for bad in [
            ListDocumentsQuery {
                limit: Some(0),
                offset: None,
            },
            ListDocumentsQuery {
                limit: Some(MAX_LIMIT + 1),
                offset: None,
            },
            ListDocumentsQuery {
                limit: None,
                offset: Some(-1),
            },
        ] {
            assert!(bad.validate().is_err());
        }
    }

    #[test]
    fn 时间戳格式化为秒级rfc3339且以z结尾() {
        // 1_700_000_000 秒 = 2023-11-14T22:13:20Z；纳秒必须被丢弃
        let dt = DateTime::from_timestamp(1_700_000_000, 123_456_789).unwrap();
        let formatted = format_timestamp(dt);
        assert_eq!(formatted, "2023-11-14T22:13:20Z");
        assert!(!formatted.contains('.'));
    }
}
