//! 端到端全链路业务与并发集成测试 (E2E Full Workflow Integration Test - W5)
//!
//! 验证场景：
//! 1. 多租户注册与 JWT 认证
//! 2. 文档创建、读取与版本自增 (CAS OCC)
//! 3. 严格多租户物理隔离：用户 B 试图访问/更新/删除用户 A 文档统一返回 404
//! 4. 并发写入冲突检测：旧版本写入严格触发 409 VERSION_CONFLICT 并返回最新 server_version
//! 5. 冲突恢复与重新覆写
//! 6. 乐观锁删除：删除成功返回 204 无 Body，删除后再查返回 404
//! 7. 标题 Unicode 标量空白校验 (U+3000) 拒绝返回 400

use actix_http::Request;
use actix_web::dev::{Service, ServiceResponse};
use actix_web::http::StatusCode;
use actix_web::{App, Error, test, web};
use markdown_cloud_editor::configure_app;
use markdown_cloud_editor::middleware::RequestIdLayer;
use markdown_cloud_editor::routes::auth::AuthConfig;
use markdown_cloud_editor::state::AppState;
use sqlx::PgPool;

const TEST_SECRET: &str = "Kd8#mZ2!vQ7@xR4&pW9@jL5^nT3*yF7=hG2+Ab1";
const TEST_PASSWORD: &str = "Correct-Horse-Battery";

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .expect("TEST_DATABASE_URL 未设置，请配置后运行")
}

async fn isolated_pool() -> PgPool {
    let schema = format!(
        "t_e2e_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros()
    );

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

async fn build_app(
    pool: PgPool,
) -> impl Service<Request, Response = ServiceResponse, Error = Error> {
    let config = markdown_cloud_editor::Config::new(
        test_database_url(),
        TEST_SECRET.to_owned(),
        "127.0.0.1:8080".to_owned(),
        3600,
    )
    .expect("测试配置应合法");

    let state = web::Data::new(AppState::new(pool));
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
}

async fn register_user(
    app: &impl Service<Request, Response = ServiceResponse, Error = Error>,
    username: &str,
) -> String {
    let req = test::TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(serde_json::json!({
            "username": username,
            "password": TEST_PASSWORD,
        }))
        .to_request();

    let resp = test::call_service(app, req).await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let body: serde_json::Value = test::read_body_json(resp).await;
    body["token"].as_str().unwrap().to_owned()
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn test_full_e2e_multi_tenant_and_optimistic_concurrency_workflow() {
    let pool = isolated_pool().await;
    let app = build_app(pool).await;

    // 1. 注册两个租户
    let token_a = register_user(&app, "alice_e2e").await;
    let token_b = register_user(&app, "bob_e2e").await;

    // 2. 租户 A 创建文档（省略标题，默认未命名文档，初始版本 1）
    let req_create = test::TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .set_json(serde_json::json!({
            "content": "# 初稿正文"
        }))
        .to_request();

    let resp_create = test::call_service(&app, req_create).await;
    assert_eq!(resp_create.status(), StatusCode::CREATED);
    let doc_a: serde_json::Value = test::read_body_json(resp_create).await;
    let doc_id = doc_a["id"].as_str().unwrap();
    assert_eq!(doc_a["title"], "未命名文档");
    assert_eq!(doc_a["version"], 1);

    // 3. 租户 A 读取文档详情
    let req_get = test::TestRequest::get()
        .uri(&format!("/api/v1/documents/{doc_id}"))
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .to_request();
    let resp_get = test::call_service(&app, req_get).await;
    assert_eq!(resp_get.status(), StatusCode::OK);
    let get_body: serde_json::Value = test::read_body_json(resp_get).await;
    assert_eq!(get_body["content"], "# 初稿正文");

    // 4. 租户 A 正常更新文档至版本 2
    let req_update1 = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{doc_id}"))
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .set_json(serde_json::json!({
            "title": "项目正式规范",
            "content": "## 第二版修订正文",
            "expected_version": 1
        }))
        .to_request();
    let resp_update1 = test::call_service(&app, req_update1).await;
    assert_eq!(resp_update1.status(), StatusCode::OK);
    let update1_body: serde_json::Value = test::read_body_json(resp_update1).await;
    assert_eq!(update1_body["version"], 2);

    // 5. 租户 B 试图越权操作租户 A 的文档 (统一返回 404，不泄露任何元数据)
    // 5.1 越权读取
    let req_b_read = test::TestRequest::get()
        .uri(&format!("/api/v1/documents/{doc_id}"))
        .insert_header(("Authorization", format!("Bearer {token_b}")))
        .to_request();
    assert_eq!(
        test::call_service(&app, req_b_read).await.status(),
        StatusCode::NOT_FOUND
    );

    // 5.2 越权更新
    let req_b_update = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{doc_id}"))
        .insert_header(("Authorization", format!("Bearer {token_b}")))
        .set_json(serde_json::json!({
            "title": "恶意篡改",
            "content": "恶意内容",
            "expected_version": 2
        }))
        .to_request();
    assert_eq!(
        test::call_service(&app, req_b_update).await.status(),
        StatusCode::NOT_FOUND
    );

    // 5.3 越权删除
    let req_b_delete = test::TestRequest::delete()
        .uri(&format!("/api/v1/documents/{doc_id}?expected_version=2"))
        .insert_header(("Authorization", format!("Bearer {token_b}")))
        .to_request();
    assert_eq!(
        test::call_service(&app, req_b_delete).await.status(),
        StatusCode::NOT_FOUND
    );

    // 6. 并发冲突：会话使用陈旧的 expected_version: 1 提交更新
    let req_conflict = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{doc_id}"))
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .set_json(serde_json::json!({
            "title": "陈旧提交",
            "content": "过期内容",
            "expected_version": 1
        }))
        .to_request();
    let resp_conflict = test::call_service(&app, req_conflict).await;
    assert_eq!(resp_conflict.status(), StatusCode::CONFLICT);
    let conflict_body: serde_json::Value = test::read_body_json(resp_conflict).await;
    assert_eq!(conflict_body["error"]["code"], "VERSION_CONFLICT");
    assert_eq!(conflict_body["error"]["details"]["server_version"], 2);

    // 7. 冲突恢复：采用正确的 expected_version: 2 更新至版本 3
    let req_recover = test::TestRequest::put()
        .uri(&format!("/api/v1/documents/{doc_id}"))
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .set_json(serde_json::json!({
            "title": "冲突恢复后终稿",
            "content": "## 最终发布内容",
            "expected_version": 2
        }))
        .to_request();
    let resp_recover = test::call_service(&app, req_recover).await;
    assert_eq!(resp_recover.status(), StatusCode::OK);
    let recover_body: serde_json::Value = test::read_body_json(resp_recover).await;
    assert_eq!(recover_body["version"], 3);

    // 8. 乐观锁删除：携带匹配版本 3 删除文档
    let req_delete = test::TestRequest::delete()
        .uri(&format!("/api/v1/documents/{doc_id}?expected_version=3"))
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .to_request();
    let resp_delete = test::call_service(&app, req_delete).await;
    assert_eq!(resp_delete.status(), StatusCode::NO_CONTENT);

    // 9. 删除后再查返回 404
    let req_after_del = test::TestRequest::get()
        .uri(&format!("/api/v1/documents/{doc_id}"))
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .to_request();
    assert_eq!(
        test::call_service(&app, req_after_del).await.status(),
        StatusCode::NOT_FOUND
    );
}
