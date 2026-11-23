//! M4 W4 新增集成测试：把「输入边界」真正压到生产校验入口上。
//!
//! # 为什么需要这个文件
//!
//! W3 的 `document_api.rs` 已经覆盖了 CRUD、越权、乐观锁等主流程，但在
//! **边界输入**上存在一个共性缺陷：用例的输入与断言同源自对边界的想象，
//! 而不是来自能让「错误实现」与「正确实现」得出相反结果的取值。
//!
//! 典型例子是 `正文超限返回413`：它用 `"a".repeat(262_145)`（无首尾空白），
//! 无论实现是「按原始字节计数」还是「先 trim 再计数」，结果都是 413——
//! 这条用例因此**没有鉴别力**，它只能证明「超限会拒绝」，
//! 不能证明「按原始字节计数」。
//!
//! 本文件用**对偶输入**（原始超限、修剪后合规）让两种实现分道扬镳：
//!
//! ```text
//! content = " " + "a" * 262144 + " "   // 原始 262146 字节，trim 后 262144 字节
//!   按原始字节计数 → 262146 > 262144 → 413（正确）
//!   先 trim 再计数 → 262144 <= 262144 → 201（错误，会静默放行超限正文）
//! ```
//!
//! `M4-05` 的定向变异（把 `validate_content` 改成 `content.trim().len()`）
//! 实测只会让本文件的三条 M4-01 用例变红，而 `document_api.rs` 的 20 条全绿。
//!
//! # 运行
//!
//! ```text
//! $env:TEST_DATABASE_URL = "postgres://postgres:test@127.0.0.1:55432/mce_test"
//! cargo test --locked --test document_w4 -- --ignored
//! ```
//!
//! 每个用例在独立 schema 内运行（见 [`isolated_pool`]），可安全并行。

use actix_http::Request;
use actix_web::dev::{Service, ServiceResponse};
use actix_web::http::StatusCode;
use actix_web::{App, Error, test, web};
use markdown_cloud_editor::configure_app;
use markdown_cloud_editor::middleware::RequestIdLayer;
use markdown_cloud_editor::routes::auth::AuthConfig;
use markdown_cloud_editor::state::AppState;
use sqlx::PgPool;

/// 测试用 JWT 密钥。**仅本测试使用**，非真实部署密钥。
const TEST_SECRET: &str = "Kd8#mZ2!vQ7@xR4&pW9@jL5^nT3*yF7=hG2+Ab1";

/// 合法密码（≥ 12 UTF-8 字节，符合规范 §06）。
const TEST_PASSWORD: &str = "Correct-Horse-Battery";

/// 正文上限（字节），与 `config::MAX_CONTENT_BYTES` 保持一致。
const MAX_CONTENT: usize = 262_144;

/// 取测试连接串，缺失时 panic 并给出可执行的修复指引。
fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .expect(
            "TEST_DATABASE_URL 未设置。\n\
             依据规范 §11/§12，数据库集成测试不得静默跳过。\n\
             设置方式见 docs/LOCAL_POSTGRES.md 第五节。",
        )
}

/// 断言真实数据库可用，否则明确失败。
macro_rules! require_db {
    () => {
        if std::env::var("TEST_DATABASE_URL")
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            panic!(
                "TEST_DATABASE_URL 未设置。\n\
                 依据规范 §11/§12，数据库集成测试不允许静默跳过。\n\
                 设置方法见 docs/LOCAL_POSTGRES.md 第五节。"
            );
        }
    };
}

/// 建连接池并为**当前测试**准备一个独立 schema。
async fn isolated_pool() -> PgPool {
    require_db!();
    let schema = unique_schema_name();

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
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

/// 生成一个当前测试独有的 schema 名。
fn unique_schema_name() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let thread: String = std::thread::current()
        .name()
        .unwrap_or("t")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(12)
        .collect();

    format!("w4_{thread}_{n}_{stamp:x}")
}

/// 组装应用，走与生产**完全相同**的组装路径。
macro_rules! build_app {
    ($pool:expr) => {{
        let config = markdown_cloud_editor::Config::new(
            test_database_url(),
            TEST_SECRET.to_owned(),
            "127.0.0.1:8080".to_owned(),
            3600,
        )
        .expect("测试配置应合法");

        let state = web::Data::new(AppState::new($pool));
        let auth_config = web::Data::new(AuthConfig {
            jwt_ttl_secs: 3600,
            ..Default::default()
        });

        test::init_service(
            App::new()
                .app_data(state)
                .app_data(web::Data::new(config))
                .app_data(auth_config)
                .wrap(RequestIdLayer)
                .configure(configure_app),
        )
        .await
    }};
}

