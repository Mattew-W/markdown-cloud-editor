import { describe, it, assert } from 'node:test';
import {
  apiFetch,
  BASE_URL,
  TIMEOUT_MS,
  ApiError, ProtocolError,
  InvalidInputError, AuthError, NotFoundError,
  ConflictError, VersionConflictError, TooLargeError, RateLimitedError,
  ServiceUnavailableError, ServerError,
  TimeoutError, NetworkError
} from '../js/api.js';

describe('M6‑W2 apiFetch — 阶段1：成功请求 & 204', () => {

  it('构造正确URL、Bearer头、Accept头', async () => {
    const mockFetch = async (input, init) => {
      assert.equal(input.pathname, `${BASE_URL}/documents`);
      assert.equal(init.headers.get('Authorization'), 'Bearer my‑token‑123');
      assert.equal(init.headers.get('Accept'), 'application/json');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await apiFetch('/documents', { token: 'my‑token‑123', fetchImpl: mockFetch });
  });

  it('200 返回json payload', async () => {
    const mockFetch = async () => {
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    };
    const ret = await apiFetch('/foo', { fetchImpl: mockFetch });
    assert.deepEqual(ret, { id: 1 });
  });

  it('201 返回json payload', async () => {
    const mockFetch = async () => {
      return new Response(JSON.stringify({ created: true }), { status: 201 });
    };
    const ret = await apiFetch('/foo', { fetchImpl: mockFetch });
    assert.deepEqual(ret, { created: true });
  });

  it('204 No‑Content：**绝不调用 response.json()，返回null**', async () => {
    let jsonCalled = false;
    const mock204Res = {
      ok: true,
      status: 204,
      json: async () => {
        jsonCalled = true;
        throw new Error('json() should not be invoked for 204');
      }
    };
    const mockFetch = async () => mock204Res;
    const res = await apiFetch('/empty', { fetchImpl: mockFetch });
    assert.equal(res, null);
    assert.equal(jsonCalled, false, '204 must skip .json()');
  });

  it('成功200返回内容非法JSON抛出ProtocolError', async () => {
    const mockFetch = async () => new Response('not‑json‑text', { status: 200 });
    await assert.rejects(
      () => apiFetch('/badjsonok', { fetchImpl: mockFetch }),
      ProtocolError
    );
  });

  it('GET 请求禁止传入 body', async () => {
    await assert.rejects(
      () => apiFetch('/x', { method: 'GET', body: { a: 1 } }),
      ProtocolError
    );
  });

  it('非法path（带完整/api/v1前缀）抛出ProtocolError', async () => {
    await assert.rejects(() => apiFetch('/api/v1/foo'), ProtocolError);
  });
});

describe('M6‑W2 apiFetch — 阶段2：错误分类与坏响应', () => {

  function makeMockErrorResp(status, errorObj, extraHeaders = {}) {
    const hd = new Headers({ 'content‑type': 'application/json', ...extraHeaders });
    return new Response(JSON.stringify({ error: errorObj }), { status, headers: hd });
  }

  it('BAD_REQUEST → InvalidInputError', async () => {
    const mockFetch = async () => makeMockErrorResp(400, { code: 'BAD_REQUEST', message: 'bad input' });
    await assert.rejects(async () => apiFetch('/e', { fetchImpl: mockFetch }), InvalidInputError);
  });

  it('UNAUTHORIZED → AuthError', async () => {
    const mockFetch = async () => makeMockErrorResp(401, { code: 'UNAUTHORIZED', message: 'no auth' });
    await assert.rejects(async () => apiFetch('/e', { fetchImpl: mockFetch }), AuthError);
  });

  it('NOT_FOUND → NotFoundError', async () => {
    const mockFetch = async () => makeMockErrorResp(404, { code: 'NOT_FOUND', message: 'no item' });
    await assert.rejects(async () => apiFetch('/e', { fetchImpl: mockFetch }), NotFoundError);
  });

  it('USERNAME_TAKEN(409) → ConflictError', async () => {
    const mockFetch = async () => makeMockErrorResp(409, { code: 'USERNAME_TAKEN', message: 'taken' });
    await assert.rejects(async () => apiFetch('/e', { fetchImpl: mockFetch }), ConflictError);
  });

  it('VERSION_CONFLICT(409) → VersionConflictError，携带serverVersion', async () => {
    const mockFetch = async () => makeMockErrorResp(409, {
      code: 'VERSION_CONFLICT',
      message: 'conflict',
      details: { server_version: 8 },
      request_id: 'req‑001'
    });
    try {
      await apiFetch('/e', { fetchImpl: mockFetch });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof VersionConflictError);
      assert.equal(err.serverVersion, 8);
      assert.equal(err.requestId, 'req‑001');
    }
  });

  it('VERSION_CONFLICT server_version缺失抛出ProtocolError', async () => {
    const mockFetch = async () => makeMockErrorResp(409, {
      code: 'VERSION_CONFLICT',
      message: 'conflict',
      details: {}
    });
    await assert.rejects(async () => apiFetch('/e', { fetchImpl: mockFetch }), ProtocolError);
  });

  it('PAYLOAD_TOO_LARGE → TooLargeError', async () => {
    const mockFetch = async () => makeMockErrorResp(413, { code: 'PAYLOAD_TOO_LARGE', message: 'too big' });
    await assert.rejects(async () => apiFetch('/e', { fetchImpl: mockFetch }), TooLargeError);
  });

  it('RATE_LIMITED → RateLimitedError，保留Retry‑After头', async () => {
    const mockFetch = async () => makeMockErrorResp(429,
      { code: 'RATE_LIMITED', message: 'slow down' },
      { 'retry‑after': '60' }
    );
    try {
      await apiFetch('/e', { fetchImpl: mockFetch });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof RateLimitedError);
      assert.equal(err.retryAfter, '60');
    }
  });

  it('SERVICE_UNAVAILABLE → ServiceUnavailableError', async () => {
    const mockFetch = async () => makeMockErrorResp(503, { code: 'SERVICE_UNAVAILABLE', message: 'down' });
    await assert.rejects(async () => apiFetch('/e', { fetchImpl: mockFetch }), ServiceUnavailableError);
  });

  it('INTERNAL_ERROR → ServerError', async () => {
    const mockFetch = async () => makeMockErrorResp(500, { code: 'INTERNAL_ERROR', message: 'boom' });
    await assert.rejects(async () => apiFetch('/e', { fetchImpl: mockFetch }), ServerError);
  });

  it('Content‑Type非JSON的500返回普通ApiError，不尝试JSON解析', async () => {
    const mockFetch = async () => new Response('<html>error page</html>', {
      status: 500,
      headers: { 'content‑type': 'text/html' }
    });
    await assert.rejects(async () => apiFetch('/e', { fetchImpl: mockFetch }), ApiError);
  });

  it('声明application/json但是返回损坏JSON → ProtocolError', async () => {
    const mockFetch = async () => new Response('{bad json', {
      status: 500,
      headers: { 'content‑type': 'application/json' }
    });
    await assert.rejects(async () => apiFetch('/e', { fetchImpl: mockFetch }), ProtocolError);
  });

  it('401响应没有合法error JSON，仍然抛出AuthError', async () => {
    const mockFetch = async () => new Response('no json body', { status: 401 });
    await assert.rejects(async () => apiFetch('/e', { fetchImpl: mockFetch }), AuthError);
  });
});

