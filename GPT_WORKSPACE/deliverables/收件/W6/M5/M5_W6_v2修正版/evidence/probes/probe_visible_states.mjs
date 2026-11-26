import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const FE = 'D:/WORKbuddy1/RUST/Temp/m5w6_audit_20261126/M5_W6_刘欣怡_261125/frontend';
const OUT = 'D:/WORKbuddy1/RUST/Temp/w6_states';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8138;
const PORT_CDP = 9334;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---- mock API 状态机 ----
const MOCK = {
  putMode: 'ok',      // ok | 429 | 409 | 500
  getDocVersion: 5,
  putCount: 0,
  log: [],
};
const DOC = () => ({ id: 'doc-1', title: 'W6 状态复核', content: '# 状态复核\n\n正文内容。', version: MOCK.getDocVersion, updated_at: '2026-11-25T00:00:00Z' });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const json = (st, obj, extra = {}) => {
    const b = JSON.stringify(obj);
    res.writeHead(st, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), ...extra });
    res.end(b);
  };

  // ---- mock API ----
  if (u.startsWith('/api/v1/')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      MOCK.log.push(`${req.method} ${req.url} ${body.slice(0, 100)}`);
      if (u === '/api/v1/auth/login') return json(200, { token: 'tok-mock', user: { id: 'u1', username: 'tester' } });
      if (req.method === 'GET' && u === '/api/v1/documents') return json(200, { documents: [DOC()], total: 1, limit: 100, offset: 0 });
      if (req.method === 'GET' && /^\/api\/v1\/documents\/[^/]+$/.test(u)) return json(200, DOC());
      if (req.method === 'PUT') {
        MOCK.putCount++;
        if (MOCK.putMode === '429') return json(429, { error: { code: 'RATE_LIMITED', message: '请求过于频繁', request_id: 'r429' } }, { 'retry-after': '3' });
        if (MOCK.putMode === '409') return json(409, { error: { code: 'VERSION_CONFLICT', message: '版本冲突', details: { server_version: 7 }, request_id: 'r409' } });
        if (MOCK.putMode === '500') return json(500, { error: { code: 'INTERNAL_ERROR', message: '服务端错误', request_id: 'r500' } });
        MOCK.getDocVersion += 1;
        return json(200, { ...DOC(), version: MOCK.getDocVersion });
      }
      return json(200, {});
    });
    return;
  }

  // ---- 静态 ----
  let p = decodeURIComponent(u);
  if (p === '/') p = '/index.html';
  const fp = path.join(FE, p);
  if (!fp.startsWith(path.resolve(FE)) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log('[static+mock] http://127.0.0.1:' + PORT);

// ---- Chrome ----
const userDir = 'D:/WORKbuddy1/RUST/Temp/w6_cdp_profile2';
fs.rmSync(userDir, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT_CDP, '--user-data-dir=' + userDir, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });

async function waitCdp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT_CDP}/json/version`); if (r.ok) return await r.json(); } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('CDP 未就绪');
}
const ver = await waitCdp();
console.log('[cdp]', ver.Browser);

const tgt = await (await fetch(`http://127.0.0.1:${PORT_CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((res, rej) => { pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
}
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
await new Promise((r) => setTimeout(r, 2000));

async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'err' };
  return r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
}
const snap = () => js(`(() => {
  const b = document.getElementById('syncBadge');
  const s = document.getElementById('statusText');
  const sb = document.getElementById('storageBanner');
  const cm = document.getElementById('conflictModal');
  const ta = document.getElementById('docContent');
  return {
    badge: b ? b.textContent.trim() : null,
    badgeClass: b ? b.className : null,
    status: s ? s.textContent.trim() : null,
    storageBannerHidden: sb ? sb.classList.contains('hidden') : null,
    storageMessage: (document.getElementById('storageMessage')||{}).textContent,
    conflictHidden: cm ? cm.classList.contains('hidden') : null,
    serverVersionText: (document.getElementById('serverVersionText')||{}).textContent,
    selStart: ta ? ta.selectionStart : null,
    selEnd: ta ? ta.selectionEnd : null,
    activeEl: document.activeElement ? document.activeElement.id : null,
  };
})()`);

