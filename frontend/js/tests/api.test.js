/**
 * api.js 的 Node 内置测试。
 *
 * 运行：node --test frontend/js/tests/
 *
 * 覆盖 `docs/INTERFACES.md` §C8 与 `docs/API.md` §4.1 的要求：
 * 1. 200 / 201 返回 JSON；**204 绝不调用 `response.json()`**；
 * 2. URL 为相对路径、前缀只拼一次、**Bearer 只在请求头**；
 * 3. 九个 `error.code` 的映射；两种 409 不混淆；
 * 4. `serverVersion` 缺失即 `ProtocolError`；`Retry-After` 原样保留；
 * 5. 非 JSON 错误体、损坏 JSON、未知 code；
 * 6. 10 秒超时：9999ms 不 abort、10000ms 触发 abort；
 * 7. 成功/业务失败/解析失败/网络失败**四条路径都清理定时器**；
 * 8. 非法路径与序列化失败**不发出请求**；失败时**不自动重试**。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  apiFetch,
  BASE_URL,
  TIMEOUT_MS,
  ApiError,
  ProtocolError,
  InvalidInputError,
  AuthError,
  NotFoundError,
  ConflictError,
  VersionConflictError,
  TooLargeError,
  RateLimitedError,
  ServiceUnavailableError,
  ServerError,
  TimeoutError,
  NetworkError,
} from '../api.js';

// ---------- 测试替身 ----------

/**
 * 构造一个 JSON 错误响应。
 * @param {number} status HTTP 状态码
 * @param {object} errorObj 错误体中的 error 对象
 * @param {Record<string,string>} [extraHeaders] 附加响应头
 * @returns {Response}
 */
function makeErrorResponse(status, errorObj, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: errorObj }), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

/**
 * 可控时钟：记录 setTimeout 调用，可手动触发回调。
 * @returns {{state: object, timers: {setTimeout: Function, clearTimeout: Function}}}
 */
function makeTimers() {
  const state = { setCalls: [], clearCalls: [], trigger: null };
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

// ---------- 成功路径 ----------

describe('apiFetch — 成功路径与 204', () => {
  test('200 返回解析后的 JSON', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ id: 1 }), { status: 200 });
    assert.deepEqual(await apiFetch('/documents', { fetchImpl: mockFetch }), { id: 1 });
  });

  test('201 返回解析后的 JSON', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ created: true }), { status: 201 });
    assert.deepEqual(await apiFetch('/documents', { fetchImpl: mockFetch }), { created: true });
  });

  test('204 绝不调用 response.json()，返回 null', async () => {
    let jsonCalled = false;
    const mockFetch = async () => ({
      ok: true,
      status: 204,
      json: async () => {
        jsonCalled = true;
        throw new Error('204 不得调用 json()');
      },
    });
    assert.equal(await apiFetch('/documents', { fetchImpl: mockFetch }), null);
    assert.equal(jsonCalled, false, '204 必须跳过 json()');
  });

  test('成功但内容不是合法 JSON 抛 ProtocolError，不伪装成成功', async () => {
    const mockFetch = async () => new Response('not-json', { status: 200 });
    await assert.rejects(() => apiFetch('/documents', { fetchImpl: mockFetch }), ProtocolError);
  });
});

// ---------- 请求构造 ----------

