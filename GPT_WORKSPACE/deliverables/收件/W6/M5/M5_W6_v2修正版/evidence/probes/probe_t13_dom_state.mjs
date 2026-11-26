import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const FE = 'D:/WORKbuddy1/RUST/Temp/m5w6_audit_20261126/M5_W6_刘欣怡_261125/frontend';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT_STATIC = 8137;
const PORT_CDP = 9333;

// ---- 1. 静态服务 ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(FE, p);
  if (!fp.startsWith(path.resolve(FE)) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(PORT_STATIC, '127.0.0.1', r));
console.log('[static] http://127.0.0.1:' + PORT_STATIC);

// ---- 2. Chrome ----
const userDir = 'D:/WORKbuddy1/RUST/Temp/w6_cdp_profile';
fs.rmSync(userDir, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + PORT_CDP,
  '--user-data-dir=' + userDir,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--window-size=1200,900',
  'about:blank',
], { stdio: 'ignore' });

async function waitCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT_CDP}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('CDP 未就绪');
}
const ver = await waitCdp();
console.log('[cdp]', ver['Browser']);

// ---- 3. 目标页 ----
const tgt = await (await fetch(`http://127.0.0.1:${PORT_CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);

let msgId = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) events.push(m);
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT_STATIC}/index.html` });
await new Promise((r) => setTimeout(r, 2500));

async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result.value;
}

const result = await evalJS(`(async () => {
  const out = {};
  out.url = location.href;
  out.innerWidth = window.innerWidth;
  out.innerHeight = window.innerHeight;
  out.outerWidth = window.outerWidth;
  out.outerHeight = window.outerHeight;
  out.dpr = window.devicePixelRatio;
  out.ua = navigator.userAgent;
  out.vendorLoaded = {
    marked: typeof window.marked,
    markedVersion: window.marked && window.marked.defaults ? 'n/a' : null,
    dompurify: typeof window.DOMPurify,
    dompurifyVersion: window.DOMPurify && window.DOMPurify.version,
  };

  const ta = document.getElementById('docContent');
  const ti = document.getElementById('docTitle');
  if (!ta) { out.error = 'no #docContent'; return out; }
  out.nodeRefs = {};
  out.nodeRefs.contentInitialConnected = ta.isConnected;

  // ---- A. 输入前：焦点与选区基线 ----
  ta.focus();
  ta.value = '# 中文标题测试\\n\\n第一段正文内容，用于选区验证。';
  ta.setSelectionRange(8, 15);
  out.before = {
    activeElementId: document.activeElement && document.activeElement.id,
    selectionStart: ta.selectionStart,
    selectionEnd: ta.selectionEnd,
    valueLength: ta.value.length,
  };

  // ---- B. 输入事件（触发 renderPreview）后 ----
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  out.afterInput = {
    activeElementId: document.activeElement && document.activeElement.id,
    selectionStart: ta.selectionStart,
    selectionEnd: ta.selectionEnd,
    sameNode: ta.isConnected && document.getElementById('docContent') === ta,
    previewHasScript: !!document.querySelector('#preview script'),
    previewText: (document.getElementById('preview') || {}).textContent?.slice(0, 60),
  };

  // ---- C. 合成 composition 序列（非真实 IME，仅 DOM 层） ----
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  ta.value += "zhong'wen";
  ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: "zhong'wen" }));
  const duringComposition = {
    activeElementId: document.activeElement && document.activeElement.id,
    selectionStart: ta.selectionStart,
    selectionEnd: ta.selectionEnd,
    valueTail: ta.value.slice(-12),
    previewTail: ((document.getElementById('preview') || {}).textContent || '').slice(-14),
  };
  ta.value = ta.value.slice(0, -"zhong'wen".length) + '中文';
  ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
  await new Promise((r) => setTimeout(r, 120));
  out.composition = {
    during: duringComposition,
    afterEnd: {
      activeElementId: document.activeElement && document.activeElement.id,
      selectionStart: ta.selectionStart,
      selectionEnd: ta.selectionEnd,
      sameNode: document.getElementById('docContent') === ta,
      valueTail: ta.value.slice(-8),
      previewTail: ((document.getElementById('preview') || {}).textContent || '').slice(-14),
    },
  };

  // ---- D. 保存状态变化（不重建节点 / 不改选区） ----
  ta.setSelectionRange(5, 11);
  const sel = { s: ta.selectionStart, e: ta.selectionEnd };
  const states = ['DIRTY', 'SAVING', 'SYNCED', 'RETRY_WAIT', 'CONFLICT', 'INVALID', 'AUTH_REQUIRED'];
  const badge = document.getElementById('syncBadge');
  const observed = [];
  for (const st of states) {
    window.dispatchEvent(new CustomEvent('__w6_probe_state', { detail: st }));
    await new Promise((r) => setTimeout(r, 30));
    observed.push({
      tried: st,
      sameNode: document.getElementById('docContent') === ta,
      selStart: ta.selectionStart,
      selEnd: ta.selectionEnd,
      activeEl: document.activeElement && document.activeElement.id,
      badgeText: badge ? badge.textContent.trim() : null,
    });
  }
  out.stateStability = { initialSelection: sel, perState: observed };

  // ---- E. 标题框纯文本（T12 标题部分） ----
  const mal = '<img src=x onerror=alert(9)>';
  ti.focus();
  ti.value = mal;
  ti.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  out.title = {
    injected: mal,
    inputTagName: ti.tagName,
    valueIsLiteral: ti.value === mal,
    inputChildElementCount: ti.childElementCount,
    previewHasImgOnError: !!document.querySelector('#preview [onerror]'),
    docListHtml: (document.getElementById('docList') || {}).innerHTML?.slice(0, 200),
  };

  out.finalContentValue = ta.value;
  return out;
})()`);

fs.writeFileSync('D:/WORKbuddy1/RUST/Temp/w6_t13_probe.json', JSON.stringify(result, null, 2), 'utf8');
console.log('=== 探针结果已写入 w6_t13_probe.json ===');
console.log(JSON.stringify(result, null, 2));

ws.close();
chrome.kill();
server.close();
process.exit(0);
