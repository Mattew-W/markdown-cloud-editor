# `api.js` 接口说明

HTTP API 客户端。零 DOM、不读写存储、不保存令牌、不自动重试。

| 项 | 值 |
| --- | --- |
| 位置 | `frontend/js/api.js` |
| 契约来源 | [`docs/INTERFACES.md`](../../docs/INTERFACES.md) §C8（冻结）、[`docs/API.md`](../../docs/API.md) §1/§4 |
| 模块形式 | ES Module，全部具名导出 |
| 运行环境 | Node ≥ 18（浏览器 ES2020+） |

---

## 1. 快速开始

```js
import { apiFetch, AuthError, VersionConflictError } from './api.js';

try {
  const doc = await apiFetch(`/documents/${id}`, { token });
  console.log(doc.content);
} catch (err) {
  if (err instanceof VersionConflictError) {
    // 冲突：err.serverVersion 是服务端当前版本
  } else if (err instanceof AuthError) {
    // 登录失效：暂停重试，跳转登录
  } else {
    console.error(err.message);
  }
}
```

---

## 2. 导出清单

### 2.1 常量

| 名称 | 类型 | 值 | 说明 |
| --- | --- | --- | --- |
| `BASE_URL` | `string` | `'/api/v1'` | API 前缀。**唯一来源**，勿在别处硬编码 |
| `TIMEOUT_MS` | `number` | `10000` | 请求超时（毫秒） |

### 2.2 主函数

```js
apiFetch(path, {
  method = 'GET',
  token,
  body,
  fetchImpl = globalThis.fetch,
  timers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout },
} = {})
```

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | `string` | API 相对路径，须以单个 `/` 开头，如 `'/documents'` |
| `method` | `string` | HTTP 方法，默认 `'GET'` |
| `token` | `string` | 访问令牌。**只放入 `Authorization: Bearer` 头，不进 URL** |
| `body` | `unknown` | 请求体。**不为 `undefined` 时**才 JSON 序列化并设 `Content-Type` |
| `fetchImpl` | `Function` | 注入的 fetch 实现，测试用 |
| `timers` | `object` | 注入的定时器，测试用（避免真等 10 秒） |

**返回值**

| 响应 | 返回 |
| --- | --- |
| `200` / `201` | 解析后的 JSON |
| `204` | `null`（**不调用 `response.json()`**） |

**`path` 限制**（违反抛 `ProtocolError`，且**不发出请求**）

- 须以单个 `/` 开头
- 禁止完整外域 URL（`https://...`）
- 禁止协议相对 URL（`//...`）
- 禁止已带 `/api/v1` 前缀（会重复拼接）

**`GET` 不接受 `body`**（传了抛 `ProtocolError`）。

### 2.3 错误类

全部继承 `ApiError`，保留 `status` / `code` / `details` / `requestId`。

| 类 | 触发 | 额外字段 |
| --- | --- | --- |
| `ApiError` | 基类；未知 `error.code` 也归此类 | — |
| `ProtocolError` | 响应不符合冻结协议：JSON 损坏、字段缺失、`server_version` 非法、路径非法、序列化失败 | — |
| `InvalidInputError` | `BAD_REQUEST`（400） | — |
| `AuthError` | `UNAUTHORIZED`（401）；401 无可读 JSON 时也归此类 | — |
| `NotFoundError` | `NOT_FOUND`（404） | — |
| `ConflictError` | `USERNAME_TAKEN`（409） | — |
| `VersionConflictError` | `VERSION_CONFLICT`（409） | `serverVersion: number` |
| `TooLargeError` | `PAYLOAD_TOO_LARGE`（413） | — |
| `RateLimitedError` | `RATE_LIMITED`（429） | `retryAfter: string \| null` |
| `ServiceUnavailableError` | `SERVICE_UNAVAILABLE`（503） | — |
| `ServerError` | `INTERNAL_ERROR`（500） | — |
| `TimeoutError` | 超过 `TIMEOUT_MS` | — |
| `NetworkError` | 网络层失败（连接被拒、DNS 失败等） | — |

**`error.code` → 类的映射**（按 `code` 分支，**绝不按 `message`**）：

| `error.code` | HTTP | 类 |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | `InvalidInputError` |
| `UNAUTHORIZED` | 401 | `AuthError` |
| `NOT_FOUND` | 404 | `NotFoundError` |
| `USERNAME_TAKEN` | 409 | `ConflictError` |
| `VERSION_CONFLICT` | 409 | `VersionConflictError` |
| `PAYLOAD_TOO_LARGE` | 413 | `TooLargeError` |
| `RATE_LIMITED` | 429 | `RateLimitedError` |
| `SERVICE_UNAVAILABLE` | 503 | `ServiceUnavailableError` |
| `INTERNAL_ERROR` | 500 | `ServerError` |

