# 冻结接口契约（M3 `password.rs` / M6 `drafts.js`）

| 项 | 值 |
| --- | --- |
| 文档状态 | **已冻结**（Frozen） |
| 冻结日期 | 2026-10-20 |
| 目的 | **防止 M6 二次返工。** 缺任一项契约，M6 的 W2 交付必然再次被打回 |
| 契约责任方 | M1（负责人） |
| 消费方 | M6（`drafts.js`、`api.js`）、M3（`password.rs`）、M1（接线） |
| 来源 | M3 交件 v2、M6 W1 审核记录 §7.1（C1–C9）、项目规范 §09/§08/§10 |
| 相关文档 | [`API.md`](API.md)、[`SYNC.md`](SYNC.md)、[`ARCHITECTURE.md`](ARCHITECTURE.md) |

---

## 0. 为什么这份文档存在

M6 W1 交件已完成范围练习，但作为正式模块判定**返工重写**，理由是**与规范存在结构性差距，可直接落地的代码行为 0%**（审核记录 §5.5）。

结构性差距的根因不是 M6 能力问题，而是**契约缺失**：M6 在没有冻结接口的情况下写代码，只能猜。猜错就要返工。

**本文档把这些猜测全部消除。** 下游实现只需照着写。

---

## 1. M3 `src/auth/password.rs` — 冻结签名

### 1.1 当前状态

| 项 | 状态 |
| --- | --- |
| 交件位置 | `GPT_WORKSPACE/deliverables/收件/W1/M3/优化后代码_M3_W1_v2/password_demo/src/password.rs` |
| 代码可用性 | **可用。** 类型化错误、参数可配置、缺 salt/hash 时不误判为密码错误 |
| `cargo fmt` | **未通过**（交件头部注释称已通过，实际未过 CI） |
| 是否已合入 `src/` | **否。** `src/auth/` 目录当前不存在 |
| 合入阶段 | **阶段 3** |

> **`cargo fmt` 未通过是硬阻塞。** CI 必检 `cargo fmt --check`（必需状态 `Rust checks`）。合入前必须跑 `cargo fmt` 并提交格式化结果。**CI 不得为此添加豁免。**

### 1.2 公开 API 冻结

模块公开以下 4 个类型与 2 个自由函数。**签名不得变更。**

```rust
// ---------- 参数 ----------

/// Argon2id 计算参数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2Params {
    /// 内存代价（KiB）。
    pub memory_kib: u32,
    /// 迭代次数。
    pub iterations: u32,
    /// 并行度（lanes）。
    pub parallelism: u32,
    /// 输出哈希长度（字节）。
    pub output_len: usize,
}

impl Default for Argon2Params {
    // memory_kib: 19_456, iterations: 2, parallelism: 1, output_len: 32
}

impl Argon2Params {
    pub fn to_params(&self) -> Result<argon2::Params, PasswordError>;
}

// ---------- 错误 ----------

#[derive(Debug)]
pub enum PasswordError {
    InvalidHashFormat(String),
    IncompatibleParams(String),
    PasswordMismatch,
    HashingFailed(String),
    InvalidParams(String),
}

// ---------- 策略 ----------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyViolation {
    pub code: &'static str,      // "TOO_SHORT" | "MISSING_LETTER" | "MISSING_DIGIT"
    pub message: String,
}

#[derive(Debug, Clone, Copy)]
pub struct PasswordPolicy {
    pub min_length: usize,       // Default: 8
    pub require_letter: bool,    // Default: true
    pub require_digit: bool,     // Default: true
}

impl Default for PasswordPolicy {
    // min_length: 8, require_letter: true, require_digit: true
}

impl PasswordPolicy {
    /// 按策略检查密码，返回全部违规项；全部通过返回空 Vec。
    pub fn check(&self, password: &str) -> Vec<PolicyViolation>;
}

// ---------- 核心函数 ----------

/// 用 Argon2id + 随机盐生成哈希串（PHC 格式）。
pub fn hash_password(password: &str, params: &Argon2Params) -> Result<String, PasswordError>;

/// 校验密码是否与给定哈希串匹配。
pub fn verify_password(password: &str, hash_str: &str) -> Result<(), PasswordError>;
```

### 1.3 `PasswordError` 各变体的处置（**M1 接线必须遵守**）

