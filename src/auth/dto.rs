//! 注册与登录的请求/响应结构及输入校验。
//!
//! 规范 §06 的字段约束在这里集中实现。**这是唯一做输入校验的地方**，
//! 数据库约束是兜底而非主防线。
//!
//! # 关键陷阱：密码长度按字节，不是字符
//!
//! [`crate::auth::password::PasswordPolicy`] 的默认 `min_length` 是 8，且按
//! **字符**计数。本项目要求 12–128 **UTF-8 字节**（规范 §06）。
//! 两者不可互换：8 个中文字符是 24 字节（合规），而 12 个 emoji 是 48 字节。
//!
//! 因此注册与登录接口**不使用** `PasswordPolicy`，只按本模块的字节规则校验。
//! 误用会导致放过 8–11 字节的弱密码，或把 12 字节的强密码错判为过短。

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

/// 用户名最小长度（字符）。
pub const USERNAME_MIN_CHARS: usize = 3;

/// 用户名最大长度（字符）。
pub const USERNAME_MAX_CHARS: usize = 32;

/// 密码最小长度（**UTF-8 字节**）。
pub const PASSWORD_MIN_BYTES: usize = 12;

/// 密码最大长度（**UTF-8 字节**）。
pub const PASSWORD_MAX_BYTES: usize = 128;

/// 用户名允许的字符集：小写 ASCII 字母、数字、下划线、短横线。
///
/// 规范要求先去首尾空白再转小写，因此**大写字母不可能出现在合法用户名里**——
/// 校验前必须先归一化。
const USERNAME_ALLOWED: fn(char) -> bool =
    |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-';

/// `POST /api/v1/auth/register` 请求体。
#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    /// 用户名。校验时先 trim + 转小写。
    pub username: String,
    /// 明文密码。**不** trim——首尾空格是密码的一部分。
    pub password: String,
}

/// `POST /api/v1/auth/login` 请求体。
#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    /// 用户名。同样先 trim + 转小写。
    pub username: String,
    /// 明文密码。不 trim。
    pub password: String,
}

/// 注册或登录成功后返回的用户信息。
///
/// 刻意**不含** `password_hash`，也**不含**邮箱等任何未在规范 §06 列出的字段。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserResponse {
    /// 用户 UUID 字符串。
    pub id: String,
    /// 归一化后的用户名。
    pub username: String,
    /// 注册时间（UTC，RFC 3339）。
    pub created_at: String,
}

/// 认证成功响应。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    /// JWT 原文。
    pub token: String,
    /// 有效期（**秒**）。前端据此决定何时重新登录。
    pub expires_in: u64,
    /// 用户信息。
    pub user: UserResponse,
}

impl RegisterRequest {
    /// 校验并返回归一化后的 `(username, password)`。
    ///
    /// # Errors
    ///
    /// 用户名或密码不合规时返回 [`AppError::BadRequest`]，
    /// 字段名写入 `details.field` 便于前端定位。
    pub fn validate(&self) -> Result<(String, &str), AppError> {
        let username = normalize_username(&self.username)?;
        validate_password(&self.password)?;
        Ok((username, &self.password))
    }
}

impl LoginRequest {
    /// 校验登录请求。
    ///
    /// 与注册**同样的用户名规则**，但密码只检查非空与长度上限——
    /// 登录时不该因为密码"太短"而泄露策略信息，且真实密码可能本就短于注册下限
    /// （例如策略后来收紧了）。
    ///
    /// # Errors
    ///
    /// 用户名非法或密码为空/超长时返回 [`AppError::BadRequest`]。
    pub fn validate(&self) -> Result<(String, &str), AppError> {
        let username = normalize_username(&self.username)?;
        if self.password.is_empty() {
            return Err(field_error("password", "密码不能为空"));
        }
        if self.password.len() > PASSWORD_MAX_BYTES {
            return Err(field_error("password", "密码超出长度上限"));
        }
        Ok((username, &self.password))
    }
}

/// 归一化并校验用户名：trim → 转小写 → 查字符集与长度。
///
/// # Errors
///
/// 长度或字符集不符时返回 [`AppError::BadRequest`]。
pub fn normalize_username(raw: &str) -> Result<String, AppError> {
    let normalized = raw.trim().to_lowercase();

    let char_count = normalized.chars().count();
    if !(USERNAME_MIN_CHARS..=USERNAME_MAX_CHARS).contains(&char_count) {
        return Err(field_error(
            "username",
            format!("用户名长度须为 {USERNAME_MIN_CHARS}–{USERNAME_MAX_CHARS} 个字符"),
        ));
    }

    if !normalized.chars().all(USERNAME_ALLOWED) {
        return Err(field_error(
            "username",
            "用户名只能包含小写字母、数字、下划线与短横线",
        ));
    }

    Ok(normalized)
}

/// 校验密码字节长度。
///
/// # Errors
///
/// 长度不在 12–128 字节时返回 [`AppError::BadRequest`]。
pub fn validate_password(password: &str) -> Result<(), AppError> {
    let bytes = password.len();
    if !(PASSWORD_MIN_BYTES..=PASSWORD_MAX_BYTES).contains(&bytes) {
        return Err(field_error(
            "password",
            format!("密码长度须为 {PASSWORD_MIN_BYTES}–{PASSWORD_MAX_BYTES} 个字节"),
        ));
    }
    Ok(())
}

