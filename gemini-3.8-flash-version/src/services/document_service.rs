//! 文档业务层 (严格对齐 API 规范 §03、§04 与 §05，无冗余 revisions)

use crate::dto::{
    CreateDocumentRequest, DocumentListQuery, DocumentListResponse, DocumentResponse,
    DocumentSummaryResponse, UpdateDocumentRequest, UpdateDocumentResponse,
};
use crate::error::AppError;
use crate::repositories::{DeleteResult, DocumentRepo, UpdateResult};
use crate::state::AppState;
use uuid::Uuid;

/// 最大内容字节限制 256 KiB
pub const MAX_CONTENT_BYTES: usize = 262144;
/// 默认标题
pub const DEFAULT_TITLE: &str = "未命名文档";

/// 文档服务
pub struct DocumentService;

impl DocumentService {
    /// 校验并归一化标题 (Unicode 标量值计数 1..=255)
    pub fn validate_title(title: &str) -> Result<String, AppError> {
        let trimmed = title.trim();
        let char_count = trimmed.chars().count();
        if char_count == 0 {
            return Err(AppError::BadRequest(
                "Document title cannot be empty".to_string(),
            ));
        }
        if char_count > 255 {
            return Err(AppError::BadRequest(format!(
                "Document title exceeds 255 characters (got {char_count})"
            )));
        }
        Ok(trimmed.to_string())
    }

    /// 校验内容载荷大小 (字节数 <= 262144)
    pub fn validate_content(content: &str) -> Result<(), AppError> {
        if content.len() > MAX_CONTENT_BYTES {
            return Err(AppError::PayloadTooLarge);
        }
        Ok(())
    }

    /// 创建文档 (version = 1)
    pub async fn create_document(
        state: &AppState,
        owner_id: Uuid,
        req: CreateDocumentRequest,
    ) -> Result<DocumentResponse, AppError> {
        let title = match req.title {
            Some(t) => Self::validate_title(&t)?,
            None => DEFAULT_TITLE.to_string(),
        };

        let content = req.content.unwrap_or_default();
        Self::validate_content(&content)?;

        let doc_id = Uuid::new_v4();
        let doc =
            DocumentRepo::create_document(&state.db, doc_id, owner_id, &title, &content).await?;

        Ok(DocumentResponse {
            id: doc.id,
            title: doc.title,
            content: doc.content,
            version: doc.version,
            created_at: doc.created_at,
            updated_at: doc.updated_at,
        })
    }

    /// 查询单篇文档
    pub async fn get_document(
        state: &AppState,
        owner_id: Uuid,
        doc_id: Uuid,
    ) -> Result<DocumentResponse, AppError> {
        let doc = DocumentRepo::find_by_id_and_owner(&state.db, doc_id, owner_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Document not found".to_string()))?;

        Ok(DocumentResponse {
            id: doc.id,
            title: doc.title,
            content: doc.content,
            version: doc.version,
            created_at: doc.created_at,
            updated_at: doc.updated_at,
        })
    }

    /// 分页列出所有者文档
    pub async fn list_documents(
        state: &AppState,
        owner_id: Uuid,
        query: DocumentListQuery,
    ) -> Result<DocumentListResponse, AppError> {
        let limit = query.limit.unwrap_or(20);
        let offset = query.offset.unwrap_or(0);

        if !(1..=100).contains(&limit) {
            return Err(AppError::BadRequest(
                "Limit must be between 1 and 100".to_string(),
            ));
        }
        if offset < 0 {
            return Err(AppError::BadRequest(
                "Offset must be non-negative".to_string(),
            ));
        }

        let (items, total) =
            DocumentRepo::list_documents(&state.db, owner_id, limit, offset).await?;

        let summaries = items
            .into_iter()
            .map(|d| DocumentSummaryResponse {
                id: d.id,
                title: d.title,
                version: d.version,
                created_at: d.created_at,
                updated_at: d.updated_at,
            })
            .collect();

        Ok(DocumentListResponse {
            documents: summaries,
            limit,
            offset,
            total,
        })
    }

    /// 更新文档 (带乐观并发控制)
    pub async fn update_document(
        state: &AppState,
        owner_id: Uuid,
        doc_id: Uuid,
        req: UpdateDocumentRequest,
    ) -> Result<UpdateDocumentResponse, AppError> {
        let title = Self::validate_title(&req.title)?;
        Self::validate_content(&req.content)?;

        if req.expected_version < 1 {
            return Err(AppError::BadRequest(
                "expected_version must be greater than or equal to 1".to_string(),
            ));
        }

        let result = DocumentRepo::update_document_atomic(
            &state.db,
            doc_id,
            owner_id,
            &title,
            &req.content,
            req.expected_version,
        )
        .await?;

        match result {
            UpdateResult::Success {
                new_version,
                updated_at,
            } => Ok(UpdateDocumentResponse {
                id: doc_id,
                version: new_version,
                updated_at,
            }),
            UpdateResult::NotFound => Err(AppError::NotFound("Document not found".to_string())),
            UpdateResult::Conflict { server_version } => {
                Err(AppError::VersionConflict(server_version))
            }
        }
    }

    /// 删除文档 (带乐观并发控制)
    pub async fn delete_document(
        state: &AppState,
        owner_id: Uuid,
        doc_id: Uuid,
        expected_version: i32,
    ) -> Result<(), AppError> {
        if expected_version < 1 {
            return Err(AppError::BadRequest(
                "expected_version must be greater than or equal to 1".to_string(),
            ));
        }

        let result =
            DocumentRepo::delete_document_atomic(&state.db, doc_id, owner_id, expected_version)
                .await?;

        match result {
            DeleteResult::Success => Ok(()),
            DeleteResult::NotFound => Err(AppError::NotFound("Document not found".to_string())),
            DeleteResult::Conflict { server_version } => {
                Err(AppError::VersionConflict(server_version))
            }
        }
    }
}
