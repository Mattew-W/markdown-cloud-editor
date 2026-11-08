//! 认证模块集成测试 (对齐 API 规范 §03 与 §04)

mod common;

use actix_web::http::StatusCode;
use actix_web::test::{self, TestRequest};
use common::setup_test_app;

#[actix_rt::test]
async fn test_register_and_login_success() {
    let app = setup_test_app().await;

    // 1. 注册成功
    let req = TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(serde_json::json!({
            "username": "gemini_user",
            "password": "Password-123456"
        }))
        .to_request();

    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::CREATED);

    let body: serde_json::Value = test::read_body_json(resp).await;
    assert!(body["token"].is_string());
    assert_eq!(body["expires_in"], 3600);
    assert_eq!(body["user"]["username"], "gemini_user");

    // 2. 正常登录成功
    let login_req = TestRequest::post()
        .uri("/api/v1/auth/login")
        .set_json(serde_json::json!({
            "username": "gemini_user",
            "password": "Password-123456"
        }))
        .to_request();

    let login_resp = test::call_service(&app, login_req).await;
    assert_eq!(login_resp.status(), StatusCode::OK);

    let login_body: serde_json::Value = test::read_body_json(login_resp).await;
    assert!(login_body["token"].is_string());
}

#[actix_rt::test]
async fn test_register_duplicate_username_fails_with_409() {
    let app = setup_test_app().await;

    let payload = serde_json::json!({
        "username": "duplicate_user",
        "password": "Password-123456"
    });

    let req1 = TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(&payload)
        .to_request();
    let resp1 = test::call_service(&app, req1).await;
    assert_eq!(resp1.status(), StatusCode::CREATED);

    let req2 = TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(&payload)
        .to_request();
    let resp2 = test::call_service(&app, req2).await;
    assert_eq!(resp2.status(), StatusCode::CONFLICT);

    let body: serde_json::Value = test::read_body_json(resp2).await;
    assert_eq!(body["error"]["code"], "USERNAME_TAKEN");
}

#[actix_rt::test]
async fn test_password_length_validation_rules() {
    let app = setup_test_app().await;

    // 密码不足 12 字节 -> 400
    let req_short = TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(serde_json::json!({
            "username": "short_pwd_user",
            "password": "short"
        }))
        .to_request();
    let resp_short = test::call_service(&app, req_short).await;
    assert_eq!(resp_short.status(), StatusCode::BAD_REQUEST);

    // 8 个中文字符 (24 字节) >= 12 字节 -> 合法通过
    let req_chinese = TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(serde_json::json!({
            "username": "chinese_pwd_user",
            "password": "八个中文字符密码"
        }))
        .to_request();
    let resp_chinese = test::call_service(&app, req_chinese).await;
    assert_eq!(resp_chinese.status(), StatusCode::CREATED);
}

#[actix_rt::test]
async fn test_login_failure_returns_identical_401() {
    let app = setup_test_app().await;

    // 1. 用户不存在 -> 401
    let req_nonexist = TestRequest::post()
        .uri("/api/v1/auth/login")
        .set_json(serde_json::json!({
            "username": "non_existent_user",
            "password": "Password-123456"
        }))
        .to_request();
    let resp_nonexist = test::call_service(&app, req_nonexist).await;
    assert_eq!(resp_nonexist.status(), StatusCode::UNAUTHORIZED);

    // 2. 先注册用户
    let reg_req = TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(serde_json::json!({
            "username": "registered_user",
            "password": "Correct-Password-1"
        }))
        .to_request();
    assert_eq!(
        test::call_service(&app, reg_req).await.status(),
        StatusCode::CREATED
    );

    // 3. 密码错误 -> 401 (且响应体与不存在时完全一致)
    let req_wrong_pwd = TestRequest::post()
        .uri("/api/v1/auth/login")
        .set_json(serde_json::json!({
            "username": "registered_user",
            "password": "Wrong-Password-12"
        }))
        .to_request();
    let resp_wrong_pwd = test::call_service(&app, req_wrong_pwd).await;
    assert_eq!(resp_wrong_pwd.status(), StatusCode::UNAUTHORIZED);

    let body_nonexist: serde_json::Value = test::read_body_json(resp_nonexist).await;
    let body_wrong: serde_json::Value = test::read_body_json(resp_wrong_pwd).await;
    assert_eq!(body_nonexist["error"]["code"], "UNAUTHORIZED");
    assert_eq!(body_wrong["error"]["code"], "UNAUTHORIZED");
}

#[actix_rt::test]
async fn test_jwt_tampered_or_invalid_signature_returns_401() {
    let app = setup_test_app().await;

    // 1. 尝试伪造秘钥签发的 Token
    let fake_token = gemini_markdown_cloud_editor::auth::token::create_token(
        uuid::Uuid::new_v4(),
        "hacker",
        "wrong_fake_secret_key_that_does_not_match_app_32_bytes",
        3600,
    )
    .unwrap();

    let req = TestRequest::get()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {fake_token}")))
        .to_request();

    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[actix_rt::test]
async fn test_jwt_expired_token_returns_401() {
    let app = setup_test_app().await;

    // 2. 签发一个在过去已过期的 Token (ttl = -100)
    let expired_token = gemini_markdown_cloud_editor::auth::token::create_token(
        uuid::Uuid::new_v4(),
        "expired_user",
        "test_jwt_secret_must_be_at_least_32_bytes_long_high_entropy",
        -100,
    )
    .unwrap();

    let req = TestRequest::get()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {expired_token}")))
        .to_request();

    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[test]
fn test_config_jwt_secret_validation() {
    use gemini_markdown_cloud_editor::{Config, ConfigError};

    // 缺少或空串 JWT_SECRET -> MissingEnv
    let err_empty = Config::validate_jwt_secret("").unwrap_err();
    assert!(matches!(err_empty, ConfigError::MissingEnv(v) if v == "JWT_SECRET"));

    let err_spaces = Config::validate_jwt_secret("   ").unwrap_err();
    assert!(matches!(err_spaces, ConfigError::MissingEnv(v) if v == "JWT_SECRET"));

    // JWT_SECRET 长度不足 32 字节 -> WeakJwtSecret
    let err_weak = Config::validate_jwt_secret("too_short_secret").unwrap_err();
    assert!(matches!(err_weak, ConfigError::WeakJwtSecret(len) if len == 16));

    // JWT_SECRET >= 32 字节 -> 校验通过
    let valid_secret = "this_is_a_very_secure_and_long_jwt_secret_32_bytes";
    assert!(Config::validate_jwt_secret(valid_secret).is_ok());
}
