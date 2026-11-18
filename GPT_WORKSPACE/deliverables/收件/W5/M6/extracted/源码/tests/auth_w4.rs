//! M3 W4 认证回归：路由级错误映射、`VerifyLimits` 接线与限流行为。
//!
//! 本文件是 **W4 新增**，与 W3 的 [`auth_db.rs`](auth_db.rs) 并存：
//! W3 的用例保持原样，W4 不重复造例，只补「HTTP 层」与「配置接线」两类此前
//! 没有证据的行为。纯逻辑部分（密码 / JWT）不依赖数据库，可直接 `cargo test`；
//! 需要 PostgreSQL 的用例标注 `#[ignore]`，用 `--ignored` 显式执行。
//!
//! # 覆盖编号
//!
//! | 编号 | 用例 |
//! |---|---|
//! | M3-01 | [`w3空白sub与极端ttl修复仍有效`]、[`phc损坏与参数不兼容保持独立错误`] |
//! | M3-02 | `正确密码登录返回200`、`错误密码与用户不存在返回同形401`、`错误响应不带内部细节且request_id与响应头一致`、`重复用户名返回409`、`库中哈希损坏返回500而非401` |
//! | M3-03 | [`验证上限恰好合法与恰好越界`]、[`参数越界优先于密码比对`]、[`默认上限拦下超大m且不分配内存`]、`验证上限经配置传入真实登录路径` |
//! | M3-04 | `登录第六次请求触发429并带retry_after`、`不同ip限流互相独立`、`限流窗口到期后恢复`、`注册与登录共用同一限流器预算`、[`限流器剩余秒数不超过窗口长度`] |
//!
//! 复现命令（纯逻辑，不需要数据库）：
//! ```text
//! cargo test --locked --test auth_w4
//! ```
//! 复现命令（含真实数据库，需先设 `TEST_DATABASE_URL`）：
//! ```text
//! $env:TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:5432/mce_test"
//! cargo test --locked --test auth_w4 -- --ignored --nocapture --test-threads=1
//! ```

use std::net::{IpAddr, SocketAddr};

use actix_http::Request;
use actix_web::body::MessageBody;
use actix_web::dev::{Service, ServiceResponse};
use actix_web::http::StatusCode;
use actix_web::http::header::HeaderMap;
// 注意：这里把 `actix_web::test` 改名导入。actix-web 在 crate 根同时导出**同名
// attribute 宏** `actix_web::test`，直接 `use actix_web::test` 会让本文件的 `#[test]`
// 解析到那个异步测试宏（要求 `async fn`），与纯逻辑的同步用例冲突。
use actix_web::{App, Error, test as aw_test, web};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use markdown_cloud_editor::auth::password::{
    Argon2Params, PasswordError, VerifyLimits, hash_password, verify_password,
    verify_password_with_limits,
};
use markdown_cloud_editor::auth::token::{AUDIENCE, ISSUER, issue_token};
use markdown_cloud_editor::auth::{Claims, TokenError, decode_token};
use markdown_cloud_editor::middleware::{RateLimiter, RequestIdLayer};
use markdown_cloud_editor::routes::auth::AuthConfig;
use markdown_cloud_editor::state::AppState;
use sqlx::PgPool;

/// 测试用 JWT 密钥。**仅测试使用**，非真实部署密钥。
///
/// 刻意不含 secret / changeme / placeholder 等词——`Config::new` 的占位检测
/// 会拒绝它们（这是闸门在正常工作，不是缺陷）。
const TEST_SECRET: &str = "Kd8#mZ2!vQ7@xR4&pW9@jL5^nT3*yF7=hG2+Ab1";

/// 测试用密码（12–128 字节之内，符合注册规则）。
const PWD: &str = "Correct-Horse-Battery";

/// 一组**很小**的 Argon2 参数：真实哈希只需 2 MiB 内存，不会压测机器。
///
/// M3-03 明确要求「用安全的小上限/受控参数测试越界拒绝」，
/// 不允许撤掉上限后用极大参数触发内存申请。
const fn light_params() -> Argon2Params {
    Argon2Params {
        memory_kib: 2_048,
        iterations: 2,
        parallelism: 1,
        output_len: 32,
    }
}

// ---------------------------------------------------------------------------
// M3-03：`VerifyLimits` 的参数闸边界（纯逻辑，不需数据库）
// ---------------------------------------------------------------------------

