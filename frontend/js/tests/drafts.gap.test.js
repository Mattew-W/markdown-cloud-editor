/**
 * api.http.test.js 的 Node 内置测试。
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

/**
 * 草稿层（drafts.js）的 Node 内置测试 —— M6 W4 补缺断言
 *
 * 用途：填补 W4 审核中发现的 4 处**断言空缺**。
 * 背景：这 4 条行为**生产代码本就正确**（不是实现缺陷），
 * 但现有用例（W4 新增 25 项 + 旧 47 项）**检不出**对应的变异，
 * 属于「看起来测了、实际测不到」的假覆盖。
 *
 * 每条断言都经定向变异验证：
 *   GAP-1 去掉 clearSessionDrafts 的 docId 段  → 变红
 *   GAP-2 去掉 clearSessionDrafts 的 userId 段 → 变红
 *   GAP-3 把 MERGE_WINDOW_MS 改成 10           → 变红
 *   GAP-4 让 saveDraft 返回 recordedAt='Invalid Date' → 变红
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MERGE_WINDOW_MS,
  clearSessionDrafts,
  listDrafts,
  saveDraft,
} from '../drafts.js';

// ---------- 测试替身 ----------

/** 内存版 Web Storage。 */
function makeStorage() {
  const map = new Map();
  return {
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
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
  };
}

const USER_A = 'user-a';
const USER_B = 'user-b';
const DOC_1 = 'doc-1';
const DOC_2 = 'doc-2';
const SESS_1 = 'sess-1';
const SESS_2 = 'sess-2';

function draftOf(overrides = {}) {
  return {
    userId: USER_A,
    docId: DOC_1,
    sessionId: SESS_1,
    baseVersion: 3,
    title: 'T',
    content: 'C',
    localRevision: 7,
    ...overrides,
  };
}

describe('drafts — W4 补缺断言（填补空覆盖）', () => {
  test('GAP-1 clearSessionDrafts 不得误删「其他文档」中已被云端覆盖的草稿', () => {
    // 为什么原用例检不出：原用例里"别的文档"记录的 title/content 与 cloud
    // **不匹配** → isCoveredByCloud 返回 false → 那条记录本来就不在可删集合里，
    // 删不删都与 scope 前缀无关。**必须让其他文档的记录与 cloud 完全一致**，
    // 才能真正检验 docId 是否参与过滤。
    const store = makeStorage();
    saveDraft(draftOf({ docId: DOC_1, sessionId: SESS_2 }), store);
    saveDraft(draftOf({ docId: DOC_2, sessionId: SESS_2 }), store);

    clearSessionDrafts(
      { userId: USER_A, docId: DOC_1, sessionId: SESS_1 },
      { cloud: { version: 9, title: 'T', content: 'C' } },
      store,
    );

    assert.equal(
      listDrafts({ userId: USER_A, docId: DOC_2 }, store).length,
      1,
      '其他文档的草稿必须保留——scope 过滤必须含 docId',
    );
  });

  test('GAP-2 clearSessionDrafts 不得误删「其他账号」中已被云端覆盖的草稿', () => {
    // 同 GAP-1：账号维度也必须让记录与 cloud 完全一致才构成有效检验。
    const store = makeStorage();
    saveDraft(draftOf({ sessionId: SESS_2 }), store);
    saveDraft(draftOf({ userId: USER_B, sessionId: SESS_2 }), store);

    clearSessionDrafts(
      { userId: USER_A, docId: DOC_1, sessionId: SESS_1 },
      { cloud: { version: 9, title: 'T', content: 'C' } },
      store,
    );

    assert.equal(
      listDrafts({ userId: USER_B }, store).length,
      1,
      '其他账号的草稿必须保留——scope 过滤必须含 userId',
    );
  });

  test('GAP-3 合并写入窗口必须是 250 毫秒', () => {
    // 契约 SYNC §9.4；假时钟虽存了 ms，但无任何用例读取它。
    assert.equal(MERGE_WINDOW_MS, 250, '合并窗口必须是 250 毫秒');
  });

  test('GAP-4 saveDraft 返回的 recordedAt 必须可被 Date.parse 解析', () => {
    // 契约要求最终返回值不显示 Invalid Date。
    // 旧用例 drafts.test.js 有兜底，但 W4 新增用例未覆盖此返回值。
    const store = makeStorage();
    const result = saveDraft(draftOf(), store);

    assert.equal(typeof result.recordedAt, 'string');
    assert.equal(
      Number.isNaN(Date.parse(result.recordedAt)),
      false,
      'recordedAt 不能是 Invalid Date',
    );
  });
});
