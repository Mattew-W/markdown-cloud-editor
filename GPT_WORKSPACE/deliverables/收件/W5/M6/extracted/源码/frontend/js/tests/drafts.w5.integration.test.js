/**
 * 草稿 × 状态机的交接面用例（M6-W5-02 / M6-W5-03 的联调取证）
 *
 * `drafts.w5.test.js` 验的是草稿层**纯逻辑**（键、读回值、清理判定）。
 * 本文件验的是「保存结果真的落到草稿上」这一层：用**真实 `SyncEngine` +
 * 注入存储 + 可控时钟**跑完整链路，断言存储**前后状态**（不是只断言函数返回值）。
 *
 * 覆盖：
 *   W5-INT-a 保存成功且快照匹配 → 草稿被清理（存储真的空）；
 *   W5-INT-b 保存成功但期间有新修订 → 快照不匹配 → 较新草稿保留（可读回）；
 *   W5-INT-c 保存失败（网络错误）→ 草稿保留，状态为 retry_wait；
 *   W5-INT-d 409 冲突 → 草稿保留，且阻塞态不再发 PUT；
 *   W5-INT-e 切换文档 → 旧文档草稿留存，新文档键独立，互不覆盖；
 *   W5-INT-f 恢复（采用云端）→ 先 flush 再三重核对删除，存储不留残留；
 *   W5-INT-g 退出登录（destroy）→ 取消待写草稿，不产生旧账号记录。
 *
 * 运行：node --test js/tests/drafts.w5.integration.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SyncEngine, SyncState } from '../sync.js';
import * as drafts from '../drafts.js';

// ---------------------------------------------------------------------------
// 脚手架（与 sync.test.js 同构，保持两处可独立运行）
// ---------------------------------------------------------------------------

/** 可控时钟：`tick` 推进并触发到期回调；`clearTimeout` 真的移除定时器。 */
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    get now() {
      return now;
    },
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, at: now + (ms || 0), id: seq });
      return seq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending() {
      return timers.size;
    },
    tick(ms) {
      const target = now + ms;
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

/** 记录调用的假 fetch；`delay: true` 时返回受控 promise，测试手动 resolve。 */
function makeFetch(plan = []) {
  const calls = [];
  let index = 0;
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    const spec = plan[index] ?? { status: 200, body: { version: 1 } };
    index += 1;

    if (spec.throw) throw spec.throw;

    const status = spec.status ?? 200;
    const makeResponse = () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(spec.headers ?? { 'content-type': 'application/json' }),
      json: async () => spec.body ?? {},
      text: async () => JSON.stringify(spec.body ?? {}),
    });

    if (spec.delay) {
      return new Promise((resolve) => {
        spec.resolve = () => resolve(makeResponse());
      });
    }
    return makeResponse();
  };
  impl.calls = calls;
  return impl;
}

