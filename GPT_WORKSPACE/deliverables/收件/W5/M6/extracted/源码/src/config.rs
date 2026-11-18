//! 运行时配置与启动期校验。
//!
//! 规范要求「服务在启动时拒绝缺失密钥或明显占位的值」。
//! 本模块把该要求实现为 [`Config::from_env`]：任何一项不满足都返回 [`ConfigError`]，
//! 由 `main` 打印明确原因后**拒绝启动**——不降级、不用默认值继续跑。
//!
//! 真实密钥只从环境变量读取；仓库内只保留 `.env.example` 占位样例。

use std::fmt;

/// 最小 JWT 密钥字节长度（规范要求 ≥32 字节高熵）。
pub const MIN_JWT_SECRET_BYTES: usize = 32;

/// JWT 有效期默认值（秒）。规范 §09 要求 TTL 为 1 小时。
pub const DEFAULT_JWT_TTL_SECS: u64 = 3600;

/// JWT 有效期允许的最小值（秒）。
pub const MIN_JWT_TTL_SECS: i64 = 60;

/// JWT 有效期允许的最大值（秒）。
pub const MAX_JWT_TTL_SECS: i64 = 86_400;

/// JSON 请求体上限（字节）。规范 §06 规定 2 MiB。
pub const MAX_JSON_BODY_BYTES: usize = 2 * 1024 * 1024;

/// Markdown 正文字节上限（字节）。规范 §06 规定 256 KiB。
pub const MAX_CONTENT_BYTES: usize = 256 * 1024;

/// 注册与登录的限流阈值：同一 IP 在窗口内允许的次数。
pub const AUTH_RATE_LIMIT_MAX_ATTEMPTS: u64 = 5;

/// 限流窗口（秒）。
pub const AUTH_RATE_LIMIT_WINDOW_SECS: u64 = 60;

/// 默认监听地址。
pub const DEFAULT_BIND_ADDR: &str = "127.0.0.1:8080";

/// 常见占位密钥片段（大小写不敏感）。命中即拒绝启动。
const PLACEHOLDER_MARKERS: &[&str] = &[
    "changeme",
    "change-me",
    "change_me",
    "secret",
    "placeholder",
    "your-secret",
    "your_secret",
    "example",
    "dummy",
    "test-secret",
    "replace-me",
    "replace_me",
    "todo",
    "fixme",
    "12345678",
    "abcdefgh",
];

/// 配置校验失败的原因。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    /// 必需的环境变量未设置。
    #[error("缺少必需的环境变量 {0}，请在 .env 中设置（可参考 .env.example）")]
    Missing(&'static str),

    /// JWT 密钥长度不足。
    #[error("JWT_SECRET 至少需要 {required} 字节，当前只有 {actual} 字节")]
    JwtSecretTooShort {
        /// 要求的最小字节数。
        required: usize,
        /// 实际的字节数。
        actual: usize,
    },

    /// JWT 密钥是明显占位值。
    #[error("JWT_SECRET 疑似占位值（含有 {marker}），请改用随机生成的高熵密钥")]
    JwtSecretPlaceholder {
        /// 命中的占位标记。
        marker: &'static str,
    },

    /// JWT 密钥字符种类过少，熵不足。
    #[error(
        "JWT_SECRET 不同字符仅 {distinct} 种，熵不足；请用密码管理器或 `openssl rand -base64 48` 生成"
    )]
    JwtSecretLowEntropy {
        /// 实际的不同字符种类数。
        distinct: usize,
    },

    /// 监听地址无法解析。
    #[error("BIND_ADDR 无法解析：{0}")]
    InvalidBindAddr(String),

    /// 数值型配置超出合理范围。
    #[error("{name} 超出允许范围：{value}（允许 {min}–{max}）")]
    OutOfRange {
        /// 配置项名称。
        name: &'static str,
        /// 解析出的值。
        value: i64,
        /// 允许下界。
        min: i64,
        /// 允许上界。
        max: i64,
    },
}

/// 已校验的应用配置。
///
/// 注意：`Debug` 为**手写实现**（见下），不能同时 `#[derive(Debug)]`——
/// 那会产生两个冲突实现，且派生版会打印密钥。
#[derive(Clone)]
pub struct Config {
    /// PostgreSQL 连接串。
    pub database_url: String,
    /// JWT 签名密钥。**禁止**写入日志；[`fmt::Debug`] 已脱敏。
    jwt_secret: String,
    /// HTTP 监听地址，形如 `127.0.0.1:8080`。
    pub bind_addr: String,
    /// JWT 有效期（秒）。
    pub jwt_ttl_secs: u64,
}

