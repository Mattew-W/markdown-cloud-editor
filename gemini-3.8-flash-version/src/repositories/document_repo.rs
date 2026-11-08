//! 文档仓储层 (带原子乐观锁 CAS，支持 SQLite 与 PostgreSQL)

use crate::error::AppError;
use crate::models::{Document, DocumentSummary};
use crate::state::DbPool;
use chrono::{DateTime, Utc};
use sqlx::Row;
use uuid::Uuid;

/// 更新结果枚举
#[derive(Debug, Clone)]
pub enum UpdateResult {
    /// 更新成功，返回新版本号与更新时间
    Success {
        /// 新版本号
        new_version: i32,
        /// 更新时间
        updated_at: DateTime<Utc>,
    },
    /// 文档不存在或不属于当前用户 (统一 404)
    NotFound,
    /// 乐观锁版本冲突，附带当前服务端的最新版本号
    Conflict {
        /// 当前服务端最新版本号
        server_version: i32,
    },
}

/// 删除结果枚举
#[derive(Debug, Clone)]
pub enum DeleteResult {
    /// 删除成功
    Success,
    /// 文档不存在或不属于当前用户 (统一 404)
    NotFound,
    /// 乐观锁版本冲突，附带当前服务端的最新版本号
    Conflict {
        /// 当前服务端最新版本号
        server_version: i32,
    },
}

/// 文档仓储
pub struct DocumentRepo;

impl DocumentRepo {
    /// 创建新文档
    pub async fn create_document(
        db: &DbPool,
        id: Uuid,
        owner_id: Uuid,
        title: &str,
        content: &str,
    ) -> Result<Document, AppError> {
        let now = Utc::now();
        match db {
            DbPool::Sqlite(pool) => {
                let id_str = id.to_string();
                let owner_str = owner_id.to_string();
                let now_str = now.to_rfc3339();

                sqlx::query(
                    r#"
                    INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at)
                    VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
                    "#,
                )
                .bind(&id_str)
                .bind(&owner_str)
                .bind(title)
                .bind(content)
                .bind(&now_str)
                .bind(&now_str)
                .execute(pool)
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!("SQLite create_document error: {e}")))?;