| 变体 | 含义 | **必须映射到** | 理由 |
| --- | --- | --- | --- |
| `PasswordMismatch` | 哈希合法，但密码不对 | **`401 UNAUTHORIZED`** | 这是**唯一的"正常失败"分支** |
| `InvalidHashFormat(String)` | 哈希串损坏、缺 `salt` 或 `hash` | **`500 INTERNAL_ERROR`** | 数据库里存在一条**无法解析的哈希**是**数据损坏**，不是用户错误 |
| `IncompatibleParams(String)` | 算法/版本/参数不兼容 | **`500 INTERNAL_ERROR`** | 同上 |
| `HashingFailed(String)` | 底层哈希计算失败 | **`500 INTERNAL_ERROR`** | 服务端故障 |
| `InvalidParams(String)` | Argon2 参数不合法 | **`500 INTERNAL_ERROR`** | 服务端配置错误 |

> **关键区别**：`InvalidHashFormat` **绝不能**映射成 `PasswordMismatch`。若混淆，登录失败率会异常升高且无法排查——用户会以为密码错了，实际上是库里那条哈希坏了。
>
> `500` 的响应 `message` 恒为 `"服务器内部错误"`，内部细节只写日志（`src/error.rs:197`）。

### 1.4 M1 接线规则（不属于 M3 范围）

以下由 **M1** 实现，M3 **不得**触碰：

| 规则 | 说明 |
| --- | --- |
| **哈希与验证放入受限阻塞任务池** | 规范 §09。限制同时计算数量，**避免阻塞 actix HTTP 工作线程**。M3 只提供纯函数，**不做线程池** |
| **Argon2 参数从 `config.rs` 读取** | 不写死。M3 的 `Argon2Params::default()` 是**库默认值**，不代表生产参数 |
| **虚拟哈希验证** | 用户名不存在时也执行一次 `hash_password`，降低响应时间差异（规范 §09）。**这是 M1 的 auth service 责任** |
| **不存明文、不打日志** | M3 已遵守（交件全程无明文打印）。M1 接线时同样禁止把 `password` 写入日志 |
| **保存完整 PHC 串** | 直接把 `hash_password` 的返回值存入 `users.password_hash`，**不要二次加工** |

### 1.5 密码长度校验的唯一位置

**密码长度 12–128 UTF-8 字节只能在应用层校验，在 `POST /auth/register` 的 DTO 校验中完成。**

> **M3 的 `PasswordPolicy::default()`（min_length = 8）与本项目要求的 12 不一致。**
>
> `PasswordPolicy` 是 M3 交件中**预置的选做项**，用于"改密接口"的策略扩展。**首版 `POST /auth/register` 的密码校验规则是 12–128 UTF-8 字节**（见 [`API.md`](API.md) §1.3），**不走 `PasswordPolicy`**。
>
> M1 接线时若误用 `PasswordPolicy::default()`，会放过 8–11 字节的密码。**这是已知的接线陷阱，明确记录在此。**

---

## 2. M6 `frontend/js/drafts.js` — 冻结签名

### 2.1 当前状态

| 项 | 状态 |
| --- | --- |
| 交件 | `M6_W1_吴泽佳_20261025.zip`（4 文件，`drafts.js` 仅 2106 字节） |
| 审核结论 | **返工重写**。可直接落地的代码 **0%**；思路可复用约 28% |
| 重写阶段 | **W2**（M6） |
| 与 M1 的边界 | M6 只写**纯逻辑 ES Module 草稿层**（**零 DOM**）；接线、UI、sync 状态机归 M1 |

### 2.2 六条硬约束（违反即返工）

| # | 约束 | 理由 |
| --- | --- | --- |
| 1 | **零 DOM** | 模块**不读写任何 DOM 节点**，**不绑定任何事件**。使 Node 内置测试可直接验证；避免与 M5 的 `editor.js` 争抢节点 |
| 2 | **`userId` 由调用方传入** | 模块**不自行推断**当前用户 |
| 3 | **不自行读 token** | 模块**不访问 `sessionStorage` 的 token**。它连 `sessionStorage` 都不直接访问（见第 4 条） |
| 4 | **所有存储访问经注入的 `storage` 适配器** | 见 §4 |
| 5 | **必须是 ES Module 且有具名 export** | 否则 `sync.js` 无法 `import` |
| 6 | **文案错误一律中文** | 禁止把 `e.message` 直接透出 |

