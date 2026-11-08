//! Gemini 3.8 Flash AI Copilot DTO 契约

use serde::{Deserialize, Serialize};

/// 续写与自动补全请求
#[derive(Debug, Clone, Deserialize)]
pub struct AiCompleteRequest {
    /// 光标前上下文或引导提示词
    pub prompt: String,
    /// 期望最大生成 Token 数量
    pub max_tokens: Option<u32>,
}

/// Markdown 润色与排版修复请求
#[derive(Debug, Clone, Deserialize)]
pub struct AiPolishRequest {
    /// 待润色正文
    pub content: String,
    /// 润色意图（例如 "学术严谨", "精简有力", "修复语法错别字"）
    pub instruction: Option<String>,
}

/// 文档摘要提取请求
#[derive(Debug, Clone, Deserialize)]
pub struct AiSummarizeRequest {
    /// 待摘要正文
    pub content: String,
    /// 摘要格式: "bullet_points" | "paragraph" | "executive"
    pub format: Option<String>,
}

/// Mermaid 图表生成请求
#[derive(Debug, Clone, Deserialize)]
pub struct AiDiagramRequest {
    /// 流程或概念描述
    pub description: String,
    /// 图表类型: "flowchart" | "sequence" | "class" | "state"
    pub diagram_type: Option<String>,
}

/// LaTeX 数学公式智能构建请求
#[derive(Debug, Clone, Deserialize)]
pub struct AiMathRequest {
    /// 公式自然语言描述
    pub description: String,
}

/// 对话历史单项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    /// 角色: "user" | "model"
    pub role: String,
    /// 消息正文
    pub content: String,
}

/// 基于文档的智能问答请求
#[derive(Debug, Clone, Deserialize)]
pub struct AiChatRequest {
    /// 用户当前输入
    pub message: String,
    /// 当前正在编辑的文档上下文
    pub document_context: Option<String>,
    /// 历史问答轮次
    pub history: Option<Vec<ChatMessage>>,
}

/// Gemini AI 统一响应结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiResponse {
    /// 模型生成结果
    pub result: String,
    /// 实际响应模型名称 (如 "gemini-3.8-flash")
    pub model: String,
    /// 消耗 Token 估计
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_tokens: Option<u32>,
    /// 是否为本地高保真模拟模式 (无 API Key 场景)
    pub simulated: bool,
}
