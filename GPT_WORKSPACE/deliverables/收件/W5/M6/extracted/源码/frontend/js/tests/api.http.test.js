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
  AuthError,
  NotFoundError,
  ConflictError,
  VersionConflictError,
  TooLargeError,
  RateLimitedError,
  ServiceUnavailableError,
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

/**
 * 可控时钟：记录 setTimeout，测试可手动触发回调（避免真等 10 秒）。
 *
 * ⚠ `clearTimeout` 必须**真正取消**该定时器（与真实 `clearTimeout` 语义一致）。
 * 若只记录不取消，则「超时保护提前结束」这类变异在本假时钟下毫无影响，
 * 用例会误判为通过 —— 即"看起来通过而实际没测到"。
 * `trigger()` 返回布尔值：true = 该定时器仍有效并已触发；false = 已被清除（未触发）。
 */
function makeTimers() {
  const state = { setCalls: [], trigger: null, clearCalls: [], cancelled: new Set() };
  return {
    state,
    timers: {
      setTimeout(cb, ms) {
        const id = state.setCalls.length + 1;
        state.setCalls.push(ms);
        state.trigger = () => {
          if (state.cancelled.has(id)) return false;
          cb();
          return true;
        };
        return id;
      },
      clearTimeout(id) {
        state.clearCalls.push(id);
        state.cancelled.add(id);
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

/**
 * 让**客户端确实拿到响应头**之后才 resolve 的 fetch 包装。
 *
 * M6 W3 初版的两个超时用例在服务端 `writeHead` 后立即 `startedResolve()`，
 * 此时响应头还在 TCP 缓冲区里，`response.json()` 根本没被调用——
 * 测到的是「等响应头超时」，不是任务书要求的「正文读取超时」。
 *
 * 本包装在 `fetch` resolve（= 客户端已收到响应头）之后才通知测试，
 * 确保 abort 发生在**正文读取阶段**。
 *
 * ⚠ `getBaseFetch` 必须是**惰性取值**（传函数而非函数值）：
 * `fetchImpl` 在 `start()` 里被重新赋值，而本包装常在 `start()` 之前构造。
 * 若直接传函数值，闭包会捕获**上一次测试的旧端口**（首次为 `undefined`），
 * 请求打到已关闭的服务端 → fetch 直接失败，永远等不到响应头。
 *
 * @param {() => Function} getBaseFetch 返回底层 fetch 的取值函数
 * @param {() => void} onHeadersSettled 客户端拿到响应头后的回调
 * @param {() => void} [onBodyRead] 客户端**开始读取正文**（`response.json()` 被调用）时的回调
 * @returns {Function}
 */
function makeFetchNotifyOnHeaders(getBaseFetch, onHeadersSettled, onBodyRead) {
  return async (url, init) => {
    const baseFetch = getBaseFetch();
    const response = await baseFetch(url, init);
    onHeadersSettled();
    if (typeof onBodyRead === 'function') {
      const originalJson = response.json.bind(response);
      response.json = () => {
        onBodyRead();
        return originalJson();
      };
    }
    return response;
  };
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

  test('九类 error.code 在真实传输下全部映射到对应错误类', async () => {
    // 契约 API.md §4.1 的九个字面量，真实 HTTP 传输下逐类验证
    const cases = [
      [400, 'BAD_REQUEST', InvalidInputError],
      [401, 'UNAUTHORIZED', AuthError],
      [404, 'NOT_FOUND', NotFoundError],
      [409, 'USERNAME_TAKEN', ConflictError],
      [413, 'PAYLOAD_TOO_LARGE', TooLargeError],
      [429, 'RATE_LIMITED', RateLimitedError],
      [503, 'SERVICE_UNAVAILABLE', ServiceUnavailableError],
      [500, 'INTERNAL_ERROR', ServerError],
    ];
    for (const [status, code, ErrorClass] of cases) {
      await start((req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code, message: 'x' } }));
      });
      const err = await apiFetch('/documents', { fetchImpl }).catch((e) => e);
      assert.ok(
        err instanceof ErrorClass,
        `${code} 应归 ${ErrorClass.name}，实际 ${err.constructor.name}`
      );
      assert.equal(err.status, status);
      assert.equal(err.code, code);
      await stopServer(server);
      server = null;
    }
  });

  test('409 VERSION_CONFLICT 在真实传输下携带 serverVersion（两种 409 不混淆）', async () => {
    await start((req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'VERSION_CONFLICT',
            message: '文档已被其他会话修改',
            details: { server_version: 7 },
            request_id: 'req-real-001',
          },
        })
      );
    });

    const err = await apiFetch('/documents/u1', { fetchImpl }).catch((e) => e);
    assert.ok(err instanceof VersionConflictError);
    assert.ok(!(err instanceof ConflictError), '两种 409 不得混淆');
    assert.equal(err.serverVersion, 7, '必须携带服务端版本号');
    assert.equal(err.status, 409);
    assert.equal(err.code, 'VERSION_CONFLICT');
    assert.equal(err.requestId, 'req-real-001');
  });

  test('409 VERSION_CONFLICT 缺 server_version → ProtocolError，不编造版本', async () => {
    await start((req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'x', details: {} } }));
    });

    await assert.rejects(() => apiFetch('/documents/u1', { fetchImpl }), ProtocolError);
  });

  test('DELETE 的 expected_version 走查询参数，不进请求体', async () => {
    // 契约 API.md §3.6：expected_version 是查询参数，不是请求体
    let seen = null;
    await start((req, res) => {
      seen = { url: req.url, method: req.method, body: null };
      res.writeHead(204);
      res.end();
    });

    const result = await apiFetch('/documents/u1?expected_version=3', {
      method: 'DELETE',
      fetchImpl,
    });

    assert.equal(result, null, '204 返回 null');
    assert.equal(seen.method, 'DELETE');
    assert.equal(seen.url, '/api/v1/documents/u1?expected_version=3');
    assert.ok(seen.url.includes('expected_version=3'), '版本号必须在查询串中');
  });

  // ---------- 真实分块 / 断连 / 超时 ----------

  test('返回 JSON 响应头 + 不完整正文后断开连接 → NetworkError', async () => {
    // 必须让响应头**真正送达客户端**再断开。
    // `res.destroy()` 立即销毁 socket 时，TCP 缓冲区里的响应头会随之丢弃，
    // 客户端根本收不到 —— 那样测的是「连接被重置」而非「分块响应中途断开」。
    //
    // 实测（4 种组合）：
    //   立即 destroy      → 客户端拿不到响应头（fetch 不 resolve）
    //   延迟 30ms destroy → 客户端已拿到响应头（fetch resolve）
    // **延迟是关键**（flushHeaders 只保证写出，不保证出网）。
    let headersArrived = false;
    const notifyingFetch = makeFetchNotifyOnHeaders(
      () => fetchImpl,
      () => {
        headersArrived = true;
      }
    );

    await start((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
      res.flushHeaders(); // 强制写出响应头
      setTimeout(() => res.destroy(), 30); // 留出传输窗口，确保响应头抵达客户端
    });

    await assert.rejects(() => apiFetch('/documents', { fetchImpl: notifyingFetch }), NetworkError);
    assert.equal(headersArrived, true, '客户端必须先收到响应头，断连场景才成立');
  });

  test('成功（200）正文读取超时 → TimeoutError（可控时钟，不真等 10 秒）', async () => {
    const { state, timers } = makeTimers();
    let startedResolve;
    const started = new Promise((r) => {
      startedResolve = r;
    });
    let bodyReadResolve;
    const bodyRead = new Promise((r) => {
      bodyReadResolve = r;
    });
    // 在**客户端拿到响应头之后**才放行 —— 确保 abort 落在正文读取阶段
    const notifyingFetch = makeFetchNotifyOnHeaders(
      () => fetchImpl,
      () => startedResolve(),
      () => bodyReadResolve()
    );

    await start((req, res) => {
      holdResponse(res, 200, { 'content-type': 'application/json' });
    });

    const request = apiFetch('/documents', { fetchImpl: notifyingFetch, timers });
    request.catch(() => {}); // 断言提前失败时不产生未处理拒绝
    await started; // 客户端已收到响应头
    // 关键前提自证：**正文读取已经开始**（response.json() 被调用），
    // 否则测到的是「等响应头超时」，不是任务书要求的「正文读取超时」。
    await bodyRead;
    assert.equal(state.setCalls[0], 10000, '应使用 10 秒超时');
    // trigger() 返回 false = 该定时器已被提前清除（超时保护未覆盖正文读取阶段）。
    // 必须断言这一点，否则「超时只覆盖 fetch 阶段」的缺陷不会被发现。
    assert.equal(state.trigger(), true, '超时定时器必须仍然有效（未被提前清除）');
    await assert.rejects(request, TimeoutError);
    assert.equal(state.clearCalls.length, 1, 'finally 必须清理定时器');
  });

  test('错误（400）正文读取超时 → TimeoutError（可控时钟，不真等 10 秒）', async () => {
    const { state, timers } = makeTimers();
    let startedResolve;
    const started = new Promise((r) => {
      startedResolve = r;
    });
    let bodyReadResolve;
    const bodyRead = new Promise((r) => {
      bodyReadResolve = r;
    });
    const notifyingFetch = makeFetchNotifyOnHeaders(
      () => fetchImpl,
      () => startedResolve(),
      () => bodyReadResolve()
    );

    await start((req, res) => {
      holdResponse(res, 400, { 'content-type': 'application/json' });
    });

    const request = apiFetch('/documents', { fetchImpl: notifyingFetch, timers });
    request.catch(() => {});
    await started;
    await bodyRead;
    assert.equal(state.trigger(), true, '超时定时器必须仍然有效（未被提前清除）');
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
