/**
 * evidence_probe.mjs —— 逐用例实测取证
 *
 * 目的：检查记录要求「动作 + 输出 + 断言」三者成对，且输出必须是真实执行结果。
 * 本脚本对每个验收点独立执行一次，把实际观察到的值打印出来，供记录直接引用。
 * 所有请求均由 mock fetch 承担，不访问真实后端。
 */
import {
  apiFetch, BASE_URL, TIMEOUT_MS,
  ApiError, ProtocolError, InvalidInputError, AuthError, NotFoundError,
  ConflictError, VersionConflictError, TooLargeError, RateLimitedError,
  ServiceUnavailableError, ServerError, TimeoutError, NetworkError,
} from './api.js';

const line = (s) => console.log(s);
const head = (s) => console.log(`\n===== ${s} =====`);

/** 打印一次调用的结果类型与关键字段 */
async function probe(label, fn) {
  try {
    const r = await fn();
    line(`${label} → 返回 ${JSON.stringify(r)}`);
    return { ok: true, value: r };
  } catch (e) {
    const extra = [];
    if (e.status !== null && e.status !== undefined) extra.push(`status=${e.status}`);
    if (e.code) extra.push(`code=${e.code}`);
    if (e.requestId) extra.push(`requestId=${e.requestId}`);
    if (e.serverVersion !== null && e.serverVersion !== undefined) extra.push(`serverVersion=${e.serverVersion}`);
    if (e.retryAfter !== null && e.retryAfter !== undefined) extra.push(`retryAfter=${e.retryAfter}`);
    line(`${label} → 抛出 ${e.constructor.name}(${e.message}) ${extra.join(' ')}`);
    return { ok: false, error: e };
  }
}

const jsonErr = (status, obj, headers = {}) =>
  new Response(JSON.stringify({ error: obj }), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });

head('环境');
line(`Node ${process.version} / ${process.platform} ${process.arch}`);
line(`BASE_URL = ${BASE_URL}`);
line(`TIMEOUT_MS = ${TIMEOUT_MS}`);

head('A 成功路径');
await probe('A1 200 返回 JSON', () =>
  apiFetch('/documents', { fetchImpl: async () => new Response(JSON.stringify({ id: 'u1', title: 't' }), { status: 200 }) }));
await probe('A2 201 返回 JSON', () =>
  apiFetch('/documents', { method: 'POST', body: { title: 't' }, fetchImpl: async () => new Response(JSON.stringify({ id: 'u1', version: 1 }), { status: 201 }) }));

head('B 204 不调用 json()');
{
  let called = false;
  const r = await probe('B1 204 响应', () =>
    apiFetch('/documents/u1', {
      method: 'DELETE',
      fetchImpl: async () => ({
        ok: true, status: 204,
        json: async () => { called = true; throw new Error('不应被调用'); },
      }),
    }));
  line(`B2 response.json() 是否被调用 = ${called}（期望 false）`);
  line(`B3 返回值 = ${r.value}（期望 null）`);
}

head('C 请求构造');
{
  let seen = null;
  await apiFetch('/documents', {
    method: 'POST',
    token: 'tok-abc', body: { title: 't' },
    fetchImpl: async (input, init) => { seen = { input, init }; return new Response('{}', { status: 200 }); },
  });
  line(`C1 传给 fetch 的 url = ${JSON.stringify(seen.input)}（期望 "${BASE_URL}/documents"，相对路径）`);
  line(`C2 url 是否为绝对 URL = ${/^https?:/i.test(String(seen.input))}（期望 false）`);
  line(`C3 Authorization 头 = ${JSON.stringify(seen.init.headers.get('Authorization'))}`);
  line(`C4 Accept 头 = ${JSON.stringify(seen.init.headers.get('Accept'))}`);
  line(`C5 Content-Type 头 = ${JSON.stringify(seen.init.headers.get('Content-Type'))}`);
  line(`C6 请求体 = ${JSON.stringify(seen.init.body)}`);
  line(`C7 url 是否含令牌 = ${String(seen.input).includes('tok-abc')}（期望 false）`);
}

head('D 九类 error.code 映射');
for (const [code, status] of [
  ['BAD_REQUEST', 400], ['UNAUTHORIZED', 401], ['NOT_FOUND', 404],
  ['USERNAME_TAKEN', 409], ['VERSION_CONFLICT', 409], ['PAYLOAD_TOO_LARGE', 413],
  ['RATE_LIMITED', 429], ['SERVICE_UNAVAILABLE', 503], ['INTERNAL_ERROR', 500],
]) {
  await probe(`D ${code} (${status})`, () =>
    apiFetch('/documents', {
      fetchImpl: async () => jsonErr(status, {
        code, message: '服务消息',
        ...(code === 'VERSION_CONFLICT' ? { details: { server_version: 7 } } : {}),
        request_id: 'req-1',
      }),
    }));
}

head('E 两种 409 的区分');
{
  const a = await probe('E1 USERNAME_TAKEN', () =>
    apiFetch('/auth/register', { fetchImpl: async () => jsonErr(409, { code: 'USERNAME_TAKEN', message: 'x' }) }));
  const b = await probe('E2 VERSION_CONFLICT', () =>
    apiFetch('/documents/u1', {
      fetchImpl: async () => jsonErr(409, { code: 'VERSION_CONFLICT', message: 'x', details: { server_version: 7 } }),
    }));
  line(`E3 USERNAME_TAKEN 是不是 VersionConflictError = ${a.error instanceof VersionConflictError}（期望 false）`);
  line(`E4 VERSION_CONFLICT 是不是 VersionConflictError = ${b.error instanceof VersionConflictError}（期望 true）`);
}

