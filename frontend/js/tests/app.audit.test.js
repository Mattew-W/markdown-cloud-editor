import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { saveDraft, listDrafts } from '../drafts.js';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const doc = { id: 'doc', title: '云端', content: '云端内容', version: 3, updated_at: '2026-01-01' };
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function setup(name, fetchImpl) {
  const dom = new JSDOM(html, { url: 'http://localhost/' });
  const { window } = dom;
  Object.assign(globalThis, {
    window, document: window.document, sessionStorage: window.sessionStorage,
    localStorage: window.localStorage, confirm: () => true, fetch: fetchImpl,
  });
  sessionStorage.setItem('mce_token', 'token');
  sessionStorage.setItem('mce_user', JSON.stringify({ id: 'user', username: 'alice' }));
  await import(`../app.js?${name}`);
  await tick();
  await tick();
  return dom;
}

function response(body, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function baseResponse(url) {
  return String(url).includes('?limit=') ? response({ documents: [doc], total: 1 }) : response(doc);
}

function seed() {
  saveDraft({ userId: 'user', docId: 'doc', sessionId: 'other',
    baseVersion: 1, localRevision: 1, title: '旧草稿', content: '未同步' }, localStorage);
}

test('旧草稿恢复后先进入冲突，明确确认前不提交', async () => {
  let puts = 0;
  const dom = await setup('restore', async (url, init) => {
    if (init.method === 'PUT') puts++;
    return baseResponse(url);
  });
  seed();
  document.querySelector('.doc-item').click();
  await tick(); await tick();
  document.getElementById('btnRestoreDraft').click();
  document.getElementById('btnSaveNow').click();
  await tick();
  assert.equal(puts, 0);
  assert.equal(document.getElementById('conflictModal').classList.contains('hidden'), false);
  document.getElementById('btnAuthToggle').click();
  dom.window.close();
});

test('立即退出保留待写草稿', async () => {
  const dom = await setup('logout', async (url) => baseResponse(url));
  const input = document.getElementById('docContent');
  input.value = '未同步的输入';
  input.dispatchEvent(new dom.window.Event('input'));
  document.getElementById('btnAuthToggle').click();
  const entries = listDrafts({ userId: 'user', docId: 'doc' }, localStorage);
  assert.equal(entries[0].content, '未同步的输入');
  dom.window.close();
});

test('页面离开前刷新尚未落盘的草稿', async () => {
  const dom = await setup('pagehide', async (url) => baseResponse(url));
  const input = document.getElementById('docContent');
  input.value = '刷新前的输入';
  input.dispatchEvent(new dom.window.Event('input'));
  assert.match(document.getElementById('syncBadge').textContent, /等待本地备份/);
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  assert.equal(listDrafts({ userId: 'user', docId: 'doc' }, localStorage)[0].content, '刷新前的输入');
  document.getElementById('btnAuthToggle').click();
  dom.window.close();
});

test('最新草稿与云端一致时仍能恢复其余会话的草稿', async () => {
  const dom = await setup('restore-older', async (url) => baseResponse(url));
  seed();
  const older = listDrafts({ userId: 'user', docId: 'doc' }, localStorage)[0];
  const { key } = saveDraft({ userId: 'user', docId: 'doc', sessionId: 'confirmed',
    baseVersion: 3, localRevision: 1, title: doc.title, content: doc.content }, localStorage);
  const confirmed = JSON.parse(localStorage.getItem(key));
  confirmed.recorded_at = new Date(Date.parse(older.recorded_at) + 1000).toISOString();
  localStorage.setItem(key, JSON.stringify(confirmed));
  document.querySelector('.doc-item').click();
  await tick(); await tick();
  assert.equal(document.getElementById('draftBanner').classList.contains('hidden'), false);
  document.getElementById('btnRestoreDraft').click();
  assert.equal(document.getElementById('docContent').value, '未同步');
  document.getElementById('btnAuthToggle').click();
  dom.window.close();
});

test('删除文档保留其他会话草稿', async () => {
  const dom = await setup('delete', async (url, init) =>
    init.method === 'DELETE' ? response(null, 204) : baseResponse(url));
  seed();
  document.getElementById('btnDeleteDoc').click();
  await tick(); await tick();
  assert.equal(listDrafts({ userId: 'user', docId: 'doc' }, localStorage).length, 1);
  document.getElementById('btnAuthToggle').click();
  dom.window.close();
});

test('退出后的旧列表响应不能显示文档', async () => {
  let resolveList;
  const dom = await setup('list', () => new Promise((resolve) => { resolveList = resolve; }));
  document.getElementById('btnAuthToggle').click();
  resolveList(response({ documents: [doc], total: 1 }));
  await tick(); await tick();
  assert.equal(document.getElementById('docList').textContent.includes('云端'), false);
  dom.window.close();
});

test('文档列表可以打开超过首屏 100 条的文档', async () => {
  const older = { ...doc, id: 'older', title: '第 101 篇', content: '历史内容' };
  const dom = await setup('list-pagination', async (url) => {
    if (url === '/api/v1/documents?limit=100&offset=0') {
      const documents = Array.from({ length: 100 }, (_, index) => ({ ...doc, id: `recent-${index}` }));
      return response({ documents, total: 101 });
    }
    if (url === '/api/v1/documents?limit=100&offset=100') {
      return response({ documents: [older], total: 101 });
    }
    return response(url.endsWith('/older') ? older : doc);
  });
  const next = document.querySelector('.doc-pagination button:last-child');
  assert.ok(next && !next.disabled);
  next.click();
  await tick();
  assert.equal(document.querySelector('.doc-item-title').textContent, '第 101 篇');
  document.querySelector('.doc-item').click();
  await tick(); await tick();
  assert.equal(document.getElementById('docContent').value, '历史内容');
  document.getElementById('btnAuthToggle').click();
  dom.window.close();
});

test('净化库缺失时预览只显示文本', async () => {
  const dom = await setup('preview', async (url) => baseResponse(url));
  const input = document.getElementById('docContent');
  input.value = '<img src=x onerror=alert(1)>';
  input.dispatchEvent(new dom.window.Event('input'));
  assert.equal(document.getElementById('preview').querySelector('img'), null);
  document.getElementById('btnAuthToggle').click();
  dom.window.close();
});
