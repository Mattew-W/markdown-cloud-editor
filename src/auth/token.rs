//! JWT 签发与验签（HS256）。
//!
//! 规范 §09 硬性要求：
//!
//! - 算法**固定** HS256，`decode` 时不信任 header 里的 `alg`——
//!   否则攻击者可把 `alg` 改成 `none` 或降级到非对称算法的空实现来伪造；
//! - 必须校验 `exp`（有效期）、`sub`（用户 id）、`iss`（签发者）、`aud`（受众）；
//! - 有效期 1 小时（由 [`crate::config`] 的 `jwt_ttl_secs` 控制）。
//!
//! 前端把 token 存 `sessionStorage`（规范 §09），有效期到期后须重新登录。

use chrono::{DateTime, Duration, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};

/// 签发者标识。放进 `iss` 并在校验时比对，防止其他系统的 token 被误用。
pub const ISSUER: &str = "markdown-cloud-editor";

/// 受众标识。放进 `aud`。
pub const AUDIENCE: &str = "markdown-cloud-editor-web";

/// token 中的载荷。
///
/// 字段名与规范 §06 的 snake_case 约定一致。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Claims {
    /// 用户 UUID 字符串。客户端不得据此判断权限以外的事。
    pub sub: String,
    /// 用户名，便于前端显示而不必额外请求。
    pub username: String,
    /// 签发时间（UTC，RFC 3339）。
    pub iat: i64,
    /// 过期时间（UTC，Unix 秒）。
    pub exp: i64,
    /// 签发者。
    pub iss: String,
    /// 受众。
    pub aud: String,
}

/// token 相关错误。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TokenError {
    /// 签名或格式非法（含 alg 不匹配、签名不匹配）。
    #[error("token 无效：{0}")]
    Invalid(String),

    /// 已过期。
    #[error("token 已过期")]
    Expired,

    /// 已签发但签发时间在未来，通常意味着时钟漂移或伪造。
    #[error("token 尚未生效")]
    NotYetValid,
}

impl TokenError {
    /// 是否属于「客户端需要重新登录」的情形。
    ///
    /// 过期、签名错、格式错都意味着这个 token 不能再用了，
    /// 统一映射为 401 而非 400——token 无效不是请求参数问题。
    #[must_use]
    pub const fn requires_login(&self) -> bool {
        true
    }
}

/// 为用户签发 token。
///
/// # Errors
///
/// 序列化失败（时间戳越界等）或密钥长度不合法时返回 [`TokenError::Invalid`]。
pub fn issue_token(
    user_id: &str,
    username: &str,
    secret: &str,
    ttl_secs: u64,
) -> Result<(String, DateTime<Utc>), TokenError> {
    let now = Utc::now();
    let expires_at = now + Duration::seconds(i64::try_from(ttl_secs).unwrap_or(i64::MAX));

    let claims = Claims {
        sub: user_id.to_owned(),
        username: username.to_owned(),
        iat: now.timestamp(),
        exp: expires_at.timestamp(),
        iss: ISSUER.to_owned(),
        aud: AUDIENCE.to_owned(),
    };

    // 显式指定 HS256：不使用 `encode` 的默认 header，
    // 避免将来某个依赖升级悄悄改变算法。
    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| TokenError::Invalid(e.to_string()))?;

    Ok((token, expires_at))
}