const report = { env: {}, states: {}, requests: MOCK.log };

// 环境
report.env = await js(`({ innerWidth: innerWidth, innerHeight: innerHeight, outerWidth: outerWidth, outerHeight: outerHeight, dpr: devicePixelRatio, ua: navigator.userAgent, dompurify: window.DOMPurify && window.DOMPurify.version, marked: typeof window.marked })`);

// 1) 首屏：未同步
report.states.initial = await snap();
await shot('01_首屏_未同步.png');

// 2) 登录并打开文档
await js(`(() => {
  document.getElementById('authUsername').value = 'tester';
  document.getElementById('authPassword').value = 'pw12345678';
  document.getElementById('authForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return true;
})()`);
await new Promise((r) => setTimeout(r, 1200));
report.states.afterLogin = await snap();
await shot('02_登录后_文档打开.png');

// 3) 输入 → dirty
await js(`(() => {
  const ta = document.getElementById('docContent');
  ta.focus();
  ta.value = '# 状态复核\\n\\n修改后的正文。';
  ta.setSelectionRange(6, 12);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await new Promise((r) => setTimeout(r, 200));
report.states.dirty = await snap();
await shot('03_dirty_有未保存修改.png');
const selBeforeSave = { s: report.states.dirty.selStart, e: report.states.dirty.selEnd };

// 4) 429 → 等待重试
MOCK.putMode = '429';
await js(`document.getElementById('btnSaveNow').dispatchEvent(new Event('click'))`);
await new Promise((r) => setTimeout(r, 1500));
report.states.retryWait = await snap();
report.states.retryWait.selStable = report.states.retryWait.selStart === selBeforeSave.s && report.states.retryWait.selEnd === selBeforeSave.e;
await shot('04_等待重试_429.png');

// 5) 409 → 冲突
MOCK.putMode = '409';
await js(`document.getElementById('conflictModal').classList.add('hidden'); true`);
await js(`document.getElementById('btnSaveNow').dispatchEvent(new Event('click'))`);
await new Promise((r) => setTimeout(r, 1500));
report.states.conflict = await snap();
report.states.conflict.selStable = report.states.conflict.selStart === selBeforeSave.s && report.states.conflict.selEnd === selBeforeSave.e;
await shot('05_版本冲突_409.png');

// 6) 冲突弹窗两个按钮
report.conflictButtons = await js(`(() => {
  const out = [];
  for (const id of ['btnConflictReload','btnConflictOverwrite']) {
    const el = document.getElementById(id);
    out.push({ id, text: el ? el.textContent.trim() : null, exists: !!el });
  }
  return out;
})()`);

// 7) 存储失败（QuotaExceeded）
MOCK.putMode = 'ok';
await js(`(() => {
  document.getElementById('conflictModal').classList.add('hidden');
  const proto = Object.getPrototypeOf(window.localStorage);
  const orig = proto.setItem;
  window.__origSetItem = orig;
  proto.setItem = function () { throw new DOMException('quota exceeded', 'QuotaExceededError'); };
  return true;
})()`);
await js(`(() => {
  const ta = document.getElementById('docContent');
  ta.value += ' 触发存储失败。';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await new Promise((r) => setTimeout(r, 2500));
report.states.storageFailure = await snap();
await shot('06_本地备份失败.png');

// 8) 恢复 localStorage，保存成功 → 已同步
await js(`(() => {
  const proto = Object.getPrototypeOf(window.localStorage);
  if (window.__origSetItem) proto.setItem = window.__origSetItem;
  return true;
})()`);
await js(`document.getElementById('btnSaveNow').dispatchEvent(new Event('click'))`);
await new Promise((r) => setTimeout(r, 2000));
report.states.synced = await snap();
await shot('07_保存成功_已同步.png');

report.requests = MOCK.log;
fs.writeFileSync(path.join(OUT, 'states.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));

ws.close(); chrome.kill(); server.close();
process.exit(0);
