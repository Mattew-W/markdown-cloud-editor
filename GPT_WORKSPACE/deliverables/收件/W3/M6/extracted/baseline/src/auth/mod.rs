//! 身份认证：密码哈希与 JWT 签发。
//!
//! # 模块边界（规范 §07 六层解耦）
//!
//! | 子模块 | 职责 | 依赖 |
//! |---|---|---|
//! | [`password`] | Argon2id 哈希与校验（**M3 交付**，纯逻辑） | 无数据库 |
//! | [`token`] | JWT 签发与验签 | 仅密钥 |
//! | [`dto`] | 请求/响应结构与输入校验 | 无 |
//! | [`extractor`] | HTTP 请求中提取已认证用户 | JWT 密钥 |
//!
//! 三层都**不依赖数据库**。数据访问在 [`crate::repositories`]，
//! 路由组装在 [`crate::routes::auth`]。这样密码学与 HTTP 逻辑可独立测试。
//!
//! # 安全约定
//!
//! - 明文密码只在请求生命周期内存活，不写入日志、不回显；
//! - 登录失败（密码错）与用户名不存在**统一返回 401**，不区分，避免用户枚举；
//! - 校验签发成功、验签失败的哈希串属于**数据损坏**，映射 500 而非 401。

pub mod dto;
pub mod extractor;
pub mod password;
pub mod token;

pub use extractor::AuthenticatedUser;
pub use password::{Argon2Params, PasswordError};
pub use token::{Claims, TokenError, decode_token, issue_token};
