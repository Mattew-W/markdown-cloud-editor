//! M4 W5 文档业务联调与回归：补齐 W5 验收里**现有覆盖没有断言到**的路径。
//!
//! 依据 `完整提示词.txt` 的验收 1–4 与 `逐项验收表.md`：
//!
//! - W5-01：正文按**原始 UTF-8 字节**计数（`首尾空格 + 262144 字节`必须被拒，
//!   而不是先 trim 再计数放过）；超限创建不新增行；超限更新后内容与版本维持原值。
//! - W5-02：`U+00A0`（不换行空格）标题按契约返回 400（全角空格已有覆盖，补齐这一条）。
//! - W5-03：同一 `expected_version` 的两个更新**并发起跑**：一个 200、一个 409，
//!   409 的 `error.details.server_version` 等于胜方写入后的版本，
//!   数据库最终行是胜方内容且版本只加一次。
//! - W5-04：非所有者的 GET/PUT/DELETE 均为 `404 NOT_FOUND`，错误体里
//!   **不含文档元数据**；所有者回读内容与版本不变；`request_id` 逐请求变化。
//!
//! 每个用例在**独立 schema**内运行（同 `document_api.rs` 的做法），复用真实
//! `migrations/0001_init.sql`，因此可与既有用例并行、互不清数据。
//!
//! 运行（需要真实 PostgreSQL 17，`TEST_DATABASE_URL` 缺失时直接失败）：
//!
//! ```text
//! $env:TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:5432/mce_test"
//! cargo test --locked --test document_w5 -- --ignored
//! ```

use std::future::Future;
use std::task::Poll;

use actix_http::Request;
use actix_web::dev::{Service, ServiceResponse};
use actix_web::http::StatusCode;
use actix_web::{App, Error, test, web};
use markdown_cloud_editor::configure_app;
use markdown_cloud_editor::middleware::RequestIdLayer;
use markdown_cloud_editor::routes::auth::AuthConfig;
use markdown_cloud_editor::state::AppState;
use sqlx::PgPool;

/// 测试用 JWT 密钥，**仅本测试使用**，非真实部署密钥。
const TEST_SECRET: &str = "Kd8#mZ2!vQ7@xR4&pW9@jL5^nT3*yF7=hG2+Ab1";

/// 合法密码（≥ 12 UTF-8 字节，符合规范 §06）。
const TEST_PASSWORD: &str = "Correct-Horse-Battery";

/// 正文上限：262144 字节（256 KiB）。
const BODY_LIMIT: usize = 262_144;

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

/// 连池并为当前测试建一个独立 schema。
async fn isolated_pool() -> PgPool {
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

    format!("w5_{thread}_{n}_{stamp:x}")
}

/// 组装应用，走与生产完全相同的装配路径。
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

