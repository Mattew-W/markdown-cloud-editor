/**
 * drafts.js 的 W5 用例：草稿隔离与留存 / 条件删除（M6-W5-02、M6-W5-03）
 *
 * 与 W2 的 `drafts.test.js`、W4 的 `drafts.w4.test.js` / `drafts.gap.test.js` 互补，
 * **不替换**既有用例。本文件只补 W5 任务书点出、而既有用例没有按「实际存储键
 * 与读回值」取证的场景：
 *
 *   W5-02-a 同文档不同用户：**键字符串本身**不同，raw 记录与读回值都各归其主；
 *   W5-02-b 同用户不同文档：键的 doc 段不同，listDrafts 按 doc 过滤；
 *   W5-02-c 匿名（无 userId）：不产生任何可被登录账号读到的草稿（键无法构造，落盘为 0）；
 *   W5-02-d 账号切换：后一个账号的写入不覆盖前一个账号的键，前者的读回值不变；
 *   W5-02-e 等待中的写入（250ms 缓冲）在切换身份后**只落到旧身份的键**，
 *             绝不跨会话写进新身份的键（迟到回调取证）；
 *   W5-02-f 恢复分支采用云端后，待写缓冲不得把草稿「复活」；
 *   W5-02-g 清除计时器必须真正取消执行：到点后存储写入次数为 0（不是只统计调用）；
 *   W5-03-a 保存成功且快照匹配 → 才可清理（键真的消失）；
 *   W5-03-b 保存成功但快照不匹配（期间有新修订）→ 拒绝清理，较新草稿留存；
 *   W5-03-c 保存失败 / 未获云端基准 → 一律不清理（保守默认）；
 *   W5-03-d 409 语义下的「云端版本落后于草稿」→ 较新草稿必须保留；
 *   W5-03-e 云端内容不同（含仅标题不同）→ 保留。
 *
 * 运行：node --test js/tests/drafts.w5.test.js
 */

import { test, describe } from 'node:test';
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
  readDraft,
  saveDraft,
} from '../drafts.js';

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/**
 * 内存版 Web Storage。统计实际写入（`setItem` 成功次数）与写入内容，
 * 用于证明「计时器被取消」不是靠调用计数推断，而是存储真的没被动过。
 *
 * @param {{failOnSet?: string}} [faults]
 */
function makeStorage(faults = {}) {
  const map = new Map();
  const stats = { writes: [] };
  const raise = (name) => Object.assign(new Error('quota exceeded'), { name });
  return {
    stats,
    map,
    get length() {
      return map.size;
    },
    key(i) {
      return [...map.keys()][i] ?? null;
    },
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (faults.failOnSet) throw raise(faults.failOnSet);
      stats.writes.push({ key: k, raw: String(v) });
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
    /** 测试辅助：直接写入原始值（模拟外部改坏 / 绕过模块写盘） */
    putRaw(k, v) {
      map.set(k, String(v));
    },
  };
}

