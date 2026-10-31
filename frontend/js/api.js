/**
 * api.js —— HTTP API 客户端（M6 W2 正式实现）
 *
 * 契约来源：`docs/INTERFACES.md` §C8（已冻结，2026-10-20）+ `docs/API.md` §1.5、§4.1。
 * 本文严格按冻结契约实现，契约清单外的导出**一律不提供**。
 *
 * ## 六条硬约束（违反即返工，见 INTERFACES.md §C8）
 *
 * 1. **零 DOM** —— 不读写任何 DOM 节点，不绑定任何事件；
 * 2. **base URL 单一常量** —— `BASE_URL`，不硬编码在多个文件；
 * 3. **按 `error.code` 映射** —— 绝不按 `error.message` 分支；
 * 4. **204 先判 `status === 204` 并 `return null`** —— 禁止调用 `response.json()`；
 * 5. **非 2xx 先查 `content-type`** —— 确认是 JSON 再解析；
 * 6. **10 秒 `AbortController` 超时** —— 计时范围覆盖 fetch 与响应体读取。
 *
 * ## ⚠️ 路径与 URL 禁令（本次返工新增，INTERFACES.md C8 补充）
 *
 * **传给 `fetch` 的必须是相对路径**（如 `/api/v1/documents`），
 * 由浏览器按当前页面 origin 解析。
 *
 * **禁止**写成 `new URL(path, 'http://dummy-base')` 这类拼绝对 URL 的形式——
 * 那会把请求发往 `dummy-base` 这个不存在的外域，**真实后端永远收不到请求**。
 * 该写法在 mock 测试下看似正确（`URL.pathname` 恰好对），**只有真实浏览器才暴露**。
 *
 * ## ⚠️ 协议字面量必须为纯 ASCII（本次返工新增）
 *
 * HTTP 头名（`Content-Type`、`Retry-After`）、Content-Type 匹配串等
 * 会被程序按精确字符串匹配的标识符，**必须是 ASCII**。
 *
 * U+2011 NON-BREAKING HYPHEN（`‑`）与 ASCII `-` 视觉几乎相同，
 * 但会让 `Headers` 构造直接抛：
 * `TypeError: Cannot convert argument to a ByteString ... value of 8209`。
 * **语法检查无法发现，只有真实执行才暴露。**
 *
 * @module api
 */

/** API 前缀。与 `docs/API.md` §1.5 一致，唯一来源。 */
export const BASE_URL = '/api/v1';

/** 请求超时（毫秒）。与 `docs/SYNC.md` §2 一致。 */
export const TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/**
 * 全部 API 错误的基类。
 *
 * 保留 `status` / `code` / `details` / `requestId` 供上层判断行为。
 * `message` 仅供显示，**客户端不得依赖文字内容做逻辑分支**（API.md §4.1）。
 */