/// 两路并发执行。std 没有 `join!`，这里手写一个最小实现，
/// 好处是不引入额外依赖，且能把两个请求**同时**推给服务。
async fn join2<A, B>(a: A, b: B) -> (A::Output, B::Output)
where
    A: Future,
    B: Future,
{
    let mut a = Box::pin(a);
    let mut b = Box::pin(b);
    let mut a_out: Option<A::Output> = None;
    let mut b_out: Option<B::Output> = None;

    std::future::poll_fn(|cx| {
        if a_out.is_none()
            && let Poll::Ready(v) = a.as_mut().poll(cx)
        {
            a_out = Some(v);
        }
        if b_out.is_none()
            && let Poll::Ready(v) = b.as_mut().poll(cx)
        {
            b_out = Some(v);
        }
        if a_out.is_some() && b_out.is_some() {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await;

    (a_out.unwrap(), b_out.unwrap())
}

fn content_of_bytes(n: usize) -> String {
    "a".repeat(n)
}

/// 读库里最终的一行：(title, content, version)。
async fn read_row(pool: &PgPool, id: &str) -> (String, String, i32) {
    sqlx::query_as("SELECT title, content, version FROM documents WHERE id = $1")
        .bind(uuid::Uuid::parse_str(id).expect("id 应为 UUID"))
        .fetch_one(pool)
        .await
        .expect("应能查到文档")
}

// ==================== W5-01 正文大小与落库 ====================

/// 首尾各加一个空格，总长 262146 字节 > 上限。
///
/// 意义：如果实现是「先 trim 再按字节计数」，这条会被**放过**（trim 后正好 262144），
/// 只有按原始字节计数才会返回 413。这条用例就是用来区分这两者的。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 首尾空格加满额正文按原始字节计数被拒413() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    let raw = format!(" {} ", content_of_bytes(BODY_LIMIT));
    assert_eq!(raw.len(), BODY_LIMIT + 2, "构造前提：总字节数应超出上限 2");

    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": "空格加满额", "content": raw }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(
        resp.status(),
        StatusCode::PAYLOAD_TOO_LARGE,
        "按原始字节计数时，262146 字节必须 413；只有先 trim 才会被放过"
    );
}

/// 超限创建**不能留下半条数据**：库里行数不变。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 超限创建不新增行() {
    let pool = isolated_pool().await;
    let app = build_app!(pool.clone());
    let (_uid, token) = register_ok(&app, "alice").await;

    let before: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM documents")
        .fetch_one(&pool)
        .await
        .expect("应能计数");
    assert_eq!(before.0, 0, "起点应没有文档");

    let oversized = content_of_bytes(BODY_LIMIT + 1);
    let req = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({ "title": "超限", "content": oversized }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let after: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM documents")
        .fetch_one(&pool)
        .await
        .expect("应能计数");
    assert_eq!(after.0, before.0, "超限创建不得新增行");
}

/// 超限**更新**失败后，原有内容与版本必须维持原值（不能被写一半）。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 超限更新后内容与版本维持原值() {
    let pool = isolated_pool().await;
    let app = build_app!(pool.clone());
    let (_uid, token) = register_ok(&app, "alice").await;

    let (id, version) = create_doc_ok(&app, &token, "原标题", "原正文").await;
    assert_eq!(version, 1);

    let oversized = content_of_bytes(BODY_LIMIT + 1);
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "被改的标题",
            "content": oversized,
            "expected_version": version
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let (title, content, ver) = read_row(&pool, &id).await;
    assert_eq!(title, "原标题", "超限更新不得改标题");
    assert_eq!(content, "原正文", "超限更新不得改正文");
    assert_eq!(ver, 1, "超限更新不得改版本");
}

/// 合法正文（含空正文）：创建与更新各自回读，并核对数据库原值。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 合法正文与空正文在创建和更新路径都原样落库() {
    let pool = isolated_pool().await;
    let app = build_app!(pool.clone());
    let (_uid, token) = register_ok(&app, "alice").await;

    // 空正文：合法，落库为空串
    let (id, version) = create_doc_ok(&app, &token, "空正文", "").await;
    assert_eq!(version, 1, "空正文创建后初始版本应为 1");
    let (_, content, _) = read_row(&pool, &id).await;
    assert_eq!(content, "", "空正文应合法并落库为空串");

    // 满额正文（正好 262144）+ 首尾空白：创建路径
    let raw = format!("  {}  ", content_of_bytes(BODY_LIMIT - 4));
    assert_eq!(raw.len(), BODY_LIMIT, "构造前提：总字节数应正好等于上限");
    let (id2, v2) = create_doc_ok(&app, &token, "满额", &raw).await;
    let (_, stored, _) = read_row(&pool, &id2).await;
    assert_eq!(stored.len(), BODY_LIMIT, "满额正文应原样落库");
    assert!(stored.starts_with("  ") && stored.ends_with("  "));

    // 更新路径：同样原样
    let raw2 = format!("   {}   ", content_of_bytes(BODY_LIMIT - 8));
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id2}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "满额2",
            "content": raw2,
            "expected_version": v2
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK);

    let (_, stored2, ver2) = read_row(&pool, &id2).await;
    assert_eq!(stored2, raw2, "更新路径正文必须原样落库");
    assert_eq!(ver2 as i64, v2 + 1, "更新成功后版本应加一");

    // 空正文创建的文档仍在
    let (_, content, _) = read_row(&pool, &id).await;
    assert_eq!(content, "", "空正文文档不应被别的用例影响");
}

// ==================== W5-02 标题与错误契约 ====================

