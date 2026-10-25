//! M3_W1 密码校验模块（库入口）。
//!
//! 主项目集成时可直接 `use password_demo::password::{hash_password, verify_password};`，
//! 或把本目录 `src/password.rs` 迁入主项目 `src/auth/password.rs`（签名保持一致）。

pub mod password;

pub use password::{
    Argon2Params, PasswordError, PasswordPolicy, PolicyViolation, hash_password, verify_password,
};
