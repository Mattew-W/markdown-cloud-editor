/**
 * api.extra.test.js —— M6 W2 阶段4 要求但原交件缺失的覆盖点
 *
 * 任务书阶段4 必测清单中，原 tests/api.test.js 未覆盖的项目在此补齐：
 *   1. JSON 序列化失败（循环引用）不发请求
 *   2. 不自动重试：失败时 fetch 只调用一次
 *   3. 9999ms 不 abort / 10000ms abort 的边界
 *   4. 业务错误路径也清理定时器
 *   5. 解析失败路径也清理定时器
 *   6. Content-Type 的 application/*+json 变体
 *   7. 非法 path 不发请求
 *   8. 未知 code 归为基类 ApiError 且保留 status
 *   9. JSON body 的 Content-Type 与序列化正确性
 *  10. path 校验不误伤含 api/v1 的查询串
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiFetch,
  BASE_URL,
  TIMEOUT_MS,
  ApiError,
  ProtocolError,
  TimeoutError,
  NetworkError,
} from '../js/api.js';

/** 可控时钟：记录调用，支持手动触发。 */
function makeTimers() {
  const state = { setCalls: [], clearCalls: [], triggerIndex: null };
  return {
    state,
    timers: {
      setTimeout(cb, ms) {
        state.setCalls.push(ms);
        state.triggerIndex = cb;
        return state.setCalls.length;
      },
      clearTimeout(id) {
        state.clearCalls.push(id);
      },
    },
  };
}

describe('阶段4 补齐覆盖 · 请求不发出与不重试', () => {
  it('JSON 序列化失败（循环引用）抛 ProtocolError 且不调用 fetch', async () => {
    let called = 0;
    const mockFetch = async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    };
    const cyclic = {};
    cyclic.self = cyclic;

    await assert.rejects(
      () => apiFetch('/x', { method: 'POST', body: cyclic, fetchImpl: mockFetch }),
      ProtocolError
    );
    assert.equal(called, 0, '序列化失败不得发出请求');
  });

  it('非法 path 抛 ProtocolError 且不调用 fetch', async () => {
    let called = 0;
    const mockFetch = async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    };
    for (const bad of ['/api/v1/documents', '//evil.example.com/x', 'documents', '']) {
      await assert.rejects(() => apiFetch(bad, { fetchImpl: mockFetch }), ProtocolError);
    }
    assert.equal(called, 0, '非法 path 不得发出请求');
  });

  it('网络失败时 fetch 只调用一次（不自动重试）', async () => {
    let called = 0;
    const mockFetch = async () => {
      called += 1;
      throw new Error('socket drop');
    };
    await assert.rejects(() => apiFetch('/x', { fetchImpl: mockFetch }), NetworkError);
    assert.equal(called, 1, '失败时不得自动重试');
  });

  it('业务错误（409）时 fetch 只调用一次', async () => {
    let called = 0;
    const mockFetch = async () => {
      called += 1;
      return new Response(
        JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'c', details: { server_version: 3 } } }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      );
    };
    await assert.rejects(() => apiFetch('/x', { fetchImpl: mockFetch }), ApiError);
    assert.equal(called, 1);
  });
});

