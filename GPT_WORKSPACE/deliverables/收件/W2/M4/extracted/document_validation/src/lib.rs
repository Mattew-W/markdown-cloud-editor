//! # document_validation
//!
//! W2 正式输入规则的候选校验模块，仅使用 Rust 标准库。
//!
//! 规则（与 W1 练习不同，详见 `规则对照.md`）：
//! - 标题字符上限 [`MAX_TITLE_CHARS`] = 255：先 `trim()`，再按 `chars().count()` 计数；
//! - 正文字节上限 [`MAX_BODY_BYTES`] = 262144：不 trim，直接按 `len()` 统计 UTF-8 字节；
//! - 创建时仅 `None`（省略标题）才使用 [`DEFAULT_TITLE`]；显式空串、普通/全角空白均报错；
//! - 更新时标题必填，空白也报错；正常标题返回 trim 后的值，正文原样返回。
//!
//! 本模块不依赖主项目的 `AppError`，也不提供任何 CRUD / HTTP / 持久化能力；
//! 是否由主项目复用、如何适配由 M1 决定，本交付不声称已集成。

use std::fmt;

/// 标题最大字符数（trim 后的 Unicode 字符数）。
pub const MAX_TITLE_CHARS: usize = 255;

/// 正文最大 UTF-8 字节数。
pub const MAX_BODY_BYTES: usize = 262_144;

/// 创建时省略标题（`None`）使用的默认标题。
pub const DEFAULT_TITLE: &str = "未命名文档";

/// 校验通过后的文档：标题为 trim 后的值，正文保持原样。
#[derive(Debug, PartialEq, Eq)]
pub struct ValidatedDocument {
    pub title: String,
    pub content: String,
}

/// 输入校验错误。
#[derive(Debug, PartialEq, Eq)]
pub enum ValidationError {
    /// 标题为空，或 trim 后为空（含普通空白、全角空白等）。
    EmptyTitle,
    /// 标题 trim 后字符数超过上限。
    TitleTooLong { actual: usize, max: usize },
    /// 正文 UTF-8 字节数超过上限。
    ContentTooLarge { actual: usize, max: usize },
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyTitle => write!(f, "标题不能为空"),
            Self::TitleTooLong { actual, max } => {
                write!(f, "标题超长：{actual} 个字符，上限 {max}")
            }
            Self::ContentTooLarge { actual, max } => {
                write!(f, "正文超长：{actual} 字节，上限 {max}")
            }
        }
    }
}

impl std::error::Error for ValidationError {}

/// 校验标题：先 trim，再判空、再按 Unicode 字符数判长度。
///
/// 成功时返回 trim 后的标题（新的 `String`），而不是只做检查。
///
/// # Errors
/// - trim 后为空（空串、普通/全角空白等）：[`ValidationError::EmptyTitle`]
/// - trim 后字符数超过 [`MAX_TITLE_CHARS`]：[`ValidationError::TitleTooLong`]
pub fn validate_title(title: &str) -> Result<String, ValidationError> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err(ValidationError::EmptyTitle);
    }
    let actual = trimmed.chars().count();
    if actual > MAX_TITLE_CHARS {
        return Err(ValidationError::TitleTooLong {
            actual,
            max: MAX_TITLE_CHARS,
        });
    }
    Ok(trimmed.to_string())
}

/// 创建场景的标题归一化：只有显式传入 `None`（省略标题）才使用默认标题。
///
/// `Some(..)` 一律交给 [`validate_title`]，因此 `Some("")`、`Some("   ")`、
/// `Some("\u{3000}")` 等都会返回 [`ValidationError::EmptyTitle`]，不会被默认值替换。
///
/// # Errors
/// 见 [`validate_title`]。
pub fn normalize_create_title(title: Option<&str>) -> Result<String, ValidationError> {
    match title {
        None => Ok(DEFAULT_TITLE.to_string()),
        Some(raw) => validate_title(raw),
    }
}

/// 校验正文：不 trim，按 UTF-8 字节数判长度。
///
/// # Errors
/// 字节数超过 [`MAX_BODY_BYTES`] 时返回 [`ValidationError::ContentTooLarge`]；
/// 空正文合法，返回 `Ok(())`。
pub fn validate_content(content: &str) -> Result<(), ValidationError> {
    let actual = content.len();
    if actual > MAX_BODY_BYTES {
        return Err(ValidationError::ContentTooLarge {
            actual,
            max: MAX_BODY_BYTES,
        });
    }
    Ok(())
}

/// 更新场景校验：标题必填，正文必须满足字节上限。
///
/// 标题复用 [`validate_title`] 的返回值（trim 后的 `String`），
/// 不会只检查后又回填原始标题；正文通过 [`validate_content`] 检查后原样保留。
///
/// # Errors
/// 标题为空/超长或正文超限时返回对应的 [`ValidationError`]。
pub fn validate_update(title: &str, content: &str) -> Result<ValidatedDocument, ValidationError> {
    let validated_title = validate_title(title)?;
    validate_content(content)?;
    Ok(ValidatedDocument {
        title: validated_title,
        content: content.to_string(),
    })
}
