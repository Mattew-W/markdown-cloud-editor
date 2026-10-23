//! 文档业务服务层：输入校验、乐观锁编排与错误语义映射。
//!
//! 本模块不接触 SQL 与 HTTP：数据访问经 [`DocumentRepository`] 抽象由
//! M1 的 SQLx 实现注入；HTTP 状态码由路由层依据 [`DocumentServiceError::code`]
//! 给出的稳定英文字面量映射（API.md §4.1）。
//!
//! 修正记录（2026-10-24，相对 M4 原始交付）：
//! - F5：正文超限由 400 改为 413（`ValidationError::ContentTooLarge` 经
//!   `From` 翻译为 [`DocumentServiceError::PayloadTooLarge`]）；
//! - F6：update 路径持久化 trim 后的标题，与 create 路径一致；
//! - F7b：新增 [`DocumentServiceError::code`]，产出 API.md §4.1 的稳定字面量；
//! - F9：仓储错误独立为 [`RepositoryError`]，服务层统一包装为 `Internal`。

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::dto::document::{
    CreateDocumentRequest, DeleteDocumentQuery, DocumentListResponse, DocumentResponse,
    DocumentSummaryResponse, ListDocumentsQuery, UpdateDocumentRequest, UpdateDocumentResponse,
    ValidationError, format_timestamp,
};

/// 仓储层错误：数据访问故障，与业务规则无关。
///
/// 数据访问实现（如 SQLx）应把连接失败、约束违反、超时归类到具体变体，
/// 便于运维区分故障类型；service 层统一包装为
/// [`DocumentServiceError::Internal`]，细节只进日志、不透出客户端。
#[derive(Debug, thiserror::Error)]
pub enum RepositoryError {
    /// 连接池耗尽或数据库不可达。
    #[error("数据库连接失败")]
    Connection,
    /// 违反数据库约束（唯一键、外键、CHECK 等）。
    #[error("数据约束违反")]
    Constraint,
    /// 语句执行超时。
    #[error("数据库查询超时")]
    Timeout,
}

/// 文档业务错误。
///
/// 每个变体对应 API.md §4 的确定 HTTP 语义；[`DocumentServiceError::code`]
/// 给出写入错误响应体的稳定英文字面量（API.md §4.1）。
#[derive(Debug, thiserror::Error)]
pub enum DocumentServiceError {
    /// 输入校验失败 → 400 `BAD_REQUEST`。
    #[error("输入参数无效")]
    Validation(ValidationError),

    /// 文档不存在或不属于当前所有者 → 404 `NOT_FOUND`（二者不区分，避免泄露）。
    #[error("文档不存在")]
    NotFound,

    /// 乐观锁版本冲突 → 409 `VERSION_CONFLICT`，响应 `details` 必含 `server_version`。
    #[error("文档版本冲突")]
    VersionConflict {
        /// 服务端当前版本号。
        server_version: i32,
    },

    /// 正文超过 262 144 字节 → 413 `PAYLOAD_TOO_LARGE`（API.md §4）。
    #[error("请求内容过大")]
    PayloadTooLarge,

    /// 仓储层故障 → 500 `INTERNAL_ERROR`。
    #[error("服务内部错误")]
    Internal(#[from] RepositoryError),
}

impl DocumentServiceError {
    /// 返回写入错误响应体的稳定英文字面量（API.md §4.1）。
    ///
    /// 客户端可依据该字段做行为分支；`Display` 文案仅供展示。
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Validation(_) => "BAD_REQUEST",
            Self::NotFound => "NOT_FOUND",
            Self::VersionConflict { .. } => "VERSION_CONFLICT",
            Self::PayloadTooLarge => "PAYLOAD_TOO_LARGE",
            Self::Internal(_) => "INTERNAL_ERROR",
        }
    }
}

impl From<ValidationError> for DocumentServiceError {
    /// 校验错误翻译：正文字节超限单独映射为 413，其余均为 400。
    fn from(err: ValidationError) -> Self {
        match err {
            ValidationError::ContentTooLarge => Self::PayloadTooLarge,
            other => Self::Validation(other),
        }
    }
}

