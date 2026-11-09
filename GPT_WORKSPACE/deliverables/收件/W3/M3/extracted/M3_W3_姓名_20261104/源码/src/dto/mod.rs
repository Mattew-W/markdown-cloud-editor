//! 数据传输对象（DTO）定义层。
//!
//! 包含请求入参反序列化结构、查询参数结构以及标准化响应体定义。

pub mod documents;

pub use documents::{
    CreateDocumentRequest, DeleteDocumentQuery, DocumentListResponse, DocumentResponse,
    DocumentSummaryResponse, ListDocumentsQuery, UpdateDocumentRequest, UpdateDocumentResponse,
};
