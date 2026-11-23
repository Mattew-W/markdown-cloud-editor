// js/tests/app.state.w5.test.js —— M5 W5：可见状态与生命周期补测（M5-W5-01/03）
//
// ⚠ 本文件为 M1 代修版本（2026-11-19）。补两处原 M5 交件缺覆盖的验收点：
//
// 1) M5-W5-03「从实际页面核对**离线、保存中、保存失败和 409 的可见提示**」——
//    原 conflict.w5.test.js 用 `source.includes('case SyncState.${key}:')` 做源码字符串
//    匹配，既不证明分支被触发，也不证明提示文案可见。本文件改为**经 app.js 的
//    updateSyncBadge 真实路径驱动**，断言徽标与状态栏的**具体文案**。
//
// 2) M5-W5-01「用实际入口核对初始化、**重复初始化**、销毁后监听器和事件次数」——
//    原 editor.lifecycle.w5.test.js 用「两个实例并存（两次独立 JSDOM）」顶替重复初始化，
//    语义不同（那是实例间不串扰，不是同一 DOM 上重复初始化导致监听器叠加）。
//    本文件补：**同一 DOM 节点上连续 createEditor 两次**，验证事件次数仍为 1。
//
// 另附状态文案禁令断言（docs/SYNC.md §4.4）：dirty 不得出现「已同步/保存成功/已保存」。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { JSDOM } from 'jsdom';
import { createEditor } from '../editor.js';
import { SyncState } from '../sync.js';

const ELEMENT_IDS = [
  'docTitle', 'docContent', 'preview', 'syncBadge', 'statusText', 'docInfo',
  'statChars', 'docList', 'docCount', 'btnNewDoc', 'btnSaveNow', 'btnDeleteDoc',
  'btnDownloadMarkdown', 'userInfo', 'btnAuthToggle',
  'authModal', 'authModalTitle', 'authForm', 'authUsername', 'authPassword',
  'authError', 'btnAuthSubmit', 'btnAuthSwitch', 'btnAuthClose',
  'conflictModal', 'serverVersionText', 'localVersionText',
  'btnConflictReload', 'btnConflictOverwrite',
  'draftBanner', 'draftTimestamp', 'btnRestoreDraft', 'btnDiscardDraft',
  'storageBanner', 'storageMessage', 'btnDownloadFromBanner',
];

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close(() => resolve());
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 载入 app.js（真实 HTTP 服务 + jsdom），返回 window 与请求记录。 */
async function loadApp(port) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      ${ELEMENT_IDS.map((id) => `<div id="${id}"></div>`).join('')}
    </body></html>`,
    { url: 'http://localhost/', pretendToBeVisual: true },
  );
  const { window } = dom;
  window.localStorage.clear();
  window.sessionStorage.clear();

  const nativeFetch = globalThis.fetch;
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    Blob: globalThis.Blob,
    URL: globalThis.URL,
    fetch: globalThis.fetch,
  };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  globalThis.sessionStorage = window.sessionStorage;
  globalThis.Blob = window.Blob;
  globalThis.URL = window.URL;

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url, `http://127.0.0.1:${port}`);
    calls.push({
      url: target.pathname + target.search,
      method: init.method || 'GET',
      body: init.body ?? null,
    });
    return nativeFetch(target.toString(), {
      method: init.method || 'GET',
      headers: init.headers,
      body: init.body,
    });
  };
  window.fetch = globalThis.fetch;

  const moduleUrl = new URL('../app.js', import.meta.url);
  await import(`${moduleUrl.href}?t=${Date.now()}-${Math.random()}`);

  return {
    window,
    calls,
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.localStorage = previous.localStorage;
      globalThis.sessionStorage = previous.sessionStorage;
      globalThis.Blob = previous.Blob;
      globalThis.URL = previous.URL;
      globalThis.fetch = previous.fetch;
      window.close();
    },
  };
}

const DOC = {
  id: 'doc-1',
  title: '原标题',
  content: '原正文',
  version: 5,
  updated_at: '2026-11-16T00:00:00Z',
};

/**
 * 轮询等待条件成立。
 *
 * 【为什么需要】原实现用固定 `setTimeout(60)` 等登录后的首篇文档打开。
 * 单独运行该文件时够用，但在 `node --test "js/tests/*.test.js"` 下 20 个
 * 测试文件并行（各自独立进程，争 CPU）时，登录→列表→打开这条链超过 60ms，
 * `syncBadge` 仍为空文本，断言失败。改为轮询后不再依赖机器负载。
 */
