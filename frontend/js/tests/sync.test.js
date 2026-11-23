/**
 * sync.test.js —— 自动保存状态机的单元测试（M1 W4）
 *
 * 覆盖 W4 任务书的验收编号：
 *   - M1-02 调度：1500ms 防抖 / 5000ms max-wait / 同文档最多一个 PUT /
 *                 在途输入合并为最新快照 / base_version 取响应值不自行 +1 /
 *                 响应不写回编辑器
 *   - M1-03 会话隔离：A→B→A / 切换账号 / 退出销毁后旧响应不得修改新会话状态
 *   - M1-04 错误分支：401→auth_required / 409→conflict / 400·413→invalid /
 *                 网络·超时·5xx→retry_wait / 429 遵守 Retry-After /
 *                 §6 四分支先核对云端再重试 / 阻塞态不被新输入或手动保存解除
 *   - M1-05 存储失败：写入失败不得显示"已在本地备份" / 保留内存内容 /
 *                 草稿条件删除符合 INTERFACES / 不得用 force:true 绕开核对
 *
 * 按 docs/SYNC.md §7.3 的要求，**全部使用可控时钟**，不依赖真实等待。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SyncEngine, SyncState, BACKOFF_LADDER } from '../sync.js';

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

/**
 * 可控时钟。
 *
 * 必须**同时**实现 setTimeout 与 clearTimeout —— 只实现前者会让取消变成空操作，
 * 旧定时器照样到点触发，把之后排入的快照提前写走。
 */
function makeClock() {
  let now = 0;
  let seq = 0;
  /** @type {Map<number, {fn: Function, at: number, id: number}>} */
  const timers = new Map();

  return {
    timers,
    get now() {
      return now;
    },
    setTimeout(fn, ms) {
      seq += 1;
      const id = seq;
      timers.set(id, { fn, at: now + (ms || 0), id });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** 推进时钟并触发到期回调。 */
    tick(ms) {
      const target = now + ms;
      // 可能因回调内再排入定时器而反复触发，按到期时间顺序处理。
      for (;;) {
        const due = [...timers.values()]
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due.id);
        now = due.at;
        due.fn();
      }
      now = target;
    },
  };
}

/**
 * 记录所有 fetch 调用的假 fetch。
 *
 * @param {Array<{status?: number, body?: object, headers?: object, delay?: boolean}>} plan
 */
function makeFetch(plan = []) {
  const calls = [];
  let index = 0;

  const impl = async (url, init = {}) => {
    const entry = {
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body) : null,
      headers: Object.fromEntries(init.headers?.entries?.() ?? []),
    };
    calls.push(entry);

    const spec = plan[index] ?? { status: 200, body: { version: 1 } };
    index += 1;

    if (spec.throw) {
      throw spec.throw;
    }
    if (spec.delay) {
      // 受控 promise：测试可手动决定何时 resolve。
      return new Promise((resolve, reject) => {
        spec.resolve = () =>
          resolve({
            ok: (spec.status ?? 200) >= 200 && (spec.status ?? 200) < 300,
            status: spec.status ?? 200,
            headers: new Headers(spec.headers ?? { 'content-type': 'application/json' }),
            json: async () => spec.body ?? {},
            text: async () => JSON.stringify(spec.body ?? {}),
          });
        spec.reject = (e) => reject(e);
      });
    }

    const status = spec.status ?? 200;
    return {
      // `ok` 是 Response 的标准属性，api.js 用它判断成功分支。
      // 漏掉它会让所有成功响应被当成错误响应。
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(spec.headers ?? { 'content-type': 'application/json' }),
      json: async () => spec.body ?? {},
      text: async () => JSON.stringify(spec.body ?? {}),
    };
  };

  impl.calls = calls;
  return impl;
}

/**
 * 内存存储适配器。
 *
 * Node 环境没有 `window.localStorage`，`drafts.js` 的默认适配器会抛
 * 「浏览器禁止本地存储」。测试必须注入可用的存储，否则每个用例
 * 都会在第一次写草稿时失败。
 *
 * @param {Map<string,string>} [seed] 初始内容
 */
