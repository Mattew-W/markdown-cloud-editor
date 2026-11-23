/**
 * sync.js 的 F-01 / F-03 回归测试（M6 W5 审计后 M1 补）
 *
 * 这两条锁定的是 M6 W5 用探针取证、由 M1 修复的两处真实缺陷。
 * **没有它们，修复会悄悄退化**（比如以后有人把 `this.storage` 参数删掉，
 * 或把 `flushDraft()` 挪到改 docId 之后，测试仍然全绿）。
 *
 * 缺陷背景：
 *   F-01  `resolveReload()` 里的 `discardDraft` 漏传 `this.storage`
 *         → 清理落到默认存储，草稿留在原地，且只打一条 warn 静默失败
 *   F-03  `initSession()` 切换文档前不 flush 待写缓冲
 *         → 250ms 窗口里的最后一批编辑被新文档的 schedule() 覆盖，从未落盘
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SyncEngine } from '../sync.js';
import * as drafts from '../drafts.js';

/** 内存版 Web Storage（与 drafts.w4/w5 测试同构） */
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

/** 可控时钟：可推进时间、可查待触发定时器 */
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
    size() {
      return timers.size;
    },
  };
}

function makeEngine(storage, clock) {
  return new SyncEngine(
    {
      onStateChange: () => {},
      onConflict: () => {},
      onError: () => {},
      onSaveSuccess: () => {},
      onStorageFailure: () => {},
      onCloudUnavailable: () => {},
    },
    {
      timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
      storage,
      random: () => 0,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({}),
      }),
    },
  );
}

const DOC_A = 'doc-a';
const DOC_B = 'doc-b';

describe('sync — M6 W5 缺口 F-01 / F-03 回归', () => {
  test('F-01 resolveReload 的草稿清理必须作用在注入的 storage 上', () => {
    const storage = makeStorage();
    const clock = makeClock();
    const engine = makeEngine(storage, clock);

    engine.initSession('u1', 'tok', { id: DOC_A, title: 'T', content: 'C0', version: 1 });
    engine.onInput('T', 'C-本地未同步');
    engine.flushDraft();

    assert.equal(
      drafts.listDrafts({ userId: 'u1', docId: DOC_A }, storage).length,
      1,
      '前置条件：注入存储里应有一条草稿',
    );

    engine.resolveReload({ id: DOC_A, title: 'T-云端', content: 'C-云端', version: 5 });

    // 若漏传 storage，清理会落到 defaultStorage()，这里仍然是 1
    assert.equal(
      drafts.listDrafts({ userId: 'u1', docId: DOC_A }, storage).length,
      0,
      'resolveReload 后注入存储里的草稿必须被清理（不得落到默认存储）',
    );
  });

  test('F-03 切换文档前必须 flush 待写缓冲，旧文档的编辑不得丢失', () => {
    const storage = makeStorage();
    const clock = makeClock();
    const engine = makeEngine(storage, clock);

    engine.initSession('u1', 'tok', { id: DOC_A, title: 'A', content: 'A0', version: 1 });
    engine.onInput('A', 'A-最后一批编辑'); // 进入 250ms 窗口，尚未落盘

    assert.equal(
      drafts.listDrafts({ userId: 'u1', docId: DOC_A }, storage).length,
      0,
      '前置条件：此刻尚未到 250ms，docA 还没落盘',
    );

    // 切到另一篇文档（app.openDocument 的真实调用点）
    engine.initSession('u1', 'tok', { id: DOC_B, title: 'B', content: 'B0', version: 1 });
    engine.onInput('B', 'B-编辑');
    clock.tick(250);

    const docA = drafts.listDrafts({ userId: 'u1', docId: DOC_A }, storage);
    assert.equal(
      docA.length,
      1,
      '切文档前必须 flush：docA 的待写编辑不得被 docB 的 schedule 覆盖而丢失',
    );
    assert.equal(docA[0].content, 'A-最后一批编辑', '落盘的必须是 docA 的那一批编辑');
    assert.equal(
      drafts.listDrafts({ userId: 'u1', docId: DOC_B }, storage).length,
      1,
      'docB 的草稿应独立存在',
    );
  });

  test('F-03 附带要求：flush 失败必须被上报，不得静默丢掉待写草稿', () => {
    // 若 flushDraft() 在 initSession 里被吞掉（异常不上报），
    // 用户会以为切换成功、旧内容已备份，实际那份编辑既没落盘也没提示。
    const map = new Map();
    const storage = {
      get length() {
        return map.size;
      },
      key: (i) => [...map.keys()][i] ?? null,
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      // setItem 抛错 → flush 落盘失败
      setItem: () => {
        throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      },
      removeItem: (k) => map.delete(k),
    };

    const clock = makeClock();
    let storageFailures = 0;
    const engine = new SyncEngine(
      {
        onStateChange: () => {},
        onConflict: () => {},
        onError: () => {},
        onSaveSuccess: () => {},
        onStorageFailure: () => {
          storageFailures += 1;
        },
        onCloudUnavailable: () => {},
      },
      {
        timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
        storage,
        random: () => 0,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({}),
        }),
      },
    );

    engine.initSession('u1', 'tok', { id: DOC_A, title: 'A', content: 'A0', version: 1 });
    engine.onInput('A', 'A-最后一批编辑'); // 进入 250ms 窗口

    engine.initSession('u1', 'tok', { id: DOC_B, title: 'B', content: 'B0', version: 1 });

    assert.ok(
      storageFailures > 0,
      '切换前 flush 失败必须触发 onStorageFailure（不得静默丢弃待写草稿）',
    );
  });
});