> 第 2、3 条合起来解决审核记录 §5.1 的首要缺陷：**跨账号草稿互相可见（隐私事故）**。若模块自己去找 token，多标签页切换账号时就会读到错误账号的草稿。**由调用方显式传入 `userId` 是唯一可靠的做法。**

### 2.3 冻结的 export 签名（全部 7 个）

```js
/**
 * 生成一次文档打开会话的 ID。
 * @returns {string} UUID v4 字符串
 */
export function createEditSessionId();

/**
 * 构造草稿键。
 * @param {{userId: string, docId: string, sessionId: string}} parts
 * @returns {string} markdown-editor:draft:{userId}:{docId}:{sessionId}
 */
export function buildDraftKey(parts);

/**
 * 解析草稿键为各段。
 * @param {string} key
 * @returns {{userId: string, docId: string, sessionId: string} | null} 非本模块键返回 null
 */
export function parseDraftKey(key);

/**
 * 写入/合并草稿。
 * @param {{userId: string, docId: string, sessionId: string,
 *          baseVersion: number, title: string, content: string,
 *          localRevision: number}} draft
 * @param {StorageAdapter} [storage] 省略时用模块默认 storage
 * @returns {{key: string, recordedAt: string}}
 * @throws {DraftStorageError}
 */
export function saveDraft(draft, storage);

/**
 * 读取单个草稿。
 * @param {string} key
 * @param {StorageAdapter} [storage]
 * @returns {DraftRecord | null}
 * @throws {DraftStorageError} reason==='corrupt' 时抛出
 */
export function readDraft(key, storage);

/**
 * 枚举指定用户（可选指定文档）的遗留草稿。
 * @param {{userId: string, docId?: string}} scope
 * @param {StorageAdapter} [storage]
 * @returns {DraftRecord[]} 按 recordedAt DESC 排序
 * @throws {DraftStorageError}
 */
export function listDrafts(scope, storage);

/**
 * 丢弃草稿——**必须先通过三重核对**。
 * @param {string} key
 * @param {{sessionId: string, localRevision: number, content: string}} expected
 * @param {StorageAdapter} [storage]
 * @returns {boolean} true=已删除；false=核对未通过，**拒绝删除**
 * @throws {DraftStorageError}
 */
export function discardDraft(key, expected, storage);

/**
 * 清理当前会话已无用的草稿（会话 ID 不匹配的旧记录）。
 * @param {{userId: string, docId: string, sessionId: string}} parts
 * @param {StorageAdapter} [storage]
 * @returns {{removed: string[]}} 被删除的键
 * @throws {DraftStorageError}
 */
export function clearSessionDrafts(parts, storage);

/**
 * 纯函数：判定草稿恢复分支。
 * @param {DraftRecord} draft
 * @param {{title: string, content: string, version: number}} cloud
 * @returns {'confirm' | 'adopt_cloud' | 'conflict'}
 */
export function classifyRestore(draft, cloud);
```

> **`classifyRestore` 是选做项。** 若 M6 不实现，由 M1 在集成期补写。**它必须是纯函数，只做判定不做 UI。**

### 2.4 存储适配器（`StorageAdapter`）

```js
/**
 * 注入的存储适配器。
 * 必须提供与 Web Storage 一致的 getItem / setItem / removeItem / key / length。
 */
```

| 规则 | 说明 |
| --- | --- |
| **所有**存储访问经适配器 | 模块内**不得**出现 `window.localStorage` 直接引用 |
| 默认值 | 未注入时使用 `window.localStorage`（可用适配器包装后作为 default 参数） |
| **Node 测试必须能注入** | 模拟三种情形：**存储禁用**、**配额耗尽**、**值损坏** |
| 不新增能力 | 适配器接口与 Web Storage 一致，**不引入异步**（`localStorage` 是同步的） |

> **为什么必须注入**：M6 W1 的实测证明了三类存储错误在真实浏览器里都会发生（审核记录 §4 的 F2、§5.5）。**测试环境无法可靠复现"存储禁用"**，只能靠注入模拟对象。

### 2.5 `DraftStorageError`

```js
export class DraftStorageError extends Error {
  /** @type {'quota' | 'unavailable' | 'corrupt' | 'serialize'} */
  reason;
}
```