/// `U+00A0`（不换行空格）：按契约属于「trim 后为空」→ 400 BAD_REQUEST。
///
/// 现有覆盖有显式空串与全角空格（U+3000），缺 U+00A0 这一条。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn nbsp标题返回400且错误码稳定() {
    let app = build_app!(isolated_pool().await);
    let (_uid, token) = register_ok(&app, "alice").await;

    for (label, title) in [
        ("仅 U+00A0", "\u{00A0}"),
        ("两侧 U+00A0", "\u{00A0}\u{00A0}\u{00A0}"),
        ("U+00A0 包住文字", "\u{00A0}标题\u{00A0}"),
    ] {
        let req = test::TestRequest::post()
            .uri("/api/v1/documents")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(serde_json::json!({ "title": title, "content": "正文" }))
            .to_request();
        let resp = test::call_service(&app, req).await;

        if label == "U+00A0 包住文字" {
            assert_eq!(
                resp.status(),
                StatusCode::CREATED,
                "U+00A0 包住实际文字时 trim 后非空，应放行"
            );
            continue;
        }

        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{label} 应 400");
        let body: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(
            body["error"]["code"], "BAD_REQUEST",
            "{label} 的错误码应稳定为 BAD_REQUEST"
        );
    }
}

// ==================== W5-03 同版本并发更新 ====================

/// 两个请求带**同一个** `expected_version` 并发起跑：最多一次写入。
///
/// 为什么能保证最多一次写入：落库是单条
/// `UPDATE documents SET ... , version = version + 1 WHERE id = $ AND owner_id = $ AND version = $`
/// —— 两个事务的 `WHERE version = 1` 只有先提交的那个能匹配到行，
/// 后到的匹配 0 行，服务层据此返回 409，并把**当前**版本作为 `server_version` 带出。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 同版本并发更新最多一次写入() {
    let pool = isolated_pool().await;
    let app = build_app!(pool.clone());
    let (_uid, token) = register_ok(&app, "alice").await;
    let (id, version) = create_doc_ok(&app, &token, "并发", "初始").await;
    assert_eq!(version, 1);

    // 同时构造两个请求再一起推给服务，避免「先发一个等回来再发第二个」。
    let req_a = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "并发",
            "content": "甲的版本",
            "expected_version": 1
        }))
        .to_request();
    let req_b = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "并发",
            "content": "乙的版本",
            "expected_version": 1
        }))
        .to_request();

    let (resp_a, resp_b) = join2(
        test::call_service(&app, req_a),
        test::call_service(&app, req_b),
    )
    .await;

    let status_a = resp_a.status();
    let status_b = resp_b.status();

    let mut statuses = [status_a, status_b];
    statuses.sort();
    assert_eq!(
        statuses,
        [StatusCode::OK, StatusCode::CONFLICT],
        "并发同版本更新必须恰好一个 200、一个 409，实际 {status_a} / {status_b}"
    );

    let (winner_content, loser_body): (&str, serde_json::Value) = if status_a == StatusCode::OK {
        ("甲的版本", test::read_body_json(resp_b).await)
    } else {
        ("乙的版本", test::read_body_json(resp_a).await)
    };

    assert_eq!(
        loser_body["error"]["code"], "VERSION_CONFLICT",
        "失败方必须是 VERSION_CONFLICT"
    );
    assert_eq!(
        loser_body["error"]["details"]["server_version"],
        serde_json::json!(2),
        "409 里的 server_version 必须等于胜方写入后的版本"
    );

    // 数据库最终行 = 胜方内容，版本只加一次
    let (_, content, ver) = read_row(&pool, &id).await;
    assert_eq!(content, winner_content, "最终落库必须是胜方内容");
    assert_eq!(ver, 2, "版本只能加一次");

    // 再用版本 2 的 GET 回读确认
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["content"], winner_content);
    assert_eq!(body["version"], serde_json::json!(2));
}

