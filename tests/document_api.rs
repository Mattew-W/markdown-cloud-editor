//! 文档路由的**真实数据库**集成测试（M1 W3）。
//!
//! 覆盖任务书要求的全部验收项：
//!
//! - 两用户数据隔离（A 看不到 B 的文档）；
//! - CRUD 全流程（创建 / 列表 / 详情 / 更新 / 删除）；
//! - 字段边界（标题空白、标题超长、正文超限、显式空标题）；
//! - 并发旧版本写入触发 `409 VERSION_CONFLICT` 且带 `server_version`；
//! - 越权与不存在统一 `404`；
//! - `DELETE` 返回 `204` 且**无响应体**。
//!
//! 依据规范 §11「测试服务不可用应明确失败，不报告为通过」与
//! §12「最终验收必须连接真实后端和数据库」，
//! `TEST_DATABASE_URL` 缺失时**直接失败**，不静默跳过。
//!
//! 运行：
//! ```text
//! $env:TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:5432/mce_test"
//! cargo test --locked --test document_api -- --ignored
//! ```
//!
//! 每个用例在**独立 schema** 内运行（见 [`isolated_pool`]），
//! 因此可安全并行，不会互相清空数据。

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
///
/// 与 `auth_db.rs` 同款做法：独立 schema + `after_connect` 设 `search_path`，
/// 使不同用例物理隔离，可安全并行。
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

    // 复用真实迁移文件，保证测的就是生产 schema（规范 §11：不得另写一套）。
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

    format!("t_{thread}_{n}_{stamp:x}")
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
            argon2_params: markdown_cloud_editor::auth::Argon2Params::default(),
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

// ==================== 认证与鉴权 ====================

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 无token访问文档返回401() {
    let app = build_app!(isolated_pool().await);

    let req = test::TestRequest::get()
        .uri("/api/v1/documents")
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "缺 token 应 401");
    assert_eq!(error_code(resp).await, "UNAUTHORIZED");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 非法token访问文档返回401() {
    let app = build_app!(isolated_pool().await);

    let req = test::TestRequest::get()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", "Bearer not-a-real-token"))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "非法 token 应 401");
}

// ==================== CRUD 全流程 ====================

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 文档crud全流程() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    // --- 创建 ---
    let (id, version) = create_doc_ok(&app, &token, "第一篇", "# 标题\n正文").await;
    assert_eq!(version, 1, "初始版本号必须是 1");

    // --- 列表：含正文吗？不含 ---
    let req = test::TestRequest::get()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["total"], 1, "total 应为 1");
    assert_eq!(body["documents"].as_array().expect("应为数组").len(), 1);
    assert!(
        body["documents"][0].get("content").is_none(),
        "列表摘要**不得**包含正文"
    );
    assert_eq!(body["documents"][0]["title"], "第一篇");
    assert_eq!(body["limit"], 20, "limit 默认 20");
    assert_eq!(body["offset"], 0, "offset 默认 0");

    // --- 详情：含正文 ---
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["content"], "# 标题\n正文", "详情应含完整正文");
    assert_eq!(body["version"], 1);

    // --- 更新 ---
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "改过的标题",
            "content": "新正文",
            "expected_version": 1
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK, "更新应返回 200");
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["version"], 2, "版本号应自增为 2");
    assert_eq!(body["id"], id.as_str(), "应回显 id");
    assert!(body.get("updated_at").is_some(), "应含 updated_at");
    assert!(body.get("content").is_none(), "更新成功**不得**回传正文");

    // --- 删除 ---
    let req = test::TestRequest::delete()
        .uri(&format!("/api/v1/documents/{id}?expected_version=2"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT, "删除应返回 204");

    // 204 必须无响应体
    let body = test::read_body(resp).await;
    assert!(
        body.is_empty(),
        "204 响应体必须为空，实际 {:?}",
        String::from_utf8_lossy(&body)
    );

    // 删除后再取应为 404
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "删除后应 404");
}

