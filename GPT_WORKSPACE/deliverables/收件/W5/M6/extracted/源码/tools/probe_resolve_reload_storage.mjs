/**
 * 诊断脚本（非测试）：确认 `SyncEngine.resolveReload()` 的草稿清理是否作用在
 * **注入的 storage** 上。
 *
 * 背景：`discardOwnDraft()` 调用 `drafts.discardDraft(key, snapshot, this.storage)`，
 * 显式传入了注入存储；而 `resolveReload()` 里的那次 `discardDraft` 只传了两个实参，
 * 于是走 `defaultStorage()`（浏览器里是 localStorage，Node 里直接抛错）。
 *
 * 在生产页面里两者恰好同一个 localStorage，所以看不出问题；但一旦换成注入/封装的
 * 存储适配器（测试、离线封装、隐私模式降级），这次清理就会落到别处，草稿留在原地。
 *
 * 运行：node tools/probe_resolve_reload_storage.mjs
 * 期望（当前实现）：注入存储里仍剩 1 条草稿，并打印一条 "丢弃本地草稿失败" 警告。
 */

import { SyncEngine } from '../frontend/js/sync.js';
import * as drafts from '../frontend/js/drafts.js';

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

const timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

const engine = new SyncEngine(
  {
    onStateChange: () => {},
    onConflict: () => {},
    onError: () => {},
    onSaveSuccess: () => {},
    onStorageFailure: () => {},
    onCloudUnavailable: () => {},
  },
  { timers, storage, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }), random: () => 0 },
);

engine.initSession('u1', 'tok', { id: 'doc1', title: 'T', content: 'C0', version: 1 });
engine.onInput('T', 'C-本地未同步');
engine.flushDraft();

const before = drafts.listDrafts({ userId: 'u1', docId: 'doc1' }, storage).length;
engine.resolveReload({ id: 'doc1', title: 'T-云端', content: 'C-云端', version: 5 });
const after = drafts.listDrafts({ userId: 'u1', docId: 'doc1' }, storage).length;

console.log(`[probe] resolveReload 前草稿条数 = ${before}`);
console.log(`[probe] resolveReload 后草稿条数 = ${after}`);
console.log(
  after === 0
    ? '[probe] 结论：清理作用在注入存储上（无缺口）'
    : '[probe] 结论：清理未作用在注入存储上 —— resolveReload 未传 storage（缺口 F-01）',
);