function makeStorage(seed = new Map()) {
  const store = seed instanceof Map ? seed : new Map(Object.entries(seed));
  return {
    store,
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
}

/** 构造一个带可控时钟的引擎。 */
function makeEngine(options = {}) {
  const clock = options.clock ?? makeClock();
  const fetchImpl = options.fetchImpl ?? makeFetch(options.plan ?? []);
  const states = [];
  const conflicts = [];
  const storageFailures = [];
  const cloudUnavailable = [];

  const engine = new SyncEngine(
    {
      onStateChange: (state, payload) => states.push({ state, payload }),
      onConflict: (info) => conflicts.push(info),
      onError: () => {},
      onSaveSuccess: (resp) => states.push({ state: 'onSaveSuccess', payload: resp }),
      onStorageFailure: (info) => storageFailures.push(info),
      onCloudUnavailable: (info) => cloudUnavailable.push(info),
    },
    {
      timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
      fetchImpl,
      random: () => 0,
      // 未显式给出存储时用内存适配器，避免 Node 环境无 localStorage 导致全盘失败。
      storage: options.storage ?? makeStorage(),
    },
  );

  return { engine, clock, fetchImpl, states, conflicts, storageFailures, cloudUnavailable };
}

/**
 * 冲刷微任务队列。
 *
 * `flushSave()` 是 async 函数，内部有多层 await（apiFetch → fetch impl → JSON）。
 * 单次 `await Promise.resolve()` 只能推进一层 microtask，状态还没落地。
 * 这里用一个宏任务边界把整条链冲干净。
 *
 * @param {number} [rounds=8]
 */
async function flushAsync(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** 最后一个状态。 */
function lastState(states) {
  return states[states.length - 1]?.state;
}

// ---------------------------------------------------------------------------
// M1-02 调度
// ---------------------------------------------------------------------------

test('M1-02 防抖 1500ms：1400ms 内不发请求，1600ms 后发一次', async () => {
  const { engine, clock, fetchImpl } = makeEngine({
    plan: [{ status: 200, body: { version: 2 } }],
  });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });

  engine.onInput('T', 'C1');
  clock.tick(1400);
  assert.equal(fetchImpl.calls.length, 0, '1400ms 时不得发请求');

  clock.tick(200);
  assert.equal(fetchImpl.calls.length, 1, '1600ms 时应发出一次');
  assert.equal(fetchImpl.calls[0].method, 'PUT');
  assert.equal(fetchImpl.calls[0].body.content, 'C1');
});

test('M1-02 max-wait 5000ms：持续输入时 5 秒必发一次，不被防抖无限推迟', async () => {
  const { engine, clock, fetchImpl } = makeEngine({
    plan: [{ status: 200, body: { version: 2 } }],
  });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });

  // 每 400ms 输入一次，持续超过防抖窗口。
  for (let i = 0; i < 13; i += 1) {
    engine.onInput('T', `C${i}`);
    clock.tick(400);
  }
  assert.equal(fetchImpl.calls.length, 1, '5.2 秒时应恰好发出一次');
  assert.equal(fetchImpl.calls[0].body.content, 'C12', '发送的是当时最新快照');

  clock.tick(2000);
  assert.equal(fetchImpl.calls.length, 1, 'max-wait 之后不应重复发送');
});

test('M1-02 同文档同时最多一个 PUT 在途', async () => {
  const plan = [{ delay: true, status: 200, body: { version: 2 } }];
  const { engine, clock, fetchImpl } = makeEngine({ plan });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });

  engine.onInput('T', 'C1');
  clock.tick(1600);
  assert.equal(fetchImpl.calls.length, 1, '第一个 PUT 已发出');

  // 期间继续输入并再次触发调度。
  engine.onInput('T', 'C2');
  clock.tick(2000);
  assert.equal(fetchImpl.calls.length, 1, '在途期间不得发出第二个 PUT');
});

