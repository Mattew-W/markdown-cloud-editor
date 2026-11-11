/**
 * M6-06 —— 交给 M1 的调用样例（可运行，输出即真实返回值）
 *
 * 运行：node handoff/call_samples.mjs
 *
 * 目的是把 drafts.js 的**返回值形状**与**文案禁令**落到可复制的样例里：
 *   1. 保存成功：{ key, recordedAt } —— 只能显示“已在本地备份”，不得改 synced/dirty
 *   2. 保存失败：抛 DraftStorageError —— 不得显示“备份成功”，必须保留内存内容
 *   3. 删除拒绝：false —— 必须保留编辑器内容与状态，不得按“已丢弃”处理
 *   4. 删除成功：true
 *   5. 清理：{ removed, kept } —— 只清本用户/本文档的旧会话
 *   6. 合并写入器：成功落盘 / 抛错后 pending 仍为 true（可重试）
 *
 * 注意：本文件不是测试，不参与 `npm test`；它只打印真实调用结果供 M1 接线参考。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 路径按脚本自身位置解析，兼容两种布局：
//   交付包：<包根>/证据/call_samples.mjs   +  <包根>/源码/frontend/js/drafts.js
//   work  ：<work>/handoff/call_samples.mjs + <work>/frontend/js/drafts.js
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  path.join(HERE, '..', '源码', 'frontend', 'js', 'drafts.js'),
  path.join(HERE, '..', 'frontend', 'js', 'drafts.js'),
];
const DRAFTS_PATH = CANDIDATES.find((p) => existsSync(p));
if (!DRAFTS_PATH) {
  throw new Error(`找不到 drafts.js，已尝试：\n${CANDIDATES.join('\n')}`);
}

const {
  DraftStorageError,
  buildDraftKey,
  clearSessionDrafts,
  createDraftWriter,
  discardDraft,
  listDrafts,
  readDraft,
  saveDraft,
} = await import(pathToFileURL(DRAFTS_PATH).href);

const USER = 'u-1';
const DOC = 'd-1';
const SESS = 's-1';
const OTHER_SESS = 's-2';

function makeStorage({ failSet = null } = {}) {
  const map = new Map();
  let nextSetFails = failSet;
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      if (nextSetFails) {
        const name = nextSetFails;
        nextSetFails = null;
        const e = Object.assign(new Error('quota'), { name });
        throw e;
      }
      map.set(k, String(v));
    },
    removeItem(k) { map.delete(k); },
    /** 供样例复位故障开关 */
    arm(next) { nextSetFails = next; },
  };
}

function draft(over = {}) {
  return {
    userId: USER,
    docId: DOC,
    sessionId: SESS,
    baseVersion: 3,
    title: '课程笔记',
    content: '# 标题\n\n正文',
    localRevision: 1,
    ...over,
  };
}

function show(title, value) {
  console.log(`\n【${title}】`);
  console.log(JSON.stringify(value, null, 2));
}

console.log('=== M6-06 drafts.js 调用样例（实测输出，非示意） ===');

// ---------- 1. 保存成功 ----------
const store = makeStorage();
const okResult = saveDraft(draft(), store);
show('1 保存成功 → { key, recordedAt }', okResult);
console.log('调用方应显示：已在本地备份');
console.log('调用方禁止显示：已同步 / 保存成功 / 已保存');
console.log('调用方禁止改动：synced / dirty（草稿只是兜底，不是云端保存）');

// ---------- 2. 保存失败 ----------
store.arm('QuotaExceededError');
let failure = null;
try {
  saveDraft(draft({ content: '第二段' }), store);
} catch (error) {
  failure = error;
}
show('2 保存失败 → DraftStorageError（可捕获字段）', {
  name: failure.name,
  reason: failure.reason,
  message: failure.message,
  detail: failure.detail,
  isDraftStorageError: failure instanceof DraftStorageError,
});
console.log('调用方应显示：“' + failure.message + '”，并保留内存内容 + 提供 Markdown 下载');
console.log('调用方禁止显示：备份成功 / 已保存（磁盘里其实没写进去）');
console.log('内存中的草稿仍可用；存储恢复后再次 flush() 可补写（见第 6 项）');