/// 期望的错误归类，用于把断言对到具体变体。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Expected {
    /// 密码不匹配（唯一的「正常失败」分支）。
    Mismatch,
    /// 参数/算法不兼容（数据损坏或越界，必须 500）。
    Params,
    /// PHC 串格式损坏。
    Format,
}

/// 用给定上限校验并归类结果；未报错直接 panic。
fn verify_error(password: &str, hash: &str, limits: &VerifyLimits) -> Expected {
    match verify_password_with_limits(password, hash, limits) {
        Ok(()) => panic!("应被拒绝，实际通过"),
        Err(PasswordError::PasswordMismatch) => Expected::Mismatch,
        Err(PasswordError::IncompatibleParams(_)) => Expected::Params,
        Err(PasswordError::InvalidHashFormat(_)) => Expected::Format,
        Err(other) => panic!("意外的错误类别：{other:?}"),
    }
}

/// 校验上限「恰好等于」与「比实际小 1」两档：合法记录可验证，越界必须报参数错。
///
/// 断言两件事：① 恰好合法仍能验通过；② 越界得到 [`PasswordError::IncompatibleParams`]，
/// **不是** `PasswordMismatch`（否则数据损坏会伪装成用户输错密码）。
#[test]
fn 验证上限恰好合法与恰好越界() {
    let hash = hash_password(PWD, &light_params()).expect("哈希生成不应失败");
    assert!(hash.contains("m=2048"), "哈希串应记录 m=2048，实际：{hash}");

    let exact = VerifyLimits {
        max_memory_kib: 2_048,
        max_iterations: 2,
        max_parallelism: 1,
    };
    assert!(
        verify_password_with_limits(PWD, &hash, &exact).is_ok(),
        "上限恰好等于实际参数时不应拒绝"
    );

    // 内存上限比实际小 1 KiB → 越界。
    let memory_tight = VerifyLimits {
        max_memory_kib: 2_047,
        ..exact
    };
    assert_eq!(
        verify_error(PWD, &hash, &memory_tight),
        Expected::Params,
        "m 超过上限应归类为 IncompatibleParams"
    );

    // 迭代上限比实际小 1 → 越界。
    let iter_tight = VerifyLimits {
        max_iterations: 1,
        ..exact
    };
    assert_eq!(verify_error(PWD, &hash, &iter_tight), Expected::Params);

    // 并行度上限比实际小 1 → 越界。
    let par_tight = VerifyLimits {
        max_parallelism: 0,
        ..exact
    };
    assert_eq!(verify_error(PWD, &hash, &par_tight), Expected::Params);
}

/// 参数越界必须先于密码比对：同一越界记录，密码对与错都得到 `IncompatibleParams`。
#[test]
fn 参数越界优先于密码比对() {
    let hash = hash_password(PWD, &light_params()).expect("哈希生成不应失败");
    let tight = VerifyLimits {
        max_memory_kib: 2_047,
        max_iterations: 2,
        max_parallelism: 1,
    };

    assert_eq!(verify_error(PWD, &hash, &tight), Expected::Params);
    assert_eq!(
        verify_error("Wrong-Passw0rd-X", &hash, &tight),
        Expected::Params,
        "越界记录不应因为密码错就变成 PasswordMismatch"
    );

    // 放松回「恰好等于」后，分类恢复常规：对 → 通过，错 → Mismatch。
    let exact = VerifyLimits {
        max_memory_kib: 2_048,
        max_iterations: 2,
        max_parallelism: 1,
    };
    assert!(verify_password_with_limits(PWD, &hash, &exact).is_ok());
    assert_eq!(
        verify_error("Wrong-Passw0rd-X", &hash, &exact),
        Expected::Mismatch
    );
}

/// `verify_password` 走默认上限（1 GiB），超大 `m` 必须在分配内存前被拦下。
///
/// 只改哈希串里的 `m` 而摘要不变，是为了证明**闸门先于 argon2 执行**：
/// 若先算再判，这里就会尝试分配 2 GiB 内存。
#[test]
fn 默认上限拦下超大m且不分配内存() {
    let hash = hash_password(PWD, &light_params()).expect("哈希生成不应失败");
    let huge = hash.replace("m=2048", "m=2097152"); // 2 GiB，超过默认 1 GiB 上限
    assert_ne!(huge, hash, "替换应生效");
    assert_eq!(
        verify_error(PWD, &huge, &VerifyLimits::default()),
        Expected::Params,
        "超大 m 应被默认上限拦下"
    );
}

