//! 文档业务服务层。
//!
//! 负责业务规则编排、输入严格校验与错误语义映射。
//! 严格遵照六层解耦规范，本模块不直接编写 SQL，而是通过 [`crate::repositories::document_repo`] 访问数据。

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::MAX_CONTENT_BYTES;
use crate::error::AppError;
use crate::models::document::{Document, DocumentSummary};
use crate::repositories::document_repo::{self, DeleteDocOutcome, UpdateDocOutcome};

/// 标题允许的最大 Unicode 字符数。
pub const MAX_TITLE_CHARS: usize = 255;

/// 创建文档时未指定标题的默认回退值。
pub const DEFAULT_TITLE: &str = "未命名文档";

/// 校验并标准化文档更新时的标题。
///
/// # 规则
///
/// 1. 去除首尾空白（涵盖所有 Unicode 空白字符）；
/// 2. 修剪后不能为空串；
/// 3. Unicode 字符数（`chars().count()`）必须在 `1..=255` 范围内。
///
/// # Errors
///
/// 标题为空白或超限时返回 [`AppError::BadRequest`]。
pub fn validate_title(raw_title: &str) -> Result<String, AppError> {
    let trimmed = raw_title.trim();
    if trimmed.is_empty() {
        return Err(AppError::field_error("title", "标题不能为空白字符"));
    }
    let char_count = trimmed.chars().count();
    if char_count > MAX_TITLE_CHARS {
        return Err(AppError::field_error(
            "title",
            format!("标题长度不能超过 {MAX_TITLE_CHARS} 个字符（当前 {char_count}）"),
        ));
    }
    Ok(trimmed.to_string())
}

/// 标准化创建文档时的标题。
///
/// 若为 `None` 则采用默认标题 `"未命名文档"`；若为 `Some` 则执行严格检验。
///
/// # Errors
///
/// 显式传入全空白标题或超长标题时返回 [`AppError::BadRequest`]。
pub fn normalize_create_title(raw_title: Option<&str>) -> Result<String, AppError> {
    match raw_title {
        None => Ok(DEFAULT_TITLE.to_string()),
        Some(t) => validate_title(t),
    }
}

/// 校验正文字节数上限。
///
/// 规范 §06 规定正文最大 262,144 字节（256 KiB）。
///
/// # Errors
///
/// 超限时返回 [`AppError::PayloadTooLarge`]（413）。
pub fn validate_content(content: &str) -> Result<(), AppError> {
    if content.len() > MAX_CONTENT_BYTES {
        return Err(AppError::PayloadTooLarge);
    }
    Ok(())
}

