//! 密码哈希与防时序攻击验证 (严格对齐 INTERFACES.md §1 M3 冻结契约)

use crate::error::AppError;
use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};

/// 预计算的虚拟 Argon2id 哈希，用于用户不存在时对齐运算时间，彻底消除时序侧信道
/// 参数与标准 Argon2id 完全对齐 (m=19456, t=2, p=1)
pub const DUMMY_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$77+977+977+977+977+977+977+977+9$77+977+977+977+977+977+977+977+977+977+977+977+9";

/// Argon2id 计算参数 (对齐 INTERFACES.md §1.2)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2Params {
    /// 内存代价（KiB）
    pub memory_kib: u32,
    /// 迭代次数
    pub iterations: u32,
    /// 并行度（lanes）
    pub parallelism: u32,
    /// 输出哈希长度（字节）
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

/// 密码操作错误类型 (对齐 INTERFACES.md §1.2 与 §1.3)
#[derive(Debug, thiserror::Error)]
pub enum PasswordError {
    /// 哈希格式非法
    #[error("Invalid hash format: {0}")]
    InvalidHashFormat(String),
    /// 参数不兼容
    #[error("Incompatible params: {0}")]
    IncompatibleParams(String),
    /// 密码不匹配
    #[error("Password mismatch")]
    PasswordMismatch,
    /// 哈希计算失败
    #[error("Hashing failed: {0}")]
    HashingFailed(String),
    /// 参数非法
    #[error("Invalid params: {0}")]
    InvalidParams(String),
}

/// 用 Argon2id + 随机盐生成哈希串（PHC 格式）
pub fn hash_password(password: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    let params = Argon2Params::default();
    let argon2_params = argon2::Params::new(
        params.memory_kib,
        params.iterations,
        params.parallelism,
        Some(params.output_len),
    )
    .map_err(|e| AppError::Internal(anyhow::anyhow!("Invalid Argon2 params: {e}")))?;

    let argon2 = Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon2_params,
    );

    let password_hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Argon2 hash failed: {e}")))?
        .to_string();
    Ok(password_hash)
}

/// 校验密码是否与给定哈希串匹配
pub fn verify_password(password: &str, password_hash: &str) -> bool {
    let Ok(parsed_hash) = PasswordHash::new(password_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok()
}

/// 用户不存在时执行虚拟哈希校验，消耗相同的 CPU 时钟周期
pub fn verify_dummy(password: &str) {
    let _ = verify_password(password, DUMMY_HASH);
}
