/**
 * drafts.js 的 Node 内置测试。
 *
 * 运行：node --test frontend/js/tests/
 *
 * 覆盖 INTERFACES.md §4.1 要求的六项：
 * 1. 键生成与解析；
 * 2. user/doc 隔离（两 user 枚举互不可见）；
 * 3. 多会话并存；
 * 4. 250 毫秒合并（**可控时钟**）；
 * 5. 清理三重核对**拒绝误删**；
 * 6. quota / unavailable / corrupt 三类存储错误。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DRAFT_KEY_PREFIX,
  DraftStorageError,
  buildDraftKey,
  classifyRestore,
  clearSessionDrafts,
  createDraftWriter,
  discardDraft,
  listDrafts,
  parseDraftKey,
  readDraft,
  saveDraft,
} from '../drafts.js';

// ---------- 测试替身 ----------

/**
 * 内存版 Web Storage，可注入故障。
 * @param {{failOnSet?: string, failOnGet?: string}} [faults] 传入异常 name
 */
function makeStorage(faults = {}) {
  const map = new Map();
  /** 按异常名构造贴近真实浏览器的错误对象。 */
  const raise = (name) => {
    const message = name === 'QuotaExceededError'
      ? 'Failed to execute setItem: Quota exceeded.'
      : 'The operation is insecure.';
    return Object.assign(new Error(message), { name });
  };
  return {
    get length() {
      return map.size;
    },
    key(i) {
      return [...map.keys()][i] ?? null;
    },
    getItem(k) {
      if (faults.failOnGet) throw raise(faults.failOnGet);
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (faults.failOnSet) throw raise(faults.failOnSet);
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
    // 测试辅助
    _dump: () => Object.fromEntries(map),
  };
}

const USER_A = '6f1a3c2e-8b5d-4a71-9f0e-2d3c4b5a6e7f';
const USER_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DOC_1 = 'b2e9d4f1-0c3a-4e5b-8d7a-1f2e3d4c5b6a';
const DOC_2 = '11111111-2222-4333-8444-555555555555';
const SESS_1 = 'c3d5e7a9-1b2f-4c8d-9e0a-3f4c5d6e7f8a';
const SESS_2 = '99999999-8888-4777-8666-555555555555';

function draftOf(over = {}) {
  return {
    userId: USER_A,
    docId: DOC_1,
    sessionId: SESS_1,
    baseVersion: 3,
    title: '课程笔记',
    content: '# 课程笔记\n\n第一段落。',
    localRevision: 7,
    ...over,
  };
}

// ---------- 1. 键生成与解析 ----------

test('键格式为 markdown-editor:draft:userId:docId:sessionId', () => {
  const key = buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 });
  assert.equal(key, `${DRAFT_KEY_PREFIX}${USER_A}:${DOC_1}:${SESS_1}`);
});

test('解析键与构造严格互逆', () => {
  const parts = { userId: USER_A, docId: DOC_1, sessionId: SESS_1 };
  assert.deepEqual(parseDraftKey(buildDraftKey(parts)), parts);
});

test('段内含分隔符不破坏解析', () => {
  const parts = { userId: 'a:b', docId: 'c:d', sessionId: 'e:f' };
  assert.deepEqual(parseDraftKey(buildDraftKey(parts)), parts);
});

test('非本模块键返回 null 而非抛异常', () => {
  for (const k of ['some-other-app:key', 'markdown-editor:draft:onlytwo', '', null, undefined, 42]) {
    assert.equal(parseDraftKey(k), null, `${String(k)} 应返回 null`);
  }
});

test('缺失段时构造抛 TypeError', () => {
  assert.throws(() => buildDraftKey({ userId: '', docId: DOC_1, sessionId: SESS_1 }), TypeError);
  assert.throws(() => buildDraftKey({ userId: USER_A, docId: DOC_1 }), TypeError);
});

// ---------- 2. 落盘字段与结构校验 ----------

test('落盘为 snake_case 且含全部 8 个字段', () => {
  const store = makeStorage();
  const { key } = saveDraft(draftOf(), store);
  const record = JSON.parse(store.getItem(key));

  assert.deepEqual(Object.keys(record).sort(), [
    'base_version', 'content', 'doc_id', 'edit_session_id',
    'local_revision', 'recorded_at', 'title', 'user_id',
  ]);
  assert.equal(record.base_version, 3);
  assert.equal(record.local_revision, 7);
  assert.equal(record.edit_session_id, SESS_1);
  assert.equal(record.user_id, USER_A);
});

