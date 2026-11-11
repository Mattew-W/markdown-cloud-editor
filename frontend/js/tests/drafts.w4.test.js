/**
 * drafts.js 的 M6 W4 新增用例（与 W2 既有 `drafts.test.js` 区分，旧用例未改动）
 *
 * 对应验收编号：
 * - M6-01 user/doc/session 三元键隔离；键与记录身份不符判 corrupt；listDrafts 不泄露其他账号
 * - M6-02 StorageAdapter 四种语义（quota/unavailable/corrupt/serialize）+ camelCase→snake_case
 * - M6-03 discardDraft 三重核对（逐项只改一处）；clearSessionDrafts 冻结范围；待写缓冲不复活
 * - M6-04 250ms 合并写入：可取消假时钟、实际写入次数与落盘值；classifyRestore 按 SYNC §9.7 回归
 *
 * 运行：npm test 或 node --test js/tests/drafts.w4.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DRAFT_KEY_PREFIX,
  MERGE_WINDOW_MS,
  DraftStorageError,
  buildDraftKey,
  classifyRestore,
  clearSessionDrafts,
  createDraftWriter,
  discardDraft,
  listDrafts,
  readDraft,
  saveDraft,
} from '../drafts.js';

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/**
 * 内存版 Web Storage。可注入 get / set 故障，并统计 setItem 实际写入次数。
 *
 * @param {{failOnSet?: string, failOnGet?: string}} [faults]
 */
function makeStorage(faults = {}) {
  const map = new Map();
  const stats = { setCalls: [], writes: [] };
  const raise = (name) => {
    const message = name === 'QuotaExceededError'
      ? 'Failed to execute setItem: Quota exceeded.'
      : 'The operation is insecure.';
    return Object.assign(new Error(message), { name });
  };
  return {
    stats,
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
      stats.setCalls.push(k);
      stats.writes.push({ key: k, raw: String(v) });
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
    /** 测试辅助：直接写入原始值（模拟被外部改坏的值） */
    putRaw(k, v) {
      map.set(k, String(v));
    },
  };
}

/**
 * 可取消的假时钟（M6-R19）。
 *
 * `delay` 返回 id，`cancel` 真正移除定时器，`fire` 返回布尔值：
 * true = 仍有效并已触发；false = 已被取消（未触发）。
 * 这样「定时器是否被真正取消」可被断言，而不是只能靠 pending() 间接推断。
 */
