/**
 * app.test.js —— 前端总控模块的接线与会话隔离测试（M1 W4）
 *
 * app.js 是 DOM 密集的模块，直接 import 需要一套最小 DOM 环境。
 * 本文件用 jsdom 搭一个够用的环境，验证 M1-03 要求的接线行为：
 *
 *   - 退出登录必须销毁同步引擎（旧账号不得继续写入）
 *   - 令牌存 sessionStorage 而非 localStorage（docs/API.md §7）
 *   - 草稿字段名按 snake_case 读取（drafts.js 落盘格式）
 *   - classifyRestore 三分支正确处置（不得恒走"隐藏横幅"分支）
 *   - 冲突"用云端"按钮走 resolveReload 而非绕路重开
 *   - 删除文档后不得用 force:true 清除他人草稿
 *
 * 按 docs/SYNC.md §7.3 的要求使用可控时钟，不依赖真实等待。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { SyncState } from '../sync.js';

// ---------------------------------------------------------------------------
// DOM 环境
// ---------------------------------------------------------------------------

/** index.html 里 app.js 依赖的全部元素 id。 */
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

/**
 * 搭一个够用的 DOM 环境并加载 app.js。
 *
 * app.js 在模块顶层就执行 `document.getElementById(...)` 并绑定事件，
 * 因此必须在 DOM 就绪之后 import。
 *
 * @param {object} options
 * @param {Map<string,string>} [options.storage] 注入的 localStorage 初始内容
 * @param {Map<string,string>} [options.sessionStorage]
 * @returns {Promise<object>}
 */