test('recorded_at 是 ISO 8601 UTC 字符串而非数字', () => {
  const store = makeStorage();
  const { key, recordedAt } = saveDraft(draftOf(), store);
  assert.equal(typeof recordedAt, 'string');
  assert.match(recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  assert.ok(!Number.isNaN(Date.parse(recordedAt)));
  assert.equal(JSON.parse(store.getItem(key)).recorded_at, recordedAt);
});

test('正文允许空串', () => {
  const store = makeStorage();
  const { key } = saveDraft(draftOf({ content: '' }), store);
  assert.equal(readDraft(key, store).content, '');
});

test('content 非字符串判为 corrupt 而非静默接受', () => {
  const store = makeStorage();
  const key = buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 });

  for (const bad of [123, null, { a: 1 }, ['x'], true]) {
    store.setItem(key, JSON.stringify({
      user_id: USER_A, doc_id: DOC_1, edit_session_id: SESS_1,
      base_version: 1, title: 't', content: bad,
      local_revision: 0, recorded_at: new Date().toISOString(),
    }));
    assert.throws(() => readDraft(key, store), (e) => e instanceof DraftStorageError && e.reason === 'corrupt',
      `content=${JSON.stringify(bad)} 应判 corrupt`);
  }
});

test('recorded_at 缺失不显示 Invalid Date 而判 corrupt', () => {
  const store = makeStorage();
  const key = buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 });
  store.setItem(key, JSON.stringify({
    user_id: USER_A, doc_id: DOC_1, edit_session_id: SESS_1,
    base_version: 1, title: 't', content: 'c', local_revision: 0,
  }));
  assert.throws(() => readDraft(key, store), (e) => e.reason === 'corrupt');
});

test('base_version 与 local_revision 越界判 corrupt', () => {
  const store = makeStorage();
  const key = buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 });
  const base = {
    user_id: USER_A, doc_id: DOC_1, edit_session_id: SESS_1,
    base_version: 1, title: 't', content: 'c',
    local_revision: 0, recorded_at: new Date().toISOString(),
  };
  for (const [field, value] of [['base_version', 0], ['base_version', -1], ['local_revision', -1]]) {
    store.setItem(key, JSON.stringify({ ...base, [field]: value }));
    assert.throws(() => readDraft(key, store), (e) => e.reason === 'corrupt', `${field}=${value} 应判 corrupt`);
  }
});

test('键与记录不一致判 corrupt', () => {
  const store = makeStorage();
  const key = buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 });
  // 记录里的 user_id 与键中不同 —— 说明被手工改过
  store.setItem(key, JSON.stringify({
    user_id: USER_B, doc_id: DOC_1, edit_session_id: SESS_1,
    base_version: 1, title: 't', content: 'c',
    local_revision: 0, recorded_at: new Date().toISOString(),
  }));
  assert.throws(() => readDraft(key, store), (e) => e.reason === 'corrupt');
});

test('读取不存在的键返回 null', () => {
  assert.equal(readDraft(buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 }), makeStorage()), null);
});

// ---------- 3. user / doc 隔离 ----------

test('两个用户的草稿互相不可见', () => {
  const store = makeStorage();
  saveDraft(draftOf(), store);
  saveDraft(draftOf({ userId: USER_B }), store);

  const seenByA = listDrafts({ userId: USER_A }, store);
  const seenByB = listDrafts({ userId: USER_B }, store);

  assert.equal(seenByA.length, 1);
  assert.equal(seenByB.length, 1);
  assert.equal(seenByA[0].user_id, USER_A);
  assert.equal(seenByB[0].user_id, USER_B);
});

test('按 docId 过滤', () => {
  const store = makeStorage();
  saveDraft(draftOf({ docId: DOC_1 }), store);
  saveDraft(draftOf({ docId: DOC_2 }), store);

  assert.equal(listDrafts({ userId: USER_A, docId: DOC_1 }, store).length, 1);
  assert.equal(listDrafts({ userId: USER_A, docId: DOC_2 }, store).length, 1);
  assert.equal(listDrafts({ userId: USER_A }, store).length, 2);
});