/// 注册一个用户，返回 `(user_id, token)`。
async fn register_ok<S>(app: &S, username: &str) -> (String, String)
where
    S: Service<Request, Response = ServiceResponse, Error = Error>,
    S::Future: 'static,
{
    let req = test::TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(serde_json::json!({ "username": username, "password": TEST_PASSWORD }))
        .to_request();
    let resp = test::call_service(app, req).await;
    assert_eq!(resp.status(), StatusCode::CREATED, "注册应返回 201");

    let body: serde_json::Value = test::read_body_json(resp).await;
    (
        body["user"]["id"]
            .as_str()
            .expect("应含 user.id")
            .to_owned(),
        body["token"].as_str().expect("应含 token").to_owned(),
    )
}

/// 解析错误响应里的 `error.code`。
async fn error_code(resp: ServiceResponse) -> String {
    let body: serde_json::Value = test::read_body_json(resp).await;
    body["error"]["code"]
        .as_str()
        .unwrap_or("<无 code 字段>")
        .to_owned()
}

/// 创建一个文档，返回 `(id, version)`。
async fn create_doc_ok<S>(app: &S, token: &str, title: &str, content: &str) -> (String, i64)
where
    S: Service<Request, Response = ServiceResponse, Error = Error>,
    S::Future: 'static,
{
    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": title, "content": content }))
        .to_request();
    let resp = test::call_service(app, req).await;
    assert_eq!(resp.status(), StatusCode::CREATED, "创建文档应返回 201");

    let body: serde_json::Value = test::read_body_json(resp).await;
    (
        body["id"].as_str().expect("应含 id").to_owned(),
        body["version"].as_i64().expect("应含 version"),
    )
}

/// 直接读库里的 `content`，绕过 HTTP 序列化。
async fn stored_content(pool: &PgPool, id: &str) -> String {
    let row: (String,) = sqlx::query_as("SELECT content FROM documents WHERE id = $1")
        .bind(uuid::Uuid::parse_str(id).expect("id 应为 UUID"))
        .fetch_one(pool)
        .await
        .expect("应能查到文档");
    row.0
}

/// 直接从 HTTP 详情接口读回正文。
async fn fetched_content<S>(app: &S, token: &str, id: &str) -> String
where
    S: Service<Request, Response = ServiceResponse, Error = Error>,
    S::Future: 'static,
{
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp = test::call_service(app, req).await;
    assert_eq!(resp.status(), StatusCode::OK, "详情应返回 200");
    let body: serde_json::Value = test::read_body_json(resp).await;
    body["content"]
        .as_str()
        .expect("详情应含 content")
        .to_owned()
}

/// 构造「原始超限、修剪后合规」的正文：`" " + "a"×262144 + " "`。
///
/// 原始 262146 字节，`trim()` 后恰好 262144 字节。
fn over_limit_but_trim_ok() -> String {
    let mut s = String::with_capacity(MAX_CONTENT + 2);
    s.push(' ');
    s.push_str(&"a".repeat(MAX_CONTENT));
    s.push(' ');
    s
}

// ==================== M4-01：正文上限按原始字节计数 ====================

/// M4-01：创建路径必须按**原始字节**判断上限。
///
/// 输入原始 262146 字节、trim 后 262144 字节。
/// - 正确实现（`content.len()`）→ 413；
/// - 错误实现（`content.trim().len()`）→ 201。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn m4_01_原始超限修剪后合规的正文创建必须413() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    let raw = over_limit_but_trim_ok();
    assert_eq!(raw.len(), MAX_CONTENT + 2, "构造的原始字节数应为 262146");
    assert_eq!(
        raw.trim().len(),
        MAX_CONTENT,
        "构造的 trim 后字节数应恰为 262144"
    );

    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": "标题", "content": raw }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(
        resp.status(),
        StatusCode::PAYLOAD_TOO_LARGE,
        "正文上限必须按原始字节判断：262146 > 262144 应返回 413"
    );
    assert_eq!(error_code(resp).await, "PAYLOAD_TOO_LARGE");
}

