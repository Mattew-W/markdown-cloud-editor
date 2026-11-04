/**
 * api.js 的真实 HTTP 传输回归测试（M6 W3 新增）
 *
 * 与 `api.test.js`（纯 mock，注入假 Response）互补：本文件用 `node:http`
 * 在 127.0.0.1 随机端口起**真实服务**，用 Node 自带全局 `fetch` 做**真实传输**，
 * 覆盖 mock 无法验证的真实网络行为：
 *
 *   1. 请求真正发往本机测试地址，实际请求路径为 `/api/v1/documents`；
 *   2. `Authorization` 只在请求头，不进 URL；
 *   3. JSON 请求体被真实发送，并带 `Content-Type: application/json`；
 *   4. 错误响应在真实传输下的映射（400/404/429/500 → 对应错误类）；
 *   5. 真实分块/断连：先返回 JSON 响应头 + 不完整正文再断开连接 → `NetworkError`；
 *   6. 成功与错误响应的正文读取超时 → `TimeoutError`（注入可控时钟，**不真等 10 秒**）；
 *   7. 恶意畸形 JSON → `ProtocolError`；
 *   8. 204 真实传输返回 `null`；连接被拒（端口无监听）→ `NetworkError`。
 *
 * 全部流量只走 127.0.0.1，不访问外网。
 * 客户端相对路径保持不变，测试注入 `fetchImpl` 把相对路径解析到本机测试地址。
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  apiFetch,
  BASE_URL,
  ApiError,
  InvalidInputError,
  NotFoundError,
  RateLimitedError,
  ServerError,
  ProtocolError,
  TimeoutError,
  NetworkError,
} from '../api.js';

// ---------------------------------------------------------------------------
// 真实 HTTP 服务 + 本地 fetch 工厂
// ---------------------------------------------------------------------------

/** 起一个 127.0.0.1 随机端口真实 HTTP 服务 */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/** 关闭服务；先强制断开所有剩余连接，避免挂起的 body 阻塞 close 回调 */
function stopServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close(resolve);
  });
}

/**
 * 把相对路径解析到本机测试地址的真实 fetch 实现。
 * apiFetch 传给 fetch 的仍是相对路径（如 `/api/v1/documents`），
 * 只在这里补上 `http://127.0.0.1:port` 前缀，客户端代码不被改动。
 */
function makeLocalFetch(port) {
  return (url, init) => fetch(`http://127.0.0.1:${port}${url}`, init);
}

/** 可控时钟：记录 setTimeout，测试可手动触发回调（避免真等 10 秒） */
function makeTimers() {
  const state = { setCalls: [], trigger: null, clearCalls: [] };
  return {
    state,
    timers: {
      setTimeout(cb, ms) {
        state.setCalls.push(ms);
        state.trigger = cb;
        return state.setCalls.length;
      },
      clearTimeout(id) {
        state.clearCalls.push(id);
      },
    },
  };
}

/** 收集真实请求体 */
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

/** 发出响应头并写一部分正文后不结束，让响应体保持"读取中" */
function holdResponse(res, status, headers) {
  res.writeHead(status, headers);
  res.write('{"partial":');
}

// ---------------------------------------------------------------------------
// 测试主体
// ---------------------------------------------------------------------------