| `reason` | 触发场景 | **必须显示的中文文案** |
| --- | --- | --- |
| `quota` | 超出存储容量（`QuotaExceededError`） | 本地备份失败：存储空间不足 |
| `unavailable` | 存储被禁用（`SecurityError`，含无痕模式） | 本地备份失败：浏览器禁止本地存储 |
| `corrupt` | 读出值 JSON 解析失败，或结构校验不通过 | 本地备份已损坏，已忽略 |
| `serialize` | 写入前 `JSON.stringify` 失败（循环引用等） | 本地备份失败：内容无法序列化 |

**禁止**：`new DraftStorageError(reason, e.message)` 直接透出原始消息。审核记录 §4 的 F2 明确记录了原实现会显示浏览器的 `"The operation is insecure."`。

**全部四种 `reason` 的处置**：显示"**本地备份失败**" → **保留内存内容** → **提供 Markdown 下载**。详见 [`SYNC.md`](SYNC.md) §9.8。

### 2.6 结构校验（修复 F3）

读取草稿时**必须**校验类型，校验不过按 `corrupt` 处理，**不得静默接受**：

| 校验项 | 要求 |
| --- | --- |
| `content` | **`typeof === 'string'`**。`123` / `null` / 对象**一律拒绝**（W1 实现会把 `123` 静默转成 `"123"`、`null` 转成 `""`、对象转成 `"[object Object]"`） |
| `title` | **`typeof === 'string'`** |
| `baseVersion` | **`Number.isFinite()` 且 ≥ 1** |
| `local_revision` | **`Number.isFinite()` 且 ≥ 0** |
| `recorded_at` | **`typeof === 'string'` 且可被 `Date.parse()` 解析** |
| `user_id` / `doc_id` / `edit_session_id` | 均为非空 string |
| 键与记录**必须一致** | 键中的三段须与记录中的三段相同。**不一致即 `corrupt`** |

> W1 的另一个缺陷：`savedAt` 缺失时仍显示 `"✅读取成功，上次保存：Invalid Date"`。**校验不过就报损坏，不显示假时间。**

---

## 3. C1–C9 契约（正式冻结）

以下 9 条来自 M6 W1 审核记录 §7.1，现正式冻结为契约。**M6 的 W2 任务书直接引用本节。**

### C1 — 草稿记录 Schema

**字段（8 个，缺一不可）：**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `user_id` | string | **是** | UUID |
| `doc_id` | string | **是** | UUID |
| `edit_session_id` | string | **是** | UUID |
| `base_version` | integer | **是** | ≥ 1 |
| `title` | string | **是** | 允许空串？**否**——标题非空白由 §2.6 的校验与上游保证 |
| `content` | string | **是** | **允许空串** |
| `local_revision` | integer | **是** | ≥ 0 |
| `recorded_at` | string | **是** | **ISO 8601 UTC，如 `"2026-10-20T08:45:12Z"`** |

> **⚠ `recorded_at` 用 ISO 8601 UTC 字符串，不用 `Date.now()` 数字。**
>
> 理由：(1) 数字毫秒时间戳无时区信息，跨时区展示会错；(2) 字符串在 `localStorage` 里可直接阅读，排查问题方便；(3) 与后端 `TIMESTAMPTZ` 的序列化形式一致。
>
> `recorded_at` **只用于展示**。恢复判断以 `base_version` 与 `content` 为依据（[`SYNC.md`](SYNC.md) §9.7）。

**落盘形态（snake_case）：**
```json
{
  "user_id": "6f1a3c2e-8b5d-4a71-9f0e-2d3c4b5a6e7f",
  "doc_id": "b2e9d4f1-0c3a-4e5b-8d7a-1f2e3d4c5b6a",
  "edit_session_id": "c3d5e7a9-1b2f-4c8d-9e0a-3f4c5d6e7f8a",
  "base_version": 3,
  "title": "课程笔记",
  "content": "# 课程笔记\n\n第一段落。",
  "local_revision": 7,
  "recorded_at": "2026-10-20T08:45:12Z"
}
```

> **注意命名不一致是刻意的**：落盘用 **snake_case**（与后端 API 字段、[`API.md`](API.md) §1.1 一致）；JS 函数**入参**用 **camelCase**（JS 惯例）。转换发生在 `saveDraft` / `readDraft` 内部，**调用方不需要关心**。

### C2 — 键生成规则

