/**
 * api.js 真实 HTTP 阶段的 W5 补充验证（M6-W5-01）
 *
 * 与 `api.http.test.js`（W3 新增）互补，不替换。W3 已覆盖「真实传输 + 断连 +
 * 正文超时 + 畸形 JSON」。本文件补 W5 任务书明确点出的四个**阶段判定**缺口：
 *
 *   W5-01-a 「响应头/正文开始」必须是**可观察事件**，且顺序为头先于正文；
 *   W5-01-b **非 JSON 错误体**不得被当成 JSON 解析（以 `response.json()` 实调用次数取证）；
 *   W5-01-c 非 JSON 错误体在不同状态码下走**同一套映射**（保留 status、归基类、不归 ProtocolError）；
 *   W5-01-d **错误响应正文读取中断连** → NetworkError（W3 只覆盖了 200 成功响应）；
 *   W5-01-e 九类 `error.code` 在真实传输下**同一个循环**全部映射（W3 的循环只列了 8 类，
 *             `VERSION_CONFLICT` 落在另一个用例里，「九类」实际未被一并验证）；
 *   W5-01-f 挂起正文的服务关闭后**请求真的被清理**（不是靠定时器猜测阶段），
 *             且超时保护定时器在 `finally` 被清除。
 *
 * 全部流量只走 127.0.0.1，不访问外网。客户端相对路径不变，
 * 只在本文件的 fetch 包装里补 `http://127.0.0.1:port` 前缀。
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
// 真实服务与可控时钟
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

/** 相对路径 → 本机地址的真实 fetch */
function makeLocalFetch(port) {
  return (url, init) => fetch(`http://127.0.0.1:${port}${url}`, init);
}

/**
 * 可控时钟。`trigger()` 返回 false 表示该定时器已被清除（未触发）。
 * 取消必须**真的**移除定时器，否则「超时保护是否覆盖正文阶段」无法断言。
 */
