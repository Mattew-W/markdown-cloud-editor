# API 契约（HTTP）

| 项 | 值 |
| --- | --- |
| 文档状态 | **已冻结**（Frozen） |
| 冻结日期 | 2026-10-21 |
| 规范依据 | 项目规范 §06（v1.2） |
| 实现状态 | **阶段 3 已实现认证接口**（`src/routes/auth.rs`）；`documents` 路由阶段 4 |
| 相关文档 | [`DATABASE.md`](DATABASE.md)、[`INTERFACES.md`](INTERFACES.md)、[`SYNC.md`](SYNC.md)、[`ARCHITECTURE.md`](ARCHITECTURE.md) |

> **本文档取代先前的英文占位稿。** 旧稿自述 "proposals / not implemented endpoints"，
> 且写有 `403`、`412` 与"可选 `document_revisions`"等与规范 §06 冲突的表述，已废弃。
> 凡本表与旧稿不一致，以本表为准。

---

## 1. 通用约定

| 项 | 规定 |
|---|---|
| API 前缀 | `/api/v1` |
| 字段命名 | `snake_case` |
| ID 格式 | UUID，JSON 中以**字符串**表示 |
| 时间格式 | UTC **RFC 3339** 字符串 |
| 响应体 | 除 `204` 外，成功与错误响应**均为 JSON** |
| 认证 | `Authorization: Bearer <token>`。**JWT 不得放入 URL** |
| 内容类型 | 请求与响应 `application/json` |
| `owner_id` | **只能来自服务端验证后的身份**。客户端不得指定或改变文档所有者 |
| 越权处理 | 不存在或不属于本人，**统一返回 404**，且不泄露标题/版本/正文 |
| 非法 UUID | 统一 `400`（由 Path/Query/Json 错误处理器统一返回） |
| 安全 | 部署环境启用 TLS；响应附 CSP；**不得**记录密码、token、连接串或完整正文 |

---

## 2. 接口清单

| 方法 | 路由 | 成功码 | 说明 |
|---|---|---|---|
| GET | `/health` | 200 | 运维探针，**不带** `/api/v1` 前缀 |
| POST | `/api/v1/auth/register` | 201 | 注册并直接返回 token |
| POST | `/api/v1/auth/login` | 200 | 登录 |
| GET | `/api/v1/documents` | 200 | 列表，**不含正文** |
| POST | `/api/v1/documents` | 201 | 创建，`version = 1` |
| GET | `/api/v1/documents/{id}` | 200 | 单篇，含正文 |
| PUT | `/api/v1/documents/{id}` | 200 | 更新，带乐观锁 |
| DELETE | `/api/v1/documents/{id}` | 204 | 删除，**无响应体** |

---

## 3. 请求与响应明细

### 3.1 `POST /api/v1/auth/register`

请求：

```json
{ "username": "alice", "password": "Correct-Horse-Battery" }
```

