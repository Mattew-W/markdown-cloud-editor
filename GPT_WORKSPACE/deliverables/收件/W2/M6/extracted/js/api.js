// 基础常量
export const BASE_URL = '/api/v1';
export const TIMEOUT_MS = 10000;

// 根异常基类
export class ApiError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.details = opts.details ?? null;
    this.requestId = opts.requestId ?? null;
  }
}

// 协议解析错误：JSON损坏、字段缺失、版本非法等
export class ProtocolError extends ApiError {}

// 阶段2 业务错误子类
export class InvalidInputError extends ApiError {}
export class AuthError extends ApiError {}
export class NotFoundError extends ApiError {}
export class ConflictError extends ApiError {}
export class VersionConflictError extends ApiError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.serverVersion = opts.serverVersion ?? null;
  }
}
export class TooLargeError extends ApiError {}
export class RateLimitedError extends ApiError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.retryAfter = opts.retryAfter ?? null;
  }
}
export class ServiceUnavailableError extends ApiError {}
export class ServerError extends ApiError {}

// 阶段3：超时、网络故障
export class TimeoutError extends ApiError {}
export class NetworkError extends ApiError {}

// code -> Error Class 映射表（9类契约映射）
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
 * 核心请求函数
 * @param {string} path 必须以 / 开头相对路径
 * @param {Object} [opts]
 * @param {string} [opts.method='GET']
 * @param {string} [opts.token]
 * @param {any} [opts.body]
 * @param {typeof fetch} [opts.fetchImpl=globalThis.fetch]
 * @param {{setTimeout:Function, clearTimeout:Function}} [opts.timers]
 * @returns {Promise<any>}
 */
export async function apiFetch(path, {
  method = 'GET',
  token,
  body,
  fetchImpl = globalThis.fetch,
  timers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
} = {}) {
  // ---------- path 合法性校验 ----------
  if (!path.startsWith('/') || path.startsWith('//') || path.includes(BASE_URL)) {
    throw new ProtocolError(`invalid path: ${path}`);
  }
  const url = new URL(`${BASE_URL}${path}`, 'http://dummy-base');

  // ---------- 请求头 ----------
  const headers = new Headers();
  headers.set('Accept', 'application/json');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // ---------- body 处理：GET禁止body；非undefined做JSON序列化 ----------
  let reqBody = undefined;
  if (body !== undefined) {
    if (method.toUpperCase() === 'GET') {
      throw new ProtocolError('GET request cannot have body');
    }
    try {
      reqBody = JSON.stringify(body);
    } catch (e) {
      throw new ProtocolError(`body JSON serialize fail: ${e.message}`);
    }
    headers.set('Content‑Type', 'application/json');
  }

  // ---------- 超时控制器 AbortController ----------
  const controller = new AbortController();
  const signal = controller.signal;
  let timerId = null;

  try {
    // 设置超时计时器
    timerId = timers.setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);

    const res = await fetchImpl(url, {
      method,
      headers,
      body: reqBody,
      signal
    });

    // ---------- 2xx 成功分支 ----------
    if (res.ok) {
      // 204 No‑Content：禁止调用 .json()，直接返回 null
      if (res.status === 204) {
        return null;
      }
      // 200 / 201：读取JSON；非合法JSON抛ProtocolError
      let payload;
      try {
        payload = await res.json();
      } catch (err) {
        throw new ProtocolError(`success response parse json failed: ${err.message}`, { status: res.status });
      }
      return payload;
    }

    // ---------- 非2xx 错误响应分支 ----------
    const contentTypeRaw = res.headers.get('content‑type') ?? '';
    const contentType = contentTypeRaw.toLowerCase();
    const isJsonContentType = /^application\/(\*\+)?json/.test(contentType);

    let errorBody = null;
    if (isJsonContentType) {
      try {
        errorBody = await res.json();
      } catch (err) {
        // 声明JSON但解析损坏
        throw new ProtocolError(`error‑response json parse broken: ${err.message}`, { status: res.status });
      }
    }

    // 有标准 {error:{...}} 协议体
    if (errorBody && typeof errorBody.error === 'object' && errorBody.error !== null) {
      const { code, message, details, request_id } = errorBody.error;
      const requestId = request_id ?? null;

      const ErrCls = ERROR_CODE_MAP[code] ?? ApiError;
      const errOpts = { status: res.status, code, details, requestId };

      if (ErrCls === VersionConflictError) {
        const sv = details?.server_version;
        if (!Number.isSafeInteger(sv) || sv <= 0) {
          throw new ProtocolError('VersionConflict missing/invalid server_version', { status: res.status, code });
        }
        errOpts.serverVersion = sv;
      }
      if (ErrCls === RateLimitedError) {
        const retryAfter = res.headers.get('retry‑after');
        errOpts.retryAfter = retryAfter;
      }
      throw new ErrCls(message ?? 'api error', errOpts);
    } else {
      // 非JSON、或者error结构不全
      // 401无合法error体，仍映射AuthError
      if (res.status === 401) {
        throw new AuthError('Unauthorized', { status: res.status });
      }
      throw new ApiError(`http status ${res.status}`, { status: res.status });
    }

  } catch (err) {
    // ---------- 区分超时abort、网络错误、业务异常 ----------
    if (err.name === 'AbortError') {
      throw new TimeoutError(`request timeout ${TIMEOUT_MS}ms`);
    }
    // 已经是我们自己定义的错误类，直接向外重抛
    if (Object.values([
      ApiError, ProtocolError, InvalidInputError, AuthError, NotFoundError,
      ConflictError, VersionConflictError, TooLargeError, RateLimitedError,
      ServiceUnavailableError, ServerError, TimeoutError, NetworkError
    ]).some(cls => err instanceof cls)) {
      throw err;
    }
    // 其他网络层面拒绝，包装为NetworkError
    throw new NetworkError(`network fail: ${err.message}`);
  } finally {
    // 无论成功失败，务必清除定时器
    if (timerId !== null) {
      timers.clearTimeout(timerId);
    }
  }
}