                Ok(Document {
                    id,
                    owner_id,
                    title: title.to_string(),
                    content: content.to_string(),
                    version: 1,
                    created_at: now,
                    updated_at: now,
                })
            }
            DbPool::Postgres(pool) => {
                sqlx::query(
                    r#"
                    INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at)
                    VALUES ($1, $2, $3, $4, 1, $5, $6)
                    "#,
                )
                .bind(id)
                .bind(owner_id)
                .bind(title)
                .bind(content)
                .bind(now)
                .bind(now)
                .execute(pool)
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!("Postgres create_document error: {e}")))?;

                Ok(Document {
                    id,
                    owner_id,
                    title: title.to_string(),
                    content: content.to_string(),
                    version: 1,
                    created_at: now,
                    updated_at: now,
                })
            }
        }
    }

    /// 查询单篇文档 (带所有者鉴权隔离，不属于本人统一返回 None)
    pub async fn find_by_id_and_owner(
        db: &DbPool,
        id: Uuid,
        owner_id: Uuid,
    ) -> Result<Option<Document>, AppError> {
        match db {
            DbPool::Sqlite(pool) => {
                let id_str = id.to_string();
                let owner_str = owner_id.to_string();
                let row = sqlx::query(
                    r#"
                    SELECT id, owner_id, title, content, version, created_at, updated_at
                    FROM documents
                    WHERE id = ?1 AND owner_id = ?2
                    "#,
                )
                .bind(&id_str)
                .bind(&owner_str)
                .fetch_optional(pool)
                .await
                .map_err(|e| {
                    AppError::Internal(anyhow::anyhow!("SQLite find_document error: {e}"))
                })?;

                if let Some(r) = row {
                    let created_str: String = r.get("created_at");
                    let updated_str: String = r.get("updated_at");
                    let created_at = DateTime::parse_from_rfc3339(&created_str)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now());
                    let updated_at = DateTime::parse_from_rfc3339(&updated_str)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now());

                    Ok(Some(Document {
                        id,
                        owner_id,
                        title: r.get("title"),
                        content: r.get("content"),
                        version: r.get("version"),
                        created_at,
                        updated_at,
                    }))
                } else {
                    Ok(None)
                }
            }
            DbPool::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
                    SELECT id, owner_id, title, content, version, created_at, updated_at
                    FROM documents
                    WHERE id = $1 AND owner_id = $2
                    "#,
                )
                .bind(id)
                .bind(owner_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| {
                    AppError::Internal(anyhow::anyhow!("Postgres find_document error: {e}"))
                })?;

                if let Some(r) = row {
                    Ok(Some(Document {
                        id: r.get("id"),
                        owner_id: r.get("owner_id"),
                        title: r.get("title"),
                        content: r.get("content"),
                        version: r.get("version"),
                        created_at: r.get("created_at"),
                        updated_at: r.get("updated_at"),
                    }))
                } else {
                    Ok(None)
                }
            }
        }
    }

    /// 分页查询所有者文档列表 (排序: updated_at DESC, id DESC)
    pub async fn list_documents(
        db: &DbPool,
        owner_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<DocumentSummary>, i64), AppError> {
        match db {
            DbPool::Sqlite(pool) => {
                let owner_str = owner_id.to_string();
                let count_row =
                    sqlx::query("SELECT COUNT(*) AS total FROM documents WHERE owner_id = ?1")
                        .bind(&owner_str)
                        .fetch_one(pool)
                        .await
                        .map_err(|e| {
                            AppError::Internal(anyhow::anyhow!("SQLite count error: {e}"))
                        })?;
                let total: i64 = count_row.get("total");

                let rows = sqlx::query(
                    r#"
                    SELECT id, title, version, created_at, updated_at
                    FROM documents
                    WHERE owner_id = ?1
                    ORDER BY updated_at DESC, id DESC
                    LIMIT ?2 OFFSET ?3
                    "#,
                )
                .bind(&owner_str)
                .bind(limit)
                .bind(offset)
                .fetch_all(pool)
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!("SQLite list error: {e}")))?;

                let mut summaries = Vec::with_capacity(rows.len());
                for r in rows {
                    let id_str: String = r.get("id");
                    let id = Uuid::parse_str(&id_str).unwrap_or_default();
                    let created_str: String = r.get("created_at");
                    let updated_str: String = r.get("updated_at");
                    let created_at = DateTime::parse_from_rfc3339(&created_str)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now());
                    let updated_at = DateTime::parse_from_rfc3339(&updated_str)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now());

                    summaries.push(DocumentSummary {
                        id,
                        title: r.get("title"),
                        version: r.get("version"),
                        created_at,
                        updated_at,
                    });
                }

                Ok((summaries, total))
            }
            DbPool::Postgres(pool) => {
                let count_row =
                    sqlx::query("SELECT COUNT(*) AS total FROM documents WHERE owner_id = $1")
                        .bind(owner_id)
                        .fetch_one(pool)
                        .await
                        .map_err(|e| {
                            AppError::Internal(anyhow::anyhow!("Postgres count error: {e}"))
                        })?;
                let total: i64 = count_row.get("total");

                let rows = sqlx::query(
                    r#"
                    SELECT id, title, version, created_at, updated_at
                    FROM documents
                    WHERE owner_id = $1
                    ORDER BY updated_at DESC, id DESC
                    LIMIT $2 OFFSET $3
                    "#,
                )
                .bind(owner_id)
                .bind(limit)
                .bind(offset)
                .fetch_all(pool)
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!("Postgres list error: {e}")))?;

                let mut summaries = Vec::with_capacity(rows.len());
                for r in rows {
                    summaries.push(DocumentSummary {
                        id: r.get("id"),
                        title: r.get("title"),
                        version: r.get("version"),
                        created_at: r.get("created_at"),
                        updated_at: r.get("updated_at"),
                    });
                }

                Ok((summaries, total))
            }
        }
    }

    /// 原子更新文档 (带乐观并发锁 CAS)
    pub async fn update_document_atomic(
        db: &DbPool,
        id: Uuid,
        owner_id: Uuid,
        title: &str,
        content: &str,
        expected_version: i32,
    ) -> Result<UpdateResult, AppError> {
        let now = Utc::now();
        match db {
            DbPool::Sqlite(pool) => {
                let id_str = id.to_string();
                let owner_str = owner_id.to_string();
                let now_str = now.to_rfc3339();

                let res = sqlx::query(
                    r#"
                    UPDATE documents
                    SET title = ?1, content = ?2, version = version + 1, updated_at = ?3
                    WHERE id = ?4 AND owner_id = ?5 AND version = ?6
                    "#,
                )
                .bind(title)
                .bind(content)
                .bind(&now_str)
                .bind(&id_str)
                .bind(&owner_str)
                .bind(expected_version)
                .execute(pool)
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!("SQLite update error: {e}")))?;

                if res.rows_affected() == 1 {
                    Ok(UpdateResult::Success {
                        new_version: expected_version + 1,
                        updated_at: now,
                    })
                } else {
                    let check = sqlx::query(
                        "SELECT version FROM documents WHERE id = ?1 AND owner_id = ?2",
                    )
                    .bind(&id_str)
                    .bind(&owner_str)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| {
                        AppError::Internal(anyhow::anyhow!("SQLite version check error: {e}"))
                    })?;

                    if let Some(r) = check {
                        let server_version: i32 = r.get("version");
                        Ok(UpdateResult::Conflict { server_version })
                    } else {
                        Ok(UpdateResult::NotFound)
                    }
                }
            }
            DbPool::Postgres(pool) => {
                let res = sqlx::query(
                    r#"
                    UPDATE documents
                    SET title = $1, content = $2, version = version + 1, updated_at = $3
                    WHERE id = $4 AND owner_id = $5 AND version = $6
                    "#,
                )
                .bind(title)
                .bind(content)
                .bind(now)
                .bind(id)
                .bind(owner_id)
                .bind(expected_version)
                .execute(pool)
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!("Postgres update error: {e}")))?;

                if res.rows_affected() == 1 {
                    Ok(UpdateResult::Success {
                        new_version: expected_version + 1,
                        updated_at: now,
                    })
                } else {
                    let check = sqlx::query(
                        "SELECT version FROM documents WHERE id = $1 AND owner_id = $2",
                    )
                    .bind(id)
                    .bind(owner_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| {
                        AppError::Internal(anyhow::anyhow!("Postgres version check error: {e}"))
                    })?;

                    if let Some(r) = check {
                        let server_version: i32 = r.get("version");
                        Ok(UpdateResult::Conflict { server_version })
                    } else {
                        Ok(UpdateResult::NotFound)
                    }
                }
            }
        }
    }

    /// 原子删除文档 (带乐观锁)
    pub async fn delete_document_atomic(
        db: &DbPool,
        id: Uuid,
        owner_id: Uuid,
        expected_version: i32,
    ) -> Result<DeleteResult, AppError> {
        match db {
            DbPool::Sqlite(pool) => {
                let id_str = id.to_string();
                let owner_str = owner_id.to_string();

                let res = sqlx::query(
                    "DELETE FROM documents WHERE id = ?1 AND owner_id = ?2 AND version = ?3",
                )
                .bind(&id_str)
                .bind(&owner_str)
                .bind(expected_version)
                .execute(pool)
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!("SQLite delete error: {e}")))?;

                if res.rows_affected() == 1 {
                    Ok(DeleteResult::Success)
                } else {
                    let check = sqlx::query(
                        "SELECT version FROM documents WHERE id = ?1 AND owner_id = ?2",
                    )
                    .bind(&id_str)
                    .bind(&owner_str)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| {
                        AppError::Internal(anyhow::anyhow!("SQLite delete check error: {e}"))
                    })?;

                    if let Some(r) = check {
                        let server_version: i32 = r.get("version");
                        Ok(DeleteResult::Conflict { server_version })
                    } else {
                        Ok(DeleteResult::NotFound)
                    }
                }
            }
            DbPool::Postgres(pool) => {
                let res = sqlx::query(
                    "DELETE FROM documents WHERE id = $1 AND owner_id = $2 AND version = $3",
                )
                .bind(id)
                .bind(owner_id)
                .bind(expected_version)
                .execute(pool)
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!("Postgres delete error: {e}")))?;

                if res.rows_affected() == 1 {
                    Ok(DeleteResult::Success)
                } else {
                    let check = sqlx::query(
                        "SELECT version FROM documents WHERE id = $1 AND owner_id = $2",
                    )
                    .bind(id)
                    .bind(owner_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| {
                        AppError::Internal(anyhow::anyhow!("Postgres delete check error: {e}"))
                    })?;

                    if let Some(r) = check {
                        let server_version: i32 = r.get("version");
                        Ok(DeleteResult::Conflict { server_version })
                    } else {
                        Ok(DeleteResult::NotFound)
                    }
                }
            }
        }
    }
}