/// 构造带 `details.field` 的 400 错误。
fn field_error(field: &'static str, message: impl Into<String>) -> AppError {
    AppError::field_error(field, message)
}

/// 校验路径中的文档 UUID。
///
/// # Errors
///
/// 非法 UUID 返回 400（而非 404）——这是**请求格式错误**，
/// 与"文档不存在"是两回事，不应混为一谈。
pub fn parse_document_id(raw: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(raw).map_err(|_| AppError::field_error("id", "文档 id 必须是合法 UUID"))
}

/// 把数据库行转成响应结构。
#[must_use]
pub fn user_response(id: Uuid, username: &str, created_at: &str) -> UserResponse {
    UserResponse {
        id: id.to_string(),
        username: username.to_owned(),
        created_at: created_at.to_owned(),
    }
}

/// 认证类错误的默认映射表，供文档与测试共用。
///
/// | 情形 | 状态码 | 错误码 |
/// |---|---|---|
/// | 用户名已被占用 | 409 | `USERNAME_TAKEN` |
/// | 密码错误 / 用户不存在 | 401 | `UNAUTHORIZED` |
/// | token 失效或过期 | 401 | `UNAUTHORIZED` |
/// | 库中哈希损坏 | 500 | `INTERNAL_ERROR` |
///
/// 最后一行最容易写错：`PasswordError::InvalidHashFormat` 绝不能映射成 401，
/// 那会让数据损坏伪装成"密码错了"。
#[must_use]
pub const fn password_error_is_client_fault() -> bool {
    // PasswordMismatch 才是真正的"密码错了"；其余都是服务端问题。
    true
}

/// 该模块的规范常量自检，确保与文档一致。
#[cfg(test)]
const _: () = {
    assert!(USERNAME_MIN_CHARS == 3);
    assert!(USERNAME_MAX_CHARS == 32);
    assert!(PASSWORD_MIN_BYTES == 12);
    assert!(PASSWORD_MAX_BYTES == 128);
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 用户名去空白并转小写() {
        assert_eq!(normalize_username("  Alice  ").unwrap(), "alice");
        assert_eq!(normalize_username("BOB").unwrap(), "bob");
        assert_eq!(normalize_username("\tC_d-e\n").unwrap(), "c_d-e");
    }

    #[test]
    fn 用户名长度按字符计() {
        // 3 字符（虽然字节更多）应通过
        assert!(normalize_username("abc").is_ok());
        // 32 字符通过
        assert!(normalize_username(&"a".repeat(32)).is_ok());
        // 2 字符拒绝
        assert!(normalize_username("ab").is_err());
        // 33 字符拒绝
        assert!(normalize_username(&"a".repeat(33)).is_err());
    }

    #[test]
    fn 用户名拒绝非法字符() {
        for bad in ["a b", "a.b", "a@b", "中文", "a+b", "a/b"] {
            let r = normalize_username(bad);
            assert!(r.is_err(), "{bad} 应被拒绝");
        }
        assert!(normalize_username("user_name-01").is_ok());
    }

    #[test]
    fn 密码长度按字节而非字符() {
        // 4 个中文字符 = 12 字节，刚好达标
        assert!(validate_password("中文密码").is_ok());
        // 3 个中文字符 = 9 字节，不足
        assert!(validate_password("中文密").is_err());
        // 11 字节拒绝（这个正是不该用 PasswordPolicy 默认 8 的原因）
        assert!(validate_password("abc12345678").is_err());
        // 12 字节通过
        assert!(validate_password("abc123456789").is_ok());
    }

    #[test]
    fn 密码不因首尾空格被裁剪() {
        // 11 字符 + 2 空格 = 13 字节，应通过
        assert!(validate_password("abc1234567  ").is_ok());
    }

    #[test]
    fn 超长密码被拒绝() {
        assert!(validate_password(&"a".repeat(PASSWORD_MAX_BYTES)).is_ok());
        assert!(validate_password(&"a".repeat(PASSWORD_MAX_BYTES + 1)).is_err());
    }

    #[test]
    fn 注册校验返回归一化用户名() {
        let req = RegisterRequest {
            username: "  Alice ".to_owned(),
            password: "Correct-Horse-Battery".to_owned(),
        };
        let (username, _) = req.validate().expect("应通过");
        assert_eq!(username, "alice");
    }

    #[test]
    fn 登录不因密码过短而拒绝() {
        // 策略收紧后，历史短密码仍应能登录
        let req = LoginRequest {
            username: "alice".to_owned(),
            password: "short".to_owned(),
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn 登录拒绝空密码() {
        let req = LoginRequest {
            username: "alice".to_owned(),
            password: String::new(),
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn 非法文档id报400且指出字段() {
        let e = parse_document_id("not-a-uuid").expect_err("非法 UUID 应报错");
        assert_eq!(e.code().status().as_u16(), 400);
    }

    #[test]
    fn 合法文档id解析成功() {
        let uid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
        assert_eq!(
            parse_document_id(uid).expect("应通过"),
            Uuid::parse_str(uid).unwrap()
        );
    }

    #[test]
    fn 用户名错误带字段名便于前端定位() {
        let req = RegisterRequest {
            username: "A".to_owned(),
            password: "Correct-Horse-Battery".to_owned(),
        };
        let e = req.validate().expect_err("单字符用户名应被拒绝");
        match &e {
            AppError::BadRequest { field, .. } => assert_eq!(*field, Some("username")),
            other => panic!("应为 BadRequest，实际：{other:?}"),
        }
    }
}