// ---------------------------------------------------------------------------
// M3-01：W3 修复在公开 API 上仍然有效（纯逻辑，不需数据库）
// ---------------------------------------------------------------------------

/// 复核 W3 的三处修复：纯空白 `sub` 被拒、极端 TTL 不 panic、`aud` 不符被拒。
///
/// W3 已在 `token.rs` 单测覆盖这些点；本用例从**crate 外部**再验一次，
/// 确认修复在公开 API 上与在模块内部一致（不是只有内部测试才成立）。
#[test]
fn w3空白sub与极端ttl修复仍有效() {
    use chrono::Utc;

    // ① 纯空白 sub（空格 / 制表符 / 全角空格）——W3 修复点。
    for blank in [" ", "\t", "\u{3000}"] {
        let (token, _) = issue_token(blank, "alice", TEST_SECRET, 3600).expect("签发不应失败");
        match decode_token(&token, TEST_SECRET) {
            Err(TokenError::Invalid(_)) => {}
            other => panic!("sub={blank:?} 应归类为 Invalid，实际：{other:?}"),
        }
    }
    // 合法 sub 不被误伤。
    let (token, _) = issue_token("u1", "alice", TEST_SECRET, 3600).expect("签发不应失败");
    assert_eq!(
        decode_token(&token, TEST_SECRET)
            .expect("合法 token 应通过")
            .sub,
        "u1"
    );

    // ② 极端 TTL 返回错误而不是 panic。
    assert!(
        issue_token("u1", "alice", TEST_SECRET, u64::MAX).is_err(),
        "u64::MAX TTL 必须返回错误"
    );
    assert!(
        issue_token("u1", "alice", TEST_SECRET, 9_223_372_036_854_776).is_err(),
        "超出 chrono TimeDelta 的 TTL 必须返回错误"
    );

    // ③ aud 不符被拒（用正确密钥签发，证明拦的是 aud 而不是签名）。
    let now = Utc::now();
    let claims = Claims {
        sub: "u1".to_owned(),
        username: "alice".to_owned(),
        iat: now.timestamp(),
        exp: (now + chrono::Duration::hours(1)).timestamp(),
        iss: ISSUER.to_owned(),
        aud: "wrong-audience".to_owned(),
    };
    let forged = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(TEST_SECRET.as_bytes()),
    )
    .expect("构造不应失败");
    assert!(
        decode_token(&forged, TEST_SECRET).is_err(),
        "aud={} 的 token 必须被拒绝（正确 aud 为 {AUDIENCE}）",
        claims.aud
    );
}

/// PHC 格式损坏与参数不兼容保持**各自独立**的错误，不吞成 `PasswordMismatch`。
#[test]
fn phc损坏与参数不兼容保持独立错误() {
    let good = hash_password(PWD, &light_params()).expect("哈希生成不应失败");

    // 格式损坏：盐含非法字符。
    let bad_salt = "$argon2id$v=19$m=2048,t=2,p=1$!!!!$aGVsbG8".to_owned();
    assert_eq!(
        verify_error(PWD, &bad_salt, &VerifyLimits::default()),
        Expected::Format,
        "格式损坏必须归类为 InvalidHashFormat"
    );

    // 格式损坏：只有盐没有摘要。
    let parts: Vec<&str> = good.split('$').collect();
    let only_salt = format!("${}${}${}", parts[1], parts[2], parts[3]);
    assert_eq!(
        verify_error(PWD, &only_salt, &VerifyLimits::default()),
        Expected::Format
    );

    // 参数不兼容：m 超出默认上限。
    let huge = good.replace("m=2048", "m=4294967295");
    assert_eq!(
        verify_error(PWD, &huge, &VerifyLimits::default()),
        Expected::Params
    );

    // 合法哈希 + 正确密码仍是 Ok；错误密码仍是 Mismatch。
    assert!(verify_password(PWD, &good).is_ok());
    assert_eq!(
        verify_error("Wrong-Passw0rd-X", &good, &VerifyLimits::default()),
        Expected::Mismatch
    );
}

// ---------------------------------------------------------------------------
// 测试应用：与生产相同的组装路径
// ---------------------------------------------------------------------------

