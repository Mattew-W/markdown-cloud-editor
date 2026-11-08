//! 文档模块集成测试 (乐观锁、多租户隔离与边界约束)

mod common;

use actix_web::http::StatusCode;
use actix_web::test::{self, TestRequest};
use common::{register_and_get_token, setup_test_app};

#[actix_rt::test]
async fn test_create_and_get_document() {
    let app = setup_test_app().await;
    let (token, _) = register_and_get_token(&app, "alice_doc", "Secure-Password-1").await;

    // 1. 创建文档 (省略标题默认为 "未命名文档", version = 1)
    let create_req = TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "content": "# Hello Gemini 3.8 Flash"
        }))
        .to_request();

    let create_resp = test::call_service(&app, create_req).await;
    assert_eq!(create_resp.status(), StatusCode::CREATED);

    let doc: serde_json::Value = test::read_body_json(create_resp).await;
    assert_eq!(doc["title"], "未命名文档");
    assert_eq!(doc["version"], 1);
    let doc_id = doc["id"].as_str().unwrap();

    // 2. 读取单篇文档 (含正文)
    let get_req = TestRequest::get()
        .uri(&format!("/api/v1/documents/{doc_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();

    let get_resp = test::call_service(&app, get_req).await;
    assert_eq!(get_resp.status(), StatusCode::OK);

    let get_doc: serde_json::Value = test::read_body_json(get_resp).await;
    assert_eq!(get_doc["content"], "# Hello Gemini 3.8 Flash");
}

#[actix_rt::test]
async fn test_unicode_whitespace_title_rejected() {
    let app = setup_test_app().await;
    let (token, _) = register_and_get_token(&app, "title_user", "Secure-Password-1").await;

    // 全角空格 U+3000 -> 必须被拒绝为 400
    let req_fullwidth = TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "\u{3000}\u{3000}",
            "content": "测试"
        }))
        .to_request();

    let resp_fullwidth = test::call_service(&app, req_fullwidth).await;
    assert_eq!(resp_fullwidth.status(), StatusCode::BAD_REQUEST);

    // 显式空字符串 -> 400
    let req_empty = TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "   ",
            "content": "测试"
        }))
        .to_request();

    let resp_empty = test::call_service(&app, req_empty).await;
    assert_eq!(resp_empty.status(), StatusCode::BAD_REQUEST);
}

#[actix_rt::test]
async fn test_optimistic_locking_prevents_lost_updates() {
    let app = setup_test_app().await;
    let (token, _) = register_and_get_token(&app, "bob_lock", "Secure-Password-1").await;

    // 创建文档 (version = 1)
    let create_req = TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "并发测试文档",
            "content": "初始内容"
        }))
        .to_request();

    let doc: serde_json::Value = test::call_and_read_body_json(&app, create_req).await;
    let doc_id = doc["id"].as_str().unwrap();

    // 第一次更新 (expected_version = 1) -> 成功，版本变为 2
    let update_req1 = TestRequest::put()
        .uri(&format!("/api/v1/documents/{doc_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "已更新标题",
            "content": "会话A修改的内容",
            "expected_version": 1
        }))
        .to_request();

    let resp1 = test::call_service(&app, update_req1).await;
    assert_eq!(resp1.status(), StatusCode::OK);
    let update1_body: serde_json::Value = test::read_body_json(resp1).await;
    assert_eq!(update1_body["version"], 2);

    // 第二次更新仍带过期版本 (expected_version = 1) -> 必须触发 409 VERSION_CONFLICT 并返回当前服务端版本
    let update_req2 = TestRequest::put()
        .uri(&format!("/api/v1/documents/{doc_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "并发冲突标题",
            "content": "会话B迟到的覆写内容",
            "expected_version": 1
        }))
        .to_request();

    let resp2 = test::call_service(&app, update_req2).await;
    assert_eq!(resp2.status(), StatusCode::CONFLICT);

    let conflict_body: serde_json::Value = test::read_body_json(resp2).await;
    assert_eq!(conflict_body["error"]["code"], "VERSION_CONFLICT");
    assert_eq!(conflict_body["error"]["details"]["server_version"], 2);
}

#[actix_rt::test]
async fn test_tenant_isolation_unauthorized_returns_404() {
    let app = setup_test_app().await;
    let (token_alice, _) = register_and_get_token(&app, "alice_iso", "Secure-Password-1").await;
    let (token_bob, _) = register_and_get_token(&app, "bob_iso", "Secure-Password-1").await;

    // Alice 创建私有文档
    let create_req = TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token_alice}")))
        .set_json(serde_json::json!({
            "title": "Alice的机密文档",
            "content": "内部机密"
        }))
        .to_request();

    let doc: serde_json::Value = test::call_and_read_body_json(&app, create_req).await;
    let doc_id = doc["id"].as_str().unwrap();

    // Bob 试图读取 Alice 的文档 -> 严格统一返回 404，不泄露任何元数据
    let get_req = TestRequest::get()
        .uri(&format!("/api/v1/documents/{doc_id}"))
        .insert_header(("Authorization", format!("Bearer {token_bob}")))
        .to_request();

    let get_resp = test::call_service(&app, get_req).await;
    assert_eq!(get_resp.status(), StatusCode::NOT_FOUND);

    // Bob 试图更新 Alice 的文档 -> 404
    let put_req = TestRequest::put()
        .uri(&format!("/api/v1/documents/{doc_id}"))
        .insert_header(("Authorization", format!("Bearer {token_bob}")))
        .set_json(serde_json::json!({
            "title": "篡改尝试",
            "content": "恶意修改",
            "expected_version": 1
        }))
        .to_request();

    let put_resp = test::call_service(&app, put_req).await;
    assert_eq!(put_resp.status(), StatusCode::NOT_FOUND);
}

#[actix_rt::test]
async fn test_payload_too_large_boundary() {
    let app = setup_test_app().await;
    let (token, _) = register_and_get_token(&app, "payload_user", "Secure-Password-1").await;

    // 构造刚好超过 262144 字节 (256KiB) 的内容
    let big_content = "A".repeat(262145);

    let req = TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "超大正文测试",
            "content": big_content
        }))
        .to_request();

    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert_eq!(body["error"]["code"], "PAYLOAD_TOO_LARGE");
}

#[actix_rt::test]
async fn test_delete_document_with_optimistic_locking() {
    let app = setup_test_app().await;
    let (token, _) = register_and_get_token(&app, "delete_user", "Secure-Password-1").await;

    let create_req = TestRequest::post()
        .uri("/api/v1/documents")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "title": "待删除文档"
        }))
        .to_request();

    let doc: serde_json::Value = test::call_and_read_body_json(&app, create_req).await;
    let doc_id = doc["id"].as_str().unwrap();

    // 错误版本删除 -> 409
    let delete_req_fail = TestRequest::delete()
        .uri(&format!("/api/v1/documents/{doc_id}?expected_version=999"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp_fail = test::call_service(&app, delete_req_fail).await;
    assert_eq!(resp_fail.status(), StatusCode::CONFLICT);

    // 正确版本删除 -> 204
    let delete_req_ok = TestRequest::delete()
        .uri(&format!("/api/v1/documents/{doc_id}?expected_version=1"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let resp_ok = test::call_service(&app, delete_req_ok).await;
    assert_eq!(resp_ok.status(), StatusCode::NO_CONTENT);

    // 删除后再读取 -> 404
    let get_req = TestRequest::get()
        .uri(&format!("/api/v1/documents/{doc_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .to_request();
    let get_resp = test::call_service(&app, get_req).await;
    assert_eq!(get_resp.status(), StatusCode::NOT_FOUND);
}