test('M1-02 在途期间的输入合并为最新快照', async () => {
  const plan = [
    { delay: true, status: 200, body: { version: 2 } },
    { status: 200, body: { version: 3 } },
  ];
  const { engine, clock, fetchImpl } = makeEngine({ plan });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });

  engine.onInput('T', 'C1');
  clock.tick(1600);
  assert.equal(fetchImpl.calls[0].body.content, 'C1');

  // 第一个 PUT 在途时产生新输入。
  engine.onInput('T', 'C2');
  plan[0].resolve();
  await flushAsync();
  clock.tick(1600);

  assert.equal(fetchImpl.calls.length, 2, '应补发第二次');
  assert.equal(fetchImpl.calls[1].body.content, 'C2', '第二次必须带最新快照');
});

test('M1-02 base_version 取服务端响应值，不自行 +1', async () => {
  const { engine, clock } = makeEngine({
    plan: [{ status: 200, body: { version: 77 } }],
  });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 5 });

  engine.onInput('T', 'C1');
  clock.tick(1600);
  await flushAsync();

  assert.equal(engine.baseVersion, 77, 'base_version 必须等于响应 version，而非 6');
});

test('M1-02 响应不得写回编辑器内容', async () => {
  const { engine, clock } = makeEngine({
    plan: [{ status: 200, body: { version: 2, title: 'SRV', content: 'SRVC' } }],
  });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });

  engine.onInput('T', 'C1');
  clock.tick(1600);
  await flushAsync();

  assert.equal(engine.currentContent, 'C1', '响应不得覆盖本地正文');
  assert.equal(engine.currentTitle, 'T', '响应不得覆盖本地标题');
});

// ---------------------------------------------------------------------------
// M1-03 会话隔离
// ---------------------------------------------------------------------------

test('M1-03 A→B→A：A 的迟到响应不得修改 B 的状态与内容', async () => {
  const plan = [
    { delay: true, status: 200, body: { id: 'docA', version: 99 } },
  ];
  const { engine, clock, fetchImpl, states } = makeEngine({ plan });

  engine.initSession('uA', 'tokA', { id: 'docA', title: 'A', content: 'A0', version: 1 });
  engine.onInput('A', 'A-rev7');
  clock.tick(1600);
  assert.equal(fetchImpl.calls.length, 1, 'A 的 PUT 应已发出');

  // 切到 B。
  engine.initSession('uB', 'tokB', { id: 'docB', title: 'B', content: 'B0', version: 5 });
  const baseBefore = engine.baseVersion;
  const contentBefore = engine.currentContent;

  // A 的迟到响应到达。
  plan[0].resolve();
  await flushAsync();

  assert.equal(engine.baseVersion, baseBefore, 'B 的 baseVersion 不得被 A 的响应覆盖');
  assert.equal(engine.currentContent, contentBefore, 'B 的内容不得被 A 的响应污染');
  assert.equal(
    states.filter((s) => s.state === 'onSaveSuccess').length,
    0,
    '旧响应不得触发 onSaveSuccess（那会改写当前 UI）',
  );
});

test('M1-03 切换账号后旧账号响应不得影响新账号', async () => {
  const plan = [{ delay: true, status: 200, body: { id: 'docA', version: 99 } }];
  const { engine, clock } = makeEngine({ plan });

  engine.initSession('uA', 'tokA', { id: 'docA', title: 'A', content: 'A0', version: 1 });
  engine.onInput('A', 'A-rev7');
  clock.tick(1600);

  // 切换账号。
  engine.initSession('uB', 'tokB', { id: 'docB', title: 'B', content: 'B0', version: 5 });
  const baseBefore = engine.baseVersion;

  plan[0].resolve();
  await flushAsync();

  assert.equal(engine.baseVersion, baseBefore);
  assert.equal(engine.userId, 'uB');
});