/// 组装被测应用。
///
/// 走与 `main.rs` **完全相同**的 `configure_app`，避免「测的不是真实装配」。
/// 限流器可选：不传时处理器拿到 `None`（与 `auth_db.rs` 的既有用法一致）。
macro_rules! build_app {
    ($pool:expr, $auth:expr, $limiter:expr) => {{
        let config = markdown_cloud_editor::Config::new(
            "postgres://nobody@127.0.0.1:1/nonexistent".to_owned(),
            TEST_SECRET.to_owned(),
            "127.0.0.1:8080".to_owned(),
            3600,
        )
        .expect("测试配置应合法");

        let mut app = App::new()
            .app_data(web::Data::new(AppState::new($pool)))
            .app_data(web::Data::new(config))
            .app_data(web::Data::new($auth))
            .wrap(RequestIdLayer);

        // 显式标注类型，让调用处可以安全地写 `None`。
        let limiter: Option<RateLimiter> = $limiter;
        if let Some(limiter) = limiter {
            app = app.app_data(web::Data::new(limiter));
        }

        aw_test::init_service(app.configure(markdown_cloud_editor::configure_app)).await
    }};
}

/// 发一个 JSON POST，返回 `(状态码, 响应头, 原始响应体)`。
///
/// 原始响应体保留为字节，便于断言「不泄露内部细节」时直接做全文检索；
/// 响应头保留下来，用于核对 `X-Request-Id` 与 `Retry-After`。
async fn post_json<S, B>(
    app: &S,
    uri: &str,
    body: &serde_json::Value,
    peer: Option<&str>,
) -> (StatusCode, HeaderMap, Vec<u8>)
where
    S: Service<Request, Response = ServiceResponse<B>, Error = Error>,
    B: MessageBody,
{
    let mut builder = aw_test::TestRequest::post().uri(uri);
    if let Some(addr) = peer {
        builder = builder.peer_addr(addr.parse::<SocketAddr>().expect("测试 peer 地址应合法"));
    }
    let req = builder.set_json(body).to_request();
    let resp = aw_test::call_service(app, req).await;

    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = aw_test::read_body(resp).await.to_vec();
    (status, headers, bytes)
}

/// 取响应头里的字符串值。
fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(ToOwned::to_owned)
}

/// 解析错误响应体里的 `error` 对象。
fn error_body(bytes: &[u8]) -> serde_json::Value {
    let value: serde_json::Value = serde_json::from_slice(bytes).expect("错误响应应为 JSON");
    value["error"].clone()
}

/// 断言响应体不含数据库 / 哈希 / 堆栈等内部细节。
fn assert_no_internal_details(bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    for needle in [
        "password_hash",
        "argon2",
        "select",
        "insert",
        "postgres://",
        "sqlx",
        "rust_backtrace",
    ] {
        assert!(
            !text.contains(needle),
            "响应体泄露内部细节 {needle:?}：{text}"
        );
    }
}

// ---------------------------------------------------------------------------
// 数据库测试的前置工具（与 `auth_db.rs` 同策略：每用例独立 schema）
// ---------------------------------------------------------------------------

/// 取连接串；缺失时 panic 并给出可执行指引（不静默跳过）。
fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .expect(
            "TEST_DATABASE_URL 未设置。数据库集成测试不得静默跳过。\n\
             设置方式见 docs/LOCAL_POSTGRES.md 第五节。",
        )
}

/// 生成当前用例独有的 schema 名（`t_` 前缀，便于统一清理）。
fn unique_schema_name() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("t_w4_{n}_{stamp:x}")
}

/// 建连接池并在独立 schema 内应用真实迁移，返回带 `search_path` 的池。
async fn isolated_pool() -> PgPool {
    let schema = unique_schema_name();

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(3)
        .after_connect({
            let schema = schema.clone();
            move |conn, _meta| {
                let set = format!("SET search_path TO {schema}");
                Box::pin(async move {
                    sqlx::query(&set).execute(conn).await?;
                    Ok(())
                })
            }
        })
        .connect(&test_database_url())
        .await
        .expect("连接测试数据库失败");

    sqlx::query(&format!("CREATE SCHEMA IF NOT EXISTS {schema}"))
        .execute(&pool)
        .await
        .expect("创建隔离 schema 失败");

    let migration = include_str!("../migrations/0001_init.sql");
    let body = migration
        .lines()
        .filter(|l| {
            let t = l.trim().to_ascii_uppercase();
            !t.starts_with("BEGIN") && !t.starts_with("COMMIT")
        })
        .collect::<Vec<_>>()
        .join("\n");
    sqlx::raw_sql(&body)
        .execute(&pool)
        .await
        .expect("在隔离 schema 内执行迁移失败");

    pool
}