test('不扫描其他应用的键', () => {
  const store = makeStorage();
  store.setItem('other-app:important', 'x');
  saveDraft(draftOf(), store);
  assert.equal(listDrafts({ userId: USER_A }, store).length, 1);
});

// ---------- 4. 多会话并存 ----------

test('同一文档的多个会话草稿并存', () => {
  const store = makeStorage();
  saveDraft(draftOf({ sessionId: SESS_1, content: 'A' }), store);
  saveDraft(draftOf({ sessionId: SESS_2, content: 'B' }), store);

  const all = listDrafts({ userId: USER_A, docId: DOC_1 }, store);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((d) => d.content).sort(), ['A', 'B']);
});

test('clearSessionDrafts 默认不删其他会话的草稿（保守）', () => {
  const store = makeStorage();
  saveDraft(draftOf({ sessionId: SESS_1, content: 'mine' }), store);
  saveDraft(draftOf({ sessionId: SESS_2, content: 'old' }), store);

  // 未提供云端状态时，无从证明历史草稿已无用，因此一条都不删。
  // 这是修复 P1 的核心：会话 ID 不同 ≠ 记录已过时。
  const { removed, kept } = clearSessionDrafts(
    { userId: USER_A, docId: DOC_1, sessionId: SESS_1 },
    {},
    store,
  );
  assert.equal(removed.length, 0, '未确认时不得删除任何记录');
  assert.equal(kept.length, 2, '两条都应保留');

  const left = listDrafts({ userId: USER_A, docId: DOC_1 }, store);
  assert.equal(left.length, 2);
});

test('clearSessionDrafts 仅在云端已覆盖时才删（标题与正文都一致）', () => {
  const store = makeStorage();
  saveDraft(draftOf({ sessionId: SESS_1, content: 'mine' }), store);
  saveDraft(draftOf({ sessionId: SESS_2, content: 'old', title: '旧标题' }), store);

  const { removed } = clearSessionDrafts(
    { userId: USER_A, docId: DOC_1, sessionId: SESS_1 },
    {
      cloud: { version: 9, title: '旧标题', content: 'old' },
    },
    store,
  );
  assert.equal(removed.length, 1, '与云端完全一致的那条才可删');

  const left = listDrafts({ userId: USER_A, docId: DOC_1 }, store);
  assert.equal(left.length, 1);
  assert.equal(left[0].content, 'mine');
});

test('clearSessionDrafts 保留「云端版本够但内容不同」的草稿', () => {
  const store = makeStorage();
  saveDraft(draftOf({ sessionId: SESS_2, content: 'unsaved-edit' }), store);

  const { removed } = clearSessionDrafts(
    { userId: USER_A, docId: DOC_1, sessionId: SESS_1 },
    { cloud: { version: 99, title: '标题', content: '云端内容' } },
    store,
  );
  assert.equal(removed.length, 0, '内容不同就是有未同步修改，绝不能删');
  assert.equal(listDrafts({ userId: USER_A, docId: DOC_1 }, store).length, 1);
});

test('clearSessionDrafts 保留「仅标题不同」的草稿', () => {
  const store = makeStorage();
  // 正文与云端一致，但标题是未保存的修改——必须保留。
  saveDraft(draftOf({ sessionId: SESS_2, content: 'same', title: '我改的标题' }), store);

  const { removed } = clearSessionDrafts(
    { userId: USER_A, docId: DOC_1, sessionId: SESS_1 },
    { cloud: { version: 99, title: '原标题', content: 'same' } },
    store,
  );
  assert.equal(removed.length, 0, '标题改动同样受草稿保护');
  assert.equal(listDrafts({ userId: USER_A, docId: DOC_1 }, store).length, 1);
});

test('clearSessionDrafts 支持显式确认丢弃', () => {
  const store = makeStorage();
  saveDraft(draftOf({ sessionId: SESS_2, content: 'old' }), store);
  const key = listDrafts({ userId: USER_A, docId: DOC_1 }, store)[0].key
    ?? `${'markdown-editor:draft'}:${USER_A}:${DOC_1}:${SESS_2}`;

  const { removed } = clearSessionDrafts(
    { userId: USER_A, docId: DOC_1, sessionId: SESS_1 },
    { confirmedKeys: [key] },
    store,
  );
  assert.equal(removed.length, 1);
});