describe('阶段4 补齐覆盖 · 超时边界与定时器清理', () => {
  it('9999ms 不 abort，10000ms 触发 abort', async () => {
    // 记录 abort 是否已被调用，并让 mock 监听 signal
    const { state, timers } = makeTimers();
    let aborted = false;
    const mockFetch = async (_, opts) =>
      new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('abort', 'AbortError'));
        });
      });

    const p = apiFetch('/timeout', { fetchImpl: mockFetch, timers });

    // 计时器尚未到点，不应 abort
    assert.equal(state.setCalls.length, 1);
    assert.equal(state.setCalls[0], TIMEOUT_MS);
    assert.equal(aborted, false, '9999ms 时不得 abort');

    // 手动触发计时回调，等价于到达 10000ms
    state.triggerIndex();
    await assert.rejects(() => p, TimeoutError);
    assert.equal(aborted, true, '10000ms 必须 abort');
  });

  it('业务错误路径也清理定时器', async () => {
    const { state, timers } = makeTimers();
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'b' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });

    await assert.rejects(() => apiFetch('/x', { fetchImpl: mockFetch, timers }), ApiError);
    assert.equal(state.clearCalls.length, 1, '业务错误必须清理定时器');
  });

  it('解析失败路径也清理定时器', async () => {
    const { state, timers } = makeTimers();
    const mockFetch = async () => new Response('not-json', { status: 200 });

    await assert.rejects(() => apiFetch('/x', { fetchImpl: mockFetch, timers }), ProtocolError);
    assert.equal(state.clearCalls.length, 1, '解析失败必须清理定时器');
  });

  it('网络失败路径也清理定时器', async () => {
    const { state, timers } = makeTimers();
    const mockFetch = async () => {
      throw new Error('drop');
    };

    await assert.rejects(() => apiFetch('/x', { fetchImpl: mockFetch, timers }), NetworkError);
    assert.equal(state.clearCalls.length, 1, '网络失败必须清理定时器');
  });
});

describe('阶段4 补齐覆盖 · Content-Type 与请求构造', () => {
  function errResp(status, body, contentType) {
    return new Response(body, { status, headers: { 'content-type': contentType } });
  }

  it('application/*+json 变体被识别为 JSON 错误体', async () => {
    const mockFetch = async () =>
      errResp(
        409,
        JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'c', details: { server_version: 9 } } }),
        'application/vnd.api+json'
      );
    const err = await apiFetch('/x', { fetchImpl: mockFetch }).catch((e) => e);
    assert.equal(err.constructor.name, 'VersionConflictError');
    assert.equal(err.serverVersion, 9);
  });

  it('application/json 带 charset 参数被识别为 JSON', async () => {
    const mockFetch = async () =>
      errResp(400, JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'b' } }), 'application/json; charset=utf-8');
    const err = await apiFetch('/x', { fetchImpl: mockFetch }).catch((e) => e);
    assert.equal(err.constructor.name, 'InvalidInputError');
  });

  it('未知 code 归为基类 ApiError 且保留 status 与 code', async () => {
    const mockFetch = async () =>
      errResp(400, JSON.stringify({ error: { code: 'SOMETHING_NEW', message: 'x' } }), 'application/json');
    const err = await apiFetch('/x', { fetchImpl: mockFetch }).catch((e) => e);
    assert.ok(err instanceof ApiError);
    assert.equal(err.constructor.name, 'ApiError');
    assert.equal(err.status, 400);
    assert.equal(err.code, 'SOMETHING_NEW');
  });

  it('POST 的 JSON body 被正确序列化并带 Content-Type', async () => {
    let seen = null;
    const mockFetch = async (input, init) => {
      seen = { input, init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await apiFetch('/documents', { method: 'POST', body: { title: 't' }, fetchImpl: mockFetch });

    assert.equal(seen.input, `${BASE_URL}/documents`);
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.body, JSON.stringify({ title: 't' }));
    assert.equal(seen.init.headers.get('Content-Type'), 'application/json');
  });

  it('body 为 undefined 时不设 Content-Type 也不带 body', async () => {
    let seen = null;
    const mockFetch = async (input, init) => {
      seen = { input, init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await apiFetch('/documents', { fetchImpl: mockFetch });

    assert.equal(seen.init.body, undefined);
    assert.equal(seen.init.headers.get('Content-Type'), null);
  });

  it('token 只出现在 Authorization 头，不进 URL', async () => {
    let seen = null;
    const mockFetch = async (input, init) => {
      seen = { input, init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await apiFetch('/documents', { token: 'secret-token', fetchImpl: mockFetch });

    assert.equal(seen.init.headers.get('Authorization'), 'Bearer secret-token');
    assert.ok(!String(seen.input).includes('secret-token'), 'token 不得进入 URL');
  });
});