test('M1-03 退出（destroy）后到达的旧响应不得修改任何状态', async () => {
  const plan = [{ delay: true, status: 200, body: { id: 'docA', version: 99 } }];
  const { engine, clock, states } = makeEngine({ plan });

  engine.initSession('uA', 'tokA', { id: 'docA', title: 'A', content: 'A0', version: 1 });
  engine.onInput('A', 'A-rev7');
  clock.tick(1600);

  engine.destroy();
  const snapshotAfterDestroy = {
    baseVersion: engine.baseVersion,
    acked: engine.ackedRevision,
  };

  plan[0].resolve();
  await flushAsync();

  assert.equal(engine.baseVersion, snapshotAfterDestroy.baseVersion, '销毁后 baseVersion 不得变化');
  assert.equal(engine.ackedRevision, snapshotAfterDestroy.acked, '销毁后 ackedRevision 不得变化');
  assert.equal(engine.userId, null);
  assert.equal(
    states.filter((s) => s.state === 'onSaveSuccess').length,
    0,
    '销毁后的旧响应不得触发 onSaveSuccess',
  );
});

test('M1-03 每次打开文档生成新的 session id', async () => {
  const { engine } = makeEngine();
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });
  const first = engine.editSessionId;
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });
  const second = engine.editSessionId;
  assert.notEqual(first, second, '每次打开文档必须新生成 session id');
});

// ---------------------------------------------------------------------------
// M1-04 错误分支
// ---------------------------------------------------------------------------

test('M1-04 401 进入 auth_required 且不自动重试', async () => {
  const { engine, clock, fetchImpl } = makeEngine({
    plan: [{ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'x' } } }],
  });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });

  engine.onInput('T', 'C1');
  clock.tick(1600);
  await flushAsync();

  assert.equal(engine.state, SyncState.AUTH_REQUIRED);
  const before = fetchImpl.calls.length;
  clock.tick(60000);
  assert.equal(fetchImpl.calls.length, before, '401 后不得自动重试');
});

test('M1-04 409 进入 conflict 并携带 serverVersion', async () => {
  const { engine, clock, conflicts } = makeEngine({
    plan: [
      {
        status: 409,
        body: { error: { code: 'VERSION_CONFLICT', message: 'x', details: { server_version: 9 } } },
      },
    ],
  });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });

  engine.onInput('T', 'C1');
  clock.tick(1600);
  await flushAsync();

  assert.equal(engine.state, SyncState.CONFLICT);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].serverVersion, 9);
});

test('M1-04 400 与 413 进入 invalid', async () => {
  for (const [status, code] of [
    [400, 'BAD_REQUEST'],
    [413, 'PAYLOAD_TOO_LARGE'],
  ]) {
    const { engine, clock } = makeEngine({
      plan: [{ status, body: { error: { code, message: 'x' } } }],
    });
    engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });
    engine.onInput('T', 'C1');
    clock.tick(1600);
    await flushAsync();
    assert.equal(engine.state, SyncState.INVALID, `${status} 应进入 invalid`);
  }
});

test('M1-04 网络错误先核对云端再处置（不得盲重发 PUT）', async () => {
  // 第一次 PUT：服务端已提交但响应丢失（网络错误）。
  // 随后 GET 返回 version=2 且内容相同 —— 分支 ①，应确认已持久化。
  const plan = [
    { throw: new Error('network down') },
    { status: 200, body: { id: 'doc1', title: 'T', content: 'C1', version: 2 } },
    { status: 200, body: { id: 'doc1', version: 3 } },
  ];
  const { engine, clock, fetchImpl } = makeEngine({ plan });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });

  engine.onInput('T', 'C1');
  clock.tick(1600);
  await flushAsync();

  assert.equal(engine.state, SyncState.RETRY_WAIT, '网络错误应先进入 retry_wait');
  engine.onInput('T', '核对期间的新内容');
  await engine.flushSave();
  assert.deepEqual(fetchImpl.calls.map(({ method }) => method), ['PUT']);

  // 退避后触发核对。
  clock.tick(2000);
  await flushAsync();

  assert.equal(fetchImpl.calls.length, 2, '第二次调用应是 GET 核对');
  assert.equal(fetchImpl.calls[1].method, 'GET', '必须先 GET 核对，不能盲重发 PUT');
  assert.equal(engine.baseVersion, 2, '分支 ①：应采纳读取到的版本');
  assert.equal(engine.state, SyncState.DIRTY, '核对仅确认原快照，新内容仍待保存');
  clock.tick(1600);
  await flushAsync();
  assert.equal(fetchImpl.calls[2].method, 'PUT');
  assert.equal(engine.state, SyncState.SYNCED);
});