test('clearSessionDrafts 云端字段缺失时不得删除（回归）', () => {
  // 回归测试（PR #3 二次审查 P1）：修复"只比 content"那一版里，
  // 判定写成了 `typeof cloud.title !== 'string' || ...`，
  // 把「字段缺失」当成「匹配」——
  // 于是只传 { cloud: { version: 1 } } 就能删掉 base_version ≤ 1 的他人草稿，
  // 比修复前更危险。删除不可逆，必须要求基准完整。
  const store = makeStorage();
  saveDraft(draftOf({ sessionId: SESS_2, content: 'unsaved' }), store);

  const onlyVersion = clearSessionDrafts(
    { userId: USER_A, docId: DOC_1, sessionId: SESS_1 },
    { cloud: { version: 1 } },
    store,
  );
  assert.equal(onlyVersion.removed.length, 0, '云端只给 version 时不得删除');

  const onlyContent = clearSessionDrafts(
    { userId: USER_A, docId: DOC_1, sessionId: SESS_1 },
    { cloud: { version: 1, content: 'unsaved' } },
    store,
  );
  assert.equal(onlyContent.removed.length, 0, '缺 title 时不得删除');

  const onlyTitle = clearSessionDrafts(
    { userId: USER_A, docId: DOC_1, sessionId: SESS_1 },
    { cloud: { version: 1, title: '标题' } },
    store,
  );
  assert.equal(onlyTitle.removed.length, 0, '缺 content 时不得删除');

  assert.equal(
    listDrafts({ userId: USER_A, docId: DOC_1 }, store).length,
    1,
    '草稿必须还在',
  );
});

test('writeNow 写失败时保留待写快照以供重试（回归）', () => {
  // 回归测试（PR #3 二次审查 P2）：早期实现先清 pendingDraft 再 saveDraft，
  // 存储故障时唯一快照被清掉，pending() 变 false，
  // 存储恢复后再 flush() 也写不出来 —— 草稿永久丢失。
  let fail = true;
  const inner = makeStorage();
  const flaky = {
    get length() { return inner.length; },
    key: (i) => inner.key(i),
    getItem: (k) => inner.getItem(k),
    setItem: (k, v) => {
      if (fail) {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      inner.setItem(k, v);
    },
    removeItem: (k) => inner.removeItem(k),
  };

  const writer = createDraftWriter({ storage: flaky, delay: () => 1 });
  writer.schedule(draftOf({ content: '别丢我' }));

  // 第一次 flush：写入应失败
  assert.throws(() => writer.flush(), (e) => e instanceof DraftStorageError);

  // 故障排除后再 flush：必须能把这份草稿写出去
  fail = false;
  writer.flush();

  const saved = listDrafts({ userId: USER_A }, inner);
  assert.equal(saved.length, 1, '恢复后必须补写成功');
  assert.equal(saved[0].content, '别丢我');
});

test('clearSessionDrafts 不影响其他文档', () => {
  const store = makeStorage();
  saveDraft(draftOf({ docId: DOC_1, sessionId: SESS_2 }), store);
  saveDraft(draftOf({ docId: DOC_2, sessionId: SESS_2 }), store);

  clearSessionDrafts({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 }, store);
  assert.equal(listDrafts({ userId: USER_A, docId: DOC_2 }, store).length, 1);
});

// ---------- 5. 三重核对拒绝误删 ----------

test('三项全等才删除', () => {
  const store = makeStorage();
  const { key } = saveDraft(draftOf({ localRevision: 7, content: 'X' }), store);
  const ok = discardDraft(key, { sessionId: SESS_1, localRevision: 7, content: 'X' }, store);
  assert.equal(ok, true);
  assert.equal(readDraft(key, store), null);
});

test('会话不同则拒绝删除', () => {
  const store = makeStorage();
  const { key } = saveDraft(draftOf({ sessionId: SESS_1 }), store);
  const ok = discardDraft(key, { sessionId: SESS_2, localRevision: 7, content: 'X' }, store);
  assert.equal(ok, false, '会话不同必须拒绝');
  assert.notEqual(readDraft(key, store), null, '拒绝时不得删除');
});

test('修订号不同则拒绝删除（防抹掉新修改）', () => {
  const store = makeStorage();
  const { key } = saveDraft(draftOf({ localRevision: 9, content: '新内容' }), store);
  // 用户手上还拿着 localRevision 7 的旧快照
  const ok = discardDraft(key, { sessionId: SESS_1, localRevision: 7, content: 'X' }, store);
  assert.equal(ok, false, '修订号不同必须拒绝');
  assert.equal(readDraft(key, store).local_revision, 9, '草稿必须完好');
});

test('内容不同则拒绝删除', () => {
  const store = makeStorage();
  const { key } = saveDraft(draftOf({ localRevision: 7, content: '服务器版本' }), store);
  const ok = discardDraft(key, { sessionId: SESS_1, localRevision: 7, content: '另一份内容' }, store);
  assert.equal(ok, false);
  assert.equal(readDraft(key, store).content, '服务器版本');
});

test('删除不存在的草稿视为已达成目标', () => {
  const key = buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 });
  assert.equal(discardDraft(key, { sessionId: SESS_1, localRevision: 1, content: '' }, makeStorage()), true);
});

