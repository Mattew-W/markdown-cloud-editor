//! 文档路由 (/api/v1/documents) - 严格限定为规范规定的 5 个端点

use crate::auth::AuthenticatedUser;
use crate::dto::{
    CreateDocumentRequest, DeleteDocumentQuery, DocumentListQuery, UpdateDocumentRequest,
};
use crate::error::AppError;
use crate::services::DocumentService;
use crate::state::AppState;
use actix_web::{HttpResponse, delete, get, post, put, web};
use uuid::Uuid;

/// GET /api/v1/documents (分页列表，不含正文)
#[get("")]
pub async fn list_documents(
    state: web::Data<AppState>,
    user: AuthenticatedUser,
    query: web::Query<DocumentListQuery>,
) -> Result<HttpResponse, AppError> {
    let resp = DocumentService::list_documents(&state, user.user_id, query.into_inner()).await?;
    Ok(HttpResponse::Ok().json(resp))
}

/// POST /api/v1/documents (创建新文档，version = 1)
#[post("")]
pub async fn create_document(
    state: web::Data<AppState>,
    user: AuthenticatedUser,
    payload: web::Json<CreateDocumentRequest>,
) -> Result<HttpResponse, AppError> {
    let doc = DocumentService::create_document(&state, user.user_id, payload.into_inner()).await?;
    Ok(HttpResponse::Created().json(doc))
}

/// GET /api/v1/documents/{id} (查询单篇文档，含正文)
#[get("/{id}")]
pub async fn get_document(
    state: web::Data<AppState>,
    user: AuthenticatedUser,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let doc_id = Uuid::parse_str(&path.into_inner())
        .map_err(|_| AppError::BadRequest("Invalid document UUID format".to_string()))?;

    let doc = DocumentService::get_document(&state, user.user_id, doc_id).await?;
    Ok(HttpResponse::Ok().json(doc))
}

/// PUT /api/v1/documents/{id} (更新文档，带乐观锁)
#[put("/{id}")]
pub async fn update_document(
    state: web::Data<AppState>,
    user: AuthenticatedUser,
    path: web::Path<String>,
    payload: web::Json<UpdateDocumentRequest>,
) -> Result<HttpResponse, AppError> {
    let doc_id = Uuid::parse_str(&path.into_inner())
        .map_err(|_| AppError::BadRequest("Invalid document UUID format".to_string()))?;

    let resp = DocumentService::update_document(&state, user.user_id, doc_id, payload.into_inner())
        .await?;
    Ok(HttpResponse::Ok().json(resp))
}

/// DELETE /api/v1/documents/{id} (删除文档，带乐观锁，无响应体 204)
#[delete("/{id}")]
pub async fn delete_document(
    state: web::Data<AppState>,
    user: AuthenticatedUser,
    path: web::Path<String>,
    query: web::Query<DeleteDocumentQuery>,
) -> Result<HttpResponse, AppError> {
    let doc_id = Uuid::parse_str(&path.into_inner())
        .map_err(|_| AppError::BadRequest("Invalid document UUID format".to_string()))?;

    DocumentService::delete_document(&state, user.user_id, doc_id, query.expected_version).await?;
    Ok(HttpResponse::NoContent().finish())
}