/// 注册一个用户，返回其 `user.id` 与 token。
async fn register_ok<S, B>(app: &S, username: &str, password: &str) -> (String, String)
where
    S: Service<Request, Response = ServiceResponse<B>, Error = Error>,
    B: MessageBody,
{
    let req = aw_test::TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(serde_json::json!({ "username": username, "password": password }))
        .to_request();
    let resp = aw_test::call_service(app, req).await;
    assert_eq!(resp.status(), StatusCode::CREATED, "注册应返回 201");

    let body: serde_json::Value = aw_test::read_body_json(resp).await;
    (
        body["user"]["id"]
            .as_str()
            .expect("应含 user.id")
            .to_owned(),
        body["token"].as_str().expect("应含 token").to_owned(),
    )
}

/// 绕过接口直接写入一条用户记录（用于构造「库里已存在异常哈希」的场景）。
async fn insert_raw_user(pool: &PgPool, username: &str, password_hash: &str) {
    sqlx::query("INSERT INTO users (username, password_hash) VALUES ($1, $2)")
        .bind(username)
        .bind(password_hash)
        .execute(pool)
        .await
        .expect("写入用户记录应成功");
}

/// 登录请求的公共封装。
async fn login<S, B>(app: &S, username: &str, password: &str) -> (StatusCode, HeaderMap, Vec<u8>)
where
    S: Service<Request, Response = ServiceResponse<B>, Error = Error>,
    B: MessageBody,
{
    post_json(
        app,
        "/api/v1/auth/login",
        &serde_json::json!({ "username": username, "password": password }),
        None,
    )
    .await
}

// ---------------------------------------------------------------------------
// M3-02：隔离库上的 200 / 401 / 409 与错误响应形状
// ---------------------------------------------------------------------------

/// 正确密码登录返回 200，`expires_in` 与 TTL 一致，响应不含哈希。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 正确密码登录返回200() {
    let pool = isolated_pool().await;
    let app = build_app!(
        pool.clone(),
        AuthConfig {
            jwt_ttl_secs: 3600,
            ..Default::default()
        },
        None
    );
    let (user_id, _) = register_ok(&app, "w4_login", PWD).await;

    let (status, _, bytes) = login(&app, "w4_login", PWD).await;
    assert_eq!(status, StatusCode::OK, "正确密码应登录成功");

    let body: serde_json::Value = serde_json::from_slice(&bytes).expect("成功响应应为 JSON");
    assert_eq!(body["expires_in"], 3600);
    assert_eq!(body["user"]["id"], user_id);
    assert!(
        body["user"].get("password_hash").is_none(),
        "响应不得含 password_hash"
    );
}

/// 错误密码与用户不存在：状态码、错误码、错误文案与字段集合完全一致。
///
/// 「完全一致」是防用户名枚举的硬要求（API.md §3.2）：任何字段不同都可用于探测。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 错误密码与用户不存在返回同形401() {
    let pool = isolated_pool().await;
    let app = build_app!(pool.clone(), AuthConfig::default(), None);
    register_ok(&app, "w4_wrongpw", PWD).await;

    let (wrong_status, _, wrong_bytes) = login(&app, "w4_wrongpw", "Wrong-Passw0rd-X").await;
    let (missing_status, _, missing_bytes) = login(&app, "w4_nobody", PWD).await;

    assert_eq!(wrong_status, StatusCode::UNAUTHORIZED, "错误密码应为 401");
    assert_eq!(
        missing_status,
        StatusCode::UNAUTHORIZED,
        "用户不存在应为 401"
    );

    let wrong = error_body(&wrong_bytes);
    let missing = error_body(&missing_bytes);
    assert_eq!(wrong["code"], "UNAUTHORIZED");
    assert_eq!(missing["code"], "UNAUTHORIZED");
    assert_eq!(
        wrong["message"], missing["message"],
        "两个分支的文案必须一致"
    );

    // 字段集合也必须一致：多一个字段就等于多一条探测线索。
    let wrong_keys: Vec<&String> = wrong.as_object().expect("应为对象").keys().collect();
    let missing_keys: Vec<&String> = missing.as_object().expect("应为对象").keys().collect();
    assert_eq!(wrong_keys, missing_keys, "两个分支的错误体字段必须一致");
}