```
markdown-editor:draft:{userId}:{docId}:{sessionId}
```

| 规则 | 说明 |
| --- | --- |
| 前缀 | `markdown-editor:draft:` 固定 |
| 分隔符 | `:` |
| **各段做分隔符安全编码** | 防止段内含 `:` 破坏解析。UUID 本身不含 `:`，编码保证的是**防御性**与未来扩展 |
| **`parseDraftKey()` 必须提供** | 供 `listDrafts` 枚举。**非本模块键必须返回 `null`，不得抛异常** |

**实现建议（不强制）**：若各段经校验均为合法 UUID，可直接拼接。若不做校验，必须用 `encodeURIComponent` 之类的编码，并在 `parseDraftKey` 中对应解码。**`buildDraftKey` 与 `parseDraftKey` 的编码/解码必须严格互逆。**

**枚举前缀**：按 `markdown-editor:draft:{userId}:` 前缀扫描，**避免遍历全部 `localStorage`**（可能包含其他应用的键）。

### C3 — `edit_session_id`

| 项 | 规则 |
| --- | --- |
| 生成 | **`crypto.randomUUID()`** |
| 作用域 | **一次文档打开会话** |
| 切换文档 | **必重新生成** |
| 跨用户 | **不复用** |
| 跨标签页 | **不复用** |

**不可用时的降级**：若环境无 `crypto.randomUUID()`，**M6 的实现可以抛错**（测试环境应提供 polyfill 或 stub）。**不允许退回 `Math.random()`**——会话 ID 会进草稿键，弱随机会让枚举与碰撞行为不可预测。

### C4 — `drafts.js` 导出签名

见 §2.3。

**必须包含**：零 DOM、`userId` 由调用方传入、不自行读 token。详见 §2.2。

### C5 — 存储适配器注入

见 §2.4。

**Node 测试必须能模拟三件事**：

| # | 情形 | 预期 |
| --- | --- | --- |
| 1 | **存储禁用**（`SecurityError`） | 抛 `DraftStorageError`，`reason === 'unavailable'` |
| 2 | **配额耗尽**（`QuotaExceededError`） | 抛 `DraftStorageError`，`reason === 'quota'` |
| 3 | **值损坏**（JSON 非法 / 结构不符） | 抛 `DraftStorageError`，`reason === 'corrupt'` |

### C6 — 错误类型

见 §2.5。**禁止把 `e.message` 直接透出。**

### C7 — sync 协调器接口

**M1 实现 `sync.js`，M6 只订阅，不驱动状态机。**

| 接口 | 方向 | 说明 |
| --- | --- | --- |
| `onInput` | sync → 界面 | 用户输入/标题修改。**每次 +1 `local_revision`** |
| `getBaseVersion` | sync → 界面 | 取当前 `base_version` |
| `onSaveConfirmed` | sync → 界面 | 服务端已确认某修订。**传 `acked_revision` 与新 `base_version`** |
| `onConflict` | sync → 界面 | 进入 `conflict`。**传 `server_version` 与云端内容** |

**M6 的 `drafts.js` 不实现也不调用这四个接口。** 它们属于 `sync.js`（M1）与 `editor.js`（M5）之间。M6 只需确保草稿层**可以被 `sync.js` 调用**。

### C8 — `api.js` 契约

| 项 | 规则 |
| --- | --- |
| **base URL 来源** | 单一常量。**不硬编码在多个文件**。须与 [`API.md`](API.md) 的 `/api/v1` 前缀一致 |
| **错误码 → JS 错误映射** | **按 `error.code` 映射，不按 `error.message`**。9 个字面量见 [`API.md`](API.md) §1.5 |
| **`AbortController` 超时** | **10 秒**（与 [`SYNC.md`](SYNC.md) §2 一致） |
| **204 不调 `response.json()`** | **必须**先判 `response.status === 204` 并 `return null` |
| **先查 `Content-Type`** | 任何非 2xx 响应，先 `response.headers.get('content-type')` 确认是 JSON 再解析 |

**`error.code` → 建议的 JS 错误分类：**

