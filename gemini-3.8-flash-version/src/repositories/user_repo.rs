//! 用户仓储层 (支持 SQLite 与 PostgreSQL 双引擎)

use crate::error::AppError;
use crate::models::User;
use crate::state::DbPool;
use chrono::{DateTime, Utc};
use sqlx::Row;
use uuid::Uuid;

/// 用户仓储
pub struct UserRepo;

impl UserRepo {
    /// 创建新用户
    pub async fn create_user(
        db: &DbPool,
        id: Uuid,
        username: &str,
        password_hash: &str,
    ) -> Result<User, AppError> {
        let now = Utc::now();
        match db {
            DbPool::Sqlite(pool) => {
                let id_str = id.to_string();
                let now_str = now.to_rfc3339();
                let res = sqlx::query(
                    r#"
                    INSERT INTO users (id, username, password_hash, created_at)
                    VALUES (?1, ?2, ?3, ?4)
                    "#,
                )
                .bind(&id_str)
                .bind(username)
                .bind(password_hash)
                .bind(&now_str)
                .execute(pool)
                .await;

                match res {
                    Ok(_) => Ok(User {
                        id,
                        username: username.to_string(),
                        password_hash: password_hash.to_string(),
                        created_at: now,
                    }),
                    Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => {
                        Err(AppError::UsernameTaken)
                    }
                    Err(e) => Err(AppError::Internal(anyhow::anyhow!(
                        "SQLite create_user error: {e}"
                    ))),
                }
            }
            DbPool::Postgres(pool) => {
                let res = sqlx::query(
                    r#"
                    INSERT INTO users (id, username, password_hash, created_at)
                    VALUES ($1, $2, $3, $4)
                    "#,
                )
                .bind(id)
                .bind(username)
                .bind(password_hash)
                .bind(now)
                .execute(pool)
                .await;

                match res {
                    Ok(_) => Ok(User {
                        id,
                        username: username.to_string(),
                        password_hash: password_hash.to_string(),
                        created_at: now,
                    }),
                    Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => {
                        Err(AppError::UsernameTaken)
                    }
                    Err(e) => Err(AppError::Internal(anyhow::anyhow!(
                        "Postgres create_user error: {e}"
                    ))),
                }
            }
        }
    }

    /// 根据用户名查找用户
    pub async fn find_by_username(db: &DbPool, username: &str) -> Result<Option<User>, AppError> {
        match db {
            DbPool::Sqlite(pool) => {
                let row = sqlx::query(
                    r#"
                    SELECT id, username, password_hash, created_at
                    FROM users
                    WHERE username = ?1 COLLATE NOCASE
                    "#,
                )
                .bind(username)
                .fetch_optional(pool)
                .await
                .map_err(|e| {
                    AppError::Internal(anyhow::anyhow!("SQLite find_by_username error: {e}"))
                })?;

                if let Some(r) = row {
                    let id_str: String = r.get("id");
                    let id = Uuid::parse_str(&id_str)
                        .map_err(|e| AppError::Internal(anyhow::anyhow!("Corrupt UUID: {e}")))?;
                    let username: String = r.get("username");
                    let password_hash: String = r.get("password_hash");
                    let created_str: String = r.get("created_at");
                    let created_at = DateTime::parse_from_rfc3339(&created_str)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now());

                    Ok(Some(User {
                        id,
                        username,
                        password_hash,
                        created_at,
                    }))
                } else {
                    Ok(None)
                }
            }
            DbPool::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
                    SELECT id, username, password_hash, created_at
                    FROM users
                    WHERE username = $1
                    "#,
                )
                .bind(username)
                .fetch_optional(pool)
                .await
                .map_err(|e| {
                    AppError::Internal(anyhow::anyhow!("Postgres find_by_username error: {e}"))
                })?;

                if let Some(r) = row {
                    let id: Uuid = r.get("id");
                    let username: String = r.get("username");
                    let password_hash: String = r.get("password_hash");
                    let created_at: DateTime<Utc> = r.get("created_at");

                    Ok(Some(User {
                        id,
                        username,
                        password_hash,
                        created_at,
                    }))
                } else {
                    Ok(None)
                }
            }
        }
    }
}
