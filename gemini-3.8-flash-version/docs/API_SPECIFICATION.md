# HTTP REST API 完整规范契约

> **基准规范**：严格继承并扩展 35-380 项目规范 §06 与冻结契约  
> **协议前缀**：`/api/v1`（运维探针 `/health` 除外）  
> **认证方式**：`Authorization: Bearer <JWT>`  
> **数据格式**：请求与响应均采用 UTF-8 编码的 `application/json`

---

## 1. 状态码与通用错误响应格式

所有非 2xx 响应（除 204 无响应体外）均返回统一结构体：

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Version conflict: current server version is 3",
    "details": {
      "server_version": 3
    },
    "request_id": "c1f7b8d4-5a3e-4b72-9c10-2f9810d7a123"
  }
}
```

### 状态码映射表

| 状态码 | 错误码枚举 (`code`) | 触发场景 |
|---|---|---|
| `200 OK` | - | 登录成功、查询文档、更新文档、AI 生成成功 |
| `201 Created` | - | 用户注册成功、文档创建成功 |
| `204 No Content` | - | 文档删除成功（无响应体） |
| `400 Bad Request` | `BAD_REQUEST` | 参数缺失、格式非法、标题为空、密码长度不符 |
| `401 Unauthorized` | `UNAUTHORIZED` | Token 无效/过期、用户名或密码错误 |
| `404 Not Found` | `NOT_FOUND` | 路由不存在、文档不存在、试图越权访问他人文档 |
| `409 Conflict` | `USERNAME_TAKEN` | 注册时用户名已被占用 |
| `409 Conflict` | `VERSION_CONFLICT` | 乐观锁版本号不匹配（附带 `server_version`） |
| `413 Payload Too Large`| `PAYLOAD_TOO_LARGE` | 正文 > 262144 字节 (256KiB) 或 JSON 请求体 > 2 MiB |
| `429 Too Many Requests`| `RATE_LIMITED` | 触发认证限流（响应头携带 `Retry-After: 60`） |
| `500 Internal Error` | `INTERNAL_ERROR` | 服务端未预期的系统异常 |
| `503 Service Unavail`| `SERVICE_UNAVAILABLE`| `/health` 探针检测到数据库不可达 |

---

## 2. 运维接口

### `GET /health`
- **说明**：系统存活与健康探针，不带 `/api/v1` 前缀。
- **响应 (200 OK)**：
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "database": "sqlite",
  "gemini_mode": "simulation"
}
```

---

## 3. 认证接口 (`/api/v1/auth`)

### 3.1 `POST /api/v1/auth/register`
- **请求体**：
```json
{
  "username": "alice",
  "password": "Correct-Horse-Battery"
}
```
- **字段约束**：
  - `username`：3–32 字符，字母/数字/下划线/中划线。
  - `password`：UTF-8 编码下 12–128 字节，不做 trim。
- **响应 (201 Created)**：
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_in": 3600,
  "user": {
    "id": "e0b94723-5e66-4c4f-a9cb-6825c572cf93",
    "username": "alice",
    "created_at": "2026-11-08T01:00:00Z"
  }
}
```

### 3.2 `POST /api/v1/auth/login`
- **请求体**：同注册。
- **响应 (200 OK)**：同注册响应结构。
- **安全性保证**：用户不存在与密码错误返回完全相同的 401 响应与恒定执行时延。

---

## 4. 文档接口 (`/api/v1/documents`)

### 4.1 `GET /api/v1/documents`
- **查询参数**：
  - `limit` (int, 默认 20, 范围 1..100)
  - `offset` (int, 默认 0, 范围 >= 0)
- **响应 (200 OK)**：
```json
{
  "documents": [
    {
      "id": "d3b07384-d113-4663-8a90-349079f18e95",
      "title": "项目架构设计",
      "version": 3,
      "created_at": "2026-11-08T01:00:00Z",
      "updated_at": "2026-11-08T01:30:00Z"
    }
  ],
  "limit": 20,
  "offset": 0,
  "total": 1
}
```

### 4.2 `POST /api/v1/documents`
- **请求体**：
```json
{
  "title": "新特性规划",
  "content": "# 特性清单\n- 离线同步\n- AI 伴写"
}
```
- **响应 (201 Created)**：返回完整文档对象（`version` 初始为 1）。

### 4.3 `GET /api/v1/documents/{id}`
- **说明**：获取单篇文档完整内容。
- **响应 (200 OK)**：包含 `id`, `title`, `content`, `version`, `created_at`, `updated_at`。

### 4.4 `PUT /api/v1/documents/{id}`
- **说明**：带乐观锁更新文档。
- **请求体**：
```json
{
  "title": "新特性规划 (已评审)",
  "content": "# 特性清单 (最新版)...",
  "expected_version": 1
}
```
- **响应 (200 OK)**：
```json
{
  "id": "d3b07384-d113-4663-8a90-349079f18e95",
  "version": 2,
  "updated_at": "2026-11-08T01:40:00Z"
}
```

### 4.5 `DELETE /api/v1/documents/{id}?expected_version={version}`
- **说明**：带乐观锁删除文档。
- **响应 (204 No Content)**：成功无响应体。
- **冲突 (409 Conflict)**：版本不匹配时返回 `VERSION_CONFLICT` 与服务端当前版本。

> **规范约束说明 (Non-Goal #1)**：根据项目规范《docs/PROJECT_SPEC.md》与《docs/DATABASE.md》，MVP 阶段明确排除修订历史（Revisions）表与端点。核心文档接口严格限定为上述 5 个端点。

---

## 5. Gemini 3.8 Flash AI Copilot 接口 (`/api/v1/ai`)

所有 AI 接口均需通过 JWT 认证，支持在线与离线仿真双模式：

### 5.1 `POST /api/v1/ai/complete` (智能续写)
- **请求体**：
```json
{ "prompt": "## 系统高可用性\n在容灾方面，", "max_tokens": 256 }
```
- **响应 (200 OK)**：
```json
{
  "result": "我们采用多副本主动复制策略...",
  "model": "gemini-2.0-flash",
  "usage_tokens": 42,
  "simulated": false
}
```

### 5.2 `POST /api/v1/ai/polish` (排版与语法润色)
- **请求体**：`{ "content": "待润色 Markdown 正文", "instruction": "学术风格" }`
- **响应**：润色后的精美 Markdown 文本。

### 5.3 `POST /api/v1/ai/summarize` (核心摘要提取)
- **请求体**：`{ "content": "文档全文", "format": "bullet_points" }`
- **响应**：结构化摘要与行动建议。

### 5.4 `POST /api/v1/ai/diagram` (Mermaid 图表推导)
- **请求体**：`{ "description": "系统分层架构描述", "diagram_type": "flowchart" }`
- **响应**：合法的 ````mermaid 代码块。

### 5.5 `POST /api/v1/ai/math` (LaTeX 公式构建)
- **请求体**：`{ "description": "带正则化惩罚项的均方误差损失函数" }`
- **响应**：KaTeX 兼容的 `$$...$$` 公式。

### 5.6 `POST /api/v1/ai/chat` (文档上下文智能问答)
- **请求体**：
```json
{
  "message": "请问当前文章提到了哪些并发解决方案？",
  "document_context": "# 文档正文...",
  "history": []
}
```
- **响应**：基于文章精准上下文的解答。
