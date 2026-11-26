import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const FE = 'D:/WORKbuddy1/RUST/Temp/m5w6_audit_20261126/M5_W6_刘欣怡_261125/frontend';
const OUT = 'D:/WORKbuddy1/RUST/Temp/w6_conflict';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8139; const PORT_CDP = 9335;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const M = { mode: 'conflict', version: 5, log: [], puts: [], gets: [] };
const DOC = () => ({ id: 'doc-1', title: '冲突复核', content: '# 冲突复核\n\n云端正文。', version: M.version, updated_at: '2026-11-25T00:00:00Z' });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const json = (st, o) => { const b = JSON.stringify(o); res.writeHead(st, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };
  if (u.startsWith('/api/v1/')) {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (u === '/api/v1/auth/login') return json(200, { token: 't', user: { id: 'u1', username: 'tester' } });
      if (req.method === 'GET' && u === '/api/v1/documents') return json(200, { documents: [DOC()], total: 1, limit: 100, offset: 0 });
      if (req.method === 'GET' && /^\/api\/v1\/documents\/[^/]+$/.test(u)) {
        M.gets.push(u);
        return json(200, DOC());
      }
      if (req.method === 'PUT') {
        let parsed = null; try { parsed = JSON.parse(body); } catch {}
        M.puts.push({ url: u, body: parsed });
        if (M.mode === 'conflict') return json(409, { error: { code: 'VERSION_CONFLICT', message: '版本冲突', details: { server_version: 7 }, request_id: 'r409' } });
        M.version = (parsed && parsed.expected_version ? parsed.expected_version : M.version) + 1;
        return json(200, { ...DOC(), title: parsed && parsed.title, content: parsed && parsed.content });
      }
      return json(200, {});
    });
    return;
  }
  let p = decodeURIComponent(u); if (p === '/') p = '/index.html';
  const fp = path.join(FE, p);
  if (!fp.startsWith(path.resolve(FE)) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const userDir = 'D:/WORKbuddy1/RUST/Temp/w6_cdp_profile3';
fs.rmSync(userDir, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT_CDP, '--user-data-dir=' + userDir, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT_CDP}/json/version`); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

const tgt = await (await fetch(`http://127.0.0.1:${PORT_CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
await new Promise((r) => setTimeout(r, 2000));

const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? { __err: r.exceptionDetails.exception?.description } : r.result.value; };
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64')); };

const out = {};

// 登录 + 打开
await js(`(()=>{document.getElementById('authUsername').value='tester';document.getElementById('authPassword').value='pw12345678';document.getElementById('authForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return 1})()`);
await new Promise((r) => setTimeout(r, 1200));

// 制造冲突
await js(`(()=>{const ta=document.getElementById('docContent');ta.focus();ta.value='# 冲突复核\\n\\n本地修改后的正文。';ta.setSelectionRange(4,10);ta.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
await new Promise((r) => setTimeout(r, 300));
await js(`document.getElementById('btnSaveNow').dispatchEvent(new Event('click'))`);
await new Promise((r) => setTimeout(r, 1800));
out.conflictShown = await js(`({hidden:document.getElementById('conflictModal').classList.contains('hidden'),sv:(document.getElementById('serverVersionText')||{}).textContent,lv:(document.getElementById('localVersionText')||{}).textContent,badge:document.getElementById('syncBadge').textContent.trim()})`);
await shot('01_冲突弹窗.png');

// 点「强制覆盖」→ 记录 expected_version
M.puts.length = 0; M.mode = 'ok';
await js(`document.getElementById('btnConflictOverwrite').dispatchEvent(new Event('click'))`);
await new Promise((r) => setTimeout(r, 2200));
out.overwrite = { puts: JSON.parse(JSON.stringify(M.puts)), after: await js(`({hidden:document.getElementById('conflictModal').classList.contains('hidden'),badge:document.getElementById('syncBadge').textContent.trim(),status:(document.getElementById('statusText')||{}).textContent,docInfo:(document.getElementById('docInfo')||{}).textContent})`) };
await shot('02_强制覆盖后.png');

// 再制造一次冲突，点「重新载入」→ 记录 GET 与本地内容
M.mode = 'conflict'; M.version = 9; M.gets.length = 0; M.puts.length = 0;
await js(`(()=>{const ta=document.getElementById('docContent');ta.value='# 冲突复核\\n\\n再次本地修改。';ta.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
await new Promise((r) => setTimeout(r, 300));
await js(`document.getElementById('btnSaveNow').dispatchEvent(new Event('click'))`);
await new Promise((r) => setTimeout(r, 1800));
out.conflict2 = await js(`({hidden:document.getElementById('conflictModal').classList.contains('hidden'),sv:(document.getElementById('serverVersionText')||{}).textContent})`);
await shot('03_第二次冲突.png');

M.mode = 'ok';
M.version = 9;
await js(`document.getElementById('btnConflictReload').dispatchEvent(new Event('click'))`);
await new Promise((r) => setTimeout(r, 2200));
out.reload = { gets: M.gets.slice(), putsAfterReload: JSON.parse(JSON.stringify(M.puts)), after: await js(`({hidden:document.getElementById('conflictModal').classList.contains('hidden'),badge:document.getElementById('syncBadge').textContent.trim(),status:(document.getElementById('statusText')||{}).textContent,content:document.getElementById('docContent').value,docInfo:(document.getElementById('docInfo')||{}).textContent})`) };
await shot('04_重新载入后.png');

fs.writeFileSync(path.join(OUT, 'conflict.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
ws.close(); chrome.kill(); server.close(); process.exit(0);