/// M4-01：更新路径同样按**原始字节**判断上限。
///
/// 与创建路径是两个不同的落库/校验调用点，必须分别覆盖。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn m4_01_原始超限修剪后合规的正文更新必须413() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;
    let (id, version) = create_doc_ok(&app, &token, "标题", "初始正文").await;

    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "标题",
            "content": over_limit_but_trim_ok(),
            "expected_version": version
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(
        resp.status(),
        StatusCode::PAYLOAD_TOO_LARGE,
        "更新路径也必须按原始字节判断：262146 > 262144 应返回 413"
    );
}

/// M4-01：直接调用校验入口，确认是**入参本身**超限而非下游拒绝。
///
/// 前两条用例走 HTTP，若 413 来自 body 大小限制而非 `validate_content`，
/// 断言就会误判。这条用例直接调生产函数，把「哪一层拒绝」钉死。
// 注意：本文件 `use actix_web::test`，`#[test]` 会被解析成那个模块而不是内置宏，
// 故这里用 `#[actix_web::test]`（它只需要 async fn，不要求数据库）。
#[actix_web::test]
async fn m4_01_校验入口直接调用拒绝原始超限正文() {
    use markdown_cloud_editor::error::ErrorCode;
    use markdown_cloud_editor::services::document_service::validate_content;

    let raw = over_limit_but_trim_ok();
    let err = validate_content(&raw).expect_err("原始 262146 字节必须被拒绝");
    assert_eq!(err.code(), ErrorCode::PayloadTooLarge);

    // 对照：同样的内容 trim 后合规——但**不得**因此放行原串。
    assert!(validate_content(raw.trim()).is_ok());
}

// ==================== M4-02：标题边界 ====================

/// M4-02：纯普通空格标题（`"   "`）必须 400。
///
/// 与「省略 title」不同——省略走默认值，显式给空白必须拒绝。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn m4_02_纯普通空格标题返回400() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": "   ", "content": "正文" }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "纯空格标题应 400");
    assert_eq!(error_code(resp).await, "BAD_REQUEST");
}

/// M4-02：U+00A0 不间断空格标题必须 400。
///
/// `str::trim()` 认为 U+00A0 是空白，但很多手写实现只处理 ASCII 空格，
/// 这条用例专门把「Unicode 空白也算空白」钉死。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn m4_02_u00a0不间断空格标题返回400() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "\u{00A0}\u{00A0}",
            "content": "正文"
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "U+00A0 标题应 400");
}

/// M4-02：`trim()` 后 255 个 Unicode 标量合法、256 个非法（按**字符**不按字节）。
///
/// 输入两端各加一个空格（共 257 标量），用「中」这种 3 字节字符，
/// 同时证明上限数的是 `chars()` 而非 `len()`（否则 255 个「中」= 765 字节，
/// 按字节算会直接判超限，用例会红）。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn m4_02_标题修剪后255合法而256非法() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    // 255 个「中」+ 两端空格 → trim 后 255，合法
    let ok_title = format!(" {} ", "中".repeat(255));
    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": ok_title, "content": "正文" }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::CREATED, "trim 后 255 字符应合法");

    // 响应里的标题必须是规范化（trim 后）值
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(
        body["title"].as_str().expect("应含 title"),
        "中".repeat(255),
        "返回的标题应是 trim 后的规范化值"
    );

    // 256 个「中」→ 超限
    let bad_title = format!(" {} ", "中".repeat(256));
    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": bad_title, "content": "正文" }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(
        resp.status(),
        StatusCode::BAD_REQUEST,
        "trim 后 256 字符应 400"
    );
}

// ==================== M4-03：UTF-8 多字节正文 ====================

/// M4-03：多字节字符的正文上限按**字节**而非字符数。
///
/// `"中"` 占 3 字节：87381 个「中」= 262143 字节，补 1 个 `a` 恰好 262144 → 201；
/// 再多 1 个 `a` = 262145 → 413。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn m4_03_多字节正文按字节边界() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    let mut ok = "中".repeat(87_381);
    ok.push('a');
    assert_eq!(ok.len(), MAX_CONTENT, "构造的字节数应恰为 262144");
    assert_eq!(ok.chars().count(), 87_382, "字符数与字节数不同");

    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": "多字节", "content": ok }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "多字节正文恰好 262144 字节应通过"
    );

    let bad = format!("{}aa", "中".repeat(87_381));
    assert_eq!(bad.len(), MAX_CONTENT + 1);
    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": "多字节", "content": bad }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(
        resp.status(),
        StatusCode::PAYLOAD_TOO_LARGE,
        "多字节正文 262145 字节应 413"
    );
}