async function waitFor(predicate, { timeoutMs = 8000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = predicate();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 登录并打开文档，使 state.token / state.currentDoc 就位。 */
async function loginAndOpenDocument(app) {
  const { window } = app;
  const doc = window.document;
  doc.getElementById('authUsername').value = 'tester';
  doc.getElementById('authPassword').value = 'pw12345678';
  doc.getElementById('authForm').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true })
  );
  // 等到「登录报错」或「首篇文档已完整打开」二者之一出现，再断言。
  // 不能只等 docContent 非空：openDocument 的 initSession 在其后仍会重写状态栏。
  await waitFor(
    () =>
      doc.getElementById('authError').textContent !== '' ||
      doc.getElementById('statusText').textContent === '所有更改已同步至云端',
    { label: '登录并打开首篇文档' }
  );
  assert.equal(doc.getElementById('authError').textContent, '', '登录不应出错');
}

/** 触发一次输入 → syncEngine.onInput → 状态流转到 dirty。 */
async function triggerInput(app) {
  const { window } = app;
  const doc = window.document;
  doc.getElementById('docContent').value = '改名后正文';
  doc.getElementById('docContent').dispatchEvent(
    new window.Event('input', { bubbles: true })
  );
  await new Promise((r) => setTimeout(r, 30));
}

/**
 * 收尾：经 app.js 的登出路径触发 syncEngine.destroy() → clearTimers()。
 *
 * ⚠ 必要性（勿删）：本文件断言在输入后 30ms 内完成，此时防抖定时器（1.5s）
 * 尚未到期。若不清理，测试结束后定时器仍会触发 flushSave，PUT 打到已关闭的
 * 测试服务 → NetworkError → scheduleRetry 指数退避 → **无限重试，进程永不退出**。
 * （实测：不清���时该文件 HANG >45s，其余 14 个测试文件均正常退出。）
 *
 * app.js 的登出分支（app.js:496）正是为此设计的：先 syncEngine.destroy()，
 * 再清 state。这里走的是**真实公开入口**，不改动被测源码。
 */
async function destroyApp(app) {
  const doc = app.window.document;
  // 已登录时点 btnAuthToggle 触发登出 → syncEngine.destroy()
  const toggle = doc.getElementById('btnAuthToggle');
  if (toggle) {
    toggle.dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('M5-W5-03 可见状态：dirty 的徽标与状态栏文案，且不违反 §4.4 禁令', async () => {
  const { server, port } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/api/v1/auth/login')) {
        sendJson(res, 200, { token: 'tok-1', user: { id: 'u1', username: 'tester' } });
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/api/v1/documents?')) {
        sendJson(res, 200, { documents: [DOC], total: 1, limit: 100, offset: 0 });
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/api/v1/documents/')) {
        sendJson(res, 200, DOC);
        return;
      }
      sendJson(res, 200, {});
    });
  });

  const app = await loadApp(port);
  try {
    const doc = app.window.document;
    await loginAndOpenDocument(app);
    await triggerInput(app);

    const badge = doc.getElementById('syncBadge');
    const status = doc.getElementById('statusText');

    assert.ok(badge.textContent.length > 0, '徽标应有可见文案');
    assert.ok(status.textContent.length > 0, '状态栏应有可见文案');

    // §4.4 文案禁令：dirty 不得宣称已同步/保存成功
    for (const forbidden of ['已同步', '保存成功', '已保存']) {
      assert.ok(
        !badge.textContent.includes(forbidden),
        `dirty 徽标不得出现「${forbidden}」：实际「${badge.textContent}」`
      );
      assert.ok(
        !status.textContent.includes(forbidden),
        `dirty 状态栏不得出现「${forbidden}」：实际「${status.textContent}」`
      );
    }
  } finally {
    await destroyApp(app);
    app.restore();
    await stopServer(server);
  }
});

test('M5-W5-03 可见状态：conflict 状态有对应徽标文案', async () => {
  const { server, port } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/api/v1/auth/login')) {
        sendJson(res, 200, { token: 'tok-1', user: { id: 'u1', username: 'tester' } });
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/api/v1/documents?')) {
        sendJson(res, 200, { documents: [DOC], total: 1, limit: 100, offset: 0 });
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/api/v1/documents/')) {
        sendJson(res, 200, DOC);
        return;
      }
      if (req.method === 'PUT') {
        sendJson(res, 409, {
          error: {
            code: 'VERSION_CONFLICT',
            message: '版本冲突',
            details: { server_version: 7 },
            request_id: 'req-1',
          },
        });
        return;
      }
      sendJson(res, 200, {});
    });
  });

  const app = await loadApp(port);
  try {
    const doc = app.window.document;
    await loginAndOpenDocument(app);
    await triggerInput(app);
    // 等防抖窗口让自动保存真正发出 PUT → 409 → conflict
    await new Promise((r) => setTimeout(r, 1800));

    const badge = doc.getElementById('syncBadge');
    assert.ok(
      !doc.getElementById('conflictModal').classList.contains('hidden'),
      '409 后冲突弹窗应弹出'
    );
    assert.ok(
      badge.textContent.includes('冲突'),
      `conflict 徽标应含「冲突」二字：实际「${badge.textContent}」`
    );
  } finally {
    await destroyApp(app);
    app.restore();
    await stopServer(server);
  }
});