function makeTimers() {
  const state = { setCalls: [], clearCalls: [], cancelled: new Set(), trigger: null };
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

/**
 * 事件记录型 fetch。
 *
 * - `event('headers')`：fetch 已 resolve —— 即客户端**真的收到响应头**；
 * - `event('body-start')`：`response.json()` 被调用 —— 即**正文读取开始**；
 * - `jsonCalls` 计数：错误响应是否被误当 JSON 解析的取证。
 *
 * @param {() => Function} getBaseFetch 惰性取值，避免闭包捕获旧端口
 * @param {(name: string) => void} event
 * @param {{jsonCalls: number}} stats
 */
function makeEventFetch(getBaseFetch, event, stats) {
  return async (url, init) => {
    const response = await getBaseFetch()(url, init);
    event('headers');
    const originalJson = response.json.bind(response);
    response.json = () => {
      stats.jsonCalls += 1;
      event('body-start');
      return originalJson();
    };
    return response;
  };
}

/** 发出响应头并写一部分正文后不结束，让响应体保持「读取中」 */
function holdResponse(res, status, headers) {
  res.writeHead(status, headers);
  res.write('{"partial":');
}

/** 在 ms 内没完成即判失败的守卫，用于证明「关闭服务不会挂住」 */
function withDeadline(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const id = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 未完成（疑似挂起）`)), ms);
      if (typeof id.unref === 'function') id.unref();
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 测试主体
// ---------------------------------------------------------------------------

describe('apiFetch — 真实 HTTP 阶段（M6-W5-01）', () => {
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

  // ---------- W5-01-a 响应头 / 正文开始是可观察事件 ----------

  test('W5-01-a 响应头先到、正文读取随后开始，两者都是可观察事件', async () => {
    const { state, timers } = makeTimers();
    const stats = { jsonCalls: 0 };
    /** @type {string[]} */
    const events = [];
    let headersResolve;
    const headersSeen = new Promise((r) => {
      headersResolve = r;
    });
    let bodyResolve;
    const bodySeen = new Promise((r) => {
      bodyResolve = r;
    });

    const eventFetch = makeEventFetch(
      () => fetchImpl,
      (name) => {
        events.push(name);
        if (name === 'headers') headersResolve();
        if (name === 'body-start') bodyResolve();
      },
      stats,
    );

    await start((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"a":');
      res.end('1}');
    });

    const request = apiFetch('/documents', { fetchImpl: eventFetch, timers });
    await headersSeen;
    // 此刻只应发生过「收到响应头」，正文尚未开始 —— 阶段可判定，不靠猜。
    assert.deepEqual(events, ['headers'], '收到响应头时正文读取不得已开始');

    await bodySeen;
    assert.equal(stats.jsonCalls, 1, '正文读取开始必须以 response.json() 实调用取证');
    assert.deepEqual(events, ['headers', 'body-start'], '事件顺序必须是头先、正文后');

    const payload = await request;
    assert.deepEqual(payload, { a: 1 });
    // 响应头阶段结束后定时器仍须有效（超时保护覆盖正文读取）。
    assert.equal(state.setCalls[0], 10000, '超时应为 10 秒');
    assert.equal(state.trigger(), false, '请求结束后 finally 必须已清除定时器');
  });

  // ---------- W5-01-b 非 JSON 错误体不被当作 JSON ----------

  test('W5-01-b 非 JSON 错误体（text/html）绝不调用 response.json()，保留 status', async () => {
    const stats = { jsonCalls: 0 };
    const events = [];
    const eventFetch = makeEventFetch(() => fetchImpl, (n) => events.push(n), stats);

    await start((req, res) => {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body>500 Internal Server Error</body></html>');
    });

    const err = await apiFetch('/documents', { fetchImpl: eventFetch }).catch((e) => e);
    assert.ok(err instanceof ApiError, '非 JSON 错误体仍须归 ApiError');
    assert.ok(!(err instanceof ProtocolError), '非 JSON 不是协议错误');
    assert.equal(err.constructor.name, 'ApiError', '无标准错误体时归基类，不编造业务 code');
    assert.equal(err.status, 500, '必须保留真实 status');
    assert.equal(err.code, null, '没有 error.code 时不得编造');
    assert.equal(stats.jsonCalls, 0, '非 JSON 响应不得调用 response.json()（这是本用例的取证点）');
    assert.deepEqual(events, ['headers'], '非 JSON 错误体只到「收到响应头」，不应进入正文 JSON 解析');
    assert.ok(!err.message.includes('<html>'), '不得把 HTML 整段暴露给用户');
  });

  // ---------- W5-01-c 非 JSON 错误体的统一映射 ----------

  test('W5-01-c 非 JSON 错误体在 400/404/500/503 下走同一映射（基类 + 原 status）', async () => {
    const cases = [
      [400, 'text/html'],
      [404, 'text/plain; charset=utf-8'],
      [500, 'text/html'],
      [503, 'application/octet-stream'],
    ];

    for (const [status, contentType] of cases) {
      const stats = { jsonCalls: 0 };
      const eventFetch = makeEventFetch(() => fetchImpl, () => {}, stats);

      await start((req, res) => {
        res.writeHead(status, { 'content-type': contentType });
        res.end('not json at all');
      });

      const err = await apiFetch('/documents', { fetchImpl: eventFetch }).catch((e) => e);
      assert.equal(err.constructor.name, 'ApiError', `${status} 非 JSON 应统一归基类 ApiError`);
      assert.ok(!(err instanceof ProtocolError), `${status} 非 JSON 不得归 ProtocolError`);
      assert.ok(!(err instanceof InvalidInputError), `${status} 非 JSON 不得凭状态猜测业务 code`);
      assert.ok(!(err instanceof NotFoundError) && !(err instanceof ServerError)
        && !(err instanceof ServiceUnavailableError), `${status} 非 JSON 不得套用 code 映射`);
      assert.equal(err.status, status, `${status} 必须保留原状态码`);
      assert.equal(err.code, null, `${status} 未给出 error.code 时必须为 null`);
      assert.equal(stats.jsonCalls, 0, `${status} 非 JSON 不得尝试解析正文`);

      await stopServer(server);
      server = null;
    }

    // 401 是非 JSON 错误体的唯一例外：契约要求仍归 AuthError（否则上层无法进 auth_required）。
    const stats401 = { jsonCalls: 0 };
    const eventFetch401 = makeEventFetch(() => fetchImpl, () => {}, stats401);
    await start((req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('Unauthorized');
    });
    const err401 = await apiFetch('/documents', { fetchImpl: eventFetch401 }).catch((e) => e);
    assert.ok(err401 instanceof AuthError, '401 无可读 JSON 时仍归 AuthError');
    assert.equal(err401.status, 401);
    assert.equal(stats401.jsonCalls, 0, '401 非 JSON 同样不得解析正文');
  });

  test('W5-01-c2 同样的状态码，JSON 错误体与非 JSON 错误体的映射必须一致分界', async () => {
    // 同一 400：有标准错误体 → 按 code 映射到 InvalidInputError；无错误体 → 基类 ApiError。
    // 两条都要保留 status，差别只在 code 是否可信。
    const stats = { jsonCalls: 0 };
    const eventFetch = makeEventFetch(() => fetchImpl, () => {}, stats);

    await start((req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: '标题不能为空' } }));
    });
    const withBody = await apiFetch('/documents', { fetchImpl: eventFetch }).catch((e) => e);
    assert.ok(withBody instanceof InvalidInputError);
    assert.equal(withBody.status, 400);
    assert.equal(withBody.code, 'BAD_REQUEST');
    assert.equal(stats.jsonCalls, 1, '声明 JSON 的错误体必须被读取一次');

    await stopServer(server);
    server = null;

    const plainStats = { jsonCalls: 0 };
    const plainFetch = makeEventFetch(() => fetchImpl, () => {}, plainStats);
    await start((req, res) => {
      res.writeHead(400, { 'content-type': 'text/html' });
      res.end('<h1>400</h1>');
    });
    const withoutBody = await apiFetch('/documents', { fetchImpl: plainFetch }).catch((e) => e);
    assert.equal(withoutBody.constructor.name, 'ApiError');
    assert.equal(withoutBody.status, 400, '两种错误体的 status 都必须保留');
    assert.equal(withoutBody.code, null);
    assert.equal(plainStats.jsonCalls, 0);
  });

  // ---------- W5-01-d 错误响应正文读取期间断连 ----------

  test('W5-01-d 500 错误响应正文读取中途断连 → NetworkError（不是 ApiError/ProtocolError）', async () => {
    let headersArrived = false;
    const eventFetch = makeEventFetch(
      () => fetchImpl,
      (name) => {
        if (name === 'headers') headersArrived = true;
      },
      { jsonCalls: 0 },
    );

    await start((req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.write('{"error":{"code":');
      res.flushHeaders();
      // 延迟给响应头留出出网窗口，确保客户端已收到响应头后才断连。
      setTimeout(() => res.destroy(), 30);
    });

    const err = await apiFetch('/documents', { fetchImpl: eventFetch }).catch((e) => e);
    assert.equal(headersArrived, true, '必须先收到响应头，断连才发生在正文阶段');
    assert.ok(err instanceof NetworkError, `正文阶段断连应归 NetworkError，实际 ${err.constructor.name}`);
    // 「不得归 ApiError」这条**不能**写成 `!(err instanceof ApiError) || err instanceof NetworkError`：
    // NetworkError extends ApiError（api.js:136），该式恒真，等于没断言。
    // 真正要约束的是「不得归 ProtocolError」——它是「服务端不符合协议」的语义，
    // 与「正文阶段连接中断」无关；归错会让上层按协议损坏分支处理。
    assert.ok(
      !(err instanceof ProtocolError),
      `正文阶段断连不得归 ProtocolError，实际 ${err.constructor.name}`,
    );
  });

  // ---------- W5-01-e 九类 error.code 同一循环 ----------

  test('W5-01-e 九类 error.code 在真实传输下由同一循环全部映射（含两种 409）', async () => {
    // API.md §4.1 的九个字面量。W3 的循环只列了 8 类，
    // VERSION_CONFLICT 在另一个用例里单独验证，本用例把九类放进同一张表。
    const cases = [
      [400, { code: 'BAD_REQUEST', message: 'x' }, InvalidInputError],
      [401, { code: 'UNAUTHORIZED', message: 'x' }, AuthError],
      [404, { code: 'NOT_FOUND', message: 'x' }, NotFoundError],
      [409, { code: 'USERNAME_TAKEN', message: 'x' }, ConflictError],
      [409, { code: 'VERSION_CONFLICT', message: 'x', details: { server_version: 4 } }, VersionConflictError],
      [413, { code: 'PAYLOAD_TOO_LARGE', message: 'x' }, TooLargeError],
      [429, { code: 'RATE_LIMITED', message: 'x' }, RateLimitedError],
      [503, { code: 'SERVICE_UNAVAILABLE', message: 'x' }, ServiceUnavailableError],
      [500, { code: 'INTERNAL_ERROR', message: 'x' }, ServerError],
    ];

    let checked = 0;
    for (const [status, errorBody, ErrorClass] of cases) {
      await start((req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: errorBody }));
      });

      const err = await apiFetch('/documents', { fetchImpl }).catch((e) => e);
      assert.ok(
        err instanceof ErrorClass,
        `${errorBody.code} 应归 ${ErrorClass.name}，实际 ${err.constructor.name}`,
      );
      assert.equal(err.status, status, `${errorBody.code} 必须保留 HTTP ${status}`);
      assert.equal(err.code, errorBody.code, `${errorBody.code} 必须保留 code 字面量`);

      if (errorBody.code === 'VERSION_CONFLICT') {
        assert.equal(err.serverVersion, 4, 'VERSION_CONFLICT 必须携带 details.server_version');
        assert.ok(!(err instanceof ConflictError), '两种 409 不得混淆');
      } else {
        assert.equal(err.serverVersion, undefined, `${errorBody.code} 不得伪造 serverVersion`);
      }
      checked += 1;
      await stopServer(server);
      server = null;
    }
    assert.equal(checked, 9, '九个错误码都必须各走一次真实传输');
  });

  // ---------- W5-01-f 挂起请求与服务关闭 ----------

  test('W5-01-f 挂起的正文读取在关闭测试服务后被真正清理（不靠定时器猜测阶段）', async () => {
    const { state, timers } = makeTimers();
    const stats = { jsonCalls: 0 };
    let headersResolve;
    const headersSeen = new Promise((r) => {
      headersResolve = r;
    });
    let bodyResolve;
    const bodySeen = new Promise((r) => {
      bodyResolve = r;
    });

    const eventFetch = makeEventFetch(
      () => fetchImpl,
      (name) => {
        if (name === 'headers') headersResolve();
        if (name === 'body-start') bodyResolve();
      },
      stats,
    );

    await start((req, res) => {
      holdResponse(res, 200, { 'content-type': 'application/json' });
    });

    const request = apiFetch('/documents', { fetchImpl: eventFetch, timers });
    request.catch(() => {}); // 断言提前失败时不产生未处理拒绝
    await headersSeen;
    await bodySeen; // 已进入正文读取阶段，服务端仍不结束响应

    const startedAt = Date.now();
    // 关闭服务（含 closeAllConnections）必须在限定时间内完成，否则说明挂起请求未被清理。
    await withDeadline(stopServer(server), 3000, '关闭测试服务');
    server = null;
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 3000, `关闭服务耗时 ${elapsed}ms，超过 3 秒视为挂起`);
    assert.equal(server, null, '服务已关闭并置空，afterEach 不会重复关闭');
    await assert.rejects(request, NetworkError, '连接被服务端断开后必须落到 NetworkError');
    assert.equal(state.clearCalls.length, 1, '挂起请求结束时 finally 必须清理定时器');
    assert.equal(state.trigger(), false, '已清理的定时器不得再触发（否则超时会污染后续用例）');
  });

  test('W5-01-f2 正文读取超时后服务端与客户端都不留残余（定时器已清除、连接已断开）', async () => {
    const { state, timers } = makeTimers();
    const stats = { jsonCalls: 0 };
    let bodyResolve;
    const bodySeen = new Promise((r) => {
      bodyResolve = r;
    });

    const eventFetch = makeEventFetch(
      () => fetchImpl,
      (name) => {
        if (name === 'body-start') bodyResolve();
      },
      stats,
    );

    await start((req, res) => {
      holdResponse(res, 200, { 'content-type': 'application/json' });
    });

    const request = apiFetch('/documents', { fetchImpl: eventFetch, timers });
    request.catch(() => {});
    await bodySeen;
    assert.equal(state.setCalls[0], 10000, '超时必须是 10 秒');
    assert.equal(state.trigger(), true, '正文读取期间超时定时器必须仍有效');
    await assert.rejects(request, TimeoutError);
    assert.equal(state.clearCalls.length, 1, '超时路径也必须清理定时器');

    await withDeadline(stopServer(server), 3000, '超时后关闭测试服务');
    server = null;
  });

  test('W5-01-g 相对路径仍直传：真实请求路径带 /api/v1 且不访问外网', async () => {
    let receivedUrl = null;
    let receivedHost = null;
    await start((req, res) => {
      receivedUrl = req.url;
      receivedHost = req.headers.host;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await apiFetch('/documents?limit=1', { fetchImpl });
    assert.equal(receivedUrl, `${BASE_URL}/documents?limit=1`);
    assert.ok(receivedHost.startsWith('127.0.0.1:'), '所有流量必须落在本机测试服务上');
  });
});
