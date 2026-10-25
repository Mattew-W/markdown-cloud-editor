//! 演示入口：以内存仓储实现跑通文档服务的全部分支。
//!
//! 运行：`cargo run`。任一场景失败即以非零码退出，可直接当作冒烟检查。
//! 覆盖的示例类别：默认标题 / 显式全空白标题 / 标题超长 / 正文字节边界
//! （含多字节边界）/ 更新与删除的乐观锁分支 / 分页默认与越界 / 错误码字面量。

use std::sync::Mutex;

use chrono::Utc;
use uuid::Uuid;

use markdown_cloud_editor::dto::document::{
    CreateDocumentRequest, DEFAULT_TITLE, DeleteDocumentQuery, ListDocumentsQuery,
    MAX_CONTENT_BYTES, MAX_TITLE_CHARS, UpdateDocumentRequest,
};
use markdown_cloud_editor::services::document_service::{
    DeleteOutcome, DocumentRecord, DocumentRepository, DocumentService, DocumentServiceError,
    DocumentSummaryRecord, DocumentUpdateResult, RepositoryError,
};

/// 内存仓储：仅供演示，不涉及数据库。
struct InMemoryRepo {
    docs: Mutex<Vec<(Uuid, DocumentRecord)>>,
}

impl InMemoryRepo {
    fn new() -> Self {
        Self {
            docs: Mutex::new(Vec::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<(Uuid, DocumentRecord)>> {
        self.docs.lock().expect("演示用内存锁不应被毒化")
    }
}

impl DocumentRepository for InMemoryRepo {
    async fn create(
        &self,
        owner_id: Uuid,
        title: &str,
        content: &str,
    ) -> Result<DocumentRecord, RepositoryError> {
        let mut docs = self.lock();
        let now = Utc::now();
        let record = DocumentRecord {
            id: Uuid::new_v4(),
            title: title.to_string(),
            content: content.to_string(),
            version: 1,
            created_at: now,
            updated_at: now,
        };
        docs.push((owner_id, record.clone()));
        Ok(record)
    }

    async fn get_by_id(
        &self,
        id: Uuid,
        owner_id: Uuid,
    ) -> Result<Option<DocumentRecord>, RepositoryError> {
        let docs = self.lock();
        Ok(docs
            .iter()
            .find(|(owner, doc)| *owner == owner_id && doc.id == id)
            .map(|(_, doc)| doc.clone()))
    }

    async fn update(
        &self,
        id: Uuid,
        owner_id: Uuid,
        title: &str,
        content: &str,
        expected_version: i32,
    ) -> Result<Option<DocumentUpdateResult>, RepositoryError> {
        let mut docs = self.lock();
        let Some(entry) = docs
            .iter_mut()
            .find(|(owner, doc)| *owner == owner_id && doc.id == id)
        else {
            return Ok(None);
        };
        if entry.1.version != expected_version {
            return Ok(None);
        }
        entry.1.title = title.to_string();
        entry.1.content = content.to_string();
        entry.1.version += 1;
        entry.1.updated_at = Utc::now();
        Ok(Some(DocumentUpdateResult {
            version: entry.1.version,
            updated_at: entry.1.updated_at,
        }))
    }

    async fn delete(
        &self,
        id: Uuid,
        owner_id: Uuid,
        expected_version: i32,
    ) -> Result<DeleteOutcome, RepositoryError> {
        let mut docs = self.lock();
        let Some(pos) = docs
            .iter()
            .position(|(owner, doc)| *owner == owner_id && doc.id == id)
        else {
            return Ok(DeleteOutcome::NotFound);
        };
        if docs[pos].1.version != expected_version {
            return Ok(DeleteOutcome::VersionConflict {
                server_version: docs[pos].1.version,
            });
        }
        docs.remove(pos);
        Ok(DeleteOutcome::Success)
    }

    async fn list(
        &self,
        owner_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<DocumentSummaryRecord>, i64), RepositoryError> {
        let docs = self.lock();
        let mut owned: Vec<&DocumentRecord> = docs
            .iter()
            .filter(|(owner, _)| *owner == owner_id)
            .map(|(_, doc)| doc)
            .collect();
        // updated_at DESC, id DESC（API.md §3.3）
        owned.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        let total = owned.len() as i64;
        let page = owned
            .into_iter()
            .skip(offset.max(0) as usize)
            .take(limit.max(0) as usize)
            .map(|doc| DocumentSummaryRecord {
                id: doc.id,
                title: doc.title.clone(),
                version: doc.version,
                created_at: doc.created_at,
                updated_at: doc.updated_at,
            })
            .collect();
        Ok((page, total))
    }
}

/// 演示结果记录器。
struct Report {
    passed: usize,
    failed: usize,
}

impl Report {
    fn new() -> Self {
        Self {
            passed: 0,
            failed: 0,
        }
    }

    fn check(&mut self, name: &str, ok: bool, detail: &str) {
        if ok {
            self.passed += 1;
            println!("PASS  {name}  {detail}");
        } else {
            self.failed += 1;
            println!("FAIL  {name}  {detail}");
        }
    }

    fn summary(&self) -> bool {
        println!("----------------------------------------");
        println!("合计：通过 {} 项，失败 {} 项", self.passed, self.failed);
        self.failed == 0
    }
}

#[tokio::main]
async fn main() {
    let mut report = Report::new();
    let owner = Uuid::new_v4();
    let service = DocumentService::new(InMemoryRepo::new());
    let mut live_docs: i64 = 0;

    // ---------- 创建 ----------

    let doc1 = service
        .create_document(
            owner,
            &CreateDocumentRequest {
                title: None,
                content: Some("# 演示文档\n\n第一版正文。".to_string()),
            },
        )
        .await
        .expect("默认标题创建应成功");
    live_docs += 1;
    report.check(
        "创建-省略标题回退默认标题",
        doc1.title == DEFAULT_TITLE && doc1.version == 1,
        &format!("title={:?} version={}", doc1.title, doc1.version),
    );
    report.check(
        "创建-响应时间戳为秒级RFC3339(Z结尾)",
        doc1.created_at.ends_with('Z') && !doc1.created_at.contains('.'),
        &format!("created_at={}", doc1.created_at),
    );
    println!(
        "      响应体示例：{}",
        serde_json::to_string(&doc1).unwrap()
    );

    let err = service
        .create_document(
            owner,
            &CreateDocumentRequest {
                title: Some(" \t\u{3000} ".to_string()),
                content: None,
            },
        )
        .await
        .unwrap_err();
    report.check(
        "创建-显式全空白标题拒绝(400)",
        err.code() == "BAD_REQUEST",
        err.code(),
    );

    let err = service
        .create_document(
            owner,
            &CreateDocumentRequest {
                title: Some("中".repeat(MAX_TITLE_CHARS + 1)),
                content: None,
            },
        )
        .await
        .unwrap_err();
    report.check(
        "创建-标题超过255字符拒绝(400)",
        err.code() == "BAD_REQUEST",
        err.code(),
    );

    // 多字节边界：87 381 个汉字（262 143 字节）+ 1 个 ASCII = 恰好 262 144 字节
    let boundary = format!("{}{}", "中".repeat(MAX_CONTENT_BYTES / 3), "a");
    let doc4 = service
        .create_document(
            owner,
            &CreateDocumentRequest {
                title: None,
                content: Some(boundary),
            },
        )
        .await;
    report.check(
        "创建-正文多字节边界恰达上限通过",
        doc4.is_ok(),
        &format!("bytes={}", MAX_CONTENT_BYTES),
    );
    if doc4.is_ok() {
        live_docs += 1;
    }

    let err = service
        .create_document(
            owner,
            &CreateDocumentRequest {
                title: None,
                content: Some("a".repeat(MAX_CONTENT_BYTES + 1)),
            },
        )
        .await
        .unwrap_err();
    report.check(
        "创建-正文超1字节拒绝(413)",
        err.code() == "PAYLOAD_TOO_LARGE",
        err.code(),
    );

    // ---------- 更新 ----------

    let updated = service
        .update_document(
            doc1.id,
            owner,
            &UpdateDocumentRequest {
                title: "  演示标题 \t".to_string(),
                content: "更新后的正文".to_string(),
                expected_version: 1,
            },
        )
        .await
        .expect("happy path 更新应成功");
    report.check(
        "更新-happy path版本自增",
        updated.version == 2,
        &format!("version={}", updated.version),
    );

    let fetched = service
        .get_document(doc1.id, owner)
        .await
        .expect("刚创建的文档应可读");
    report.check(
        "更新-落库标题为trim后形态",
        fetched.title == "演示标题",
        &format!("title={:?}", fetched.title),
    );

    let err = service
        .update_document(
            doc1.id,
            owner,
            &UpdateDocumentRequest {
                title: "x".to_string(),
                content: "y".to_string(),
                expected_version: 1,
            },
        )
        .await
        .unwrap_err();
    let conflict_ok = matches!(
        err,
        DocumentServiceError::VersionConflict { server_version } if server_version == 2
    );
    report.check("更新-旧版本号冲突(409)", conflict_ok, err.code());

    let err = service
        .update_document(
            Uuid::new_v4(),
            owner,
            &UpdateDocumentRequest {
                title: "x".to_string(),
                content: "y".to_string(),
                expected_version: 1,
            },
        )
        .await
        .unwrap_err();
    report.check(
        "更新-目标不存在(404)",
        err.code() == "NOT_FOUND",
        err.code(),
    );

    // ---------- 获取 ----------

    let err = service
        .get_document(Uuid::new_v4(), owner)
        .await
        .unwrap_err();
    report.check("获取-不存在(404)", err.code() == "NOT_FOUND", err.code());

    // ---------- 删除 ----------

    let doc4 = doc4.expect("上文已验证边界创建成功");
    service
        .delete_document(
            doc4.id,
            owner,
            &DeleteDocumentQuery {
                expected_version: 1,
            },
        )
        .await
        .expect("版本正确的删除应成功");
    live_docs -= 1;
    let err = service.get_document(doc4.id, owner).await.unwrap_err();
    report.check(
        "删除-成功后不可再见(404)",
        err.code() == "NOT_FOUND",
        err.code(),
    );

    let doc11 = service
        .create_document(
            owner,
            &CreateDocumentRequest {
                title: None,
                content: None,
            },
        )
        .await
        .expect("创建应成功");
    live_docs += 1;
    let err = service
        .delete_document(
            doc11.id,
            owner,
            &DeleteDocumentQuery {
                expected_version: 99,
            },
        )
        .await
        .unwrap_err();
    let conflict_ok = matches!(
        err,
        DocumentServiceError::VersionConflict { server_version } if server_version == 1
    );
    report.check("删除-版本冲突(409)", conflict_ok, err.code());

    let err = service
        .delete_document(
            doc11.id,
            owner,
            &DeleteDocumentQuery {
                expected_version: 0,
            },
        )
        .await
        .unwrap_err();
    report.check(
        "删除-版本号非法(400)",
        err.code() == "BAD_REQUEST",
        err.code(),
    );

    // ---------- 列表 ----------

    let list = service
        .list_documents(
            owner,
            &ListDocumentsQuery {
                limit: None,
                offset: None,
            },
        )
        .await
        .expect("默认分页查询应成功");
    report.check(
        "列表-默认分页参数(20/0)",
        list.limit == 20 && list.offset == 0,
        &format!("limit={} offset={}", list.limit, list.offset),
    );
    report.check(
        "列表-总数与存活文档数一致",
        list.total == live_docs,
        &format!("total={} live={}", list.total, live_docs),
    );

    for (bad, label) in [
        (
            ListDocumentsQuery {
                limit: Some(0),
                offset: None,
            },
            "limit=0",
        ),
        (
            ListDocumentsQuery {
                limit: Some(101),
                offset: None,
            },
            "limit=101",
        ),
        (
            ListDocumentsQuery {
                limit: None,
                offset: Some(-1),
            },
            "offset=-1",
        ),
    ] {
        let err = service.list_documents(owner, &bad).await.unwrap_err();
        report.check(
            &format!("列表-{label}拒绝(400)"),
            err.code() == "BAD_REQUEST",
            err.code(),
        );
    }

    if !report.summary() {
        std::process::exit(1);
    }
}