function makeClock() {
  let nextId = 0;
  const timers = new Map();
  return {
    delay(fn, ms) {
      const id = (nextId += 1);
      timers.set(id, { fn, ms });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    fire(id) {
      const entry = timers.get(id);
      if (!entry) return false;
      timers.delete(id);
      entry.fn();
      return true;
    },
    size() {
      return timers.size;
    },
    ids() {
      return [...timers.keys()];
    },
    /** 取某个定时器被排入时的延迟毫秒数——用于断言「实际排入的就是 250ms」 */
    msOf(id) {
      const entry = timers.get(id);
      return entry ? entry.ms : null;
    },
  };
}

const USER_A = '6f1a3c2e-8b5d-4a71-9f0e-2d3c4b5a6e7f';
const USER_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DOC_1 = 'b2e9d4f1-0c3a-4e5b-8d7a-1f2e3d4c5b6a';
const DOC_2 = '11111111-2222-4333-8444-555555555555';
const SESS_1 = 'c3d5e7a9-1b2f-4c8d-9e0a-3f4c5d6e7f8a';
const SESS_2 = '99999999-8888-4777-8666-555555555555';
const SESS_3 = '77777777-6666-4555-8444-333333333333';

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

/** 构造一条落盘的合法记录（snake_case），用于模拟外部写入 */
function storedRecord(parts = {}, over = {}) {
  const { userId = USER_A, docId = DOC_1, sessionId = SESS_1 } = parts;
  return {
    user_id: userId,
    doc_id: docId,
    edit_session_id: sessionId,
    base_version: 3,
    title: 't',
    content: 'c',
    local_revision: 7,
    recorded_at: '2026-11-09T04:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// M6-01 三元键隔离
// ---------------------------------------------------------------------------

test('M6-01 两个账号同文档同会话：键不同、互不覆盖、各自读回自己的内容', () => {
  const store = makeStorage();
  const a = saveDraft(draftOf({ content: 'A 的内容' }), store);
  const b = saveDraft(draftOf({ userId: USER_B, content: 'B 的内容' }), store);

  assert.notEqual(a.key, b.key, '同文档同会话下，账号不同必须产生不同的键');
  assert.equal(readDraft(a.key, store).content, 'A 的内容');
  assert.equal(readDraft(b.key, store).content, 'B 的内容');
  assert.equal(readDraft(a.key, store).user_id, USER_A);
  assert.equal(readDraft(b.key, store).user_id, USER_B);
});

test('M6-01 同账号同文档不同会话：分别存取，互不覆盖', () => {
  const store = makeStorage();
  const s1 = saveDraft(draftOf({ sessionId: SESS_1, content: '会话一' }), store);
  const s2 = saveDraft(draftOf({ sessionId: SESS_2, content: '会话二' }), store);

  assert.equal(readDraft(s1.key, store).content, '会话一');
  assert.equal(readDraft(s2.key, store).content, '会话二');
  assert.equal(readDraft(s1.key, store).edit_session_id, SESS_1);
  assert.equal(readDraft(s2.key, store).edit_session_id, SESS_2);

  const listed = listDrafts({ userId: USER_A, docId: DOC_1 }, store);
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((d) => d.content).sort(), ['会话一', '会话二'].sort());
});

test('M6-01 同账号不同文档：分别存取，互不覆盖', () => {
  const store = makeStorage();
  const d1 = saveDraft(draftOf({ docId: DOC_1, content: '文档一' }), store);
  const d2 = saveDraft(draftOf({ docId: DOC_2, content: '文档二' }), store);

  assert.equal(readDraft(d1.key, store).content, '文档一');
  assert.equal(readDraft(d2.key, store).content, '文档二');
  assert.equal(listDrafts({ userId: USER_A, docId: DOC_1 }, store).length, 1);
  assert.equal(listDrafts({ userId: USER_A, docId: DOC_2 }, store).length, 1);
  assert.equal(listDrafts({ userId: USER_A }, store).length, 2);
});

test('M6-01 listDrafts 不泄露其他账号（含损坏项）', () => {
  const store = makeStorage();
  saveDraft(draftOf({ sessionId: SESS_2, content: '只属于 A' }), store);
  // 键是 A 的，记录身份却是 B：判 corrupt，且绝不能出现在 B 的枚举里
  store.putRaw(
    buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 }),
    JSON.stringify(storedRecord({ userId: USER_B })),
  );

  const byA = listDrafts({ userId: USER_A }, store);
  assert.equal(byA.length, 2, 'A 的两条（一条合法、一条损坏）都在');
  assert.equal(byA.filter((d) => d.corrupt).length, 1);
  assert.equal(byA.find((d) => !d.corrupt).content, '只属于 A');

  const byB = listDrafts({ userId: USER_B }, store);
  assert.equal(byB.length, 0, 'B 不得看到任何属于 A 的记录（含损坏项）');

  // 损坏项携带的身份来自键，不采信记录里的伪造字段
  const corrupt = byA.find((d) => d.corrupt);
  assert.equal(corrupt.user_id, USER_A, '损坏项身份应以键为准，不采信记录伪造的 user_id');
});

test('M6-01 键与记录身份不符（user/doc/session 三段逐一）判 corrupt，不接受伪造字段', () => {
  for (const field of ['user_id', 'doc_id', 'edit_session_id']) {
    const store = makeStorage();
    const key = buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 });
    store.putRaw(key, JSON.stringify(storedRecord({}, { [field]: 'forged-value' })));

    assert.throws(
      () => readDraft(key, store),
      (e) => e instanceof DraftStorageError && e.reason === 'corrupt',
      `${field} 与键不一致必须判 corrupt`,
    );
    // 也不得被 listDrafts 当成合法记录
    const listed = listDrafts({ userId: USER_A, docId: DOC_1 }, store);
    assert.equal(listed.filter((d) => !d.corrupt).length, 0, `${field} 不一致的记录不得作为合法项返回`);
  }
});

// ---------------------------------------------------------------------------
// M6-02 StorageAdapter 语义与落盘形态
// ---------------------------------------------------------------------------

