//! M3 W5 认证联调回归补充用例。
//!
//! 本文件只补 W5 提示词指出的两个缺口，已有覆盖不重复造例：
//!
//! 1. **JWT 401 映射（HTTP 层）**：`auth_w4.rs` 只在纯逻辑层断言
//!    `TokenError` 的分类，没有经过 `AuthenticatedUser` 提取器走真实路由。
//!    本文件用过期 / 错误受众 / 错误签发者 / alg=none / 签名篡改五种受控夹具，
//!    经受保护路由 `GET /api/v1/documents` 断言统一 401 与统一错误体。
//! 2. **损坏记录错误分类的复跑分布**：`password.rs` 的 `ensure_output_len`
//!    是针对「摘要在 base64 解码时静默少 1 字节」这一偶发项的修复。
//!    本文件用**有界固定夹具**（小参数 m=2048、固定截断位置）跑固定轮次，
//!    记录每一轮的分类，输出 Format / Mismatch / 其它 的分布计数。
//!    不关闭任何资源上限，不使用大内存参数。
//!
//! 运行：
//! ```text
//! cargo test --locked --test w5_regression -- --nocapture
//! ```
//!
//! 前一类用例不需要数据库（惰性连接池在鉴权失败处即返回 401，不触库）。

use std::net::SocketAddr;

use actix_http::Request;
use actix_web::body::MessageBody;
use actix_web::dev::{Service, ServiceResponse};
use actix_web::http::StatusCode;
use actix_web::http::header::HeaderMap;
use actix_web::{App, Error, test as aw_test, web};
use chrono::{Duration, Utc};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use markdown_cloud_editor::auth::password::{
    Argon2Params, PasswordError, hash_password, verify_password,
};
use markdown_cloud_editor::auth::token::{AUDIENCE, Claims, ISSUER};
use markdown_cloud_editor::middleware::RequestIdLayer;
use markdown_cloud_editor::routes::auth::AuthConfig;
use markdown_cloud_editor::state::AppState;
use sqlx::PgPool;

/// 测试用 JWT 密钥。仅本测试使用，非部署密钥。
const TEST_SECRET: &str = "Kd8#mZ2!vQ7@xR4&pW9@jL5^nT3*yF7=hG2+Ab1";

/// 测试密码，符合 12–128 字节规则。
const PWD: &str = "Correct-Horse-Battery";

/// 小参数：哈希只占 2 MiB 内存，符合 W5「不得大内存复现」的约束。
const LIGHT: Argon2Params = Argon2Params {
    memory_kib: 2_048,
    iterations: 2,
    parallelism: 1,
    output_len: 32,
};

/// 指向不可用地址的惰性连接池：只用其形状，不发起连接。
fn lazy_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_millis(300))
        .connect_lazy("postgres://nobody@127.0.0.1:1/nonexistent")
        .expect("connect_lazy 不应失败")
}

/// 构造与生产一致的 Config（仅密钥与监听地址不同）。
fn test_config() -> markdown_cloud_editor::Config {
    markdown_cloud_editor::Config::new(
        "postgres://nobody@127.0.0.1:1/nonexistent".to_owned(),
        TEST_SECRET.to_owned(),
        "127.0.0.1:8080".to_owned(),
        3600,
    )
    .expect("测试配置应合法")
}

/// 用给定 header / 载荷 / 密钥签发 token。
fn sign_with(header: Header, claims: &Claims, secret: &str) -> String {
    encode(
        &header,
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .expect("签名不应失败")
}

/// 基准合规载荷。
fn base_claims() -> Claims {
    let now = Utc::now();
    Claims {
        sub: "3f2504e0-4f89-41d3-9a0c-0305e82c3301".to_owned(),
        username: "alice".to_owned(),
        iat: now.timestamp(),
        exp: (now + Duration::hours(1)).timestamp(),
        iss: ISSUER.to_owned(),
        aud: AUDIENCE.to_owned(),
    }
}

/// 发一个带 Bearer token 的 GET，返回 `(状态码, 响应头, 原始响应体)`。
async fn get_with_token<S, B>(
    app: &S,
    uri: &str,
    token: Option<&str>,
    peer: Option<&str>,
) -> (StatusCode, HeaderMap, Vec<u8>)
where
    S: Service<Request, Response = ServiceResponse<B>, Error = Error>,
    B: MessageBody,
{
    let mut builder = aw_test::TestRequest::get().uri(uri);
    if let Some(addr) = peer {
        builder = builder.peer_addr(addr.parse::<SocketAddr>().expect("peer 应合法"));
    }
    if let Some(t) = token {
        builder = builder.insert_header(("Authorization", format!("Bearer {t}")));
    }
    let req = builder.to_request();
    let resp = aw_test::call_service(app, req).await;
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = aw_test::read_body(resp).await.to_vec();
    (status, headers, bytes)
}

/// 取响应头字符串值。
fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(ToOwned::to_owned)
}

