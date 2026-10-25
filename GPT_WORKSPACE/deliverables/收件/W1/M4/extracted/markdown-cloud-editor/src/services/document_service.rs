use chrono::{DateTime, Utc};
use uuid::Uuid;
use crate::dto::document::*;

/// 文档业务错误
#[derive(Debug, thiserror::Error)]
pub enum DocumentServiceError {
    /// 输入校验失败 -> 400
    #[error("输入参数无效")]
    Validation(#[from] ValidationError),

    /// 文档不存在或无权限 -> 404
    #[error("文档不存在")]
    NotFound,

    /// 版本冲突 -> 409
    #[error("文档版本冲突")]
    VersionConflict { server_version: i32 },

    /// 正文超限 -> 413
    #[error("请求内容过大")]
    PayloadTooLarge,

    /// 服务内部错误 -> 500
    #[error("服务内部错误")]
    Internal,
}

/// 文档仓库抽象接口（由 M1 用 SQLx 实现）
#[allow(async_fn_in_trait)]
pub trait DocumentRepository {
    /// 创建文档，返回完整文档记录
    async fn create(
        &self,
        owner_id: Uuid,
        title: &str,
        content: &str,
    ) -> Result<DocumentRecord, DocumentServiceError>;

    /// 根据ID和所有者查询文档
    async fn get_by_id(
        &self,
        id: Uuid,
        owner_id: Uuid,
    ) -> Result<Option<DocumentRecord>, DocumentServiceError>;

    /// 原子更新文档（乐观锁），成功返回新版本信息，版本不匹配返回 None
    async fn update(
        &self,
        id: Uuid,
        owner_id: Uuid,
        title: &str,
        content: &str,
        expected_version: i32,
    ) -> Result<Option<DocumentUpdateResult>, DocumentServiceError>;

    /// 原子删除文档（乐观锁）
    async fn delete(
        &self,
        id: Uuid,
        owner_id: Uuid,
        expected_version: i32,
    ) -> Result<DeleteOutcome, DocumentServiceError>;

    /// 分页查询所有者的文档列表，按 updated_at DESC、id DESC 排序
    async fn list(
        &self,
        owner_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<DocumentSummaryRecord>, i64), DocumentServiceError>;
}

/// 完整文档记录（对应数据库 model）
#[derive(Debug, Clone)]
pub struct DocumentRecord {
    pub id: Uuid,
    pub title: String,
    pub content: String,
    pub version: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 文档摘要记录（列表用，不含正文）
#[derive(Debug, Clone)]
pub struct DocumentSummaryRecord {
    pub id: Uuid,
    pub title: String,
    pub version: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 更新操作返回结果
#[derive(Debug, Clone)]
pub struct DocumentUpdateResult {
    pub version: i32,
    pub updated_at: DateTime<Utc>,
}

/// 删除操作结果枚举
#[derive(Debug, Clone, PartialEq)]
pub enum DeleteOutcome {
    Success,
    NotFound,
    VersionConflict { server_version: i32 },
}

/// 文档业务服务核心
pub struct DocumentService<R: DocumentRepository> {
    repository: R,
}

impl<R: DocumentRepository> DocumentService<R> {
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    /// 创建文档
    pub async fn create_document(
        &self,
        owner_id: Uuid,
        req: &CreateDocumentRequest,
    ) -> Result<DocumentResponse, DocumentServiceError> {
        let (title, content) = req.validate()?;
        let record = self.repository.create(owner_id, &title, &content).await?;

        Ok(DocumentResponse {
            id: record.id,
            title: record.title,
            content: record.content,
            version: record.version,
            created_at: record.created_at,
            updated_at: record.updated_at,
        })
    }

    /// 获取单篇文档
    pub async fn get_document(
        &self,
        id: Uuid,
        owner_id: Uuid,
    ) -> Result<DocumentResponse, DocumentServiceError> {
        let record = self.repository.get_by_id(id, owner_id).await?;

        match record {
            Some(doc) => Ok(DocumentResponse {
                id: doc.id,
                title: doc.title,
                content: doc.content,
                version: doc.version,
                created_at: doc.created_at,
                updated_at: doc.updated_at,
            }),
            None => Err(DocumentServiceError::NotFound),
        }
    }