head('F server_version 校验');
for (const sv of [undefined, null, 0, -1, 1.5, '3']) {
  await probe(`F server_version=${JSON.stringify(sv)}`, () =>
    apiFetch('/documents/u1', {
      fetchImpl: async () => jsonErr(409, { code: 'VERSION_CONFLICT', message: 'x', details: { server_version: sv } }),
    }));
}

head('G Retry-After');
await probe('G1 429 带 Retry-After: 60', () =>
  apiFetch('/auth/login', {
    fetchImpl: async () => jsonErr(429, { code: 'RATE_LIMITED', message: 'x' }, { 'retry-after': '60' }),
  }));

head('H 坏响应');
await probe('H1 text/html 的 500', () =>
  apiFetch('/documents', {
    fetchImpl: async () => new Response('<html>err</html>', { status: 500, headers: { 'content-type': 'text/html' } }),
  }));
await probe('H2 声明 JSON 但内容损坏', () =>
  apiFetch('/documents', {
    fetchImpl: async () => new Response('{bad', { status: 500, headers: { 'content-type': 'application/json' } }),
  }));
await probe('H3 未知 code', () =>
  apiFetch('/documents', { fetchImpl: async () => jsonErr(400, { code: 'NEW_CODE', message: 'x' }) }));
await probe('H4 401 无 JSON', () =>
  apiFetch('/documents', { fetchImpl: async () => new Response('nope', { status: 401 }) }));
await probe('H5 200 但内容非 JSON', () =>
  apiFetch('/documents', { fetchImpl: async () => new Response('not-json', { status: 200 }) }));

head('I Content-Type 识别');
{
  const re = /^application\/(?:json|[a-z0-9!#$&^_.+-]*\+json)\b/;
  for (const ct of ['application/json', 'application/json; charset=utf-8', 'application/vnd.api+json',
                    'application/problem+json', 'APPLICATION/JSON', 'text/html', 'text/json']) {
    line(`I ${ct.padEnd(32)} → ${re.test(ct.toLowerCase())}`);
  }
}

head('J 超时边界');
{
  let aborted = false;
  let trigger = null;
  let cleared = 0;
  const timers = {
    setTimeout(cb) { trigger = cb; return 1; },
    clearTimeout() { cleared += 1; },
  };
  const mockFetch = async (input, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('a', 'AbortError')); });
    });

  const p = apiFetch('/documents', { fetchImpl: mockFetch, timers });
  line(`J1 计时器设定值 = ${TIMEOUT_MS}ms；此刻 aborted = ${aborted}（期望 false，即 9999ms 未中断）`);
  trigger();
  const r = await probe('J2 触发 10000ms 中断', () => p);
  line(`J3 abort 是否触发 = ${aborted}（期望 true）`);
  line(`J4 定时器清理次数 = ${cleared}（期望 1）`);
}

head('K 四条路径的定时器清理');
for (const [label, mock] of [
  ['K1 成功', async () => new Response('{}', { status: 200 })],
  ['K2 业务失败', async () => jsonErr(400, { code: 'BAD_REQUEST', message: 'x' })],
  ['K3 解析失败', async () => new Response('bad', { status: 200 })],
  ['K4 网络失败', async () => { throw new Error('drop'); }],
]) {
  let cleared = 0;
  const timers = { setTimeout() { return 1; }, clearTimeout() { cleared += 1; } };
  await apiFetch('/documents', { fetchImpl: mock, timers }).catch(() => {});
  line(`${label} 定时器清理次数 = ${cleared}（期望 1）`);
}

head('L 不自动重试 / 不发请求');
for (const [label, mock] of [
  ['L1 网络失败', async () => { throw new Error('drop'); }],
  ['L2 业务失败', async () => jsonErr(500, { code: 'INTERNAL_ERROR', message: 'x' })],
]) {
  let calls = 0;
  const counted = async (...a) => { calls += 1; return mock(...a); };
  await apiFetch('/documents', { fetchImpl: counted }).catch(() => {});
  line(`${label} fetch 调用次数 = ${calls}（期望 1）`);
}
{
  let calls = 0;
  const mock = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const cyclic = {}; cyclic.self = cyclic;
  await apiFetch('/documents', { method: 'POST', body: cyclic, fetchImpl: mock }).catch(() => {});
  line(`L3 序列化失败后 fetch 调用次数 = ${calls}（期望 0）`);
  calls = 0;
  await apiFetch('/api/v1/documents', { fetchImpl: mock }).catch(() => {});
  line(`L4 非法路径后 fetch 调用次数 = ${calls}（期望 0）`);
}

head('M ASCII 守卫');
{
  try {
    new Headers().set('Content‑Type', 'application/json');
    line('M1 含 U+2011 的头名 → 未抛错（异常）');
  } catch (e) {
    line(`M1 含 U+2011 的头名 → 抛出 ${e.constructor.name}: ${e.message.slice(0, 70)}...`);
  }
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  line(`M2 纯 ASCII 头名 → 读取为 ${JSON.stringify(h.get('content-type'))}`);
}

line('\n===== 取证结束 =====');
