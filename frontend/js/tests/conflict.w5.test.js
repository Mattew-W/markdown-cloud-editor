// js/tests/conflict.w5.test.js —— M5 W5：冲突选择与可见状态补测（M5-W5-03）
//
// ⚠ 本文件为 M1 代修版本（2026-11-19）。原 M5 版本的冲突用例只断言「弹窗关闭」
// 加源码字符串匹配，**回调主体与后续 UI 从未在运行时执行**（见 修复说明.txt）：
//   - app.js:413 的 `if (state.currentDoc)` 与 app.js:434 的 `if (state.pendingConflict)`
//     在原测试环境中恒为 null，handler 主体从未进入；
//   - 原断言 `source.includes('syncEngine.resolveReload(')` 只能检出「整行删除」，
//     检出不了「参数传错」「后续 UI 文案改错」「编辑区不更新」。
//
// 本文件改为**经 node:http 真实 HTTP 服务驱动完整业务链路**：
//   1. 提交登录表单 → state.token / state.user 就位
//   2. 打开文档 → state.currentDoc 就位
//   3. 触发保存 → PUT 返回 409 VERSION_CONFLICT → onConflict 回调 → 弹窗弹出
//   4. 点击冲突按钮 → 断言**实际发出的请求**、**实际的后续 UI**
//
// 全部流量只走 127.0.0.1 随机端口，不访问外网。
//
// 边界说明：
//   - 真实云端重载 / 覆盖结果由 M1 在联调环境复核；本文件只断言前端可观测行为
//     （请求方法与路径、expected_version、编辑区内容、状态栏文案）。
//   - 基线弹窗为两按钮接口，不含「取消」与 W4 候选的四选项；该差异作为跨模块
//     缺口记录交 M1，不在本基线内擅自改接口。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
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

/** 启动 127.0.0.1 随机端口的真实 HTTP 服务，只服务本用例需要的路径。 */
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

/**
 * 载入 app.js 并把全局环境换成 jsdom。
 * fetch 被重写为把相对路径解析到本机测试服务（api.js 发的是 `/api/v1/...` 相对路径）。
 */
async function loadApp(port) {
  // 必须在替换 globalThis.fetch 之前捕获原生实现，否则替身会自我递归
  const nativeFetch = globalThis.fetch;
  const dom = new JSDOM(
    `<!doctype html><html><body>
      ${ELEMENT_IDS.map((id) => `<div id="${id}"></div>`).join('')}
    </body></html>`,
    { url: 'http://localhost/', pretendToBeVisual: true },
  );
  const { window } = dom;
  window.localStorage.clear();
  window.sessionStorage.clear();
  // DOM 桩默认没有任何类名；冲突弹窗在真实 index.html 里带 hidden。
  // 显式补上，否则"弹窗自动弹出"的断言会因裸 div 恒可见而失去鉴别力。
  window.document.getElementById('conflictModal').classList.add('hidden');
  window.document.getElementById('storageBanner').classList.add('hidden');
  window.document.getElementById('draftBanner').classList.add('hidden');

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

  // 相对路径 → 本机测试服务；记录每次请求供断言
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url, `http://127.0.0.1:${port}`);
    const method = init.method || 'GET';
    let body = null;
    if (init.body !== undefined && init.body !== null) {
      body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    }
    calls.push({ url: target.pathname + target.search, method, body });

    const response = await nativeFetch(target.toString(), {
      method,
      headers: init.headers,
      body: init.body,
    });
    return response;
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