test('M6-02 quota：真实 StorageAdapter 的 setItem 抛出 QuotaExceededError → reason/中文文案按契约', () => {
  const store = makeStorage({ failOnSet: 'QuotaExceededError' });
  const err = (() => {
    try {
      saveDraft(draftOf(), store);
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err instanceof DraftStorageError);
  assert.equal(err.name, 'DraftStorageError');
  assert.equal(err.reason, 'quota');
  assert.equal(err.message, DraftStorageError.messageFor('quota'));
  assert.equal(err.message, '本地备份失败：存储空间不足');
  assert.equal(store.stats.writes.length, 0, '配额失败时不得落盘');
});

test('M6-02 unavailable：读取阶段抛 SecurityError 也归一化（不是只覆盖写入）', () => {
  const store = makeStorage({ failOnGet: 'SecurityError' });
  const key = buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 });
  assert.throws(
    () => readDraft(key, store),
    (e) => e instanceof DraftStorageError
      && e.reason === 'unavailable'
      && e.message === '本地备份失败：浏览器禁止本地存储',
  );
});

test('M6-02 corrupt：JSON 非法 → 契约文案；结构不符同样归 corrupt', () => {
  const store = makeStorage();
  const key = buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 });

  store.putRaw(key, '{ 这不是合法 JSON');
  assert.throws(
    () => readDraft(key, store),
    (e) => e.reason === 'corrupt' && e.message === '本地备份已损坏，已忽略',
  );

  store.putRaw(key, JSON.stringify(storedRecord({}, { title: 123 })));
  assert.throws(
    () => readDraft(key, store),
    (e) => e.reason === 'corrupt',
    'title 非字符串必须判 corrupt',
  );
});

test('M6-02 serialize：写入前校验失败（title 非字符串 / 版本非整数）→ reason/文案按契约', () => {
  for (const over of [{ title: null }, { title: 123 }, { baseVersion: 3.5 }, { localRevision: -1 }]) {
    const store = makeStorage();
    assert.throws(
      () => saveDraft(draftOf(over), store),
      (e) => e instanceof DraftStorageError
        && e.reason === 'serialize'
        && e.message === '本地备份失败：内容无法序列化',
      `非法入参 ${JSON.stringify(over)} 必须在写入前被拒并归 serialize`,
    );
    assert.equal(store.stats.writes.length, 0, '校验未通过不得落盘');
  }
});

test('M6-02 camelCase 入参 → snake_case 落盘，且读回值可校验到最终返回值', () => {
  const store = makeStorage();
  const { key } = saveDraft(draftOf(), store);

  const raw = JSON.parse(store.stats.writes[0].raw);
  assert.deepEqual(Object.keys(raw).sort(), [
    'base_version', 'content', 'doc_id', 'edit_session_id',
    'local_revision', 'recorded_at', 'title', 'user_id',
  ]);
  for (const camel of ['userId', 'docId', 'sessionId', 'baseVersion', 'localRevision', 'recordedAt']) {
    assert.equal(Object.hasOwn(raw, camel), false, `落盘不应残留 camelCase 键 ${camel}`);
  }
  assert.equal(raw.user_id, USER_A);
  assert.equal(raw.doc_id, DOC_1);
  assert.equal(raw.edit_session_id, SESS_1);
  assert.equal(raw.base_version, 3);
  assert.equal(raw.local_revision, 7);

  const record = readDraft(key, store);
  assert.equal(typeof record.title, 'string');
  assert.equal(typeof record.content, 'string');
  assert.equal(Number.isInteger(record.base_version), true, 'base_version 必须是整数');
  assert.equal(Number.isInteger(record.local_revision), true, 'local_revision 必须是整数');
  assert.equal(Number.isNaN(Date.parse(record.recorded_at)), false, 'recorded_at 必须可解析，不能落到 Invalid Date');
  assert.equal(record.recorded_at, raw.recorded_at);
});

test('M6-02 版本/修订非整数、日期不可解析或为数字 → corrupt（不显示 Invalid Date）', () => {
  const key = buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 });
  const cases = [
    ['base_version 字符串', { base_version: '3' }],
    ['base_version 小数', { base_version: 3.5 }],
    ['base_version 0', { base_version: 0 }],
    ['local_revision 字符串', { local_revision: '7' }],
    ['local_revision 负数', { local_revision: -1 }],
    ['recorded_at 不可解析', { recorded_at: 'not-a-date' }],
    ['recorded_at 数字时间戳', { recorded_at: 1762334400000 }],
  ];
  for (const [label, over] of cases) {
    const store = makeStorage();
    store.putRaw(key, JSON.stringify(storedRecord({}, over)));
    assert.throws(
      () => readDraft(key, store),
      (e) => e.reason === 'corrupt',
      `${label} 必须判 corrupt`,
    );
  }
});