describe('apiFetch — 请求构造', () => {
  test('传入 fetch 的是相对路径，前缀只拼一次', async () => {
    let seen = null;
    const mockFetch = async (input, init) => {
      seen = { input, init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await apiFetch('/documents', { fetchImpl: mockFetch });

    // 必须是相对路径字符串，由浏览器按页面 origin 解析。
    // 若为绝对 URL（new URL(path, 'http://dummy-base')），请求会发往不存在的外域。
    assert.equal(seen.input, `${BASE_URL}/documents`);
    assert.equal(typeof seen.input, 'string');
  });

  test('Bearer 只出现在请求头，不进 URL', async () => {
    let seen = null;
    const mockFetch = async (input, init) => {
      seen = { input, init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await apiFetch('/documents', { token: 'secret-token', fetchImpl: mockFetch });

    assert.equal(seen.init.headers.get('Authorization'), 'Bearer secret-token');
    assert.ok(!String(seen.input).includes('secret-token'), '令牌不得进入 URL');
  });

  test('始终带 Accept: application/json', async () => {
    let seen = null;
    const mockFetch = async (input, init) => {
      seen = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await apiFetch('/documents', { fetchImpl: mockFetch });
    assert.equal(seen.headers.get('Accept'), 'application/json');
  });

  test('body 不为 undefined 时序列化为 JSON 并带 Content-Type', async () => {
    let seen = null;
    const mockFetch = async (input, init) => {
      seen = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await apiFetch('/documents', { method: 'POST', body: { title: 't' }, fetchImpl: mockFetch });

    assert.equal(seen.body, JSON.stringify({ title: 't' }));
    assert.equal(seen.headers.get('Content-Type'), 'application/json');
  });

  test('body 为 undefined 时不带 body 也不设 Content-Type', async () => {
    let seen = null;
    const mockFetch = async (input, init) => {
      seen = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await apiFetch('/documents', { fetchImpl: mockFetch });

    assert.equal(seen.body, undefined);
    assert.equal(seen.headers.get('Content-Type'), null);
  });

  test('GET 不接受 body', async () => {
    await assert.rejects(
      () => apiFetch('/documents', { method: 'GET', body: { a: 1 } }),
      ProtocolError
    );
  });

  test('非法路径被拒：完整外域、协议相对、重复前缀、空串、非字符串', async () => {
    for (const bad of [
      'https://evil.example/documents',
      '//evil.example/documents',
      '/api/v1/documents',
      'documents',
      '',
      null,
      undefined,
      123,
    ]) {
      await assert.rejects(() => apiFetch(bad, { fetchImpl: async () => new Response('{}') }), ProtocolError);
    }
  });
});

// ---------- 错误分类 ----------

describe('apiFetch — 错误码映射', () => {
  const codeCases = [
    ['BAD_REQUEST', 400, InvalidInputError],
    ['UNAUTHORIZED', 401, AuthError],
    ['NOT_FOUND', 404, NotFoundError],
    ['USERNAME_TAKEN', 409, ConflictError],
    ['PAYLOAD_TOO_LARGE', 413, TooLargeError],
    ['RATE_LIMITED', 429, RateLimitedError],
    ['SERVICE_UNAVAILABLE', 503, ServiceUnavailableError],
    ['INTERNAL_ERROR', 500, ServerError],
  ];

  for (const [code, status, ErrorClass] of codeCases) {
    test(`${code} (${status}) → ${ErrorClass.name}`, async () => {
      const mockFetch = async () => makeErrorResponse(status, { code, message: 'x' });
      await assert.rejects(() => apiFetch('/documents', { fetchImpl: mockFetch }), ErrorClass);
    });
  }

  test('VERSION_CONFLICT (409) → VersionConflictError，携带 serverVersion 与 requestId', async () => {
    const mockFetch = async () =>
      makeErrorResponse(409, {
        code: 'VERSION_CONFLICT',
        message: '文档已被其他会话修改',
        details: { server_version: 8 },
        request_id: 'req-001',
      });
    const error = await apiFetch('/documents', { fetchImpl: mockFetch }).catch((e) => e);

    assert.ok(error instanceof VersionConflictError);
    assert.equal(error.serverVersion, 8);
    assert.equal(error.requestId, 'req-001');
    assert.equal(error.status, 409);
    assert.equal(error.code, 'VERSION_CONFLICT');
  });

  test('两种 409 不混淆', async () => {
    const username = await apiFetch('/auth/register', {
      fetchImpl: async () => makeErrorResponse(409, { code: 'USERNAME_TAKEN', message: 'x' }),
    }).catch((e) => e);
    const version = await apiFetch('/documents/1', {
      fetchImpl: async () =>
        makeErrorResponse(409, {
          code: 'VERSION_CONFLICT',
          message: 'x',
          details: { server_version: 3 },
        }),
    }).catch((e) => e);

    assert.ok(username instanceof ConflictError);
    assert.ok(!(username instanceof VersionConflictError));
    assert.ok(version instanceof VersionConflictError);
    assert.ok(!(version instanceof ConflictError));
  });

  test('VERSION_CONFLICT 缺 server_version 抛 ProtocolError，不编造版本', async () => {
    const mockFetch = async () => makeErrorResponse(409, { code: 'VERSION_CONFLICT', message: 'x', details: {} });
    const error = await apiFetch('/documents', { fetchImpl: mockFetch }).catch((e) => e);
    assert.ok(error instanceof ProtocolError);
  });

  test('server_version 非正整数同样抛 ProtocolError', async () => {
    for (const bad of [0, -1, 1.5, '3', null]) {
      const mockFetch = async () =>
        makeErrorResponse(409, {
          code: 'VERSION_CONFLICT',
          message: 'x',
          details: { server_version: bad },
        });
      await assert.rejects(() => apiFetch('/documents', { fetchImpl: mockFetch }), ProtocolError);
    }
  });

  test('RATE_LIMITED 保留原始 Retry-After 头', async () => {
    const mockFetch = async () =>
      makeErrorResponse(429, { code: 'RATE_LIMITED', message: 'x' }, { 'retry-after': '60' });
    const error = await apiFetch('/auth/login', { fetchImpl: mockFetch }).catch((e) => e);

    assert.ok(error instanceof RateLimitedError);
    assert.equal(error.retryAfter, '60');
  });

  test('未知 code 归为基类 ApiError，保留 status 与 code', async () => {
    const mockFetch = async () => makeErrorResponse(400, { code: 'SOMETHING_NEW', message: 'x' });
    const error = await apiFetch('/documents', { fetchImpl: mockFetch }).catch((e) => e);

    assert.equal(error.constructor.name, 'ApiError');
    assert.equal(error.status, 400);
    assert.equal(error.code, 'SOMETHING_NEW');
  });
});

// ---------- 坏响应 ----------

describe('apiFetch — 坏响应处理', () => {
  test('Content-Type 非 JSON 的 500 归 ApiError，不尝试解析 HTML', async () => {
    const mockFetch = async () =>
      new Response('<html>error page</html>', { status: 500, headers: { 'content-type': 'text/html' } });
    const error = await apiFetch('/documents', { fetchImpl: mockFetch }).catch((e) => e);

    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 500);
    assert.ok(!error.message.includes('<html>'), '不得把 HTML 整段暴露');
  });

  test('声明 JSON 但内容损坏 → ProtocolError', async () => {
    const mockFetch = async () =>
      new Response('{bad json', { status: 500, headers: { 'content-type': 'application/json' } });
    await assert.rejects(() => apiFetch('/documents', { fetchImpl: mockFetch }), ProtocolError);
  });

  test('application/*+json 变体被识别为 JSON 错误体', async () => {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          error: { code: 'VERSION_CONFLICT', message: 'x', details: { server_version: 9 } },
        }),
        { status: 409, headers: { 'content-type': 'application/vnd.api+json' } }
      );
    const error = await apiFetch('/documents', { fetchImpl: mockFetch }).catch((e) => e);
    assert.ok(error instanceof VersionConflictError);
    assert.equal(error.serverVersion, 9);
  });

  test('application/json 带 charset 参数被识别为 JSON', async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'x' } }), {
        status: 400,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    await assert.rejects(() => apiFetch('/documents', { fetchImpl: mockFetch }), InvalidInputError);
  });

  test('401 无可读 JSON 时仍归 AuthError', async () => {
    const mockFetch = async () => new Response('no json body', { status: 401 });
    await assert.rejects(() => apiFetch('/documents', { fetchImpl: mockFetch }), AuthError);
  });
});