// ---------- 6. 三类存储错误 ----------

test('存储禁用映射 unavailable', () => {
  const store = makeStorage({ failOnSet: 'SecurityError' });
  assert.throws(
    () => saveDraft(draftOf(), store),
    (e) => e instanceof DraftStorageError && e.reason === 'unavailable',
  );
});

test('属性访问阶段抛出的 SecurityError 也归一化为 unavailable', () => {
  // 回归测试（PR #3 审查意见 P2）：浏览器策略禁用存储时，
  // 访问 `window.localStorage` **属性本身**就抛 SecurityError，
  // 若该访问在 try 之外，原生 DOMException 会直接漏出，
  // 调用方拿不到契约承诺的 reason === 'unavailable'。
  //
  // Node 环境没有 window，这里用 getter 定义一个会抛错的假 window，
  // 精确复现"取属性即抛"的场景。
  const realWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    get() {
      throw new Error('浏览器策略阻断');
    },
  });
  try {
    assert.throws(
      () => readDraft(buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 })),
      (e) => e instanceof DraftStorageError && e.reason === 'unavailable',
      '取 localStorage 属性时抛错也必须归一化',
    );
  } finally {
    if (realWindow === undefined) {
      delete globalThis.window;
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: realWindow,
      });
    }
  }
});

test('配额耗尽映射 quota', () => {
  const store = makeStorage({ failOnSet: 'QuotaExceededError' });
  assert.throws(
    () => saveDraft(draftOf(), store),
    (e) => e instanceof DraftStorageError && e.reason === 'quota',
  );
});

test('值损坏映射 corrupt', () => {
  const store = makeStorage();
  const key = buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 });
  store.setItem(key, '{ 这不是合法 JSON');
  assert.throws(() => readDraft(key, store), (e) => e.reason === 'corrupt');
});

test('错误文案为中文，不透出浏览器英文原文', () => {
  const store = makeStorage({ failOnSet: 'SecurityError' });
  try {
    saveDraft(draftOf(), store);
    assert.fail('应抛错');
  } catch (e) {
    assert.match(e.message, /本地备份失败/);
    assert.doesNotMatch(e.message, /operation is insecure/i);
    // 原始细节只在 detail 里，供日志用
    assert.match(e.detail, /insecure/i);
  }
});

test('四种 reason 各有中文文案', () => {
  for (const reason of ['quota', 'unavailable', 'corrupt', 'serialize']) {
    const msg = new DraftStorageError(reason).message;
    assert.match(msg, /本地备份/);
    assert.doesNotMatch(msg, /[a-z]/i, `${reason} 文案不应含英文`);
  }
});

// ---------- 7. 250 毫秒合并（可控时钟） ----------

test('窗口内连续调用只写最后一次', () => {
  const store = makeStorage();
  let fired = null;
  const writer = createDraftWriter({
    storage: store,
    delay: (fn) => { fired = fn; return 1; },   // 可控时钟：手动触发
    now: () => '2026-10-20T08:45:12.000Z',
  });

  writer.schedule(draftOf({ content: '第一击' }));
  writer.schedule(draftOf({ content: '第二击' }));
  writer.schedule(draftOf({ content: '第三击' }));

  assert.equal(writer.pending(), true);
  assert.equal(listDrafts({ userId: USER_A }, store).length, 0, '窗口内不应已写入');

  fired();  // 时钟到点

  const drafts = listDrafts({ userId: USER_A }, store);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].content, '第三击', '只保留最后一次');
});