test('M6-02 saveDraft 返回的 recordedAt 也必须可解析（返回值是调用方直接用的）', () => {
  // 上一条用例校验的是**落盘后读回**的 recorded_at；
  // 这里校验**saveDraft 的返回值**——它同样会直接进入界面与日志，
  // 若这里返回 Invalid Date，读回时虽正常，界面仍会显示非法日期。
  const store = makeStorage();
  const result = saveDraft(draftOf(), store);

  assert.equal(typeof result.recordedAt, 'string');
  assert.equal(
    Number.isNaN(Date.parse(result.recordedAt)),
    false,
    'saveDraft 返回的 recordedAt 不能是 Invalid Date',
  );
  assert.equal(result.recordedAt, JSON.parse(store.stats.writes[0].raw).recorded_at,
    '返回值与落盘值必须是同一个时间戳');
});

// ---------------------------------------------------------------------------
// M6-03 条件删除与清理范围
// ---------------------------------------------------------------------------

test('M6-03 只改 sessionId，其余两项相同 → 返回 false 且原记录完好', () => {
  const store = makeStorage();
  const { key } = saveDraft(draftOf({ content: '原始内容', localRevision: 7 }), store);

  const ok = discardDraft(key, { sessionId: SESS_2, localRevision: 7, content: '原始内容' }, store);
  assert.equal(ok, false, '会话不匹配必须拒绝删除');

  const record = readDraft(key, store);
  assert.equal(record.content, '原始内容');
  assert.equal(record.local_revision, 7);
  assert.equal(record.edit_session_id, SESS_1);
});

test('M6-03 只改 localRevision，其余两项相同 → 返回 false 且原记录完好', () => {
  const store = makeStorage();
  const { key } = saveDraft(draftOf({ content: '原始内容', localRevision: 9 }), store);

  const ok = discardDraft(key, { sessionId: SESS_1, localRevision: 7, content: '原始内容' }, store);
  assert.equal(ok, false, '修订号不匹配必须拒绝删除（期间可能有新输入）');
  assert.equal(readDraft(key, store).local_revision, 9, '草稿必须完好');
});

test('M6-03 只改 content，其余两项相同 → 返回 false 且原记录完好', () => {
  const store = makeStorage();
  const { key } = saveDraft(draftOf({ content: '服务器版本', localRevision: 7 }), store);

  const ok = discardDraft(key, { sessionId: SESS_1, localRevision: 7, content: '另一份内容' }, store);
  assert.equal(ok, false, '内容不匹配必须拒绝删除');
  assert.equal(readDraft(key, store).content, '服务器版本');
});

test('M6-03 三项全部相等 → true 且确实删除', () => {
  const store = makeStorage();
  const { key } = saveDraft(draftOf({ content: '可删', localRevision: 7 }), store);
  assert.equal(discardDraft(key, { sessionId: SESS_1, localRevision: 7, content: '可删' }, store), true);
  assert.equal(readDraft(key, store), null);
});

test('M6-03 clearSessionDrafts 只清本用户/本文档内已证实可弃的旧会话', () => {
  const store = makeStorage();
  const root = { userId: USER_A, docId: DOC_1, sessionId: SESS_1 };

  saveDraft(draftOf({ sessionId: SESS_1, content: '当前会话' }), store);
  saveDraft(draftOf({ sessionId: SESS_2, title: '旧标题', content: '已上云' }), store);
  saveDraft(draftOf({ sessionId: SESS_3, title: '旧标题', content: '未上云' }), store);
  saveDraft(draftOf({ docId: DOC_2, sessionId: SESS_2, content: '别的文档' }), store);
  saveDraft(draftOf({ userId: USER_B, sessionId: SESS_2, content: '别的账号' }), store);

  const res = clearSessionDrafts(
    root,
    { cloud: { version: 9, title: '旧标题', content: '已上云' } },
    store,
  );

  assert.deepEqual(
    res.removed,
    [buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_2 })],
    '只应删除「本文档、本账号、旧会话、已被云端覆盖」的那一条',
  );

  const left = listDrafts({ userId: USER_A, docId: DOC_1 }, store).map((d) => d.content).sort();
  assert.deepEqual(left, ['未上云', '当前会话'].sort(), '当前会话与未上云草稿都必须保留');
  assert.equal(listDrafts({ userId: USER_A, docId: DOC_2 }, store).length, 1, '不得影响其他文档');
  assert.equal(listDrafts({ userId: USER_B }, store).length, 1, '不得影响其他账号');
});