| `error.code` | HTTP | 建议的 JS 错误类别 | 上层动作 |
| --- | --- | --- | --- |
| `BAD_REQUEST` | 400 | `InvalidInputError` | 进 `invalid`，交用户修正 |
| `UNAUTHORIZED` | 401 | `AuthError` | 进 `auth_required`，**暂停重试** |
| `NOT_FOUND` | 404 | `NotFoundError` | 见 [`SYNC.md`](SYNC.md) §6.2 分支 ④ |
| `USERNAME_TAKEN` | 409 | `ConflictError` | 注册页提示换名 |
| `VERSION_CONFLICT` | 409 | `VersionConflictError` | 进 `conflict`，**携带 `details.server_version`** |
| `PAYLOAD_TOO_LARGE` | 413 | `TooLargeError` | 进 `invalid`，**暂停重试** |
| `RATE_LIMITED` | 429 | `RateLimitedError` | **携带 `Retry-After`** |
| `SERVICE_UNAVAILABLE` | 503 | `ServiceUnavailableError` | 按「结果未知」核对 |
| `INTERNAL_ERROR` | 500 | `ServerError` | 按「结果未知」核对 |

### C9 — 草稿与保存状态机的关系

| 项 | 规则 |
| --- | --- |
| **定位** | **草稿是兜底，自动保存是主路径。** |
| **硬约束** | **草稿写入成功不得改变 `synced` / `dirty` 判定** |
| **文案硬约束** | 草稿成功**只能**显示"已在本地备份"，**禁止**显示"已同步""保存成功""已保存" |

> **这是 M6 W1 交件的语义风险最高一条**（审核记录 §5.2）：`drafts.js:19` 的文案是 `"✅保存成功，保存时间：…"`。规范 §08:349 明文禁止。本地备份成功显示成云端保存成功，会让用户在没真正上云时关闭浏览器。**W2 第一条必须纠正。**

**完整规则见 [`SYNC.md`](SYNC.md) §4.4「文案禁令」。**

---

## 4. M6 W2 验收清单

> **来源**：审核记录 §7.2。以下为 M6 W2 的交付要求，M1 收件时逐条核对。

### 4.1 必做

| # | 项 | 完成标准 |
| --- | --- | --- |
| 1 | **重写为纯逻辑 ES Module 草稿层** | 零 DOM；§2.3 七个签名齐全；三元组键；八字段记录；250 毫秒合并写入；遗留草稿枚举；清理前三重核对；三类存储错误分类 |
| 2 | **Node 内置测试** | 键生成与解析；**user/doc 隔离（两 user 枚举互不可见）**；多会话并存；250 毫秒合并（**可控时钟**）；清理三重核对**拒绝误删**；`quota` / `unavailable` / `corrupt` |
| 3 | **真实检查记录** | 贴**实际执行命令与完整输出**；浏览器版本填**真实值**；未跑的写"未运行" |

### 4.2 检查记录的两条格式硬要求

> **来源**：审核记录 §7.2「必做 3 补充」。这两条源自 D2 事故（组员把读取分支文案误记为保存分支）。

**要求 1 — 每条记录写成「动作 + 输出 + 断言」三者成对。**

> **教训**：光贴 `读取成功，上次保存：2026/10/20 12:38:44` 无法自证属于保存还是读取，**因为两个分支的时间戳完全同源恒等**（都来自草稿里的 `savedAt`）。写成三元组后，抄错分支会当场自相矛盾，**不必等第三方复跑才发现**。

**要求 2 — 禁用「未执行项：无」这个写法。**

> **强制列出未执行清单**（哪怕为空也要写清单标题）。**空清单 = 不可信。** 这是最省事的自动检测点。

### 4.3 自动检测器（已交付，可直接用）

```sh
node tools/check_record.js "<检查记录.md路径>"   # 单文件
node tools/check_record.js "<目录>"             # 递归扫描所有 检查记录*.md
```

退出码：`0` = 无问题 / `1` = 有问题 / `2` = 用法错误。可直接挂 CI。

检测 5 类：版本占位符、空清单（`未执行项：无` 判高危）、标题转义失效、**抄错分支（按用例块判定）**、疑似未覆盖场景（关键词缺失，仅提示）。

**双向回归已验证**：合规对照样本 → 0 处问题，退出码 0（**不误报**）；M6 W1 真实收件 → 4 处问题，退出码 1（**全部命中**）。

### 4.4 M6 明确不做（属 M1 集成期）

| 项 | 归属 |
| --- | --- |
| 退出账号提示 | **M1** |
| Markdown 下载兜底 | **M1** |
| 遗留草稿选择界面（UI） | **M1** |
| `edit_session_id` 与 `sync.js` 的接线 | **M1** |