describe('M6‑W2 apiFetch — 阶段3：超时与网络故障（mock timers，不等待真实10s）', () => {

  it('fetch底层网络拒绝抛出NetworkError', async () => {
    const mockFetch = async () => { throw new Error('socket drop'); };
    await assert.rejects(async () => apiFetch('/netfail', { fetchImpl: mockFetch }), NetworkError);
  });

  it('超时触发AbortController，向外抛出TimeoutError；timer被清理', async () => {
    let cleared = false;
    let timerTrigger = null;
    const fakeTimers = {
      setTimeout(cb) { timerTrigger = cb; return 999; },
      clearTimeout() { cleared = true; }
    };
    const mockFetch = async (_, opts) => {
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new DOMException('abort','AbortError')));
      });
    };
    const p = apiFetch('/timeout', { fetchImpl: mockFetch, timers: fakeTimers });
    // 触发超时回调
    timerTrigger();
    await assert.rejects(() => p, TimeoutError);
    assert.equal(cleared, true, 'timer must clearTimeout in finally');
  });

  it('成功路径：定时器依然会被clear', async () => {
    let cleared = false;
    const fakeTimers = {
      setTimeout: () => 123,
      clearTimeout: () => { cleared = true; }
    };
    const mockFetch = async () => new Response(JSON.stringify({ok:1}), {status:200});
    await apiFetch('/ok‑clear‑timer', { fetchImpl: mockFetch, timers: fakeTimers });
    assert.equal(cleared, true);
  });
});