test('M6-03 clearSessionDrafts 即使显式点名当前会话键，也不得误清当前会话', () => {
  const store = makeStorage();
  const root = { userId: USER_A, docId: DOC_1, sessionId: SESS_1 };
  const currentKey = saveDraft(draftOf({ sessionId: SESS_1, content: '正在编辑' }), store).key;
  const oldKey = saveDraft(draftOf({ sessionId: SESS_2, content: '旧会话' }), store).key;

  const res = clearSessionDrafts(root, { confirmedKeys: [currentKey, oldKey] }, store);
  assert.deepEqual(res.removed, [oldKey], '当前会话不在清理范围内，即便被点名');
  assert.deepEqual(res.kept, [currentKey]);
  assert.equal(readDraft(currentKey, store).content, '正在编辑');
});

test('M6-03 不得误删「其他文档」中已被云端覆盖的草稿', () => {
  // ⚠ 这条与上面「只清本用户/本文档内旧会话」那条的**关键差别**：
  //   上面的对照记录 content 是「别的文档」，与 cloud 的「已上云」不一致，
  //   isCoveredByCloud 因此返回 false —— 那条记录**本来就不在可删集合里**，
  //   删不删都与 scope 前缀无关，所以那条用例**检不出** docId 过滤失效。
  //   这里让其他文档的记录**与云端完全一致**，它才真的可能被误删，
  //   断言才真正约束了「scope 过滤必须含 docId」。
  const store = makeStorage();
  const root = { userId: USER_A, docId: DOC_1, sessionId: SESS_1 };
  const cloud = { version: 9, title: '旧标题', content: '已上云' };

  saveDraft(draftOf({ sessionId: SESS_2, title: cloud.title, content: cloud.content }), store);
  saveDraft(draftOf({ docId: DOC_2, sessionId: SESS_2, title: cloud.title, content: cloud.content }), store);

  const res = clearSessionDrafts(root, { cloud }, store);

  assert.deepEqual(
    res.removed,
    [buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_2 })],
    '只应删除本文档的那一条',
  );
  assert.equal(
    listDrafts({ userId: USER_A, docId: DOC_2 }, store).length,
    1,
    '其他文档的草稿即使与云端一致也不得被删——scope 过滤必须含 docId',
  );
});

test('M6-03 不得误删「其他账号」中已被云端覆盖的草稿', () => {
  // 同上：其他账号的记录也必须**与云端完全一致**，
  // 才构成对「scope 过滤必须含 userId」的有效检验。
  const store = makeStorage();
  const root = { userId: USER_A, docId: DOC_1, sessionId: SESS_1 };
  const cloud = { version: 9, title: '旧标题', content: '已上云' };

  saveDraft(draftOf({ sessionId: SESS_2, title: cloud.title, content: cloud.content }), store);
  saveDraft(draftOf({ userId: USER_B, sessionId: SESS_2, title: cloud.title, content: cloud.content }), store);

  const res = clearSessionDrafts(root, { cloud }, store);

  assert.deepEqual(
    res.removed,
    [buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_2 })],
    '只应删除本账号的那一条',
  );
  assert.equal(
    listDrafts({ userId: USER_B }, store).length,
    1,
    '其他账号的草稿即使与云端一致也不得被删——scope 过滤必须含 userId',
  );
});

test('M6-03 待写缓冲：cancel 后清理，定时器到点不会复活旧草稿', () => {
  const store = makeStorage();
  const clock = makeClock();
  const writer = createDraftWriter({
    storage: store,
    delay: clock.delay,
    clearDelay: clock.cancel,
  });

  saveDraft(draftOf({ sessionId: SESS_2, content: '旧会话草稿' }), store);
  writer.schedule(draftOf({ sessionId: SESS_2, content: '旧会话草稿' }));
  assert.equal(clock.size(), 1, '应有一个待触发定时器');

  writer.cancel();
  assert.equal(clock.size(), 0, 'cancel 必须真正取消注入时钟的定时器');
  assert.equal(writer.pending(), false);

  clearSessionDrafts({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 }, { force: true }, store);
  assert.equal(clock.fire(1), false, '已取消的定时器不得触发');
  assert.equal(listDrafts({ userId: USER_A, docId: DOC_1 }, store).length, 0, '清理后不得被待写缓冲复活');
});

