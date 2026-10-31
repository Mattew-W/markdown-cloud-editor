//! 数据访问层：documents 表的原子操作与查询。
//!
//! 规范 §07 要求六层解耦，路由与服务层**严禁**直接编写 SQL 字符串。
//! 本模块是唯一持有 `documents` 表 SQL 语句的地方。
//!
//! # 所有权与安全约定
//!
//! - 所有查询和修改**必须**带 `WHERE owner_id = $` 条件进行物理隔离；
//! - 越权访问与资源不存在统一表现为未查到（上层统一映射 404）；
//! - 更新与删除必须带 `version = expected_version` 乐观锁条件，受影响行数为 0 时
//!   通过只读探测分流为 409 冲突或 404 不存在。

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppError;
use crate::models::document::{Document, DocumentSummary};

/// 文档更新操作的判定分流结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateDocOutcome {
    /// 成功更新，携带新递增的版本号与更新时间。
    Updated {
        /// 更新后的版本号（原版本 + 1）。
        version: i32,
        /// 更新时间戳（UTC）。
        updated_at: DateTime<Utc>,
    },
    /// 文档存在且属于本人，但期望版本与服务端当前版本不符。
    Conflict {
        /// 服务端当前最新版本号。
        server_version: i32,
    },
    /// 文档不存在或不属于当前用户。
    NotFound,
}

/// 文档删除操作的判定分流结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteDocOutcome {
    /// 成功删除。
    Deleted,
    /// 文档存在且属于本人，但版本已被其它会话推高。
    Conflict {
        /// 服务端当前版本号。
        server_version: i32,
    },
    /// 文档不存在或不属于当前用户。
    NotFound,
}

/// 按主键与所有者 ID 查询单篇文档（含完整正文）。
///
/// # Errors
///
/// 数据库连接或查询执行失败时返回 [`AppError::Internal`]。
pub async fn find_by_id_and_owner(
    pool: &PgPool,
    id: Uuid,
    owner_id: Uuid,
) -> Result<Option<Document>, AppError> {
    let row = sqlx::query_as::<_, Document>(
        "SELECT id, owner_id, title, content, version, created_at, updated_at \
         FROM documents WHERE id = $1 AND owner_id = $2",
    )
    .bind(id)
    .bind(owner_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::internal)?;

    Ok(row)
}

/// 按所有者分页查询文档摘要列表，并返回总记录数。
///
/// 严格按照 `updated_at DESC, id DESC` 稳定排序，利用复合索引 `documents_owner_updated_idx`。
///
/// # Errors
///
/// 数据库连接或查询执行失败时返回 [`AppError::Internal`]。
pub async fn list_by_owner(
    pool: &PgPool,
    owner_id: Uuid,
    limit: i64,
    offset: i64,
) -> Result<(Vec<DocumentSummary>, i64), AppError> {
    let items = sqlx::query_as::<_, DocumentSummary>(
        "SELECT id, owner_id, title, version, created_at, updated_at \
         FROM documents \
         WHERE owner_id = $1 \
         ORDER BY updated_at DESC, id DESC \
         LIMIT $2 OFFSET $3",
    )
    .bind(owner_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
    .map_err(AppError::internal)?;

    let count_row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM documents WHERE owner_id = $1")
        .bind(owner_id)
        .fetch_one(pool)
        .await
        .map_err(AppError::internal)?;

    Ok((items, count_row.0))
}

/// 插入新文档（初始版本号恒为 1）。
///
/// # Errors
///
/// 数据库约束违反或执行失败时返回 [`AppError::Internal`]。
pub async fn insert(
    pool: &PgPool,
    owner_id: Uuid,
    title: &str,
    content: &str,
) -> Result<Document, AppError> {
    let row = sqlx::query_as::<_, Document>(
        "INSERT INTO documents (owner_id, title, content) \
         VALUES ($1, $2, $3) \
         RETURNING id, owner_id, title, content, version, created_at, updated_at",
    )
    .bind(owner_id)
    .bind(title)
    .bind(content)
    .fetch_one(pool)
    .await
    .map_err(AppError::internal)?;

    Ok(row)
}

/// 原子更新文档（带乐观锁版本校验）。
///
/// 单条 SQL 保证并发安全性，严禁“先 SELECT 再无条件 UPDATE”。
///
/// # Errors
///
/// 数据库执行失败时返回 [`AppError::Internal`]。
pub async fn update_atomic(
    pool: &PgPool,
    id: Uuid,
    owner_id: Uuid,
    expected_version: i32,
    title: &str,
    content: &str,
) -> Result<UpdateDocOutcome, AppError> {
    let row: Option<(i32, DateTime<Utc>)> = sqlx::query_as(
        "UPDATE documents \
         SET title = $1, content = $2, version = version + 1, updated_at = CURRENT_TIMESTAMP \
         WHERE id = $3 AND owner_id = $4 AND version = $5 \
         RETURNING version, updated_at",
    )
    .bind(title)
    .bind(content)
    .bind(id)
    .bind(owner_id)
    .bind(expected_version)
    .fetch_optional(pool)
    .await
    .map_err(AppError::internal)?;

    if let Some((new_version, updated_at)) = row {
        return Ok(UpdateDocOutcome::Updated {
            version: new_version,
            updated_at,
        });
    }

    // 0 行匹配：通过只读轻量查询判定是冲突还是不存在
    let probe: Option<(i32,)> =
        sqlx::query_as("SELECT version FROM documents WHERE id = $1 AND owner_id = $2")
            .bind(id)
            .bind(owner_id)
            .fetch_optional(pool)
            .await
            .map_err(AppError::internal)?;

    match probe {
        Some((server_version,)) => Ok(UpdateDocOutcome::Conflict { server_version }),
        None => Ok(UpdateDocOutcome::NotFound),
    }
}

/// 原子删除文档（带乐观锁版本校验）。
///
/// # Errors
///
/// 数据库执行失败时返回 [`AppError::Internal`]。
pub async fn delete_atomic(
    pool: &PgPool,
    id: Uuid,
    owner_id: Uuid,
    expected_version: i32,
) -> Result<DeleteDocOutcome, AppError> {
    let row: Option<(i32,)> = sqlx::query_as(
        "DELETE FROM documents \
         WHERE id = $1 AND owner_id = $2 AND version = $3 \
         RETURNING version",
    )
    .bind(id)
    .bind(owner_id)
    .bind(expected_version)
    .fetch_optional(pool)
    .await
    .map_err(AppError::internal)?;

    if row.is_some() {
        return Ok(DeleteDocOutcome::Deleted);
    }

    // 0 行匹配：判定分流
    let probe: Option<(i32,)> =
        sqlx::query_as("SELECT version FROM documents WHERE id = $1 AND owner_id = $2")
            .bind(id)
            .bind(owner_id)
            .fetch_optional(pool)
            .await
            .map_err(AppError::internal)?;

    match probe {
        Some((server_version,)) => Ok(DeleteDocOutcome::Conflict { server_version }),
        None => Ok(DeleteDocOutcome::NotFound),
    }
}