成功 `201`：

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_in": 3600,
  "user": { "id": "0f8e...", "username": "alice", "created_at": "2026-10-21T09:00:00Z" }
}
```

> `user` **只含** `id` / `username` / `created_at`，不含 `password_hash`。

### 3.2 `POST /api/v1/auth/login`

请求同注册。成功 `200`，响应结构同注册。

**失败一律 `401`**，且用户不存在与密码错误**返回完全相同的响应体与状态码**。

> 实现要点（`src/routes/auth.rs`）：两者耗时也必须相近。
> 用户不存在时对**预计算的虚拟哈希**做恰好一次 Argon2 校验，
> 使两个分支的运算次数相同。若写成"现算哈希 + 再校验一次"，是**两次**运算，
> 会把本该消除的用户名枚举**变成可测的时序信道**。

### 3.3 `GET /api/v1/documents`

| 查询参数 | 类型 | 默认 | 范围 |
|---|---|---|---|
| `limit` | integer | `20` | `1`–`100` |
| `offset` | integer | `0` | `>= 0` |

成功 `200`：

```json
{
  "documents": [
    { "id": "0f8e...", "title": "未命名文档", "version": 3, "created_at": "...", "updated_at": "..." }
  ],
  "limit": 20,
  "offset": 0,
  "total": 42
}
```

排序：`updated_at DESC, id DESC`（`id` 作次排序键保证分页稳定）。**摘要不含正文。**

### 3.4 `POST /api/v1/documents`

| 字段 | 必填 | 规则 |
|---|---|---|
| `title` | 否 | 省略 → 默认 `"未命名文档"`；显式空串 → `400` |
| `content` | 否 | 省略 → 空串；≤ 262144 字节（256 KiB） |

成功 `201`，返回 `id` / `title` / `content` / `version`（= `1`）/ `created_at` / `updated_at`。

### 3.5 `PUT /api/v1/documents/{id}`

| 字段 | 必填 | 规则 |
|---|---|---|
| `title` | **是** | 更新必须提供有效标题 |
| `content` | **是** | ≤ 262144 字节 |
| `expected_version` | **是** | `1`–`2147483647` |

成功 `200`，返回 `id` / `version` / `updated_at`（**不回传正文**）。

**乐观锁语义**：仅当 `WHERE id AND owner_id AND version = expected_version` 命中时更新。
**严禁**"先读版本、再执行无版本条件的 UPDATE"——那会让自动保存静默覆盖他人修改。

### 3.6 `DELETE /api/v1/documents/{id}`

| 查询参数 | 必填 | 规则 |
|---|---|---|
| `expected_version` | **是** | 走**查询参数**，不是请求体 |

成功 `204`，**无响应体**。

---

## 4. 状态码语义

| 状态码 | 触发条件 |
|---|---|
| `200` | 查询、更新成功 |
| `201` | 注册、创建成功 |
| `204` | 删除成功（无响应体） |
| `400` | 缺失必填、类型不符、越界（`expected_version` / `limit` / `offset`）、非法 UUID、**显式空标题** |
| `401` | 身份缺失/无效/过期；**登录失败统一 401** |
| `404` | 资源不存在**或**属于他人（二者统一，不可区分） |
| `409` | 版本冲突（`VERSION_CONFLICT`）或用户名冲突（`USERNAME_TAKEN`） |
| `413` | 正文 > 262144 字节，**或** JSON 请求体 > 2 MiB |
| `429` | 触发限流。**必须**遵循 `Retry-After` |
| `500` | 服务端内部错误 |
| `503` | `/health` 探测到数据库不可用 |

### 4.1 错误响应结构

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "文档已被其他会话修改",
    "details": { "server_version": 7 },
    "request_id": "9f3c2e1a-..."
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `code` | 是 | 稳定英文枚举，**客户端可据此判断行为** |
| `message` | 是 | 仅供显示。**客户端不得依赖文字内容**做逻辑分支 |
| `details` | 否 | 可选对象。**仅 `VERSION_CONFLICT` 必须含 `server_version`** |
| `request_id` | 是 | 关联 `X-Request-Id` 响应头，用于排障 |

**错误码字面量**：`BAD_REQUEST` / `UNAUTHORIZED` / `NOT_FOUND` / `USERNAME_TAKEN` /
`VERSION_CONFLICT` / `PAYLOAD_TOO_LARGE` / `RATE_LIMITED` / `SERVICE_UNAVAILABLE` / `INTERNAL_ERROR`。

> 响应**不得**包含 SQL 语句、凭据、连接串或内部堆栈（规范 §09）。

---

## 5. 输入校验规则（应用层为主，数据库兜底）

| 字段 | 规则 | 校验层 |
|---|---|---|
| `username` | 去首尾空白 → 转小写；字符集 `[a-z0-9_-]`；长度 `3`–`32` | 应用层；DB 有格式 CHECK 兜底 |
| `password` | **不 trim**；按 **UTF-8 字节** `12`–`128` | 仅应用层（哈希长度≠密码长度，DB 不能补这个 CHECK） |
| `title` | 按 **Unicode 标量值**计数；去首尾空白后 `1`–`255` | 应用层（`char::is_whitespace()`）；DB 用显式空白列表兜底 |
| `content` | ≤ **262144 字节**（256 KiB），允许空串 | 应用层；DB 用 `octet_length` 兜底 |
| `expected_version` | `1`–`2147483647` | 应用层 |
| JSON 请求体 | ≤ **2 MiB** | 框架层 `JsonConfig::limit` |

> **关于密码长度口径**：`12`–`128` 是**字节**而非字符。8 个中文字符 24 字节（合规），
> 12 个 emoji 48 字节。按字符计会放过 8–11 字节的弱密码，或错杀 12 字节的强密码。

---

## 6. 限流

| 接口 | 策略 | 超限响应 |
|---|---|---|
| `POST /auth/register` | 每 IP 每 `60` 秒 `5` 次 | `429` + `Retry-After: 60` |
| `POST /auth/login` | 每 IP 每 `60` 秒 `5` 次 | `429` + `Retry-After: 60` |

> `Retry-After` 客户端**必须**遵循（规范 §08）。

---

## 7. JWT

| 项 | 规定 |
|---|---|
| 算法 | **HS256**，固定 |
| 密钥 | ≥ 32 字节高熵。**启动时校验**，缺失或为占位值则拒绝启动 |
| 载荷 | `exp` / `sub`（user id）/ `iss` / `aud`，**四者全部校验** |
| 有效期 | **1 小时**（`expires_in` 以秒为单位回传） |
| 传输 | 仅 `Authorization: Bearer`；前端存 **sessionStorage** |

> 调参会改变参数，但 `password-hash` 的 `PasswordVerifier` 会**沿用哈希串自带的
> algorithm/version/params**，故历史哈希不会因调参失效。

---

## 8. 实施进度

| 接口 | 状态 |
|---|---|
| `GET /health` | ✅ 已实现（DB 不可达返回 503，不谎报健康） |
| `POST /auth/register` | ✅ 已实现（Argon2id 经 `web::block` 卸载） |
| `POST /auth/login` | ✅ 已实现（虚拟哈希对齐时序） |
| `/documents` 全部 | ⬜ 阶段 4，依赖 M4 的 document service |
| 限流 | ⬜ 已定参数，待实现 |
