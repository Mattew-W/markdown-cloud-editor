//! 健康检查路由的集成测试。
//!
//! 测试分两类，**严格区分**：
//!
//! - **无需数据库**：验证 404 兜底、请求 ID 响应头等纯 HTTP 行为
//! - **需要真实 PostgreSQL**：验证数据库可达时 200、不可达时 503
//!
//! 需要数据库的用例由 `TEST_DATABASE_URL` 决定是否启用。
//! **禁止**为了"让 CI 变绿"而跳过——规范 §11 要求
//! 「缺少 Cargo.toml、测试服务不可用或必需脚本未配置应明确失败，不报告为通过」。
//!
//! 函数标识符用英文、中文写在文档注释里：规范 §03 要求标识符与代码用英文。
//!
//! 复现命令：
//!   cargo test --locked --all-targets
//!   cargo test --locked --all-targets -- --ignored   # 额外跑需要数据库的用例

use actix_web::http::StatusCode;
use actix_web::{App, test, web};
use markdown_cloud_editor::configure_app;
use markdown_cloud_editor::middleware::RequestIdLayer;
use markdown_cloud_editor::state::AppState;

/// 从环境变量读取测试用连接串，未设置则返回 `None`。
fn test_database_url() -> Option<String> {
    std::env::var("TEST_DATABASE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
}

/// 建一个指向不可用地址的连接池：连接惰性，`SELECT 1` 必然失败。
///
/// 用 `127.0.0.1:1`（保留端口，实际无服务监听）而非随手写的库名，
/// 保证失败原因是"连不上"而不是"库不存在"，语义更明确。
async fn unreachable_pool() -> sqlx::PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_millis(300))
        .connect_lazy("postgres://nobody@127.0.0.1:1/nonexistent")
        .expect("connect_lazy 不会发起连接，不应失败")
}

/// 健康检查在数据库不可用时返回 503。
///
/// 规范要求「服务在 DB 未就绪时不能谎报健康」——这是最容易被实现成
/// "进程活着就报 200"的一条，故单独用不可达连接池验证。
#[actix_web::test]
async fn health_returns_503_when_db_unreachable() {
    let state = web::Data::new(AppState::new(unreachable_pool().await));
    let app = test::init_service(
        App::new()
            .app_data(state)
            .wrap(RequestIdLayer)
            .configure(configure_app),
    )
    .await;

    let req = test::TestRequest::get().uri("/health").to_request();
    let resp = test::call_service(&app, req).await;

    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["status"], "degraded");
    assert_eq!(body["database"], "down");
}

/// 健康检查响应体不含数据库错误细节。
#[actix_web::test]
async fn health_body_leaks_no_database_details() {
    let state = web::Data::new(AppState::new(unreachable_pool().await));
    let app = test::init_service(
        App::new()
            .app_data(state)
            .wrap(RequestIdLayer)
            .configure(configure_app),
    )
    .await;

    let req = test::TestRequest::get().uri("/health").to_request();
    let resp = test::call_service(&app, req).await;
    let body = test::read_body(resp).await;

    // 不得泄露连接串、用户名或底层驱动错误。
    let text = String::from_utf8_lossy(&body);
    assert!(!text.contains("nobody"), "泄露了数据库用户名：{text}");
    assert!(!text.contains("postgres://"), "泄露了连接串：{text}");
}

/// 响应带请求追踪 ID 响应头。
#[actix_web::test]
async fn response_carries_request_id_header() {
    let state = web::Data::new(AppState::new(unreachable_pool().await));
    let app = test::init_service(
        App::new()
            .app_data(state)
            .wrap(RequestIdLayer)
            .configure(configure_app),
    )
    .await;

    let req = test::TestRequest::get().uri("/health").to_request();
    let resp = test::call_service(&app, req).await;

    assert!(
        resp.headers().contains_key("X-Request-Id"),
        "缺少 X-Request-Id 响应头"
    );
}

/// 上游代理传入的请求 ID 被沿用，保证全链路一致。
#[actix_web::test]
async fn incoming_request_id_is_reused() {
    let state = web::Data::new(AppState::new(unreachable_pool().await));
    let app = test::init_service(
        App::new()
            .app_data(state)
            .wrap(RequestIdLayer)
            .configure(configure_app),
    )
    .await;

    let req = test::TestRequest::get()
        .uri("/health")
        .insert_header(("X-Request-Id", "trace-from-proxy-001"))
        .to_request();
    let resp = test::call_service(&app, req).await;

    assert_eq!(
        resp.headers().get("X-Request-Id").unwrap(),
        "trace-from-proxy-001"
    );
}

/// 非法请求 ID 不被采信，回退为新生成的 UUID。
#[actix_web::test]
async fn invalid_request_id_falls_back_to_uuid() {
    let state = web::Data::new(AppState::new(unreachable_pool().await));
    let app = test::init_service(
        App::new()
            .app_data(state)
            .wrap(RequestIdLayer)
            .configure(configure_app),
    )
    .await;

    let req = test::TestRequest::get()
        .uri("/health")
        .insert_header(("X-Request-Id", "bad id with spaces"))
        .to_request();
    let resp = test::call_service(&app, req).await;

    let id = resp
        .headers()
        .get("X-Request-Id")
        .unwrap()
        .to_str()
        .unwrap();
    assert_ne!(id, "bad id with spaces");
    assert_eq!(id.len(), 36, "应回退为 UUID v4：{id}");
}

/// 未知路由返回结构化错误体，而非 actix 默认的纯文本。
#[actix_web::test]
async fn unknown_route_returns_structured_error() {
    let state = web::Data::new(AppState::new(unreachable_pool().await));
    let app = test::init_service(
        App::new()
            .app_data(state)
            .wrap(RequestIdLayer)
            .configure(configure_app),
    )
    .await;

    let req = test::TestRequest::get()
        .uri("/api/v1/documents")
        .to_request();
    let resp = test::call_service(&app, req).await;

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["error"]["code"], "NOT_FOUND");
    assert!(
        body["error"]["request_id"].is_string(),
        "错误体必须含 request_id"
    );
}

/// 健康检查在数据库可用时返回 200。
///
/// 需要真实 PostgreSQL。未设置 `TEST_DATABASE_URL` 时**直接失败**，
/// 不静默跳过——规范 §11 要求测试服务不可用必须明确失败，不得报告为通过。
#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：先设 TEST_DATABASE_URL 再用 --ignored 运行"]
async fn health_returns_200_when_db_reachable() {
    let url = test_database_url().expect(
        "TEST_DATABASE_URL 未设置。数据库集成测试不得静默跳过——请配置真实数据库后用 --ignored 运行。",
    );

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("连接测试数据库失败");

    let state = web::Data::new(AppState::new(pool));
    let app = test::init_service(
        App::new()
            .app_data(state)
            .wrap(RequestIdLayer)
            .configure(configure_app),
    )
    .await;

    let req = test::TestRequest::get().uri("/health").to_request();
    let resp = test::call_service(&app, req).await;

    assert_eq!(resp.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["status"], "ok");
    assert_eq!(body["database"], "up");
}