test('M6-03 待写缓冲：先 flush 落盘再清理，同样不留残留', () => {
  const store = makeStorage();
  const clock = makeClock();
  const writer = createDraftWriter({ storage: store, delay: clock.delay, clearDelay: clock.cancel });

  writer.schedule(draftOf({ sessionId: SESS_2, content: '切换前最后一次' }));
  writer.flush();
  assert.equal(clock.size(), 0, 'flush 必须取消待触发定时器');
  assert.equal(listDrafts({ userId: USER_A, docId: DOC_1 }, store).length, 1);

  clearSessionDrafts({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 }, { force: true }, store);
  assert.equal(listDrafts({ userId: USER_A, docId: DOC_1 }, store).length, 0);
});

// ---------------------------------------------------------------------------
// M6-04 合并写入（可取消假时钟）与恢复分支回归
// ---------------------------------------------------------------------------

test('M6-04 合并窗口必须是 250 毫秒', () => {
  // 契约 SYNC §9.4。上一条用例只验证了「窗口内合并、到点写一次」，
  // 但**没有断言窗口长度本身**——把 250 改成 10，用例仍然全绿。
  // 这里直接把常量钉死，避免合并窗口被无声改短（改短会显著增加写入次数）。
  assert.equal(MERGE_WINDOW_MS, 250, '合并写入窗口必须是 250 毫秒');
});

test('M6-04 实际排入的延迟必须就是 250 毫秒（假时钟记录到的值）', () => {
  // 上一条钉的是导出常量；这条钉的是**真的排进了延迟队列的那个值**，
  // 防止出现「常量是 250、实际排入用别的值」这类不一致。
  const store = makeStorage();
  const clock = makeClock();
  const writer = createDraftWriter({ storage: store, delay: clock.delay, clearDelay: clock.cancel });

  writer.schedule(draftOf({ content: '一次输入' }));
  assert.equal(clock.ids().length, 1, '应排入一个定时器');
  assert.equal(clock.msOf(clock.ids()[0]), 250, '排入的延迟必须是 250 毫秒');
});

test('M6-04 窗口内连续三次输入只写一次，且落盘值为最后一次', () => {
  const store = makeStorage();
  const clock = makeClock();
  const writer = createDraftWriter({ storage: store, delay: clock.delay, clearDelay: clock.cancel });

  writer.schedule(draftOf({ content: '第一击', localRevision: 1 }));
  writer.schedule(draftOf({ content: '第二击', localRevision: 2 }));
  writer.schedule(draftOf({ content: '第三击', localRevision: 3 }));

  assert.equal(store.stats.writes.length, 0, '窗口内不得已落盘');
  assert.equal(writer.pending(), true);

  assert.equal(clock.fire(clock.ids()[0]), true);
  assert.equal(store.stats.writes.length, 1, '一个窗口只能产生一次实际写入');
  const written = JSON.parse(store.stats.writes[0].raw);
  assert.equal(written.content, '第三击', '落盘值必须是最后一次内容，不能只看写入次数');
  assert.equal(written.local_revision, 3);
  assert.equal(writer.pending(), false);
});

test('M6-04 两个相邻窗口各写一次，最终存储保留两条最新内容', () => {
  const store = makeStorage();
  const clock = makeClock();
  const writer = createDraftWriter({ storage: store, delay: clock.delay, clearDelay: clock.cancel });

  writer.schedule(draftOf({ sessionId: SESS_1, content: '窗口一' }));
  clock.fire(clock.ids()[0]);
  writer.schedule(draftOf({ sessionId: SESS_2, content: '窗口二' }));
  clock.fire(clock.ids()[0]);

  assert.equal(store.stats.writes.length, 2, '两个窗口应各有一次写入');
  assert.deepEqual(
    store.stats.writes.map((w) => JSON.parse(w.raw).content),
    ['窗口一', '窗口二'],
  );
  assert.deepEqual(
    listDrafts({ userId: USER_A, docId: DOC_1 }, store).map((d) => d.content).sort(),
    ['窗口一', '窗口二'].sort(),
  );
});