/** 内存存储适配器 */
function makeStorage() {
  const store = new Map();
  return {
    store,
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

function makeEngine(options = {}) {
  const clock = options.clock ?? makeClock();
  const fetchImpl = options.fetchImpl ?? makeFetch(options.plan ?? []);
  const storage = options.storage ?? makeStorage();
  const states = [];
  const conflicts = [];
  const engine = new SyncEngine(
    {
      onStateChange: (state, payload) => states.push({ state, payload }),
      onConflict: (info) => conflicts.push(info),
      onError: () => {},
      onSaveSuccess: (resp) => states.push({ state: 'onSaveSuccess', payload: resp }),
      onStorageFailure: () => {},
      onCloudUnavailable: () => {},
    },
    {
      timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
      fetchImpl,
      random: () => 0,
      storage,
    },
  );
  return { engine, clock, fetchImpl, storage, states, conflicts };
}

/** 冲刷微任务链（apiFetch → fetch → json 有多层 await） */
async function flushAsync(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** 该账号该文档的全部草稿（读回值，不是键计数） */
function draftsOf(storage, userId, docId) {
  return drafts.listDrafts({ userId, docId }, storage);
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('M6-W5-02/03 草稿与保存状态的交接面', () => {
  test('W5-INT-a 保存成功且快照匹配 → 草稿被清理，存储读回为空', () => {
    const { engine, clock, storage, states } = makeEngine({ plan: [{ status: 200, body: { version: 2 } }] });
    engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C0', version: 1 });

    engine.onInput('T', 'C1');
    engine.flushDraft(); // 绕过 250ms 窗口立即落盘，形成与发送快照一致的记录
    assert.equal(draftsOf(storage, 'u1', 'doc1').length, 1, '发送前草稿必须已落盘');

    clock.tick(1600); // 防抖到期 → PUT
    return flushAsync().then(() => {
      assert.equal(states.filter((s) => s.state === 'onSaveSuccess').length, 1, '保存必须被确认');
      assert.equal(engine.state, SyncState.SYNCED);
      assert.equal(
        draftsOf(storage, 'u1', 'doc1').length,
        0,
        '保存成功且会话/修订/内容全匹配时，草稿必须真的被删除（读回为空）',
      );
      assert.equal(storage.store.size, 0, '存储里不得留下任何键');
    });
  });

  test('W5-INT-b 保存成功但期间有新修订 → 快照不匹配，较新草稿保留且可读回', async () => {
    const plan = [{ delay: true, status: 200, body: { version: 2 } }];
    const { engine, clock, storage } = makeEngine({ plan });
    engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C0', version: 1 });

    engine.onInput('T', 'C1'); // rev1
    engine.flushDraft(); // 落盘 rev1
    clock.tick(1600); // 发出 PUT（响应受控、暂不返回）
    assert.equal(plan[0].resolve instanceof Function, true, 'PUT 应已在途');

    engine.onInput('T', 'C2'); // rev2：保存期间的新输入
    clock.tick(250); // 合并窗口到点 → 落盘 rev2（覆盖同一键）
    const beforeResp = draftsOf(storage, 'u1', 'doc1');
    assert.equal(beforeResp.length, 1);
    assert.equal(beforeResp[0].content, 'C2');

    plan[0].resolve(); // 服务端确认的是 rev1 的快照
    await flushAsync();

    const afterResp = draftsOf(storage, 'u1', 'doc1');
    assert.equal(afterResp.length, 1, '快照不匹配时草稿必须保留（不得因保存成功就删）');
    assert.equal(afterResp[0].content, 'C2', '留存的必须是较新修订，不是被确认的旧快照');
    assert.equal(afterResp[0].local_revision, 2);
    assert.equal(engine.state, SyncState.DIRTY, '仍有未确认修订时必须保持 dirty，不得显示已同步');
  });

  test('W5-INT-c 保存失败（网络错误）→ 草稿保留，状态 retry_wait', async () => {
    const { engine, clock, storage } = makeEngine({ plan: [{ throw: new TypeError('network down') }] });
    engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C0', version: 1 });

    engine.onInput('T', 'C1-未上云');
    engine.flushDraft();
    clock.tick(1600);
    await flushAsync();

    assert.equal(engine.state, SyncState.RETRY_WAIT);
    const kept = draftsOf(storage, 'u1', 'doc1');
    assert.equal(kept.length, 1, '保存失败时草稿必须保留（它是唯一的本地副本）');
    assert.equal(kept[0].content, 'C1-未上云');
    assert.equal(kept[0].base_version, 1);
  });

  test('W5-INT-d 409 冲突 → 草稿保留（不得静默清除），且阻塞态不再发 PUT', async () => {
    const { engine, clock, storage, fetchImpl, states } = makeEngine({
      plan: [{
        status: 409,
        body: { error: { code: 'VERSION_CONFLICT', message: 'x', details: { server_version: 7 } } },
      }],
    });
    engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C0', version: 1 });

    engine.onInput('T', 'C1-本地');
    engine.flushDraft();
    clock.tick(1600);
    await flushAsync();

    assert.equal(engine.state, SyncState.CONFLICT);
    const kept = draftsOf(storage, 'u1', 'doc1');
    assert.equal(kept.length, 1, '冲突期间草稿是唯一的本地副本，必须保留');
    assert.equal(kept[0].content, 'C1-本地');

    const callsBefore = fetchImpl.calls.length;
    engine.onInput('T', 'C2-继续写');
    clock.tick(60000);
    await flushAsync();
    assert.equal(fetchImpl.calls.length, callsBefore, '冲突未决时不得发起任何写请求');
    // 但输入仍要进草稿（草稿是兜底，不能因为阻塞就丢内容）。
    const afterTyping = draftsOf(storage, 'u1', 'doc1');
    assert.equal(afterTyping[0].content, 'C2-继续写', '阻塞态下新输入仍必须进本地草稿');
    assert.ok(
      states.some((s) => s.state === SyncState.CONFLICT),
      '冲突状态必须被上报给界面',
    );
  });

  test('W5-INT-e 切换文档：旧文档草稿留存，新文档键独立，互不覆盖', () => {
    const { engine, storage } = makeEngine();
    engine.initSession('u1', 'tok', { id: 'doc1', title: 'A', content: 'A0', version: 1 });
    engine.onInput('A', 'A-未同步');
    engine.flushDraft();

    const doc1Draft = draftsOf(storage, 'u1', 'doc1');
    assert.equal(doc1Draft.length, 1);
    assert.equal(doc1Draft[0].doc_id, 'doc1');

    // 切到 doc2（同一账号）。
    engine.initSession('u1', 'tok', { id: 'doc2', title: 'B', content: 'B0', version: 1 });
    engine.onInput('B', 'B-未同步');
    engine.flushDraft();

    assert.equal(
      draftsOf(storage, 'u1', 'doc1')[0].content,
      'A-未同步',
      '切文档不得覆盖或删除旧文档草稿',
    );
    const doc2Draft = draftsOf(storage, 'u1', 'doc2');
    assert.equal(doc2Draft.length, 1);
    assert.equal(doc2Draft[0].content, 'B-未同步');
    assert.equal(doc2Draft[0].edit_session_id, engine.editSessionId, '新文档用新的会话 ID');
    assert.equal(draftsOf(storage, 'u1').length, 2, '两个文档各一条，键独立');
  });

  test('W5-INT-f 恢复序列（flush → 三重核对 → 删除）不留残留，且快照不符时删不掉', () => {
    const { engine, storage } = makeEngine();
    engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C0', version: 1 });

    engine.onInput('T', 'C-本地草稿');
    engine.flushDraft();
    assert.equal(draftsOf(storage, 'u1', 'doc1').length, 1, '恢复前草稿必须已落盘');

    // INTERFACES §3 规定的恢复顺序：先把待写缓冲刷成记录，再用
    // 「会话 ID + 本地修订号 + 内容」三重核对删除。顺序颠倒会让待写缓冲复活旧草稿。
    const key = drafts.buildDraftKey({
      userId: engine.userId,
      docId: engine.docId,
      sessionId: engine.editSessionId,
    });

    // 负对照：快照内容与落盘记录不符（例如界面上已被云端内容替换）→ 必须删不掉。
    const wrongSnapshot = drafts.discardDraft(
      key,
      { sessionId: engine.editSessionId, localRevision: engine.localRevision, content: 'C-云端' },
      storage,
    );
    assert.equal(wrongSnapshot, false, '快照内容不匹配时不得删除（否则本地未同步内容会丢）');
    assert.equal(draftsOf(storage, 'u1', 'doc1').length, 1);

    // 正路径：用引擎当前的会话/修订/内容作为快照。
    const removed = drafts.discardDraft(
      key,
      {
        sessionId: engine.editSessionId,
        localRevision: engine.localRevision,
        content: engine.currentContent,
      },
      storage,
    );
    assert.equal(removed, true, '三重核对全部匹配时必须删得掉');
    assert.equal(draftsOf(storage, 'u1', 'doc1').length, 0, '恢复后本会话草稿不得残留');
    assert.equal(storage.store.size, 0, '存储里不得留下任何键');

    // 说明：公开入口 `engine.resolveReload()` 未把注入存储传给 `discardDraft`，
    // 因此本用例在草稿层验证恢复序列，该缺口记入检查记录 F-01 并交接 M1。
  });

  test('W5-INT-g 退出登录（destroy）取消待写草稿，不产生旧账号记录', () => {
    const { engine, clock, storage } = makeEngine();
    engine.initSession('uA', 'tokA', { id: 'docA', title: 'A', content: 'A0', version: 1 });
    engine.onInput('A', 'A-待写'); // 仅进入 250ms 窗口，尚未落盘
    assert.equal(storage.store.size, 0, '窗口内不得落盘');

    engine.destroy(); // 退出登录的真实调用点
    clock.tick(250); // 旧定时器若未被取消，就会在此写入
    assert.equal(storage.store.size, 0, '退出登录后不得再写入任何旧账号草稿');

    // 以 B 身份重新登录并编辑。
    engine.initSession('uB', 'tokB', { id: 'docB', title: 'B', content: 'B0', version: 1 });
    engine.onInput('B', 'B-待写');
    clock.tick(250);

    const all = [...storage.store.keys()];
    assert.equal(all.length, 1, '存储里只应有 B 的一条');
    assert.equal(
      drafts.parseDraftKey(all[0]).userId,
      'uB',
      '唯一落盘的键必须属于 B，旧账号内容不得跨会话写入',
    );
    assert.equal(draftsOf(storage, 'uB', 'docB')[0].content, 'B-待写');
  });
});