/// 错误响应不带内部细节，且 `error.request_id` 与 `X-Request-Id` 响应头一致。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 错误响应不带内部细节且request_id与响应头一致() {
    let pool = isolated_pool().await;
    let app = build_app!(pool.clone(), AuthConfig::default(), None);
    register_ok(&app, "w4_detail", PWD).await;

    let (status, headers, bytes) = login(&app, "w4_detail", "Wrong-Passw0rd-X").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_no_internal_details(&bytes);

    let body = error_body(&bytes);
    let body_id = body["request_id"]
        .as_str()
        .expect("错误体必须含 request_id");
    assert_eq!(
        Some(body_id),
        header_str(&headers, "X-Request-Id").as_deref(),
        "错误体 request_id 必须等于 X-Request-Id 响应头"
    );
    assert!(
        uuid::Uuid::parse_str(body_id).is_ok(),
        "request_id 应为 UUID，实际：{body_id}"
    );
    // 401 不应带 details（只有 VERSION_CONFLICT 才必须带）。
    assert!(body.get("details").is_none(), "401 不应带 details");
}

/// 重复用户名（含大小写差异）返回 409 `USERNAME_TAKEN`，且不泄露数据库错误。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 重复用户名返回409() {
    let pool = isolated_pool().await;
    let app = build_app!(pool.clone(), AuthConfig::default(), None);
    register_ok(&app, "w4_dup", PWD).await;

    let (status, headers, bytes) = post_json(
        &app,
        "/api/v1/auth/register",
        &serde_json::json!({ "username": "  W4_DUP  ", "password": PWD }),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT, "归一化后重名应为 409");
    assert_no_internal_details(&bytes);

    let body = error_body(&bytes);
    assert_eq!(body["code"], "USERNAME_TAKEN", "409 的 code 必须稳定");
    assert_eq!(
        Some(body["request_id"].as_str().expect("应含 request_id")),
        header_str(&headers, "X-Request-Id").as_deref(),
        "409 的 request_id 必须与响应头一致"
    );
}

/// 库中哈希损坏：登录返回 500 `INTERNAL_ERROR`，**不是** 401。
///
/// 这是 INTERFACES.md §1.3 的硬要求：数据损坏不得伪装成「密码错了」。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 库中哈希损坏返回500而非401() {
    let pool = isolated_pool().await;
    let app = build_app!(pool.clone(), AuthConfig::default(), None);
    insert_raw_user(&pool, "w4_corrupt", "not-a-phc-string").await;

    let (status, _, bytes) = login(&app, "w4_corrupt", PWD).await;
    assert_eq!(
        status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "哈希损坏必须映射 500，不能是 401"
    );

    let body = error_body(&bytes);
    assert_eq!(body["code"], "INTERNAL_ERROR");
    assert_eq!(
        body["message"], "服务器内部错误",
        "500 只返回通用文案，细节只进日志"
    );
    assert_no_internal_details(&bytes);
    assert!(
        !String::from_utf8_lossy(&bytes).contains("not-a-phc-string"),
        "不得回显库中的哈希内容"
    );
}

// ---------------------------------------------------------------------------
// M3-03：`AuthConfig.verify_limits` 确实传入真实登录路径
// ---------------------------------------------------------------------------

