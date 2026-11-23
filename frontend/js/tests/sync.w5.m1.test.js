/**
 * sync.w5.m1.test.js —— M1 W5 总成阶段补充的回归用例
 *
 * 覆盖本轮修复的三个真实缺陷与一处契约对齐，均为 W5 联调中发现：
 *
 *   1. 陈旧"待核对"项永不清除（G-03）
 *      `reconcile()` 遇到世代过期的快照会把它**写回** pendingReconcile，
 *      而 `initSession()` 从不清这个 Map → `hasPending(docId)` 恒为真，
 *      app 每次打开该文档都提示"正在核对未完成的保存…"，核对永不完成。
 *
 *   2. 核对期业务错误被当成网络故障（G-04）
 *      核对用 GET 返回 401/400 时，原实现一律落到 retry_wait 并按退避表
 *      无限重试 —— token 过期既不弹登录也永不停止。
 *
 *   3. 本地备份失败后徽标仍称"已备份"（G-07）
 *      状态栏被 app 改成"本地备份失败"，而徽标停留在"本地已备份"，
 *      违反 SYNC §4.4 文案禁令，用户会误判内容已落盘。
 *
 *   4. 本地备份失败文案未按 INTERFACES §2.5 的四分支给出（G-01）
 *      app 曾把原始 reason 码直接塞进界面（"本地备份失败（quota）"）。
 *
 * 时钟与 fetch 全部可控，不依赖真实等待（SYNC §7.3）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SyncEngine, SyncState } from '../sync.js';
import { DraftStorageError } from '../drafts.js';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, at: now + (ms || 0), id: seq });
      return seq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    tick(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.values()].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due.id);
        now = due.at;
        due.fn();
      }
      now = target;
    },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeStorage({ failOnSet = null } = {}) {
  const store = new Map();
  return {
    store,
    get length() {
      return store.size;
    },
    key(i) {
      return [...store.keys()][i] ?? null;
    },
    getItem(k) {
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      if (failOnSet) {
        const error = new Error('stub');
        error.name = failOnSet;
        throw error;
      }
      store.set(k, v);
    },
    removeItem(k) {
      store.delete(k);
    },
  };
}

/** 冲刷 async 链（await 之后的若干微任务）。 */
async function flushAsync(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function makeEngine({ fetchImpl, clock = makeClock(), storage } = {}) {
  const states = [];
  const engine = new SyncEngine(
    {
      onStateChange: (state, payload) => states.push({ state, payload }),
      onConflict: () => {},
      onError: () => {},
      onSaveSuccess: () => {},
      onStorageFailure: () => {},
      onCloudUnavailable: () => {},
    },
    {
      timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
      fetchImpl,
      random: () => 0,
      storage: storage ?? makeStorage(),
    },
  );
  return { engine, clock, states };
}

const DOC1 = { id: 'doc-1', title: 'T', content: 'C', version: 1 };
const DOC2 = { id: 'doc-2', title: 'T2', content: 'C2', version: 1 };

// ---------------------------------------------------------------------------
// 1. 陈旧待核对项必须清除
// ---------------------------------------------------------------------------

test('W5-M1-01 切走再切回同一文档后，陈旧待核对项必须被清除（hasPending 归 false）', async () => {
  let resolvePut;
  const fetchImpl = async (url, init) => {
    if ((init.method ?? 'GET') === 'PUT') {
      // 受控：测试决定何时返回，用于制造"响应迟到"
      return new Promise((resolve) => {
        resolvePut = () => resolve(jsonResponse(200, { id: 'doc-1', version: 2, updated_at: 'now' }));
      });
    }
    return jsonResponse(200, { ...DOC1 });
  };

  const { engine } = makeEngine({ fetchImpl });
  engine.initSession('u1', 'tok', DOC1);
  engine.onInput('T', 'C-改');

  // 不 await：PUT 悬着，模拟"切走时请求仍在途"
  const saving = engine.flushSave();
  await flushAsync();

  // 切到另一文档（世代 +1），再让旧 PUT 返回 → 走 stale 分支写回 pendingReconcile
  engine.initSession('u1', 'tok', DOC2);
  resolvePut();
  await saving;
  await flushAsync();

  assert.equal(engine.hasPending('doc-1'), true, '迟到的成功响应应被记为待核对');

  // 切回 doc-1：此时 baseVersion 来自刚 GET 到的云端文档，陈旧待核对项不得再阻塞
  engine.initSession('u1', 'tok', { ...DOC1, version: 2 });
  assert.equal(
    engine.hasPending('doc-1'),
    false,
    '打开文档后陈旧待核对项必须清除，否则 app 每次打开都空转核对',
  );
});

// ---------------------------------------------------------------------------
// 2. 核对期 401 必须进 auth_required，而不是无限重试
// ---------------------------------------------------------------------------

test('W5-M1-02 核对用 GET 返回 401 时进入 auth_required，不得继续退避重试', async () => {
  const fetchImpl = async (url, init) => {
    if ((init.method ?? 'GET') === 'PUT') {
      // 网络层失败 → NetworkError → §6 先核对云端
      throw new TypeError('network down');
    }
    return jsonResponse(401, {
      error: { code: 'UNAUTHORIZED', message: '未授权', request_id: 'r1' },
    });
  };

  const { engine, clock } = makeEngine({ fetchImpl });
  engine.initSession('u1', 'tok', DOC1);
  engine.onInput('T', 'C-改');

  const saving = engine.flushSave();
  await flushAsync();
  await saving;

  assert.equal(engine.state, SyncState.RETRY_WAIT, '先进入等待核对');

  clock.tick(1000); // 退避 1s（random=0，无抖动）
  await flushAsync(24);

  assert.equal(
    engine.state,
    SyncState.AUTH_REQUIRED,
    '核对返回 401 必须转为 auth_required，暂停重试等用户重新登录',
  );
});

// ---------------------------------------------------------------------------
// 3. 核对期 400 必须进 invalid
// ---------------------------------------------------------------------------

test('W5-M1-03 核对用 GET 返回 400 时进入 invalid，不得当成网络故障重试', async () => {
  const fetchImpl = async (url, init) => {
    if ((init.method ?? 'GET') === 'PUT') throw new TypeError('network down');
    return jsonResponse(400, {
      error: { code: 'BAD_REQUEST', message: '标题不合法', request_id: 'r2' },
    });
  };

  const { engine, clock } = makeEngine({ fetchImpl });
  engine.initSession('u1', 'tok', DOC1);
  engine.onInput('T', 'C-改');

  const saving = engine.flushSave();
  await flushAsync();
  await saving;
  clock.tick(1000);
  await flushAsync(24);

  assert.equal(engine.state, SyncState.INVALID, '400 应交用户修正，不得无限重试');
});

// ---------------------------------------------------------------------------
// 4. 本地备份失败：徽标不得继续声称"已备份"
// ---------------------------------------------------------------------------

test('W5-M1-04 草稿写入失败后状态为 dirty 且 storageOk=false（徽标与事实一致）', async () => {
  const storage = makeStorage({ failOnSet: 'QuotaExceededError' });
  const { engine, clock, states } = makeEngine({
    fetchImpl: async () => jsonResponse(200, { version: 2 }),
    storage,
  });

  engine.initSession('u1', 'tok', DOC1);
  engine.onInput('T', 'C-改');

  // 草稿走 250ms 合并窗口，推进时钟才会真正写入
  clock.tick(250);
  await flushAsync();

  const last = states[states.length - 1];
  assert.equal(last.state, SyncState.DIRTY, '仍应为未同步');
  assert.equal(last.payload.storageOk, false, '必须显式标记本地备份失败');
  assert.equal(
    last.payload.message,
    '本地备份失败',
    '不得出现"已在本地备份"这类与事实相反的文案',
  );
});

// ---------------------------------------------------------------------------
// 5. 存储失败文案按契约四分支给出
// ---------------------------------------------------------------------------

test('W5-M1-05 存储失败文案按 INTERFACES §2.5 四分支给出，且 app 使用该映射', async () => {
  assert.equal(DraftStorageError.messageFor('quota'), '本地备份失败：存储空间不足');
  assert.equal(DraftStorageError.messageFor('unavailable'), '本地备份失败：浏览器禁止本地存储');
  assert.equal(DraftStorageError.messageFor('corrupt'), '本地备份已损坏，已忽略');
  assert.equal(DraftStorageError.messageFor('serialize'), '本地备份失败：内容无法序列化');

  // 界面层必须复用这份映射，而不是把 reason 码直接拼进文案。
  const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(
    appSource.includes('DraftStorageError.messageFor('),
    'app.js 的存储失败横幅必须复用契约文案映射',
  );
  assert.ok(
    !appSource.includes('本地备份失败（${info.reason}）'),
    '不得把原始 reason 码直接展示给用户',
  );
});

// ---------------------------------------------------------------------------
// 6. 首屏不得声明"已同步"
// ---------------------------------------------------------------------------

test('W5-M1-06 首屏徽标不得预设 badge-synced / "已同步"', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const badgeLine = html.split('\n').find((line) => line.includes('id="syncBadge"'));
  assert.ok(badgeLine, 'index.html 必须存在 syncBadge');
  assert.ok(
    !badgeLine.includes('badge-synced'),
    '未取得任何服务端响应前不得带已同步样式',
  );
  assert.ok(!badgeLine.includes('已同步'), '未取得任何服务端响应前不得写"已同步"');
});