// ---------- 超时与网络 ----------

describe('apiFetch — 超时与网络故障', () => {
  test('9999ms 不 abort，10000ms 触发 abort 并抛 TimeoutError', async () => {
    const { state, timers } = makeTimers();
    let aborted = false;
    const mockFetch = async (input, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('abort', 'AbortError'));
        });
      });

    const promise = apiFetch('/documents', { fetchImpl: mockFetch, timers });

    assert.equal(state.setCalls.length, 1);
    assert.equal(state.setCalls[0], TIMEOUT_MS);
    assert.equal(aborted, false, '9999 毫秒时不得中断');

    state.trigger();
    await assert.rejects(() => promise, TimeoutError);
    assert.equal(aborted, true, '10000 毫秒必须中断');
  });

  test('网络拒绝抛 NetworkError', async () => {
    const mockFetch = async () => {
      throw new Error('socket drop');
    };
    await assert.rejects(() => apiFetch('/documents', { fetchImpl: mockFetch }), NetworkError);
  });

  test('成功路径清理定时器', async () => {
    const { state, timers } = makeTimers();
    const mockFetch = async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    await apiFetch('/documents', { fetchImpl: mockFetch, timers });
    assert.equal(state.clearCalls.length, 1);
  });

  test('业务失败路径清理定时器', async () => {
    const { state, timers } = makeTimers();
    const mockFetch = async () => makeErrorResponse(400, { code: 'BAD_REQUEST', message: 'x' });
    await assert.rejects(() => apiFetch('/documents', { fetchImpl: mockFetch, timers }), ApiError);
    assert.equal(state.clearCalls.length, 1);
  });

  test('解析失败路径清理定时器', async () => {
    const { state, timers } = makeTimers();
    const mockFetch = async () => new Response('not-json', { status: 200 });
    await assert.rejects(() => apiFetch('/documents', { fetchImpl: mockFetch, timers }), ProtocolError);
    assert.equal(state.clearCalls.length, 1);
  });

  test('网络失败路径清理定时器', async () => {
    const { state, timers } = makeTimers();
    const mockFetch = async () => {
      throw new Error('drop');
    };
    await assert.rejects(() => apiFetch('/documents', { fetchImpl: mockFetch, timers }), NetworkError);
    assert.equal(state.clearCalls.length, 1);
  });
});