**未知 `code`** → 归基类 `ApiError`，**保留 `status` 与 `code`**，不抛未捕获异常。

---

## 3. 上层动作对照

来自 [`docs/SYNC.md`](../../docs/SYNC.md) §6 的分支约定：

| 错误 | 上层动作 |
| --- | --- |
| `InvalidInputError` / `TooLargeError` | 进 `invalid`，交用户修正 |
| `AuthError` | 进 `auth_required`，**暂停重试** |
| `NotFoundError` | 按 SYNC.md §6.2 分支 ④ 处理 |
| `VersionConflictError` | 进 `conflict`，用 `err.serverVersion` 与云端内容 |
| `RateLimitedError` | 用 `err.retryAfter` 决定退避时长（**本层不解析**） |
| `ServiceUnavailableError` / `ServerError` | 按「结果未知」核对，**不直接判定未保存** |
| `TimeoutError` | 按「结果未知」核对，**不直接判定未保存** |
| `NetworkError` | 按「结果未知」核对 |

> **`TimeoutError` 与 `NetworkError` 不等于"服务器没保存"。**
> 请求可能已到达服务端并完成写入，只是响应没回来。必须按 SYNC.md §6 的「结果未知」流程核对云端状态。

---

## 4. 行为约束

### 4.1 硬约束（违反即返工）

1. **零 DOM** —— 不读写任何 DOM 节点，不绑定任何事件
2. **base URL 单一常量** —— `BASE_URL`，不硬编码在多个文件
3. **按 `error.code` 映射** —— 绝不按 `error.message` 分支
4. **204 先判 `status === 204` 并 `return null`** —— 禁止调用 `response.json()`
5. **非 2xx 先查 `content-type`** —— 确认是 JSON 再解析
6. **10 秒 `AbortController` 超时** —— 计时范围覆盖 fetch 与响应体读取

### 4.2 两条禁令

**禁令一：不得构造绝对 URL。**

```js
// ✗ 错：请求会发往 dummy-base 这个不存在的外域
const url = new URL(`${BASE_URL}${path}`, 'http://dummy-base');

// ✓ 对：相对路径直传，由浏览器按当前页面 origin 解析
const url = `${BASE_URL}${path}`;
```

真实浏览器实测后者不会请求到错误域名；前者报 `net::ERR_NAME_NOT_RESOLVED`。
**mock 测试容易掩盖这个错误**——`URL.pathname` 恰好正确，但最终目的地是错的。断言时应断言传入值本身是字符串。

**禁令二：协议字面量必须为纯 ASCII。**

HTTP 头名（`Content-Type`、`Retry-After`）、错误码枚举等按精确字符串匹配的标识符必须是 ASCII。
U+2011 NON-BREAKING HYPHEN（`‑`）视觉与 ASCII `-` 几乎相同，但会让 `Headers` 构造抛：

```
TypeError: Cannot convert argument to a ByteString because the character at
index 9 has a value of 8209 which is greater than 255.
```

**语法检查发现不了，只有真实执行才暴露。** 测试套件中有守卫用例持续检查。

### 4.3 其他行为

- **不自动重试** —— 任何失败都只发一次请求
- **不保存令牌** —— 模块不访问 `sessionStorage`，令牌由调用方每次传入
- **错误文案一律中文** —— 不透出 `e.message` 等原始异常
- **非法路径与序列化失败不发出请求** —— 在构造请求前就抛错
- **定时器必清理** —— 成功、业务失败、解析失败、网络失败四条路径都走 `finally`

---

## 5. 测试

```sh
cd frontend
npm test              # 全部前端测试
npm run test:api      # 仅 api.js
npm run test:log      # 生成 test-output.log（真实 TAP 原文）
```

测试全部使用 mock fetch，**不访问真实后端**。超时用注入的可控时钟，**不会真的等 10 秒**。

覆盖：200/201/204、URL 构造、Bearer 位置、JSON body、九类 `code` 映射、两种 409、`serverVersion` 校验、`Retry-After` 保留、坏响应（HTML / 损坏 JSON / 未知 code / 401 无 JSON）、超时边界（9999ms 不中断、10000ms 中断）、四条路径的定时器清理、不自动重试、非法路径与序列化失败不发请求、ASCII 守卫。

> **mock 的局限**：`URL.pathname` 断言无法验证请求最终发往哪个域。
> 真实浏览器验证过一次：`new URL(path, 'http://dummy-base')` 会报 `ERR_NAME_NOT_RESOLVED`。

---

## 6. 未覆盖范围

| 项 | 归属 | 说明 |
| --- | --- | --- |
| 与真实后端联调 | M1 | `/documents` 路由尚未实现（`API.md` §8 阶段 4） |
| `GET /health` | — | **不带 `/api/v1` 前缀**，不属于本模块范围 |
| 与 `sync.js` 接线 | M1 | 见 `INTERFACES.md` §4.4 |
