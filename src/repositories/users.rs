//! 数据访问层：users 表的读写。
//!
//! 规范 §07 要求六层解耦，路由**不得**直接写 SQL。本模块是唯一持有
//! users 表 SQL 的地方。
//!
//! # 唯一约束的处理
//!
//! `users_username_unique` 冲突时数据库报 `SqlState::UniqueViolation`（23505）。
//! 本模块把它转成 [`AppError::UsernameTaken`]，路由层无需了解数据库错误码。

use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppError;

/// 用户表的一行。
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRow {
    /// 主键。
    pub id: Uuid,
    /// 归一化后的用户名（小写）。
    pub username: String,
    /// Argon2id PHC 格式哈希串。
    pub password_hash: String,
    /// 注册时间。
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// 判断是否为用户名唯一约束冲突。
///
/// PostgreSQL 错误码 23505 = `unique_violation`。
/// 若能拿到约束名则严格比对；拿不到（部分驱动/错误路径）时按"唯一冲突"处理，
/// 因为本表当前唯一的唯一约束就是 `users_username_unique`。
fn is_username_taken(err: &sqlx::Error) -> bool {
    let sqlx::Error::Database(db_err) = err else {
        return false;
    };
    if db_err.code().as_deref() != Some("23505") {
        return false;
    }
    !matches!(db_err.constraint(), Some(c) if c != "users_username_unique")
}

/// 按用户名查询用户。
///
/// # Errors
///
/// 查询失败时返回 [`AppError::Internal`]。**用户名不存在不算错误**，
/// 返回 `Ok(None)`，由调用方决定如何处理（登录时应与密码错误返回同一个 401）。
pub async fn find_by_username(pool: &PgPool, username: &str) -> Result<Option<UserRow>, AppError> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, password_hash, created_at \
         FROM users WHERE username = $1",
    )
    .bind(username)
    .fetch_optional(pool)
    .await
    .map_err(AppError::internal)?;

    Ok(row)
}

/// 按主键查询用户。
///
/// # Errors
///
/// 查询失败时返回 [`AppError::Internal`]。
pub async fn find_by_id(pool: &PgPool, id: Uuid) -> Result<Option<UserRow>, AppError> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, password_hash, created_at \
         FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::internal)?;

    Ok(row)
}

/// 插入新用户。
///
/// # Errors
///
/// - 用户名已存在 → [`AppError::UsernameTaken`]（409）
/// - 其他数据库错误 → [`AppError::Internal`]（500）
///
/// # Note
///
/// **不预先检查用户名是否存在**——那样会有竞态（两个并发注册都通过检查）。
/// 唯一索引才是最终裁决者，这里只负责把冲突翻译成 409。
pub async fn insert_user(
    pool: &PgPool,
    username: &str,
    password_hash: &str,
) -> Result<UserRow, AppError> {
    let row = sqlx::query_as::<_, UserRow>(
        "INSERT INTO users (username, password_hash) \
         VALUES ($1, $2) \
         RETURNING id, username, password_hash, created_at",
    )
    .bind(username)
    .bind(password_hash)
    .fetch_one(pool)
    .await
    .map_err(|e| {
        if is_username_taken(&e) {
            AppError::UsernameTaken
        } else {
            AppError::internal(e)
        }
    })?;

    Ok(row)
}

/// 把 `created_at` 格式化为 RFC 3339 UTC 字符串。
///
/// 规范 §06 要求时间为 UTC RFC 3339。
#[must_use]
pub fn format_timestamp(ts: chrono::DateTime<chrono::Utc>) -> String {
    ts.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 时间戳格式化为utc_rfc3339() {
        let ts = chrono::DateTime::parse_from_rfc3339("2026-10-20T08:30:00+00:00")
            .expect("解析应成功")
            .with_timezone(&chrono::Utc);
        assert_eq!(format_timestamp(ts), "2026-10-20T08:30:00Z");
    }

    #[test]
    fn 唯一约束识别依赖错误码与约束名() {
        // 非数据库错误一律不算重名
        assert!(!is_username_taken(&sqlx::Error::RowNotFound));
        // PoolTimedOut 等也返回 false
        let e = sqlx::Error::PoolTimedOut;
        assert!(!is_username_taken(&e));
    }
}
