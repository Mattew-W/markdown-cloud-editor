//! 频率限制集成测试 (对齐 API 规范 §06)

use actix_web::http::StatusCode;
use actix_web::test::{self, TestRequest};
use actix_web::{App, web};
use gemini_markdown_cloud_editor::middleware::RateLimiter;
use gemini_markdown_cloud_editor::{AppState, Config, DbPool, configure_app, run_migrations};
use sqlx::sqlite::SqlitePoolOptions;

#[actix_rt::test]
async fn test_rate_limiter_blocks_on_excess_requests() {
    let mut config = Config::from_env().unwrap();
    config.database_url = "sqlite::memory:?cache=shared".to_string();

    let pool = SqlitePoolOptions::new()
        .connect(&config.database_url)
        .await
        .unwrap();

    let db = DbPool::Sqlite(pool);
    run_migrations(&db).await.unwrap();

    let app_state = AppState::new(config, db);
    // 严格限制：每 60 秒最多 2 次请求
    let rate_limiter = RateLimiter::new(2, 60);

    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(app_state))
            .app_data(web::Data::new(rate_limiter))
            .configure(configure_app),
    )
    .await;

    // 第 1 次
    let req1 = TestRequest::post()
        .uri("/api/v1/auth/login")
        .set_json(serde_json::json!({
            "username": "user1",
            "password": "Password-123456"
        }))
        .to_request();
    let resp1 = test::call_service(&app, req1).await;
    assert_ne!(resp1.status(), StatusCode::TOO_MANY_REQUESTS);

    // 第 2 次
    let req2 = TestRequest::post()
        .uri("/api/v1/auth/login")
        .set_json(serde_json::json!({
            "username": "user1",
            "password": "Password-123456"
        }))
        .to_request();
    let resp2 = test::call_service(&app, req2).await;
    assert_ne!(resp2.status(), StatusCode::TOO_MANY_REQUESTS);

    // 第 3 次 (超出阈值 2) -> 必须返回 429 与 Retry-After 头
    let req3 = TestRequest::post()
        .uri("/api/v1/auth/login")
        .set_json(serde_json::json!({
            "username": "user1",
            "password": "Password-123456"
        }))
        .to_request();
    let resp3 = test::call_service(&app, req3).await;
    assert_eq!(resp3.status(), StatusCode::TOO_MANY_REQUESTS);

    assert!(resp3.headers().contains_key("Retry-After"));
    let body: serde_json::Value = test::read_body_json(resp3).await;
    assert_eq!(body["error"]["code"], "RATE_LIMITED");
}