/// 校验分页参数。
///
/// # Errors
///
/// `limit` 不在 `1..=100` 或 `offset < 0` 时返回 [`AppError::BadRequest`]。
pub fn validate_pagination(
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<(i64, i64), AppError> {
    let l = limit.unwrap_or(20);
    let o = offset.unwrap_or(0);

    if !(1..=100).contains(&l) {
        return Err(AppError::bad_request("limit 必须在 1 到 100 之间"));
    }
    if o < 0 {
        return Err(AppError::bad_request("offset 必须大于等于 0"));
    }
    Ok((l, o))
}

/// 校验期望版本号。
///
/// # Errors
///
/// `expected_version < 1` 时返回 [`AppError::BadRequest`]。
pub fn validate_expected_version(expected_version: i32) -> Result<i32, AppError> {
    if expected_version < 1 {
        return Err(AppError::field_error(
            "expected_version",
            "期望版本号必须大于等于 1",
        ));
    }
    Ok(expected_version)
}

/// 获取单篇文档详情。
///
/// # Errors
///
/// 不存在或非本人拥有时统一返回 [`AppError::NotFound`]（404）。
pub async fn get_document(pool: &PgPool, id: Uuid, owner_id: Uuid) -> Result<Document, AppError> {
    document_repo::find_by_id_and_owner(pool, id, owner_id)
        .await?
        .ok_or(AppError::NotFound)
}

/// 分页查询用户的文档摘要列表。
///
/// 返回 `(文档摘要列表, 生效的 limit, 生效的 offset, 总记录数)`。
///
/// # Errors
///
/// 参数不合法或数据库执行失败时返回 [`AppError`]。
pub async fn list_documents(
    pool: &PgPool,
    owner_id: Uuid,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<(Vec<DocumentSummary>, i64, i64, i64), AppError> {
    let (l, o) = validate_pagination(limit, offset)?;
    let (items, total) = document_repo::list_by_owner(pool, owner_id, l, o).await?;
    Ok((items, l, o, total))
}

/// 创建新文档。
///
/// # Errors
///
/// 标题或正文校验不通过、数据库异常时返回 [`AppError`]。
pub async fn create_document(
    pool: &PgPool,
    owner_id: Uuid,
    title_opt: Option<&str>,
    content_opt: Option<&str>,
) -> Result<Document, AppError> {
    let title = normalize_create_title(title_opt)?;
    let content = content_opt.unwrap_or("");
    validate_content(content)?;

    document_repo::insert(pool, owner_id, &title, content).await
}

/// 原子更新文档（带乐观锁检查）。
///
/// # Errors
///
/// - 输入校验不合法 → [`AppError::BadRequest`] 或 [`AppError::PayloadTooLarge`]；
/// - 版本冲突（已被其它请求推高）→ [`AppError::VersionConflict`]（409）；
/// - 不存在或属于他人 → [`AppError::NotFound`]（404）。
pub async fn update_document(
    pool: &PgPool,
    id: Uuid,
    owner_id: Uuid,
    raw_title: &str,
    raw_content: &str,
    expected_version: i32,
) -> Result<(i32, DateTime<Utc>), AppError> {
    let title = validate_title(raw_title)?;
    validate_content(raw_content)?;
    validate_expected_version(expected_version)?;

    let outcome =
        document_repo::update_atomic(pool, id, owner_id, expected_version, &title, raw_content)
            .await?;

    match outcome {
        UpdateDocOutcome::Updated {
            version,
            updated_at,
        } => Ok((version, updated_at)),
        UpdateDocOutcome::Conflict { server_version } => {
            Err(AppError::VersionConflict { server_version })
        }
        UpdateDocOutcome::NotFound => Err(AppError::NotFound),
    }
}

/// 原子删除文档（带乐观锁检查）。
///
/// # Errors
///
/// - 版本冲突 → [`AppError::VersionConflict`]（409）；
/// - 不存在或属于他人 → [`AppError::NotFound`]（404）。
pub async fn delete_document(
    pool: &PgPool,
    id: Uuid,
    owner_id: Uuid,
    expected_version: i32,
) -> Result<(), AppError> {
    validate_expected_version(expected_version)?;

    let outcome = document_repo::delete_atomic(pool, id, owner_id, expected_version).await?;

    match outcome {
        DeleteDocOutcome::Deleted => Ok(()),
        DeleteDocOutcome::Conflict { server_version } => {
            Err(AppError::VersionConflict { server_version })
        }
        DeleteDocOutcome::NotFound => Err(AppError::NotFound),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 正常标题校验通过且去除首尾空白() {
        let title = "  这是测试标题 \t ";
        let res = validate_title(title).unwrap();
        assert_eq!(res, "这是测试标题");
    }

    #[test]
    fn 全角空格与空白字符修剪后为空被拒绝() {
        let title = "　 \t\n \u{3000} ";
        let err = validate_title(title).unwrap_err();
        assert_eq!(err.code(), crate::error::ErrorCode::BadRequest);
    }

    #[test]
    fn 恰好255字符标题通过校验() {
        let title = "中".repeat(255);
        let res = validate_title(&title).unwrap();
        assert_eq!(res.chars().count(), 255);
    }

    #[test]
    fn 超过255字符标题被拒绝() {
        let title = "字".repeat(256);
        let err = validate_title(&title).unwrap_err();
        assert_eq!(err.code(), crate::error::ErrorCode::BadRequest);
    }

    #[test]
    fn 创建文档时省略标题回退为未命名文档() {
        let res = normalize_create_title(None).unwrap();
        assert_eq!(res, DEFAULT_TITLE);
    }

    #[test]
    fn 创建文档时显式传入空标题被拒绝() {
        let err = normalize_create_title(Some("   ")).unwrap_err();
        assert_eq!(err.code(), crate::error::ErrorCode::BadRequest);
    }

    #[test]
    fn 正文边界与超限测试() {
        let ok_content = "a".repeat(MAX_CONTENT_BYTES);
        assert!(validate_content(&ok_content).is_ok());

        let too_large = "a".repeat(MAX_CONTENT_BYTES + 1);
        let err = validate_content(&too_large).unwrap_err();
        assert_eq!(err.code(), crate::error::ErrorCode::PayloadTooLarge);
    }

    #[test]
    fn 分页默认值与越界校验() {
        let (limit, offset) = validate_pagination(None, None).unwrap();
        assert_eq!(limit, 20);
        assert_eq!(offset, 0);

        assert!(validate_pagination(Some(1), Some(0)).is_ok());
        assert!(validate_pagination(Some(100), Some(1000)).is_ok());

        assert_eq!(
            validate_pagination(Some(0), Some(0)).unwrap_err().code(),
            crate::error::ErrorCode::BadRequest
        );
        assert_eq!(
            validate_pagination(Some(101), Some(0)).unwrap_err().code(),
            crate::error::ErrorCode::BadRequest
        );
        assert_eq!(
            validate_pagination(Some(10), Some(-1)).unwrap_err().code(),
            crate::error::ErrorCode::BadRequest
        );
    }

    #[test]
    fn 期望版本号小于1被拒绝() {
        assert!(validate_expected_version(1).is_ok());
        assert!(validate_expected_version(42).is_ok());

        let err0 = validate_expected_version(0).unwrap_err();
        assert_eq!(err0.code(), crate::error::ErrorCode::BadRequest);

        let err_neg = validate_expected_version(-1).unwrap_err();
        assert_eq!(err_neg.code(), crate::error::ErrorCode::BadRequest);
    }
}
