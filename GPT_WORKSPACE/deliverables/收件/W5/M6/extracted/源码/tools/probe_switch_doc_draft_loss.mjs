/**
 * 诊断脚本（非测试）：文档切换时待写草稿是否被刷新。
 *
 * 契约 SYNC.md §8.1：切换文档前必须先把待写草稿刷到磁盘。
 * `initSession()` 只 clearTimers()（撤掉防抖/重试），并**不** flush/cancel
 * 草稿写入器；于是 250ms 合并窗口里的最后一批编辑有两种结局：
 *   a) 无人再输入：定时器到点，写到旧文档自己的键上（内容没丢，但写入发生在新会话里）；
 *   b) 新文档接着输入：`schedule()` 直接覆盖 pendingDraft，旧文档这批编辑**从未落盘**。
 *
 * 运行：node tools/probe_switch_doc_draft_loss.mjs
 */

import { SyncEngine } from '../frontend/js/sync.js';
import * as drafts from '../frontend/js/drafts.js';

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

const store = new Map();
const storage = {
  get length() {
    return store.size;
  },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const clock = makeClock();
const engine = new SyncEngine(
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
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) }),
  },
);

engine.initSession('u1', 'tok', { id: 'docA', title: 'A', content: 'A0', version: 1 });
engine.onInput('A', 'A-最后一批编辑'); // 进入 250ms 窗口，尚未落盘
const beforeSwitch = drafts.listDrafts({ userId: 'u1', docId: 'docA' }, storage).length;

// 切到另一篇文档（app.openDocument 的真实调用点）
engine.initSession('u1', 'tok', { id: 'docB', title: 'B', content: 'B0', version: 1 });
engine.onInput('B', 'B-编辑');
clock.tick(250);

const docA = drafts.listDrafts({ userId: 'u1', docId: 'docA' }, storage);
const docB = drafts.listDrafts({ userId: 'u1', docId: 'docB' }, storage);

console.log(`[probe] 切换前 docA 草稿条数 = ${beforeSwitch}`);
console.log(`[probe] 切换并继续编辑后 docA 草稿条数 = ${docA.length}`);
console.log(`[probe] 切换并继续编辑后 docB 草稿条数 = ${docB.length}`);
console.log(
  docA.length === 0
    ? '[probe] 结论：docA 的待写编辑从未落盘 —— initSession 未 flush 待写草稿（缺口 F-03）'
    : '[probe] 结论：docA 的待写编辑已落盘（无缺口）',
);