test('M1-04 §6 分支 ②：云端版本仍等于 base_version 时用原 expected_version 重试', async () => {
  const plan = [
    { throw: new Error('network down') },
    { status: 200, body: { id: 'doc1', title: 'T', content: 'C0', version: 1 } },
    { status: 200, body: { id: 'doc1', version: 2 } },
  ];
  const { engine, clock, fetchImpl } = makeEngine({ plan });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });

  engine.onInput('T', 'C1');
  clock.tick(1600);
  await flushAsync();

  clock.tick(2000);
  await flushAsync();

  assert.equal(fetchImpl.calls[1].method, 'GET', '先 GET 核对');
  assert.equal(fetchImpl.calls[2].method, 'PUT', '分支 ② 才重试');
  assert.equal(
    fetchImpl.calls[2].body.expected_version,
    1,
    '分支 ② 必须用原 expected_version',
  );
});

test('M1-04 §6 分支 ③：版本已变且内容不同进入 conflict', async () => {
  const plan = [
    { throw: new Error('network down') },
    { status: 200, body: { id: 'doc1', title: 'T', content: '他人内容', version: 7 } },
  ];
  const { engine, clock, conflicts } = makeEngine({ plan });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });

  engine.onInput('T', 'C1');
  clock.tick(1600);
  await flushAsync();

  clock.tick(2000);
  await flushAsync();

  assert.equal(engine.state, SyncState.CONFLICT, '分支 ③ 应进入 conflict');
  assert.equal(conflicts[0].serverVersion, 7);
});

test('M1-04 §6 分支 ④：读取返回 404 提示云端不可用并保留本地内容', async () => {
  const plan = [
    { throw: new Error('network down') },
    { status: 404, body: { error: { code: 'NOT_FOUND', message: 'x' } } },
  ];
  const { engine, clock, cloudUnavailable } = makeEngine({ plan });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });

  engine.onInput('T', 'C1');
  clock.tick(1600);
  await flushAsync();

  clock.tick(2000);
  await flushAsync();

  assert.equal(cloudUnavailable.length, 1, '分支 ④ 必须回调 onCloudUnavailable');
  assert.equal(engine.currentContent, 'C1', '分支 ④ 必须保留本地内容');
});

test('M1-04 429 遵守响应头 Retry-After，不用退避表', async () => {
  const plan = [
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '45' }, body: { error: { code: 'RATE_LIMITED', message: 'x' } } },
  ];
  const { engine, clock, fetchImpl } = makeEngine({ plan });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });

  engine.onInput('T', 'C1');
  clock.tick(1600);
  await flushAsync();

  assert.equal(engine.state, SyncState.RETRY_WAIT);
  const before = fetchImpl.calls.length;
  engine.onInput('T', '等待期间的新内容');
  await engine.flushSave();

  // 退避表第 1 次是 1 秒，远小于 45 秒。
  clock.tick(5000);
  assert.equal(fetchImpl.calls.length, before, '45 秒内不得重试');

  clock.tick(45000);
  assert.ok(fetchImpl.calls.length > before, '45 秒后应重试');
});

test('核对读取被限流时等待 Retry-After 并继续读取', async () => {
  const plan = [
    { throw: new Error('response lost') },
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' }, body: { error: { code: 'RATE_LIMITED' } } },
    { status: 200, body: { id: 'doc1', title: 'T', content: 'C1', version: 2 } },
  ];
  const { engine, clock, fetchImpl } = makeEngine({ plan });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });
  engine.onInput('T', 'C1');
  await engine.flushSave();
  clock.tick(1000);
  await flushAsync();
  clock.tick(59999);
  assert.deepEqual(fetchImpl.calls.map(({ method }) => method), ['PUT', 'GET']);
  clock.tick(1);
  await flushAsync();
  assert.deepEqual(fetchImpl.calls.map(({ method }) => method), ['PUT', 'GET', 'GET']);
  assert.equal(engine.baseVersion, 2);
});