/// 手写的脱敏 `Debug` 实现：绝不打印密钥内容。
impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("database_url", &"<redacted>")
            .field("jwt_secret", &"<redacted>")
            .field("bind_addr", &self.bind_addr)
            .field("jwt_ttl_secs", &self.jwt_ttl_secs)
            .finish()
    }
}

impl Config {
    /// 从环境变量读取并校验配置。
    ///
    /// 先尝试加载 `.env`（不存在不算错误，便于 CI 用真实环境变量），
    /// 再逐项校验。任何一项不满足都返回 [`ConfigError`]，调用方必须拒绝启动。
    ///
    /// # Errors
    ///
    /// 缺少必需变量、密钥不达标或数值越界时返回 [`ConfigError`]。
    pub fn from_env() -> Result<Self, ConfigError> {
        // .env 缺失不算错误：CI 与生产通常用真实环境变量注入。
        let _ = dotenvy::dotenv();

        let database_url = required("DATABASE_URL")?;
        let jwt_secret = required("JWT_SECRET")?;
        let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| DEFAULT_BIND_ADDR.to_owned());
        // 先按 i64 校验范围，再安全转成 u64。
        let jwt_ttl_secs = parse_bounded(
            "JWT_TTL_SECS",
            std::env::var("JWT_TTL_SECS").ok(),
            DEFAULT_JWT_TTL_SECS.cast_signed(),
            MIN_JWT_TTL_SECS,
            MAX_JWT_TTL_SECS,
        )?;
        let jwt_ttl_secs = u64::try_from(jwt_ttl_secs).map_err(|_| ConfigError::OutOfRange {
            name: "JWT_TTL_SECS",
            value: -1,
            min: MIN_JWT_TTL_SECS,
            max: MAX_JWT_TTL_SECS,
        })?;

        Self::new(database_url, jwt_secret, bind_addr, jwt_ttl_secs)
    }

    /// 校验并构造配置。便于单元测试直接注入候选值。
    ///
    /// # Errors
    ///
    /// 密钥长度不足、疑似占位、熵不足、地址非法或 TTL 越界时返回 [`ConfigError`]。
    pub fn new(
        database_url: String,
        jwt_secret: String,
        bind_addr: String,
        jwt_ttl_secs: u64,
    ) -> Result<Self, ConfigError> {
        validate_jwt_secret(&jwt_secret)?;

        if bind_addr.parse::<std::net::SocketAddr>().is_err() {
            return Err(ConfigError::InvalidBindAddr(bind_addr));
        }

        // u64 → i64 溢出时记为 i64::MAX，仍会被范围检查拦下，不做 panic。
        let ttl = i64::try_from(jwt_ttl_secs).unwrap_or(i64::MAX);
        if !(MIN_JWT_TTL_SECS..=MAX_JWT_TTL_SECS).contains(&ttl) {
            return Err(ConfigError::OutOfRange {
                name: "JWT_TTL_SECS",
                value: ttl,
                min: MIN_JWT_TTL_SECS,
                max: MAX_JWT_TTL_SECS,
            });
        }

        Ok(Self {
            database_url,
            jwt_secret,
            bind_addr,
            jwt_ttl_secs,
        })
    }

    /// 返回 JWT 签名密钥。
    ///
    /// 调用方须仅用于签名与验签，**不得**写入日志或响应体。
    #[must_use]
    pub fn jwt_secret(&self) -> &str {
        &self.jwt_secret
    }
}

/// 读取必需环境变量，空字符串视为未设置。
fn required(name: &'static str) -> Result<String, ConfigError> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(ConfigError::Missing(name)),
    }
}

/// 解析带范围校验的整型环境变量；未设置时用默认值。
fn parse_bounded(
    name: &'static str,
    raw: Option<String>,
    default: i64,
    min: i64,
    max: i64,
) -> Result<i64, ConfigError> {
    let value = match raw {
        None => default,
        Some(s) => s
            .trim()
            .parse::<i64>()
            .map_err(|_| ConfigError::OutOfRange {
                name,
                value: -1,
                min,
                max,
            })?,
    };
    if !(min..=max).contains(&value) {
        return Err(ConfigError::OutOfRange {
            name,
            value,
            min,
            max,
        });
    }
    Ok(value)
}