/// 文档仓储抽象：由 M1 以 SQLx 实现并注入 [`DocumentService`]。
///
/// 实现方只关心数据访问，不返回业务错误；update/delete 必须在单条语句内
/// 原子完成乐观锁校验（API.md §3.5：严禁"先读版本、再执行无版本条件的
/// UPDATE"）。
///
/// `async fn in trait` 自 edition 2024 起为原生语法；该 lint 关注的是无法为
/// 返回的 future 指定 `Send` 等自动 trait 边界，而本 crate 以泛型注入仓储、
/// 不要求 `dyn` 兼容，故显式豁免（与 M4 原始交付的处理一致）。
#[allow(async_fn_in_trait)]
pub trait DocumentRepository {
    /// 插入新文档，返回完整记录。
    ///
    /// # Errors
    ///
    /// 数据库故障时返回 [`RepositoryError`]。
    async fn create(
        &self,
        owner_id: Uuid,
        title: &str,
        content: &str,
    ) -> Result<DocumentRecord, RepositoryError>;

    /// 按 ID 与所有者查询文档；越权与不存在均返回 `Ok(None)`。
    ///
    /// # Errors
    ///
    /// 数据库故障时返回 [`RepositoryError`]。
    async fn get_by_id(
        &self,
        id: Uuid,
        owner_id: Uuid,
    ) -> Result<Option<DocumentRecord>, RepositoryError>;

    /// 原子更新文档（乐观锁）；版本不匹配返回 `Ok(None)`。
    ///
    /// # Errors
    ///
    /// 数据库故障时返回 [`RepositoryError`]。
    async fn update(
        &self,
        id: Uuid,
        owner_id: Uuid,
        title: &str,
        content: &str,
        expected_version: i32,
    ) -> Result<Option<DocumentUpdateResult>, RepositoryError>;

    /// 原子删除文档（乐观锁）。
    ///
    /// # Errors
    ///
    /// 数据库故障时返回 [`RepositoryError`]。
    async fn delete(
        &self,
        id: Uuid,
        owner_id: Uuid,
        expected_version: i32,
    ) -> Result<DeleteOutcome, RepositoryError>;

    /// 分页查询所有者的文档列表，按 `updated_at DESC, id DESC` 排序。
    ///
    /// 返回 `(当页摘要, 总数)`。
    ///
    /// # Errors
    ///
    /// 数据库故障时返回 [`RepositoryError`]。
    async fn list(
        &self,
        owner_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<DocumentSummaryRecord>, i64), RepositoryError>;
}

/// 完整文档记录（对应数据库行，不含响应格式化）。
#[derive(Debug, Clone)]
pub struct DocumentRecord {
    /// 文档主键。
    pub id: Uuid,
    /// 标题（已 trim 的持久化形态）。
    pub title: String,
    /// Markdown 正文。
    pub content: String,
    /// 当前版本号。
    pub version: i32,
    /// 创建时间。
    pub created_at: DateTime<Utc>,
    /// 最后更新时间。
    pub updated_at: DateTime<Utc>,
}

/// 文档摘要记录（列表用，不含正文）。
#[derive(Debug, Clone)]
pub struct DocumentSummaryRecord {
    /// 文档主键。
    pub id: Uuid,
    /// 标题。
    pub title: String,
    /// 当前版本号。
    pub version: i32,
    /// 创建时间。
    pub created_at: DateTime<Utc>,
    /// 最后更新时间。
    pub updated_at: DateTime<Utc>,
}

/// 更新操作的结果（版本号与更新时间）。
#[derive(Debug, Clone)]
pub struct DocumentUpdateResult {
    /// 更新后的新版本号。
    pub version: i32,
    /// 更新时间。
    pub updated_at: DateTime<Utc>,
}

/// 删除操作结果枚举。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteOutcome {
    /// 删除成功。
    Success,
    /// 目标不存在或不属于该所有者。
    NotFound,
    /// 版本不匹配，携带服务端当前版本。
    VersionConflict {
        /// 服务端当前版本号。
        server_version: i32,
    },
}