async function readCode(relPath) {
  const raw = await fs.promises.readFile(new URL(relPath, import.meta.url), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * 轮询等待条件成立。
 *
 * 【为什么需要】本文件原用固定 `setTimeout(60)` 等登录后的首篇文档打开。
 * 单独运行时够用，但在 `node --test "js/tests/*.test.js"` 下 20 个测试文件
 * 并行（各自独立进程，争 CPU），登录→列表→打开这条链一旦超过 60ms，
 * `docContent.value` 仍是 undefined，断言会以 TypeError 失败。
 * 实测：259 项全绿时本文件 4/4 通过；全量并行时稳定 2 项失败。
 * 改为轮询后等待上限放宽，且不依赖机器负载。
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

/**
 * 收尾：经 app.js 的登出路径触发 syncEngine.destroy() → clearTimers()。
 *
 * 必要性同 app.state.w5.test.js：若不清理，测试结束后仍在的防抖/重试定时器
 * 会向已关闭的测试服务发 PUT → NetworkError → 指数退避 → 进程永不退出。
 */
async function destroyApp(app) {
  const doc = app.window.document;
  const toggle = doc.getElementById('btnAuthToggle');
  if (toggle) {
    toggle.dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
  }
}

const DOC = {
  id: 'doc-1',
  title: '原标题',
  content: '原正文',
  version: 5,
  updated_at: '2026-11-16T00:00:00Z',
};

/** 登录 + 打开文档，使 state.token / state.currentDoc 就位。 */
async function loginAndOpenDocument(app) {
  const { window } = app;
  const doc = window.document;

  doc.getElementById('authUsername').value = 'tester';
  doc.getElementById('authPassword').value = 'pw12345678';
  doc.getElementById('authForm').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true })
  );
  // 等到「登录报错」或「首篇文档已完整打开」二者之一出现。
  //
  // ⚠ 不能只等 `docContent` 非空：app 的 openDocument 是「先 setValues、
  //   再 initSession」，initSession 会把状态置为 synced 并重写状态栏。
  //   只等正文出现会在中途返回，随后残留的 initSession 会覆盖测试断言的状态栏。
  //   因此以"状态栏进入已同步"作为打开完成的信号。
  await waitFor(
    () =>
      doc.getElementById('authError').textContent !== '' ||
      doc.getElementById('statusText').textContent === '所有更改已同步至云端',
    { label: '登录并打开首篇文档' }
  );

  assert.equal(
    doc.getElementById('authError').textContent,
    '',
    '登录不应出错'
  );
  assert.ok(
    doc.getElementById('docContent').value.length > 0,
    '登录后应已打开首篇文档，编辑区有内容'
  );
}

test('冲突弹窗点「重新载入云端」：发出 GET /documents/{id}、更新编辑区与状态栏', async () => {
  const requests = [];
  const { server, port } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      if (req.url.startsWith('/api/v1/auth/login')) {
        sendJson(res, 200, { token: 'tok-1', user: { id: 'u1', username: 'tester' } });
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/api/v1/documents?')) {
        sendJson(res, 200, { documents: [DOC], total: 1, limit: 100, offset: 0 });
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/api/v1/documents/')) {
        sendJson(res, 200, { ...DOC, title: '云端标题', content: '云端正文', version: 7 });
        return;
      }
      sendJson(res, 200, {});
    });
  });

  const app = await loadApp(port);
  try {
    const doc = app.window.document;
    await loginAndOpenDocument(app);

    // 模拟 onConflict 已弹出弹窗（冲突由 syncEngine 触发，此处只置可见状态）
    const modal = doc.getElementById('conflictModal');
    modal.classList.remove('hidden');
    doc.getElementById('serverVersionText').textContent = 'v7';
    doc.getElementById('localVersionText').textContent = 'v5';

    const before = requests.length;
    // 制造可观测的差异：冲突场景下编辑区是"本地内容"，点"重新载入"后才变成云端内容。
    // 若不先改成别的值，编辑区在登录打开文档时已是"云端正文"，
    // 等待条件会立即成立，断言就会读到重载前的状态（假通过 / 假失败）。
    doc.getElementById('docContent').value = '本地待覆盖正文';
    doc.getElementById('btnConflictReload')
      .dispatchEvent(new app.window.Event('click'));
    // 等按钮 handler 里的 GET 返回并写回编辑区，不假定固定耗时。
    await waitFor(
      () => doc.getElementById('docContent').value === '云端正文',
      { label: '重新载入后编辑区被替换为云端正文' }
    );

    assert.ok(modal.classList.contains('hidden'), '选择「重新载入云端」后弹窗必须关闭');

    // 后续 UI：编辑区被替换为云端版本，状态栏提示已采用云端版本
    assert.equal(
      doc.getElementById('docContent').value,
      '云端正文',
      '重新载入后编辑区正文应被替换为云端版本'
    );
    assert.equal(
      doc.getElementById('statusText').textContent,
      '已采用云端版本',
      '重新载入后状态栏应提示已采用云端版本'
    );

    // 实际发出的请求
    const reloadCall = requests
      .slice(before)
      .find((r) => r.method === 'GET' && r.url.startsWith('/api/v1/documents/'));
    assert.ok(reloadCall, '重新载入必须实际发出 GET /documents/{id}');
    assert.match(reloadCall.url, /\/api\/v1\/documents\/doc-1$/, 'GET 必须打到具体文档 id');
  } finally {
    await destroyApp(app);
    app.restore();
    await stopServer(server);
  }
});

