/**
 * 证据：待写缓冲与 clearSessionDrafts 的先后顺序（M6-03 第三项）
 *
 * 运行：node evidence/probe_buffers.mjs
 *
 * 结论先说：
 *   - cancel() → clearSessionDrafts()  ：不复活（由 npm test 用例守护）
 *   - flush()  → clearSessionDrafts()  ：不复活（由 npm test 用例守护）
 *   - 直接 clearSessionDrafts()（不 cancel / 不 flush）：**会复活**，且写回的正是被清掉的会话草稿。
 *     ⇒ 这属于跨模块接线顺序问题（SYNC §8.1「先保存本地草稿，再建立新编辑会话」），
 *       已写入 M1交接表.md，要求 M1 在切换文档时先 flush/cancel 再清理。
 */

import { clearSessionDrafts, createDraftWriter, listDrafts, saveDraft } from '../frontend/js/drafts.js';

const USER = 'u-1';
const DOC = 'd-1';
const CURRENT = 's-current';
const OLD = 's-old';

function makeStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

function draft(sessionId, content) {
  return {
    userId: USER, docId: DOC, sessionId,
    baseVersion: 3, title: '同一标题', content, localRevision: 1,
  };
}

function makeClock() {
  let next = 0;
  const timers = new Map();
  return {
    delay(fn) { const id = (next += 1); timers.set(id, fn); return id; },
    cancel(id) { timers.delete(id); },
    fireOldest() {
      const id = [...timers.keys()][0];
      const fn = timers.get(id);
      if (!fn) return false;
      timers.delete(id);
      fn();
      return true;
    },
    size() { return timers.size; },
  };
}

function scenario(name, { cancel, flush }) {
  const store = makeStorage();
  const clock = makeClock();
  const writer = createDraftWriter({ storage: store, delay: clock.delay, clearDelay: clock.cancel });

  saveDraft(draft(OLD, '旧会话草稿'), store);
  writer.schedule(draft(OLD, '旧会话草稿'));   // 待写缓冲里也有同一份

  if (cancel) writer.cancel();
  if (flush) writer.flush();

  clearSessionDrafts({ userId: USER, docId: DOC, sessionId: CURRENT }, { force: true }, store);
  const afterCleanup = listDrafts({ userId: USER, docId: DOC }, store).length;

  const fired = clock.fireOldest();            // 模拟 250ms 到点
  const afterFire = listDrafts({ userId: USER, docId: DOC }, store).map((d) => d.content);

  console.log(`\n[${name}]`);
  console.log(`  清理后条数            = ${afterCleanup}`);
  console.log(`  旧定时器是否仍触发     = ${fired}`);
  console.log(`  到点后内容            = ${JSON.stringify(afterFire)}`);

  if (afterFire.length === 0) {
    console.log('  结论                  = 不复活');
  } else {
    console.log('  结论                  = 复活（接线顺序风险，见 M1交接表.md）');
  }
}

console.log('=== 待写缓冲 × 清理顺序（实测） ===');
scenario('A 直接清理（未 cancel / 未 flush）', { cancel: false, flush: false });
scenario('B 先 cancel 再清理', { cancel: true, flush: false });
scenario('C 先 flush 再清理', { cancel: false, flush: true });