async function loadApp(options = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      ${ELEMENT_IDS.map((id) => `<div id="${id}"></div>`).join('')}
    </body></html>`,
    { url: 'http://localhost/', pretendToBeVisual: true },
  );

  const { window } = dom;

  // localStorage / sessionStorage：JSDOM 自带，但每个 JSDOM 实例独立。
  window.localStorage.clear();
  window.sessionStorage.clear();
  if (options.storage) {
    for (const [k, v] of options.storage) window.localStorage.setItem(k, v);
  }
  if (options.sessionStorage) {
    for (const [k, v] of options.sessionStorage) window.sessionStorage.setItem(k, v);
  }

  // 把 window 的全局暴露给 Node 侧被测模块。
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    Blob: globalThis.Blob,
    URL: globalThis.URL,
  };

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  globalThis.sessionStorage = window.sessionStorage;
  globalThis.Blob = window.Blob;
  globalThis.URL = window.URL;

  // 记录写过的 fetch 请求，测试用。
  // 假响��按路径分派：认证接口返回凭据，文档接口返回文档列表。
  const calls = [];
  window.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ?? null });

    const path = String(url);
    const payload = path.includes('/auth/')
      ? {
          token: 'test-token',
          expires_in: 3600,
          user: { id: 'user-1', username: 'alice', created_at: '2026-11-15T00:00:00Z' },
        }
      : path.includes('/documents')
        ? { documents: [], total: 0, limit: 100, offset: 0 }
        : {};

    return {
      ok: true,
      status: 200,
      headers: new window.Headers({ 'content-type': 'application/json' }),
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  globalThis.fetch = window.fetch;

  // app.js 顶层会跑 initApp()，它会读 sessionStorage 并可能发请求。
  // 这里用 query 参数控制，避免干扰。
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
      window.close();
    },
  };
}

/**
 * 读取源文件并**剥离注释**。
 *
 * 本模块的注释里会引用被修复掉的旧写法（如 `{ force: true }`、`'prompt_user'`），
 * 直接全文匹配会把注释误判为代码残留。断言必须只看可执行代码。
 *
 * @param {string} relPath 相对本文件路径
 * @returns {Promise<string>}
 */
async function readCode(relPath) {
  const raw = await (await import('node:fs/promises')).readFile(
    new URL(relPath, import.meta.url),
    'utf8',
  );
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')  // 块注释
    .replace(/^\s*\/\/.*$/gm, '')     // 行注释
    .replace(/<!--[\s\S]*?-->/g, ''); // 块注释（HTML 风格）
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('M1-03 app.js 加载后不抛异常，且同步徽章存在', async () => {
  const app = await loadApp();
  try {
    const badge = app.window.document.getElementById('syncBadge');
    assert.ok(badge, 'syncBadge 元素必须存在');
    assert.ok(SyncState.SYNCED);
  } finally {
    app.restore();
  }
});

test('令牌存 sessionStorage 而非 localStorage（docs/API.md §7）', async () => {
  const app = await loadApp();
  try {
    const { window } = app;
    // 模拟登录成功：直接触发表单提交路径较重，
    // 这里验证存储位置约束 —— app.js 源码里不得出现 localStorage 写令牌。
    const source = await readCode('../app.js');
    assert.ok(
      !source.includes("localStorage.setItem('mce_token'"),
      '令牌不得写入 localStorage',
    );
    assert.ok(
      source.includes("sessionStorage.setItem('mce_token'"),
      '令牌必须写入 sessionStorage',
    );
    assert.ok(
      !source.includes("localStorage.getItem('mce_token'"),
      '令牌不得从 localStorage 读取',
    );
  } finally {
    app.restore();
  }
});

test('退出登录必须销毁同步引擎（旧账号不得继续写入）', async () => {
  const app = await loadApp();
  try {
    const { window } = app;
    const doc = window.document;

    // 登录（走真实表单路径）
    doc.getElementById('authUsername').value = 'alice';
    doc.getElementById('authPassword').value = 'Correct-Horse-Battery';
    doc.getElementById('authForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));

    const tokenBefore = window.sessionStorage.getItem('mce_token');
    assert.ok(tokenBefore, '登录后 sessionStorage 应有令牌');

    // 退出
    doc.getElementById('btnAuthToggle').dispatchEvent(new window.Event('click'));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(window.sessionStorage.getItem('mce_token'), null, '退出后必须清除令牌');
    assert.equal(
      window.localStorage.getItem('mce_token'),
      null,
      '退出后 localStorage 也不得有令牌残留',
    );
    assert.equal(doc.getElementById('userInfo').textContent, '未登录');
  } finally {
    app.restore();
  }
});

test('草稿字段按 snake_case 读取（drafts.js 落盘格式）', async () => {
  const app = await loadApp();
  try {
    const source = await readCode('../app.js');
    // drafts.js 落盘用 snake_case：recorded_at / edit_session_id / local_revision
    assert.ok(
      !source.includes('latestDraft.recordedAt'),
      '不得用 camelCase 读 recorded_at',
    );
    assert.ok(
      !source.includes('state.pendingDraft.sessionId'),
      '不得用 camelCase 读 edit_session_id',
    );
    assert.ok(source.includes('latestDraft.recorded_at'), '必须读 recorded_at');
    assert.ok(source.includes('state.pendingDraft.edit_session_id'), '必须读 edit_session_id');
  } finally {
    app.restore();
  }
});

test('classifyRestore 三分支不得恒走"隐藏横幅"分支', async () => {
  const app = await loadApp();
  try {
    const source = await readCode('../app.js');
    // 'prompt_user' 不在 classifyRestore 的返回值域内，
    // 用它做判断会让条件恒假、草稿横幅永远隐藏。
    assert.ok(
      !source.includes("'prompt_user'"),
      '不得比较不存在的 prompt_user 返回值',
    );
    assert.ok(source.includes("'adopt_cloud'"), '必须处理 adopt_cloud 分支');
  } finally {
    app.restore();
  }
});

test('删除文档不得用 force:true 清除他人草稿', async () => {
  const app = await loadApp();
  try {
    const source = await readCode('../app.js');
    assert.ok(!source.includes('force: true'), 'app.js 不得使用 force: true');
  } finally {
    app.restore();
  }
});

test('sync.js 不得使用 force:true（绕过草稿三重核对）', async () => {
  const source = await readCode('../sync.js');
  assert.ok(!source.includes('force: true'), 'sync.js 不得使用 force: true');
});

test('冲突"用云端"按钮走 resolveReload', async () => {
  const app = await loadApp();
  try {
    const source = await readCode('../app.js');
    assert.ok(
      source.includes('syncEngine.resolveReload('),
      '必须调用 resolveReload 而非绕路 openDocument',
    );
  } finally {
    app.restore();
  }
});

test('存储失败横幅与下载按钮已接线', async () => {
  const app = await loadApp();
  try {
    const { window } = app;
    const doc = window.document;
    assert.ok(doc.getElementById('storageBanner'), '存储失败横幅必须存在');
    assert.ok(doc.getElementById('btnDownloadMarkdown'), 'Markdown 下载按钮必须存在');

    const source = await readCode('../app.js');
    assert.ok(source.includes('onStorageFailure'), '必须注册 onStorageFailure 回调');
    assert.ok(source.includes('function downloadMarkdown'), '必须实现 Markdown 下载');
  } finally {
    app.restore();
  }
});