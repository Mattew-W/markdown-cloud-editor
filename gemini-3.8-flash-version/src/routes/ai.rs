//! Gemini 3.8 Flash AI Copilot 路由 (/api/v1/ai)

use crate::auth::AuthenticatedUser;
use crate::dto::{
    AiChatRequest, AiCompleteRequest, AiDiagramRequest, AiMathRequest, AiPolishRequest,
    AiSummarizeRequest,
};
use crate::error::AppError;
use crate::services::GeminiService;
use crate::state::AppState;
use actix_web::{HttpResponse, post, web};

/// POST /api/v1/ai/complete (续写补全)
#[post("/complete")]
pub async fn complete(
    state: web::Data<AppState>,
    _user: AuthenticatedUser,
    payload: web::Json<AiCompleteRequest>,
) -> Result<HttpResponse, AppError> {
    let resp = GeminiService::complete(&state, payload.into_inner()).await?;
    Ok(HttpResponse::Ok().json(resp))
}

/// POST /api/v1/ai/polish (Markdown 润色修复)
#[post("/polish")]
pub async fn polish(
    state: web::Data<AppState>,
    _user: AuthenticatedUser,
    payload: web::Json<AiPolishRequest>,
) -> Result<HttpResponse, AppError> {
    let resp = GeminiService::polish(&state, payload.into_inner()).await?;
    Ok(HttpResponse::Ok().json(resp))
}

/// POST /api/v1/ai/summarize (提取摘要)
#[post("/summarize")]
pub async fn summarize(
    state: web::Data<AppState>,
    _user: AuthenticatedUser,
    payload: web::Json<AiSummarizeRequest>,
) -> Result<HttpResponse, AppError> {
    let resp = GeminiService::summarize(&state, payload.into_inner()).await?;
    Ok(HttpResponse::Ok().json(resp))
}

/// POST /api/v1/ai/diagram (Mermaid 图表推导)
#[post("/diagram")]
pub async fn diagram(
    state: web::Data<AppState>,
    _user: AuthenticatedUser,
    payload: web::Json<AiDiagramRequest>,
) -> Result<HttpResponse, AppError> {
    let resp = GeminiService::generate_diagram(&state, payload.into_inner()).await?;
    Ok(HttpResponse::Ok().json(resp))
}

/// POST /api/v1/ai/math (KaTeX 公式构建)
#[post("/math")]
pub async fn math(
    state: web::Data<AppState>,
    _user: AuthenticatedUser,
    payload: web::Json<AiMathRequest>,
) -> Result<HttpResponse, AppError> {
    let resp = GeminiService::generate_math(&state, payload.into_inner()).await?;
    Ok(HttpResponse::Ok().json(resp))
}

/// POST /api/v1/ai/chat (基于文档上下文智能对话)
#[post("/chat")]
pub async fn chat(
    state: web::Data<AppState>,
    _user: AuthenticatedUser,
    payload: web::Json<AiChatRequest>,
) -> Result<HttpResponse, AppError> {
    let resp = GeminiService::chat(&state, payload.into_inner()).await?;
    Ok(HttpResponse::Ok().json(resp))
}