/// 同一行数据、同一密码，只有 `AuthConfig.verify_limits` 不同：越界 500，合法 200。
///
/// 这是「配置接线」的直接证据——若 `verify_limits` 没传到真实校验路径，
/// 两次结果会一样，本用例必然失败。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 验证上限经配置传入真实登录路径() {
    let pool = isolated_pool().await;

    // 库里写入一条用**小参数**（m=2048）真实生成的哈希。
    let hash = hash_password(PWD, &light_params()).expect("哈希生成不应失败");
    assert!(hash.contains("m=2048"), "实际：{hash}");
    insert_raw_user(&pool, "w4_limits", &hash).await;

    // ① 上限 1024 KiB < 实际 2048 KiB：越界，必须 500。
    let tight_app = build_app!(
        pool.clone(),
        AuthConfig {
            jwt_ttl_secs: 3600,
            verify_limits: VerifyLimits {
                max_memory_kib: 1_024,
                max_iterations: 64,
                max_parallelism: 8,
            },
            ..Default::default()
        },
        None
    );
    let (tight_status, _, tight_bytes) = login(&tight_app, "w4_limits", PWD).await;
    assert_eq!(
        tight_status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "上限 1024 应拦下 m=2048 的记录（500），实际：{tight_status}"
    );
    assert_eq!(error_body(&tight_bytes)["code"], "INTERNAL_ERROR");

    // ② 上限 2048 KiB = 实际：合法，必须 200。
    let exact_app = build_app!(
        pool.clone(),
        AuthConfig {
            jwt_ttl_secs: 3600,
            verify_limits: VerifyLimits {
                max_memory_kib: 2_048,
                max_iterations: 64,
                max_parallelism: 8,
            },
            ..Default::default()
        },
        None
    );
    let (exact_status, _, exact_bytes) = login(&exact_app, "w4_limits", PWD).await;
    assert_eq!(
        exact_status,
        StatusCode::OK,
        "上限放到 2048 后同一记录应能登录，实际：{} / {}",
        exact_status,
        String::from_utf8_lossy(&exact_bytes)
    );
}

// ---------------------------------------------------------------------------
// M3-04：限流（隔离实例，不依赖数据库）
// ---------------------------------------------------------------------------

/// 指向不可用地址的惰性连接池：只用它的形状，不发起连接。
///
/// 限流用例在处理器里先过限流器、后校验入参，入参非法时不会触库，
/// 因此这些用例可以在**无数据库**环境运行。
fn lazy_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_millis(300))
        .connect_lazy("postgres://nobody@127.0.0.1:1/nonexistent")
        .expect("connect_lazy 不会发起连接，不应失败")
}

/// 第 6 次请求触发 429，带 `Retry-After`，错误码为 `RATE_LIMITED`。
///
/// 阈值取 API.md §6 的生产参数（每 IP 60 秒 5 次），但用**独立实例**，
/// 不与其它用例共享计数。
#[actix_web::test]
async fn 登录第六次请求触发429并带retry_after() {
    let app = build_app!(
        lazy_pool(),
        AuthConfig::default(),
        Some(RateLimiter::new(5, 60))
    );

    // 入参非法（用户名 1 字符、密码空）→ 处理器已过限流、在入参校验处返回 400，不触库。
    let body = serde_json::json!({ "username": "x", "password": "" });

    for n in 1..=5 {
        let (status, _, _) = post_json(&app, "/api/v1/auth/login", &body, None).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "第 {n} 次应在入参校验处返回 400"
        );
    }

    let (status, headers, bytes) = post_json(&app, "/api/v1/auth/login", &body, None).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "第 6 次应被限流");

    let retry_after = header_str(&headers, "Retry-After").expect("429 必须带 Retry-After");
    let secs: u64 = retry_after.parse().expect("Retry-After 应为整数秒");
    assert!(
        (1..=60).contains(&secs),
        "Retry-After 应在 1..=60 之间，实际：{secs}"
    );

    let body_json = error_body(&bytes);
    assert_eq!(body_json["code"], "RATE_LIMITED");
    assert_eq!(
        Some(body_json["request_id"].as_str().expect("应含 request_id")),
        header_str(&headers, "X-Request-Id").as_deref(),
        "429 的 request_id 必须与响应头一致"
    );
}

/// 不同 IP 各自计数：A 用尽后，B 仍可继续。
#[actix_web::test]
async fn 不同ip限流互相独立() {
    let app = build_app!(
        lazy_pool(),
        AuthConfig::default(),
        Some(RateLimiter::new(1, 60))
    );
    let body = serde_json::json!({ "username": "x", "password": "" });

    let (a1, _, _) = post_json(&app, "/api/v1/auth/login", &body, Some("10.0.1.1:5555")).await;
    assert_eq!(a1, StatusCode::BAD_REQUEST, "A 的首次请求应放行");

    let (a2, _, _) = post_json(&app, "/api/v1/auth/login", &body, Some("10.0.1.1:5555")).await;
    assert_eq!(a2, StatusCode::TOO_MANY_REQUESTS, "A 的第二次请求应被限流");

    let (b1, _, _) = post_json(&app, "/api/v1/auth/login", &body, Some("10.0.1.2:5555")).await;
    assert_eq!(b1, StatusCode::BAD_REQUEST, "B 不应受 A 的计数影响");
}