/// 校验并解析 token。
///
/// 校验项：签名、`exp`、`iss`、`aud`、`sub`。
///
/// # Errors
///
/// 返回 [`TokenError`]，路由层一律映射为 401。
pub fn decode_token(token: &str, secret: &str) -> Result<Claims, TokenError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[AUDIENCE]);
    // 允许 0 宽容度：token 过期即刻失效，不给时钟偏差留窗口。
    validation.leeway = 0;
    validation.validate_exp = true;

    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|e| match e.kind() {
        jsonwebtoken::errors::ErrorKind::ExpiredSignature => TokenError::Expired,
        jsonwebtoken::errors::ErrorKind::ImmatureSignature => TokenError::NotYetValid,
        // ErrorKind 未实现 Display，只能取其 Debug 形式。
        // 该文本只进日志与本层错误，不返回给客户端（路由统一映射为通用 401 文案）。
        other => TokenError::Invalid(format!("{other:?}")),
    })?;

    Ok(data.claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

    // 刻意不含 secret/changeme 等词，与 config.rs 的占位检测保持一致。
    const SECRET: &str = "Kd8#mZ2!vQ7@xR4&pW9@jL5^nT3*yF7=hG2+Ab1";

    #[test]
    fn 签发后可验回原载荷() {
        let uid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
        let (token, _) = issue_token(uid, "alice", SECRET, 3600).expect("签发不应失败");
        let claims = decode_token(&token, SECRET).expect("验签不应失败");

        assert_eq!(claims.sub, uid);
        assert_eq!(claims.username, "alice");
        assert_eq!(claims.iss, ISSUER);
        assert_eq!(claims.aud, AUDIENCE);
    }

    #[test]
    fn 错误密钥无法验签() {
        let (token, _) = issue_token("u1", "alice", SECRET, 3600).expect("签发不应失败");
        let other = "9Zx#3mQ7!vB2@xR8&pL4@jK6^nT1*yH5=hG9+";
        let err = decode_token(&token, other).expect_err("错误密钥必须失败");
        assert!(matches!(err, TokenError::Invalid(_)), "实际：{err:?}");
    }

    #[test]
    fn 篡改载荷后验签失败() {
        let (token, _) = issue_token("user-1", "alice", SECRET, 3600).expect("签发不应失败");
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3, "JWT 应为三段");

        // 真正篡改载荷：换掉 base64 编码的用户名，同时保留原签名。
        // 攻击者没有密钥，算不出匹配新载荷的签名，因此验签必失败。
        let forged_payload = Claims {
            sub: "user-2".to_owned(),
            username: "mallory".to_owned(),
            iat: 0,
            exp: i64::MAX,
            iss: ISSUER.to_owned(),
            aud: AUDIENCE.to_owned(),
        };
        let body =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&forged_payload).expect("序列化不应失败"));
        let tampered = format!("{}.{}.{}", parts[0], body, parts[2]);

        let err = decode_token(&tampered, SECRET).expect_err("篡改载荷必须验签失败");
        assert!(matches!(err, TokenError::Invalid(_)), "实际：{err:?}");
    }

    #[test]
    fn 篡改签名段失败() {
        let (token, _) = issue_token("u1", "alice", SECRET, 3600).expect("签发不应失败");
        let parts: Vec<&str> = token.split('.').collect();
        // 翻转签名末位
        let flipped = format!(
            "{}{}",
            &parts[2][..parts[2].len() - 1],
            if parts[2].ends_with('A') { "B" } else { "A" }
        );
        let tampered = format!("{}.{}.{flipped}", parts[0], parts[1]);
        assert!(decode_token(&tampered, SECRET).is_err(), "签名被改必须失败");
    }

    #[test]
    fn 非jwt字符串被拒绝() {
        for bad in ["", "abc", "a.b.c", "not.a.token"] {
            assert!(decode_token(bad, SECRET).is_err(), "{bad} 应被拒绝");
        }
    }

    #[test]
    fn 过期token被识别为过期() {
        // TTL 允许最小 60 秒，这里直接构造已过期的载荷绕过时长限制。
        let now = Utc::now();
        let claims = Claims {
            sub: "u1".to_owned(),
            username: "alice".to_owned(),
            iat: (now - Duration::hours(2)).timestamp(),
            exp: (now - Duration::hours(1)).timestamp(),
            iss: ISSUER.to_owned(),
            aud: AUDIENCE.to_owned(),
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .expect("构造不应失败");

        let err = decode_token(&token, SECRET).expect_err("过期 token 必须失败");
        assert!(matches!(err, TokenError::Expired), "实际：{err:?}");
    }

    #[test]
    fn 不同签发者的token被拒绝() {
        let now = Utc::now();
        let claims = Claims {
            sub: "u1".to_owned(),
            username: "alice".to_owned(),
            iat: now.timestamp(),
            exp: (now + Duration::hours(1)).timestamp(),
            iss: "some-other-service".to_owned(),
            aud: AUDIENCE.to_owned(),
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .expect("构造不应失败");

        assert!(
            decode_token(&token, SECRET).is_err(),
            "外部签发者的 token 必须拒绝"
        );
    }

    #[test]
    fn 算法降级攻击被阻断() {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"none","typ":"JWT"}"#);
        let now = Utc::now();
        let payload = Claims {
            sub: "attacker".to_owned(),
            username: "attacker".to_owned(),
            iat: now.timestamp(),
            exp: (now + Duration::hours(1)).timestamp(),
            iss: ISSUER.to_owned(),
            aud: AUDIENCE.to_owned(),
        };
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("序列化不应失败"));
        let forged = format!("{header}.{body}.");

        assert!(
            decode_token(&forged, SECRET).is_err(),
            "alg=none 的伪造 token 必须被拒绝"
        );
    }
}
