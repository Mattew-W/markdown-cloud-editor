//! M3_W1 密码校验模块（优化版 v2）
//!
//! 相对 v1（组员原交件）的改动：
//! - 核心逻辑从 `main.rs` 抽到独立模块 `password.rs`，可被主项目作为库引用；
//! - 新增 `PasswordError` 类型化错误，区分「哈希串格式错」「参数/算法不兼容」
//!   「密码不匹配」「哈希计算失败」，不再依赖 `Error::Password` 的模式匹配；
//! - Argon2id 参数（内存 / 迭代 / 并行度 / 输出长度）可配置，不再写死库默认值；
//! - 哈希串缺 salt 或缺 hash 字段时不再被误判为「密码错误」，而是明确报格式错；
//! - 新增密码策略校验函数（不涉及数据库，为 W2 选做项预置）；
//! - 补齐单元测试（正确 / 错误 / 损坏 / 残缺 / 非法参数 / 策略），`cargo fmt` 已通过。
//!
//! ## 安全要点
//! 1. 哈希采用 Argon2id（`argon2` crate 默认算法），慢哈希 + 每密码独立随机盐；
//! 2. 盐随哈希串一起存储（PHC 格式），无需单独建列；
//! 3. 校验时 `password_hash` 的 `PasswordVerifier` 会**沿用哈希串自带的算法与参数**，
//!    因此日后调参不会让历史哈希失效；
//! 4. 全程不存储、不打印明文密码。
//!
//! ## ⚠️ 接线注意：`PasswordPolicy` 不用于注册与登录
//!
//! 本模块的 [`PasswordPolicy`] 默认 `min_length` 是 8，且按**字符**计数；
//! 而项目规范要求密码为 12–128 **UTF-8 字节**。两者不可互换：
//!
//! - 8 个中文字符 = 24 字节 → 字节规则通过，字符规则也通过；
//! - 12 个 emoji = 48 字节 → 字节规则通过；
//! - 11 个 ASCII 字符 = 11 字节 → 字节规则**拒绝**，字符规则却放行。
//!
//! 因此注册与登录接口走 [`crate::auth::dto::validate_password`] 的字节规则，
//! **不要**调用本模块的策略函数。误用会放过 8–11 字节的弱密码。

use std::fmt;

use argon2::password_hash::{
    Error as HashError, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rand_core::OsRng;

/// Argon2id 计算参数。
///
/// 默认值与 `argon2` crate 的库默认一致（m=19456 KiB, t=2, p=1, 输出 32 字节），
/// 但在此显式写出，便于按服务器性能调整并纳入 `config.rs`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2Params {
    /// 内存代价（KiB）。
    pub memory_kib: u32,
    /// 迭代次数。
    pub iterations: u32,
    /// 并行度（lanes）。
    pub parallelism: u32,
    /// 输出哈希长度（字节）。
    pub output_len: usize,
}

impl Default for Argon2Params {
    fn default() -> Self {
        Self {
            memory_kib: 19_456,
            iterations: 2,
            parallelism: 1,
            output_len: 32,
        }
    }
}

impl Argon2Params {
    /// 转换为 `argon2` crate 的 `Params`。
    ///
    /// # Errors
    /// 返回 [`PasswordError::InvalidParams`]：内存、迭代、并行度或输出长度不合法。
    pub fn to_params(&self) -> Result<Params, PasswordError> {
        Params::new(
            self.memory_kib,
            self.iterations,
            self.parallelism,
            Some(self.output_len),
        )
        .map_err(|e| PasswordError::InvalidParams(e.to_string()))
    }
}

/// 密码校验相关的类型化错误。
#[derive(Debug)]
pub enum PasswordError {
    /// 哈希串格式非法（含非法字符、缺少 salt / hash 字段等）。**不是**密码错误。
    InvalidHashFormat(String),
    /// 哈希串中的算法 / 版本 / 参数与当前实现不兼容。
    IncompatibleParams(String),
    /// 密码不匹配（哈希合法，但算出的值对不上）。
    PasswordMismatch,
    /// 哈希计算过程本身出错。
    HashingFailed(String),
    /// Argon2 参数本身不合法。
    InvalidParams(String),
}

impl fmt::Display for PasswordError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidHashFormat(m) => write!(f, "哈希字符串格式非法: {m}"),
            Self::IncompatibleParams(m) => write!(f, "哈希参数与当前实现不兼容: {m}"),
            Self::PasswordMismatch => write!(f, "密码与哈希不匹配"),
            Self::HashingFailed(m) => write!(f, "密码哈希计算失败: {m}"),
            Self::InvalidParams(m) => write!(f, "Argon2 参数不合法: {m}"),
        }
    }
}