    /// 更新文档（乐观锁并发控制）
    pub async fn update_document(
        &self,
        id: Uuid,
        owner_id: Uuid,
        req: &UpdateDocumentRequest,
    ) -> Result<DocumentUpdateConfirmResponse, DocumentServiceError> {
        req.validate()?;

        let result = self
            .repository
            .update(id, owner_id, &req.title, &req.content, req.expected_version)
            .await?;

        match result {
            Some(update_result) => Ok(DocumentUpdateConfirmResponse {
                id,
                version: update_result.version,
                updated_at: update_result.updated_at,
            }),
            None => {
                // 版本不匹配：先判断文档是否存在，再决定返回 404 还是 409
                let doc = self.repository.get_by_id(id, owner_id).await?;
                match doc {
                    None => Err(DocumentServiceError::NotFound),
                    Some(existing) => Err(DocumentServiceError::VersionConflict {
                        server_version: existing.version,
                    }),
                }
            }
        }
    }

    /// 删除文档（乐观锁）
    pub async fn delete_document(
        &self,
        id: Uuid,
        owner_id: Uuid,
        expected_version: i32,
    ) -> Result<(), DocumentServiceError> {
        if expected_version < 1 {
            return Err(DocumentServiceError::Validation(ValidationError::InvalidVersion));
        }

        let outcome = self.repository.delete(id, owner_id, expected_version).await?;

        match outcome {
            DeleteOutcome::Success => Ok(()),
            DeleteOutcome::NotFound => Err(DocumentServiceError::NotFound),
            DeleteOutcome::VersionConflict { server_version } => {
                Err(DocumentServiceError::VersionConflict { server_version })
            }
        }
    }

    /// 分页查询文档列表
    pub async fn list_documents(
        &self,
        owner_id: Uuid,
        query: &ListDocumentsQuery,
    ) -> Result<DocumentListResponse, DocumentServiceError> {
        let (limit, offset) = query.validate()?;
        let (records, total) = self.repository.list(owner_id, limit, offset).await?;

        let documents = records
            .into_iter()
            .map(|r| DocumentSummaryResponse {
                id: r.id,
                title: r.title,
                version: r.version,
                created_at: r.created_at,
                updated_at: r.updated_at,
            })
            .collect();

        Ok(DocumentListResponse {
            documents,
            limit,
            offset,
            total,
        })
    }
}

// 单元测试模块
#[cfg(test)]
mod tests {
    use super::*;
    use mockall::mock;
    use chrono::Utc;

    // 生成 Mock 仓库实现
    mock! {
        pub DocRepo {}
        impl DocumentRepository for DocRepo {
            async fn create(
                &self,
                owner_id: Uuid,
                title: &str,
                content: &str,
            ) -> Result<DocumentRecord, DocumentServiceError>;

            async fn get_by_id(
                &self,
                id: Uuid,
                owner_id: Uuid,
            ) -> Result<Option<DocumentRecord>, DocumentServiceError>;

            async fn update(
                &self,
                id: Uuid,
                owner_id: Uuid,
                title: &str,
                content: &str,
                expected_version: i32,
            ) -> Result<Option<DocumentUpdateResult>, DocumentServiceError>;

            async fn delete(
                &self,
                id: Uuid,
                owner_id: Uuid,
                expected_version: i32,
            ) -> Result<DeleteOutcome, DocumentServiceError>;

            async fn list(
                &self,
                owner_id: Uuid,
                limit: i64,
                offset: i64,
            ) -> Result<(Vec<DocumentSummaryRecord>, i64), DocumentServiceError>;
        }
    }