/// 窗口到期后恢复：用 1 秒窗口，避免真实长时间 sleep。
#[actix_web::test]
async fn 限流窗口到期后恢复() {
    let app = build_app!(
        lazy_pool(),
        AuthConfig::default(),
        Some(RateLimiter::new(1, 1))
    );
    let body = serde_json::json!({ "username": "x", "password": "" });

    let (first, _, _) = post_json(&app, "/api/v1/auth/login", &body, Some("10.0.2.1:5555")).await;
    assert_eq!(first, StatusCode::BAD_REQUEST);

    let (blocked, _, bytes) =
        post_json(&app, "/api/v1/auth/login", &body, Some("10.0.2.1:5555")).await;
    assert_eq!(blocked, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(error_body(&bytes)["code"], "RATE_LIMITED");

    // 1 秒窗口 + 100ms 余量；不是「长时间 sleep」。
    actix_rt::time::sleep(std::time::Duration::from_millis(1_100)).await;

    let (recovered, _, _) =
        post_json(&app, "/api/v1/auth/login", &body, Some("10.0.2.1:5555")).await;
    assert_eq!(recovered, StatusCode::BAD_REQUEST, "窗口到期后应恢复放行");
}

/// 事实记录：生产装配只注册**一个** `RateLimiter`，注册与登录共用同一份计数。
///
/// API.md §6 的分表写法容易被读成「每个接口各 5 次」；实际实现是一个实例
/// 被两个处理器共享，因此同一 IP 在两个接口上**合计** 5 次即被限流。
/// 这属于共享限流器的设计问题，按 W4 提示词要求**只记录、写进 M1 交接**，
/// 不在本轮改公开行为。
#[actix_web::test]
async fn 注册与登录共用同一限流器预算() {
    let app = build_app!(
        lazy_pool(),
        AuthConfig::default(),
        Some(RateLimiter::new(5, 60))
    );
    let body = serde_json::json!({ "username": "x", "password": "" });
    let peer = Some("10.0.3.1:5555");

    // 前 5 次交替打在注册与登录上，全部只到入参校验（400），合计计入同一份计数。
    for n in 1..=5 {
        let uri = if n % 2 == 0 {
            "/api/v1/auth/login"
        } else {
            "/api/v1/auth/register"
        };
        let (status, _, _) = post_json(&app, uri, &body, peer).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "第 {n} 次（{uri}）应放行");
    }

    for uri in ["/api/v1/auth/register", "/api/v1/auth/login"] {
        let (status, _, _) = post_json(&app, uri, &body, peer).await;
        assert_eq!(
            status,
            StatusCode::TOO_MANY_REQUESTS,
            "{uri} 应因共享计数被限流（观测：合计第 6 次起）"
        );
    }

    // 换 IP 后不受影响，证明共享的是「计数容器」而不是「全局开关」。
    let (fresh, _, _) = post_json(&app, "/api/v1/auth/login", &body, Some("10.0.3.2:5555")).await;
    assert_eq!(fresh, StatusCode::BAD_REQUEST);
}

/// 限流器阈值与剩余秒数的直接观测（纯实例级，补充 HTTP 用例）。
///
/// 打印实际 `Retry-After` 计算值，供交付记录引用：实现返回的是「剩余秒数」
/// （`<=` 窗口长度），不是文档字面的固定 60。
#[test]
fn 限流器剩余秒数不超过窗口长度() {
    let limiter = RateLimiter::new(5, 60);
    let ip: IpAddr = "192.0.2.10".parse().expect("IP 应合法");

    for _ in 0..5 {
        assert!(limiter.check(ip).is_none(), "阈值内的请求应放行");
    }
    let retry_after = limiter.check(ip).expect("第 6 次应被限流");
    assert!(
        (1..=60).contains(&retry_after),
        "Retry-After 应在 1..=60 之间，实际：{retry_after}"
    );
    println!("观测：RateLimiter(5,60) 第 6 次返回 Retry-After = {retry_after} 秒");

    // 换 IP 独立。
    let other: IpAddr = "192.0.2.11".parse().expect("IP 应合法");
    assert!(limiter.check(other).is_none(), "不同 IP 应独立计数");
}