impl std::error::Error for PasswordError {}

impl From<HashError> for PasswordError {
    fn from(e: HashError) -> Self {
        match e {
            // 密码不匹配：唯一的「正常失败」分支。
            HashError::Password => Self::PasswordMismatch,
            // 算法 / 版本 / 参数相关：哈希串本身来自别的实现或旧参数集。
            HashError::Algorithm
            | HashError::Version
            | HashError::ParamValueInvalid(_)
            | HashError::ParamNameInvalid
            | HashError::ParamNameDuplicated
            | HashError::ParamsMaxExceeded
            | HashError::OutputSize { .. } => Self::IncompatibleParams(e.to_string()),
            // 底层加密原语失败。
            HashError::Crypto => Self::HashingFailed(e.to_string()),
            // 其余（PHC 串字段缺失、尾部多余数据、Base64 非法、盐非法）均为格式问题。
            other => Self::InvalidHashFormat(other.to_string()),
        }
    }
}

/// 密码策略检查结果：不通过时列出具体原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyViolation {
    /// 违规项的机器可读标识。
    pub code: &'static str,
    /// 面向用户的说明。
    pub message: String,
}

/// 密码策略：最小长度、是否要求含字母、是否要求含数字。
#[derive(Debug, Clone, Copy)]
pub struct PasswordPolicy {
    /// 最小长度（按字符计，非字节）。
    pub min_length: usize,
    /// 是否必须包含字母。
    pub require_letter: bool,
    /// 是否必须包含数字。
    pub require_digit: bool,
}

impl Default for PasswordPolicy {
    fn default() -> Self {
        Self {
            min_length: 8,
            require_letter: true,
            require_digit: true,
        }
    }
}

impl PasswordPolicy {
    /// 按策略检查密码，返回全部违规项；全部通过时返回空 `Vec`。
    ///
    /// 该函数**不**做任何哈希运算，只做明文字符级检查，
    /// 便于放在注册 / 改密接口的最前端拦截弱密码。
    pub fn check(&self, password: &str) -> Vec<PolicyViolation> {
        let mut violations = Vec::new();

        if password.chars().count() < self.min_length {
            violations.push(PolicyViolation {
                code: "TOO_SHORT",
                message: format!("密码长度至少 {} 个字符", self.min_length),
            });
        }
        if self.require_letter && !password.chars().any(char::is_alphabetic) {
            violations.push(PolicyViolation {
                code: "MISSING_LETTER",
                message: "密码必须包含字母".to_string(),
            });
        }
        if self.require_digit && !password.chars().any(|c| c.is_ascii_digit()) {
            violations.push(PolicyViolation {
                code: "MISSING_DIGIT",
                message: "密码必须包含数字".to_string(),
            });
        }

        violations
    }
}

/// 用 Argon2id + 随机盐为密码生成哈希串（PHC 格式）。
///
/// 每次调用都用 `OsRng` 生成**全新随机盐**，因此同一密码两次调用得到的
/// 字符串必然不同，但两者都能通过 [`verify_password`] 验证。
///
/// # Errors
/// 返回 [`PasswordError::InvalidParams`]（参数不合法）或
/// [`PasswordError::HashingFailed`]（哈希计算失败）。
pub fn hash_password(password: &str, params: &Argon2Params) -> Result<String, PasswordError> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params.to_params()?);
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| PasswordError::HashingFailed(e.to_string()))?;
    Ok(hash.to_string())
}