test('flush 绕过窗口立即写入', () => {
  const store = makeStorage();
  const writer = createDraftWriter({ storage: store, delay: () => 1 });
  writer.schedule(draftOf({ content: '切换文档前的最后一段' }));
  writer.flush();
  assert.equal(listDrafts({ userId: USER_A }, store)[0].content, '切换文档前的最后一段');
});

test('cancel 后不再写入', () => {
  const store = makeStorage();
  let fired = null;
  const writer = createDraftWriter({ storage: store, delay: (fn) => { fired = fn; return 1; } });
  writer.schedule(draftOf());
  writer.cancel();
  if (fired) fired();
  assert.equal(listDrafts({ userId: USER_A }, store).length, 0);
});

test('flushAll 必须落盘（不能只取消定时器）', () => {
  // 回归测试：早期实现只 clearTimeout + pendingDraft = null，
  // 导致「schedule 之后立刻 flushAll」什么都不写——快照被静默丢失。
  const store = makeStorage();
  let fired = null;
  const writer = createDraftWriter({ storage: store, delay: (fn) => { fired = fn; return 1; } });
  writer.schedule(draftOf({ content: 'flushAll 必须保住我' }));
  writer.flushAll();

  const saved = listDrafts({ userId: USER_A }, store);
  assert.equal(saved.length, 1, 'flushAll 后存储里必须有这条草稿');
  assert.equal(saved[0].content, 'flushAll 必须保住我');

  // 落盘后定时器不应再写第二次
  if (fired) fired();
  assert.equal(listDrafts({ userId: USER_A }, store).length, 1);
});

// ---------- 8. 恢复分支判定 ----------

test('内容相同则采用云端', () => {
  const d = draftOf({ content: '一样的', title: '标题甲', base_version: 5 });
  assert.equal(
    classifyRestore(d, { title: '标题甲', content: '一样的', version: 99 }),
    'adopt_cloud',
  );
});

test('仅标题不同时不得判为 adopt_cloud（否则标题改动会丢失）', () => {
  // 正文与云端一致，标题是用户未保存的修改。
  // 早期实现只比 content，会判成 adopt_cloud 并清掉草稿 → 标题改动丢失。
  const d = draftOf({ content: '一样的', title: '我改的标题', base_version: 5 });
  assert.equal(
    classifyRestore(d, { title: '原标题', content: '一样的', version: 99 }),
    'conflict',
    '标题不同就不能认定草稿冗余',
  );
});

test('仅标题不同时且版本未变则需确认', () => {
  const d = draftOf({ content: '一样的', title: '我改的标题', base_version: 5 });
  assert.equal(
    classifyRestore(d, { title: '原标题', content: '一样的', version: 5 }),
    'confirm',
  );
});

test('云端版本等于 base_version 则需确认', () => {
  const d = draftOf({ content: '草稿', title: '标题甲', base_version: 5 });
  assert.equal(
    classifyRestore(d, { title: '标题甲', content: '云端不同', version: 5 }),
    'confirm',
  );
});

test('版本不同且内容不同则冲突', () => {
  const d = draftOf({ content: '草稿', base_version: 5 });
  assert.equal(classifyRestore(d, { title: 'x', content: '云端不同', version: 7 }), 'conflict');
});

test('classifyRestore 不修改传入对象', () => {
  const d = draftOf({ content: '草稿', base_version: 5 });
  const before = JSON.stringify(d);
  classifyRestore(d, { title: 'x', content: '云端', version: 9 });
  assert.equal(JSON.stringify(d), before, '必须是纯函数');
});

// ---------- 9. 排序 ----------

test('按 recordedAt 降序', () => {
  const store = makeStorage();
  const times = ['2026-10-20T01:00:00.000Z', '2026-10-20T03:00:00.000Z', '2026-10-20T02:00:00.000Z'];
  for (const [i, t] of times.entries()) {
    const key = buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: `${SESS_1.slice(0, -1)}${i}` });
    store.setItem(key, JSON.stringify({
      user_id: USER_A, doc_id: DOC_1, edit_session_id: `${SESS_1.slice(0, -1)}${i}`,
      base_version: 1, title: `t${i}`, content: `c${i}`,
      local_revision: i, recorded_at: t,
    }));
  }
  const list = listDrafts({ userId: USER_A }, store);
  assert.deepEqual(list.map((d) => d.content), ['c1', 'c2', 'c0']);
});