/**
 * 可取消的假时钟。`fire(id)` 返回 false 表示该定时器已被取消（未执行）。
 * 只有「取消真的移除定时器」，才能区分「被取消」与「还没到点」。
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
  };
}

const USER_A = 'user-a';
const USER_B = 'user-b';
const DOC_1 = 'doc-1';
const DOC_2 = 'doc-2';
const SESS_1 = 'sess-1';
const SESS_2 = 'sess-2';

function draftOf(over = {}) {
  return {
    userId: USER_A,
    docId: DOC_1,
    sessionId: SESS_1,
    baseVersion: 3,
    title: '标题甲',
    content: '正文甲',
    localRevision: 1,
    ...over,
  };
}

/** 构造一条合法的落盘记录（snake_case），用于模拟外部写入 */
function storedRecord(parts = {}, over = {}) {
  const { userId = USER_A, docId = DOC_1, sessionId = SESS_1 } = parts;
  return {
    user_id: userId,
    doc_id: docId,
    edit_session_id: sessionId,
    base_version: 3,
    title: '标题甲',
    content: '正文甲',
    local_revision: 1,
    recorded_at: '2026-11-17T02:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// W5-02 草稿隔离与留存
// ---------------------------------------------------------------------------

describe('M6-W5-02 草稿隔离与留存（实际键与读回值取证）', () => {
  test('W5-02-a 同文档不同用户：键字符串不同，raw 记录与读回值各归其主', () => {
    const store = makeStorage();
    const a = saveDraft(draftOf({ content: 'A 的正文' }), store);
    const b = saveDraft(draftOf({ userId: USER_B, content: 'B 的正文' }), store);

    // 键必须逐字符合 C2 格式，且 user 段不同。
    assert.equal(a.key, `${DRAFT_KEY_PREFIX}${USER_A}:${DOC_1}:${SESS_1}`);
    assert.equal(b.key, `${DRAFT_KEY_PREFIX}${USER_B}:${DOC_1}:${SESS_1}`);
    assert.notEqual(a.key, b.key);

    // 实际落盘的两条 raw 记录各自带着自己的 user_id，不串号。
    const rawA = JSON.parse(store.map.get(a.key));
    const rawB = JSON.parse(store.map.get(b.key));
    assert.equal(rawA.user_id, USER_A);
    assert.equal(rawB.user_id, USER_B);
    assert.equal(rawA.content, 'A 的正文');
    assert.equal(rawB.content, 'B 的正文');

    // 读回值同样各归其主。
    assert.equal(readDraft(a.key, store).content, 'A 的正文');
    assert.equal(readDraft(b.key, store).content, 'B 的正文');

    // 枚举按用户隔离：B 看不到 A 的任何一条（含损坏项）。
    assert.equal(listDrafts({ userId: USER_B }, store).length, 1);
    assert.deepEqual(
      listDrafts({ userId: USER_A }, store).map((d) => d.content),
      ['A 的正文'],
    );
  });

  test('W5-02-b 同用户不同文档：键的 doc 段不同，listDrafts 按 doc 过滤到实际记录', () => {
    const store = makeStorage();
    const d1 = saveDraft(draftOf({ docId: DOC_1, content: '文档一正文' }), store);
    const d2 = saveDraft(draftOf({ docId: DOC_2, content: '文档二正文' }), store);

    assert.equal(d1.key, `${DRAFT_KEY_PREFIX}${USER_A}:${DOC_1}:${SESS_1}`);
    assert.equal(d2.key, `${DRAFT_KEY_PREFIX}${USER_A}:${DOC_2}:${SESS_1}`);
    assert.equal(JSON.parse(store.map.get(d1.key)).doc_id, DOC_1);
    assert.equal(JSON.parse(store.map.get(d2.key)).doc_id, DOC_2);

    const only1 = listDrafts({ userId: USER_A, docId: DOC_1 }, store);
    assert.equal(only1.length, 1);
    assert.equal(only1[0].content, '文档一正文', 'doc 过滤必须返回该文档的真实记录');
    assert.equal(listDrafts({ userId: USER_A, docId: DOC_2 }, store)[0].content, '文档二正文');
    assert.equal(listDrafts({ userId: USER_A }, store).length, 2);
  });

  test('W5-02-c 匿名（无 userId）不产生可被登录账号读到的草稿', () => {
    // 契约 C2/§9.2：键必须含 userId；模块不自行推断身份（硬约束 2）。
    // 因此匿名编辑不可能构造出合法键，也就不可能在磁盘上留下任何记录。
    for (const bad of [undefined, null, '', 0]) {
      assert.throws(
        () => buildDraftKey({ userId: bad, docId: DOC_1, sessionId: SESS_1 }),
        TypeError,
        `userId=${String(bad)} 必须无法构造草稿键（匿名不得落盘）`,
      );
    }

    const store = makeStorage();
    assert.throws(
      () => saveDraft(draftOf({ userId: '' }), store),
      TypeError,
      '匿名（空 userId）不得写入草稿',
    );
    assert.equal(store.stats.writes.length, 0, '匿名场景不得产生任何存储写入');

    // 登录后按真实账号枚举，磁盘为空 —— 不会读到匿名阶段的任何内容。
    assert.equal(listDrafts({ userId: USER_A }, store).length, 0);
    assert.equal(store.length, 0, '存储里不得残留任何键');
  });

  test('W5-02-d 账号切换：后一个账号的写入不覆盖前一个账号的键', () => {
    const store = makeStorage();
    const a = saveDraft(draftOf({ content: 'A 未同步内容', localRevision: 5 }), store);
    // 切换账号后 B 在同一文档、同一 sessionId 上写入。
    const b = saveDraft(draftOf({ userId: USER_B, content: 'B 内容', localRevision: 2 }), store);

    assert.equal(JSON.parse(store.map.get(a.key)).content, 'A 未同步内容', 'A 的落盘值不得被 B 覆盖');
    assert.equal(readDraft(a.key, store).local_revision, 5);
    assert.equal(JSON.parse(store.map.get(b.key)).content, 'B 内容');
    // B 读不到 A 的记录，A 也读不到 B 的。
    assert.equal(listDrafts({ userId: USER_B }, store).length, 1);
    assert.equal(readDraft(b.key, store).user_id, USER_B);
  });

  test('W5-02-e 等待中的写入在切换身份后只落到旧身份的键，不跨会话写进新键', () => {
    const store = makeStorage();
    const clock = makeClock();
    const writer = createDraftWriter({ storage: store, delay: clock.delay, clearDelay: clock.cancel });

    // A 编辑后进入 250ms 合并窗口，尚未落盘。
    writer.schedule(draftOf({ userId: USER_A, sessionId: SESS_1, content: 'A 待写' }));
    assert.equal(store.stats.writes.length, 0, '窗口内不得落盘');
    const staleId = clock.ids()[0];

    // 身份切换到 B（新用户、新文档、新会话）—— 此时**还没有**任何新的输入，
    // 旧定时器照常到点。这是「迟到回调」的真实形态。
    assert.equal(clock.fire(staleId), true, '旧定时器到点必须能触发（才谈得上迟到回调）');
    assert.equal(store.stats.writes.length, 1, '迟到回调恰好写一次');

    const writtenKey = store.stats.writes[0].key;
    assert.equal(
      writtenKey,
      buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 }),
      '迟到回调必须落在旧身份的键上',
    );
    assert.equal(JSON.parse(store.stats.writes[0].raw).content, 'A 待写');
    assert.equal(JSON.parse(store.stats.writes[0].raw).user_id, USER_A);

    // 新身份 B 的键此刻必须为空 —— 迟到回调不得把 A 的内容写进 B 的会话。
    assert.equal(readDraft(buildDraftKey({ userId: USER_B, docId: DOC_2, sessionId: SESS_2 }), store), null);
    assert.equal(listDrafts({ userId: USER_B }, store).length, 0, 'B 前缀下不得出现 A 的内容');

    // B 开始编辑：新的合并窗口，落盘键与内容都属于 B。
    writer.schedule(draftOf({ userId: USER_B, docId: DOC_2, sessionId: SESS_2, content: 'B 待写' }));
    assert.equal(clock.size(), 1, '旧定时器已触发并移除，B 必须排入新的定时器');
    const liveId = clock.ids()[0];
    assert.notEqual(liveId, staleId, 'B 必须拿到新的句柄，不能复用已触发的旧句柄');
    assert.equal(clock.fire(liveId), true);
    assert.equal(store.stats.writes.length, 2);
    assert.equal(JSON.parse(store.stats.writes[1].raw).content, 'B 待写');
    assert.equal(listDrafts({ userId: USER_B }, store).length, 1);
    assert.equal(listDrafts({ userId: USER_A }, store).length, 1, 'A 的记录仍在，未被 B 顶掉');
  });

  test('W5-02-f 恢复分支采用云端后，待写缓冲不得把草稿复活', () => {
    const store = makeStorage();
    const clock = makeClock();
    const writer = createDraftWriter({ storage: store, delay: clock.delay, clearDelay: clock.cancel });

    // 旧会话草稿已落盘，且另有一次待写。
    saveDraft(draftOf({ sessionId: SESS_1, title: '标题甲', content: '正文甲', localRevision: 2 }), store);
    writer.schedule(draftOf({ sessionId: SESS_1, title: '标题甲', content: '正文甲', localRevision: 2 }));
    const pendingId = clock.ids()[0];

    // 恢复判定：与云端完全相同 → adopt_cloud。
    const draft = readDraft(buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 }), store);
    assert.equal(
      classifyRestore(draft, { title: '标题甲', content: '正文甲', version: 9 }),
      'adopt_cloud',
    );

    // 契约顺序（INTERFACES §3 / SYNC §9.7）：先取消待写，再清理，否则会被复活。
    writer.cancel();
    assert.equal(clock.fire(pendingId), false, '取消后定时器不得执行');
    const res = clearSessionDrafts(
      { userId: USER_A, docId: DOC_1, sessionId: SESS_2 },
      { cloud: { version: 9, title: '标题甲', content: '正文甲' } },
      store,
    );
    assert.equal(res.removed.length, 1);
    assert.equal(listDrafts({ userId: USER_A, docId: DOC_1 }, store).length, 0, '采用云端后不得留下草稿');
    assert.equal(store.stats.writes.length, 1, '取消后不得产生第二次写入');
  });

  test('W5-02-g 清除计时器必须真正取消执行：到点后存储写入次数为 0', () => {
    const store = makeStorage();
    const clock = makeClock();
    const writer = createDraftWriter({ storage: store, delay: clock.delay, clearDelay: clock.cancel });

    writer.schedule(draftOf({ content: '不该落盘' }));
    const id = clock.ids()[0];
    writer.cancel();

    assert.equal(clock.size(), 0, 'cancel 必须把定时器移出时钟（不是只置内部标志）');
    assert.equal(writer.pending(), false);
    // 关键取证：即使拿着旧 id 强制触发，也不得产生写入。
    assert.equal(clock.fire(id), false, '已取消的句柄不得执行');
    assert.equal(store.stats.writes.length, 0, '取消后存储写入次数必须为 0');
    assert.equal(store.length, 0);
    // 清理该文档（含当前会话）也不应留下任何痕迹。
    clearSessionDrafts({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 }, { force: true }, store);
    assert.equal(store.length, 0);
  });

  test('W5-02-h 同一用户的遗留草稿按 recorded_at 倒序枚举，且损坏项单独标记', () => {
    const store = makeStorage();
    store.putRaw(
      buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_1 }),
      JSON.stringify(storedRecord({ sessionId: SESS_1 }, { recorded_at: '2026-11-17T01:00:00.000Z', content: '较早', local_revision: 1 })),
    );
    store.putRaw(
      buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: SESS_2 }),
      JSON.stringify(storedRecord({ sessionId: SESS_2 }, { recorded_at: '2026-11-17T03:00:00.000Z', content: '较晚', local_revision: 2 })),
    );
    store.putRaw(buildDraftKey({ userId: USER_A, docId: DOC_1, sessionId: 'sess-3' }), '{坏 JSON');

    const listed = listDrafts({ userId: USER_A, docId: DOC_1 }, store);
    assert.equal(listed.length, 3, '两条合法 + 一条损坏都要返回，不得静默丢弃');
    assert.equal(listed[0].content, '较晚', '按 recorded_at 倒序');
    assert.equal(listed[1].content, '较早');
    assert.equal(listed[2].corrupt, true, '损坏项必须带 corrupt 标记');
  });
});

