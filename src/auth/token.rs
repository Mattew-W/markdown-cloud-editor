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

    // TTL 过大不能 panic。三道闸依次拦：
    //   1. u64 → i64 转换失败：超出 i64 秒范围；
    //   2. `Duration::try_seconds` 返回 None：超出 chrono TimeDelta 表示范围
    //      （注意 `Duration::seconds` 在这里就会 panic，必须用 try_* 版本）；
    //   3. `checked_add_signed` 返回 None：加上 TTL 后超出 Utc 可表示的时间范围。
    // 三者都归为 `TokenError::Invalid`，接口与错误类型均不变。
    let ttl_secs = i64::try_from(ttl_secs)
        .map_err(|_| TokenError::Invalid("TTL 超出可表示范围".to_owned()))?;
    let ttl = Duration::try_seconds(ttl_secs)
        .ok_or_else(|| TokenError::Invalid("TTL 过大，超出时间间隔表示范围".to_owned()))?;
    let expires_at = now
        .checked_add_signed(ttl)
        .ok_or_else(|| TokenError::Invalid("TTL 过大，过期时间溢出".to_owned()))?;

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

    // `sub` 承载用户 UUID，不允许为空串：空值会让"验签通过但查不到用户"。
    // 纯空白（空格 / 制表符 / 全角空格）与空串同属"查不到用户"，一并拒绝；
    // 只判空而不裁剪首尾，合法 id 原样返回，不做任何改写。
    // 最小校验，不做 UUID 格式解析（解析交给调用方，如 extractor.rs）。
    if data.claims.sub.trim().is_empty() {
        return Err(TokenError::Invalid("sub 不能为空".to_owned()));
    }

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

    // ---- 边界测试（M3 W2 回归新增）----
    //
    // 用测试辅助结构构造「签名正确但字段缺失」的 token：
    // 不能靠改坏 base64 去赌签名变化，那样测到的是签名不匹配而非字段缺失。

    /// 与 `Claims` 同构但缺 `aud` 的载荷。
    #[derive(Serialize)]
    struct ClaimsNoAud {
        sub: String,
        username: String,
        iat: i64,
        exp: i64,
        iss: String,
    }

    /// 与 `Claims` 同构但缺 `exp` 的载荷。
    #[derive(Serialize)]
    struct ClaimsNoExp {
        sub: String,
        username: String,
        iat: i64,
        iss: String,
        aud: String,
    }

    /// 用正确密钥为任意可序列化载荷签发 token。
    fn sign<T: Serialize>(payload: &T) -> String {
        encode(
            &Header::new(Algorithm::HS256),
            payload,
            &EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .expect("构造不应失败")
    }

    #[test]
    fn 正确签名但aud错误被拒绝() {
        let now = Utc::now();
        let claims = Claims {
            sub: "u1".to_owned(),
            username: "alice".to_owned(),
            iat: now.timestamp(),
            exp: (now + Duration::hours(1)).timestamp(),
            iss: ISSUER.to_owned(),
            aud: "wrong-audience".to_owned(),
        };
        let token = sign(&claims);
        let err = decode_token(&token, SECRET).expect_err("错误 aud 必须被拒绝");
        assert!(matches!(err, TokenError::Invalid(_)), "实际：{err:?}");
    }

    #[test]
    fn 签名正确但缺aud被拒绝() {
        let now = Utc::now();
        let payload = ClaimsNoAud {
            sub: "u1".to_owned(),
            username: "alice".to_owned(),
            iat: now.timestamp(),
            exp: (now + Duration::hours(1)).timestamp(),
            iss: ISSUER.to_owned(),
        };
        let token = sign(&payload);
        assert!(
            decode_token(&token, SECRET).is_err(),
            "缺少 aud 的 token 必须被拒绝"
        );
    }

    #[test]
    fn 签名正确但缺exp被拒绝() {
        let now = Utc::now();
        let payload = ClaimsNoExp {
            sub: "u1".to_owned(),
            username: "alice".to_owned(),
            iat: now.timestamp(),
            iss: ISSUER.to_owned(),
            aud: AUDIENCE.to_owned(),
        };
        let token = sign(&payload);
        assert!(
            decode_token(&token, SECRET).is_err(),
            "缺少 exp 的 token 必须被拒绝"
        );
    }

    #[test]
    fn 空sub被拒绝() {
        let (token, _) = issue_token("", "alice", SECRET, 3600).expect("签发不应失败");
        let err = decode_token(&token, SECRET).expect_err("空 sub 必须被拒绝");
        assert!(matches!(err, TokenError::Invalid(_)), "实际：{err:?}");
    }

    #[test]
    fn ttl取u64max返回错误不panic() {
        let res = issue_token("u1", "alice", SECRET, u64::MAX);
        assert!(res.is_err(), "u64::MAX TTL 必须返回错误而非 panic");
    }

    #[test]
    fn ttl取i64max返回错误不panic() {
        // u64 → i64 转换能成功，但秒数已超出 chrono TimeDelta 的表示范围，
        // `Duration::seconds` 在此处就会 panic，必须走 `try_seconds`。
        let res = issue_token("u1", "alice", SECRET, i64::MAX as u64);
        assert!(res.is_err(), "i64::MAX TTL 必须返回错误而非 panic");
    }

    // ---- M3 W3 新增：边界与错误分类回归 ----
    //
    // W3 验收点里已有覆盖的 4 项**不重复造例**：
    //   - 签名正确但缺 exp → `签名正确但缺exp被拒绝`
    //   - aud 错误 / 缺失   → `正确签名但aud错误被拒绝` / `签名正确但缺aud被拒绝`
    //   - 空 sub            → `空sub被拒绝`
    //   - u64::MAX / i64::MAX TTL 不 panic
    //     → `ttl取u64max返回错误不panic` / `ttl取i64max返回错误不panic`
    // 下面只补 W2 之后仍然缺的边界。

    /// 与 `Claims` 同构但缺 `iss` 的载荷。
    #[derive(Serialize)]
    struct ClaimsNoIss {
        sub: String,
        username: String,
        iat: i64,
        exp: i64,
        aud: String,
    }

    /// 与 `Claims` 同构但整体缺 `sub` 字段的载荷。
    #[derive(Serialize)]
    struct ClaimsNoSubField {
        username: String,
        iat: i64,
        exp: i64,
        iss: String,
        aud: String,
    }

    #[test]
    fn 同密钥hs384签名的token被拒绝() {
        // 签名能被同一密钥验证，只有 header 的 alg 不是 HS256。
        // 与 `算法降级攻击被阻断`（alg=none、无签名）不同：这条验证的是
        // 「算法固定」，即 decode 不信任 header 里的 alg。
        let now = Utc::now();
        let claims = Claims {
            sub: "u1".to_owned(),
            username: "alice".to_owned(),
            iat: now.timestamp(),
            exp: (now + Duration::hours(1)).timestamp(),
            iss: ISSUER.to_owned(),
            aud: AUDIENCE.to_owned(),
        };
        let token = encode(
            &Header::new(Algorithm::HS384),
            &claims,
            &EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .expect("构造不应失败");

        let err = decode_token(&token, SECRET).expect_err("非 HS256 的 token 必须被拒绝");
        assert!(matches!(err, TokenError::Invalid(_)), "实际：{err:?}");
    }

    #[test]
    fn 签名正确但缺iss被拒绝() {
        // 与 `不同签发者的token被拒绝` 互补：那条是 iss 值不对，这条是字段整个缺失。
        let now = Utc::now();
        let payload = ClaimsNoIss {
            sub: "u1".to_owned(),
            username: "alice".to_owned(),
            iat: now.timestamp(),
            exp: (now + Duration::hours(1)).timestamp(),
            aud: AUDIENCE.to_owned(),
        };
        let token = sign(&payload);
        let err = decode_token(&token, SECRET).expect_err("缺少 iss 的 token 必须被拒绝");
        assert!(matches!(err, TokenError::Invalid(_)), "实际：{err:?}");
    }

    #[test]
    fn 载荷缺sub字段被拒绝() {
        // 与 `空sub被拒绝` 互补：那条 sub 存在但为空串，这条连字段都没有。
        let now = Utc::now();
        let payload = ClaimsNoSubField {
            username: "alice".to_owned(),
            iat: now.timestamp(),
            exp: (now + Duration::hours(1)).timestamp(),
            iss: ISSUER.to_owned(),
            aud: AUDIENCE.to_owned(),
        };
        let token = sign(&payload);
        let err = decode_token(&token, SECRET).expect_err("缺少 sub 字段的 token 必须被拒绝");
        assert!(matches!(err, TokenError::Invalid(_)), "实际：{err:?}");
    }

    #[test]
    fn 纯空白sub被拒绝() {
        // W2 只拦了空串；纯空白（空格 / 制表符 / 全角空格）同样不是合法 user id，
        // 下游按 sub 查用户会查不到，与空串属同一类问题。
        for blank in [" ", "   ", "\t", "\u{3000}"] {
            let (token, _) = issue_token(blank, "alice", SECRET, 3600).expect("签发不应失败");
            match decode_token(&token, SECRET) {
                Ok(claims) => panic!("sub={blank:?} 应被拒绝，实际解析出 {:?}", claims.sub),
                Err(TokenError::Invalid(_)) => {}
                Err(e) => panic!("sub={blank:?} 应返回 Invalid，实际：{e:?}"),
            }
        }
        // 正常 sub 不受影响（首尾空格不裁剪，合法 id 原样透出）。
        let (token, _) = issue_token("u1", "alice", SECRET, 3600).expect("签发不应失败");
        let claims = decode_token(&token, SECRET).expect("正常 sub 不应被误伤");
        assert_eq!(claims.sub, "u1");
    }

    #[test]
    fn 过期且签名错误的token归类为签名无效() {
        // 先验签、后判过期：伪造者拿不到密钥，不应因为改了 exp 就得到「已过期」
        // 这个只有真 token 才该有的结论。分类顺序本身就是可观测行为。
        let now = Utc::now();
        let claims = Claims {
            sub: "u1".to_owned(),
            username: "alice".to_owned(),
            iat: (now - Duration::hours(2)).timestamp(),
            exp: (now - Duration::hours(1)).timestamp(),
            iss: ISSUER.to_owned(),
            aud: AUDIENCE.to_owned(),
        };
        let other_secret = "9Zx#3mQ7!vB2@xR8&pL4@jK6^nT1*yH5=hG9+";
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(other_secret.as_bytes()),
        )
        .expect("构造不应失败");

        let err = decode_token(&token, SECRET).expect_err("错误密钥签发必须失败");
        assert!(
            matches!(err, TokenError::Invalid(_)),
            "过期 + 签名错误应归类为签名无效而非 Expired，实际：{err:?}"
        );
    }

    #[test]
    fn 过期判定按秒边界生效() {
        // leeway = 0 时 exp 的比较是「严格小于 now 才算过期」：同一秒内 exp == now
        // 仍有效，跨过这一秒即 Expired。两档写死，避免将来改成 `<=` 而无人发现。
        let mut same_second_accepted = false;
        for _ in 0..5 {
            let now = Utc::now();
            let claims = Claims {
                sub: "u1".to_owned(),
                username: "alice".to_owned(),
                iat: (now - Duration::hours(1)).timestamp(),
                exp: now.timestamp(),
                iss: ISSUER.to_owned(),
                aud: AUDIENCE.to_owned(),
            };
            match decode_token(&sign(&claims), SECRET) {
                Ok(_) => {
                    same_second_accepted = true;
                    break;
                }
                // 构造与校验之间跨秒了：重取时间再试，不算失败。
                Err(TokenError::Expired) => {}
                Err(e) => panic!("意外错误：{e:?}"),
            }
        }
        assert!(same_second_accepted, "exp == now 在同一秒内应仍被视为有效");

        let now = Utc::now();
        let claims = Claims {
            sub: "u1".to_owned(),
            username: "alice".to_owned(),
            iat: (now - Duration::hours(1)).timestamp(),
            exp: now.timestamp() - 1,
            iss: ISSUER.to_owned(),
            aud: AUDIENCE.to_owned(),
        };
        let err = decode_token(&sign(&claims), SECRET).expect_err("已过期一秒必须失败");
        assert!(matches!(err, TokenError::Expired), "实际：{err:?}");
    }

    #[test]
    fn exp为零被判过期而非无效() {
        // 1970 年的 exp：结构合法、签名合法，只是过期很久了——分类必须是 Expired。
        let claims = Claims {
            sub: "u1".to_owned(),
            username: "alice".to_owned(),
            iat: 0,
            exp: 0,
            iss: ISSUER.to_owned(),
            aud: AUDIENCE.to_owned(),
        };
        let err = decode_token(&sign(&claims), SECRET).expect_err("exp=0 必须失败");
        assert!(matches!(err, TokenError::Expired), "实际：{err:?}");
    }

    #[test]
    fn ttl为0时签发不panic且当秒到期() {
        // issue_token 只负责「不 panic、不溢出」，TTL 下限由 config.rs 的
        // MIN_JWT_TTL_SECS（60 秒）把关。这里记录库层真实行为：TTL=0 返回 Ok，
        // 过期时刻与签发时刻落在同一秒。
        let before = Utc::now().timestamp();
        let (_, expires_at) = issue_token("u1", "alice", SECRET, 0).expect("TTL=0 不应报错");
        let after = Utc::now().timestamp();
        assert!(
            (before..=after).contains(&expires_at.timestamp()),
            "TTL=0 的过期时刻应落在当前秒内，实际 {}",
            expires_at.timestamp()
        );
    }

    #[test]
    fn ttl三道闸各自拦下越界值() {
        // 闸 1：u64 → i64 溢出（TTL 连 i64 秒都装不下）。
        let err = issue_token("u1", "alice", SECRET, u64::MAX).expect_err("u64::MAX 必须失败");
        assert!(
            matches!(&err, TokenError::Invalid(m) if m.contains("可表示范围")),
            "实际：{err:?}"
        );

        // 闸 2：i64 秒装得下，但超出 chrono TimeDelta 的表示范围
        // （TimeDelta 内部按毫秒存，上限 9_223_372_036_854_775 秒）。
        let err = issue_token("u1", "alice", SECRET, 9_223_372_036_854_776)
            .expect_err("TimeDelta 上限之外必须失败");
        assert!(
            matches!(&err, TokenError::Invalid(m) if m.contains("时间间隔")),
            "实际：{err:?}"
        );

        // 闸 3：TimeDelta 能表示，但 now + TTL 超出 Utc 可表示范围（公元 262143 年）。
        let err = issue_token("u1", "alice", SECRET, 9_000_000_000_000)
            .expect_err("Utc 上限之外必须失败");
        assert!(
            matches!(&err, TokenError::Invalid(m) if m.contains("溢出")),
            "实际：{err:?}"
        );

        // 边界内侧：8e12 秒（约 2.5 万年）仍可签发，与 Utc 上限留有约 2×10^11 秒余量。
        assert!(
            issue_token("u1", "alice", SECRET, 8_000_000_000_000).is_ok(),
            "Utc 上限以内的极长 TTL 不应被误拒"
        );
    }

    #[test]
    fn 签发返回的过期时间与ttl一致() {
        let (token, expires_at) = issue_token("u1", "alice", SECRET, 3600).expect("签发不应失败");
        let claims = decode_token(&token, SECRET).expect("验签不应失败");
        assert_eq!(
            claims.exp,
            expires_at.timestamp(),
            "返回值与载荷的 exp 必须一致"
        );
        assert_eq!(claims.exp - claims.iat, 3600, "有效期实际秒数应等于 TTL");
    }
}