// ==================== 两用户隔离 ====================

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 两用户数据互相隔离() {
    let app = build_app!(isolated_pool().await);
    let (_uid_a, token_a) = register_ok(&app, "alice").await;
    let (_uid_b, token_b) = register_ok(&app, "bob").await;

    let (id_a, _) = create_doc_ok(&app, &token_a, "A 的私密文档", "A 的内容").await;
    create_doc_ok(&app, &token_b, "B 的文档", "B 的内容").await;

    // A 的列表只有自己的
    let req = test::TestRequest::get()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["total"], 1, "A 只应看到自己 1 篇");
    assert_eq!(body["documents"][0]["title"], "A 的私密文档");

    // B 拿 A 的 id 直接取 → 404（不是 403）
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/documents/{id_a}"))
        .insert_header(("Authorization", format!("Bearer {token_b}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "越权读取应 404");
    assert_eq!(error_code(resp).await, "NOT_FOUND");

    // B 改 A 的文档 → 404
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id_a}"))
        .insert_header(("Authorization", format!("Bearer {token_b}")))
        .set_json(serde_json::json!({
            "title": "B 改的",
            "content": "恶意内容",
            "expected_version": 1
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "越权更新应 404");

    // B 删 A 的文档 → 404
    let req = test::TestRequest::delete()
        .uri(&format!("/api/v1/documents/{id_a}?expected_version=1"))
        .insert_header(("Authorization", format!("Bearer {token_b}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "越权删除应 404");

    // A 的文档仍在
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/documents/{id_a}"))
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK, "A 的文档不应被 B 影响");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 不存在的文档返回404() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    let req = test::TestRequest::get()
        .uri("/api/v1/documents/00000000-0000-0000-0000-000000000000")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert_eq!(error_code(resp).await, "NOT_FOUND");
}

// ==================== 乐观锁与版本冲突 ====================

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 用旧版本更新触发409且带server_version() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;
    let (id, _) = create_doc_ok(&app, &token, "标题", "内容").await;

    // 第一次更新成功，版本变 2
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "标题2", "content": "内容2", "expected_version": 1
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK);

    // 再用旧版本 1 更新 → 409
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "标题3", "content": "内容3", "expected_version": 1
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::CONFLICT, "旧版本写入应 409");
    assert_eq!(error_code(resp).await, "VERSION_CONFLICT");

    // 必须带 server_version
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "标题4", "content": "内容4", "expected_version": 1
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(
        body["error"]["details"]["server_version"],
        serde_json::json!(2),
        "409 必须带 server_version=2"
    );
    assert!(
        body["error"]["request_id"]
            .as_str()
            .is_some_and(|v| !v.is_empty()),
        "错误体必须带 request_id"
    );
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 用旧版本删除触发409() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;
    let (id, _) = create_doc_ok(&app, &token, "标题", "内容").await;

    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "新标题", "content": "新内容", "expected_version": 1
        }))
        .to_request();
    test::call_service(&app, req).await;

    // 用旧版本 1 删除 → 409
    let req = test::TestRequest::delete()
        .uri(&format!("/api/v1/documents/{id}?expected_version=1"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::CONFLICT, "旧版本删除应 409");
    assert_eq!(error_code(resp).await, "VERSION_CONFLICT");

    // 文档仍在
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK, "冲突的删除不应生效");
}

// ==================== 字段边界 ====================

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 创建时省略标题使用默认标题() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    // 完全省略 title
    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "content": "只有正文" }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["title"], "未命名文档", "省略标题应使用默认值");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 创建时显式传空标题返回400() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    // 显式传空标题 —— 与「省略」不同，必须 400
    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": "", "content": "正文" }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "显式空标题应 400");
    assert_eq!(error_code(resp).await, "BAD_REQUEST");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 创建时全角空格标题返回400() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    // U+3000 全角空格 —— trim 后为空
    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": "\u{3000}\u{3000}", "content": "正文" }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "全角空格标题应 400");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 标题超长返回400() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    // 256 个字符，超过 255 上限
    let long = "字".repeat(256);
    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": long, "content": "正文" }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "超长标题应 400");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 正文超限返回413() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    // 262145 字节，超过 262144 上限
    let big = "a".repeat(262_145);
    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": "标题", "content": big }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(
        resp.status(),
        StatusCode::PAYLOAD_TOO_LARGE,
        "正文超限应 413"
    );
    assert_eq!(error_code(resp).await, "PAYLOAD_TOO_LARGE");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 正文恰好在上限应通过() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    // 恰好 262144 字节，边界值应合法
    let exact = "a".repeat(262_144);
    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": "边界", "content": exact }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::CREATED, "边界值应通过");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 更新缺少必填字段返回400() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;
    let (id, _) = create_doc_ok(&app, &token, "标题", "内容").await;

    // 缺 expected_version
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": "新标题", "content": "新内容" }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "缺字段应 400");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 删除缺少expected_version查询参数返回400() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;
    let (id, _) = create_doc_ok(&app, &token, "标题", "内容").await;

    // 不带 expected_version
    let req = test::TestRequest::delete()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "缺查询参数应 400");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 分页参数越界返回400() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    for uri in [
        "/api/v1/documents?limit=0",
        "/api/v1/documents?limit=101",
        "/api/v1/documents?offset=-1",
    ] {
        let req = test::TestRequest::get()
            .uri(uri)
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{uri} 应返回 400");
    }
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 分页与排序稳定() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    // 创建 3 篇，标题按创建顺序
    create_doc_ok(&app, &token, "第一篇", "c1").await;
    create_doc_ok(&app, &token, "第二篇", "c2").await;
    create_doc_ok(&app, &token, "第三篇", "c3").await;

    // limit=2 取前两篇
    let req = test::TestRequest::get()
        .uri("/api/v1/documents?limit=2&offset=0")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["documents"].as_array().expect("应为数组").len(), 2);
    assert_eq!(body["total"], 3, "total 是总数，不受 limit 影响");
    assert_eq!(body["limit"], 2);

    // offset=1 取后两篇
    let req = test::TestRequest::get()
        .uri("/api/v1/documents?limit=2&offset=1")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["documents"].as_array().expect("应为数组").len(), 2);

    // 两次相同查询必须返回相同顺序（排序稳定）
    let mut orders = Vec::new();
    for _ in 0..2 {
        let req = test::TestRequest::get()
            .uri("/api/v1/documents")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let resp = test::call_service(&app, req).await;
        let body: serde_json::Value = test::read_body_json(resp).await;
        let ids: Vec<String> = body["documents"]
            .as_array()
            .expect("应为数组")
            .iter()
            .map(|d| d["id"].as_str().unwrap_or_default().to_owned())
            .collect();
        orders.push(ids);
    }
    assert_eq!(orders[0], orders[1], "相同查询必须返回相同顺序");
}