/// 并发用例的重复场次：同一断言连跑若干次，记录每次谁赢。
///
/// 提示词要求「记录少量独立重复的场次及各次结果，不假定哪一个请求获胜」。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 同版本并发更新重复场次结果稳定() {
    let pool = isolated_pool().await;
    let app = build_app!(pool.clone());
    let (_uid, token) = register_ok(&app, "alice").await;

    let mut winners = Vec::new();
    for round in 0..5 {
        let (id, version) = create_doc_ok(&app, &token, "重复", "初始").await;
        assert_eq!(version, 1);

        let req_a = test::TestRequest::put()
            .uri(&format!("/api/v1/documents/{id}"))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(serde_json::json!({
                "title": "重复", "content": format!("甲-{round}"), "expected_version": 1
            }))
            .to_request();
        let req_b = test::TestRequest::put()
            .uri(&format!("/api/v1/documents/{id}"))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(serde_json::json!({
                "title": "重复", "content": format!("乙-{round}"), "expected_version": 1
            }))
            .to_request();

        let (resp_a, resp_b) = join2(
            test::call_service(&app, req_a),
            test::call_service(&app, req_b),
        )
        .await;

        let (win, lose) = if resp_a.status() == StatusCode::OK {
            ("甲", resp_b)
        } else {
            ("乙", resp_a)
        };
        assert_eq!(
            lose.status(),
            StatusCode::CONFLICT,
            "第 {round} 轮应一胜一败"
        );

        let (_, content, ver) = read_row(&pool, &id).await;
        assert_eq!(ver, 2, "第 {round} 轮版本只能加一次");
        assert_eq!(
            content,
            format!("{win}-{round}"),
            "第 {round} 轮落库应为胜方内容"
        );
        winners.push(win);
    }

    println!("五轮胜方：{winners:?}（不假定固定一方获胜）");
}

// ==================== W5-04 多用户隔离 ====================

/// 非所有者的三种操作都必须是 404，且**错误体不带文档元数据**；
/// 所有者回读内容与版本不变；两次请求的 `request_id` 不同。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 非所有者三种操作均404且不泄漏元数据() {
    let pool = isolated_pool().await;
    let app = build_app!(pool.clone());
    let (_uid_a, token_a) = register_ok(&app, "alice").await;
    let (_uid_b, token_b) = register_ok(&app, "bob").await;

    let (id, version) = create_doc_ok(&app, &token_a, "A 的机密标题", "A 的机密正文").await;

    let mut request_ids = Vec::new();

    // 1) 非所有者 GET
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token_b}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "越权读应 404");
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["error"]["code"], "NOT_FOUND");
    assert_no_metadata(&body, &id);
    request_ids.push(request_id_of(&body));

    // 2) 非所有者 PUT
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token_b}")))
        .set_json(serde_json::json!({
            "title": "B 想改", "content": "恶意", "expected_version": version
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "越权改应 404");
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["error"]["code"], "NOT_FOUND");
    assert_no_metadata(&body, &id);
    request_ids.push(request_id_of(&body));

    // 3) 非所有者 DELETE
    let req = test::TestRequest::delete()
        .uri(&format!(
            "/api/v1/documents/{id}?expected_version={version}"
        ))
        .insert_header(("Authorization", format!("Bearer {token_b}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "越权删应 404");
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["error"]["code"], "NOT_FOUND");
    assert_no_metadata(&body, &id);
    request_ids.push(request_id_of(&body));

    // 请求 ID 逐请求变化
    assert_eq!(
        request_ids.len(),
        3,
        "应收集到三个 request_id：{request_ids:?}"
    );
    assert!(
        request_ids.iter().all(|v| !v.is_empty()),
        "request_id 不应为空：{request_ids:?}"
    );
    assert_ne!(request_ids[0], request_ids[1], "request_id 应逐请求变化");

    // 所有者回读：内容与版本未变
    let (title, content, ver) = read_row(&pool, &id).await;
    assert_eq!(title, "A 的机密标题");
    assert_eq!(content, "A 的机密正文");
    assert_eq!(ver as i64, version, "越权尝试不得改变版本");

    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/documents/{id}"))
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK, "A 的文档应仍在");
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["content"], "A 的机密正文");
    assert_eq!(body["version"], serde_json::json!(version));
}

fn request_id_of(body: &serde_json::Value) -> String {
    body["error"]["request_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

/// 404 错误体里不得出现文档 id、标题、正文等元数据。
fn assert_no_metadata(body: &serde_json::Value, doc_id: &str) {
    let text = body.to_string();
    assert!(
        !text.contains(doc_id),
        "404 错误体不应包含文档 id（泄漏存在性）：{text}"
    );
    for leaked in ["A 的机密标题", "A 的机密正文"] {
        assert!(
            !text.contains(leaked),
            "404 错误体不应包含文档内容「{leaked}」：{text}"
        );
    }
}