// ---------------------------------------------------------------------------
// W5-03 条件删除
// ---------------------------------------------------------------------------

describe('M6-W5-03 条件删除（保存结果 × 快照匹配）', () => {
  test('W5-03-a 保存成功且会话/修订/内容全匹配 → 才允许清理，键真的消失', () => {
    const store = makeStorage();
    const { key } = saveDraft(
      draftOf({ content: '已上云正文', localRevision: 4, title: '已上云标题' }),
      store,
    );

    const ok = discardDraft(
      key,
      { sessionId: SESS_1, localRevision: 4, content: '已上云正文' },
      store,
    );
    assert.equal(ok, true);
    assert.equal(store.map.has(key), false, '匹配时必须真的从存储里删除该键');
    assert.equal(readDraft(key, store), null);
  });

  test('W5-03-b 保存成功但期间产生新修订 → 拒绝清理，较新草稿留存且读回值是最新内容', () => {
    const store = makeStorage();
    const { key } = saveDraft(
      draftOf({ content: '第 1 修订', localRevision: 1 }),
      store,
    );
    // 保存响应回来前，用户又输入了一次：同一键被覆盖为第 2 修订。
    saveDraft(draftOf({ content: '第 2 修订', localRevision: 2 }), store);

    const ok = discardDraft(
      key, // 快照仍指向第 1 修订
      { sessionId: SESS_1, localRevision: 1, content: '第 1 修订' },
      store,
    );
    assert.equal(ok, false, '快照不匹配必须拒绝清理');
    assert.equal(readDraft(key, store).content, '第 2 修订', '较新的草稿必须留存');
    assert.equal(readDraft(key, store).local_revision, 2);
  });

  test('W5-03-b2 内容相同但修订号更新（用户改回原样）→ 以修订号为准，仍拒绝清理', () => {
    const store = makeStorage();
    const { key } = saveDraft(
      draftOf({ title: '标题甲', content: '同一段正文', localRevision: 2 }),
      store,
    );

    // 内容与保存快照完全相同，只有修订号更新。
    // 若实现只比对内容（漏掉修订号），这里会误删，把「保存之后又发生的编辑」丢掉。
    const ok = discardDraft(
      key,
      { sessionId: SESS_1, localRevision: 1, content: '同一段正文' },
      store,
    );
    assert.equal(ok, false, '内容相同但修订号更新时仍必须拒绝清理');
    assert.equal(readDraft(key, store).local_revision, 2);

    // 修订号也匹配时才允许删（正对照，防止本用例因其他原因恒不删）。
    const okExact = discardDraft(
      key,
      { sessionId: SESS_1, localRevision: 2, content: '同一段正文' },
      store,
    );
    assert.equal(okExact, true);
  });

  test('W5-03-c 保存失败（未获云端基准）→ 一律不清理', () => {
    const store = makeStorage();
    const { key } = saveDraft(draftOf({ content: '仅在本地', localRevision: 3 }), store);

    // 保存失败时的真实调用形态：根本不会走到 discardDraft；
    // 即使调用「按云端清理」，也必须因为缺少基准而拒绝。
    const noCloud = clearSessionDrafts(
      { userId: USER_A, docId: DOC_1, sessionId: SESS_2 },
      {},
      store,
    );
    assert.deepEqual(noCloud.removed, [], '没有云端基准时不得删除任何记录');
    assert.equal(store.map.has(key), true, '保存失败后草稿必须仍在');

    // 只给版本、缺 title/content —— 半套基准同样不可删（基准必须完整）。
    const halfCloud = clearSessionDrafts(
      { userId: USER_A, docId: DOC_1, sessionId: SESS_2 },
      { cloud: { version: 99 } },
      store,
    );
    assert.deepEqual(halfCloud.removed, [], '云端基准字段不全时不得删除');
    assert.equal(readDraft(key, store).content, '仅在本地');
  });

  test('W5-03-d 409 语义：云端版本落后于草稿（较新草稿）→ 必须保留', () => {
    const store = makeStorage();
    // 草稿基于云端第 9 版，说明它比当前云端（第 4 版）更新。
    const { key } = saveDraft(
      draftOf({ baseVersion: 9, title: '标题甲', content: '正文甲', localRevision: 2 }),
      store,
    );

    const res = clearSessionDrafts(
      { userId: USER_A, docId: DOC_1, sessionId: SESS_2 },
      { cloud: { version: 4, title: '标题甲', content: '正文甲' } },
      store,
    );
    assert.deepEqual(res.removed, [], '云端版本落后于草稿时不得清理（否则丢掉较新内容）');
    assert.equal(store.map.has(key), true);
    assert.equal(readDraft(key, store).base_version, 9);
  });

  test('W5-03-e 云端内容不同（含仅标题不同）→ 必须保留', () => {
    const store = makeStorage();
    const { key } = saveDraft(
      draftOf({ title: '本地新标题', content: '正文甲', localRevision: 6 }),
      store,
    );

    const resBodyDiff = clearSessionDrafts(
      { userId: USER_A, docId: DOC_1, sessionId: SESS_2 },
      { cloud: { version: 30, title: '本地新标题', content: '不同的正文' } },
      store,
    );
    assert.deepEqual(resBodyDiff.removed, [], '正文不同不得清理');
    assert.equal(store.map.has(key), true);

    const resTitleDiff = clearSessionDrafts(
      { userId: USER_A, docId: DOC_1, sessionId: SESS_2 },
      { cloud: { version: 30, title: '不同的标题', content: '正文甲' } },
      store,
    );
    assert.deepEqual(resTitleDiff.removed, [], '仅标题不同也不得清理（标题改动同样要有草稿保护）');
    assert.equal(store.map.has(key), true);

    // 正对照：三项都一致且版本足够时，才删得掉 —— 证明上面的「保留」不是恒不删。
    const resAllMatch = clearSessionDrafts(
      { userId: USER_A, docId: DOC_1, sessionId: SESS_2 },
      { cloud: { version: 30, title: '本地新标题', content: '正文甲' } },
      store,
    );
    assert.deepEqual(resAllMatch.removed, [key], '正对照必须删掉这一条');
    assert.equal(store.map.has(key), false);
  });

  test('W5-03-f 快照匹配但属于其他会话/其他文档/其他账号 → 仍不得清理', () => {
    const store = makeStorage();
    // 三个「邻近」记录，内容与云端完全一致，只是归属不同。
    const otherSession = saveDraft(draftOf({ sessionId: SESS_2, content: '正文甲', localRevision: 2 }), store);
    const otherDoc = saveDraft(draftOf({ docId: DOC_2, sessionId: SESS_2, content: '正文甲', localRevision: 2 }), store);
    const otherUser = saveDraft(draftOf({ userId: USER_B, sessionId: SESS_2, content: '正文甲', localRevision: 2 }), store);

    // 当前会话自己的记录（内容相同，且已是当前会话 → 不在清理范围内）。
    const current = saveDraft(draftOf({ sessionId: SESS_1, content: '正文甲', localRevision: 2 }), store);

    const res = clearSessionDrafts(
      { userId: USER_A, docId: DOC_1, sessionId: SESS_1 },
      { cloud: { version: 30, title: '标题甲', content: '正文甲' } },
      store,
    );

    assert.deepEqual(res.removed, [otherSession.key], '只允许删本文档、本账号、非当前会话的那一条');
    assert.equal(store.map.has(current.key), true, '当前会话绝不清理');
    assert.equal(store.map.has(otherDoc.key), true, '其他文档不清理');
    assert.equal(store.map.has(otherUser.key), true, '其他账号不清理');
    assert.equal(listDrafts({ userId: USER_B }, store).length, 1);

    // 三重核对的第一项：会话 ID 不符时，单条 discardDraft 同样拒绝（防误删他人会话）。
    const sameContentOtherSession = saveDraft(
      draftOf({ sessionId: SESS_2, content: '正文甲', localRevision: 2 }),
      store,
    );
    assert.equal(
      discardDraft(
        sameContentOtherSession.key,
        { sessionId: SESS_1, localRevision: 2, content: '正文甲' },
        store,
      ),
      false,
      '会话 ID 不符时不得删除（修订号与内容都相同也不行）',
    );
    assert.equal(store.map.has(sameContentOtherSession.key), true);
  });

  test('W5-03-g 删除阶段的存储故障必须抛出可分类错误，不得静默返回 removed=[]', () => {
    const store = makeStorage();
    saveDraft(draftOf({ sessionId: SESS_2, content: '正文甲', localRevision: 2 }), store);

    // 读阶段正常（getItem/key 可用），只有 removeItem 失败。
    // 这是「清理动作本身失败」的最小形态：若实现把错误吞掉，调用方会误以为草稿已清理。
    const brokenStore = {
      get length() {
        return store.length;
      },
      key: (i) => store.key(i),
      getItem: (k) => store.getItem(k),
      setItem: (k, v) => store.setItem(k, v),
      removeItem: () => {
        throw Object.assign(new Error('Quota exceeded.'), { name: 'QuotaExceededError' });
      },
    };

    assert.throws(
      () => clearSessionDrafts(
        { userId: USER_A, docId: DOC_1, sessionId: SESS_1 },
        { cloud: { version: 30, title: '标题甲', content: '正文甲' } },
        brokenStore,
      ),
      (e) => e instanceof DraftStorageError && e.reason === 'quota',
      '删除阶段失败必须抛 DraftStorageError(quota)，不得静默返回 removed=[]',
    );
  });
});