/// 校验输入密码是否与给定哈希串匹配。
///
/// 关键行为：
/// - 哈希串格式非法（含缺 salt / 缺 hash）→ [`PasswordError::InvalidHashFormat`]，
///   **不会** panic，也**不会**被误报成「密码错误」；
/// - 哈希合法但密码不对 → [`PasswordError::PasswordMismatch`]；
/// - 算法 / 版本 / 参数不兼容 → [`PasswordError::IncompatibleParams`]；
/// - 校验时 `password_hash` 的 `PasswordVerifier` 会**沿用哈希串自带的算法与参数**，
///   因此日后调整全局 Argon2id 参数也不会让历史哈希失效。
///
/// # Errors
/// 见 [`PasswordError`] 各变体。
pub fn verify_password(password: &str, hash_str: &str) -> Result<(), PasswordError> {
    let parsed =
        PasswordHash::new(hash_str).map_err(|e| PasswordError::InvalidHashFormat(e.to_string()))?;

    // password_hash 的 `verify_password` 在缺少 salt 或 hash 字段时会返回
    // `Error::Password`，那会被误读成「密码错误」。这里提前拦下，明确报格式错。
    if parsed.salt.is_none() || parsed.hash.is_none() {
        return Err(PasswordError::InvalidHashFormat(
            "缺少 salt 或 hash 字段".to_string(),
        ));
    }

    // `PasswordVerifier` 的默认实现会读取 `parsed.algorithm` / `parsed.version` /
    // `parsed.params` 重新构造哈希实例，即沿用哈希串自带参数。
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .map_err(PasswordError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEMO_PASSWORD: &str = "Correct-Horse-Battery-Staple";

    /// 较重的一组参数，用于验证「参数随哈希串走」的行为。
    const HEAVY: Argon2Params = Argon2Params {
        memory_kib: 32_768,
        iterations: 3,
        parallelism: 1,
        output_len: 32,
    };

    #[test]
    fn 正确密码验证通过() {
        let hash =
            hash_password(DEMO_PASSWORD, &Argon2Params::default()).expect("哈希生成不应失败");
        assert!(verify_password(DEMO_PASSWORD, &hash).is_ok());
    }

    #[test]
    fn 错误密码被拒绝且归类为不匹配() {
        let hash =
            hash_password(DEMO_PASSWORD, &Argon2Params::default()).expect("哈希生成不应失败");
        let err = verify_password("wrong-password-123", &hash).expect_err("错误密码必须被拒绝");
        assert!(matches!(err, PasswordError::PasswordMismatch));
    }

    #[test]
    fn 损坏哈希返回错误且不崩溃() {
        let corrupted = "$argon2id$v=19$m=19456,t=2,p=1$很坏的盐$完全不对的哈希";
        let err = verify_password(DEMO_PASSWORD, corrupted).expect_err("损坏哈希必须返回错误");
        assert!(matches!(err, PasswordError::InvalidHashFormat(_)));
    }

    #[test]
    fn 空串与残缺串不触发panic() {
        for bad in ["", "$", "$argon2id$", "not-a-hash", "$$$$"] {
            assert!(verify_password(DEMO_PASSWORD, bad).is_err());
        }
    }

    #[test]
    fn 缺salt或缺hash的串报格式错而非密码错() {
        // 只有算法与参数、没有盐和哈希值：应判为格式非法，不能判成「密码不匹配」。
        let incomplete = "$argon2id$v=19$m=19456,t=2,p=1";
        let err = verify_password(DEMO_PASSWORD, incomplete).expect_err("残缺串必须返回错误");
        assert!(matches!(err, PasswordError::InvalidHashFormat(_)));
    }

    #[test]
    fn 同一密码两次哈希不同但都能验证() {
        let params = Argon2Params::default();
        let a = hash_password(DEMO_PASSWORD, &params).expect("哈希生成不应失败");
        let b = hash_password(DEMO_PASSWORD, &params).expect("哈希生成不应失败");
        assert_ne!(a, b, "随机盐应导致两次哈希不同");
        assert!(verify_password(DEMO_PASSWORD, &a).is_ok());
        assert!(verify_password(DEMO_PASSWORD, &b).is_ok());
    }

    #[test]
    fn 校验沿用哈希串自带参数() {
        // 用较重参数生成，随后校验：应通过，因为参数取自哈希串而非当前配置。
        let hash = hash_password(DEMO_PASSWORD, &HEAVY).expect("哈希生成不应失败");
        assert!(verify_password(DEMO_PASSWORD, &hash).is_ok());
    }

    #[test]
    fn 不同参数生成的哈希互不通用() {
        let a = hash_password(DEMO_PASSWORD, &Argon2Params::default()).expect("不应失败");
        let b = hash_password(DEMO_PASSWORD, &HEAVY).expect("不应失败");
        assert_ne!(a, b);
        // 两个哈希各自都验证通过
        assert!(verify_password(DEMO_PASSWORD, &a).is_ok());
        assert!(verify_password(DEMO_PASSWORD, &b).is_ok());
    }

    #[test]
    fn 非法参数被拒绝() {
        let bad = Argon2Params {
            memory_kib: 0,
            iterations: 2,
            parallelism: 1,
            output_len: 32,
        };
        assert!(matches!(
            hash_password(DEMO_PASSWORD, &bad),
            Err(PasswordError::InvalidParams(_))
        ));
    }

    #[test]
    fn 密码策略检查() {
        let policy = PasswordPolicy::default();
        // clippy::assert_is_empty：直接比较长度而非 .is_empty()。
        assert_eq!(policy.check("Abcdef12").len(), 0);
        assert_eq!(policy.check("Ab1").len(), 1);
        assert_eq!(policy.check("abcdefgh").len(), 1);
        assert_eq!(policy.check("12345678").len(), 1);
        assert_eq!(policy.check("ab").len(), 2);
    }
}