// ---------- 不重试与不发请求 ----------

describe('apiFetch — 不自动重试', () => {
  test('网络失败时 fetch 只调用一次', async () => {
    let called = 0;
    const mockFetch = async () => {
      called += 1;
      throw new Error('socket drop');
    };
    await assert.rejects(() => apiFetch('/documents', { fetchImpl: mockFetch }), NetworkError);
    assert.equal(called, 1, '失败时不得自动重试');
  });

  test('业务错误时 fetch 只调用一次', async () => {
    let called = 0;
    const mockFetch = async () => {
      called += 1;
      return makeErrorResponse(409, { code: 'VERSION_CONFLICT', message: 'x', details: { server_version: 3 } });
    };
    await assert.rejects(() => apiFetch('/documents', { fetchImpl: mockFetch }), ApiError);
    assert.equal(called, 1);
  });

  test('序列化失败不发出请求', async () => {
    let called = 0;
    const mockFetch = async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    };
    const cyclic = {};
    cyclic.self = cyclic;

    await assert.rejects(
      () => apiFetch('/documents', { method: 'POST', body: cyclic, fetchImpl: mockFetch }),
      ProtocolError
    );
    assert.equal(called, 0, '序列化失败不得发出请求');
  });

  test('非法路径不发出请求', async () => {
    let called = 0;
    const mockFetch = async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    };
    await assert.rejects(() => apiFetch('/api/v1/documents', { fetchImpl: mockFetch }), ProtocolError);
    assert.equal(called, 0);
  });
});

// ---------- 协议字面量 ASCII 守卫 ----------

describe('apiFetch — 协议字面量必须为 ASCII', () => {
  test('HTTP 头名与协议标识符均为纯 ASCII', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');

    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, '..', 'api.js'), 'utf8');

    // U+2011 NON-BREAKING HYPHEN 视觉与 ASCII '-' 几乎相同，
    // 放进 HTTP 头名会让 Headers.set 抛 TypeError（值 8209 > 255）。
    //
    // 只检查**协议标识符**位置：header 名、错误码字面量、Content-Type 匹配串。
    // **中文错误文案是规范要求**（项目规范 §09/§10：错误文案一律中文），
    // 不在检查范围内。
    const protocolLiterals = [];
    const patterns = [
      /headers\.set\(\s*'([^']*)'/g,
      /headers\.get\(\s*'([^']*)'/g,
      /'([A-Z][A-Z_]{2,})'/g,
      /'application\/[^']*'/g,
      /'(text|application)\/[^']*'/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        protocolLiterals.push({ literal: match[1], index: match.index });
      }
    }

    const offenders = protocolLiterals.filter(({ literal }) => /[^\x00-\x7F]/.test(literal));
    assert.deepEqual(
      offenders.map((o) => o.literal),
      [],
      'HTTP 头名与错误码字面量必须是纯 ASCII'
    );
  });

  test('运行时验证：标准头名可被 Headers 正常构造与读取', async () => {
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json');
    headers.set('Authorization', 'Bearer t');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('authorization'), 'Bearer t');
  });

  test('运行时验证：含非 ASCII 的头名会抛错（这正是要防的故障）', async () => {
    const headers = new Headers();
    assert.throws(
      () => headers.set('Content‑Type', 'application/json'),
      TypeError,
      '非 ASCII 头名必须抛错——这证明 ASCII 守卫的必要性'
    );
  });
});