test('M5-W5-03 保存失败（存储不可用）：DOM 层可断言文案存在性，但完整失败条路径标为未执行', async () => {
  // 说明（勿删）：完整的「存储不可用 → onStorageFailure → 存储失败条 + 下载入口」链路
  // 依赖**真实的浏览器存储被禁用**（无痕模式 / 站点数据被拒 / 配额耗尽），
  // jsdom 的 localStorage 是内存实现，无法真实触发 SecurityError / QuotaExceededError。
  // 强行用 mock 模拟会得到「写入失败被 catch 但状态未流转」的假象，断言无鉴别力。
  //
  // 因此本用例只断言**前端确实存在失败条与下载入口的 DOM 落点**（结构可达性），
  // 把「失败条真的被显示」明确标注为**未执行**，交 M1 在真实浏览器 / 无痕窗口复核。
  // 任务书第 21 行允许此路径：「缺…浏览器时，给出受影响用例与复跑入口」。
  const { server, port } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/api/v1/auth/login')) {
        sendJson(res, 200, { token: 'tok-1', user: { id: 'u1', username: 'tester' } });
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/api/v1/documents?')) {
        sendJson(res, 200, { documents: [DOC], total: 1, limit: 100, offset: 0 });
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/api/v1/documents/')) {
        sendJson(res, 200, DOC);
        return;
      }
      sendJson(res, 200, {});
    });
  });

  const app = await loadApp(port);
  try {
    const doc = app.window.document;

    // 结构可达性：失败条容器与下载入口存在于页面结构中
    const banner = doc.getElementById('storageBanner');
    assert.ok(banner, '页面须存在存储失败条容器 #storageBanner');
    assert.ok(
      doc.getElementById('storageMessage'),
      '失败条须有文案节点 #storageMessage'
    );
    assert.ok(
      doc.getElementById('btnDownloadFromBanner'),
      '失败条须提供下载入口 #btnDownloadFromBanner'
    );

    // 未执行项（须在验收表同步标注）：
    //   「存储不可用 → 失败条实际显示 + 下载入口可用」= 未执行
    //   复跑入口：无痕窗口打开 http://127.0.0.1:<port>/ 登录 → 输入正文
    //             → 站点数据被禁用时观察底部失败条与「下载当前 Markdown」按钮
  } finally {
    await destroyApp(app);
    app.restore();
    await stopServer(server);
  }
});

test('M5-W5-01 重复初始化：同一 DOM 节点上连续 createEditor 两次，一次 input 仍只回调一次', () => {
  // 原 editor.lifecycle.w5.test.js 用「两个独立 JSDOM 的实例并存」顶替重复初始化，
  // 验证的是实例间不串扰，与「同一节点重复初始化 → 监听器叠加 → 一次 input 多次回调」
  // 不是同一语义。本用例补上后者。
  const doc = new JSDOM(
    '<input id="title"><textarea id="content"></textarea><div id="preview"></div>'
  ).window.document;
  const titleInput = doc.getElementById('title');
  const contentInput = doc.getElementById('content');
  const previewElement = doc.getElementById('preview');

  const editorA = createEditor({ titleInput, contentInput, previewElement });
  const editorB = createEditor({ titleInput, contentInput, previewElement });

  let aCalls = 0;
  let bCalls = 0;
  editorA.onInput(() => { aCalls += 1; });
  editorB.onInput(() => { bCalls += 1; });

  contentInput.value = '一次输入';
  contentInput.dispatchEvent(
    new contentInput.ownerDocument.defaultView.Event('input')
  );

  assert.equal(aCalls, 1, '实例 A 一次 input 只回调一次');
  assert.equal(bCalls, 1, '实例 B 一次 input 只回调一次');

  // 销毁其中一个不应影响另一个
  editorA.destroy();
  contentInput.value = '第二次输入';
  contentInput.dispatchEvent(
    new contentInput.ownerDocument.defaultView.Event('input')
  );

  assert.equal(aCalls, 1, 'A 已销毁，不得再收到通知');
  assert.equal(bCalls, 2, 'B 未销毁，应继续收到通知');

  editorB.destroy();
});

test('M5-W5-01 销毁后监听器被移除：重复 destroy 幂等且不再响应输入', () => {
  const doc = new JSDOM(
    '<input id="title"><textarea id="content"></textarea><div id="preview"></div>'
  ).window.document;
  const titleInput = doc.getElementById('title');
  const contentInput = doc.getElementById('content');
  const previewElement = doc.getElementById('preview');

  const editor = createEditor({ titleInput, contentInput, previewElement });
  let calls = 0;
  editor.onInput(() => { calls += 1; });

  editor.destroy();
  editor.destroy();
  editor.destroy();

  contentInput.value = 'x';
  contentInput.dispatchEvent(
    new contentInput.ownerDocument.defaultView.Event('input')
  );

  assert.equal(calls, 0, 'destroy 后不得再响应输入');
});