    // 辅助函数：生成测试用的文档记录
    fn mock_record(id: Uuid, version: i32) -> DocumentRecord {
        let now = Utc::now();
        DocumentRecord {
            id,
            title: "测试文档".to_string(),
            content: "# 测试内容".to_string(),
            version,
            created_at: now,
            updated_at: now,
        }
    }

    #[tokio::test]
    async fn create_document_uses_default_title() {
        let mut mock_repo = MockDocRepo::new();
        let owner_id = Uuid::new_v4();
        let doc_id = Uuid::new_v4();

        mock_repo
            .expect_create()
            .returning(move |_, title, _| {
                assert_eq!(title, "未命名文档");
                Ok(mock_record(doc_id, 1))
            });

        let service = DocumentService::new(mock_repo);
        let req = CreateDocumentRequest {
            title: None,
            content: None,
        };

        let result = service.create_document(owner_id, &req).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().version, 1);
    }

    #[tokio::test]
    async fn create_document_empty_title_returns_validation_error() {
        let mock_repo = MockDocRepo::new();
        let service = DocumentService::new(mock_repo);
        let req = CreateDocumentRequest {
            title: Some("   ".to_string()),
            content: None,
        };

        let result = service.create_document(Uuid::new_v4(), &req).await;
        assert!(matches!(
            result,
            Err(DocumentServiceError::Validation(ValidationError::TitleEmpty))
        ));
    }

    #[tokio::test]
    async fn update_document_version_mismatch_returns_conflict() {
        let mut mock_repo = MockDocRepo::new();
        let doc_id = Uuid::new_v4();
        let owner_id = Uuid::new_v4();

        // 更新失败（版本不对）
        mock_repo.expect_update().returning(|_, _, _, _, _| Ok(None));
        // 查询到现有版本为 3
        mock_repo
            .expect_get_by_id()
            .returning(move |_, _| Ok(Some(mock_record(doc_id, 3))));

        let service = DocumentService::new(mock_repo);
        let req = UpdateDocumentRequest {
            title: "新标题".to_string(),
            content: "新内容".to_string(),
            expected_version: 1,
        };

        let result = service.update_document(doc_id, owner_id, &req).await;
        match result {
            Err(DocumentServiceError::VersionConflict { server_version }) => {
                assert_eq!(server_version, 3);
            }
            _ => panic!("预期返回版本冲突错误"),
        }
    }

    #[tokio::test]
    async fn get_nonexistent_document_returns_not_found() {
        let mut mock_repo = MockDocRepo::new();
        mock_repo.expect_get_by_id().returning(|_, _| Ok(None));

        let service = DocumentService::new(mock_repo);
        let result = service.get_document(Uuid::new_v4(), Uuid::new_v4()).await;
        assert!(matches!(result, Err(DocumentServiceError::NotFound)));
    }

    #[tokio::test]
    async fn list_documents_uses_default_pagination() {
        let mut mock_repo = MockDocRepo::new();
        let owner_id = Uuid::new_v4();

        mock_repo
            .expect_list()
            .withf(move |_, limit, offset| *limit == 20 && *offset == 0)
            .returning(|_, _, _| Ok((vec![], 0)));

        let service = DocumentService::new(mock_repo);
        let query = ListDocumentsQuery {
            limit: None,
            offset: None,
        };

        let result = service.list_documents(owner_id, &query).await;
        assert!(result.is_ok());
        let resp = result.unwrap();
        assert_eq!(resp.limit, 20);
        assert_eq!(resp.offset, 0);
    }

    #[tokio::test]
    async fn content_exceeds_limit_returns_validation_error() {
        let mock_repo = MockDocRepo::new();
        let service = DocumentService::new(mock_repo);

        // 生成超过 256KiB 的内容
        let large_content = "a".repeat(262145);
        let req = UpdateDocumentRequest {
            title: "测试".to_string(),
            content: large_content,
            expected_version: 1,
        };

        let result = service.update_document(Uuid::new_v4(), Uuid::new_v4(), &req).await;
        assert!(matches!(
            result,
            Err(DocumentServiceError::Validation(ValidationError::ContentTooLarge))
        ));
    }
}