/// M4-03：空正文在**创建**路径原样落库（空串，不是 null）。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn m4_03_空正文创建路径原样落库() {
    let pool = isolated_pool().await;
    let app = build_app!(pool.clone());
    let (_uid, token) = register_ok(&app, "alice").await;

    // 显式传空串
    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": "空正文", "content": "" }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let body: serde_json::Value = test::read_body_json(resp).await;
    let id = body["id"].as_str().expect("应含 id").to_owned();

    assert_eq!(stored_content(&pool, &id).await, "", "库里应是空串");
    assert_eq!(fetched_content(&app, &token, &id).await, "", "回读应是空串");
}

/// M4-03：空正文在**更新**路径原样落库（覆盖另一个落库点）。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn m4_03_空正文更新路径原样落库() {
    let pool = isolated_pool().await;
    let app = build_app!(pool.clone());
    let (_uid, token) = register_ok(&app, "alice").await;
    let (id, version) = create_doc_ok(&app, &token, "标题", "非空正文").await;

    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "标题",
            "content": "",
            "expected_version": version
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK, "更新为空正文应 200");

    assert_eq!(stored_content(&pool, &id).await, "", "库里应被置为空串");
    assert_eq!(fetched_content(&app, &token, &id).await, "", "回读应是空串");
}

/// M4-03：更新路径正文首尾空白原样落库（与创建路径分开覆盖）。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn m4_03_更新路径正文首尾空白原样落库() {
    let pool = isolated_pool().await;
    let app = build_app!(pool.clone());
    let (_uid, token) = register_ok(&app, "alice").await;
    let (id, version) = create_doc_ok(&app, &token, "标题", "初始").await;

    let raw = "  更新后的正文\n\t  ";
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "  新标题  ",
            "content": raw,
            "expected_version": version
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK);

    assert_eq!(stored_content(&pool, &id).await, raw, "正文应原样落库");
    assert_eq!(
        fetched_content(&app, &token, &id).await,
        raw,
        "回读应与写入完全一致"
    );
}

// ==================== M4-04：版本号边界 ====================

/// M4-04：`expected_version = 0` 必须 400（乐观锁版本从 1 起）。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn m4_04_期望版本为0返回400() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;
    let (id, _version) = create_doc_ok(&app, &token, "标题", "正文").await;

    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "标题",
            "content": "新正文",
            "expected_version": 0
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "版本 0 应 400");
    assert_eq!(error_code(resp).await, "BAD_REQUEST");
}

/// M4-04：负版本号必须 400。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn m4_04_期望版本为负数返回400() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;
    let (id, _) = create_doc_ok(&app, &token, "标题", "正文").await;

    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "标题",
            "content": "新正文",
            "expected_version": -5
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "负版本应 400");
}

/// M4-04：超出 `i32` 上限的版本号必须 400（不能溢出成负数后继续走）。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn m4_04_期望版本超出i32上限返回400() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;
    let (id, _) = create_doc_ok(&app, &token, "标题", "正文").await;

    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "标题",
            "content": "新正文",
            "expected_version": 2_147_483_648_i64
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(
        resp.status(),
        StatusCode::BAD_REQUEST,
        "超出 i32 的版本号应 400（反序列化失败）"
    );
}

/// M4-04：`expected_version` 类型错误（字符串）必须 400。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn m4_04_期望版本类型错误返回400() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;
    let (id, _) = create_doc_ok(&app, &token, "标题", "正文").await;

    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "标题",
            "content": "新正文",
            "expected_version": "1"
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "字符串版本应 400");
}

/// M4-04：删除接口的 `expected_version` 走查询参数，0 必须 400。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn m4_04_删除时期望版本为0返回400() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;
    let (id, _) = create_doc_ok(&app, &token, "标题", "正文").await;

    let req = test::TestRequest::delete()
        .uri(&format!("/api/v1/documents/{id}?expected_version=0"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "删除版本 0 应 400");
}