export class ApiError extends Error {
  /**
   * @param {string} message 面向用户的中文提示
   * @param {{status?: number|null, code?: string|null, details?: object|null, requestId?: string|null}} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.details = opts.details ?? null;
    this.requestId = opts.requestId ?? null;
  }
}

/**
 * 协议错误：响应体损坏、字段缺失、版本值非法等。
 *
 * 表示服务端返回的内容**不符合冻结协议**，属于不可预期状态，
 * 与业务错误（可预期的 4xx/5xx）区分。
 */
export class ProtocolError extends ApiError {}

/** `BAD_REQUEST` —— 输入校验失败。上层进 `invalid` 状态交用户修正。 */
export class InvalidInputError extends ApiError {}

/** `UNAUTHORIZED` —— 凭据缺失/无效/过期。上层进 `auth_required` 并**暂停重试**。 */
export class AuthError extends ApiError {}

/** `NOT_FOUND` —— 资源不存在**或**属于他人（二者统一，不可区分）。 */
export class NotFoundError extends ApiError {}

/** `USERNAME_TAKEN` —— 用户名冲突（409 的一种）。 */
export class ConflictError extends ApiError {}

/**
 * `VERSION_CONFLICT` —— 版本冲突（409 的另一种）。
 *
 * 携带 `serverVersion`（= `details.server_version`）供上层进入 `conflict`。
 * **缺失或非法时抛 {@link ProtocolError}，不编造版本号。**
 */
export class VersionConflictError extends ApiError {
  /**
   * @param {string} message 面向用户的中文提示
   * @param {{status?: number|null, code?: string|null, details?: object|null, requestId?: string|null, serverVersion?: number|null}} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts);
    this.serverVersion = opts.serverVersion ?? null;
  }
}

/** `PAYLOAD_TOO_LARGE` —— 正文或请求体超限（413）。 */
export class TooLargeError extends ApiError {}

/**
 * `RATE_LIMITED` —— 触发限流（429）。
 *
 * 携带 `retryAfter`（**原始 `Retry-After` 头字符串**或 `null`）。
 * **解析与退避由上层负责**，本层不做单位换算。
 */
export class RateLimitedError extends ApiError {
  /**
   * @param {string} message 面向用户的中文提示
   * @param {{status?: number|null, code?: string|null, details?: object|null, requestId?: string|null, retryAfter?: string|null}} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts);
    this.retryAfter = opts.retryAfter ?? null;
  }
}

/** `SERVICE_UNAVAILABLE` —— 服务不可用（503）。 */
export class ServiceUnavailableError extends ApiError {}

/** `INTERNAL_ERROR` —— 服务端内部错误（500）。 */
export class ServerError extends ApiError {}

/** 请求超时（超过 {@link TIMEOUT_MS}）。 */
export class TimeoutError extends ApiError {}

/** 网络层失败（连接被拒、DNS 失败等）。 */
export class NetworkError extends ApiError {}

/**
 * `error.code` → 错误类映射表。
 *
 * 九个字面量与 `docs/API.md` §4.1 完全一致。
 * 两种 409（`USERNAME_TAKEN` / `VERSION_CONFLICT`）**不得混淆**。
 *
 * @type {Readonly<Record<string, typeof ApiError>>}
 */
const ERROR_CODE_MAP = Object.freeze({
  BAD_REQUEST: InvalidInputError,
  UNAUTHORIZED: AuthError,
  NOT_FOUND: NotFoundError,
  USERNAME_TAKEN: ConflictError,
  VERSION_CONFLICT: VersionConflictError,
  PAYLOAD_TOO_LARGE: TooLargeError,
  RATE_LIMITED: RateLimitedError,
  SERVICE_UNAVAILABLE: ServiceUnavailableError,
  INTERNAL_ERROR: ServerError,
});

/**
 * 判断 Content-Type 是否为 JSON。
 *
 * 支持 `application/json` 与 `application/*+json`（如 `application/vnd.api+json`），
 * **忽略参数与大小写**（契约 C8 + API.md §1.5）。
 *
 * @param {string} contentType 原始 Content-Type 头值
 * @returns {boolean}
 */
function isJsonContentType(contentType) {
  const value = contentType.toLowerCase();
  return (
    /^application\/(?:json|[a-z0-9!#$&^_.+-]*\+json)\b/.test(value) ||
    /^application\/\*\+json\b/.test(value)
  );
}

/**
 * 校验 API 相对路径。
 *
 * 必须是单个 `/` 开头的相对路径。禁止：
 * - 完整外域 URL（`https://evil.example/...`）
 * - 协议相对 URL（`//evil.example/...`）
 * - 已带 `/api/v1` 前缀（会重复拼接）
 *
 * @param {unknown} path 待校验路径
 * @throws {ProtocolError}
 */
function assertValidPath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new ProtocolError(`接口路径无效：${String(path)}`);
  }
  if (!path.startsWith('/')) {
    throw new ProtocolError(`接口路径必须以 / 开头：${path}`);
  }
  if (path.startsWith('//')) {
    throw new ProtocolError(`接口路径不得以 // 开头：${path}`);
  }
  if (path.includes(BASE_URL)) {
    throw new ProtocolError(`接口路径不得重复包含 ${BASE_URL} 前缀：${path}`);
  }
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

/**
 * 发起一次 API 请求。
 *
 * @param {string} path API 相对路径，如 `/documents`
 * @param {object} [opts]
 * @param {string} [opts.method='GET'] HTTP 方法
 * @param {string} [opts.token] 访问令牌。**只放入 `Authorization: Bearer` 头，不进 URL**
 * @param {unknown} [opts.body] 请求体。**不为 `undefined` 时**才 JSON 序列化
 * @param {typeof fetch} [opts.fetchImpl=globalThis.fetch] 注入的 fetch 实现（测试用）
 * @param {{setTimeout: Function, clearTimeout: Function}} [opts.timers] 注入的定时器（测试用）
 * @returns {Promise<unknown>} 200/201 返回解析后的 JSON；204 返回 `null`
 * @throws {ApiError} 业务错误、协议错误、超时、网络错误
 */
export async function apiFetch(
  path,
  {
    method = 'GET',
    token,
    body,
    fetchImpl = globalThis.fetch,
    timers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout },
  } = {}
) {
  // ---------- 路径校验 ----------
  assertValidPath(path);

  // ---------- 相对路径直传 ----------
  // 由浏览器按当前页面 origin 解析。不可构造绝对 URL，否则请求发往错误的外域。
  const url = `${BASE_URL}${path}`;

  // ---------- 请求头 ----------
  const headers = new Headers();
  headers.set('Accept', 'application/json');

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // ---------- 请求体 ----------
  let requestBody;
  if (body !== undefined) {
    if (method.toUpperCase() === 'GET') {
      throw new ProtocolError('GET 请求不能携带请求体');
    }
    try {
      requestBody = JSON.stringify(body);
    } catch (error) {
      // 序列化失败属受控错误，不调用 fetch
      throw new ProtocolError('请求体无法序列化为 JSON');
    }
    headers.set('Content-Type', 'application/json');
  }

  // ---------- 超时控制 ----------
  const controller = new AbortController();
  let timerId = null;

  try {
    timerId = timers.setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);

    const response = await fetchImpl(url, {
      method,
      headers,
      body: requestBody,
      signal: controller.signal,
    });

    // ---------- 成功分支 ----------
    if (response.ok) {
      // 204 必须先判并直接返回，绝不调用 response.json()
      if (response.status === 204) {
        return null;
      }

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        // 声明成功但内容不是合法 JSON，不伪装成成功
        throw new ProtocolError('响应内容不是合法 JSON', { status: response.status });
      }
      return payload;
    }

