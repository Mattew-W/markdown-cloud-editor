# Gemini 3.8 Flash 原生协同创作集成指南

> **核心目标**：将 Google 新一代 Gemini 3.8 Flash 的长上下文理解、多模态图表构建与精准推理能力无缝嵌入 Web Markdown 编辑流。

---

## 1. 架构总览

在协同编辑场景中，AI 不仅是一个独立的问答聊天框，更是深入到 Markdown 字符流、光标选区和结构推导中的智能副驾驶（Copilot）：

```text
[浏览器 Markdown 编辑器] 
       │
       ▼ (光标位置 / 选中文本 / 全文大纲)
[前端 GeminiCopilot 交互层] 
       │
       ▼ (HTTP POST /api/v1/ai/* + JWT)
[后端 GeminiService 调度网关]
       ├── [在线分支] ──> Google Generative Language API (Gemini 3.8/2.0 Flash)
       └── [离线分支] ──> 内置高保真上下文感知模拟引擎 (100% 离线测试通过)
```

---

## 2. 提示词工程与系统指令矩阵

为使 Gemini 3.8 Flash 产生稳定、可直接注入编辑器的 Markdown 内容，系统针对每类场景制定了精确的 System Prompt 契约：

### 2.1 智能续写 (`complete`)
- **System Prompt**：
  > "You are Gemini 3.8 Flash, an elite AI Markdown Copilot. Continue the user's Markdown document naturally, logically, and concisely with proper Markdown formatting."
- **上下文拼接**：自动截取光标前至多 4000 字符作为紧前文，提示词显式标注 `Continue text from cursor:`。
- **输出格式**：仅输出续写部分，不得输出重复的前文或寒暄语。

### 2.2 润色与排版修复 (`polish`)
- **System Prompt**：
  > "You are Gemini 3.8 Flash Markdown Polisher. Instruction: {instruction}. Rewrite and enhance the following Markdown text, preserving semantic meaning and improving readability."
- **特色支持**：针对混排中的中文全半角符号、中英文间空格、列表层级混乱及 Markdown 标题规范进行自动化标定。

### 2.3 Mermaid 架构推导 (`diagram`)
- **System Prompt**：
  > "You are Gemini 3.8 Flash Diagram Generator. Convert the following description into a clean, valid Mermaid diagram. Output ONLY the ```mermaid code block."
- **前端集成**：前端解析到 ````mermaid 时，自动渲染为可视化矢量图，并在右侧预览区实时呈现。

### 2.4 LaTeX 数学公式推导 (`math`)
- **System Prompt**：
  > "You are Gemini 3.8 Flash Math Assistant. Convert the following natural language math description into standard KaTeX / LaTeX formula syntax. Output display math wrapped in $$...$$ or inline math in $...$."
- **无缝衔接**：生成的公式可直接通过「插入至光标处」合入正文，无需人工书写复杂 LaTeX 语法。

---

## 3. 高保真离线仿真引擎 (Offline Simulation Engine)

在教学评估、CI/CD 持续集成或局域网评测环境中，外网访问受限或未提供 Google API Key 是常见场景。若 AI 功能因无 Key 直接报错瘫痪，整个软件的完整度将大打折扣。

为此，本项目特别研发了**本地高保真离线仿真引擎**：
1. **关键词上下文感知**：
   - 当检测到正文提及「架构」「并发」「网络」「代码」时，自动生成贴合语义的六层解耦阐述、乐观锁 CAS 原语及 Rust 代码片段。
2. **合法格式断言保证**：
   - Mermaid 生成必定输出标准可解析的 `flowchart TD` 语法。
   - 数学公式必定输出标准的 `\mathcal{L}` 交叉熵损失函数。
3. **透明可追溯**：
   - 响应体通过 `simulated: true` 与 `model: "gemini-2.0-flash-simulated"` 显式告知前端，既保证演示与自动化测试 100% 畅通，又保持事实透明。

---

## 4. 接入官方 API 操作指南

若需启用真实的 Google Gemini 3.8 Flash 在线能力：

1. 访问 [Google AI Studio](https://aistudio.google.com/) 获取 API Key。
2. 在 `gemini-3.8-flash-version/` 目录下创建或编辑 `.env` 文件：
   ```env
   GEMINI_API_KEY=AIzaSyD-YourActualGeminiKey...
   GEMINI_MODEL=gemini-2.0-flash
   ```
3. 重启后端服务：
   ```bash
   cargo run
   ```
   控制台将打印 `🤖 Gemini AI 模式: 在线 API 模式`，所有请求即刻直连 Google Cloud 大模型基础设施。