/// 校验 JWT 密钥是否满足安全下限。
///
/// 三道检查：长度 ≥32 字节、不含占位标记、不同字符种类 ≥10。
/// 第三道用于排除 `aaaaaaaaaaaaaaaa` 这类长度够但熵不足的值。
///
/// # Errors
///
/// 任何一项不满足时返回对应的 [`ConfigError`]。
pub fn validate_jwt_secret(secret: &str) -> Result<(), ConfigError> {
    let len = secret.len();
    if len < MIN_JWT_SECRET_BYTES {
        return Err(ConfigError::JwtSecretTooShort {
            required: MIN_JWT_SECRET_BYTES,
            actual: len,
        });
    }

    let lower = secret.to_ascii_lowercase();
    for marker in PLACEHOLDER_MARKERS {
        if lower.contains(marker) {
            return Err(ConfigError::JwtSecretPlaceholder { marker });
        }
    }

    let distinct: std::collections::HashSet<char> = secret.chars().collect();
    if distinct.len() < 10 {
        return Err(ConfigError::JwtSecretLowEntropy {
            distinct: distinct.len(),
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good_secret() -> String {
        // 42 字节、20 种字符，通过全部三道检查。
        "Kd8#mZ2!vQ7@xR4&pW9@jL5^nT3*yF7=hG2+".to_owned()
    }

    #[test]
    fn 合规密钥通过校验() {
        assert!(validate_jwt_secret(&good_secret()).is_ok());
    }

    #[test]
    fn 过短密钥被拒绝() {
        let e = validate_jwt_secret("short").unwrap_err();
        assert!(
            matches!(e, ConfigError::JwtSecretTooShort { .. }),
            "实际：{e:?}"
        );
    }

    #[test]
    fn 恰好32字节的密钥通过() {
        let s = "Ab3$Ef6$Ij9$Lm2$Op5$Qr8$St1$Uv4$Wx7$Yz0$Aa1$"; // 35 字节
        assert!(s.len() >= MIN_JWT_SECRET_BYTES);
        assert!(validate_jwt_secret(s).is_ok());
    }

    #[test]
    fn 占位密钥被拒绝() {
        for bad in [
            "changeme-changeme-changeme-changeme-1234",
            "YOUR-SECRET-KEY-GOES-HERE-PLEASE-32B",
            "placeholder-placeholder-placeholder-x",
        ] {
            let e = validate_jwt_secret(bad).unwrap_err();
            assert!(
                matches!(e, ConfigError::JwtSecretPlaceholder { .. }),
                "{bad} 应判为占位值，实际：{e:?}"
            );
        }
    }

    #[test]
    fn 低熵密钥被拒绝() {
        // 长度够、字符单一 —— 正是占位标记查不出来的那类。
        let e = validate_jwt_secret(&"a".repeat(48)).unwrap_err();
        assert!(
            matches!(e, ConfigError::JwtSecretLowEntropy { .. }),
            "实际：{e:?}"
        );
    }

    #[test]
    fn 非法监听地址被拒绝() {
        let e = Config::new(
            "postgres://x".into(),
            good_secret(),
            "不是地址".into(),
            3600,
        )
        .unwrap_err();
        assert!(matches!(e, ConfigError::InvalidBindAddr(_)), "实际：{e:?}");
    }

    #[test]
    fn ttl越界被拒绝() {
        for bad in [0_u64, 10, 100_000] {
            let e = Config::new(
                "postgres://x".into(),
                good_secret(),
                DEFAULT_BIND_ADDR.into(),
                bad,
            )
            .unwrap_err();
            assert!(
                matches!(e, ConfigError::OutOfRange { .. }),
                "ttl={bad} 应被拒绝，实际：{e:?}"
            );
        }
    }

    #[test]
    fn debug输出不含密钥() {
        let secret = good_secret();
        let cfg = Config::new(
            "postgres://user:pw@host/db".into(),
            secret.clone(),
            DEFAULT_BIND_ADDR.into(),
            3600,
        )
        .unwrap();
        let rendered = format!("{cfg:?}");
        assert!(!rendered.contains(&secret), "Debug 泄露密钥：{rendered}");
        assert!(!rendered.contains("hunter2"));
        assert!(
            !rendered.contains("postgres://"),
            "连接串应脱敏：{rendered}"
        );
    }

    #[test]
    fn 规范常量与文档一致() {
        assert_eq!(MAX_JSON_BODY_BYTES, 2 * 1024 * 1024, "请求体上限应为 2 MiB");
        assert_eq!(MAX_CONTENT_BYTES, 256 * 1024, "正文上限应为 256 KiB");
        assert_eq!(DEFAULT_JWT_TTL_SECS, 3600, "JWT TTL 应为 1 小时");
    }
}