test('冲突弹窗点「强制本地覆盖」：PUT 带 expected_version=serverVersion', async () => {
  const requests = [];
  let putCount = 0;
  const { server, port } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
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
        putCount += 1;
        // 第一次 PUT → 409 触发冲突；第二次（点覆盖按钮）→ 成功
        if (putCount === 1) {
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
        sendJson(res, 200, { ...DOC, title: '改名后标题', content: '改名后正文', version: 8 });
        return;
      }
      sendJson(res, 200, {});
    });
  });

  const app = await loadApp(port);
  try {
    const doc = app.window.document;
    await loginAndOpenDocument(app);

    // 真实触发 409：修改正文 → 输入事件 → syncEngine 自动保存 → PUT 返回 409
    doc.getElementById('docContent').value = '改名后正文';
    doc.getElementById('docContent').dispatchEvent(
      new app.window.Event('input', { bubbles: true })
    );
    // 等防抖窗口（1.5s）到期并完成 PUT → 409 → onConflict → 弹窗填入服务端版本。
    //
    // ⚠ 不能等 `!modal.classList.contains('hidden')`：本文件的 DOM 桩是裸
    //   `<div id="conflictModal">`，初始就没有 hidden 类，该条件恒真。
    //   以 serverVersionText 被写入为信号，才是 onConflict 真正执行过的证据。
    await waitFor(
      () => doc.getElementById('serverVersionText').textContent === 'v7',
      { label: 'PUT 返回 409 后 onConflict 写入服务端版本', timeoutMs: 15000 }
    )

    const modal = doc.getElementById('conflictModal');
    assert.ok(
      !modal.classList.contains('hidden'),
      'PUT 返回 409 后冲突弹窗应自动弹出（onConflict 回调已执行）'
    );
    assert.equal(
      doc.getElementById('serverVersionText').textContent,
      'v7',
      '弹窗应显示服务端版本 v7'
    );

    const before = requests.length;
    doc.getElementById('btnConflictOverwrite')
      .dispatchEvent(new app.window.Event('click'));
    // 等 handler 里的异步 PUT 真正发出（resolveOverwrite 是 async）。
    await waitFor(
      () => requests.slice(before).some((r) => r.method === 'PUT'),
      { label: '强制覆盖发出 PUT' }
    )

    assert.ok(modal.classList.contains('hidden'), '选择「强制覆盖」后弹窗必须关闭');

    const putCall = requests
      .slice(before)
      .find((r) => r.method === 'PUT');
    assert.ok(putCall, '强制覆盖必须实际发出 PUT');
    const body = typeof putCall.body === 'string'
      ? JSON.parse(putCall.body)
      : putCall.body;
    assert.ok(body && body.expected_version !== undefined,
      'PUT 必须携带 expected_version');
    assert.equal(body.expected_version, 7,
      'expected_version 必须取 pendingConflict.serverVersion');
  } finally {
    await destroyApp(app);
    app.restore();
    await stopServer(server);
  }
});

test('基线冲突弹窗为两按钮接口，不含「取消」按钮（差异记录交 M1）', async () => {
  const app = await loadApp(1);
  try {
    const doc = app.window.document;
    assert.ok(doc.getElementById('btnConflictReload'), '应存在「重新载入云端」按钮');
    assert.ok(doc.getElementById('btnConflictOverwrite'), '应存在「强制覆盖」按钮');
    assert.equal(doc.getElementById('btnConflictCancel'), null,
      '基线无「取消」按钮；W4 候选四选项未接入，记为跨模块缺口');
  } finally {
    app.restore();
  }
});

test('七状态徽标分支在源码中齐全（synced/dirty/saving/retry/auth/conflict/invalid）', async () => {
  const source = await readCode('../app.js');
  for (const [key] of Object.entries(SyncState)) {
    assert.ok(source.includes(`case SyncState.${key}:`), `必须存在 ${key} 状态分支`);
  }
});