test('M1-04 退避表按 1/2/4/8/16/30 秒递增', async () => {
  assert.deepEqual([...BACKOFF_LADDER], [1000, 2000, 4000, 8000, 16000, 30000]);
  const { engine } = makeEngine();
  const delays = [];
  for (let i = 0; i < 7; i += 1) {
    delays.push(engine.nextBackoffDelay());
  }
  assert.equal(delays[0], 1000);
  assert.equal(delays[1], 2000);
  assert.equal(delays[2], 4000);
  assert.equal(delays[3], 8000);
  assert.equal(delays[4], 16000);
  assert.equal(delays[5], 30000);
  assert.equal(delays[6], 30000, '第 6 次及以后固定 30 秒（上限）');
});

test('M1-04 阻塞态不得被新输入解除', async () => {
  for (const state of [SyncState.CONFLICT, SyncState.AUTH_REQUIRED, SyncState.INVALID]) {
    const { engine, clock, fetchImpl } = makeEngine();
    engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });
    engine.state = state;

    const before = fetchImpl.calls.length;
    engine.onInput('T', 'C1');
    clock.tick(10000);

    assert.equal(engine.state, state, `${state} 不得被新输入解除`);
    assert.equal(fetchImpl.calls.length, before, `${state} 下新输入不得引发写请求`);
  }
});

test('M1-04 阻塞态不得被手动保存解除', async () => {
  for (const state of [SyncState.CONFLICT, SyncState.AUTH_REQUIRED, SyncState.INVALID]) {
    const { engine, clock, fetchImpl } = makeEngine();
    engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });
    engine.onInput('T', 'C1');
    engine.state = state;

    const before = fetchImpl.calls.length;
    await engine.flushSave();
    clock.tick(10000);

    assert.equal(fetchImpl.calls.length, before, `${state} 下手动保存不得发起写请求`);
    assert.equal(engine.state, state, `${state} 不得被手动保存解除`);
  }
});

test('正文缩短到字节限制后可从校验失败恢复保存', async () => {
  const plan = [
    { status: 413, body: { error: { code: 'PAYLOAD_TOO_LARGE', message: '超限' } } },
    { status: 200, body: { id: 'doc1', version: 2 } },
  ];
  const { engine, clock, fetchImpl } = makeEngine({ plan });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });
  engine.onInput('T', '中'.repeat(87382));
  await engine.flushSave();
  assert.equal(engine.state, SyncState.INVALID);

  engine.onInput('T', '中'.repeat(87381) + 'ab');
  clock.tick(1600);
  assert.equal(fetchImpl.calls.length, 1, '超过字节上限的修改仍不可调度');

  engine.onInput('T', '中'.repeat(87381) + 'a');
  assert.equal(engine.state, SyncState.DIRTY);
  clock.tick(1600);
  await flushAsync();
  assert.equal(engine.state, SyncState.SYNCED);
  assert.equal(engine.baseVersion, 2);
});

// ---------------------------------------------------------------------------
// M1-05 存储失败
// ---------------------------------------------------------------------------

test('M1-05 存储写入失败不得显示"已在本地备份"', async () => {
  const storage = {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => {
      const e = new Error('quota');
      e.name = 'QuotaExceededError';
      throw e;
    },
    removeItem: () => {},
  };

  const { engine, storageFailures, clock } = makeEngine({ storage });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });

  engine.onInput('T', 'C1');

  // 草稿写入走 250 毫秒合并窗口（SYNC.md §9.4），
  // 真正的存储写入发生在窗口到期时，故必须推进时钟。
  clock.tick(300);

  assert.ok(storageFailures.length >= 1, '存储失败必须回调 onStorageFailure');
  assert.equal(storageFailures[0].reason, 'quota', '必须带上失败分类');
  assert.equal(
    storageFailures[0].message,
    '本地备份失败',
    '文案必须是"本地备份失败"，不得是"已在本地备份"',
  );
});