/// 解析 `error` 对象。
fn error_body(bytes: &[u8]) -> serde_json::Value {
    let value: serde_json::Value = serde_json::from_slice(bytes).expect("错误响应应为 JSON");
    value["error"].clone()
}

// ---------------------------------------------------------------------------
// W5-02：JWT 受控夹具 → 受保护路由统一 401
// ---------------------------------------------------------------------------

/// 过期、错误声明与伪造签名的 token 经真实提取器与真实路由，必须统一 401。
///
/// 这里不 sleep、不依赖真实时钟推进：过期用「已过去的 exp」构造，
/// 等价于可控时钟，且每次运行结果确定。
#[actix_web::test]
async fn 过期与错误声明token经受保护路由统一401() {
    let app = aw_test::init_service(
        App::new()
            .app_data(web::Data::new(AppState::new(lazy_pool())))
            .app_data(web::Data::new(test_config()))
            .app_data(web::Data::new(AuthConfig::default()))
            .wrap(RequestIdLayer)
            .configure(markdown_cloud_editor::configure_app),
    )
    .await;

    let now = Utc::now();

    // ① 已过期：exp 在过去一小时。
    let mut expired = base_claims();
    expired.iat = (now - Duration::hours(2)).timestamp();
    expired.exp = (now - Duration::hours(1)).timestamp();
    let expired_token = sign_with(Header::new(Algorithm::HS256), &expired, TEST_SECRET);

    // ② 受众错误：签名合法，只有 aud 不对。
    let mut wrong_aud = base_claims();
    wrong_aud.aud = "another-service".to_owned();
    let wrong_aud_token = sign_with(Header::new(Algorithm::HS256), &wrong_aud, TEST_SECRET);

    // ③ 签发者错误。
    let mut wrong_iss = base_claims();
    wrong_iss.iss = "another-issuer".to_owned();
    let wrong_iss_token = sign_with(Header::new(Algorithm::HS256), &wrong_iss, TEST_SECRET);

    // ④ 算法降级：alg=none、无签名。
    let none_token = {
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
        let head = URL_SAFE_NO_PAD.encode(r#"{"alg":"none","typ":"JWT"}"#);
        let body =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&base_claims()).expect("序列化不应失败"));
        format!("{head}.{body}.")
    };

    // ⑤ 签名被篡改：保留前两段，把签名段首字符换成另一个合法 base64url 字符。
    //
    // 注意：不能写成「去掉末尾 'A' 再补 'A'」——HMAC-SHA256 的签名段共 43 个
    // base64url 字符，末位只承载 4 个有效位（取值仅 16 种），若原始签名本就以
    // 'A' 结尾，`trim_end_matches('A')` 后再补 'A' 会**原样复原**该签名，
    // 得到一个仍然合法的 token，用例会以 200 而非 401 失败（实测约 1/16 的秒级
    // 时段会命中，表现为 CI 间歇性红灯）。改为翻转首字符，保证字节必然不同。
    let valid = sign_with(Header::new(Algorithm::HS256), &base_claims(), TEST_SECRET);
    let parts: Vec<&str> = valid.split('.').collect();
    let mut sig = parts[2].to_owned();
    let first = sig.remove(0);
    let flipped = if first == 'A' { 'B' } else { 'A' };
    sig.insert(0, flipped);
    let tampered = format!("{}.{}.{}", parts[0], parts[1], sig);
    assert_ne!(parts[2], sig, "篡改后的签名必须与原签名不同");

    let cases = [
        ("过期", expired_token),
        ("aud 错误", wrong_aud_token),
        ("iss 错误", wrong_iss_token),
        ("alg=none", none_token),
        ("签名篡改", tampered),
    ];

    for (label, token) in cases {
        let (status, headers, bytes) = get_with_token(
            &app,
            "/api/v1/documents",
            Some(&token),
            Some("10.0.9.9:5555"),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{label} 必须映射 401");
        let body = error_body(&bytes);
        assert_eq!(body["code"], "UNAUTHORIZED", "{label} 的错误码必须统一");
        assert!(
            body.get("details").is_none(),
            "{label} 的 401 不应带 details"
        );
        assert_eq!(
            Some(
                body["request_id"]
                    .as_str()
                    .expect("错误体必须含 request_id")
            ),
            header_str(&headers, "X-Request-Id").as_deref(),
            "{label} 的 request_id 必须与响应头一致"
        );
    }

    // 对照：缺少 Authorization 头同样 401，且错误体形状与上面一致。
    let (missing_status, _, missing_bytes) =
        get_with_token(&app, "/api/v1/documents", None, None).await;
    assert_eq!(missing_status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_body(&missing_bytes)["code"], "UNAUTHORIZED");
}

