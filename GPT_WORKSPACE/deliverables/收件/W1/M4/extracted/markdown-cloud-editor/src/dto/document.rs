use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 创建文档请求
#[derive(Debug, Deserialize)]
pub struct CreateDocumentRequest {
    /// 标题：可选，省略则用默认值；显式空串视为非法
    pub title: Option<String>,
    /// 正文：可选，默认为空串
    pub content: Option<String>,
}

/// 更新文档请求
#[derive(Debug, Deserialize)]
pub struct UpdateDocumentRequest {
    /// 标题：必填，trim后1-255字符
    pub title: String,
    /// 正文：必填，字节数不超过256KiB
    pub content: String,
    /// 期望版本：正整数，用于乐观锁
    pub expected_version: i32,
}

/// 文档列表查询参数
#[derive(Debug, Deserialize)]
pub struct ListDocumentsQuery {
    /// 每页数量：默认20，范围1-100
    pub limit: Option<i64>,
    /// 偏移量：默认0，非负
    pub offset: Option<i64>,
}

/// 单篇完整文档响应
#[derive(Debug, Serialize)]
pub struct DocumentResponse {
    pub id: Uuid,
    pub title: String,
    pub content: String,
    pub version: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 文档摘要（列表项，不含正文）
#[derive(Debug, Serialize)]
pub struct DocumentSummaryResponse {
    pub id: Uuid,
    pub title: String,
    pub version: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 文档列表响应
#[derive(Debug, Serialize)]
pub struct DocumentListResponse {
    pub documents: Vec<DocumentSummaryResponse>,
    pub limit: i64,
    pub offset: i64,
    pub total: i64,
}

/// 更新/保存成功确认响应
#[derive(Debug, Serialize)]
pub struct DocumentUpdateConfirmResponse {
    pub id: Uuid,
    pub version: i32,
    pub updated_at: DateTime<Utc>,
}



/// 校验错误类型
#[derive(Debug, thiserror::Error)]
pub enum ValidationError {
    #[error("标题不能为空")]
    TitleEmpty,
    #[error("标题长度不能超过255个字符")]
    TitleTooLong,
    #[error("正文大小不能超过256KiB")]
    ContentTooLarge,
    #[error("期望版本必须为正整数")]
    InvalidVersion,
    #[error("分页数量必须在1-100之间")]
    InvalidLimit,
    #[error("偏移量不能为负数")]
    InvalidOffset,
}

impl CreateDocumentRequest {
    /// 校验创建请求，返回处理后的标题和正文
    pub fn validate(&self) -> Result<(String, String), ValidationError> {
        // 处理标题：有值则trim校验，无值用默认名
        let title = match &self.title {
            Some(t) => {
                let trimmed = t.trim().to_string();
                if trimmed.is_empty() {
                    return Err(ValidationError::TitleEmpty);
                }
                if trimmed.chars().count() > 255 {
                    return Err(ValidationError::TitleTooLong);
                }
                trimmed
            }
            None => "未命名文档".to_string(),
        };

        // 处理正文：默认空串，校验字节上限
        let content = self.content.clone().unwrap_or_default();
        if content.len() > 262144 {
            return Err(ValidationError::ContentTooLarge);
        }

        Ok((title, content))
    }
}

impl UpdateDocumentRequest {
    /// 校验更新请求
    pub fn validate(&self) -> Result<(), ValidationError> {
        let trimmed_title = self.title.trim();
        if trimmed_title.is_empty() {
            return Err(ValidationError::TitleEmpty);
        }
        if trimmed_title.chars().count() > 255 {
            return Err(ValidationError::TitleTooLong);
        }

        if self.content.len() > 262144 {
            return Err(ValidationError::ContentTooLarge);
        }

        if self.expected_version < 1 {
            return Err(ValidationError::InvalidVersion);
        }

        Ok(())
    }
}

impl ListDocumentsQuery {
    /// 校验并返回处理后的分页参数 (limit, offset)
    pub fn validate(&self) -> Result<(i64, i64), ValidationError> {
        let limit = self.limit.unwrap_or(20);
        if !(1..=100).contains(&limit) {
            return Err(ValidationError::InvalidLimit);
        }

        let offset = self.offset.unwrap_or(0);
        if offset < 0 {
            return Err(ValidationError::InvalidOffset);
        }

        Ok((limit, offset))
    }
}