describe('apiFetch — 真实 HTTP 传输（127.0.0.1）', () => {
  let server;
  let port;
  let fetchImpl;

  afterEach(async () => {
    if (server) {
      await stopServer(server);
      server = null;
    }
  });

  async function start(handler) {
    const s = await startServer(handler);
    server = s.server;
    port = s.port;
    fetchImpl = makeLocalFetch(port);
    return { server, port, fetchImpl };
  }

  // ---------- 请求构造：路径 / 认证 / 请求体 ----------

  test('真实请求路径为 /api/v1/documents（相对路径直传，本机解析）', async () => {
    let receivedUrl = null;
    await start((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    const payload = await apiFetch('/documents', { fetchImpl });
    assert.deepEqual(payload, { ok: true });
    assert.equal(receivedUrl, `${BASE_URL}/documents`, '真实请求路径必须带 /api/v1 前缀');
  });

  test('Authorization 只在请求头，不进 URL', async () => {
    let seen = {};
    await start((req, res) => {
      seen = { url: req.url, auth: req.headers.authorization ?? null };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await apiFetch('/documents', { token: 'secret-token', fetchImpl });
    assert.equal(seen.auth, 'Bearer secret-token');
    assert.ok(!seen.url.includes('secret-token'), '令牌不得进入 URL');
  });

  test('JSON 请求体被真实发送，并带 Content-Type: application/json', async () => {
    let seen = {};
    await start(async (req, res) => {
      const body = await readBody(req);
      seen = {
        url: req.url,
        method: req.method,
        contentType: req.headers['content-type'] ?? null,
        body,
      };
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ created: true }));
    });

    const payload = await apiFetch('/documents', {
      method: 'POST',
      body: { title: 't', n: 1 },
      fetchImpl,
    });
    assert.deepEqual(payload, { created: true });
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/api/v1/documents');
    assert.equal(seen.contentType, 'application/json');
    assert.equal(seen.body, JSON.stringify({ title: 't', n: 1 }));
  });

  // ---------- 错误响应映射（真实传输） ----------

  test('错误响应真实映射：400→InvalidInputError、404→NotFoundError、500→ServerError', async () => {
    const cases = [
      [400, 'BAD_REQUEST', InvalidInputError],
      [404, 'NOT_FOUND', NotFoundError],
      [500, 'INTERNAL_ERROR', ServerError],
    ];
    for (const [status, code, ErrorClass] of cases) {
      await start((req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code, message: 'x' } }));
      });
      await assert.rejects(() => apiFetch('/documents', { fetchImpl }), ErrorClass);
      await stopServer(server);
      server = null;
    }
  });

  test('429 RATE_LIMITED 在真实传输下保留 Retry-After 头', async () => {
    await start((req, res) => {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '120',
      });
      res.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'x' } }));
    });

    const err = await apiFetch('/documents', { fetchImpl }).catch((e) => e);
    assert.ok(err instanceof RateLimitedError);
    assert.equal(err.retryAfter, '120');
  });

  // ---------- 真实分块 / 断连 / 超时 ----------

  test('返回 JSON 响应头 + 不完整正文后断开连接 → NetworkError', async () => {
    await start((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
      res.destroy(); // 立即断开底层连接，正文不完整
    });

    await assert.rejects(() => apiFetch('/documents', { fetchImpl }), NetworkError);
  });

  test('成功（200）正文读取超时 → TimeoutError（可控时钟，不真等 10 秒）', async () => {
    const { state, timers } = makeTimers();
    let startedResolve;
    const started = new Promise((r) => {
      startedResolve = r;
    });
    await start((req, res) => {
      holdResponse(res, 200, { 'content-type': 'application/json' });
      startedResolve(); // 服务端已发出响应头、正文挂起
    });

    const request = apiFetch('/documents', { fetchImpl, timers });
    await started; // 服务端可控事件：确认已进入正文读取
    assert.equal(state.setCalls[0], 10000, '应使用 10 秒超时');
    state.trigger(); // 手动触发超时回调 → abort
    await assert.rejects(request, TimeoutError);
    assert.equal(state.clearCalls.length, 1, 'finally 必须清理定时器');
  });

  test('错误（400）正文读取超时 → TimeoutError（可控时钟，不真等 10 秒）', async () => {
    const { state, timers } = makeTimers();
    let startedResolve;
    const started = new Promise((r) => {
      startedResolve = r;
    });
    await start((req, res) => {
      holdResponse(res, 400, { 'content-type': 'application/json' });
      startedResolve();
    });

    const request = apiFetch('/documents', { fetchImpl, timers });
    await started;
    state.trigger();
    await assert.rejects(request, TimeoutError);
    assert.equal(state.clearCalls.length, 1, 'finally 必须清理定时器');
  });

  // ---------- 坏响应 ----------

  test('恶意畸形 JSON（Content-Type: application/json）→ ProtocolError', async () => {
    await start((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{bad json');
    });

    await assert.rejects(() => apiFetch('/documents', { fetchImpl }), ProtocolError);
  });

  test('错误响应声明 JSON 但内容损坏 → ProtocolError', async () => {
    await start((req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{oops');
    });

    await assert.rejects(() => apiFetch('/documents', { fetchImpl }), ProtocolError);
  });

  test('非 JSON 错误响应（text/html 错误页）→ ApiError，保留 status，不把 HTML 当 JSON 解析', async () => {
    await start((req, res) => {
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end('<html><body>Internal Server Error</body></html>');
    });

    const err = await apiFetch('/documents', { fetchImpl }).catch((e) => e);
    // 契约要求：非 JSON 返回 ApiError 保留 status，不读 HTML 作 JSON
    assert.ok(err instanceof ApiError, '非 JSON 错误响应应归 ApiError');
    assert.ok(!(err instanceof ProtocolError), '非 JSON 不应归 ProtocolError');
    assert.equal(err.status, 500, '必须保留 status');
    assert.ok(!err.message.includes('<html>'), '不得把 HTML 整段暴露给用户');
  });

  // ---------- 204 与连接被拒 ----------

  test('204 真实传输返回 null（不解析正文）', async () => {
    await start((req, res) => {
      res.writeHead(204);
      res.end();
    });

    assert.equal(await apiFetch('/documents', { fetchImpl }), null);
  });

  test('连接被拒（端口无服务监听）→ NetworkError', async () => {
    // 起一个临时服务拿端口后立即关闭，再请求该端口 → ECONNREFUSED
    const { server: tmp, port: deadPort } = await startServer(() => {});
    await stopServer(tmp);
    const deadFetch = makeLocalFetch(deadPort);

    await assert.rejects(() => apiFetch('/documents', { fetchImpl: deadFetch }), NetworkError);
  });
});