// ---------------------------------------------------------------------------
// W5-03：损坏记录错误分类的确定性回归与复跑分布
// ---------------------------------------------------------------------------

/// 有界固定夹具：每一类损坏都必须稳定归到既定类别，密码错误只归 Mismatch。
#[test]
fn 损坏记录分类的固定夹具() {
    let good = hash_password(PWD, &LIGHT).expect("哈希生成不应失败");
    let parts: Vec<&str> = good.split('$').collect();
    assert_eq!(parts.len(), 6, "PHC 串应为六段");

    // 合法验证：正确密码通过，错误密码归 Mismatch。
    assert!(verify_password(PWD, &good).is_ok(), "合法哈希应通过");
    assert!(matches!(
        verify_password("Wrong-Passw0rd-X", &good).expect_err("错误密码必须失败"),
        PasswordError::PasswordMismatch
    ));

    // 摘要段截断一个字符（31 字节）：必须 InvalidHashFormat，不得 Mismatch。
    let digest_truncated = format!(
        "${}${}:{}${}",
        parts[1],
        parts[2],
        parts[3],
        &parts[5][..parts[5].len() - 1]
    );
    assert!(matches!(
        verify_password(PWD, &digest_truncated).expect_err("截断摘要必须失败"),
        PasswordError::InvalidHashFormat(_)
    ));

    // 缺摘要段。
    let no_digest = format!("${}${}${}", parts[1], parts[2], parts[3]);
    assert!(matches!(
        verify_password(PWD, &no_digest).expect_err("缺摘要必须失败"),
        PasswordError::InvalidHashFormat(_)
    ));

    // 参数越界（m 超过默认上限）：必须 IncompatibleParams，不得 Mismatch。
    let huge_m = good.replace("m=2048", "m=4294967295");
    assert!(matches!(
        verify_password(PWD, &huge_m).expect_err("超大 m 必须被闸门拦下"),
        PasswordError::IncompatibleParams(_)
    ));
}

/// 复跑分布：固定 300 轮，每轮生成合法哈希后按固定位置截断一个字符，
/// 统计分类结果。断言「Mismatch = 0」——截断记录绝不能伪装成密码错误。
///
/// 轮数取 300 与 `password.rs` 注释中的观测规模一致；参数固定为 m=2048，
/// 单轮毫秒级，整体有界（不关闭上限、不申请大内存）。
#[test]
fn 截断记录复跑分布_mismatch必须为零() {
    const ROUNDS: usize = 300;

    let (mut format, mut mismatch, mut params, mut other, mut legal) = (0, 0, 0, 0, 0);

    for _ in 0..ROUNDS {
        let good = hash_password(PWD, &LIGHT).expect("哈希生成不应失败");
        let parts: Vec<&str> = good.split('$').collect();
        let damaged = format!(
            "${}${}:{}${}",
            parts[1],
            parts[2],
            parts[3],
            &parts[5][..parts[5].len() - 1]
        );

        match verify_password(PWD, &damaged) {
            Err(PasswordError::InvalidHashFormat(_)) => format += 1,
            Err(PasswordError::PasswordMismatch) => mismatch += 1,
            Err(PasswordError::IncompatibleParams(_)) => params += 1,
            Err(_) => other += 1,
            Ok(()) => legal += 1,
        }
    }

    println!(
        "W5-03 复跑分布：rounds={ROUNDS} InvalidHashFormat={format} \
         PasswordMismatch={mismatch} IncompatibleParams={params} other={other} legal={legal}"
    );

    assert_eq!(mismatch, 0, "截断记录不得归类为 PasswordMismatch");
    assert_eq!(legal, 0, "截断记录不得验证通过");
    assert_eq!(other, 0, "不得出现未归类的错误");
    assert_eq!(format, ROUNDS, "截断记录应全部归为 InvalidHashFormat");
}