/// 文档业务服务核心。
///
/// 通过泛型参数注入仓储实现：生产传 SQLx 实现，测试传 mock。
pub struct DocumentService<R: DocumentRepository> {
    repository: R,
}

impl<R: DocumentRepository> DocumentService<R> {
    /// 以给定仓储实现构造服务。
    #[must_use]
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    /// 创建文档。
    ///
    /// # Errors
    ///
    /// - [`DocumentServiceError::Validation`]：标题为空或超长（400）；
    /// - [`DocumentServiceError::PayloadTooLarge`]：正文超字节（413）；
    /// - [`DocumentServiceError::Internal`]：仓储故障（500）。
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
            created_at: format_timestamp(record.created_at),
            updated_at: format_timestamp(record.updated_at),
        })
    }

    /// 获取单篇文档。
    ///
    /// # Errors
    ///
    /// - [`DocumentServiceError::NotFound`]：不存在或属于他人（404）；
    /// - [`DocumentServiceError::Internal`]：仓储故障（500）。
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
                created_at: format_timestamp(doc.created_at),
                updated_at: format_timestamp(doc.updated_at),
            }),
            None => Err(DocumentServiceError::NotFound),
        }
    }

    /// 更新文档（乐观锁并发控制）。
    ///
    /// 持久化的是 trim 后的标题，与 create 路径口径一致。
    ///
    /// # Errors
    ///
    /// - [`DocumentServiceError::Validation`]：输入不合法（400）；
    /// - [`DocumentServiceError::PayloadTooLarge`]：正文超字节（413）；
    /// - [`DocumentServiceError::VersionConflict`]：版本冲突（409）；
    /// - [`DocumentServiceError::NotFound`]：不存在或属于他人（404）；
    /// - [`DocumentServiceError::Internal`]：仓储故障（500）。
    pub async fn update_document(
        &self,
        id: Uuid,
        owner_id: Uuid,
        req: &UpdateDocumentRequest,
    ) -> Result<UpdateDocumentResponse, DocumentServiceError> {
        let title = req.validate()?;

        let result = self
            .repository
            .update(id, owner_id, &title, &req.content, req.expected_version)
            .await?;

        if let Some(update_result) = result {
            Ok(UpdateDocumentResponse {
                id,
                version: update_result.version,
                updated_at: format_timestamp(update_result.updated_at),
            })
        } else {
            // 版本不匹配：再查一次以区分 404 与 409（TOCTOU 窗口影响有限）
            if let Some(existing) = self.repository.get_by_id(id, owner_id).await? {
                Err(DocumentServiceError::VersionConflict {
                    server_version: existing.version,
                })
            } else {
                Err(DocumentServiceError::NotFound)
            }
        }
    }

    /// 删除文档（乐观锁）。`expected_version` 经查询参数传入（API.md §3.6）。
    ///
    /// # Errors
    ///
    /// - [`DocumentServiceError::Validation`]：`expected_version < 1`（400）；
    /// - [`DocumentServiceError::VersionConflict`]：版本冲突（409）；
    /// - [`DocumentServiceError::NotFound`]：不存在或属于他人（404）；
    /// - [`DocumentServiceError::Internal`]：仓储故障（500）。
    pub async fn delete_document(
        &self,
        id: Uuid,
        owner_id: Uuid,
        query: &DeleteDocumentQuery,
    ) -> Result<(), DocumentServiceError> {
        if query.expected_version < 1 {
            return Err(DocumentServiceError::Validation(
                ValidationError::InvalidVersion,
            ));
        }

        let outcome = self
            .repository
            .delete(id, owner_id, query.expected_version)
            .await?;

        match outcome {
            DeleteOutcome::Success => Ok(()),
            DeleteOutcome::NotFound => Err(DocumentServiceError::NotFound),
            DeleteOutcome::VersionConflict { server_version } => {
                Err(DocumentServiceError::VersionConflict { server_version })
            }
        }
    }

    /// 分页查询文档列表。
    ///
    /// # Errors
    ///
    /// - [`DocumentServiceError::Validation`]：分页参数越界（400）；
    /// - [`DocumentServiceError::Internal`]：仓储故障（500）。
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
                created_at: format_timestamp(r.created_at),
                updated_at: format_timestamp(r.updated_at),
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
    // mockall 0.12 为 mock 生成的 async trait 实现不含 await 语句，
    // 触发 pedantic 的 unused_async_trait_impl；属宏生成代码，非手写缺陷。
    #![allow(clippy::unused_async_trait_impl)]

    use super::*;
    use crate::dto::document::{DEFAULT_LIMIT, DEFAULT_TITLE, MAX_CONTENT_BYTES};
    use chrono::Utc;
    use mockall::mock;

    // 生成 Mock 仓储实现
    mock! {
        pub DocRepo {}
        impl DocumentRepository for DocRepo {
            async fn create(
                &self,
                owner_id: Uuid,
                title: &str,
                content: &str,
            ) -> Result<DocumentRecord, RepositoryError>;

            async fn get_by_id(
                &self,
                id: Uuid,
                owner_id: Uuid,
            ) -> Result<Option<DocumentRecord>, RepositoryError>;

            async fn update(
                &self,
                id: Uuid,
                owner_id: Uuid,
                title: &str,
                content: &str,
                expected_version: i32,
            ) -> Result<Option<DocumentUpdateResult>, RepositoryError>;

            async fn delete(
                &self,
                id: Uuid,
                owner_id: Uuid,
                expected_version: i32,
            ) -> Result<DeleteOutcome, RepositoryError>;

            async fn list(
                &self,
                owner_id: Uuid,
                limit: i64,
                offset: i64,
            ) -> Result<(Vec<DocumentSummaryRecord>, i64), RepositoryError>;
        }
    }

    // 辅助函数：生成测试用文档记录
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

        mock_repo.expect_create().returning(move |_, title, _| {
            assert_eq!(title, DEFAULT_TITLE);
            Ok(mock_record(doc_id, 1))
        });

        let service = DocumentService::new(mock_repo);
        let req = CreateDocumentRequest {
            title: None,
            content: None,
        };

        let result = service.create_document(owner_id, &req).await;
        assert!(result.is_ok());
        let resp = result.unwrap();
        assert_eq!(resp.version, 1);
        // 响应时间戳必须是秒级 RFC 3339 字符串
        assert!(resp.created_at.ends_with('Z'));
        assert!(!resp.created_at.contains('.'));
    }

    #[tokio::test]
    async fn create_document_explicit_blank_title_returns_bad_request() {
        let mock_repo = MockDocRepo::new();
        let service = DocumentService::new(mock_repo);
        let req = CreateDocumentRequest {
            title: Some("  \u{3000}\t ".to_string()),
            content: None,
        };

        let err = service
            .create_document(Uuid::new_v4(), &req)
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            DocumentServiceError::Validation(ValidationError::TitleEmpty)
        ));
        assert_eq!(err.code(), "BAD_REQUEST");
    }

    #[tokio::test]
    async fn create_document_title_too_long_returns_bad_request() {
        let mock_repo = MockDocRepo::new();
        let service = DocumentService::new(mock_repo);
        let req = CreateDocumentRequest {
            title: Some("中".repeat(256)),
            content: None,
        };

        let err = service
            .create_document(Uuid::new_v4(), &req)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "BAD_REQUEST");
    }

    #[tokio::test]
    async fn create_document_content_over_limit_returns_payload_too_large() {
        let mock_repo = MockDocRepo::new();
        let service = DocumentService::new(mock_repo);
        let req = CreateDocumentRequest {
            title: None,
            content: Some("a".repeat(MAX_CONTENT_BYTES + 1)),
        };

        let err = service
            .create_document(Uuid::new_v4(), &req)
            .await
            .unwrap_err();
        assert!(matches!(err, DocumentServiceError::PayloadTooLarge));
        assert_eq!(err.code(), "PAYLOAD_TOO_LARGE");
    }

    #[tokio::test]
    async fn update_document_persists_trimmed_title() {
        let mut mock_repo = MockDocRepo::new();
        let doc_id = Uuid::new_v4();
        let owner_id = Uuid::new_v4();

        // 落库的标题必须是 trim 后的形态（F6 修复点）
        mock_repo
            .expect_update()
            .returning(move |_, _, title, _, _| {
                assert_eq!(title, "整理后的标题");
                Ok(Some(DocumentUpdateResult {
                    version: 2,
                    updated_at: Utc::now(),
                }))
            });

        let service = DocumentService::new(mock_repo);
        let req = UpdateDocumentRequest {
            title: "  整理后的标题 \t".to_string(),
            content: "新内容".to_string(),
            expected_version: 1,
        };

        let resp = service
            .update_document(doc_id, owner_id, &req)
            .await
            .unwrap();
        assert_eq!(resp.id, doc_id);
        assert_eq!(resp.version, 2);
    }

    #[tokio::test]
    async fn update_document_version_mismatch_returns_conflict() {
        let mut mock_repo = MockDocRepo::new();
        let doc_id = Uuid::new_v4();
        let owner_id = Uuid::new_v4();

        // 更新失败（版本不对）
        mock_repo
            .expect_update()
            .returning(|_, _, _, _, _| Ok(None));
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

        let err = service
            .update_document(doc_id, owner_id, &req)
            .await
            .unwrap_err();
        match err {
            DocumentServiceError::VersionConflict { server_version } => {
                assert_eq!(server_version, 3);
            }
            other => panic!("预期返回版本冲突错误，实际：{other:?}"),
        }
        assert_eq!(
            DocumentServiceError::VersionConflict { server_version: 3 }.code(),
            "VERSION_CONFLICT"
        );
    }

    #[tokio::test]
    async fn update_document_missing_returns_not_found() {
        let mut mock_repo = MockDocRepo::new();
        mock_repo
            .expect_update()
            .returning(|_, _, _, _, _| Ok(None));
        mock_repo.expect_get_by_id().returning(|_, _| Ok(None));

        let service = DocumentService::new(mock_repo);
        let req = UpdateDocumentRequest {
            title: "t".to_string(),
            content: "c".to_string(),
            expected_version: 1,
        };

        let err = service
            .update_document(Uuid::new_v4(), Uuid::new_v4(), &req)
            .await
            .unwrap_err();
        assert!(matches!(err, DocumentServiceError::NotFound));
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[tokio::test]
    async fn update_document_content_over_limit_returns_payload_too_large() {
        let mock_repo = MockDocRepo::new();
        let service = DocumentService::new(mock_repo);

        let large_content = "a".repeat(MAX_CONTENT_BYTES + 1);
        let req = UpdateDocumentRequest {
            title: "测试".to_string(),
            content: large_content,
            expected_version: 1,
        };

        let err = service
            .update_document(Uuid::new_v4(), Uuid::new_v4(), &req)
            .await
            .unwrap_err();
        assert!(matches!(err, DocumentServiceError::PayloadTooLarge));
        assert_eq!(err.code(), "PAYLOAD_TOO_LARGE");
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
            .withf(move |_, limit, offset| *limit == DEFAULT_LIMIT && *offset == 0)
            .returning(|_, _, _| Ok((vec![], 0)));

        let service = DocumentService::new(mock_repo);
        let query = ListDocumentsQuery {
            limit: None,
            offset: None,
        };

        let result = service.list_documents(owner_id, &query).await;
        assert!(result.is_ok());
        let resp = result.unwrap();
        assert_eq!(resp.limit, DEFAULT_LIMIT);
        assert_eq!(resp.offset, 0);
    }

    #[tokio::test]
    async fn list_documents_rejects_out_of_range_pagination() {
        let mock_repo = MockDocRepo::new();
        let service = DocumentService::new(mock_repo);

        for bad in [
            ListDocumentsQuery {
                limit: Some(0),
                offset: None,
            },
            ListDocumentsQuery {
                limit: Some(101),
                offset: None,
            },
            ListDocumentsQuery {
                limit: None,
                offset: Some(-1),
            },
        ] {
            let err = service
                .list_documents(Uuid::new_v4(), &bad)
                .await
                .unwrap_err();
            assert!(matches!(err, DocumentServiceError::Validation(_)));
        }
    }

    #[tokio::test]
    async fn delete_document_success() {
        let mut mock_repo = MockDocRepo::new();
        mock_repo.expect_delete().returning(|_, _, v| {
            assert_eq!(v, 1);
            Ok(DeleteOutcome::Success)
        });

        let service = DocumentService::new(mock_repo);
        let query = DeleteDocumentQuery {
            expected_version: 1,
        };
        let result = service
            .delete_document(Uuid::new_v4(), Uuid::new_v4(), &query)
            .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn delete_document_version_mismatch_returns_conflict() {
        let mut mock_repo = MockDocRepo::new();
        mock_repo
            .expect_delete()
            .returning(|_, _, _| Ok(DeleteOutcome::VersionConflict { server_version: 5 }));

        let service = DocumentService::new(mock_repo);
        let query = DeleteDocumentQuery {
            expected_version: 2,
        };
        let err = service
            .delete_document(Uuid::new_v4(), Uuid::new_v4(), &query)
            .await
            .unwrap_err();
        match err {
            DocumentServiceError::VersionConflict { server_version } => {
                assert_eq!(server_version, 5);
            }
            other => panic!("预期版本冲突，实际：{other:?}"),
        }
    }

    #[tokio::test]
    async fn delete_document_missing_returns_not_found() {
        let mut mock_repo = MockDocRepo::new();
        mock_repo
            .expect_delete()
            .returning(|_, _, _| Ok(DeleteOutcome::NotFound));

        let service = DocumentService::new(mock_repo);
        let query = DeleteDocumentQuery {
            expected_version: 1,
        };
        let err = service
            .delete_document(Uuid::new_v4(), Uuid::new_v4(), &query)
            .await
            .unwrap_err();
        assert!(matches!(err, DocumentServiceError::NotFound));
    }

    #[tokio::test]
    async fn delete_document_rejects_non_positive_version() {
        let mock_repo = MockDocRepo::new();
        let service = DocumentService::new(mock_repo);
        let query = DeleteDocumentQuery {
            expected_version: 0,
        };
        let err = service
            .delete_document(Uuid::new_v4(), Uuid::new_v4(), &query)
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            DocumentServiceError::Validation(ValidationError::InvalidVersion)
        ));
    }

    #[tokio::test]
    async fn error_codes_match_api_contract() {
        // API.md §4.1 稳定字面量抽查
        let cases: Vec<(DocumentServiceError, &str)> = vec![
            (
                DocumentServiceError::Validation(ValidationError::TitleEmpty),
                "BAD_REQUEST",
            ),
            (DocumentServiceError::NotFound, "NOT_FOUND"),
            (
                DocumentServiceError::VersionConflict { server_version: 1 },
                "VERSION_CONFLICT",
            ),
            (DocumentServiceError::PayloadTooLarge, "PAYLOAD_TOO_LARGE"),
            (
                DocumentServiceError::Internal(RepositoryError::Connection),
                "INTERNAL_ERROR",
            ),
        ];
        for (err, expected) in cases {
            assert_eq!(err.code(), expected);
        }
    }

    #[tokio::test]
    async fn multibyte_boundary_content_accepted() {
        let mut mock_repo = MockDocRepo::new();
        let doc_id = Uuid::new_v4();

        // 87 381 个汉字 = 262 143 字节，加 1 个 ASCII 恰好 262 144
        let boundary = format!("{}{}", "中".repeat(MAX_CONTENT_BYTES / 3), "a");
        assert_eq!(boundary.len(), MAX_CONTENT_BYTES);
        mock_repo
            .expect_create()
            .returning(move |_, _, _| Ok(mock_record(doc_id, 1)));

        let service = DocumentService::new(mock_repo);
        let req = CreateDocumentRequest {
            title: None,
            content: Some(boundary),
        };
        assert!(service.create_document(Uuid::new_v4(), &req).await.is_ok());
    }
}
