//! 配置管理模块 (对齐 ARCHITECTURE.md §2.3 敏感信息脱敏保护)

use std::env;
use std::fmt;
use thiserror::Error;

/// 配置错误
#[derive(Debug, Error)]
pub enum ConfigError {
    /// 缺失关键环境变量
    #[error("Missing required environment variable: {0}")]
    MissingEnv(String),

    /// JWT Secret 熵值不足 (规范要求至少 32 字节)
    #[error("JWT_SECRET must be at least 32 bytes long for security, got {0} bytes")]
    WeakJwtSecret(usize),

    /// 解析数值错误
    #[error("Invalid configuration value for {name}: {source}")]
    ParseError {
        /// 字段名
        name: &'static str,
        /// 底层错误
        source: std::num::ParseIntError,
    },
}

/// 数据库类型
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatabaseKind {
    /// SQLite 嵌入式数据库 (零依赖，开箱即用)
    Sqlite,
    /// PostgreSQL 关系数据库 (对齐课程生产规范)
    Postgres,
}

/// 全局运行配置
#[derive(Clone)]
pub struct Config {
    /// 数据库连接串 (敏感信息，日志脱敏)
    pub database_url: String,
    /// 数据库类型
    pub database_kind: DatabaseKind,
    /// JWT 签名秘钥 (>= 32 字节，敏感信息，日志脱敏)
    pub jwt_secret: String,
    /// JWT 令牌过期时间 (秒)
    pub jwt_ttl_secs: i64,
    /// HTTP 服务监听地址
    pub bind_addr: String,
    /// Gemini API Key (可选，为空时启用高质量仿真/离线模拟模式)
    pub gemini_api_key: Option<String>,
    /// Gemini 模型标识
    pub gemini_model: String,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("database_url", &"<redacted>")
            .field("database_kind", &self.database_kind)
            .field("jwt_secret", &"<redacted>")
            .field("jwt_ttl_secs", &self.jwt_ttl_secs)
            .field("bind_addr", &self.bind_addr)
            .field(
                "gemini_api_key",
                &self.gemini_api_key.as_ref().map(|_| "<redacted>"),
            )
            .field("gemini_model", &self.gemini_model)
            .finish()
    }
}

impl Config {
    /// 校验 JWT Secret 安全强度 (规范要求 >= 32 字节且非空)
    pub fn validate_jwt_secret(secret: &str) -> Result<(), ConfigError> {
        let trimmed = secret.trim();
        if trimmed.is_empty() {
            return Err(ConfigError::MissingEnv("JWT_SECRET".to_string()));
        }
        if trimmed.len() < 32 {
            return Err(ConfigError::WeakJwtSecret(trimmed.len()));
        }
        Ok(())
    }

    /// 从环境变量加载配置
    pub fn from_env() -> Result<Self, ConfigError> {
        let _ = dotenvy::dotenv();

        let database_url = env::var("DATABASE_URL")
            .unwrap_or_else(|_| "sqlite://gemini_editor.db?mode=rwc".to_string());

        let database_kind = if database_url.starts_with("postgres://")
            || database_url.starts_with("postgresql://")
        {
            DatabaseKind::Postgres
        } else {
            DatabaseKind::Sqlite
        };

        let jwt_secret = env::var("JWT_SECRET")
            .map_err(|_| ConfigError::MissingEnv("JWT_SECRET".to_string()))?;

        Self::validate_jwt_secret(&jwt_secret)?;

        let jwt_ttl_secs = match env::var("JWT_TTL_SECS") {
            Ok(val) => val
                .parse::<i64>()
                .map_err(|source| ConfigError::ParseError {
                    name: "JWT_TTL_SECS",
                    source,
                })?,
            Err(_) => 3600,
        };

        let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".to_string());

        let gemini_api_key = env::var("GEMINI_API_KEY")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let gemini_model =
            env::var("GEMINI_MODEL").unwrap_or_else(|_| "gemini-2.0-flash".to_string());

        Ok(Self {
            database_url,
            database_kind,
            jwt_secret,
            jwt_ttl_secs,
            bind_addr,
            gemini_api_key,
            gemini_model,
        })
    }

    /// 构造测试用隔离配置（提供高熵测试密钥，避免依赖外部环境）
    pub fn for_test(database_url: String) -> Self {
        let database_kind = if database_url.starts_with("postgres://")
            || database_url.starts_with("postgresql://")
        {
            DatabaseKind::Postgres
        } else {
            DatabaseKind::Sqlite
        };

        Self {
            database_url,
            database_kind,
            jwt_secret: "test_jwt_secret_must_be_at_least_32_bytes_long_high_entropy".to_string(),
            jwt_ttl_secs: 3600,
            bind_addr: "127.0.0.1:0".to_string(),
            gemini_api_key: None,
            gemini_model: "gemini-2.0-flash".to_string(),
        }
    }
}
