//! Gemini 3.8 Flash AI Copilot 接口集成测试

mod common;

use actix_web::http::StatusCode;
use actix_web::test::{self, TestRequest};
use common::{register_and_get_token, setup_test_app};

#[actix_rt::test]
async fn test_ai_complete_endpoint() {
    let app = setup_test_app().await;
    let (token, _) = register_and_get_token(&app, "gemini_copilot_user", "Secure-Password-1").await;

    let req = TestRequest::post()
        .uri("/api/v1/ai/complete")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "prompt": "## 系统架构设计\n本项目采用六层解耦",
            "max_tokens": 256
        }))
        .to_request();

    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body: serde_json::Value = test::read_body_json(resp).await;
    assert!(!body["result"].as_str().unwrap().is_empty());
    assert!(body["model"].is_string());
}

#[actix_rt::test]
async fn test_ai_polish_endpoint() {
    let app = setup_test_app().await;
    let (token, _) = register_and_get_token(&app, "polish_user", "Secure-Password-1").await;

    let req = TestRequest::post()
        .uri("/api/v1/ai/polish")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "content": "这代码写的很好，非常快，没有bug",
            "instruction": "学术严谨风格"
        }))
        .to_request();

    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body: serde_json::Value = test::read_body_json(resp).await;
    assert!(body["result"].as_str().unwrap().contains("润色"));
}

#[actix_rt::test]
async fn test_ai_summarize_endpoint() {
    let app = setup_test_app().await;
    let (token, _) = register_and_get_token(&app, "summary_user", "Secure-Password-1").await;

    let req = TestRequest::post()
        .uri("/api/v1/ai/summarize")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "content": "# 项目概览\n本项目实现了高性能 Web Markdown 编辑器，支持离线草稿恢复与云端实时同步。",
            "format": "bullet_points"
        }))
        .to_request();

    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body: serde_json::Value = test::read_body_json(resp).await;
    assert!(body["result"].as_str().unwrap().contains("摘要"));
}

#[actix_rt::test]
async fn test_ai_diagram_generation() {
    let app = setup_test_app().await;
    let (token, _) = register_and_get_token(&app, "diagram_user", "Secure-Password-1").await;

    let req = TestRequest::post()
        .uri("/api/v1/ai/diagram")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "description": "用户请求经过路由到达服务层，随后访问数据库",
            "diagram_type": "flowchart"
        }))
        .to_request();

    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body: serde_json::Value = test::read_body_json(resp).await;
    let text = body["result"].as_str().unwrap();
    assert!(text.contains("```mermaid"));
}

#[actix_rt::test]
async fn test_ai_math_generation() {
    let app = setup_test_app().await;
    let (token, _) = register_and_get_token(&app, "math_user", "Secure-Password-1").await;

    let req = TestRequest::post()
        .uri("/api/v1/ai/math")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "description": "交叉熵损失函数加上 L2 正则化"
        }))
        .to_request();

    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body: serde_json::Value = test::read_body_json(resp).await;
    let text = body["result"].as_str().unwrap();
    assert!(text.contains("$$"));
}

#[actix_rt::test]
async fn test_ai_chat_with_document_context() {
    let app = setup_test_app().await;
    let (token, _) = register_and_get_token(&app, "chat_user", "Secure-Password-1").await;

    let req = TestRequest::post()
        .uri("/api/v1/ai/chat")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(serde_json::json!({
            "message": "请问当前文档的主要内容是什么？",
            "document_context": "# 分布式系统设计\n本文讨论 Raft 共识机制与状态机复制。"
        }))
        .to_request();

    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body: serde_json::Value = test::read_body_json(resp).await;
    assert!(
        body["result"]
            .as_str()
            .unwrap()
            .contains("Gemini 3.8 Flash")
    );
}