// ---------- 3. 删除被拒绝 ----------
const key = okResult.key;
store.arm(null);
saveDraft(draft({ content: '更新后的正文', localRevision: 9 }), store);
const rejected = discardDraft(key, { sessionId: SESS, localRevision: 1, content: '# 标题\n\n正文' }, store);
show('3 三重核对不通过 → false', { returned: rejected, stillThere: readDraft(key, store).content });
console.log('调用方必须：保留编辑器内容与 dirty/synced 状态，提示“草稿已有新修改，暂不能丢弃”');
console.log('调用方禁止：清空编辑器、按“已丢弃”处理、把 false 当成功');

// ---------- 4. 删除成功 ----------
const current = readDraft(key, store);
const accepted = discardDraft(key, {
  sessionId: current.edit_session_id,
  localRevision: current.local_revision,
  content: current.content,
}, store);
show('4 三项全部相等 → true', { returned: accepted, afterDelete: readDraft(key, store) });
console.log('调用方可以：按“已丢弃该草稿”处理（仅此一条，且必须是用户确认过的）');

// ---------- 5. 清理范围 ----------
// 旧会话 A：内容与云端一致（可删）；旧会话 B：有未上云修改（必须保留）
saveDraft(draft({ sessionId: 's-2', title: '旧标题', content: '已上云' }), store);
saveDraft(draft({ sessionId: 's-3', title: '旧标题', content: '未上云' }), store);
const cleanup = clearSessionDrafts(
  { userId: USER, docId: DOC, sessionId: SESS },
  { cloud: { version: 9, title: '旧标题', content: '已上云' } },
  store,
);
show('5 clearSessionDrafts → { removed, kept }', cleanup);
console.log('调用方应按 removed/kept 逐项提示；kept 里的记录一律不得当作已丢弃');

// ---------- 6. 合并写入器 ----------
const writerStore = makeStorage();
const clock = { timers: new Map(), id: 0 };
const writer = createDraftWriter({
  storage: writerStore,
  delay: (fn) => { const id = (clock.id += 1); clock.timers.set(id, fn); return id; },
  clearDelay: (id) => clock.timers.delete(id),
});

writer.schedule(draft({ content: '窗口内的最后一次' }));
const fire = clock.timers.get(clock.id);
clock.timers.delete(clock.id);
fire();
show('6a schedule → 定时器到点 → 落盘结果', {
  pendingAfterFire: writer.pending(),
  saved: listDrafts({ userId: USER, docId: DOC }, writerStore).map((d) => d.content),
});

writerStore.arm('QuotaExceededError');
writer.schedule(draft({ content: '存储故障期间的内容' }));
let flushError = null;
try {
  writer.flush();
} catch (error) {
  flushError = { reason: error.reason, message: error.message };
}
show('6b 保存抛错 → flush 抛出，但 pending 仍为 true（可重试）', {
  flushError,
  pending: writer.pending(),
});
writerStore.arm(null);
writer.flush();
show('6c 存储恢复后再次 flush → 补写成功', {
  pending: writer.pending(),
  saved: listDrafts({ userId: USER, docId: DOC }, writerStore).map((d) => d.content),
});
console.log('M1 接线要点：6b 中若把异常吞掉并显示“备份成功”，用户会以为内容已落盘而关闭浏览器——这正是文案禁令要防的事故');

// ---------- 7. 键与身份 ----------
show('7 buildDraftKey 的形状（三段编码，含 user_id 防跨账号）', {
  key: buildDraftKey({ userId: USER, docId: DOC, sessionId: SESS }),
  note: '键必须含 userId；M1 传入的 userId 必须是当前账号，切换账号必须重新取会话 ID',
});