### 4.5 前置依赖

**M5 的 `frontend/package.json` 与 `npm test` 脚本须先就位**，否则 M6 无处跑测试。

W2 任务书须写明"测试脚本待 M5 工具链就绪后追加"，**避免两份 `package.json`**。

---

## 5. 冻结签名清单速查

### 5.1 M3 `src/auth/password.rs`（阶段 3 合入）

```rust
pub struct Argon2Params { pub memory_kib: u32, pub iterations: u32,
                          pub parallelism: u32, pub output_len: usize }
impl Default for Argon2Params                                    // 19456 / 2 / 1 / 32

pub fn (Argon2Params)::to_params(&self) -> Result<Params, PasswordError>

pub enum PasswordError { InvalidHashFormat(String), IncompatibleParams(String),
                         PasswordMismatch, HashingFailed(String), InvalidParams(String) }

pub struct PolicyViolation { pub code: &'static str, pub message: String }
pub struct PasswordPolicy { pub min_length: usize, pub require_letter: bool,
                            pub require_digit: bool }
impl Default for PasswordPolicy                                  // 8 / true / true
pub fn (PasswordPolicy)::check(&self, password: &str) -> Vec<PolicyViolation>

pub fn hash_password(password: &str, params: &Argon2Params) -> Result<String, PasswordError>
pub fn verify_password(password: &str, hash_str: &str) -> Result<(), PasswordError>
```

### 5.2 M6 `frontend/js/drafts.js`（阶段 5 / W2 重写）

```js
// 会话与键
export function createEditSessionId();
export function buildDraftKey(parts);          // {userId, docId, sessionId} -> string
export function parseDraftKey(key);            // string -> parts | null

// 存取
export function saveDraft(draft, storage);     // draft -> {key, recordedAt}   250ms 合并
export function readDraft(key, storage);       // -> DraftRecord | null
export function listDrafts(scope, storage);    // {userId, docId?} -> DraftRecord[]

// 清理（必须三重核对）
export function discardDraft(key, expected, storage);
//   expected = {sessionId, localRevision, content}  -> boolean
export function clearSessionDrafts(parts, storage);   // -> {removed: string[]}

// 纯判定（选做）
export function classifyRestore(draft, cloud);
//   -> 'confirm' | 'adopt_cloud' | 'conflict'

// 错误
export class DraftStorageError extends Error { reason; }
//   reason: 'quota' | 'unavailable' | 'corrupt' | 'serialize'
```

---

## 6. 不在本文档范围内的内容

| 项 | 归属文档 |
| --- | --- |
| HTTP 端点、状态码、错误体 | [`API.md`](API.md) |
| 状态机、退避、四分支、草稿语义规则 | [`SYNC.md`](SYNC.md) |
| 表结构、原子更新 SQL | [`DATABASE.md`](DATABASE.md) |
| 分层、模块边界、目录树 | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| JWT 签发/验签（`src/auth/jwt.rs`） | 阶段 3 实现，**本文档未冻结**（M3 交付后另行补入） |
| `src/auth/extractor.rs` 的 `FromRequest` 实现细节 | 阶段 3，**本文档未冻结** |

> **JWT 与 extractor 未冻结的原因**：这两项 M3 的 W1 交件未覆盖，待阶段 3 交付后再补入本文档。**不写占位签名**——编造未实现的函数比留空更危险。

---

## 7. 变更流程

本文档冻结的是**函数签名与数据结构**，属于强契约。

**变更任一签名属于破坏性变更**，必须：

1. 在 `docs/DECISIONS.md` 记录原因、替代方案、影响范围
2. **同时**通知 M3、M6、M1 三方
3. 走 PR 审核，通过 `Rust checks` 与 `Frontend checks`

**特别地**：`drafts.js` 的签名是 M6 W2 的**直接施工依据**。**M1 不得在 M6 开发中途单方面改动签名**——那会直接导致返工，正是本文档要防止的情况。

### 版本记录

| 版本 | 日期 | 变更 | 记录人 |
| --- | --- | --- | --- |
| 1.0 | 2026-10-20 | 首次冻结。M3 `password.rs` 签名与错误映射、M6 `drafts.js` 七个 export 与存储适配器、C1–C9 契约、M6 W2 验收清单 | M1 |