test('M1-05 存储失败时保留内存内容', async () => {
  const storage = {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => {
      const e = new Error('quota');
      e.name = 'QuotaExceededError';
      throw e;
    },
    removeItem: () => {},
  };

  const { engine } = makeEngine({ storage, plan: [{ status: 200, body: { version: 2 } }] });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });
  engine.onInput('T', '内存必须保留');

  assert.equal(engine.initSession('u1', 'tok', { id: 'doc2', title: '另一篇', content: '', version: 1 }), false);
  assert.equal(engine.docId, 'doc1', '落盘失败时必须保留当前会话');
  assert.equal(engine.currentContent, '内存必须保留', '内存内容是最后一道防线，不得清空');
  await engine.flushSave();
  assert.equal(engine.initSession('u1', 'tok', { id: 'doc2', title: '另一篇', content: '', version: 1 }), true);
});

test('M1-05 resolveReload 不得用 force:true 清除其他会话的草稿', async () => {
  const { engine } = makeEngine();
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });

  // 预置一个"其他标签页"的草稿键。
  const otherKey = 'markdown-editor:draft:u1:doc1:otherTab';
  const store = new Map([[otherKey, JSON.stringify({
    user_id: 'u1',
    doc_id: 'doc1',
    edit_session_id: 'otherTab',
    base_version: 1,
    local_revision: 3,
    title: '其他标签页',
    content: '他人未同步内容',
    recorded_at: new Date().toISOString(),
  })]]);

  const storage = {
    length: store.size,
    key: (i) => [...store.keys()][i],
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };

  const e2 = makeEngine({ storage });
  e2.engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C', version: 1 });
  e2.engine.resolveReload({ id: 'doc1', title: 'T', content: 'C', version: 2 });

  assert.ok(store.has(otherKey), '其他标签页的草稿不得被清除');
});

test('创建草稿写入器失败时保留尚未获云端确认的会话', async () => {
  const clock = makeClock();
  const fetchImpl = makeFetch([{ status: 200, body: { version: 2 } }]);
  const engine = new SyncEngine({}, { timers: clock, fetchImpl });
  engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: '', version: 1 });
  engine.onInput('T', '仅在内存中的内容');
  assert.equal(engine.flushDraft(), false);
  assert.equal(engine.initSession('u1', 'tok', { id: 'doc2' }), false);
  assert.equal(engine.currentContent, '仅在内存中的内容');
  await engine.flushSave();
  assert.equal(engine.initSession('u1', 'tok', { id: 'doc2' }), true);
});

test('切回文档须等待在途保存并读取云端', async () => {
  const plan = [
    { delay: true, status: 200, body: { id: 'docA', version: 2 } },
    { status: 200, body: { id: 'docA', title: 'A', content: 'A1', version: 2 } },
  ];
  const { engine, clock, fetchImpl } = makeEngine({ plan });
  engine.initSession('u1', 'tok', { id: 'docA', title: 'A', content: 'A0', version: 1 });
  engine.onInput('A', 'A1');
  clock.tick(1600);
  engine.initSession('u1', 'tok', { id: 'docB', title: 'B', content: 'B0', version: 1 });
  let finished = false;
  const wait = engine.reconcilePending('docA').then(() => { finished = true; });
  await flushAsync();
  assert.equal(finished, false);
  assert.deepEqual(fetchImpl.calls.map((call) => call.method), ['PUT']);
  plan[0].resolve();
  await wait;
  assert.deepEqual(fetchImpl.calls.map((call) => call.method), ['PUT', 'GET']);
  assert.equal(engine.hasPending('docA'), false);
  assert.equal(engine.docId, 'docB');
  assert.equal(engine.currentContent, 'B0');
});
