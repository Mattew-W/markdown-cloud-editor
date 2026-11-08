//! 测试辅助通用模块

use actix_web::dev::ServiceResponse;
use actix_web::test::{self, TestRequest};
use actix_web::{App, web};
use gemini_markdown_cloud_editor::middleware::RateLimiter;
use gemini_markdown_cloud_editor::{AppState, Config, DbPool, configure_app, run_migrations};
use sqlx::sqlite::SqlitePoolOptions;

/// 初始化全功能测试应用 (采用独立 SQLite 内存库，完全隔离)
#[allow(dead_code)]
pub async fn setup_test_app() -> impl actix_web::dev::Service<
    actix_http::Request,
    Response = ServiceResponse,
    Error = actix_web::Error,
> {
    // 使用随机独立内存 SQLite 数据库，各用例完全并行隔离
    let db_url = "sqlite::memory:?cache=shared".to_string();
    let config = Config::for_test(db_url);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&config.database_url)
        .await
        .expect("Failed to connect to in-memory SQLite");

    let db = DbPool::Sqlite(pool);
    run_migrations(&db).await.expect("Failed to run migrations");

    let app_state = AppState::new(config, db);
    let rate_limiter = RateLimiter::new(100, 60); // 测试中放宽限流避免干扰业务用例

    test::init_service(
        App::new()
            .app_data(web::Data::new(app_state))
            .app_data(web::Data::new(rate_limiter))
            .configure(configure_app),
    )
    .await
}

/// 辅助注册用户并获取 JWT token
#[allow(dead_code)]
pub async fn register_and_get_token(
    app: &impl actix_web::dev::Service<
        actix_http::Request,
        Response = ServiceResponse,
        Error = actix_web::Error,
    >,
    username: &str,
    password: &str,
) -> (String, String) {
    let req = TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(serde_json::json!({
            "username": username,
            "password": password
        }))
        .to_request();

    let resp: serde_json::Value = test::call_and_read_body_json(app, req).await;
    let token = resp["token"].as_str().unwrap().to_string();
    let user_id = resp["user"]["id"].as_str().unwrap().to_string();
    (token, user_id)
}

/// 初始化针对 PostgreSQL 生产环境的测试应用 (采用动态独立 Schema 保证并行隔离)
#[allow(dead_code)]
pub async fn setup_postgres_test_app(
    schema: &str,
) -> (
    impl actix_web::dev::Service<
        actix_http::Request,
        Response = ServiceResponse,
        Error = actix_web::Error,
    >,
    sqlx::PgPool,
    String,
) {
    let base_url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| "postgresql://postgres:postgres@127.0.0.1:5432/mce_test".to_string());

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .after_connect({
            let schema = schema.to_string();
            move |conn, _meta| {
                let set = format!("SET search_path TO {schema}, public");
                Box::pin(async move {
                    sqlx::query(&set).execute(conn).await?;
                    Ok(())
                })
            }
        })
        .connect(&base_url)
        .await
        .expect("Failed to connect to PostgreSQL");

    // 创建独立测试 Schema
    sqlx::query(&format!("CREATE SCHEMA IF NOT EXISTS {schema}"))
        .execute(&pool)
        .await
        .expect("Failed to create isolated schema");

    let db = DbPool::Postgres(pool.clone());
    run_migrations(&db).await.expect("Failed to run postgres migrations");

    let config = Config::for_test(base_url.clone());
    let app_state = AppState::new(config, db);
    let rate_limiter = RateLimiter::new(100, 60);

    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(app_state))
            .app_data(web::Data::new(rate_limiter))
            .configure(configure_app),
    )
    .await;

    (app, pool, base_url)
}