test('M6-04 flush 真正取消注入时钟的旧定时器，旧定时器不得提前写走新草稿', () => {
  const store = makeStorage();
  const clock = makeClock();
  const writer = createDraftWriter({ storage: store, delay: clock.delay, clearDelay: clock.cancel });

  writer.schedule(draftOf({ content: 'A' }));
  const staleId = clock.ids()[0];
  writer.flush();
  assert.equal(store.stats.writes.length, 1, 'flush 必须立即落盘');
  assert.equal(JSON.parse(store.stats.writes[0].raw).content, 'A');
  assert.equal(clock.size(), 0, 'flush 必须真正取消注入时钟的定时器');

  writer.schedule(draftOf({ content: 'B' }));
  assert.equal(clock.size(), 1);

  // 旧定时器若未被取消，会在这里把 B 提前写走（缺陷）
  assert.equal(clock.fire(staleId), false, '旧定时器已被取消，不得再触发');
  assert.equal(store.stats.writes.length, 1, 'B 仍在 250ms 窗口内，不得提前落盘');
  assert.equal(writer.pending(), true, 'B 必须仍处于待写状态');

  clock.fire(clock.ids()[0]);
  assert.equal(store.stats.writes.length, 2);
  assert.equal(JSON.parse(store.stats.writes[1].raw).content, 'B');
});

test('M6-04 flushAll 落盘且不再触发第二次写入', () => {
  const store = makeStorage();
  const clock = makeClock();
  const writer = createDraftWriter({ storage: store, delay: clock.delay, clearDelay: clock.cancel });

  writer.schedule(draftOf({ content: 'flushAll 必须保住我' }));
  const id = clock.ids()[0];
  writer.flushAll();

  assert.equal(store.stats.writes.length, 1);
  assert.equal(JSON.parse(store.stats.writes[0].raw).content, 'flushAll 必须保住我');
  assert.equal(clock.fire(id), false, 'flushAll 后旧定时器不得再写第二次');
  assert.equal(store.stats.writes.length, 1);
  assert.equal(writer.pending(), false);
});

test('M6-04 classifyRestore 按 SYNC §9.7 三分支回归（标题与正文都必须比）', () => {
  // classifyRestore 的入参是**落盘记录**（snake_case），与 readDraft 返回值一致
  const draft = { ...draftOf({ title: '标题甲', content: '草稿正文' }), base_version: 5 };

  // ① 内容与云端相同 → adopt_cloud（版本任意）
  assert.equal(
    classifyRestore(draft, { title: '标题甲', content: '草稿正文', version: 99 }),
    'adopt_cloud',
  );
  // ② 云端版本等于 base_version → confirm（内容不同也一样）
  assert.equal(
    classifyRestore(draft, { title: '标题甲', content: '云端不同', version: 5 }),
    'confirm',
  );
  // ③ 版本不同且内容不同 → conflict
  assert.equal(
    classifyRestore(draft, { title: '标题甲', content: '云端不同', version: 7 }),
    'conflict',
  );
  // 仅标题不同：不得判 adopt_cloud（否则标题改动丢失）
  assert.equal(
    classifyRestore(draft, { title: '云端标题', content: '草稿正文', version: 99 }),
    'conflict',
  );
  assert.equal(
    classifyRestore(draft, { title: '云端标题', content: '草稿正文', version: 5 }),
    'confirm',
  );
  // 纯函数：不修改入参
  const snapshot = JSON.stringify(draft);
  classifyRestore(draft, { title: 'x', content: 'y', version: 1 });
  assert.equal(JSON.stringify(draft), snapshot);
});

test('M6-04 协议字面量保持 ASCII（新增断言不引入非 ASCII 标识符）', () => {
  for (const literal of [DRAFT_KEY_PREFIX, 'markdown-editor:draft:']) {
    assert.match(literal, /^[\x20-\x7E]+$/, `协议字面量必须是 ASCII：${literal}`);
  }
  for (const key of [
    'user_id', 'doc_id', 'edit_session_id', 'base_version',
    'title', 'content', 'local_revision', 'recorded_at',
  ]) {
    assert.match(key, /^[\x20-\x7E]+$/, `落盘字段名必须是 ASCII：${key}`);
  }
});