    // ---------- 错误分支 ----------
    const contentType = response.headers.get('content-type') ?? '';
    let errorBody = null;

    if (isJsonContentType(contentType)) {
      try {
        errorBody = await response.json();
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        // 声明 JSON 但解析损坏
        throw new ProtocolError('错误响应内容不是合法 JSON', { status: response.status });
      }
    }

    if (errorBody && typeof errorBody.error === 'object' && errorBody.error !== null) {
      const { code, message, details } = errorBody.error;
      const ErrorClass = ERROR_CODE_MAP[code] ?? ApiError;
      // request_id 以响应体为准；缺失时回落到 X-Request-Id 响应头
      // （契约 API.md §4.1：request_id 关联 X-Request-Id 头用于排障）
      const requestId =
        errorBody.error.request_id ??
        response.headers.get('x-request-id') ??
        null;
      const options = { status: response.status, code: code ?? null, details: details ?? null, requestId };

      if (ErrorClass === VersionConflictError) {
        const serverVersion = details?.server_version;
        if (!Number.isSafeInteger(serverVersion) || serverVersion <= 0) {
          // 不编造版本号
          throw new ProtocolError('版本冲突响应缺少有效的 server_version', {
            status: response.status,
            code: code ?? null,
          });
        }
        options.serverVersion = serverVersion;
      }

      if (ErrorClass === RateLimitedError) {
        // 保留原始头字符串，解析与退避交上层
        options.retryAfter = response.headers.get('retry-after');
      }

      throw new ErrorClass(message ?? '接口调用失败', options);
    }

    // 无标准错误协议体
    if (response.status === 401) {
      // 401 无可读 JSON 时仍归 AuthError
      throw new AuthError('未授权', { status: response.status });
    }
    // 不把 HTML 整段暴露给用户
    throw new ApiError(`接口返回状态码 ${response.status}`, { status: response.status });
  } catch (error) {
    // ---------- 错误归类 ----------

    // 本模块自身抛出的错误原样重抛
    if (error instanceof ApiError) {
      throw error;
    }

    // 超时中断
    if (error && error.name === 'AbortError') {
      throw new TimeoutError(`请求超时（${TIMEOUT_MS} 毫秒）`);
    }

    // 其余视为网络层失败
    throw new NetworkError('网络请求失败');
  } finally {
    // 无论成功、业务失败、解析失败、网络失败，都清理定时器
    if (timerId !== null) {
      timers.clearTimeout(timerId);
    }
  }
}
